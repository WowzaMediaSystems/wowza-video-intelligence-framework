(function () {
    window.VIF = window.VIF || {};
    var VIF = window.VIF;
    VIF.listeners = VIF.listeners || {};

    // Cache-busting version suffix (C4/P2-T1) - same literal as vif-core.js's
    // UI_VERSION (kept in sync automatically by the same CI version-bump
    // workflow - see the comment there), used below to version the
    // dynamically-constructed listeners/<ClassName>.js script URLs
    // (ensureListenerScriptLoaded).
    var UI_VERSION = '1.0.1';

    VIF.listeners.init = function () {
        var NEW_LISTENER_PRESET_TYPES = ['OverlayEvent', 'Id3Event', 'LogFileEvent', 'WebhookEvent2', 'ObjectTracking'];
        var LISTENER_DEFAULT_DISPLAY_NAMES = {
            OverlayEvent: 'Overlays',
            Id3Event: 'Id3Event',
            LogFileEvent: 'LogFile',
            WebhookEvent2: 'Webhook',
            ObjectTracking: 'ObjectTracker'
        };
        EVENT_METHOD_OPTIONS = [
            { value: 'disabled', label: 'Disabled' },
            { value: 'immediate', label: 'Immediate' },
            { value: 'batch', label: 'Batch' },
            { value: 'rollup', label: 'Rollup' }
        ];
        var isAddingNewListener = false;
        var LISTENER_PROPERTY_RULES = {
            OverlayEvent: {
                fade_step: { min: 0, max: 30, integer: true, label: 'Fade Step' }
            },
            ObjectTracking: {
                fade_step: { min: 0, max: 30, integer: true, label: 'Fade Step' },
                untriggered_object_color: { cssColor: true, label: 'Untriggered Object Color' },
                color: { cssColor: true, label: 'Color' }
            }
        };

        function normalizeValueForCompare(value) {
            if (Array.isArray(value)) {
                return value.map(normalizeValueForCompare);
            }
            if (value && typeof value === 'object') {
                const normalized = {};
                Object.keys(value).sort().forEach(function(key) {
                    normalized[key] = normalizeValueForCompare(value[key]);
                });
                return normalized;
            }
            return value;
        }

        function valuesEqual(a, b) {
            return JSON.stringify(normalizeValueForCompare(a)) === JSON.stringify(normalizeValueForCompare(b));
        }

        function getListenerPropertyRule(fieldKey) {
            if (!activeListenerName || !eventListenersData[activeListenerName]) return null;
            const shortName = resolveClassName(eventListenersData[activeListenerName].class_name || '');
            const rules = LISTENER_PROPERTY_RULES[shortName] || {};
            return rules[fieldKey] || null;
        }

        function applyTextRuleToInput(input, rule) {
            if (!input || !rule || !rule.cssColor) return;
            input.title = 'Enter any valid CSS color such as red, #ff0000, rgb(255,0,0), or rgba(255,0,0,0.5).';
            if (input.dataset.ruleBound === 'true') return;
            input.addEventListener('blur', function() {
                const valid = input.value === '' || isValidCssColor(input.value);
                input.setCustomValidity(valid ? '' : 'Enter a valid CSS color.');
            });
            input.dataset.ruleBound = 'true';
        }

        function onNewListenerTemplateChanged() {
            const templateSelect = document.getElementById('evt-new-listener-template');
            const nameInput = document.getElementById('evt-new-listener-name');
            if (!templateSelect || !nameInput) return;
            showListenerWarning('');

            const selected = templateSelect.value || '';
            const currentValue = nameInput.value.trim();
            const previousSuggestedValue = nameInput.dataset.suggestedValue || '';
            const suggestedValue = selected ? getUniqueListenerName(getDefaultListenerNameForType(selected)) : '';
            const shouldReplaceValue = currentValue === '' || currentValue === previousSuggestedValue || nameInput.dataset.userEdited !== 'true';

            if (!selected) {
                nameInput.style.display = 'none';
                nameInput.value = '';
                nameInput.dataset.suggestedValue = '';
                nameInput.dataset.userEdited = 'false';
                return;
            }

            nameInput.style.display = '';

            if (shouldReplaceValue) {
                nameInput.value = suggestedValue;
                nameInput.dataset.userEdited = 'false';
            }

            nameInput.dataset.suggestedValue = suggestedValue;
            nameInput.placeholder = '';
        }

        function refreshNewListenerTemplateOptions() {
            const templateSelect = document.getElementById('evt-new-listener-template');
            if (!templateSelect) return;

            const previousValue = templateSelect.value || '';
            const available = [];
            const merged = [];
            templateSelect.innerHTML = '';
            for (const [name, version] of Object.entries(defaultConfig.available_event_listeners || {})) {
                available.push(name);
            }

            const promptOption = document.createElement('option');
            promptOption.value = '';
            promptOption.textContent = 'Select listener type...';
            templateSelect.appendChild(promptOption);

            available.forEach(function(className) {
                const shortName = className.includes('.') ? className.substring(className.lastIndexOf('.') + 1) : className;
                if (!merged.includes(shortName)) merged.push(shortName);
            });

            NEW_LISTENER_PRESET_TYPES.forEach(function(typeName) {
                if (!merged.includes(typeName)) merged.push(typeName);
            });

            // P3-T3 (F5): a listener type not offered for the active detector type (present-but-
            // empty vlm_methods/synthetic_methods, e.g. ObjectTracking under vlm/synthetic) is
            // excluded from "Create New Listener" entirely - see isListenerTypeOfferedForDetector.
            const currentDetectorType = getCurrentDetectorType();
            const offeredTypes = merged.filter(function(typeName) {
                return isListenerTypeOfferedForDetector(typeName, currentDetectorType);
            });

            offeredTypes.forEach(function(typeName) {
                const option = document.createElement('option');
                option.value = typeName;
                option.textContent = typeName;
                templateSelect.appendChild(option);
            });

            const availableValues = Array.from(templateSelect.options).map(function(option) { return option.value; });
            templateSelect.value = availableValues.includes(previousValue)
                ? previousValue
                : (availableValues[1] || availableValues[0] || '');

            onNewListenerTemplateChanged();
        }

        function getDefaultListenerNameForType(className) {
            const shortName = resolveClassName(className || '');
            return LISTENER_DEFAULT_DISPLAY_NAMES[shortName] || shortName || 'Listener';
        }

        function getListenerTypeDisplayName(className) {

            const shortName = resolveClassName(className || '');
            const version = defaultConfig.available_event_listeners[shortName] || '?.?.?';
            return (shortName || 'Listener') + ' v' + version;
        }

        function updateListenerSelectOptionLabel(name) {
            const select = document.getElementById('evt-listener-select');
            if (!select || !name || !eventListenersData[name]) return;
            const option = select.querySelector('option[value="' + CSS.escape(name) + '"]');
            if (!option) return;
            option.textContent = name;
        }

        function updateSelectedListenerTypeDisplay(name) {
            return;
        }

        function getUniqueListenerName(baseName) {
            const normalizedBaseName = String(baseName || '').trim() || 'Listener';
            if (!eventListenersData[normalizedBaseName]) {
                return normalizedBaseName;
            }

            let index = 2;
            let candidate = normalizedBaseName + ' (' + index + ')';
            while (eventListenersData[candidate]) {
                index++;
                candidate = normalizedBaseName + ' (' + index + ')';
            }
            return candidate;
        }

        function validateNewListenerName(showWarning) {
            const nameInput = document.getElementById('evt-new-listener-name');
            const name = nameInput ? nameInput.value.trim() : '';
            if (!name) {
                if (showWarning) {
                    showListenerWarning('Listener name is required before you can create the listener.');
                }
                return false;
            }
            if (eventListenersData[name]) {
                if (showWarning) {
                    showListenerWarning('A listener with that name already exists. Choose a different name.');
                }
                return false;
            }
            if (showWarning) {
                showListenerWarning('');
            }
            return true;
        }

        function formatEventMethodLabel(method) {
            const match = EVENT_METHOD_OPTIONS.find(function(optionInfo) {
                return optionInfo.value === method;
            });
            return match ? match.label : method;
        }

        // Synthetic relays the source without transcoding by default, so there is no rendition for
        // OverlayEvent to burn the verdict into — overlays silently won't appear on playback or the
        // thumbnail. Warn when overlays + synthetic + no transcoder, pointing at the Use Transcoder
        // toggle that fixes it (at the cost of a transcode purely for the overlay rendition).
        function updateSyntheticOverlayWarning() {
            const el = document.getElementById('evt-synthetic-overlay-warning');
            if (!el) return;
            const detectorType = document.getElementById('cfg-detector-type').value;
            const useTranscoder = document.getElementById('cfg-use-transcoder').checked;
            const hasOverlay = Object.keys(eventListenersData || {}).some(function(name) {
                return resolveClassName((eventListenersData[name] || {}).class_name || '') === 'OverlayEvent';
            });
            if (detectorType === 'synthetic' && hasOverlay && !useTranscoder) {
                el.innerHTML = 'This Overlay listener won’t appear for synthetic detection: synthetic relays the ' +
                    'source without transcoding, so there is no rendition to burn the verdict into (playback and the ' +
                    'thumbnail show the source with no overlay). Enable <strong>Use Transcoder</strong> above to render a ' +
                    'separate overlay rendition with the verdict — your source rendition stays untouched, at the cost ' +
                    'of transcoding that one rendition.';
                el.style.display = 'block';
            } else {
                el.style.display = 'none';
            }
        }

        function updateActiveListenerSummary() {
            const summary = document.getElementById('evt-active-summary');
            if (!summary) return;
            updateSyntheticOverlayWarning();

            const listenerNames = Object.keys(eventListenersData || {});
            if (listenerNames.length === 0) {
                summary.style.display = 'none';
                summary.innerHTML = '';
                return;
            }

            const activeNames = listenerNames
                .slice()
                .sort(function(a, b) { return a.localeCompare(b); })
                .filter(function(name) {
                    const listener = eventListenersData[name] || {};
                    const method = (listener.methods || 'disabled').toLowerCase();
                    return method !== 'disabled';
                })
                .map(function(name) {
                    const method = eventListenersData[name] ? eventListenersData[name].methods : 'disabled';
                    return `${name} (${formatEventMethodLabel(method)})`;
                });

            summary.innerHTML = '';
            const label = document.createElement('strong');
            label.textContent = 'Active listeners:';
            summary.appendChild(label);
            summary.appendChild(document.createTextNode(
                activeNames.length > 0
                    ? ` ${activeNames.join(', ')}.`
                    : ' None. All configured event listeners are currently disabled.'
            ));
            summary.style.display = 'block';
        }

        function setExistingListenerRowVisibility(visible) {
            const row = document.getElementById('evt-existing-listener-row');
            const newBtn = document.getElementById('evt-show-new-listener-btn');
            if (!row) return;
            const shouldShow = visible && !isAddingNewListener;
            row.style.display = shouldShow ? 'flex' : 'none';
            if (newBtn) newBtn.style.display = visible && !isAddingNewListener ? '' : 'none';
            if (!shouldShow) {
                updateSelectedListenerTypeDisplay('');
            }
        }

        function ensureListenerSelectPromptOption(select, labelText) {
            if (!select) return null;
            let prompt = select.querySelector('option[value=""]');
            if (!prompt) {
                prompt = document.createElement('option');
                prompt.value = '';
                select.insertBefore(prompt, select.firstChild);
            }
            prompt.textContent = labelText || 'Select listener to edit...';
            return prompt;
        }

        function cancelListenerSelection() {
            const select = document.getElementById('evt-listener-select');
            if (!select) return;
            ensureListenerSelectPromptOption(select, 'Select listener to edit...');
            select.value = '';
            activeListenerName = null;
            onListenerSelected();
        }

        function cancelNewListenerForm() {
            isAddingNewListener = false;
            const select = document.getElementById('evt-listener-select');
            if (select) {
                ensureListenerSelectPromptOption(select, 'Select listener to edit...');
                select.value = '';
            }
            onListenerSelected();
        }

        function openNewListenerForm() {
            const fields = document.getElementById('evt-listener-fields');
            const newNameGroup = document.getElementById('evt-new-listener-name-group');
            const removeBtn = document.getElementById('evt-remove-listener-btn');
            const cancelBtn = document.getElementById('evt-cancel-listener-btn');
            const cancelNewBtn = document.getElementById('evt-cancel-new-listener-btn');
            const select = document.getElementById('evt-listener-select');
            const nameInput = document.getElementById('evt-new-listener-name');
            const hasListeners = Object.keys(eventListenersData).length > 0;

            syncListenerFields();

            isAddingNewListener = true;
            activeListenerName = null;
            setExistingListenerRowVisibility(hasListeners);
            if (hasListeners) {
                ensureListenerSelectPromptOption(select, 'Select listener to edit...');
                select.value = '';
            }
            fields.style.display = 'none';
            document.getElementById('evt-properties-section').style.display = 'none';
            newNameGroup.style.display = 'flex';
            removeBtn.style.display = 'none';
            if (cancelBtn) cancelBtn.style.display = 'none';
            if (cancelNewBtn) cancelNewBtn.style.display = hasListeners ? 'inline-block' : 'none';
            showListenerWarning('');
            updateListenerTip('', '');
            if (nameInput) {
                nameInput.style.display = 'none';
                nameInput.value = '';
                nameInput.placeholder = '';
                nameInput.dataset.userEdited = 'false';
                nameInput.dataset.suggestedValue = '';
            }
            refreshNewListenerTemplateOptions();
            const templateSelect = document.getElementById('evt-new-listener-template');
            if (templateSelect) templateSelect.focus();
        }

        function showListenerWarning(message) {
            const el = document.getElementById('evt-warning-message');
            if (!message) {
                el.style.display = 'none';
                el.textContent = '';
                return;
            }
            el.textContent = message;
            el.style.display = 'block';
        }

        function getListenerTip(className, method) {
            const shortName = resolveClassName(className || '');
            const methodTips = {
                immediate: 'Immediate is best when downstream systems need each detection as it happens.',
                batch: 'Batch is useful when you want short grouped windows instead of one event per detection.',
                rollup: 'Rollup is useful for summary-style outputs such as counts, dwell time, or aggregate state over a window.',
                disabled: 'Disabled keeps the listener config in place without emitting any events.'
            };
            const listenerTips = {
                OverlayEvent: 'OverlayEvent draws boxes, labels, and optional stats back onto the Wowza video output.',
                Id3Event: 'Id3Event injects timed metadata into the stream for downstream players or consumers.',
                LogFileEvent: 'LogFileEvent writes detection activity to a file, which is helpful for audits and debugging.',
                WebhookEvent2: 'WebhookEvent2 sends detections using the webhook destinations configured in webhooks.json.',
                ObjectTracking: 'ObjectTracking evaluates tracked objects against configured regions, triggers, directions, counts, and dwell logic.'
            };

            const parts = [];
            if (listenerTips[shortName]) parts.push(listenerTips[shortName]);
            if (methodTips[method]) parts.push(methodTips[method]);
            return parts.join(' ');
        }

        function updateListenerTip(className, method) {
            const tipEl = document.getElementById('evt-tip-message');
            const tip = getListenerTip(className, method);
            tipEl.textContent = tip || 'Choose a listener class and method to see a short usage tip here.';
        }

        function populateClassNameDropdown() {
            var select = document.getElementById('evt-class-name');
            select.innerHTML = '';
            var available = [];
            var merged = [];
            for (const [name, version] of Object.entries(defaultConfig.available_event_listeners || {})) {
                available.push(name);
            }
            available.forEach(function(className) {
                var shortName = className.includes('.') ? className.substring(className.lastIndexOf('.') + 1) : className;
                if (!merged.includes(shortName)) merged.push(shortName);
            });

            NEW_LISTENER_PRESET_TYPES.forEach(function(className) {
                if (!merged.includes(className)) merged.push(className);
            });

            merged.forEach(function(shortName) {
                var opt = document.createElement('option');
                opt.value = shortName;
                opt.textContent = getListenerTypeDisplayName(shortName);
                select.appendChild(opt);
            });
        }

        function setListenerTypeEditability(className, editable) {
            const select = document.getElementById('evt-class-name');
            const readonlyEl = document.getElementById('evt-class-name-readonly');
            const helpEl = document.getElementById('evt-class-name-help');
            const shortName = resolveClassName(className || '');

            if (!select || !readonlyEl || !helpEl) return;

            if (editable) {
                select.style.display = '';
                select.disabled = false;
                readonlyEl.style.display = 'none';
                readonlyEl.textContent = '';
                helpEl.textContent = 'Choose the listener type for this new custom listener. You can change it until you save the config.';
                return;
            }

            select.style.display = 'none';
            select.disabled = true;
            readonlyEl.style.display = 'block';
            readonlyEl.textContent = getListenerTypeDisplayName(shortName) || 'Not set';
            helpEl.textContent = 'Listener type is fixed after save. Remove and recreate the listener to use a different type.';
        }

        function isListenerTypeEditable(listenerData) {
            return !!listenerData && listenerData.type_locked === false;
        }

        function lockListenerTypesAfterSave() {
            Object.keys(eventListenersData || {}).forEach(function(name) {
                eventListenersData[name].type_locked = true;
            });

            const current = activeListenerName ? eventListenersData[activeListenerName] : null;
            if (current) {
                setListenerTypeEditability(current.class_name, isListenerTypeEditable(current));
            }
        }

        function updateEventMethodOptions(className, selectedMethod) {
            const select = document.getElementById('evt-methods');
            const helpEl = document.getElementById('evt-method-help');
            if (!select) return;
            const detectorType = getCurrentDetectorType();
            const currentValue = selectedMethod || select.value || 'disabled';
            const allowedValues = getAllowedEventMethodValues(className, detectorType);
            const allowedOptions = EVENT_METHOD_OPTIONS.filter(function(option) {
                return allowedValues.includes(option.value);
            });
            const isCurrentInvalid = currentValue !== 'disabled' && !allowedValues.includes(currentValue);

            select.innerHTML = '';

            if (isCurrentInvalid) {
                const invalidOption = document.createElement('option');
                invalidOption.value = currentValue;
                invalidOption.textContent = formatEventMethodLabel(currentValue) + ' (not available for this listener / detector type)';
                invalidOption.disabled = true;
                invalidOption.selected = true;
                select.appendChild(invalidOption);
            }

            allowedOptions.forEach(function(optionInfo) {
                const option = document.createElement('option');
                option.value = optionInfo.value;
                option.textContent = optionInfo.label;
                select.appendChild(option);
            });

            if (!isCurrentInvalid) {
                const nextValue = allowedOptions.some(function(optionInfo) {
                    return optionInfo.value === currentValue;
                }) ? currentValue : 'disabled';
                select.value = nextValue;
            }

            if (helpEl) {
                helpEl.textContent = buildEventMethodHelpText(allowedValues);
            }

            // P3-T3 (F5): updateEventMethodOptions is the one function already called from
            // every place the active listener's applicability could change - onListenerSelected,
            // the evt-class-name change handler, ensureListenerScriptLoaded's onload, and
            // vif-stream-config.js's toggleDetectorSection (on a detector-type switch) - so it
            // is the correct single place to refresh the "not applicable" warning chip too.
            updateListenerTypeApplicabilityWarning(className);
        }

        // Cross-file shared state, same rationale as EVENT_METHOD_OPTIONS above:
        // MAIN's toggleDetectorSection() (vif-stream-config.js) reads both
        // eventListenersData and activeListenerName directly.
        eventListenersData = {};
        activeListenerName = null;

        function populateEventListeners(listeners) {
            const select = document.getElementById('evt-listener-select');
            eventListenersData = {};

            // Store all listener data
            if (listeners) {
                for (const name of Object.keys(listeners)) {
                    const l = listeners[name];
                    eventListenersData[name] = {
                        class_name: l.class_name || '',
                        methods: l.methods && l.methods.length > 0
                            ? Array.from(l.methods)[0].toLowerCase() : 'disabled',
                        confidence_threshold: l.confidence_threshold !== undefined && l.confidence_threshold !== null
                            ? l.confidence_threshold : 0.7,
                        suppress_empty_detections: l.suppress_empty_detections ?? false,
                        properties: l.properties || {},
                        type_locked: true
                    };
                }
            }

            updateActiveListenerSummary();

            // Populate dropdown
            select.innerHTML = '';

            activeListenerName = null;
            if (Object.keys(eventListenersData).length > 0) {
                refreshNewListenerTemplateOptions();
                ensureListenerSelectPromptOption(select, 'Select listener to edit...');
                for (const name of Object.keys(eventListenersData).sort((a, b) => a.localeCompare(b))) {
                    const opt = document.createElement('option');
                    opt.value = name;
                    opt.textContent = name;
                    select.appendChild(opt);
                }
                isAddingNewListener = false;
                setExistingListenerRowVisibility(true);
                select.value = '';
                onListenerSelected();
            } else {
                refreshNewListenerTemplateOptions();
                ensureListenerSelectPromptOption(select, 'No listeners yet');
                select.value = '';
                setExistingListenerRowVisibility(false);
                openNewListenerForm();
            }
        }

        function addNewListener() {
            var templateSelect = document.getElementById('evt-new-listener-template');
            var nameInput = document.getElementById('evt-new-listener-name');
            var selectedTemplate = templateSelect ? templateSelect.value.trim() : '';
            var name = nameInput ? nameInput.value.trim() : '';
            if (!selectedTemplate) {
                showListenerWarning('Listener type is required before you can create the listener.');
                if (templateSelect) templateSelect.focus();
                return;
            }
            if (!name) {
                showListenerWarning('Listener name is required before you can create the listener.');
                if (nameInput) nameInput.focus();
                return;
            }
            if (!validateNewListenerName(true)) {
                if (nameInput) nameInput.focus();
                return;
            }
            eventListenersData[name] = {
                class_name: selectedTemplate,
                methods: 'disabled',
                confidence_threshold: 0.7,
                properties: {},
                type_locked: true
            };
            updateActiveListenerSummary();

            // Add the new listener to the existing-listener dropdown
            var select = document.getElementById('evt-listener-select');
            ensureListenerSelectPromptOption(select, 'Select listener to edit...');
            var opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            var inserted = false;
            for (var i = 1; i < select.options.length; i++) {
                if (name.localeCompare(select.options[i].value) < 0) {
                    select.insertBefore(opt, select.options[i]);
                    inserted = true;
                    break;
                }
            }
            if (!inserted) select.appendChild(opt);

            // Select the new listener
            select.value = name;
            isAddingNewListener = false;
            setExistingListenerRowVisibility(true);
            refreshNewListenerTemplateOptions();
            onListenerSelected();
            markDirty();
        }

        function onListenerSelected() {
            const select = document.getElementById('evt-listener-select');
            const fields = document.getElementById('evt-listener-fields');
            const newNameGroup = document.getElementById('evt-new-listener-name-group');
            const removeBtn = document.getElementById('evt-remove-listener-btn');
            const cancelBtn = document.getElementById('evt-cancel-listener-btn');
            const cancelNewBtn = document.getElementById('evt-cancel-new-listener-btn');
            var name = select.value;

            // Save previous listener's fields
            syncListenerFields();

            newNameGroup.style.display = 'none';
            if (cancelNewBtn) cancelNewBtn.style.display = 'none';
            isAddingNewListener = false;
            activeListenerName = name;
            setExistingListenerRowVisibility(Object.keys(eventListenersData).length > 0);

            if (!name || !eventListenersData[name]) {
                fields.style.display = 'none';
                document.getElementById('evt-properties-section').style.display = 'none';
                removeBtn.style.display = 'none';
                if (cancelBtn) cancelBtn.style.display = 'none';
                updateSelectedListenerTypeDisplay('');
                showListenerWarning('');
                updateListenerTip('', '');
                if (Object.keys(eventListenersData).length === 0) {
                    openNewListenerForm();
                }
                return;
            }

            removeBtn.style.display = 'inline-block';
            if (cancelBtn) cancelBtn.style.display = 'inline-block';
            fields.style.display = 'block';
            const data = eventListenersData[name];
            document.getElementById('evt-class-name').value = data.class_name;
            setListenerTypeEditability(data.class_name, isListenerTypeEditable(data));
            ensureListenerScriptLoaded(data.class_name);
            updateEventMethodOptions(data.class_name, data.methods);
            document.getElementById('evt-confidence').value = data.confidence_threshold != null ? Math.round(data.confidence_threshold * 100) : '';
            document.getElementById('evt-suppress-empty-detections').checked = data.suppress_empty_detections ?? false;
            updateSelectedListenerTypeDisplay(name);

            const shortName = resolveClassName(data.class_name || '');
            if (!shortName) {
                showListenerWarning('No listener type is selected. Please choose a listener type.');
            } else {
                showListenerWarning('');
            }
            updateListenerTip(data.class_name, data.methods);
            updatePropertiesVisibility();
        }

        function removeListener() {
            var name = activeListenerName;
            if (!name) return;
            if (!confirm('Remove listener "' + name + '"?')) return;

            delete eventListenersData[name];
            activeListenerName = null;
            updateActiveListenerSummary();

            // Remove option from dropdown
            var select = document.getElementById('evt-listener-select');
            var opt = select.querySelector('option[value="' + CSS.escape(name) + '"]');
            if (opt) opt.remove();

            // Return to a neutral selector state or reopen the add form
            if (Object.keys(eventListenersData).length > 0) {
                ensureListenerSelectPromptOption(select, 'Select listener to edit...');
                select.value = '';
                isAddingNewListener = false;
                setExistingListenerRowVisibility(true);
                refreshNewListenerTemplateOptions();
                onListenerSelected();
            } else {
                select.innerHTML = '';
                refreshNewListenerTemplateOptions();
                ensureListenerSelectPromptOption(select, 'No listeners yet');
                select.value = '';
                setExistingListenerRowVisibility(false);
                openNewListenerForm();
            }
            markDirty();
        }

        function updatePropertiesVisibility() {
            var method = document.getElementById('evt-methods').value;
            if (method === 'disabled') {
                document.getElementById('evt-properties-section').style.display = 'none';
                document.getElementById('evt-properties-fields').innerHTML = '';
                showListenerWarning('This listener is disabled and will not receive events.');
            } else if (activeListenerName && eventListenersData[activeListenerName]) {
                showListenerWarning('');
                loadListenerProperties(eventListenersData[activeListenerName].class_name);
            }
            const current = activeListenerName ? eventListenersData[activeListenerName] : null;
            updateListenerTip(current ? current.class_name : '', method);
        }

        function resolveClassName(className) {
            // Strip package prefix if present (e.g. com.wowza...Id3Event -> Id3Event)
            if (className.includes('.')) {
                return className.substring(className.lastIndexOf('.') + 1);
            }
            return className;
        }

        function getListenerSchema(shortName) {
            return (window.VIF_LISTENER_PROPERTIES && window.VIF_LISTENER_PROPERTIES[shortName]) || [];
        }

        function normalizeMethodValues(methods) {
            if (!Array.isArray(methods)) return [];
            const seen = new Set();
            return methods.reduce(function(list, method) {
                const normalized = String(method || '').trim().toLowerCase();
                if (!normalized || seen.has(normalized)) return list;
                seen.add(normalized);
                list.push(normalized);
                return list;
            }, []);
        }

        function getListenerMethodMetadata(shortName) {
            const schema = getListenerSchema(shortName);
            return schema.reduce(function(metadata, field) {
                if (!field || typeof field !== 'object' || Array.isArray(field)) {
                    return metadata;
                }
                if (field.key !== undefined || field.type === 'separator') {
                    return metadata;
                }
                if (field.object_methods !== undefined) {
                    metadata.object_methods = normalizeMethodValues(field.object_methods);
                }
                if (field.scene_methods !== undefined) {
                    metadata.scene_methods = normalizeMethodValues(field.scene_methods);
                }
                if (field.vlm_methods !== undefined) {
                    metadata.vlm_methods = normalizeMethodValues(field.vlm_methods);
                }
                if (field.synthetic_methods !== undefined) {
                    metadata.synthetic_methods = normalizeMethodValues(field.synthetic_methods);
                }
                return metadata;
            }, {});
        }

        function getRenderableListenerSchema(shortName) {
            return getListenerSchema(shortName).filter(function(field) {
                return field && typeof field === 'object' && !Array.isArray(field) && (field.key !== undefined || field.type === 'separator');
            });
        }

        function getCurrentDetectorType() {
            const select = document.getElementById('cfg-detector-type');
            return select ? String(select.value || '').trim().toLowerCase() : '';
        }

        // P3-T3 (F5): resolves which of getListenerMethodMetadata()'s four per-detector keys
        // governs `detectorType`. vlm/synthetic fall back to scene_methods only when their OWN
        // key is absent (undefined) - an explicit empty array is a real, load-bearing value
        // ("no methods offered"), not a signal to fall back. Shared by getAllowedEventMethodValues
        // and isListenerTypeOfferedForDetector so both agree on "offered" vs "allowed".
        function resolveDetectorSpecificMethods(metadata, detectorType) {
            if (detectorType === 'vlm') {
                return metadata.vlm_methods !== undefined ? metadata.vlm_methods : metadata.scene_methods;
            }
            if (detectorType === 'synthetic') {
                return metadata.synthetic_methods !== undefined ? metadata.synthetic_methods : metadata.scene_methods;
            }
            if (detectorType === 'scene') {
                return metadata.scene_methods;
            }
            if (detectorType === 'object') {
                return metadata.object_methods;
            }
            return null;
        }

        // Shows the per-detector inline help span `${prefix}-${detectorType}` and hides the
        // siblings. Keeps each field's help text detector-specific instead of one paragraph
        // that lists every detector. Missing spans (e.g. no object Duration help) are skipped.
        function getAllowedEventMethodValues(className, detectorType) {
            const shortName = resolveClassName(className || '');
            const normalizedDetectorType = String(detectorType || getCurrentDetectorType() || '').trim().toLowerCase();
            const metadata = getListenerMethodMetadata(shortName);
            let allowedValues = EVENT_METHOD_OPTIONS.map(function(option) {
                return option.value;
            });

            const detectorSpecificMethods = resolveDetectorSpecificMethods(metadata, normalizedDetectorType);

            // P3-T3 (F5): inverted guard - a *present* array (even empty) now narrows the allowed
            // set; an empty array narrows it to 'disabled' only ("not offered" for this detector -
            // see isListenerTypeOfferedForDetector). Previously the `.length > 0` check let an
            // empty array fall through to ALL methods, which is what made ObjectTracking
            // selectable with Immediate under vlm/synthetic (F5's proven-live bug).
            if (Array.isArray(detectorSpecificMethods)) {
                allowedValues = ['disabled'].concat(detectorSpecificMethods.filter(function(method) {
                    return method !== 'disabled';
                }));
            }

            return EVENT_METHOD_OPTIONS.filter(function(option) {
                return allowedValues.includes(option.value);
            }).map(function(option) {
                return option.value;
            });
        }

        // P3-T3 (F5): a listener TYPE is "not offered" for a detector type when that detector's
        // specific-methods key is present but explicitly empty (today only ObjectTracking's
        // vlm_methods/synthetic_methods: []) - bounding-box/ROI semantics are meaningless outside
        // object/scene. Absent key => not an array => offered (mirrors getAllowedEventMethodValues'
        // "no restriction" fallback). Drives: (a) filtering the "Create New Listener" dropdown in
        // refreshNewListenerTemplateOptions, (b) the inline "not applicable" warning chip on an
        // existing listener via updateListenerTypeApplicabilityWarning, (c) the type-level branch
        // getDetectorTypeSwitchConflicts adds below.
        function isListenerTypeOfferedForDetector(className, detectorType) {
            const shortName = resolveClassName(className || '');
            const normalizedDetectorType = String(detectorType || getCurrentDetectorType() || '').trim().toLowerCase();
            const metadata = getListenerMethodMetadata(shortName);
            const detectorSpecificMethods = resolveDetectorSpecificMethods(metadata, normalizedDetectorType);
            return !(Array.isArray(detectorSpecificMethods) && detectorSpecificMethods.length === 0);
        }

        // P3-T3 (F5): mirrors updateSyntheticOverlayWarning's amber inline-warning-chip pattern
        // (same `.inline-warning` styling contract) for an EXISTING listener whose type is not
        // offered for the active detector type (e.g. an ObjectTracking listener left over after
        // switching from object/scene into vlm/synthetic). The element is created lazily and
        // inserted into the static #evt-listener-fields container - stream-config.html's markup
        // is owned by the form workstream for this task, so no HTML changes here.
        function ensureListenerNotApplicableWarningElement() {
            let el = document.getElementById('evt-listener-not-applicable-warning');
            if (!el) {
                const fields = document.getElementById('evt-listener-fields');
                if (!fields) return null;
                el = document.createElement('div');
                el.id = 'evt-listener-not-applicable-warning';
                el.className = 'inline-warning';
                el.style.display = 'none';
                fields.insertBefore(el, fields.firstChild);
            }
            return el;
        }

        function capitalizeDetectorTypeLabel(detectorType) {
            return detectorType === 'scene' ? 'Scene'
                : detectorType === 'object' ? 'Object'
                : detectorType === 'vlm' ? 'VLM'
                : detectorType === 'synthetic' ? 'Synthetic'
                : detectorType;
        }

        function updateListenerTypeApplicabilityWarning(className) {
            const el = ensureListenerNotApplicableWarningElement();
            if (!el) return;
            const shortName = resolveClassName(className || '');
            const detectorType = getCurrentDetectorType();
            if (shortName && !isListenerTypeOfferedForDetector(shortName, detectorType)) {
                el.textContent = 'Not applicable to ' + capitalizeDetectorTypeLabel(detectorType) + ' detection.';
                el.style.display = 'block';
            } else {
                el.style.display = 'none';
                el.textContent = '';
            }
        }

        function buildEventMethodHelpText(allowedValues) {
            const enabledOptions = EVENT_METHOD_OPTIONS.filter(function(option) {
                return allowedValues.includes(option.value) && option.value !== 'disabled';
            }).map(function(option) {
                return option.label;
            });

            if (enabledOptions.length === 0) {
                return 'This listener is currently limited to Disabled for the selected listener type.';
            }

            return 'Available methods for this listener type: ' + enabledOptions.join(', ') + '.';
        }

        function getDetectorTypeSwitchConflicts(targetDetectorType) {
            const conflicts = [];

            Object.keys(eventListenersData || {}).forEach(function(name) {
                const listener = eventListenersData[name];
                if (!listener || !listener.class_name) {
                    return;
                }

                const currentMethod = String(listener.methods || 'disabled').toLowerCase();
                const allowedMethods = getAllowedEventMethodValues(listener.class_name, targetDetectorType);
                const allowedLabels = EVENT_METHOD_OPTIONS.filter(function(option) {
                    return allowedMethods.includes(option.value);
                }).map(function(option) {
                    return option.label;
                });

                // P3-T3 (F5): flag the listener TYPE itself as inapplicable to the target
                // detector (e.g. ObjectTracking -> vlm/synthetic), not just a now-disallowed
                // method value. Reported even when the current method already happens to be
                // 'disabled' - otherwise a disabled-but-now-inapplicable listener would sail
                // through this check silently and only surface later as the inline warning
                // chip, with no chance to fix/remove it from this same dialog.
                if (!isListenerTypeOfferedForDetector(listener.class_name, targetDetectorType)) {
                    conflicts.push({
                        name: name,
                        method: currentMethod,
                        allowedLabels: allowedLabels,
                        typeNotApplicable: true
                    });
                    return;
                }

                if (!allowedMethods.includes(currentMethod)) {
                    conflicts.push({
                        name: name,
                        method: currentMethod,
                        allowedLabels: allowedLabels
                    });
                }
            });

            return conflicts;
        }

        function buildDetectorTypeSwitchConflictMessage(targetDetectorType, conflicts) {
            const targetLabel = targetDetectorType === 'scene' ? 'Scene' : targetDetectorType === 'object' ? 'Object' : targetDetectorType === 'vlm' ? 'VLM' : targetDetectorType;
            const details = conflicts.map(function(conflict) {
                if (conflict.typeNotApplicable) {
                    return conflict.name + ' (not applicable to ' + targetLabel + ' detection)';
                }
                return conflict.name + ' (' + formatEventMethodLabel(conflict.method) + '; allowed: ' + conflict.allowedLabels.join(', ') + ')';
            }).join(', ');

            return 'Cannot switch to ' + targetLabel + ' detection. Update these Event Listeners first: ' + details + '.';
        }

        function buildDetectorTypeSwitchConflictDialogMessage(targetDetectorType, conflicts) {
            const targetLabel = targetDetectorType === 'scene' ? 'Scene' : targetDetectorType === 'object' ? 'Object' : targetDetectorType === 'vlm' ? 'VLM' : targetDetectorType;
            const details = conflicts.map(function(conflict) {
                if (conflict.typeNotApplicable) {
                    return '- ' + conflict.name + ': not applicable to ' + targetLabel + ' detection';
                }
                const visibleAllowedLabels = conflict.allowedLabels.filter(function(label) {
                    return label !== 'Disabled';
                });
                return '- ' + conflict.name + ': current ' + formatEventMethodLabel(conflict.method) + ', allowed ' + visibleAllowedLabels.join(', ');
            }).join('\n');

            return 'Cannot switch to ' + targetLabel + ' detection.\n\nUpdate these Event Listeners first:\n' + details;
        }

        var loadedListenerScripts = {};
        var listenerScriptWaiters = {};

        // P3-T3 (F5): the "Create New Listener" dropdown (refreshNewListenerTemplateOptions)
        // filters by getListenerMethodMetadata()'s vlm_methods/synthetic_methods, which only
        // exist once a type's listeners/<Type>.js schema file has loaded. preloadConfiguredListenerSchemas
        // (elsewhere) only covers types already present in eventListenersData, so a brand-new
        // stream with zero listeners configured would have no metadata to filter by. Kick off
        // (idempotent, cached by ensureListenerScriptLoaded) loading for every built-in preset
        // type up front so that filter has real data by the time the dropdown first renders. Must
        // run after loadedListenerScripts/listenerScriptWaiters above are actually initialized
        // (their `var` bindings are hoisted, but not their `= {}` assignments).
        NEW_LISTENER_PRESET_TYPES.forEach(function (typeName) {
            ensureListenerScriptLoaded(typeName);
        });

        function ensureListenerScriptLoaded(className, onReady, onMissing) {
            const shortName = resolveClassName(className || '');
            if (!shortName) {
                if (typeof onMissing === 'function') onMissing(shortName);
                return;
            }

            if (window.VIF_LISTENER_PROPERTIES && window.VIF_LISTENER_PROPERTIES[shortName] !== undefined) {
                if (typeof onReady === 'function') onReady(shortName);
                return;
            }

            if (loadedListenerScripts[shortName] === 'ready') {
                if (typeof onReady === 'function') onReady(shortName);
                return;
            }

            if (loadedListenerScripts[shortName] === 'missing') {
                if (typeof onMissing === 'function') onMissing(shortName);
                return;
            }

            if (loadedListenerScripts[shortName] === 'loading') {
                listenerScriptWaiters[shortName] = listenerScriptWaiters[shortName] || [];
                listenerScriptWaiters[shortName].push({ onReady: onReady, onMissing: onMissing });
                return;
            }

            loadedListenerScripts[shortName] = 'loading';
            listenerScriptWaiters[shortName] = listenerScriptWaiters[shortName] || [];
            listenerScriptWaiters[shortName].push({ onReady: onReady, onMissing: onMissing });

            // P2-T1 cache-busting sweep (C4): every dynamically-constructed script URL
            // carries ?v=<UI_VERSION>, same literal as the static <script src> tags -
            // this loader has its own loaded-tracking/dual-callback semantics that
            // don't map cleanly onto VIF.core.loadScript, so the version suffix is
            // appended by hand here instead of delegating to that helper.
            let jsFileName = 'wse-plugins/server/vif/listeners/' + shortName + '.js?v=' + UI_VERSION
            if(!urlExists(jsFileName)) {
                jsFileName = 'wse-plugins/server/vif/listeners.addon/' + shortName + '.js?v=' + UI_VERSION
            }
            const script = document.createElement('script');
            script.src = jsFileName;
            script.onload = function() {
                loadedListenerScripts[shortName] = 'ready';
                if (activeListenerName && eventListenersData[activeListenerName]) {
                    const current = eventListenersData[activeListenerName];
                    if (resolveClassName(current.class_name || '') === shortName) {
                        updateEventMethodOptions(current.class_name, current.methods);
                    }
                }
                const waiters = listenerScriptWaiters[shortName] || [];
                delete listenerScriptWaiters[shortName];
                waiters.forEach(function(waiter) {
                    if (typeof waiter.onReady === 'function') waiter.onReady(shortName);
                });
            };
            script.onerror = function() {
                loadedListenerScripts[shortName] = 'missing';
                const waiters = listenerScriptWaiters[shortName] || [];
                delete listenerScriptWaiters[shortName];
                waiters.forEach(function(waiter) {
                    if (typeof waiter.onMissing === 'function') waiter.onMissing(shortName);
                });
            };
            document.head.appendChild(script);
        }

         function urlExists(url) {
            var http = new XMLHttpRequest();
            http.open('HEAD', url, false);
            try {
                http.send();
                return http.status !== 404;
            } catch (e) {
                return false;
            }
            return false;
        }


        function preloadConfiguredListenerSchemas() {
            const classNames = [];

            Object.keys(eventListenersData || {}).forEach(function(name) {
                const listener = eventListenersData[name];
                const shortName = resolveClassName(listener && listener.class_name ? listener.class_name : '');
                if (shortName && !classNames.includes(shortName)) {
                    classNames.push(shortName);
                }
            });

            return Promise.all(classNames.map(function(className) {
                return new Promise(function(resolve) {
                    ensureListenerScriptLoaded(className, function() {
                        resolve();
                    }, function() {
                        resolve();
                    });
                });
            }));
        }

        function loadListenerProperties(className) {
            const propsSection = document.getElementById('evt-properties-section');
            const propsFields = document.getElementById('evt-properties-fields');
            const shortName = resolveClassName(className);

            ensureListenerScriptLoaded(shortName, function(readyShortName) {
                renderProperties(readyShortName);
            }, function() {
                propsSection.style.display = 'block';
                propsFields.innerHTML = '<div style="font-size:0.85em; color:#888; padding:4px 0;">No Properties to Configure</div>';
            });
            return;
        }

        function renderProperties(shortName) {
            const propsSection = document.getElementById('evt-properties-section');
            const propsFields = document.getElementById('evt-properties-fields');
            const schema = getRenderableListenerSchema(shortName);

            if (schema.length === 0) {
                propsSection.style.display = 'block';
                propsFields.innerHTML = '<div style="font-size:0.85em; color:#888; padding:4px 0;">No Properties to Configure</div>';
                return;
            }

            propsSection.style.display = 'block';
            propsFields.innerHTML = '';

            const data = eventListenersData[activeListenerName];
            const props = data.properties || {};

            schema.forEach(function(field) {
                if (field.type === 'array') {
                    renderArrayField(propsFields, field, props[field.key] || []);
                } else {
                    renderScalarField(propsFields, field, props[field.key]);
                }
            });

            const previousSuppressDirtyTracking = suppressDirtyTracking;
            suppressDirtyTracking = true;
            syncPropertyFields();
            suppressDirtyTracking = previousSuppressDirtyTracking;
        }

        function renderScalarField(container, field, value, dataAttr) {
            const hasExplicitValue = value !== undefined && value !== null;

            if (field.type === 'separator') {
                var hr = document.createElement('hr');
                hr.style.margin = '12px 0';
                hr.style.border = 'none';
                hr.style.borderTop = '1px solid #ddd';
                if (field.label) {
                    var wrapper = document.createElement('div');
                    wrapper.style.cssText = 'font-size:0.8em; color:#888; text-transform:uppercase; letter-spacing:1px; margin:12px 0 8px;';
                    wrapper.textContent = field.label;
                    wrapper.appendChild(hr);
                    container.appendChild(wrapper);
                } else {
                    container.appendChild(hr);
                }
                return;
            }
            dataAttr = dataAttr || 'propKey';
            var div = document.createElement('div');
            div.className = 'form-group';

            var label = document.createElement('label');
            label.textContent = field.label;
            div.appendChild(label);

            if (field.type === 'boolean') {
                var switchLabel = document.createElement('label');
                switchLabel.className = 'switch';
                var input = document.createElement('input');
                input.type = 'checkbox';
                input.checked = hasExplicitValue ? !!value : !!field.default;
                input.dataset[dataAttr] = field.key;
                input.addEventListener('change', syncPropertyFields);
                var span = document.createElement('span');
                span.className = 'slider-switch';
                switchLabel.appendChild(input);
                switchLabel.appendChild(span);
                div.appendChild(switchLabel);
            } else if (field.type === 'number') {
                var input = document.createElement('input');
                input.type = 'number';
                input.value = hasExplicitValue
                    ? value
                    : (field.default !== undefined && field.default !== null ? field.default : '');
                if (field.default !== undefined && field.default !== null) {
                    input.placeholder = String(field.default);
                }
                input.step = field.step || 'any';
                input.dataset[dataAttr] = field.key;
                input.addEventListener('input', syncPropertyFields);
                const numericRule = getListenerPropertyRule(field.key);
                if (numericRule) applyNumericRuleToInput(input, numericRule);
                div.appendChild(input);
            } else if (field.type === 'select') {
                var select = document.createElement('select');
                select.dataset[dataAttr] = field.key;
                (field.options || []).forEach(function(optVal) {
                    var opt = document.createElement('option');
                    opt.value = optVal;
                    opt.textContent = optVal;
                    select.appendChild(opt);
                });
                select.value = value !== undefined ? value : field.default;
                select.addEventListener('change', syncPropertyFields);
                div.appendChild(select);
            } else if (field.type === 'string_list') {
                var wrapper = document.createElement('div');
                wrapper.className = 'string-list-field';
                var input = document.createElement('input');
                input.type = 'text';
                if (Array.isArray(value)) {
                    input.value = value.join(', ');
                } else if (hasExplicitValue) {
                    input.value = value;
                } else if (field.default !== undefined && field.default !== null) {
                    input.value = Array.isArray(field.default)
                        ? field.default.join(', ')
                        : String(field.default);
                } else {
                    input.value = '';
                }
                if (field.default !== undefined && field.default !== null) {
                    input.placeholder = Array.isArray(field.default) ? field.default.join(', ') : String(field.default);
                }
                input.dataset[dataAttr] = field.key;
                input.dataset.fieldType = 'string_list';
                input.addEventListener('input', syncPropertyFields);
                wrapper.appendChild(input);
                var hint = document.createElement('span');
                hint.className = 'string-list-hint';
                hint.textContent = 'comma-separated';
                wrapper.appendChild(hint);
                div.appendChild(wrapper);
            } else {
                var input = document.createElement('input');
                input.type = 'text';
                input.value = hasExplicitValue
                    ? value
                    : (field.default !== undefined && field.default !== null ? String(field.default) : '');
                if (field.default !== undefined && field.default !== null) {
                    input.placeholder = String(field.default);
                }
                input.dataset[dataAttr] = field.key;
                input.addEventListener('input', syncPropertyFields);
                const textRule = getListenerPropertyRule(field.key);
                if (textRule) applyTextRuleToInput(input, textRule);
                div.appendChild(input);
            }

            if (field.tooltip) {
                var help = document.createElement('div');
                help.className = 'field-help';
                help.textContent = field.tooltip;
                div.appendChild(help);
            }

            container.appendChild(div);
        }

        function renderArrayField(container, field, items) {
            var section = document.createElement('div');
            section.className = 'array-section';
            section.dataset.arrayKey = field.key;

            var header = document.createElement('div');
            header.className = 'array-section-header';
            var title = document.createElement('div');
            title.className = 'form-section-title';
            title.textContent = field.label;
            header.appendChild(title);

            var addBtn = document.createElement('button');
            addBtn.textContent = '+ Add';
            addBtn.addEventListener('click', function() {
                var newItem = {};
                addArrayItem(section, field, newItem, true);
                syncPropertyFields();
            });
            header.appendChild(addBtn);
            section.appendChild(header);

            items.forEach(function(item) {
                addArrayItem(section, field, item, false);
            });

            container.appendChild(section);
        }

        function addArrayItem(section, fieldSchema, itemData, expanded) {
            var item = document.createElement('div');
            item.className = 'array-item';

            var itemHeader = document.createElement('div');
            itemHeader.className = 'array-item-header';

            var chevron = document.createElement('span');
            chevron.className = 'array-item-chevron';
            chevron.textContent = expanded ? '\u25BC' : '\u25B6';
            itemHeader.appendChild(chevron);

            var itemTitle = document.createElement('span');
            itemTitle.textContent = itemData.name || itemData.id || fieldSchema.item_label || 'Item';
            itemHeader.appendChild(itemTitle);

            var actions = document.createElement('div');
            actions.className = 'array-item-actions';

            var removeBtn = document.createElement('button');
            removeBtn.textContent = 'Remove';
            removeBtn.className = 'btn-danger';
            removeBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                item.remove();
                syncPropertyFields();
            });
            actions.appendChild(removeBtn);
            itemHeader.appendChild(actions);

            itemHeader.addEventListener('click', function(e) {
                if (e.target.tagName === 'BUTTON') return;
                body.classList.toggle('expanded');
                chevron.textContent = body.classList.contains('expanded') ? '\u25BC' : '\u25B6';
            });

            item.appendChild(itemHeader);

            var body = document.createElement('div');
            body.className = 'array-item-body' + (expanded ? ' expanded' : '');

            fieldSchema.fields.forEach(function(subField) {
                var value = itemData[subField.key];
                renderScalarField(body, subField, value, 'arrayField');
            });

            item.appendChild(body);
            section.appendChild(item);

            // Update title when name/id fields change
            var nameInput = body.querySelector('[data-array-field="name"]') || body.querySelector('[data-array-field="id"]');
            if (nameInput) {
                nameInput.addEventListener('input', function() {
                    itemTitle.textContent = this.value || fieldSchema.item_label || 'Item';
                });
            }
        }

        function syncPropertyFields() {
            if (!activeListenerName || !eventListenersData[activeListenerName]) return false;
            var container = document.getElementById('evt-properties-fields');
            var props = {};

            // Sync scalar fields
            var inputs = container.querySelectorAll('[data-prop-key]');
            inputs.forEach(function(input) {
                var key = input.dataset.propKey;
                if (input.type === 'checkbox') {
                    props[key] = input.checked;
                } else if (input.type === 'number') {
                    const source = input.value !== '' ? input.value : input.placeholder;
                    props[key] = parseFloat(source) || 0;
                } else if (input.dataset.fieldType === 'string_list') {
                    const source = input.value !== '' ? input.value : (input.placeholder || '');
                    props[key] = source.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
                } else {
                    props[key] = input.value !== '' ? input.value : (input.placeholder || '');
                }
            });

            // Sync array fields
            var arraySections = container.querySelectorAll('.array-section');
            arraySections.forEach(function(section) {
                var key = section.dataset.arrayKey;
                var items = [];
                section.querySelectorAll('.array-item').forEach(function(itemEl) {
                    var obj = {};
                    var fields = itemEl.querySelectorAll('[data-array-field]');
                    fields.forEach(function(input) {
                        var fieldKey = input.dataset.arrayField;
                        if (input.type === 'checkbox') {
                            obj[fieldKey] = input.checked;
                        } else if (input.type === 'number') {
                            const source = input.value !== '' ? input.value : input.placeholder;
                            obj[fieldKey] = parseFloat(source) || 0;
                        } else if (input.dataset.fieldType === 'string_list') {
                            const source = input.value !== '' ? input.value : (input.placeholder || '');
                            obj[fieldKey] = source.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
                        } else {
                            obj[fieldKey] = input.value !== '' ? input.value : (input.placeholder || '');
                        }
                    });
                    items.push(obj);
                });
                props[key] = items;
            });

            const existingProps = eventListenersData[activeListenerName].properties || {};
            const changed = !valuesEqual(existingProps, props);
            eventListenersData[activeListenerName].properties = props;
            if (changed) {
                markDirty();
            }
            return changed;
        }

        // Auto-save listener fields on any change
        function syncListenerFields() {
            const name = activeListenerName;
            if (!name || !eventListenersData[name]) return false;
            const data = eventListenersData[name];
            const propertiesChanged = syncPropertyFields();
            const nextClassName = document.getElementById('evt-class-name').value.trim();
            const nextMethod = document.getElementById('evt-methods').value;
            const confidenceInput = document.getElementById('evt-confidence');
            const confidence = parseFloat(confidenceInput.value || confidenceInput.placeholder);
            const nextConfidence = Number.isFinite(confidence) ? confidence / 100 : 0.7;
            const nextSupresEmptyDetections = document.getElementById('evt-suppress-empty-detections').checked;
            const changed = propertiesChanged
                || data.class_name !== nextClassName
                || data.methods !== nextMethod
                || data.confidence_threshold !== nextConfidence
                || data.suppress_empty_detections !== nextSupresEmptyDetections;

            data.class_name = nextClassName;
            data.methods = nextMethod;
            data.confidence_threshold = nextConfidence;
            data.suppress_empty_detections = nextSupresEmptyDetections;
            updateListenerSelectOptionLabel(name);
            updateSelectedListenerTypeDisplay(name);
            updateActiveListenerSummary();

            if (changed) {
                markDirty();
            }
            return changed;
        }

        document.getElementById('evt-class-name').addEventListener('change', function() {
            syncListenerFields();
            const current = activeListenerName && eventListenersData[activeListenerName] ? eventListenersData[activeListenerName] : null;
            const className = current ? current.class_name : document.getElementById('evt-class-name').value.trim();
            setListenerTypeEditability(className, isListenerTypeEditable(current));
            ensureListenerScriptLoaded(className);
            updateEventMethodOptions(className, current ? current.methods : document.getElementById('evt-methods').value);
            updatePropertiesVisibility();
        });
        document.getElementById('evt-methods').addEventListener('change', function() { syncListenerFields(); updatePropertiesVisibility(); });
        document.getElementById('evt-confidence').addEventListener('input', syncListenerFields);
        document.getElementById('evt-suppress-empty-detections').addEventListener('change', syncListenerFields);
        document.getElementById('evt-new-listener-template').addEventListener('change', function() {
            onNewListenerTemplateChanged();
        });
        document.getElementById('evt-new-listener-name').addEventListener('input', function() {
            this.dataset.userEdited = 'true';
            validateNewListenerName(true);
        });
        document.getElementById('evt-new-listener-name').addEventListener('keydown', function(event) {
            if (event.key === 'Enter') {
                event.preventDefault();
                addNewListener();
            }
        });

        function buildEventListenersJson() {
            // Save current fields first
            syncListenerFields();

            const listeners = {};
            for (const [name, data] of Object.entries(eventListenersData)) {
                const entry = {
                    class_name: data.class_name,
                    methods: [data.methods],
                    confidence_threshold: data.confidence_threshold,
                    suppress_empty_detections: data.suppress_empty_detections ?? false
                };
                if (data.properties && Object.keys(data.properties).length > 0) {
                    entry.properties = data.properties;
                }
                listeners[name] = entry;
            }
            return listeners;
        }


        window.openNewListenerForm = openNewListenerForm;
        window.onListenerSelected = onListenerSelected;
        window.cancelListenerSelection = cancelListenerSelection;
        window.removeListener = removeListener;
        window.addNewListener = addNewListener;
        window.cancelNewListenerForm = cancelNewListenerForm;

        // (c) cross-file: called from vif-stream-config.js (collectValidationErrors,
        //     buildConfigJson, saveConfig, populateForm, loadStreams,
        //     toggleDetectorSection, the cfg-detector-type change handler, and
        //     init()'s own tail) - permanent, not a Phase-1-baseline alias.
        window.resolveClassName = resolveClassName;
        window.getAllowedEventMethodValues = getAllowedEventMethodValues;
        window.getListenerMethodMetadata = getListenerMethodMetadata;
        window.isListenerTypeOfferedForDetector = isListenerTypeOfferedForDetector;
        window.updateListenerTypeApplicabilityWarning = updateListenerTypeApplicabilityWarning;
        window.formatEventMethodLabel = formatEventMethodLabel;
        window.buildEventListenersJson = buildEventListenersJson;
        window.lockListenerTypesAfterSave = lockListenerTypesAfterSave;
        window.populateEventListeners = populateEventListeners;
        window.populateClassNameDropdown = populateClassNameDropdown;
        window.updateEventMethodOptions = updateEventMethodOptions;
        window.updatePropertiesVisibility = updatePropertiesVisibility;
        window.updateSyntheticOverlayWarning = updateSyntheticOverlayWarning;
        window.syncListenerFields = syncListenerFields;
        window.preloadConfiguredListenerSchemas = preloadConfiguredListenerSchemas;
        window.getDetectorTypeSwitchConflicts = getDetectorTypeSwitchConflicts;
        window.buildDetectorTypeSwitchConflictMessage = buildDetectorTypeSwitchConflictMessage;
        window.buildDetectorTypeSwitchConflictDialogMessage = buildDetectorTypeSwitchConflictDialogMessage;
        window.updateListenerTip = updateListenerTip;
        window.ensureListenerScriptLoaded = ensureListenerScriptLoaded;
    };
})();
