(function () {
    window.VIF = window.VIF || {};
    var VIF = window.VIF;
    VIF.core = VIF.core || {};

    // Cache-busting version suffix (C4) - literal repo VERSION, bumped
    // automatically by the CI version-bump workflow (see
    // .github/workflows/reusable-update-version-file.yml) in the same
    // commit that bumps VERSION.
    var UI_VERSION = '1.2.0';

    // ── credential / serverUrl resolution ───────────────────────────────────
    // Consolidates the near-identical boilerplate previously duplicated at
    // the top of shm.html's inline script + shm.js's credentials line,
    // default.html's inline script, and stream-config.html's inline script
    // (untouched here - stream-config's JS extraction is a separate later
    // task, P2-T3b). All three existing copies:
    //   - rewrite the same two Docker-internal hostnames ("wse.docker",
    //     "host.docker.internal") to the browser's actual hostname,
    //   - strip a trailing slash from serverUrl,
    //   - base64-encode "<username>:<password>" for a Basic auth header.
    // They differ in two ways:
    //   1. default.html guards every global read with `typeof x !==
    //      'undefined'` (falling back to ''); shm.html/shm.js and
    //      stream-config.html assume the WSEM chrome already defined
    //      serverUrl/username/password (true per C6, but not defensive).
    //   2. shm.html and stream-config.html reassign the *global*
    //      `serverUrl` in place; default.html copies it into a page-local
    //      `_serverUrl` and never mutates the global.
    // This implementation adopts default.html's defensive `typeof` style
    // (per the plan's P2-T3 sub-step 3) and always returns a fresh object
    // rather than mutating any global - verified safe for the three pages
    // this phase touches: nothing outside a fragment's own script ever
    // reads back a bare `serverUrl`/`host`/`protocol`/`hostname` global
    // left behind by a previously-loaded fragment (each fragment re-derives
    // its own copy from window.location, and re-applying the same hostname
    // replaceAll on an already-rewritten URL is a no-op). stream-config.html
    // keeps mutating the true global for now; that copy is untouched by
    // this file and will be ported/reconciled in P2-T3b.
    VIF.core.resolveServer = function () {
        var url = new URL(window.location.href);

        var resolvedServerUrl = (typeof serverUrl !== 'undefined' ? serverUrl : '');
        resolvedServerUrl = resolvedServerUrl.replaceAll('wse.docker', url.hostname);
        resolvedServerUrl = resolvedServerUrl.replaceAll('host.docker.internal', url.hostname);
        resolvedServerUrl = resolvedServerUrl.replace(/\/+$/, ''); // remove trailing slash if there is one
        if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
            resolvedServerUrl = resolvedServerUrl.replaceAll('localhost', url.hostname);
        }
        // An https page cannot call a plain-http REST API (mixed content), so the
        // scheme follows the page. Remembered: when this rewrite happened, a failed
        // request has a known cause -- Manager itself reaches Engine over http.
        var upgradedToHttps = url.protocol === 'https:' && resolvedServerUrl.startsWith('http://');
        if (upgradedToHttps) {
            resolvedServerUrl = resolvedServerUrl.replaceAll('http://', 'https://');
        }

        var resolvedUsername = (typeof username !== 'undefined' ? username : '');
        var resolvedPassword = (typeof password !== 'undefined' ? password : '');
        var encodedCredentials = btoa(resolvedUsername + ':' + resolvedPassword);

        return {
            serverUrl: resolvedServerUrl,
            username: resolvedUsername,
            password: resolvedPassword,
            encodedCredentials: encodedCredentials,
            // Bonus fields, computed for free from the same URL parse: only
            // shm's dashboard needs these (it currently derives them itself
            // from `new URL(window.location.href)` too), default.html and
            // playback.html ignore them.
            host: url.host,
            protocol: url.protocol,
            hostname: url.hostname,
            upgradedToHttps: upgradedToHttps
        };
    };

    // ── engine reachability ─────────────────────────────────────────────────
    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function engineAuthority(resolved) {
        try {
            return new URL(resolved.serverUrl).host;
        } catch (invalid) {
            return '';
        }
    }

    // One sentence, HTML, for the dashboard's offline banner: why the Engine REST
    // API did not answer, from what the SDK error and the resolved server say. A
    // rejected fetch carries no reason in any browser (TLS, refused, DNS and a
    // dropped connection all surface as the same TypeError), so the transport
    // case is certain only when resolveServer had to upgrade the scheme; the
    // other causes are listed for the operator to check.
    VIF.core.explainEngineError = function (error, resolved) {
        var sdk = VIF.sdk;
        var isSdkError = sdk && error instanceof sdk.VifError;
        if (!isSdkError) {
            return 'Lost connection to the Engine.';
        }
        var authority = escapeHtml(engineAuthority(resolved));
        if (error instanceof sdk.TransportError) {
            if (resolved.upgradedToHttps) {
                var where = authority ? ' (' + authority + ')' : '';
                return 'This page is served over HTTPS, but Manager reaches Engine\'s REST API over plain HTTP' +
                    where + ', which the browser cannot use. See "Manager over HTTPS" in the VIF documentation.';
            }
            // An https REST API the browser does not trust fails the same way as
            // one that is down, and the browser never tells the page which.
            var certificate = String(resolved.serverUrl).startsWith('https://')
                ? 'that this browser trusts its certificate (open the address in a new tab to see), '
                : '';
            return 'Cannot reach the Engine REST API at ' + escapeHtml(resolved.serverUrl) +
                '. Check that Engine is running, that ' + (authority || 'its address') +
                ' is reachable from this browser, ' + certificate +
                'and that this address is in RESTInterface/IPWhiteList.';
        }
        if (error instanceof sdk.AuthError) {
            if (error.status === 403) {
                return 'The Engine REST API refused this browser\'s address (403): add it to RESTInterface/IPWhiteList.';
            }
            // Two 401s the browser cannot tell from bad credentials: a digest
            // challenge the page never saw (the CORS policy has to expose
            // WWW-Authenticate) and one with an algorithm this client lacks.
            return 'The Engine REST API rejected the Manager credentials (401). With digest authentication, ' +
                'the REST API\'s CORS policy also has to expose WWW-Authenticate (the installer sets it) ' +
                'and the challenge has to use MD5 or SHA-256.';
        }
        if (error.status > 0) {
            return 'The Engine REST API answered ' + error.status + '.';
        }
        return 'Lost connection to the Engine.';
    };

    // ── API client ──────────────────────────────────────────────────────────
    // The v2 client, aimed at the Engine this Manager page was served from.
    // Knowing what a WSEM chrome is, and turning it into a base URL and a
    // credential, is this file's job — the SDK takes a transport and reads no
    // globals of its own, so the dependency runs UI → SDK and only that way.
    // The transport gets the username and password, not a Basic token: it
    // answers whichever challenge the Engine's REST interface sends.
    // `options` passes through to VifClient — in practice `application`. A
    // caller wanting a different endpoint or a stub builds its own transport
    // and constructs VIF.sdk.VifClient directly; that is the whole seam.
    VIF.core.createClient = function (options) {
        var resolved = VIF.core.resolveServer();
        return new VIF.sdk.VifClient(Object.assign({
            transport: VIF.sdk.httpTransport({
                baseUrl: resolved.serverUrl,
                username: resolved.username,
                password: resolved.password
            })
        }, options || {}));
    };

    // One client per page load, built on first use: every controller on a page
    // shares the transport and the SDK's revision caches, which is what lets a
    // read on one code path hand its revision to a write on another.
    var sharedClient = null;

    VIF.core.client = function () {
        if (!sharedClient) sharedClient = VIF.core.createClient();
        return sharedClient;
    };

    // ── feature flags ────────────────────────────────────────────────────────
    // Verify ships dark: pages offer it only when the Manager container runs with
    // VIF_VERIFY_ENABLED=true, surfaced through config.json as the plugin property
    // verify_enabled. Anything else — including the unsubstituted "ENV.…" literal
    // when the variable is unset — reads as off.
    VIF.core.verifyEnabled = function () {
        var props = (typeof pluginProperties !== 'undefined' && pluginProperties) || {};
        return props.verify_enabled === 'true';
    };

    // ── conflict retry ──────────────────────────────────────────────────────
    // Runs `attempt` and, when it loses a revision race (another writer saved
    // between this page's read and its write), runs it once more. `attempt`
    // must re-read before writing - the fresh read is what picks up the new
    // revision. A second conflict propagates: two losses in a row is contention
    // the operator should see, not silently absorb.
    VIF.core.withConflictRetry = function (attempt) {
        return Promise.resolve().then(attempt).catch(function (error) {
            if (VIF.sdk && error instanceof VIF.sdk.RevisionConflictError) {
                return attempt();
            }
            throw error;
        });
    };

    // ── script loader ───────────────────────────────────────────────────────
    // Promise-returning <script> injector with de-dupe (the same normalized
    // URL loads once - later callers get the same pending/settled promise)
    // and preserved order for chained calls (script.async = false makes a
    // dynamically-created classic script execute in insertion order relative
    // to other such scripts, same as static <script> tags). Appends the
    // cache-busting `?v=<UI_VERSION>` suffix (C4) if the caller's URL didn't
    // already carry a query string.
    //
    // Contract relied on by the stream-config JS extraction (P2-T3b):
    // loadScript(url): Promise, resolves on load, rejects on error, dedupes
    // by normalized URL.
    var loadedScripts = {};

    function withVersion(url) {
        return (url.indexOf('?') === -1) ? (url + '?v=' + UI_VERSION) : url;
    }

    VIF.core.loadScript = function (url) {
        var normalizedUrl = withVersion(url);
        if (loadedScripts[normalizedUrl]) {
            return loadedScripts[normalizedUrl];
        }

        var promise = new Promise(function (resolve, reject) {
            var script = document.createElement('script');
            script.src = normalizedUrl;
            script.async = false; // preserve call order for chained loadScript() calls
            script.onload = function () {
                resolve();
            };
            script.onerror = function () {
                reject(new Error('VIF.core.loadScript: failed to load ' + normalizedUrl));
            };
            document.head.appendChild(script);
        });

        loadedScripts[normalizedUrl] = promise;
        return promise;
    };

    // The Configs tab remembers which config surface was last in use — Stream
    // Configs, Stream Config Defaults, On-Demand Configs (vod.html's settings
    // view in Configs chrome), or Secrets. The stored value is whitelisted
    // here, never loaded raw; no memory lands on Stream Configs.
    // ── header tab counts ───────────────────────────────────────────────────
    // The Live Streams and On-Demand counts every VIF page's tab rows carry: the
    // On-Demand total from the VOD jobs API, the active live streams from the status
    // wire, refreshed every 15 s. A page may carry a second tab row whose counts use
    // the same ids with a "-cfg" suffix. Failures leave the placeholders. The
    // fragments have no unload hook, so arming clears the previous page's pollers.
    VIF.core.armTabCounts = function () {
        function counters(id) {
            return [id, id + '-cfg'].map(function (x) { return document.getElementById(x); }).filter(Boolean);
        }
        var ondemand = counters('vif-tab-ondemand-count');
        var live = counters('vif-tab-live-count');
        function show(els, n) { els.forEach(function (el) { el.textContent = String(n); }); }
        function refreshOnDemand() {
            if (!ondemand.length) return;
            try {
                // A limit-1 call totals the whole listing, so the count is exact.
                VIF.core.client().vod.jobs.list({ limit: 1 }).then(function (page) {
                    show(ondemand, (page && page.total) || 0);
                }).catch(function () { /* Engine unreachable: the placeholder stays */ });
            } catch (e) { /* placeholders stay */ }
        }
        function refreshLive() {
            if (!live.length) return;
            try {
                VIF.core.client().status().then(function (status) {
                    var active = ((status && status.streams) || []).filter(function (s) {
                        return s.config && s.config.active;
                    }).length;
                    show(live, active);
                }).catch(function () {});
            } catch (e) { /* placeholders stay */ }
        }
        refreshOnDemand();
        refreshLive();
        if (window.__vifVodTabTimers) { window.__vifVodTabTimers.forEach(clearInterval); window.__vifVodTabTimers = null; }
        if (window.__vifTabCountTimers) window.__vifTabCountTimers.forEach(clearInterval);
        window.__vifTabCountTimers = [setInterval(refreshOnDemand, 15000), setInterval(refreshLive, 15000)];
    };

    VIF.core.gotoConfigs = function () {
        var page = null;
        try { page = sessionStorage.getItem('vifConfigsPage'); } catch (e) { /* non-sticky */ }
        if (page === 'settings') {
            try { sessionStorage.setItem('vifVodView', 'settings'); } catch (e) { /* best effort */ }
            loadAjaxPluginContent('server', 'vif', 'vod.html', '');
            return;
        }
        var remembered = page === 'default.html' || page === 'secrets.html';
        loadAjaxPluginContent('server', 'vif', remembered ? page : 'stream-config.html', '');
    };

    // ── toasts ───────────────────────────────────────────────────────────────
    // The one save-feedback pattern every fragment shares: a dark chip stack,
    // bottom right, auto-dismissing (4.5s; warnings 7s, errors 9s). A message
    // identical to the newest one still showing restarts that toast's clock
    // instead of stacking a twin, so repeated clicks of a Save with nothing to
    // save read as one calm chip, not a tower. containerId lets vod.html keep
    // its own #vod-toasts node (and the .vif-vod styling scoped to it);
    // everyone else gets a shared #vif-toasts appended to body on first use —
    // classed vif-plugin so the palette variables reach it there.
    VIF.core.toast = function (msg, kind, containerId) {
        var box = document.getElementById(containerId || 'vif-toasts');
        if (!box) {
            if (containerId) return;
            box = document.createElement('div');
            box.id = 'vif-toasts';
            box.className = 'vif-plugin vif-toasts';
            document.body.appendChild(box);
        }
        var cls = 'toast' + (kind === 'err' ? ' err' : kind === 'warn' ? ' warn' : '');
        var ttl = kind === 'err' ? 9000 : kind === 'warn' ? 7000 : 4500;
        var last = box.lastElementChild;
        if (last && last.className === cls && last.textContent === String(msg)) {
            clearTimeout(Number(last.dataset.vifToastTimer));
            last.dataset.vifToastTimer = String(setTimeout(function () { last.remove(); }, ttl));
            return;
        }
        var el = document.createElement('div');
        el.className = cls;
        el.textContent = msg;
        el.dataset.vifToastTimer = String(setTimeout(function () { el.remove(); }, ttl));
        box.appendChild(el);
    };

    // ── click-popover tips ───────────────────────────────────────────────────
    // Floating tip cards instead of native title tooltips: any element inside the
    // fragment root carrying data-vif-tip shows a floating card on CLICK and
    // hides on the next click (same element, elsewhere, Escape, scroll or
    // resize). Elements with class vif-help-tip that carry a native `title`
    // are upgraded automatically (title -> data-vif-tip) as they appear, so
    // the dashboard's continuously re-rendered rows keep working. One popover
    // per page; safe to call once per fragment injection.
    VIF.core.initClickTips = function (root) {
        if (!root || root.__vifTipsInit) return;
        root.__vifTipsInit = true;

        var COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
            + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            + '<rect x="9" y="9" width="13" height="13" rx="2"/>'
            + '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
        var CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
            + ' stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">'
            + '<polyline points="20 6 9 17 4 12"/></svg>';

        var pop = document.createElement('div');
        // vif-plugin scopes it into the fragment styles even though it hangs
        // off document.body (fixed positioning must escape the fragment).
        pop.className = 'vif-plugin vif-popover';
        pop.setAttribute('role', 'tooltip');
        pop.style.display = 'none';
        var popText = document.createElement('div');
        popText.className = 'vif-popover-text';
        var copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'vif-popover-copy';
        copyBtn.setAttribute('aria-label', 'Copy to clipboard');
        copyBtn.innerHTML = COPY_ICON;
        pop.appendChild(popText);
        pop.appendChild(copyBtn);
        document.body.appendChild(pop);
        var currentAnchor = null;
        var copiedTimer = null;

        function legacyCopy(text) {
            var scratch = document.createElement('textarea');
            scratch.value = text;
            scratch.style.position = 'fixed';
            scratch.style.opacity = '0';
            document.body.appendChild(scratch);
            scratch.select();
            var ok = false;
            try { ok = document.execCommand('copy'); } catch (e) { /* stays false */ }
            document.body.removeChild(scratch);
            return ok;
        }

        function flashCopied(ok) {
            if (!ok) return;
            copyBtn.innerHTML = CHECK_ICON;
            copyBtn.classList.add('is-copied');
            if (copiedTimer) clearTimeout(copiedTimer);
            copiedTimer = setTimeout(function () {
                copyBtn.innerHTML = COPY_ICON;
                copyBtn.classList.remove('is-copied');
            }, 1200);
        }

        copyBtn.addEventListener('click', function (ev) {
            // The document-level click handler must neither close the popover
            // nor re-open it for some anchor.
            ev.stopPropagation();
            var text = popText.textContent;
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(
                    function () { flashCopied(true); },
                    function () { flashCopied(legacyCopy(text)); }
                );
            } else {
                flashCopied(legacyCopy(text));
            }
        });

        function hide() {
            pop.style.display = 'none';
            currentAnchor = null;
        }

        function show(anchor, text) {
            popText.textContent = text;
            copyBtn.innerHTML = COPY_ICON;
            copyBtn.classList.remove('is-copied');
            // The copy affordance is opt-in (data-vif-tip-copy on the anchor):
            // dynamic content like a stream's raw server notice is worth
            // copying; static help text is not.
            copyBtn.style.display = anchor.hasAttribute('data-vif-tip-copy') ? '' : 'none';
            pop.style.display = 'flex';
            pop.style.visibility = 'hidden';
            pop.style.left = '0px';
            pop.style.top = '0px';
            var rect = anchor.getBoundingClientRect();
            var width = pop.offsetWidth;
            var height = pop.offsetHeight;
            var left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
            var top = rect.bottom + 8;
            if (top + height > window.innerHeight - 8) top = rect.top - height - 8;
            pop.style.left = left + 'px';
            pop.style.top = Math.max(8, top) + 'px';
            pop.style.visibility = 'visible';
            currentAnchor = anchor;
        }

        function upgrade(el) {
            el.dataset.vifTip = el.getAttribute('title');
            el.removeAttribute('title');
        }

        function upgradeAll() {
            root.querySelectorAll('.vif-help-tip[title]').forEach(upgrade);
        }
        upgradeAll();
        new MutationObserver(upgradeAll).observe(root, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['title'],
        });

        document.addEventListener('click', function (ev) {
            // Clicks inside the card (text selection, the copy button) keep it open.
            if (pop.contains(ev.target)) return;
            var anchor = ev.target && ev.target.closest
                ? ev.target.closest('[data-vif-tip]')
                : null;
            if (anchor && root.contains(anchor)) {
                ev.preventDefault();
                if (currentAnchor === anchor) {
                    hide();
                    return;
                }
                show(anchor, anchor.dataset.vifTip || '');
                return;
            }
            hide();
        });
        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape') hide();
        });
        window.addEventListener('scroll', function (ev) {
            if (!currentAnchor) return;
            // An anchor a re-render replaced is gone from the document: the card
            // is orphaned and closes on the next scroll, wherever it happened.
            if (!document.contains(currentAnchor)) { hide(); return; }
            // Only a scroll that can move the anchor closes the card. Another pane
            // scrolling — the VOD windows list under its Follow, the card's own
            // overflow — leaves an open tip where the user put it.
            var scrolled = ev.target === document ? document.documentElement : ev.target;
            if (scrolled && scrolled.contains && !scrolled.contains(currentAnchor)) return;
            hide();
        }, true);
        window.addEventListener('resize', hide);
    };

})();
