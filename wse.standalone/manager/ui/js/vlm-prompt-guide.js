(function () {
    'use strict';

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

    function subheading(text) {
        var h = document.createElement('div');
        h.style.cssText = 'font-weight:600; font-size:0.92em; margin:12px 0 4px;';
        h.textContent = text;
        return h;
    }

    function heading(text) {
        var h = document.createElement('div');
        h.style.cssText = 'font-weight:600; margin:14px 0 4px; border-top:1px solid #e2e7ec; padding-top:10px;';
        h.textContent = text;
        return h;
    }

    /** The prompt guide mounted in `root` (the page document, or a prefixed detector-section root). */
    function guideIn(root) {
        var prefix = (root.dataset && root.dataset.vifPrefix) || '';
        var escHandler = null;
        // While open, the window sits at the page's top level: a chain step keeps its form inside
        // a collapsed section, which would hide it. `home` marks where it goes back to.
        var shownModal = null;
        var home = null;

        function el(id) {
            var lifted = root.vifLiftedInto;
            return root.querySelector('#' + CSS.escape(prefix + id)) || (lifted ? lifted.querySelector('#' + CSS.escape(prefix + id)) : null);
        }

        function templateButton(label, mode) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'btn-secondary vlm-guide-button';
            b.textContent = label;
            b.style.cssText = 'margin:0 0 8px;';
            b.onclick = function () { useTemplate(mode); };
            return b;
        }

        function renderGuide() {
            var host = el('vlm-prompt-guide');
            if (!host) return;
            host.innerHTML = '';

            host.appendChild(prose(
                'Each clip, or each box when a chain step zooms in, goes to the AI model with two texts. '
                + '<strong>Background for the model</strong> says who the model is and the rules it always follows. '
                + 'It&rsquo;s optional, and blank uses a built-in one. <strong>Your instructions</strong> say what to do '
                + 'with this clip, and are required. Both can use <code>{class_list}</code> (the list you fill in), '
                + '<code>{frame_count}</code> (how many pictures it gets) and <code>{duration_seconds}</code> '
                + '(how long the clip is).'
            ));

            host.appendChild(heading('Getting an answer a condition can use'));
            host.appendChild(prose(
                'Unless you pick an <strong>Answer format</strong>, the model answers in its own words. That reads '
                + 'well, but nothing can match on it: in a chain, a condition after this step goes on every time. Pick '
                + '<strong>Yes or no for each list item</strong> to get an answer per item in your list, or '
                + '<strong>Fields you name</strong> to choose your own. Then ask for exactly that answer in your instructions.'
            ));

            var d = vlmDefaults();
            if (!d) {
                host.appendChild(heading('Starting points'));
                host.appendChild(prose(
                    '<em>The starting points come from the analysis service, which can&rsquo;t be reached right now. '
                    + 'Reload once it&rsquo;s running to see them.</em>'
                ));
                return;
            }
            host.appendChild(heading('Starting points'));
            host.appendChild(prose(
                'Copy one into the boxes, then edit it to fit.'
            ));
            if (d.detect) {
                host.appendChild(subheading('Yes or no for each item in a list'));
                host.appendChild(prose('Also sets the Answer format to Yes or no for each list item. Fill in the list to use it.'));
                host.appendChild(templateButton('Start from this', 'detect'));
                if (d.detect.system_prompt) host.appendChild(block('Background for the model', d.detect.system_prompt));
                if (d.detect.user_prompt) host.appendChild(block('Your instructions', d.detect.user_prompt));
            }
            if (d.describe) {
                host.appendChild(subheading('A short description in its own words'));
                host.appendChild(templateButton('Start from this', 'describe'));
                if (d.describe.system_prompt) host.appendChild(block('Background for the model', d.describe.system_prompt));
                if (d.describe.user_prompt) host.appendChild(block('Your instructions', d.describe.user_prompt));
            }
        }

        function openGuide() {
            var modal = el('vlm-guide-modal');
            if (!modal) return;
            renderGuide(); // (re-)render on open so it reflects the latest loaded defaults
            var page = (root.closest && root.closest('.vif-plugin')) || document.querySelector('.vif-plugin') || document.body;
            if (modal.parentNode !== page) {
                home = document.createComment('vlm-guide-modal');
                modal.parentNode.insertBefore(home, modal);
                page.appendChild(modal);
            }
            modal.onclick = function (e) {
                if (e.target === modal || (e.target.closest && e.target.closest('.overlay-close'))) closeGuide();
            };
            shownModal = modal;
            modal.classList.add('open');
            if (escHandler) document.removeEventListener('keydown', escHandler);
            escHandler = function (e) { if (e.key === 'Escape') closeGuide(); };
            document.addEventListener('keydown', escHandler);
        }

        function closeGuide() {
            var modal = shownModal || el('vlm-guide-modal');
            if (modal) modal.classList.remove('open');
            if (modal && home && home.parentNode) home.parentNode.replaceChild(modal, home);
            home = null;
            shownModal = null;
            if (escHandler) {
                document.removeEventListener('keydown', escHandler);
                escHandler = null;
            }
        }

        function useTemplate(mode) {
            var d = vlmDefaults();
            var modeDefaults = d ? d[mode] : null;
            if (!modeDefaults) return;
            var sys = el('cfg-vlm-system-prompt');
            var usr = el('cfg-vlm-user-prompt');
            if (sys && modeDefaults.system_prompt) sys.value = modeDefaults.system_prompt;
            if (usr && modeDefaults.user_prompt) usr.value = modeDefaults.user_prompt;
            [sys, usr].forEach(function (area) {
                if (area) area.dispatchEvent(new Event('input', { bubbles: true }));
            });
            // The yes-or-no starting point asks for an answer per list item, so it brings its format.
            var kind = mode === 'detect' && el('cfg-vlm-schema-kind');
            var perItem = kind && kind.querySelector('input[value="default"]');
            if (perItem && !perItem.checked) {
                perItem.checked = true;
                perItem.dispatchEvent(new Event('change', { bubbles: true }));
            }
            // Dismiss the guide and bring the freshly-filled prompts into view, focusing
            // the (required) user prompt so the operator can edit it immediately.
            closeGuide();
            if (sys) sys.scrollIntoView({ behavior: 'smooth', block: 'center' });
            if (usr) usr.focus({ preventScroll: true });
        }

        return { open: openGuide, close: closeGuide, useTemplate: useTemplate };
    }

    var guides = new WeakMap();

    function vlmPromptGuide(root) {
        root = root || document;
        if (!guides.has(root)) guides.set(root, guideIn(root));
        return guides.get(root);
    }

    var page = vlmPromptGuide(document);

    window.vlmPromptGuide = vlmPromptGuide;
    window.openVlmPromptGuide = page.open;
    window.closeVlmPromptGuide = page.close;
    window.useVlmPromptTemplate = page.useTemplate;
})();
