// VIF API v2 browser SDK. Mirrors api/openapi.yaml, which is organized by
// intent: /runtime is the running world (writes are ephemeral and lost on
// restart; 404 means "not running"), /persist the durable one (stream group configs
// and per-stream overrides; writes save to disk AND apply to the running
// streams they govern), /vod the on-demand one (the files under the Engine's
// content directory and the jobs that analyze them). Configs layer as
// default config < matching stream group config < persisted override < runtime
// changes.
//
// Every document carries its settings in one member, `config` — a stream group
// config is a match rule plus a config, an override is a sparse config, a
// running stream reports the config it resolved to. The config is what the
// layers merge.
//
// Two layers: a flat operation client (VIF.sdk.RawClient, one method per
// operationId, plus three URL builders — thumbnailUrl and vodJobThumbnailUrl
// for <img src>, vodFileUploadUrl for an upload the page drives itself — the
// only non-operation methods) and an OOP facade (VIF.sdk.VifClient) whose
// namespaces mirror the spec tags: vif.status() / vif.models(),
// vif.runtime.streams, vif.persist.streamGroupConfigs, vif.persist.streams,
// vif.persist.vodSettings(), vif.persist.secrets(), vif.probes, vif.vod.files,
// vif.vod.jobs.
//
// Underneath both sits a third file the pages load first, js/vif-api.js: the
// client openapi-generator produces from api/openapi.yaml, published as VIF.api
// (see api/sdk/generate.sh). Paths, verbs, query parameter names and content
// types come from there and are not written here. What stays here is everything
// the spec does not say: dirty tracking, the atomic-key rules, the revision
// ledger, the typed errors, the guards, and the facade. The camel↔snake boundary
// is not one of them: each schema's generated FromJSON/ToJSON pair names the
// fields the spec declares, and the operations serialize through them. A member
// the spec grew and the client never learned therefore does not reach a document
// — which is what makes the drift detectable at all. toWire/fromWire stay
// exported as the generic conversion a caller may still want; nothing here
// routes a document through them.
//
// Facade conventions:
// - In the persist world a GET answered 404 resolves to null — an absent
//   document just means "inherits from the layer below". Runtime GETs throw
//   NotFoundError ("not running").
// - Both worlds share the tracked get→edit→save cycle, the recommended way
//   to write: get()/list()/default() return tracked models, save() sends a
//   JSON Merge Patch of exactly the touched fields, and If-Match quotes the
//   revision the object was loaded at, never `*` (the API rejects it with
//   412). StreamGroupConfig and StreamConfigOverride documents carry their etag, so
//   one adopted from list() saves without a refetch. The procedural verbs
//   (update(patch)/create()) remain as a thin layer over the same operations.
// - Verb policy: create() POSTs a new resource (409 on a taken identity is
//   AlreadyExistsError), tracked save() and update() PATCH an existing one,
//   delete() removes. PUT does not exist in this API — save() is a PATCH
//   always, everywhere. Action endpoints POST too: stream.reset() discards
//   the ephemeral changes and rehydrates the model from the response (no
//   follow-up GET), vif.probes.* check connectivity.
// - Detectors: config.detector.type rides in the PATCH like any field; the
//   server replaces the whole detector section when it changes (a new
//   discriminator means a new object). The VLM detector names its analysis family in an explicit
//   mode field (detect | describe | custom) with per-mode blocks — detect
//   {classes, classHints, reasoningLevel (a built-in prompt preset VIS
//   applies server-side)} and custom {prompt, responseSchema} — so switching
//   mode is a normal patch and nothing is inferred from field presence.
// - In-place array mutation on a tracked model
//   (config.detector.classes.push(...)) is tracked too: it dirties the array's
//   own path, and the patch replaces the whole array (JSON Merge Patch cannot
//   address elements).
// - Listeners layer per entry, by name: a document that declares listener X
//   owns that whole entry, entries it does not name pass through from the layer
//   below, and assigning null to one removes it at that layer.
// - Assigning null to a tracked persist field patches it to null, which
//   unsets the member — the document inherits it from the layer below again.
// - An absent override is null, and null is not editable: create one with
//   vif.persist.streams.create(app?, name, doc) — 409 when it already exists
//   — which also returns a tracked model.
// - A running stream's aspects are subresources, so they stay on the ref
//   rather than on the model: stream.detector and stream.listeners are handles
//   with their own revisions, and stream.config carries the members this
//   resource patches (active, processing, service, diagnostics).
// - App-scoped facade calls resolve their application by arity: the long form
//   names it explicitly, the short form omits it and uses the client's
//   default ({ application } at construction, or a vif.for(app) view; without
//   one the short form throws). The default scopes ADDRESSING only — it fills
//   the {app} path segment, and is NEVER applied as a filter:
//   vif.runtime.streams.list() and vif.persist.streamGroupConfigs.list() stay
//   fleet-wide unless an application filter is passed explicitly.
//
// Classic script, no build step (see MANAGER-UI-REVAMP-PLAN.md C1-C4): the
// module publishes VIF.sdk on the global object, speaks no DOM, and reads no
// global other than the one it publishes into — VIF.api, the generated
// operations, is the one thing it reads from there, and it reads it on the first
// request rather than at load. A caller supplies the base URL and credentials, or
// a transport of its own. Resolving those from a host page belongs to that host
// page (VIF.core.createClient in vif-core.js).
(function () {
    var root = globalThis;
    root.VIF = root.VIF || {};
    var VIF = root.VIF;

    var BASE_PATH = '/v2/vif';

    // ── wire naming ─────────────────────────────────────────────────────────
    // The wire is snake_case, the facade camelCase. Values under these keys have
    // meaningful key spelling of their own (JSON Schemas, per-class maps, listener
    // property bags, VIS-owned defaults, the analysis service's stored result
    // rows), so they cross the boundary verbatim.
    //
    // The same fact has a second consequence, and it is the reason `buildPatch`
    // reads this table too: a member whose keys are the writer's is a member a
    // merge patch cannot prune. An absent key means "leave it alone", so dropping
    // a class from `class_hints` would send a map without it and the server would
    // keep it. See `withDeletions`.
    var OPAQUE_KEYS = {
        response_schema: 1, responseSchema: 1,
        class_hints: 1, classHints: 1,
        class_sensitivity: 1, classSensitivity: 1,
        properties: 1,
        concurrent_executions: 1, concurrentExecutions: 1,
        vlm_defaults: 1, vlmDefaults: 1,
        results: 1,
        values: 1
    };
    // Maps whose KEYS are operator data — listener names — but whose values are
    // models to convert.
    var NAME_KEYED_KEYS = { listeners: 1 };

    function toCamel(key) {
        return key.replace(/_([a-z0-9])/g, function (_, c) { return c.toUpperCase(); });
    }

    function toSnake(key) {
        return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    }

    function convert(value, keyFn) {
        if (Array.isArray(value)) {
            return value.map(function (item) { return convert(item, keyFn); });
        }
        if (!value || typeof value !== 'object' || value instanceof Date) return value;
        var out = {};
        Object.keys(value).forEach(function (key) {
            if (key.indexOf('__') === 0) return;
            if (OPAQUE_KEYS[key]) {
                out[keyFn(key)] = value[key];
                return;
            }
            if (NAME_KEYED_KEYS[key]) {
                var map = value[key];
                if (!map || typeof map !== 'object' || Array.isArray(map)) {
                    out[keyFn(key)] = map;
                    return;
                }
                var converted = {};
                Object.keys(map).forEach(function (name) {
                    converted[name] = convert(map[name], keyFn);
                });
                out[keyFn(key)] = converted;
                return;
            }
            out[keyFn(key)] = convert(value[key], keyFn);
        });
        return out;
    }

    function toWire(value) { return convert(value, toSnake); }
    function fromWire(value) { return convert(value, toCamel); }

    // ── errors ──────────────────────────────────────────────────────────────
    function VifError(message, status, problem) {
        var error = Error.call(this, message);
        this.name = 'VifError';
        this.message = message;
        this.stack = error.stack;
        this.status = status || 0;
        this.problem = problem || null;
    }
    VifError.prototype = Object.create(Error.prototype);
    VifError.prototype.constructor = VifError;

    function subclassError(name) {
        function Sub(message, status, problem) {
            VifError.call(this, message, status, problem);
            this.name = name;
        }
        Sub.prototype = Object.create(VifError.prototype);
        Sub.prototype.constructor = Sub;
        return Sub;
    }

    var NotFoundError = subclassError('NotFoundError');
    var ConflictError = subclassError('ConflictError');
    function AlreadyExistsError(message, status, problem) {
        ConflictError.call(this, message, status, problem);
        this.name = 'AlreadyExistsError';
    }
    AlreadyExistsError.prototype = Object.create(ConflictError.prototype);
    AlreadyExistsError.prototype.constructor = AlreadyExistsError;
    var RevisionConflictError = subclassError('RevisionConflictError');
    var PreconditionRequiredError = subclassError('PreconditionRequiredError');
    var AuthError = subclassError('AuthError');
    var LicenseError = subclassError('LicenseError');
    var TransportError = subclassError('TransportError');
    // A v2 route the running VIC jar does not serve yet. The Engine's router
    // answers an unmatched path with its own {success, code, message} envelope
    // instead of application/problem+json, which is what tells the two apart.
    var RouteUnavailableError = subclassError('RouteUnavailableError');

    function errorFor(status, body, contentType, fallbackMessage) {
        var problem = (body && typeof body === 'object') ? body : null;
        var engineEnvelope = !!(problem && problem.success === false && problem.title === undefined);
        var detail = problem && (problem.detail || problem.title || problem.message);
        var message = detail || fallbackMessage || ('HTTP ' + status);
        if (status === 404 && (engineEnvelope || contentType.indexOf('problem+json') === -1)) {
            return new RouteUnavailableError(
                'This build of the Video Intelligence Controller does not serve ' + message, status, problem);
        }
        if (status === 404) return new NotFoundError(message, status, problem);
        if (status === 401 || status === 403) return new AuthError(message, status, problem);
        if (status === 402) return new LicenseError(message, status, problem);
        if (status === 409) return new ConflictError(message, status, problem);
        if (status === 412) return new RevisionConflictError(message, status, problem);
        if (status === 428) return new PreconditionRequiredError(message, status, problem);
        return new VifError(message, status, problem);
    }

    // ── transport ───────────────────────────────────────────────────────────
    // Resolves to {status, etag, body}; body is parsed JSON, a Blob when the
    // request accepted a non-JSON type (an image, the ndjson results file), or
    // null for 204. Rejects only on a network-level failure. The transport
    // also exposes url(path, query), which the URL builders use to mint an
    // <img src> or an upload target against the same base (credentials ride on
    // the browser's own Engine session there, not on a header), and
    // upload(path, query, body, contentType, onProgress): the same POST fetch
    // would send, over XMLHttpRequest because fetch reports no upload progress.
    function isBinary(value) {
        return (typeof Blob !== 'undefined' && value instanceof Blob)
            || (typeof ArrayBuffer !== 'undefined'
                && (value instanceof ArrayBuffer || ArrayBuffer.isView(value)));
    }

    // application/json and the +json structured syntaxes; application/x-ndjson
    // is a stream of documents, not one, and is read as bytes.
    function isJsonType(mediaType) {
        return /[\/+]json\b/.test(mediaType);
    }

    function parseBody(contentType, text) {
        if (isJsonType(contentType)) {
            try { return JSON.parse(text); } catch (e) { return null; }
        }
        return text ? { message: text } : null;
    }

    function httpTransport(options) {
        var baseUrl = String(options.baseUrl || '').replace(/\/+$/, '') + BASE_PATH;
        var authorization = options.encodedCredentials
            ? 'Basic ' + options.encodedCredentials
            : (options.username !== undefined
                ? 'Basic ' + btoa((options.username || '') + ':' + (options.password || ''))
                : null);

        var transport = async function (request) {
            var url = transport.url(request.path, request.query);

            var headers = {};
            if (authorization) headers['Authorization'] = authorization;
            if (request.accept) headers['Accept'] = request.accept;
            if (request.contentType) headers['Content-Type'] = request.contentType;
            if (request.ifMatch) headers['If-Match'] = request.ifMatch;

            var response;
            try {
                response = await fetch(url, {
                    method: request.method,
                    headers: headers,
                    body: request.body === undefined || isBinary(request.body)
                        ? request.body : JSON.stringify(request.body)
                });
            } catch (networkError) {
                throw new TransportError('Cannot reach the Engine REST API: ' + networkError.message, 0, null);
            }

            var contentType = response.headers.get('content-type') || '';
            var body = null;
            if (response.status !== 204) {
                if (response.ok && request.accept && !isJsonType(request.accept)) {
                    body = await response.blob();
                } else {
                    body = parseBody(contentType, await response.text());
                }
            }

            if (!response.ok) {
                throw errorFor(response.status, body, contentType, response.statusText);
            }
            return { status: response.status, etag: response.headers.get('ETag'), body: body };
        };

        transport.url = function (path, query) {
            var queryString = buildQuery(query);
            return baseUrl + path + (queryString ? '?' + queryString : '');
        };

        transport.upload = async function (path, query, body, contentType, onProgress) {
            if (typeof XMLHttpRequest === 'undefined') {
                throw new VifError('Uploads with progress need a browser: there is no XMLHttpRequest here', 0, null);
            }
            return new Promise(function (resolve, reject) {
                var xhr = new XMLHttpRequest();
                xhr.open('POST', transport.url(path, query));
                if (authorization) xhr.setRequestHeader('Authorization', authorization);
                xhr.setRequestHeader('Content-Type', contentType);
                xhr.upload.onprogress = function (event) { onProgress(event.loaded, event.total); };
                xhr.onerror = function () {
                    reject(new TransportError('Cannot reach the Engine REST API: the upload failed', 0, null));
                };
                xhr.onload = function () {
                    var responseType = xhr.getResponseHeader('Content-Type') || '';
                    var answer = xhr.status === 204 ? null : parseBody(responseType, xhr.responseText);
                    if (xhr.status < 200 || xhr.status >= 300) {
                        reject(errorFor(xhr.status, answer, responseType, xhr.statusText));
                        return;
                    }
                    resolve({ status: xhr.status, etag: xhr.getResponseHeader('ETag'), body: answer });
                };
                xhr.send(body);
            });
        };

        return transport;
    }

    function buildQuery(query) {
        if (!query) return '';
        return Object.keys(query)
            .filter(function (key) { return query[key] !== undefined && query[key] !== null && query[key] !== ''; })
            .map(function (key) { return encodeURIComponent(key) + '=' + encodeURIComponent(query[key]); })
            .join('&');
    }

    // ── raw operation client ────────────────────────────────────────────────
    // One method per operationId in api/openapi.yaml (plus the three URL builders).
    // Arguments and results are camelCase; the snake_case wire conversion
    // happens here. The application is always explicit at this layer — the
    // facade's application default never reaches it.
    //
    // Paths, verbs, query parameters and content types are not spelled out here:
    // they come from the spec through vif-api.js, whose methods are named for
    // the operationIds. What stays is this layer's own contract — camelCase in
    // and out, {data, etag} wherever a revision matters — and the seam below.
    function RawClient(transport) {
        this.transport = transport;
        // Built on first use, not at construction: VIF.api has to be there before
        // a request goes out, which is not the same as before this file loads.
        var apis = null;
        Object.defineProperty(this, '__api', {
            get: function () {
                if (!apis) apis = generatedApis(transport);
                return apis;
            }
        });
    }

    function generatedApis(transport) {
        if (!VIF.api) {
            throw new VifError('vif-api.js is not loaded: it carries the generated operations, '
                + 'and the page has to load it alongside this file.', 0, null);
        }
        // An empty basePath leaves the transport owning the origin and the
        // /v2/vif prefix, so paths reach it exactly as the spec spells them. No
        // credentials: the generated Authorization branch is dead unless a
        // username is configured, and credentials belong to the transport.
        var configuration = new VIF.api.Configuration({
            basePath: '',
            fetchApi: transportFetch(transport)
        });
        return {
            persist: new VIF.api.PersistApi(configuration),
            probes: new VIF.api.ProbesApi(configuration),
            runtime: new VIF.api.RuntimeApi(configuration),
            server: new VIF.api.ServerApi(configuration),
            vod: new VIF.api.VodApi(configuration)
        };
    }

    // The generated client speaks fetch(url, init); a transport speaks request
    // objects. This is the whole translation, and it is the only place that
    // knows both vocabularies.
    function transportFetch(transport) {
        return async function (url, init) {
            var split = url.indexOf('?');
            var query = {};
            if (split !== -1) {
                new URLSearchParams(url.slice(split + 1)).forEach(function (value, key) {
                    query[key] = value;
                });
            }
            var headers = init.headers || {};
            var result = await transport({
                method: init.method,
                path: split === -1 ? url : url.slice(0, split),
                query: query,
                // The generated client stringifies a JSON body before handing it
                // over; the transport contract carries the document. A file body
                // arrives as the bytes it was given.
                body: (init.body === undefined || init.body === null) ? undefined
                    : (typeof init.body === 'string' ? JSON.parse(init.body) : init.body),
                contentType: headers['Content-Type'],
                accept: headers['Accept'],
                ifMatch: headers['If-Match']
            });
            return asResponse(result);
        };
    }

    // Enough of a Response for the generated result wrappers: a status to check,
    // the revision, and one payload however it is asked for.
    function asResponse(result) {
        var payload = result.body === undefined ? null : result.body;
        return {
            status: result.status,
            headers: {
                get: function (name) {
                    return String(name).toLowerCase() === 'etag' ? (result.etag || null) : null;
                }
            },
            json: function () { return Promise.resolve(payload); },
            text: function () { return Promise.resolve(payload === null ? '' : String(payload)); },
            blob: function () { return Promise.resolve(payload); }
        };
    }

    // The generated runtime wraps whatever its fetch threw. The transport already
    // rejected with one of the SDK's error classes, and that is what every caller
    // branches on, so it has to come back out.
    async function called(operation) {
        try {
            return await operation;
        } catch (error) {
            if (error && error.cause instanceof VifError) throw error.cause;
            throw error;
        }
    }

    // A detector and a listener are discriminated: their converters dispatch on
    // `type`, so a body without one has no subtype to convert as and its fields
    // would be dropped on the way out. The tracked path stamps it from the model
    // (see stampDiscriminators); a procedural caller has to carry it, and the
    // server merges rather than replacing when the type does not move.
    function discriminated(payload, what) {
        if (payload && !payload.type) {
            throw new VifError(
                'A ' + what + ' write has to say which ' + what + " it is: carry `type` in the body, "
                + 'unchanged if the write is not switching subtype.', 0, null);
        }
        return payload;
    }

    // A revisioned read or write: the document, plus the revision the next write
    // has to be based on.
    async function revisioned(operation) {
        var answer = await called(operation);
        return { data: await answer.value(), etag: answer.raw.headers.get('ETag') };
    }

    // A response that carries no revision of its own.
    async function document(operation) {
        return (await called(operation)).value();
    }

    async function listed(operation) {
        return (await (await called(operation)).value()) || [];
    }

    function runtimePath(app, stream, suffix) {
        return '/runtime/apps/' + encodeURIComponent(app) + '/streams/' + encodeURIComponent(stream) + (suffix || '');
    }

    function thumbnailQuery(params) {
        params = params || {};
        return {
            width: params.width,
            height: params.height,
            fit: params.fit,
            format: params.format,
            frame_id: params.frameId,
            overlay: params.overlay === undefined ? undefined : String(params.overlay)
        };
    }

    // If-Match carries the revision a write is based on. There is no `*`
    // fallback: the API rejects "any revision" with 412 because it defeats the
    // concurrency check. A write that CREATES a resource has no revision, and
    // the API accepts the header's absence for exactly that.
    function requireEtag(etag, what) {
        if (!etag) {
            throw new VifError(
                'No revision for ' + what + '. Read it through the SDK first: a write has to say '
                + 'which revision it is based on.', 0, null);
        }
        return etag;
    }

    // Name-keyed collection responses: the generated client maps the values and
    // leaves the names alone, so an absent body is all that is left to handle.
    async function nameKeyed(operation) {
        return (await (await called(operation)).value()) || {};
    }

    RawClient.prototype = {
        async getServerStatus() {
            return document(this.__api.server.getServerStatusRaw());
        },

        async getModelCatalog() {
            return document(this.__api.server.getModelCatalogRaw());
        },

        async listListenerTypes() {
            return listed(this.__api.server.listListenerTypesRaw());
        },

        async listRuntimeStreams(filters) {
            filters = filters || {};
            return listed(this.__api.runtime.listRuntimeStreamsRaw({
                application: filters.application,
                detector: filters.detector,
                active: filters.active
            }));
        },

        async getRuntimeStream(app, stream) {
            return revisioned(this.__api.runtime.getRuntimeStreamRaw({ app: app, stream: stream }));
        },

        async updateRuntimeStream(app, stream, settings, etag) {
            return revisioned(this.__api.runtime.updateRuntimeStreamRaw({
                app: app, stream: stream, ifMatch: etag, streamSettings: settings
            }));
        },

        async resetRuntimeStream(app, stream) {
            return revisioned(this.__api.runtime.resetRuntimeStreamRaw({ app: app, stream: stream }));
        },

        async getRuntimeDetector(app, stream) {
            return revisioned(this.__api.runtime.getRuntimeDetectorRaw({ app: app, stream: stream }));
        },

        async updateRuntimeDetector(app, stream, patch, etag) {
            return revisioned(this.__api.runtime.updateRuntimeDetectorRaw({
                app: app, stream: stream, ifMatch: etag, detector: discriminated(patch, 'detector')
            }));
        },

        async listRuntimeListeners(app, stream) {
            return nameKeyed(this.__api.runtime.listRuntimeListenersRaw({ app: app, stream: stream }));
        },

        async getRuntimeListener(app, stream, name) {
            return revisioned(this.__api.runtime.getRuntimeListenerRaw({
                app: app, stream: stream, name: name
            }));
        },

        async createRuntimeListener(app, stream, listener) {
            return revisioned(this.__api.runtime.createRuntimeListenerRaw({
                app: app, stream: stream, listener: discriminated(listener, 'listener')
            }));
        },

        async updateRuntimeListener(app, stream, name, patch, etag) {
            return revisioned(this.__api.runtime.updateRuntimeListenerRaw({
                app: app, stream: stream, name: name, ifMatch: etag, listener: discriminated(patch, 'listener')
            }));
        },

        async deleteRuntimeListener(app, stream, name, etag) {
            await called(this.__api.runtime.deleteRuntimeListenerRaw({
                app: app, stream: stream, name: name, ifMatch: etag
            }));
        },

        // Returns a Blob; the caller owns the object URL. The spec declares
        // image/png and image/jpeg on this operation but the generated client
        // sends no Accept, and Accept is what tells a transport to read the body
        // as an image rather than as JSON.
        async getThumbnail(app, stream, params) {
            params = params || {};
            var answer = await called(this.__api.runtime.getThumbnailRaw({
                app: app, stream: stream,
                width: params.width, height: params.height,
                fit: params.fit, format: params.format,
                frameId: params.frameId, overlay: params.overlay
            }, { headers: { Accept: params.format === 'jpg' ? 'image/jpeg' : 'image/png' } }));
            return answer.value();
        },

        // Not an operation: the getThumbnail URL, for <img src>. It is synchronous,
        // and the generated client only knows its own URL inside an async request,
        // so this, vodJobThumbnailUrl and vodFileUploadUrl are the three paths the
        // SDK still spells out.
        thumbnailUrl(app, stream, params) {
            if (!this.transport.url) {
                throw new VifError('This transport does not expose url(); cannot build a thumbnail URL', 0, null);
            }
            return this.transport.url(runtimePath(app, stream, '/thumbnail'), thumbnailQuery(params));
        },

        async listStreamGroupConfigs(filters) {
            filters = filters || {};
            return listed(this.__api.persist.listStreamGroupConfigsRaw({
                application: filters.application
            }));
        },

        async createStreamGroupConfig(config) {
            return revisioned(this.__api.persist.createStreamGroupConfigRaw({
                streamGroupConfig: config
            }));
        },

        async getDefaultConfig() {
            return revisioned(this.__api.persist.getDefaultConfigRaw());
        },

        async updateDefaultConfig(patch, etag) {
            return revisioned(this.__api.persist.updateDefaultConfigRaw({
                ifMatch: etag, defaultConfig: patch
            }));
        },

        async getVodSettings() {
            return revisioned(this.__api.persist.getVodSettingsRaw());
        },

        async updateVodSettings(patch, etag) {
            return revisioned(this.__api.persist.updateVodSettingsRaw({
                ifMatch: etag, vodSettings: patch
            }));
        },

        async getSecrets() {
            return revisioned(this.__api.persist.getSecretsRaw());
        },

        async updateSecrets(patch, etag) {
            return revisioned(this.__api.persist.updateSecretsRaw({
                ifMatch: etag, secrets: patch
            }));
        },

        async getStreamGroupConfig(name) {
            return revisioned(this.__api.persist.getStreamGroupConfigRaw({ name: name }));
        },

        async updateStreamGroupConfig(name, patch, etag) {
            return revisioned(this.__api.persist.updateStreamGroupConfigRaw({
                name: name, ifMatch: etag, streamGroupConfig: patch
            }));
        },

        async deleteStreamGroupConfig(name, etag) {
            await called(this.__api.persist.deleteStreamGroupConfigRaw({ name: name, ifMatch: etag }));
        },

        async listStreamConfigOverrides(filters) {
            filters = filters || {};
            return listed(this.__api.persist.listStreamConfigOverridesRaw({
                application: filters.application
            }));
        },

        async getStreamConfigOverride(app, stream) {
            return revisioned(this.__api.persist.getStreamConfigOverrideRaw({ app: app, stream: stream }));
        },

        async createStreamConfigOverride(app, stream, override) {
            return revisioned(this.__api.persist.createStreamConfigOverrideRaw({
                app: app, stream: stream, streamConfigOverride: override
            }));
        },

        async updateStreamConfigOverride(app, stream, patch, etag) {
            return revisioned(this.__api.persist.updateStreamConfigOverrideRaw({
                app: app, stream: stream, ifMatch: etag, streamConfigOverride: patch
            }));
        },

        async deleteStreamConfigOverride(app, stream, etag) {
            await called(this.__api.persist.deleteStreamConfigOverrideRaw({
                app: app, stream: stream, ifMatch: etag
            }));
        },

        async getPersistedDetector(app, stream) {
            return revisioned(this.__api.persist.getPersistedDetectorRaw({ app: app, stream: stream }));
        },

        async updatePersistedDetector(app, stream, patch, etag) {
            return revisioned(this.__api.persist.updatePersistedDetectorRaw({
                app: app, stream: stream, ifMatch: etag, detector: discriminated(patch, 'detector')
            }));
        },

        async deletePersistedDetector(app, stream, etag) {
            await called(this.__api.persist.deletePersistedDetectorRaw({
                app: app, stream: stream, ifMatch: etag
            }));
        },

        async listPersistedListeners(app, stream) {
            return nameKeyed(this.__api.persist.listPersistedListenersRaw({ app: app, stream: stream }));
        },

        async getPersistedListener(app, stream, name) {
            return revisioned(this.__api.persist.getPersistedListenerRaw({
                app: app, stream: stream, name: name
            }));
        },

        async createPersistedListener(app, stream, listener) {
            return revisioned(this.__api.persist.createPersistedListenerRaw({
                app: app, stream: stream, listener: discriminated(listener, 'listener')
            }));
        },

        async updatePersistedListener(app, stream, name, patch, etag) {
            return revisioned(this.__api.persist.updatePersistedListenerRaw({
                app: app, stream: stream, name: name, ifMatch: etag, listener: discriminated(patch, 'listener')
            }));
        },

        async deletePersistedListener(app, stream, name, etag) {
            await called(this.__api.persist.deletePersistedListenerRaw({
                app: app, stream: stream, name: name, ifMatch: etag
            }));
        },

        async probeVlmEndpoint(request) {
            return document(this.__api.probes.probeVlmEndpointRaw({
                vlmEndpointProbeRequest: request
            }));
        },

        async listVodFiles() {
            return document(this.__api.vod.listVodFilesRaw());
        },

        // The generated operation fixes video/mp4; the header override is how the
        // spec's other body type gets sent.
        async createVodFile(file, body, contentType) {
            return document(this.__api.vod.createVodFileRaw(
                { file: file, body: body },
                { headers: { 'Content-Type': contentType || 'video/mp4' } }));
        },

        async deleteVodFile(file) {
            await called(this.__api.vod.deleteVodFileRaw({ file: file }));
        },

        // Not an operation: the createVodFile URL, for an upload the page drives
        // itself.
        vodFileUploadUrl(file) {
            if (!this.transport.url) {
                throw new VifError('This transport does not expose url(); cannot build an upload URL', 0, null);
            }
            return this.transport.url('/vod/files', { file: file });
        },

        async listVodJobs(filters) {
            filters = filters || {};
            return document(this.__api.vod.listVodJobsRaw({
                tag: filters.tag, state: filters.state, offset: filters.offset, limit: filters.limit
            }));
        },

        async createVodJob(request) {
            return document(this.__api.vod.createVodJobRaw({ vodJobRequest: request }));
        },

        async getVodJob(jobId) {
            return document(this.__api.vod.getVodJobRaw({ jobId: jobId }));
        },

        async deleteVodJob(jobId) {
            await called(this.__api.vod.deleteVodJobRaw({ jobId: jobId }));
        },

        async cancelVodJob(jobId) {
            return document(this.__api.vod.cancelVodJobRaw({ jobId: jobId }));
        },

        async resumeVodJob(jobId, request) {
            return document(this.__api.vod.resumeVodJobRaw({ jobId: jobId, vodJobResumeRequest: request }));
        },

        // The envelope camelCases; the rows inside `results` are the analysis
        // service's own documents and arrive as stored.
        async listVodJobResults(jobId, page) {
            page = page || {};
            return document(this.__api.vod.listVodJobResultsRaw({
                jobId: jobId, offset: page.offset, limit: page.limit, fromMs: page.fromMs, toMs: page.toMs
            }));
        },

        // Returns a Blob of newline-delimited JSON. As with getThumbnail, the
        // generated client sends no Accept, and Accept is what keeps a transport
        // from parsing the body as one JSON document.
        async getVodJobResultsFile(jobId) {
            var answer = await called(this.__api.vod.getVodJobResultsFileRaw(
                { jobId: jobId }, { headers: { Accept: 'application/x-ndjson' } }));
            return answer.value();
        },

        // Returns a Blob; the caller owns the object URL.
        async getVodJobThumbnail(jobId) {
            var answer = await called(this.__api.vod.getVodJobThumbnailRaw(
                { jobId: jobId }, { headers: { Accept: 'image/jpeg' } }));
            return answer.value();
        },

        // Not an operation: the getVodJobThumbnail URL, for <img src>.
        vodJobThumbnailUrl(jobId) {
            if (!this.transport.url) {
                throw new VifError('This transport does not expose url(); cannot build a thumbnail URL', 0, null);
            }
            return this.transport.url('/vod/jobs/' + encodeURIComponent(jobId) + '/thumbnail');
        }
    };

    // ── models ──────────────────────────────────────────────────────────────
    // Plain objects with a prototype, so `instanceof ObjectDetector` narrows a
    // detector. Bookkeeping (ETag, dirty paths, owning ref) lives on
    // non-enumerable __ctx so it never reaches the wire.
    function defineModel(name, parent, fixed) {
        function Model(values) {
            assign(this, values);
            if (fixed) Object.keys(fixed).forEach(function (key) { this[key] = fixed[key]; }, this);
        }
        Model.prototype = Object.create((parent || Object).prototype);
        Model.prototype.constructor = Model;
        Model.modelName = name;
        return Model;
    }

    function assign(target, values) {
        Object.keys(values || {}).forEach(function (key) {
            if (key.indexOf('__') === 0) return;
            target[key] = values[key];
        });
        return target;
    }

    var Detector = defineModel('Detector');
    var SceneDetector = defineModel('SceneDetector', Detector, { type: 'scene' });
    var ObjectDetector = defineModel('ObjectDetector', Detector, { type: 'object' });
    var VlmDetector = defineModel('VlmDetector', Detector, { type: 'vlm' });
    var SyntheticDetector = defineModel('SyntheticDetector', Detector, { type: 'synthetic' });

    var DETECTOR_CLASSES = {
        scene: SceneDetector,
        object: ObjectDetector,
        vlm: VlmDetector,
        synthetic: SyntheticDetector
    };

    var Listener = defineModel('Listener');
    var OverlayListener = defineModel('OverlayListener', Listener, { type: 'overlay' });
    var WebhookListener = defineModel('WebhookListener', Listener, { type: 'webhook' });
    var Id3Listener = defineModel('Id3Listener', Listener, { type: 'id3' });
    var LogListener = defineModel('LogListener', Listener, { type: 'log' });
    var CustomListener = defineModel('CustomListener', Listener, { type: 'custom' });

    var LISTENER_CLASSES = {
        overlay: OverlayListener,
        webhook: WebhookListener,
        id3: Id3Listener,
        log: LogListener,
        custom: CustomListener
    };

    var StreamGroupConfig = defineModel('StreamGroupConfig');
    var DefaultConfig = defineModel('DefaultConfig');
    var Stream = defineModel('Stream');
    var StreamConfigOverride = defineModel('StreamConfigOverride');
    var VodSettings = defineModel('VodSettings');

    // Every document carries its settings in `config`, so that is the only root
    // a stream PATCH may touch — and inside it, only these members: the
    // detector and the listeners have their own subresources, and the rest of
    // the document is read-only state.
    var STREAM_CONFIG_KEYS = { active: 1, processing: 1, service: 1, diagnostics: 1 };
    // Paths, not keys: the aspects the stream document reports are served
    // through their own subresources and are shadowed by refs, so they come off
    // the model rather than riding into a patch.
    var STREAM_STRIP = ['etag', 'config.detector', 'config.listeners'];

    function detectorFrom(data) {
        var Klass = DETECTOR_CLASSES[data && data.type];
        return Klass ? new Klass(data) : new Detector(data || {});
    }

    function listenerFrom(data) {
        var Klass = LISTENER_CLASSES[data && data.type];
        return Klass ? new Klass(data) : new Listener(data || {});
    }

    // ── dirty tracking ──────────────────────────────────────────────────────
    // A Proxy records every assignment as a dot path, so save() can send a
    // merge-patch of exactly the touched fields. Property reads are local; the
    // only network boundaries are get/list/save/replace/set/delete/reload.
    function track(model, ctx) {
        Object.defineProperty(model, '__ctx', { value: ctx, enumerable: false, writable: true });
        return wrap(model, ctx, '');
    }

    // `arrayPath` is set once the walk crosses an array: JSON Merge Patch
    // replaces arrays wholesale, so every mutation at or below one — an index,
    // `length`, a field of an element — dirties the array's own path.
    function wrap(target, ctx, prefix, arrayPath) {
        function mark(key) {
            if (typeof key === 'string' && key.indexOf('__') !== 0) {
                ctx.dirty.add(arrayPath === undefined ? prefix + key : arrayPath);
            }
        }
        return new Proxy(target, {
            get: function (obj, key) {
                if (key === '__raw') return obj;
                var value = obj[key];
                if (typeof key !== 'string' || key.indexOf('__') === 0) return value;
                if (value && value.__ref) return value;
                if (value && typeof value === 'object' && typeof value !== 'function'
                    && !OPAQUE_KEYS[key]) {
                    if (Array.isArray(value)) {
                        return wrap(value, ctx, '',
                            arrayPath === undefined ? prefix + key : arrayPath);
                    }
                    return wrap(value, ctx, prefix + key + '.', arrayPath);
                }
                return value;
            },
            set: function (obj, key, value) {
                if (obj[key] && obj[key].__ref) return true;
                obj[key] = value;
                mark(key);
                return true;
            },
            deleteProperty: function (obj, key) {
                if (obj[key] && obj[key].__ref) return true;
                delete obj[key];
                mark(key);
                return true;
            }
        });
    }

    function valueAtPath(source, path) {
        var parts = path.split('.');
        var current = source;
        for (var i = 0; i < parts.length; i++) {
            if (current === null || current === undefined) return undefined;
            current = current[parts[i]];
        }
        return current;
    }

    function setAtPath(target, path, value) {
        var parts = path.split('.');
        var current = target;
        for (var i = 0; i < parts.length - 1; i++) {
            if (typeof current[parts[i]] !== 'object' || current[parts[i]] === null) current[parts[i]] = {};
            current = current[parts[i]];
        }
        current[parts[parts.length - 1]] = value;
    }

    function isPlainObject(value) {
        return !!value && typeof value === 'object' && !Array.isArray(value)
            && !(value instanceof Date);
    }

    // A removal, stated. Merge patch has no way to say "this key is gone" other
    // than naming it null, so a map that lost a key has to carry that key as a
    // null or the server keeps it. Recursive because the maps nest: a response
    // schema drops a property two levels down, and the patch has to say so at
    // that depth. Arrays are left alone — merge patch replaces those wholesale.
    function withDeletions(baseline, current) {
        if (!isPlainObject(baseline) || !isPlainObject(current)) return current;
        var out = {};
        Object.keys(current).forEach(function (key) {
            out[key] = withDeletions(baseline[key], current[key]);
        });
        Object.keys(baseline).forEach(function (key) {
            if (!(key in current)) out[key] = null;
        });
        return out;
    }

    // A patch that touches a detector or a listener entry restates its `type`.
    // The section is atomic and the wire converters dispatch on that
    // discriminator, so a patch without one has no variant to serialize through.
    // An unchanged type is a no-op server-side; only a changed one replaces the
    // section. Operator-keyed maps are not walked: their `type` members are the
    // writer's data, not a discriminator.
    function stampDiscriminators(patch, source) {
        if (!isPlainObject(patch) || !isPlainObject(source)) return;
        if (typeof source.type === 'string' && patch.type === undefined) patch.type = source.type;
        Object.keys(patch).forEach(function (key) {
            if (OPAQUE_KEYS[key]) return;
            stampDiscriminators(patch[key], source[key]);
        });
    }

    // The touched paths as a JSON Merge Patch. An assigned null deletes the
    // member server-side, which is how the API expresses "unset / inherit".
    function buildPatch(model) {
        var ctx = model.__ctx;
        var source = model.__raw || model;
        var patch = {};
        ctx.dirty.forEach(function (path) {
            var value = valueAtPath(source, path);
            var parts = path.split('.');
            if (OPAQUE_KEYS[parts[parts.length - 1]] && ctx.baseline) {
                value = withDeletions(valueAtPath(ctx.baseline, path), value);
            }
            setAtPath(patch, path, value === undefined ? null : value);
        });
        stampDiscriminators(patch, source);
        return patch;
    }

    // Reads off the proxy's raw target, so the copy holds no tracking proxies.
    function plain(model) {
        var raw = (model && model.__raw) || model;
        var out = {};
        Object.keys(raw).forEach(function (key) {
            if (key.indexOf('__') !== 0) out[key] = raw[key];
        });
        return out;
    }

    // `etag` rides on stream and listener documents so a client that listed
    // them can write one back; it is the server's, and never part of a write
    // body — at any depth: a document's listener map carries one per listener.
    function withoutEtags(value) {
        if (Array.isArray(value)) return value.map(withoutEtags);
        if (!value || typeof value !== 'object' || value instanceof Date) return value;
        var out = {};
        Object.keys(value).forEach(function (key) {
            if (key === 'etag') return;
            if (OPAQUE_KEYS[key]) {
                out[key] = value[key];
                return;
            }
            if (NAME_KEYED_KEYS[key] && value[key] && typeof value[key] === 'object'
                && !Array.isArray(value[key])) {
                var cleaned = {};
                Object.keys(value[key]).forEach(function (name) {
                    cleaned[name] = withoutEtags(value[key][name]);
                });
                out[key] = cleaned;
                return;
            }
            out[key] = withoutEtags(value[key]);
        });
        return out;
    }

    function body(model) {
        return withoutEtags(model && model.__ctx ? plain(model) : model);
    }

    // A shallow copy without the dot paths given, cloning only the objects on
    // the way down: `config.detector` has to come off without the caller's own
    // snapshot of the document losing it.
    function withoutPaths(data, paths) {
        var out = Object.assign({}, data);
        paths.forEach(function (path) {
            var parts = path.split('.');
            var current = out;
            for (var i = 0; i < parts.length - 1 && current; i++) {
                if (!current[parts[i]] || typeof current[parts[i]] !== 'object') return;
                current[parts[i]] = Object.assign({}, current[parts[i]]);
                current = current[parts[i]];
            }
            if (current) delete current[parts[parts.length - 1]];
        });
        return out;
    }

    function replaceContents(model, data) {
        Object.keys(plain(model)).forEach(function (key) { delete model[key]; });
        assign(model, data);
        delete model.etag;
    }

    // What the model held when it was last read. Only `withDeletions` reads it,
    // and only to see which keys an operator-keyed map has since lost. A copy,
    // not the answer itself: the answer is assigned into the model and would
    // otherwise change underfoot with every edit.
    function snapshot(data) {
        return data === null || typeof data !== 'object' ? data
            : JSON.parse(JSON.stringify(data));
    }

    // ── tracked-model lifecycle ─────────────────────────────────────────────
    // Each tracked model's ctx carries closures for its own resource:
    // fetchOp() and patchOp(patch, etag) resolve to {data, etag}; onEtag and
    // onData hand server answers back to the owning ref; guard vets a patch
    // before it is emitted. Models without a patchOp are replace-only.
    function tracked(model, ctx) {
        ctx.dirty = new Set();
        ctx.baseline = snapshot(plain(model));
        return track(model, ctx);
    }

    function applyResult(model, ctx, result) {
        var data = result.data;
        if (ctx.strip) data = withoutPaths(data, ctx.strip);
        replaceContents(model, data);
        ctx.baseline = snapshot(plain(model));
        ctx.etag = result.etag;
        if (ctx.onEtag) ctx.onEtag(result.etag);
        if (ctx.onData) ctx.onData(result.data);
        // Last: assigning the server's answer back through the tracking proxy
        // marks those same paths dirty again.
        ctx.dirty.clear();
    }

    async function saveTracked(model) {
        var ctx = model.__ctx;
        if (!ctx) throw new VifError('This object was not loaded through the SDK and cannot save itself', 0, null);
        if (ctx.guard) ctx.guard(model, ctx);
        if (ctx.dirty.size === 0) return model;
        var result = await ctx.patchOp(buildPatch(model), requireEtag(ctx.etag, ctx.label));
        applyResult(model, ctx, result);
        return model;
    }

    async function reloadTracked(model) {
        var ctx = model.__ctx;
        if (!ctx) throw new VifError('This object was not loaded through the SDK and cannot reload itself', 0, null);
        applyResult(model, ctx, await ctx.fetchOp());
        return model;
    }

    // Adopts the stored revision without touching the local edits. After a write
    // lost a race, this is what lets the edits be re-applied deliberately instead
    // of a reload throwing away everything the operator typed.
    async function rebaseTracked(model) {
        var ctx = model.__ctx;
        if (!ctx) throw new VifError('This object was not loaded through the SDK and cannot rebase itself', 0, null);
        ctx.etag = (await ctx.fetchOp()).etag;
        if (ctx.onEtag) ctx.onEtag(ctx.etag);
        return model;
    }

    // ── patch guards ────────────────────────────────────────────────────────
    // Client-side vetting of a save() before its PATCH is emitted.
    function streamSettingsGuard(model, ctx) {
        ctx.dirty.forEach(function (path) {
            var parts = path.split('.');
            if (parts[0] !== 'config') {
                throw new VifError(
                    "'" + parts[0] + "' is not patchable on the stream: only its `config` is, and "
                    + 'the rest of the document is read-only state.', 0, null);
            }
            if (!STREAM_CONFIG_KEYS[parts[1]]) {
                throw new VifError(
                    "'config." + parts[1] + "' is not patchable on the stream: the detector and the "
                    + 'listeners have their own subresources.', 0, null);
            }
        });
    }

    // ── facade: runtime refs ────────────────────────────────────────────────
    // Refs hold per-resource revision bookkeeping and expose the operations the
    // contract defines for that aspect. `value` is the last plain snapshot seen
    // — seeded from the owning stream document, refreshed by any read or write.
    function RuntimeDetectorRef(client, stream) {
        this.client = client;
        this.stream = stream;
        this.etag = null;
        this.type = null;
        this.value = null;
    }
    RuntimeDetectorRef.prototype.__ref = true;

    RuntimeDetectorRef.prototype.adopt = function (result) {
        var ref = this;
        var model = detectorFrom(result.data);
        this.etag = result.etag;
        this.type = model.type || null;
        this.value = result.data || null;
        return tracked(model, {
            etag: result.etag,
            label: 'this detector',
            fetchOp: function () {
                return ref.client.raw.getRuntimeDetector(ref.stream.app, ref.stream.name);
            },
            patchOp: function (patch, etag) {
                return ref.client.raw.updateRuntimeDetector(ref.stream.app, ref.stream.name, patch, etag);
            },
            onEtag: function (etag) { ref.etag = etag; },
            onData: function (data) { ref.type = (data && data.type) || null; ref.value = data || null; }
        });
    };

    RuntimeDetectorRef.prototype.get = async function () {
        return this.adopt(await this.client.raw.getRuntimeDetector(
            this.stream.app, this.stream.name));
    };

    // A patch that changes type replaces the whole detector section
    // server-side.
    RuntimeDetectorRef.prototype.update = async function (patch) {
        var result = await this.client.raw.updateRuntimeDetector(
            this.stream.app, this.stream.name, patch,
            requireEtag(this.etag, 'this detector'));
        return this.adopt(result);
    };

    function RuntimeListenersRef(client, stream) {
        this.client = client;
        this.stream = stream;
        // Revision per listener, from whichever read produced it. Collection
        // and stream reads carry one per listener, so listing is enough to
        // write one back.
        this.etags = {};
        this.value = null;
    }
    RuntimeListenersRef.prototype.__ref = true;

    RuntimeListenersRef.prototype.adopt = function (name, result) {
        var ref = this;
        var model = listenerFrom(result.data);
        delete model.etag;
        this.etags[name] = result.etag || null;
        return tracked(model, {
            etag: result.etag || null,
            label: "listener '" + name + "'",
            fetchOp: function () {
                return ref.client.raw.getRuntimeListener(ref.stream.app, ref.stream.name, name);
            },
            patchOp: function (patch, etag) {
                return ref.client.raw.updateRuntimeListener(ref.stream.app, ref.stream.name, name, patch, etag);
            },
            onEtag: function (etag) { ref.etags[name] = etag; }
        });
    };

    RuntimeListenersRef.prototype.list = async function () {
        var ref = this;
        var raw = await this.client.raw.listRuntimeListeners(this.stream.app, this.stream.name);
        this.value = raw;
        var listeners = {};
        Object.keys(raw).forEach(function (name) {
            listeners[name] = ref.adopt(name, { data: raw[name], etag: raw[name].etag || null });
        });
        return listeners;
    };

    RuntimeListenersRef.prototype.get = async function (name) {
        return this.adopt(name, await this.client.raw.getRuntimeListener(
            this.stream.app, this.stream.name, name));
    };

    // POST create: the name rides in the body; a taken name is
    // AlreadyExistsError.
    RuntimeListenersRef.prototype.create = async function (name, listener) {
        var payload = body(listener);
        payload.name = name;
        try {
            var result = await this.client.raw.createRuntimeListener(this.stream.app, this.stream.name, payload);
            return this.adopt(name, result);
        } catch (error) {
            if (error instanceof ConflictError) {
                throw new AlreadyExistsError("listener '" + name + "' already exists", error.status, error.problem);
            }
            throw error;
        }
    };

    RuntimeListenersRef.prototype.update = async function (name, patch) {
        var result = await this.client.raw.updateRuntimeListener(
            this.stream.app, this.stream.name, name, patch,
            requireEtag(this.etags[name], "listener '" + name + "'"));
        return this.adopt(name, result);
    };

    RuntimeListenersRef.prototype.delete = async function (name) {
        await this.client.raw.deleteRuntimeListener(
            this.stream.app, this.stream.name, name,
            requireEtag(this.etags[name], "listener '" + name + "'"));
        delete this.etags[name];
    };

    function RuntimeStreamRef(client, app, name) {
        this.client = client;
        this.app = app;
        this.name = name;
        this.etag = null;
        this.detector = new RuntimeDetectorRef(client, this);
        this.listeners = new RuntimeListenersRef(client, this);
    }
    RuntimeStreamRef.prototype.__ref = true;

    // Pushes the aspect snapshots a stream document carries into the aspect
    // refs. They live inside the document's `config` now, and are still exposed
    // on the ref rather than on the model, because they are subresources
    // addressed at their own paths. Listener revisions ride on the document; the
    // detector's own revision does not, so a detector write still needs a
    // detector read.
    RuntimeStreamRef.prototype.seed = function (data) {
        var config = data && data.config;
        if (!config) return;
        if (config.detector !== undefined) {
            this.detector.value = config.detector || null;
            this.detector.type = (config.detector && config.detector.type) || null;
        }
        if (config.listeners !== undefined) {
            var listenersRef = this.listeners;
            listenersRef.value = config.listeners || {};
            Object.keys(config.listeners || {}).forEach(function (name) {
                if (config.listeners[name] && config.listeners[name].etag) {
                    listenersRef.etags[name] = config.listeners[name].etag;
                }
            });
        }
    };

    RuntimeStreamRef.prototype.adopt = function (result) {
        var ref = this;
        this.etag = result.etag || (result.data && result.data.etag) || null;
        this.seed(result.data);
        var model = new Stream(withoutPaths(result.data, STREAM_STRIP));
        var trackedModel = tracked(model, {
            etag: this.etag,
            label: "stream '" + this.name + "'",
            streamRef: ref,
            strip: STREAM_STRIP,
            guard: streamSettingsGuard,
            fetchOp: function () { return ref.client.raw.getRuntimeStream(ref.app, ref.name); },
            patchOp: function (patch, etag) {
                return ref.client.raw.updateRuntimeStream(ref.app, ref.name, patch, etag);
            },
            onEtag: function (etag) { ref.etag = etag; },
            onData: function (full) { ref.seed(full); }
        });
        // The aspect refs shadow the stripped document fields; non-enumerable
        // so they never reach a patch, a write body, or toJSON().
        ['detector', 'listeners'].forEach(function (aspect) {
            Object.defineProperty(model, aspect, { value: ref[aspect], enumerable: false, configurable: true });
        });
        return trackedModel;
    };

    RuntimeStreamRef.prototype.reset = function () {
        return this.client.raw.resetRuntimeStream(this.app, this.name);
    };

    RuntimeStreamRef.prototype.thumbnail = function (params) {
        return this.client.raw.getThumbnail(this.app, this.name, params);
    };

    RuntimeStreamRef.prototype.thumbnailUrl = function (params) {
        return this.client.raw.thumbnailUrl(this.app, this.name, params);
    };

    function streamRefOf(model, verb) {
        var ref = model.__ctx && model.__ctx.streamRef;
        if (!ref) throw new VifError('This stream was not loaded through the SDK and cannot ' + verb, 0, null);
        return ref;
    }

    // Action endpoint: reverts the running instance to its persisted
    // configuration and rehydrates the model from the returned stream — no
    // follow-up GET.
    Stream.prototype.reset = async function () {
        var result = await streamRefOf(this, 'reset').reset();
        applyResult(this, this.__ctx, result);
        return this;
    };

    Stream.prototype.thumbnail = function (params) {
        return streamRefOf(this, 'fetch a thumbnail').thumbnail(params);
    };

    Stream.prototype.thumbnailUrl = function (params) {
        return streamRefOf(this, 'build a thumbnail URL').thumbnailUrl(params);
    };

    // App-scoped calls resolve their application by arity: (app, stream, ...)
    // names it, (stream, ...) addresses the client's default application.
    function resolveStream(client, args) {
        var app, name, rest;
        if (typeof args[1] === 'string') {
            app = args[0];
            name = args[1];
            rest = Array.prototype.slice.call(args, 2);
        } else {
            app = client.application;
            name = args[0];
            rest = Array.prototype.slice.call(args, 1);
            if (!app) {
                throw new VifError(
                    'No application to address: construct the client with { application }, '
                    + 'use vif.for(application), or pass the application explicitly.', 0, null);
            }
        }
        if (typeof name !== 'string' || !name) {
            throw new VifError('A stream name is required', 0, null);
        }
        return { app: app, name: name, rest: rest };
    }

    function RuntimeStreams(client, refs) {
        this.client = client;
        // Shared across vif.for() views: refs are keyed by (app, stream).
        this.refs = refs;
    }

    RuntimeStreams.prototype.ref = function (app, name) {
        var target = resolveStream(this.client, arguments);
        var key = target.app + ' ' + target.name;
        if (!this.refs[key]) this.refs[key] = new RuntimeStreamRef(this.client, target.app, target.name);
        return this.refs[key];
    };

    // The application default never filters a list: this stays fleet-wide
    // unless filters.application is passed explicitly.
    RuntimeStreams.prototype.list = async function (filters) {
        var ns = this;
        var items = await this.client.raw.listRuntimeStreams(filters);
        return items.map(function (data) {
            return ns.ref(data.application, data.name).adopt({ data: data, etag: data.etag || null });
        });
    };

    RuntimeStreams.prototype.get = async function (app, name) {
        var ref = this.ref.apply(this, arguments);
        return ref.adopt(await this.client.raw.getRuntimeStream(ref.app, ref.name));
    };

    // ── facade: persist refs ────────────────────────────────────────────────
    // In the persist world an absent document is a normal state ("inherits
    // from the layer below"): GETs answer null instead of throwing.
    function isAbsent(error) {
        return error instanceof NotFoundError && !(error instanceof RouteUnavailableError);
    }

    function PersistedDetectorRef(client, override) {
        this.client = client;
        this.override = override;
        this.etag = null;
        this.type = null;
        this.value = null;
    }
    PersistedDetectorRef.prototype.__ref = true;

    PersistedDetectorRef.prototype.adopt = function (result) {
        var ref = this;
        var model = detectorFrom(result.data);
        this.etag = result.etag;
        this.type = model.type || null;
        this.value = result.data || null;
        return tracked(model, {
            etag: result.etag,
            label: 'the saved detector',
            fetchOp: function () {
                return ref.client.raw.getPersistedDetector(ref.override.app, ref.override.name);
            },
            patchOp: function (patch, etag) {
                return ref.client.raw.updatePersistedDetector(ref.override.app, ref.override.name, patch, etag);
            },
            onEtag: function (etag) { ref.etag = etag; },
            onData: function (data) { ref.type = (data && data.type) || null; ref.value = data || null; }
        });
    };

    PersistedDetectorRef.prototype.get = async function () {
        try {
            return this.adopt(await this.client.raw.getPersistedDetector(this.override.app, this.override.name));
        } catch (error) {
            if (isAbsent(error)) {
                this.etag = null;
                this.type = null;
                this.value = null;
                return null;
            }
            throw error;
        }
    };

    // A patch that changes type replaces the whole detector section
    // server-side. 404 means the override sets no detector: add one by
    // patching the override document with {config: {detector: {...}}}.
    PersistedDetectorRef.prototype.update = async function (patch) {
        return this.adopt(await this.client.raw.updatePersistedDetector(
            this.override.app, this.override.name, patch,
            requireEtag(this.etag, 'the saved detector')));
    };

    PersistedDetectorRef.prototype.delete = async function () {
        await this.client.raw.deletePersistedDetector(
            this.override.app, this.override.name,
            requireEtag(this.etag, 'the saved detector'));
        this.etag = null;
        this.type = null;
        this.value = null;
    };

    function PersistedListenersRef(client, override) {
        this.client = client;
        this.override = override;
        this.etags = {};
        this.value = null;
    }
    PersistedListenersRef.prototype.__ref = true;

    PersistedListenersRef.prototype.adopt = function (name, result) {
        var ref = this;
        var model = listenerFrom(result.data);
        delete model.etag;
        this.etags[name] = result.etag || null;
        return tracked(model, {
            etag: result.etag || null,
            label: "saved listener '" + name + "'",
            fetchOp: function () {
                return ref.client.raw.getPersistedListener(ref.override.app, ref.override.name, name);
            },
            patchOp: function (patch, etag) {
                return ref.client.raw.updatePersistedListener(ref.override.app, ref.override.name, name, patch, etag);
            },
            onEtag: function (etag) { ref.etags[name] = etag; }
        });
    };

    PersistedListenersRef.prototype.list = async function () {
        var ref = this;
        var raw;
        try {
            raw = await this.client.raw.listPersistedListeners(this.override.app, this.override.name);
        } catch (error) {
            if (isAbsent(error)) return null;
            throw error;
        }
        this.value = raw;
        var listeners = {};
        Object.keys(raw).forEach(function (name) {
            listeners[name] = ref.adopt(name, { data: raw[name], etag: raw[name].etag || null });
        });
        return listeners;
    };

    PersistedListenersRef.prototype.get = async function (name) {
        try {
            return this.adopt(name, await this.client.raw.getPersistedListener(
                this.override.app, this.override.name, name));
        } catch (error) {
            if (isAbsent(error)) return null;
            throw error;
        }
    };

    // POST create: the name rides in the body; a taken name is
    // AlreadyExistsError. Creating the first listener materializes the
    // override.
    PersistedListenersRef.prototype.create = async function (name, listener) {
        var payload = body(listener);
        payload.name = name;
        try {
            var result = await this.client.raw.createPersistedListener(this.override.app, this.override.name, payload);
            return this.adopt(name, result);
        } catch (error) {
            if (error instanceof ConflictError) {
                throw new AlreadyExistsError("listener '" + name + "' already exists", error.status, error.problem);
            }
            throw error;
        }
    };

    PersistedListenersRef.prototype.update = async function (name, patch) {
        return this.adopt(name, await this.client.raw.updatePersistedListener(
            this.override.app, this.override.name, name, patch,
            requireEtag(this.etags[name], "saved listener '" + name + "'")));
    };

    PersistedListenersRef.prototype.delete = async function (name) {
        await this.client.raw.deletePersistedListener(
            this.override.app, this.override.name, name,
            requireEtag(this.etags[name], "saved listener '" + name + "'"));
        delete this.etags[name];
    };

    // One stream's saved override. Unlike the runtime stream, the document
    // keeps config.detector and config.listeners as sparse DATA that save() may
    // patch (escalating to a full replace on replace-only zones); the aspect
    // SUBRESOURCE operations live on the ref's .detector/.listeners.
    function StreamConfigOverrideRef(client, app, name) {
        this.client = client;
        this.app = app;
        this.name = name;
        this.etag = null;
        this.detector = new PersistedDetectorRef(client, this);
        this.listeners = new PersistedListenersRef(client, this);
    }
    StreamConfigOverrideRef.prototype.__ref = true;

    StreamConfigOverrideRef.prototype.adopt = function (result) {
        var ref = this;
        this.etag = result.etag || (result.data && result.data.etag) || null;
        var model = new StreamConfigOverride(result.data);
        delete model.etag;
        return tracked(model, {
            etag: this.etag,
            label: "the override of stream '" + this.name + "'",
            fetchOp: function () { return ref.client.raw.getStreamConfigOverride(ref.app, ref.name); },
            patchOp: function (patch, etag) {
                return ref.client.raw.updateStreamConfigOverride(ref.app, ref.name, patch, etag);
            },
            onEtag: function (etag) { ref.etag = etag; }
        });
    };

    // Null means the stream has no override — it follows its config entirely.
    StreamConfigOverrideRef.prototype.get = async function () {
        try {
            return this.adopt(await this.client.raw.getStreamConfigOverride(this.app, this.name));
        } catch (error) {
            if (isAbsent(error)) {
                this.etag = null;
                return null;
            }
            throw error;
        }
    };

    // POST create: 409 when the stream already has an override.
    StreamConfigOverrideRef.prototype.create = async function (override) {
        try {
            return this.adopt(await this.client.raw.createStreamConfigOverride(this.app, this.name, body(override)));
        } catch (error) {
            if (error instanceof ConflictError) {
                throw new AlreadyExistsError(
                    "stream '" + this.name + "' already has an override", error.status, error.problem);
            }
            throw error;
        }
    };

    StreamConfigOverrideRef.prototype.update = async function (patch) {
        return this.adopt(await this.client.raw.updateStreamConfigOverride(
            this.app, this.name, patch,
            requireEtag(this.etag, "the override of stream '" + this.name + "'")));
    };

    StreamConfigOverrideRef.prototype.delete = async function () {
        await this.client.raw.deleteStreamConfigOverride(
            this.app, this.name,
            requireEtag(this.etag, "the override of stream '" + this.name + "'"));
        this.etag = null;
    };

    function PersistStreams(client, refs) {
        this.client = client;
        // Shared across vif.for() views: refs are keyed by (app, stream).
        this.refs = refs;
    }

    // Filters, not addressing: the client's default application scopes how a stream is
    // named, never which overrides a listing answers with — pass { application } to narrow.
    PersistStreams.prototype.list = async function (filters) {
        var self = this;
        var raw = await this.client.raw.listStreamConfigOverrides(filters);
        return raw.map(function (data) {
            return self.ref(data.application, data.stream)
                .adopt({ data: data, etag: data.etag || null });
        });
    };

    PersistStreams.prototype.ref = function (app, name) {
        var target = resolveStream(this.client, arguments);
        var key = target.app + ' ' + target.name;
        if (!this.refs[key]) this.refs[key] = new StreamConfigOverrideRef(this.client, target.app, target.name);
        return this.refs[key];
    };

    PersistStreams.prototype.get = function (app, name) {
        var target = resolveStream(this.client, arguments);
        return this.ref(target.app, target.name).get();
    };

    PersistStreams.prototype.create = function (app, name, override) {
        var target = resolveStream(this.client, arguments);
        return this.ref(target.app, target.name).create(target.rest[0]);
    };

    PersistStreams.prototype.update = function (app, name, patch) {
        var target = resolveStream(this.client, arguments);
        return this.ref(target.app, target.name).update(target.rest[0]);
    };

    PersistStreams.prototype.delete = function (app, name) {
        var target = resolveStream(this.client, arguments);
        return this.ref(target.app, target.name).delete();
    };

    // A single revisioned document with no identity of its own: read whole,
    // patched against the revision that read produced.
    function defineDocumentRef(Model, label, read, write) {
        function Ref(client) {
            this.client = client;
            this.etag = null;
        }
        Ref.prototype.__ref = true;

        Ref.prototype.adopt = function (result) {
            var ref = this;
            this.etag = result.etag;
            return tracked(new Model(result.data), {
                etag: result.etag,
                label: label,
                fetchOp: function () { return read(ref.client.raw); },
                patchOp: function (patch, etag) { return write(ref.client.raw, patch, etag); },
                onEtag: function (etag) { ref.etag = etag; }
            });
        };

        Ref.prototype.get = async function () {
            return this.adopt(await read(this.client.raw));
        };

        Ref.prototype.update = async function (patch) {
            return this.adopt(await write(this.client.raw, patch, requireEtag(this.etag, label)));
        };

        return Ref;
    }

    var DefaultConfigRef = defineDocumentRef(DefaultConfig, 'the default config',
        function (raw) { return raw.getDefaultConfig(); },
        function (raw, patch, etag) { return raw.updateDefaultConfig(patch, etag); });

    var VodSettingsRef = defineDocumentRef(VodSettings, 'the VOD settings',
        function (raw) { return raw.getVodSettings(); },
        function (raw, patch, etag) { return raw.updateVodSettings(patch, etag); });

    // Names come out and values go in, so there is nothing to edit in place:
    // get() answers the names, update() sends the values, one revision covers
    // both.
    function SecretsRef(client) {
        this.client = client;
        this.etag = null;
    }
    SecretsRef.prototype.__ref = true;

    SecretsRef.prototype.adopt = function (result) {
        this.etag = result.etag;
        return { names: (result.data && result.data.names) || [], etag: result.etag };
    };

    SecretsRef.prototype.get = async function () {
        return this.adopt(await this.client.raw.getSecrets());
    };

    SecretsRef.prototype.update = async function (patch) {
        return this.adopt(await this.client.raw.updateSecrets(
            patch, requireEtag(this.etag, 'the secrets')));
    };

    function StreamGroupConfigs(client, base) {
        this.client = client;
        this.base = base;
        // Revision per stream group config name, from whichever read produced it. The
        // collection carries none, so replace/delete need a get() first.
        // Shared across vif.for() views: stream group configs are not app-scoped.
        this.etags = base.streamGroupConfigEtags;
    }

    StreamGroupConfigs.prototype.adopt = function (name, result) {
        var ref = this;
        var etag = result.etag || (result.data && result.data.etag) || null;
        var model = new StreamGroupConfig(result.data);
        delete model.etag;
        this.etags[name] = etag;
        return tracked(model, {
            etag: etag,
            label: "stream group config '" + name + "'",
            guard: function (model, ctx) {
                if (ctx.dirty.has('name')) {
                    throw new VifError(
                        "A stream group config's name is immutable; create a new one instead.", 0, null);
                }
            },
            fetchOp: function () { return ref.client.raw.getStreamGroupConfig(name); },
            patchOp: function (patch, etag) { return ref.client.raw.updateStreamGroupConfig(name, patch, etag); },
            onEtag: function (etag) { ref.etags[name] = etag; }
        });
    };

    // The application default never filters a list: this stays fleet-wide
    // unless filters.application is passed explicitly. Each document carries
    // its etag, so a listed stream group config is directly editable and saveable.
    StreamGroupConfigs.prototype.list = async function (filters) {
        var ref = this;
        var raw = await this.client.raw.listStreamGroupConfigs(filters);
        return raw.map(function (data) {
            return ref.adopt(data.name, { data: data, etag: data.etag || null });
        });
    };

    StreamGroupConfigs.prototype.get = async function (name) {
        return this.adopt(name, await this.client.raw.getStreamGroupConfig(name));
    };

    StreamGroupConfigs.prototype.create = async function (group) {
        var result = await this.client.raw.createStreamGroupConfig(body(group));
        return this.adopt(result.data.name, result);
    };

    StreamGroupConfigs.prototype.update = async function (name, patch) {
        return this.adopt(name, await this.client.raw.updateStreamGroupConfig(
            name, patch, requireEtag(this.etags[name], "stream group config '" + name + "'")));
    };

    StreamGroupConfigs.prototype.delete = async function (name) {
        await this.client.raw.deleteStreamGroupConfig(name, requireEtag(this.etags[name], "stream group config '" + name + "'"));
        delete this.etags[name];
    };

    StreamGroupConfigs.prototype.default = function () {
        if (!this.base.defaultConfigRef) this.base.defaultConfigRef = new DefaultConfigRef(this.client);
        return this.base.defaultConfigRef;
    };

    // ── facade: vod ─────────────────────────────────────────────────────────
    // Files are not tracked models: a listing is read-only, and an upload or a
    // delete is the whole write.
    function VodFiles(client) {
        this.client = client;
    }

    VodFiles.prototype.list = function () {
        return this.client.raw.listVodFiles();
    };

    // POST create: 409 when the name is taken. With onProgress the upload goes
    // through the transport's own path when it has one; the generated operation
    // bypassed there, its response runs through the same generated mapper so
    // both routes answer the same document.
    VodFiles.prototype.upload = async function (name, body, options) {
        options = options || {};
        var contentType = options.contentType || (body && body.type) || 'video/mp4';
        var transport = this.client.raw.transport;
        try {
            if (options.onProgress && transport.upload) {
                var answer = await transport.upload(
                    '/vod/files', { file: name }, body, contentType, options.onProgress);
                return VIF.api.models.VodFileFromJSON(answer.body);
            }
            return await this.client.raw.createVodFile(name, body, contentType);
        } catch (error) {
            if (error instanceof ConflictError) {
                throw new AlreadyExistsError("file '" + name + "' already exists", error.status, error.problem);
            }
            throw error;
        }
    };

    // DELETE by the name the listing gives: 404 when nothing is there, 409
    // while a queued or running job reads it. Job records are not touched.
    VodFiles.prototype.delete = function (name) {
        return this.client.raw.deleteVodFile(name);
    };

    // Jobs are not tracked models either: one is submitted whole and from then
    // on only reports. A job id nothing knows throws NotFoundError, as a runtime
    // read does — a job is never an absent layer to fall through.
    function VodJobs(client) {
        this.client = client;
    }

    VodJobs.prototype.list = function (filters) {
        return this.client.raw.listVodJobs(filters);
    };

    VodJobs.prototype.get = function (jobId) {
        return this.client.raw.getVodJob(jobId);
    };

    // POST create: no identity to take, so a 409 stays what the server says.
    VodJobs.prototype.create = function (request) {
        return this.client.raw.createVodJob(body(request));
    };

    // Action endpoint: the job settles to cancelled off this request and keeps
    // its record; delete() is what removes that.
    VodJobs.prototype.cancel = function (jobId) {
        return this.client.raw.cancelVodJob(jobId);
    };

    // The one body a resume may carry is the config of an inline job whose
    // record shed its credentials; no config, no body.
    VodJobs.prototype.resume = function (jobId, config) {
        return this.client.raw.resumeVodJob(jobId, config === undefined ? undefined : { config: body(config) });
    };

    VodJobs.prototype.delete = function (jobId) {
        return this.client.raw.deleteVodJob(jobId);
    };

    VodJobs.prototype.results = function (jobId, page) {
        return this.client.raw.listVodJobResults(jobId, page);
    };

    VodJobs.prototype.resultsFile = function (jobId) {
        return this.client.raw.getVodJobResultsFile(jobId);
    };

    VodJobs.prototype.thumbnail = function (jobId) {
        return this.client.raw.getVodJobThumbnail(jobId);
    };

    VodJobs.prototype.thumbnailUrl = function (jobId) {
        return this.client.raw.vodJobThumbnailUrl(jobId);
    };

    // ── model prototypes ────────────────────────────────────────────────────
    [Detector, Listener, StreamGroupConfig, DefaultConfig, Stream, StreamConfigOverride, VodSettings]
        .forEach(function (Klass) {
        Klass.prototype.save = function () { return saveTracked(this); };
        Klass.prototype.reload = function () { return reloadTracked(this); };
        Klass.prototype.rebase = function () { return rebaseTracked(this); };
        Klass.prototype.isDirty = function () { return !!(this.__ctx && this.__ctx.dirty.size > 0); };
        Klass.prototype.dirtyPaths = function () { return this.__ctx ? Array.from(this.__ctx.dirty) : []; };
        Klass.prototype.toJSON = function () { return plain(this); };
    });

    // ── client ──────────────────────────────────────────────────────────────
    // Wires a facade over a shared base (transport plus revision caches).
    // Views from for() share the base and differ only in the application
    // default, which is immutable on each view.
    function initFacade(client, base, application) {
        Object.defineProperty(client, '__base', { value: base });
        Object.defineProperty(client, 'raw', { value: base.raw, enumerable: true });
        Object.defineProperty(client, 'application', { value: application || null, enumerable: true });
        client.runtime = { streams: new RuntimeStreams(client, base.runtimeRefs) };
        client.persist = {
            streamGroupConfigs: new StreamGroupConfigs(client, base),
            streams: new PersistStreams(client, base.overrideRefs),
            vodSettings: function () {
                if (!base.vodSettingsRef) base.vodSettingsRef = new VodSettingsRef(client);
                return base.vodSettingsRef;
            },
            secrets: function () {
                if (!base.secretsRef) base.secretsRef = new SecretsRef(client);
                return base.secretsRef;
            }
        };
        client.probes = {
            vlmEndpoint: function (request) { return base.raw.probeVlmEndpoint(request); }
        };
        client.vod = { files: new VodFiles(client), jobs: new VodJobs(client) };
    }

    function VifClient(options) {
        options = options || {};
        initFacade(this, {
            raw: new RawClient(options.transport || httpTransport(options)),
            runtimeRefs: {},
            overrideRefs: {},
            streamGroupConfigEtags: {},
            defaultConfigRef: null,
            vodSettingsRef: null,
            secretsRef: null
        }, options.application);
    }

    // A cheap re-scoped view: same transport, credentials and revision caches,
    // different application default.
    VifClient.prototype.for = function (application) {
        var view = Object.create(VifClient.prototype);
        initFacade(view, this.__base, application);
        return view;
    };

    VifClient.prototype.status = function () {
        return this.raw.getServerStatus();
    };

    VifClient.prototype.models = function () {
        return this.raw.getModelCatalog();
    };

    VifClient.prototype.listenerTypes = function () {
        return this.raw.listListenerTypes();
    };

    VIF.sdk = {
        BASE_PATH: BASE_PATH,
        VifClient: VifClient,
        RawClient: RawClient,
        httpTransport: httpTransport,

        Detector: Detector,
        SceneDetector: SceneDetector,
        ObjectDetector: ObjectDetector,
        VlmDetector: VlmDetector,
        SyntheticDetector: SyntheticDetector,
        detectorFrom: detectorFrom,

        Listener: Listener,
        OverlayListener: OverlayListener,
        WebhookListener: WebhookListener,
        Id3Listener: Id3Listener,
        LogListener: LogListener,
        CustomListener: CustomListener,
        listenerFrom: listenerFrom,

        StreamGroupConfig: StreamGroupConfig,
        DefaultConfig: DefaultConfig,
        Stream: Stream,
        StreamConfigOverride: StreamConfigOverride,
        VodSettings: VodSettings,

        VifError: VifError,
        NotFoundError: NotFoundError,
        ConflictError: ConflictError,
        AlreadyExistsError: AlreadyExistsError,
        RevisionConflictError: RevisionConflictError,
        PreconditionRequiredError: PreconditionRequiredError,
        AuthError: AuthError,
        LicenseError: LicenseError,
        TransportError: TransportError,
        RouteUnavailableError: RouteUnavailableError,

        // Maps an HTTP status + body to the error class the facade expects; a
        // custom transport (the UI test harness's stub) must reject with these.
        errorFor: errorFor,

        toWire: toWire,
        fromWire: fromWire
    };
})();
