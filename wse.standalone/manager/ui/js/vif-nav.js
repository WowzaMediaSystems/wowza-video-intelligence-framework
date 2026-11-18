// The left-hand menu every VIF page carries. A page mounts it into its <nav> and says
// which entry it is; the menu navigates between fragments, keeps the Live Streams and
// On-Demand counts (by the ids VIF.core.armTabCounts refreshes), and collapses to an
// icon rail, by hand or on its own below RAIL_BELOW pixels of window width.
(function () {
    'use strict';
    window.VIF = window.VIF || {};
    var nav = window.VIF.nav = window.VIF.nav || {};

    /** Windows narrower than this start with the menu as an icon rail. */
    nav.RAIL_BELOW = 1100;
    var COLLAPSE_KEY = 'vifNavCollapsed';   // localStorage: '1' rail, '0' open, absent = decide by width
    var CONFIGS_KEY = 'vifNavConfigsOpen';  // sessionStorage: '1' / '0', absent = open when a config page is showing

    nav.ITEMS = [
        { key: 'live', label: 'Live Streams', icon: 'fa-video-camera', page: 'shm.html', countId: 'vif-tab-live-count' },
        { key: 'ondemand', label: 'On-Demand', icon: 'fa-film', page: 'vod.html', countId: 'vif-tab-ondemand-count' },
        { key: 'configs', label: 'Configs', icon: 'fa-sliders', children: [
            { key: 'stream-config', label: 'Stream Configs', icon: 'fa-list-ul', page: 'stream-config.html',
                tip: 'Per-stream detector configs. Streams match by name pattern.' },
            { key: 'defaults', label: 'Stream Config Defaults', icon: 'fa-clone', page: 'default.html',
                tip: 'Defaults every stream config inherits. A config that sets its own value pins it.' },
            { key: 'ondemand-settings', label: 'On-Demand Configs', icon: 'fa-wrench', page: 'vod.html', view: 'settings',
                tip: 'On-Demand job settings: caps, retention, lifecycle webhooks.' },
            { key: 'secrets', label: 'Secrets', icon: 'fa-key', page: 'secrets.html',
                tip: 'Stored credentials the configs reference by name: endpoint keys, the service key, webhook secrets.' }
        ] }
    ];

    nav.find = function (key) {
        var hit = null;
        nav.ITEMS.forEach(function (item) {
            if (item.key === key) hit = item;
            (item.children || []).forEach(function (child) { if (child.key === key) hit = child; });
        });
        return hit;
    };

    /** The group an entry sits under, or null for a top-level one. */
    nav.parentOf = function (key) {
        var parent = null;
        nav.ITEMS.forEach(function (item) {
            (item.children || []).forEach(function (child) { if (child.key === key) parent = item.key; });
        });
        return parent;
    };

    /** Whether the menu shows as a rail: the saved choice wins, else the window width decides. */
    nav.collapsed = function (width, choice) {
        if (choice === '1') return true;
        if (choice === '0') return false;
        return width < nav.RAIL_BELOW;
    };

    /** Whether the Configs group is open: the saved choice wins, else open while a config page shows. */
    nav.configsOpen = function (active, choice) {
        if (choice === '1') return true;
        if (choice === '0') return false;
        return nav.parentOf(active) === 'configs';
    };

    /**
     * What a page leaving through the menu records for the next one: Live Streams is an
     * explicit choice (so shm.html's sticky-tab redirect stays put), and On-Demand Configs
     * asks vod.html to open on its settings view.
     */
    nav.leaveFlags = function (item) {
        var flags = {};
        if (item.key === 'live') flags.vifNavExplicit = '1';
        if (item.view === 'settings') flags.vifVodView = 'settings';
        return flags;
    };

    function read(store, key) {
        try { return window[store].getItem(key); } catch (e) { return null; }
    }
    function write(store, key, value) {
        try {
            if (value === null) window[store].removeItem(key);
            else window[store].setItem(key, value);
        } catch (e) { /* non-sticky */ }
    }

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
    }
    function icon(name) {
        var i = el('i', 'fa ' + name);
        i.setAttribute('aria-hidden', 'true');
        return i;
    }

    var state = null;

    function go(item) {
        if (!state || item.key === state.active) return;
        if (state.onSelect && state.onSelect(item) === true) return;
        if (state.beforeLeave) {
            try { state.beforeLeave(); } catch (e) { /* the page is going away regardless */ }
        }
        var flags = nav.leaveFlags(item);
        Object.keys(flags).forEach(function (key) { write('sessionStorage', key, flags[key]); });
        if (typeof window.loadAjaxPluginContent === 'function') window.loadAjaxPluginContent('server', 'vif', item.page, '');
    }

    function entry(item, depth) {
        var button = el('button', 'vif-nav-item' + (depth ? ' vif-nav-child' : ''));
        button.type = 'button';
        button.dataset.key = item.key;
        button.appendChild(icon(item.icon));
        button.appendChild(el('span', 'vif-nav-label', item.label));
        if (item.countId) {
            var count = el('span', 'vif-nav-count', '–');
            count.id = item.countId;
            button.appendChild(count);
        }
        button.addEventListener('click', function () { go(item); });
        return button;
    }

    function group(item) {
        var wrap = el('div', 'vif-nav-group');
        wrap.dataset.key = item.key;
        var head = el('button', 'vif-nav-item vif-nav-group-head');
        head.type = 'button';
        head.appendChild(icon(item.icon));
        head.appendChild(el('span', 'vif-nav-label', item.label));
        head.appendChild(icon('fa-angle-down vif-nav-chevron'));
        head.addEventListener('click', function () {
            var open = nav.configsOpen(state.active, read('sessionStorage', CONFIGS_KEY));
            write('sessionStorage', CONFIGS_KEY, open ? '0' : '1');
            apply();
        });
        var children = el('div', 'vif-nav-children');
        item.children.forEach(function (child) { children.appendChild(entry(child, 1)); });
        wrap.appendChild(head);
        wrap.appendChild(children);
        return wrap;
    }

    function build(host) {
        host.replaceChildren();
        var inner = el('div', 'vif-sidenav-inner');
        var list = el('div', 'vif-nav-list');
        nav.ITEMS.forEach(function (item) { list.appendChild(item.children ? group(item) : entry(item, 0)); });
        inner.appendChild(list);
        var toggle = el('button', 'vif-nav-toggle');
        toggle.type = 'button';
        toggle.appendChild(icon('fa-angle-double-left'));
        toggle.appendChild(el('span', 'vif-nav-label', 'Collapse menu'));
        toggle.addEventListener('click', function () {
            var rail = nav.collapsed(window.innerWidth, read('localStorage', COLLAPSE_KEY));
            write('localStorage', COLLAPSE_KEY, rail ? '0' : '1');
            apply();
        });
        inner.appendChild(toggle);
        host.appendChild(inner);
    }

    /** Puts the current state on the built menu: which entry is lit, rail or open, group open or shut. */
    function apply() {
        if (!state || !state.host.isConnected) return;
        var rail = nav.collapsed(window.innerWidth, read('localStorage', COLLAPSE_KEY));
        var open = nav.configsOpen(state.active, read('sessionStorage', CONFIGS_KEY));
        var parent = nav.parentOf(state.active);
        if (state.shell) state.shell.classList.toggle('is-rail', rail);
        Array.prototype.forEach.call(state.host.querySelectorAll('.vif-nav-item[data-key]'), function (button) {
            var item = nav.find(button.dataset.key);
            var active = button.dataset.key === state.active;
            button.classList.toggle('is-active', active);
            if (active) button.setAttribute('aria-current', 'page');
            else button.removeAttribute('aria-current');
            button.title = rail ? item.label : (item.tip || '');
        });
        Array.prototype.forEach.call(state.host.querySelectorAll('.vif-nav-group'), function (wrap) {
            var head = wrap.querySelector('.vif-nav-group-head');
            wrap.classList.toggle('is-open', open);
            wrap.classList.toggle('has-active', parent === wrap.dataset.key);
            head.setAttribute('aria-expanded', open ? 'true' : 'false');
            head.title = rail ? nav.find(wrap.dataset.key).label : '';
        });
        var toggle = state.host.querySelector('.vif-nav-toggle');
        toggle.querySelector('.fa').className = 'fa ' + (rail ? 'fa-angle-double-right' : 'fa-angle-double-left');
        toggle.querySelector('.vif-nav-label').textContent = rail ? 'Expand menu' : 'Collapse menu';
        toggle.title = rail ? 'Expand menu' : 'Collapse menu';
    }

    // One width watcher for the lifetime of the Manager page: fragments come and go, so
    // it looks up the current mount each time. Crossing the rail width forgets a hand
    // choice, so the size rule decides again.
    var media = null;
    function watchWidth() {
        if (media || !window.matchMedia) return;
        media = window.matchMedia('(max-width: ' + (nav.RAIL_BELOW - 1) + 'px)');
        var onChange = function () { write('localStorage', COLLAPSE_KEY, null); apply(); };
        if (media.addEventListener) media.addEventListener('change', onChange);
        else if (media.addListener) media.addListener(onChange);
    }

    /**
     * Builds the menu into host (the page's <nav>). opts.active names this page's entry
     * (null for a page off the menu, such as playback); opts.onSelect(item) may handle a
     * pick in place and return true; opts.beforeLeave runs before another fragment loads.
     */
    nav.mount = function (host, opts) {
        opts = opts || {};
        state = {
            host: host,
            shell: host.closest ? host.closest('.vif-shell') : null,
            active: opts.active || null,
            onSelect: opts.onSelect || null,
            beforeLeave: opts.beforeLeave || null
        };
        build(host);
        apply();
        watchWidth();
    };

    /** Lights another entry without rebuilding (a page that switches views in place). */
    nav.setActive = function (key) {
        if (!state) return;
        state.active = key || null;
        apply();
    };
})();
