(function () {
    window.VIF = window.VIF || {};
    var VIF = window.VIF;
    VIF.streamConfig = VIF.streamConfig || {};

    VIF.streamConfig.init = async function () {
        var resolvedServer = VIF.core.resolveServer();
        var serverUrl = resolvedServer.serverUrl;
        var encodedCredentials = resolvedServer.encodedCredentials;

        var COCO_CLASSES = ['airplane', 'apple', 'backpack', 'banana', 'baseball bat', 'baseball glove', 'bear', 'bed', 'bench', 'bicycle', 'bird', 'boat', 'book', 'bottle', 'bowl', 'broccoli', 'bus', 'cake', 'car', 'carrot', 'cat', 'cell phone', 'chair', 'clock', 'couch', 'cow', 'cup', 'dining table', 'dog', 'donut', 'elephant', 'fire hydrant', 'fork', 'frisbee', 'giraffe', 'hair drier', 'handbag', 'horse', 'hot dog', 'keyboard', 'kite', 'knife', 'laptop', 'microwave', 'motorcycle', 'mouse', 'orange', 'oven', 'parking meter', 'person', 'pizza', 'potted plant', 'refrigerator', 'remote', 'sandwich', 'scissors', 'sheep', 'sink', 'skateboard', 'skis', 'snowboard', 'spoon', 'sports ball', 'stop sign', 'suitcase', 'surfboard', 'teddy bear', 'tennis racket', 'tie', 'toaster', 'toilet', 'toothbrush', 'traffic light', 'train', 'truck', 'tv', 'umbrella', 'vase', 'wine glass', 'zebra'];

        function loadVlmModules() {
            var names = ['vlm-schema-builder', 'vlm-prompt-guide', 'vlm-autogrow'];
            return Promise.all(names.map(function (name) {
                return VIF.core.loadScript('wse-plugins/server/vif/js/' + name + '.js');
            }));
        }
        // Kick off the loads immediately (same timing as the original fire-and-forget
        // injection - give the three modules the most possible time to load before
        // they're needed), but keep the promise so it can be awaited later, right
        // before loadStreams() (see the end of this function).
        var vlmModulesPromise = loadVlmModules();

        var streamsList = [];
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
        // custom text input.
        var VLM_MODEL_OPTIONS = [
            { value: 'Qwen/Qwen3-VL-4B-Instruct-FP8', label: 'Qwen3-VL-4B (Qwen)' },
            { value: 'nvidia/NVIDIA-Nemotron-Nano-12B-v2-VL-FP8', label: 'Nemotron Nano 12B VL (NVIDIA)' },
            { value: 'google/gemma-3-4b-it', label: 'Gemma 3 4B (Google)' }
        ];
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
        var STREAM_CONFIG_SELECTION_STORAGE_KEY = `vif.stream-config.selected-stream.${window.location.host}`;
        FIELD_RULES = VIF.fieldRegistry.deriveFieldRules();
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
            if (input.dataset.ruleBound === 'true') return;
            input.addEventListener('input', function() {
                const sanitized = sanitizeNumericString(input.value, rule);
                if (input.value !== sanitized) input.value = sanitized;
                const valid = input.value === '' || validateNumericValue(input.value, rule);
                input.setCustomValidity(valid ? '' : formatRuleGuidance(rule));
            });
            input.addEventListener('blur', function() {
                input.value = normalizeNumericValue(input.value, rule);
                const valid = input.value === '' || validateNumericValue(input.value, rule);
                input.setCustomValidity(valid ? '' : formatRuleGuidance(rule));
            });
            input.dataset.ruleBound = 'true';
        }

        function initializeStaticFieldRules() {
            Object.entries(FIELD_RULES).forEach(function(entry) {
                const input = document.getElementById(entry[0]);
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
            if (!loading) syncAllApiKeyToggles();
        }

        function toggleCheckpointPath() {
            const model = document.getElementById('cfg-model-name').value;
            document.getElementById('checkpoint-path-group').style.display = model === 'custom' ? 'flex' : 'none';
            updateClassNamesOptions();
            markDirty();
        }

        function getModelClasses() {
            const modelName = document.getElementById('cfg-model-name').value;
            if (!defaultConfig || !defaultConfig.available_models || !defaultConfig.available_models.models) return [];
            const models = defaultConfig.available_models.models;
            let model;
            if (modelName === 'custom') {
                const checkpointPath = document.getElementById('cfg-checkpoint-path').value;
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

        function updateClassNamesOptions() {
            const select = document.getElementById('cfg-class-names');
            const classes = getModelClasses();
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

        function toggleByteTrack() {
            const method = document.getElementById('cfg-tracking-method').value;
            const show = method === 'byte-track';
            document.getElementById('byte-track-section').style.display = show ? 'block' : 'none';
            if (show && !document.getElementById('cfg-bt-min-confidence').value) {
                const btMinConfidence = document.getElementById('cfg-bt-min-confidence');
                const btMaxLostFrames = document.getElementById('cfg-bt-max-lost-frames');
                const btMinOverlap = document.getElementById('cfg-bt-min-overlap');
                const btMinFrames = document.getElementById('cfg-bt-min-frames');
                btMinConfidence.value = btMinConfidence.placeholder || '50';
                btMaxLostFrames.value = btMaxLostFrames.placeholder || '30';
                btMinOverlap.value = btMinOverlap.placeholder || '20';
                btMinFrames.value = btMinFrames.placeholder || '3';
            }
            markDirty();
        }

        function toggleTiling() {
            // Tiling is feature-gated behind the ?tiling=true query param (like vlm). When it
            // is not present, keep both the toggle and the properties section hidden — even if a
            // loaded config has tiling enabled (the stored config is preserved, just not shown).
            const uiEnabled = new URLSearchParams(window.location.search).get('tiling') === 'true';
            const enabled = uiEnabled && document.getElementById('cfg-tiling-enabled').checked;
            document.getElementById('tiling-section').style.display = enabled ? 'block' : 'none';
            if (enabled && !document.getElementById('cfg-tiling-max-rows').value) {
                ['cfg-tiling-min-rows', 'cfg-tiling-min-cols', 'cfg-tiling-max-rows',
                 'cfg-tiling-max-cols', 'cfg-tiling-coverage-cutoff', 'cfg-tiling-cluster-children']
                    .forEach(function(id) {
                        const el = document.getElementById(id);
                        if (!el.value) el.value = el.placeholder || '';
                    });
            }
            toggleTilingMode();
            markDirty();
        }

        function toggleTilingMode() {
            const mode = document.getElementById('cfg-tiling-mode').value;
            document.getElementById('tiling-gated-fields').style.display = mode === 'gated' ? 'block' : 'none';
            // The full-frame toggle only applies to Fixed mode. In Gated the full-frame
            // probe always runs, so the toggle is hidden there.
            document.getElementById('tiling-fixed-fields').style.display = mode === 'gated' ? 'none' : 'block';
            // In Fixed mode there is a single grid, so "Max" is misleading — drop the prefix.
            document.getElementById('lbl-tiling-max-rows').textContent = mode === 'gated' ? 'Max Slice Rows' : 'Slice Rows';
            document.getElementById('lbl-tiling-max-cols').textContent = mode === 'gated' ? 'Max Slice Cols' : 'Slice Cols';
            updateClusterChildrenVisibility();
            markDirty();
        }

        function toggleFullFrameDetection() {
            updateClusterChildrenVisibility();
            markDirty();
        }

        // Cluster suppression only does something when there is a full-frame pass that
        // can produce the over-large "parent" box: that is always the case in Gated
        // (the probe), but in Fixed only when Full Frame Detection is enabled.
        function updateClusterChildrenVisibility() {
            const mode = document.getElementById('cfg-tiling-mode').value;
            const fullFrame = document.getElementById('cfg-tiling-full-frame').checked;
            const show = mode === 'gated' || fullFrame;
            document.getElementById('tiling-cluster-children-group').style.display = show ? 'block' : 'none';
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
            appInput.value = appInput.placeholder || 'live';
            streamInput.value = '';

            window.requestAnimationFrame(function() {
                if (!isNewStream()) return;
                appInput.value = appInput.placeholder || 'live';
                streamInput.value = '';
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
        // global-derived suggestion. Only replaces an untouched suggestion.
        function applyDetectorTypeInferenceFpsSuggestion(detectorType) {
            if (!isNewStream()) return;
            const input = document.getElementById('cfg-inference-fps');
            if (input.value !== input.dataset.suggested) return;
            if (detectorType === 'vlm') {
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
            const cb = document.getElementById('cfg-use-transcoder');
            if (cb.dataset.suggested !== undefined && String(cb.checked) !== cb.dataset.suggested) return;
            const suggested = detectorType !== 'synthetic';
            cb.checked = suggested;
            cb.dataset.suggested = String(suggested);
            updateSyntheticOverlayWarning();
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

            return {
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
                'cfg-synthetic-function-id': { path: 'synthetic_analysis.function_id', fallback: '', value: null, skipNewStreamPrefill: true },
                'cfg-synthetic-classification-threshold': { path: 'synthetic_analysis.classification_threshold', fallback: '', value: null, skipNewStreamPrefill: true }
            };
        }

        function applySuggestedDefaultsForNewStream() {
            const defaults = computeEffectiveFieldDefaults();
            Object.keys(defaults).forEach(function(id) {
                const entry = defaults[id];
                if (entry.skipNewStreamPrefill) return;
                const input = document.getElementById(id);
                if (input) applyDefaultFieldValue(input, entry.value, entry.fallback);
            });
        }

        function refreshEffectiveDefaultPlaceholders() {
            const defaults = computeEffectiveFieldDefaults();
            Object.keys(defaults).forEach(function(id) {
                const entry = defaults[id];
                if (entry.value === null || entry.value === undefined) return;
                const input = document.getElementById(id);
                if (input) input.placeholder = String(entry.value);
            });
        }

        function isFieldUnsettable(path) {
            const field = VIF.fieldRegistry.getFieldByPath(path);
            return !!field && field.inheritMode === 'blank-inherits';
        }

        function isFieldBlank(id, entry) {
            if (typeof entry.isBlank === 'function') return entry.isBlank();
            const input = document.getElementById(id);
            return !input || !input.value || !input.value.trim();
        }

        function readNumericInputValue(id, integer, scale) {
            const input = document.getElementById(id);
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

        function collectUnsetFields() {
            if (isNewStream()) return [];
            const defaults = computeEffectiveFieldDefaults();
            const paths = [];
            Object.keys(defaults).forEach(function(id) {
                const entry = defaults[id];
                if (!isFieldUnsettable(entry.path)) return;
                if (!isFieldBlank(id, entry)) return;
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
                meterEl.textContent = 'Matches the source frame rate — each window will be evenly subsampled to the endpoint’s image cap. Use a fixed rate for predictable sampling.';
                return;
            }
            const images = Math.round(duration * effectiveFps * 100) / 100;
            if (images > VLM_TYPICAL_ENDPOINT_IMAGE_CAP) {
                meterEl.classList.add('text-warn');
                meterEl.textContent = `Images per request: ${images} — above the bundled endpoint's default cap (${VLM_TYPICAL_ENDPOINT_IMAGE_CAP}); the service will evenly subsample each window down to the endpoint's limit. For full-quality sampling keep Duration × Inference FPS at or below the cap.`;
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

        function toggleSyntheticApiKeyVisibility() {
            const input = document.getElementById('cfg-synthetic-api-key');
            const btn   = document.getElementById('cfg-synthetic-api-key-toggle');
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
        function syntheticEndpointIsNvcf() {
            const endpointInput = document.getElementById('cfg-synthetic-endpoint');
            if (!endpointInput) return false;
            const effective = endpointInput.value.trim() || (endpointInput.dataset.globalDefault || '');
            return /(^|\.)nvcf\.nvidia\.com(:\d+)?$/i.test(effective);
        }

        function updateSyntheticEndpointFields() {
            const nvcfFields = document.getElementById('synthetic-nvcf-fields');
            const mtlsHint   = document.getElementById('synthetic-mtls-hint');
            const tlsCerts   = document.getElementById('synthetic-tls-certs-group');
            if (!nvcfFields || !mtlsHint || !tlsCerts) return;
            const isNvcf = syntheticEndpointIsNvcf();
            nvcfFields.style.display = isNvcf ? 'block' : 'none';
            mtlsHint.style.display   = isNvcf ? 'none' : 'block';
            tlsCerts.style.display   = isNvcf ? 'none' : 'block';
        }

        function setSyntheticTlsCertsExpanded(show) {
            document.getElementById('cfg-synthetic-tls-certs').style.display = show ? 'block' : 'none';
            document.getElementById('cfg-synthetic-tls-certs-caret').innerHTML = show ? '&#9662;' : '&#9656;';
        }

        function toggleSyntheticTlsCerts() {
            setSyntheticTlsCertsExpanded(document.getElementById('cfg-synthetic-tls-certs').style.display === 'none');
        }

        function toggleVlmApiKeyVisibility() {
            const input = document.getElementById('cfg-vlm-api-key');
            const btn   = document.getElementById('cfg-vlm-api-key-toggle');
            const hide  = input.type === 'password';
            input.type      = hide ? 'text' : 'password';
            btn.textContent = hide ? 'Hide' : 'Show';
        }

        // Disable an API-key Show/Hide toggle when its field is empty (nothing to reveal), and
        // snap the field back to masked so it can never be left showing an empty value.
        function syncApiKeyToggleState(inputId, toggleId) {
            const input = document.getElementById(inputId);
            const btn   = document.getElementById(toggleId);
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
            syncApiKeyToggleState('cfg-synthetic-api-key', 'cfg-synthetic-api-key-toggle');
            syncApiKeyToggleState('cfg-vlm-api-key', 'cfg-vlm-api-key-toggle');
        }

        function getApiUrl() {
            const stream = getSelectedStream();
            if (!stream) return null;
            return `${serverUrl}/v1/server/plugin/vif/applications/${encodeURIComponent(stream.appName)}/streams/${encodeURIComponent(stream.streamName)}/config`;
        }

        async function loadStreams(preferredValue) {
            const select = document.getElementById('cfg-stream-select');
            setFormLoading(true);
            try {
                const storedValue = getStoredSelectedStreamValue();
                const currentValue = preferredValue !== undefined
                    ? preferredValue
                    : (select.value || storedValue);
                const response = await fetch(`${serverUrl}/v1/server/plugin/vif/config`, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Basic ${encodedCredentials}`,
                        'Content-Type': 'application/json'
                    }
                });

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                const config = await response.json();
                // Preserve the API's ordering (server sorts by priority_id, then app, then stream name).
                streamsList = config.streams || [];
                defaultConfig = Object.assign({}, config);
                delete defaultConfig.streams;
                refreshEffectiveDefaultPlaceholders();
                populateClassNameDropdown();
                populateCheckpointPaths();

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
                populateForm(defaultConfig);
                // A new stream leaves VIS URL/API key blank so they inherit from the default
                // config at runtime, rather than baking a copy of the current global values into
                // the stream's own config. populateForm(defaultConfig) above filled them in from
                // the global defaults, so clear them back to blank (their placeholders already read
                // "inherited from default config").
                document.getElementById('cfg-vi-service-url').value = '';
                document.getElementById('cfg-vi-service-api-key').value = '';
                syncApiKeyToggleState('cfg-vi-service-api-key', 'cfg-vi-service-api-key-toggle');
                resetNewStreamMatchFields();
                applySuggestedDefaultsForNewStream();
                suppressDirtyTracking = false;
                document.getElementById('cfg-detector-type').value = 'object';
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

        async function cloneConfig() {
            const stream = getSelectedStream();
            if (!stream) return;
            const apiUrl = getApiUrl();
            if (!apiUrl) return;

            try {
                suppressDirtyTracking = true;
                const response = await fetch(apiUrl, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Basic ${encodedCredentials}`,
                        'Content-Type': 'application/json'
                    }
                });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                const config = await response.json();
                const select = document.getElementById('cfg-stream-select');
                select.value = '__new__';
                onStreamSelected();
                populateForm(config);
                document.getElementById('cfg-new-app-name').value = config.app_name || stream.appName || '';
                document.getElementById('cfg-new-stream-name').value = '';
                showStatus('Config cloned. Enter a new stream name or regex, then save.', false);
                markDirty();
            } catch (error) {
                console.error("Error cloning config:", error);
                showStatus(`Error cloning config: ${error.message}`, true);
            } finally {
                suppressDirtyTracking = false;
            }
        }


        function getVlmMode() {
            const checked = document.querySelector('#cfg-vlm-mode input[name="vlm-mode"]:checked');
            return checked ? checked.value : 'detect';
        }

        // Detect "Reasoning Level" (Low / Medium / High). The selector writes ONLY the level
        // marker; VIS owns the per-level prompts and per-class schema and applies them
        // server-side. Sub-choice inside Detect only, separate from getVlmMode().
        function getReasoningLevel() {
            const checked = document.querySelector('#cfg-vlm-reasoning-level input[name="vlm-reasoning-level"]:checked');
            return checked ? checked.value : 'high';
        }

        function setReasoningLevel(level) {
            const value = (level === 'low' || level === 'medium') ? level : 'high';
            const radios = document.querySelectorAll('#cfg-vlm-reasoning-level input[name="vlm-reasoning-level"]');
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
        function toggleVlmModelNameOther() {
            const isOther = document.getElementById('cfg-vlm-model-name').value === VLM_MODEL_OTHER;
            document.getElementById('cfg-vlm-model-name-other').style.display = isOther ? 'block' : 'none';
            markDirty();
        }

        // Effective model_name from the dropdown, or the custom text when "Other" is chosen.
        // Empty custom -> null so the stream inherits the global default.
        function readVlmModelName() {
            const select = document.getElementById('cfg-vlm-model-name');
            if (select.value === VLM_MODEL_OTHER) {
                return document.getElementById('cfg-vlm-model-name-other').value.trim() || null;
            }
            return select.value || null;
        }

        // Select the option matching modelName; an unknown value loads into "Other" + custom input.
        function setVlmModelName(modelName) {
            const select = document.getElementById('cfg-vlm-model-name');
            const other = document.getElementById('cfg-vlm-model-name-other');
            if (modelName && VLM_KNOWN_MODELS.indexOf(modelName) === -1) {
                select.value = VLM_MODEL_OTHER;
                other.value = modelName;
            } else {
                select.value = modelName || VLM_KNOWN_MODELS[0];
                other.value = '';
            }
            toggleVlmModelNameOther();
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
        function buildVlmEndpointUrl() {
            let s = document.getElementById('cfg-vlm-endpoint-url').value.trim();
            if (!s) return null;
            if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) s = 'http://' + s;
            // No path after host:port (a lone trailing / counts as none) -> append /v1.
            const rest = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
            if (!/\/./.test(rest)) s = s.replace(/\/$/, '') + '/v1';
            return s;
        }

        // Endpoint the Verify button probes: the field (normalized to a full URL), else the
        // effective global default layered the same way the load block does.
        function effectiveVlmEndpointForTest() {
            const fromField = buildVlmEndpointUrl();
            if (fromField) return fromField;
            const globalVa = (defaultConfig && defaultConfig.vlm_analysis) || {};
            return globalVa.endpoint_url || VLM_FALLBACK_DEFAULTS.endpoint_url || null;
        }

        // Bumped on every clear so an in-flight probe knows its result is stale.
        var vlmEndpointTestSeq = 0;

        function clearVlmEndpointTestResult() {
            vlmEndpointTestSeq++;
            const el = document.getElementById('cfg-vlm-endpoint-test-result');
            if (!el) return;
            el.style.display = 'none';
            el.className = 'endpoint-test-result';
            el.textContent = '';
        }

        function showVlmEndpointTestResult(cls) {
            const el = document.getElementById('cfg-vlm-endpoint-test-result');
            el.className = 'endpoint-test-result ' + cls;
            el.style.display = '';
            return el;
        }

        // Server-side connectivity probe: the browser can't reach compose-internal
        // hostnames, so the Engine plugin issues GET <endpoint>/models on our behalf.
        async function testVlmEndpoint() {
            const btn = document.getElementById('cfg-vlm-endpoint-test');
            const endpoint = effectiveVlmEndpointForTest();
            if (!endpoint) {
                showVlmEndpointTestResult('error').textContent = '✗ No VLM endpoint configured';
                return;
            }
            // Layer the key like the endpoint: the per-stream field, else the global default.
            const globalVa = (defaultConfig && defaultConfig.vlm_analysis) || {};
            const apiKey = document.getElementById('cfg-vlm-api-key').value || globalVa.api_key || '';

            const original = btn.textContent;
            btn.disabled = true;
            btn.textContent = 'Verifying…';
            showVlmEndpointTestResult('').textContent = 'Verifying…';
            const seq = ++vlmEndpointTestSeq;

            try {
                // POST body (not query params) so the api_key stays out of logged URLs.
                const payload = { endpoint_url: endpoint };
                if (apiKey) payload.api_key = apiKey;
                const response = await fetch(`${serverUrl}/v1/server/plugin/vif/vlm/test`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Basic ${encodedCredentials}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                const result = await response.json();
                if (seq !== vlmEndpointTestSeq) return; // field edited mid-flight; result is stale
                renderVlmEndpointTestOutcome(result);
            } catch (error) {
                if (seq !== vlmEndpointTestSeq) return;
                showVlmEndpointTestResult('error').textContent = `✗ ${error.message}`;
            } finally {
                btn.disabled = false;
                btn.textContent = original;
            }
        }

        function renderVlmEndpointTestOutcome(result) {
            const models = Array.isArray(result.models) ? result.models : [];
            if (result.reachable && models.length) {
                // Compare against the model the stream would actually use (field,
                // else the global default). A single served model that differs is
                // adopted right away — the note reports the change; save persists it.
                const globalVa = (defaultConfig && defaultConfig.vlm_analysis) || {};
                const configured = readVlmModelName() || globalVa.model_name || VLM_FALLBACK_DEFAULTS.model_name;
                const matches = models.indexOf(configured) !== -1;
                if (matches) {
                    showVlmEndpointTestResult('ok').textContent =
                        `✓ Reachable — serving: ${models.join(', ')} (matches the configured model)`;
                } else if (models.length === 1) {
                    setVlmModelName(models[0]);
                    markDirty();
                    showVlmEndpointTestResult('warn').textContent =
                        `⚠ Reachable — serving: ${models[0]}; the configured model (${configured}) did not match, so it was updated. Save to keep it.`;
                } else {
                    showVlmEndpointTestResult('warn').textContent =
                        `⚠ Reachable — serving: ${models.join(', ')}, which does not match the configured model (${configured}). Pick one of the served models.`;
                }
                return;
            }
            if (result.reachable) {
                // Reachable but no usable model list: auth rejection, redirect, or
                // a model listing too large/odd to read.
                showVlmEndpointTestResult('warn').textContent = `⚠ ${result.error || 'Endpoint reachable but returned no models'}`;
                return;
            }
            showVlmEndpointTestResult('error').textContent = `✗ ${result.error || 'Endpoint unreachable'}`;
        }

        function toggleVlmMode() {
            const mode = getVlmMode();
            document.getElementById('vlm-mode-detect').style.display = mode === 'detect' ? 'block' : 'none';
            document.getElementById('vlm-mode-describe').style.display = mode === 'describe' ? 'block' : 'none';
            document.getElementById('vlm-mode-custom').style.display = mode === 'custom' ? 'block' : 'none';
            if (mode === 'detect' || mode === 'custom') {
                const targetId = mode === 'detect' ? 'cfg-vlm-detect-classes' : 'cfg-vlm-custom-classes';
                const sourceId = mode === 'detect' ? 'cfg-vlm-custom-classes' : 'cfg-vlm-detect-classes';
                carryOverVlmClasses(sourceId, targetId);
            }
            if (mode === 'custom') updateVlmCustomLint();
            // Leaving Detect resets the reasoning level to High so Custom/Describe never
            // carry a Low/Medium marker. On a Low/Medium load, populateForm sets the level
            // AFTER this runs (mode is 'detect' there), so a reopened config keeps its level.
            if (mode !== 'detect') setReasoningLevel('high');
            // Re-fit the now-visible Custom-mode textareas to any prefilled content — a
            // programmatic value set (loadConfig) fires no 'input' event. Safe in any
            // mode: vlmAutoGrowAll skips textareas that are still hidden.
            if (window.vlmAutoGrowAll) window.vlmAutoGrowAll();
            markDirty();
        }

        function setVlmMode(mode) {
            const radios = document.querySelectorAll('#cfg-vlm-mode input[name="vlm-mode"]');
            radios.forEach(function(r) { r.checked = (r.value === mode); });
            toggleVlmMode();
        }

        function addClassRow(containerId, name, options) {
            options = options || {};
            const withHint = options.withHint !== false;
            const container = document.getElementById(containerId);
            const row = document.createElement('div');
            row.className = withHint ? 'vlm-class-row' : 'vif-class-row';

            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = withHint ? 'vlm-class-name' : 'vif-class-name';
            nameInput.placeholder = options.placeholder || 'class (e.g. fire)';
            nameInput.value = name || '';
            nameInput.addEventListener('input', function() { markDirty(); if (withHint) updateVlmCustomLint(); });

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'btn-danger';
            removeBtn.textContent = '×';
            removeBtn.title = 'Remove class';
            removeBtn.onclick = function() { row.remove(); markDirty(); if (withHint) updateVlmCustomLint(); };

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
                updateVlmCustomLint();
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
            updateVlmCustomLint();
        }

        function addVlmClassRow(containerId, name, hint) {
            addClassRow(containerId, name, { hint: hint, withHint: true });
        }

        function collectClassRows(containerId, options) {
            options = options || {};
            const withHint = options.withHint !== false;
            const rowSelector = withHint ? '.vlm-class-row' : '.vif-class-row';
            const nameSelector = withHint ? '.vlm-class-name' : '.vif-class-name';
            const rows = document.querySelectorAll('#' + containerId + ' ' + rowSelector);
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
        function collectVlmClasses(containerId) {
            return collectClassRows(containerId, { withHint: true });
        }

        function populateClassRows(containerId, classNames, classHints, options) {
            options = options || {};
            const withHint = options.withHint !== false;
            const hints = classHints || {};
            const lowerHints = {};
            for (const k of Object.keys(hints)) {
                lowerHints[k.toLowerCase()] = hints[k];
            }
            for (const cn of (classNames || [])) {
                addClassRow(containerId, cn, {
                    hint: withHint ? (lowerHints[cn.toLowerCase()] || '') : undefined,
                    withHint: withHint
                });
            }
        }

        // Populate a repeater (Detect or Custom) from a config's class_names +
        // class_hints. Inverse of collectVlmClasses().
        function populateVlmClassRows(containerId, classNames, classHints) {
            populateClassRows(containerId, classNames, classHints, { withHint: true });
        }

        function carryOverVlmClasses(sourceId, targetId) {
            const targetHasRows = document.querySelectorAll('#' + targetId + ' .vlm-class-row').length > 0;
            if (targetHasRows) return;
            const source = collectVlmClasses(sourceId);
            if (source.classNames.length === 0) return;
            populateVlmClassRows(targetId, source.classNames, source.classHints);
        }

        function toggleVlmAdvanced() {
            const adv = document.getElementById('cfg-vlm-advanced');
            const caret = document.getElementById('cfg-vlm-advanced-caret');
            const show = adv.style.display === 'none';
            adv.style.display = show ? 'block' : 'none';
            caret.innerHTML = show ? '&#9662;' : '&#9656;';
        }

        function updateVlmCustomLint() {
            const warn = document.getElementById('vlm-custom-classlist-warning');
            if (!warn) return;
            const hasClasses = collectVlmClasses('cfg-vlm-custom-classes').classNames.length > 0;
            const sys = document.getElementById('cfg-vlm-system-prompt').value;
            const usr = document.getElementById('cfg-vlm-user-prompt').value;
            const hasPlaceholder = sys.indexOf('{class_list}') !== -1 || usr.indexOf('{class_list}') !== -1;
            warn.style.display = (hasClasses && !hasPlaceholder) ? 'block' : 'none';
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
                    showStatus(missingFields.join(' '), true);
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
                vi_service_api_key: document.getElementById('cfg-vi-service-api-key').value.trim() || null,
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
            if (detectorType === 'scene' || detectorType === 'vlm') {
                config.catch_up_to_live = document.getElementById('cfg-catch-up-to-live').checked;
                // Optional: blank => null (backend derives ~2s). Don't use readNumericInputValue here —
                // it substitutes the placeholder and so could never produce null.
                const catchUpMaxBehindRaw = document.getElementById('cfg-catch-up-max-behind').value.trim();
                config.catch_up_max_behind_seconds = catchUpMaxBehindRaw === '' ? null : parseFloat(catchUpMaxBehindRaw);
            }

            config.rollup_batch_interval = readNumericInputValue('cfg-rollup-batch-interval', false);
            if (fieldAppliesToDetector('ignore_untracked_objects', detectorType)) {
                config.ignore_untracked_objects = document.getElementById('cfg-ignore-untracked-objects').checked;
            }

            if (detectorType === 'object') {
                const classNames = Array.from(document.getElementById('cfg-class-names').selectedOptions).map(o => o.value);

                const trackingMethod = document.getElementById('cfg-tracking-method').value;

                const modelName = document.getElementById('cfg-model-name').value;
                config.object_analysis = {
                    class_names: classNames,
                    model_name: modelName,
                    confidence_threshold: readNumericInputValue('cfg-confidence-threshold', false, 100),
                    tracking_method: trackingMethod || null
                };

                if (modelName === 'custom') {
                    config.object_analysis.checkpoint_path = document.getElementById('cfg-checkpoint-path').value || null;
                }

                if (trackingMethod === 'byte-track') {
                    config.object_analysis.byte_track_properties = {
                        track_creation_minimum_confidence: readNumericInputValue('cfg-bt-min-confidence', false, 100),
                        max_lost_track_frames_before_track_removal: readNumericInputValue('cfg-bt-max-lost-frames', true),
                        minimum_consecutive_track_overlap: readNumericInputValue('cfg-bt-min-overlap', false, 100),
                        track_creation_minimum_consecutive_frames: readNumericInputValue('cfg-bt-min-frames', true)
                    };
                }

                const tilingEnabled = document.getElementById('cfg-tiling-enabled').checked;
                if (tilingEnabled) {
                    const tilingMode = document.getElementById('cfg-tiling-mode').value || 'fixed';
                    config.object_analysis.tiling_mode = tilingMode;
                    const tilingProperties = {
                        max_slice_rows: readNumericInputValue('cfg-tiling-max-rows', true),
                        max_slice_cols: readNumericInputValue('cfg-tiling-max-cols', true),
                        tile_coverage_cutoff: readNumericInputValue('cfg-tiling-coverage-cutoff', false, 100)
                    };
                    if (tilingMode === 'gated') {
                        tilingProperties.min_slice_rows = readNumericInputValue('cfg-tiling-min-rows', true);
                        tilingProperties.min_slice_cols = readNumericInputValue('cfg-tiling-min-cols', true);
                        // Gated always has the full-frame probe, so cluster suppression always applies.
                        tilingProperties.cluster_suppression_min_children = readNumericInputValue('cfg-tiling-cluster-children', true);
                    } else {
                        // Fixed mode: the full-frame pass is opt-in, and cluster suppression
                        // is only meaningful (and only sent) when that pass is enabled.
                        const fullFrame = document.getElementById('cfg-tiling-full-frame').checked;
                        tilingProperties.full_frame_detection = fullFrame;
                        if (fullFrame) {
                            tilingProperties.cluster_suppression_min_children = readNumericInputValue('cfg-tiling-cluster-children', true);
                        }
                    }
                    config.object_analysis.tiling_properties = tilingProperties;
                } else {
                    // Tiling off — a single full-frame pass. tiling_mode 'none' is the
                    // master switch; tiling_properties is omitted.
                    config.object_analysis.tiling_mode = 'none';
                }
            }

            if (detectorType === 'scene') {
                const sceneClassNames = collectClassRows('cfg-scene-class-names', { withHint: false }).classNames;

                config.scene_analysis = {
                    class_names: sceneClassNames,
                    sensitivity: readNumericInputValue('cfg-scene-sensitivity', false),
                    confidence_threshold: readNumericInputValue('cfg-scene-confidence-threshold', false, 100),
                };
            }

            if (detectorType === 'vlm') {
                // Shared connection + advanced fields (every mode). Class/prompt keys
                // are added per active mode below and ONLY for that mode, so VIS's
                // field-presence mode inference stays unambiguous (mode-bleed guard).
                const vlm = {
                    model_name: readVlmModelName(),
                    endpoint_url: buildVlmEndpointUrl(),
                    api_key: document.getElementById('cfg-vlm-api-key').value || null,
                    request_timeout_seconds: readNumericInputValue('cfg-vlm-request-timeout', false),
                    temperature: readNumericInputValue('cfg-vlm-temperature', false),
                    max_tokens: readNumericInputValue('cfg-vlm-max-tokens', true),
                    // max_concurrent_requests is JSON-only (Default.json); not exposed in the UI.
                };
                const vlmMode = getVlmMode();
                if (vlmMode === 'detect') {
                    // Per-class repeater -> class_names (+ class_hints for rows with a note).
                    const detect = collectVlmClasses('cfg-vlm-detect-classes');
                    vlm.class_names = detect.classNames;
                    if (Object.keys(detect.classHints).length > 0) {
                        vlm.class_hints = detect.classHints;
                    }
                    // High is the DEFAULT and rides as ABSENT — VIS treats a missing
                    // reasoning_level as High. Only Low/Medium ride as explicit markers;
                    // sending "high" explicitly would pin it and silently override a stream
                    // (or fleet default) that means to stay on the default. VIS owns the
                    // Low/Medium prompts/schema/sizing — the UI sends only the level.
                    const reasoningLevel = getReasoningLevel();
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
                    vlm.system_prompt = document.getElementById('cfg-vlm-system-prompt').value.trim() || null;
                    vlm.user_prompt = document.getElementById('cfg-vlm-user-prompt').value.trim() || null;
                    // Same per-class repeater as Detect: class_names (+ class_hints).
                    const customCls = collectVlmClasses('cfg-vlm-custom-classes');
                    if (customCls.classNames.length > 0) {
                        vlm.class_names = customCls.classNames;
                        if (Object.keys(customCls.classHints).length > 0) {
                            vlm.class_hints = customCls.classHints;
                        }
                    }
                    const responseSchema = window.vlmOutputSchemaForSave
                        ? window.vlmOutputSchemaForSave()
                        : collectVlmSchema();
                    if (responseSchema) {
                        vlm.response_schema = responseSchema;
                    }
                }
                // Describe mode: no class/prompt keys — VIS uses the descriptive default.
                config.vlm_analysis = vlm;
            }

            let syntheticUnsets = [];
            if (detectorType === 'synthetic') {
                // Field names mirror the VIS WSSyntheticConfigMessage contract; blank => null
                // so the global synthetic_analysis defaults (video-intelligence.json) apply.
                const useTlsRaw = document.getElementById('cfg-synthetic-use-tls').value;
                const thresholdRaw = document.getElementById('cfg-synthetic-classification-threshold').value.trim();
                // NVCF-only credentials vs self-hosted-only cert paths: only the set that
                // applies to the effective endpoint is serialized. The other set is hidden in
                // the UI, and merely sending null would leave a previously-saved value in the
                // stored config (synthetic_analysis is deep-merged, not replaced wholesale),
                // so it is explicitly unset below -- otherwise an NVCF api_key saved during
                // evaluation would keep riding as a Bearer header to a self-hosted endpoint.
                const nvcf = syntheticEndpointIsNvcf();
                config.synthetic_analysis = {
                    endpoint: document.getElementById('cfg-synthetic-endpoint').value.trim() || null,
                    // '' => auto-detect (null); 'true'/'false' => explicit override.
                    use_tls: useTlsRaw === '' ? null : useTlsRaw === 'true',
                    tls_ca_cert: nvcf ? null : document.getElementById('cfg-synthetic-tls-ca-cert').value.trim() || null,
                    tls_client_cert: nvcf ? null : document.getElementById('cfg-synthetic-tls-client-cert').value.trim() || null,
                    tls_client_key: nvcf ? null : document.getElementById('cfg-synthetic-tls-client-key').value.trim() || null,
                    api_key: nvcf ? document.getElementById('cfg-synthetic-api-key').value || null : null,
                    function_id: nvcf ? document.getElementById('cfg-synthetic-function-id').value.trim() || null : null,
                    classification_threshold: thresholdRaw === '' ? null : parseFloat(thresholdRaw),
                };
                if (!isNewStream()) {
                    syntheticUnsets = (nvcf
                        ? ['synthetic_analysis.tls_ca_cert', 'synthetic_analysis.tls_client_cert', 'synthetic_analysis.tls_client_key']
                        : ['synthetic_analysis.api_key', 'synthetic_analysis.function_id']
                    ).filter(function(path) {
                        const stored = getConfigValueAtPath(lastRawStreamConfig, path);
                        return stored !== null && stored !== undefined;
                    });
                }
            }

            config.vif_event_listeners = buildEventListenersJson();

            // syntheticUnsets can overlap collectUnsetFields (a gated-off field that is
            // also blank) -- dedupe the union.
            const unsetFields = Array.from(new Set(collectUnsetFields().concat(syntheticUnsets)));
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

            if (config.detector_type === 'vlm') {
                const va = config.vlm_analysis || {};
                const effectiveModel = va.model_name
                    || (defaultConfig && defaultConfig.vlm_analysis && defaultConfig.vlm_analysis.model_name);
                if (!effectiveModel) errors.push('No VLM model is configured. Select a model, or set vlm_defaults.model in Default.json on the Engine host.');
                if (config.duration !== undefined && config.duration !== null
                    && (!Number.isFinite(config.duration) || config.duration < 0 || config.duration > 5)) {
                    errors.push('Duration must be between 0 and 5 for VLM detection.');
                }
                const inVlmCustomMode = ('user_prompt' in va) || ('system_prompt' in va) || ('response_schema' in va);
                if (inVlmCustomMode && !(va.user_prompt && String(va.user_prompt).trim())) {
                    errors.push('User Prompt is required for VLM Custom mode.');
                }
                // Output Schema: only Raw JSON can be invalid (the Fields builder always
                // emits valid JSON). One shared validator also refreshes the inline error.
                if (inVlmCustomMode) {
                    const schemaError = validateVlmSchema();
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

        function resetForm() {
            suppressDirtyTracking = true;
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
            document.getElementById('cfg-ignore-untracked-objects').checked = false;
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

            // Object analysis
            document.getElementById('cfg-class-names').innerHTML = '';
            document.getElementById('cfg-model-name').value = '';
            document.getElementById('cfg-checkpoint-path').value = '';
            document.getElementById('cfg-confidence-threshold').value = '';
            document.getElementById('cfg-tracking-method').value = '';

            // ByteTrack
            document.getElementById('cfg-bt-min-confidence').value = '';
            document.getElementById('cfg-bt-max-lost-frames').value = '';
            document.getElementById('cfg-bt-min-overlap').value = '';
            document.getElementById('cfg-bt-min-frames').value = '';

            // Tiling
            document.getElementById('cfg-tiling-enabled').checked = false;
            document.getElementById('cfg-tiling-mode').value = 'fixed';
            document.getElementById('cfg-tiling-min-rows').value = '';
            document.getElementById('cfg-tiling-min-cols').value = '';
            document.getElementById('cfg-tiling-max-rows').value = '';
            document.getElementById('cfg-tiling-max-cols').value = '';
            document.getElementById('cfg-tiling-coverage-cutoff').value = '';
            document.getElementById('cfg-tiling-full-frame').checked = false;
            document.getElementById('cfg-tiling-cluster-children').value = '';

            document.getElementById('cfg-scene-class-names').innerHTML = '';
            document.getElementById('cfg-scene-sensitivity').value = '';
            document.getElementById('cfg-scene-confidence-threshold').value = '';

            // VLM analysis
            setVlmModelName(VLM_KNOWN_MODELS[0]);
            document.getElementById('cfg-vlm-endpoint-url').value = '';
            document.getElementById('cfg-vlm-api-key').value = '';
            syncApiKeyToggleState('cfg-vlm-api-key', 'cfg-vlm-api-key-toggle');
            clearVlmEndpointTestResult();
            document.getElementById('cfg-vlm-detect-classes').innerHTML = '';
            document.getElementById('cfg-vlm-custom-classes').innerHTML = '';
            document.getElementById('cfg-vlm-system-prompt').value = '';
            document.getElementById('cfg-vlm-user-prompt').value = '';
            if (typeof resetVlmSchemaBuilder === 'function') resetVlmSchemaBuilder();
            document.getElementById('cfg-vlm-request-timeout').value = '';
            document.getElementById('cfg-vlm-temperature').value = '';
            document.getElementById('cfg-vlm-max-tokens').value = '';
            document.getElementById('cfg-vlm-advanced').style.display = 'none';
            document.getElementById('cfg-vlm-advanced-caret').innerHTML = '&#9656;';
            document.getElementById('vlm-custom-classlist-warning').style.display = 'none';
            setReasoningLevel('high'); // default reasoning level
            setVlmMode('detect');
            // max_concurrent_requests is JSON-only (Default.json); not exposed in the UI.

            document.getElementById('cfg-synthetic-endpoint').value = '';
            document.getElementById('cfg-synthetic-endpoint').dataset.globalDefault = '';
            document.getElementById('cfg-synthetic-use-tls').value = '';
            ['cfg-synthetic-tls-ca-cert', 'cfg-synthetic-tls-client-cert', 'cfg-synthetic-tls-client-key'].forEach(function(id) {
                const input = document.getElementById(id);
                input.value = '';
                input.placeholder = '';
            });
            setSyntheticTlsCertsExpanded(false);
            document.getElementById('cfg-synthetic-api-key').value = '';
            syncApiKeyToggleState('cfg-synthetic-api-key', 'cfg-synthetic-api-key-toggle');
            document.getElementById('cfg-synthetic-function-id').value = '';
            document.getElementById('cfg-synthetic-classification-threshold').value = '';
            updateSyntheticEndpointFields();
            suppressDirtyTracking = false;
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
            if (config.ignore_untracked_objects !== undefined) {
                document.getElementById('cfg-ignore-untracked-objects').checked = config.ignore_untracked_objects;
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

            if (config.object_analysis || isNewStream()) {
                const oa = config.object_analysis || {};
                if (oa.model_name) {
                    document.getElementById('cfg-model-name').value = oa.model_name;
                }
                if (oa.checkpoint_path) {
                    populateCheckpointPaths(oa.checkpoint_path);
                    document.getElementById('cfg-checkpoint-path').value = oa.checkpoint_path;
                }
                updateClassNamesOptions();
                if (oa.class_names && oa.class_names.length > 0) {
                    const classSelect = document.getElementById('cfg-class-names');
                    const nameSet = new Set(oa.class_names);
                    Array.from(classSelect.options).forEach(opt => { opt.selected = nameSet.has(opt.value); });
                }
                if (oa.confidence_threshold !== undefined) {
                    document.getElementById('cfg-confidence-threshold').value = Math.round(oa.confidence_threshold * 100);
                }
                if (oa.tracking_method) {
                    document.getElementById('cfg-tracking-method').value = oa.tracking_method;
                }
                if (oa.byte_track_properties) {
                    const bt = oa.byte_track_properties;
                    if (bt.track_creation_minimum_confidence !== undefined) {
                        document.getElementById('cfg-bt-min-confidence').value = Math.round(bt.track_creation_minimum_confidence * 100);
                    }
                    if (bt.max_lost_track_frames_before_track_removal !== undefined) {
                        document.getElementById('cfg-bt-max-lost-frames').value = bt.max_lost_track_frames_before_track_removal;
                    }
                    if (bt.minimum_consecutive_track_overlap !== undefined) {
                        document.getElementById('cfg-bt-min-overlap').value = Math.round(bt.minimum_consecutive_track_overlap * 100);
                    }
                    if (bt.track_creation_minimum_consecutive_frames !== undefined) {
                        document.getElementById('cfg-bt-min-frames').value = bt.track_creation_minimum_consecutive_frames;
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
                document.getElementById('cfg-tiling-enabled').checked = tilingOn;
                if (tilingMode === 'fixed' || tilingMode === 'gated') {
                    document.getElementById('cfg-tiling-mode').value = tilingMode;
                }
                if (oa.tiling_properties) {
                    const tp = oa.tiling_properties;
                    if (tp.min_slice_rows !== undefined) {
                        document.getElementById('cfg-tiling-min-rows').value = tp.min_slice_rows;
                    }
                    if (tp.min_slice_cols !== undefined) {
                        document.getElementById('cfg-tiling-min-cols').value = tp.min_slice_cols;
                    }
                    if (tp.max_slice_rows !== undefined) {
                        document.getElementById('cfg-tiling-max-rows').value = tp.max_slice_rows;
                    }
                    if (tp.max_slice_cols !== undefined) {
                        document.getElementById('cfg-tiling-max-cols').value = tp.max_slice_cols;
                    }
                    if (tp.tile_coverage_cutoff !== undefined) {
                        document.getElementById('cfg-tiling-coverage-cutoff').value = Math.round(tp.tile_coverage_cutoff * 100);
                    }
                    document.getElementById('cfg-tiling-full-frame').checked = !!tp.full_frame_detection;
                    if (tp.cluster_suppression_min_children !== undefined) {
                        document.getElementById('cfg-tiling-cluster-children').value = tp.cluster_suppression_min_children;
                    }
                }
            }

            if (config.scene_analysis || isNewStream()) {
                const sa = config.scene_analysis || {};
                if (sa.class_names) {
                    populateClassRows('cfg-scene-class-names', sa.class_names, null, { withHint: false });
                }
                if (sa.sensitivity !== undefined) {
                    document.getElementById('cfg-scene-sensitivity').value = sa.sensitivity;
                }
                if (sa.confidence_threshold !== undefined) {
                    document.getElementById('cfg-scene-confidence-threshold').value = Math.round(sa.confidence_threshold * 100);
                }
            }

            {
                const va = config.vlm_analysis || {};
                const globalVa = (defaultConfig && defaultConfig.vlm_analysis) || {};

                setVlmModelName(va.model_name || globalVa.model_name || VLM_FALLBACK_DEFAULTS.model_name);

                const endpointInput = document.getElementById('cfg-vlm-endpoint-url');
                if (va.endpoint_url) endpointInput.value = va.endpoint_url;
                const effectiveEndpoint = globalVa.endpoint_url || VLM_FALLBACK_DEFAULTS.endpoint_url;
                if (effectiveEndpoint) endpointInput.placeholder = vlmEndpointPlaceholder(effectiveEndpoint);
                clearVlmEndpointTestResult();

                if (va.api_key) {
                    document.getElementById('cfg-vlm-api-key').value = va.api_key;
                }
                syncApiKeyToggleState('cfg-vlm-api-key', 'cfg-vlm-api-key-toggle');

                const timeoutInput = document.getElementById('cfg-vlm-request-timeout');
                if (va.request_timeout_seconds !== undefined && va.request_timeout_seconds !== null) {
                    timeoutInput.value = va.request_timeout_seconds;
                }
                if (globalVa.request_timeout_seconds !== undefined && globalVa.request_timeout_seconds !== null) {
                    timeoutInput.placeholder = String(globalVa.request_timeout_seconds);
                }

                const temperatureInput = document.getElementById('cfg-vlm-temperature');
                if (va.temperature !== undefined && va.temperature !== null) {
                    temperatureInput.value = va.temperature;
                }
                if (globalVa.temperature !== undefined && globalVa.temperature !== null) {
                    temperatureInput.placeholder = String(globalVa.temperature);
                }

                const maxTokensInput = document.getElementById('cfg-vlm-max-tokens');
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
                        document.getElementById('cfg-vlm-system-prompt').value = va.system_prompt;
                    }
                    if (va.user_prompt) {
                        document.getElementById('cfg-vlm-user-prompt').value = va.user_prompt;
                    }
                    if (hasClasses) {
                        populateVlmClassRows('cfg-vlm-custom-classes', va.class_names, va.class_hints);
                    }
                    // Pick the Output Schema kind from the loaded schema: absent -> Free-form,
                    // the live default class schema -> Per-class verdicts, anything else ->
                    // Custom (loaded into the Fields/Raw editor).
                    if (window.applyVlmOutputSchema) {
                        window.applyVlmOutputSchema(va.response_schema);
                    } else if (va.response_schema) {
                        loadVlmSchema(va.response_schema);
                    }
                } else if (vlmMode === 'detect') {
                    if (hasClasses) {
                        populateVlmClassRows('cfg-vlm-detect-classes', va.class_names, va.class_hints);
                    }
                }
                setVlmMode(vlmMode);
                // After setVlmMode so the leaving-Detect reset in toggleVlmMode can't clobber
                // it. Only Detect mode carries the loaded level; Custom/Describe (incl. a config
                // where a prompt won over a stray level) reset to High. Absent/unknown -> High.
                setReasoningLevel(vlmMode === 'detect' ? (reasoningLevel || 'high') : 'high');
            }

            {
                const sy = config.synthetic_analysis || {};
                const globalSy = (defaultConfig && defaultConfig.synthetic_analysis) || {};

                const endpointInput = document.getElementById('cfg-synthetic-endpoint');
                if (sy.endpoint) endpointInput.value = sy.endpoint;
                if (globalSy.endpoint) endpointInput.placeholder = globalSy.endpoint;
                endpointInput.dataset.globalDefault = globalSy.endpoint || '';
                updateSyntheticEndpointFields();

                // use_tls is a tri-state <select> ('' auto-detect / true / false), not a
                // text/number input - it has no placeholder to show an effective default
                // in, so an unset stream value leaves it on '' (auto-detect), same as before.
                if (typeof sy.use_tls === 'boolean') {
                    document.getElementById('cfg-synthetic-use-tls').value = String(sy.use_tls);
                }

                // Stream value in the field, global default as its placeholder (endpoint
                // pattern); auto-expand the disclosure when any TLS material is in effect.
                let anyTlsCert = false;
                [['cfg-synthetic-tls-ca-cert', 'tls_ca_cert'],
                 ['cfg-synthetic-tls-client-cert', 'tls_client_cert'],
                 ['cfg-synthetic-tls-client-key', 'tls_client_key']].forEach(function(pair) {
                    const input = document.getElementById(pair[0]);
                    if (sy[pair[1]]) input.value = sy[pair[1]];
                    if (globalSy[pair[1]]) input.placeholder = globalSy[pair[1]];
                    if (sy[pair[1]] || globalSy[pair[1]]) anyTlsCert = true;
                });
                setSyntheticTlsCertsExpanded(anyTlsCert);

                if (sy.api_key) {
                    document.getElementById('cfg-synthetic-api-key').value = sy.api_key;
                }
                syncApiKeyToggleState('cfg-synthetic-api-key', 'cfg-synthetic-api-key-toggle');
                if (sy.function_id) {
                    document.getElementById('cfg-synthetic-function-id').value = sy.function_id;
                }

                const thresholdInput = document.getElementById('cfg-synthetic-classification-threshold');
                if (sy.classification_threshold !== undefined && sy.classification_threshold !== null) {
                    thresholdInput.value = sy.classification_threshold;
                }
                if (globalSy.classification_threshold !== undefined && globalSy.classification_threshold !== null) {
                    thresholdInput.placeholder = String(globalSy.classification_threshold);
                }
            }

            // Event listeners
            populateEventListeners(config.vif_event_listeners);

            toggleByteTrack();
            toggleCheckpointPath();
            toggleTiling();
            toggleDetectorSection();
            // Round 3: capture this stream's own raw `config` (as returned by GET, or
            // defaultConfig for a new stream) for buildConfigJson()'s collectUnsetFields() to
            // read stored values from at save time - not the layered/effective values the
            // inputs now show as placeholders. (Previously fed the removed pinned/inherited
            // badge rendering via updateFieldInheritIndicators().)
            lastRawStreamConfig = config;
            suppressDirtyTracking = false;
            markClean(false);
        }

        function populateCheckpointPaths(existingPath) {
            var select = document.getElementById('cfg-checkpoint-path');
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

        function toggleDetectorSection() {
            const detectorTypeSelect = document.getElementById('cfg-detector-type');
            const detectorType = detectorTypeSelect.value;
            const useTranscoder = document.getElementById('cfg-use-transcoder').checked;

            VIF.fieldRegistry.sections.forEach(function(section) {
                const el = document.getElementById(section.group);
                if (el) el.style.display = section.detectors.indexOf(detectorType) !== -1 ? 'block' : 'none';
            });
            // Keep the VLM mode panels in sync with the selected mode whenever the
            // section becomes visible.
            if (detectorType === 'vlm') toggleVlmMode();

            VIF.fieldRegistry.fields.forEach(function(field) {
                if (field.group) {
                    let visible = field.detectors.indexOf(detectorType) !== -1;
                    // cfg-inference-fps-group / cfg-frame-grab-group also gate on Use
                    // Transcoder (synthetic taps the source H.264 directly - no transcode, no
                    // JPEG sampling or keyframe thumbnailing - so neither control applies
                    // there regardless of the checkbox, which `detectors` above already
                    // excludes synthetic from).
                    if (field.transcoderGate === 'on') visible = visible && useTranscoder;
                    if (field.transcoderGate === 'off') visible = visible && !useTranscoder;
                    const groupEl = document.getElementById(field.group);
                    if (groupEl) groupEl.style.display = visible ? 'flex' : 'none';
                }
                if (field.rule && field.rule.byDetector) {
                    FIELD_RULES[field.id] = VIF.fieldRegistry.effectiveRule(field, detectorType);
                    applyNumericRuleToInput(document.getElementById(field.id), FIELD_RULES[field.id]);
                }
                if (field.help) {
                    showDetectorHelp(field.help.prefix, detectorType, field.help.detectors);
                }
            });

            if (activeListenerName && eventListenersData[activeListenerName]) {
                const current = eventListenersData[activeListenerName];
                updateEventMethodOptions(current.class_name, current.methods);
                updatePropertiesVisibility();
            }
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

        document.getElementById('cfg-synthetic-api-key').addEventListener('input', function() {
            syncApiKeyToggleState('cfg-synthetic-api-key', 'cfg-synthetic-api-key-toggle');
        });
        syncApiKeyToggleState('cfg-synthetic-api-key', 'cfg-synthetic-api-key-toggle');

        document.getElementById('cfg-synthetic-endpoint').addEventListener('input', updateSyntheticEndpointFields);
        updateSyntheticEndpointFields();

        document.getElementById('cfg-vlm-api-key').addEventListener('input', function() {
            syncApiKeyToggleState('cfg-vlm-api-key', 'cfg-vlm-api-key-toggle');
        });
        syncApiKeyToggleState('cfg-vlm-api-key', 'cfg-vlm-api-key-toggle');

        // A stale probe result no longer describes an edited endpoint, model, or API
        // key — clear it (which also invalidates any in-flight probe).
        document.getElementById('cfg-vlm-endpoint-url').addEventListener('input', clearVlmEndpointTestResult);
        document.getElementById('cfg-vlm-model-name').addEventListener('change', clearVlmEndpointTestResult);
        document.getElementById('cfg-vlm-model-name-other').addEventListener('input', clearVlmEndpointTestResult);
        document.getElementById('cfg-vlm-api-key').addEventListener('input', clearVlmEndpointTestResult);

        // Populate the model dropdown from VLM_MODEL_OPTIONS, ahead of the fixed "Other…"
        // option (guarded in case the script re-evaluates over an already-populated DOM).
        (function() {
            const select = document.getElementById('cfg-vlm-model-name');
            if (select.querySelector('option[value="' + VLM_MODEL_OPTIONS[0].value + '"]')) return;
            const otherOption = select.querySelector('option[value="' + VLM_MODEL_OTHER + '"]');
            VLM_MODEL_OPTIONS.forEach(function(o) {
                const option = document.createElement('option');
                option.value = o.value;
                option.textContent = o.label;
                select.insertBefore(option, otherOption);
            });
        })();

        document.getElementById('cfg-detector-type').addEventListener('change', async function() {
            syncListenerFields();
            const previousDetectorType = this.dataset.previousValue || '';
            const nextDetectorType = this.value;

            if (nextDetectorType && previousDetectorType && nextDetectorType !== previousDetectorType) {
                await preloadConfiguredListenerSchemas();
                const conflicts = getDetectorTypeSwitchConflicts(nextDetectorType);
                if (conflicts.length > 0) {
                    this.value = previousDetectorType;
                    toggleDetectorSection();
                    showStatus(buildDetectorTypeSwitchConflictMessage(nextDetectorType, conflicts), true);
                    alert(buildDetectorTypeSwitchConflictDialogMessage(nextDetectorType, conflicts));
                    return;
                }
            }

            applyDetectorTypeInferenceFpsSuggestion(nextDetectorType);
            applyDetectorTypeTranscoderSuggestion(nextDetectorType);
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

        function showStatus(message, isError) {
            const el = document.getElementById('status-message');
            if (!el) return;
            if (statusHideTimer) clearTimeout(statusHideTimer);
            if (statusClearTimer) clearTimeout(statusClearTimer);
            el.textContent = message;
            el.className = `visible ${isError ? 'error' : 'success'}`;
            statusHideTimer = setTimeout(() => {
                el.classList.remove('visible');
                statusClearTimer = setTimeout(() => {
                    el.className = '';
                    el.textContent = '';
                }, 240);
            }, 3000);
        }

        async function getConfig() {
            const apiUrl = getApiUrl();
            if (!apiUrl) return;
            setFormLoading(true);
            try {
                suppressDirtyTracking = true;
                const response = await fetch(apiUrl, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Basic ${encodedCredentials}`,
                        'Content-Type': 'application/json'
                    }
                });

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                const config = await response.json();
                populateForm(config);
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

        async function saveConfig() {
            const config = buildConfigJson();
            if (!config) return;
            const validationErrors = collectValidationErrors(config);
            if (validationErrors.length > 0) {
                showStatus(validationErrors.join(' '), true);
                return;
            }

            const isNew = isNewStream();
            const apiUrl = isNew
                ? `${serverUrl}/v1/server/plugin/vif/applications/${encodeURIComponent(config.app_name)}/streams/${encodeURIComponent(config.stream_name)}/config`
                : getApiUrl();
            if (!apiUrl) return;

            setFormLoading(true);
            try {
                setSavingState(true);
                const response = await fetch(apiUrl, {
                    method: isNew ? 'POST' : 'PUT',
                    body: JSON.stringify(config),
                    headers: {
                        'Authorization': `Basic ${encodedCredentials}`,
                        'Content-Type': 'application/json'
                    }
                });

                // 409 Conflict: the stream config already exists (e.g. creating a stream whose
                // name/regex is already configured). Surface a clear message rather than a raw HTTP error.
                if (response.status === 409) {
                    showStatus('Stream configuration already exists', true);
                    return;
                }

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                await response.json();
                showStatus(isNew ? 'Stream config created successfully' : 'Config saved successfully', false);
                lockListenerTypesAfterSave();
                markClean(true);

                // A committed save with a non-NVCF endpoint dropped the NVCF credentials from
                // the config (nulled + unset in buildConfigJson); clear them from the form too
                // so the secrets don't linger hidden in the DOM.
                if (document.getElementById('cfg-detector-type').value === 'synthetic' && !syntheticEndpointIsNvcf()) {
                    document.getElementById('cfg-synthetic-api-key').value = '';
                    syncApiKeyToggleState('cfg-synthetic-api-key', 'cfg-synthetic-api-key-toggle');
                    document.getElementById('cfg-synthetic-function-id').value = '';
                }

                if (isNew) {
                    const newValue = `${config.app_name}::${config.stream_name}`;
                    await loadStreams(newValue);
                }

            } catch (error) {
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

            const apiUrl = getApiUrl();
            if (!apiUrl) return;

            try {
                const response = await fetch(apiUrl, {
                    method: 'DELETE',
                    headers: {
                        'Authorization': `Basic ${encodedCredentials}`,
                        'Content-Type': 'application/json'
                    }
                });

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                showStatus('Stream config deleted successfully', false);
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
        window.saveConfig = saveConfig;
        window.cloneConfig = cloneConfig;
        window.deleteConfig = deleteConfig;
        window.togglePanel = togglePanel;
        window.toggleCheckpointPath = toggleCheckpointPath;
        window.updateClassNamesOptions = updateClassNamesOptions;
        window.toggleByteTrack = toggleByteTrack;
        window.toggleTiling = toggleTiling;
        window.toggleTilingMode = toggleTilingMode;
        window.toggleFullFrameDetection = toggleFullFrameDetection;
        window.toggleVlmMode = toggleVlmMode;
        window.addVlmClassRow = addVlmClassRow;
        window.addClassRow = addClassRow;
        window.updateVlmCustomLint = updateVlmCustomLint;
        window.toggleVlmAdvanced = toggleVlmAdvanced;
        window.toggleSyntheticTlsCerts = toggleSyntheticTlsCerts;
        window.toggleVisServiceApiKeyVisibility = toggleVisServiceApiKeyVisibility;
        window.toggleSyntheticApiKeyVisibility = toggleSyntheticApiKeyVisibility;
        window.toggleVlmApiKeyVisibility = toggleVlmApiKeyVisibility;
        window.toggleVlmModelNameOther = toggleVlmModelNameOther;
        window.testVlmEndpoint = testVlmEndpoint;

        // (c) cross-file: exposed because vif-listeners.js's applyTextRuleToInput()/
        //     renderScalarField() and the vlm-*.js modules (markDirty from both
        //     vlm-schema-builder.js and vlm-prompt-guide.js; updateVlmCustomLint from
        //     vlm-prompt-guide.js's useTemplate(), guarded there with `typeof`) call
        //     these directly. (updateVlmCustomLint is also markup-exposed above.)
        window.markDirty = markDirty;
        window.isValidCssColor = isValidCssColor;
        window.applyNumericRuleToInput = applyNumericRuleToInput;

        // Spec-facing API (plan P2-T3 sub-step 4): the qa_automation baseline
        // specs and baselines.cjs prepare scripts call these four via
        // VIF.streamConfig.* - their permanent home. (The temporary bare
        // window.* aliases the Phase-1 specs used were removed here once the
        // paired spec migration to the namespaced form landed.)
        VIF.streamConfig.toggleDetectorSection = toggleDetectorSection;
        VIF.streamConfig.buildConfigJson = buildConfigJson;
        VIF.streamConfig.collectValidationErrors = collectValidationErrors;
        VIF.streamConfig.populateForm = populateForm;

        // vif-listeners.js's own init() sets up the listener-subsystem state
        // (eventListenersData/activeListenerName) and DOM bindings (evt-class-name,
        // evt-methods, evt-confidence, ...) that toggleDetectorSection()/
        // updateListenerTip()/loadStreams() below all reach into.
        VIF.listeners.init();

        // Initialize
        console.log(`VIF ${new Date().toISOString().slice(0, 10)}`);

        var tilingEnableGroupEl = document.getElementById('tiling-enable-group');
        var tilingUiEnabled = new URLSearchParams(window.location.search).get('tiling') === 'true';
        if (tilingUiEnabled) tilingEnableGroupEl.style.display = '';

        initializeStaticFieldRules();
        initializeStaticFieldTooltips();
        toggleByteTrack();
        toggleCheckpointPath();
        toggleTiling();
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
