/* The global named-secrets editor — the /persist/secrets document.

   One flat namespace of names the config documents reference: endpoint keys, the service key,
   the TLS client key and VOD webhook Authorization values alike. Values are write-only: a read
   answers names, an input here is a rotation (blank keeps), and a deletion sends the name as
   null — which the server refuses, listing every use, while anything still references it. */
(function () {
    'use strict';
    window.VIF = window.VIF || {};
    VIF.secrets = VIF.secrets || {};

    VIF.secrets.init = function () {
        var client = null;
        function vif() {
            if (!client) client = VIF.core.createClient();
            return client;
        }

        var statusTimer = null;
        function showStatus(msg, isError) {
            var el = document.getElementById('secrets-status');
            if (!el) return;
            clearTimeout(statusTimer);
            el.textContent = msg;
            el.className = 'visible ' + (isError ? 'error' : 'success');
            // An error can list every use of a secret, so it stays until the next action.
            if (!isError) statusTimer = setTimeout(function () { el.classList.remove('visible'); }, 3500);
        }

        function h(tag, attrs, children) {
            var el = document.createElement(tag);
            Object.keys(attrs || {}).forEach(function (key) {
                if (key.indexOf('on') === 0) el[key] = attrs[key];
                else if (attrs[key] !== null && attrs[key] !== undefined) el.setAttribute(key, attrs[key]);
            });
            (children || []).forEach(function (child) {
                if (child === null || child === undefined) return;
                el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
            });
            return el;
        }

        // A masked value input with the Show/Hide toggle the inline credential slots have,
        // disabled while there is nothing to show.
        function valueInput(placeholder, value, onValue) {
            var toggle = h('button', { type: 'button', title: 'Show/hide value' }, ['Show']);
            var input = h('input', {
                type: 'password', autocomplete: 'new-password', style: 'flex:1;min-width:0',
                placeholder: placeholder, value: value,
                oninput: function (e) { onValue(e.target.value); syncToggle(); }
            });
            function syncToggle() {
                var empty = !input.value;
                toggle.disabled = empty;
                if (empty) { input.type = 'password'; toggle.textContent = 'Show'; }
            }
            toggle.onclick = function () {
                var hidden = input.type === 'password';
                input.type = hidden ? 'text' : 'password';
                toggle.textContent = hidden ? 'Hide' : 'Show';
            };
            syncToggle();
            return h('span', { class: 'secret-value' }, [input, toggle]);
        }

        var names = [];
        // Per-render edit state: rotations by name, removals by name, and the added rows.
        var state = { edits: {}, removed: {}, adds: [] };

        function render() {
            var root = document.getElementById('secrets-rows');
            if (!root) return;
            root.innerHTML = '';
            if (!names.length && !state.adds.length) {
                root.appendChild(h('p', { class: 'section-help' }, ['No secrets configured.']));
            }
            names.forEach(function (name) {
                var gone = !!state.removed[name];
                var row = h('div', { class: 'secret-row' }, [
                    h('span', { class: 'secret-name' + (gone ? ' secret-gone' : '') }, [name]),
                    gone ? h('span', { class: 'section-help', style: 'flex:1;margin:0' }, ['removed on save'])
                        : valueInput('(unchanged — type to rotate)', state.edits[name] || '',
                            function (value) { state.edits[name] = value; }),
                    h('button', {
                        type: 'button',
                        class: gone ? null : 'btn-danger',
                        onclick: function () {
                            state.removed[name] = !gone;
                            if (!gone) delete state.edits[name];
                            render();
                        }
                    }, [gone ? 'Keep' : 'Remove'])
                ]);
                root.appendChild(row);
            });
            state.adds.forEach(function (row, i) {
                root.appendChild(h('div', { class: 'secret-row' }, [
                    h('input', {
                        style: 'min-width:160px;max-width:160px', placeholder: 'name (A-z 0-9 . _ -)', value: row.name,
                        oninput: function (e) { row.name = e.target.value; }
                    }),
                    valueInput('value — a key, "Bearer …", or an ${ENV_VAR} placeholder', row.value,
                        function (value) { row.value = value; }),
                    h('button', { type: 'button', onclick: function () { state.adds.splice(i, 1); render(); } }, ['Discard'])
                ]));
            });
        }

        async function load() {
            try {
                names = (await vif().persist.secrets().get()).names || [];
                state = { edits: {}, removed: {}, adds: [] };
                render();
            } catch (e) {
                showStatus(e.message, true);
            }
        }

        async function save() {
            var values = {};
            Object.keys(state.removed).forEach(function (name) {
                if (state.removed[name]) values[name] = null;
            });
            for (var name in state.edits) {
                if (state.removed[name]) continue;
                if (state.edits[name].trim()) values[name] = state.edits[name].trim();
            }
            for (var i = 0; i < state.adds.length; i++) {
                var row = state.adds[i];
                var newName = row.name.trim();
                if (!newName && !row.value.trim()) continue;
                if (!newName || !row.value.trim()) { showStatus('A new secret needs both a name and a value.', true); return; }
                if (names.indexOf(newName) !== -1 || Object.prototype.hasOwnProperty.call(values, newName)) {
                    showStatus('Secret "' + newName + '" is already defined — rotate it on its own row.', true);
                    return;
                }
                values[newName] = row.value.trim();
            }
            if (!Object.keys(values).length) { showStatus('Nothing changed.'); return; }
            try {
                names = (await vif().persist.secrets().update({ values: values })).names || [];
                state = { edits: {}, removed: {}, adds: [] };
                showStatus('Secrets saved.');
                render();
            } catch (e) {
                // A refused removal is a 400 whose detail lists every use of the names,
                // across every config document, the VOD settings and unfinished jobs.
                showStatus(e.message, true);
            }
        }

        document.getElementById('secrets-add').onclick = function () {
            state.adds.push({ name: '', value: '' });
            render();
        };
        document.getElementById('secrets-save').onclick = save;
        load();
    };
})();
