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
        var VLM_MODEL_OPTIONS = VIF.fieldRegistry.VLM_MODEL_OPTIONS;
        var VLM_KNOWN_MODELS = VLM_MODEL_OPTIONS.map(function(o) { return o.value; });
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
            { on: 'input', matches: byId('cfg-synthetic-endpoint'), run: function(root) { updateSyntheticEndpointFields(root); } },
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
            return null;
        }

        function dispatchSectionEvent(event) {
            const root = event.currentTarget;
            const prefix = sectionPrefix(root);
            SECTION_HANDLERS.forEach(function(handler) {
                if (handler.on !== event.type) return;
                for (let el = event.target; el && el !== root; el = el.parentElement) {
                    if (handler.matches(el, prefix)) {
                        handler.run(root, el, event);
                        return;
                    }
                }
            });
        }

        function addVlmModelOptions(select) {
            const otherOption = select.querySelector('option[value="' + VLM_MODEL_OTHER + '"]');
            VLM_MODEL_OPTIONS.forEach(function(o) {
                const option = document.createElement('option');
                option.value = o.value;
                option.textContent = o.label;
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
            if (target.id === 'cfg-stream-select' || target.id === 'evt-listener-select') return true;
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
            const selectors = '.two-column input, .two-column select, .two-column textarea, .two-column button';
            document.querySelectorAll(selectors).forEach(function(el) {
                el.disabled = loading;
            });
            ['btn-save-top', 'btn-clone-top', 'btn-delete-top'].forEach(function(id) {
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
            if (show && !field(root, 'cfg-bt-min-confidence').value) {
                const btMinConfidence = field(root, 'cfg-bt-min-confidence');
                const btMaxLostFrames = field(root, 'cfg-bt-max-lost-frames');
                const btMinOverlap = field(root, 'cfg-bt-min-overlap');
                const btMinFrames = field(root, 'cfg-bt-min-frames');
                btMinConfidence.value = btMinConfidence.placeholder || '50';
                btMaxLostFrames.value = btMaxLostFrames.placeholder || '30';
                btMinOverlap.value = btMinOverlap.placeholder || '20';
                btMinFrames.value = btMinFrames.placeholder || '3';
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

        function resetNewStreamMatchFields() {
            const appInput = document.getElementById('cfg-new-app-name');
            const streamInput = document.getElementById('cfg-new-stream-name');
            appInput.placeholder = 'live';
            delete appInput.dataset.suggested;
            appInput.value = 'live';
            delete streamInput.dataset.suggested;
            streamInput.value = '';

            window.requestAnimationFrame(function() {
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
            }
            return seed;
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
                'cfg-synthetic-function-id': sy.function_id || '',
                'cfg-synthetic-classification-threshold': number(sy.classification_threshold)
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
            const endpoint = field(root, 'cfg-synthetic-endpoint');
            endpoint.placeholder = sy.endpoint || 'svd.docker:8001';
            endpoint.dataset.globalDefault = sy.endpoint || '';
            updateSyntheticEndpointFields(root);
            const url = field(root, 'cfg-vlm-endpoint-url');
            const effectiveUrl = va.endpoint_url || VLM_FALLBACK_DEFAULTS.endpoint_url;
            url.placeholder = effectiveUrl ? vlmEndpointPlaceholder(effectiveUrl) : 'vlm.docker:8000';
            const timeout = field(root, 'cfg-vlm-request-timeout');
            timeout.placeholder = va.request_timeout_seconds !== undefined && va.request_timeout_seconds !== null
                ? String(va.request_timeout_seconds) : '30';
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
                // No fallback and no default value to show: the placeholder already reads
                // "inherited from default config", and what this entry is for is
                // collectUnsetFields() — a blanked VIS URL has to travel as the null that
                // clears it, or the stored one survives a save that cleared the field.
                'cfg-vi-service-url': {
                    path: 'vi_service_url', fallback: '',
                    value: (defaultConfig && defaultConfig.vi_service_url) || null
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
                    value: Number.isFinite(defaultConfig && defaultConfig.log_max_messages) ? defaultConfig.log_max_messages : null
                },
                'cfg-log-timing': {
                    path: 'log_timing', fallback: '0',
                    value: Number.isFinite(defaultConfig && defaultConfig.log_timing) ? defaultConfig.log_timing : null
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
            const effective = endpointInput.value.trim() || (endpointInput.dataset.globalDefault || '');
            return /(^|\.)nvcf\.nvidia\.com(:\d+)?$/i.test(effective);
        }

        function updateSyntheticEndpointFields(root) {
            const nvcfFields = field(root, 'synthetic-nvcf-fields');
            const mtlsHint   = field(root, 'synthetic-mtls-hint');
            const tlsCerts   = field(root, 'synthetic-tls-certs-group');
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
            const persist = VIF.core.client().persist;
            if (resource.kind === 'override') {
                const override = await persist.streams.get(resource.app, resource.stream);
                // The facade answers null for an override that is gone; the dropdown
                // listed it, so here that is an error to show, not a layer to inherit.
                if (override === null) {
                    throw new VIF.sdk.NotFoundError(
                        `Stream ${resource.app}/${resource.stream} has no override any more`, 404, null);
                }
                return VIF.v2map.flatFromOverride(resource.app, resource.stream, override);
            }
            return VIF.v2map.flatFromGroup(await persist.streamGroupConfigs.get(resource.name));
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

        function onStreamSelected() {
            hideStatus();
            const newFields = document.getElementById('new-stream-fields');
            const deleteBtnTop = document.getElementById('btn-delete-top');
            const cloneBtnTop = document.getElementById('btn-clone-top');
            const listenersPanel = document.querySelector('.event-listeners-panel');
            const select = document.getElementById('cfg-stream-select');
            storeSelectedStreamValue(select ? select.value : '');
            if (isNewStream()) {
                newFields.style.display = 'block';
                deleteBtnTop.style.display = 'none';
                cloneBtnTop.style.display = 'none';
                listenersPanel.style.display = '';
                suppressDirtyTracking = true;
                const hintedType = takeNewConfigDetectorTypeHint();
                populateForm(newConfigSeed(hintedType));
                // A new stream leaves VIS URL/API key blank so they inherit from the default
                // config at runtime, rather than baking a copy of the current global values into
                // the stream's own config. populateForm(defaultConfig) above filled them in from
                // the global defaults, so clear them back to blank (their placeholders already read
                // "inherited from default config").
                document.getElementById('cfg-vi-service-url').value = '';
                document.getElementById('cfg-vi-service-api-key').value = '';
                syncApiKeyToggleState('cfg-vi-service-api-key', 'cfg-vi-service-api-key-toggle');
                resetNewStreamMatchFields();
                updateMatchOverlapNote();
                applySuggestedDefaultsForNewStream(sectionsRoot);
                suppressDirtyTracking = false;
                document.getElementById('cfg-detector-type').value = hintedType || 'object';
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
            newFields.style.display = 'none';
            deleteBtnTop.style.display = 'inline-block';
            cloneBtnTop.style.display = 'inline-block';
            const stream = getSelectedStream();
            if (!stream) return;
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
                const select = document.getElementById('cfg-stream-select');
                select.value = '__new__';
                onStreamSelected();
                populateForm(Object.assign({}, config, { active: true }));
                document.getElementById('cfg-new-app-name').value = config.app_name || stream.appName || '';
                document.getElementById('cfg-new-stream-name').value = '';
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
                function_id: nvcf ? value('cfg-synthetic-function-id') : ''
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
                showSvdEndpointTestResult(root, 'error').textContent = '✗ No SVD endpoint configured';
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

        function renderSvdEndpointTestOutcome(root, result, endpoint) {
            if (result.reachable && result.accepted) {
                showSvdEndpointTestResult(root, 'ok').textContent = `✓ Reachable — an SVD service answered at ${endpoint} and accepted the credentials`;
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
                showVlmEndpointTestResult(root, 'error').textContent = '✗ No VLM endpoint configured';
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
                    api_key: field(root, 'cfg-vlm-api-key').value || null,
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
                errors.push('Log Max Messages must be a whole number between 0 and 1000.');
            }

            if (config.log_timing !== undefined && config.log_timing !== null
                && (!Number.isFinite(config.log_timing) || config.log_timing < 0 || config.log_timing > 60 || !Number.isInteger(config.log_timing))) {
                errors.push('Log Timing must be a whole number between 0 and 60.');
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
                errors.push('Temperature must be between 0 and 2.');
            }

            if (config.vlm_analysis && config.vlm_analysis.max_tokens !== undefined && config.vlm_analysis.max_tokens !== null
                && (!Number.isFinite(config.vlm_analysis.max_tokens) || !Number.isInteger(config.vlm_analysis.max_tokens)
                    || config.vlm_analysis.max_tokens < 1 || config.vlm_analysis.max_tokens > 4096)) {
                errors.push('Max Tokens must be a whole number between 1 and 4096.');
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
                    errors.push('VIS URL must be a valid URL including the scheme, e.g. wss://host:5001/ws/stream/, or left blank to inherit the default.');
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
                        errors.push('Detect Low/Medium reasoning level requires at least one class.');
                    }
                    if (va.reasoning_level === 'medium') {
                        for (const cn of classes) {
                            if (String(cn).trim().toLowerCase() === 'scene') {
                                errors.push('A class cannot be named "scene" at Medium reasoning level (it collides with the internal scene field). Rename the class or use another level.');
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
                    errors.push('The scoring endpoint is required (gRPC host:port). Set it here, or in the Verify baseline of the Stream Config Defaults.');
                } else if (sy.endpoint && /^https?:\/\//i.test(sy.endpoint)) {
                    errors.push('The scoring endpoint must be a gRPC host:port (e.g. svd.docker:8001), not an http(s) URL.');
                }
                if (!!sy.tls_client_cert !== !!sy.tls_client_key) {
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
                // Effective endpoint (the field shows stream value layered over the json default),
                // so an empty endpoint here means neither the stream nor the global default set one.
                if (!sy.endpoint) {
                    errors.push('Synthetic endpoint is required (gRPC host:port). Set it here or as a global synthetic_analysis.endpoint default in video-intelligence.json.');
                } else if (/^https?:\/\//i.test(sy.endpoint)) {
                    errors.push('Synthetic endpoint must be a gRPC host:port (e.g. svd.docker:8001), not an http(s) URL.');
                }
                if (sy.classification_threshold !== null && sy.classification_threshold !== undefined
                    && (!Number.isFinite(sy.classification_threshold) || sy.classification_threshold < 0 || sy.classification_threshold > 1)) {
                    errors.push('Synthetic classification threshold must be between 0.0 and 1.0.');
                }
                if (!!sy.tls_client_cert !== !!sy.tls_client_key) {
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
                listenerMethods.forEach(function(method) {
                    if (method && !allowedMethods.includes(method)) {
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

                const endpointInput = field(root, 'cfg-synthetic-endpoint');
                if (sy.endpoint) endpointInput.value = sy.endpoint;
                if (globalSy.endpoint) endpointInput.placeholder = globalSy.endpoint;
                endpointInput.dataset.globalDefault = globalSy.endpoint || '';
                updateSyntheticEndpointFields(root);

                // use_tls is a tri-state <select> ('' auto-detect / true / false), not a
                // text/number input - it has no placeholder to show an effective default
                // in, so an unset stream value leaves it on '' (auto-detect), same as before.
                if (typeof sy.use_tls === 'boolean') {
                    field(root, 'cfg-synthetic-use-tls').value = String(sy.use_tls);
                }

                // Stream value in the field, global default as its placeholder (endpoint
                // pattern); auto-expand the disclosure when any TLS material is in effect.
                let anyTlsCert = false;
                [['cfg-synthetic-tls-ca-cert', 'tls_ca_cert'],
                 ['cfg-synthetic-tls-client-cert', 'tls_client_cert'],
                 ['cfg-synthetic-tls-client-key', 'tls_client_key']].forEach(function(pair) {
                    const input = field(root, pair[0]);
                    if (sy[pair[1]]) input.value = sy[pair[1]];
                    if (globalSy[pair[1]]) input.placeholder = globalSy[pair[1]];
                    if (sy[pair[1]] || globalSy[pair[1]]) anyTlsCert = true;
                });
                setSyntheticTlsCertsExpanded(root, anyTlsCert);

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
                document.getElementById('cfg-use-transcoder').checked = true;
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

        var CHAIN_STAGE_LABELS = { object: 'Object', scene: 'Scene', vlm: 'VLM', synthetic: 'Synthetic', motion: 'Motion' };
        var FRAME_SELECTION_LABELS = {
            all: 'All frames', first: 'First frame', middle: 'Middle frame', last: 'Last frame', every_nth: 'Every Nth frame'
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
            'crop-min-confidence': { min: 0, max: 100, decimals: 1, label: 'Min Confidence %' },
            'crop-padding': { min: 0, max: 100, decimals: 1, label: 'Padding %' },
            'crop-max': { min: 1, max: 256, integer: true, label: 'Max Crops' },
            'frame-stride': { min: 2, max: 1000, integer: true, label: 'Every Nth' }
        };
        var CROP_WHY = 'Tracking and tiling stay off while this stage crops: each crop is analyzed on its own.';

        function chainTrackingWhy(blocker) {
            const cause = {
                entry: 'the ' + blocker.type + ' entry filters which frames reach this stage',
                clip: 'a synthetic stage fixes the chain to clip windows',
                window: 'the ' + blocker.type + ' stage gives the chain a multi-frame cadence and only the entry stage sees every window',
                dynamic: 'a dynamic chain may revisit this stage and re-feed the tracker the same window',
                selection: 'frame selection on this stage thins the frames the tracker must see',
                route: 'a route re-enters this stage, re-feeding the tracker the same window'
            }[blocker.reason];
            return 'ByteTrack needs every captured frame to reach this stage exactly once, but ' + cause + '.';
        }
        var CHAIN_GATE_NUMBER_RULES = {
            minConfidence: { min: 0, max: 100, decimals: 1, label: 'Min Confidence %' },
            minCount: { min: 1, max: 100000, integer: true, label: 'Min Count' }
        };
        var CHAIN_LEVEL_NUMBER_RULES = {
            'chain-max-rings': { min: 1, max: 64, integer: true, label: 'Max Executions' },
            'chain-decision-timeout': { min: 0.001, max: 2147483.647, decimals: 3, label: 'Decision Timeout (seconds)' }
        };
        var CHAIN_LEVEL_LABELS = {
            max_rings: 'Max executions',
            'decision_listener.class_name': 'Decision listener class name',
            decision_timeout_seconds: 'Decision timeout'
        };
        var CHAIN_MODE_LABELS = { linear: 'Linear', conditional: 'Conditional', dynamic: 'Dynamic' };
        var CHAIN_EDITABLE = '.chain-stage, .chain-gate, #chain-decision-panel, #chain-advanced';
        var CHAIN_TIPS = {
            stageName: 'A unique name for this stage. Routes refer to stages by name, and stored API keys are kept per stage name — renaming a VLM or Synthetic stage clears its stored key, so re-enter it after a rename.',
            ruleClasses: 'Comma-separated class names this rule looks for, matched ignoring case. A rule with no classes never matches.',
            motionRuleClasses: 'Motion detections all carry the class motion, so a motion route always matches it.',
            ruleMinConfidence: 'Detections below this confidence don’t count toward the rule. 0 counts every detection.',
            ruleMinCount: 'The rule matches once this many qualifying detections appear across the window’s analyzed frames. 1 by default.',
            match: 'Any rule: the route matches when one of its rules matches. All rules: every rule has to match.',
            onMatch: 'What runs next when the route matches: another stage, or the end of the window.',
            onNoMatch: 'What runs next when the route does not match. The end of the window unless you pick a stage.',
            onDone: 'What always runs after this stage: another stage, or the end of the window. Ending here delivers this stage’s result.',
            routeRules: 'Match rules against this stage’s detections and pick where a match and a miss go.',
            routeAlways: 'Always go to one target after this stage runs, whatever it detected.',
            routeRulesLocked: 'This stage returns free-form text with no classes to match, so its route always goes one way.',
            frameSelection: 'Which of the window’s captured frames this stage analyzes — all of them unless you narrow it.',
            crop: 'Analyze the boxes the previous stage detected instead of whole frames: one crop per box, filtered by class and confidence and padded by a share of the box size. Results keep full-frame coordinates.'
        };
        var CHAIN_STRIDE_HELP = 'Keeps frames 0, N, 2N and so on, plus the last frame.';
        var CHAIN_SYNTHETIC_FRAMES_NOTE = 'A Synthetic stage always takes the whole clip.';
        var CHAIN_OBJECT_LATENCY_NOTE = 'Object detection boxes render when the whole window completes, so they trail live video.';
        var CHAIN_SVD_GATE_NOTE = 'The detector’s synthetic verdict needs a score strictly greater than its threshold; a rule’s Min Confidence includes equality.';
        var CHAIN_DYNAMIC_END = 'The first stage is the entry point — after each run, the decision listener picks what runs next';

        var chainState = null;
        var chainStoredDetector = null;
        var chainCards = {};
        var chainUidSeq = 0;
        var chainDrag = null;
        var chainSuggestedEntryType = null;
        var chainPropertyRows = [];
        var chainPropertySeq = 0;
        var chainPendingMode = null;

        function chainStageTypes() {
            return chainState ? chainState.stages.map(function(stage) { return (stage.detector || {}).type; }) : [];
        }

        function chainEntryType() {
            return chainStageTypes()[0] || 'object';
        }

        function chainIsWindowed() {
            const types = chainStageTypes();
            return (types.indexOf('scene') !== -1 || types.indexOf('vlm') !== -1) && types.indexOf('synthetic') === -1;
        }

        function chainRuleDetectorTypeOf(types) {
            if (types.indexOf('vlm') !== -1) return 'vlm';
            if (types.indexOf('synthetic') !== -1) return 'synthetic';
            return 'scene';
        }

        function chainRuleDetectorType() {
            return chainRuleDetectorTypeOf(chainStageTypes());
        }

        function chainErrorText(error) {
            const stage = /^stages\[(\d+)\]((?:\.[a-z_]+(?:\[\d+\])?)*):\s*(.*)$/.exec(error);
            if (stage) {
                const member = stage[2].replace(/^\./, '').replace(/^detector\./, '')
                    .replace(/\.(mode|stride|stage)$/, '')
                    .replace(/rules\[(\d+)\]/g, function(match, n) { return 'rule ' + (Number(n) + 1); })
                    .replace(/[._]/g, ' ');
                return 'Stage ' + (Number(stage[1]) + 1) + (member ? ' ' + member : '') + ': ' + stage[3];
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
                if (mode === 'every_nth') stage.frameSelection.stride = readNumber(card.strideInput, true);
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
            setOrDelete(state, 'resultMode', document.getElementById('chain-result-mode').value || undefined);
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

        function syncChainFromCards() {
            if (!chainState) return;
            readChainLevel(chainState);
            chainState.stages.forEach(function(stage) {
                const card = chainCards[stage.uid];
                if (!card) return;
                readChainCard(card, stage);
                if (lockGateToAlwaysOnFreeFormStage(card, stage)) readGate(card, stage);
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

        function chainValidationErrors(config) {
            const state = VIF.chainEditor.initChain(config.chain_detector || { stages: [] });
            const errors = VIF.chainEditor.validateChain(state).errors.map(chainErrorText);
            const types = state.stages.map(function(stage) { return (stage.detector || {}).type; });
            const cap = VIF.fieldRegistry.effectiveRule(VIF.fieldRegistry.getField('cfg-duration'), chainRuleDetectorTypeOf(types)).max;
            if (config.duration !== undefined && config.duration !== null
                && (!Number.isFinite(config.duration) || config.duration < 0 || config.duration > cap)) {
                errors.push('Duration must be between 0 and ' + cap + ' for this chain.');
            }
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
            summary.appendChild(chainTip(tip));
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
            const summary = chainSummary('Frame selection', CHAIN_TIPS.frameSelection);
            card.frameValue = chainEl('span', 'chain-disclosure-value');
            card.frameValue.id = prefix + 'frame-value';
            summary.insertBefore(card.frameValue, summary.querySelector('.vif-help-tip'));
            box.appendChild(summary);
            const body = chainEl('div', 'chain-disclosure-body');
            card.frameMode = chainEl('select');
            card.frameMode.id = prefix + 'frame-mode';
            VIF.chainEditor.FRAME_SELECTION_MODES.forEach(function(mode) {
                const option = chainEl('option', null, FRAME_SELECTION_LABELS[mode]);
                option.value = mode;
                card.frameMode.appendChild(option);
            });
            card.strideInput = chainInput('number', prefix + 'frame-stride', '2');
            card.strideGroup = chainFormGroup('Every Nth', card.strideInput);
            card.strideGroup.id = prefix + 'frame-stride-group';
            card.strideGroup.appendChild(chainEl('div', 'field-help', CHAIN_STRIDE_HELP));
            card.frameSyntheticNote = chainEl('div', 'field-help chain-note');
            card.frameSyntheticNote.id = prefix + 'frame-synthetic-note';
            body.append(card.frameSyntheticNote, chainFormGroup('Frames', card.frameMode), card.strideGroup);
            box.appendChild(body);
            card.frameBox = box;
        }

        function buildCrop(card) {
            const prefix = card.prefix;
            const box = chainEl('details', 'chain-disclosure');
            box.id = prefix + 'crop';
            box.appendChild(chainSummary('Crop from previous stage', CHAIN_TIPS.crop));
            const body = chainEl('div', 'chain-disclosure-body chain-crop-rail');
            card.cropError = chainEl('div', 'chain-stage-errors');
            card.cropError.id = prefix + 'crop-error';
            card.cropFields = chainEl('div');
            card.cropFields.id = prefix + 'crop-fields';
            card.cropClasses = chainInput('text', prefix + 'crop-classes', 'all classes');
            card.cropMinConfidence = chainInput('number', prefix + 'crop-min-confidence', '0');
            card.cropPadding = chainInput('number', prefix + 'crop-padding', '0');
            card.cropMax = chainInput('number', prefix + 'crop-max', '16');
            card.cropFields.append(
                chainFormGroup('Classes', card.cropClasses),
                chainFormGroup('Min Confidence %', card.cropMinConfidence),
                chainFormGroup('Padding %', card.cropPadding),
                chainFormGroup('Max Crops', card.cropMax));
            const actions = chainEl('div', 'chain-crop-actions');
            card.cropAdd = chainButton('Crop detections from the previous stage', 'btn-secondary');
            card.cropAdd.id = prefix + 'crop-add';
            card.cropRemove = chainButton('Remove crop', 'btn-danger');
            card.cropRemove.id = prefix + 'crop-remove';
            actions.append(card.cropAdd, card.cropRemove);
            body.append(card.cropError, card.cropFields, actions);
            box.appendChild(body);
            card.cropBox = box;
        }

        function buildGate(card) {
            const prefix = card.prefix;
            const gate = { rows: [], rowSeq: 0, match: undefined, kind: 'rules', open: false, pendingMode: null };
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
            gate.ruleHead = chainEl('div', 'chain-rule-head');
            const ruleHeader = function(text, tip) {
                const head = chainEl('span', null, text);
                head.appendChild(chainTip(tip));
                return head;
            };
            gate.minConfidenceHead = ruleHeader('Min Confidence %', CHAIN_TIPS.ruleMinConfidence);
            gate.ruleHead.append(ruleHeader('Classes', CHAIN_TIPS.ruleClasses),
                gate.minConfidenceHead,
                ruleHeader('Min Count', CHAIN_TIPS.ruleMinCount), chainEl('span'));
            gate.rules = chainEl('div', 'chain-rules');
            gate.rules.id = prefix + 'rules';
            gate.empty = chainEl('div', 'chain-rules-empty', 'No rules — always takes the No-match path');
            gate.empty.id = prefix + 'rules-empty';
            gate.addRule = chainButton('+ Add rule', 'btn-secondary');
            gate.addRule.id = prefix + 'rule-add';
            gate.removeRoute = chainButton('Remove route', 'btn-danger');
            gate.removeRoute.id = prefix + 'route-remove';
            const actions = chainEl('div', 'chain-gate-actions');
            actions.append(gate.addRule, gate.removeRoute);
            gate.matchSeg = chainEl('div', 'chain-seg');
            gate.matchSeg.id = prefix + 'route-match';
            gate.matchSeg.setAttribute('role', 'group');
            [['any', 'Any rule'], ['all', 'All rules']].forEach(function(entry) {
                const button = chainButton(entry[1]);
                button.dataset.match = entry[0];
                gate.matchSeg.appendChild(button);
            });
            gate.onMatch = chainEl('select');
            gate.onMatch.id = prefix + 'route-on-match';
            gate.onNoMatch = chainEl('select');
            gate.onNoMatch.id = prefix + 'route-on-no-match';
            gate.svdNote = chainEl('div', 'field-help chain-note');
            gate.svdNote.id = prefix + 'gate-svd-note';
            gate.svdNote.textContent = CHAIN_SVD_GATE_NOTE;
            gate.kindSeg = chainEl('div', 'chain-seg');
            gate.kindSeg.id = prefix + 'route-kind';
            gate.kindSeg.setAttribute('role', 'group');
            [['rules', 'Rules', CHAIN_TIPS.routeRules], ['always', 'Always', CHAIN_TIPS.routeAlways]].forEach(function(entry) {
                const button = chainButton(entry[1], null, entry[2]);
                button.dataset.kind = entry[0];
                gate.kindSeg.appendChild(button);
            });
            gate.onDone = chainEl('select');
            gate.onDone.id = prefix + 'route-on-done';
            gate.matchGroup = chainFormGroup('Match', gate.matchSeg, CHAIN_TIPS.match);
            gate.onMatchGroup = chainFormGroup('On Match', gate.onMatch, CHAIN_TIPS.onMatch);
            gate.onNoMatchGroup = chainFormGroup('On No Match', gate.onNoMatch, CHAIN_TIPS.onNoMatch);
            gate.onDoneGroup = chainFormGroup('Then', gate.onDone, CHAIN_TIPS.onDone);
            gate.editor.append(chainFormGroup('Route', gate.kindSeg), gate.ruleHead, gate.rules, gate.empty, actions,
                gate.matchGroup, gate.onMatchGroup, gate.onNoMatchGroup, gate.onDoneGroup, gate.svdNote);

            gate.modeConfirm = chainEl('div', 'inline-warning chain-confirm');
            gate.modeConfirm.id = prefix + 'gate-mode-confirm';
            gate.modeConfirm.style.display = 'none';
            gate.modeConfirmText = chainEl('span');
            gate.modeConfirmText.id = prefix + 'gate-mode-confirm-text';
            gate.modeConfirmYes = chainButton('', 'btn-danger');
            gate.modeConfirmYes.id = prefix + 'gate-mode-confirm-yes';
            gate.modeConfirmNo = chainButton('Cancel', 'btn-secondary');
            gate.modeConfirmNo.id = prefix + 'gate-mode-confirm-no';
            const confirmActions = chainEl('div', 'chain-confirm-actions');
            confirmActions.append(gate.modeConfirmYes, gate.modeConfirmNo);
            gate.modeConfirm.append(gate.modeConfirmText, confirmActions);
            gate.el.append(gate.modeConfirm, gate.plain, gate.strip, gate.errors, gate.warnings, gate.editor);
            card.gate = gate;
        }

        function addGateRuleRow(card, rule) {
            const gate = card.gate;
            const id = card.prefix + 'rule-' + (++gate.rowSeq) + '-';
            const row = { base: rule ? JSON.parse(JSON.stringify(rule)) : {} };
            row.el = chainEl('div', 'chain-rule');
            row.classes = chainInput('text', id + 'classes', 'classes, comma-separated');
            row.motionClasses = chainInput('text', id + 'motion-classes');
            row.motionClasses.value = 'motion';
            row.motionClasses.disabled = true;
            row.motionClasses.title = CHAIN_TIPS.motionRuleClasses;
            row.minConfidence = chainInput('number', id + 'min-confidence', '0');
            row.minCount = chainInput('number', id + 'min-count', '1');
            row.remove = chainButton('Remove', 'btn-danger', 'Remove this rule');
            row.classes.value = chainCsvText(row.base.classes);
            row.minConfidence.value = chainPercentText(row.base.minConfidence);
            row.minCount.value = chainPlainText(row.base.minCount);
            applyNumericRuleToInput(row.minConfidence, CHAIN_GATE_NUMBER_RULES.minConfidence);
            applyNumericRuleToInput(row.minCount, CHAIN_GATE_NUMBER_RULES.minCount);
            row.remove.addEventListener('click', function() {
                gate.rows.splice(gate.rows.indexOf(row), 1);
                row.el.remove();
                refreshChainFromDom(true);
                markDirty();
            });
            row.el.append(row.classes, row.motionClasses, row.minConfidence, row.minCount, row.remove);
            lockGateRowForMotion(row, card.type === 'motion');
            gate.rules.appendChild(row.el);
            gate.rows.push(row);
            return row;
        }

        function lockGateRowForMotion(row, motion) {
            row.el.classList.toggle('chain-rule-motion', motion);
            row.classes.style.display = motion ? 'none' : '';
            row.motionClasses.style.display = motion ? '' : 'none';
            row.minConfidence.style.display = motion ? 'none' : '';
        }

        function applyGateMotionLock(card) {
            const motion = card.type === 'motion';
            card.gate.ruleHead.classList.toggle('chain-rule-motion', motion);
            card.gate.minConfidenceHead.style.display = motion ? 'none' : '';
            card.gate.rows.forEach(function(row) { lockGateRowForMotion(row, motion); });
        }

        function fillChainTargets(card, select, value, noMatch) {
            select.replaceChildren();
            const add = function(optionValue, label) {
                const option = chainEl('option', null, label);
                option.value = optionValue;
                select.appendChild(option);
            };
            if (!noMatch && value === '') add('', 'Choose a target');
            const own = chainIndexOf(card.uid);
            const all = chainState.stages.map(function(stage) { return chainTrimmed(stage.name); });
            const offered = all.filter(function(name, index) {
                return index !== own && name !== '' && all.indexOf(name) === index;
            });
            offered.forEach(function(name) { add('s:' + name, name); });
            if (value.indexOf('s:') === 0 && offered.indexOf(value.slice(2)) === -1) {
                const name = value.slice(2);
                add(value, all.indexOf(name) !== -1 ? name : name + ' (no such stage)');
            }
            add('end', 'End of window');
            select.value = value;
        }

        function fillGate(card, stage) {
            const gate = card.gate;
            const routing = stage.routing;
            card.routeOn = !!routing;
            gate.rows.forEach(function(row) { row.el.remove(); });
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

        function setGateKind(card, kind) {
            const gate = card.gate;
            if (gate.kind === kind) return;
            gate.kind = kind;
            if (kind === 'always') {
                fillChainTargets(card, gate.onDone, gate.onNoMatch.value, true);
                return;
            }
            if (!gate.rows.length) addGateRuleRow(card);
            if (gate.onMatch.value === '') fillChainTargets(card, gate.onMatch, chainTargetValue(nextStageTarget(card), ''), false);
        }

        function lockGateToAlwaysOnFreeFormStage(card, stage) {
            if (!stage.routing || card.gate.kind === 'always' || !VIF.chainEditor.isFreeFormVlm(stage.detector)) return false;
            setGateKind(card, 'always');
            return true;
        }

        var VLM_MODE_LABELS = { detect: 'Detect', describe: 'Describe', custom: 'Custom' };

        function isVlmModeRadio(el) {
            return el.type === 'radio' && /vlm-mode$/.test(el.name || '');
        }

        function stageVlmMode(detector) {
            if (detector.mode !== undefined && detector.mode !== null) return detector.mode;
            if (detector.detect !== undefined && detector.detect !== null) return 'detect';
            return detector.custom !== undefined && detector.custom !== null ? 'custom' : 'describe';
        }

        function hideGateModeConfirm(card) {
            card.gate.pendingMode = null;
            card.gate.modeConfirm.style.display = 'none';
        }

        /**
         * Intercepts a stage-mode switch that would drop a rules route, before the switch's
         * own handlers run: the radio is put back and the gate shows the same inline confirm
         * the chain-mode switch uses. Returns true when the event must not propagate.
         */
        function deferVlmModeSwitchConfirm(target) {
            if (!isVlmModeRadio(target) || target.value === 'detect') return false;
            if (VIF.chainEditor.chainMode(chainState) !== 'conditional') return false;
            const stageEl = target.closest('.chain-stage');
            const stage = stageEl && chainState.stages.find(function(entry) {
                const candidate = chainCards[entry.uid];
                return candidate && candidate.el === stageEl;
            });
            const card = stage && chainCards[stage.uid];
            if (!card || card.type !== 'vlm' || target.name !== sectionPrefix(card.root) + 'vlm-mode') return false;
            if (!card.routeOn || card.gate.kind !== 'rules') return false;
            const previous = stageVlmMode(stage.detector);
            if (previous === target.value) return false;
            if (target.value === 'custom') {
                carryOverVlmClasses(card.root, 'cfg-vlm-detect-classes', 'cfg-vlm-custom-classes');
                if (!VIF.chainEditor.isFreeFormVlm(stageDetectorFromDom(card, stage))) return false;
            }
            const previousRadio = field(card.root, 'cfg-vlm-mode').querySelector('input[value="' + previous + '"]');
            if (!previousRadio) return false;
            previousRadio.checked = true;
            const gate = card.gate;
            const label = VLM_MODE_LABELS[target.value];
            gate.pendingMode = target.value;
            gate.modeConfirmText.textContent = 'Switching to ' + label + " drops this stage's rules — its route becomes always → "
                + chainTargetLabel(chainTargetOf(gate.onNoMatch.value) || { end: true }) + '.';
            gate.modeConfirmYes.textContent = 'Switch to ' + label;
            gate.modeConfirm.style.display = '';
            gate.modeConfirmNo.focus();
            return true;
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
            gate.kindSeg.addEventListener('click', function(event) {
                const button = event.target.closest('button');
                if (!button || button.disabled || gate.kind === button.dataset.kind) return;
                setGateKind(card, button.dataset.kind);
                refreshChainFromDom(true);
                markDirty();
            });
            gate.removeRoute.addEventListener('click', function() {
                fillGate(card, {});
                refreshChainFromDom(true);
                markDirty();
            });
            gate.modeConfirmNo.addEventListener('click', function() { hideGateModeConfirm(card); });
            gate.modeConfirmYes.addEventListener('click', function() {
                const requested = gate.pendingMode;
                hideGateModeConfirm(card);
                if (!requested) return;
                const radio = field(card.root, 'cfg-vlm-mode').querySelector('input[value="' + requested + '"]');
                if (!radio) return;
                radio.checked = true;
                toggleVlmMode(card.root);
                refreshChainFromDom(true);
            });
            gate.addRule.addEventListener('click', function() {
                const row = addGateRuleRow(card);
                refreshChainFromDom(true);
                markDirty();
                row.classes.focus();
            });
            gate.matchSeg.addEventListener('click', function(event) {
                const button = event.target.closest('button');
                if (!button || gate.match === button.dataset.match) return;
                gate.match = button.dataset.match;
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
            if (gate.pendingMode && (!card.routeOn || gate.kind !== 'rules')) hideGateModeConfirm(card);
            gate.plain.style.display = card.routeOn ? 'none' : '';
            gate.plainText.textContent = last ? 'falls through to the end of the window' : 'falls through to the next stage';
            gate.strip.style.display = card.routeOn ? '' : 'none';
            gate.summary.textContent = stage.routing ? chainGateSummary(routingAsSaved(card, stage.routing)) : '';
            gate.toggle.textContent = gate.open ? 'Close' : 'Edit';
            gate.strip.setAttribute('aria-expanded', String(card.routeOn && gate.open));
            gate.el.classList.toggle('is-open', card.routeOn && gate.open);
            const always = gate.kind === 'always';
            const freeForm = VIF.chainEditor.isFreeFormVlm(stage.detector);
            Array.from(gate.kindSeg.children).forEach(function(button) {
                const active = button.dataset.kind === gate.kind;
                const locked = freeForm && button.dataset.kind === 'rules';
                button.classList.toggle('is-active', active);
                button.setAttribute('aria-pressed', String(active));
                button.disabled = locked;
                button.title = locked ? CHAIN_TIPS.routeRulesLocked
                    : (button.dataset.kind === 'rules' ? CHAIN_TIPS.routeRules : CHAIN_TIPS.routeAlways);
            });
            gate.ruleHead.style.display = !always && gate.rows.length ? '' : 'none';
            gate.rules.style.display = always ? 'none' : '';
            gate.empty.style.display = !always && !gate.rows.length ? '' : 'none';
            gate.addRule.style.visibility = always ? 'hidden' : '';
            [gate.matchGroup, gate.onMatchGroup, gate.onNoMatchGroup].forEach(function(group) {
                group.style.display = always ? 'none' : '';
            });
            gate.onDoneGroup.style.display = always ? '' : 'none';
            gate.svdNote.style.display = !always && card.type === 'synthetic' ? '' : 'none';
            const match = gate.match || 'any';
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

        function fillStageExtras(card, stage) {
            const selection = stage.frameSelection || {};
            card.frameMode.value = selection.mode || 'all';
            card.strideInput.value = selection.stride !== undefined && selection.stride !== null ? selection.stride : '';
            const crop = stage.crop || {};
            card.cropOn = !!stage.crop;
            card.cropClasses.value = (crop.classes || []).join(', ');
            card.cropMinConfidence.value = chainPercentText(crop.minConfidence);
            card.cropPadding.value = chainPercentText(crop.padding);
            card.cropMax.value = crop.maxCrops !== undefined && crop.maxCrops !== null ? crop.maxCrops : '';
            card.cropBox.open = card.cropOn;
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
            card.nameInput = chainInput('text', prefix + 'stage-name', 'e.g. detect');
            card.nameInput.value = stage.name || '';
            card.nameNote = chainEl('div', 'field-help chain-note');
            card.nameNote.id = prefix + 'stage-name-note';
            const nameGroup = chainFormGroup('Stage Name', card.nameInput, CHAIN_TIPS.stageName);
            nameGroup.appendChild(card.nameNote);
            card.typeSelect = chainEl('select');
            card.typeSelect.id = prefix + 'stage-type';
            VIF.chainEditor.STAGE_TYPES.forEach(function(type) {
                const option = chainEl('option', null, CHAIN_STAGE_LABELS[type]);
                option.value = type;
                card.typeSelect.appendChild(option);
            });
            card.typeSelect.value = card.type;
            card.typeSelect.dataset.chainRole = 'type';
            card.root = chainEl('div', 'chain-stage-form');
            card.root.appendChild(VIF.detectorSections.instantiate(prefix, card.root));
            buildFrameSelection(card);
            buildCrop(card);
            buildGate(card);
            card.committedName = chainTrimmed(stage.name);
            body.append(card.errors, nameGroup, chainFormGroup('Detector Type', card.typeSelect), card.root, card.frameBox, card.cropBox);
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
                applyChainTransition(function(state) { return VIF.chainEditor.removeStage(state, index); });
            });
            card.typeSelect.addEventListener('change', function() { changeChainStageType(card, card.typeSelect.value); });
            card.nameInput.addEventListener('change', function() { renameChainStage(card); });
            card.cropAdd.addEventListener('click', function() {
                card.cropOn = true;
                if (card.type === 'object') {
                    const tracking = field(card.root, 'cfg-tracking-method');
                    const tiling = field(card.root, 'cfg-tiling-enabled');
                    if (tracking.value !== 'none') { tracking.value = 'none'; toggleByteTrack(card.root); }
                    if (tiling.checked) { tiling.checked = false; toggleTiling(card.root); }
                }
                refreshChainFromDom(true);
                markDirty();
                card.cropClasses.focus();
            });
            card.cropRemove.addEventListener('click', function() {
                card.cropOn = false;
                [card.cropClasses, card.cropMinConfidence, card.cropPadding, card.cropMax].forEach(function(input) { input.value = ''; });
                refreshChainFromDom(true);
                markDirty();
            });
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
                applyChainTransition(function(state) { return VIF.chainEditor.moveStage(state, from, drag.to - from); });
            }
        }

        function moveChainStage(card, delta) {
            const index = chainIndexOf(card.uid);
            applyChainTransition(function(state) { return VIF.chainEditor.moveStage(state, index, delta); });
            const button = delta < 0 ? card.upBtn : card.downBtn;
            (button.disabled ? (delta < 0 ? card.downBtn : card.upBtn) : button).focus();
        }

        function changeChainStageType(card, type) {
            syncChainFromCards();
            chainState = VIF.chainEditor.setStageType(chainState, chainIndexOf(card.uid), type);
            card.type = type;
            loadChainCardSections(card, chainState.stages[chainIndexOf(card.uid)]);
            applyGateMotionLock(card);
            refreshChainView(true);
            markDirty();
        }

        function insertChainStage(at) {
            applyChainTransition(function(state) { return VIF.chainEditor.addStage(state, 'object', at); });
            const card = chainCards[chainState.stages[at].uid];
            if (card) card.nameInput.focus();
        }

        function refillChainFromState() {
            chainState.stages.forEach(function(stage) {
                const card = chainCards[stage.uid];
                if (card) fillGate(card, stage);
            });
            fillChainLevel();
        }

        function applyChainTransition(transition) {
            syncChainFromCards();
            chainState = assignStageUids(transition(chainState));
            refillChainFromState();
            renderChain();
            markDirty();
        }

        function renameChainStage(card) {
            const name = card.nameInput.value;
            if (chainTrimmed(name) === '' || chainTrimmed(name) === card.committedName) return;
            const index = chainIndexOf(card.uid);
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
                    if (stage.routing) routed.push(chainTrimmed(stage.name) || 'stage ' + (index + 1));
                });
                if (routed.length) drops.push((routed.length === 1 ? 'the route on ' : 'the routes on ') + chainJoinList(routed));
            }
            if (current === 'dynamic' && mode !== 'dynamic') {
                const listener = chainState.decisionListener;
                if (listener) drops.push('the decision listener' + (listener.className ? ' ' + listener.className : ''));
                if (isPresent(chainState.decisionTimeoutSeconds)) drops.push('the decision timeout');
                if (isPresent(chainState.dispatchIntermediateRings)) drops.push('the dispatch intermediate setting');
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
            document.getElementById('chain-result-mode').value = state.resultMode || '';
            document.getElementById('chain-decision-class').value = listener.className || '';
            document.getElementById('chain-decision-timeout').value = chainPlainText(state.decisionTimeoutSeconds);
            document.getElementById('chain-dispatch-intermediate').checked = state.dispatchIntermediateRings === true;
            chainPropertyRows.forEach(function(row) { row.el.remove(); });
            chainPropertyRows = [];
            const properties = listener.properties || {};
            Object.keys(properties).forEach(function(key) { addChainPropertyRow(key, properties[key], true); });
        }

        function chainConnector(at) {
            const connector = chainEl('div', 'chain-connector');
            const trailing = at === (chainState ? chainState.stages.length : 0);
            const insert = trailing
                ? chainButton('+ Add stage', 'chain-insert chain-insert-end', 'Add a stage at the end')
                : chainButton('+', 'chain-insert', 'Insert a stage here');
            insert.addEventListener('click', function() { insertChainStage(at); });
            connector.appendChild(insert);
            return connector;
        }

        function renderChain(options) {
            options = options || {};
            const list = document.getElementById('chain-stages');
            const stages = chainState ? chainState.stages : [];
            const live = {};
            stages.forEach(function(stage) { live[stage.uid] = true; });
            Object.keys(chainCards).forEach(function(uid) {
                if (live[uid]) return;
                chainCards[uid].el.remove();
                chainCards[uid].gate.el.remove();
                delete chainCards[uid];
            });
            Array.from(list.querySelectorAll(':scope > .chain-connector')).forEach(function(connector) { connector.remove(); });
            const routed = VIF.chainEditor.chainMode(chainState || {}) === 'conditional';
            stages.forEach(function(stage, index) {
                const card = chainCards[stage.uid] || createChainCard(stage, !!options.stored, options.expandNew !== false);
                list.appendChild(card.el);
                if (routed) list.appendChild(card.gate.el);
                else card.gate.el.remove();
                list.appendChild(chainConnector(index + 1));
            });
            if (!stages.length) list.appendChild(chainConnector(0));
            refreshChainView(true);
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

        function chainOrdinal(n) {
            const tens = n % 100;
            if (tens >= 11 && tens <= 13) return n + 'th';
            return n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
        }

        function chainFrameSelectionText(mode, strideText) {
            if (mode !== 'every_nth') return FRAME_SELECTION_LABELS[mode] || '';
            const stride = Number(String(strideText).trim());
            return Number.isInteger(stride) && stride > 0 ? 'Every ' + chainOrdinal(stride) : 'Every Nth';
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
            card.nameNote.textContent = renamed ? 'Renaming clears this stage’s stored API key.' : '';

            const frameMode = card.frameMode.value;
            card.frameBox.style.display = card.type !== 'synthetic' || frameMode !== 'all' ? '' : 'none';
            card.strideGroup.style.display = frameMode === 'every_nth' ? 'flex' : 'none';
            const frameText = chainFrameSelectionText(frameMode, card.strideInput.value);
            card.frameValue.textContent = frameText ? ' · ' + frameText : '';
            card.frameSyntheticNote.textContent = card.type === 'synthetic' ? CHAIN_SYNTHETIC_FRAMES_NOTE : '';

            const cropOffered = VIF.chainEditor.offersCrop(chainState, index);
            const own = 'stages[' + index + '].';
            const cropErrors = errors.filter(function(error) {
                return error.indexOf(own + 'crop') === 0
                    || (card.cropOn && (error.indexOf(own + 'detector.tracking') === 0 || error.indexOf(own + 'detector.tiling') === 0));
            });
            card.cropBox.style.display = cropOffered || card.cropOn ? '' : 'none';
            card.cropFields.style.display = card.cropOn ? '' : 'none';
            card.cropAdd.style.display = !card.cropOn && cropOffered ? '' : 'none';
            card.cropRemove.style.display = card.cropOn ? '' : 'none';
            card.cropError.textContent = cropErrors.map(chainErrorText).join('\n');
            if (cropErrors.length) card.cropBox.open = true;

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
            tracking.disabled = lock && tracking.value === 'none';
            tiling.disabled = lock && !tiling.checked;
            card.trackingNote.textContent = lock ? CROP_WHY : (blocker ? chainTrackingWhy(blocker) : '');

            Array.from(card.typeSelect.options).forEach(function(option) {
                if (option.value !== 'synthetic') return;
                const excluded = mode === 'dynamic' && card.type !== 'synthetic';
                option.hidden = excluded;
                option.disabled = excluded;
            });

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

        function updateChainCadence() {
            const line = document.getElementById('chain-cadence');
            const types = chainStageTypes();
            if (!types.length) { line.textContent = ''; return; }
            const input = document.getElementById('cfg-duration');
            const seconds = parseFloat((input.value || '').trim() || input.placeholder || '');
            const windowText = (Number.isFinite(seconds) ? seconds : 2) + ' s';
            const synthetic = types.indexOf('synthetic') !== -1;
            let windowType = null;
            for (let i = 0; i < types.length && !windowType; i++) {
                if (types[i] === 'scene' || types[i] === 'vlm') windowType = types[i];
            }
            if (!synthetic && !windowType) {
                line.textContent = 'Captures per-frame — only Object and Motion stages';
                return;
            }
            let text = synthetic
                ? 'Captures ' + windowText + ' clip windows — a Synthetic stage is present'
                : 'Captures ' + windowText + ' windows — a ' + CHAIN_STAGE_LABELS[windowType] + ' stage is present';
            if (types.indexOf('object') !== -1) text += '. ' + CHAIN_OBJECT_LATENCY_NOTE;
            line.textContent = text;
        }

        function chainStatusChip(errors, warnings) {
            if (errors.length) return { kind: 'error', text: '✗ ' + chainErrorText(errors[0]) };
            if (warnings.length) {
                return { kind: 'warn', text: '⚠ ' + warnings.length + (warnings.length === 1 ? ' warning' : ' warnings') };
            }
            return { kind: 'ok', text: '✓ Valid' };
        }

        function isChainLevelWarning(warning) {
            return !/^stages\[\d+\]/.test(warning);
        }

        function refreshChainView(showStageErrors) {
            if (!chainState) return;
            const result = VIF.chainEditor.validateChain(chainState);
            const errors = result.errors;
            chainState.stages.forEach(function(stage, index) {
                const card = chainCards[stage.uid];
                if (card) refreshChainCard(card, stage, index, errors, result.warnings, showStageErrors);
            });

            const status = chainStatusChip(errors, result.warnings);
            const chip = document.getElementById('chain-status');
            chip.className = 'chain-status ' + status.kind;
            chip.textContent = status.text;
            document.getElementById('chain-vod-only').style.display = VIF.chainEditor.hasSyntheticStage(chainState) ? '' : 'none';
            showChainWarnings(document.getElementById('chain-warnings'), result.warnings.filter(isChainLevelWarning));

            const mode = VIF.chainEditor.chainMode(chainState);
            document.querySelectorAll('#chain-mode > button').forEach(function(button) {
                const active = button.dataset.mode === mode;
                button.classList.toggle('is-active', active);
                button.setAttribute('aria-pressed', String(active));
                button.disabled = false;
            });
            VIF.chainEditor.MODES.forEach(function(each) {
                const help = document.getElementById('chain-mode-help-' + each);
                if (help) help.style.display = each === mode ? '' : 'none';
            });
            document.getElementById('chain-decision-panel').style.display = mode === 'dynamic' ? '' : 'none';
            const end = document.getElementById('chain-end');
            end.textContent = mode === 'dynamic' ? CHAIN_DYNAMIC_END : 'End of window';
            end.classList.toggle('is-sentence', mode === 'dynamic');
            if (showStageErrors) refreshChainLevelErrors(errors);

            updateChainCadence();
            document.getElementById('chain-json-body').textContent =
                JSON.stringify(VIF.sdk.toWire(VIF.chainEditor.collectChainDetector(chainState)), null, 2);

            if (document.getElementById('cfg-detector-type').value !== 'chain') return;
            applyChainCaptureGroups();
            updateSyntheticOverlayWarning();
            suggestFromChainEntryStage();
        }

        function showChainWarnings(box, warnings) {
            box.textContent = warnings.map(chainErrorText).join('\n');
            box.style.display = warnings.length ? '' : 'none';
        }

        function refreshChainLevelErrors(errors) {
            const text = function(prefixes) {
                return errors.filter(function(error) {
                    return prefixes.some(function(prefix) { return error.indexOf(prefix) === 0; });
                }).map(chainErrorText).join('\n');
            };
            document.getElementById('chain-decision-errors').textContent = text(['decision_listener', 'decision_timeout_seconds']);
            const advanced = text(['max_rings']);
            document.getElementById('chain-advanced-errors').textContent = advanced;
            if (advanced) document.getElementById('chain-advanced').open = true;
        }

        function refreshChainFromDom(showStageErrors) {
            syncChainFromCards();
            refreshChainView(showStageErrors);
        }

        function applyChainCaptureGroups() {
            const duration = VIF.fieldRegistry.getField('cfg-duration');
            FIELD_RULES[duration.id] = VIF.fieldRegistry.effectiveRule(duration, chainRuleDetectorType());
            applyNumericRuleToInput(document.getElementById(duration.id), FIELD_RULES[duration.id]);
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
            updateChainCadence();
        }

        function loadChain(detector) {
            clearChain();
            chainState = assignStageUids(VIF.chainEditor.withFreeFormRoutesAsOnDone(VIF.chainEditor.initChain(detector)));
            const stored = !isNewStream();
            chainStoredDetector = stored ? JSON.parse(JSON.stringify(detector)) : null;
            fillChainLevel();
            renderChain({ stored: stored, expandNew: false });
        }

        function ensureChain() {
            if (chainState) return;
            chainState = assignStageUids(VIF.chainEditor.newChain());
            fillChainLevel();
            renderChain({ expandNew: true });
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
            document.getElementById('chain-advanced').open = false;
            ['chain-decision-errors', 'chain-advanced-errors'].forEach(function(id) {
                document.getElementById(id).textContent = '';
            });
            document.getElementById('chain-decision-panel').style.display = 'none';
            const end = document.getElementById('chain-end');
            end.textContent = 'End of window';
            end.classList.remove('is-sentence');
            chainSuggestedEntryType = null;
            document.getElementById('chain-stages').replaceChildren();
            const chip = document.getElementById('chain-status');
            chip.className = 'chain-status';
            chip.textContent = '';
            document.getElementById('chain-vod-only').style.display = 'none';
            showChainWarnings(document.getElementById('chain-warnings'), []);
            document.getElementById('chain-cadence').textContent = '';
            document.getElementById('chain-json-body').textContent = '';
        }

        (function bindChainSection() {
            const section = document.getElementById('chain-pipeline-section');
            // A mode radio fires input before change; both are deferred to the capture
            // listener below so a switch that needs confirming converts nothing first.
            section.addEventListener('change', function(event) {
                if (!chainState || !event.target.closest(CHAIN_EDITABLE)) return;
                if (deferVlmModeSwitchConfirm(event.target)) event.stopPropagation();
            }, true);
            section.addEventListener('input', function(event) {
                if (!chainState || !event.target.closest(CHAIN_EDITABLE)) return;
                if (isVlmModeRadio(event.target)) return;
                refreshChainFromDom(false);
            });
            section.addEventListener('change', function(event) {
                if (!chainState || !event.target.closest(CHAIN_EDITABLE)) return;
                if (event.target.dataset.chainRole === 'type') return;
                refreshChainFromDom(true);
            });
            document.getElementById('chain-mode').addEventListener('click', function(event) {
                const button = event.target.closest('button[data-mode]');
                if (button) requestChainMode(button.dataset.mode);
            });
            document.getElementById('chain-mode-confirm-yes').addEventListener('click', function() {
                if (chainPendingMode) switchChainMode(chainPendingMode);
            });
            document.getElementById('chain-mode-confirm-no').addEventListener('click', hideChainModeConfirm);
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
            if (mode === 'model') return 0;
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
                modeSelect.value = 'model';
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
                    FIELD_RULES[entry.id] = VIF.fieldRegistry.effectiveRule(entry,
                        detectorType === 'chain' ? chainRuleDetectorType() : detectorType);
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
        document.getElementById('cfg-duration').addEventListener('input', function() {
            if (chainState) updateChainCadence();
        });
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

        function showStatus(message, isError, sticky) {
            const el = document.getElementById('status-message');
            if (!el) return;
            if (statusHideTimer) clearTimeout(statusHideTimer);
            if (statusClearTimer) clearTimeout(statusClearTimer);
            el.textContent = message;
            el.className = `visible ${isError ? 'error' : 'success'}`;
            statusIsSticky = !!sticky;
            if (statusIsSticky) return;
            statusHideTimer = setTimeout(() => {
                el.classList.remove('visible');
                statusClearTimer = setTimeout(() => {
                    el.className = '';
                    el.textContent = '';
                }, 240);
            }, 3000);
        }

        function hideStatus() {
            const el = document.getElementById('status-message');
            statusIsSticky = false;
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
                showStatus('Config loaded successfully', false);

            } catch (error) {
                console.error("Error fetching config:", error);
                showStatus(`Error loading config: ${error.message}`, true);
            } finally {
                setFormLoading(false);
                suppressDirtyTracking = false;
                updateIncomingStreamPanelState();
            }
        }

        function toastChainWarnings(detector) {
            const warnings = VIF.chainEditor.validateChain(VIF.chainEditor.initChain(detector)).warnings;
            if (warnings.length) VIF.core.toast('Saved with warnings: ' + warnings.map(chainErrorText).join(' '), 'warn');
        }

        function clearNvcfFieldsOffNvcf(root) {
            if (syntheticEndpointIsNvcf(root)) return;
            field(root, 'cfg-synthetic-api-key').value = '';
            syncSectionApiKeyToggle(root, 'cfg-synthetic-api-key', 'cfg-synthetic-api-key-toggle');
            field(root, 'cfg-synthetic-function-id').value = '';
        }

        async function saveConfig() {
            const config = buildConfigJson();
            if (!config) return;
            const validationErrors = collectValidationErrors(config);
            if (validationErrors.length > 0) {
                showStatus(validationErrors.join(' '), true, true);
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
                if (config.detector_type === 'chain') toastChainWarnings(config.chain_detector);
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
                showStatus(`Error saving config: ${error.message}`, true);
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
                if (!isStreamConfigMounted() || !isDirty || isSaving) return;
                e.preventDefault();
                e.returnValue = '';
            });


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

            window.__vifStreamConfigGlobalBindings = true;
        }

        window.onStreamSelected = onStreamSelected;
        window.updateVerifyGateLine = onStandaloneSections(updateVerifyGateLine);
        window.updateMatchOverlapNote = updateMatchOverlapNote;
        window.saveConfig = saveConfig;
        window.cloneConfig = cloneConfig;
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
