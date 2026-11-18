(function () {
    window.VIF = window.VIF || {};
    var VIF = window.VIF;
    VIF.defaultConfig = VIF.defaultConfig || {};

    VIF.defaultConfig.init = function () {
        if (!VIF.core.verifyEnabled()) {
            var verifySection = document.getElementById('def-verify-section');
            if (verifySection) verifySection.style.display = 'none';
        }

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

        // ── secret fields ─────────────────────────────────────────────────────
        var SECRET_FIELDS = [
            ['def-vi-service-api-key', 'def-api-key-toggle'],
            ['def-synthetic-api-key', 'def-synthetic-api-key-toggle'],
            ['def-synthetic-tls-client-key', null],
            ['def-verify-svd-api-key', 'def-verify-svd-api-key-toggle'],
            ['def-verify-review-api-key', 'def-verify-review-api-key-toggle']
        ];

        window.toggleSecretVisibility = function (inputId, buttonId) {
            var input  = document.getElementById(inputId);
            var btn    = document.getElementById(buttonId);
            var hidden = input.type === 'password';
            input.type = hidden ? 'text' : 'password';
            btn.textContent = hidden ? 'Hide' : 'Show';
        };
        window.toggleApiKeyVisibility = function () {
            window.toggleSecretVisibility('def-vi-service-api-key', 'def-api-key-toggle');
        };

        // Disable the Show/Hide toggle when the field is empty (nothing to reveal), and
        // snap it back to masked. Re-asserted after the fieldset is re-enabled on load, which
        // would otherwise leave the button enabled over an empty field.
        function syncSecretToggleState(inputId, buttonId) {
            var input = document.getElementById(inputId);
            var btn   = buttonId && document.getElementById(buttonId);
            if (!input) return;
            var empty = (input.value || '').trim() === '';
            // "Save as secret" stores what was typed, so like Show it waits for a value.
            var saveAs = input.parentElement && input.parentElement.querySelector('.secret-save-as');
            if (saveAs) saveAs.disabled = empty;
            if (!btn) return;
            btn.disabled = empty;
            if (empty) {
                input.type      = 'password';
                btn.textContent = 'Show';
            }
        }
        function syncSecretToggles() {
            SECRET_FIELDS.forEach(function (pair) { syncSecretToggleState(pair[0], pair[1]); });
        }
        SECRET_FIELDS.forEach(function (pair) {
            document.getElementById(pair[0]).addEventListener('input', function () {
                syncSecretToggleState(pair[0], pair[1]);
            });
        });

        // ── the credential slots: a stored secret by name, or a typed value ───
        // Same pattern as stream-config.html. `base` is the literal input's id; the mode
        // select is <base>-source, the name picker <base>-secret, the value row
        // <base>-value-row and the store row <base>-store-row.
        var SLOT_BASES = ['def-vi-service-api-key', 'def-synthetic-api-key', 'def-synthetic-tls-client-key',
            'def-verify-svd-api-key', 'def-verify-review-api-key'];
        var secretNamesLoaded = [];

        function secretSourceIsStored(base) {
            var source = document.getElementById(base + '-source');
            return !!source && source.value === 'stored';
        }

        function applySecretSourceVisibility(base) {
            var stored = secretSourceIsStored(base);
            var valueRow = document.getElementById(base + '-value-row');
            var picker = document.getElementById(base + '-secret');
            var storeRow = document.getElementById(base + '-store-row');
            if (valueRow) valueRow.style.display = stored ? 'none' : '';
            if (picker) picker.style.display = stored ? '' : 'none';
            if (storeRow && stored) storeRow.style.display = 'none';
        }

        window.secretSourceChanged = function (base) {
            applySecretSourceVisibility(base);
            if (secretSourceIsStored(base)) {
                // One form per slot: entering stored mode withdraws anything typed, or the
                // save would carry a literal beside the reference and be refused.
                var input = document.getElementById(base);
                if (input) input.value = '';
                syncSecretToggles();
            } else {
                var picker = document.getElementById(base + '-secret');
                if (picker) picker.value = '';
            }
        };

        function setPickerValue(picker, name) {
            // A stored reference always shows, even when its name has left the document.
            var known = Array.prototype.some.call(picker.options, function (o) { return o.value === name; });
            if (!known) {
                var opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name + ' (not configured)';
                picker.appendChild(opt);
            }
            picker.value = name;
        }

        function fillSecretPicker(base) {
            var picker = document.getElementById(base + '-secret');
            if (!picker) return;
            var selected = picker.value;
            picker.innerHTML = '';
            var none = document.createElement('option');
            none.value = '';
            none.textContent = secretNamesLoaded.length
                ? '(pick a secret)' : '(none — add one on the Secrets page)';
            picker.appendChild(none);
            secretNamesLoaded.forEach(function (name) {
                var opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                picker.appendChild(opt);
            });
            if (selected) setPickerValue(picker, selected);
        }

        function pickedSecret(base) {
            return (document.getElementById(base + '-secret') || {}).value || '';
        }

        function setSecretSlot(base, referenceName) {
            var source = document.getElementById(base + '-source');
            var picker = document.getElementById(base + '-secret');
            if (!source || !picker) return;
            // A reference is readable, so the slot shows it by name; anything else opens in
            // value mode — a stored literal is invisible to a read, and showing the picker
            // over it would report a configured slot as empty and hide the value-row
            // controls. An untouched save keeps the stored form either way.
            source.value = referenceName ? 'stored' : 'value';
            if (referenceName) setPickerValue(picker, referenceName);
            else picker.value = '';
            applySecretSourceVisibility(base);
        }

        async function loadSecretNames() {
            try {
                secretNamesLoaded = (await VIF.core.client().persist.secrets().get()).names || [];
            } catch (error) {
                secretNamesLoaded = [];
            }
            SLOT_BASES.forEach(fillSecretPicker);
        }

        // ── "Save as secret": promote a typed value into the secrets document ─
        window.promptStoreSecret = function (base) {
            var input = document.getElementById(base);
            if (!input || !(input.value || '').trim()) {
                showStatus('Type the value first, then save it as a secret.', true);
                return;
            }
            var row = document.getElementById(base + '-store-row');
            if (row) {
                row.style.display = '';
                var name = document.getElementById(base + '-store-name');
                if (name) name.focus();
            }
        };

        window.cancelStoreSecret = function (base) {
            var row = document.getElementById(base + '-store-row');
            if (row) row.style.display = 'none';
        };

        window.confirmStoreSecret = async function (base) {
            var input = document.getElementById(base);
            var nameInput = document.getElementById(base + '-store-name');
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
            SLOT_BASES.forEach(fillSecretPicker);
            if (nameInput) nameInput.value = '';
            window.cancelStoreSecret(base);
            // The value now lives in the document; the slot switches to it by name and the
            // typed literal is withdrawn so the save carries the reference alone.
            setSecretSlot(base, name);
            if (input) input.value = '';
            syncSecretToggles();
            showStatus('Secret "' + name + '" saved — this field now uses it. Save to apply.', false);
        };

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
        var THRESHOLD_RULE     = { min: 0,    max: 1,   decimals: 2  };
        var TIMEOUT_RULE       = { min: 1,              decimals: 1  };

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
        bindNumericInput('def-inference-fps',           INF_FPS_RULE,    'Whole number -1 or 1–120');
        bindNumericInput('def-frame-grab-interval',     FRAME_GRAB_RULE, 'Must be ≥ 0.01');
        bindNumericInput('def-duration',                DURATION_RULE,   'Must be 0–5');
        bindNumericInput('def-concurrent-object',       CONCURRENT_RULE, 'Must be a whole number ≥ 1');
        bindNumericInput('def-concurrent-scene',        CONCURRENT_RULE, 'Must be a whole number ≥ 1');
        bindNumericInput('def-verify-flag-threshold',   THRESHOLD_RULE,  'Must be 0–1');
        bindNumericInput('def-verify-strong-threshold', THRESHOLD_RULE,  'Must be 0–1');
        bindNumericInput('def-verify-review-timeout',   TIMEOUT_RULE,    'Must be ≥ 1');

        // ── synthetic baseline ────────────────────────────────────────────────
        function isNvcfAddress(address) {
            return /(^|\.)nvcf\.nvidia\.com(:\d+)?$/i.test(address || '');
        }

        var NVCF_FUNCTION_ID_REQUIRED = "NVIDIA's hosted detector requires a Function ID.";

        // As on a synthetic config: the hosted detector takes a key and a function id, a
        // self-hosted one client certificates.
        function syncSyntheticEndpointFields() {
            var nvcf = isNvcfAddress(document.getElementById('def-synthetic-endpoint').value.trim());
            document.getElementById('def-synthetic-nvcf-fields').style.display = nvcf ? '' : 'none';
            document.getElementById('def-synthetic-tls-cert-fields').style.display = nvcf ? 'none' : '';
        }
        document.getElementById('def-synthetic-endpoint').addEventListener('input', syncSyntheticEndpointFields);

        function showSvdTestResult(cls, text) {
            var el = document.getElementById('def-synthetic-endpoint-test-result');
            el.className = 'endpoint-test-result' + (cls ? ' ' + cls : '');
            el.style.display = '';
            el.textContent = text;
        }

        var svdTestSeq = 0;
        function clearSvdTestResult() {
            svdTestSeq++;
            var el = document.getElementById('def-synthetic-endpoint-test-result');
            el.style.display = 'none';
            el.textContent = '';
        }
        document.getElementById('def-synthetic-section').addEventListener('input', clearSvdTestResult);
        document.getElementById('def-synthetic-section').addEventListener('change', clearSvdTestResult);

        // The form as stored is probed by reference, so the Engine dials the default with the
        // credentials it holds. An edited form goes by value, which carries a typed key and no
        // secret name: null when a stored secret would have to ride it.
        function svdTestRequest() {
            var value = function (id) { return document.getElementById(id).value.trim(); };
            var nvcf = isNvcfAddress(value('def-synthetic-endpoint'));
            var useTls = value('def-synthetic-use-tls');
            var keyBase = nvcf ? 'def-synthetic-api-key' : 'def-synthetic-tls-client-key';
            var loadedSecret = (nvcf ? loadedSynthetic.api_key_secret : loadedSynthetic.tls_client_key_secret) || '';
            var typedKey = secretSourceIsStored(keyBase) ? '' : value(keyBase);
            var pickedName = secretSourceIsStored(keyBase) ? pickedSecret(keyBase) : '';
            var same = function (raw, loaded) { return raw === (loaded == null ? '' : String(loaded)); };
            var asStored = same(value('def-synthetic-endpoint'), loadedSynthetic.endpoint)
                && same(useTls, loadedSynthetic.use_tls) && typedKey === '' && pickedName === loadedSecret
                && (nvcf ? same(value('def-synthetic-function-id'), loadedSynthetic.function_id)
                    : same(value('def-synthetic-tls-ca-cert'), loadedSynthetic.tls_ca_cert)
                        && same(value('def-synthetic-tls-client-cert'), loadedSynthetic.tls_client_cert));
            if (asStored) return { streamGroupConfig: 'default', detectorType: 'synthetic' };
            if (pickedName) return null;
            return VIF.v2map.svdProbeRequestFromV1({
                endpoint: value('def-synthetic-endpoint'),
                use_tls: useTls === '' ? null : useTls === 'true',
                tls_ca_cert: nvcf ? '' : value('def-synthetic-tls-ca-cert'),
                tls_client_cert: nvcf ? '' : value('def-synthetic-tls-client-cert'),
                tls_client_key: nvcf ? '' : typedKey,
                api_key: nvcf ? typedKey : '',
                function_id: nvcf ? value('def-synthetic-function-id') : ''
            });
        }

        async function testDefaultSvdEndpoint() {
            var btn = document.getElementById('def-synthetic-endpoint-test');
            var address = document.getElementById('def-synthetic-endpoint').value.trim();
            if (address === '') return showSvdTestResult('error', '✗ No detector server set');
            if (/^https?:\/\//i.test(address)) {
                return showSvdTestResult('error', '✗ The detector server must be a host:port, like svd.docker:8001, not a web address.');
            }
            if (isNvcfAddress(address) && document.getElementById('def-synthetic-function-id').value.trim() === '') {
                return showSvdTestResult('error', '✗ ' + NVCF_FUNCTION_ID_REQUIRED);
            }
            var request = svdTestRequest();
            if (!request) {
                return showSvdTestResult('warn', '⚠ Save the changes, then Verify: the check uses the stored secret as saved with the default.');
            }
            var original = btn.textContent;
            btn.disabled = true;
            btn.textContent = 'Verifying…';
            showSvdTestResult('', 'Verifying…');
            var seq = ++svdTestSeq;
            try {
                var result = await VIF.core.client().probes.svdEndpoint(request);
                if (seq !== svdTestSeq) return;
                if (result.reachable && result.accepted) {
                    showSvdTestResult('ok', '✓ Reachable — an SVD service answered at ' + address + ' and accepted the credentials');
                } else if (result.reachable) {
                    showSvdTestResult('warn', '⚠ ' + (result.error || 'Reachable, but the endpoint did not accept the probe'));
                } else {
                    showSvdTestResult('error', '✗ ' + (result.error || 'Unreachable'));
                }
            } catch (error) {
                if (seq === svdTestSeq) showSvdTestResult('error', '✗ ' + error.message);
            } finally {
                btn.disabled = false;
                btn.textContent = original;
            }
        }
        window.testDefaultSvdEndpoint = testDefaultSvdEndpoint;

        // ── verify baseline ───────────────────────────────────────────────────
        var VERIFY_BUILTIN = { flag_threshold: 0.3, strong_threshold: 0.9 };

        (function offerReviewModels() {
            var list = document.getElementById('def-verify-review-models');
            var names = (VIF.fieldRegistry && VIF.fieldRegistry.VLM_MODEL_NAMES) || [];
            if (!list) return;
            names.filter(function (name) { return name.indexOf('nvidia/') === 0; }).forEach(function (name) {
                var option = document.createElement('option');
                option.value = name;
                list.appendChild(option);
            });
        })();

        function verifyEndpointIsNvcf() {
            return isNvcfAddress(document.getElementById('def-verify-svd-address').value.trim());
        }
        function syncVerifyNvcfFields() {
            document.getElementById('def-verify-nvcf-fields').style.display = verifyEndpointIsNvcf() ? '' : 'none';
        }
        document.getElementById('def-verify-svd-address').addEventListener('input', syncVerifyNvcfFields);

        // Same completion the Stream Configs editor applies to a typed VLM server: a bare
        // host gets a scheme, a host[:port] with no path gets the OpenAI-style /v1 base.
        function normalizeVlmEndpoint(s) {
            if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) s = 'http://' + s;
            var rest = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
            if (!/\/./.test(rest)) s = s.replace(/\/$/, '') + '/v1';
            return s;
        }

        // ── populate form from API response ───────────────────────────────────
        function setNumeric(id, val) {
            document.getElementById(id).value = (val != null) ? val : '';
        }
        function setText(id, val) {
            document.getElementById(id).value = (val != null) ? String(val) : '';
        }

        // What the stored verify baseline held at load: a field blanked against a stored
        // value is a clear, a field blank over nothing stored is left out of the write.
        var loadedVerify = {};
        var loadedSynthetic = {};

        function populateForm(config) {
            document.getElementById('def-vi-service-url').value = config.vi_service_url || '';
            document.getElementById('def-vi-service-api-key').value = config.vi_service_api_key || '';
            setSecretSlot('def-vi-service-api-key', config.vi_service_api_key_secret || null);
            document.getElementById('def-use-transcoder').checked = !!config.use_transcoder;
            setNumeric('def-inference-fps',       config.inference_fps);
            setNumeric('def-frame-grab-interval', config.frame_grab_interval);
            setNumeric('def-duration',            config.duration);
            var ce = config.concurrent_executions || {};
            setNumeric('def-concurrent-object', ce.object_detection && ce.object_detection.default != null ? ce.object_detection.default : null);
            setNumeric('def-concurrent-scene',  ce.scene_detection  && ce.scene_detection.default  != null ? ce.scene_detection.default  : null);

            var sy = config.synthetic_analysis || {};
            loadedSynthetic = {
                endpoint: sy.endpoint,
                use_tls: sy.use_tls,
                tls_ca_cert: sy.tls_ca_cert,
                tls_client_cert: sy.tls_client_cert,
                tls_client_key_secret: sy.tls_client_key_secret,
                api_key_secret: sy.api_key_secret,
                function_id: sy.function_id
            };
            setText('def-synthetic-endpoint',        sy.endpoint);
            setText('def-synthetic-use-tls',         typeof sy.use_tls === 'boolean' ? sy.use_tls : '');
            setText('def-synthetic-tls-ca-cert',     sy.tls_ca_cert);
            setText('def-synthetic-tls-client-cert', sy.tls_client_cert);
            setText('def-synthetic-function-id',     sy.function_id);
            document.getElementById('def-synthetic-api-key').value = '';
            document.getElementById('def-synthetic-tls-client-key').value = '';
            setSecretSlot('def-synthetic-api-key', sy.api_key_secret || null);
            setSecretSlot('def-synthetic-tls-client-key', sy.tls_client_key_secret || null);
            syncSyntheticEndpointFields();

            var vf  = config.verify_analysis || {};
            var svd = vf.svd || {};
            var vlm = vf.vlm || {};
            loadedVerify = {
                flag_threshold: vf.flag_threshold,
                strong_threshold: vf.strong_threshold,
                endpoint: svd.endpoint,
                function_id: svd.function_id,
                endpoint_url: vlm.endpoint_url,
                model_name: vlm.model_name,
                request_timeout_seconds: vlm.request_timeout_seconds
            };
            setNumeric('def-verify-flag-threshold',   vf.flag_threshold);
            setNumeric('def-verify-strong-threshold', vf.strong_threshold);
            setText('def-verify-svd-address',         svd.endpoint);
            setText('def-verify-svd-function-id',     svd.function_id);
            setText('def-verify-review-url',          vlm.endpoint_url);
            setText('def-verify-review-model',        vlm.model_name);
            setNumeric('def-verify-review-timeout',   vlm.request_timeout_seconds);
            document.getElementById('def-verify-svd-api-key').value = '';
            document.getElementById('def-verify-review-api-key').value = '';
            setSecretSlot('def-verify-svd-api-key', svd.api_key_secret || null);
            setSecretSlot('def-verify-review-api-key', vlm.api_key_secret || null);
            syncVerifyNvcfFields();
            syncSecretToggles();
        }

        // ── load ──────────────────────────────────────────────────────────────
        // The revision the write quotes; the attempt's own re-read refreshes it first.

        async function loadDefaultConfig() {
            document.getElementById('def-save-btn').disabled = true;
            document.getElementById('default-fieldset').disabled = true;
            try {
                var current = await VIF.core.client().persist.streamGroupConfigs.default().get();
                populateForm(VIF.v2map.flatDefaultFromV2(current));
                document.getElementById('def-save-btn').disabled = false;
                document.getElementById('default-fieldset').disabled = false;
                // Re-enabling the fieldset above also re-enables the toggle buttons; re-assert
                // the empty-key disabling.
                syncSecretToggles();
            } catch (err) {
                showStatus('Error loading config: ' + err.message + ' — refresh to retry.', true);
            }
        }

        // ── save ──────────────────────────────────────────────────────────────
        function fieldValue(id) {
            return document.getElementById(id).value.trim();
        }

        function verifyMember(id, loaded, parse) {
            return storedMember(fieldValue(id), loaded, parse);
        }

        function storedMember(raw, loaded, parse) {
            if (raw === '') return loaded != null ? null : undefined;
            var value = parse ? parse(raw) : raw;
            return loaded != null && String(value) === String(loaded) ? undefined : value;
        }

        function effectiveThreshold(id, loaded, builtin) {
            var raw = fieldValue(id);
            if (raw !== '') return parseFloat(raw);
            return loaded != null ? loaded : builtin;
        }

        function rejectField(message, id) {
            showStatus(message, true);
            document.getElementById(id).focus();
        }

        // The synthetic baseline's members, each as storedMember states it. Only the set the
        // address uses is read from the form, as a synthetic config saves it. The other set is
        // left as stored until the address moves across, and cleared then. A blank address, stored
        // or typed, is of neither kind and moves nothing.
        function syntheticBody(secrets) {
            var address = fieldValue('def-synthetic-endpoint');
            var nvcf = isNvcfAddress(address);
            var movedAcross = address !== '' && !!loadedSynthetic.endpoint && nvcf !== isNvcfAddress(loadedSynthetic.endpoint);
            var member = function (raw, applies, loaded) {
                if (!applies && !movedAcross) return undefined;
                return storedMember(applies ? raw : '', loaded);
            };
            var reference = function (base) {
                return secretSourceIsStored(base) ? pickedSecret(base) : '';
            };
            function key(base, flatPath, applies) {
                if (applies && !secretSourceIsStored(base) && fieldValue(base) !== '') secrets[flatPath] = fieldValue(base);
                else if (!applies && movedAcross) secrets[flatPath] = '';
            }
            key('def-synthetic-api-key', 'synthetic_analysis.api_key', nvcf);
            key('def-synthetic-tls-client-key', 'synthetic_analysis.tls_client_key', !nvcf);
            return {
                endpoint: storedMember(fieldValue('def-synthetic-endpoint'), loadedSynthetic.endpoint),
                use_tls: storedMember(fieldValue('def-synthetic-use-tls'), loadedSynthetic.use_tls,
                    function (raw) { return raw === 'true'; }),
                tls_ca_cert: member(fieldValue('def-synthetic-tls-ca-cert'), !nvcf, loadedSynthetic.tls_ca_cert),
                tls_client_cert: member(fieldValue('def-synthetic-tls-client-cert'), !nvcf, loadedSynthetic.tls_client_cert),
                tls_client_key_secret: member(reference('def-synthetic-tls-client-key'), !nvcf,
                    loadedSynthetic.tls_client_key_secret),
                api_key_secret: member(reference('def-synthetic-api-key'), nvcf, loadedSynthetic.api_key_secret),
                function_id: member(fieldValue('def-synthetic-function-id'), nvcf, loadedSynthetic.function_id)
            };
        }

        window.saveDefaultConfig = async function () {
            var urlVal       = fieldValue('def-vi-service-url');
            var keyVal       = fieldValue('def-vi-service-api-key');
            var fpsVal       = fpsInput.value.trim();
            var grabVal      = fieldValue('def-frame-grab-interval');
            var durationVal  = fieldValue('def-duration');
            var concObjVal   = fieldValue('def-concurrent-object');
            var concScnVal   = fieldValue('def-concurrent-scene');
            var flagVal      = fieldValue('def-verify-flag-threshold');
            var strongVal    = fieldValue('def-verify-strong-threshold');
            var timeoutVal   = fieldValue('def-verify-review-timeout');

            if (fpsVal !== '' && !validateNumericValue(fpsVal, INF_FPS_RULE)) {
                return rejectField('Inference FPS must be a whole number between 1 and 120, or -1 to match the stream frame rate.', 'def-inference-fps');
            }
            if (grabVal !== '' && !validateNumericValue(grabVal, FRAME_GRAB_RULE)) {
                return rejectField('Frame Grab Interval must be ≥ 0.01.', 'def-frame-grab-interval');
            }
            if (durationVal !== '' && !validateNumericValue(durationVal, DURATION_RULE)) {
                return rejectField('Duration must be between 0 and 5.', 'def-duration');
            }
            if (concObjVal !== '' && !validateNumericValue(concObjVal, CONCURRENT_RULE)) {
                return rejectField('Object Detection concurrent executions must be a whole number ≥ 1.', 'def-concurrent-object');
            }
            if (concScnVal !== '' && !validateNumericValue(concScnVal, CONCURRENT_RULE)) {
                return rejectField('Scene Detection concurrent executions must be a whole number ≥ 1.', 'def-concurrent-scene');
            }
            if (flagVal !== '' && !validateNumericValue(flagVal, THRESHOLD_RULE)) {
                return rejectField('Flag Threshold must be between 0 and 1.', 'def-verify-flag-threshold');
            }
            if (strongVal !== '' && !validateNumericValue(strongVal, THRESHOLD_RULE)) {
                return rejectField('Strong Threshold must be between 0 and 1.', 'def-verify-strong-threshold');
            }
            var flag   = effectiveThreshold('def-verify-flag-threshold',   loadedVerify.flag_threshold,   VERIFY_BUILTIN.flag_threshold);
            var strong = effectiveThreshold('def-verify-strong-threshold', loadedVerify.strong_threshold, VERIFY_BUILTIN.strong_threshold);
            if (strong < flag) {
                return rejectField('Strong Threshold must be at least the Flag Threshold (' + flag + ').', 'def-verify-strong-threshold');
            }
            if (timeoutVal !== '' && !validateNumericValue(timeoutVal, TIMEOUT_RULE)) {
                return rejectField('Request Timeout must be at least 1 second.', 'def-verify-review-timeout');
            }
            if (/^https?:\/\//i.test(fieldValue('def-synthetic-endpoint'))) {
                return rejectField('The detector server must be a host:port, like svd.docker:8001, not a web address.', 'def-synthetic-endpoint');
            }
            // Nothing below the defaults can supply a function ID the hosted detector needs.
            if (isNvcfAddress(fieldValue('def-synthetic-endpoint')) && fieldValue('def-synthetic-function-id') === '') {
                return rejectField(NVCF_FUNCTION_ID_REQUIRED, 'def-synthetic-function-id');
            }
            if (verifyEndpointIsNvcf() && fieldValue('def-verify-svd-function-id') === '') {
                return rejectField(NVCF_FUNCTION_ID_REQUIRED, 'def-verify-svd-function-id');
            }

            // The API keys are secrets the wire never echoes back, so each input's own
            // value is the whole signal: a typed key sets it, a blank field keeps the
            // stored one — which is what omitting it from the flat body means. In stored
            // mode the picked name travels instead (the server clears the stored literal),
            // and an empty picker keeps whatever the document holds.
            var body = {};
            if (urlVal !== '')      body.vi_service_url       = urlVal;
            if (secretSourceIsStored('def-vi-service-api-key')) {
                var pickedName = pickedSecret('def-vi-service-api-key');
                if (pickedName !== '') body.vi_service_api_key_secret = pickedName;
            } else if (keyVal !== '') {
                body.vi_service_api_key = keyVal;
            }
            if (fpsVal !== '')      body.inference_fps        = parseInt(fpsVal, 10);
            if (grabVal !== '')     body.frame_grab_interval  = parseFloat(grabVal);
            if (durationVal !== '') body.duration             = parseFloat(durationVal);
            body.use_transcoder = document.getElementById('def-use-transcoder').checked;
            if (concObjVal !== '' || concScnVal !== '') {
                body.concurrent_executions = {};
                if (concObjVal !== '') body.concurrent_executions.object_detection = { default: parseInt(concObjVal, 10) };
                if (concScnVal !== '') body.concurrent_executions.scene_detection  = { default: parseInt(concScnVal, 10) };
            }
            body.verify_analysis = {
                flag_threshold:   verifyMember('def-verify-flag-threshold',   loadedVerify.flag_threshold,   parseFloat),
                strong_threshold: verifyMember('def-verify-strong-threshold', loadedVerify.strong_threshold, parseFloat),
                svd: {
                    endpoint:    verifyMember('def-verify-svd-address',     loadedVerify.endpoint),
                    function_id: verifyMember('def-verify-svd-function-id', loadedVerify.function_id)
                },
                vlm: {
                    endpoint_url:            verifyMember('def-verify-review-url',     loadedVerify.endpoint_url, normalizeVlmEndpoint),
                    model_name:              verifyMember('def-verify-review-model',   loadedVerify.model_name),
                    request_timeout_seconds: verifyMember('def-verify-review-timeout', loadedVerify.request_timeout_seconds, parseFloat)
                }
            };
            var secrets = {};
            body.synthetic_analysis = syntheticBody(secrets);
            // Each Verify key slot sends its picked name, or its typed value; neither keeps it.
            if (secretSourceIsStored('def-verify-svd-api-key')) {
                if (pickedSecret('def-verify-svd-api-key')) body.verify_analysis.svd.api_key_secret = pickedSecret('def-verify-svd-api-key');
            } else if (fieldValue('def-verify-svd-api-key') !== '') {
                secrets['verify_analysis.svd.api_key'] = fieldValue('def-verify-svd-api-key');
            }
            if (secretSourceIsStored('def-verify-review-api-key')) {
                if (pickedSecret('def-verify-review-api-key')) body.verify_analysis.vlm.api_key_secret = pickedSecret('def-verify-review-api-key');
            } else if (fieldValue('def-verify-review-api-key') !== '') {
                secrets['verify_analysis.vlm.api_key'] = fieldValue('def-verify-review-api-key');
            }

            document.getElementById('def-save-btn').disabled = true;
            try {
                // The re-read inside the attempt is what carries a fresh revision,
                // so a lost race retries once.
                var result = await VIF.core.withConflictRetry(async function () {
                    var defaults = VIF.core.client().persist.streamGroupConfigs.default();
                    await defaults.get();
                    return defaults.update(VIF.v2map.defaultPatchFromV1(body, { secrets: secrets }));
                });
                // Refresh form with the merged values the server echoes back
                var merged = VIF.v2map.flatDefaultFromV2(result);
                if (merged.vi_service_url !== undefined || merged.inference_fps !== undefined
                    || merged.synthetic_analysis !== undefined || merged.verify_analysis !== undefined) {
                    populateForm(merged);
                }
                // Success rides the shared toast; wipe any error text still
                // sitting in the inline status slot from a previous attempt.
                var statusEl = document.getElementById('status-message');
                if (statusEl) { statusEl.className = ''; statusEl.textContent = ''; }
                VIF.core.toast('Saved successfully');
            } catch (err) {
                showStatus('Error saving: ' + err.message, true);
            } finally {
                document.getElementById('def-save-btn').disabled = false;
            }
        };

        // ── init ──────────────────────────────────────────────────────────────
        syncSecretToggles();
        syncSyntheticEndpointFields();
        syncVerifyNvcfFields();
        SLOT_BASES.forEach(applySecretSourceVisibility);
        loadSecretNames();
        loadDefaultConfig();
    };
})();
