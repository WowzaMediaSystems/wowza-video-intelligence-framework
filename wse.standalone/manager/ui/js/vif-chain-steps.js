// vif-chain-steps.js - the plain controls a chain step shows in place of its full settings
// form: chips, sliders and cards. Every control reads and writes the form's own field, so
// saving, validation, inherited defaults and stored secrets stay the form's; the full form
// is still there under "All settings". The page hands in an adapter that reaches the fields.
(function () {
    'use strict';

    window.VIF = window.VIF || {};

    var SIZES = [['nano', 'Nano'], ['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']];
    var COMMON_MODEL = 'common';
    // The common objects model's 80 things, under the headings people browse them by.
    var COCO_GROUPS = [
        ['People and vehicles', ['person', 'car', 'truck', 'bus', 'motorcycle', 'bicycle', 'train', 'boat', 'airplane']],
        ['Street', ['traffic light', 'stop sign', 'fire hydrant', 'parking meter', 'bench']],
        ['Animals', ['dog', 'cat', 'bird', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe']],
        ['Bags and accessories', ['backpack', 'handbag', 'suitcase', 'umbrella', 'tie']],
        ['Sports', ['sports ball', 'frisbee', 'kite', 'skateboard', 'surfboard', 'skis', 'snowboard', 'baseball bat', 'baseball glove', 'tennis racket']],
        ['Kitchen', ['bottle', 'cup', 'wine glass', 'fork', 'knife', 'spoon', 'bowl']],
        ['Food', ['banana', 'apple', 'orange', 'sandwich', 'hot dog', 'pizza', 'donut', 'cake', 'broccoli', 'carrot']],
        ['Furniture', ['chair', 'couch', 'bed', 'dining table', 'toilet', 'potted plant']],
        ['Electronics', ['tv', 'laptop', 'cell phone', 'keyboard', 'mouse', 'remote']],
        ['Appliances', ['refrigerator', 'microwave', 'oven', 'toaster', 'sink']],
        ['Around the house', ['book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush']]
    ];
    var TASKS = [
        ['describe', 'Describe what it sees', 'Writes a short description. There are no labels for a condition to match.'],
        ['detect', 'Check for specific things', 'Answers yes or no for each thing you list.'],
        ['custom', 'Follow my instructions', 'Uses your own question or prompt.']
    ];
    var TRACKING_HELP = 'Gives each object an ID that stays the same while it is in view. Needed for counting and time-in-area rules.';

    var seq = 0;
    // The model list's "Other…" choice (VLM_MODEL_OTHER in vif-stream-config.js).
    var OTHER_MODEL = '__other__';

    function nextId(base) { return 'cs-' + base + '-' + (++seq); }

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function button(text, className, onClick) {
        var node = el('button', className, text);
        node.type = 'button';
        if (onClick) node.addEventListener('click', onClick);
        return node;
    }

    function tip(text) {
        var node = el('span', 'vif-help-tip');
        node.dataset.vifTip = text;
        node.setAttribute('aria-label', 'Help');
        return node;
    }

    function headed(labelText, forId, tipText) {
        var head = el('div', 'cs-head');
        var label = el('label', 'cs-label', labelText);
        if (forId) label.htmlFor = forId;
        head.appendChild(label);
        if (tipText) head.appendChild(tip(tipText));
        return { el: head, label: label };
    }

    function round(value, decimals) {
        var factor = Math.pow(10, decimals || 0);
        return Math.round(value * factor) / factor;
    }

    function fieldNumber(input, fallback) {
        var raw = (input.value || '').trim();
        var fromField = raw !== '' ? Number(raw) : Number(input.placeholder);
        var inherited = Number(input.placeholder);
        return { value: isFinite(fromField) ? fromField : fallback, isDefault: raw === '',
                 defaultValue: input.placeholder !== '' && isFinite(inherited) ? inherited : fallback };
    }

    function fire(adapter, element) { adapter.fire(element); }

    // A dropdown's, switch's or typed box's own input and change events stay with it: the step refreshes
    // on input, which would put the old choice back before the change is handled. Its handler
    // writes the form field, and that change is what the step reacts to.
    function keepToItself(control) {
        ['input', 'change'].forEach(function (name) {
            control.addEventListener(name, function (event) { event.stopPropagation(); });
        });
    }

    // ── controls ─────────────────────────────────────────────────────────────

    /**
     * A slider over a number field. `spec`: {id, label, min, max, step, decimals, fallback,
     * unit, help, tip, fromField, toField, number: {min, max, step}} - `number` adds a typed
     * box beside the slider for values past the slider's usual range.
     */
    function rangeControl(adapter, spec) {
        var id = nextId(spec.id);
        var wrap = el('div', 'cs-field');
        var head = headed(spec.label, id, spec.tip);
        var row = el('div', 'cs-range-row');
        var range = el('input', 'cs-range');
        range.type = 'range';
        range.id = id;
        range.min = String(spec.min);
        range.max = String(spec.max);
        range.step = String(spec.step);
        row.appendChild(range);
        var number = null;
        if (spec.number) {
            number = el('input', 'cs-number');
            number.type = 'number';
            number.min = String(spec.number.min);
            number.max = String(spec.number.max);
            number.step = String(spec.number.step);
            number.setAttribute('aria-label', spec.label + ', typed');
            row.appendChild(number);
            if (spec.unit) row.appendChild(el('span', 'cs-unit', spec.unit));
        }
        // The default stays in view while the slider moves, with a way back to it.
        var defaults = el('span', 'cs-default');
        var defaultText = el('span', 'cs-default-text');
        var reset = el('button', 'cs-reset', 'Reset');
        reset.type = 'button';
        reset.addEventListener('click', function () {
            var input = adapter.field(spec.id);
            input.value = '';
            fire(adapter, input);
            sync();
        });
        defaults.append(defaultText, reset);
        head.el.appendChild(defaults);
        wrap.append(head.el, row);
        if (spec.help) wrap.appendChild(el('p', 'cs-help', spec.help));

        var fromField = spec.fromField || function (v) { return v; };
        var toField = spec.toField || function (v) { return v; };

        function write(shown) {
            var input = adapter.field(spec.id);
            var clamp = spec.number || spec;
            shown = Math.min(clamp.max, Math.max(clamp.min, shown));
            input.value = String(round(toField(shown), spec.fieldDecimals === undefined ? 3 : spec.fieldDecimals));
            if (spec.moved) spec.moved();
            fire(adapter, input);
        }

        range.addEventListener('input', function () { write(Number(range.value)); });
        if (number) {
            number.addEventListener('change', function () {
                var typed = Number(number.value);
                if (isFinite(typed) && number.value.trim() !== '') write(typed);
                else sync();
            });
            keepToItself(number);
        }

        function sync() {
            var current = fieldNumber(adapter.field(spec.id), spec.fallback);
            var shown = round(fromField(current.value), spec.decimals || 0);
            range.value = String(shown);
            if (number && document.activeElement !== number) number.value = String(shown);
            head.label.textContent = spec.label + ': ' + shown + (spec.unit || '') + (spec.after ? spec.after(shown) : '');
            defaultText.textContent = 'Default ' + round(fromField(current.defaultValue), spec.decimals || 0) + (spec.unit || '');
            reset.style.display = current.isDefault || current.value === current.defaultValue ? 'none' : '';
        }
        return { el: wrap, sync: sync };
    }

    /**
     * Chips for what a Find objects step looks for, from everything its model finds
     * (`spec.known()`), so nothing has to be guessed. The first 10 show, then up to 100 on
     * "more", then the rest; the common objects model's full list sits under plain headings.
     * A model that doesn't list what it finds gets a box to type names into.
     */
    function objectChips(adapter, spec) {
        var wrap = el('div', 'cs-field');
        var labelId = nextId('chips');
        var head = headed(spec.label, null, spec.tip);
        head.label.id = labelId;
        var groups = el('div', 'cs-groups');
        groups.setAttribute('role', 'group');
        groups.setAttribute('aria-labelledby', labelId);
        var addRow = el('div', 'cs-add');
        var addInput = el('input', 'cs-add-input');
        addInput.type = 'text';
        addInput.placeholder = 'Type what your model finds';
        addInput.setAttribute('aria-label', spec.addLabel);
        addInput.autocomplete = 'off';
        addInput.spellcheck = false;
        var addButton = button('Add', 'btn-secondary', add);
        addRow.append(addInput, addButton);
        var level = 0;
        var nextLevel = 1;
        var levelFor = null;
        var links = el('div', 'cs-links');
        var moreLink = button('', 'cs-reset', function () { level = nextLevel; sync(); });
        var fewerLink = button('Show fewer', 'cs-reset', function () {
            level = 0;
            sync();
            // The list shrinks above where the reader is, so bring it back into view.
            if (wrap.getBoundingClientRect().top < 0) wrap.scrollIntoView({ block: 'center' });
        });
        links.append(moreLink, fewerLink);
        // Picks this model can't find stay put through both: they are taken off one at a time.
        var bulk = el('div', 'cs-links cs-bulk');
        var selectAll = button('Select all', 'cs-reset', function () {
            var list = spec.list.get();
            var known = spec.known() || [];
            spec.list.set(list.filter(function (name) { return known.indexOf(name) === -1; }).concat(known));
        });
        var unselectAll = button('Unselect all', 'cs-reset', function () {
            var known = spec.known() || [];
            spec.list.set(spec.list.get().filter(function (name) { return known.indexOf(name) === -1; }));
        });
        bulk.append(selectAll, unselectAll);
        var help = el('p', 'cs-help');
        wrap.append(head.el, bulk, groups, links, addRow, help);

        function add() {
            var value = addInput.value.trim().toLowerCase();
            if (!value) return;
            var list = spec.list.get();
            if (list.indexOf(value) === -1) spec.list.set(list.concat([value]));
            addInput.value = '';
            addInput.focus();
        }
        addInput.addEventListener('keydown', function (event) {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            add();
        });

        function chipRow(names, list) {
            var row = el('div', 'cs-chips');
            names.forEach(function (name) {
                var on = list.indexOf(name) !== -1;
                var chip = button(name, 'cs-chip' + (on ? ' is-on' : ''), function () {
                    var next = list.slice();
                    var at = next.indexOf(name);
                    if (at === -1) next.push(name); else next.splice(at, 1);
                    spec.list.set(next);
                });
                chip.setAttribute('aria-pressed', String(on));
                row.appendChild(chip);
            });
            return row;
        }

        function group(title, names, list) {
            var box = el('div', 'cs-group');
            box.append(el('div', 'cs-group-title', title), chipRow(names, list));
            groups.appendChild(box);
        }

        function sync() {
            var list = spec.list.get();
            var known = spec.known();
            groups.replaceChildren();
            moreLink.style.display = 'none';
            fewerLink.style.display = 'none';
            if (known) {
                // A different model starts from its first 10 again.
                var knownKey = known.join('\n');
                if (knownKey !== levelFor) {
                    levelFor = knownKey;
                    level = 0;
                }
                var sections = [];
                var placed = [];
                COCO_GROUPS.forEach(function (entry) {
                    var names = entry[1].filter(function (name) { return known.indexOf(name) !== -1; });
                    if (names.length < 2) return;
                    sections.push([entry[0], names]);
                    placed = placed.concat(names);
                });
                var rest = known.filter(function (name) { return placed.indexOf(name) === -1; });
                if (rest.length) sections.push(['Other', rest]);
                var ordered = sections.reduce(function (all, section) { return all.concat(section[1]); }, []);
                var picks = list.filter(function (name) { return known.indexOf(name) !== -1; });
                // Picks past the cut stay in view, so what's picked never hides.
                var visibleAt = function (cut) {
                    var head = ordered.slice(0, cut);
                    return head.concat(picks.filter(function (name) { return head.indexOf(name) === -1; }));
                };
                var shown = visibleAt(level === 0 ? 10 : level === 1 ? 100 : ordered.length);
                var whole = shown.length >= ordered.length;
                if (whole && sections.length > 1) {
                    sections.forEach(function (section) { group(section[0], section[1], list); });
                } else {
                    groups.appendChild(chipRow(whole ? ordered : shown, list));
                }
                if (!whole) {
                    var adds = level === 0 ? visibleAt(100).length - shown.length : 0;
                    nextLevel = adds > 0 ? 1 : 2;
                    moreLink.textContent = adds > 0 ? 'Show ' + adds + ' more' : 'Show all ' + ordered.length;
                    moreLink.style.display = '';
                }
                fewerLink.style.display = level > 0 ? '' : 'none';
                // Saved picks this model can't find stay visible so they can be taken off.
                var unknown = list.filter(function (name) { return known.indexOf(name) === -1; });
                if (unknown.length) group('This model can’t find', unknown, list);
            } else if (list.length) {
                groups.appendChild(chipRow(list, list));
            }
            links.style.display = moreLink.style.display === 'none' && fewerLink.style.display === 'none' ? 'none' : '';
            addRow.style.display = known ? 'none' : '';
            var picked = known ? known.filter(function (name) { return list.indexOf(name) !== -1; }).length : list.length;
            bulk.style.display = known ? '' : 'none';
            selectAll.style.display = known && picked < known.length ? '' : 'none';
            unselectAll.style.display = known && picked > 0 ? '' : 'none';
            help.textContent = !list.length ? 'Nothing picked yet. Pick at least one thing to look for.'
                : known && picked === known.length ? 'Looking for everything this model finds.'
                : 'Looking for: ' + list.join(', ') + '.';
        }
        return { el: wrap, sync: sync };
    }

    // How to add a model of your own, on the Model label; the same steps sit on the
    // single-detector form's Model Name.
    var YOUR_MODEL_TIP = 'Use your own object model\n\n'
        + '1. Save your trained RF-DETR model as a .pt or .pth file.\n'
        + '2. Copy it into the Video Intelligence Service’s models folder. In the standard setup, that’s vis/models.\n'
        + '3. Restart the Video Intelligence Service.\n'
        + '4. Reload this page. Your model appears in this list under its file name, with the objects it’s trained to find.\n\n'
        + 'Only add model files you trust: the service can run code inside a model file when loaded.';

    /**
     * Which model a Find objects step uses: the common objects model, or one of yours. Shown
     * even with no model of yours, so its tip says how to add one.
     */
    function modelPicker(adapter, spec) {
        var id = nextId('model');
        var wrap = el('div', 'cs-field');
        var head = headed(spec.label, id, YOUR_MODEL_TIP);
        var select = el('select', 'cs-select');
        select.id = id;
        var help = el('p', 'cs-help');
        var note = el('p', 'cs-help cs-note');
        wrap.append(head.el, select, help, note);
        note.style.display = 'none';
        keepToItself(select);
        select.addEventListener('change', function () {
            var picked = select.value === COMMON_MODEL ? 'Common objects' : select.options[select.selectedIndex].textContent;
            var dropped = spec.model.set(select.value);
            note.textContent = dropped.length
                ? 'No longer looking for ' + dropped.join(', ') + ', since ' + picked + ' can’t find ' + (dropped.length === 1 ? 'it.' : 'them.')
                : '';
            note.style.display = dropped.length ? '' : 'none';
        });

        var optionsKey = null;
        function sync() {
            var yours = spec.model.yours();
            // Rebuilding the options while the list is open would close it and lose the choice.
            var key = yours.map(function (model) { return model.value; }).join('\n');
            if (key !== optionsKey) {
                optionsKey = key;
                select.replaceChildren();
                var common = el('option', null, 'Common objects (80 types)');
                common.value = COMMON_MODEL;
                select.appendChild(common);
                if (yours.length) {
                    var group = el('optgroup');
                    group.label = 'Your models';
                    yours.forEach(function (model) {
                        var option = el('option', null, model.label);
                        option.value = model.value;
                        group.appendChild(option);
                    });
                    select.appendChild(group);
                }
            }
            var value = spec.model.get();
            if (select.value !== value) select.value = value;
            help.textContent = select.value !== COMMON_MODEL ? 'Finds only what this model was trained to find.'
                : yours.length ? 'Finds 80 kinds of things, such as people, vehicles, and animals. To find something else, use one of your models.'
                : 'Finds 80 kinds of things, such as people, vehicles, and animals. To find something else, add a model of your own: see the ⓘ next to Model.';
        }
        return { el: wrap, sync: sync };
    }

    /** Chips with a remove cross, over a list field; a box below adds one more. */
    function listChips(adapter, spec) {
        var wrap = el('div', 'cs-field');
        var labelId = nextId('list');
        var head = headed(spec.label, null, spec.tip);
        head.label.id = labelId;
        var chips = el('div', 'cs-chips');
        chips.setAttribute('role', 'group');
        chips.setAttribute('aria-labelledby', labelId);
        var addRow = el('div', 'cs-add');
        var addInput = el('input', 'cs-add-input');
        addInput.type = 'text';
        addInput.placeholder = spec.placeholder;
        addInput.setAttribute('aria-label', spec.addLabel);
        addInput.autocomplete = 'off';
        var addButton = button('Add', 'btn-secondary', add);
        addRow.append(addInput, addButton);
        wrap.append(head.el, chips, addRow);
        if (spec.help) wrap.appendChild(el('p', 'cs-help', spec.help));

        function add() {
            var value = addInput.value.trim();
            if (!value) return;
            var list = spec.list.get();
            if (list.indexOf(value) === -1) spec.list.set(list.concat([value]));
            addInput.value = '';
            addInput.focus();
        }
        addInput.addEventListener('keydown', function (event) {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            add();
        });

        function sync() {
            var list = spec.list.get();
            chips.replaceChildren();
            if (!list.length) chips.appendChild(el('span', 'cs-empty', spec.empty));
            list.forEach(function (name) {
                var chip = button(name + ' ×', 'cs-chip is-on', function () {
                    spec.list.set(list.filter(function (each) { return each !== name; }));
                });
                chip.setAttribute('aria-label', 'Remove ' + name);
                chips.appendChild(chip);
            });
        }
        return { el: wrap, sync: sync };
    }

    /** A row of choices where one is active, over a select or radio field. */
    function segmented(adapter, spec) {
        var wrap = el('div', 'cs-field');
        var labelId = nextId('seg');
        var head = headed(spec.label, null, spec.tip);
        head.label.id = labelId;
        var seg = el('div', 'chain-seg cs-seg');
        seg.setAttribute('role', 'group');
        seg.setAttribute('aria-labelledby', labelId);
        wrap.append(head.el, seg);
        if (spec.help) wrap.appendChild(el('p', 'cs-help', spec.help));

        function sync() {
            var value = spec.get();
            rebuildKeepingFocus(seg, function () {
                spec.options(value).forEach(function (option) {
                    var active = option[0] === value;
                    var item = button(option[1], active ? 'is-active' : '', function () { if (!active) spec.set(option[0]); });
                    item.dataset.choice = String(option[0]);
                    item.setAttribute('aria-pressed', String(active));
                    seg.appendChild(item);
                });
            });
        }
        return { el: wrap, sync: sync };
    }

    /** An on/off switch with a help line that can carry the reason it is locked. */
    function toggle(adapter, spec) {
        var wrap = el('div', 'cs-switch-row');
        var text = el('div', 'cs-switch-text');
        var labelId = nextId('switch');
        var label = el('div', 'cs-label', spec.label);
        label.id = labelId;
        var help = el('p', 'cs-help');
        text.append(label, help);
        var holder = el('label', 'switch');
        var box = el('input');
        box.type = 'checkbox';
        box.setAttribute('aria-labelledby', labelId);
        holder.append(box, el('span', 'slider-switch'));
        wrap.append(text, holder);
        keepToItself(box);
        box.addEventListener('change', function () { spec.set(box.checked); });

        function sync(info) {
            var why = spec.lockedWhy(info);
            box.checked = spec.get();
            box.disabled = !!why && !box.checked;
            help.textContent = why || spec.help;
        }
        return { el: wrap, sync: sync };
    }

    /**
     * Rebuilds a group of choice buttons, then gives focus back to the rebuilt button for the
     * choice that had it, so a keyboard or mouse pick doesn't drop focus to the page.
     */
    function rebuildKeepingFocus(container, build) {
        var focused = container.contains(document.activeElement) ? document.activeElement.dataset.choice : undefined;
        container.replaceChildren();
        build();
        if (focused === undefined) return;
        var again = Array.prototype.find.call(container.children, function (node) { return node.dataset.choice === focused; });
        if (again) again.focus({ preventScroll: true });
    }

    /** Stacked cards where one is picked, over the AI model's mode. */
    function taskCards(adapter, spec) {
        var wrap = el('div', 'cs-field');
        var labelId = nextId('tasks');
        var head = headed(spec.label, null);
        head.label.id = labelId;
        var list = el('div', 'cs-cards');
        list.setAttribute('role', 'group');
        list.setAttribute('aria-labelledby', labelId);
        wrap.append(head.el, list);

        function sync() {
            var value = spec.get();
            rebuildKeepingFocus(list, function () {
                TASKS.forEach(function (task) {
                    var active = task[0] === value;
                    var card = button('', 'cs-card' + (active ? ' is-on' : ''), function () { if (!active) spec.set(task[0]); });
                    card.dataset.choice = task[0];
                    card.setAttribute('aria-pressed', String(active));
                    card.append(el('span', 'cs-card-title', task[1]), el('span', 'cs-card-text', task[2]));
                    list.appendChild(card);
                });
            });
        }
        return { el: wrap, sync: sync };
    }

    /** A text box over a field, written as the user types. */
    function textControl(adapter, spec) {
        var id = nextId(spec.id);
        var wrap = el('div', 'cs-field');
        var head = headed(spec.label, id, spec.tip);
        var area = el('textarea', 'cs-text');
        area.id = id;
        area.rows = spec.rows || 4;
        area.placeholder = spec.placeholder || '';
        // The box edits the form's own field, so the form's copy stays out of Advanced.
        adapter.field(spec.id);
        wrap.append(head.el, area);
        if (spec.help) wrap.appendChild(el('p', 'cs-help', spec.help));
        function grow() {
            if (area.offsetParent === null) return;
            area.style.height = 'auto';
            area.style.height = (area.scrollHeight + 2) + 'px';
        }
        area.addEventListener('input', function () {
            var input = adapter.field(spec.id);
            input.value = area.value;
            fire(adapter, input);
            grow();
        });
        function sync() {
            var value = adapter.field(spec.id).value;
            if (area.value !== value && document.activeElement !== area) area.value = value;
            grow();
        }
        return { el: wrap, sync: sync };
    }

    /** A one-line box editing a text field of the form. */
    function lineControl(adapter, spec) {
        var id = nextId(spec.id);
        var wrap = el('div', 'cs-field');
        var head = headed(spec.label, id, spec.tip);
        var input = el('input', 'cs-line');
        input.type = 'text';
        input.id = id;
        input.placeholder = spec.placeholder || '';
        adapter.field(spec.id);
        wrap.append(head.el, input);
        if (spec.help) wrap.appendChild(el('p', 'cs-help', spec.help));
        input.addEventListener('input', function () {
            var source = adapter.field(spec.id);
            source.value = input.value;
            fire(adapter, source);
        });
        function sync() {
            var value = adapter.field(spec.id).value;
            if (input.value !== value && document.activeElement !== input) input.value = value;
        }
        return { el: wrap, sync: sync };
    }

    /** Form fields lifted out of the step's settings form to sit with the plain controls. */
    function liftedFields(adapter, ids) {
        var wrap = el('div', 'cs-lifted');
        adapter.liftFormGroups(ids, wrap);
        return { el: wrap, sync: function () { adapter.liftFormGroups(ids, wrap); } };
    }

    /** A button that opens the AI model step's guide to writing instructions. */
    function guideButton(adapter, label) {
        var wrap = el('div', 'cs-field');
        wrap.appendChild(button(label, 'btn-secondary vlm-guide-button', function () { adapter.openGuide(); }));
        return { el: wrap, sync: function () {} };
    }

    /** A dropdown mirroring a select field's options. */
    function mirroredSelect(adapter, spec) {
        var id = nextId(spec.id);
        var wrap = el('div', 'cs-field');
        var head = headed(spec.label, id, spec.tip);
        var select = el('select', 'cs-select');
        select.id = id;
        wrap.append(head.el, select);
        if (spec.help) wrap.appendChild(el('p', 'cs-help', spec.help));
        keepToItself(select);
        select.addEventListener('change', function () {
            var source = adapter.field(spec.id);
            source.value = select.value;
            fire(adapter, source);
        });
        var optionsKey = null;
        function sync() {
            var source = adapter.field(spec.id);
            // Rebuilding the options while the list is open would close it and lose the choice.
            var key = Array.from(source.options).map(function (option) { return option.value + '\t' + option.textContent; }).join('\n');
            if (key !== optionsKey) {
                optionsKey = key;
                select.replaceChildren();
                Array.from(source.options).forEach(function (option) {
                    var copy = el('option', null, spec.relabel ? spec.relabel(option) : option.textContent);
                    copy.value = option.value;
                    select.appendChild(copy);
                });
            }
            if (select.value !== source.value) select.value = source.value;
        }
        return { el: wrap, sync: sync };
    }

    /**
     * The settings for following objects, under the Follow switch while it is on: the three
     * people change, then the two fine-tuning ones behind a link.
     */
    function followSettings(adapter) {
        var following = function () { return adapter.field('cfg-tracking-method').value === 'byte-track'; };
        // A frame count, as about how long it lasts at the chain's capture rate.
        var aboutSeconds = function (frames) {
            var fps = adapter.framesPerSecond();
            if (!fps || !frames) return '';
            var seconds = frames / fps;
            return ' (about ' + (seconds < 10 ? Math.round(seconds * 10) / 10 : Math.round(seconds)) + ' s)';
        };
        var keep = rangeControl(adapter, { id: 'cfg-bt-max-lost-frames', label: 'Keep an ID while hidden for', min: 0, max: 60, step: 1,
            fallback: 30, unit: ' frames', help: 'If an object is out of sight for longer than this, like when it’s hidden behind another object, it gets a new ID when it comes back. Raise it if you want the same object to keep its ID. If it’s set too high, a different object in the same spot can take over the old one’s ID.',
            after: aboutSeconds });
        var appear = rangeControl(adapter, { id: 'cfg-bt-min-frames', label: 'Frames before an ID appears', min: 0, max: 60, step: 1,
            fallback: 3, after: aboutSeconds,
            help: 'An object has to be seen in this many frames in a row before it gets an ID. Raise it if brief misidentifications, like a shadow taken for a person, get IDs.' });
        var only = toggle(adapter, { label: 'Only report objects with an ID', help: 'When on, only objects with an ID show up in results, so one-off misidentifications are left out. New objects show up a little later, once they have their ID.',
            get: function () { return adapter.field('cfg-ignore-untracked-objects').checked; },
            set: function (on) { var box = adapter.field('cfg-ignore-untracked-objects'); box.checked = on; fire(adapter, box); },
            lockedWhy: function () { return ''; } });
        var start = rangeControl(adapter, { id: 'cfg-bt-min-confidence', label: 'Start following at', min: 0, max: 100, step: 5,
            fallback: 50, unit: '% sure', help: 'How sure the model must be before it gives something new an ID. Raise it if misidentifications get IDs. Lower it if real objects never get one.' });
        var overlap = rangeControl(adapter, { id: 'cfg-bt-min-overlap', label: 'Match boxes that overlap by at least', min: 0, max: 100, step: 5,
            fallback: 20, unit: '%', help: 'How much an object’s box has to overlap its box in the previous frame to count as the same object. Lower it if fast-moving objects keep getting new IDs. If it’s set too low, two objects passing close together can swap IDs.' });

        var wrap = el('div', 'cs-sub');
        var more = el('details', 'chain-disclosure cs-sub-more');
        var summary = el('summary', null, 'More following settings');
        summary.prepend(el('span', 'collapse-chevron', '▼'));
        var moreBody = el('div', 'chain-disclosure-body');
        moreBody.append(start.el, overlap.el);
        more.append(summary, moreBody);
        wrap.append(keep.el, appear.el, only.el, more);
        var parts = [keep, appear, only, start, overlap];
        return {
            el: wrap,
            sync: function (info) {
                var on = following();
                wrap.style.display = on ? '' : 'none';
                if (on) parts.forEach(function (part) { part.sync(info); });
            }
        };
    }

    var STRICT_FALLBACK = 0.3; // the service's own setting when none is chosen anywhere
    var STRICT_NAMED = [['balanced', 'Balanced', window.VIF.chainPresets.SYNTHETIC_BALANCED],
        ['catch', 'Catch more', window.VIF.chainPresets.SYNTHETIC_CATCH_MORE]];
    /**
     * How strict an AI-generated video check is, as a choice over its score field: the
     * default (blank), one of NVIDIA's two named settings, or the user's own score.
     * `input()` returns the score field (0 to 1). The user's own, once picked or once they
     * move the score themselves (`keepOwn()`), holds until another choice is picked, whatever
     * the score; `forget()` drops it for a newly loaded score.
     */
    function strictness(input) {
        var own = false;
        function typed() { return (input().value || '').trim(); }
        function get() {
            var value = typed();
            if (value === '') { own = false; return 'default'; }
            var named = own ? null : STRICT_NAMED.filter(function (entry) { return Number(value) === entry[2]; })[0];
            return named ? named[0] : 'custom';
        }
        /** Writes the choice into the field; true when the score changed. */
        function set(choice) {
            var field = input();
            var before = field.value;
            var named = STRICT_NAMED.filter(function (entry) { return entry[0] === choice; })[0];
            own = choice === 'custom';
            if (named) field.value = String(named[2]);
            else if (choice === 'default') field.value = '';
            else if (typed() === '') field.value = String(fieldNumber(field, STRICT_FALLBACK).defaultValue);
            return field.value !== before;
        }
        function options() {
            return [['default', 'Default (' + toPercent(fieldNumber(input(), STRICT_FALLBACK).defaultValue) + '%)']]
                .concat(STRICT_NAMED.map(function (entry) { return [entry[0], entry[1]]; }), [['custom', 'My own']]);
        }
        return { get: get, set: set, options: options, keepOwn: function () { own = true; }, forget: function () { own = false; } };
    }

    // A 0 to 1 score as a percentage and back, without float noise either way.
    function toPercent(score) { return Number((score * 100).toFixed(2)); }
    function fromPercent(percent) { return Number((percent / 100).toFixed(4)); }

    function shownWhen(control, when) {
        var sync = control.sync;
        control.sync = function (info) {
            var on = when();
            control.el.style.display = on ? '' : 'none';
            if (on) sync(info);
        };
        return control;
    }

    // ── per step type ────────────────────────────────────────────────────────

    function controlsFor(adapter) {
        var main = [], more = [], advanced = [];
        switch (adapter.type) {
            case 'motion':
                main.push(rangeControl(adapter, { id: 'cfg-motion-sensitivity', label: 'How sensitive', min: 1, max: 10, step: 1, fallback: 5,
                    unit: ' of 10', help: 'A higher setting catches smaller and slower movement, but also wakes the steps after it more often.' }));
                more.push(rangeControl(adapter, { id: 'cfg-motion-min-displacement', label: 'Smallest movement that counts', min: 0, max: 30, step: 0.5,
                    decimals: 1, fallback: 2, unit: '%', number: { min: 0, max: 100, step: 0.1 },
                    help: 'How far something has to move before it counts. Raise it if swaying trees or flickering shadows set it off; lower it to catch small, slow movement.' }));
                more.push(rangeControl(adapter, { id: 'cfg-motion-merge-distance', label: 'Join moving areas closer than', min: 0, max: 25, step: 0.5,
                    decimals: 1, fallback: 8, unit: '%', number: { min: 0, max: 50, step: 0.1 },
                    help: 'Movement can appear as separate patches, such as a person’s arms and legs. Patches within this distance are grouped into one box. Increase this value if one person appears in multiple boxes; decrease it if two people walking together appear in a single box.' }));
                more.push(mirroredSelect(adapter, { id: 'cfg-motion-suppress-global-changes', label: 'When the whole picture changes',
                    relabel: function (option) {
                        var choices = { 'true': 'Count it as nothing moving', 'false': 'Count it as movement' };
                        if (option.value !== '') return choices[option.value] || option.textContent;
                        // The form's blank option names the default in force: "Default (Suppress)" or "Default (Report)".
                        var counts = /Report/.test(option.textContent) ? choices['false'] : choices['true'];
                        return 'Use the default (' + counts.charAt(0).toLowerCase() + counts.slice(1) + ')';
                    },
                    help: 'A cut, a lighting change or a camera move changes the whole picture at once. Counting it as nothing moving keeps it from waking the steps after this one.' }));
                break;
            case 'object':
                main.push(modelPicker(adapter, { label: 'Model', model: adapter.objectModel }));
                main.push(objectChips(adapter, { label: 'What to look for', list: adapter.classes,
                    known: adapter.objectModel.classes, addLabel: 'Add a thing to look for' }));
                main.push(rangeControl(adapter, { id: 'cfg-confidence-threshold', label: 'How sure the model must be', min: 0, max: 100, step: 1, fallback: 30,
                    unit: '%', help: 'Lowering this finds more objects, but some may be misidentified.' }));
                more.push(shownWhen(segmented(adapter, { label: 'Model size', help: 'Larger models are more accurate but use more of the GPU, so fewer streams can be analyzed.',
                    get: function () { return adapter.field('cfg-model-name').value; },
                    set: function (value) { var select = adapter.field('cfg-model-name'); select.value = value; fire(adapter, select); },
                    options: function () { return SIZES; } }),
                    function () { return adapter.objectModel.get() === COMMON_MODEL; }));
                more.push(toggle(adapter, { label: 'Follow each object from frame to frame', help: TRACKING_HELP,
                    get: function () { return adapter.field('cfg-tracking-method').value === 'byte-track'; },
                    set: function (on) { var select = adapter.field('cfg-tracking-method'); select.value = on ? 'byte-track' : 'none'; fire(adapter, select); },
                    lockedWhy: function (info) { return (info || {}).trackingWhy || ''; } }));
                more.push(followSettings(adapter));
                break;
            case 'scene':
                main.push(listChips(adapter, { label: 'What to recognize', list: adapter.sceneClasses, placeholder: 'A few words, such as smoke rising',
                    addLabel: 'Add a scene to recognize', empty: 'Nothing yet.', help: 'Each scene is scored on its own, so a condition can match any of them.' }));
                // Stored as a whole number, so the slider offers only whole numbers.
                main.push(rangeControl(adapter, { id: 'cfg-scene-sensitivity', label: 'How sensitive', min: 0, max: 10, step: 1, fallback: 5,
                    unit: ' of 10', help: 'Higher makes a scene easier to trigger.' }));
                main.push(rangeControl(adapter, { id: 'cfg-scene-confidence-threshold', label: 'How sure the model must be', min: 0, max: 100, step: 1,
                    fallback: 30, unit: '%', help: 'Lowering this recognizes more scenes, but some may be misidentified.' }));
                break;
            case 'vlm':
                main.push(taskCards(adapter, { label: 'What the AI model should do', get: adapter.vlmMode.get, set: adapter.vlmMode.set }));
                main.push(shownWhen(listChips(adapter, { label: 'Things to check for', list: adapter.things, placeholder: 'e.g. person not wearing a hard hat',
                    addLabel: 'Add a thing to check for', empty: 'Nothing yet.',
                    tip: 'Each entry is one thing the AI model looks for, answering yes if it’s clearly visible in the picture. '
                        + 'Describe the situation you care about in a few words, like “person not wearing a hard hat” rather than just “hard hat”. '
                        + 'Stick to what can be seen: the model won’t guess things like whether someone is an employee.',
                    help: 'The model answers yes or no for each thing, and a condition can act on the answer.' }),
                    function () { return adapter.vlmMode.get() === 'detect'; }));
                var custom = function () { return adapter.vlmMode.get() === 'custom'; };
                main.push(shownWhen(guideButton(adapter, 'How to write instructions'), custom));
                main.push(shownWhen(textControl(adapter, { id: 'cfg-vlm-user-prompt', label: 'Your instructions', rows: 4,
                    placeholder: 'For example: Is anyone climbing the fence? Answer yes or no, then explain.',
                    help: 'Fill in the list below to use {class_list}.' }), custom));
                main.push(shownWhen(textControl(adapter, { id: 'cfg-vlm-system-prompt', label: 'Background for the model', rows: 3,
                    placeholder: 'For example: You are a safety inspector at a construction site.',
                    help: 'Optional. Who the model is and the rules it follows for every answer. Blank uses a built-in one.' }), custom));
                main.push(shownWhen(liftedFields(adapter, ['cfg-vlm-custom-classes', 'cfg-vlm-schema-kind']), custom));
                advanced.push(mirroredSelect(adapter, { id: 'cfg-vlm-model-name', label: 'AI model',
                    relabel: function (option) { return option.value === '' ? 'The default model' : option.textContent; } }));
                advanced.push(shownWhen(lineControl(adapter, { id: 'cfg-vlm-model-name-other', label: 'Model name',
                    placeholder: 'For example: Qwen/Qwen3-VL-8B-Instruct',
                    help: 'Exactly as your AI server names it.' }),
                    function () { return adapter.field('cfg-vlm-model-name').value === OTHER_MODEL; }));
                break;
            case 'synthetic': {
                var score = function () { return adapter.field('cfg-synthetic-classification-threshold'); };
                var strict = strictness(score);
                main.push(segmented(adapter, { label: 'How strict', get: strict.get, options: strict.options,
                    set: function (choice) { strict.set(choice); fire(adapter, score()); },
                    help: 'A clip counts as AI-generated when its score is above the setting. Balanced (44%) suits most uses. '
                        + 'Catch more (26%) misses fewer AI-generated clips but flags more real ones.' }));
                main.push(shownWhen(rangeControl(adapter, { id: 'cfg-synthetic-classification-threshold', label: 'Flag clips scoring above', min: 1, max: 99, step: 1,
                    fallback: STRICT_FALLBACK, unit: '%', fromField: function (v) { return v * 100; }, toField: function (v) { return v / 100; }, fieldDecimals: 2,
                    moved: strict.keepOwn }),
                    function () { return strict.get() === 'custom'; }));
                break;
            }
            default:
                break;
        }
        return { main: main, more: more, advanced: advanced };
    }

    /**
     * The plain controls for one step. `adapter` reaches the step's form: `type`, `field(id)`,
     * `fire(element)`, `{get, set}` pairs for `classes`, `sceneClasses`, `things` and
     * `vlmMode`, `framesPerSecond()` (the chain's capture rate, or null when it has none), and `objectModel`: `get()` ('common' or a model of yours), `set(value)`
     * (returns the picked things the new model can't find), `yours()` and `classes()`. Returns the main block, the "More settings" block, the block
     * that opens the step's Advanced, and `sync(info)`, which re-reads the form; `info.trackingWhy` is the reason tracking is locked, if any.
     */
    function createStepControls(adapter) {
        var controls = controlsFor(adapter);
        var main = el('div', 'cs-main');
        var more = el('div', 'cs-more');
        var advanced = el('div', 'cs-advanced');
        controls.main.forEach(function (control) { main.appendChild(control.el); });
        controls.more.forEach(function (control) { more.appendChild(control.el); });
        controls.advanced.forEach(function (control) { advanced.appendChild(control.el); });
        return {
            main: main,
            more: more,
            advanced: advanced,
            hasMore: controls.more.length > 0,
            sync: function (info) {
                controls.main.concat(controls.more, controls.advanced).forEach(function (control) { control.sync(info); });
            }
        };
    }

    window.VIF.chainSteps = {
        COMMON_MODEL: COMMON_MODEL,
        TASKS: TASKS,
        createStepControls: createStepControls,
        strictness: strictness,
        toPercent: toPercent,
        fromPercent: fromPercent
    };
})();
