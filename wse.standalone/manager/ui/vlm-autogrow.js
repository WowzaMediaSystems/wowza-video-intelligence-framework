/* VLM Custom-mode textarea auto-grow (VI-615 follow-up).
 *
 * Its own tiny module (loaded alongside vlm-schema-builder.js / vlm-prompt-guide.js
 * via the dynamic <script> injection in stream-config.html) so this behavior stays
 * out of the page. Grows the System / User prompt textareas and the Raw JSON schema
 * textarea to fit their content as the operator types, up to the CSS max-height
 * (past which they scroll). The CSS min-height holds each field's initial multi-row
 * size so an empty field never collapses to a single line.
 *
 * Files in docker/manager/ui/ are served under wse-plugins/server/vif/.
 *
 * Public surface on window:
 *   vlmAutoGrowAll() — re-fit every managed textarea that is currently visible.
 *     Called by stream-config.html (after populating / showing the Custom panel) and
 *     by vlm-schema-builder.js (when the Raw JSON panel appears), because a
 *     programmatic `.value` set fires no 'input' event.
 */
(function () {
    'use strict';

    var IDS = [
        'cfg-vlm-system-prompt',
        'cfg-vlm-user-prompt',
        'cfg-vlm-response-schema'
    ];

    // Fit one textarea to its content. Bail when hidden (offsetParent === null):
    // scrollHeight is unreliable for a display:none element, and vlmAutoGrowAll()
    // re-fits it once its panel is shown. Resetting to 'auto' before measuring lets
    // the box shrink back when text is deleted; CSS min/max-height bound the result.
    function grow(el) {
        if (!el || el.offsetParent === null) return;
        el.style.height = 'auto';
        el.style.height = el.scrollHeight + 'px';
    }

    function growAll() {
        IDS.forEach(function (id) { grow(document.getElementById(id)); });
    }

    IDS.forEach(function (id) {
        var el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', function () { grow(el); });
        }
    });

    window.vlmAutoGrowAll = growAll;
})();
