(function () {
    window.VIF = window.VIF || {};
    var VIF = window.VIF;
    VIF.streamConfig = VIF.streamConfig || {};

    VIF.streamConfig.init = async function () {
        if (!VIF.core.verifyEnabled()) {
            var verifyOption = document.querySelector('#cfg-detector-type option[value="verify"]');
            if (verifyOption) verifyOption.remove();
        }

        var COCO_CLASSES = ['airplane', 'apple', 'backpack', 'banana', 'baseball bat', 'baseball glove', 'bear', 'bed', 'bench', 'bicycle', 'bird', 'boat', 'book', 'bottle', 'bowl', 'broccoli', 'bus', 'cake', 'car', 'carrot', 'cat', 'cell phone', 'chair', 'clock', 'couch', 'cow', 'cup', 'dining table', 'dog', 'donut', 'elephant', 'fire hydrant', 'fork', 'frisbee', 'giraffe', 'hair drier', 'handbag', 'horse', 'hot dog', 'keyboard', 'kite', 'knife', 'laptop', 'microwave', 'motorcycle', 'mouse', 'orange', 'oven', 'parking meter', 'person', 'pizza', 'potted plant', 'refrigerator', 'remote', 'sandwich', 'scissors', 'sheep', 'sink', 'skateboard', 'skis', 'snowboard', 'spoon', 'sports ball', 'stop sign', 'suitcase', 'surfboard', 'teddy bear', 'tennis racket', 'tie', 'toaster', 'toilet', 'toothbrush', 'traffic light', 'train', 'truck', 'tv', 'umbrella', 'vase', 'wine glass', 'zebra'];

        function loadVlmModules() {
            var names = ['vlm-schema-builder', 'vlm-prompt-guide', 'vlm-autogrow'];
            return Promise.all(names.map(function (name) {
                return VIF.core.loadScript('wse-plugins/server/vif/js/' + name + '.js');
            }));
        }

        var streamsList = [];
        // The resource each dropdown entry addresses, keyed by its option value:
        // {kind: 'group'|'override', name?, app, stream}. A group config addresses a
        // pattern; an override addresses one literal stream, and the two have their
        // own routes.
        var streamRegistry = {};
        defaultConfig = {};
        // Built-in VLM fallbacks matching the vLLM sidecar bundled with the Video Intelligence
        // framework (docker compose --profile vlm). Used to prefill the VLM fields only when
        // neither the stream's vlm_analysis block nor the global defaults provide a value, so
        // configs without a global vlm_analysis block (e.g. predating VLM support) still work
        // out of the box. Keep in sync with the global vlm_analysis defaults in
        // docker/conf.modules/vif/Default.json.
        var VLM_FALLBACK_DEFAULTS = {
            model_name: 'Qwen/Qwen3-VL-4B-Instruct-FP8',
            endpoint_url: 'http://vlm.docker:8000/v1'
        };
        // Models offered as explicit options in the VLM Model Name dropdown; the <select>
        // options are populated from this list at init (stream-config.html only carries the
        // fixed "Other…" entry). A stored model_name outside this set loads into the "Other"
        // custom text input. The list itself is shared with the VOD inline editor.
        var VLM_KNOWN_MODELS = VIF.fieldRegistry.VLM_MODEL_NAMES;
        // Sentinel <option> value that reveals the custom model-name text input.
        var VLM_MODEL_OTHER = '__other__';
        var VLM_TYPICAL_ENDPOINT_IMAGE_CAP = VIF.fieldRegistry.VLM_TYPICAL_ENDPOINT_IMAGE_CAP;
        // Suggested inference_fps for new VLM streams. The global inference_fps default
        // (-1 = match source) would push a 25-30fps stream far past the endpoint's typical
        // image cap (VLM_TYPICAL_ENDPOINT_IMAGE_CAP) - still allowed (VIS subsamples), but a
        // fixed rate gives predictable, full-quality sampling out of the box. 2 fps over the
        // default 2s window = 4 images per request, matching the bundled example config in
        // docker/conf.modules/vif/Default.json.
        var VLM_SUGGESTED_INFERENCE_FPS = 2;
        // What a new Verify config arrives with: a longer window than the live detectors ask for,
        // and the rate its review runs at. Prepopulated values only — a Verify config that clears
        // them inherits the global processing defaults like any other config.
        var VERIFY_SUGGESTED_WINDOW_SECONDS = 8;
        var VERIFY_SUGGESTED_INFERENCE_FPS = 1;
        var isDirty = false;
        var isSaving = false;
        var wasSaved = false;
        var lastRawStreamConfig = null;
        // Cross-file shared state: vif-listeners.js's renderProperties() reads and
        // temporarily overrides this flag around syncPropertyFields() - no `var`, same
        // implicit-global rationale as defaultConfig above.
        suppressDirtyTracking = false;
        var statusHideTimer = null;
        var statusClearTimer = null;
        // Pre-save validation errors stay up until the next save attempt, a change of
        // stream selection, or another status message replaces them - never on a timer.
        var statusIsSticky = false;
        // Set while the error bar holds a refused save, so each edit can check it again.
        var saveRefused = false;
        var STREAM_CONFIG_SELECTION_STORAGE_KEY = `vif.stream-config.selected-stream.${window.location.host}`;
        // A one-shot hint another page leaves for "+ New Stream Config": the detector type to open on.
        var NEW_CONFIG_DETECTOR_TYPE_STORAGE_KEY = `vif.stream-config.new-detector-type.${window.location.host}`;
        FIELD_RULES = VIF.fieldRegistry.deriveFieldRules();

        var SECTION_EVENT_TYPES = ['change', 'click', 'input'];

        // The credential slots the detector sections carry; the VIS service key's slot
        // lives outside the sections and is not one of these.
        var SECTION_SECRET_SOURCES = ['cfg-vlm-api-key',
            'cfg-synthetic-api-key', 'cfg-synthetic-tls-client-key'];
        var secretNamesLoaded = [];

        function byId(baseId) {
            return function(el, prefix) { return el.id === prefix + baseId; };
        }

        function byClass(name) {
            return function(el) { return !!el.classList && el.classList.contains(name); };
        }

        // The slot a secret button acts on, from the row that holds it: the row's id is
        // <prefix><base><rowSuffix>.
        function secretBaseFrom(root, el, rowSuffix) {
            const row = el.closest('[id$="' + rowSuffix + '"]');
            return row ? row.id.slice(sectionPrefix(root).length, -rowSuffix.length) : null;
        }

        function byRadioGroup(name) {
            return function(el, prefix) { return el.type === 'radio' && el.name === prefix + name; };
        }

        function bySelectorFrom(anchorBaseId, rest) {
            return function(el, prefix) { return el.matches('#' + CSS.escape(prefix + anchorBaseId) + rest); };
        }

        function byLabelHolding(baseId) {
            return function(el, prefix) {
                return el.tagName === 'LABEL' && !!el.querySelector(':scope > #' + CSS.escape(prefix + baseId));
            };
        }

        var SECTION_HANDLERS = [
            { on: 'change', matches: byId('cfg-model-name'), run: function(root) { toggleCheckpointPath(root); } },
            { on: 'change', matches: byId('cfg-checkpoint-path'), run: function(root) { updateClassNamesOptions(root); } },
            { on: 'change', matches: byId('cfg-tracking-method'), run: function(root) { toggleByteTrack(root); } },
            { on: 'change', matches: byId('cfg-tiling-enabled'), run: function(root) { toggleTiling(root); } },
            { on: 'change', matches: byId('cfg-tiling-mode'), run: function(root) { toggleTilingMode(root); } },
            { on: 'change', matches: byId('cfg-tiling-full-frame'), run: function(root) { toggleFullFrameDetection(root); } },
            { on: 'click', matches: bySelectorFrom('cfg-scene-class-names', ' + button'),
                run: function(root) { addClassRow(root, 'cfg-scene-class-names', '', { withHint: false }); } },
            { on: 'input', matches: byId('cfg-synthetic-endpoint'),
                run: function(root) { showInheritedSyntheticMembers(root); updateSyntheticEndpointFields(root); } },
            { on: 'change', matches: byId('synthetic-strictness'), run: function(root) { pickSyntheticStrictness(root); } },
            { on: 'input', matches: byId('cfg-synthetic-classification-threshold'), run: function(root) { showSyntheticStrictness(root); } },
            { on: 'input', matches: byId('synthetic-strictness-own'), run: function(root) { typeSyntheticStrictness(root); } },
            { on: 'change', matches: byId('synthetic-strictness-own'), run: function(root) { showSyntheticStrictness(root); } },
            { on: 'click', matches: byId('cfg-synthetic-endpoint-test'), run: function(root) { testSvdEndpoint(root); } },
            { on: 'click', matches: byLabelHolding('cfg-synthetic-tls-certs-caret'), run: function(root) { toggleSyntheticTlsCerts(root); } },
            { on: 'click', matches: byLabelHolding('cfg-motion-advanced-caret'), run: function(root) { toggleMotionAdvanced(root); } },
            { on: 'input', matches: byId('cfg-synthetic-api-key'),
                run: function(root) { syncSectionApiKeyToggle(root, 'cfg-synthetic-api-key', 'cfg-synthetic-api-key-toggle'); } },
            { on: 'click', matches: byId('cfg-synthetic-api-key-toggle'), run: function(root) { toggleSyntheticApiKeyVisibility(root); } },
            { on: 'input', matches: byId('cfg-synthetic-endpoint'), run: function(root) { clearSvdEndpointTestResult(root); } },
            { on: 'input', matches: byId('cfg-synthetic-tls-ca-cert'), run: function(root) { clearSvdEndpointTestResult(root); } },
            { on: 'input', matches: byId('cfg-synthetic-tls-client-cert'), run: function(root) { clearSvdEndpointTestResult(root); } },
            { on: 'input', matches: byId('cfg-synthetic-tls-client-key'), run: function(root) {
                clearSvdEndpointTestResult(root);
                syncSaveAsSecret(field(root, 'cfg-synthetic-tls-client-key'));
            } },
            { on: 'input', matches: byId('cfg-synthetic-api-key'), run: function(root) { clearSvdEndpointTestResult(root); } },
            { on: 'input', matches: byId('cfg-synthetic-function-id'), run: function(root) { clearSvdEndpointTestResult(root); } },
            { on: 'change', matches: byId('cfg-synthetic-use-tls'), run: function(root) { clearSvdEndpointTestResult(root); } },
            { on: 'input', matches: byId('cfg-verify-flag-threshold'), run: function(root) { updateVerifyGateLine(root); } },
            { on: 'input', matches: byId('cfg-verify-strong-threshold'), run: function(root) { updateVerifyGateLine(root); } },
            { on: 'change', matches: byId('cfg-vlm-model-name'), run: function(root) { toggleVlmModelNameOther(root); } },
            { on: 'change', matches: byId('cfg-vlm-model-name'), run: function(root) { clearVlmEndpointTestResult(root); } },
            { on: 'input', matches: byId('cfg-vlm-model-name-other'), run: function(root) { clearVlmEndpointTestResult(root); } },
            { on: 'input', matches: byId('cfg-vlm-endpoint-url'), run: function(root) { clearVlmEndpointTestResult(root); } },
            { on: 'click', matches: byId('cfg-vlm-endpoint-test'), run: function(root) { testVlmEndpoint(root); } },
            { on: 'input', matches: byId('cfg-vlm-api-key'),
                run: function(root) { syncSectionApiKeyToggle(root, 'cfg-vlm-api-key', 'cfg-vlm-api-key-toggle'); } },
            { on: 'input', matches: byId('cfg-vlm-api-key'), run: function(root) { clearVlmEndpointTestResult(root); } },
            { on: 'click', matches: byId('cfg-vlm-api-key-toggle'), run: function(root) { toggleVlmApiKeyVisibility(root); } },
            { on: 'change', matches: byRadioGroup('vlm-mode'), run: function(root) { toggleVlmMode(root); } },
            { on: 'change', matches: byRadioGroup('vlm-reasoning-level'), run: function() { markDirty(); } },
            { on: 'click', matches: bySelectorFrom('cfg-vlm-detect-classes', ' + button'),
                run: function(root) { addVlmClassRow(root, 'cfg-vlm-detect-classes'); } },
            { on: 'click', matches: bySelectorFrom('vlm-mode-custom', ' > .form-group > button'),
                run: function(root) { withPromptGuide(root, function(guide) { guide.open(); }); } },
            { on: 'click', matches: byId('vlm-guide-modal'),
                run: function(root, el, event) { if (event.target === el) withPromptGuide(root, function(guide) { guide.close(); }); } },
            { on: 'click', matches: bySelectorFrom('vlm-guide-modal', ' .overlay-close'),
                run: function(root) { withPromptGuide(root, function(guide) { guide.close(); }); } },
            { on: 'input', matches: byId('cfg-vlm-system-prompt'), run: function(root) { updateVlmCustomLint(root); } },
            { on: 'input', matches: byId('cfg-vlm-user-prompt'), run: function(root) { updateVlmCustomLint(root); } },
            { on: 'click', matches: bySelectorFrom('cfg-vlm-custom-classes', ' + button'),
                run: function(root) { addVlmClassRow(root, 'cfg-vlm-custom-classes'); } },
            { on: 'change', matches: byRadioGroup('vlm-schema-kind'),
                run: function(root, el) { withSchemaBuilder(root, function(builder) { builder.switchKind(el.value); }); } },
            { on: 'change', matches: byRadioGroup('vlm-schema-mode'),
                run: function(root, el) { withSchemaBuilder(root, function(builder) { builder.switchMode(el.value); }); } },
            { on: 'click', matches: bySelectorFrom('cfg-vlm-schema-rows', ' + button'),
                run: function(root) { withSchemaBuilder(root, function(builder) { builder.addField(); }); } },
            { on: 'input', matches: byId('cfg-vlm-response-schema'),
                run: function(root) { withSchemaBuilder(root, function(builder) { builder.validate(); }); } },
            { on: 'click', matches: byLabelHolding('cfg-vlm-advanced-caret'), run: function(root) { toggleVlmAdvanced(root); } },
            { on: 'change', matches: byId('cfg-vlm-api-key-source'),
                run: function(root) { secretSourceChanged(root, 'cfg-vlm-api-key'); clearVlmEndpointTestResult(root); } },
            { on: 'change', matches: byId('cfg-synthetic-api-key-source'),
                run: function(root) { secretSourceChanged(root, 'cfg-synthetic-api-key'); clearSvdEndpointTestResult(root); } },
            { on: 'change', matches: byId('cfg-synthetic-tls-client-key-source'),
                run: function(root) { secretSourceChanged(root, 'cfg-synthetic-tls-client-key'); clearSvdEndpointTestResult(root); } },
            { on: 'change', matches: byId('cfg-vlm-api-key-secret'),
                run: function(root) { markDirty(); clearVlmEndpointTestResult(root); } },
            { on: 'change', matches: byId('cfg-synthetic-api-key-secret'),
                run: function(root) { markDirty(); clearSvdEndpointTestResult(root); } },
            { on: 'change', matches: byId('cfg-synthetic-tls-client-key-secret'),
                run: function(root) { markDirty(); clearSvdEndpointTestResult(root); } },
            { on: 'click', matches: byClass('secret-save-as'),
                run: function(root, el) { promptStoreSecret(root, secretBaseFrom(root, el, '-value-row')); } },
            { on: 'click', matches: byClass('secret-store-confirm'),
                run: function(root, el) { confirmStoreSecret(root, secretBaseFrom(root, el, '-store-row')); } },
            { on: 'click', matches: byClass('secret-store-cancel'),
                run: function(root, el) { cancelStoreSecret(root, secretBaseFrom(root, el, '-store-row')); } }
        ];

        function sectionPrefix(root) {
            return root.dataset.vifPrefix || '';
        }

        function withSchemaBuilder(root, fn) {
            return window.vlmSchemaBuilder ? fn(window.vlmSchemaBuilder(root)) : undefined;
        }

        function withPromptGuide(root, fn) {
            return window.vlmPromptGuide ? fn(window.vlmPromptGuide(root)) : undefined;
        }

        function field(root, baseId) {
            const prefix = sectionPrefix(root);
            const id = prefix + baseId;
            const sections = VIF.fieldRegistry.sections;
            for (let i = 0; i < sections.length; i++) {
                const section = root.querySelector('#' + CSS.escape(prefix + sections[i].group));
                if (!section) continue;
                if (section.id === id) return section;
                const found = section.querySelector('#' + CSS.escape(id));
                if (found) return found;
            }
            const lifted = root.vifLiftedInto;
            return lifted ? lifted.querySelector('#' + CSS.escape(id)) : null;
        }

        function dispatchSectionEvent(event) {
            dispatchSectionEventIn(event.currentTarget, event);
        }

        // `root`'s handlers for an event inside `root`, or inside fields lifted out of it.
        function dispatchSectionEventIn(root, event) {
            const prefix = sectionPrefix(root);
            SECTION_HANDLERS.forEach(function(handler) {
                if (handler.on !== event.type) return;
                for (let el = event.target; el && el !== root && el !== event.currentTarget.parentElement; el = el.parentElement) {
                    if (handler.matches(el, prefix)) {
                        handler.run(root, el, event);
                        return;
                    }
                }
            });
        }

        function addVlmModelOptions(select) {
            const otherOption = select.querySelector('option[value="' + VLM_MODEL_OTHER + '"]');
            VLM_KNOWN_MODELS.forEach(function(name) {
                const option = document.createElement('option');
                option.value = name;
                option.textContent = name;
                select.insertBefore(option, otherOption);
            });
        }

        function instantiateSections(prefix, root) {
            const fragment = document.importNode(document.getElementById('vif-detector-sections').content, true);
            if (prefix) {
                fragment.querySelectorAll('[data-scope="config"]').forEach(function(el) { el.remove(); });
                fragment.querySelectorAll('[id]').forEach(function(el) { el.id = prefix + el.id; });
                fragment.querySelectorAll('label[for]').forEach(function(el) { el.htmlFor = prefix + el.htmlFor; });
                fragment.querySelectorAll('input[type="radio"]').forEach(function(el) { el.name = prefix + el.name; });
            }
            addVlmModelOptions(fragment.getElementById(prefix + 'cfg-vlm-model-name'));
            // A clone made after the names loaded (a chain stage card) gets its pickers
            // filled here; the standalone clone is filled by loadSecretNames() at init.
            SECTION_SECRET_SOURCES.forEach(function(base) {
                fillSecretPicker(fragment.getElementById(prefix + base + '-secret'));
            });
            root.dataset.vifPrefix = prefix;
            // Capture phase: a synthetic `new Event('input')` does not bubble, and handlers bound
            // to the fields themselves used to see it.
            SECTION_EVENT_TYPES.forEach(function(type) { root.addEventListener(type, dispatchSectionEvent, true); });
            return fragment;
        }

        function mountStandaloneSections() {
            const template = document.getElementById('vif-detector-sections');
            const root = template.parentElement;
            // The Manager's fragment loader can re-run this script over a DOM that
            // already holds the clone; a second insert would duplicate every section.
            if (!document.getElementById('object-analysis-section'))
                template.after(instantiateSections('', root));
            return root;
        }

        VIF.detectorSections = {
            instantiate: instantiateSections,
            field: field,
            populate: populateSections,
            read: readSections,
            reset: resetSections,
            toggle: toggleSections
        };

        // The VLM modules bind to section elements when they load, and loadStreams() fills
        // them: the sections have to be in the page before either starts.
        var sectionsRoot = mountStandaloneSections();
        var vlmModulesPromise = loadVlmModules();

        function onStandaloneSections(fn) {
            return function() {
                return fn.apply(null, [sectionsRoot].concat(Array.from(arguments)));
            };
        }

        function formatRuleGuidance(rule) {
            const parts = [];
            if (Number.isFinite(rule.min) && Number.isFinite(rule.max)) {
                parts.push(`Allowed range: ${rule.min}-${rule.max}.`);
            }
            if (rule.integer) {
                parts.push('Whole numbers only.');
            } else if (rule.decimals !== undefined) {
                parts.push(`Up to ${rule.decimals} decimal place${rule.decimals === 1 ? '' : 's'}.`);
            }
            return parts.join(' ');
        }

        function shouldIgnoreGlobalDirtyTracking(target) {
            if (!target) return false;
            if (target.id === 'cfg-stream-select' || target.id === 'evt-listener-select' || target.id === 'cfg-upload-file') return true;
            // These write the score field, which speaks for them when the score changes.
            if (target.id === 'synthetic-strictness' || target.id === 'synthetic-strictness-own') return true;
            if (target.closest && target.closest('#evt-new-listener-name-group')) return true;
            return false;
        }

        function sanitizeNumericString(rawValue, rule) {
            if (rawValue === '') return '';
            const allowNegative = Number.isFinite(rule.min) && rule.min < 0;
            const raw = String(rawValue);
            const isNegative = allowNegative && raw.startsWith('-');
            let value = raw.replace(/[^0-9.]/g, '');
            const firstDot = value.indexOf('.');
            if (firstDot !== -1) {
                value = value.slice(0, firstDot + 1) + value.slice(firstDot + 1).replace(/\./g, '');
            }
            if (rule.integer) {
                value = value.split('.')[0];
            } else if (rule.decimals !== undefined && firstDot !== -1) {
                const parts = value.split('.');
                parts[1] = (parts[1] || '').slice(0, rule.decimals);
                value = parts[0] + '.' + parts[1];
            }
            if (isNegative && value !== '') value = '-' + value;
            return value;
        }

        function normalizeNumericValue(rawValue, rule) {
            const sanitized = sanitizeNumericString(rawValue, rule);
            if (sanitized === '' || sanitized === '.') return '';
            let number = rule.integer ? parseInt(sanitized, 10) : parseFloat(sanitized);
            if (!Number.isFinite(number)) return '';
            if (Number.isFinite(rule.min)) number = Math.max(rule.min, number);
            if (Number.isFinite(rule.max)) number = Math.min(rule.max, number);
            if (rule.integer) return String(number);
            if (rule.decimals !== undefined) {
                return parseFloat(number.toFixed(rule.decimals)).toString();
            }
            return String(number);
        }

        function validateNumericValue(rawValue, rule) {
            if (rawValue === '' || rawValue === null || rawValue === undefined) return false;
            const value = sanitizeNumericString(rawValue, rule);
            if (value === '' || value === '.') return false;
            if (rule.integer && value.includes('.')) return false;
            const number = rule.integer ? parseInt(value, 10) : parseFloat(value);
            if (!Number.isFinite(number)) return false;
            if (Number.isFinite(rule.min) && number < rule.min) return false;
            if (Number.isFinite(rule.max) && number > rule.max) return false;
            const decimalPart = value.includes('.') ? value.split('.')[1] : '';
            if (!rule.integer && rule.decimals !== undefined && decimalPart.length > rule.decimals) return false;
            return true;
        }

        function isValidCssColor(value) {
            if (!value || !String(value).trim()) return false;
            const probe = new Option().style;
            probe.color = '';
            probe.color = String(value).trim();
            return probe.color !== '';
        }

        function applyNumericRuleToInput(input, rule) {
            if (!input || !rule) return;
            input.min = rule.min;
            input.max = rule.max;
            input.step = rule.integer ? '1' : `0.${'0'.repeat(Math.max((rule.decimals || 1) - 1, 0))}1`;
            input.inputMode = 'decimal';
            input.title = formatRuleGuidance(rule);
            // A detector switch re-applies a FRESH rule object to an already-bound
            // input, so the once-bound listeners below must read the rule that is
            // current at the keystroke - a rule captured at first bind would keep
            // clamping with the static default forever (typed 8 snapped back to 5
            // on the VLM duration long after its cap moved).
            input.__vifNumericRule = rule;
            if (input.dataset.ruleBound === 'true') return;
            input.addEventListener('input', function() {
                const live = input.__vifNumericRule;
                const sanitized = sanitizeNumericString(input.value, live);
                if (input.value !== sanitized) input.value = sanitized;
                const valid = input.value === '' || validateNumericValue(input.value, live);
                input.setCustomValidity(valid ? '' : formatRuleGuidance(live));
            });
            input.addEventListener('blur', function() {
                const live = input.__vifNumericRule;
                input.value = normalizeNumericValue(input.value, live);
                const valid = input.value === '' || validateNumericValue(input.value, live);
                input.setCustomValidity(valid ? '' : formatRuleGuidance(live));
            });
            input.dataset.ruleBound = 'true';
        }

        function rootInput(root, baseId) {
            return field(root, baseId) || (sectionPrefix(root) ? null : document.getElementById(baseId));
        }

        function initializeStaticFieldRules(root) {
            Object.entries(FIELD_RULES).forEach(function(entry) {
                const input = rootInput(root, entry[0]);
                if (input) applyNumericRuleToInput(input, entry[1]);
            });
        }

        function initializeStaticFieldTooltips() {
            // Inline help is the primary guidance pattern on this page.
            // Avoid duplicating the same text into hover tooltips.
        }

        function isStreamConfigMounted() {
            return !!document.getElementById('cfg-stream-select') && !!document.getElementById('dirty-indicator');
        }

        function updateDirtyIndicator() {
            const dirtyEl = document.getElementById('dirty-indicator');
            if (!dirtyEl) return;
            if (isSaving) {
                dirtyEl.style.visibility = '';
                dirtyEl.textContent = 'Saving changes...';
                dirtyEl.className = 'state-saving';
                return;
            }
            if (isDirty) {
                dirtyEl.style.visibility = '';
                dirtyEl.textContent = 'Unsaved changes';
                dirtyEl.className = 'state-unsaved';
                return;
            }
            if (wasSaved) {
                dirtyEl.style.visibility = '';
                dirtyEl.textContent = 'Saved';
                dirtyEl.className = 'state-saved';
                return;
            }
            dirtyEl.style.visibility = 'hidden';
        }

        function updateIncomingStreamPanelState() {
            if (!isStreamConfigMounted()) return;
            const panel = document.querySelector('.top-config-panel');
            if (!panel) return;
            const shouldCompact = window.scrollY > 0;
            panel.classList.toggle('is-compact', shouldCompact);
        }

        function updateSaveButtonState() {
            const label = isSaving ? 'Saving...' : 'Save all changes';
            document.querySelectorAll('[data-save-config-btn="true"]').forEach(function(saveBtn) {
                saveBtn.disabled = isSaving;
                saveBtn.textContent = label;
            });
        }



        function markDirty() {
            if (!isStreamConfigMounted() || suppressDirtyTracking || isSaving) return;
            isDirty = true;
            updateDirtyIndicator();
        }

        function markClean(savedNow) {
            isDirty = false;
            wasSaved = !!savedNow;
            updateDirtyIndicator();
        }

        function setSavingState(saving) {
            isSaving = saving;
            updateDirtyIndicator();
            updateSaveButtonState();
        }

        function setFormLoading(loading) {
            document.querySelector('.two-column').classList.toggle('loading', loading);
            // The panel bodies may sit in the chain builder's hosts rather than the columns.
            const roots = ['.two-column', '#chain-video-host', '#chain-listeners-host', '#chain-advanced-host'];
            const selectors = roots.map(function(root) {
                return [root + ' input', root + ' select', root + ' textarea', root + ' button'].join(', ');
            }).join(', ');
            document.querySelectorAll(selectors).forEach(function(el) {
                el.disabled = loading;
            });
            ['btn-save-top', 'btn-new-top', 'btn-clone-top', 'btn-delete-top', 'btn-download-top', 'btn-upload-top'].forEach(function(id) {
                const el = document.getElementById(id);
                if (el) el.disabled = loading;
            });
            // The bulk-enable above would re-enable a Show/Hide button whose API-key field is
            // empty; re-assert the empty-key disabling once the form is no longer loading.
            if (!loading) {
                syncAllApiKeyToggles();
                updateSaveButtonState();
                if (chainState) refreshChainView();
            }
        }

        function toggleCheckpointPath(root) {
            const model = field(root, 'cfg-model-name').value;
            field(root, 'checkpoint-path-group').style.display = model === 'custom' ? 'flex' : 'none';
            updateClassNamesOptions(root);
            markDirty();
        }

        function getModelClasses(root) {
            const modelName = field(root, 'cfg-model-name').value;
            if (!defaultConfig || !defaultConfig.available_models || !defaultConfig.available_models.models) return [];
            const models = defaultConfig.available_models.models;
            let model;
            if (modelName === 'custom') {
                const checkpointPath = field(root, 'cfg-checkpoint-path').value;
                if (!checkpointPath) return [];
                model = models.find(m => m.checkpoint_path === checkpointPath);
            } else {
                model = models.find(m => !m.is_custom && m.name && m.name.endsWith('-' +modelName));
            }
            if (!model) return [];
            if (model.available_classes && model.available_classes.length > 0) return model.available_classes;
            if (model.class_set === 'coco') return COCO_CLASSES;
            return [];
        }

        function updateClassNamesOptions(root) {
            const select = field(root, 'cfg-class-names');
            const classes = getModelClasses(root);
            const selected = new Set(Array.from(select.selectedOptions).map(o => o.value));
            select.innerHTML = '';
            classes.forEach(cls => {
                const opt = document.createElement('option');
                opt.value = cls;
                opt.textContent = cls;
                if (selected.has(cls)) opt.selected = true;
                select.appendChild(opt);
            });
        }

        function toggleByteTrack(root) {
            const method = field(root, 'cfg-tracking-method').value;
            const show = method === 'byte-track';
            field(root, 'byte-track-section').style.display = show ? 'block' : 'none';
            if (show) {
                [['cfg-bt-min-confidence', '50'], ['cfg-bt-max-lost-frames', '30'],
                 ['cfg-bt-min-overlap', '20'], ['cfg-bt-min-frames', '3']].forEach(function(blank) {
                    const input = field(root, blank[0]);
                    if (!input.value) input.value = input.placeholder || blank[1];
                });
            }
            markDirty();
        }

        function toggleTiling(root) {
            // Tiling is feature-gated behind the ?tiling=true query param (like vlm). When it
            // is not present, keep both the toggle and the properties section hidden — even if a
            // loaded config has tiling enabled (the stored config is preserved, just not shown).
            const uiEnabled = new URLSearchParams(window.location.search).get('tiling') === 'true';
            const enabled = uiEnabled && field(root, 'cfg-tiling-enabled').checked;
            field(root, 'tiling-section').style.display = enabled ? 'block' : 'none';
            if (enabled && !field(root, 'cfg-tiling-max-rows').value) {
                ['cfg-tiling-min-rows', 'cfg-tiling-min-cols', 'cfg-tiling-max-rows',
                 'cfg-tiling-max-cols', 'cfg-tiling-coverage-cutoff', 'cfg-tiling-cluster-children']
                    .forEach(function(id) {
                        const el = field(root, id);
                        if (!el.value) el.value = el.placeholder || '';
                    });
            }
            toggleTilingMode(root);
            markDirty();
        }

        function toggleTilingMode(root) {
            const mode = field(root, 'cfg-tiling-mode').value;
            field(root, 'tiling-gated-fields').style.display = mode === 'gated' ? 'block' : 'none';
            // The full-frame toggle only applies to Fixed mode. In Gated the full-frame
            // probe always runs, so the toggle is hidden there.
            field(root, 'tiling-fixed-fields').style.display = mode === 'gated' ? 'none' : 'block';
            // In Fixed mode there is a single grid, so "Max" is misleading — drop the prefix.
            field(root, 'lbl-tiling-max-rows').textContent = mode === 'gated' ? 'Max Slice Rows' : 'Slice Rows';
            field(root, 'lbl-tiling-max-cols').textContent = mode === 'gated' ? 'Max Slice Cols' : 'Slice Cols';
            updateClusterChildrenVisibility(root);
            markDirty();
        }

        function toggleFullFrameDetection(root) {
            updateClusterChildrenVisibility(root);
            markDirty();
        }

        // Cluster suppression only does something when there is a full-frame pass that
        // can produce the over-large "parent" box: that is always the case in Gated
        // (the probe), but in Fixed only when Full Frame Detection is enabled.
        function updateClusterChildrenVisibility(root) {
            const mode = field(root, 'cfg-tiling-mode').value;
            const fullFrame = field(root, 'cfg-tiling-full-frame').checked;
            const show = mode === 'gated' || fullFrame;
            field(root, 'tiling-cluster-children-group').style.display = show ? 'block' : 'none';
        }

        function getSelectedStream() {
            const select = document.getElementById('cfg-stream-select');
            const val = select.value;
            if (!val) return null;
            const parts = val.split('::');
            return { appName: parts[0], streamName: parts[1] };
        }

        function getStoredSelectedStreamValue() {
            try {
                return window.localStorage.getItem(STREAM_CONFIG_SELECTION_STORAGE_KEY) || '';
            } catch (error) {
                return '';
            }
        }

        function storeSelectedStreamValue(value) {
            try {
                if (value) {
                    window.localStorage.setItem(STREAM_CONFIG_SELECTION_STORAGE_KEY, value);
                } else {
                    window.localStorage.removeItem(STREAM_CONFIG_SELECTION_STORAGE_KEY);
                }
            } catch (error) {
                // Ignore storage issues and keep the page working normally.
            }
        }

        // An existing config shows the match it was created with, read-only, so the row keeps
        // its shape and Detector type stays in the same place; a clone is how to use another match.
        function showStoredMatch(stream) {
            document.getElementById('new-stream-fields').style.display = '';
            document.getElementById('cfg-new-app-name').value = stream.appName || '';
            document.getElementById('cfg-new-stream-name').value = stream.streamName || '';
            setMatchFieldsReadOnly(true);
            document.getElementById('match-overlap-note').style.display = 'none';
        }

        function setMatchFieldsReadOnly(readOnly) {
            ['cfg-new-app-name', 'cfg-new-stream-name'].forEach(function(id) {
                const input = document.getElementById(id);
                input.readOnly = readOnly;
                input.tabIndex = readOnly ? -1 : 0;
            });
            document.querySelectorAll('.top-field [data-match-help]').forEach(function(help) {
                help.style.display = (help.dataset.matchHelp === 'stored') === readOnly ? '' : 'none';
            });
        }

        var pendingMatchFieldReset = null;

        function resetNewStreamMatchFields() {
            const appInput = document.getElementById('cfg-new-app-name');
            const streamInput = document.getElementById('cfg-new-stream-name');
            appInput.placeholder = 'live';
            delete appInput.dataset.suggested;
            appInput.value = 'live';
            delete streamInput.dataset.suggested;
            streamInput.value = '';

            pendingMatchFieldReset = window.requestAnimationFrame(function() {
                if (!isNewStream()) return;
                appInput.value = appInput.placeholder || 'live';
                streamInput.value = streamInput.dataset.suggested || '';
            });
        }

        function applyDefaultFieldValue(input, defaultValue, fallbackValue) {
            const resolvedValue = defaultValue !== null && defaultValue !== undefined
                ? String(defaultValue)
                : String(fallbackValue);
            input.value = resolvedValue;
            input.placeholder = resolvedValue;
            // Remember what was suggested so a later suggestion may replace an untouched value
            // without ever overwriting one the user typed.
            input.dataset.suggested = resolvedValue;
        }

        // Keep the suggested Inference FPS in step with the detector type while creating a new
        // stream. VLM gets VLM_SUGGESTED_INFERENCE_FPS instead of the global default (-1 = match
        // source): -1 is allowed for VLM (VIS subsamples oversized windows), but a fixed rate
        // gives predictable, full-quality sampling out of the box; switching away restores the
        // global-derived suggestion. Verify gets its own rate — the one its review runs at, which
        // more frames do not improve. Only replaces an untouched suggestion.
        function suggestionTypeFor(detectorType) {
            return detectorType === 'chain' ? chainEntryType() : detectorType;
        }

        function applyDetectorTypeInferenceFpsSuggestion(detectorType) {
            if (!isNewStream()) return;
            detectorType = suggestionTypeFor(detectorType);
            const input = document.getElementById('cfg-inference-fps');
            if (input.value !== input.dataset.suggested) return;
            if (detectorType === 'verify') {
                applyDefaultFieldValue(input, VERIFY_SUGGESTED_INFERENCE_FPS, VERIFY_SUGGESTED_INFERENCE_FPS);
            } else if (detectorType === 'vlm') {
                applyDefaultFieldValue(input, VLM_SUGGESTED_INFERENCE_FPS, VLM_SUGGESTED_INFERENCE_FPS);
            } else {
                const globalDefault = Number.isFinite(defaultConfig && defaultConfig.inference_fps)
                    ? defaultConfig.inference_fps
                    : null;
                applyDefaultFieldValue(input, globalDefault, '-1');
            }
        }

        // Synthetic relays the source without transcoding by default; every other detector defaults
        // to transcoding. Mirror the inference-fps suggestion: only adjust on a new stream, and only
        // while the user hasn't manually toggled the checkbox away from the last suggested value.
        function applyDetectorTypeTranscoderSuggestion(detectorType) {
            if (!isNewStream()) return;
            detectorType = suggestionTypeFor(detectorType);
            const cb = document.getElementById('cfg-use-transcoder');
            if (cb.dataset.suggested !== undefined && String(cb.checked) !== cb.dataset.suggested) return;
            const suggested = detectorType !== 'synthetic' && detectorType !== 'verify';
            cb.checked = suggested;
            cb.dataset.suggested = String(suggested);
            updateSyntheticOverlayWarning();
        }

        // Verify scores whole windows and reviews their frames, so it wants a longer window than
        // the global default suggests; the same untouched-suggestion rule as the fps above.
        function applyDetectorTypeDurationSuggestion(detectorType) {
            if (!isNewStream()) return;
            detectorType = suggestionTypeFor(detectorType);
            const input = document.getElementById('cfg-duration');
            if (input.value !== input.dataset.suggested) return;
            if (detectorType === 'verify') {
                applyDefaultFieldValue(input, VERIFY_SUGGESTED_WINDOW_SECONDS, VERIFY_SUGGESTED_WINDOW_SECONDS);
            } else {
                const entry = computeEffectiveFieldDefaults()['cfg-duration'];
                applyDefaultFieldValue(input, entry.value, entry.fallback);
            }
        }

        // A Verify config is used by on-demand jobs, so its rule is an identity rather than a live
        // match; suggest the on-demand application while the operator has not typed one.
        function applyDetectorTypeApplicationSuggestion(detectorType) {
            if (!isNewStream()) return;
            detectorType = suggestionTypeFor(detectorType);
            const input = document.getElementById('cfg-new-app-name');
            const suggestedBefore = input.dataset.suggested !== undefined ? input.dataset.suggested : (input.placeholder || 'live');
            if (input.value !== suggestedBefore) return;
            const suggested = detectorType === 'verify' ? 'vod' : 'live';
            input.value = suggested;
            input.placeholder = suggested;
            input.dataset.suggested = suggested;
            updateMatchOverlapNote();
        }

        function freeVerifyConfigName(app) {
            const taken = {};
            Object.keys(streamRegistry).forEach(function(key) {
                const r = streamRegistry[key];
                if (r.kind === 'group' && r.app === app) taken[r.stream] = true;
            });
            let name = 'verify';
            for (let n = 2; taken[name]; n++) name = 'verify-' + n;
            return name;
        }

        function applyDetectorTypeStreamNameSuggestion(detectorType) {
            if (!isNewStream()) return;
            detectorType = suggestionTypeFor(detectorType);
            const input = document.getElementById('cfg-new-stream-name');
            if (input.value !== (input.dataset.suggested || '')) return;
            const appInput = document.getElementById('cfg-new-app-name');
            const app = (appInput.value || appInput.placeholder || '').trim();
            const suggested = detectorType === 'verify' ? freeVerifyConfigName(app) : '';
            input.value = suggested;
            if (suggested) input.dataset.suggested = suggested;
            else delete input.dataset.suggested;
            updateMatchOverlapNote();
        }

        // Seed for "+ New Stream Config": the global defaults, switched on, minus the blocks the form
        // must surface as placeholders rather than bake in as the stream's own values —
        // the verify thresholds always, and for a Verify config both stage blocks, whose
        // blanks inherit the Verify baseline rather than the live detectors' globals.
        function newConfigSeed(hintedType) {
            const seed = Object.assign({}, defaultConfig);
            seed.active = true;
            if (hintedType) seed.detector_type = hintedType;
            delete seed.verify_analysis;
            if (seed.detector_type === 'verify') {
                delete seed.vlm_analysis;
                delete seed.synthetic_analysis;
            } else if (seed.synthetic_analysis) {
                // How strict is not copied: startSyntheticStrictness() gives a new check its score.
                seed.synthetic_analysis = Object.assign({}, seed.synthetic_analysis);
                delete seed.synthetic_analysis.classification_threshold;
            }
            return seed;
        }

        // How strict on this config, until it is settled: `open` while no AI-generated video
        // detector was stored with it and the operator has picked nothing, `started` while the
        // score is the start given below.
        var syntheticStrictnessOpen = false;
        var syntheticStrictnessStarted = false;

        // An AI-generated video detector newly put on a config starts on Balanced. The start
        // comes off again when the type moves on, so it never outlives the detector it was for.
        function startSyntheticStrictness(detectorType) {
            const score = field(sectionsRoot, 'cfg-synthetic-classification-threshold');
            const start = String(VIF.chainPresets.SYNTHETIC_BALANCED);
            if (detectorType === 'synthetic') {
                if (!syntheticStrictnessOpen || score.value !== '') return;
                score.value = start;
                syntheticStrictnessStarted = true;
            } else {
                if (!syntheticStrictnessStarted) return;
                syntheticStrictnessStarted = false;
                if (score.value !== start) return;
                score.value = '';
            }
            showSyntheticStrictness(sectionsRoot);
        }

        function liveStageSeeds() {
            const va = (defaultConfig && defaultConfig.vlm_analysis) || {};
            const sy = (defaultConfig && defaultConfig.synthetic_analysis) || {};
            const number = function(raw) { return raw !== undefined && raw !== null ? String(raw) : ''; };
            return {
                'cfg-vlm-endpoint-url': va.endpoint_url || '',
                'cfg-vlm-api-key': va.api_key || '',
                'cfg-vlm-request-timeout': number(va.request_timeout_seconds),
                'cfg-synthetic-endpoint': sy.endpoint || '',
                'cfg-synthetic-use-tls': typeof sy.use_tls === 'boolean' ? String(sy.use_tls) : '',
                'cfg-synthetic-tls-ca-cert': sy.tls_ca_cert || '',
                'cfg-synthetic-tls-client-cert': sy.tls_client_cert || '',
                'cfg-synthetic-tls-client-key': sy.tls_client_key || '',
                'cfg-synthetic-api-key': sy.api_key || '',
                'cfg-synthetic-function-id': sy.function_id || ''
            };
        }

        // The stage-connection fields follow the detector type on a new config the way the
        // name suggestion does: only a field the operator has not touched moves. Verify's
        // seed is blank (a blank inherits the Verify baseline); the live types get back the
        // global block values newConfigSeed() gives them.
        function applyDetectorTypeStageFieldSuggestions(detectorType) {
            if (!isNewStream()) return;
            detectorType = suggestionTypeFor(detectorType);
            const seeds = liveStageSeeds();
            const verify = detectorType === 'verify';
            const seedModel = ((defaultConfig && defaultConfig.vlm_analysis) || {}).model_name
                || VLM_FALLBACK_DEFAULTS.model_name;
            let changed = false;
            Object.keys(seeds).forEach(function(id) {
                const input = field(sectionsRoot, id);
                const from = verify ? seeds[id] : '';
                const to = verify ? '' : seeds[id];
                if (from === to || input.value !== from) return;
                input.value = to;
                changed = true;
            });
            if (verify) {
                if (readVlmModelName(sectionsRoot) === seedModel) {
                    setVerifyReviewModel(sectionsRoot, '');
                    changed = true;
                }
            } else if (!readVlmModelName(sectionsRoot)) {
                setVlmModelName(sectionsRoot, seedModel);
                changed = true;
            }
            if (!changed) return;
            updateSyntheticEndpointFields(sectionsRoot);
            syncSectionApiKeyToggle(sectionsRoot, 'cfg-vlm-api-key', 'cfg-vlm-api-key-toggle');
            syncSectionApiKeyToggle(sectionsRoot, 'cfg-synthetic-api-key', 'cfg-synthetic-api-key-toggle');
            clearVlmEndpointTestResult(sectionsRoot);
            clearSvdEndpointTestResult(sectionsRoot);
        }

        function verifyBaseline() {
            return (defaultConfig && defaultConfig.verify_analysis) || {};
        }

        // The synthetic and VLM blocks serve two detectors each; their placeholders follow the
        // baseline of the one selected, so a Verify config sees the Verify baseline.
        function applyStagePlaceholdersForDetector(root, detectorType) {
            const verify = detectorType === 'verify';
            const sy = verify ? (verifyBaseline().svd || {}) : ((defaultConfig && defaultConfig.synthetic_analysis) || {});
            const va = verify ? (verifyBaseline().vlm || {}) : ((defaultConfig && defaultConfig.vlm_analysis) || {});
            showInheritedSyntheticEndpoint(root, sy);
            const url = field(root, 'cfg-vlm-endpoint-url');
            const effectiveUrl = va.endpoint_url || VLM_FALLBACK_DEFAULTS.endpoint_url;
            url.placeholder = effectiveUrl ? vlmEndpointPlaceholder(effectiveUrl) : 'vlm.docker:8000';
            const timeout = field(root, 'cfg-vlm-request-timeout');
            timeout.placeholder = va.request_timeout_seconds !== undefined && va.request_timeout_seconds !== null
                ? String(va.request_timeout_seconds) : '30';
        }

        // What a blank member of the synthetic block inherits, shown where the operator looks:
        // the placeholder, or the select's blank choice.
        function showInheritedSyntheticEndpoint(root, sy) {
            const endpoint = field(root, 'cfg-synthetic-endpoint');
            endpoint.placeholder = sy.endpoint || SVD_NO_DEFAULT_HINT;
            endpoint.dataset.globalDefault = sy.endpoint || '';
            endpoint.dataset.inherited = JSON.stringify({
                tls_ca_cert: sy.tls_ca_cert || '', tls_client_cert: sy.tls_client_cert || '',
                function_id: sy.function_id || '', use_tls: typeof sy.use_tls === 'boolean' ? sy.use_tls : null,
            });
            field(root, 'cfg-synthetic-function-id').dataset.globalDefault = sy.function_id || '';
            showInheritedSyntheticMembers(root);
            updateSyntheticEndpointFields(root);
        }

        // An own server of the other kind than the default's inherits nothing from it, as the
        // Engine fills it, so the hints go blank with it.
        function showInheritedSyntheticMembers(root) {
            const endpoint = field(root, 'cfg-synthetic-endpoint');
            if (!endpoint.dataset.inherited) return;
            const own = endpoint.value.trim();
            const below = endpoint.dataset.globalDefault || '';
            const inherits = !(own && below && isNvcfAddress(own) !== isNvcfAddress(below));
            const sy = inherits ? JSON.parse(endpoint.dataset.inherited) : { tls_ca_cert: '', tls_client_cert: '', function_id: '', use_tls: null };
            field(root, 'cfg-synthetic-tls-ca-cert').placeholder = sy.tls_ca_cert;
            field(root, 'cfg-synthetic-tls-client-cert').placeholder = sy.tls_client_cert;
            field(root, 'cfg-synthetic-function-id').placeholder = sy.function_id;
            const automatic = field(root, 'cfg-synthetic-use-tls').querySelector('option[value=""]');
            automatic.textContent = sy.use_tls === null ? 'Automatic' : 'Default (' + (sy.use_tls ? 'Always' : 'Never') + ')';
        }

        function verifyBaselineModel() {
            const vlm = verifyBaseline().vlm || {};
            return vlm.model_name || VIF.fieldRegistry.VERIFY_FALLBACK_REVIEW_MODEL;
        }

        // Verify reviews with one of the NVIDIA models the report's prompts were tuned for, and
        // a blank choice inherits the baseline's; the other detector types keep the full list.
        function applyVlmModelChoicesForDetector(root, detectorType) {
            const select = field(root, 'cfg-vlm-model-name');
            const inherit = field(root, 'cfg-vlm-model-inherit');
            const verify = detectorType === 'verify';
            inherit.style.display = verify ? '' : 'none';
            inherit.disabled = !verify;
            inherit.textContent = 'Default (' + verifyBaselineModel() + ')';
            Array.from(select.options).forEach(function(option) {
                if (option === inherit) return;
                const offered = !verify || option.value.indexOf('nvidia/') === 0 || option.dataset.stored === 'true';
                option.style.display = offered ? '' : 'none';
                option.disabled = !offered;
            });
            const selected = select.options[select.selectedIndex];
            if (!selected || selected.disabled) {
                select.value = verify ? '' : VLM_KNOWN_MODELS[0];
                toggleVlmModelNameOther(root);
            }
        }

        // The stored review model, the inherit choice when there is none; a model outside the
        // offered list is shown as its own entry rather than lost behind "Other".
        function setVerifyReviewModel(root, modelName) {
            const select = field(root, 'cfg-vlm-model-name');
            field(root, 'cfg-vlm-model-name-other').value = '';
            if (!modelName) {
                select.value = '';
            } else {
                if (!Array.from(select.options).some(function(option) { return option.value === modelName; })) {
                    const option = document.createElement('option');
                    option.value = modelName;
                    option.textContent = modelName;
                    option.dataset.stored = 'true';
                    select.insertBefore(option, select.querySelector('option[value="' + VLM_MODEL_OTHER + '"]'));
                }
                select.value = modelName;
            }
            toggleVlmModelNameOther(root);
        }

        function updateVerifyGateLine(root) {
            const line = field(root, 'verify-gate-line');
            if (!line) return;
            const baseline = verifyBaseline();
            const unit = function(raw, fallback) {
                const n = typeof raw === 'number' ? raw : parseFloat(raw);
                return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
            };
            const flag = unit(field(root, 'cfg-verify-flag-threshold').value, unit(baseline.flag_threshold, 0.3));
            const strong = unit(field(root, 'cfg-verify-strong-threshold').value, unit(baseline.strong_threshold, 0.9));
            line.textContent = 'score > ' + flag + ' → the window is reviewed · below → it stands as scored'
                + (strong < 1 ? ' · above ' + strong + ' → strong synthetic confidence, the VLM only explains' : '');
        }

        function takeNewConfigDetectorTypeHint() {
            try {
                const hint = window.localStorage.getItem(NEW_CONFIG_DETECTOR_TYPE_STORAGE_KEY);
                if (hint) window.localStorage.removeItem(NEW_CONFIG_DETECTOR_TYPE_STORAGE_KEY);
                if (hint === 'verify' && !VIF.core.verifyEnabled()) return null;
                return VIF.fieldRegistry.detectorTypes.indexOf(hint) !== -1 ? hint : null;
            } catch (error) {
                return null;
            }
        }

        function computeEffectiveFieldDefaults() {
            const byteTrackDefaults = defaultConfig
                && defaultConfig.object_analysis
                && defaultConfig.object_analysis.byte_track_properties
                ? defaultConfig.object_analysis.byte_track_properties
                : null;
            const tilingDefaults = defaultConfig
                && defaultConfig.object_analysis
                && defaultConfig.object_analysis.tiling_properties
                ? defaultConfig.object_analysis.tiling_properties
                : null;
            const objectConfidenceDefault = defaultConfig
                && defaultConfig.object_analysis
                && Number.isFinite(defaultConfig.object_analysis.confidence_threshold)
                ? Math.round(defaultConfig.object_analysis.confidence_threshold * 100)
                : null;
            const sceneSensitivityDefault = defaultConfig
                && defaultConfig.scene_analysis
                && Number.isFinite(defaultConfig.scene_analysis.sensitivity)
                ? defaultConfig.scene_analysis.sensitivity
                : null;
            const sceneConfidenceDefault = defaultConfig
                && defaultConfig.scene_analysis
                && Number.isFinite(defaultConfig.scene_analysis.confidence_threshold)
                ? Math.round(defaultConfig.scene_analysis.confidence_threshold * 100)
                : null;
            const motionDefaults = defaultConfig && defaultConfig.motion_analysis
                ? defaultConfig.motion_analysis
                : {};

            return {
                // A blanked address has to travel as the null that clears it, or the stored one
                // survives a save that cleared the field (collectUnsetFields).
                'cfg-vi-service-url': {
                    path: 'vi_service_url', fallback: '',
                    value: (defaultConfig && defaultConfig.vi_service_url) || null, skipNewStreamPrefill: true
                },
                'cfg-inference-fps': {
                    path: 'inference_fps', fallback: '-1',
                    value: Number.isFinite(defaultConfig && defaultConfig.inference_fps) ? defaultConfig.inference_fps : null
                },
                'cfg-rollup-batch-interval': {
                    path: 'rollup_batch_interval', fallback: '2',
                    value: Number.isFinite(defaultConfig && defaultConfig.rollup_batch_interval) ? defaultConfig.rollup_batch_interval : null
                },
                'cfg-confidence-threshold': {
                    path: 'object_analysis.confidence_threshold', fallback: '30', value: objectConfidenceDefault
                },
                'cfg-log-max-messages': {
                    path: 'log_max_messages', fallback: '20',
                    value: Number.isFinite(defaultConfig && defaultConfig.log_max_messages) ? defaultConfig.log_max_messages : null,
                    skipNewStreamPrefill: true
                },
                'cfg-log-timing': {
                    path: 'log_timing', fallback: '0',
                    value: Number.isFinite(defaultConfig && defaultConfig.log_timing) ? defaultConfig.log_timing : null,
                    skipNewStreamPrefill: true
                },
                'cfg-bt-min-confidence': {
                    path: 'object_analysis.byte_track_properties.track_creation_minimum_confidence', fallback: '50',
                    value: byteTrackDefaults && Number.isFinite(byteTrackDefaults.track_creation_minimum_confidence)
                        ? Math.round(byteTrackDefaults.track_creation_minimum_confidence * 100) : null
                },
                'cfg-bt-max-lost-frames': {
                    path: 'object_analysis.byte_track_properties.max_lost_track_frames_before_track_removal', fallback: '30',
                    value: byteTrackDefaults && Number.isFinite(byteTrackDefaults.max_lost_track_frames_before_track_removal)
                        ? byteTrackDefaults.max_lost_track_frames_before_track_removal : null
                },
                'cfg-bt-min-overlap': {
                    path: 'object_analysis.byte_track_properties.minimum_consecutive_track_overlap', fallback: '20',
                    value: byteTrackDefaults && Number.isFinite(byteTrackDefaults.minimum_consecutive_track_overlap)
                        ? Math.round(byteTrackDefaults.minimum_consecutive_track_overlap * 100) : null
                },
                'cfg-bt-min-frames': {
                    path: 'object_analysis.byte_track_properties.track_creation_minimum_consecutive_frames', fallback: '3',
                    value: byteTrackDefaults && Number.isFinite(byteTrackDefaults.track_creation_minimum_consecutive_frames)
                        ? byteTrackDefaults.track_creation_minimum_consecutive_frames : null
                },
                'cfg-tiling-min-rows': {
                    path: 'object_analysis.tiling_properties.min_slice_rows', fallback: '3',
                    value: tilingDefaults && Number.isFinite(tilingDefaults.min_slice_rows) ? tilingDefaults.min_slice_rows : null
                },
                'cfg-tiling-min-cols': {
                    path: 'object_analysis.tiling_properties.min_slice_cols', fallback: '2',
                    value: tilingDefaults && Number.isFinite(tilingDefaults.min_slice_cols) ? tilingDefaults.min_slice_cols : null
                },
                'cfg-tiling-max-rows': {
                    path: 'object_analysis.tiling_properties.max_slice_rows', fallback: '6',
                    value: tilingDefaults && Number.isFinite(tilingDefaults.max_slice_rows) ? tilingDefaults.max_slice_rows : null
                },
                'cfg-tiling-max-cols': {
                    path: 'object_analysis.tiling_properties.max_slice_cols', fallback: '4',
                    value: tilingDefaults && Number.isFinite(tilingDefaults.max_slice_cols) ? tilingDefaults.max_slice_cols : null
                },
                'cfg-tiling-coverage-cutoff': {
                    path: 'object_analysis.tiling_properties.tile_coverage_cutoff', fallback: '100',
                    value: tilingDefaults && Number.isFinite(tilingDefaults.tile_coverage_cutoff)
                        ? Math.round(tilingDefaults.tile_coverage_cutoff * 100) : null
                },
                'cfg-tiling-cluster-children': {
                    path: 'object_analysis.tiling_properties.cluster_suppression_min_children', fallback: '0',
                    value: tilingDefaults && Number.isFinite(tilingDefaults.cluster_suppression_min_children)
                        ? tilingDefaults.cluster_suppression_min_children : null
                },
                'cfg-duration': {
                    path: 'duration', fallback: '2',
                    value: Number.isFinite(defaultConfig && defaultConfig.duration) ? defaultConfig.duration : null
                },
                'cfg-scene-sensitivity': {
                    path: 'scene_analysis.sensitivity', fallback: '5', value: sceneSensitivityDefault
                },
                'cfg-scene-confidence-threshold': {
                    path: 'scene_analysis.confidence_threshold', fallback: '30', value: sceneConfidenceDefault
                },
                'cfg-motion-sensitivity': {
                    path: 'motion_analysis.sensitivity', fallback: '5',
                    value: Number.isFinite(motionDefaults.sensitivity) ? motionDefaults.sensitivity : null
                },
                'cfg-motion-min-displacement': {
                    path: 'motion_analysis.min_displacement', fallback: '2',
                    value: Number.isFinite(motionDefaults.min_displacement) ? Math.round(motionDefaults.min_displacement * 1000) / 10 : null
                },
                'cfg-motion-merge-distance': {
                    path: 'motion_analysis.merge_distance', fallback: '8',
                    value: Number.isFinite(motionDefaults.merge_distance) ? Math.round(motionDefaults.merge_distance * 1000) / 10 : null
                },
                'cfg-motion-suppress-global-changes': {
                    path: 'motion_analysis.suppress_global_changes', fallback: '', skipNewStreamPrefill: true,
                    value: typeof motionDefaults.suppress_global_changes === 'boolean'
                        ? (motionDefaults.suppress_global_changes ? 'Suppress' : 'Report') : null
                },
                // catch_up_max_behind_seconds has no global default in the shipped
                // Default.json (it's commented out - unset = ~2s server-side auto), so
                // `value` is null in the common case and refreshEffectiveDefaultPlaceholders()
                // below leaves the "auto (~2s)" markup literal alone (don't invent a number
                // that isn't actually configured). skipNewStreamPrefill: unlike every other
                // field here, this one is intentionally never value-prefilled for a new
                // stream (resetForm()/populateForm() leave it blank on purpose so the "auto"
                // placeholder shows) - only its placeholder participates in the P4-T2 refresh.
                'cfg-catch-up-max-behind': {
                    path: 'catch_up_max_behind_seconds', fallback: 'auto (~2s)', skipNewStreamPrefill: true,
                    value: Number.isFinite(defaultConfig && defaultConfig.catch_up_max_behind_seconds) ? defaultConfig.catch_up_max_behind_seconds : null
                },
                'cfg-frame-grab': {
                    path: 'frame_grab_interval', fallback: '',
                    value: Number.isFinite(defaultConfig && defaultConfig.frame_grab_interval) ? defaultConfig.frame_grab_interval : null
                },
                'cfg-inference-video-height-custom': {
                    path: 'inference_video_height', fallback: '', skipNewStreamPrefill: true,
                    value: Number.isFinite(defaultConfig && defaultConfig.inference_video_height) ? defaultConfig.inference_video_height : null,
                    isBlank: function() {
                        return document.getElementById('cfg-inference-video-height-mode').value === '';
                    }
                },
                // Synthetic stream-level scalars: present ONLY so collectUnsetFields()
                // can emit unset_fields when an input is blanked (synthetic_analysis is
                // deep-merged on save; a serialized null never clears a stored value).
                // value:null keeps them out of the placeholder/prefill passes --
                // populateForm() owns the synthetic placeholders.
                'cfg-synthetic-endpoint': { path: 'synthetic_analysis.endpoint', fallback: '', value: null, skipNewStreamPrefill: true },
                'cfg-synthetic-use-tls': { path: 'synthetic_analysis.use_tls', fallback: '', value: null, skipNewStreamPrefill: true },
                'cfg-synthetic-tls-ca-cert': { path: 'synthetic_analysis.tls_ca_cert', fallback: '', value: null, skipNewStreamPrefill: true },
                'cfg-synthetic-tls-client-cert': { path: 'synthetic_analysis.tls_client_cert', fallback: '', value: null, skipNewStreamPrefill: true },
                'cfg-synthetic-tls-client-key': { path: 'synthetic_analysis.tls_client_key', fallback: '', value: null, skipNewStreamPrefill: true },
                'cfg-synthetic-api-key': { path: 'synthetic_analysis.api_key', fallback: '', value: null, skipNewStreamPrefill: true },
                // The *_secret pickers: present so a slot switched back to a value clears its
                // stored reference — a blank picker with a stored name travels as an unset.
                'cfg-vi-service-api-key-secret': { path: 'vi_service_api_key_secret', fallback: '', value: null, skipNewStreamPrefill: true },
                'cfg-vlm-api-key-secret': { path: 'vlm_analysis.api_key_secret', fallback: '', value: null, skipNewStreamPrefill: true },
                'cfg-synthetic-api-key-secret': { path: 'synthetic_analysis.api_key_secret', fallback: '', value: null, skipNewStreamPrefill: true },
                'cfg-synthetic-tls-client-key-secret': { path: 'synthetic_analysis.tls_client_key_secret', fallback: '', value: null, skipNewStreamPrefill: true },
                'cfg-synthetic-function-id': { path: 'synthetic_analysis.function_id', fallback: '', value: null, skipNewStreamPrefill: true },
                'cfg-synthetic-classification-threshold': { path: 'synthetic_analysis.classification_threshold', fallback: '', value: null, skipNewStreamPrefill: true }
            };
        }

        function applySuggestedDefaultsForNewStream(root) {
            const defaults = computeEffectiveFieldDefaults();
            Object.keys(defaults).forEach(function(id) {
                const entry = defaults[id];
                if (entry.skipNewStreamPrefill) return;
                const input = rootInput(root, id);
                if (input) applyDefaultFieldValue(input, entry.value, entry.fallback);
            });
        }

        function refreshEffectiveDefaultPlaceholders(root) {
            const defaults = computeEffectiveFieldDefaults();
            Object.keys(defaults).forEach(function(id) {
                const entry = defaults[id];
                if (entry.value === null || entry.value === undefined) return;
                const input = rootInput(root, id);
                if (!input) return;
                if (input.tagName === 'SELECT') {
                    const blank = Array.prototype.find.call(input.options, function(option) {
                        return option.value === '';
                    });
                    if (blank) blank.textContent = 'Default (' + entry.value + ')';
                } else {
                    input.placeholder = String(entry.value);
                }
            });
        }

        function isFieldUnsettable(path) {
            const field = VIF.fieldRegistry.getFieldByPath(path);
            return !!field && field.inheritMode === 'blank-inherits';
        }

        function isFieldBlank(root, id, entry) {
            if (typeof entry.isBlank === 'function') return entry.isBlank();
            const input = rootInput(root, id);
            return !input || !input.value || !input.value.trim();
        }

        function readNumericInputValue(id, integer, scale) {
            return readNumber(document.getElementById(id), integer, scale);
        }

        function readNumber(input, integer, scale) {
            const raw = (input.value || '').trim();
            if (raw === '') return undefined;
            const number = integer ? parseInt(raw, 10) : parseFloat(raw);
            if (!Number.isFinite(number)) return undefined;
            return scale ? number / scale : number;
        }

        function fieldAppliesToDetector(path, detectorType) {
            const field = VIF.fieldRegistry.getFieldByPath(path);
            return !field || field.detectors.indexOf(detectorType) !== -1;
        }

        function getConfigValueAtPath(obj, path) {
            if (!obj || !path) return undefined;
            const parts = path.split('.');
            let current = obj;
            for (let i = 0; i < parts.length; i++) {
                if (current === null || current === undefined) return undefined;
                current = current[parts[i]];
            }
            return current;
        }

        function collectUnsetFields(root) {
            if (isNewStream()) return [];
            const defaults = computeEffectiveFieldDefaults();
            const paths = [];
            Object.keys(defaults).forEach(function(id) {
                const entry = defaults[id];
                if (!isFieldUnsettable(entry.path)) return;
                if (!isFieldBlank(root, id, entry)) return;
                const stored = getConfigValueAtPath(lastRawStreamConfig, entry.path);
                if (stored === null || stored === undefined) return;
                paths.push(entry.path);
            });
            return paths;
        }

        function resolveEffectiveInferenceFpsForVlm() {
            const raw = (document.getElementById('cfg-inference-fps').value || '').trim();
            const parsed = raw !== '' ? parseFloat(raw) : NaN;
            if (Number.isFinite(parsed)) return parsed;
            const globalDefault = Number.isFinite(defaultConfig && defaultConfig.inference_fps)
                ? defaultConfig.inference_fps
                : null;
            return globalDefault !== null ? globalDefault : VLM_SUGGESTED_INFERENCE_FPS;
        }

        function updateVlmImagesMeter() {
            const meterEl = document.getElementById('vlm-images-meter');
            if (!meterEl) return;
            const detectorType = document.getElementById('cfg-detector-type').value;
            if (detectorType !== 'vlm') {
                meterEl.style.display = 'none';
                meterEl.classList.remove('text-warn');
                return;
            }
            const durationRaw = (document.getElementById('cfg-duration').value || '').trim();
            const duration = durationRaw !== '' ? parseFloat(durationRaw) : NaN;
            const effectiveFps = resolveEffectiveInferenceFpsForVlm();
            if (!Number.isFinite(duration) || !Number.isFinite(effectiveFps)) {
                meterEl.style.display = 'none';
                meterEl.classList.remove('text-warn');
                return;
            }
            meterEl.style.display = 'block';
            // -1 (match source): the image count depends on the source frame rate, which
            // isn't known here, so there's no N to show - just the informational note.
            if (effectiveFps === -1) {
                meterEl.classList.add('text-warn');
                meterEl.textContent = 'Matches the source frame rate, so the window cannot be held to the endpoint’s image cap — set a fixed rate. A VLM config with -1 does not save.';
                return;
            }
            const images = Math.round(duration * effectiveFps * 100) / 100;
            if (images > VLM_TYPICAL_ENDPOINT_IMAGE_CAP) {
                meterEl.classList.add('text-warn');
                meterEl.textContent = `Images per request: ${images} — over the endpoint's image cap (${VLM_TYPICAL_ENDPOINT_IMAGE_CAP}). Lower Duration or Inference FPS; a config over the cap does not save.`;
            } else {
                meterEl.classList.remove('text-warn');
                meterEl.textContent = `Images per request: ${images}`;
            }
        }

        function togglePanel(header) {
            const body = header.nextElementSibling;
            header.classList.toggle('collapsed');
            body.classList.toggle('collapsed');
            const wrapper = header.closest('.form-wrapper') || header.closest('.event-listeners-panel');
            if (wrapper) wrapper.classList.toggle('collapsed');
        }

        function toggleVisServiceApiKeyVisibility() {
            const input = document.getElementById('cfg-vi-service-api-key');
            const btn   = document.getElementById('cfg-vi-service-api-key-toggle');
            const hide  = input.type === 'password';
            input.type      = hide ? 'text' : 'password';
            btn.textContent = hide ? 'Hide' : 'Show';
        }

        function toggleSyntheticApiKeyVisibility(root) {
            const input = field(root, 'cfg-synthetic-api-key');
            const btn   = field(root, 'cfg-synthetic-api-key-toggle');
            const hide  = input.type === 'password';
            input.type      = hide ? 'text' : 'password';
            btn.textContent = hide ? 'Hide' : 'Show';
        }

        // API Key / Function ID are NVCF-only credentials (a self-hosted detector ignores them),
        // so they show only when the effective endpoint (field value, else the global default
        // mirrored into data-global-default) is NVIDIA's hosted one; every other endpoint gets
        // the mTLS hint instead — mTLS is the only client authentication a self-hosted detector
        // supports.
        // The effective endpoint is the field value layered over the global default
        // (mirrored into data-global-default by populateForm).
        function syntheticEndpointIsNvcf(root) {
            const endpointInput = field(root, 'cfg-synthetic-endpoint');
            if (!endpointInput) return false;
            return isNvcfAddress(endpointInput.value.trim() || (endpointInput.dataset.globalDefault || ''));
        }

        function isNvcfAddress(address) {
            return /(^|\.)nvcf\.nvidia\.com(:\d+)?$/i.test(address || '');
        }

        // NVIDIA's proxy refuses a call without a function ID before it checks the key, so
        // neither Verify nor the analysis could tell a wrong key from a right one.
        var NVCF_FUNCTION_ID_REQUIRED = "NVIDIA's hosted detector requires a Function ID.";

        function hostedSvdLacksFunctionId(address, functionId) {
            return isNvcfAddress((address || '').trim()) && !(functionId || '').trim();
        }

        // The function ID a config inherits from a default: none when its own server is of the other
        // kind than the default's, hosted against self-hosted, as the Engine fills it.
        function inheritedFunctionId(ownAddress, defaultAddress, defaultFunctionId) {
            const own = (ownAddress || '').trim();
            const below = (defaultAddress || '').trim();
            if (own && below && isNvcfAddress(own) !== isNvcfAddress(below)) return '';
            return defaultFunctionId || '';
        }

        // What a blank detector server box shows when Stream Config Defaults has none.
        var SVD_NO_DEFAULT_HINT = 'e.g. svd.docker:8001 (no default set)';

        function syntheticStrictness(root) {
            const choice = field(root, 'synthetic-strictness');
            if (!choice.vifStrictness) {
                choice.vifStrictness = VIF.chainSteps.strictness(function() {
                    return field(root, 'cfg-synthetic-classification-threshold');
                });
            }
            return choice.vifStrictness;
        }

        // The How strict choice follows the score field: blank is the default, the two named
        // settings are NVIDIA's, anything else is the user's own and shows as a percentage.
        // `loaded` says the score was just loaded, so a "My own" picked before no longer holds.
        function showSyntheticStrictness(root, loaded) {
            const choice = field(root, 'synthetic-strictness');
            const score = field(root, 'cfg-synthetic-classification-threshold');
            if (!choice || !score) return;
            const strict = syntheticStrictness(root);
            if (loaded) strict.forget();
            choice.options[0].textContent = strict.options()[0][1];
            choice.value = strict.get();
            const own = field(root, 'synthetic-strictness-own');
            const custom = choice.value === 'custom';
            field(root, 'synthetic-strictness-own-row').style.display = custom ? 'inline-flex' : 'none';
            if (custom && document.activeElement !== own) own.value = String(VIF.chainSteps.toPercent(Number(score.value)));
        }

        function syntheticStrictnessPicked(root) {
            if (root !== sectionsRoot) return;
            syntheticStrictnessOpen = false;
            syntheticStrictnessStarted = false;
        }

        function pickSyntheticStrictness(root) {
            const choice = field(root, 'synthetic-strictness');
            syntheticStrictnessPicked(root);
            if (syntheticStrictness(root).set(choice.value)) fireFieldChange(field(root, 'cfg-synthetic-classification-threshold'));
            else showSyntheticStrictness(root);
        }

        // A percentage typed as the user's own setting; an unfinished one leaves the score alone.
        function typeSyntheticStrictness(root) {
            const own = field(root, 'synthetic-strictness-own');
            const score = field(root, 'cfg-synthetic-classification-threshold');
            const percent = Number(own.value);
            if (own.value.trim() === '' || !isFinite(percent)) return;
            syntheticStrictnessPicked(root);
            syntheticStrictness(root).keepOwn();
            const next = String(VIF.chainSteps.fromPercent(Math.min(100, Math.max(0, percent))));
            if (next === score.value) return;
            score.value = next;
            fireFieldChange(score);
        }

        function updateSyntheticEndpointFields(root) {
            const nvcfFields = field(root, 'synthetic-nvcf-fields');
            const mtlsHint   = field(root, 'synthetic-mtls-hint');
            const tlsCerts   = field(root, 'synthetic-tls-cert-fields');
            if (!nvcfFields || !mtlsHint || !tlsCerts) return;
            const isNvcf = syntheticEndpointIsNvcf(root);
            nvcfFields.style.display = isNvcf ? 'block' : 'none';
            mtlsHint.style.display   = isNvcf ? 'none' : 'block';
            tlsCerts.style.display   = isNvcf ? 'none' : 'block';
        }

        function setSyntheticTlsCertsExpanded(root, show) {
            field(root, 'cfg-synthetic-tls-certs').style.display = show ? 'block' : 'none';
            field(root, 'cfg-synthetic-tls-certs-caret').innerHTML = show ? '&#9662;' : '&#9656;';
        }

        function toggleSyntheticTlsCerts(root) {
            setSyntheticTlsCertsExpanded(root, field(root, 'cfg-synthetic-tls-certs').style.display === 'none');
        }

        function toggleMotionAdvanced(root) {
            const fields = field(root, 'cfg-motion-advanced');
            const show = fields.style.display === 'none';
            fields.style.display = show ? 'block' : 'none';
            field(root, 'cfg-motion-advanced-caret').innerHTML = show ? '&#9662;' : '&#9656;';
        }

        function toggleVlmApiKeyVisibility(root) {
            const input = field(root, 'cfg-vlm-api-key');
            const btn   = field(root, 'cfg-vlm-api-key-toggle');
            const hide  = input.type === 'password';
            input.type      = hide ? 'text' : 'password';
            btn.textContent = hide ? 'Hide' : 'Show';
        }

        // Disable an API-key Show/Hide toggle when its field is empty (nothing to reveal), and
        // snap the field back to masked so it can never be left showing an empty value.
        // A stored key is never echoed, so its input is blank on every load and the
        // save cannot tell "leave it alone" from "clear it" by looking at the field.
        // This is the explicit way to say the second one: it marks the input as typed
        // in, which is what resolves the secret to the empty string the API reads as
        // a clear. Without it the only way through was to type a character and delete
        // it again.
        //
        // "Disable" means this stream stops carrying a key of its own and inherits the
        // default config's. It is not a way to reach VIS with no key at all -- an
        // unset key resolves to the layer below, and the root falls back to the
        // VIS_API_KEY environment template.
        function clearVisServiceApiKey() {
            var input = document.getElementById('cfg-vi-service-api-key');
            if (!input) return;
            input.value = '';
            touchedSecrets['vi_service_api_key'] = true;
            syncApiKeyToggleState('cfg-vi-service-api-key', 'cfg-vi-service-api-key-toggle');
            markDirty();
            updateSaveButtonState();
        }

        function syncApiKeyToggleState(inputId, toggleId) {
            syncApiKeyToggle(document.getElementById(inputId), document.getElementById(toggleId));
        }

        function syncSectionApiKeyToggle(root, inputBaseId, toggleBaseId) {
            syncApiKeyToggle(field(root, inputBaseId), field(root, toggleBaseId));
        }

        // "Save as secret" stores what was typed, so like Show it waits for a value.
        function syncSaveAsSecret(input) {
            const btn = input && input.parentElement && input.parentElement.querySelector('.secret-save-as');
            if (btn) btn.disabled = (input.value || '').trim() === '';
        }

        function syncApiKeyToggle(input, btn) {
            syncSaveAsSecret(input);
            if (!input || !btn) return;
            const empty = (input.value || '').trim() === '';
            btn.disabled = empty;
            if (empty) {
                input.type      = 'password';
                btn.textContent = 'Show';
            }
        }

        function syncAllApiKeyToggles() {
            syncApiKeyToggleState('cfg-vi-service-api-key', 'cfg-vi-service-api-key-toggle');
            syncSectionApiKeyToggle(sectionsRoot, 'cfg-synthetic-api-key', 'cfg-synthetic-api-key-toggle');
            syncSectionApiKeyToggle(sectionsRoot, 'cfg-vlm-api-key', 'cfg-vlm-api-key-toggle');
            // Every slot on the page, chain stage cards and toggle-less slots included: the
            // loading state's bulk enable reaches them all.
            document.querySelectorAll('.secret-save-as').forEach(function(btn) {
                syncSaveAsSecret(btn.parentElement.querySelector('input'));
            });
        }

        // ── credential slots: a value or a stored secret, never both ─────────
        // Each credential field may hold the literal (the password/path input, tri-state as
        // ever) OR a reference into the global secrets document — exclusive per field, the
        // way the API refuses a write carrying both. `base` is the literal input's id; the
        // mode select is <base>-source, the name picker <base>-secret, and the literal's
        // wrapper <base>-value-row. A reference is readable, so the picker shows the saved
        // name; anything else — a stored literal or an empty slot — opens in value mode,
        // where the placeholder copy steers toward a stored secret without hiding the
        // value-row controls behind a mode switch.
        //
        // The three in-section slots exist once per instantiated root — the standalone
        // page and every chain stage card — so every function here takes the root. A null
        // root means the page itself: the VIS service key's slot lives outside the
        // sections and is the one caller that passes it.
        function slotEl(root, id) {
            return root ? field(root, id) : document.getElementById(id);
        }

        function secretSourceIsStored(root, base) {
            var source = slotEl(root, base + '-source');
            return !!source && source.value === 'stored';
        }

        /** The flat path a slot saves its literal under, from SECRET_INPUTS. */
        function secretPathOf(base) {
            var paths = Object.keys(SECRET_INPUTS);
            for (var i = 0; i < paths.length; i++) {
                if (SECRET_INPUTS[paths[i]] === base) return paths[i];
            }
            return null;
        }

        // The touch tracker serves the standalone form's tri-state; a stage card's
        // literals ride whole with its stage, so its slots never touch it.
        function forgetTouchedSecret(root, base) {
            if (root && sectionPrefix(root)) return;
            var path = secretPathOf(base);
            if (path) delete touchedSecrets[path];
        }

        function syncSlotApiKeyToggle(root, base) {
            if (root) syncSectionApiKeyToggle(root, base, base + '-toggle');
            else syncApiKeyToggleState(base, base + '-toggle');
        }

        function secretSourceChanged(root, base) {
            applySecretSourceVisibility(root, base);
            if (secretSourceIsStored(root, base)) {
                // The slot holds one form: entering stored mode withdraws anything typed,
                // or the save would carry a literal beside the reference and be refused.
                var input = slotEl(root, base);
                if (input) input.value = '';
                forgetTouchedSecret(root, base);
                syncSlotApiKeyToggle(root, base);
            } else {
                // Back to a value: the blanked picker is what clears the stored name on save.
                var picker = slotEl(root, base + '-secret');
                if (picker) picker.value = '';
            }
            markDirty();
            updateSaveButtonState();
        }

        function applySecretSourceVisibility(root, base) {
            var stored = secretSourceIsStored(root, base);
            var valueRow = slotEl(root, base + '-value-row');
            var picker = slotEl(root, base + '-secret');
            var storeRow = slotEl(root, base + '-store-row');
            if (valueRow) valueRow.style.display = stored ? 'none' : '';
            if (picker) picker.style.display = stored ? '' : 'none';
            if (storeRow && stored) storeRow.style.display = 'none';
        }

        /** The reference this save sends for the slot, or undefined when it holds a value. */
        function referenceValue(root, base) {
            if (!secretSourceIsStored(root, base)) return undefined;
            var picker = slotEl(root, base + '-secret');
            return (picker && picker.value) || undefined;
        }

        // ── "Save as secret": promote a typed value into the secrets document ─
        // In value mode, one click stores what was typed under a name and switches the
        // slot to that stored secret — the value lands in the document, never in the
        // config file.
        function promptStoreSecret(root, base) {
            if (!base) return;
            var input = slotEl(root, base);
            if (!input || !(input.value || '').trim()) {
                showStatus('Type the value first, then save it as a secret.', true);
                return;
            }
            var row = slotEl(root, base + '-store-row');
            if (row) {
                row.style.display = '';
                var name = slotEl(root, base + '-store-name');
                if (name) name.focus();
            }
        }

        function cancelStoreSecret(root, base) {
            if (!base) return;
            var row = slotEl(root, base + '-store-row');
            if (row) row.style.display = 'none';
        }

        async function confirmStoreSecret(root, base) {
            if (!base) return;
            var input = slotEl(root, base);
            var nameInput = slotEl(root, base + '-store-name');
            var value = input ? (input.value || '').trim() : '';
            var name = nameInput ? (nameInput.value || '').trim() : '';
            if (!name || !value) {
                showStatus('A secret needs both a name and the typed value.', true);
                return;
            }
            if (secretNamesLoaded.indexOf(name) !== -1) {
                showStatus('Secret "' + name + '" already exists — pick it from the list, or rotate it on the Secrets page.', true);
                return;
            }
            try {
                var values = {};
                values[name] = value;
                var secrets = VIF.core.client().persist.secrets();
                await secrets.get();
                secretNamesLoaded = (await secrets.update({ values: values })).names || secretNamesLoaded;
            } catch (error) {
                showStatus(error.message, true);
                return;
            }
            fillSecretPickers();
            if (nameInput) nameInput.value = '';
            cancelStoreSecret(root, base);
            // The value now lives in the document; the slot switches to it by name and
            // the typed literal is withdrawn so the save carries the reference alone.
            setSecretSlot(root, base, name);
            forgetTouchedSecret(root, base);
            if (input) input.value = '';
            syncSlotApiKeyToggle(root, base);
            markDirty();
            updateSaveButtonState();
            showStatus('Secret "' + name + '" saved — this field now uses it.', false);
        }

        function setPickerValue(picker, name) {
            // A stored reference always shows, even when its name has left the document.
            var known = Array.prototype.some.call(picker.options, function(o) { return o.value === name; });
            if (!known) {
                var opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name + ' (not configured)';
                picker.appendChild(opt);
            }
            picker.value = name;
        }

        function setSecretSlot(root, base, referenceName) {
            var source = slotEl(root, base + '-source');
            var picker = slotEl(root, base + '-secret');
            if (!source || !picker) return;
            // A reference is readable, so the slot shows it by name; anything else opens in
            // value mode — a stored literal is invisible to a read, and showing the picker
            // over it would report a configured slot as empty and hide the value-row
            // controls. An untouched save keeps the stored form either way.
            source.value = referenceName ? 'stored' : 'value';
            if (referenceName) setPickerValue(picker, referenceName);
            else picker.value = '';
            applySecretSourceVisibility(root, base);
        }

        function fillSecretPicker(picker) {
            if (!picker) return;
            var selected = picker.value;
            picker.innerHTML = '';
            var none = document.createElement('option');
            none.value = '';
            none.textContent = secretNamesLoaded.length
                ? '(pick a secret)' : '(none — add one on the Secrets page)';
            picker.appendChild(none);
            secretNamesLoaded.forEach(function(name) {
                var opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                picker.appendChild(opt);
            });
            if (selected) setPickerValue(picker, selected);
        }

        function fillSecretPickers() {
            fillSecretPicker(document.getElementById('cfg-vi-service-api-key-secret'));
            document.querySelectorAll('[data-vif-prefix]').forEach(function(root) {
                SECTION_SECRET_SOURCES.forEach(function(base) {
                    fillSecretPicker(field(root, base + '-secret'));
                });
            });
        }

        async function loadSecretNames() {
            try {
                secretNamesLoaded = (await VIF.core.client().persist.secrets().get()).names || [];
            } catch (error) {
                secretNamesLoaded = [];
            }
            fillSecretPickers();
        }

        // The credential inputs, by the flat path a save names each one under.
        var SECRET_INPUTS = {
            'vi_service_api_key': 'cfg-vi-service-api-key',
            'vlm_analysis.api_key': 'cfg-vlm-api-key',
            'synthetic_analysis.api_key': 'cfg-synthetic-api-key',
            'synthetic_analysis.tls_client_key': 'cfg-synthetic-tls-client-key'
        };

        // A credential is never echoed back, so a blank input is ambiguous on its own:
        // it means "leave the stored one alone" until the operator types in it, and
        // "clear it" once they have. Typing during this session is the whole signal,
        // and it is forgotten whenever the form is repopulated.
        var touchedSecrets = {};

        // `touched` is read at keystroke time: resetForm() replaces the standalone map.
        function watchSecretInputs(root, touched) {
            Object.keys(SECRET_INPUTS).forEach(function(path) {
                const input = rootInput(root, SECRET_INPUTS[path]);
                if (input) input.addEventListener('input', function() { touched()[path] = true; });
            });
        }

        // The tri-state each credential resolves to at save time, from the value the
        // flat body carries and whether the operator typed it. A path with nothing to
        // say is left out, so an unset_fields entry for it still clears it.
        function collectSecrets(config) {
            const secrets = {};
            Object.keys(SECRET_INPUTS).forEach(function(path) {
                // A slot in stored-secret mode holds the name; its literal is withdrawn
                // entirely — the API refuses a write carrying both forms.
                if (secretSourceIsStored(null, SECRET_INPUTS[path])) return;
                const value = VIF.v2map.secretValue(
                    !!touchedSecrets[path], getConfigValueAtPath(config, path));
                if (value !== undefined) secrets[path] = value;
            });
            if (config.detector_type === 'chain') Object.assign(secrets, collectChainStageSecrets());
            return secrets;
        }

        // The resource the selected dropdown entry addresses; null while
        // '+ New Stream Config...' is selected.
        function getSelectedResource() {
            const select = document.getElementById('cfg-stream-select');
            return streamRegistry[select.value] || null;
        }

        /**
         * Warns, while a NEW config's rule is typed, when it can claim the same
         * streams as an existing group. Regex intersection in general is
         * undecidable, so this tests the practical case both ways: one rule's
         * pattern, read as a literal stream name, matching the other's regex.
         * That catches exact-vs-pattern overlaps (synth_ vs synth.*) and
         * outright duplicates.
         */
        function updateMatchOverlapNote() {
            const note = document.getElementById('match-overlap-note');
            if (!note) return;
            if (!isNewStream()) { note.style.display = 'none'; return; }
            const appInput = document.getElementById('cfg-new-app-name');
            const app = (appInput.value || appInput.placeholder || '').trim();
            const pattern = document.getElementById('cfg-new-stream-name').value.trim();
            if (!pattern) { note.style.display = 'none'; return; }
            const asWholeRegex = function (p) {
                try { return new RegExp('^(?:' + p + ')$'); } catch (e) { return null; }
            };
            const mineRe = asWholeRegex(pattern);
            const hits = [];
            Object.keys(streamRegistry).forEach(function (key) {
                const r = streamRegistry[key];
                if (r.kind !== 'group' || r.app !== app) return;
                const theirsRe = asWholeRegex(r.stream);
                if ((theirsRe && theirsRe.test(pattern)) || (mineRe && mineRe.test(r.stream))) {
                    hits.push(r.app + ' / ' + r.stream);
                }
            });
            if (!hits.length) { note.style.display = 'none'; return; }
            note.textContent = '';
            const icon = document.createElement('span');
            icon.textContent = '!';
            icon.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;'
                + 'width:14px;height:14px;border-radius:50%;background:#e09600;color:#fff;'
                + 'font-weight:700;font-size:10px;line-height:1;flex:none;';
            note.appendChild(icon);
            note.appendChild(document.createTextNode(
                'A stream config already matches this pattern: ' + hits.join(' and ')));
            note.style.display = 'flex';
        }

        // The selected entry's own stored document, flattened to the shape the form
        // reads. Sparse in, sparse out: an unset member stays absent, so it renders
        // blank over its effective-default placeholder rather than inheriting a value.
        async function readConfig(resource) {
            return VIF.v2map.flatFromGroup(await readSavedDocument(resource));
        }

        // The selected entry as the server stores it, in the shape of a stream group
        // config: a per-stream override reads as a rule matching its one stream.
        async function readSavedDocument(resource) {
            const persist = VIF.core.client().persist;
            if (resource.kind !== 'override') return persist.streamGroupConfigs.get(resource.name);
            const override = await persist.streams.get(resource.app, resource.stream);
            // The facade answers null for an override that is gone; the dropdown
            // listed it, so here that is an error to show, not a layer to inherit.
            if (override === null) {
                throw new VIF.sdk.NotFoundError(
                    `Stream ${resource.app}/${resource.stream} has no override any more`, 404, null);
            }
            return {
                name: VIF.v2map.deriveName(resource.app, resource.stream),
                match: { application: resource.app, streamPattern: resource.stream },
                config: override.config
            };
        }

        // One dropdown row, plus the resource it addresses under the same
        // '<app>::<stream>' key the option value carries.
        function registerStream(resource) {
            streamsList.push({ app_name: resource.app, stream_name: resource.stream });
            streamRegistry[`${resource.app}::${resource.stream}`] = resource;
        }

        async function loadStreams(preferredValue) {
            const select = document.getElementById('cfg-stream-select');
            setFormLoading(true);
            try {
                const storedValue = getStoredSelectedStreamValue();
                const currentValue = preferredValue !== undefined
                    ? preferredValue
                    : (select.value || storedValue);
                const client = VIF.core.client();
                // The flat defaultConfig is assembled from three routes: the default
                // config, the model catalog and the listener types.
                const [groups, defaults, catalog, listenerTypes, overrides] = await Promise.all([
                    client.persist.streamGroupConfigs.list(),
                    client.persist.streamGroupConfigs.default().get(),
                    client.models(),
                    client.listenerTypes(),
                    client.persist.streams.list()
                ]);

                // The flat global defaults every downstream consumer reads: the model
                // dropdown, the listener editor, the VLM modules and the
                // effective-default placeholders.
                defaultConfig = VIF.v2map.flatDefaultFromV2(defaults, catalog, listenerTypes);

                // Both listings arrive in the server's stored order (priority, then
                // application, then stream); groups precede the per-stream overrides.
                streamRegistry = {};
                streamsList = [];
                groups.forEach(function (group) {
                    const match = group.match || {};
                    registerStream({
                        kind: 'group', name: group.name,
                        app: match.application, stream: match.streamPattern
                    });
                });
                overrides.forEach(function (override) {
                    registerStream({
                        kind: 'override', app: override.application, stream: override.stream
                    });
                });
                refreshEffectiveDefaultPlaceholders(sectionsRoot);
                populateClassNameDropdown();
                populateCheckpointPaths(sectionsRoot);

                select.innerHTML = '';

                const newOpt = document.createElement('option');
                newOpt.value = '__new__';
                newOpt.textContent = '+ New Stream Config...';
                select.appendChild(newOpt);

                streamsList.forEach((stream, index) => {
                    const opt = document.createElement('option');
                    opt.value = `${stream.app_name}::${stream.stream_name}`;
                    opt.textContent = `${stream.app_name} / ${stream.stream_name}`;
                    select.appendChild(opt);
                });

                const hasPreferredValue = currentValue
                    && Array.from(select.options).some(function(opt) { return opt.value === currentValue; });

                if (hasPreferredValue) {
                    select.value = currentValue;
                } else if (streamsList.length > 0) {
                    select.value = select.options[1].value;
                }

                onStreamSelected();

            } catch (error) {
                console.error("Error loading streams:", error);
                select.innerHTML = '<option value="">Error loading streams</option>';
                showStatus(`Error loading streams: ${error.message}`, true);
                setFormLoading(false);
            }
        }


        function isNewStream() {
            return document.getElementById('cfg-stream-select').value === '__new__';
        }

        var LEAVE_UNSAVED = 'You have unsaved changes. Leave without saving?';

        // The window-wide guards below are bound once while this script can run several times
        // per visit, so they read the unsaved badge on screen rather than any one run's state.
        window.__vifStreamConfigUnsaved = function() {
            const badge = document.getElementById('dirty-indicator');
            return !!badge && !!document.getElementById('cfg-stream-select') && badge.classList.contains('state-unsaved')
                && badge.style.visibility !== 'hidden';
        };

        // The + beside the picker: the same switch as picking the picker's own new-config entry.
        function newConfig() {
            const picker = document.getElementById('cfg-stream-select');
            if (picker.value === '__new__') return;
            window.__vifStreamPickerBefore = picker.value;
            picker.value = '__new__';
            onStreamSelected();
        }

        function onStreamSelected() {
            const picker = document.getElementById('cfg-stream-select');
            // The picker's value before the user opened it, so a declined switch can put it back.
            const before = window.__vifStreamPickerBefore;
            window.__vifStreamPickerBefore = null;
            if (window.__vifStreamConfigUnsaved() && before != null && picker.value !== before && !window.confirm(LEAVE_UNSAVED)) {
                picker.value = before;
                return;
            }
            hideStatus();
            copiedPriority = null;
            copiedLimits = null;
            const newFields = document.getElementById('new-stream-fields');
            const deleteBtnTop = document.getElementById('btn-delete-top');
            const cloneBtnTop = document.getElementById('btn-clone-top');
            const downloadBtnTop = document.getElementById('btn-download-top');
            const uploadBtnTop = document.getElementById('btn-upload-top');
            const listenersPanel = document.querySelector('.event-listeners-panel');
            const select = document.getElementById('cfg-stream-select');
            storeSelectedStreamValue(select ? select.value : '');
            if (isNewStream()) {
                newFields.style.display = '';
                deleteBtnTop.style.display = 'none';
                cloneBtnTop.style.display = 'none';
                downloadBtnTop.style.display = 'none';
                uploadBtnTop.style.display = 'inline-block';
                listenersPanel.style.display = '';
                suppressDirtyTracking = true;
                const hintedType = takeNewConfigDetectorTypeHint();
                populateForm(newConfigSeed(hintedType));
                // A new stream leaves the service address and key and the troubleshooting boxes
                // blank so they follow Stream Config Defaults, rather than keeping a copy of today's
                // values. populateForm(defaultConfig) above filled them in, so clear them back;
                // their placeholders show the defaults.
                document.getElementById('cfg-vi-service-url').value = '';
                document.getElementById('cfg-log-max-messages').value = '';
                document.getElementById('cfg-log-timing').value = '';
                document.getElementById('cfg-vi-service-api-key').value = '';
                syncApiKeyToggleState('cfg-vi-service-api-key', 'cfg-vi-service-api-key-toggle');
                resetNewStreamMatchFields();
                setMatchFieldsReadOnly(false);
                updateMatchOverlapNote();
                applySuggestedDefaultsForNewStream(sectionsRoot);
                suppressDirtyTracking = false;
                document.getElementById('cfg-detector-type').value = hintedType || 'object';
                syntheticStrictnessOpen = true;
                startSyntheticStrictness(hintedType || 'object');
                if (hintedType) {
                    applyDetectorTypeInferenceFpsSuggestion(hintedType);
                    applyDetectorTypeTranscoderSuggestion(hintedType);
                    applyDetectorTypeDurationSuggestion(hintedType);
                    applyDetectorTypeApplicationSuggestion(hintedType);
                    applyDetectorTypeStreamNameSuggestion(hintedType);
                }
                toggleDetectorSection();
                markClean(false);
                updateSaveButtonState();
                updateIncomingStreamPanelState();
                setFormLoading(false);
                return;
            }
            listenersPanel.style.display = '';
            deleteBtnTop.style.display = 'inline-block';
            cloneBtnTop.style.display = 'inline-block';
            downloadBtnTop.style.display = 'inline-block';
            uploadBtnTop.style.display = 'none';
            const stream = getSelectedStream();
            if (!stream) return;
            showStoredMatch(stream);
            updateSaveButtonState();
            updateIncomingStreamPanelState();
            getConfig();
        }

        /**
         * The credential slots a clone cannot carry: the ones in use by this detector that hold
         * no stored-secret reference. A key entered as a value is never read back, so a clone
         * built from the read saves without it; a reference is a name, and copies. Whether a
         * value is actually stored is not knowable from the read, so a slot counts as soon as
         * it could hold one.
         */
        function uncopyableCredentialsOf(config) {
            const labels = [];
            const type = config.detector_type;
            const vlm = config.vlm_analysis || {};
            const svd = config.synthetic_analysis || {};
            if ((type === 'vlm' || type === 'verify') && !vlm.api_key_secret) {
                labels.push(type === 'verify' ? 'review endpoint API key' : 'VLM API key');
            }
            if (type === 'synthetic' || type === 'verify') {
                if (/(^|\.)nvcf\.nvidia\.com(:\d+)?$/i.test(svd.endpoint || '') && !svd.api_key_secret) {
                    labels.push('Synthetic Video Detector API key');
                }
                if (svd.tls_client_cert && !svd.tls_client_key_secret) {
                    labels.push('TLS client key');
                }
            }
            return labels;
        }

        async function cloneConfig() {
            const stream = getSelectedStream();
            if (!stream) return;
            const resource = getSelectedResource();
            if (!resource) return;

            try {
                suppressDirtyTracking = true;
                const config = await readConfig(resource);
                const uncopyable = uncopyableCredentialsOf(config);
                if (uncopyable.length && !confirm(
                        `The ${uncopyable.join(' and the ')} of this config will not be copied: `
                        + 'a key entered as a value is never read back, so the clone would be saved without it.\n\n'
                        + 'To keep it, store the key as a secret first (the Secrets page, or "Save as secret…" '
                        + 'on the field) and pick it in the original config, or enter the key again in the '
                        + 'clone before saving.\n\nClone anyway?')) {
                    return;
                }
                openAsNewConfig(Object.assign({}, config, { active: true }), config.app_name || stream.appName || '', '');
                showStatus(uncopyable.length
                    ? `Config cloned without its ${uncopyable.join(' and ')}. Enter it again (or pick a stored secret), set a new stream name or regex, then save.`
                    : 'Config cloned. Enter a new stream name or regex, then save.', false);
                markDirty();
            } catch (error) {
                console.error("Error cloning config:", error);
                showStatus(`Error cloning config: ${error.message}`, true);
            } finally {
                suppressDirtyTracking = false;
            }
        }


        // The match priority of the copy now open as a new config. The form has no field for
        // it, so it rides here until the copy is saved or another config is picked.
        var copiedPriority = null;

        // The endpoint limits of that copy, which no field shows either.
        var copiedLimits = null;

        function endpointLimitsOf(config) {
            const held = function(block, names) {
                const out = {};
                names.forEach(function(name) {
                    if (block && block[name] !== undefined && block[name] !== null) out[name] = block[name];
                });
                return out;
            };
            return {
                vlm_analysis: held(config.vlm_analysis, ['max_concurrent_requests']),
                synthetic_analysis: held(config.synthetic_analysis, ['request_timeout_seconds', 'max_concurrent_requests'])
            };
        }

        // Puts the copy's limits on the endpoints the form built; a detector type changed
        // away from the copy's has no such endpoint, and takes none.
        function addCopiedLimits(config) {
            if (!copiedLimits) return;
            Object.keys(copiedLimits).forEach(function(block) {
                if (config[block]) Object.assign(config[block], copiedLimits[block]);
            });
        }

        // Fills "+ New Stream Config..." with a copy of a config, to be saved under its own rule.
        function openAsNewConfig(config, application, streamName) {
            document.getElementById('cfg-stream-select').value = '__new__';
            onStreamSelected();
            copiedPriority = config.priority_id === undefined ? null : config.priority_id;
            copiedLimits = endpointLimitsOf(config);
            // The copy's application and stream name stand; the blank form's deferred reset would wipe them.
            window.cancelAnimationFrame(pendingMatchFieldReset);
            populateForm(config);
            document.getElementById('cfg-new-app-name').value = application;
            document.getElementById('cfg-new-stream-name').value = streamName;
            updateMatchOverlapNote();
            updateSaveButtonState();
            // The chain's Send results tile was drawn before the copied destinations loaded.
            if (chainState) refreshChainView();
        }

        async function downloadConfig() {
            const resource = getSelectedResource();
            if (!resource) return;
            try {
                const saved = JSON.parse(JSON.stringify(await readSavedDocument(resource)));
                const file = new Blob([JSON.stringify(VIF.sdk.toWire(saved), null, 2) + '\n'], { type: 'application/json' });
                const link = document.createElement('a');
                link.href = URL.createObjectURL(file);
                link.download = saved.name + '.json';
                document.body.appendChild(link);
                link.click();
                link.remove();
                setTimeout(function() { URL.revokeObjectURL(link.href); }, 1000);
                if (window.__vifStreamConfigUnsaved()) {
                    showStatus('Downloaded the saved config. Your unsaved changes are not in the file.', false);
                }
            } catch (error) {
                console.error("Error downloading config:", error);
                showStatus(`Error downloading config: ${error.message}`, true);
            }
        }

        // The one stream config a chosen file holds, as { match, config } in the SDK's
        // spelling. Throws with words for the user when the file is anything else.
        function streamConfigInFile(text) {
            let parsed;
            try {
                parsed = JSON.parse(text);
            } catch (error) {
                throw new Error('This file can’t be read: it isn’t valid JSON.');
            }
            if (Array.isArray(parsed)) throw new Error('This file holds a list. Upload one stream config per file.');
            // No stream config nests anywhere near this deep, and reading one that does would overflow.
            if (VIF.v2map.nestsDeeperThan(parsed, 64)) {
                throw new Error('This file isn’t a stream config: it nests far deeper than a stream config does.');
            }
            const read = parsed && typeof parsed === 'object' ? VIF.sdk.fromWire(parsed) : null;
            const held = VIF.v2map.streamConfigDocument(read);
            if (!held) throw new Error('This file isn’t a stream config. Upload a file downloaded from a saved config.');
            const misshapen = VIF.v2map.misshapenSetting(held, read);
            if (misshapen) {
                const part = VIF.v2map.settingPathInFile(misshapen, misshapen[0] === 'match' ? held : held.config);
                throw new Error(`This file isn’t a stream config: "${part}" doesn’t hold what a stream config has there.`);
            }
            const type = held.config.detector && held.config.detector.type;
            const offered = Array.from(document.getElementById('cfg-detector-type').options).map(function(option) { return option.value; });
            if (type && offered.indexOf(type) === -1) {
                throw new Error(`This file’s config uses the detector type "${type}", which this server doesn’t offer.`);
            }
            return held;
        }

        // The stored secrets a config names that this server doesn't have. Empty when
        // the server's secrets can't be listed: a guess would cry wolf.
        async function secretsMissingHere(config) {
            let stored;
            try {
                stored = (await VIF.core.client().persist.secrets().get()).names || [];
            } catch (error) {
                return [];
            }
            return VIF.v2map.secretReferences(config).filter(function(name) { return stored.indexOf(name) === -1; });
        }

        // How saving the new-config form as it stands would differ from the config just opened
        // in it: the settings left out and the ones saved with another value, each as the file
        // spells it.
        function settingsTheFormWouldDrop(openedConfig) {
            // buildConfigJson refuses a blank application or stream name, so one stands in while it reads the form.
            const application = document.getElementById('cfg-new-app-name');
            const streamName = document.getElementById('cfg-new-stream-name');
            const typedApplication = application.value;
            const typed = streamName.value;
            if (!typedApplication.trim()) application.value = 'unnamed';
            if (!typed.trim()) streamName.value = 'unnamed';
            try {
                const built = buildConfigJson();
                if (!built) return { leftOut: [], changed: [] };
                addCopiedLimits(built);
                const written = VIF.v2map.groupFromFlat(built, { secrets: collectSecrets(built) }).config || {};
                const spelled = function(path) { return VIF.v2map.settingPathInFile(path, openedConfig); };
                return {
                    leftOut: VIF.v2map.settingsNotKept(openedConfig, written).map(spelled),
                    changed: VIF.v2map.settingsChanged(openedConfig, written).map(spelled)
                };
            } finally {
                application.value = typedApplication;
                streamName.value = typed;
            }
        }

        var UNREADABLE_CONFIG = 'This file can’t be opened as a stream config. Upload a file downloaded from a saved config.';

        // Up to eight settings by name; a longer list ends in a count.
        function listed(paths) {
            return paths.length > 8 ? `${paths.slice(0, 8).join(', ')} and ${paths.length - 8} more` : paths.join(', ');
        }

        async function uploadConfigFile(input) {
            const file = input.files && input.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                input.value = '';
                const uploaded = streamConfigInFile(text);
                let flat;
                try {
                    flat = VIF.v2map.flatFromGroup(uploaded);
                } catch (error) {
                    throw new Error(UNREADABLE_CONFIG);
                }
                // Asked for before the question below, so nothing is typed between the answer and the form opening.
                const missingSecrets = await secretsMissingHere(uploaded.config);
                if (window.__vifStreamConfigUnsaved() && !window.confirm(LEAVE_UNSAVED)) return;
                const application = flat.app_name || '';
                const rule = `${application} / ${flat.stream_name}`;
                const taken = !!streamRegistry[`${application}::${flat.stream_name}`];

                try {
                    openAsNewConfig(Object.assign({}, flat, { active: flat.active !== false }),
                        application, taken || !flat.stream_name ? '' : flat.stream_name);
                } catch (error) {
                    console.error("Error opening uploaded config:", error);
                    // Half a config is worse than none: back to a blank new config.
                    onStreamSelected();
                    throw new Error(UNREADABLE_CONFIG);
                }
                markDirty();
                const unheld = settingsTheFormWouldDrop(uploaded.config);
                const unread = uncopyableCredentialsOf(flat);

                const notes = [];
                if (taken) notes.push(`${rule} already has a config, so enter a different stream name.`);
                if (missingSecrets.length) {
                    notes.push(`It uses ${missingSecrets.length > 1 ? 'secrets' : 'a secret'} this server doesn’t have (${missingSecrets.join(', ')}): `
                        + 'add ' + (missingSecrets.length > 1 ? 'them' : 'it') + ' on the Secrets page or pick another.');
                }
                if (unread.length) {
                    notes.push(`The file doesn’t hold the ${unread.join(' or the ')}: a key entered as a value is never read back. `
                        + 'If the original had one, enter it again (or pick a stored secret) before saving.');
                }
                if (unheld.leftOut.length) {
                    notes.push(`${unheld.leftOut.length > 1 ? 'These settings in the file have' : 'This setting in the file has'} no field here and `
                        + `won’t be saved: ${listed(unheld.leftOut)}.`);
                }
                if (unheld.changed.length) {
                    notes.push((unheld.changed.length > 1 ? 'These settings will be saved with different values than the file’s: '
                        : 'This setting will be saved with a different value than the file’s: ') + `${listed(unheld.changed)}.`);
                }
                if (notes.length) showStickyNote('Opened as a new config, not saved yet. ' + notes.join(' '));
                else showStatus('Opened as a new config. Check it, then save.', false);
            } catch (error) {
                console.error("Error uploading config:", error);
                input.value = '';
                showStatus(error.message, true);
            }
        }

        function getVlmMode(root) {
            const checked = field(root, 'cfg-vlm-mode').querySelector('input[name="' + sectionPrefix(root) + 'vlm-mode"]:checked');
            return checked ? checked.value : 'detect';
        }

        // Detect "Reasoning Level" (Low / Medium / High). The selector writes ONLY the level
        // marker; VIS owns the per-level prompts and per-class schema and applies them
        // server-side. Sub-choice inside Detect only, separate from getVlmMode().
        function getReasoningLevel(root) {
            const checked = field(root, 'cfg-vlm-reasoning-level').querySelector('input[name="' + sectionPrefix(root) + 'vlm-reasoning-level"]:checked');
            return checked ? checked.value : 'low';
        }

        function setReasoningLevel(root, level) {
            const value = (level === 'medium' || level === 'high') ? level : 'low';
            const radios = field(root, 'cfg-vlm-reasoning-level').querySelectorAll('input[name="' + sectionPrefix(root) + 'vlm-reasoning-level"]');
            radios.forEach(function(r) { r.checked = (r.value === value); });
        }

        // Detect/High default max_tokens, sized by class count. High emits per-class
        // {class_name, reasoning} prose, so a flat budget truncates the JSON once many
        // classes are present. Cap 4096 (the field/model hard limit). DEFAULT only: an
        // explicit Advanced value wins (see buildConfigJson). VIS owns Low/Medium sizing.
        function highDetectMaxTokens(classCount) {
            return Math.min(4096, 256 + classCount * 128);
        }

        // Reveal the custom model-name input only when the "Other" option is selected.
        function toggleVlmModelNameOther(root) {
            const isOther = field(root, 'cfg-vlm-model-name').value === VLM_MODEL_OTHER;
            field(root, 'cfg-vlm-model-name-other').style.display = isOther ? 'block' : 'none';
            markDirty();
        }

        // Effective model_name from the dropdown, or the custom text when "Other" is chosen.
        // Empty custom -> null so the stream inherits the global default.
        function readVlmModelName(root) {
            const select = field(root, 'cfg-vlm-model-name');
            if (select.value === VLM_MODEL_OTHER) {
                return field(root, 'cfg-vlm-model-name-other').value.trim() || null;
            }
            return select.value || null;
        }

        // Select the option matching modelName; an unknown value loads into "Other" + custom input.
        function setVlmModelName(root, modelName) {
            const select = field(root, 'cfg-vlm-model-name');
            const other = field(root, 'cfg-vlm-model-name-other');
            if (modelName && VLM_KNOWN_MODELS.indexOf(modelName) === -1) {
                select.value = VLM_MODEL_OTHER;
                other.value = modelName;
            } else {
                select.value = modelName || VLM_KNOWN_MODELS[0];
                other.value = '';
            }
            toggleVlmModelNameOther(root);
        }

        // The VLM Server field takes a lenient address: on save, a missing scheme
        // gets http:// and a missing path gets /v1; an explicit scheme (https) or
        // path (/v1, /random) is kept as typed. A saved value is shown verbatim;
        // only the placeholder (unset field) is reduced — and only by stripping what
        // save re-adds, so it round-trips back through save even for https or non-/v1
        // endpoints.
        function vlmEndpointPlaceholder(endpointUrl) {
            if (!endpointUrl) return '';
            let s = String(endpointUrl).trim();
            s = s.replace(/^http:\/\//, '');
            s = s.replace(/\/v1\/?$/, '');
            return s;
        }

        // Build the stored endpoint_url from the field. Empty -> null so the
        // stream inherits the global default.
        function buildVlmEndpointUrl(root) {
            let s = field(root, 'cfg-vlm-endpoint-url').value.trim();
            if (!s) return null;
            if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) s = 'http://' + s;
            // No path after host:port (a lone trailing / counts as none) -> append /v1.
            const rest = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
            if (!/\/./.test(rest)) s = s.replace(/\/$/, '') + '/v1';
            return s;
        }

        // The vlm_analysis block a blank field inherits from: the Verify baseline's for a
        // Verify config, the global defaults' otherwise.
        function effectiveVlmDefaults() {
            return document.getElementById('cfg-detector-type').value === 'verify'
                ? (verifyBaseline().vlm || {})
                : ((defaultConfig && defaultConfig.vlm_analysis) || {});
        }

        // Endpoint the Verify button probes: the field (normalized to a full URL), else the
        // default a blank field inherits, layered the same way the placeholders are.
        function effectiveVlmEndpointForTest(root) {
            const fromField = buildVlmEndpointUrl(root);
            if (fromField) return fromField;
            return effectiveVlmDefaults().endpoint_url || VLM_FALLBACK_DEFAULTS.endpoint_url || null;
        }

        // Per section root, bumped on every clear so an in-flight probe knows its result is stale.
        var probeSeqs = new WeakMap();

        function probeSeq(root, kind, bump) {
            const seqs = probeSeqs.get(root) || { vlm: 0, svd: 0 };
            if (bump) seqs[kind]++;
            probeSeqs.set(root, seqs);
            return seqs[kind];
        }

        // Per section root, the endpoints its stored document holds, snapshotted at populate.
        // While a field still matches its snapshot, Verify probes BY REFERENCE so the stored
        // api_key, which a read never echoes, authenticates server-side.
        var storedEndpoints = new WeakMap();

        function probeTarget(root) {
            const resource = getSelectedResource();
            const config = resource && resource.kind === 'group' ? resource.name : null;
            const stored = storedEndpoints.get(root) || null;
            const card = chainCardOfRoot(root);
            if (!card) {
                const override = resource && resource.kind === 'override'
                    ? { application: resource.app, stream: resource.stream } : null;
                return { config: config, override: override, stage: null,
                    detectorType: document.getElementById('cfg-detector-type').value, stored: stored };
            }
            const name = chainCardName(card);
            const unrenamed = !!stored && stored.stage === name && stored.type === card.type;
            return {
                config: unrenamed ? config : null,
                stage: unrenamed ? name : null,
                detectorType: card.type,
                stored: unrenamed ? stored : null
            };
        }

        function clearSvdEndpointTestResult(root) {
            probeSeq(root, 'svd', true);
            const el = field(root, 'cfg-synthetic-endpoint-test-result');
            if (!el) return;
            el.style.display = 'none';
            el.className = 'endpoint-test-result';
            el.textContent = '';
        }

        function showSvdEndpointTestResult(root, cls) {
            const el = field(root, 'cfg-synthetic-endpoint-test-result');
            el.className = 'endpoint-test-result ' + cls;
            el.style.display = '';
            return el;
        }

        function svdEndpointFields(root) {
            const value = function(id) { return field(root, id).value.trim(); };
            const useTlsRaw = value('cfg-synthetic-use-tls');
            const nvcf = syntheticEndpointIsNvcf(root);
            return {
                endpoint: value('cfg-synthetic-endpoint'),
                use_tls: useTlsRaw === '' ? null : useTlsRaw === 'true',
                tls_ca_cert: nvcf ? '' : value('cfg-synthetic-tls-ca-cert'),
                tls_client_cert: nvcf ? '' : value('cfg-synthetic-tls-client-cert'),
                tls_client_key: nvcf ? '' : value('cfg-synthetic-tls-client-key'),
                api_key: nvcf ? value('cfg-synthetic-api-key') : '',
                // Not a secret, so an inherited one rides a by-value probe as the analyzer would use it.
                function_id: nvcf ? (value('cfg-synthetic-function-id')
                    || inheritedFunctionId(value('cfg-synthetic-endpoint'), field(root, 'cfg-synthetic-endpoint').dataset.globalDefault,
                        field(root, 'cfg-synthetic-function-id').dataset.globalDefault)) : ''
            };
        }

        // An endpoint the operator did not type — a stored config's own, or the baseline's, with
        // no secret typed beside it — is probed by reference, so the Engine dials it with the
        // stored credentials the analyzer would use. Anything typed goes by value.
        function svdProbeRequest(root, fields) {
            const target = probeTarget(root);
            const typedSecret = fields.api_key || fields.tls_client_key;
            if (!typedSecret) {
                const storedEndpoint = target.stored ? target.stored.svdEndpoint : null;
                if (target.stage && target.config && fields.endpoint === (storedEndpoint || '')) {
                    return { streamGroupConfig: target.config, stage: target.stage, detectorType: target.detectorType };
                }
                if (!target.stage && target.config && storedEndpoint && fields.endpoint === storedEndpoint) {
                    return { streamGroupConfig: target.config };
                }
                const baseline = field(root, 'cfg-synthetic-endpoint').dataset.globalDefault || '';
                if (!fields.endpoint || fields.endpoint === baseline) {
                    return { streamGroupConfig: 'default', detectorType: target.detectorType };
                }
            }
            return VIF.v2map.svdProbeRequestFromV1(fields);
        }

        // The SVD probe takes no secret name, so a stored secret only reaches it by reference:
        // a picked name that is not the saved one would be probed as the saved one.
        function unsavedSvdSecret(root) {
            const stored = probeTarget(root).stored || {};
            const nvcf = syntheticEndpointIsNvcf(root);
            const slots = nvcf ? [['cfg-synthetic-api-key', stored.svdKeySecret]]
                : [['cfg-synthetic-tls-client-key', stored.svdTlsKeySecret]];
            for (let i = 0; i < slots.length; i++) {
                const picked = referenceValue(root, slots[i][0]);
                if (picked && picked !== (slots[i][1] || '')) return picked;
            }
            return null;
        }

        async function testSvdEndpoint(root) {
            const btn = field(root, 'cfg-synthetic-endpoint-test');
            const fields = svdEndpointFields(root);
            const endpointInput = field(root, 'cfg-synthetic-endpoint');
            const effective = fields.endpoint || endpointInput.dataset.globalDefault || '';
            if (!effective) {
                showSvdEndpointTestResult(root, 'error').textContent = '✗ No detector server set, here or in Stream Config Defaults';
                return;
            }
            if (hostedSvdLacksFunctionId(effective, fields.function_id)) {
                showSvdEndpointTestResult(root, 'error').textContent = '✗ ' + svdFunctionIdRequired(root);
                return;
            }
            const unsaved = unsavedSvdSecret(root);
            if (unsaved) {
                showSvdEndpointTestResult(root, 'warn').textContent =
                    `⚠ Save the config, then Verify: the SVD check uses the secrets saved with it, and '${unsaved}' is not saved yet.`;
                return;
            }
            const original = btn.textContent;
            btn.disabled = true;
            btn.textContent = 'Verifying…';
            showSvdEndpointTestResult(root, '').textContent = 'Verifying…';
            const seq = probeSeq(root, 'svd', true);
            try {
                const result = await VIF.core.client().probes.svdEndpoint(svdProbeRequest(root, fields));
                if (seq !== probeSeq(root, 'svd')) return;
                renderSvdEndpointTestOutcome(root, result, effective);
            } catch (error) {
                if (seq !== probeSeq(root, 'svd')) return;
                showSvdEndpointTestResult(root, 'error').textContent = `✗ ${error.message}`;
            } finally {
                btn.disabled = false;
                btn.textContent = original;
            }
        }

        // Where a hosted endpoint's missing function ID is set, as the field's own surface says it.
        function svdFunctionIdRequired(root) {
            if (chainCardOfRoot(root)) return NVCF_FUNCTION_ID_REQUIRED + ' Set it in the step, or in Stream Config Defaults.';
            if (document.getElementById('cfg-detector-type').value === 'verify') {
                return NVCF_FUNCTION_ID_REQUIRED + ' Set it here, or in the Verify baseline of Stream Config Defaults.';
            }
            return NVCF_FUNCTION_ID_REQUIRED + ' Set it here, or in Stream Config Defaults.';
        }

        function renderSvdEndpointTestOutcome(root, result, endpoint) {
            if (result.reachable && result.accepted) {
                showSvdEndpointTestResult(root, 'ok').textContent =
                    `✓ Reachable — an SVD service answered at ${endpoint} and accepted the credentials`;
                return;
            }
            if (result.reachable) {
                showSvdEndpointTestResult(root, 'warn').textContent = `⚠ ${result.error || 'Reachable, but the endpoint did not accept the probe'}`;
                return;
            }
            showSvdEndpointTestResult(root, 'error').textContent = `✗ ${result.error || 'Unreachable'}`;
        }

        function clearVlmEndpointTestResult(root) {
            probeSeq(root, 'vlm', true);
            const el = field(root, 'cfg-vlm-endpoint-test-result');
            if (!el) return;
            el.style.display = 'none';
            el.className = 'endpoint-test-result';
            el.textContent = '';
            stopPointingAtVlmServerKey(root);
        }

        function vlmServerKeyGroup(root) {
            const key = field(root, 'cfg-vlm-api-key');
            return key && key.closest('.form-group');
        }

        // Marks the Server key field as the one to change, opening whatever it is folded inside.
        function pointAtVlmServerKey(root) {
            const group = vlmServerKeyGroup(root);
            if (!group) return;
            group.classList.add('needs-attention');
            for (let folded = group.closest('details'); folded; folded = folded.parentElement.closest('details')) {
                folded.open = true;
            }
        }

        function stopPointingAtVlmServerKey(root) {
            const group = vlmServerKeyGroup(root);
            if (group) group.classList.remove('needs-attention');
        }

        function showVlmEndpointTestResult(root, cls) {
            const el = field(root, 'cfg-vlm-endpoint-test-result');
            el.className = 'endpoint-test-result ' + cls;
            el.style.display = '';
            return el;
        }

        // Server-side connectivity probe: the browser can't reach compose-internal
        // hostnames, so the Engine plugin issues GET <endpoint>/models on our behalf.
        async function testVlmEndpoint(root) {
            const btn = field(root, 'cfg-vlm-endpoint-test');
            const endpoint = effectiveVlmEndpointForTest(root);
            if (!endpoint) {
                showVlmEndpointTestResult(root, 'error').textContent = '✗ No AI model server set';
                return;
            }
            // The browser never holds a stored key: a stored secret goes by reference or by
            // name, and vlmProbePlan picks which.
            const target = probeTarget(root);
            const typedUrl = (field(root, 'cfg-vlm-endpoint-url').value || '').trim();
            const storedUrl = target.stored ? target.stored.vlmUrl : null;
            const plan = VIF.v2map.vlmProbePlan({
                named: secretSourceIsStored(root, 'cfg-vlm-api-key'),
                picked: referenceValue(root, 'cfg-vlm-api-key') || '',
                storedKeySecret: target.stored ? target.stored.vlmKeySecret : null,
                typedKey: field(root, 'cfg-vlm-api-key').value,
                inheritedKey: effectiveVlmDefaults().api_key || '',
                endpoint: endpoint,
                typedUrl: typedUrl,
                urlAsStored: buildVlmEndpointUrl(root) === storedUrl,
                untouchedUrl: target.stage
                    ? buildVlmEndpointUrl(root) === storedUrl
                    : !!storedUrl && buildVlmEndpointUrl(root) === storedUrl,
                config: target.config,
                override: target.override,
                stage: target.stage,
                detectorType: target.detectorType
            });

            const original = btn.textContent;
            btn.disabled = true;
            btn.textContent = 'Verifying…';
            showVlmEndpointTestResult(root, '').textContent = 'Verifying…';
            const seq = probeSeq(root, 'vlm', true);

            try {
                const request = plan.request;
                const result = await VIF.core.client().probes.vlmEndpoint(request);
                if (seq !== probeSeq(root, 'vlm')) return; // field edited mid-flight; result is stale
                renderVlmEndpointTestOutcome(root, result);
            } catch (error) {
                if (seq !== probeSeq(root, 'vlm')) return;
                showVlmEndpointTestResult(root, 'error').textContent = `✗ ${error.message}`;
            } finally {
                btn.disabled = false;
                btn.textContent = original;
            }
        }

        function renderVlmEndpointTestOutcome(root, result) {
            const models = Array.isArray(result.models) ? result.models : [];
            if (result.reachable && models.length) {
                // Compare against the model the stream would actually use (field, else
                // the default an empty choice inherits). A single served model that
                // differs is adopted right away — the note reports the change; save
                // persists it.
                const verify = document.getElementById('cfg-detector-type').value === 'verify';
                const globalVa = (defaultConfig && defaultConfig.vlm_analysis) || {};
                const configured = readVlmModelName(root)
                    || (verify ? verifyBaselineModel() : (globalVa.model_name || VLM_FALLBACK_DEFAULTS.model_name));
                const matches = models.indexOf(configured) !== -1;
                if (matches) {
                    showVlmEndpointTestResult(root, 'ok').textContent =
                        `✓ Reachable — serving: ${models.join(', ')} (matches the configured model)`;
                } else if (models.length === 1) {
                    if (verify) setVerifyReviewModel(root, models[0]);
                    else setVlmModelName(root, models[0]);
                    // Before the note: the change handlers clear it. A chain step's mirror
                    // controls re-read the form on this event.
                    field(root, 'cfg-vlm-model-name').dispatchEvent(new Event('change', { bubbles: true }));
                    markDirty();
                    showVlmEndpointTestResult(root, 'warn').textContent =
                        `⚠ Reachable — serving: ${models[0]}; the configured model (${configured}) did not match, so it was updated. Save to keep it.`;
                } else {
                    showVlmEndpointTestResult(root, 'warn').textContent =
                        `⚠ Reachable — serving: ${models.join(', ')}, which does not match the configured model (${configured}). Pick one of the served models.`;
                }
                return;
            }
            if (result.reachable) {
                // Reachable but no usable model list: auth rejection, redirect, or
                // a model listing too large/odd to read.
                showVlmEndpointTestResult(root, 'warn').textContent = `⚠ ${result.error || 'Endpoint reachable but returned no models'}`;
                const keyRefused = /\(HTTP 40[13]\)/.test(result.error || '');
                if (keyRefused) pointAtVlmServerKey(root);
                else stopPointingAtVlmServerKey(root);
                return;
            }
            showVlmEndpointTestResult(root, 'error').textContent = `✗ ${result.error || 'Endpoint unreachable'}`;
        }

        function toggleVlmMode(root) {
            const mode = getVlmMode(root);
            field(root, 'vlm-mode-detect').style.display = mode === 'detect' ? 'block' : 'none';
            field(root, 'vlm-mode-describe').style.display = mode === 'describe' ? 'block' : 'none';
            field(root, 'vlm-mode-custom').style.display = mode === 'custom' ? 'block' : 'none';
            if (mode === 'detect' || mode === 'custom') {
                const targetId = mode === 'detect' ? 'cfg-vlm-detect-classes' : 'cfg-vlm-custom-classes';
                const sourceId = mode === 'detect' ? 'cfg-vlm-custom-classes' : 'cfg-vlm-detect-classes';
                carryOverVlmClasses(root, sourceId, targetId);
            }
            if (mode === 'custom') updateVlmCustomLint(root);
            // Leaving Detect resets the reasoning level to High so Custom/Describe never
            // carry a Low/Medium marker. On a Low/Medium load, populateForm sets the level
            // AFTER this runs (mode is 'detect' there), so a reopened config keeps its level.
            if (mode !== 'detect') setReasoningLevel(root, 'low');
            // Re-fit the now-visible Custom-mode textareas to any prefilled content — a
            // programmatic value set (loadConfig) fires no 'input' event. Safe in any
            // mode: vlmAutoGrowAll skips textareas that are still hidden.
            if (window.vlmAutoGrowAll) window.vlmAutoGrowAll();
            markDirty();
        }

        function setVlmMode(root, mode) {
            const radios = field(root, 'cfg-vlm-mode').querySelectorAll('input[name="' + sectionPrefix(root) + 'vlm-mode"]');
            radios.forEach(function(r) { r.checked = (r.value === mode); });
            toggleVlmMode(root);
        }

        function addClassRow(root, containerId, name, options) {
            options = options || {};
            const withHint = options.withHint !== false;
            const container = field(root, containerId);
            const row = document.createElement('div');
            row.className = withHint ? 'vlm-class-row' : 'vif-class-row';

            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = withHint ? 'vlm-class-name' : 'vif-class-name';
            nameInput.placeholder = options.placeholder || 'class (e.g. fire)';
            nameInput.value = name || '';
            nameInput.addEventListener('input', function() { markDirty(); if (withHint) updateVlmCustomLint(root); });

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'btn-danger';
            removeBtn.textContent = '×';
            removeBtn.title = 'Remove class';
            removeBtn.onclick = function() { row.remove(); markDirty(); if (withHint) updateVlmCustomLint(root); };

            if (!withHint) {
                // Scene: single full-width class-name column + remove button (unchanged behaviour).
                row.style.cssText = 'display:flex; gap:8px; margin-bottom:6px; align-items:center;';
                nameInput.style.flex = '1';
                row.appendChild(nameInput);
                row.appendChild(removeBtn);
                container.appendChild(row);
                markDirty();
                return;
            }

            // VLM: the class name fills the input column; its optional hint sits on the line directly
            // below it at the same width. A toggle button to the right reveals the hint (when empty) or
            // removes it (when present); the × button removes the whole class row.
            row.style.cssText = 'display:flex; gap:8px; margin-bottom:6px; align-items:flex-start;';
            const col = document.createElement('div');
            col.style.cssText = 'flex:1; min-width:0; display:flex; flex-direction:column; gap:6px;';

            // Hint line: a muted "HINT" label on the left, the hint input filling the rest.
            const hintLine = document.createElement('div');
            hintLine.className = 'vlm-class-hint-line';
            const hintLabel = document.createElement('span');
            hintLabel.className = 'vlm-class-hint-label';
            hintLabel.textContent = 'HINT';
            const hintInput = document.createElement('input');
            hintInput.type = 'text';
            hintInput.className = 'vlm-class-hint';
            hintInput.placeholder = 'e.g. open flame, not red glow';
            hintInput.value = options.hint || '';
            hintInput.addEventListener('input', markDirty);
            hintLine.appendChild(hintLabel);
            hintLine.appendChild(hintInput);

            const hintBtn = document.createElement('button');
            hintBtn.type = 'button';
            hintBtn.className = 'btn-secondary vlm-hint-toggle';

            function setHintShown(shown) {
                hintLine.style.display = shown ? '' : 'none';
                hintBtn.textContent = shown ? '× hint' : '+ hint';
                hintBtn.title = shown ? 'Remove hint' : 'Add a hint';
            }
            hintBtn.onclick = function() {
                if (hintLine.style.display !== 'none') {
                    hintInput.value = '';        // delete the hint
                    setHintShown(false);
                } else {
                    setHintShown(true);          // add the hint
                    hintInput.focus();
                }
                markDirty();
                updateVlmCustomLint(root);
            };

            col.appendChild(nameInput);
            col.appendChild(hintLine);
            row.appendChild(col);
            row.appendChild(hintBtn);
            row.appendChild(removeBtn);

            // Show the hint line initially only when a hint was supplied (e.g. loaded from config).
            setHintShown(!!(options.hint && options.hint.trim()));

            container.appendChild(row);
            markDirty();
            updateVlmCustomLint(root);
        }

        function addVlmClassRow(root, containerId, name, hint) {
            addClassRow(root, containerId, name, { hint: hint, withHint: true });
        }

        function collectClassRows(root, containerId, options) {
            options = options || {};
            const withHint = options.withHint !== false;
            const rowSelector = withHint ? '.vlm-class-row' : '.vif-class-row';
            const nameSelector = withHint ? '.vlm-class-name' : '.vif-class-name';
            const rows = field(root, containerId).querySelectorAll(rowSelector);
            const classNames = [];
            const classHints = {};
            rows.forEach(function(row) {
                const name = row.querySelector(nameSelector).value.trim();
                if (!name) return;
                classNames.push(name);
                if (withHint) {
                    const hint = row.querySelector('.vlm-class-hint').value.trim();
                    if (hint) classHints[name] = hint;
                }
            });
            return { classNames: classNames, classHints: classHints };
        }

        // Read a repeater's rows -> {classNames:[...], classHints:{name:hint}}.
        // Used for both the Detect and Custom class lists.
        function collectVlmClasses(root, containerId) {
            return collectClassRows(root, containerId, { withHint: true });
        }

        function populateClassRows(root, containerId, classNames, classHints, options) {
            options = options || {};
            const withHint = options.withHint !== false;
            const hints = classHints || {};
            const lowerHints = {};
            for (const k of Object.keys(hints)) {
                lowerHints[k.toLowerCase()] = hints[k];
            }
            for (const cn of (classNames || [])) {
                addClassRow(root, containerId, cn, {
                    hint: withHint ? (lowerHints[cn.toLowerCase()] || '') : undefined,
                    withHint: withHint
                });
            }
        }

        // Populate a repeater (Detect or Custom) from a config's class_names +
        // class_hints. Inverse of collectVlmClasses().
        function populateVlmClassRows(root, containerId, classNames, classHints) {
            populateClassRows(root, containerId, classNames, classHints, { withHint: true });
        }

        function carryOverVlmClasses(root, sourceId, targetId) {
            const targetHasRows = field(root, targetId).querySelectorAll('.vlm-class-row').length > 0;
            if (targetHasRows) return;
            const source = collectVlmClasses(root, sourceId);
            if (source.classNames.length === 0) return;
            populateVlmClassRows(root, targetId, source.classNames, source.classHints);
        }

        function toggleVlmAdvanced(root) {
            const adv = field(root, 'cfg-vlm-advanced');
            const caret = field(root, 'cfg-vlm-advanced-caret');
            const show = adv.style.display === 'none';
            adv.style.display = show ? 'block' : 'none';
            caret.innerHTML = show ? '&#9662;' : '&#9656;';
        }

        function updateVlmCustomLint(root) {
            const warn = field(root, 'vlm-custom-classlist-warning');
            if (!warn) return;
            const hasClasses = collectVlmClasses(root, 'cfg-vlm-custom-classes').classNames.length > 0;
            const sys = field(root, 'cfg-vlm-system-prompt').value;
            const usr = field(root, 'cfg-vlm-user-prompt').value;
            const hasPlaceholder = sys.indexOf('{class_list}') !== -1 || usr.indexOf('{class_list}') !== -1;
            warn.style.display = (hasClasses && !hasPlaceholder) ? 'block' : 'none';
        }

        function readSections(root, detectorType) {
            const sections = {};
            if (fieldAppliesToDetector('ignore_untracked_objects', detectorType)) {
                sections.ignore_untracked_objects = field(root, 'cfg-ignore-untracked-objects').checked;
            }

            if (detectorType === 'object') {
                const classNames = Array.from(field(root, 'cfg-class-names').selectedOptions).map(o => o.value);

                const trackingMethod = field(root, 'cfg-tracking-method').value;

                const modelName = field(root, 'cfg-model-name').value;
                sections.object_analysis = {
                    class_names: classNames,
                    model_name: modelName,
                    confidence_threshold: readNumber(field(root, 'cfg-confidence-threshold'), false, 100),
                    tracking_method: trackingMethod || null
                };

                if (modelName === 'custom') {
                    sections.object_analysis.checkpoint_path = field(root, 'cfg-checkpoint-path').value || null;
                }

                if (trackingMethod === 'byte-track') {
                    sections.object_analysis.byte_track_properties = {
                        track_creation_minimum_confidence: readNumber(field(root, 'cfg-bt-min-confidence'), false, 100),
                        max_lost_track_frames_before_track_removal: readNumber(field(root, 'cfg-bt-max-lost-frames'), true),
                        minimum_consecutive_track_overlap: readNumber(field(root, 'cfg-bt-min-overlap'), false, 100),
                        track_creation_minimum_consecutive_frames: readNumber(field(root, 'cfg-bt-min-frames'), true)
                    };
                }

                const tilingEnabled = field(root, 'cfg-tiling-enabled').checked;
                if (tilingEnabled) {
                    const tilingMode = field(root, 'cfg-tiling-mode').value || 'fixed';
                    sections.object_analysis.tiling_mode = tilingMode;
                    const tilingProperties = {
                        max_slice_rows: readNumber(field(root, 'cfg-tiling-max-rows'), true),
                        max_slice_cols: readNumber(field(root, 'cfg-tiling-max-cols'), true),
                        tile_coverage_cutoff: readNumber(field(root, 'cfg-tiling-coverage-cutoff'), false, 100)
                    };
                    if (tilingMode === 'gated') {
                        tilingProperties.min_slice_rows = readNumber(field(root, 'cfg-tiling-min-rows'), true);
                        tilingProperties.min_slice_cols = readNumber(field(root, 'cfg-tiling-min-cols'), true);
                        // Gated always has the full-frame probe, so cluster suppression always applies.
                        tilingProperties.cluster_suppression_min_children = readNumber(field(root, 'cfg-tiling-cluster-children'), true);
                    } else {
                        // Fixed mode: the full-frame pass is opt-in, and cluster suppression
                        // is only meaningful (and only sent) when that pass is enabled.
                        const fullFrame = field(root, 'cfg-tiling-full-frame').checked;
                        tilingProperties.full_frame_detection = fullFrame;
                        if (fullFrame) {
                            tilingProperties.cluster_suppression_min_children = readNumber(field(root, 'cfg-tiling-cluster-children'), true);
                        }
                    }
                    sections.object_analysis.tiling_properties = tilingProperties;
                } else {
                    // Tiling off — a single full-frame pass. tiling_mode 'none' is the
                    // master switch; tiling_properties is omitted.
                    sections.object_analysis.tiling_mode = 'none';
                }
            }

            if (detectorType === 'scene') {
                const sceneClassNames = collectClassRows(root, 'cfg-scene-class-names', { withHint: false }).classNames;

                sections.scene_analysis = {
                    class_names: sceneClassNames,
                    sensitivity: readNumber(field(root, 'cfg-scene-sensitivity'), false),
                    confidence_threshold: readNumber(field(root, 'cfg-scene-confidence-threshold'), false, 100),
                };
            }

            if (detectorType === 'motion') {
                const suppressGlobalChangesRaw = field(root, 'cfg-motion-suppress-global-changes').value;
                sections.motion_analysis = {
                    sensitivity: readNumber(field(root, 'cfg-motion-sensitivity'), true),
                    min_displacement: readNumber(field(root, 'cfg-motion-min-displacement'), false, 100),
                    merge_distance: readNumber(field(root, 'cfg-motion-merge-distance'), false, 100),
                    suppress_global_changes: suppressGlobalChangesRaw === '' ? null : suppressGlobalChangesRaw === 'true',
                };
            }

            if (detectorType === 'vlm') {
                // Shared connection + advanced fields (every mode). Class/prompt keys
                // are added per active mode below and ONLY for that mode, so VIS's
                // field-presence mode inference stays unambiguous (mode-bleed guard).
                const vlm = {
                    model_name: readVlmModelName(root),
                    endpoint_url: buildVlmEndpointUrl(root),
                    api_key: secretSourceIsStored(root, 'cfg-vlm-api-key') ? null
                        : field(root, 'cfg-vlm-api-key').value || null,
                    api_key_secret: referenceValue(root, 'cfg-vlm-api-key'),
                    request_timeout_seconds: readNumber(field(root, 'cfg-vlm-request-timeout'), false),
                    temperature: readNumber(field(root, 'cfg-vlm-temperature'), false),
                    max_tokens: readNumber(field(root, 'cfg-vlm-max-tokens'), true),
                    // max_concurrent_requests is JSON-only (Default.json); not exposed in the UI.
                };
                const vlmMode = getVlmMode(root);
                if (vlmMode === 'detect') {
                    // Per-class repeater -> class_names (+ class_hints for rows with a note).
                    const detect = collectVlmClasses(root, 'cfg-vlm-detect-classes');
                    vlm.class_names = detect.classNames;
                    if (Object.keys(detect.classHints).length > 0) {
                        vlm.class_hints = detect.classHints;
                    }
                    // High is the DEFAULT and rides as ABSENT — VIS treats a missing
                    // reasoning_level as High. Only Low/Medium ride as explicit markers;
                    // sending "high" explicitly would pin it and silently override a stream
                    // (or fleet default) that means to stay on the default. VIS owns the
                    // Low/Medium prompts/schema/sizing — the UI sends only the level.
                    const reasoningLevel = getReasoningLevel(root);
                    if (reasoningLevel === 'low' || reasoningLevel === 'medium') {
                        vlm.reasoning_level = reasoningLevel;
                    } else if (vlm.max_tokens === undefined) {
                        // High + no operator override in Advanced -> auto-size max_tokens to
                        // the class count so per-class reasoning isn't truncated. An explicit
                        // Advanced value (read into vlm.max_tokens above) always wins and is
                        // left untouched.
                        vlm.max_tokens = highDetectMaxTokens(detect.classNames.length);
                    }
                } else if (vlmMode === 'custom') {
                    // Operator prompts win; classes optional (feed {class_list}).
                    // Prompts: send absent (null), never empty-string — VIS rejects ""
                    // and inherits the built-in default only on field-absence.
                    vlm.system_prompt = field(root, 'cfg-vlm-system-prompt').value.trim() || null;
                    vlm.user_prompt = field(root, 'cfg-vlm-user-prompt').value.trim() || null;
                    // Same per-class repeater as Detect: class_names (+ class_hints).
                    const customCls = collectVlmClasses(root, 'cfg-vlm-custom-classes');
                    if (customCls.classNames.length > 0) {
                        vlm.class_names = customCls.classNames;
                        if (Object.keys(customCls.classHints).length > 0) {
                            vlm.class_hints = customCls.classHints;
                        }
                    }
                    const responseSchema = withSchemaBuilder(root, function(builder) { return builder.outputSchemaForSave(); });
                    if (responseSchema) {
                        vlm.response_schema = responseSchema;
                    }
                }
                // Describe mode: no class/prompt keys — VIS uses the descriptive default.
                sections.vlm_analysis = vlm;
            }

            if (detectorType === 'verify') {
                sections.vlm_analysis = {
                    model_name: readVlmModelName(root),
                    endpoint_url: buildVlmEndpointUrl(root),
                    api_key: secretSourceIsStored(root, 'cfg-vlm-api-key') ? null
                        : field(root, 'cfg-vlm-api-key').value || null,
                    api_key_secret: referenceValue(root, 'cfg-vlm-api-key'),
                    request_timeout_seconds: readNumber(field(root, 'cfg-vlm-request-timeout'), false),
                };
                sections.verify_analysis = {
                    flag_threshold: readNumber(field(root, 'cfg-verify-flag-threshold'), false),
                    strong_threshold: readNumber(field(root, 'cfg-verify-strong-threshold'), false),
                };
            }

            if (detectorType === 'synthetic' || detectorType === 'verify') {
                // Field names mirror the VIS WSSyntheticConfigMessage contract; blank => null
                // so the global synthetic_analysis defaults (video-intelligence.json) apply.
                const useTlsRaw = field(root, 'cfg-synthetic-use-tls').value;
                const thresholdRaw = field(root, 'cfg-synthetic-classification-threshold').value.trim();
                // NVCF-only credentials vs self-hosted-only cert paths: only the set that
                // applies to the effective endpoint is serialized. The other set is hidden in
                // the UI, and merely sending null would leave a previously-saved value in the
                // stored config (synthetic_analysis is deep-merged, not replaced wholesale),
                // so buildConfigJson() unsets it explicitly -- otherwise an NVCF api_key saved during
                // evaluation would keep riding as a Bearer header to a self-hosted endpoint.
                const nvcf = syntheticEndpointIsNvcf(root);
                sections.synthetic_analysis = {
                    endpoint: field(root, 'cfg-synthetic-endpoint').value.trim() || null,
                    // '' => auto-detect (null); 'true'/'false' => explicit override.
                    use_tls: useTlsRaw === '' ? null : useTlsRaw === 'true',
                    tls_ca_cert: nvcf ? null : field(root, 'cfg-synthetic-tls-ca-cert').value.trim() || null,
                    tls_client_cert: nvcf ? null : field(root, 'cfg-synthetic-tls-client-cert').value.trim() || null,
                    tls_client_key: (nvcf || secretSourceIsStored(root, 'cfg-synthetic-tls-client-key')) ? null
                        : field(root, 'cfg-synthetic-tls-client-key').value.trim() || null,
                    tls_client_key_secret: nvcf ? null : referenceValue(root, 'cfg-synthetic-tls-client-key') || null,
                    api_key: (nvcf && !secretSourceIsStored(root, 'cfg-synthetic-api-key'))
                        ? field(root, 'cfg-synthetic-api-key').value || null : null,
                    api_key_secret: nvcf ? referenceValue(root, 'cfg-synthetic-api-key') || null : null,
                    function_id: nvcf ? field(root, 'cfg-synthetic-function-id').value.trim() || null : null,
                };
                if (detectorType === 'synthetic') {
                    sections.synthetic_analysis.classification_threshold = thresholdRaw === '' ? null : parseFloat(thresholdRaw);
                }
            }
            return sections;
        }

        function buildConfigJson() {
            let appName, streamName;
            if (isNewStream()) {
                const appInput = document.getElementById('cfg-new-app-name');
                appName = (appInput.value || appInput.placeholder || '').trim();
                streamName = document.getElementById('cfg-new-stream-name').value.trim();
                if (!appName || !streamName) {
                    const missingFields = [];
                    if (!appName) missingFields.push('Application is required.');
                    if (!streamName) missingFields.push('Stream Name is required.');
                    showStatus(missingFields.join(' '), true, true);
                    return null;
                }
            } else {
                const stream = getSelectedStream();
                if (!stream) return null;
                appName = stream.appName;
                streamName = stream.streamName;
            }
            const detectorType = document.getElementById('cfg-detector-type').value;

            const config = {
                active: document.getElementById('cfg-active').checked,
                app_name: appName,
                stream_name: streamName,
                vi_service_url: document.getElementById('cfg-vi-service-url').value.trim() || null,
                vi_service_api_key: secretSourceIsStored(null, 'cfg-vi-service-api-key') ? null
                    : document.getElementById('cfg-vi-service-api-key').value.trim() || null,
                vi_service_api_key_secret: referenceValue(null, 'cfg-vi-service-api-key'),
                log_max_messages: readNumericInputValue('cfg-log-max-messages', true),
                inference_video_height: getInferenceVideoHeight(),
                use_transcoder: document.getElementById('cfg-use-transcoder').checked,
                grayscaled: document.getElementById('cfg-grayscaled').checked,

                log_timing: readNumericInputValue('cfg-log-timing', true),
                detector_type: detectorType
            };

            if (fieldAppliesToDetector('inference_fps', detectorType)) {
                config.inference_fps = readNumericInputValue('cfg-inference-fps', true);
            }
            if (fieldAppliesToDetector('frame_grab_interval', detectorType)) {
                config.frame_grab_interval = readNumericInputValue('cfg-frame-grab', false);
            }
            if (fieldAppliesToDetector('duration', detectorType)) {
                config.duration = readNumericInputValue('cfg-duration', false);
            }

            if (fieldAppliesToDetector('auto_frame_throttle', detectorType)) {
                config.auto_frame_throttle = document.getElementById('cfg-auto-frame-throttle').checked;
            }
            // catch_up_to_live (skip stale frames to live) is scene/VLM only — object can't skip
            // without breaking tracking.
            if (detectorType === 'scene' || detectorType === 'vlm' || (detectorType === 'chain' && chainIsWindowed())) {
                config.catch_up_to_live = document.getElementById('cfg-catch-up-to-live').checked;
                // Optional: blank => null (backend derives ~2s). Don't use readNumericInputValue here —
                // it substitutes the placeholder and so could never produce null.
                const catchUpMaxBehindRaw = document.getElementById('cfg-catch-up-max-behind').value.trim();
                config.catch_up_max_behind_seconds = catchUpMaxBehindRaw === '' ? null : parseFloat(catchUpMaxBehindRaw);
            }

            config.rollup_batch_interval = readNumericInputValue('cfg-rollup-batch-interval', false);
            Object.assign(config, readSections(sectionsRoot, detectorType));
            if (detectorType === 'chain') {
                config.chain_detector = collectChain();
                if (chainStoredDetector) config.chain_detector_stored = JSON.parse(JSON.stringify(chainStoredDetector));
            }

            let syntheticUnsets = [];
            if ((detectorType === 'synthetic' || detectorType === 'verify') && !isNewStream()) {
                syntheticUnsets = (syntheticEndpointIsNvcf(sectionsRoot)
                    ? ['synthetic_analysis.tls_ca_cert', 'synthetic_analysis.tls_client_cert', 'synthetic_analysis.tls_client_key']
                    : ['synthetic_analysis.api_key', 'synthetic_analysis.function_id']
                ).filter(function(path) {
                    const stored = getConfigValueAtPath(lastRawStreamConfig, path);
                    return stored !== null && stored !== undefined;
                });
            }

            config.vif_event_listeners = buildEventListenersJson();

            // syntheticUnsets can overlap collectUnsetFields (a gated-off field that is
            // also blank) -- dedupe the union.
            const unsetFields = Array.from(new Set(collectUnsetFields(sectionsRoot).concat(syntheticUnsets)));
            if (unsetFields.length > 0) {
                config.unset_fields = unsetFields;
            }

            return config;
        }

        function collectValidationErrors(config) {
            const errors = [];

            if (!config.app_name) errors.push('Application is required.');
            if (!config.stream_name) errors.push('Stream name / regex is required.');

            if (config.inference_fps !== undefined && config.inference_fps !== null
                && (!Number.isFinite(config.inference_fps) || (config.inference_fps < 1 && config.inference_fps !== -1) || config.inference_fps > 120 || !Number.isInteger(config.inference_fps))) {
                errors.push('Inference FPS must be a whole number between 1 and 120, or -1 to match the stream frame rate.');
            }

            if (config.log_max_messages !== undefined && config.log_max_messages !== null
                && (!Number.isFinite(config.log_max_messages) || config.log_max_messages < 0 || config.log_max_messages > 1000 || !Number.isInteger(config.log_max_messages))) {
                errors.push('Messages to log must be a whole number between 0 and 1000.');
            }

            if (config.log_timing !== undefined && config.log_timing !== null
                && (!Number.isFinite(config.log_timing) || config.log_timing < 0 || config.log_timing > 60 || !Number.isInteger(config.log_timing))) {
                errors.push('Timing log every (seconds) must be a whole number between 0 and 60.');
            }
            if (config.rollup_batch_interval !== undefined && config.rollup_batch_interval !== null
                && (!Number.isFinite(config.rollup_batch_interval) || config.rollup_batch_interval < 0 || config.rollup_batch_interval > 30)) {
                errors.push('Rollup/Batch Time must be between 0 and 30.');
            }
            // Optional: null/blank = auto. Only validate when a value was provided.
            if (config.catch_up_max_behind_seconds !== null && config.catch_up_max_behind_seconds !== undefined &&
                (!Number.isFinite(config.catch_up_max_behind_seconds) || config.catch_up_max_behind_seconds < 0 || config.catch_up_max_behind_seconds > 30)) {
                errors.push('Catch-up Max Behind must be between 0 and 30 seconds, or left blank for auto.');
            }

            // VLM Temperature: VIS rejects a value above 2 ("invalid Temperature setting, over the max
            // allowed of 2"), which breaks the stream — block the save. Only validate when provided.
            if (config.vlm_analysis && config.vlm_analysis.temperature !== undefined && config.vlm_analysis.temperature !== null
                && (!Number.isFinite(config.vlm_analysis.temperature) || config.vlm_analysis.temperature < 0 || config.vlm_analysis.temperature > 2)) {
                errors.push('Randomness (temperature) must be between 0 and 2.');
            }

            if (config.vlm_analysis && config.vlm_analysis.max_tokens !== undefined && config.vlm_analysis.max_tokens !== null
                && (!Number.isFinite(config.vlm_analysis.max_tokens) || !Number.isInteger(config.vlm_analysis.max_tokens)
                    || config.vlm_analysis.max_tokens < 1 || config.vlm_analysis.max_tokens > 4096)) {
                errors.push('Longest answer (tokens) must be a whole number between 1 and 4096.');
            }
            // VLM Endpoint URL: blank is legal and inherits the global vlm_analysis default
            // (the placeholder shows what will be used). A typed value has to be something VIS
            // can give the OpenAI SDK — it validates scheme + host (validate_http_endpoint_url)
            // and a rejection kills the stream at publish, so fail here instead. ${ENV_VAR}
            // templates resolve server-side, same carve-out as vi_service_url below.
            if (config.vlm_analysis && config.vlm_analysis.endpoint_url
                && config.vlm_analysis.endpoint_url.indexOf('${') === -1) {
                let parsedEndpoint = null;
                try { parsedEndpoint = new URL(config.vlm_analysis.endpoint_url); } catch (e) { /* invalid */ }
                if (!parsedEndpoint || !parsedEndpoint.hostname
                    || (parsedEndpoint.protocol !== 'http:' && parsedEndpoint.protocol !== 'https:')) {
                    errors.push('Endpoint URL must be an http or https URL including a host, e.g. http://vlm.docker:8000/v1, or left blank to inherit the default.');
                }
            }

            // Only literal values are checked - ${ENV_VAR} templates resolve
            // server-side. A hostless parse ("host:5001/..." reads the host as
            // the scheme) is as unusable as an unparseable one.
            if (config.vi_service_url && config.vi_service_url.indexOf('${') === -1) {
                let parsedVisUrl = null;
                try { parsedVisUrl = new URL(config.vi_service_url); } catch (e) { /* invalid */ }
                if (!parsedVisUrl || !parsedVisUrl.hostname) {
                    errors.push('Analysis service address must be a full address including ws:// or wss://, like wss://host:5001/ws/stream/, or left blank to use Stream Config Defaults.');
                }
            }

            if (config.detector_type === 'object') {
                const oa = config.object_analysis || {};
                if (!oa.model_name) errors.push('Object model name is required.');
                if (oa.confidence_threshold !== undefined && oa.confidence_threshold !== null
                    && (!Number.isFinite(oa.confidence_threshold) || oa.confidence_threshold < 0 || oa.confidence_threshold > 1)) {
                    errors.push('Object confidence threshold must be between 0 and 100.');
                }
                if (oa.model_name === 'custom' && !oa.checkpoint_path) {
                    errors.push('Checkpoint Path is required when Model Name is Custom.');
                }
                if (oa.tracking_method === 'byte-track') {
                    const bt = oa.byte_track_properties || {};
                    if (bt.track_creation_minimum_confidence !== undefined && bt.track_creation_minimum_confidence !== null
                        && (!Number.isFinite(bt.track_creation_minimum_confidence) || bt.track_creation_minimum_confidence < 0 || bt.track_creation_minimum_confidence > 1)) {
                        errors.push('Min Track Confidence must be between 0 and 100.');
                    }
                    if (bt.minimum_consecutive_track_overlap !== undefined && bt.minimum_consecutive_track_overlap !== null
                        && (!Number.isFinite(bt.minimum_consecutive_track_overlap) || bt.minimum_consecutive_track_overlap < 0 || bt.minimum_consecutive_track_overlap > 1)) {
                        errors.push('Min Consecutive Overlap must be between 0 and 100.');
                    }
                    if (bt.max_lost_track_frames_before_track_removal !== undefined && bt.max_lost_track_frames_before_track_removal !== null
                        && (!Number.isFinite(bt.max_lost_track_frames_before_track_removal) || bt.max_lost_track_frames_before_track_removal < 0 || bt.max_lost_track_frames_before_track_removal > 60 || !Number.isInteger(bt.max_lost_track_frames_before_track_removal))) {
                        errors.push('Max Lost Track Frames must be a whole number between 0 and 60.');
                    }
                    if (bt.track_creation_minimum_consecutive_frames !== undefined && bt.track_creation_minimum_consecutive_frames !== null
                        && (!Number.isFinite(bt.track_creation_minimum_consecutive_frames) || bt.track_creation_minimum_consecutive_frames < 0 || bt.track_creation_minimum_consecutive_frames > 60 || !Number.isInteger(bt.track_creation_minimum_consecutive_frames))) {
                        errors.push('Min Consecutive Frames must be a whole number between 0 and 60.');
                    }
                }
                const mode = oa.tiling_mode || 'none';
                if (mode !== 'none') {
                    const tp = oa.tiling_properties || {};
                    const isProvided = function(value) { return value !== undefined && value !== null; };
                    const isGridValue = function(value) {
                        return Number.isFinite(value) && Number.isInteger(value) && value >= 1 && value <= 16;
                    };
                    if (mode !== 'fixed' && mode !== 'gated') {
                        errors.push('Tiling algorithm must be Fixed or Gated.');
                    }
                    if (isProvided(tp.max_slice_rows) && !isGridValue(tp.max_slice_rows)) {
                        errors.push('Max Slice Rows must be a whole number between 1 and 16.');
                    }
                    if (isProvided(tp.max_slice_cols) && !isGridValue(tp.max_slice_cols)) {
                        errors.push('Max Slice Cols must be a whole number between 1 and 16.');
                    }
                    if (mode === 'gated') {
                        if (isProvided(tp.min_slice_rows) && !isGridValue(tp.min_slice_rows)) {
                            errors.push('Min Slice Rows must be a whole number between 1 and 16.');
                        }
                        if (isProvided(tp.min_slice_cols) && !isGridValue(tp.min_slice_cols)) {
                            errors.push('Min Slice Cols must be a whole number between 1 and 16.');
                        }
                        if (isGridValue(tp.min_slice_rows) && isGridValue(tp.max_slice_rows) && tp.min_slice_rows > tp.max_slice_rows) {
                            errors.push('Min Slice Rows must be less than or equal to Max Slice Rows.');
                        }
                        if (isGridValue(tp.min_slice_cols) && isGridValue(tp.max_slice_cols) && tp.min_slice_cols > tp.max_slice_cols) {
                            errors.push('Min Slice Cols must be less than or equal to Max Slice Cols.');
                        }
                    }
                    if (isProvided(tp.tile_coverage_cutoff) && (!Number.isFinite(tp.tile_coverage_cutoff) || tp.tile_coverage_cutoff < 0 || tp.tile_coverage_cutoff > 1)) {
                        errors.push('Tile Coverage Cutoff must be between 0 and 100.');
                    }
                    // Only present (and only meaningful) for gated, or fixed with full-frame detection on.
                    if (isProvided(tp.cluster_suppression_min_children) &&
                        (!Number.isFinite(tp.cluster_suppression_min_children) || tp.cluster_suppression_min_children < 0 || !Number.isInteger(tp.cluster_suppression_min_children))) {
                        errors.push('Cluster Suppression Min Children must be a whole number of 0 or more.');
                    }
                }
            }

            if (config.detector_type === 'scene') {
                const sa = config.scene_analysis || {};
                // Round 3: scene detection requires at least one class to look for. Defensive
                // against more than just the "never added a row" case - buildConfigJson()'s
                // collectClassRows() already trims and drops blank rows, so sa.class_names is
                // normally either a real array of non-empty names or `[]`, but this re-checks
                // (not just `.length`) in case collectValidationErrors() is ever called
                // directly with a hand-built config (as the spec suite does) where class_names
                // is missing entirely, not an array, or contains blank-only entries.
                const sceneClassNames = Array.isArray(sa.class_names)
                    ? sa.class_names.filter(function(name) { return typeof name === 'string' && name.trim() !== ''; })
                    : [];
                if (sceneClassNames.length === 0) {
                    errors.push('Scene detection requires at least one class.');
                }
                if (config.duration !== undefined && config.duration !== null
                    && (!Number.isFinite(config.duration) || config.duration < 0 || config.duration > 5)) {
                    errors.push('Duration must be between 0 and 5 for scene detection.');
                }
                if (sa.confidence_threshold !== undefined && sa.confidence_threshold !== null
                    && (!Number.isFinite(sa.confidence_threshold) || sa.confidence_threshold < 0 || sa.confidence_threshold > 1)) {
                    errors.push('Scene confidence threshold must be between 0 and 100.');
                }
                if (sa.sensitivity !== undefined && sa.sensitivity !== null
                    && (!Number.isFinite(sa.sensitivity) || sa.sensitivity < 0 || sa.sensitivity > 10)) {
                    errors.push('Scene sensitivity must be between 0 and 10.');
                }
            }

            if (config.detector_type === 'motion') {
                const ma = config.motion_analysis || {};
                if (ma.sensitivity !== undefined && ma.sensitivity !== null
                    && (!Number.isInteger(ma.sensitivity) || ma.sensitivity < 1 || ma.sensitivity > 10)) {
                    errors.push('Motion sensitivity must be a whole number between 1 and 10.');
                }
                if (ma.min_displacement !== undefined && ma.min_displacement !== null
                    && (!Number.isFinite(ma.min_displacement) || ma.min_displacement < 0 || ma.min_displacement > 1)) {
                    errors.push('Min Displacement must be between 0 and 100.');
                }
                if (ma.merge_distance !== undefined && ma.merge_distance !== null
                    && (!Number.isFinite(ma.merge_distance) || ma.merge_distance < 0 || ma.merge_distance > 0.5)) {
                    errors.push('Merge Distance must be between 0 and 50.');
                }
            }

            if (config.detector_type === 'vlm') {
                const va = config.vlm_analysis || {};
                const effectiveModel = va.model_name
                    || (defaultConfig && defaultConfig.vlm_analysis && defaultConfig.vlm_analysis.model_name);
                if (!effectiveModel) errors.push('No VLM model is configured. Select a model, or set vlm_defaults.model in Default.json on the Engine host.');
                if (config.duration !== undefined && config.duration !== null
                    && (!Number.isFinite(config.duration) || config.duration < 0 || config.duration > 8)) {
                    errors.push('Duration must be between 0 and 8 for VLM detection.');
                }
                // One request carries Duration × Inference FPS images and the endpoint
                // accepts at most VLM_TYPICAL_ENDPOINT_IMAGE_CAP: refuse a config that
                // asks for more instead of letting the service silently thin it. A
                // blank field resolves to the global default, the same value the
                // Engine would run with; -1 (match source) is refused too, because a
                // window at the source rate cannot be held to the cap.
                const vlmFps = config.inference_fps !== undefined && config.inference_fps !== null ? config.inference_fps
                    : (defaultConfig && Number.isFinite(defaultConfig.inference_fps) ? defaultConfig.inference_fps : null);
                const vlmDur = config.duration !== undefined && config.duration !== null ? config.duration
                    : (defaultConfig && Number.isFinite(defaultConfig.duration) ? defaultConfig.duration : null);
                if (vlmFps === -1) {
                    errors.push('Inference FPS -1 (match source) cannot hold a VLM window to the endpoint image cap of '
                        + VLM_TYPICAL_ENDPOINT_IMAGE_CAP + ' images. Set a fixed rate; 1 or 2 covers most streams.');
                } else if (Number.isFinite(vlmFps) && Number.isFinite(vlmDur)
                    && vlmFps * vlmDur > VLM_TYPICAL_ENDPOINT_IMAGE_CAP) {
                    errors.push('VLM sends Duration × Inference FPS images in one request, and the endpoint accepts at most '
                        + VLM_TYPICAL_ENDPOINT_IMAGE_CAP + '. This config asks for ' + (Math.round(vlmFps * vlmDur * 100) / 100)
                        + ' — lower Duration or Inference FPS.');
                }
                const inVlmCustomMode = ('user_prompt' in va) || ('system_prompt' in va) || ('response_schema' in va);
                if (inVlmCustomMode && !(va.user_prompt && String(va.user_prompt).trim())) {
                    errors.push('User Prompt is required for VLM Custom mode.');
                }
                // Output Schema: only Raw JSON can be invalid (the Fields builder always
                // emits valid JSON). One shared validator also refreshes the inline error.
                if (inVlmCustomMode) {
                    const schemaError = withSchemaBuilder(sectionsRoot, function(builder) { return builder.validate(); });
                    if (schemaError) {
                        errors.push('VLM Output Schema is not valid JSON: ' + schemaError);
                    }
                }
                // Low/Medium friendly pre-checks mirroring VIS's server-side rejections:
                // the per-class schema VIS builds needs a non-empty class list, and Medium
                // reserves the internal `scene` field name.
                if (va.reasoning_level === 'low' || va.reasoning_level === 'medium') {
                    const classes = Array.isArray(va.class_names) ? va.class_names : [];
                    if (classes.length === 0) {
                        errors.push('Quick and Balanced checks need at least one class to check for.');
                    }
                    if (va.reasoning_level === 'medium') {
                        for (const cn of classes) {
                            if (String(cn).trim().toLowerCase() === 'scene') {
                                errors.push('At Balanced, a class can’t be named "scene": the model uses that name itself. Rename the class or pick another option.');
                            }
                        }
                    }
                }
            }

            if (config.detector_type === 'verify') {
                const sy = config.synthetic_analysis || {};
                const vf = config.verify_analysis || {};
                const baseline = verifyBaseline();
                const baselineEndpoint = baseline.svd && baseline.svd.endpoint;
                if (!sy.endpoint && !baselineEndpoint) {
                    errors.push('The detector server is required, as host:port. Set it here, or in the Verify baseline of Stream Config Defaults.');
                } else if (sy.endpoint && /^https?:\/\//i.test(sy.endpoint)) {
                    errors.push('The detector server must be a host:port, like svd.docker:8001, not a web address.');
                } else if (hostedSvdLacksFunctionId(sy.endpoint || baselineEndpoint,
                    sy.function_id || inheritedFunctionId(sy.endpoint, baselineEndpoint, (baseline.svd || {}).function_id))) {
                    errors.push(NVCF_FUNCTION_ID_REQUIRED + ' Set it here, or in the Verify baseline of Stream Config Defaults.');
                }
                if (!!sy.tls_client_cert !== !!(sy.tls_client_key || sy.tls_client_key_secret)) {
                    errors.push('Mutual TLS requires both Client Certificate Path and Client Key Path (set both or neither).');
                }
                const unit = function(v) { return v === undefined || v === null || (Number.isFinite(v) && v >= 0 && v <= 1); };
                if (!unit(vf.flag_threshold)) errors.push('Flag Threshold must be between 0.0 and 1.0.');
                if (!unit(vf.strong_threshold)) errors.push('Strong Threshold must be between 0.0 and 1.0.');
                const flag = Number.isFinite(vf.flag_threshold) ? vf.flag_threshold : baseline.flag_threshold;
                const strong = Number.isFinite(vf.strong_threshold) ? vf.strong_threshold : baseline.strong_threshold;
                if (Number.isFinite(flag) && Number.isFinite(strong) && strong < flag) {
                    errors.push('Strong Threshold must not be below Flag Threshold.');
                }
                if (config.duration !== undefined && config.duration !== null) {
                    if (!Number.isFinite(config.duration) || config.duration <= 0) {
                        errors.push('Duration (window length, seconds) must be greater than 0 for Verify.');
                    } else if (config.duration > 30) {
                        errors.push('Duration (window length, seconds) must be between 0 and 30 for Verify.');
                    }
                }
            }

            if (config.detector_type === 'synthetic') {
                const sy = config.synthetic_analysis || {};
                const syDefault = (defaultConfig && defaultConfig.synthetic_analysis) || {};
                if (!sy.endpoint && !syDefault.endpoint) {
                    errors.push('The detector server is required, as host:port. Set it here, or in Stream Config Defaults.');
                } else if (/^https?:\/\//i.test(sy.endpoint)) {
                    errors.push('The detector server must be a host:port, like svd.docker:8001, not a web address.');
                } else if (hostedSvdLacksFunctionId(sy.endpoint || syDefault.endpoint,
                    sy.function_id || inheritedFunctionId(sy.endpoint, syDefault.endpoint, syDefault.function_id))) {
                    errors.push(NVCF_FUNCTION_ID_REQUIRED + ' Set it here, or in Stream Config Defaults.');
                }
                if (sy.classification_threshold !== null && sy.classification_threshold !== undefined
                    && (!Number.isFinite(sy.classification_threshold) || sy.classification_threshold < 0 || sy.classification_threshold > 1)) {
                    errors.push('AI-generated video detection: the How strict score must be between 0 and 1.');
                }
                if (!!sy.tls_client_cert !== !!(sy.tls_client_key || sy.tls_client_key_secret)) {
                    errors.push('Mutual TLS requires both Client Certificate Path and Client Key Path (set both or neither).');
                }
                if (config.duration !== undefined && config.duration !== null) {
                    if (!Number.isFinite(config.duration) || config.duration <= 0) {
                        errors.push('Duration (window length, seconds) must be greater than 0 for synthetic detection.');
                    } else if (config.duration > 30) {
                        errors.push('Duration (window length, seconds) must be between 0 and 30 for synthetic detection.');
                    }
                }
            }

            if (config.detector_type === 'chain') {
                errors.push.apply(errors, chainValidationErrors(config));
            }

            const listeners = config.vif_event_listeners || {};
            for (const [name, listener] of Object.entries(listeners)) {
                if (!listener.class_name) {
                    errors.push(`Listener "${name}" is missing a listener type.`);
                }
                if (!listener.methods || listener.methods.length === 0) {
                    errors.push(`Listener "${name}" is missing an event method.`);
                }
                if (!Number.isFinite(listener.confidence_threshold) || listener.confidence_threshold < 0 || listener.confidence_threshold > 1) {
                    errors.push(`Listener "${name}" confidence threshold must be between 0 and 100.`);
                }
                const props = listener.properties || {};
                const shortName = resolveClassName(listener.class_name || '');
                const listenerMethods = Array.isArray(listener.methods)
                    ? listener.methods.map(function(method) { return String(method || '').toLowerCase(); })
                    : [];
                const allowedMethods = getAllowedEventMethodValues(listener.class_name || '', config.detector_type);
                // A chain's results change with its steps, so a method that no longer fits warns
                // when the chain saves instead (chainDestinationMethodWarnings).
                listenerMethods.forEach(function(method) {
                    if (method && !allowedMethods.includes(method) && config.detector_type !== 'chain') {
                        const allowedLabels = EVENT_METHOD_OPTIONS.filter(function(option) {
                            return allowedMethods.includes(option.value);
                        }).map(function(option) {
                            return option.label;
                        }).join(', ');
                        errors.push(`Listener "${name}" cannot use ${formatEventMethodLabel(method)} for ${config.detector_type || 'this'} analysis. Allowed methods: ${allowedLabels}.`);
                    }
                });
                if (shortName === 'WebhookEvent2' && props.url !== undefined && props.url !== ''
                        && !/^https?:\/\/[^\/\s]/i.test(String(props.url).trim())) {
                    // The server refuses this too; catching it here means the operator is
                    // told by the field's own name instead of by a 400 about a member.
                    errors.push(`Listener "${name}" Destination URL must be an absolute http(s) URL with a host.`);
                }
                if (shortName === 'OverlayEvent' && props.fade_step !== undefined) {
                    if (!Number.isFinite(props.fade_step) || props.fade_step < 0 || props.fade_step > 30 || !Number.isInteger(props.fade_step)) {
                        errors.push(`Listener "${name}" Fade Step must be a whole number between 0 and 30.`);
                    }
                }
                if (shortName === 'ObjectTracking') {
                    if (props.fade_step !== undefined && (!Number.isFinite(props.fade_step) || props.fade_step < 0 || props.fade_step > 30 || !Number.isInteger(props.fade_step))) {
                        errors.push(`Listener "${name}" Fade Step must be a whole number between 0 and 30.`);
                    }
                    if (props.untriggered_object_color !== undefined && props.untriggered_object_color !== '' && !isValidCssColor(props.untriggered_object_color)) {
                        errors.push(`Listener "${name}" Untriggered Object Color must be a valid CSS color.`);
                    }
                }
                if (Array.isArray(props.regions_of_interest)) {
                    props.regions_of_interest.forEach((region, index) => {
                        if (region.color !== undefined && region.color !== '' && !isValidCssColor(region.color)) {
                            errors.push(`Listener "${name}" region ${index + 1} Color must be a valid CSS color.`);
                        }
                        if (Array.isArray(region.triggers)) {
                            const TRIGGER_VOCABULARY = ['inside', 'direction', 'color', 'velocity_min', 'velocity_max', 'time_min', 'time_max', 'count_min', 'count_max'];
                            region.triggers.forEach(trigger => {
                                if (typeof trigger !== 'string') return;
                                const keyword = trigger.split('::')[0].trim().toLowerCase();
                                if (keyword && !TRIGGER_VOCABULARY.includes(keyword)) {
                                    errors.push(`Listener "${name}" region ${index + 1} has an unknown trigger "${trigger}". Allowed triggers: ${TRIGGER_VOCABULARY.join(', ')}.`);
                                }
                            });
                        }
                    });
                }
            }

            return errors;
        }

        function resetSections(root) {
            field(root, 'cfg-ignore-untracked-objects').checked = false;

            // Object analysis
            field(root, 'cfg-class-names').innerHTML = '';
            field(root, 'cfg-model-name').value = '';
            field(root, 'cfg-checkpoint-path').value = '';
            field(root, 'cfg-confidence-threshold').value = '';
            field(root, 'cfg-tracking-method').value = '';

            // ByteTrack
            field(root, 'cfg-bt-min-confidence').value = '';
            field(root, 'cfg-bt-max-lost-frames').value = '';
            field(root, 'cfg-bt-min-overlap').value = '';
            field(root, 'cfg-bt-min-frames').value = '';

            // Tiling
            field(root, 'cfg-tiling-enabled').checked = false;
            field(root, 'cfg-tiling-mode').value = 'fixed';
            field(root, 'cfg-tiling-min-rows').value = '';
            field(root, 'cfg-tiling-min-cols').value = '';
            field(root, 'cfg-tiling-max-rows').value = '';
            field(root, 'cfg-tiling-max-cols').value = '';
            field(root, 'cfg-tiling-coverage-cutoff').value = '';
            field(root, 'cfg-tiling-full-frame').checked = false;
            field(root, 'cfg-tiling-cluster-children').value = '';

            field(root, 'cfg-scene-class-names').innerHTML = '';
            field(root, 'cfg-scene-sensitivity').value = '';
            field(root, 'cfg-scene-confidence-threshold').value = '';

            field(root, 'cfg-motion-sensitivity').value = '';
            field(root, 'cfg-motion-min-displacement').value = '';
            field(root, 'cfg-motion-merge-distance').value = '';
            field(root, 'cfg-motion-suppress-global-changes').value = '';

            // VLM analysis
            setVlmModelName(root, VLM_KNOWN_MODELS[0]);
            field(root, 'cfg-vlm-endpoint-url').value = '';
            field(root, 'cfg-vlm-api-key').value = '';
            syncSectionApiKeyToggle(root, 'cfg-vlm-api-key', 'cfg-vlm-api-key-toggle');
            clearVlmEndpointTestResult(root);
            field(root, 'cfg-vlm-detect-classes').innerHTML = '';
            field(root, 'cfg-vlm-custom-classes').innerHTML = '';
            field(root, 'cfg-vlm-system-prompt').value = '';
            field(root, 'cfg-vlm-user-prompt').value = '';
            withSchemaBuilder(root, function(builder) { builder.reset(); });
            field(root, 'cfg-vlm-request-timeout').value = '';
            field(root, 'cfg-vlm-temperature').value = '';
            field(root, 'cfg-vlm-max-tokens').value = '';
            field(root, 'cfg-vlm-advanced').style.display = 'none';
            field(root, 'cfg-vlm-advanced-caret').innerHTML = '&#9656;';
            field(root, 'vlm-custom-classlist-warning').style.display = 'none';
            setReasoningLevel(root, 'low'); // default reasoning level
            setVlmMode(root, 'detect');
            // max_concurrent_requests is JSON-only (Default.json); not exposed in the UI.

            field(root, 'cfg-synthetic-endpoint').value = '';
            field(root, 'cfg-synthetic-endpoint').dataset.globalDefault = '';
            delete field(root, 'cfg-synthetic-endpoint').dataset.inherited;
            field(root, 'cfg-synthetic-use-tls').value = '';
            ['cfg-synthetic-tls-ca-cert', 'cfg-synthetic-tls-client-cert', 'cfg-synthetic-tls-client-key'].forEach(function(id) {
                const input = field(root, id);
                input.value = '';
                input.placeholder = '';
            });
            setSyntheticTlsCertsExpanded(root, false);
            field(root, 'cfg-synthetic-api-key').value = '';
            syncSectionApiKeyToggle(root, 'cfg-synthetic-api-key', 'cfg-synthetic-api-key-toggle');
            field(root, 'cfg-synthetic-function-id').value = '';
            field(root, 'cfg-synthetic-classification-threshold').value = '';
            showSyntheticStrictness(root, true);
            ['cfg-verify-flag-threshold', 'cfg-verify-strong-threshold'].forEach(function(id) {
                const input = field(root, id);
                if (input) input.value = '';
            });
            SECTION_SECRET_SOURCES.forEach(function(base) { setSecretSlot(root, base, null); });
            updateSyntheticEndpointFields(root);
        }

        function resetForm() {
            suppressDirtyTracking = true;
            touchedSecrets = {};
            // Stream settings
            document.getElementById('cfg-active').checked = false;
            document.getElementById('cfg-inference-fps').value = '';
            document.getElementById('cfg-inference-video-height-mode').value = '';
            document.getElementById('cfg-inference-video-height-custom').value = '';
            document.getElementById('cfg-inference-video-height-custom').style.display = 'none';
            document.getElementById('cfg-use-transcoder').checked = false;
            document.getElementById('cfg-use-transcoder-warning').style.display = 'none';
            document.getElementById('cfg-frame-grab').value = '';
            document.getElementById('cfg-rollup-batch-interval').value = '';
            document.getElementById('cfg-duration').value = '';
            document.getElementById('cfg-grayscaled').checked = false;

            document.getElementById('cfg-auto-frame-throttle').checked = false;
            document.getElementById('cfg-catch-up-to-live').checked = true;
            document.getElementById('cfg-catch-up-max-behind').value = '';
            document.getElementById('cfg-vi-service-url').value = '';
            document.getElementById('cfg-vi-service-api-key').value = '';
            syncApiKeyToggleState('cfg-vi-service-api-key', 'cfg-vi-service-api-key-toggle');
            document.getElementById('cfg-log-max-messages').value = '';
            document.getElementById('cfg-log-timing').value = '';
            document.getElementById('cfg-detector-type').value = '';

            resetSections(sectionsRoot);
            storedEndpoints.delete(sectionsRoot);
            clearChain();
            suppressDirtyTracking = false;
        }

        function populateSections(root, config) {
            if (config.ignore_untracked_objects !== undefined) {
                field(root, 'cfg-ignore-untracked-objects').checked = config.ignore_untracked_objects;
            }

            if (config.object_analysis || isNewStream()) {
                const oa = config.object_analysis || {};
                if (oa.model_name) {
                    field(root, 'cfg-model-name').value = oa.model_name;
                }
                if (oa.checkpoint_path) {
                    populateCheckpointPaths(root, oa.checkpoint_path);
                    field(root, 'cfg-checkpoint-path').value = oa.checkpoint_path;
                }
                updateClassNamesOptions(root);
                if (oa.class_names && oa.class_names.length > 0) {
                    const classSelect = field(root, 'cfg-class-names');
                    const nameSet = new Set(oa.class_names);
                    Array.from(classSelect.options).forEach(opt => { opt.selected = nameSet.has(opt.value); });
                }
                if (oa.confidence_threshold !== undefined) {
                    field(root, 'cfg-confidence-threshold').value = Math.round(oa.confidence_threshold * 100);
                }
                if (oa.tracking_method) {
                    field(root, 'cfg-tracking-method').value = oa.tracking_method;
                }
                if (oa.byte_track_properties) {
                    const bt = oa.byte_track_properties;
                    if (bt.track_creation_minimum_confidence !== undefined) {
                        field(root, 'cfg-bt-min-confidence').value = Math.round(bt.track_creation_minimum_confidence * 100);
                    }
                    if (bt.max_lost_track_frames_before_track_removal !== undefined) {
                        field(root, 'cfg-bt-max-lost-frames').value = bt.max_lost_track_frames_before_track_removal;
                    }
                    if (bt.minimum_consecutive_track_overlap !== undefined) {
                        field(root, 'cfg-bt-min-overlap').value = Math.round(bt.minimum_consecutive_track_overlap * 100);
                    }
                    if (bt.track_creation_minimum_consecutive_frames !== undefined) {
                        field(root, 'cfg-bt-min-frames').value = bt.track_creation_minimum_consecutive_frames;
                    }
                }
                // tiling_mode is the single switch now ('none' | 'fixed' | 'gated'); the
                // Enable Tiling toggle is on whenever the mode is not 'none'.
                const tilingMode = oa.tiling_mode || 'none';
                let tilingOn = tilingMode !== 'none';
                // Legacy configs carried a separate tiling_enabled flag — honor it if present.
                if (oa.tiling_enabled !== undefined) {
                    tilingOn = !!oa.tiling_enabled;
                }
                field(root, 'cfg-tiling-enabled').checked = tilingOn;
                if (tilingMode === 'fixed' || tilingMode === 'gated') {
                    field(root, 'cfg-tiling-mode').value = tilingMode;
                }
                if (oa.tiling_properties) {
                    const tp = oa.tiling_properties;
                    if (tp.min_slice_rows !== undefined) {
                        field(root, 'cfg-tiling-min-rows').value = tp.min_slice_rows;
                    }
                    if (tp.min_slice_cols !== undefined) {
                        field(root, 'cfg-tiling-min-cols').value = tp.min_slice_cols;
                    }
                    if (tp.max_slice_rows !== undefined) {
                        field(root, 'cfg-tiling-max-rows').value = tp.max_slice_rows;
                    }
                    if (tp.max_slice_cols !== undefined) {
                        field(root, 'cfg-tiling-max-cols').value = tp.max_slice_cols;
                    }
                    if (tp.tile_coverage_cutoff !== undefined) {
                        field(root, 'cfg-tiling-coverage-cutoff').value = Math.round(tp.tile_coverage_cutoff * 100);
                    }
                    field(root, 'cfg-tiling-full-frame').checked = !!tp.full_frame_detection;
                    if (tp.cluster_suppression_min_children !== undefined) {
                        field(root, 'cfg-tiling-cluster-children').value = tp.cluster_suppression_min_children;
                    }
                }
            }

            if (config.scene_analysis || isNewStream()) {
                const sa = config.scene_analysis || {};
                if (sa.class_names) {
                    populateClassRows(root, 'cfg-scene-class-names', sa.class_names, null, { withHint: false });
                }
                if (sa.sensitivity !== undefined) {
                    field(root, 'cfg-scene-sensitivity').value = sa.sensitivity;
                }
                if (sa.confidence_threshold !== undefined) {
                    field(root, 'cfg-scene-confidence-threshold').value = Math.round(sa.confidence_threshold * 100);
                }
            }

            if (config.motion_analysis) {
                const ma = config.motion_analysis;
                if (ma.sensitivity !== undefined) {
                    field(root, 'cfg-motion-sensitivity').value = ma.sensitivity;
                }
                if (ma.min_displacement !== undefined) {
                    field(root, 'cfg-motion-min-displacement').value = Math.round(ma.min_displacement * 1000) / 10;
                }
                if (ma.merge_distance !== undefined) {
                    field(root, 'cfg-motion-merge-distance').value = Math.round(ma.merge_distance * 1000) / 10;
                }
                field(root, 'cfg-motion-suppress-global-changes').value =
                    typeof ma.suppress_global_changes === 'boolean' ? String(ma.suppress_global_changes) : '';
            }

            {
                const va = config.vlm_analysis || {};
                const verify = config.detector_type === 'verify';
                const globalVa = verify
                    ? (verifyBaseline().vlm || {})
                    : ((defaultConfig && defaultConfig.vlm_analysis) || {});

                applyVlmModelChoicesForDetector(root, config.detector_type || '');
                if (verify) setVerifyReviewModel(root, va.model_name);
                else setVlmModelName(root, va.model_name || globalVa.model_name || VLM_FALLBACK_DEFAULTS.model_name);

                const endpointInput = field(root, 'cfg-vlm-endpoint-url');
                if (va.endpoint_url) endpointInput.value = va.endpoint_url;
                const effectiveEndpoint = globalVa.endpoint_url || VLM_FALLBACK_DEFAULTS.endpoint_url;
                if (effectiveEndpoint) endpointInput.placeholder = vlmEndpointPlaceholder(effectiveEndpoint);
                clearVlmEndpointTestResult(root);

                if (va.api_key) {
                    field(root, 'cfg-vlm-api-key').value = va.api_key;
                }
                syncSectionApiKeyToggle(root, 'cfg-vlm-api-key', 'cfg-vlm-api-key-toggle');

                const timeoutInput = field(root, 'cfg-vlm-request-timeout');
                if (va.request_timeout_seconds !== undefined && va.request_timeout_seconds !== null) {
                    timeoutInput.value = va.request_timeout_seconds;
                }
                if (globalVa.request_timeout_seconds !== undefined && globalVa.request_timeout_seconds !== null) {
                    timeoutInput.placeholder = String(globalVa.request_timeout_seconds);
                }

                const temperatureInput = field(root, 'cfg-vlm-temperature');
                if (va.temperature !== undefined && va.temperature !== null) {
                    temperatureInput.value = va.temperature;
                }
                if (globalVa.temperature !== undefined && globalVa.temperature !== null) {
                    temperatureInput.placeholder = String(globalVa.temperature);
                }

                const maxTokensInput = field(root, 'cfg-vlm-max-tokens');
                // Detect/High auto-sizes max_tokens from the class count (highDetectMaxTokens).
                // Don't surface that computed value as an operator choice — leaving it blank
                // lets it re-scale when classes change. A stored value that differs from the
                // formula IS an explicit override and always wins, so surface it. High rides
                // as absent, so an absent/High level (Detect: classes, no prompts) counts as
                // High here; Low/Medium never auto-size, so their max_tokens is always shown.
                const isHighDetect = va.reasoning_level !== 'low' && va.reasoning_level !== 'medium'
                    && !(va.system_prompt || va.user_prompt || va.response_schema)
                    && Array.isArray(va.class_names) && va.class_names.length > 0;
                const highAutoMaxTokens = isHighDetect
                    && va.max_tokens === highDetectMaxTokens(va.class_names.length);
                if (!highAutoMaxTokens && va.max_tokens !== undefined && va.max_tokens !== null) {
                    maxTokensInput.value = va.max_tokens;
                }
                if (globalVa.max_tokens !== undefined && globalVa.max_tokens !== null) {
                    maxTokensInput.placeholder = String(globalVa.max_tokens);
                }
                // max_concurrent_requests is JSON-only (Default.json); not exposed in the UI.

                // Infer the mode from which fields are present on the STREAM'S OWN
                // vlm_analysis only (mirrors VIS's field-presence inference, but no longer
                // the merged/effective view - P4-T3 - so a stream with no prompts/classes
                // of its own is Describe mode even if the global defaults or another stream
                // happen to set some): operator prompts / schema -> Custom; else a class
                // list -> Detect; else Describe.
                // Custom prompts/schema win over reasoning_level, mirroring VIS: an explicit
                // system_prompt/user_prompt/response_schema makes VIS ignore the level (custom
                // config used as-is), so a config carrying both must reopen as Custom, not
                // silently drop the prompt to Detect. Absent prompts + a Low/Medium level ->
                // Detect at that level; High rides as absent and falls through to the class-list
                // inference (High Detect always has classes), though an explicit "high" (a
                // hand-written config) is still honored. Invalid/absent level falls through.
                const reasoningLevel = (va.reasoning_level === 'low' || va.reasoning_level === 'medium'
                    || va.reasoning_level === 'high') ? va.reasoning_level : null;
                const hasPrompt = !!(va.system_prompt || va.user_prompt || va.response_schema);
                const hasClasses = Array.isArray(va.class_names) && va.class_names.length > 0;
                let vlmMode = 'describe';
                if (hasPrompt) {
                    vlmMode = 'custom';
                } else if (reasoningLevel) {
                    vlmMode = 'detect';
                } else if (hasClasses) {
                    vlmMode = 'detect';
                }
                if (vlmMode === 'custom') {
                    if (va.system_prompt) {
                        field(root, 'cfg-vlm-system-prompt').value = va.system_prompt;
                    }
                    if (va.user_prompt) {
                        field(root, 'cfg-vlm-user-prompt').value = va.user_prompt;
                    }
                    if (hasClasses) {
                        populateVlmClassRows(root, 'cfg-vlm-custom-classes', va.class_names, va.class_hints);
                    }
                    // Pick the Output Schema kind from the loaded schema: absent -> Free-form,
                    // the live default class schema -> Per-class verdicts, anything else ->
                    // Custom (loaded into the Fields/Raw editor).
                    withSchemaBuilder(root, function(builder) { builder.applyOutputSchema(va.response_schema); });
                } else if (vlmMode === 'detect') {
                    if (hasClasses) {
                        populateVlmClassRows(root, 'cfg-vlm-detect-classes', va.class_names, va.class_hints);
                    }
                }
                setVlmMode(root, vlmMode);
                // After setVlmMode so the leaving-Detect reset in toggleVlmMode can't clobber
                // it. Only Detect mode carries the loaded level. On the wire absent means
                // High, so a stored config without a level must display (and re-save as)
                // High; Low is the default for NEW configs only. Custom/Describe reset the
                // hidden radio to that new-config default.
                setReasoningLevel(root, vlmMode === 'detect' ? (reasoningLevel || 'high') : 'low');
            }

            {
                const sy = config.synthetic_analysis || {};
                const globalSy = config.detector_type === 'verify'
                    ? (verifyBaseline().svd || {})
                    : ((defaultConfig && defaultConfig.synthetic_analysis) || {});

                if (sy.endpoint) field(root, 'cfg-synthetic-endpoint').value = sy.endpoint;
                showInheritedSyntheticEndpoint(root, globalSy);

                // use_tls is a tri-state <select> ('' auto-detect / true / false), not a
                // text/number input - it has no placeholder to show an effective default
                // in, so an unset stream value leaves it on '' (auto-detect), same as before.
                if (typeof sy.use_tls === 'boolean') {
                    field(root, 'cfg-synthetic-use-tls').value = String(sy.use_tls);
                }

                // Auto-expand the disclosure when any TLS material is in effect.
                let anyTlsCert = false;
                [['cfg-synthetic-tls-ca-cert', 'tls_ca_cert'],
                 ['cfg-synthetic-tls-client-cert', 'tls_client_cert'],
                 ['cfg-synthetic-tls-client-key', 'tls_client_key']].forEach(function(pair) {
                    if (sy[pair[1]]) field(root, pair[0]).value = sy[pair[1]];
                    if (sy[pair[1]] || globalSy[pair[1]]) anyTlsCert = true;
                });
                // A connection choice made on purpose shows too.
                setSyntheticTlsCertsExpanded(root, anyTlsCert || typeof sy.use_tls === 'boolean');

                if (sy.api_key) {
                    field(root, 'cfg-synthetic-api-key').value = sy.api_key;
                }
                syncSectionApiKeyToggle(root, 'cfg-synthetic-api-key', 'cfg-synthetic-api-key-toggle');
                if (sy.function_id) {
                    field(root, 'cfg-synthetic-function-id').value = sy.function_id;
                }

                const thresholdInput = field(root, 'cfg-synthetic-classification-threshold');
                if (sy.classification_threshold !== undefined && sy.classification_threshold !== null) {
                    thresholdInput.value = sy.classification_threshold;
                }
                if (globalSy.classification_threshold !== undefined && globalSy.classification_threshold !== null) {
                    thresholdInput.placeholder = String(globalSy.classification_threshold);
                }
                showSyntheticStrictness(root, true);
            }

            {
                const vf = config.verify_analysis || {};
                const globalVf = verifyBaseline();
                [['cfg-verify-flag-threshold', 'flag_threshold'],
                 ['cfg-verify-strong-threshold', 'strong_threshold']].forEach(function(pair) {
                    const input = field(root, pair[0]);
                    if (!input) return;
                    if (vf[pair[1]] !== undefined && vf[pair[1]] !== null) input.value = vf[pair[1]];
                    if (globalVf[pair[1]] !== undefined && globalVf[pair[1]] !== null) input.placeholder = String(globalVf[pair[1]]);
                });
            }

            // Which form each credential slot holds: a reference is readable and shows by
            // name; anything else is the value mode, where a stored literal stays hidden.
            setSecretSlot(root, 'cfg-vlm-api-key',
                config.vlm_analysis && config.vlm_analysis.api_key_secret);
            setSecretSlot(root, 'cfg-synthetic-api-key',
                config.synthetic_analysis && config.synthetic_analysis.api_key_secret);
            setSecretSlot(root, 'cfg-synthetic-tls-client-key',
                config.synthetic_analysis && config.synthetic_analysis.tls_client_key_secret);

            toggleByteTrack(root);
            toggleCheckpointPath(root);
            toggleTiling(root);
        }

        function populateForm(config) {
            resetForm();
            suppressDirtyTracking = true;

            if (config.vi_service_url !== undefined) {
                document.getElementById('cfg-vi-service-url').value = config.vi_service_url;
            }
            if (config.vi_service_api_key !== undefined) {
                document.getElementById('cfg-vi-service-api-key').value = config.vi_service_api_key;
            }
            syncApiKeyToggleState('cfg-vi-service-api-key', 'cfg-vi-service-api-key-toggle');
            if (config.active !== undefined) {
                document.getElementById('cfg-active').checked = config.active;
            }
            if (config.log_max_messages !== undefined) {
                document.getElementById('cfg-log-max-messages').value = config.log_max_messages;
            }
            if (config.inference_fps !== undefined) {
                document.getElementById('cfg-inference-fps').value = config.inference_fps;
            }
    		setInferenceVideoHeightFromValue(config.inference_video_height);
            if (config.use_transcoder !== undefined) {
                document.getElementById('cfg-use-transcoder').checked = config.use_transcoder;
                document.getElementById('cfg-use-transcoder-warning').style.display = 'none';
            }
            else {
                // Left unsaid, it reads as a new config of that type would start.
                document.getElementById('cfg-use-transcoder').checked =
                    config.detector_type !== 'synthetic' && config.detector_type !== 'verify';
                document.getElementById('cfg-use-transcoder-warning').style.display = 'none';
            }
            // Baseline for applyDetectorTypeTranscoderSuggestion: a manual toggle later makes
            // checked !== dataset.suggested, which tells the suggestion to back off.
            document.getElementById('cfg-use-transcoder').dataset.suggested = String(document.getElementById('cfg-use-transcoder').checked);
            if (config.frame_grab_interval !== undefined) {
                document.getElementById('cfg-frame-grab').value = config.frame_grab_interval;
            }
            if (config.rollup_batch_interval !== undefined) {
                document.getElementById('cfg-rollup-batch-interval').value = config.rollup_batch_interval;
            }
            if (config.duration !== undefined) {
                document.getElementById('cfg-duration').value = config.duration;
            }
            if (config.grayscaled !== undefined) {
                document.getElementById('cfg-grayscaled').checked = config.grayscaled;
            }

            // auto_frame_throttle (renamed from auto_scene_frame_throttle). Opt-in, default OFF for all
            // modes. Prefer the new key; for scene/VLM fall back to the legacy auto_scene_frame_throttle
            // key (where it originally applied); unset => off.
            let autoFrameThrottle = config.auto_frame_throttle;
            if (autoFrameThrottle === undefined && config.detector_type !== 'object') {
                autoFrameThrottle = config.auto_scene_frame_throttle;
            }
            document.getElementById('cfg-auto-frame-throttle').checked = (autoFrameThrottle === true);
            if (config.catch_up_to_live !== undefined) {
                document.getElementById('cfg-catch-up-to-live').checked = config.catch_up_to_live;
            }
            // null/absent => leave blank so the "auto (~2s)" placeholder shows
            if (config.catch_up_max_behind_seconds !== undefined && config.catch_up_max_behind_seconds !== null) {
                document.getElementById('cfg-catch-up-max-behind').value = config.catch_up_max_behind_seconds;
            }
            if (config.log_timing !== undefined) {
                document.getElementById('cfg-log-timing').value = config.log_timing;
            }
            if (config.detector_type !== undefined) {
                document.getElementById('cfg-detector-type').value = config.detector_type;
            }

            populateSections(sectionsRoot, config);
            syntheticStrictnessOpen = document.getElementById('cfg-detector-type').value !== 'synthetic';
            syntheticStrictnessStarted = false;
            rememberStoredSections(config);
            if (config.detector_type === 'chain' && config.chain_detector) loadChain(config.chain_detector);

            // Event listeners
            populateEventListeners(config.vif_event_listeners);

            toggleDetectorSection();
            // The in-section slots are set by populateSections above; the service key's
            // slot is the page's own.
            setSecretSlot(null, 'cfg-vi-service-api-key', config.vi_service_api_key_secret);
            // Round 3: capture this stream's own raw `config` (as returned by GET, or
            // defaultConfig for a new stream) for buildConfigJson()'s collectUnsetFields() to
            // read stored values from at save time - not the layered/effective values the
            // inputs now show as placeholders. (Previously fed the removed pinned/inherited
            // badge rendering via updateFieldInheritIndicators().)
            lastRawStreamConfig = config;
            suppressDirtyTracking = false;
            markClean(false);
        }

        function populateCheckpointPaths(root, existingPath) {
            var select = field(root, 'cfg-checkpoint-path');
            select.innerHTML = '';
            var models = (defaultConfig && defaultConfig.available_models && defaultConfig.available_models.models) || [];
            var customModels = models.filter(function(m) { return m.is_custom; });
            if (customModels.length === 0) {
                if (existingPath) {
                    var opt = document.createElement('option');
                    opt.value = existingPath;
                    opt.textContent = existingPath;
                    select.appendChild(opt);
                } else {
                    var opt = document.createElement('option');
                    opt.value = '';
                    opt.textContent = 'No custom models available';
                    select.appendChild(opt);
                }
                return;
            }
            customModels.forEach(function(model) {
                var opt = document.createElement('option');
                opt.value = model.checkpoint_path;
                opt.textContent = model.checkpoint_path;
                select.appendChild(opt);
            });
        }

        var CHAIN_STAGE_LABELS = { object: 'Find objects', scene: 'Recognize a scene', vlm: 'Ask an AI model', synthetic: 'Spot AI-generated video', motion: 'Watch for movement' };
        var FRAME_SELECTION_LABELS = {
            all: 'Every frame', first: 'First frame', middle: 'Middle frame', last: 'Last frame', every_nth: 'One frame in every few'
        };
        var STAGE_ANALYSIS = { object: 'object_analysis', scene: 'scene_analysis', vlm: 'vlm_analysis', synthetic: 'synthetic_analysis', motion: 'motion_analysis' };
        var STAGE_SECRETS = {
            vlm: ['vlm_analysis.api_key'],
            synthetic: ['synthetic_analysis.api_key', 'synthetic_analysis.tls_client_key']
        };
        var STAGE_FLATTENERS = {
            object: VIF.v2map.flatObjectAnalysis,
            scene: VIF.v2map.flatSceneAnalysis,
            vlm: VIF.v2map.flatVlmAnalysis,
            synthetic: VIF.v2map.flatSyntheticAnalysis,
            motion: VIF.v2map.flatMotionAnalysis
        };
        var STAGE_WRITERS = {
            object: function(flat) { return VIF.v2map.writeObjectDetector(flat); },
            scene: function(flat) { return VIF.v2map.writeSceneDetector(flat); },
            vlm: function(flat) { return VIF.v2map.writeVlmDetector(flat, {}); },
            synthetic: function(flat) { return VIF.v2map.writeSyntheticDetector(flat, {}); },
            motion: function(flat) { return VIF.v2map.writeMotionDetector(flat); }
        };
        var CHAIN_NUMBER_RULES = {
            'crop-min-confidence': { min: 0, max: 100, decimals: 1, label: 'At least % sure' },
            'crop-padding': { min: 0, max: 100, decimals: 1, label: 'Extra margin %' },
            'crop-max': { min: 1, max: 256, integer: true, label: 'Most boxes per check' },
            'frame-stride': { min: 2, max: 1000, integer: true, label: 'One frame in every' }
        };
        // Why following objects is off on a step while it zooms in, quoting its zoom switch.
        function cropTrackingWhy(card) {
            return 'Off while “' + card.cropTitle.textContent + '” is on, because each box is checked separately. Turn that off to follow objects.';
        }

        // Why a step can't follow objects, in the words the step panel shows.
        function chainTrackingWhy(blocker) {
            const label = VIF.chainBuilder.stepLabel(blocker.type);
            if (blocker.reason === 'entry' && blocker.type === 'motion') {
                return 'Following objects needs every frame, but step 1 (Watch for movement) only passes on frames where something moves. To follow objects, make Find objects the first step.';
            }
            if (blocker.reason === 'entry') return 'Following objects needs Find objects as the first step.';
            if (blocker.reason === 'clip') {
                return 'Following objects is off because ' + label + ' makes this chain check whole clips, and following needs every frame.';
            }
            if (blocker.reason === 'window') {
                return 'Only the first step can follow objects once ' + label + ' is in the chain, because only step 1 sees every frame of each clip.';
            }
            if (blocker.reason === 'dynamic') {
                return 'Following objects is off while your code picks the next step, because this step could see the same frames twice.';
            }
            if (blocker.reason === 'selection') {
                return 'Following objects needs every frame, but “Which frames” on this step skips some. Set it to every frame to follow objects.';
            }
            const from = chainState.stages.findIndex(function(each) { return chainTrimmed(each.name) === blocker.name; });
            return 'Following objects is off because the condition after step ' + (from + 1)
                + ' comes back to this step, so it would see the same frames twice.';
        }
        var CHAIN_GATE_NUMBER_RULES = {
            minConfidence: { min: 0, max: 100, decimals: 1, label: 'At least % sure' },
            minCount: { min: 1, max: 100000, integer: true, label: 'At least how many' }
        };
        var CHAIN_LEVEL_NUMBER_RULES = {
            'chain-max-rings': { min: 1, max: 64, integer: true, label: 'Maximum step runs per clip' },
            'chain-decision-timeout': { min: 0.001, max: 2147483.647, decimals: 3, label: 'Wait for a decision (seconds)' }
        };
        var CHAIN_LEVEL_LABELS = {
            max_rings: 'Maximum step runs per clip',
            'decision_listener.class_name': 'Your code',
            decision_timeout_seconds: 'Wait for a decision'
        };
        var CHAIN_MODE_LABELS = { linear: 'Conditions you set', conditional: 'Conditions you set', dynamic: 'Your code' };
        var CHAIN_EDITABLE = '.chain-stage, .chain-gate, #chain-decision-panel, #chain-advanced, #chain-video-host';
        // What a step is, beside its title in the panel, for the steps whose trade-off isn't obvious.
        var STEP_TIPS = {
            scene: 'A small, fast model that uses less of the GPU, so it can watch more streams at once. It understands a scene less well than an Ask an AI model step, so use it for simple cases, or as a first check before the AI model runs.'
        };
        var CHAIN_TIPS = {
            stageName: 'What this step is called. It shows on the step’s box and in its results, and your code uses it to pick the step. Each step needs its own.',
        };
        // What the frame choice means, under the Frames select.
        function chainFrameHelp(mode, stride, type) {
            // An AI model step sends every selected frame of a clip in one request, so the
            // frames it looks at are its cost.
            if (mode === 'all' && type === 'vlm') {
                return 'Every frame of each clip goes to the AI model in one request. Fewer frames is cheaper and faster, but can miss things that happen quickly.';
            }
            if (mode === 'first') return 'The first frame of each clip only.';
            if (mode === 'middle') return 'The middle frame of each clip only.';
            if (mode === 'last') return 'The last frame of each clip only.';
            if (mode === 'every_nth') {
                const n = parseInt(stride, 10);
                return 'The first frame, then one in every ' + (n > 0 ? n : 'few') + ' after it, plus the last frame.';
            }
            return 'Every frame of each clip. Fewer frames is faster but can miss things that happen quickly.';
        }
        var CHAIN_SYNTHETIC_FRAMES_NOTE = 'Spot AI-generated video always looks at the whole clip.';
        var CHAIN_SVD_GATE_NOTE = 'A clip counts as AI-generated only when its score is above the step’s threshold, while a rule’s At least % sure also counts a score equal to it.';

        var chainState = null;
        var chainStoredDetector = null;
        var chainCards = {};
        var chainUidSeq = 0;
        var chainDrag = null;
        var chainSuggestedEntryType = null;
        var chainPropertyRows = [];
        var chainPropertySeq = 0;
        var chainPendingMode = null;
        var chainSelection = { kind: 'chain' };
        var chainShowGetStarted = false;
        var chainHosted = false;
        var chainGetStarted = VIF.chainBuilder.createGetStarted(document.getElementById('chain-getstarted'), {
            onChain: function(preset) { applyChainPreset(preset); },
            onBuild: function() {
                chainShowGetStarted = false;
                refreshChainView(false);
            }
        });

        function chainStageTypes() {
            return chainState ? chainState.stages.map(function(stage) { return (stage.detector || {}).type; }) : [];
        }

        function chainEntryType() {
            return chainStageTypes()[0] || 'object';
        }

        /**
         * The kinds of step whose results reach destinations, which decide the methods a
         * destination can use: the last step, and any step whose condition ends the chain when
         * it finds something; every step when each step's results go out or your code picks.
         */
        function chainSentStepTypes() {
            if (!chainState || !chainState.stages.length) return [];
            const stages = chainState.stages;
            const typeOf = function(stage) { return (stage.detector || {}).type; };
            const mode = VIF.chainEditor.chainMode(chainState);
            let sent;
            if (mode === 'dynamic' || chainState.resultMode === 'combined' || chainState.dispatchIntermediateRings === true) {
                sent = stages.map(typeOf);
            } else {
                sent = [typeOf(stages[stages.length - 1])];
                if (mode === 'conditional') {
                    stages.forEach(function(stage) {
                        const routing = stage.routing || {};
                        if ((routing.onMatch && routing.onMatch.end) || (routing.onDone && routing.onDone.end)) sent.push(typeOf(stage));
                    });
                }
            }
            return sent.filter(function(type, at) { return type && sent.indexOf(type) === at; });
        }

        /**
         * The frames an AI model step receives per clip on a clip-cadence chain: what the
         * chain captures (Duration × Inference FPS, as the page would save them) and what
         * the step's frame choice keeps. Null off clip cadence; captured -1 when the rate
         * follows the stream and the count can't be known here.
         */
        function chainVlmFrameBudget(stage) {
            if (!chainIsWindowed() || stage.crop) return null;
            const fps = resolveEffectiveInferenceFpsForVlm();
            const durationEl = document.getElementById('cfg-duration');
            const raw = (durationEl.value || '').trim();
            const duration = raw !== '' ? parseFloat(raw)
                : Number.isFinite(defaultConfig && defaultConfig.duration) ? defaultConfig.duration
                : parseFloat(durationEl.placeholder || '2');
            if (!Number.isFinite(fps) || !Number.isFinite(duration)) return null;
            // At the stream's own rate the frame count is unknown, so only a one-frame choice is safe.
            if (fps === -1) {
                const mode = (stage.frameSelection || {}).mode || 'all';
                return { captured: -1, selected: -1, mode: mode, over: mode === 'all' || mode === 'every_nth' };
            }
            const captured = Math.round(duration * fps);
            const selected = VIF.chainEditor.selectedFrameCount(captured, stage.frameSelection);
            return { captured: captured, selected: selected, over: selected > VLM_TYPICAL_ENDPOINT_IMAGE_CAP };
        }

        function chainVlmFrameWarning(budget) {
            if (budget.captured === -1 && budget.mode === 'every_nth') {
                return 'At the stream’s own frame rate, how many frames this step gets depends on the stream, and can be more than most AI models take in one request. '
                    + 'Pick the first, middle or last frame under Which frames it looks at, or set a fixed Inference FPS.';
            }
            if (budget.captured === -1) {
                return 'At the stream’s own frame rate every frame of the clip goes to the AI model, more than most take in one request. '
                    + 'Pick fewer frames under Which frames it looks at, or set a fixed Inference FPS.';
            }
            return 'Most AI models take ' + VLM_TYPICAL_ENDPOINT_IMAGE_CAP + ' frames in one request. If this model’s server takes fewer, '
                + 'VIF sends it an evenly spaced set and skips the rest. '
                + 'Pick fewer frames under Which frames it looks at, or lower Inference FPS or Duration.';
        }

        function chainIsWindowed() {
            const types = chainStageTypes();
            return (types.indexOf('scene') !== -1 || types.indexOf('vlm') !== -1) && types.indexOf('synthetic') === -1;
        }

        // The editor's zoom and following problems, in the words their switches use.
        function chainPlainProblem(error) {
            const picks = /^stages\[(\d+)\]\.detector\.(classes|detect\.classes): (pick|add) at least one/.exec(error);
            if (picks) {
                const step = Number(picks[1]) + 1;
                const type = (((chainState ? chainState.stages : [])[step - 1] || {}).detector || {}).type;
                return type === 'object' ? 'Step ' + step + ': pick at least one thing to look for, or Select all.'
                    : type === 'scene' ? 'Step ' + step + ': add at least one situation to recognize.'
                    : 'Step ' + step + ': add at least one thing to check for.';
            }
            const found = /^stages\[(\d+)\]\.(crop|detector\.tracking|detector\.tiling):\s*(.*)$/.exec(error);
            if (!found) return '';
            const step = Number(found[1]) + 1;
            const text = found[3];
            if (found[2] === 'detector.tracking' && /when the stage crops/.test(text)) return 'Step ' + step + ': turn off Follow each object to zoom in.';
            if (found[2] === 'detector.tiling' && /when the stage crops/.test(text)) return 'Step ' + step + ': tiling has to be off to zoom in.';
            if (found[2] === 'detector.tracking' && /every captured frame/.test(text)) {
                const blocker = VIF.chainEditor.trackingBlocker(chainState, Number(found[1]));
                const why = blocker ? chainTrackingWhy(blocker) : 'This chain doesn’t pass it every frame.';
                return 'Step ' + step + ': ' + why + ' Turn off Follow each object.';
            }
            if (found[2] !== 'crop') return '';
            if (/entry stage/.test(text)) return 'Step ' + step + ' is first, so there’s nothing before it to zoom in on. Turn off Zoom in.';
            if (/synthetic stage/.test(text)) return 'Step ' + step + ' checks the whole clip, so it can’t zoom in. Turn off Zoom in.';
            if (/motion stage/.test(text)) return 'Step ' + step + ' compares whole frames, so it can’t zoom in. Turn off Zoom in.';
            if (/immediately before it/.test(text)) return 'Step ' + (step - 1) + ' draws no boxes to zoom in on. Turn off Zoom in on step ' + step + '.';
            if (/no boxes to crop/.test(text)) return 'Step ' + step + ' can’t zoom in: none of the steps that lead to it draw boxes. Turn off Zoom in.';
            return '';
        }

        // A frame-choice problem, in the words the Which frames control uses.
        function chainFramesProblem(error) {
            const found = /^stages\[(\d+)\]\.frame_selection(?:\.stride)?:\s*(.*)$/.exec(error);
            if (!found) return '';
            const step = Number(found[1]) + 1;
            if (/whole-number stride/.test(found[2])) return 'Step ' + step + ': One frame in every needs a whole number of 2 or more.';
            return '';
        }

        // Step `index` in text: its number, then its name when someone chose it.
        function chainStepNamed(index, word) {
            const name = chainTrimmed((chainState.stages[index] || {}).name);
            return word + ' ' + (index + 1) + (name && !VIF.chainPresets.isGivenName(name) ? ' · ' + name : '');
        }

        // A message adds a chosen name to each step it numbers. With your code deciding, the steps
        // have no order, so it names the step instead of numbering it.
        function chainStepRefs(text) {
            if (!chainState) return text;
            if (VIF.chainEditor.chainMode(chainState) !== 'dynamic') {
                return text.replace(/\b([Ss]tep) (\d+)\b(?! ·)/g, function(found, word, number) {
                    return chainState.stages[Number(number) - 1] ? chainStepNamed(Number(number) - 1, word) : found;
                });
            }
            return text.replace(/\b([Ss])tep (\d+)\b/g, function(found, s, number) {
                const stage = chainState.stages[Number(number) - 1];
                if (!stage) return found;
                const name = chainTrimmed(stage.name);
                const ref = name ? '“' + name + '”' : VIF.chainBuilder.stepLabel((stage.detector || {}).type);
                return (s === 'S' ? 'The ' : 'the ') + ref + ' step';
            });
        }

        function chainErrorText(error) {
            return chainStepRefs(chainNumberedErrorText(error));
        }

        function chainNumberedErrorText(error) {
            const plain = chainPlainProblem(error) || chainFramesProblem(error);
            if (plain) return plain;
            const stage = /^stages\[(\d+)\]((?:\.[a-z_]+(?:\[\d+\])?)*):\s*(.*)$/.exec(error);
            if (stage) {
                const member = stage[2].replace(/^\./, '').replace(/^detector\./, '')
                    .replace(/\.(mode|stride|stage)$/, '')
                    .replace(/rules\[(\d+)\]/g, function(match, n) { return 'rule ' + (Number(n) + 1); })
                    .replace(/[._]/g, ' ');
                return 'Step ' + (Number(stage[1]) + 1) + (member ? ' ' + member : '') + ': ' + stage[3];
            }
            const top = /^([a-z_.]+):\s*(.*)$/.exec(error);
            if (top && CHAIN_LEVEL_LABELS[top[1]]) return CHAIN_LEVEL_LABELS[top[1]] + ': ' + top[2];
            const text = error.replace(/^stages:\s*/, '');
            return text.charAt(0).toUpperCase() + text.slice(1);
        }

        function assignStageUids(state) {
            state.stages.forEach(function(stage) {
                if (stage.uid === undefined) stage.uid = ++chainUidSeq;
            });
            return state;
        }

        function chainIndexOf(uid) {
            for (let i = 0; i < chainState.stages.length; i++) {
                if (chainState.stages[i].uid === uid) return i;
            }
            return -1;
        }

        function chainCardOfRoot(root) {
            const uid = Object.keys(chainCards).filter(function(key) { return chainCards[key].root === root; })[0];
            return uid ? chainCards[uid] : null;
        }

        function chainCardName(card) {
            return card.nameInput.value.trim();
        }

        function stageFlat(detector) {
            const type = detector.type;
            const flat = { detector_type: type };
            flat[STAGE_ANALYSIS[type]] = STAGE_FLATTENERS[type](detector);
            if (type !== 'object') return flat;
            const tracking = detector.tracking;
            if (tracking && tracking.ignoreUntracked !== undefined && tracking.ignoreUntracked !== null) {
                flat.ignore_untracked_objects = tracking.ignoreUntracked;
            }
            if (!flat.object_analysis.model_name) {
                const baseline = (defaultConfig && defaultConfig.object_analysis) || {};
                flat.object_analysis.model_name = baseline.model_name || 'medium';
            }
            return flat;
        }

        var OPAQUE_DETECTOR_MEMBERS = ['classHints', 'classSensitivity', 'responseSchema'];

        function prunedDetector(value) {
            const out = {};
            Object.keys(value).forEach(function(key) {
                let member = value[key];
                if (member === null || member === undefined) return;
                const opaque = OPAQUE_DETECTOR_MEMBERS.indexOf(key) !== -1;
                if (!opaque && typeof member === 'object' && !Array.isArray(member)) {
                    member = prunedDetector(member);
                    if (Object.keys(member).length === 0) return;
                }
                out[key] = member;
            });
            return out;
        }

        function keepStageClasses(card, classes) {
            const select = field(card.root, 'cfg-class-names');
            (classes || []).forEach(function(name) {
                let option = Array.from(select.options).filter(function(each) { return each.value === name; })[0];
                if (!option) {
                    option = chainEl('option', null, name);
                    option.value = name;
                    select.appendChild(option);
                }
                option.selected = true;
            });
        }

        function deleteAtPath(object, path) {
            const parts = path.split('.');
            const parent = getConfigValueAtPath(object, parts.slice(0, -1).join('.'));
            if (parent && typeof parent === 'object') delete parent[parts[parts.length - 1]];
        }

        function stageDetectorFromDom(card, stage) {
            const writable = JSON.parse(JSON.stringify(readSections(card.root, card.type)));
            (STAGE_SECRETS[card.type] || []).forEach(function(path) { deleteAtPath(writable, path); });
            return prunedDetector(VIF.v2map.applyDetectorPatch(stage.detector, STAGE_WRITERS[card.type](writable)));
        }

        function readChainCard(card, stage) {
            stage.name = chainCardName(card);
            stage.detector = stageDetectorFromDom(card, stage);

            const mode = card.frameMode.value;
            if (mode !== 'all') {
                stage.frameSelection = { mode: mode };
                if (mode === 'every_nth') {
                    // The box starts at its usual 2, so the choice works as soon as it's picked.
                    if (String(card.strideInput.value || '').trim() === '') card.strideInput.value = card.strideInput.placeholder || '2';
                    stage.frameSelection.stride = readNumber(card.strideInput, true);
                }
            } else if (!(stage.frameSelection && stage.frameSelection.mode === 'all')) {
                delete stage.frameSelection;
            }

            if (VIF.chainEditor.chainMode(chainState) === 'conditional') readGate(card, stage);

            if (!card.cropOn) {
                delete stage.crop;
                return;
            }
            const crop = {};
            const classes = card.cropClasses.value.split(',').map(function(name) { return name.trim(); })
                .filter(function(name) { return name !== ''; });
            if (classes.length) crop.classes = classes;
            const minConfidence = readNumber(card.cropMinConfidence, false, 100);
            if (minConfidence !== undefined) crop.minConfidence = minConfidence;
            const padding = readNumber(card.cropPadding, false, 100);
            if (padding !== undefined) crop.padding = padding;
            const maxCrops = readNumber(card.cropMax, true);
            if (maxCrops !== undefined) crop.maxCrops = maxCrops;
            stage.crop = crop;
        }

        function isPresent(value) {
            return value !== undefined && value !== null;
        }

        function chainTrimmed(name) {
            return typeof name === 'string' ? name.trim() : '';
        }

        function chainPercentText(value) {
            return isPresent(value) ? String(Math.round(value * 1000) / 10) : '';
        }

        function chainPlainText(value) {
            return isPresent(value) ? String(value) : '';
        }

        function chainCsvText(list) {
            return isPresent(list) ? list.join(', ') : '';
        }

        function chainCsvList(text) {
            return text.split(',').map(function(name) { return name.trim(); })
                .filter(function(name) { return name !== ''; });
        }

        function chainKeptOrRead(input, base, text, read) {
            return input.value === text(base) ? base : read(input);
        }

        function setOrDelete(object, key, value) {
            if (isPresent(value)) object[key] = value;
            else delete object[key];
        }

        function chainTargetValue(target, absent) {
            if (!target) return absent;
            if (target.end === true && !isPresent(target.stage)) return 'end';
            if (typeof target.stage === 'string' && !isPresent(target.end)) return 's:' + target.stage.trim();
            return absent;
        }

        function chainTargetOf(value) {
            if (value === 'end') return { end: true };
            if (value.indexOf('s:') === 0) return { stage: value.slice(2) };
            return undefined;
        }

        function readGateRule(row) {
            const base = row.base;
            const rule = {};
            const classes = chainKeptOrRead(row.classes, base.classes, chainCsvText, function(input) {
                const list = chainCsvList(input.value);
                return list.length ? list : undefined;
            });
            if (isPresent(classes)) rule.classes = classes.slice();
            setOrDelete(rule, 'minConfidence', chainKeptOrRead(row.minConfidence, base.minConfidence, chainPercentText,
                function(input) { return readNumber(input, false, 100); }));
            setOrDelete(rule, 'minCount', chainKeptOrRead(row.minCount, base.minCount, chainPlainText,
                function(input) { return readNumber(input, false); }));
            return rule;
        }

        function readGate(card, stage) {
            const gate = card.gate;
            if (!card.routeOn) {
                delete stage.routing;
                return;
            }
            if (gate.kind === 'always') {
                stage.routing = { onDone: chainTargetOf(gate.onDone.value) || { end: true } };
                return;
            }
            const previous = stage.routing || {};
            const routing = { rules: gate.rows.map(readGateRule) };
            if (gate.match) routing.match = gate.match;
            const onMatch = chainTargetOf(gate.onMatch.value);
            if (onMatch) routing.onMatch = onMatch;
            const keepsEnd = gate.onNoMatch.value === 'end' && chainTargetValue(previous.onNoMatch, 'end') === 'end';
            const onNoMatch = keepsEnd ? previous.onNoMatch : chainTargetOf(gate.onNoMatch.value);
            if (onNoMatch) routing.onNoMatch = JSON.parse(JSON.stringify(onNoMatch));
            stage.routing = routing;
        }

        function readChainProperty(row) {
            return row.hasBase && row.value.value === row.baseText ? row.base : row.value.value;
        }

        function readChainLevel(state) {
            setOrDelete(state, 'maxRings', readNumber(document.getElementById('chain-max-rings'), false));
            setOrDelete(state, 'resultMode', chainSendsEveryStep(state) ? undefined : (document.getElementById('chain-result-mode').value || undefined));
            if (VIF.chainEditor.chainMode(state) !== 'dynamic') return;

            const previous = state.decisionListener || {};
            const listener = {};
            const className = document.getElementById('chain-decision-class').value.trim();
            if (className !== '') listener.className = className;
            const named = chainPropertyRows.filter(function(row) { return row.key.value.trim() !== ''; });
            if (named.length) {
                listener.properties = {};
                named.forEach(function(row) { listener.properties[row.key.value.trim()] = readChainProperty(row); });
            } else if (previous.properties && Object.keys(previous.properties).length === 0) {
                listener.properties = {};
            }
            setOrDelete(state, 'decisionListener', Object.keys(listener).length ? listener : undefined);
            setOrDelete(state, 'decisionTimeoutSeconds', readNumber(document.getElementById('chain-decision-timeout'), false));
            const dispatch = document.getElementById('chain-dispatch-intermediate').checked;
            setOrDelete(state, 'dispatchIntermediateRings', dispatch ? true : (state.dispatchIntermediateRings === false ? false : undefined));
        }

        // With your code deciding and each step's results sent as it finishes, the end of the clip
        // sends the last step only: every step again would send the earlier ones twice.
        function chainSendsEveryStep(state) {
            return VIF.chainEditor.chainMode(state) === 'dynamic' && document.getElementById('chain-dispatch-intermediate').checked;
        }

        var CHAIN_MAX_RINGS_TIPS = {
            dynamic: 'How many steps may run on one clip, counting the one that runs first, 8 by default. When it’s reached, the clip ends with the results it has, even if your code would pick another step.'
        };

        function syncChainLevelControls() {
            const resultMode = document.getElementById('chain-result-mode');
            const locked = chainSendsEveryStep(chainState);
            if (locked) {
                resultMode.value = '';
                delete chainState.resultMode;
            }
            resultMode.disabled = locked;
            document.getElementById('chain-result-mode-note').style.display = locked ? '' : 'none';
            const tip = document.querySelector('label[for="chain-max-rings"] .vif-help-tip');
            if (tip.dataset.vifTipDefault === undefined) tip.dataset.vifTipDefault = tip.dataset.vifTip;
            tip.dataset.vifTip = CHAIN_MAX_RINGS_TIPS[VIF.chainEditor.chainMode(chainState)] || tip.dataset.vifTipDefault;
        }

        function syncChainFromCards() {
            if (!chainState) return;
            readChainLevel(chainState);
            chainState.stages.forEach(function(stage) {
                const card = chainCards[stage.uid];
                if (card) readChainCard(card, stage);
            });
        }

        function collectChain() {
            ensureChain();
            syncChainFromCards();
            return VIF.chainEditor.collectChainDetector(chainState);
        }

        function collectChainStageSecrets() {
            const secrets = {};
            if (!chainState) return secrets;
            chainState.stages.forEach(function(stage) {
                const card = chainCards[stage.uid];
                const collect = card && stageSecretsCollector(card);
                if (!collect) return;
                const collected = collect(chainCardName(card), readSections(card.root, card.type), card.touched);
                // A slot in stored-secret mode holds the name; its literal is withdrawn
                // entirely — the API refuses a write carrying both forms.
                Object.keys(SECRET_INPUTS).forEach(function(path) {
                    if (secretSourceIsStored(card.root, SECRET_INPUTS[path])) {
                        delete collected[VIF.v2map.stageSecretPath(chainCardName(card), path)];
                    }
                });
                Object.assign(secrets, collected);
            });
            return secrets;
        }

        function stageSecretsCollector(card) {
            if (card.type === 'vlm') return VIF.v2map.stageSecretsForVlm;
            if (card.type !== 'synthetic') return null;
            return syntheticEndpointIsNvcf(card.root) ? VIF.v2map.stageSecretsForNvcfSvd : VIF.v2map.stageSecretsForSelfHostedSvd;
        }

        function rememberStoredSections(config) {
            storedEndpoints.set(sectionsRoot, {
                vlmUrl: (config.vlm_analysis || {}).endpoint_url || null,
                vlmKeySecret: (config.vlm_analysis || {}).api_key_secret || null,
                svdEndpoint: (config.synthetic_analysis || {}).endpoint || null,
                svdKeySecret: (config.synthetic_analysis || {}).api_key_secret || null,
                svdTlsKeySecret: (config.synthetic_analysis || {}).tls_client_key_secret || null
            });
        }

        function rebaseChainStored() {
            if (!chainState) return;
            chainStoredDetector = JSON.parse(JSON.stringify(VIF.chainEditor.collectChainDetector(chainState)));
            chainState.stages.forEach(function(stage) {
                const card = chainCards[stage.uid];
                if (card) rememberStoredStage(card, stage);
            });
            refreshChainView(false);
        }

        function rememberStoredStage(card, stage) {
            const detector = stage.detector || {};
            const endpoint = detector.endpoint || {};
            card.stored = { name: stage.name, type: detector.type };
            storedEndpoints.set(card.root, {
                vlmUrl: detector.type === 'vlm' ? (endpoint.url || null) : null,
                vlmKeySecret: detector.type === 'vlm' ? (endpoint.apiKeySecret || null) : null,
                svdEndpoint: detector.type === 'synthetic' ? (endpoint.address || null) : null,
                svdKeySecret: detector.type === 'synthetic' ? (endpoint.apiKeySecret || null) : null,
                svdTlsKeySecret: detector.type === 'synthetic' ? ((endpoint.tls || {}).clientKeySecret || null) : null,
                stage: stage.name,
                type: detector.type
            });
        }

        function chainBuilderErrors(config) {
            const state = VIF.chainEditor.initChain(config.chain_detector || { stages: [] });
            return VIF.chainEditor.validateChain(state).errors.concat(VIF.chainEditor.missingPicks(state)).map(chainErrorText);
        }

        function chainValidationErrors(config) {
            const errors = chainBuilderErrors(config);
            const cap = VIF.fieldRegistry.effectiveRule(VIF.fieldRegistry.getField('cfg-duration'), 'chain').max;
            if (config.duration !== undefined && config.duration !== null
                && (!Number.isFinite(config.duration) || config.duration < 0 || config.duration > cap)) {
                errors.push('Duration must be between 0 and ' + cap + ' for this chain.');
            }
            const svdDefault = (defaultConfig && defaultConfig.synthetic_analysis) || {};
            ((config.chain_detector || {}).stages || []).forEach(function(stage, index) {
                const detector = stage.detector || {};
                if (detector.type !== 'synthetic') return;
                const endpoint = detector.endpoint || {};
                if (!endpoint.address && !svdDefault.endpoint) {
                    errors.push('Step ' + (index + 1) + ': the detector server is required, as host:port. Set it in the step, or in Stream Config Defaults.');
                } else if (hostedSvdLacksFunctionId(endpoint.address || svdDefault.endpoint,
                    endpoint.functionId || inheritedFunctionId(endpoint.address, svdDefault.endpoint, svdDefault.function_id))) {
                    errors.push('Step ' + (index + 1) + ': ' + NVCF_FUNCTION_ID_REQUIRED + ' Set it in the step, or in Stream Config Defaults.');
                }
            });
            return errors;
        }

        function chainEl(tag, className, text) {
            const el = document.createElement(tag);
            if (className) el.className = className;
            if (text !== undefined) el.textContent = text;
            return el;
        }

        function chainButton(text, className, title) {
            const button = chainEl('button', className, text);
            button.type = 'button';
            if (title) button.title = title;
            return button;
        }

        function chainTip(text) {
            const tip = chainEl('span', 'vif-help-tip');
            tip.dataset.vifTip = text;
            tip.setAttribute('aria-label', 'Help');
            return tip;
        }

        function chainSummary(text, tip) {
            const summary = chainEl('summary', null, text);
            summary.prepend(chainEl('span', 'collapse-chevron', '▼'));
            if (tip) summary.appendChild(chainTip(tip));
            return summary;
        }

        function chainFormGroup(labelText, control, tip) {
            const group = chainEl('div', 'form-group');
            const label = chainEl('label', null, labelText);
            if (tip) label.appendChild(chainTip(tip));
            group.appendChild(label);
            if (control) group.appendChild(control);
            return group;
        }

        function chainInput(type, id, placeholder) {
            const input = chainEl('input');
            input.type = type;
            input.id = id;
            if (placeholder !== undefined) input.placeholder = placeholder;
            if (type === 'text') {
                input.autocomplete = 'off';
                input.spellcheck = false;
            }
            return input;
        }

        function buildFrameSelection(card) {
            const prefix = card.prefix;
            const box = chainEl('details', 'chain-disclosure');
            box.id = prefix + 'frame-selection';
            const summary = chainSummary('Which frames it looks at');
            card.frameValue = chainEl('span', 'chain-disclosure-value');
            card.frameValue.id = prefix + 'frame-value';
            summary.appendChild(card.frameValue);
            box.appendChild(summary);
            const body = chainEl('div', 'chain-disclosure-body');
            card.frameMode = chainEl('select');
            card.frameMode.id = prefix + 'frame-mode';
            VIF.chainEditor.FRAME_SELECTION_MODES.forEach(function(mode) {
                const option = chainEl('option', null, FRAME_SELECTION_LABELS[mode]);
                option.value = mode;
                card.frameMode.appendChild(option);
            });
            // Plain controls like a step's: a dropdown with its help, and the stride beside it.
            card.frameMode.className = 'cs-select';
            card.frameMode.setAttribute('aria-label', 'Which frames it looks at');
            card.frameHelp = chainEl('p', 'cs-help');
            card.frameHelp.id = prefix + 'frame-help';
            card.frameWarn = chainEl('p', 'cs-help text-warn');
            card.frameWarn.id = prefix + 'frame-warn';
            const frameGroup = chainEl('div', 'cs-field');
            frameGroup.append(card.frameMode, card.frameHelp, card.frameWarn);
            card.strideInput = chainInput('number', prefix + 'frame-stride', '2');
            card.strideInput.classList.add('cs-number');
            card.strideGroup = chainEl('div', 'cs-field');
            card.strideGroup.id = prefix + 'frame-stride-group';
            const strideHead = chainEl('div', 'cs-head');
            const strideLabel = chainEl('label', 'cs-label', 'One frame in every');
            strideLabel.htmlFor = card.strideInput.id;
            strideHead.appendChild(strideLabel);
            card.strideGroup.append(strideHead, card.strideInput);
            card.frameSyntheticNote = chainEl('p', 'cs-help cs-note');
            card.frameSyntheticNote.id = prefix + 'frame-synthetic-note';
            body.append(card.frameSyntheticNote, frameGroup, card.strideGroup);
            box.appendChild(body);
            card.frameBox = box;
        }

        // Zooming in on the boxes the step before found: a switch, which boxes, and a margin.
        // The inputs underneath are what the save reads; the controls over them write to them.
        function buildCrop(card) {
            const prefix = card.prefix;
            const box = chainEl('div', 'cs-crop');
            box.id = prefix + 'crop';
            const row = chainEl('div', 'cs-switch-row');
            const text = chainEl('div', 'cs-switch-text');
            card.cropTitle = chainEl('div', 'cs-label');
            card.cropTitle.id = prefix + 'crop-title';
            card.cropHelp = chainEl('p', 'cs-help');
            text.append(card.cropTitle, card.cropHelp);
            const holder = chainEl('label', 'switch');
            card.cropSwitch = chainEl('input');
            card.cropSwitch.type = 'checkbox';
            card.cropSwitch.id = prefix + 'crop-switch';
            card.cropSwitch.setAttribute('aria-labelledby', card.cropTitle.id);
            holder.append(card.cropSwitch, chainEl('span', 'slider-switch'));
            row.append(text, holder);
            card.cropError = chainEl('div', 'chain-stage-errors');
            card.cropError.id = prefix + 'crop-error';

            card.cropClasses = chainInput('text', prefix + 'crop-classes');
            card.cropMinConfidence = chainInput('number', prefix + 'crop-min-confidence');
            card.cropPadding = chainInput('number', prefix + 'crop-padding');
            card.cropMax = chainInput('number', prefix + 'crop-max', '16');
            const source = chainEl('div');
            source.style.display = 'none';
            source.append(card.cropClasses, card.cropMinConfidence, card.cropPadding);

            card.cropFields = chainEl('div', 'cs-crop-fields');
            card.cropFields.id = prefix + 'crop-fields';
            card.cropChipField = chainEl('div', 'cs-field');
            const chipHead = chainEl('div', 'cs-head');
            chipHead.appendChild(chainEl('span', 'cs-label', 'Which boxes'));
            card.cropChips = chainEl('div', 'cs-chips');
            card.cropChips.setAttribute('role', 'group');
            card.cropChips.setAttribute('aria-label', 'Which boxes');
            card.cropChipsKey = '';
            card.cropChipHelp = chainEl('p', 'cs-help');
            card.cropChipField.append(chipHead, card.cropChips, card.cropChipHelp);
            card.cropMargin = conditionRange(card.cropPadding, { label: 'Padding around each box', min: 0, max: 50, step: 1, unit: '%', fallback: 0 });
            box.append(row, card.cropError, card.cropFields, source);

            card.cropSure = conditionRange(card.cropMinConfidence, { label: 'Skip boxes less sure than', min: 0, max: 100, step: 5, unit: '%', fallback: 0 });
            const maxField = chainEl('div', 'cs-field');
            const maxHead = chainEl('div', 'cs-head');
            card.cropMaxLabel = chainEl('label', 'cs-label');
            card.cropMaxLabel.htmlFor = card.cropMax.id;
            // The service's own default, shown like a slider's, with a way back to it.
            const maxDefault = chainEl('span', 'cs-default');
            card.cropMaxReset = chainButton('Reset', 'cs-reset');
            card.cropMaxReset.addEventListener('click', function() {
                card.cropMax.value = '';
                fireFieldChange(card.cropMax);
            });
            maxDefault.append(chainEl('span', 'cs-default-text', 'Default ' + card.cropMax.placeholder), card.cropMaxReset);
            maxHead.append(card.cropMaxLabel, maxDefault);
            card.cropMax.classList.add('cs-number');
            card.cropMaxHelp = chainEl('p', 'cs-help');
            maxField.append(maxHead, card.cropMax, card.cropMaxHelp);
            card.cropFields.append(card.cropChipField, maxField, card.cropMargin.el, card.cropSure.el);
            card.cropBox = box;
        }

        // The step a zooming step takes its boxes from, as the page names it, and whether those
        // boxes are areas that moved rather than objects.
        function chainCropSource(index) {
            // The boxes come from the step that leads here and draws them, which routing can
            // make a step other than the one above.
            const sources = VIF.chainEditor.cropSources(chainState, index);
            const drawing = sources ? sources.filter(function(each) {
                const kind = (each.detector || {}).type;
                return kind === 'object' || kind === 'motion';
            })[0] : null;
            const before = drawing || chainState.stages[index - 1];
            const dynamic = VIF.chainEditor.chainMode(chainState) === 'dynamic';
            return {
                stage: before,
                step: dynamic ? 'the step that ran before it' : chainStepNamed(chainState.stages.indexOf(before), 'step'),
                moving: !dynamic && !!before && !!before.detector && before.detector.type === 'motion'
            };
        }

        // The zoom-in controls follow the step before: its number, what it found, and its picks.
        function refreshCropPlain(card, index) {
            const source = chainCropSource(index);
            const before = source.stage;
            const step = source.step;
            const moving = source.moving;
            card.cropTitle.textContent = 'Zoom in on what ' + step + ' found';
            // When step 1 follows objects, each object is zoomed in on once per check, on its best box.
            const entry = (chainState.stages[0] || {}).detector || {};
            const entryFollows = entry.type === 'object' && (entry.tracking || {}).method === 'byte-track';
            card.cropHelp.textContent = moving
                ? 'Looks only inside the areas ' + step + ' saw move and ignores the rest of the picture.'
                : 'Looks only inside the objects ' + step + ' detected. Helps spot small items.'
                    + (entryFollows ? ' Since step 1 follows objects, each object is zoomed in on once per check, not once per frame.' : '');
            if (card.cropOn) {
                const frames = card.frameMode.value;
                card.cropHelp.textContent += frames === 'all'
                    ? ' It looks at the same frames as ' + step + '.'
                    : ' It looks at the ' + chainFrameSelectionText(frames, card.strideInput.value).toLowerCase()
                        + ' only, set under Which frames it looks at.';
            }
            card.cropSwitch.checked = card.cropOn;
            card.cropFields.style.display = card.cropOn ? '' : 'none';

            const choices = before ? conditionChoices(before) : [];
            const picked = chainCsvList(card.cropClasses.value);
            const shown = choices.concat(picked.filter(function(name) { return choices.indexOf(name) === -1; }));
            card.cropChipField.style.display = shown.length ? '' : 'none';
            const key = shown.join('|') + '#' + picked.join('|');
            if (key !== card.cropChipsKey) {
                card.cropChipsKey = key;
                card.cropChips.replaceChildren();
                shown.forEach(function(name) {
                    const on = picked.indexOf(name) !== -1;
                    const chip = chainButton(name, 'cs-chip' + (on ? ' is-on' : ''));
                    chip.setAttribute('aria-pressed', String(on));
                    chip.addEventListener('click', function() {
                        const list = chainCsvList(card.cropClasses.value);
                        const at = list.indexOf(name);
                        if (at === -1) list.push(name); else list.splice(at, 1);
                        card.cropClasses.value = list.join(', ');
                        fireFieldChange(card.cropClasses);
                    });
                    card.cropChips.appendChild(chip);
                });
            }
            card.cropChipHelp.textContent = picked.length
                ? 'Only inside boxes of ' + picked.join(', ') + '.'
                : 'Nothing picked means every box ' + step + ' drew.';
            // After movement the boxes are moving areas, and their score is how far each moved,
            // not how sure step 1 is, so "less sure" has nothing to act on there.
            const noun = moving ? 'area' : 'box';
            const nouns = moving ? 'areas' : 'boxes';
            card.cropMargin.sync('Padding around each ' + noun,
                'Adds padding around each ' + noun + ', as a share of its size, so nothing near its edge gets cut off.');
            card.cropSure.el.style.display = moving ? 'none' : '';
            card.cropSure.sync(null, 'Ignores boxes ' + step + ' was less sure about than this.');
            card.cropMaxLabel.textContent = 'Most ' + nouns + ' per check';
            const maxSet = String(card.cropMax.value || '').trim();
            card.cropMaxReset.style.display = maxSet !== '' && maxSet !== card.cropMax.placeholder ? '' : 'none';
            card.cropMaxHelp.textContent = moving
                ? 'Looks inside at most this many areas in each frame or clip, keeping the areas that moved the most.'
                : 'Looks inside at most this many boxes in each frame or clip, keeping the ones ' + step + ' is surest about.'
                    + (entryFollows ? ' Each followed object counts once.' : '')
                    + (card.type === 'vlm' ? ' Each box goes to the AI model as its own picture.' : '');
        }

        function buildGate(card) {
            const prefix = card.prefix;
            const gate = { rows: [], rowSeq: 0, match: undefined, kind: 'rules', open: false };
            gate.el = chainEl('div', 'chain-gate');
            gate.el.id = prefix + 'gate';

            gate.plain = chainEl('div', 'chain-gate-plain');
            gate.slot = chainEl('div', 'chain-gate-slot');
            gate.plainText = chainEl('span');
            const slotText = chainEl('span', null, 'No route — ');
            slotText.appendChild(gate.plainText);
            gate.addRoute = chainButton('Add route');
            gate.addRoute.id = prefix + 'route-add';
            gate.slot.append(slotText, gate.addRoute);
            gate.plain.appendChild(gate.slot);

            gate.strip = chainEl('div', 'gstrip');
            gate.strip.id = prefix + 'gate-strip';
            gate.strip.tabIndex = 0;
            gate.strip.setAttribute('role', 'button');
            gate.summary = chainEl('span', 'gx');
            gate.summary.id = prefix + 'gate-summary';
            gate.toggle = chainEl('span', 'chain-gate-toggle');
            gate.strip.append(chainEl('span', 'gl', 'Route'), gate.summary, gate.toggle);

            gate.errors = chainEl('div', 'chain-stage-errors');
            gate.errors.id = prefix + 'gate-errors';
            gate.warnings = chainEl('div', 'inline-warning chain-warnings');
            gate.warnings.id = prefix + 'gate-warnings';
            gate.warnings.style.display = 'none';

            gate.editor = chainEl('div', 'chain-gate-editor');
            gate.editor.id = prefix + 'gate-editor';
            gate.rules = chainEl('div', 'chain-rules');
            gate.rules.id = prefix + 'rules';
            gate.empty = chainEl('div', 'chain-rules-empty', 'No rules yet, so this condition is never met.');
            gate.empty.id = prefix + 'rules-empty';
            gate.addRule = chainButton('+ Add another rule', 'chain-link-add');
            gate.addRule.id = prefix + 'rule-add';
            gate.removeRoute = chainButton('Remove condition', 'chain-link-remove');
            gate.removeRoute.id = prefix + 'route-remove';
            gate.matchSeg = chainEl('div', 'chain-seg chain-seg-small');
            gate.matchSeg.id = prefix + 'route-match';
            gate.matchSeg.setAttribute('role', 'group');
            gate.matchSeg.setAttribute('aria-label', 'How many rules must match');
            [['any', 'any'], ['all', 'all']].forEach(function(entry) {
                const button = chainButton(entry[1]);
                button.dataset.match = entry[0];
                gate.matchSeg.appendChild(button);
            });
            gate.matchLine = chainEl('div', 'chain-sentence');
            gate.matchLine.append(chainEl('span', null, 'Go on when'), gate.matchSeg, chainEl('span', null, 'of these rules match'));
            gate.onMatch = chainEl('select');
            gate.onMatch.id = prefix + 'route-on-match';
            gate.onNoMatch = chainEl('select');
            gate.onNoMatch.id = prefix + 'route-on-no-match';
            gate.otherwiseLabel = chainEl('span');
            const thenLine = chainEl('div', 'chain-sentence');
            thenLine.append(chainEl('span', null, 'Go to'), gate.onMatch);
            const otherwiseLine = chainEl('div', 'chain-sentence');
            otherwiseLine.append(gate.otherwiseLabel, gate.onNoMatch);
            gate.svdNote = chainEl('div', 'field-help chain-note');
            gate.svdNote.id = prefix + 'gate-svd-note';
            gate.svdNote.textContent = CHAIN_SVD_GATE_NOTE;
            // The panel shows plain controls, like a step's; the inputs under them are what the save reads.
            gate.plainRules = chainEl('div', 'cg-rules');
            gate.targets = chainEl('div', 'cg-targets');
            gate.targets.append(thenLine, otherwiseLine);
            gate.otherwiseLine = otherwiseLine;
            // Whether the chain goes on only when the condition is met, or every time this step runs.
            gate.kindSeg = chainEl('div', 'chain-seg chain-seg-small');
            gate.kindSeg.id = prefix + 'route-kind';
            gate.kindSeg.setAttribute('role', 'group');
            gate.kindSeg.setAttribute('aria-label', 'When the chain goes on');
            [['rules', 'only when it finds'], ['always', 'every time']].forEach(function(entry) {
                const button = chainButton(entry[1]);
                button.dataset.kind = entry[0];
                gate.kindSeg.appendChild(button);
            });
            gate.kindLine = chainEl('div', 'chain-sentence');
            gate.kindLine.append(chainEl('span', null, 'Go on'), gate.kindSeg);
            gate.alwaysNote = chainEl('p', 'cs-help');
            gate.onDone = chainEl('select');
            gate.onDone.id = prefix + 'route-on-done';
            gate.doneLine = chainEl('div', 'chain-sentence cg-targets');
            gate.doneLine.append(chainEl('span', null, 'Go to'), gate.onDone);
            gate.reachNote = chainEl('p', 'cs-help');
            gate.rules.style.display = 'none';
            gate.removeRoute.style.display = 'none';
            gate.editor.append(gate.kindLine, gate.alwaysNote, gate.plainRules, gate.empty, gate.addRule, gate.matchLine,
                gate.targets, gate.doneLine, gate.reachNote, gate.svdNote, gate.rules, gate.removeRoute);

            gate.el.append(gate.plain, gate.strip, gate.errors, gate.warnings, gate.editor);
            card.gate = gate;
        }

        // A slider over one of a rule's number inputs; a blank input reads as `spec.fallback`.
        function conditionRange(input, spec) {
            const wrap = chainEl('div', 'cs-field');
            const head = chainEl('div', 'cs-head');
            const label = chainEl('label', 'cs-label');
            head.appendChild(label);
            const range = chainEl('input', 'cs-range');
            range.type = 'range';
            range.min = String(spec.min);
            range.max = String(spec.max);
            range.step = String(spec.step);
            const help = chainEl('p', 'cs-help');
            wrap.append(head, range, help);
            let name = spec.label;
            let helpLine = '';
            function sync(nextName, helpText) {
                if (nextName) name = nextName;
                if (helpText !== undefined) helpLine = helpText || '';
                help.textContent = helpLine;
                help.style.display = helpLine ? '' : 'none';
                range.setAttribute('aria-label', name);
                const raw = String(input.value || '').trim();
                const value = raw === '' ? spec.fallback : Number(raw);
                range.value = String(value);
                label.textContent = name + ': ' + value + (spec.unit || '');
            }
            range.addEventListener('input', function() {
                input.value = String(range.value);
                fireFieldChange(input);
                sync();
            });
            return { el: wrap, sync: sync };
        }

        // What a step reports that a condition on it can wait for.
        function conditionChoices(stage) {
            const detector = (stage && stage.detector) || {};
            if (detector.type === 'object' || detector.type === 'scene') return (detector.classes || []).slice();
            if (detector.type === 'vlm' && detector.detect) return (detector.detect.classes || []).slice();
            return [];
        }

        function addGateRuleRow(card, rule) {
            const gate = card.gate;
            const id = card.prefix + 'rule-' + (++gate.rowSeq) + '-';
            const row = { base: rule ? JSON.parse(JSON.stringify(rule)) : {} };
            row.el = chainEl('div', 'chain-rule chain-sentence');
            row.classes = chainInput('text', id + 'classes', 'person, car');
            row.classes.setAttribute('aria-label', 'What it finds');
            row.minConfidence = chainInput('number', id + 'min-confidence', '0');
            row.minConfidence.setAttribute('aria-label', 'How sure, in percent');
            row.minCount = chainInput('number', id + 'min-count', '1');
            row.minCount.setAttribute('aria-label', 'How many');
            row.remove = chainButton('Remove', 'chain-link-remove', 'Remove this rule');
            // The words around the inputs: "When it finds at least [1] [person, car] at [50]% sure or more",
            // or for movement "When at least [1] area of the picture moves".
            row.lead = chainEl('span');
            row.objectTail = [chainEl('span', null, 'at'), row.minConfidence, chainEl('span', null, '% sure or more')];
            row.motionTail = chainEl('span', null, 'area of the picture moves');
            row.plain = chainEl('div', 'cg-rule');
            row.plainHead = chainEl('div', 'cg-rule-head');
            row.plainTitle = chainEl('span');
            row.plainRemove = chainButton('Remove', 'chain-link-remove', 'Remove this rule');
            row.plainRemove.addEventListener('click', function() { row.remove.click(); });
            row.plainHead.append(row.plainTitle, row.plainRemove);
            row.chipField = chainEl('div', 'cs-field');
            const chipLabel = chainEl('div', 'cs-head');
            chipLabel.appendChild(chainEl('span', 'cs-label', 'What it must find'));
            row.chipBox = chainEl('div', 'cs-chips');
            row.chipBox.setAttribute('role', 'group');
            row.chipBox.setAttribute('aria-label', 'What it must find');
            row.chipKey = '';
            row.chipHelp = chainEl('p', 'cs-help');
            row.chipField.append(chipLabel, row.chipBox, row.chipHelp);
            row.sure = conditionRange(row.minConfidence, { label: 'How sure the model must be', min: 0, max: 100, step: 5, unit: '%', fallback: 0 });
            row.count = conditionRange(row.minCount, { label: 'How many', min: 1, max: 10, step: 1, fallback: 1 });
            row.plain.append(row.plainHead, row.chipField, row.sure.el, row.count.el);
            gate.plainRules.appendChild(row.plain);
            row.classes.value = chainCsvText(row.base.classes);
            row.minConfidence.value = chainPercentText(row.base.minConfidence);
            row.minCount.value = chainPlainText(row.base.minCount);
            applyNumericRuleToInput(row.minConfidence, CHAIN_GATE_NUMBER_RULES.minConfidence);
            applyNumericRuleToInput(row.minCount, CHAIN_GATE_NUMBER_RULES.minCount);
            row.remove.addEventListener('click', function() {
                gate.rows.splice(gate.rows.indexOf(row), 1);
                row.el.remove();
                row.plain.remove();
                refreshChainFromDom(true);
                markDirty();
            });
            row.el.append(row.lead, row.minCount, row.classes, row.objectTail[0], row.objectTail[1], row.objectTail[2],
                row.motionTail, row.remove);
            lockGateRowForMotion(row, card.type === 'motion');
            gate.rules.appendChild(row.el);
            gate.rows.push(row);
            return row;
        }

        function lockGateRowForMotion(row, motion) {
            row.el.classList.toggle('chain-rule-motion', motion);
            row.classes.style.display = motion ? 'none' : '';
            row.objectTail.forEach(function(part) { part.style.display = motion ? 'none' : ''; });
            row.motionTail.style.display = motion ? '' : 'none';
        }

        function applyGateMotionLock(card) {
            const motion = card.type === 'motion';
            card.gate.rows.forEach(function(row) { lockGateRowForMotion(row, motion); });
        }

        function fillChainTargets(card, select, value, noMatch) {
            select.replaceChildren();
            const add = function(optionValue, label) {
                const option = chainEl('option', null, label);
                option.value = optionValue;
                select.appendChild(option);
            };
            if (!noMatch && value === '') add('', 'Choose a step');
            const offered = chainJumpTargets(card);
            const all = chainState.stages.map(function(stage) { return chainTrimmed(stage.name); });
            offered.forEach(function(name) {
                const index = all.indexOf(name);
                add('s:' + name, VIF.chainPresets.isGivenName(name)
                    ? 'Step ' + (index + 1) + ' (' + VIF.chainBuilder.stepLabel((chainState.stages[index].detector || {}).type) + ')'
                    : chainStepNamed(index, 'Step'));
            });
            if (value.indexOf('s:') === 0 && offered.indexOf(value.slice(2)) === -1) {
                const name = value.slice(2);
                add(value, all.indexOf(name) !== -1 ? name : name + ' (no step has this name)');
            }
            add('end', 'Stop the chain');
            select.value = value;
        }

        // The steps a condition on `card` can send the chain to: any other named step except a
        // movement entry, which a condition can't run again.
        function chainJumpTargets(card) {
            const own = chainIndexOf(card.uid);
            const all = chainState.stages.map(function(stage) { return chainTrimmed(stage.name); });
            const entryIsMotion = chainState.stages.length > 0 && (chainState.stages[0].detector || {}).type === 'motion';
            return all.filter(function(name, index) {
                return index !== own && name !== '' && all.indexOf(name) === index && !(entryIsMotion && index === 0);
            });
        }

        function fillGate(card, stage) {
            const gate = card.gate;
            const routing = stage.routing;
            card.routeOn = !!routing;
            gate.rows.forEach(function(row) { row.el.remove(); row.plain.remove(); });
            gate.rows = [];
            gate.match = routing ? routing.match : undefined;
            gate.kind = routing && routing.onDone ? 'always' : 'rules';
            ((routing && routing.rules) || []).forEach(function(rule) { addGateRuleRow(card, rule); });
            fillChainTargets(card, gate.onMatch, chainTargetValue(routing && routing.onMatch, ''), false);
            fillChainTargets(card, gate.onNoMatch, chainTargetValue(routing && routing.onNoMatch, 'end'), true);
            fillChainTargets(card, gate.onDone, chainTargetValue(routing && routing.onDone, 'end'), true);
            applyGateMotionLock(card);
            if (!routing) gate.open = false;
        }

        function nextStageTarget(card) {
            const next = chainState.stages[chainIndexOf(card.uid) + 1];
            const nextName = next ? chainTrimmed(next.name) : '';
            return nextName ? { stage: nextName } : { end: true };
        }

        function setGateOpen(card, open) {
            card.gate.open = open;
            refreshChainView(false);
        }

        function bindGate(card) {
            const gate = card.gate;
            gate.strip.addEventListener('click', function() { setGateOpen(card, !gate.open); });
            gate.strip.addEventListener('keydown', function(event) {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                setGateOpen(card, !gate.open);
            });
            gate.slot.addEventListener('click', function(event) {
                if (event.target !== gate.addRoute) gate.addRoute.click();
            });
            gate.addRoute.addEventListener('click', function() {
                const stage = chainState.stages[chainIndexOf(card.uid)];
                const freeForm = VIF.chainEditor.isFreeFormVlm(stage.detector);
                fillGate(card, { routing: freeForm ? { onDone: { end: true } } : { rules: [{}], onMatch: nextStageTarget(card) } });
                gate.open = true;
                refreshChainFromDom(true);
                markDirty();
                if (freeForm) gate.onDone.focus();
                else gate.rows[0].classes.focus();
            });
            gate.removeRoute.addEventListener('click', function() {
                fillGate(card, {});
                refreshChainFromDom(true);
                markDirty();
            });
            gate.addRule.addEventListener('click', function() {
                const row = addGateRuleRow(card);
                refreshChainFromDom(true);
                markDirty();
                // The new rule opens where the link was; bring it into view, ready to pick from.
                row.plain.scrollIntoView({ block: 'nearest' });
                const firstChip = row.chipBox.querySelector('button');
                if (firstChip) firstChip.focus({ preventScroll: true });
            });
            gate.matchSeg.addEventListener('click', function(event) {
                const button = event.target.closest('button');
                if (!button || gate.match === button.dataset.match) return;
                gate.match = button.dataset.match;
                refreshChainFromDom(true);
                markDirty();
            });
            gate.kindSeg.addEventListener('click', function(event) {
                const button = event.target.closest('button');
                if (!button || gate.kind === button.dataset.kind) return;
                gate.kind = button.dataset.kind;
                // The Go to carries over, so switching only changes when the chain takes it.
                if (gate.kind === 'always') {
                    fillChainTargets(card, gate.onDone, gate.onMatch.value || 'end', true);
                } else {
                    fillChainTargets(card, gate.onMatch, gate.onDone.value, false);
                    if (!gate.rows.length) {
                        const stage = chainState.stages[chainIndexOf(card.uid)];
                        addGateRuleRow(card, (VIF.chainPresets.conditionFor(stage, undefined).rules || [{}])[0]);
                    }
                }
                refreshChainFromDom(true);
                markDirty();
            });
        }

        function chainRuleSummary(rule) {
            rule = rule || {};
            let text = rule.classes && rule.classes.length ? rule.classes.join(', ') : 'no classes';
            if (isPresent(rule.minConfidence)) text += ' at ' + chainPercentText(rule.minConfidence) + '%+';
            if (isPresent(rule.minCount)) text += ' · count ' + rule.minCount + '+';
            return text;
        }

        function chainTargetLabel(target) {
            const value = chainTargetValue(target, '');
            if (value === 'end') return 'end of window';
            return value ? value.slice(2) : 'no target';
        }

        function chainGateSummary(routing) {
            if (routing.onDone) return 'always → ' + chainTargetLabel(routing.onDone);
            const rules = routing.rules || [];
            const noMatch = routing.onNoMatch ? chainTargetLabel(routing.onNoMatch) : 'end of window';
            if (!rules.length) return 'no rules · always → ' + noMatch;
            let condition = rules.map(chainRuleSummary).join('; ');
            if (rules.length > 1) condition = (routing.match === 'all' ? 'all of: ' : 'any of: ') + condition;
            return condition + ' → ' + chainTargetLabel(routing.onMatch) + ' · else → ' + noMatch;
        }

        function routingAsSaved(card, routing) {
            if (card.type !== 'motion' || routing.onDone) return routing;
            return Object.assign({}, routing, { rules: (routing.rules || []).map(VIF.chainEditor.lockedMotionRule) });
        }

        function refreshGate(card, stage, index, routeErrors, showStageErrors) {
            const gate = card.gate;
            const last = index === chainState.stages.length - 1;
            gate.plain.style.display = card.routeOn ? 'none' : '';
            gate.plainText.textContent = last ? 'falls through to the end of the window' : 'falls through to the next stage';
            gate.strip.style.display = card.routeOn ? '' : 'none';
            gate.summary.textContent = stage.routing ? chainGateSummary(routingAsSaved(card, stage.routing)) : '';
            gate.toggle.textContent = gate.open ? 'Close' : 'Edit';
            gate.strip.setAttribute('aria-expanded', String(card.routeOn && gate.open));
            gate.el.classList.toggle('is-open', card.routeOn && gate.open);
            // A step that answers in words has nothing to match, so its condition can only go one way.
            if (VIF.chainEditor.isFreeFormVlm(stage.detector)) gate.kind = 'always';
            const motion = card.type === 'motion';
            const match = gate.match || 'any';
            gate.empty.style.display = gate.rows.length ? 'none' : '';
            gate.rows.forEach(function(row, at) {
                row.lead.textContent = motion ? 'When at least'
                    : at === 0 ? 'When it finds at least' : (match === 'all' ? 'and it finds at least' : 'or it finds at least');
                row.remove.style.display = gate.rows.length > 1 ? '' : 'none';
            });
            gate.addRule.style.display = motion ? 'none' : '';
            gate.matchLine.style.display = !motion && gate.rows.length > 1 ? '' : 'none';
            gate.otherwiseLabel.textContent = motion ? 'If nothing moves, go to'
                : card.type === 'synthetic' ? 'If the clip doesn’t look AI-generated, go to'
                : 'If it finds none of these, go to';
            refreshGatePlain(card, stage, index);
            gate.svdNote.style.display = card.type === 'synthetic' && gate.kind !== 'always' ? '' : 'none';
            Array.from(gate.matchSeg.children).forEach(function(button) {
                const active = button.dataset.match === match;
                button.classList.toggle('is-active', active);
                button.setAttribute('aria-pressed', String(active));
            });
            fillChainTargets(card, gate.onMatch, gate.onMatch.value, false);
            fillChainTargets(card, gate.onNoMatch, gate.onNoMatch.value, true);
            fillChainTargets(card, gate.onDone, gate.onDone.value, true);
            if (!showStageErrors) return;
            gate.errors.textContent = routeErrors.map(chainErrorText).join('\n');
            gate.el.classList.toggle('has-error', routeErrors.length > 0);
        }

        // The plain controls follow the inputs they sit on.
        function refreshGatePlain(card, stage, index) {
            const gate = card.gate;
            const type = card.type;
            const motion = type === 'motion';
            const synthetic = type === 'synthetic';
            const several = gate.rows.length > 1;
            const choices = conditionChoices(stage);
            const target = gate.onMatch.value.indexOf('s:') === 0
                ? chainState.stages.findIndex(function(each) { return chainTrimmed(each.name) === gate.onMatch.value.slice(2); }) : -1;
            const matchAll = (gate.match || 'any') === 'all';
            gate.rows.forEach(function(row, at) {
                row.plainHead.style.display = several ? '' : 'none';
                row.plainTitle.textContent = 'Rule ' + (at + 1);
                row.chipField.style.display = motion || synthetic ? 'none' : '';
                const picked = chainCsvList(row.classes.value);
                const shown = choices.concat(picked.filter(function(name) { return choices.indexOf(name) === -1; }));
                const key = shown.join('|') + '#' + picked.join('|');
                if (key !== row.chipKey) {
                    row.chipKey = key;
                    row.chipBox.replaceChildren();
                    shown.forEach(function(name) {
                        const on = picked.indexOf(name) !== -1;
                        const chip = chainButton(name, 'cs-chip' + (on ? ' is-on' : ''));
                        chip.setAttribute('aria-pressed', String(on));
                        chip.addEventListener('click', function() {
                            const list = chainCsvList(row.classes.value);
                            const at2 = list.indexOf(name);
                            if (at2 === -1) list.push(name); else list.splice(at2, 1);
                            row.classes.value = list.join(', ');
                            fireFieldChange(row.classes);
                        });
                        row.chipBox.appendChild(chip);
                    });
                }
                // A rule with nothing picked is never met; say what that does to the chain.
                const empty = !motion && !synthetic && shown.length > 0 && picked.length === 0;
                const blocks = !several || matchAll;
                row.chipHelp.classList.toggle('cs-note', empty);
                row.chipHelp.textContent = empty
                    ? 'Pick what this rule must find. Until you do, it’s never met'
                        + (!blocks ? ', but the other rules still can be.'
                            : target !== -1 ? ', so ' + chainStepNamed(target, 'step') + ' never runs.' : ', so the condition is never met.')
                    : shown.length ? 'Picked from what ' + chainStepNamed(index, 'step') + ' looks for.'
                    : chainStepNamed(index, 'Step') + ' has nothing to look for yet. Add it on the step first.';
                row.sure.el.style.display = motion || type === 'vlm' ? 'none' : '';
                row.sure.sync(null, type === 'scene'
                    ? 'Each scene is checked on its own. Scenes the model is less sure about don’t count.'
                    : 'Each object is checked on its own. Objects the model is less sure about don’t count.');
                // Movement noise is tuned on the step itself; a movement count shows only when a saved one is set.
                const savedCount = String(row.minCount.value || '').trim();
                const countShown = !synthetic && (!motion || (savedCount !== '' && savedCount !== '1'));
                row.count.el.style.display = countShown ? '' : 'none';
                // The example holds for any two or more picks, including a model of yours.
                const mix = '. In any combination: 3 of the same kind, or 2 of one kind and 1 of another, both count as 3.';
                const runs = target !== -1 ? chainStepNamed(target, 'Step') + ' runs' : 'The condition is met';
                // A scene or a checked thing is reported at most once a frame, so its count is how many of the picks show up.
                const once = type === 'scene' ? 'scenes' : type === 'vlm' ? 'things' : '';
                const counted = once
                    ? runs + ' only when at least this many of these ' + once + ' show up in the same frame.'
                    : runs + ' only when at least this many objects are in the same frame'
                        + (picked.length > 1 ? mix + ' To need one of each, give each its own rule and go on when all of them match.' : '.');
                row.count.sync(motion ? 'Separate areas that must move at once' : 'How many at once', motion ? '' : counted);
            });
            const always = gate.kind === 'always';
            const freeForm = VIF.chainEditor.isFreeFormVlm(stage.detector);
            gate.kindLine.style.display = freeForm ? 'none' : '';
            Array.from(gate.kindSeg.children).forEach(function(button) {
                const active = button.dataset.kind === gate.kind;
                button.classList.toggle('is-active', active);
                button.setAttribute('aria-pressed', String(active));
                if (button.dataset.kind === 'rules') {
                    button.textContent = motion ? 'only when something moves'
                        : synthetic ? 'only when the clip looks AI-generated' : 'only when it finds';
                }
            });
            gate.alwaysNote.style.display = freeForm ? '' : 'none';
            gate.alwaysNote.textContent = chainStepNamed(index, 'Step') + ' answers in words, so there’s nothing to match. The chain goes on from here every time.';
            gate.plainRules.style.display = always ? 'none' : '';
            gate.empty.style.display = always || gate.rows.length ? 'none' : '';
            gate.addRule.style.display = always || motion || synthetic ? 'none' : '';
            gate.matchLine.style.display = !always && !motion && gate.rows.length > 1 ? '' : 'none';
            gate.doneLine.style.display = always ? '' : 'none';
            // One menu says where the chain goes when the condition is met, the other where it goes
            // when it isn't; that one starts on Stop the chain.
            gate.targets.style.display = always ? 'none' : '';
            // The step under this condition is its natural target; say so when nothing reaches it.
            const orphan = VIF.chainBuilder.unreachable(chainState.stages).indexOf(index + 1) !== -1;
            gate.reachNote.style.display = orphan ? '' : 'none';
            gate.reachNote.textContent = orphan
                ? chainStepNamed(index + 1, 'Step') + ' never runs: nothing leads to it. Pick it under Go to, or remove it.' : '';
        }

        function fillCrop(card, stage) {
            const crop = stage.crop || {};
            card.cropOn = !!stage.crop;
            card.cropClasses.value = (crop.classes || []).join(', ');
            card.cropMinConfidence.value = chainPercentText(crop.minConfidence);
            card.cropPadding.value = chainPercentText(crop.padding);
            card.cropMax.value = crop.maxCrops !== undefined && crop.maxCrops !== null ? crop.maxCrops : '';
        }

        function fillStageExtras(card, stage) {
            const selection = stage.frameSelection || {};
            card.frameMode.value = selection.mode || 'all';
            card.strideInput.value = selection.stride !== undefined && selection.stride !== null ? selection.stride : '';
            fillCrop(card, stage);

            card.frameBox.open = !!selection.mode && selection.mode !== 'all';
        }

        function loadChainCardSections(card, stage) {
            const wasSuppressed = suppressDirtyTracking;
            suppressDirtyTracking = true;
            resetSections(card.root);
            populateSections(card.root, stageFlat(stage.detector));
            toggleSections(card.root, card.type);
            refreshEffectiveDefaultPlaceholders(card.root);
            if (card.type === 'object') keepStageClasses(card, stage.detector.classes);
            fillStageExtras(card, stage);
            suppressDirtyTracking = wasSuppressed;
        }

        function setChainCardExpanded(card, expanded) {
            card.body.classList.toggle('expanded', expanded);
            card.chevron.textContent = expanded ? '▼' : '▶';
            if (expanded && window.vlmAutoGrowAll) window.vlmAutoGrowAll();
        }

        function createChainCard(stage, stored, expanded) {
            const prefix = 'cfg-s' + stage.uid + '-';
            const card = { uid: stage.uid, prefix: prefix, type: stage.detector.type, touched: {}, stored: null, cropOn: false };

            const item = chainEl('div', 'array-item chain-stage');
            item.id = prefix + 'stage';
            const header = chainEl('div', 'array-item-header chain-stage-header');
            card.chevron = chainEl('span', 'array-item-chevron');
            card.badge = chainEl('span', 'dbadge');
            card.nameLabel = chainEl('span', 'chain-stage-name');
            card.typeTag = chainEl('span', 'chain-stage-type');
            card.summary = chainEl('span', 'chain-stage-summary');
            const grip = chainEl('span', 'chain-grip');
            grip.title = 'Drag to reorder';
            const actions = chainEl('div', 'array-item-actions');
            card.upBtn = chainButton('Up', null, 'Move this stage up');
            card.downBtn = chainButton('Down', null, 'Move this stage down');
            card.removeBtn = chainButton('Remove', 'btn-danger', 'Remove this stage');
            actions.append(card.upBtn, card.downBtn, card.removeBtn);
            header.append(card.chevron, card.badge, card.nameLabel, card.typeTag, card.summary, grip, actions);

            const body = chainEl('div', 'array-item-body chain-stage-body');
            card.errors = chainEl('div', 'chain-stage-errors');
            card.errors.id = prefix + 'stage-errors';
            card.nameInput = chainInput('text', prefix + 'stage-name', 'e.g. find-people');
            card.nameInput.value = stage.name || '';
            card.nameNote = chainEl('div', 'field-help chain-note');
            card.nameNote.id = prefix + 'stage-name-note';
            const nameGroup = chainFormGroup('Step name', card.nameInput, CHAIN_TIPS.stageName);
            card.nameGroup = nameGroup;
            nameGroup.appendChild(card.nameNote);
            card.root = chainEl('div', 'chain-stage-form');
            card.root.appendChild(VIF.detectorSections.instantiate(prefix, card.root));
            buildFrameSelection(card);
            buildCrop(card);
            buildGate(card);
            card.committedName = chainTrimmed(stage.name);
            // The step's name and the plain controls sit on top; the extra controls wait under
            // More settings, and whatever the plain controls don't cover under All settings.
            card.controlsSlot = chainEl('div', 'cs-slot');
            card.moreSlot = chainEl('div', 'cs-more-slot');
            const more = chainEl('details', 'chain-disclosure cs-more-box');
            more.appendChild(chainSummary('More settings'));
            const moreBody = chainEl('div', 'chain-disclosure-body');
            // What the plain controls leave: for the steps that reach an outside service, that's
            // the server, key and the model's fine-tuning, all of it under one Advanced, which an
            // AI model step opens with its choice of model.
            const all = chainEl('details', 'chain-disclosure cs-all-box');
            card.allBox = all;
            const reachesOut = card.type === 'vlm' || card.type === 'synthetic';
            if (reachesOut) all.classList.add('cs-advanced-box');
            all.appendChild(chainSummary(reachesOut ? 'Advanced' : 'All settings'));
            const allBody = chainEl('div', 'chain-disclosure-body');
            card.advancedSlot = chainEl('div', 'cs-advanced-slot');
            allBody.appendChild(card.advancedSlot);
            if (reachesOut) allBody.appendChild(chainEl('p', 'cs-help', 'Left blank, these come from Stream Config Defaults.'));
            allBody.appendChild(card.root);
            all.appendChild(allBody);
            moreBody.appendChild(card.moreSlot);
            more.appendChild(moreBody);
            card.moreBody = moreBody;
            card.moreBox = more;
            body.append(card.errors, nameGroup, card.controlsSlot, card.frameBox, card.cropBox, more, all);
            rebuildStepControls(card);
            item.append(header, body);
            card.el = item;
            card.header = header;
            card.body = body;

            const tracking = field(card.root, 'cfg-tracking-method');
            card.trackingNote = chainEl('div', 'field-help chain-note');
            tracking.parentElement.appendChild(card.trackingNote);
            field(card.root, 'tiling-enable-group').style.display = tilingUiEnabled ? '' : 'none';
            populateCheckpointPaths(card.root);
            initializeStaticFieldRules(card.root);
            Object.keys(CHAIN_NUMBER_RULES).forEach(function(id) {
                applyNumericRuleToInput(card.el.querySelector('#' + CSS.escape(prefix + id)), CHAIN_NUMBER_RULES[id]);
            });
            watchSecretInputs(card.root, function() { return card.touched; });
            syncSectionApiKeyToggle(card.root, 'cfg-vlm-api-key', 'cfg-vlm-api-key-toggle');
            syncSectionApiKeyToggle(card.root, 'cfg-synthetic-api-key', 'cfg-synthetic-api-key-toggle');

            bindChainCard(card);
            bindGate(card);
            loadChainCardSections(card, stage);
            fillGate(card, stage);
            if (stored) rememberStoredStage(card, stage);
            setChainCardExpanded(card, expanded);
            chainCards[card.uid] = card;
            return card;
        }

        function bindChainCard(card) {
            card.header.addEventListener('click', function(event) {
                if (card.suppressClick || event.target.closest('.array-item-actions')) return;
                setChainCardExpanded(card, !card.body.classList.contains('expanded'));
            });
            card.upBtn.addEventListener('click', function() { moveChainStage(card, -1); });
            card.downBtn.addEventListener('click', function() { moveChainStage(card, 1); });
            card.removeBtn.addEventListener('click', function() {
                const index = chainIndexOf(card.uid);
                applyChainTransition(function(state) { return removeChainStage(state, index); });
            });
            card.nameInput.addEventListener('input', function() { card.nameTyping = true; });
            card.nameInput.addEventListener('change', function() { card.nameTyping = false; renameChainStage(card); });
            card.cropSwitch.addEventListener('change', function(event) {
                event.stopPropagation();
                card.cropOn = card.cropSwitch.checked;
                if (card.cropOn && card.type === 'object') {
                    const tracking = field(card.root, 'cfg-tracking-method');
                    const tiling = field(card.root, 'cfg-tiling-enabled');
                    if (tracking.value !== 'none') { tracking.value = 'none'; toggleByteTrack(card.root); }
                    if (tiling.checked) { tiling.checked = false; toggleTiling(card.root); }
                }
                if (!card.cropOn) {
                    [card.cropClasses, card.cropMinConfidence, card.cropPadding, card.cropMax].forEach(function(input) { input.value = ''; });
                } else {
                    card.cropJustOn = true;
                }
                refreshChainFromDom(true);
                markDirty();
            });
            card.cropSwitch.addEventListener('input', function(event) { event.stopPropagation(); });
            card.header.addEventListener('pointerdown', function(event) {
                if (event.button !== 0 || event.target.closest('button, input, select, textarea, a')) return;
                chainDrag = { card: card, startY: event.clientY, active: false, to: null };
                try { card.header.setPointerCapture(event.pointerId); } catch (error) { /* capture is a nicety */ }
            });
            card.header.addEventListener('pointermove', function(event) {
                if (!chainDrag || chainDrag.card !== card) return;
                if (!chainDrag.active) {
                    if (Math.abs(event.clientY - chainDrag.startY) < 6) return;
                    chainDrag.active = true;
                    card.el.classList.add('is-dragging');
                }
                chainDrag.to = chainDropIndex(card, event.clientY);
                markChainDrop(card, chainDrag.to);
            });
            card.header.addEventListener('pointerup', function() { finishChainDrag(card, true); });
            card.header.addEventListener('pointercancel', function() { finishChainDrag(card, false); });
        }

        function chainOtherCards(card) {
            return chainState.stages.filter(function(stage) { return stage.uid !== card.uid; })
                .map(function(stage) { return chainCards[stage.uid]; });
        }

        function chainDropIndex(card, clientY) {
            let index = 0;
            chainOtherCards(card).forEach(function(other) {
                const rect = other.el.getBoundingClientRect();
                if (clientY > rect.top + rect.height / 2) index++;
            });
            return index;
        }

        function markChainDrop(card, to) {
            const others = chainOtherCards(card);
            others.forEach(function(other) { other.el.classList.remove('drop-before', 'drop-after'); });
            if (to < others.length) others[to].el.classList.add('drop-before');
            else if (others.length) others[others.length - 1].el.classList.add('drop-after');
        }

        function finishChainDrag(card, commit) {
            if (!chainDrag || chainDrag.card !== card) return;
            const drag = chainDrag;
            chainDrag = null;
            card.el.classList.remove('is-dragging');
            chainOtherCards(card).forEach(function(other) { other.el.classList.remove('drop-before', 'drop-after'); });
            if (!drag.active) return;
            card.suppressClick = true;
            setTimeout(function() { card.suppressClick = false; }, 0);
            const from = chainIndexOf(card.uid);
            if (commit && drag.to !== null && drag.to !== from) {
                applyChainTransition(function(state) { return VIF.chainPresets.moveStageRewiringNextSteps(state, from, drag.to - from); });
            }
        }

        function moveChainStage(card, delta) {
            const index = chainIndexOf(card.uid);
            applyChainTransition(function(state) { return VIF.chainPresets.moveStageRewiringNextSteps(state, index, delta); });
        }

        function fireFieldChange(element) {
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
        }

        // The condition after a step keeps waiting for what the step looks for as its picks change.
        function followStepPicks(card, before, after) {
            if (!card.gate) return;
            card.gate.rows.forEach(function(row) {
                const waitsFor = chainCsvList(row.classes.value);
                const next = VIF.chainPresets.conditionAfterPicks(waitsFor, before, after);
                if (next.join('|') === waitsFor.join('|')) return;
                row.classes.value = next.join(', ');
                fireFieldChange(row.classes);
            });
        }

        // How the plain controls reach a step's settings form.
        // `covered` collects the ids of the form fields the plain controls write to.
        function chainStepAdapter(card, covered) {
            const root = card.root;
            const cover = function(id) { if (covered) covered[id] = true; return id; };
            const rows = function(containerId, withHint) {
                cover(containerId);
                return {
                    get: function() { return collectClassRows(root, containerId, { withHint: withHint }).classNames; },
                    set: function(names) {
                        const before = collectClassRows(root, containerId, { withHint: withHint }).classNames;
                        const hints = withHint ? collectClassRows(root, containerId, { withHint: true }).classHints : null;
                        const container = field(root, containerId);
                        container.innerHTML = '';
                        populateClassRows(root, containerId, names, hints, { withHint: withHint });
                        fireFieldChange(container);
                        followStepPicks(card, before, names);
                    }
                };
            };
            return {
                type: card.type,
                field: function(id) { return field(root, cover(id)); },
                fire: fireFieldChange,
                openGuide: function() { withPromptGuide(root, function(guide) { guide.open(); }); },
                // The form groups holding these fields, lifted into `into` with their events still
                // handled by the step's form.
                liftFormGroups: function(ids, into) {
                    root.vifLiftedInto = into;
                    if (!into.dataset.liftedFrom) {
                        into.dataset.liftedFrom = root.dataset.vifPrefix || '';
                        SECTION_EVENT_TYPES.forEach(function(type) {
                            into.addEventListener(type, function(event) { dispatchSectionEventIn(root, event); }, true);
                        });
                    }
                    ids.forEach(function(id) {
                        const target = field(root, id);
                        const group = target && target.closest('.form-group');
                        if (group && group.parentNode !== into) into.appendChild(group);
                    });
                },
                classes: {
                    get: function() { return Array.from(field(root, 'cfg-class-names').selectedOptions).map(function(o) { return o.value; }); },
                    set: function(names) {
                        const select = field(root, 'cfg-class-names');
                        const before = Array.from(select.selectedOptions).map(function(o) { return o.value; });
                        Array.from(select.options).forEach(function(option) { option.selected = false; });
                        keepStageClasses(card, names);
                        fireFieldChange(select);
                        followStepPicks(card, before, names);
                    }
                },
                objectModel: chainObjectModel(card, cover),
                framesPerSecond: chainFramesPerSecond,
                sceneClasses: rows('cfg-scene-class-names', false),
                things: rows('cfg-vlm-detect-classes', true),
                vlmMode: {
                    get: function() { cover('cfg-vlm-mode'); return getVlmMode(root); },
                    set: function(mode) {
                        const radio = field(root, 'cfg-vlm-mode').querySelector('input[value="' + mode + '"]');
                        if (!radio || radio.checked) return;
                        radio.checked = true;
                        radio.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }
            };
        }

        // Which model a Find objects step uses, over the form's model and checkpoint fields:
        // 'common' for the built-in sizes, or the checkpoint path of a model of yours.
        function chainObjectModel(card, cover) {
            const root = card.root;
            const common = VIF.chainSteps.COMMON_MODEL;
            const modelField = function() { return field(root, cover('cfg-model-name')); };
            const pathField = function() { return field(root, cover('cfg-checkpoint-path')); };
            const picked = function() { return Array.from(field(root, 'cfg-class-names').selectedOptions).map(function(o) { return o.value; }); };
            function get() {
                return modelField().value === 'custom' ? pathField().value : common;
            }
            function classes() {
                if (get() === common) return COCO_CLASSES;
                const known = getModelClasses(root);
                return known.length ? known : null;
            }
            return {
                get: get,
                classes: classes,
                yours: function() {
                    const models = (defaultConfig && defaultConfig.available_models && defaultConfig.available_models.models) || [];
                    const paths = models.filter(function(m) { return m.is_custom && m.type !== 'scene' && m.checkpoint_path; })
                        .map(function(m) { return m.checkpoint_path; });
                    const current = get();
                    if (current !== common && current && paths.indexOf(current) === -1) paths.push(current);
                    return paths.map(function(path) { return { value: path, label: VIF.chainPresets.modelLabel(path) }; });
                },
                set: function(value) {
                    const before = picked();
                    const model = modelField();
                    if (value === common) {
                        model.value = card.commonSize || 'medium';
                    } else {
                        if (model.value !== 'custom') card.commonSize = model.value;
                        const path = pathField();
                        if (!Array.from(path.options).some(function(option) { return option.value === value; })) {
                            const option = chainEl('option', null, value);
                            option.value = value;
                            path.appendChild(option);
                        }
                        path.value = value;
                        model.value = 'custom';
                    }
                    // The model's change rebuilds the class list, keeping only the picks it still has.
                    fireFieldChange(model);
                    const known = classes();
                    const kept = known ? before.filter(function(name) { return known.indexOf(name) !== -1; }) : before;
                    keepStageClasses(card, kept);
                    fireFieldChange(field(root, 'cfg-class-names'));
                    const dropped = before.filter(function(name) { return kept.indexOf(name) === -1; });
                    // A condition on this step keeps waiting only for what the step now looks for.
                    // One left waiting for nothing would never be met, so it waits for all of that.
                    if (card.gate && known) {
                        const target = kept.length ? kept : known;
                        card.gate.rows.forEach(function(row) {
                            const ruleClasses = chainCsvList(row.classes.value);
                            const still = ruleClasses.filter(function(name) { return target.indexOf(name) !== -1; });
                            if (still.length && still.length === ruleClasses.length) return;
                            row.classes.value = (still.length ? still : target).join(', ');
                            fireFieldChange(row.classes);
                        });
                    }
                    return dropped;
                }
            };
        }

        // The chain's capture rate in frames per second, or null when it doesn't capture at a set rate.
        function chainFramesPerSecond() {
            if (!document.getElementById('cfg-use-transcoder').checked) return null;
            const fpsInput = document.getElementById('cfg-inference-fps');
            const fps = parseFloat((fpsInput.value || '').trim() || fpsInput.placeholder || '');
            return Number.isFinite(fps) && fps > 0 ? fps : null;
        }

        function rebuildStepControls(card) {
            const object = card.type === 'object';
            // Following objects is set under its switch; its form fields count as covered even
            // while the switch is off and its controls don't read them.
            const covered = { 'cfg-class-names': object, 'cfg-ignore-untracked-objects': object, 'cfg-bt-min-confidence': object,
                'cfg-bt-max-lost-frames': object, 'cfg-bt-min-overlap': object, 'cfg-bt-min-frames': object };
            card.controls = VIF.chainSteps.createStepControls(chainStepAdapter(card, covered));
            card.controlsSlot.replaceChildren(card.controls.main);
            card.moreSlot.replaceChildren(card.controls.more);
            card.advancedSlot.replaceChildren(card.controls.advanced);
            // A control reads its field when it syncs, which is how `covered` learns every field.
            card.controls.sync({ trackingWhy: '' });
            card.covered = covered;
            hideCoveredSettings(card, covered);
        }

        // All settings leaves out what the plain controls above already set, and goes away
        // when nothing is left.
        function hideCoveredSettings(card, covered) {
            card.root.querySelectorAll('.cs-covered').forEach(function(group) { group.classList.remove('cs-covered'); });
            Object.keys(covered).forEach(function(id) {
                if (!covered[id]) return;
                const target = field(card.root, id);
                const group = target && target.closest('.form-group');
                if (group && card.root.contains(group)) group.classList.add('cs-covered');
            });
            // The AI model's task cards already say what Describe does; the form's note repeats it.
            const describeNote = field(card.root, 'vlm-mode-describe');
            if (describeNote) describeNote.classList.add('cs-covered');
            // A section left with nothing to show goes too, heading and all.
            card.root.querySelectorAll('.form-section, .byte-track-fields').forEach(function(section) {
                const groups = Array.from(section.querySelectorAll('.form-group'));
                const hidden = function(group) {
                    for (let node = group; node && node !== section; node = node.parentElement) {
                        if (node.style.display === 'none') return true;
                    }
                    return false;
                };
                const empty = groups.length > 0 && groups.every(function(group) {
                    return group.classList.contains('cs-covered') || hidden(group);
                });
                if (empty) section.classList.add('cs-covered');
            });
        }

        function chainAllSettingsLeft(card) {
            if (card.advancedSlot.querySelector('.cs-field')) return true;
            return Array.from(card.root.querySelectorAll('input, select, textarea')).some(function(input) {
                if (input.type === 'hidden' || input.closest('.cs-covered')) return false;
                const section = input.closest('.form-section');
                return !section || section.style.display !== 'none';
            });
        }

        // Takes out step `index`; conditions that pointed at it follow on, or go when nothing follows.
        function removeChainStage(state, index) {
            const removed = state.stages[index] ? chainTrimmed(state.stages[index].name) : '';
            const following = state.stages[index + 1] ? chainTrimmed(state.stages[index + 1].name) : '';
            return VIF.chainPresets.repairAfterRemoval(VIF.chainEditor.removeStage(state, index), removed, following);
        }

        // A new step arrives with the conditions the guided setup would give it: the step before it
        // waits for what it finds, and a step that reports something gates the one after it.
        // Movement only ever runs first: it always lands at the top, and nothing lands above it.
        function insertChainStage(type, at) {
            const startsWithMotion = chainState.stages.length > 0 && (chainState.stages[0].detector || {}).type === 'motion';
            const index = type === 'motion' ? 0 : (startsWithMotion ? Math.max(at, 1) : at);
            applyChainTransition(function(state) {
                const stage = VIF.chainPresets.newStage(type);
                // A new Find objects step starts on everything the common objects model finds.
                if (type === 'object') stage.detector.classes = COCO_CLASSES.slice();
                const added = VIF.chainEditor.addStage(state, type, index);
                stage.name = uniqueChainStageName(added, stage.name);
                added.stages[index] = stage;
                if (VIF.chainEditor.chainMode(added) === 'dynamic') return added;
                return VIF.chainPresets.wireInsertedStage(added, index);
            });
            selectChainItem({ kind: 'stage', uid: chainState.stages[index].uid });
        }

        function uniqueChainStageName(state, base) {
            const taken = state.stages.map(function(stage) { return chainTrimmed(stage.name); });
            if (taken.indexOf(base) === -1) return base;
            let n = 2;
            while (taken.indexOf(base + '-' + n) !== -1) n++;
            return base + '-' + n;
        }

        function dropChainStage(from, at) {
            const to = VIF.chainBuilder.moveTarget(from, at);
            if (from === to) return;
            applyChainTransition(function(state) { return VIF.chainPresets.moveStageRewiringNextSteps(state, from, to - from); });
        }

        function addChainCondition(index) {
            const uid = chainState.stages[index].uid;
            if (VIF.chainEditor.chainMode(chainState) === 'linear') {
                applyChainTransition(function(state) { return VIF.chainEditor.switchMode(state, 'conditional'); });
            }
            const card = chainCards[uid];
            fillGate(card, { routing: VIF.chainPresets.conditionFor(chainState.stages[index], chainState.stages[index + 1]) });
            refreshChainFromDom(true);
            markDirty();
            selectChainItem({ kind: 'gate', uid: uid });
            const first = card.gate.rows[0];
            if (first) (card.type === 'motion' ? first.minCount : first.classes).focus();
            else card.gate.onDone.focus();
        }

        // Everything a Find objects step's model finds, or null for another step or a model of
        // yours that doesn't list what it finds.
        function chainStepKnownClasses(stage) {
            const detector = (stage || {}).detector || {};
            if (detector.type !== 'object') return null;
            if (!detector.checkpointPath) return COCO_CLASSES;
            const card = chainCards[stage.uid];
            const known = card ? getModelClasses(card.root) : [];
            return known.length ? known : null;
        }

        // A guided chain with its Find objects steps on everything the common objects model
        // finds, and each condition after one waiting for all of it.
        function withEveryObjectPicked(preset) {
            const next = JSON.parse(JSON.stringify(preset));
            (next.stages || []).forEach(function(stage) {
                const detector = stage.detector || {};
                if (detector.type !== 'object' || detector.checkpointPath || (detector.classes || []).length) return;
                detector.classes = COCO_CLASSES.slice();
                ((stage.routing || {}).rules || []).forEach(function(rule) {
                    if (!(rule.classes || []).length) rule.classes = COCO_CLASSES.slice();
                });
            });
            return next;
        }

        function applyChainPreset(preset) {
            clearChain();
            chainState = assignStageUids(VIF.chainEditor.initChain(withEveryObjectPicked(preset)));
            chainShowGetStarted = false;
            fillChainLevel();
            renderChain();
            // Opens on the first step still waiting for its picks, since that's the next thing to do.
            const missing = VIF.chainEditor.missingPicks(chainState);
            const waiting = chainState.stages.findIndex(function(stage, index) {
                return missing.some(function(error) { return error.indexOf('stages[' + index + ']') === 0; });
            });
            const first = waiting !== -1 ? waiting : 0;
            selectChainItem(chainState.stages.length ? { kind: 'stage', uid: chainState.stages[first].uid } : { kind: 'chain' });
            markDirty();
        }

        function refillChainFromState() {
            chainState.stages.forEach(function(stage) {
                const card = chainCards[stage.uid];
                if (!card) return;
                fillGate(card, stage);
                // A step moved to the front loses its zoom in the state; its card follows.
                if (card.cropOn && !stage.crop) fillCrop(card, stage);
                // So does a step whose chain can no longer follow objects.
                const tracking = card.type === 'object' ? field(card.root, 'cfg-tracking-method') : null;
                const method = stage.detector.tracking && stage.detector.tracking.method;
                if (tracking && tracking.value === 'byte-track' && method !== 'byte-track') {
                    tracking.value = 'none';
                    toggleByteTrack(card.root);
                }
            });
            fillChainLevel();
        }

        function applyChainTransition(transition) {
            syncChainFromCards();
            chainState = assignStageUids(VIF.chainPresets.withoutLastStepCondition(chainState, VIF.chainPresets.withoutBlockedFollowing(
                VIF.chainPresets.withoutBoxlessZoom(VIF.chainEditor.withFreeFormRoutesAsOnDone(transition(chainState))))));
            refillChainFromState();
            renderChain();
            markDirty();
        }

        function renameChainStage(card) {
            const name = card.nameInput.value;
            if (chainTrimmed(name) === '') card.nameInput.value = card.committedName;
            if (chainTrimmed(name) === '' || chainTrimmed(name) === card.committedName) return;
            const index = chainIndexOf(card.uid);
            const taken = chainState.stages.some(function(stage, i) { return i !== index && chainTrimmed(stage.name) === chainTrimmed(name); });
            if (taken) {
                card.nameInput.value = card.committedName;
                VIF.core.toast('Another step is already called “' + chainTrimmed(name) + '”. Pick a different name.', 'warn');
                return;
            }
            syncChainFromCards();
            chainState.stages[index].name = card.committedName;
            chainState = VIF.chainEditor.renameStage(chainState, index, name);
            card.committedName = chainTrimmed(name);
            refillChainFromState();
            refreshChainView(true);
        }

        function chainModeDrops(mode) {
            const current = VIF.chainEditor.chainMode(chainState);
            const drops = [];
            if (mode !== 'conditional') {
                const routed = [];
                chainState.stages.forEach(function(stage, index) {
                    if (stage.routing) routed.push(chainTrimmed(stage.name) || 'step ' + (index + 1));
                });
                if (routed.length) drops.push((routed.length === 1 ? 'the condition after ' : 'the conditions after ') + chainJoinList(routed));
            }
            if (current === 'dynamic' && mode !== 'dynamic') {
                const listener = chainState.decisionListener;
                if (listener) drops.push('your code' + (listener.className ? ' (' + listener.className + ')' : ''));
                if (isPresent(chainState.decisionTimeoutSeconds)) drops.push('the decision wait time');
                if (isPresent(chainState.dispatchIntermediateRings)) drops.push('the send-after-every-step setting');
            }
            return drops;
        }

        function chainJoinList(items) {
            if (items.length < 2) return items.join('');
            return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
        }

        function hideChainModeConfirm() {
            chainPendingMode = null;
            document.getElementById('chain-mode-confirm').style.display = 'none';
        }

        function switchChainMode(mode) {
            hideChainModeConfirm();
            applyChainTransition(function(state) { return VIF.chainEditor.switchMode(state, mode); });
        }

        function requestChainMode(mode) {
            if (!chainState) return;
            hideChainModeConfirm();
            if (mode === VIF.chainEditor.chainMode(chainState)) return;
            syncChainFromCards();
            const drops = chainModeDrops(mode);
            if (!drops.length) {
                switchChainMode(mode);
                return;
            }
            chainPendingMode = mode;
            document.getElementById('chain-mode-confirm-text').textContent =
                'Switching to ' + CHAIN_MODE_LABELS[mode] + ' drops ' + chainJoinList(drops) + '.';
            document.getElementById('chain-mode-confirm-yes').textContent = 'Switch to ' + CHAIN_MODE_LABELS[mode];
            document.getElementById('chain-mode-confirm').style.display = '';
            document.getElementById('chain-mode-confirm-no').focus();
        }

        function addChainPropertyRow(key, value, hasBase) {
            const id = 'chain-property-' + (++chainPropertySeq) + '-';
            const row = { base: value, hasBase: !!hasBase };
            row.el = chainEl('div', 'chain-prop');
            row.key = chainInput('text', id + 'key', 'key');
            row.value = chainInput('text', id + 'value', 'value');
            row.key.value = key || '';
            row.baseText = row.hasBase ? (typeof value === 'string' ? value : JSON.stringify(value)) : '';
            row.value.value = row.baseText;
            row.remove = chainButton('Remove', 'btn-danger', 'Remove this property');
            row.remove.addEventListener('click', function() {
                chainPropertyRows.splice(chainPropertyRows.indexOf(row), 1);
                row.el.remove();
                refreshChainFromDom(true);
                markDirty();
            });
            row.el.append(row.key, row.value, row.remove);
            document.getElementById('chain-decision-properties').appendChild(row.el);
            chainPropertyRows.push(row);
            return row;
        }

        function fillChainLevel() {
            const state = chainState || {};
            const listener = state.decisionListener || {};
            document.getElementById('chain-max-rings').value = chainPlainText(state.maxRings);
            // A saved 'final' is the Engine's default, so it shows as the default choice.
            document.getElementById('chain-result-mode').value = state.resultMode === 'combined' ? 'combined' : '';
            document.getElementById('chain-decision-class').value = listener.className || '';
            document.getElementById('chain-decision-timeout').value = chainPlainText(state.decisionTimeoutSeconds);
            document.getElementById('chain-dispatch-intermediate').checked = state.dispatchIntermediateRings === true;
            chainPropertyRows.forEach(function(row) { row.el.remove(); });
            chainPropertyRows = [];
            const properties = listener.properties || {};
            Object.keys(properties).forEach(function(key) { addChainPropertyRow(key, properties[key], true); });
        }

        // Every step's settings form and condition editor stay in the page so the save reads
        // them all; the settings panel shows only the selected one.
        function renderChain(options) {
            options = options || {};
            const list = document.getElementById('chain-stages');
            const gates = document.getElementById('chain-gates');
            const stages = chainState ? chainState.stages : [];
            const live = {};
            stages.forEach(function(stage) { live[stage.uid] = true; });
            Object.keys(chainCards).forEach(function(uid) {
                if (live[uid]) return;
                chainCards[uid].el.remove();
                chainCards[uid].gate.el.remove();
                delete chainCards[uid];
            });
            stages.forEach(function(stage) {
                const card = chainCards[stage.uid] || createChainCard(stage, !!options.stored, true);
                list.appendChild(card.el);
                gates.appendChild(card.gate.el);
            });
            refreshChainView(true);
        }

        // The settings panel's views that are not a step or a condition.
        var CHAIN_PANEL_VIEWS = {
            chain: { host: 'chain-settings', title: 'Chain conditional logic' },
            video: { host: 'chain-video-host', title: 'Video Settings' },
            listeners: { host: 'chain-listeners-host', title: 'Where detections go' },
            advanced: { host: 'chain-advanced-host', title: 'Advanced options' }
        };

        // A chain settings button shows its section in the panel, the way a step shows when it
        // is picked; the steps stay open to edit beside it.
        function openChainView(kind) {
            if (!chainState) return;
            selectChainItem({ kind: kind });
        }

        function chainSelectionUidLive() {
            return !!CHAIN_PANEL_VIEWS[chainSelection.kind] || chainIndexOf(chainSelection.uid) !== -1;
        }

        function selectChainItem(selection) {
            chainSelection = selection;
            if (selection.kind === 'gate') chainCards[selection.uid].gate.open = true;
            refreshChainView(false);
        }

        function selectionFromView(selection) {
            if (selection.kind === 'chain') return { kind: 'chain' };
            return { kind: selection.kind, uid: chainState.stages[selection.index].uid };
        }

        function chainPanelAction(text, className, onClick, disabled) {
            const action = chainButton(text, className);
            action.disabled = !!disabled;
            action.addEventListener('click', onClick);
            return action;
        }

        // The settings panel follows the selection: one step's form, one condition, or the
        // chain-wide settings.
        function applyChainSelection() {
            if (!chainSelectionUidLive()) chainSelection = { kind: 'chain' };
            if (chainSelection.kind === 'gate' && !chainState.stages[chainIndexOf(chainSelection.uid)].routing) {
                chainSelection = { kind: 'stage', uid: chainSelection.uid };
            }
            const selected = chainSelection;
            const view = CHAIN_PANEL_VIEWS[selected.kind];
            const index = view ? -1 : chainIndexOf(selected.uid);
            chainState.stages.forEach(function(stage) {
                const card = chainCards[stage.uid];
                if (!card) return;
                card.el.style.display = selected.kind === 'stage' && stage.uid === selected.uid ? '' : 'none';
                card.gate.el.style.display = selected.kind === 'gate' && stage.uid === selected.uid ? '' : 'none';
            });
            Object.keys(CHAIN_PANEL_VIEWS).forEach(function(kind) {
                document.getElementById(CHAIN_PANEL_VIEWS[kind].host).style.display = selected.kind === kind ? '' : 'none';
            });
            [['chain-video-line', 'video'], ['chain-settings-open', 'chain'], ['chain-advanced-open', 'advanced']].forEach(function(pair) {
                const fact = document.getElementById(pair[0]);
                fact.classList.toggle('is-open', selected.kind === pair[1]);
                fact.setAttribute('aria-pressed', String(selected.kind === pair[1]));
            });

            // The panel says what it applies to before what it is: the whole chain, one step, or
            // the condition after a step.
            const scope = document.getElementById('chain-panel-scope');
            const title = document.getElementById('chain-panel-title');
            const actions = document.getElementById('chain-panel-actions');
            const note = document.getElementById('chain-panel-note');
            actions.replaceChildren();
            note.style.display = 'none';
            note.textContent = '';
            const dynamic = VIF.chainEditor.chainMode(chainState) === 'dynamic';
            // A chain settings section says it applies to the whole chain, and the panel takes the
            // colour of the button that opened it, so it doesn't read as part of a step.
            document.getElementById('chain-panel').classList.toggle('is-chain-wide', !!view);
            scope.style.display = '';
            if (view) {
                scope.textContent = 'Chain settings · whole chain';
                title.textContent = view.title;
                if (selected.kind === 'chain' && dynamic) {
                    // Opened from the Your code card, which goes the way a step or condition does:
                    // removing it hands what runs next back to conditions.
                    actions.appendChild(chainPanelAction('Stop using your code', 'cb-panel-remove', function() { requestChainMode('linear'); }));
                }
                return;
            }
            const stage = chainState.stages[index];
            const card = chainCards[stage.uid];
            const count = chainState.stages.length;
            if (selected.kind === 'gate') {
                scope.textContent = 'After step ' + (index + 1) + ' of ' + count;
                title.textContent = card.gate.kind === 'always' ? 'Every time'
                    : card.type === 'motion' ? 'When something moves'
                    : card.type === 'synthetic' ? 'When the clip looks AI-generated' : 'When it finds';
                actions.appendChild(chainPanelAction('Remove', 'cb-panel-remove', function() {
                    card.gate.removeRoute.click();
                    selectChainItem({ kind: 'stage', uid: stage.uid });
                }));
                return;
            }
            scope.textContent = !dynamic ? 'Step ' + (index + 1) + ' of ' + count
                : index === 0 ? 'Runs first' : 'A step your code can pick';
            title.textContent = VIF.chainBuilder.stepLabel(card.type);
            if (chainTrimmed(stage.name) && (dynamic || !VIF.chainPresets.isGivenName(stage.name))) {
                title.appendChild(chainEl('span', 'cb-tile-name', chainTrimmed(stage.name)));
            }
            if (STEP_TIPS[card.type]) title.appendChild(chainTip(STEP_TIPS[card.type]));
            if (!dynamic && VIF.chainBuilder.unreachable(chainState.stages).indexOf(index) !== -1) {
                note.style.display = '';
                note.textContent = 'This step never runs: nothing leads to it. Pick it under Go to in the condition before it, or remove it.';
            }
            actions.append(
                chainPanelAction('Remove step', 'cb-panel-remove', function() {
                    const at = chainIndexOf(card.uid);
                    applyChainTransition(function(state) { return removeChainStage(state, at); });
                    const neighbor = chainState.stages[Math.min(at, chainState.stages.length - 1)];
                    if (neighbor) selectChainItem({ kind: 'stage', uid: neighbor.uid });
                    else showChainGetStarted();
                }));
        }

        // Why a step can't be added right now, by step type.
        function chainBlockedSteps() {
            const blocked = {};
            const stages = chainState.stages;
            const entry = stages.length ? (stages[0].detector || {}).type : '';
            if (entry === 'motion') blocked.motion = 'Already the first step. A chain watches for movement only once.';
            else if (VIF.chainEditor.hasSyntheticStage(chainState)) blocked.motion = 'Can’t join a chain that spots AI-generated video.';
            if (VIF.chainEditor.chainMode(chainState) === 'dynamic') blocked.synthetic = 'Your code can’t pick this step.';
            else if (entry === 'motion') blocked.synthetic = 'Can’t follow Watch for movement.';
            return blocked;
        }

        var CHAIN_DESTINATION_LABELS = {
            WebhookEvent2: 'webhook', LogFileEvent: 'log file', OverlayEvent: 'video overlay',
            Id3Event: 'ID3 tags', ObjectTracking: 'object tracking'
        };

        function chainDestinations() {
            const listeners = window.buildEventListenersJson ? window.buildEventListenersJson() : {};
            return Object.keys(listeners).sort(function(a, b) { return a.localeCompare(b); }).map(function(name) {
                const listener = listeners[name] || {};
                const type = window.resolveClassName ? window.resolveClassName(listener.class_name || '') : '';
                const methods = [].concat(listener.methods || []);
                return { name: name, type: CHAIN_DESTINATION_LABELS[type] || type,
                         off: methods.length === 0 || methods.every(function(method) { return method === 'disabled'; }) };
            });
        }

        // Opens Where detections go; with `addNew`, straight onto the new-destination form.
        function openListenerSettings(addNew) {
            if (!chainState) return;
            openChainView('listeners');
            // The chain may have changed which steps' results go out, and so which methods fit.
            if (window.refreshListenerMethodChoices) window.refreshListenerMethodChoices();
            if (addNew === true && window.openNewListenerForm) {
                window.openNewListenerForm();
                return;
            }
            const target = document.getElementById('evt-listener-select');
            const focus = target && target.offsetParent ? target : document.getElementById('evt-show-new-listener-btn');
            if (focus) focus.focus({ preventScroll: true });
        }

        // What the Send results card at the end of the chain shows and does.
        function chainSendView() {
            return {
                destinations: chainDestinations(),
                everyStep: chainState.resultMode === 'combined',
                dynamic: VIF.chainEditor.chainMode(chainState) === 'dynamic',
                afterEveryStep: chainState.dispatchIntermediateRings === true,
                missStops: VIF.chainBuilder.missStops(chainState.stages),
                selected: chainSelection.kind === 'listeners',
                onOpen: function() { openListenerSettings(chainDestinations().length === 0); },
                onEdit: openChainDestination,
                onAdd: function() { openListenerSettings(true); }
            };
        }

        function openChainDestination(name) {
            openListenerSettings(false);
            const select = document.getElementById('evt-listener-select');
            if (!select || !Array.from(select.options).some(function(option) { return option.value === name; })) return;
            select.value = name;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }

        function refreshChainResults() {
            if (!chainState) return;
            const slot = document.getElementById('chain-send');
            if (slot) VIF.chainBuilder.renderSend(slot, chainSendView());
        }

        function renderChainBuilder(errors, warnings) {
            const stages = chainState.stages;
            const getStarted = chainShowGetStarted && stages.length === 0;
            document.getElementById('chain-getstarted').style.display = getStarted ? '' : 'none';
            document.getElementById('chain-workspace').style.display = getStarted ? 'none' : '';
            // Get started has no settings panel yet, so nothing that opens one shows there.
            document.getElementById('chain-head').style.display = getStarted ? 'none' : '';
            if (getStarted) return;

            applyChainSelection();
            const blocked = chainBlockedSteps();
            const own = function(index, member) {
                const prefix = 'stages[' + index + ']' + member;
                return errors.some(function(error) { return error.indexOf(prefix) === 0; });
            };
            const warnedAt = function(index, routing) {
                const prefix = 'stages[' + index + ']';
                return (warnings || []).some(function(warning) {
                    return warning.indexOf(prefix) === 0 && (warning.indexOf(prefix + '.routing') === 0) === routing;
                });
            };
            const viewSelection = CHAIN_PANEL_VIEWS[chainSelection.kind] ? { kind: chainSelection.kind }
                : { kind: chainSelection.kind, index: chainIndexOf(chainSelection.uid) };
            VIF.chainBuilder.renderFlow(document.getElementById('chain-flow'), {
                state: chainState,
                maxRings: chainState.maxRings,
                palette: { blocked: blocked, onAdd: function(type) { insertChainStage(type, chainState.stages.length); } },
                mode: VIF.chainEditor.chainMode(chainState),
                selection: viewSelection,
                blocked: blocked,
                knownClasses: function(index) { return chainStepKnownClasses(chainState.stages[index]); },
                stageHasError: function(index) {
                    return errors.some(function(error) {
                        return error.indexOf('stages[' + index + ']') === 0 && error.indexOf('stages[' + index + '].routing') !== 0;
                    });
                },
                routeHasError: function(index) { return own(index, '.routing'); },
                stageHasWarning: function(index) { return warnedAt(index, false); },
                routeHasWarning: function(index) { return warnedAt(index, true); },
                decisionHasError: errors.some(function(error) { return /^decision_/.test(error); }),
                actions: {
                    select: function(selection) { selectChainItem(selectionFromView(selection)); },
                    insert: insertChainStage,
                    move: dropChainStage,
                    addCondition: addChainCondition,
                    nudge: function(index, delta) { moveChainStage(chainCards[chainState.stages[index].uid], delta); },
                    showGetStarted: showChainGetStarted
                },
                send: chainSendView()
            });
        }

        function chainStageSummary(stage) {
            const detector = stage.detector || {};
            const parts = [];
            const classes = detector.classes || (detector.detect && detector.detect.classes)
                || (detector.custom && detector.custom.classes);
            if (classes && classes.length) parts.push(classes.join(', '));
            if (detector.type === 'vlm' && detector.mode) parts.push(detector.mode);
            const selection = stage.frameSelection;
            if (selection && selection.mode && selection.mode !== 'all') {
                parts.push(selection.mode === 'every_nth' && selection.stride
                    ? 'one frame in ' + selection.stride
                    : (FRAME_SELECTION_LABELS[selection.mode] || selection.mode).toLowerCase());
            }
            if (stage.crop) parts.push('crop');
            return parts.join(' · ');
        }

        function chainFrameSelectionText(mode, strideText) {
            if (mode !== 'every_nth') return FRAME_SELECTION_LABELS[mode] || '';
            const stride = Number(String(strideText).trim());
            return Number.isInteger(stride) && stride > 0 ? 'One frame in every ' + stride : 'One frame in every few';
        }

        function refreshChainCard(card, stage, index, errors, warnings, showStageErrors) {
            const stages = chainState.stages;
            const mode = VIF.chainEditor.chainMode(chainState);
            const name = chainCardName(card);
            card.badge.textContent = String(index + 1);
            card.nameLabel.textContent = name || 'Unnamed stage';
            card.typeTag.textContent = CHAIN_STAGE_LABELS[card.type] || card.type;
            card.summary.textContent = chainStageSummary(stage);
            card.upBtn.disabled = index === 0;
            card.downBtn.disabled = index === stages.length - 1;
            const renamed = !!card.stored && !!STAGE_SECRETS[card.stored.type] && name !== card.stored.name;
            card.nameNote.textContent = renamed ? 'Renaming clears this step’s stored API key.' : '';
            // What a section shows can change with the step's choices, so the hiding follows them.
            if (card.covered) hideCoveredSettings(card, card.covered);
            card.allBox.style.display = chainAllSettingsLeft(card) ? '' : 'none';
            const moreHasControls = card.moreSlot.firstElementChild && card.moreSlot.firstElementChild.childElementCount > 0;
            // A step that looks inside boxes follows the frames of the step before, so its frame
            // choice offers only choices that still get boxes. It stays above the zoom controls
            // either way, so turning zoom on doesn't move it.
            const boxed = card.cropOn && VIF.chainEditor.offersCrop(chainState, index);
            if (card.frameBox.nextSibling !== card.cropBox) card.body.insertBefore(card.frameBox, card.cropBox);
            const frameChoices = boxed ? VIF.chainEditor.cropFrameChoices(chainState, index) : VIF.chainEditor.FRAME_SELECTION_MODES;
            Array.from(card.frameMode.options).forEach(function(option) {
                const offered = frameChoices.indexOf(option.value) !== -1 || option.value === card.frameMode.value;
                option.hidden = !offered;
                option.disabled = !offered;
            });
            card.moreBox.style.display = moreHasControls ? '' : 'none';

            const frameMode = card.frameMode.value;
            const windowStage = VIF.chainEditor.windowStageIndex(chainState);
            // Movement compares consecutive frames and synthetic scores the whole clip, so neither picks
            // frames; the choice still shows if a stored step has one, so it can be set back.
            const picksFrames = card.type !== 'synthetic' && card.type !== 'motion' && windowStage !== -1;
            card.frameBox.style.display = picksFrames || frameMode !== 'all' ? '' : 'none';
            card.strideGroup.style.display = frameMode === 'every_nth' ? '' : 'none';
            const frameText = chainFrameSelectionText(frameMode, card.strideInput.value);
            card.frameValue.textContent = frameText ? ' · ' + frameText : '';
            if (boxed) {
                const source = chainCropSource(index);
                const found = source.moving ? 'areas ' + source.step + ' saw move' : 'objects ' + source.step + ' detected';
                const single = frameMode === 'first' || frameMode === 'middle' || frameMode === 'last';
                card.frameHelp.textContent = (frameMode === 'all'
                    ? 'The same frames as ' + source.step + ', so it zooms into all the ' + found + '.'
                    : chainFrameHelp(frameMode, card.strideInput.value, 'boxes') + ' It zooms into the ' + found
                        + (single ? ' on that frame.' : ' on those frames.'))
                    + ' The list only shows frames ' + source.step + ' also looks at.';
            } else {
                card.frameHelp.textContent = chainFrameHelp(frameMode, card.strideInput.value, card.type);
            }
            const budget = card.type === 'vlm' ? chainVlmFrameBudget(stage) : null;
            if (budget && budget.captured > 0) {
                card.frameHelp.textContent += ' This step gets ' + budget.selected + ' of the ' + budget.captured
                    + (budget.captured === 1 ? ' frame' : ' frames') + ' in each clip.';
            }
            const frameWarnText = budget && budget.over ? chainVlmFrameWarning(budget)
                : warnings.filter(function(w) { return w.indexOf('stages[' + index + '].frame_selection') === 0; })
                    .map(chainWarningText).join('\n');
            card.frameWarn.textContent = frameWarnText;
            card.frameWarn.style.display = frameWarnText ? '' : 'none';
            card.frameSyntheticNote.textContent = card.type === 'synthetic' ? CHAIN_SYNTHETIC_FRAMES_NOTE : '';

            const cropOffered = VIF.chainEditor.offersCrop(chainState, index);
            const own = 'stages[' + index + '].';
            const cropErrors = errors.filter(function(error) {
                return error.indexOf(own + 'crop') === 0
                    || (card.cropOn && (error.indexOf(own + 'detector.tracking') === 0 || error.indexOf(own + 'detector.tiling') === 0));
            });
            card.cropBox.style.display = cropOffered || card.cropOn ? '' : 'none';
            refreshCropPlain(card, index);
            card.cropError.textContent = cropErrors.map(chainErrorText).join('\n');

            const lock = card.type === 'object' && card.cropOn;
            const tracking = field(card.root, 'cfg-tracking-method');
            const tiling = field(card.root, 'cfg-tiling-enabled');
            const blocker = card.type === 'object' ? VIF.chainEditor.trackingBlocker(chainState, index) : null;
            if (blocker && !tracking.value) {
                tracking.value = 'none';
                toggleByteTrack(card.root);
                stage.detector.tracking = { method: 'none' };
            }
            Array.from(tracking.options).forEach(function(option) {
                if (option.value === 'byte-track') option.disabled = !!blocker;
            });
            // A chain that can't follow objects at all says so first; zoom is named only when turning
            // it off would let following work.
            const trackingWhy = chainStepRefs(blocker ? chainTrackingWhy(blocker) : (lock ? cropTrackingWhy(card) : ''));
            tracking.disabled = lock && tracking.value === 'none';
            tiling.disabled = lock && !tiling.checked;
            card.trackingNote.textContent = trackingWhy;
            card.controls.sync({ trackingWhy: trackingWhy });

            const routeOf = function(message) { return message.indexOf(own + 'routing') === 0; };
            const routeErrors = mode !== 'conditional' ? [] : errors.filter(routeOf);
            showChainWarnings(card.gate.warnings, warnings.filter(routeOf));
            refreshGate(card, stage, index, routeErrors, showStageErrors);

            if (!showStageErrors) return;
            const stageErrors = errors.filter(function(error) {
                return error.indexOf(own) === 0 && cropErrors.indexOf(error) === -1 && routeErrors.indexOf(error) === -1;
            });
            card.errors.textContent = stageErrors.map(chainErrorText).join('\n');
            card.el.classList.toggle('has-error', stageErrors.length + cropErrors.length > 0);
        }

        // The Video Settings button: an inactive config gets a chip the eye can't skip, and the
        // hover says what the chain runs on, read from Video Processing.
        function updateChainVideoLine() {
            const line = document.getElementById('chain-video-line');
            const fpsInput = document.getElementById('cfg-inference-fps');
            const fps = parseFloat((fpsInput.value || '').trim() || fpsInput.placeholder || '');
            const active = document.getElementById('cfg-active').checked;
            const say = function(text) {
                line.replaceChildren('Video Settings');
                if (!active) line.appendChild(chainEl('span', 'cb-fact-off', 'Not active'));
                line.title = (active ? 'Runs ' : 'Not active. Set to run ') + text + '.';
            };
            // Without the transcoder the Engine grabs each keyframe as it arrives, and the frame rate is not used.
            if (!document.getElementById('cfg-use-transcoder').checked) {
                say('on each keyframe from the incoming stream');
                return;
            }
            const rate = !Number.isFinite(fps) ? ''
                : fps === -1 ? 'the stream’s own frame rate'
                : fps + (fps === 1 ? ' frame' : ' frames') + ' per second';
            say((rate ? 'at ' + rate + ' ' : 'on frames ') + 'from the transcoder');
        }

        // The Chain conditional logic button's hover says how the chain decides what runs next.
        function updateChainModeLine() {
            const line = document.getElementById('chain-settings-open');
            if (!chainState) { line.title = ''; return; }
            if (VIF.chainEditor.chainMode(chainState) === 'dynamic') line.title = 'Your code decides what runs next.';
            else if (chainState.stages.some(function(stage) { return !!stage.routing; })) line.title = 'Conditions you set decide what runs next.';
            else line.title = 'Steps run in order.';
        }

        function setPanelCollapsed(panel, collapsed) {
            if (!panel || panel.classList.contains('collapsed') === collapsed) return;
            togglePanel(panel.querySelector('.form-panel-header'));
        }

        // While a chain is edited, the Video Processing, Advanced Options and Event Listeners
        // bodies move into the builder's settings panel and the columns below it hide; a
        // single-detector config gets them back where they were, with Video Processing open.
        function hostPanelsInChain(chain) {
            if (chain === chainHosted) return;
            chainHosted = chain;
            [
                [document.getElementById('video-processing-panel'), document.getElementById('chain-video-host')],
                [document.getElementById('advanced-options-panel'), document.getElementById('chain-advanced-host')],
                [document.querySelector('.vif-plugin .two-column .event-listeners-panel'), document.getElementById('chain-listeners-host')]
            ].forEach(function(pair) {
                const wrapper = pair[0], host = pair[1];
                const body = (chain ? wrapper : host).querySelector(':scope > .collapsible-body');
                if (!body) return;
                if (chain) {
                    host.appendChild(body);
                    body.classList.remove('collapsed');
                } else {
                    wrapper.appendChild(body);
                    body.classList.toggle('collapsed', wrapper.classList.contains('collapsed'));
                }
            });
            document.querySelector('.vif-plugin .two-column').style.display = chain ? 'none' : '';
            if (!chain) setPanelCollapsed(document.getElementById('video-processing-panel'), false);
        }

        function openVideoProcessing() {
            if (!chainState) return;
            openChainView('video');
            document.getElementById('cfg-active').focus({ preventScroll: true });
        }

        // The chip shows only when something needs attention; a click shows what each concern is.
        // Problems that read the same, such as one loop reached two ways, count and show once.
        function distinctLines(lines) {
            return lines.filter(function(line, at) { return lines.indexOf(line) === at; });
        }

        function chainStatusChip(counted) {
            const error = counted.kind === 'error';
            const lines = distinctLines(counted.list.map(error ? chainErrorText : chainWarningText));
            const count = lines.length;
            if (!count) return null;
            const noun = error ? (count === 1 ? ' problem' : ' problems') : (count === 1 ? ' warning' : ' warnings');
            return {
                kind: counted.kind,
                text: (error ? '✗ ' : '⚠ ') + count + noun,
                tip: lines.length === 1 ? lines[0] : lines.map(function(line) { return '• ' + line; }).join('\n')
            };
        }

        // Everything the chain view reports: the editor's errors and warnings, plus what the
        // capture settings do to an AI model step, which only the page can judge because the
        // editor never sees Inference FPS or Duration.
        function chainProblems() {
            const result = VIF.chainEditor.validateChain(chainState);
            result.errors = result.errors.concat(VIF.chainEditor.missingPicks(chainState));
            chainState.stages.forEach(function(stage, index) {
                const budget = (stage.detector || {}).type === 'vlm' ? chainVlmFrameBudget(stage) : null;
                if (budget && budget.over) {
                    result.warnings.push('stages[' + index + '].frame_selection: ' + (budget.captured === -1
                        ? (budget.mode === 'every_nth' ? 'at the stream’s own frame rate, how many frames go to the AI model depends on the stream.'
                            : 'every frame of each clip goes to the AI model.')
                        : budget.selected + ' frames per clip go to the AI model; most take ' + VLM_TYPICAL_ENDPOINT_IMAGE_CAP + '.'));
                }
            });
            return result;
        }

        // What the chip counts: the errors while there are any, otherwise the warnings on a step or
        // condition. Chain-wide warnings already show under Chain settings.
        function chainCountedProblems(result) {
            const error = result.errors.length > 0;
            const list = error ? result.errors : result.warnings.filter(function(w) { return !isChainLevelWarning(w); });
            return { kind: error ? 'error' : 'warn', list: list };
        }

        function isChainLevelWarning(warning) {
            return !/^stages\[\d+\]/.test(warning);
        }

        function followCropFrames() {
            chainState.stages.forEach(function(stage, index) {
                const card = chainCards[stage.uid];
                if (!card) return;
                const boxed = card.cropOn && VIF.chainEditor.offersCrop(chainState, index);
                const sources = boxed ? (VIF.chainEditor.cropSources(chainState, index) || []) : [];
                const key = sources.map(function(source) {
                    const type = (source.detector || {}).type;
                    return chainTrimmed(source.name) + ':' + (type === 'motion' ? 'all' : ((source.frameSelection || {}).mode || 'all'));
                }).join('|');
                // Zoom just turned on, or the steps before changed their frames: a frame choice that
                // still gets boxes stays. A saved one loads as it was.
                const moved = card.cropJustOn || (card.cropFramesKey !== undefined && card.cropFramesKey !== key);
                delete card.cropJustOn;
                card.cropFramesKey = boxed ? key : undefined;
                if (!boxed || !moved || VIF.chainEditor.cropFrameChoices(chainState, index).indexOf(card.frameMode.value) !== -1) return;
                card.frameMode.value = 'all';
                card.strideInput.value = '';
                delete stage.frameSelection;
            });
        }

        function refreshChainView(showStageErrors) {
            if (!chainState) return;
            followCropFrames();
            const result = chainProblems();
            const errors = result.errors;
            chainState.stages.forEach(function(stage, index) {
                const card = chainCards[stage.uid];
                if (card) refreshChainCard(card, stage, index, errors, result.warnings, showStageErrors);
            });

            // Chain-wide warnings show once, in the line under Chain settings; the chip counts the rest.
            const status = chainStatusChip(chainCountedProblems(result));
            const chip = document.getElementById('chain-status');
            chip.style.display = status ? '' : 'none';
            chip.className = 'chain-status ' + (status ? status.kind : '');
            chip.textContent = status ? status.text : '';
            if (status) chip.dataset.vifTip = status.tip;
            else delete chip.dataset.vifTip;
            showChainWarnings(document.getElementById('chain-warnings'), result.warnings.filter(isChainLevelWarning));

            // The switch offers two choices: a linear chain is "Conditions you set" with none set yet.
            const decidedBy = VIF.chainEditor.chainMode(chainState) === 'dynamic' ? 'dynamic' : 'conditional';
            document.querySelectorAll('#chain-mode > button').forEach(function(button) {
                const active = button.dataset.mode === decidedBy;
                button.classList.toggle('is-active', active);
                button.setAttribute('aria-pressed', String(active));
                button.disabled = false;
            });
            ['conditional', 'dynamic'].forEach(function(each) {
                document.getElementById('chain-mode-help-' + each).style.display = each === decidedBy ? '' : 'none';
            });
            document.getElementById('chain-decision-panel').style.display = decidedBy === 'dynamic' ? '' : 'none';
            if (showStageErrors) refreshChainLevelErrors(errors);
            renderChainBuilder(errors, result.warnings);

            updateChainVideoLine();
            updateChainModeLine();
            syncChainLevelControls();
            recheckSaveRefusal();
            document.getElementById('chain-json-body').textContent =
                JSON.stringify(VIF.sdk.toWire(VIF.chainEditor.collectChainDetector(chainState)), null, 2);

            if (document.getElementById('cfg-detector-type').value !== 'chain') return;
            applyChainCaptureGroups();
            updateSyntheticOverlayWarning();
            suggestFromChainEntryStage();
        }

        // Chain-wide warnings in the words the builder uses; a function gets the regex match.
        var CHAIN_WARNING_TEXT = [
            [/^stages: a synthetic stage runs on-demand only/, 'Recorded video only: live streams that match this config won’t start. To run it, go to On-Demand → New Analysis and choose a recorded video.'],
            // A condition with no rules never matches, so every clip takes its "finds none" way.
            [/^stages\[(\d+)\]\.routing\.rules: no rules/, function(found) {
                const index = Number(found[1]);
                const stage = chainState.stages[index];
                const condition = stage ? VIF.chainBuilder.conditionText(stage, chainState.stages) : null;
                const otherwise = condition ? condition.otherwise : 'stop';
                return 'The condition after step ' + (index + 1) + ' has nothing to look for, so it never matches'
                    + (otherwise === 'stop' ? ' and the chain stops there on every clip.' : ', and every clip goes to ' + otherwise.replace(/^go to /, '') + '.')
                    + ' Add a rule, or remove the condition.';
            }],
            // A movement condition goes on whenever something moves; a saved config can still carry
            // what other conditions use, which the save drops.
            [/^stages\[(\d+)\]\.routing\.rules\[\d+\]\.min_confidence: a motion route/, function(found) {
                const step = Number(found[1]) + 1;
                return 'The condition after step ' + step + ' has a how sure value, but movement has none, so saving drops it. '
                    + 'To ignore small movement, raise Smallest movement that counts under More settings on step ' + step + '.';
            }],
            [/^stages\[(\d+)\]\.routing\.rules\[\d+\]\.classes: a motion route/, function(found) {
                return 'The condition after step ' + (Number(found[1]) + 1) + ' lists things to find, but movement only reports that something moved, '
                    + 'so saving clears the list. The condition still goes on whenever something moves.';
            }],
            [/^stages\[(\d+)\]\.routing\.on_\w+: goes back to stages\[(\d+)\]/, function(found) {
                const step = Number(found[1]) + 1;
                const back = Number(found[2]) + 1;
                return back === step
                    ? 'The condition after step ' + step + ' goes back to step ' + step + ' itself, so each clip can repeat it '
                        + 'until it reaches Maximum step runs per clip. To run it once, pick a later step or Stop the chain.'
                    : 'The condition after step ' + step + ' goes back to step ' + back + ', and the chain can come back to step '
                        + step + ' from there, so each clip can repeat those steps until it reaches Maximum step runs per clip. '
                        + 'To run each step once, pick a later step or Stop the chain.';
            }],
            [/^stages\[(\d+)\]\.frame_selection: every frame of each clip goes to the AI model\.$/, function(found) {
                return 'Step ' + (Number(found[1]) + 1) + ' sends every frame of each clip to the AI model at the stream’s own frame rate, '
                    + 'more than most AI models take in one request. Pick fewer frames under Which frames it looks at on step '
                    + (Number(found[1]) + 1) + ', or set a fixed Inference FPS.';
            }],
            [/^stages\[(\d+)\]\.frame_selection: at the stream’s own frame rate, how many frames/, function(found) {
                return 'At the stream’s own frame rate, how many frames step ' + (Number(found[1]) + 1)
                    + ' sends to the AI model depends on the stream, and can be more than most AI models take in one request. '
                    + 'Pick the first, middle or last frame under Which frames it looks at on step ' + (Number(found[1]) + 1)
                    + ', or set a fixed Inference FPS.';
            }],
            [/^stages\[(\d+)\]\.frame_selection: (\d+) frames per clip go to the AI model; most take (\d+)\.$/, function(found) {
                return 'Step ' + (Number(found[1]) + 1) + ' sends ' + found[2] + ' frames per clip to the AI model, '
                    + 'more than the ' + found[3] + ' most AI models take in one request. Pick fewer frames under Which frames it looks at on step '
                    + (Number(found[1]) + 1) + ', or lower Inference FPS or Duration.';
            }],
            [/^stages\[(\d+)\]\.frame_selection: looks at different frames than stages\[(\d+)\]/, function(found) {
                const step = Number(found[1]) + 1;
                return 'Step ' + step + ' never gets a box, because it looks at different frames than step ' + (Number(found[2]) + 1)
                    + '. Set Which frames it looks at on step ' + step + ' back to Every frame.';
            }],
            [/^stages\[\d+\]\.frame_selection: a motion stage compares/, 'Watch for movement compares each frame with the one before it, so looking at fewer frames can miss movement. Set Which frames it looks at back to Every frame.'],
            // A chain without conditions runs its steps once each, so steps past the cap never run.
            [/^max_rings: (at the default of \d+, )?stages (\d+)\+ can never run\.$/, function(found) {
                const from = Number(found[2]);
                return (found[1] ? 'At the default of ' + (from - 1) + ' step runs per clip, steps ' : 'Steps ')
                    + from + ' and after never run. Raise Maximum step runs per clip to at least ' + chainState.stages.length + '.';
            }],
            // With conditions a clip can still finish early, but the cap can cut a long path short.
            [/^max_rings: (at the default of \d+, )?a window stops after (\d+) stage runs?, fewer than the (\d+) stages here\.$/, function(found) {
                const runs = Number(found[2]);
                return (found[1] ? 'At the default, each' : 'Each') + ' clip stops after ' + runs + (runs === 1 ? ' step run' : ' step runs')
                    + ', but this chain has ' + found[3] + ' steps, so a clip can end before its later steps run. '
                    + 'Raise Maximum step runs per clip to at least ' + found[3] + '.';
            }]
        ];

        function chainWarningText(warning) {
            for (let i = 0; i < CHAIN_WARNING_TEXT.length; i++) {
                const found = CHAIN_WARNING_TEXT[i][0].exec(warning);
                if (!found) continue;
                const text = CHAIN_WARNING_TEXT[i][1];
                return chainStepRefs(typeof text === 'function' ? text(found) : text);
            }
            return chainErrorText(warning);
        }

        function showChainWarnings(box, warnings) {
            box.textContent = distinctLines(warnings.map(chainWarningText)).join('\n');
            box.style.display = warnings.length ? '' : 'none';
        }

        function refreshChainLevelErrors(errors) {
            const text = function(prefixes) {
                return errors.filter(function(error) {
                    return prefixes.some(function(prefix) { return error.indexOf(prefix) === 0; });
                }).map(chainErrorText).join('\n');
            };
            document.getElementById('chain-decision-errors').textContent = text(['decision_listener', 'decision_timeout_seconds']);
            document.getElementById('chain-advanced-errors').textContent = text(['max_rings']);
        }

        function refreshChainFromDom(showStageErrors) {
            syncChainFromCards();
            // A step that now answers in words can't keep a condition with rules: it goes one way instead.
            const routed = VIF.chainEditor.withFreeFormRoutesAsOnDone(chainState);
            chainState.stages.forEach(function(stage, index) {
                const card = chainCards[stage.uid];
                if (!card || !stage.routing || stage.routing.onDone || !routed.stages[index].routing.onDone) return;
                stage.routing = routed.stages[index].routing;
                fillGate(card, stage);
            });
            // A condition's Go to can take a step's boxes away; its zoom goes with them, card and all.
            // A half-typed step name matches no route, so the routes are followed under the committed names.
            const settled = VIF.chainPresets.withoutBoxlessZoom(Object.assign({}, chainState, {
                stages: chainState.stages.map(function(stage) {
                    const card = chainCards[stage.uid];
                    return card && card.nameTyping ? Object.assign({}, stage, { name: card.committedName }) : stage;
                })
            }));
            chainState.stages.forEach(function(stage, index) {
                const card = chainCards[stage.uid];
                if (!card || !card.cropOn || settled.stages[index].crop) return;
                delete stage.crop;
                fillCrop(card, stage);
            });
            refreshChainView(showStageErrors);
        }

        function applyChainCaptureGroups() {
            const stages = document.getElementById('chain-stages');
            const focused = document.activeElement;
            const anchor = stages && focused && stages.contains(focused) ? focused : stages;
            const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;
            const display = chainIsWindowed() ? 'flex' : 'none';
            let toggled = false;
            ['catch_up_to_live', 'catch_up_max_behind_seconds'].forEach(function(path) {
                const group = document.getElementById(VIF.fieldRegistry.getFieldByPath(path).group);
                if (!group || group.style.display === display) return;
                group.style.display = display;
                toggled = true;
            });
            if (!toggled || !anchor) return;
            const shift = anchor.getBoundingClientRect().top - anchorTop;
            if (shift !== 0) window.scrollBy(0, shift);
        }

        function suggestFromChainEntryStage() {
            const entry = chainEntryType();
            if (chainSuggestedEntryType === null) chainSuggestedEntryType = entry;
            if (entry === chainSuggestedEntryType || !isNewStream()) return;
            chainSuggestedEntryType = entry;
            applyDetectorTypeInferenceFpsSuggestion('chain');
            applyDetectorTypeTranscoderSuggestion('chain');
            applyDetectorTypeDurationSuggestion('chain');
            updateChainVideoLine();
        }

        function loadChain(detector) {
            clearChain();
            chainState = assignStageUids(VIF.chainEditor.withFreeFormRoutesAsOnDone(VIF.chainEditor.initChain(detector)));
            const stored = !isNewStream();
            chainStoredDetector = stored ? JSON.parse(JSON.stringify(detector)) : null;
            chainShowGetStarted = false;
            chainSelection = chainState.stages.length ? { kind: 'stage', uid: chainState.stages[0].uid } : { kind: 'chain' };
            fillChainLevel();
            renderChain({ stored: stored });
        }

        // An empty chain goes back to Get started: when its last step is removed, or from the
        // empty builder's own link.
        function showChainGetStarted() {
            if (!chainState || chainState.stages.length) return;
            chainShowGetStarted = true;
            chainSelection = { kind: 'chain' };
            chainGetStarted.reset();
            refreshChainView(false);
        }

        // A new chain opens on Get started instead of a placeholder step.
        function ensureChain() {
            if (chainState) return;
            chainState = assignStageUids(VIF.chainEditor.initChain({ mode: 'linear', stages: [] }));
            chainShowGetStarted = true;
            chainSelection = { kind: 'chain' };
            chainGetStarted.reset();
            fillChainLevel();
            renderChain();
        }

        function clearChain() {
            Object.keys(chainCards).forEach(function(uid) {
                chainCards[uid].el.remove();
                chainCards[uid].gate.el.remove();
            });
            chainCards = {};
            chainState = null;
            chainStoredDetector = null;
            hideChainModeConfirm();
            fillChainLevel();
            ['chain-decision-errors', 'chain-advanced-errors'].forEach(function(id) {
                document.getElementById(id).textContent = '';
            });
            document.getElementById('chain-decision-panel').style.display = 'none';
            chainSuggestedEntryType = null;
            chainSelection = { kind: 'chain' };
            chainShowGetStarted = false;
            ['chain-stages', 'chain-gates', 'chain-flow', 'chain-panel-actions'].forEach(function(id) {
                document.getElementById(id).replaceChildren();
            });
            document.getElementById('chain-panel-title').textContent = '';
            const chip = document.getElementById('chain-status');
            chip.className = 'chain-status';
            chip.textContent = '';
            showChainWarnings(document.getElementById('chain-warnings'), []);
            document.getElementById('chain-json-body').textContent = '';
        }

        window.__vifRecheckSaveRefusal = recheckSaveRefusal;

        (function bindChainSection() {
            const section = document.getElementById('chain-pipeline-section');
            section.addEventListener('input', function(event) {
                if (chainState && event.target.closest(CHAIN_EDITABLE)) refreshChainFromDom(false);
            });
            section.addEventListener('change', function(event) {
                if (!chainState || !event.target.closest(CHAIN_EDITABLE)) return;
                refreshChainFromDom(true);
            });
            document.getElementById('chain-mode').addEventListener('click', function(event) {
                const button = event.target.closest('button[data-mode]');
                if (!button || !chainState) return;
                const dynamic = VIF.chainEditor.chainMode(chainState) === 'dynamic';
                if (button.dataset.mode === 'dynamic' && !dynamic) requestChainMode('dynamic');
                if (button.dataset.mode === 'conditional' && dynamic) requestChainMode('linear');
            });
            // The results strip mirrors the Event Listeners panel, which changes without telling
            // this page; re-read it after anything happens there.
            // Bound to the body, which travels into the builder while a chain is edited.
            const listenersBody = document.querySelector('.vif-plugin .two-column .event-listeners-panel > .collapsible-body');
            ['click', 'change', 'input'].forEach(function(type) {
                listenersBody.addEventListener(type, function() { setTimeout(refreshChainResults, 0); });
            });
            document.getElementById('chain-mode-confirm-yes').addEventListener('click', function() {
                if (chainPendingMode) switchChainMode(chainPendingMode);
            });
            document.getElementById('chain-mode-confirm-no').addEventListener('click', hideChainModeConfirm);
            document.getElementById('chain-video-line').addEventListener('click', openVideoProcessing);
            document.getElementById('chain-settings-open').addEventListener('click', function() { openChainView('chain'); });
            document.getElementById('chain-advanced-open').addEventListener('click', function() { openChainView('advanced'); });
            ['cfg-active', 'cfg-inference-fps', 'cfg-use-transcoder'].forEach(function(id) {
                const input = document.getElementById(id);
                ['input', 'change'].forEach(function(type) {
                    input.addEventListener(type, function() { if (chainState) updateChainVideoLine(); });
                });
            });
            document.getElementById('chain-property-add').addEventListener('click', function() {
                if (!chainState) return;
                const row = addChainPropertyRow('', '', false);
                refreshChainFromDom(true);
                markDirty();
                row.key.focus();
            });
            Object.keys(CHAIN_LEVEL_NUMBER_RULES).forEach(function(id) {
                applyNumericRuleToInput(document.getElementById(id), CHAIN_LEVEL_NUMBER_RULES[id]);
            });
        })();

        function showDetectorHelp(prefix, detectorType, types) {
            types.forEach(function(t) {
                const el = document.getElementById(prefix + '-' + t);
                if (el) el.style.display = (t === detectorType) ? 'inline' : 'none';
            });
        }

        function getInferenceVideoHeight()
        {
            const mode = document.getElementById('cfg-inference-video-height-mode').value;
            if (mode === 'source') return -1;
            if (mode === 'custom') return readNumericInputValue('cfg-inference-video-height-custom', true);
            return null;
        }

        function setInferenceVideoHeightFromValue(val)
        {
            const modeSelect = document.getElementById('cfg-inference-video-height-mode');
            const customInput = document.getElementById('cfg-inference-video-height-custom');
            if (val === -1)
            {
                modeSelect.value = 'source';
                customInput.style.display = 'none';
                customInput.value = '';
            }
            else if (val != null && val > 1)
            {
                modeSelect.value = 'custom';
                customInput.style.display = '';
                customInput.value = val;
            }
            else
            {
                // 0 and unset both mean the model's size, the one default the Engine applies.
                modeSelect.value = '';
                customInput.style.display = 'none';
                customInput.value = '';
            }
        }

        function showSectionHelp(root, prefix, detectorType, types) {
            types.forEach(function(t) {
                const el = field(root, prefix + '-' + t);
                if (el) el.style.display = (t === detectorType) ? 'inline' : 'none';
            });
        }

        function toggleSections(root, detectorType) {
            VIF.fieldRegistry.sections.forEach(function(section) {
                const el = field(root, section.group);
                if (el) el.style.display = section.detectors.indexOf(detectorType) !== -1 ? 'block' : 'none';
            });
            // Keep the VLM mode panels in sync with the selected mode whenever the
            // section becomes visible.
            if (detectorType === 'vlm') toggleVlmMode(root);
            showSectionHelp(root, 'synthetic-title', detectorType, ['synthetic', 'verify']);
            showSectionHelp(root, 'synthetic-help', detectorType, ['synthetic', 'verify']);
            showSectionHelp(root, 'vlm-title', detectorType, ['vlm', 'verify']);
            showSectionHelp(root, 'vlm-help', detectorType, ['vlm', 'verify']);
            showSectionHelp(root, 'vlm-model-help', detectorType, ['vlm', 'verify']);
            field(root, 'vlm-analysis-prompting').style.display = detectorType === 'verify' ? 'none' : '';
            applyVlmModelChoicesForDetector(root, detectorType);
            applyStagePlaceholdersForDetector(root, detectorType);
            updateVerifyGateLine(root);
            VIF.fieldRegistry.fields.forEach(function(entry) {
                const groupEl = entry.group && field(root, entry.group);
                if (groupEl) groupEl.style.display = entry.detectors.indexOf(detectorType) !== -1 ? 'flex' : 'none';
            });
        }

        function toggleDetectorSection() {
            const detectorTypeSelect = document.getElementById('cfg-detector-type');
            const detectorType = detectorTypeSelect.value;
            const useTranscoder = document.getElementById('cfg-use-transcoder').checked;

            if (detectorType === 'chain') ensureChain();
            toggleSections(sectionsRoot, detectorType);
            // The chain builder sits outside the standalone sections, so toggleSections misses it.
            document.getElementById('chain-pipeline-section').style.display = detectorType === 'chain' ? '' : 'none';
            hostPanelsInChain(detectorType === 'chain');

            VIF.fieldRegistry.fields.forEach(function(entry) {
                if (entry.group && !field(sectionsRoot, entry.group)) {
                    let visible = entry.detectors.indexOf(detectorType) !== -1;
                    // cfg-inference-fps-group / cfg-frame-grab-group also gate on Use
                    // Transcoder (synthetic taps the source H.264 directly - no transcode, no
                    // JPEG sampling or keyframe thumbnailing - so neither control applies
                    // there regardless of the checkbox, which `detectors` above already
                    // excludes synthetic from). A type that never runs live has no frame source
                    // to choose, so the gate does not speak for it either.
                    if (VIF.fieldRegistry.runsLive(detectorType)) {
                        if (entry.transcoderGate === 'on') visible = visible && useTranscoder;
                        if (entry.transcoderGate === 'off') visible = visible && !useTranscoder;
                    }
                    const groupEl = document.getElementById(entry.group);
                    if (groupEl) groupEl.style.display = visible ? 'flex' : 'none';
                }
                if (entry.rule && entry.rule.byDetector) {
                    FIELD_RULES[entry.id] = VIF.fieldRegistry.effectiveRule(entry, detectorType);
                    applyNumericRuleToInput(document.getElementById(entry.id), FIELD_RULES[entry.id]);
                }
                if (entry.help) {
                    showDetectorHelp(entry.help.prefix, detectorType, entry.help.detectors);
                }
            });

            if (activeListenerName && eventListenersData[activeListenerName]) {
                const current = eventListenersData[activeListenerName];
                updateEventMethodOptions(current.class_name, current.methods);
                updatePropertiesVisibility();
            }
            if (detectorType === 'chain') applyChainCaptureGroups();
            updateSyntheticOverlayWarning();
            updateVlmImagesMeter();
            detectorTypeSelect.dataset.previousValue = detectorType;
        }

        document.getElementById('cfg-duration').addEventListener('input', updateVlmImagesMeter);
        document.getElementById('cfg-inference-fps').addEventListener('input', updateVlmImagesMeter);

        document.getElementById('cfg-vi-service-api-key').addEventListener('input', function() {
            syncApiKeyToggleState('cfg-vi-service-api-key', 'cfg-vi-service-api-key-toggle');
        });
        syncApiKeyToggleState('cfg-vi-service-api-key', 'cfg-vi-service-api-key-toggle');

        syncSectionApiKeyToggle(sectionsRoot, 'cfg-synthetic-api-key', 'cfg-synthetic-api-key-toggle');
        updateSyntheticEndpointFields(sectionsRoot);
        syncSectionApiKeyToggle(sectionsRoot, 'cfg-vlm-api-key', 'cfg-vlm-api-key-toggle');
        window.testSvdEndpoint = onStandaloneSections(testSvdEndpoint);

        document.getElementById('cfg-detector-type').addEventListener('change', async function() {
            syncListenerFields();
            const previousDetectorType = this.dataset.previousValue || '';
            const nextDetectorType = this.value;

            if (nextDetectorType && previousDetectorType && nextDetectorType !== previousDetectorType) {
                await preloadConfiguredListenerSchemas();
                // Only a listener whose TYPE has no meaning for the target detector still
                // blocks: an ObjectTracking cannot become something a VLM stream can use.
                // A method that the target does not allow is not a conflict any more -- the
                // listeners follow the detector, and the operator is told what moved.
                const conflicts = getDetectorTypeSwitchConflicts(nextDetectorType).filter(function(conflict) {
                    return conflict.typeNotApplicable;
                });
                if (conflicts.length > 0) {
                    this.value = previousDetectorType;
                    toggleDetectorSection();
                    showStatus(buildDetectorTypeSwitchConflictMessage(nextDetectorType, conflicts), true);
                    alert(buildDetectorTypeSwitchConflictDialogMessage(nextDetectorType, conflicts));
                    return;
                }
                const adjusted = adjustListenerMethodsForDetector(nextDetectorType);
                if (adjusted.length > 0) {
                    showStatus('Switched to ' + nextDetectorType + ' analysis. '
                        + adjusted.map(function(change) {
                            return change.name + ' moved from ' + formatEventMethodLabel(change.from)
                                + ' to ' + formatEventMethodLabel(change.to);
                        }).join('; ') + '. Save to keep it.', false);
                }
            }

            applyDetectorTypeInferenceFpsSuggestion(nextDetectorType);
            applyDetectorTypeTranscoderSuggestion(nextDetectorType);
            applyDetectorTypeDurationSuggestion(nextDetectorType);
            applyDetectorTypeApplicationSuggestion(nextDetectorType);
            applyDetectorTypeStreamNameSuggestion(nextDetectorType);
            applyDetectorTypeStageFieldSuggestions(nextDetectorType);
            startSyntheticStrictness(nextDetectorType);
            toggleDetectorSection();
            markDirty();
        });

        document.getElementById('cfg-inference-video-height-mode').addEventListener('change', function() {
            const customInput = document.getElementById('cfg-inference-video-height-custom');
            customInput.style.display = this.value === 'custom' ? '' : 'none';
            if (this.value !== 'custom') customInput.value = '';
            document.getElementById('cfg-use-transcoder-warning').style.display = 'block';
            markDirty();
        });

        document.getElementById('cfg-use-transcoder').addEventListener('change', function() {
            toggleDetectorSection();
            document.getElementById('cfg-use-transcoder-warning').style.display = 'block';
            markDirty();
        });



        document.getElementById('cfg-frame-grab').addEventListener('input', function() {
            document.getElementById('cfg-use-transcoder-warning').style.display = 'block';
        });

        // Good news and notes ride the toast, which never moves the page; an error stays in the
        // bar under the stream picker until the next action, so there is time to read it.
        function showStatus(message, isError) {
            if (!isError) {
                hideStatus();
                VIF.core.toast(message);
                return;
            }
            const el = document.getElementById('status-message');
            if (!el) return;
            if (statusHideTimer) clearTimeout(statusHideTimer);
            if (statusClearTimer) clearTimeout(statusClearTimer);
            el.textContent = message;
            el.className = 'visible error';
            statusIsSticky = true;
        }

        // Stays until the next save attempt or config switch, like an error, without saying one happened.
        function showStickyNote(message) {
            const el = document.getElementById('status-message');
            if (!el) return;
            if (statusHideTimer) clearTimeout(statusHideTimer);
            if (statusClearTimer) clearTimeout(statusClearTimer);
            el.textContent = message;
            el.className = 'visible note';
            statusIsSticky = true;
        }

        function hideStatus() {
            const el = document.getElementById('status-message');
            statusIsSticky = false;
            saveRefused = false;
            if (!el) return;
            if (statusHideTimer) clearTimeout(statusHideTimer);
            if (statusClearTimer) clearTimeout(statusClearTimer);
            el.classList.remove('visible');
            statusClearTimer = setTimeout(() => {
                el.className = '';
                el.textContent = '';
            }, 240);
        }

        // hideStatus keeps the old text for the 240ms fade - right for a
        // dismissal, wrong after a successful save, where a stale validation
        // error must not outlive the success toast even for a blink.
        function clearStatusNow() {
            hideStatus();
            const el = document.getElementById('status-message');
            if (el) { el.className = ''; el.textContent = ''; }
        }

        async function getConfig() {
            const resource = getSelectedResource();
            if (!resource) return;
            setFormLoading(true);
            try {
                suppressDirtyTracking = true;
                populateForm(await readConfig(resource));

            } catch (error) {
                console.error("Error fetching config:", error);
                showStatus(`Error loading config: ${error.message}`, true);
            } finally {
                setFormLoading(false);
                suppressDirtyTracking = false;
                updateIncomingStreamPanelState();
            }
        }

        // A chain's destination set to a method its results can't use, in the words of where to fix it.
        function chainDestinationMethodWarnings(config) {
            const listeners = config.vif_event_listeners || {};
            const warnings = [];
            Object.keys(listeners).forEach(function(name) {
                const listener = listeners[name] || {};
                const allowed = getAllowedEventMethodValues(listener.class_name || '', 'chain');
                const instead = EVENT_METHOD_OPTIONS.filter(function(option) {
                    return option.value !== 'disabled' && allowed.includes(option.value);
                }).map(function(option) { return option.label; });
                const switchTo = instead.length ? ' Switch it to ' + instead.join(' or ') + ' under Where detections go.' : '';
                (Array.isArray(listener.methods) ? listener.methods : []).forEach(function(method) {
                    const value = String(method || '').toLowerCase();
                    if (!value || allowed.includes(value)) return;
                    warnings.push(value === 'rollup'
                        ? '“' + name + '” is set to Rollup, which only collects object and movement results, so it sends nothing for this chain.' + switchTo
                        : '“' + name + '” is set to ' + formatEventMethodLabel(value) + ', which this chain’s results can’t use.' + switchTo);
                });
            });
            return warnings;
        }

        function toastChainWarnings(config) {
            const warnings = (chainState ? chainProblems().warnings
                : VIF.chainEditor.validateChain(VIF.chainEditor.initChain(config.chain_detector)).warnings).map(chainWarningText)
                .concat(chainDestinationMethodWarnings(config));
            if (warnings.length) VIF.core.toast('Saved with warnings: ' + distinctLines(warnings).join(' '), 'warn');
        }

        function clearNvcfFieldsOffNvcf(root) {
            if (syntheticEndpointIsNvcf(root)) return;
            field(root, 'cfg-synthetic-api-key').value = '';
            syncSectionApiKeyToggle(root, 'cfg-synthetic-api-key', 'cfg-synthetic-api-key-toggle');
            field(root, 'cfg-synthetic-function-id').value = '';
        }

        // Why a save was refused, in one line. A chain's own problems are already listed under its
        // chip, so the line points there rather than repeating them.
        function saveRefusalText(config) {
            const errors = collectValidationErrors(config);
            if (config.detector_type !== 'chain') return errors.join(' ');
            const inChain = chainBuilderErrors(config);
            const rest = errors.filter(function(error) { return inChain.indexOf(error) === -1; });
            // With no steps yet there is no problem chip to point to.
            const stages = (config.chain_detector || {}).stages || [];
            if (inChain.length && stages.length === 0) {
                rest.unshift('Can’t save yet: the model chain has no steps. Choose what you want to detect, or add a step, to set it up.');
            } else if (inChain.length) {
                const chip = '✗ ' + inChain.length + (inChain.length === 1 ? ' problem' : ' problems');
                rest.unshift('Can’t save yet: the model chain has ' + inChain.length + (inChain.length === 1 ? ' problem' : ' problems')
                    + '. Click ' + chip + ' at the top of the model chain to see ' + (inChain.length === 1 ? 'it' : 'them') + '.');
            }
            return rest.join(' ');
        }

        // An Engine refusal the form can fix, in the form's words; null for any other.
        function engineRefusalText(message) {
            const missingClass = /decision_listener\.class_name is not available on this Engine: ([\w.$]+[\w$])/.exec(message || '');
            if (missingClass) {
                return 'Can’t save yet: Streaming Engine doesn’t have your code’s class ' + missingClass[1]
                    + '. Check Class name under Your code, or put the class’s JAR in Streaming Engine’s lib folder and restart Streaming Engine.';
            }
            return null;
        }

        // After a refused save, every edit checks again: the bar follows what is still wrong and
        // goes away once nothing is.
        function recheckSaveRefusal() {
            if (!saveRefused) return;
            const config = buildConfigJson();
            if (!config) return;
            const text = saveRefusalText(config);
            if (text) {
                showStatus(text, true);
                saveRefused = true;
            } else {
                hideStatus();
            }
        }

        async function saveConfig() {
            saveRefused = true;
            const config = buildConfigJson();
            if (!config) return;
            const refusal = saveRefusalText(config);
            if (refusal) {
                showStatus(refusal, true, true);
                return;
            }
            // Only another save attempt clears a sticky validation error, so drop it here
            // rather than waiting for this save's own status message.
            hideStatus();

            const isNew = isNewStream();
            const resource = isNew ? null : getSelectedResource();
            if (!isNew && !resource) return;

            setFormLoading(true);
            try {
                setSavingState(true);
                const persist = VIF.core.client().persist;
                const secrets = collectSecrets(config);
                let savedDocument = null;
                if (isNew) {
                    if (copiedPriority !== null) config.priority_id = copiedPriority;
                    addCopiedLimits(config);
                    await persist.streamGroupConfigs.create(VIF.v2map.groupFromFlat(config, { secrets: secrets }));
                } else {
                    // The listener map the form was populated with: a name it no longer
                    // holds has to ride as an explicit null for the merge to remove it.
                    const previousListeners = lastRawStreamConfig && lastRawStreamConfig.vif_event_listeners;
                    const patch = VIF.v2map.groupPatchFromV1(config,
                        { previousListeners: previousListeners, secrets: secrets });
                    // The re-read inside the attempt is what carries a fresh revision, so
                    // a lost race retries once.
                    savedDocument = await VIF.core.withConflictRetry(async function() {
                        if (resource.kind === 'override') {
                            const override = persist.streams.ref(resource.app, resource.stream);
                            await override.get();
                            return override.update(patch);
                        }
                        await persist.streamGroupConfigs.get(resource.name);
                        return persist.streamGroupConfigs.update(resource.name, patch);
                    });
                }

                // Success rides the shared toast; a sticky validation banner from
                // before the save still needs the explicit clear.
                clearStatusNow();
                VIF.core.toast(isNew ? 'Stream config created successfully' : 'Config saved successfully');
                if (config.detector_type === 'chain') toastChainWarnings(config);
                lockListenerTypesAfterSave();
                markClean(true);
                if (!isNew && config.detector_type === 'chain') rebaseChainStored();
                // Verify probes by reference against what is stored, so the snapshot follows the
                // save — from the document the write answered, and only while it is still shown.
                if (!isNew && savedDocument && getSelectedResource() === resource) {
                    rememberStoredSections(resource.kind === 'override'
                        ? VIF.v2map.flatFromOverride(resource.app, resource.stream, savedDocument)
                        : VIF.v2map.flatFromGroup(savedDocument));
                }

                // A committed save with a non-NVCF endpoint dropped the NVCF credentials from
                // the config (nulled + unset in buildConfigJson); clear them from the form too
                // so the secrets don't linger hidden in the DOM.
                if (document.getElementById('cfg-detector-type').value === 'synthetic') clearNvcfFieldsOffNvcf(sectionsRoot);
                if (config.detector_type === 'chain') {
                    Object.keys(chainCards).forEach(function(uid) {
                        if (chainCards[uid].type === 'synthetic') clearNvcfFieldsOffNvcf(chainCards[uid].root);
                    });
                }

                if (isNew) {
                    const newValue = `${config.app_name}::${config.stream_name}`;
                    await loadStreams(newValue);
                }

            } catch (error) {
                // A 409: in practice a create whose name/pattern is already taken.
                // Surface a clear message rather than the raw error.
                if (VIF.sdk && error instanceof VIF.sdk.ConflictError) {
                    showStatus('Stream configuration already exists', true);
                    return;
                }
                console.error("Error saving config:", error);
                showStatus(engineRefusalText(error.message) || `Error saving config: ${error.message}`, true);
            } finally {
                setSavingState(false);
                setFormLoading(false);
            }
        }

        async function deleteConfig() {
            const stream = getSelectedStream();
            if (!stream) return;

            if (!confirm(`Delete stream config "${stream.appName} / ${stream.streamName}"?\n\nThis cannot be undone.`)) return;

            const resource = getSelectedResource();
            if (!resource) return;

            try {
                const persist = VIF.core.client().persist;
                // A delete quotes a revision too, so the attempt re-reads for a fresh one
                // and a lost race retries once.
                await VIF.core.withConflictRetry(async function() {
                    if (resource.kind === 'override') {
                        const override = persist.streams.ref(resource.app, resource.stream);
                        await override.get();
                        return override.delete();
                    }
                    await persist.streamGroupConfigs.get(resource.name);
                    return persist.streamGroupConfigs.delete(resource.name);
                });

                clearStatusNow();
                VIF.core.toast('Stream config deleted successfully');
                markClean(false);
                await loadStreams();

            } catch (error) {
                console.error("Error deleting config:", error);
                showStatus(`Error deleting config: ${error.message}`, true);
            }
        }

        if (!window.__vifStreamConfigGlobalBindings) {
            window.addEventListener('beforeunload', function(e) {
                if (!window.__vifStreamConfigUnsaved || !window.__vifStreamConfigUnsaved()) return;
                e.preventDefault();
                e.returnValue = '';
            });

            // The Manager swaps pages in place, so leaving through its menus never unloads this
            // one: ask before any click that would load another page.
            const LEAVES_PAGE = /\b(loadAjax\w*|loadApplication\w*|loadNewApplication\w*|signOut)\s*\(/;
            document.addEventListener('click', function(e) {
                if (!window.__vifStreamConfigUnsaved || !window.__vifStreamConfigUnsaved()) return;
                const target = e.target.closest('a, button, [onclick]');
                if (!target) return;
                const href = target.tagName === 'A' ? (target.getAttribute('href') || '') : '';
                const script = (target.getAttribute('onclick') || '') + ' ' + href;
                const external = target.getAttribute('target') === '_blank';
                const otherPage = href !== '' && href.charAt(0) !== '#' && !/^javascript:/i.test(href) && !external;
                // The left menu binds its clicks in script, so its entries are known by class.
                const menuEntry = target.classList.contains('vif-nav-item') && !target.classList.contains('vif-nav-group-head')
                    && !target.classList.contains('is-active');
                if (!LEAVES_PAGE.test(script) && !otherPage && !menuEntry) return;
                if (window.confirm('You have unsaved changes. Leave without saving?')) return;
                e.preventDefault();
                e.stopImmediatePropagation();
            }, true);

            ['focus', 'mousedown'].forEach(function(type) {
                document.addEventListener(type, function(e) {
                    if (e.target && e.target.id === 'cfg-stream-select' && window.__vifStreamPickerBefore == null) {
                        window.__vifStreamPickerBefore = e.target.value;
                    }
                }, true);
            });
            document.addEventListener('blur', function(e) {
                if (e.target && e.target.id === 'cfg-stream-select') {
                    setTimeout(function() { window.__vifStreamPickerBefore = null; }, 0);
                }
            }, true);


            window.addEventListener('scroll', function() {
                if (!isStreamConfigMounted()) return;
                updateIncomingStreamPanelState();
            }, { passive: true });

            window.addEventListener('resize', function() {
                if (!isStreamConfigMounted()) return;
                updateIncomingStreamPanelState();
            });

            document.addEventListener('input', function(e) {
                if (!isStreamConfigMounted()) return;
                if (e.target.closest('#evt-properties-fields')) return;
                if (e.target.id === 'evt-confidence') return;
                if (e.target.id === 'evt-suppress-empty-detections') return;
                if (shouldIgnoreGlobalDirtyTracking(e.target)) return;
                markDirty();
            });

            document.addEventListener('change', function(e) {
                if (!isStreamConfigMounted()) return;
                if (e.target.closest('#evt-properties-fields')) return;
                if (shouldIgnoreGlobalDirtyTracking(e.target)) return;
                markDirty();
            });

            // Bound once, so it reaches the mounted page's own check through the window.
            ['input', 'change'].forEach(function(type) {
                document.addEventListener(type, function() {
                    if (isStreamConfigMounted() && window.__vifRecheckSaveRefusal) window.__vifRecheckSaveRefusal();
                });
            });

            window.__vifStreamConfigGlobalBindings = true;
        }

        window.onStreamSelected = onStreamSelected;
        window.updateVerifyGateLine = onStandaloneSections(updateVerifyGateLine);
        window.updateMatchOverlapNote = updateMatchOverlapNote;
        window.saveConfig = saveConfig;
        window.newConfig = newConfig;
        window.cloneConfig = cloneConfig;
        window.downloadConfig = downloadConfig;
        window.uploadConfigFile = uploadConfigFile;
        window.deleteConfig = deleteConfig;
        window.togglePanel = togglePanel;
        window.toggleCheckpointPath = onStandaloneSections(toggleCheckpointPath);
        window.updateClassNamesOptions = onStandaloneSections(updateClassNamesOptions);
        window.toggleByteTrack = onStandaloneSections(toggleByteTrack);
        window.toggleTiling = onStandaloneSections(toggleTiling);
        window.toggleTilingMode = onStandaloneSections(toggleTilingMode);
        window.toggleFullFrameDetection = onStandaloneSections(toggleFullFrameDetection);
        window.toggleVlmMode = onStandaloneSections(toggleVlmMode);
        window.addVlmClassRow = onStandaloneSections(addVlmClassRow);
        window.addClassRow = onStandaloneSections(addClassRow);
        window.updateVlmCustomLint = onStandaloneSections(updateVlmCustomLint);
        window.toggleVlmAdvanced = onStandaloneSections(toggleVlmAdvanced);
        window.toggleSyntheticTlsCerts = onStandaloneSections(toggleSyntheticTlsCerts);
        window.toggleVisServiceApiKeyVisibility = toggleVisServiceApiKeyVisibility;
        window.clearVisServiceApiKey = clearVisServiceApiKey;
        window.toggleSyntheticApiKeyVisibility = onStandaloneSections(toggleSyntheticApiKeyVisibility);
        window.toggleVlmApiKeyVisibility = onStandaloneSections(toggleVlmApiKeyVisibility);
        // The in-template slots go through SECTION_HANDLERS; these page-scoped wrappers
        // serve the one slot outside the sections, the VIS service key.
        window.secretSourceChanged = function(base) { secretSourceChanged(null, base); };
        window.promptStoreSecret = function(base) { promptStoreSecret(null, base); };
        window.cancelStoreSecret = function(base) { cancelStoreSecret(null, base); };
        window.confirmStoreSecret = function(base) { confirmStoreSecret(null, base); };
        window.toggleVlmModelNameOther = onStandaloneSections(toggleVlmModelNameOther);
        window.testVlmEndpoint = onStandaloneSections(testVlmEndpoint);

        // (c) cross-file: exposed because vif-listeners.js's applyTextRuleToInput()/
        //     renderScalarField() and vlm-schema-builder.js (markDirty) call these
        //     directly. (updateVlmCustomLint is also markup-exposed above.)
        //     getSelectedResource is how vif-listeners.js's webhook test button names the
        //     listener it fires - by the app and stream the selected document is keyed by,
        //     which is the only place that pairing is known. It guards with `typeof`,
        //     since the listener panel is a subsystem and this page is one of its hosts.
        window.markDirty = markDirty;
        window.isValidCssColor = isValidCssColor;
        window.applyNumericRuleToInput = applyNumericRuleToInput;
        window.getSelectedResource = getSelectedResource;

        // Spec-facing API (plan P2-T3 sub-step 4): the qa_automation baseline
        // specs and baselines.cjs prepare scripts call these four via
        // VIF.streamConfig.* - their permanent home. (The temporary bare
        // window.* aliases the Phase-1 specs used were removed here once the
        // paired spec migration to the namespaced form landed.)
        VIF.streamConfig.toggleDetectorSection = toggleDetectorSection;
        VIF.streamConfig.buildConfigJson = buildConfigJson;
        VIF.streamConfig.collectValidationErrors = collectValidationErrors;
        VIF.streamConfig.populateForm = populateForm;
        VIF.streamConfig.chainStageTypes = chainStageTypes;
        VIF.streamConfig.chainSentStepTypes = chainSentStepTypes;
        VIF.streamConfig.chainSendsEveryStep = function() { return !!chainState && chainState.resultMode === 'combined'; };

        // vif-listeners.js's own init() sets up the listener-subsystem state
        // (eventListenersData/activeListenerName) and DOM bindings (evt-class-name,
        // evt-methods, evt-confidence, ...) that toggleDetectorSection()/
        // updateListenerTip()/loadStreams() below all reach into.
        VIF.listeners.init();

        // Initialize
        console.log(`VIF ${new Date().toISOString().slice(0, 10)}`);

        var tilingEnableGroupEl = field(sectionsRoot, 'tiling-enable-group');
        var tilingUiEnabled = new URLSearchParams(window.location.search).get('tiling') === 'true';
        if (tilingUiEnabled) tilingEnableGroupEl.style.display = '';

        initializeStaticFieldRules(sectionsRoot);
        initializeStaticFieldTooltips();
        watchSecretInputs(sectionsRoot, function() { return touchedSecrets; });
        loadSecretNames();
        toggleByteTrack(sectionsRoot);
        toggleCheckpointPath(sectionsRoot);
        toggleTiling(sectionsRoot);
        toggleDetectorSection();
        updateListenerTip('', '');
        markClean();
        updateDirtyIndicator();
        updateSaveButtonState();
        updateIncomingStreamPanelState();

        // F18 fix: await the VLM modules before the one call below that can reach
        // resetForm() (loadStreams() -> onStreamSelected() -> populateForm() directly
        // for a new stream, or -> getConfig() -> populateForm() for an existing one).
        // If the modules fail to load (e.g. a 404), log it and proceed anyway - the
        // typeof guard in resetForm() covers the rest; a missing VLM helper module
        // must not hard-brick the page.
        try {
            await vlmModulesPromise;
        } catch (error) {
            console.error('Error loading VLM helper modules:', error);
        }
        loadStreams();
    };
})();
