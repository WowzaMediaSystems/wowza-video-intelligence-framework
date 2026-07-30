(function () {
    window.VIF = window.VIF || {};
    var VIF = window.VIF;
    VIF.core = VIF.core || {};

    // Cache-busting version suffix (C4) - literal repo VERSION, bumped
    // automatically by the CI version-bump workflow (see
    // .github/workflows/reusable-update-version-file.yml) in the same
    // commit that bumps VERSION.
    var UI_VERSION = '1.0.1';

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
		if(url.protocol === 'https:') {
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
            hostname: url.hostname
        };
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

})();
