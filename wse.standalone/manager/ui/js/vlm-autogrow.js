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
