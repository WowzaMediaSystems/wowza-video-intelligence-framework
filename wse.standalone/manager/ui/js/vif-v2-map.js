// vif-v2-map.js - the v1-flat <-> v2-document adapter.
//
// The Manager pages were written against the v1 REST API's flat config shape
// (app_name/stream_name, *_analysis blocks, vif_event_listeners), and they keep
// speaking it - populateForm/buildConfigJson, the field registry, the listener
// editor and the dashboard renderer - while the network layer speaks v2. This
// file is the whole translation, so the pages' shape and the wire's shape can
// disagree without either bending.
//
// Both sides of every function are PLAIN DATA. The v2 side is the SDK's
// camelCase view of the wire (vif-sdk.js fromWire: keys camelCase, values under
// opaque keys - classHints, classSensitivity, responseSchema, properties,
// vlmDefaults, concurrentExecutions - verbatim); the v1 side is the flat
// snake_case shape the pages read and write. No DOM, no fetch, no globals: a
// pure module, tested from Node (src/test/js/vif-v2-map.test.js).
//
// Sparse stays sparse. A v1 GET answered the stream's own stored document, and
// the form deliberately renders unset fields as blanks over placeholder
// defaults - so the read direction maps only the members the v2 document
// actually sets, and never fills a gap with an inherited value.
//
// The write direction reproduces v1's own save semantics on the v2 wire:
//   - top-level scalars merge field by field, so a flat null (blank input)
//     is OMITTED from the patch - v1's merge ignored nulls and kept the stored
//     value - unless the field is named in unset_fields, which maps to a JSON
//     merge-patch null (unset, inherit again);
//   - the detector is emitted COMPLETE for its type with explicit null on
//     every blank member: a same-type v2 patch merges per member and only null
//     unsets, and this reproduces v1's net save effect (a complete block from
//     the form plus per-member unset_fields for the blanks - and a wholesale
//     replacement for vlm_analysis, the one block v1 replaced outright);
//   - listeners are emitted as the full name-keyed map plus null for every
//     name removed since the form was populated - v1 replaced the map;
//   - secret members (api keys, the TLS client key) are TRI-STATE and never
//     follow the null rules above: undefined = untouched = omitted (the server
//     keeps its stored value), '' = explicitly cleared, anything else = set.
//     The caller decides which via secretValue().
//
// Fractions stay 0-1 end to end: the flat shape already stores them that way
// (percent is DOM-only, applied and removed by the form code), so this file
// performs no /100 or *100 anywhere.
(function () {
    'use strict';

    window.VIF = window.VIF || {};

    // Fields whose values are credentials, by their flat name. These follow the
    // tri-state write rule and are never echoed by a v2 read.
    //
    // Their *_secret counterparts are deliberately NOT here: a reference is a NAME, echoed
    // by every read, and round-trips like any ordinary member — vi_service_api_key_secret
    // rides SCALAR_PATHS below and the detector references ride the detector builders.
    var SECRET_FLAT_PATHS = {
        'vi_service_api_key': ['config', 'service', 'apiKey'],
        'vlm_analysis.api_key': ['config', 'detector', 'endpoint', 'apiKey'],
        'synthetic_analysis.api_key': ['config', 'detector', 'endpoint', 'apiKey'],
        'synthetic_analysis.tls_client_key': ['config', 'detector', 'endpoint', 'tls', 'clientKey']
    };

    // Top-level flat scalars and where they live in a v2 document. ignore_untracked_objects
    // is deliberately absent: v1 stores it stream-level but v2 carries it inside the object
    // detector's tracking section, so the detector builders own it.
    var SCALAR_PATHS = {
        active: ['config', 'active'],
        inference_fps: ['config', 'processing', 'inferenceFps'],
        duration: ['config', 'processing', 'windowSeconds'],
        inference_video_height: ['config', 'processing', 'videoHeight'],
        grayscaled: ['config', 'processing', 'grayscale'],
        frame_grab_interval: ['config', 'processing', 'grabIntervalSeconds'],
        auto_frame_throttle: ['config', 'processing', 'autoThrottle'],
        catch_up_to_live: ['config', 'processing', 'catchUp', 'enabled'],
        catch_up_max_behind_seconds: ['config', 'processing', 'catchUp', 'maxBehindSeconds'],
        rollup_batch_interval: ['config', 'processing', 'rollupIntervalSeconds'],
        frame_buffer: ['config', 'processing', 'bufferFrames'],
        gpu_ids: ['config', 'processing', 'gpuIds'],
        vi_service_url: ['config', 'service', 'url'],
        vi_service_api_key_secret: ['config', 'service', 'apiKeySecret'],
        model_idle_timeout_seconds: ['config', 'service', 'modelIdleTimeoutSeconds'],
        save_images: ['config', 'diagnostics', 'saveImages'],
        log_timing: ['config', 'diagnostics', 'timingLogSeconds'],
        log_max_messages: ['config', 'diagnostics', 'maxLoggedMessages']
    };

    // use_transcoder is boolean in v1 and an enum in v2; handled beside the table.
    var FRAME_SOURCE = { true: 'transcoder', false: 'grab' };

    function isSet(value) { return value !== undefined && value !== null; }

    function put(target, path, value) {
        var node = target;
        for (var i = 0; i < path.length - 1; i++) {
            if (!node[path[i]]) node[path[i]] = {};
            node = node[path[i]];
        }
        node[path[path.length - 1]] = value;
    }

    /** Copies `value` to `target[key]` only when the source member is set. */
    function carry(target, key, value) {
        if (value !== undefined && value !== null) target[key] = value;
    }

    /**
     * A typed value without the whitespace a paste brings along; a blank stays the blank
     * it is, since a cleared member has to travel as one. The server trims these three
     * the same way, so what the form shows is what the document holds.
     */
    function trimmed(value) {
        return typeof value === 'string' ? value.trim() : value;
    }

    /** An object with no own keys reads as "not there" on both sides. */
    function sparse(object) {
        return Object.keys(object).length === 0 ? undefined : object;
    }

    // ── deriveName ───────────────────────────────────────────────────────────

    // 1:1 port of ConfigInfo.toValidFileName: the name a created stream group
    // config takes is the base name of the file the server will store it in.
    function fileNamePart(raw) {
        return String(raw)
            .split('.').join('Dot')
            .split('*').join('Star')
            .split('?').join('Question')
            .split('+').join('Plus')
            .split('^').join('Caret')
            .split('$').join('Dollar')
            .split('|').join('Pipe')
            .split('(').join('LParen')
            .split(')').join('RParen')
            .split('[').join('LBracket')
            .split(']').join('RBracket')
            .split('{').join('LBrace')
            .split('}').join('RBrace')
            .split('\\').join('Backslash')
            .split('/').join('Slash')
            .split(' ').join('_');
    }

    function deriveName(app, pattern) {
        return fileNamePart(app) + '_' + fileNamePart(pattern);
    }

    // ── listeners ────────────────────────────────────────────────────────────

    var LISTENER_CLASS_BY_TYPE = {
        overlay: 'OverlayEvent',
        webhook: 'WebhookEvent2',
        id3: 'Id3Event',
        log: 'LogFileEvent'
    };

    // The overlay listener's typed v2 members and their v1 property names.
    var OVERLAY_PROPS = [
        ['width', 'width'], ['height', 'height'], ['frameRate', 'frame_rate'],
        ['overlayDelay', 'overlay_delay'], ['fadeStep', 'fade_step'], ['jitter', 'jitter'],
        ['replaceVideo', 'replace_video'], ['showStats', 'show_stats'], ['debugString', 'debug_string']
    ];

    function listenerTypeOf(className) {
        var name = className || '';
        if (name.indexOf('OverlayEvent') !== -1) return 'overlay';
        if (name.indexOf('WebhookEvent') !== -1) return 'webhook';
        if (name.indexOf('Id3Event') !== -1) return 'id3';
        if (name.indexOf('LogFileEvent') !== -1) return 'log';
        return 'custom';
    }

    function hasMethod(methods, wanted) {
        return (methods || []).some(function (m) {
            return String(m).toLowerCase() === wanted;
        });
    }

    /** One v2 listener document -> the v1 entry shape the listener editor renders. */
    function listenerToV1(listener) {
        var entry = {
            class_name: listener.type === 'custom'
                ? listener.className
                : LISTENER_CLASS_BY_TYPE[listener.type]
        };
        // v1 stores the firing rule as a methods array; 'disabled' is a member of
        // it rather than a flag of its own.
        entry.methods = listener.enabled === false
            ? ['disabled']
            : (listener.trigger ? [listener.trigger] : []);
        carry(entry, 'confidence_threshold', listener.minConfidence);
        carry(entry, 'suppress_empty_detections', listener.suppressEmpty);

        var properties = {};
        if (listener.type === 'overlay') {
            OVERLAY_PROPS.forEach(function (pair) { carry(properties, pair[1], listener[pair[0]]); });
        } else if (listener.type === 'webhook') {
            carry(properties, 'url', listener.url);
            carry(properties, 'credential_secret', listener.credentialSecret);
            carry(properties, 'credential_header', listener.credentialHeader);
        } else if (listener.type === 'log') {
            carry(properties, 'log_file_name', listener.fileName);
            carry(properties, 'log_file_path', listener.filePath);
        } else if (listener.type === 'custom' && listener.properties) {
            properties = listener.properties;
        }
        if (sparse(properties)) entry.properties = properties;
        return entry;
    }

    /** One v1 listener entry -> the v2 listener document. */
    function listenerFromV1(entry) {
        var type = listenerTypeOf(entry.class_name);
        var listener = { type: type };
        if (type === 'custom') listener.className = entry.class_name;

        var methods = entry.methods || [];
        listener.enabled = !hasMethod(methods, 'disabled');
        var trigger = null;
        if (hasMethod(methods, 'immediate')) trigger = 'immediate';
        else if (hasMethod(methods, 'batch')) trigger = 'batch';
        else if (hasMethod(methods, 'rollup')) trigger = 'rollup';
        if (trigger) listener.trigger = trigger;

        carry(listener, 'minConfidence', entry.confidence_threshold);
        carry(listener, 'suppressEmpty', entry.suppress_empty_detections);

        var properties = entry.properties || {};
        if (type === 'overlay') {
            OVERLAY_PROPS.forEach(function (pair) { carry(listener, pair[0], properties[pair[1]]); });
        } else if (type === 'webhook') {
            carry(listener, 'url', trimmed(properties.url));
            // A NAME, not a value: it round-trips like any ordinary member rather than
            // through the credential tri-state, and the page emits the whole listener
            // map on every save - dropping it here would erase it from disk.
            carry(listener, 'credentialSecret', trimmed(properties.credential_secret));
            carry(listener, 'credentialHeader', trimmed(properties.credential_header));
        } else if (type === 'log') {
            carry(listener, 'fileName', properties.log_file_name);
            carry(listener, 'filePath', properties.log_file_path);
        } else if (type === 'custom' && sparse(properties)) {
            listener.properties = properties;
        }
        return listener;
    }

    function listenersToV1(listeners) {
        var out = {};
        Object.keys(listeners || {}).forEach(function (name) {
            out[name] = listenerToV1(listeners[name]);
        });
        return out;
    }

    /**
     * The listeners member of a write: the full map the form now holds, plus null
     * for every name it held when populated - v1 replaced the whole map, and in a
     * merge patch only an explicit null removes an entry.
     */
    function listenersPatchFromV1(currentMap, previousMap) {
        var patch = {};
        Object.keys(currentMap || {}).forEach(function (name) {
            patch[name] = listenerFromV1(currentMap[name]);
        });
        Object.keys(previousMap || {}).forEach(function (name) {
            if (!(name in patch)) patch[name] = null;
        });
        return patch;
    }

    // ── detectors: v2 -> v1 flat ─────────────────────────────────────────────

    function flatObjectAnalysis(detector) {
        var oa = {};
        carry(oa, 'class_names', detector.classes);
        // v1 stores "custom" as the model name beside the checkpoint path; v2 drops
        // the placeholder and keeps the path alone.
        if (isSet(detector.model)) oa.model_name = detector.model;
        else if (isSet(detector.checkpointPath)) oa.model_name = 'custom';
        carry(oa, 'checkpoint_path', detector.checkpointPath);
        carry(oa, 'confidence_threshold', detector.minConfidence);
        var tracking = detector.tracking;
        if (tracking) {
            carry(oa, 'tracking_method', tracking.method);
            var bt = {};
            carry(bt, 'track_creation_minimum_confidence', tracking.minConfidenceToCreate);
            carry(bt, 'track_creation_minimum_consecutive_frames', tracking.minConsecutiveFrames);
            carry(bt, 'minimum_consecutive_track_overlap', tracking.minOverlap);
            carry(bt, 'max_lost_track_frames_before_track_removal', tracking.maxLostFrames);
            if (sparse(bt)) oa.byte_track_properties = bt;
        }
        var tiling = detector.tiling;
        if (tiling) {
            carry(oa, 'tiling_mode', tiling.mode);
            var tp = {};
            if (tiling.minGrid) {
                carry(tp, 'min_slice_rows', tiling.minGrid.rows);
                carry(tp, 'min_slice_cols', tiling.minGrid.cols);
            }
            if (tiling.maxGrid) {
                carry(tp, 'max_slice_rows', tiling.maxGrid.rows);
                carry(tp, 'max_slice_cols', tiling.maxGrid.cols);
            }
            carry(tp, 'tile_coverage_cutoff', tiling.tileCoverageCutoff);
            carry(tp, 'full_frame_detection', tiling.fullFramePass);
            carry(tp, 'cluster_suppression_min_children', tiling.clusterSuppressionMinChildren);
            if (sparse(tp)) oa.tiling_properties = tp;
        }
        return oa;
    }

    function flatSceneAnalysis(detector) {
        var sa = {};
        carry(sa, 'class_names', detector.classes);
        carry(sa, 'sensitivity', detector.sensitivity);
        carry(sa, 'confidence_threshold', detector.minConfidence);
        carry(sa, 'class_sensitivity', detector.classSensitivity);
        if (detector.baseline) {
            carry(sa, 'baseline_class_set', detector.baseline.set);
            carry(sa, 'custom_baseline_classes', detector.baseline.customClasses);
        }
        return sa;
    }

    function flatVlmAnalysis(detector) {
        var va = {};
        var endpoint = detector.endpoint || {};
        carry(va, 'endpoint_url', endpoint.url);
        carry(va, 'model_name', endpoint.model);
        carry(va, 'api_key_secret', endpoint.apiKeySecret);
        carry(va, 'request_timeout_seconds', endpoint.timeoutSeconds);
        carry(va, 'max_concurrent_requests', endpoint.maxConcurrentRequests);
        // The mode is explicit in v2; flattened back, only the active mode's
        // fields are emitted, so the form re-infers the same mode from field
        // presence (the rule VIS also reads stored blocks by) and the round
        // trip cannot change it.
        if (detector.mode === 'detect' && detector.detect) {
            carry(va, 'class_names', detector.detect.classes);
            carry(va, 'class_hints', detector.detect.classHints);
            carry(va, 'reasoning_level', detector.detect.reasoningLevel);
        } else if (detector.mode === 'custom' && detector.custom) {
            if (detector.custom.prompt) {
                carry(va, 'system_prompt', detector.custom.prompt.system);
                carry(va, 'user_prompt', detector.custom.prompt.user);
            }
            carry(va, 'response_schema', detector.custom.responseSchema);
            carry(va, 'class_names', detector.custom.classes);
            carry(va, 'class_hints', detector.custom.classHints);
        }
        if (detector.generation) {
            carry(va, 'temperature', detector.generation.temperature);
            carry(va, 'max_tokens', detector.generation.maxTokens);
        }
        return va;
    }

    function flatMotionAnalysis(detector) {
        var ma = {};
        carry(ma, 'sensitivity', detector.sensitivity);
        carry(ma, 'min_displacement', detector.minDisplacement);
        carry(ma, 'merge_distance', detector.mergeDistance);
        carry(ma, 'suppress_global_changes', detector.suppressGlobalChanges);
        return ma;
    }

    function flatSyntheticAnalysis(detector) {
        var sy = {};
        var endpoint = detector.endpoint || {};
        carry(sy, 'endpoint', endpoint.address);
        carry(sy, 'api_key_secret', endpoint.apiKeySecret);
        if (endpoint.tls) {
            carry(sy, 'use_tls', endpoint.tls.enabled);
            carry(sy, 'tls_ca_cert', endpoint.tls.caCert);
            carry(sy, 'tls_client_cert', endpoint.tls.clientCert);
            carry(sy, 'tls_client_key_secret', endpoint.tls.clientKeySecret);
        }
        carry(sy, 'function_id', endpoint.functionId);
        carry(sy, 'request_timeout_seconds', endpoint.timeoutSeconds);
        carry(sy, 'max_concurrent_requests', endpoint.maxConcurrentRequests);
        carry(sy, 'classification_threshold', detector.classificationThreshold);
        return sy;
    }

    /**
     * A verify detector as the pages read it: the scoring endpoint in the synthetic
     * block's shape, the review endpoint in the VLM block's, and the two thresholds.
     */
    function flatVerifyAnalysis(detector) {
        var vf = {};
        carry(vf, 'flag_threshold', detector.flagThreshold);
        carry(vf, 'strong_threshold', detector.strongThreshold);
        vf.svd = flatSyntheticAnalysis({ endpoint: detector.endpoint });
        vf.vlm = flatVlmAnalysis({ endpoint: detector.review });
        return vf;
    }

    var FLAT_ANALYSIS = {
        object: ['object_analysis', flatObjectAnalysis],
        scene: ['scene_analysis', flatSceneAnalysis],
        vlm: ['vlm_analysis', flatVlmAnalysis],
        motion: ['motion_analysis', flatMotionAnalysis],
        synthetic: ['synthetic_analysis', flatSyntheticAnalysis],
        verify: ['verify_analysis', flatVerifyAnalysis],
        chain: ['chain_detector', function (detector) { return JSON.parse(JSON.stringify(detector)); }]
    };

    // ── config: v2 -> v1 flat ────────────────────────────────────────────────

    /** A v2 config member -> the flat members the pages read. Sparse in, sparse out. */
    function flatFromConfig(config) {
        var flat = {};
        config = config || {};
        carry(flat, 'active', config.active);

        var detector = config.detector;
        if (detector && detector.type) {
            flat.detector_type = detector.type;
            var mapping = FLAT_ANALYSIS[detector.type];
            flat[mapping[0]] = mapping[1](detector);
            if (detector.type === 'verify') {
                // The form edits the two endpoints in the synthetic and VLM blocks it
                // already has; the verify block keeps the thresholds alone.
                flat.synthetic_analysis = flat.verify_analysis.svd;
                flat.vlm_analysis = flat.verify_analysis.vlm;
                delete flat.verify_analysis.svd;
                delete flat.verify_analysis.vlm;
            }
            if (detector.type === 'object' && detector.tracking) {
                // Stream-level in v1, a tracking member in v2.
                carry(flat, 'ignore_untracked_objects', detector.tracking.ignoreUntracked);
            }
        }

        if (config.listeners) flat.vif_event_listeners = listenersToV1(config.listeners);

        var processing = config.processing || {};
        carry(flat, 'inference_fps', processing.inferenceFps);
        carry(flat, 'duration', processing.windowSeconds);
        carry(flat, 'inference_video_height', processing.videoHeight);
        carry(flat, 'grayscaled', processing.grayscale);
        if (isSet(processing.frameSource)) flat.use_transcoder = processing.frameSource === 'transcoder';
        carry(flat, 'frame_grab_interval', processing.grabIntervalSeconds);
        carry(flat, 'frame_buffer', processing.bufferFrames);
        carry(flat, 'auto_frame_throttle', processing.autoThrottle);
        if (processing.catchUp) {
            carry(flat, 'catch_up_to_live', processing.catchUp.enabled);
            carry(flat, 'catch_up_max_behind_seconds', processing.catchUp.maxBehindSeconds);
        }
        carry(flat, 'rollup_batch_interval', processing.rollupIntervalSeconds);
        carry(flat, 'gpu_ids', processing.gpuIds);

        var service = config.service || {};
        carry(flat, 'vi_service_url', service.url);
        carry(flat, 'vi_service_api_key_secret', service.apiKeySecret);
        carry(flat, 'model_idle_timeout_seconds', service.modelIdleTimeoutSeconds);

        var diagnostics = config.diagnostics || {};
        carry(flat, 'save_images', diagnostics.saveImages);
        carry(flat, 'log_timing', diagnostics.timingLogSeconds);
        carry(flat, 'log_max_messages', diagnostics.maxLoggedMessages);
        return flat;
    }

    /** A stream group config document -> the flat config the stream-config page edits. */
    function flatFromGroup(group) {
        var flat = flatFromConfig(group.config);
        if (group.match) {
            carry(flat, 'app_name', group.match.application);
            carry(flat, 'stream_name', group.match.streamPattern);
            carry(flat, 'priority_id', group.match.priority);
        }
        return flat;
    }

    /** A per-stream override document (listed or fetched) -> the same flat shape. */
    function flatFromOverride(app, stream, override) {
        var flat = flatFromConfig(override.config);
        flat.app_name = app;
        flat.stream_name = stream;
        return flat;
    }

    /**
     * The default config document (+ the model catalog and listener-type
     * listing) -> the flat defaultConfig global the pages were written against:
     * v1 GET /config carried the catalog and the listener versions inline.
     */
    function flatDefaultFromV2(defaultDoc, modelCatalog, listenerTypes) {
        var flat = flatFromConfig(defaultDoc.config);
        var detectors = defaultDoc.detectors || {};
        Object.keys(FLAT_ANALYSIS).forEach(function (type) {
            if (detectors[type]) flat[FLAT_ANALYSIS[type][0]] = FLAT_ANALYSIS[type][1](detectors[type]);
        });
        carry(flat, 'concurrent_executions', defaultDoc.concurrentExecutions);
        if (modelCatalog) {
            flat.available_models = modelsFromV2(modelCatalog);
            carry(flat, 'vlm_defaults', modelCatalog.vlmDefaults);
        }
        if (listenerTypes) {
            var byName = {};
            listenerTypes.forEach(function (type) { byName[type.name] = type.version; });
            flat.available_event_listeners = byName;
        }
        return flat;
    }

    function modelsFromV2(catalog) {
        return {
            models: (catalog.models || []).map(function (model) {
                var entry = {};
                carry(entry, 'name', model.name);
                carry(entry, 'type', model.type);
                carry(entry, 'class_set', model.classSet);
                carry(entry, 'is_custom', model.custom);
                carry(entry, 'checkpoint_path', model.checkpointPath);
                carry(entry, 'available_classes', model.classes);
                return entry;
            })
        };
    }

    // ── status: v2 -> v1 flat ────────────────────────────────────────────────

    /** The model name v1's status reported, derived the way the server derived it. */
    function modelNameOf(detector) {
        if (!detector) return undefined;
        switch (detector.type) {
            case 'object':
                if (isSet(detector.model)) return detector.model;
                return isSet(detector.checkpointPath) ? 'custom' : undefined;
            case 'scene': return 'vifi_clip';
            case 'vlm': return detector.endpoint ? detector.endpoint.model : undefined;
            case 'synthetic': return 'synthetic';
            default: return undefined;
        }
    }

    /** One runtime stream document -> the flat row the dashboard renders. */
    function streamRowFromV2(stream) {
        var row = {
            app_name: stream.application,
            stream_name: stream.name
        };
        var config = stream.config || {};
        carry(row, 'active', config.active);
        if (config.detector) {
            carry(row, 'detector_type', config.detector.type);
            carry(row, 'model_name', modelNameOf(config.detector));
        }
        var processing = config.processing || {};
        carry(row, 'duration', processing.windowSeconds);
        if (isSet(processing.frameSource)) row.use_transcoder = processing.frameSource === 'transcoder';
        carry(row, 'frame_grab_interval', processing.grabIntervalSeconds);
        carry(row, 'inference_fps', processing.inferenceFps);
        if (config.service) carry(row, 'vi_service_url', config.service.url);
        if (config.listeners) row.vif_event_listeners = listenersToV1(config.listeners);

        var video = stream.video || {};
        carry(row, 'width', video.width);
        carry(row, 'height', video.height);
        carry(row, 'frame_rate', video.frameRate);
        carry(row, 'gop_size', video.gopSize);

        var state = stream.state || {};
        carry(row, 'status', state.connection);
        carry(row, 'endpoint_degraded', state.endpointDegraded);
        // The v1 field was an empty string, never null - the renderer prints it.
        row.reason = isSet(state.reason) ? state.reason : '';
        carry(row, 'vi_service_version', state.serviceVersion);
        if (state.performance) {
            var perf = state.performance;
            var flatPerf = {};
            carry(flatPerf, 'ping_rtt_avg', perf.pingRttAvg);
            carry(flatPerf, 'preprocess_time_avg', perf.preprocessTimeAvg);
            carry(flatPerf, 'inference_time_avg', perf.inferenceTimeAvg);
            carry(flatPerf, 'postprocess_time_avg', perf.postprocessTimeAvg);
            carry(flatPerf, 'total_processing_time_avg', perf.totalProcessingTimeAvg);
            carry(flatPerf, 'frame_detect_time_avg', perf.frameDetectTimeAvg);
            carry(flatPerf, 'frame_window', perf.frameWindow);
            carry(flatPerf, 'video_frames_ttl', perf.videoFramesTotal);
            carry(flatPerf, 'frames_detected', perf.framesDetected);
            row.performance = flatPerf;
        }
        carry(row, 'ephemeral_changes', stream.ephemeralChanges);
        return row;
    }

    /** The v2 host block -> v1's, whose GPU figures were per-GPU maps keyed by index. */
    function hostFromV2(host) {
        host = host || {};
        var flat = {};
        carry(flat, 'wse_version', host.wseVersion);
        carry(flat, 'vif_module_version', host.vifModuleVersion);
        carry(flat, 'cpu_avg', host.cpuAvg);
        if (host.gpu) {
            carry(flat, 'nvidia_gpu_type', host.gpu.model);
            carry(flat, 'nvidia_driver_version', host.gpu.driverVersion);
            carry(flat, 'cuda_version', host.gpu.cudaVersion);
            if (Array.isArray(host.gpu.devices) && host.gpu.devices.length) {
                flat.gpu_avg = {};
                flat.gpu_memory_avg = {};
                flat.gpu_encode_avg = {};
                flat.gpu_decode_avg = {};
                host.gpu.devices.forEach(function (device) {
                    if (device.id == null) return;
                    var id = String(device.id);
                    // Keep null entries so a device with a missing metric remains a row.
                    flat.gpu_avg[id] = isSet(device.utilizationAvg) ? device.utilizationAvg : null;
                    flat.gpu_memory_avg[id] = isSet(device.memoryAvg) ? device.memoryAvg : null;
                    flat.gpu_encode_avg[id] = isSet(device.encodeAvg) ? device.encodeAvg : null;
                    flat.gpu_decode_avg[id] = isSet(device.decodeAvg) ? device.decodeAvg : null;
                });
            } else {
                if (isSet(host.gpu.utilizationAvg)) flat.gpu_avg = { 0: host.gpu.utilizationAvg };
                if (isSet(host.gpu.memoryAvg)) flat.gpu_memory_avg = { 0: host.gpu.memoryAvg };
                if (isSet(host.gpu.encodeAvg)) flat.gpu_encode_avg = { 0: host.gpu.encodeAvg };
                if (isSet(host.gpu.decodeAvg)) flat.gpu_decode_avg = { 0: host.gpu.decodeAvg };
            }
        } else {
            // The v1 renderer gates its GPU cards on this exact sentinel.
            flat.nvidia_gpu_type = 'unknown';
        }
        return flat;
    }

    function visInstancesFromV2(instances) {
        return (instances || []).map(function (vis) {
            var flat = {
                host: vis.host,
                url: vis.url,
                reachable: vis.reachable
            };
            carry(flat, 'version', vis.version);
            carry(flat, 'age_seconds', vis.ageSeconds);
            // null means "no CPU gauge", which the renderer distinguishes from 0.
            flat.cpu_pct = isSet(vis.cpuPct) ? vis.cpuPct : null;
            carry(flat, 'streams', vis.streamNames);
            if (vis.gpus) {
                flat.gpus = vis.gpus.map(function (gpu) {
                    var entry = {};
                    carry(entry, 'device', gpu.name);
                    carry(entry, 'utilization_pct', gpu.utilizationPct);
                    if (isSet(gpu.memoryUsedMb)) entry.memory_used_bytes = gpu.memoryUsedMb * 1048576;
                    if (isSet(gpu.memoryTotalMb)) entry.memory_total_bytes = gpu.memoryTotalMb * 1048576;
                    return entry;
                });
            }
            return flat;
        });
    }

    // ── detectors: v1 flat -> v2 write ───────────────────────────────────────

    // Blank detector members ride as explicit null: in a same-type v2 patch
    // only null unsets, and clearing a member that was never stored is a no-op,
    // so this lands where v1's complete-block-plus-unset_fields saves landed.
    function orNull(value) { return isSet(value) ? value : null; }

    function writeObjectDetector(flat) {
        var oa = flat.object_analysis || {};
        var detector = {
            type: 'object',
            classes: orNull(oa.class_names),
            model: (isSet(oa.model_name) && oa.model_name !== 'custom') ? oa.model_name : null,
            checkpointPath: oa.model_name === 'custom' ? orNull(oa.checkpoint_path) : null,
            minConfidence: orNull(oa.confidence_threshold)
        };
        if (oa.tracking_method === 'byte-track') {
            var bt = oa.byte_track_properties || {};
            detector.tracking = {
                method: 'byte-track',
                minConfidenceToCreate: orNull(bt.track_creation_minimum_confidence),
                minConsecutiveFrames: orNull(bt.track_creation_minimum_consecutive_frames),
                minOverlap: orNull(bt.minimum_consecutive_track_overlap),
                maxLostFrames: orNull(bt.max_lost_track_frames_before_track_removal),
                ignoreUntracked: orNull(flat.ignore_untracked_objects)
            };
        } else if (isSet(oa.tracking_method)) {
            detector.tracking = { method: oa.tracking_method };
        } else {
            detector.tracking = null;
        }
        if (isSet(oa.tiling_mode) && oa.tiling_mode !== 'none') {
            var tp = oa.tiling_properties || {};
            detector.tiling = {
                mode: oa.tiling_mode,
                minGrid: grid(tp.min_slice_rows, tp.min_slice_cols),
                maxGrid: grid(tp.max_slice_rows, tp.max_slice_cols),
                tileCoverageCutoff: orNull(tp.tile_coverage_cutoff),
                fullFramePass: orNull(tp.full_frame_detection),
                clusterSuppressionMinChildren: orNull(tp.cluster_suppression_min_children)
            };
        } else if (oa.tiling_mode === 'none') {
            detector.tiling = { mode: 'none' };
        } else {
            detector.tiling = null;
        }
        return detector;
    }

    function grid(rows, cols) {
        return isSet(rows) && isSet(cols) ? { rows: rows, cols: cols } : null;
    }

    function writeSceneDetector(flat) {
        var sa = flat.scene_analysis || {};
        var detector = {
            type: 'scene',
            classes: orNull(sa.class_names),
            sensitivity: orNull(sa.sensitivity),
            minConfidence: orNull(sa.confidence_threshold)
        };
        // Hand-written configs only; the form does not edit these, and null would
        // unset what it cannot show.
        if (isSet(sa.class_sensitivity)) detector.classSensitivity = sa.class_sensitivity;
        if (isSet(sa.baseline_class_set) || isSet(sa.custom_baseline_classes)) {
            detector.baseline = {
                set: orNull(sa.baseline_class_set),
                customClasses: orNull(sa.custom_baseline_classes)
            };
        }
        return detector;
    }

    function writeMotionDetector(flat) {
        var ma = flat.motion_analysis || {};
        return {
            type: 'motion',
            sensitivity: orNull(ma.sensitivity),
            minDisplacement: orNull(ma.min_displacement),
            mergeDistance: orNull(ma.merge_distance),
            suppressGlobalChanges: orNull(ma.suppress_global_changes)
        };
    }

    /** The analysis family the flat block describes - the same presence rule VIS and the form use. */
    function vlmModeOf(va) {
        if (isSet(va.system_prompt) || isSet(va.user_prompt) || isSet(va.response_schema)) return 'custom';
        if (isSet(va.reasoning_level)) return 'detect';
        if (va.class_names && va.class_names.length > 0) return 'detect';
        return 'describe';
    }

    function writeVlmDetector(flat, secrets) {
        var va = flat.vlm_analysis || {};
        var mode = vlmModeOf(va);
        var detector = {
            type: 'vlm',
            mode: mode,
            endpoint: {
                url: orNull(va.endpoint_url),
                model: orNull(va.model_name),
                timeoutSeconds: orNull(va.request_timeout_seconds)
            },
            generation: {
                temperature: orNull(va.temperature),
                maxTokens: orNull(va.max_tokens)
            },
            detect: null,
            custom: null
        };
        // A reference is an ordinary member: written when set, null when not — the null is
        // what lets a save that switched the slot back to a literal clear the stored name.
        detector.endpoint.apiKeySecret = orNull(va.api_key_secret);
        putSecret(detector.endpoint, 'apiKey', secrets, 'vlm_analysis.api_key', va.api_key);
        if (mode === 'detect') {
            detector.detect = {
                classes: va.class_names || [],
                classHints: orNull(va.class_hints),
                reasoningLevel: (va.reasoning_level === 'low' || va.reasoning_level === 'medium')
                    ? va.reasoning_level : null
            };
        } else if (mode === 'custom') {
            detector.custom = {
                prompt: {
                    system: orNull(va.system_prompt),
                    user: orNull(va.user_prompt)
                },
                responseSchema: orNull(va.response_schema),
                classes: (va.class_names && va.class_names.length > 0) ? va.class_names : null,
                classHints: orNull(va.class_hints)
            };
        }
        return detector;
    }

    function writeSyntheticDetector(flat, secrets) {
        var sy = flat.synthetic_analysis || {};
        var detector = {
            type: 'synthetic',
            endpoint: {
                address: orNull(sy.endpoint),
                // The references are ordinary members: written when set, null when not.
                apiKeySecret: orNull(sy.api_key_secret),
                functionId: orNull(sy.function_id),
                tls: {
                    enabled: orNull(sy.use_tls),
                    caCert: orNull(sy.tls_ca_cert),
                    clientCert: orNull(sy.tls_client_cert),
                    clientKeySecret: orNull(sy.tls_client_key_secret)
                }
            },
            classificationThreshold: orNull(sy.classification_threshold)
        };
        putSecret(detector.endpoint, 'apiKey', secrets, 'synthetic_analysis.api_key', sy.api_key);
        putSecret(detector.endpoint.tls, 'clientKey', secrets, 'synthetic_analysis.tls_client_key', sy.tls_client_key);
        return detector;
    }

    /**
     * A secret member's write value: `secrets[flatPath]`, when given, is the
     * tri-state from secretValue() (undefined keep, '' clear, value set);
     * otherwise the flat value applies with set-or-keep semantics (a value
     * sets, null/absent keeps). undefined means "leave it out of the write".
     */
    function secretOf(secrets, flatPath, flatValue) {
        if (secrets && flatPath in secrets) return secrets[flatPath];
        return isSet(flatValue) && flatValue !== '' ? flatValue : undefined;
    }

    function putSecret(target, key, secrets, flatPath, flatValue) {
        var value = secretOf(secrets, flatPath, flatValue);
        if (value !== undefined) target[key] = value;
    }

    function writeVerifyDetector(flat, secrets) {
        var sy = flat.synthetic_analysis || {};
        var va = flat.vlm_analysis || {};
        var vf = flat.verify_analysis || {};
        var detector = {
            type: 'verify',
            flagThreshold: orNull(vf.flag_threshold),
            strongThreshold: orNull(vf.strong_threshold),
            endpoint: {
                address: orNull(sy.endpoint),
                apiKeySecret: orNull(sy.api_key_secret),
                functionId: orNull(sy.function_id),
                tls: {
                    enabled: orNull(sy.use_tls),
                    caCert: orNull(sy.tls_ca_cert),
                    clientCert: orNull(sy.tls_client_cert),
                    clientKeySecret: orNull(sy.tls_client_key_secret)
                }
            },
            review: {
                url: orNull(va.endpoint_url),
                model: orNull(va.model_name),
                apiKeySecret: orNull(va.api_key_secret),
                timeoutSeconds: orNull(va.request_timeout_seconds)
            }
        };
        putSecret(detector.endpoint, 'apiKey', secrets, 'synthetic_analysis.api_key', sy.api_key);
        putSecret(detector.endpoint.tls, 'clientKey', secrets, 'synthetic_analysis.tls_client_key', sy.tls_client_key);
        putSecret(detector.review, 'apiKey', secrets, 'vlm_analysis.api_key', va.api_key);
        return detector;
    }

    // Where each flat secret lands inside a chain stage's detector, by stage type.
    var STAGE_SECRET_MEMBERS = {
        vlm: { 'vlm_analysis.api_key': ['endpoint', 'apiKey'] },
        synthetic: {
            'synthetic_analysis.api_key': ['endpoint', 'apiKey'],
            'synthetic_analysis.tls_client_key': ['endpoint', 'tls', 'clientKey']
        }
    };

    /** The secrets-map key of a flat secret path scoped to one chain stage. */
    function stageSecretPath(stageName, flatPath) {
        return 'chain_stages.' + stageName + '.' + flatPath;
    }

    function stageSecrets(stageName, type, flat, touched, cleared) {
        var out = {};
        Object.keys(STAGE_SECRET_MEMBERS[type]).forEach(function (flatPath) {
            var parts = flatPath.split('.');
            var value = cleared.indexOf(flatPath) !== -1
                ? '' : secretValue(!!touched[flatPath], ((flat || {})[parts[0]] || {})[parts[1]]);
            if (value !== undefined) out[stageSecretPath(stageName, flatPath)] = value;
        });
        return out;
    }

    /**
     * The secrets-map entries for one VLM stage's save, keyed by stageSecretPath():
     * `flat` is the stage's flat section read, `touched` maps flat secret paths the
     * operator typed into. secretValue()'s tri-state applies.
     */
    function stageSecretsForVlm(stageName, flat, touched) {
        return stageSecrets(stageName, 'vlm', flat, touched, []);
    }

    /** As stageSecretsForVlm, for a synthetic stage on NVCF: its stored mTLS client key clears. */
    function stageSecretsForNvcfSvd(stageName, flat, touched) {
        return stageSecrets(stageName, 'synthetic', flat, touched, ['synthetic_analysis.tls_client_key']);
    }

    /** As stageSecretsForVlm, for a synthetic stage on a self-hosted endpoint: its stored NVCF key clears. */
    function stageSecretsForSelfHostedSvd(stageName, flat, touched) {
        return stageSecrets(stageName, 'synthetic', flat, touched, ['synthetic_analysis.api_key']);
    }

    function unsetPath(target, path) {
        var node = target;
        for (var i = 0; i < path.length - 1; i++) {
            if (!node[path[i]] || typeof node[path[i]] !== 'object') return;
            node = node[path[i]];
        }
        delete node[path[path.length - 1]];
    }

    function applyStageSecrets(stage, secrets) {
        var members = STAGE_SECRET_MEMBERS[stage.detector && stage.detector.type] || {};
        Object.keys(members).forEach(function (flatPath) {
            var key = stageSecretPath(stage.name, flatPath);
            if (!(key in secrets)) return;
            if (secrets[key] === undefined) unsetPath(stage.detector, members[flatPath]);
            else put(stage.detector, members[flatPath], secrets[key]);
        });
    }

    // Maps whose keys are operator data: the patch replaces them whole, member
    // merging would resurrect entries the form removed.
    var DETECTOR_PATCH_OPAQUE = { classHints: 1, classSensitivity: 1, responseSchema: 1 };

    function mergeDetectorMember(stored, patch) {
        var merged = {};
        if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
            Object.keys(stored).forEach(function (key) { merged[key] = stored[key]; });
        }
        Object.keys(patch).forEach(function (key) {
            var value = patch[key];
            if (value === null || value === undefined) { delete merged[key]; return; }
            if (typeof value === 'object' && !Array.isArray(value) && !DETECTOR_PATCH_OPAQUE[key]) {
                merged[key] = mergeDetectorMember(merged[key], value);
            } else {
                merged[key] = value;
            }
        });
        return merged;
    }

    /**
     * The next write value of a chain stage's detector. The detector writers emit
     * single-detector merge patches - a member with a value sets, null removes, an
     * absent member keeps what is stored - and for a standalone detector the server
     * applies them against the stored document. A chain's stages array replaces
     * wholesale, so the same semantics are applied here, against the detector the
     * stage loaded. Opaque members replace whole, a patch of another detector type
     * replaces everything, and stored secret members never ride along: a stage's
     * keys travel the secrets map and are kept server-side by stage name.
     */
    function applyDetectorPatch(stored, patch) {
        if (!stored || typeof stored !== 'object' || stored.type !== patch.type) {
            return mergeDetectorMember(null, patch);
        }
        var base = JSON.parse(JSON.stringify(stored));
        var members = STAGE_SECRET_MEMBERS[patch.type] || {};
        Object.keys(members).forEach(function (flatPath) { unsetPath(base, members[flatPath]); });
        return mergeDetectorMember(base, patch);
    }

    /**
     * The chain detector a save writes: `flat.chain_detector`, already collected by the
     * chain editor, with each stage's secrets applied from `secrets` keyed by
     * stageSecretPath(). A secret's absent value leaves the member out; '' clears it.
     *
     * The write is a merge patch, so an omitted chain-level member keeps its stored value
     * and only a null removes it. `flat.chain_detector_stored`, the detector the editor
     * loaded or last saved, makes removals reach the wire: each chain-level member and
     * decision-listener property it sets that the collected detector lacks rides as null.
     * A create passes no stored base and stays null-free.
     */
    function writeChainDetector(flat, secrets) {
        var detector = JSON.parse(JSON.stringify(flat.chain_detector || { type: 'chain', stages: [] }));
        (detector.stages || []).forEach(function (stage) {
            applyStageSecrets(stage, secrets || {});
        });
        if (flat.chain_detector_stored) nullChainRemovals(detector, flat.chain_detector_stored);
        return detector;
    }

    var CHAIN_LEVEL_MEMBERS = ['resultMode', 'maxRings', 'decisionTimeoutSeconds',
        'dispatchIntermediateRings', 'decisionListener'];

    function nullChainRemovals(detector, stored) {
        CHAIN_LEVEL_MEMBERS.forEach(function (member) {
            if (isSet(stored[member]) && !isSet(detector[member])) detector[member] = null;
        });
        var listener = detector.decisionListener;
        var storedListener = stored.decisionListener;
        if (!isObject(listener) || !isObject(storedListener) || !isObject(storedListener.properties)) return;
        if (!isSet(listener.properties)) {
            listener.properties = null;
        } else if (isObject(listener.properties)) {
            Object.keys(storedListener.properties).forEach(function (key) {
                if (!Object.prototype.hasOwnProperty.call(listener.properties, key)) listener.properties[key] = null;
            });
        }
    }

    function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }

    var WRITE_DETECTOR = {
        object: writeObjectDetector,
        scene: writeSceneDetector,
        vlm: writeVlmDetector,
        motion: writeMotionDetector,
        synthetic: writeSyntheticDetector,
        verify: writeVerifyDetector,
        chain: writeChainDetector
    };

    // ── config writes: v1 flat -> v2 patch / create body ─────────────────────

    /**
     * The merge patch a save emits, from the flat config buildConfigJson built.
     *
     * `options.previousListeners` is the v1 listener map the form was populated
     * with (so removals become nulls); `options.secrets` maps flat secret paths
     * to secretValue() results.
     */
    function configPatchFromFlat(flat, options) {
        options = options || {};
        var patch = {};

        // A secret named in unset_fields clears with '' (null would mean keep);
        // folded into the tri-state map so the detector builders below see it
        // too. An explicit secretValue() entry from the caller wins.
        var secrets = Object.assign({}, options.secrets);
        (flat.unset_fields || []).forEach(function (field) {
            if (SECRET_FLAT_PATHS[field] && !(field in secrets)) secrets[field] = '';
        });

        Object.keys(SCALAR_PATHS).forEach(function (field) {
            if (isSet(flat[field])) put(patch, SCALAR_PATHS[field], flat[field]);
        });
        if (isSet(flat.use_transcoder)) {
            put(patch, ['config', 'processing', 'frameSource'], FRAME_SOURCE[flat.use_transcoder]);
        }
        var serviceKey = secretOf(secrets, 'vi_service_api_key', flat.vi_service_api_key);
        if (serviceKey !== undefined) put(patch, ['config', 'service', 'apiKey'], serviceKey);

        // A flat null was v1's "keep the stored value" - unless the save names the
        // field in unset_fields, which is v1's explicit unset and maps to the merge
        // patch's null. Secrets are handled above; *_analysis unsets are subsumed,
        // the detector below being complete with null on every blank member.
        (flat.unset_fields || []).forEach(function (field) {
            if (SECRET_FLAT_PATHS[field]) return;
            if (SCALAR_PATHS[field]) put(patch, SCALAR_PATHS[field], null);
            else if (field === 'use_transcoder') put(patch, ['config', 'processing', 'frameSource'], null);
        });

        if (isSet(flat.detector_type) && WRITE_DETECTOR[flat.detector_type]) {
            put(patch, ['config', 'detector'],
                WRITE_DETECTOR[flat.detector_type](flat, secrets));
        }

        if (flat.vif_event_listeners || options.previousListeners) {
            put(patch, ['config', 'listeners'],
                listenersPatchFromV1(flat.vif_event_listeners, options.previousListeners));
        }
        return patch;
    }

    /** The PATCH body for an existing stream group config. */
    function groupPatchFromV1(flat, options) {
        return configPatchFromFlat(flat, options);
    }

    /**
     * The POST body that creates a stream group config. In a create, null and
     * absent mean the same thing, so the explicit nulls the patch builder uses
     * for unset semantics are pruned back out.
     */
    function groupFromFlat(flat, options) {
        var patch = configPatchFromFlat(flat, options);
        var body = pruneNulls(patch);
        if (flat.detector_type === 'chain') body.config.detector = patch.config.detector;
        body.name = deriveName(flat.app_name, flat.stream_name);
        body.match = {
            application: flat.app_name,
            streamPattern: flat.stream_name
        };
        return body;
    }

    function pruneNulls(value) {
        if (Array.isArray(value)) return value.map(pruneNulls);
        if (!value || typeof value !== 'object') return value;
        var out = {};
        Object.keys(value).forEach(function (key) {
            if (value[key] === null) return;
            var pruned = pruneNulls(value[key]);
            if (pruned && typeof pruned === 'object' && !Array.isArray(pruned)
                && Object.keys(pruned).length === 0) return;
            out[key] = pruned;
        });
        return out;
    }

    /** The PATCH body for the default config, from default.html's flat body. */
    function defaultPatchFromV1(flat, options) {
        options = options || {};
        var patch = {};
        if (isSet(flat.vi_service_url)) put(patch, ['config', 'service', 'url'], flat.vi_service_url);
        var serviceKey = secretOf(options.secrets, 'vi_service_api_key', flat.vi_service_api_key);
        if (serviceKey !== undefined) put(patch, ['config', 'service', 'apiKey'], serviceKey);
        if (isSet(flat.vi_service_api_key_secret)) {
            put(patch, ['config', 'service', 'apiKeySecret'], flat.vi_service_api_key_secret);
        }
        if (isSet(flat.use_transcoder)) {
            put(patch, ['config', 'processing', 'frameSource'], FRAME_SOURCE[flat.use_transcoder]);
        }
        if (isSet(flat.inference_fps)) put(patch, ['config', 'processing', 'inferenceFps'], flat.inference_fps);
        if (isSet(flat.frame_grab_interval)) {
            put(patch, ['config', 'processing', 'grabIntervalSeconds'], flat.frame_grab_interval);
        }
        if (isSet(flat.duration)) put(patch, ['config', 'processing', 'windowSeconds'], flat.duration);
        if (isSet(flat.concurrent_executions)) {
            // The generated model spells the reserved word `default` as `_default`;
            // passing the flat shape through verbatim serializes an EMPTY object
            // (the ToJSON reads value["_default"]), so the merge-patch is a no-op
            // that still answers 200 — the value silently never saves.
            patch.concurrentExecutions = {};
            Object.keys(flat.concurrent_executions).forEach(function (kind) {
                patch.concurrentExecutions[kind] = { _default: flat.concurrent_executions[kind]['default'] };
            });
        }
        if (flat.verify_analysis && typeof flat.verify_analysis === 'object') {
            var verify = verifyBaselinePatch(flat.verify_analysis, options.secrets);
            if (verify) put(patch, ['detectors', 'verify'], verify);
        }
        return pruneEmptyObjects(patch);
    }

    function carryPatch(target, key, value) {
        if (value !== undefined) target[key] = value;
    }

    /**
     * The default config's verify baseline as a merge patch: a member with a value writes
     * it, null clears the stored one, absent leaves it alone. Null when nothing is stated.
     */
    function verifyBaselinePatch(vf, secrets) {
        var sy = vf.svd || {};
        var va = vf.vlm || {};
        var detector = { type: 'verify' };
        carryPatch(detector, 'flagThreshold', vf.flag_threshold);
        carryPatch(detector, 'strongThreshold', vf.strong_threshold);
        var endpoint = {};
        carryPatch(endpoint, 'address', sy.endpoint);
        carryPatch(endpoint, 'functionId', sy.function_id);
        putSecret(endpoint, 'apiKey', secrets, 'verify_analysis.svd.api_key', sy.api_key);
        carryPatch(endpoint, 'apiKeySecret', sy.api_key_secret);
        var review = {};
        carryPatch(review, 'url', va.endpoint_url);
        carryPatch(review, 'model', va.model_name);
        carryPatch(review, 'timeoutSeconds', va.request_timeout_seconds);
        putSecret(review, 'apiKey', secrets, 'verify_analysis.vlm.api_key', va.api_key);
        carryPatch(review, 'apiKeySecret', va.api_key_secret);
        if (Object.keys(endpoint).length) detector.endpoint = endpoint;
        if (Object.keys(review).length) detector.review = review;
        return Object.keys(detector).length > 1 ? detector : null;
    }

    function pruneEmptyObjects(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        var out = {};
        Object.keys(value).forEach(function (key) {
            var pruned = pruneEmptyObjects(value[key]);
            if (pruned && typeof pruned === 'object' && !Array.isArray(pruned)
                && Object.keys(pruned).length === 0) return;
            out[key] = pruned;
        });
        return out;
    }

    // ── probes / thumbnails / secrets ────────────────────────────────────────

    /**
     * The VLM Verify button's request. An explicit URL probes that URL (with the
     * typed key, never a stored one); a blank URL probes the selected document's
     * effective endpoint by reference, so the stored key applies server-side
     * without ever reaching the browser.
     */
    function nonBlank(value) {
        if (!isSet(value)) return undefined;
        var text = String(value).trim();
        return text === '' ? undefined : text;
    }

    /**
     * A probe of an SVD endpoint by value: the address, transport and credentials as
     * typed, blanks left out. Probing a stored config or the default baseline by
     * reference is the caller's own request.
     */
    function svdProbeRequestFromV1(flat) {
        var request = {};
        carry(request, 'address', nonBlank(flat.endpoint));
        var tls = {};
        carry(tls, 'enabled', flat.use_tls);
        carry(tls, 'caCert', nonBlank(flat.tls_ca_cert));
        carry(tls, 'clientCert', nonBlank(flat.tls_client_cert));
        carry(tls, 'clientKey', nonBlank(flat.tls_client_key));
        if (Object.keys(tls).length) request.tls = tls;
        carry(request, 'apiKey', nonBlank(flat.api_key));
        carry(request, 'functionId', nonBlank(flat.function_id));
        return request;
    }

    function probeRequestFromV1(flat, fallbackGroupName, detectorType) {
        var request = {};
        if (isSet(flat.endpoint_url) && String(flat.endpoint_url).trim() !== '') {
            request.url = flat.endpoint_url;
        } else {
            request.streamGroupConfig = fallbackGroupName || 'default';
            if (nonBlank(detectorType)) request.detectorType = String(detectorType).trim();
        }
        if (isSet(flat.api_key) && flat.api_key !== '') request.apiKey = flat.api_key;
        return request;
    }

    /**
     * The VLM Verify request for one endpoint slot. A picked secret that is the saved one,
     * against the saved URL, probes by reference, exactly as the stream would connect; any
     * other picked name rides along by name with the URL the form shows; the server accepts it
     * only for an endpoint a stored config already uses that secret with.
     *
     * slot.config names a stream group config, slot.override an {application, stream} override;
     * slot.urlAsStored compares the field with the stored URL (blank equals unset), while
     * slot.untouchedUrl is the stricter test a typed-value slot goes by reference on.
     */
    function vlmProbePlan(slot) {
        var hasReference = !!slot.config || !!slot.override;
        if (slot.named && slot.picked) {
            if (hasReference && slot.urlAsStored && slot.picked === (slot.storedKeySecret || '')) {
                return { request: vlmReferenceRequest(slot) };
            }
            var byName = probeRequestFromV1({ endpoint_url: slot.endpoint }, slot.config || 'default');
            byName.apiKeySecret = slot.picked;
            return { request: byName };
        }
        if (!slot.named && !slot.typedKey && hasReference && slot.untouchedUrl) {
            return { request: vlmReferenceRequest(slot) };
        }
        if (!slot.named && !slot.typedKey && !slot.inheritedKey && hasReference) {
            return { request: vlmReferenceAt(slot, slot.endpoint) };
        }
        if (slot.named) {
            // Nothing picked: the slot inherits, so the stored config's own effective key is
            // the honest one, at whatever URL the form shows.
            if (hasReference) {
                return { request: slot.urlAsStored ? vlmReferenceRequest(slot) : vlmReferenceAt(slot, slot.endpoint) };
            }
            return { request: probeRequestFromV1(
                { endpoint_url: slot.typedUrl ? slot.endpoint : '', api_key: '' }, slot.config || 'default') };
        }
        return { request: probeRequestFromV1(
            { endpoint_url: slot.endpoint, api_key: slot.typedKey || slot.inheritedKey || '' },
            slot.config || 'default') };
    }

    /** The reference's stored key, sent to {@code url} instead of the reference's own. */
    function vlmReferenceAt(slot, url) {
        var request = vlmReferenceRequest(slot);
        request.url = url;
        return request;
    }

    function vlmReferenceRequest(slot) {
        if (!slot.config) {
            var request = { application: slot.override.application, stream: slot.override.stream };
            if (nonBlank(slot.detectorType)) request.detectorType = String(slot.detectorType).trim();
            return request;
        }
        var byConfig = probeRequestFromV1({}, slot.config, slot.detectorType);
        if (slot.stage) byConfig.stage = slot.stage;
        return byConfig;
    }

    /** v1 thumbnail query names -> the v2 route's. */
    function thumbnailParamsFromV1(params) {
        params = params || {};
        var out = {};
        carry(out, 'fit', params.fitMode);
        carry(out, 'width', params.width);
        carry(out, 'height', params.height);
        carry(out, 'overlay', params.overlay);
        carry(out, 'format', params.format);
        return out;
    }

    /**
     * The tri-state a secret input resolves to at save time. `touched` is
     * whether the operator typed into the input this session; the value wins
     * whenever there is one.
     */
    function secretValue(touched, value) {
        if (isSet(value) && value !== '') return value;
        return touched ? '' : undefined;
    }

    window.VIF.v2map = {
        deriveName: deriveName,
        // read direction
        flatFromGroup: flatFromGroup,
        flatFromOverride: flatFromOverride,
        flatFromConfig: flatFromConfig,
        flatDefaultFromV2: flatDefaultFromV2,
        modelsFromV2: modelsFromV2,
        streamRowFromV2: streamRowFromV2,
        hostFromV2: hostFromV2,
        visInstancesFromV2: visInstancesFromV2,
        listenerToV1: listenerToV1,
        listenersToV1: listenersToV1,
        // write direction
        groupFromFlat: groupFromFlat,
        groupPatchFromV1: groupPatchFromV1,
        defaultPatchFromV1: defaultPatchFromV1,
        listenerFromV1: listenerFromV1,
        listenersPatchFromV1: listenersPatchFromV1,
        writeChainDetector: writeChainDetector,
        applyDetectorPatch: applyDetectorPatch,
        stageSecretPath: stageSecretPath,
        stageSecretsForVlm: stageSecretsForVlm,
        stageSecretsForNvcfSvd: stageSecretsForNvcfSvd,
        stageSecretsForSelfHostedSvd: stageSecretsForSelfHostedSvd,
        // per-type detector blocks, for stage-scoped reuse
        flatObjectAnalysis: flatObjectAnalysis,
        flatSceneAnalysis: flatSceneAnalysis,
        flatVlmAnalysis: flatVlmAnalysis,
        flatMotionAnalysis: flatMotionAnalysis,
        flatSyntheticAnalysis: flatSyntheticAnalysis,
        writeObjectDetector: writeObjectDetector,
        writeSceneDetector: writeSceneDetector,
        writeVlmDetector: writeVlmDetector,
        writeMotionDetector: writeMotionDetector,
        writeSyntheticDetector: writeSyntheticDetector,
        probeRequestFromV1: probeRequestFromV1,
        vlmProbePlan: vlmProbePlan,
        svdProbeRequestFromV1: svdProbeRequestFromV1,
        thumbnailParamsFromV1: thumbnailParamsFromV1,
        secretValue: secretValue
    };
})();
