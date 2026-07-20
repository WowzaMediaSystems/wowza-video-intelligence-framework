(function () {
    'use strict';

    var PLACEHOLDERS = '{class_list}, {frame_count}, {duration_seconds}';

    function vlmDefaults() {
        return (window.defaultConfig && window.defaultConfig.vlm_defaults) || null;
    }

    // A labelled, monospace, read-only block holding prompt/schema text. Uses
    // textContent (never innerHTML) so prompt text is shown verbatim, not parsed.
    function block(labelText, value) {
        var wrap = document.createElement('div');
        wrap.style.cssText = 'margin:4px 0 10px;';
        var lbl = document.createElement('div');
        lbl.style.cssText = 'font-size:0.8em; color:#555; margin-bottom:2px;';
        lbl.textContent = labelText;
        var pre = document.createElement('pre');
        pre.style.cssText = 'margin:0; padding:8px 10px; background:#f4f6f8; border:1px solid #dde3e8; '
            + 'border-radius:4px; font-size:0.85em; white-space:pre-wrap; word-break:break-word;';
        pre.textContent = value;
        wrap.appendChild(lbl);
        wrap.appendChild(pre);
        return wrap;
    }

    function prose(html) {
        var div = document.createElement('div');
        div.className = 'field-help';
        div.style.cssText = 'margin:0 0 10px; max-width:none; flex-basis:auto;';
        div.innerHTML = html;
        return div;
    }

    function heading(text) {
        var h = document.createElement('div');
        h.style.cssText = 'font-weight:600; margin:14px 0 4px; border-top:1px solid #e2e7ec; padding-top:10px;';
        h.textContent = text;
        return h;
    }

    function templateButton(label, mode) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn-secondary';
        b.textContent = label;
        b.style.cssText = 'margin:0 0 8px;';
        b.onclick = function () { useVlmPromptTemplate(mode); };
        return b;
    }

    function renderGuide() {
        var host = document.getElementById('vlm-prompt-guide');
        if (!host) return;
        host.innerHTML = '';

        var tip = document.createElement('div');
        tip.style.cssText = 'margin:0 0 12px; padding:8px 12px; background:#eef6ff; '
            + 'border:1px solid #bcdcff; border-radius:6px; font-size:0.9em; color:#1a3a5a;';
        tip.innerHTML = '💡 <strong>Tip:</strong> press a <strong>Use … defaults</strong> button below to '
            + 'load that default into the System &amp; User Prompt fields, then edit it to fit your needs.';
        host.appendChild(tip);

        host.appendChild(prose(
            'Every mode issues <strong>one VLM call per window</strong>. In Custom mode you write the '
            + 'prompts yourself. The <strong>system prompt</strong> sets the model\'s role and standing '
            + 'rules (persona, what to do / avoid); the <strong>user prompt</strong> is the per-window '
            + 'request. Placeholders <code>' + PLACEHOLDERS + '</code> are substituted in <em>both</em> '
            + 'prompts (<code>{class_list}</code> only when you set Classes).'
        ));

        host.appendChild(prose(
            '<strong>If you leave the Output Schema empty:</strong> with <em>no</em> Classes set, output is '
            + 'free-form text (delivered as a single <code>description</code>). If you <em>do</em> set Classes, '
            + 'the service automatically applies the default per-class schema below — you get structured '
            + '<code>{class_name, reasoning}</code> results even without defining a schema.'
        ));

        var d = vlmDefaults();
        if (!d) {
            host.appendChild(prose(
                '<em>Live default prompts are unavailable (the VI service could not be reached). They are '
                + 'used automatically when you leave a prompt blank; reload once the service is up to view them.</em>'
            ));
        } else {
            if (d.detect) {
                host.appendChild(heading('Detect defaults (class-aware — produce the default schema)'));
                host.appendChild(prose(
                    'Used when Classes are set and you don\'t override them. Model these to get the default '
                    + '<code>{results: [{class_name, reasoning}]}</code> output without writing a schema.'
                ));
                host.appendChild(templateButton('Use Detect defaults', 'detect'));
                if (d.detect.system_prompt) host.appendChild(block('System prompt', d.detect.system_prompt));
                if (d.detect.user_prompt) host.appendChild(block('User prompt', d.detect.user_prompt));
                if (d.detect.response_schema) {
                    host.appendChild(block('Default Output Schema', JSON.stringify(d.detect.response_schema, null, 2)));
                }
            }
            if (d.detect_low || d.detect_medium) {
                host.appendChild(heading('Detect reasoning levels (Low / Medium — you send only the level)'));
                host.appendChild(prose(
                    'Applied server-side when you pick <strong>Low</strong> or <strong>Medium</strong> in '
                    + 'Detect mode. You send only the level — the service builds these prompts plus a per-class '
                    + 'boolean schema and folds the result back into the standard <code>{class_name}</code> shape. '
                    + 'Shown for reference; they are not editable and there is no template to load.'
                ));
                if (d.detect_low) {
                    if (d.detect_low.system_prompt) host.appendChild(block('Low — System prompt', d.detect_low.system_prompt));
                    if (d.detect_low.user_prompt) host.appendChild(block('Low — User prompt', d.detect_low.user_prompt));
                }
                if (d.detect_medium) {
                    if (d.detect_medium.system_prompt) host.appendChild(block('Medium — System prompt', d.detect_medium.system_prompt));
                    if (d.detect_medium.user_prompt) host.appendChild(block('Medium — User prompt', d.detect_medium.user_prompt));
                }
            }
            if (d.describe) {
                host.appendChild(heading('Describe defaults (free-form, no schema)'));
                host.appendChild(prose('Used when no Classes and no prompts are set. Free-form prose, no structured schema.'));
                host.appendChild(templateButton('Use Describe defaults', 'describe'));
                if (d.describe.system_prompt) host.appendChild(block('System prompt', d.describe.system_prompt));
                if (d.describe.user_prompt) host.appendChild(block('User prompt', d.describe.user_prompt));
            }
        }

        host.appendChild(heading('Using your own schema'));
        host.appendChild(prose(
            'Define an Output Schema (Fields or Raw JSON) and write a user prompt that asks for exactly those '
            + 'fields — the model is constrained to your schema via guided decoding. Keep prompt and schema '
            + 'consistent: name the fields and say what each should contain.'
        ));
    }

    var escHandler = null;

    function openGuide() {
        var modal = document.getElementById('vlm-guide-modal');
        if (!modal) return;
        renderGuide(); // (re-)render on open so it reflects the latest loaded defaults
        modal.classList.add('open');
        escHandler = function (e) { if (e.key === 'Escape') closeGuide(); };
        document.addEventListener('keydown', escHandler);
    }

    function closeGuide() {
        var modal = document.getElementById('vlm-guide-modal');
        if (modal) modal.classList.remove('open');
        if (escHandler) {
            document.removeEventListener('keydown', escHandler);
            escHandler = null;
        }
    }

    function useTemplate(mode) {
        var d = vlmDefaults();
        var modeDefaults = d ? d[mode] : null;
        if (!modeDefaults) return;
        var sys = document.getElementById('cfg-vlm-system-prompt');
        var usr = document.getElementById('cfg-vlm-user-prompt');
        if (sys && modeDefaults.system_prompt) sys.value = modeDefaults.system_prompt;
        if (usr && modeDefaults.user_prompt) usr.value = modeDefaults.user_prompt;
        if (typeof updateVlmCustomLint === 'function') updateVlmCustomLint();
        if (typeof markDirty === 'function') markDirty();
        // Dismiss the guide and bring the freshly-filled prompts into view, focusing
        // the (required) user prompt so the operator can edit it immediately.
        closeGuide();
        if (sys) sys.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (usr) usr.focus({ preventScroll: true });
    }

    window.openVlmPromptGuide = openGuide;
    window.closeVlmPromptGuide = closeGuide;
    window.useVlmPromptTemplate = useTemplate;
})();
