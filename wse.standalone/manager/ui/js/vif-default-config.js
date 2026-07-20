(function () {
    window.VIF = window.VIF || {};
    var VIF = window.VIF;
    VIF.defaultConfig = VIF.defaultConfig || {};

    VIF.defaultConfig.init = function () {
        var resolvedServer = VIF.core.resolveServer();

        var API_URL = resolvedServer.serverUrl + '/v1/server/plugin/vif/config';
        var HEADERS = { 'Authorization': 'Basic ' + resolvedServer.encodedCredentials, 'Content-Type': 'application/json' };

        // ── status ───────────────────────────────────────────────────────────
        var statusTimer = null;
        function showStatus(msg, isError) {
            var el = document.getElementById('status-message');
            if (!el) return;
            clearTimeout(statusTimer);
            el.textContent = msg;
            el.className = 'visible ' + (isError ? 'error' : 'success');
            statusTimer = setTimeout(function () {
                el.classList.remove('visible');
            }, 3500);
        }

        // ── api key toggle ────────────────────────────────────────────────────
        window.toggleApiKeyVisibility = function () {
            var input  = document.getElementById('def-vi-service-api-key');
            var btn    = document.getElementById('def-api-key-toggle');
            var hidden = input.type === 'password';
            input.type = hidden ? 'text' : 'password';
            btn.textContent = hidden ? 'Hide' : 'Show';
        };

        // Disable the Show/Hide toggle when the API-key field is empty (nothing to reveal), and
        // snap it back to masked. Re-asserted after the fieldset is re-enabled on load, which
        // would otherwise leave the button enabled over an empty field.
        function syncApiKeyToggleState() {
            var input = document.getElementById('def-vi-service-api-key');
            var btn   = document.getElementById('def-api-key-toggle');
            if (!input || !btn) return;
            var empty = (input.value || '').trim() === '';
            btn.disabled = empty;
            if (empty) {
                input.type      = 'password';
                btn.textContent = 'Show';
            }
        }
        document.getElementById('def-vi-service-api-key').addEventListener('input', syncApiKeyToggleState);

        function sanitizeNumericString(raw, rule) {
            if (raw === '') return '';
            var allowNeg = Number.isFinite(rule.min) && rule.min < 0;
            var str = String(raw);
            var isNeg = allowNeg && str.startsWith('-');
            var value = str.replace(/[^0-9.]/g, '');
            var dot = value.indexOf('.');
            if (dot !== -1) {
                value = value.slice(0, dot + 1) + value.slice(dot + 1).replace(/\./g, '');
            }
            if (rule.integer) {
                value = value.split('.')[0];
            }
            if (isNeg && value !== '') value = '-' + value;
            return value;
        }

        function validateNumericValue(raw, rule) {
            if (raw === '' || raw == null) return false;
            var value = sanitizeNumericString(raw, rule);
            if (value === '' || value === '.') return false;
            var n = rule.integer ? parseInt(value, 10) : parseFloat(value);
            if (!Number.isFinite(n)) return false;
            if (Number.isFinite(rule.min) && n < rule.min) return false;
            if (Number.isFinite(rule.max) && n > rule.max) return false;
            return true;
        }

        function normalizeNumericValue(raw, rule) {
            var sanitized = sanitizeNumericString(raw, rule);
            if (sanitized === '' || sanitized === '.') return '';
            var n = rule.integer ? parseInt(sanitized, 10) : parseFloat(sanitized);
            if (!Number.isFinite(n)) return '';
            if (Number.isFinite(rule.min)) n = Math.max(rule.min, n);
            if (Number.isFinite(rule.max)) n = Math.min(rule.max, n);
            return String(n);
        }

        var INF_FPS_RULE       = { min: -1,   max: 120, integer: true };
        var FRAME_GRAB_RULE    = { min: 0.01,           decimals: 2  };
        var DURATION_RULE      = { min: 0,    max: 5,   decimals: 1  };
        var CONCURRENT_RULE    = { min: 1,              integer: true };

        function bindNumericInput(id, rule, hint) {
            var el = document.getElementById(id);
            el.addEventListener('input', function () {
                var s = sanitizeNumericString(el.value, rule);
                if (el.value !== s) el.value = s;
                var valid = el.value === '' || validateNumericValue(el.value, rule);
                el.setCustomValidity(valid ? '' : hint);
            });
            el.addEventListener('blur', function () {
                el.value = normalizeNumericValue(el.value, rule);
                var valid = el.value === '' || validateNumericValue(el.value, rule);
                el.setCustomValidity(valid ? '' : hint);
            });
        }

        var fpsInput = document.getElementById('def-inference-fps');
        bindNumericInput('def-inference-fps',      INF_FPS_RULE,    'Whole number -1 or 1–120');
        bindNumericInput('def-frame-grab-interval', FRAME_GRAB_RULE, 'Must be ≥ 0.01');
        bindNumericInput('def-duration',            DURATION_RULE,   'Must be 0–5');
        bindNumericInput('def-concurrent-object',   CONCURRENT_RULE, 'Must be a whole number ≥ 1');
        bindNumericInput('def-concurrent-scene',    CONCURRENT_RULE, 'Must be a whole number ≥ 1');

        // ── populate form from API response ───────────────────────────────────
        function setNumeric(id, val) {
            document.getElementById(id).value = (val != null) ? val : '';
        }

        function populateForm(config) {
            document.getElementById('def-vi-service-url').value = config.vi_service_url || '';
            document.getElementById('def-vi-service-api-key').value = config.vi_service_api_key || '';
            document.getElementById('def-use-transcoder').checked = !!config.use_transcoder;
            setNumeric('def-inference-fps',       config.inference_fps);
            setNumeric('def-frame-grab-interval', config.frame_grab_interval);
            setNumeric('def-duration',            config.duration);
            var ce = config.concurrent_executions || {};
            setNumeric('def-concurrent-object', ce.object_detection && ce.object_detection.default != null ? ce.object_detection.default : null);
            setNumeric('def-concurrent-scene',  ce.scene_detection  && ce.scene_detection.default  != null ? ce.scene_detection.default  : null);
            syncApiKeyToggleState();
        }

        // ── load ──────────────────────────────────────────────────────────────
        async function loadDefaultConfig() {
            document.getElementById('def-save-btn').disabled = true;
            document.getElementById('default-fieldset').disabled = true;
            try {
                var resp = await fetch(API_URL, { method: 'GET', headers: HEADERS });
                if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + resp.statusText);
                var config = await resp.json();
                populateForm(config);
                document.getElementById('def-save-btn').disabled = false;
                document.getElementById('default-fieldset').disabled = false;
                // Re-enabling the fieldset above also re-enables the toggle button; re-assert
                // the empty-key disabling.
                syncApiKeyToggleState();
            } catch (err) {
                showStatus('Error loading config: ' + err.message + ' — refresh to retry.', true);
            }
        }

        // ── save ──────────────────────────────────────────────────────────────
        window.saveDefaultConfig = async function () {
            var urlVal       = document.getElementById('def-vi-service-url').value.trim();
            var keyVal       = document.getElementById('def-vi-service-api-key').value.trim();
            var fpsVal       = fpsInput.value.trim();
            var grabVal      = document.getElementById('def-frame-grab-interval').value.trim();
            var durationVal  = document.getElementById('def-duration').value.trim();
            var concObjVal   = document.getElementById('def-concurrent-object').value.trim();
            var concScnVal   = document.getElementById('def-concurrent-scene').value.trim();

            if (fpsVal !== '' && !validateNumericValue(fpsVal, INF_FPS_RULE)) {
                showStatus('Inference FPS must be a whole number between 1 and 120, or -1 to match the stream frame rate.', true);
                fpsInput.focus();
                return;
            }
            if (grabVal !== '' && !validateNumericValue(grabVal, FRAME_GRAB_RULE)) {
                showStatus('Frame Grab Interval must be ≥ 0.01.', true);
                document.getElementById('def-frame-grab-interval').focus();
                return;
            }
            if (durationVal !== '' && !validateNumericValue(durationVal, DURATION_RULE)) {
                showStatus('Duration must be between 0 and 5.', true);
                document.getElementById('def-duration').focus();
                return;
            }
            if (concObjVal !== '' && !validateNumericValue(concObjVal, CONCURRENT_RULE)) {
                showStatus('Object Detection concurrent executions must be a whole number ≥ 1.', true);
                document.getElementById('def-concurrent-object').focus();
                return;
            }
            if (concScnVal !== '' && !validateNumericValue(concScnVal, CONCURRENT_RULE)) {
                showStatus('Scene Detection concurrent executions must be a whole number ≥ 1.', true);
                document.getElementById('def-concurrent-scene').focus();
                return;
            }

            var body = {};
            if (urlVal !== '')      body.vi_service_url       = urlVal;
            if (keyVal !== '')      body.vi_service_api_key   = keyVal;
            if (fpsVal !== '')      body.inference_fps        = parseInt(fpsVal, 10);
            if (grabVal !== '')     body.frame_grab_interval  = parseFloat(grabVal);
            if (durationVal !== '') body.duration             = parseFloat(durationVal);
            body.use_transcoder = document.getElementById('def-use-transcoder').checked;
            if (concObjVal !== '' || concScnVal !== '') {
                body.concurrent_executions = {};
                if (concObjVal !== '') body.concurrent_executions.object_detection = { default: parseInt(concObjVal, 10) };
                if (concScnVal !== '') body.concurrent_executions.scene_detection  = { default: parseInt(concScnVal, 10) };
            }

            document.getElementById('def-save-btn').disabled = true;
            try {
                var resp = await fetch(API_URL, {
                    method: 'PUT',
                    headers: HEADERS,
                    body: JSON.stringify(body)
                });
                if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + resp.statusText);
                var result = await resp.json();
                // Refresh form with the merged values the server echoes back
                if (result && (result.vi_service_url !== undefined || result.inference_fps !== undefined)) {
                    populateForm(result);
                }
                showStatus('Saved successfully', false);
            } catch (err) {
                showStatus('Error saving: ' + err.message, true);
            } finally {
                document.getElementById('def-save-btn').disabled = false;
            }
        };

        // ── init ──────────────────────────────────────────────────────────────
        syncApiKeyToggleState();
        loadDefaultConfig();
    };
})();
