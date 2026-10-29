(function () {
    'use strict';

    var IDS = [
        'cfg-vlm-system-prompt',
        'cfg-vlm-user-prompt',
        'cfg-vlm-response-schema'
    ];

    var SELECTOR = IDS.map(function (id) {
        return 'textarea[id="' + id + '"], textarea[id$="-' + id + '"]';
    }).join(', ');

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
        Array.prototype.forEach.call(document.querySelectorAll(SELECTOR), grow);
    }

    if (!window.vlmAutoGrowAll) {
        document.addEventListener('input', function (event) {
            var target = event.target;
            if (target && target.matches && target.matches(SELECTOR)) grow(target);
        });
    }

    window.vlmAutoGrowAll = growAll;
})();
