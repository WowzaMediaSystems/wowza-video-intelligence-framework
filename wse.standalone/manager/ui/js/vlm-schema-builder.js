(function () {
    'use strict';

    var SCHEMA_TYPES = ['string', 'number', 'integer', 'boolean', 'string[]', 'enum', 'object', 'object[]'];
    var NESTED_TYPES = ['object', 'object[]'];
    var ROWS_ID = 'cfg-vlm-schema-rows'; // top-level rows container (in the markup)

    function el(id) {
        return document.getElementById(id);
    }

    function csvToList(str) {
        return str.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
    }

    // Structural deep-equality — used to recognize a loaded schema as the live
    // default class schema so the kind selector lights "Per-class verdicts"
    // instead of "Custom". Key order is irrelevant.
    function deepEqual(a, b) {
        if (a === b) return true;
        if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
        var ka = Object.keys(a), kb = Object.keys(b);
        if (ka.length !== kb.length) return false;
        for (var i = 0; i < ka.length; i++) {
            if (!Object.prototype.hasOwnProperty.call(b, ka[i])) return false;
            if (!deepEqual(a[ka[i]], b[ka[i]])) return false;
        }
        return true;
    }

    // markDirty lives in stream-config.html; guard so the module is safe in isolation.
    function dirty() {
        if (typeof markDirty === 'function') markDirty();
    }

    // ── Sub-mode (Fields / Raw JSON) ──────────────────────────────────────────
    function getMode() {
        var checked = document.querySelector('#cfg-vlm-schema-mode input[name="vlm-schema-mode"]:checked');
        return checked ? checked.value : 'fields';
    }

    // Pure view update — show one panel, refresh the inline error. No conversion.
    function showPanels(mode) {
        el('vlm-schema-fields').style.display = mode === 'fields' ? 'block' : 'none';
        el('vlm-schema-raw').style.display = mode === 'raw' ? 'block' : 'none';
        validateRaw();
        // Re-fit the Raw-JSON textarea now it may have (re)appeared: switching to Raw
        // or loading a schema sets its value programmatically (no 'input' event).
        if (window.vlmAutoGrowAll) window.vlmAutoGrowAll();
    }

    function setModeRadios(mode) {
        var radios = document.querySelectorAll('#cfg-vlm-schema-mode input[name="vlm-schema-mode"]');
        radios.forEach(function (r) { r.checked = (r.value === mode); });
    }

    // Programmatic mode set (reset / populate) — no content conversion, no dirty.
    function setMode(mode) {
        setModeRadios(mode);
        showPanels(mode);
    }

    // The panel on screen — read inside the radio handler before the panels move,
    // so it is the mode we are switching AWAY from.
    function currentPanel() {
        return el('vlm-schema-raw').style.display !== 'none' ? 'raw' : 'fields';
    }

    // User toggled Fields/Raw: convert content across the two views so a toggle
    // never silently drops the schema. Fields->Raw serializes the builder into the
    // textarea; Raw->Fields imports the JSON only if it decomposes into the
    // builder's supported shapes, otherwise it stays on Raw with an inline note.
    function switchMode(target) {
        var prev = currentPanel();
        if (prev !== target && target === 'raw') {
            var built = buildObjectSchema(el(ROWS_ID));
            el('cfg-vlm-response-schema').value = built ? JSON.stringify(built, null, 2) : '';
        } else if (prev !== target && target === 'fields') {
            var ta = el('cfg-vlm-response-schema');
            var text = ta.value.trim();
            if (text) {
                var parsed = null;
                try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
                var rows = parsed ? schemaToRows(parsed) : null;
                if (!rows) {
                    setModeRadios('raw');
                    showPanels('raw');
                    var err = el('vlm-schema-error');
                    if (err) {
                        err.textContent = parsed
                            ? 'This schema is too advanced for the Fields builder — keep editing it as Raw JSON.'
                            : 'Raw JSON is invalid — fix it before switching to Fields.';
                        err.style.display = 'block';
                    }
                    dirty();
                    return;
                }
                loadRows(el(ROWS_ID), rows);
                ta.value = '';
            }
        }
        showPanels(target);
        dirty();
    }

    // ── Fields builder rows ───────────────────────────────────────────────────
    // A "row object" is {name, type, description, required, enumValues:[], children:[row objects]}.
    // Rows nest: an object / object[] row owns a child rows-container (wrap._nestedRows).

    function addRow(container, row) {
        row = row || {};

        var wrap = document.createElement('div');
        wrap.className = 'vlm-schema-row-wrap';

        var rowEl = document.createElement('div');
        rowEl.className = 'vlm-schema-row';
        rowEl.style.cssText = 'display:flex; gap:8px; margin-bottom:6px; align-items:center;';

        var nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'vlm-schema-name';
        nameInput.placeholder = 'field (e.g. reading)';
        nameInput.value = row.name || '';
        nameInput.style.flex = '2';
        nameInput.addEventListener('input', dirty);

        var typeSelect = document.createElement('select');
        typeSelect.className = 'vlm-schema-type';
        typeSelect.style.flex = '0 0 116px';
        SCHEMA_TYPES.forEach(function (t) {
            var opt = document.createElement('option');
            opt.value = t;
            opt.textContent = t;
            typeSelect.appendChild(opt);
        });
        typeSelect.value = SCHEMA_TYPES.indexOf(row.type) !== -1 ? row.type : 'string';

        var descInput = document.createElement('input');
        descInput.type = 'text';
        descInput.className = 'vlm-schema-desc';
        descInput.placeholder = 'optional description';
        descInput.value = row.description || '';
        descInput.style.flex = '3';
        descInput.addEventListener('input', dirty);

        var reqLabel = document.createElement('label');
        reqLabel.className = 'inline-control-label';
        reqLabel.style.cssText = 'display:inline-flex; align-items:center; gap:4px; font-weight:normal; white-space:nowrap;';
        var reqInput = document.createElement('input');
        reqInput.type = 'checkbox';
        reqInput.className = 'vlm-schema-required';
        reqInput.checked = !!row.required;
        reqInput.addEventListener('change', dirty);
        reqLabel.appendChild(reqInput);
        reqLabel.appendChild(document.createTextNode('required'));

        var removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn-danger';
        removeBtn.textContent = '×';
        removeBtn.title = 'Remove field';
        removeBtn.onclick = function () { wrap.remove(); dirty(); };

        rowEl.appendChild(nameInput);
        rowEl.appendChild(typeSelect);
        rowEl.appendChild(descInput);
        rowEl.appendChild(reqLabel);
        rowEl.appendChild(removeBtn);
        wrap.appendChild(rowEl);

        // Enum allowed-values input (shown only when type === 'enum').
        var enumArea = document.createElement('div');
        enumArea.className = 'vlm-schema-enum-area';
        enumArea.style.cssText = 'display:none; margin:2px 0 8px 26px; align-items:center; gap:8px;';
        // Plain inline label — deliberately NOT class "field-help" (that class is
        // flex-basis:100% + a big left margin, meant for full-width help text below
        // a form-group; inside this flex row it would squeeze the input to nothing).
        var enumHint = document.createElement('span');
        enumHint.style.cssText = 'flex:0 0 auto; font-size:0.85em; color:#555; white-space:nowrap;';
        enumHint.textContent = 'allowed values:';
        var enumInput = document.createElement('input');
        enumInput.type = 'text';
        enumInput.className = 'vlm-schema-enum';
        enumInput.placeholder = 'comma-separated, e.g. low, medium, high';
        enumInput.value = (row.enumValues && row.enumValues.length) ? row.enumValues.join(', ') : '';
        enumInput.style.flex = '1';
        enumInput.addEventListener('input', dirty);
        enumArea.appendChild(enumHint);
        enumArea.appendChild(enumInput);
        wrap.appendChild(enumArea);
        wrap._enumInput = enumInput;

        // Nested sub-builder (shown only when type is object / object[]).
        var nested = document.createElement('div');
        nested.className = 'vlm-schema-nested';
        nested.style.cssText = 'display:none; margin:2px 0 8px 26px; padding-left:10px; border-left:2px solid #d7dde3;';
        var nestedRows = document.createElement('div');
        nestedRows.className = 'vlm-schema-rows';
        var addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'btn-secondary';
        addBtn.textContent = '+ Add field';
        addBtn.style.marginTop = '4px';
        addBtn.onclick = function () { addRow(nestedRows, {}); };
        nested.appendChild(nestedRows);
        nested.appendChild(addBtn);
        wrap.appendChild(nested);
        wrap._nestedRows = nestedRows;

        function applyTypeVisibility() {
            var t = typeSelect.value;
            enumArea.style.display = (t === 'enum') ? 'flex' : 'none';
            nested.style.display = (NESTED_TYPES.indexOf(t) !== -1) ? 'block' : 'none';
        }
        typeSelect.addEventListener('change', function () { applyTypeVisibility(); dirty(); });

        container.appendChild(wrap);
        applyTypeVisibility();

        if (NESTED_TYPES.indexOf(typeSelect.value) !== -1 && row.children && row.children.length) {
            row.children.forEach(function (child) { addRow(nestedRows, child); });
        }
        dirty();
    }

    function loadRows(container, rows) {
        container.innerHTML = '';
        rows.forEach(function (r) { addRow(container, r); });
    }

    // Direct-child row wrappers of a container (not descendants — keeps nesting clean).
    function wrapsIn(container) {
        return Array.prototype.filter.call(container.children, function (c) {
            return c.classList && c.classList.contains('vlm-schema-row-wrap');
        });
    }

    // ── Build a JSON Schema from the Fields builder (recursive) ───────────────
    // Returns an object schema, or null when the container has no named rows.
    function buildObjectSchema(container) {
        var properties = {};
        var required = [];
        wrapsIn(container).forEach(function (wrap) {
            var rowEl = wrap.firstElementChild; // .vlm-schema-row
            var name = rowEl.querySelector('.vlm-schema-name').value.trim();
            if (!name) return;
            var type = rowEl.querySelector('.vlm-schema-type').value;
            var description = rowEl.querySelector('.vlm-schema-desc').value.trim();
            var prop = propFor(type, wrap);
            if (description) prop.description = description;
            properties[name] = prop;
            if (rowEl.querySelector('.vlm-schema-required').checked && required.indexOf(name) === -1) {
                required.push(name);
            }
        });
        if (Object.keys(properties).length === 0) return null;
        var schema = { type: 'object', properties: properties };
        if (required.length) schema.required = required;
        return schema;
    }

    function propFor(type, wrap) {
        if (type === 'string[]') {
            return { type: 'array', items: { type: 'string' } };
        }
        if (type === 'enum') {
            var vals = csvToList(wrap._enumInput.value);
            return vals.length ? { type: 'string', enum: vals } : { type: 'string' };
        }
        if (type === 'object') {
            return buildObjectSchema(wrap._nestedRows) || { type: 'object', properties: {} };
        }
        if (type === 'object[]') {
            return { type: 'array', items: buildObjectSchema(wrap._nestedRows) || { type: 'object', properties: {} } };
        }
        return { type: type };
    }

    // ── Decompose a stored schema into row objects (recursive) ────────────────
    // Returns null when the schema is too complex for the builder, so the caller
    // can keep it in Raw JSON instead (lossless fallback).
    function schemaToRows(schema) {
        if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
        if (schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object') return null;
        if (!onlyKeys(schema, ['type', 'properties', 'required', 'description'])) return null;
        var requiredSet = {};
        if (Array.isArray(schema.required)) {
            schema.required.forEach(function (n) { requiredSet[n] = true; });
        }
        var rows = [];
        var names = Object.keys(schema.properties);
        for (var i = 0; i < names.length; i++) {
            var decoded = decodeProp(names[i], schema.properties[names[i]], !!requiredSet[names[i]]);
            if (!decoded) return null;
            rows.push(decoded);
        }
        return rows;
    }

    function onlyKeys(obj, allowed) {
        for (var k in obj) {
            if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
            if (allowed.indexOf(k) === -1) return false;
        }
        return true;
    }

    function decodeProp(name, prop, required) {
        if (!prop || typeof prop !== 'object' || Array.isArray(prop)) return null;
        var base = {
            name: name,
            description: typeof prop.description === 'string' ? prop.description : '',
            required: required
        };

        // String-valued enum.
        if (Array.isArray(prop.enum)) {
            if (!onlyKeys(prop, ['type', 'enum', 'description'])) return null;
            if (prop.type !== undefined && prop.type !== 'string') return null;
            for (var i = 0; i < prop.enum.length; i++) {
                if (typeof prop.enum[i] !== 'string') return null;
            }
            base.type = 'enum';
            base.enumValues = prop.enum.slice();
            return base;
        }

        if (prop.type === 'string' || prop.type === 'number' || prop.type === 'integer' || prop.type === 'boolean') {
            if (!onlyKeys(prop, ['type', 'description'])) return null;
            base.type = prop.type;
            return base;
        }

        if (prop.type === 'array') {
            if (!onlyKeys(prop, ['type', 'items', 'description'])) return null;
            var items = prop.items;
            if (!items || typeof items !== 'object' || Array.isArray(items)) return null;
            if (items.type === 'string' && onlyKeys(items, ['type'])) {
                base.type = 'string[]';
                return base;
            }
            if (items.type === 'object') {
                var itemRows = schemaToRows(items);
                if (!itemRows) return null;
                base.type = 'object[]';
                base.children = itemRows;
                return base;
            }
            return null;
        }

        if (prop.type === 'object') {
            var childRows = schemaToRows(prop);
            if (!childRows) return null;
            base.type = 'object';
            base.children = childRows;
            return base;
        }

        return null;
    }

    // ── Raw JSON validation (only the Custom kind's Raw editor can be invalid) ─
    function validateRaw() {
        var err = el('vlm-schema-error');
        if (getKind() !== 'custom' || getMode() !== 'raw') {
            if (err) err.style.display = 'none';
            return null;
        }
        var ta = el('cfg-vlm-response-schema');
        var text = ta ? ta.value.trim() : '';
        if (!text) {
            if (err) err.style.display = 'none';
            return null;
        }
        try {
            JSON.parse(text);
            if (err) err.style.display = 'none';
            return null;
        } catch (e) {
            if (err) {
                err.textContent = 'Invalid JSON: ' + e.message;
                err.style.display = 'block';
            }
            return e.message;
        }
    }

    // ── Output-schema KIND (free-form / per-class verdicts / custom) ──────────
    // Free-form (default) sends no schema — VIS leaves output free-form (it no
    // longer auto-imposes the class schema once a custom user_prompt is set).
    // "Per-class verdicts" posts the live default class schema (relayed from VIS
    // at /vlm/defaults), so VIS recognizes it (== its own default) and enforces
    // the {class_name, reasoning} contract. "Custom schema" reveals the Fields/Raw
    // builder.

    // The built-in class schema, sourced live from VIS (never mirrored here).
    function defaultClassSchema() {
        var d = window.defaultConfig && window.defaultConfig.vlm_defaults && window.defaultConfig.vlm_defaults.detect;
        return (d && d.response_schema) || null;
    }

    function getKind() {
        var checked = document.querySelector('#cfg-vlm-schema-kind input[name="vlm-schema-kind"]:checked');
        return checked ? checked.value : 'freeform';
    }

    function renderKind(kind) {
        var custom = el('vlm-schema-custom');
        if (custom) custom.style.display = (kind === 'custom') ? 'block' : 'none';
        var help = el('vlm-schema-kind-help');
        if (help) {
            if (kind === 'freeform') {
                help.textContent = 'The model follows your prompt; output is free-form text.';
            } else if (kind === 'default') {
                help.textContent = defaultClassSchema()
                    ? 'Structured per-class verdicts — the model returns {class_name, reasoning} for each class you list above (the built-in detection schema). Requires Classes.'
                    : 'Per-class verdicts use the built-in schema reported by the VI service, which is currently unreachable — reload once it is up, or use Custom schema.';
            } else {
                help.textContent = '';
            }
        }
        validateRaw();
    }

    function setKindRadios(kind) {
        var radios = document.querySelectorAll('#cfg-vlm-schema-kind input[name="vlm-schema-kind"]');
        radios.forEach(function (r) { r.checked = (r.value === kind); });
    }

    // User toggled the kind: update the view and mark dirty.
    function switchKind(kind) {
        renderKind(kind);
        if (window.vlmAutoGrowAll) window.vlmAutoGrowAll();
        dirty();
    }

    // Programmatic kind set (populate / reset) — no dirty.
    function setKind(kind) {
        setKindRadios(kind);
        renderKind(kind);
    }

    // What to persist for response_schema given the selected kind. null => omit
    // the key entirely (free-form). "default" posts the live class schema verbatim.
    function outputSchemaForSave() {
        var kind = getKind();
        if (kind === 'freeform') return null;
        if (kind === 'default') return defaultClassSchema();
        return collect(); // custom: built Fields / parsed Raw, or null when empty
    }

    // Inverse for populateForm: choose the kind from a loaded schema, loading the
    // Fields/Raw editor only for a genuinely custom one.
    function applyOutputSchema(schema) {
        if (!schema || typeof schema !== 'object') { setKind('freeform'); return; }
        var def = defaultClassSchema();
        if (def && deepEqual(schema, def)) { setKind('default'); return; }
        setKind('custom');
        load(schema);
    }

    // ── Public API ────────────────────────────────────────────────────────────
    function collect() {
        if (getMode() === 'raw') {
            var ta = el('cfg-vlm-response-schema');
            var text = ta ? ta.value.trim() : '';
            if (!text) return null;
            try { return JSON.parse(text); } catch (e) { return null; }
        }
        return buildObjectSchema(el(ROWS_ID));
    }

    function load(schema) {
        var rows = schemaToRows(schema);
        var ta = el('cfg-vlm-response-schema');
        if (rows) {
            loadRows(el(ROWS_ID), rows);
            if (ta) ta.value = '';
            setMode('fields');
        } else {
            el(ROWS_ID).innerHTML = '';
            if (ta) ta.value = JSON.stringify(schema, null, 2);
            setMode('raw');
        }
    }

    function reset() {
        var ta = el('cfg-vlm-response-schema');
        if (ta) ta.value = '';
        var rows = el(ROWS_ID);
        if (rows) rows.innerHTML = '';
        var err = el('vlm-schema-error');
        if (err) err.style.display = 'none';
        setMode('fields');
        setKind('freeform');
    }

    function addTopField() {
        addRow(el(ROWS_ID), {});
    }

    window.collectVlmSchema = collect;
    window.loadVlmSchema = load;
    window.validateVlmSchema = validateRaw;
    window.switchVlmSchemaMode = switchMode;
    window.resetVlmSchemaBuilder = reset;
    window.addVlmSchemaField = addTopField;
    window.switchVlmSchemaKind = switchKind;
    window.getVlmSchemaKind = getKind;
    window.vlmOutputSchemaForSave = outputSchemaForSave;
    window.applyVlmOutputSchema = applyOutputSchema;

    // Initialize the kind view (help text + Custom panel visibility) to match the
    // default-checked radio, so the panel is coherent before the first interaction.
    renderKind(getKind());
})();
