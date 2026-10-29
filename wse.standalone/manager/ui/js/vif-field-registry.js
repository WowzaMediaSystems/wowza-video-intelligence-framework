(function () {
    window.VIF = window.VIF || {};
    var VIF = window.VIF;

    var DETECTOR_TYPES = ['object', 'scene', 'motion', 'vlm', 'synthetic', 'verify', 'chain'];

    // Detector types a live stream never runs: their frames come from the file an on-demand job
    // decodes, so the `transcoderGate` entries below — which pick between the transcoder output
    // and the keyframe grabber — say nothing about them.
    var ON_DEMAND_ONLY = ['verify'];

    // ── Section containers ──────────────────────────────────────────────────
    // toggleDetectorSection()'s four `document.getElementById('*-analysis-
    // section').style.display = detectorType === '<x>' ? 'block' : 'none'`
    // lines - one detector each, 'block' when active, 'none' otherwise.
    var SECTIONS = [
        { group: 'object-analysis-section', detectors: ['object'] },
        { group: 'scene-analysis-section', detectors: ['scene'] },
        { group: 'motion-analysis-section', detectors: ['motion'] },
        { group: 'vlm-analysis-section', detectors: ['vlm', 'verify'] },
        { group: 'synthetic-analysis-section', detectors: ['synthetic', 'verify'] },
        { group: 'verify-gate-section', detectors: ['verify'] },
        { group: 'chain-pipeline-section', detectors: ['chain'] }
    ];

    // ── Fields ───────────────────────────────────────────────────────────────
    // One entry per field that toggleDetectorSection shows/hides a group for,
    // and/or swaps help text for, and/or FIELD_RULES has a rule for. `id` is
    // the input's element id - null for the 3 group-only fields that carry no
    // FIELD_RULES entry: cfg-auto-frame-throttle/cfg-catch-up-to-live are
    // checkboxes (no numeric rule), and cfg-frame-grab's min/step is a static
    // HTML attribute, never bound via applyNumericRuleToInput().
    var FIELDS = [
        {
            // Not detector-gated: every detector reaches VIS through this URL. It is
            // here for `inheritMode` alone — collectUnsetFields() asks the registry
            // whether a blanked field may be unset, and without an entry a cleared
            // VIS URL never reaches the wire as the null that clears it.
            //
            // Its credential is deliberately absent: a read never echoes the key, so
            // its input is blank on every load and "blank means unset" would clear a
            // stored key on any save that did not retype it.
            id: 'cfg-vi-service-url',
            path: 'vi_service_url',
            detectors: DETECTOR_TYPES.slice(),
            inheritMode: 'blank-inherits'
        },
        {
            id: 'cfg-inference-fps',
            path: 'inference_fps',
            // Every type but synthetic, whose source-packet tap has no sampling rate to set.
            // For the live types the group also follows Use Transcoder; for verify it does not
            // (see ON_DEMAND_ONLY above) — the rate is what the review samples each window at.
            detectors: ['object', 'scene', 'motion', 'vlm', 'verify', 'chain'],
            group: 'cfg-inference-fps-group',
            transcoderGate: 'on',
            rule: { default: { min: -1, max: 120, integer: true, label: 'Inference FPS' } },
            help: { prefix: 'inference-fps-help', detectors: ['object', 'scene', 'motion', 'vlm', 'verify', 'chain'] },
            inheritMode: 'blank-inherits'
        },
        {
            id: 'cfg-inference-video-height-custom',
            path: 'inference_video_height',
            // Not detector-gated at all (shown/hidden by the Inference Video Height MODE
            // select instead - toggleDetectorSection never touches it); relevant to every
            // detector.
            detectors: DETECTOR_TYPES.slice(),
            rule: { default: { min: 2, integer: true, label: 'Inference Video Height' } },
            // getInferenceVideoHeight() only reads this input when the mode select is
            // 'custom' (mode '' already returns a true null - correct inherit today); when it
            // does, it goes through readNumericInputValue(), the same F7 mechanism as below.
            inheritMode: 'blank-inherits'
        },
        {
            id: 'cfg-rollup-batch-interval',
            path: 'rollup_batch_interval',
            // Not actually detector-dependent - toggleDetectorSection sets this group's
            // display to 'flex' unconditionally every call (see visibility-matrix-object.cjs's
            // inventory note), but it's part of its contract; every detector "has" it.
            detectors: DETECTOR_TYPES.slice(),
            group: 'cfg-rollup-batch-interval-group',
            rule: { default: { min: 0, max: 30, decimals: 1, label: 'Rollup Batch Interval' } },
            inheritMode: 'blank-inherits'
        },
        {
            id: 'cfg-duration',
            path: 'duration',
            detectors: ['scene', 'vlm', 'synthetic', 'verify', 'chain'],
            group: 'cfg-duration-group',
            // The one field whose rule genuinely varies per detector: toggleDetectorSection
            // mutates FIELD_RULES['cfg-duration'].max at runtime (30 for synthetic, 5
            // otherwise) - `byDetector` expresses that directly. 'object' falls back to
            // `default` (moot in practice, since cfg-duration-group is hidden for object
            // anyway, but the mutation runs unconditionally today regardless of visibility,
            // and this preserves that exactly).
            rule: {
                default: { min: 0, max: 5, decimals: 1, label: 'Duration' },
                byDetector: {
                    synthetic: { max: 30 },
                    verify: { max: 30 },
                    scene: { max: 5 },
                    // One VLM request carries Duration × Inference FPS images and the
                    // endpoint accepts at most VLM_TYPICAL_ENDPOINT_IMAGE_CAP (8); FPS
                    // is at least 1, so a window past 8s can never fit the cap.
                    vlm: { max: 8 }
                }
            },
            help: { prefix: 'duration-help', detectors: ['scene', 'vlm', 'synthetic', 'verify', 'chain'] },
            inheritMode: 'blank-inherits'
        },
        {
            id: null, // checkbox - sent unconditionally in buildConfigJson today (F9 leak, e.g. into synthetic payloads)
            path: 'auto_frame_throttle',
            detectors: ['object', 'scene', 'motion', 'vlm', 'chain'],
            group: 'cfg-auto-frame-throttle-group',
            help: { prefix: 'throttle-help', detectors: ['object', 'scene', 'motion', 'vlm', 'chain'] },
            inheritMode: 'always-explicit' // booleans have no blank state
        },
        {
            id: null, // checkbox - already correctly gated in buildConfigJson today (only sent for scene/vlm; not an F9 leak)
            path: 'catch_up_to_live',
            detectors: ['scene', 'vlm', 'chain'],
            group: 'cfg-catch-up-to-live-group',
            help: { prefix: 'catchup-live-help', detectors: ['scene', 'vlm', 'chain'] },
            inheritMode: 'always-explicit' // booleans have no blank state
        },
        {
            id: 'cfg-catch-up-max-behind',
            path: 'catch_up_max_behind_seconds',
            detectors: ['scene', 'vlm', 'chain'],
            group: 'cfg-catch-up-max-behind-group',
            rule: { default: { min: 0, max: 30, decimals: 1, label: 'Catch-up Max Behind (s)' } },
            help: { prefix: 'catchup-behind-help', detectors: ['scene', 'vlm', 'chain'] },
            // One of the plan's F7 finding's 3 fields that already blank->null correctly:
            // buildConfigJson reads it via an explicit `.value.trim() === '' ? null :
            // parseFloat(...)`, not readNumericInputValue().
            inheritMode: 'blank-inherits'
        },
        {
            id: null, // checkbox
            path: 'ignore_untracked_objects',
            detectors: ['object', 'chain'],
            inheritMode: 'always-explicit' // booleans have no blank state
        },
        {
            id: null, // cfg-frame-grab: static HTML min/step (markup), not FIELD_RULES-managed
            path: 'frame_grab_interval',
            detectors: ['object', 'scene', 'motion', 'vlm', 'chain'],
            group: 'cfg-frame-grab-group',
            transcoderGate: 'off',
            inheritMode: 'blank-inherits'
        },
        {
            id: 'cfg-confidence-threshold',
            path: 'object_analysis.confidence_threshold',
            detectors: ['object'],
            rule: { default: { min: 0, max: 100, decimals: 1, label: 'Object Confidence Threshold %' } },
            inheritMode: 'blank-inherits'
        },
        {
            id: 'cfg-bt-min-confidence',
            path: 'object_analysis.byte_track_properties.track_creation_minimum_confidence',
            detectors: ['object'],
            rule: { default: { min: 0, max: 100, decimals: 1, label: 'Min Track Confidence' } },
            inheritMode: 'blank-inherits'
        },
        {
            id: 'cfg-bt-max-lost-frames',
            path: 'object_analysis.byte_track_properties.max_lost_track_frames_before_track_removal',
            detectors: ['object'],
            rule: { default: { min: 0, max: 60, integer: true, label: 'Max Lost Track Frames' } },
            inheritMode: 'blank-inherits'
        },
        {
            id: 'cfg-bt-min-overlap',
            path: 'object_analysis.byte_track_properties.minimum_consecutive_track_overlap',
            detectors: ['object'],
            rule: { default: { min: 0, max: 100, decimals: 1, label: 'Min Consecutive Overlap' } },
            inheritMode: 'blank-inherits'
        },
        {
            id: 'cfg-bt-min-frames',
            path: 'object_analysis.byte_track_properties.track_creation_minimum_consecutive_frames',
            detectors: ['object'],
            rule: { default: { min: 0, max: 60, integer: true, label: 'Min Consecutive Frames' } },
            inheritMode: 'blank-inherits'
        },
        {
            id: 'cfg-tiling-min-rows',
            path: 'object_analysis.tiling_properties.min_slice_rows',
            detectors: ['object'],
            rule: { default: { min: 1, max: 16, integer: true, label: 'Min Slice Rows' } },
            inheritMode: 'blank-inherits'
        },
        {
            id: 'cfg-tiling-min-cols',
            path: 'object_analysis.tiling_properties.min_slice_cols',
            detectors: ['object'],
            rule: { default: { min: 1, max: 16, integer: true, label: 'Min Slice Cols' } },
            inheritMode: 'blank-inherits'
        },
        {
            id: 'cfg-tiling-max-rows',
            path: 'object_analysis.tiling_properties.max_slice_rows',
            detectors: ['object'],
            rule: { default: { min: 1, max: 16, integer: true, label: 'Max Slice Rows' } },
            inheritMode: 'blank-inherits'
        },
        {
            id: 'cfg-tiling-max-cols',
            path: 'object_analysis.tiling_properties.max_slice_cols',
            detectors: ['object'],
            rule: { default: { min: 1, max: 16, integer: true, label: 'Max Slice Cols' } },
            inheritMode: 'blank-inherits'
        },
        {
            id: 'cfg-tiling-coverage-cutoff',
            path: 'object_analysis.tiling_properties.tile_coverage_cutoff',
            detectors: ['object'],
            rule: { default: { min: 0, max: 100, decimals: 1, label: 'Tile Coverage Cutoff %' } },
            inheritMode: 'blank-inherits'
        },
        {
            id: 'cfg-tiling-cluster-children',
            path: 'object_analysis.tiling_properties.cluster_suppression_min_children',
            detectors: ['object'],
            rule: { default: { min: 0, max: 100, integer: true, label: 'Cluster Suppression Min Children' } },
            inheritMode: 'blank-inherits'
        },
        {
            id: 'cfg-scene-sensitivity',
            path: 'scene_analysis.sensitivity',
            detectors: ['scene'],
            rule: { default: { min: 0, max: 10, decimals: 1, label: 'Scene Sensitivity' } },
            inheritMode: 'blank-inherits'
        },
        {
            id: 'cfg-motion-sensitivity',
            path: 'motion_analysis.sensitivity',
            detectors: ['motion'],
            rule: { default: { min: 1, max: 10, integer: true, label: 'Motion Sensitivity' } },
            inheritMode: 'blank-inherits'
        },
        {
            id: 'cfg-motion-min-displacement',
            path: 'motion_analysis.min_displacement',
            detectors: ['motion'],
            rule: { default: { min: 0, max: 100, decimals: 1, label: 'Min Displacement %' } },
            inheritMode: 'blank-inherits'
        },
        {
            id: 'cfg-motion-merge-distance',
            path: 'motion_analysis.merge_distance',
            detectors: ['motion'],
            rule: { default: { min: 0, max: 50, decimals: 1, label: 'Merge Distance %' } },
            inheritMode: 'blank-inherits'
        },
        {
            id: 'cfg-motion-suppress-global-changes',
            path: 'motion_analysis.suppress_global_changes',
            detectors: ['motion'],
            inheritMode: 'blank-inherits'
        },
        {
            id: 'cfg-scene-confidence-threshold',
            path: 'scene_analysis.confidence_threshold',
            detectors: ['scene'],
            rule: { default: { min: 0, max: 100, decimals: 1, label: 'Scene Confidence Threshold %' } },
            inheritMode: 'blank-inherits'
        },
        {
            id: 'cfg-log-max-messages',
            path: 'log_max_messages',
            // Not detector-gated - always visible, relevant to every detector.
            detectors: DETECTOR_TYPES.slice(),
            rule: { default: { min: 0, max: 1000, integer: true, label: 'Log Max Messages' } },
            inheritMode: 'blank-inherits'
        },
        {
            id: 'cfg-log-timing',
            path: 'log_timing',
            detectors: DETECTOR_TYPES.slice(),
            rule: { default: { min: 0, max: 60, integer: true, label: 'Log Timing' } },
            inheritMode: 'blank-inherits'
        },
        {
            id: 'evt-confidence',
            // Listener-scoped (vif_event_listeners.<name>.confidence_threshold), not a
            // top-level/detector-analysis path like the fields above.
            path: 'vif_event_listeners.*.confidence_threshold',
            // The Event Listeners panel is shown regardless of detector_type.
            detectors: DETECTOR_TYPES.slice(),
            rule: { default: { min: 0, max: 100, decimals: 1, label: 'Listener Confidence Threshold %' } },
            inheritMode: 'always-explicit' // still placeholder-materialized (F7-equivalent); residual, see comment above
        },
        {
            id: 'cfg-detector-type',
            path: 'detector_type',
            detectors: DETECTOR_TYPES.slice(),
            help: { prefix: 'detector-help', detectors: DETECTOR_TYPES.slice() },
            inheritMode: 'always-explicit' // required select; has no blank state
        },
        // ── synthetic_analysis.* stream-level scalars ────────────────────────
        // Registered (with matching computeEffectiveFieldDefaults entries in
        // vif-stream-config.js) so collectUnsetFields() emits an unset_fields
        // path when an input is blanked: synthetic_analysis is deep-merged on
        // save (never wholesale-replaced like vlm_analysis), so a serialized
        // null alone can never clear a stored value. No group/rule/help — the
        // synthetic section is shown/hidden wholesale via SECTIONS above.
        // use_tls "blank" is the select's '' (auto-detect) option.
        { id: 'cfg-synthetic-endpoint', path: 'synthetic_analysis.endpoint', detectors: ['synthetic', 'verify'], inheritMode: 'blank-inherits' },
        { id: 'cfg-synthetic-use-tls', path: 'synthetic_analysis.use_tls', detectors: ['synthetic', 'verify'], inheritMode: 'blank-inherits' },
        { id: 'cfg-synthetic-tls-ca-cert', path: 'synthetic_analysis.tls_ca_cert', detectors: ['synthetic', 'verify'], inheritMode: 'blank-inherits' },
        { id: 'cfg-synthetic-tls-client-cert', path: 'synthetic_analysis.tls_client_cert', detectors: ['synthetic', 'verify'], inheritMode: 'blank-inherits' },
        { id: 'cfg-synthetic-tls-client-key', path: 'synthetic_analysis.tls_client_key', detectors: ['synthetic', 'verify'], inheritMode: 'blank-inherits' },
        { id: 'cfg-synthetic-api-key', path: 'synthetic_analysis.api_key', detectors: ['synthetic', 'verify'], inheritMode: 'blank-inherits' },
        // The *_secret reference pickers. Unlike the credentials above these are ordinary
        // members — a reference is a NAME, echoed by reads — and the entries exist so a
        // blanked picker (the slot switched back to a value) unsets the stored name.
        { id: 'cfg-vi-service-api-key-secret', path: 'vi_service_api_key_secret', detectors: DETECTOR_TYPES.slice(), inheritMode: 'blank-inherits' },
        { id: 'cfg-vlm-api-key-secret', path: 'vlm_analysis.api_key_secret', detectors: ['vlm'], inheritMode: 'blank-inherits' },
        { id: 'cfg-synthetic-api-key-secret', path: 'synthetic_analysis.api_key_secret', detectors: ['synthetic', 'verify'], inheritMode: 'blank-inherits' },
        { id: 'cfg-synthetic-tls-client-key-secret', path: 'synthetic_analysis.tls_client_key_secret', detectors: ['synthetic', 'verify'], inheritMode: 'blank-inherits' },
        { id: 'cfg-synthetic-function-id', path: 'synthetic_analysis.function_id', detectors: ['synthetic', 'verify'], inheritMode: 'blank-inherits' },
        { id: 'cfg-synthetic-classification-threshold', path: 'synthetic_analysis.classification_threshold', detectors: ['synthetic'], group: 'cfg-synthetic-classification-threshold-group', inheritMode: 'blank-inherits' },
        { id: 'cfg-verify-flag-threshold', path: 'verify_analysis.flag_threshold', detectors: ['verify'], inheritMode: 'blank-inherits' },
        { id: 'cfg-verify-strong-threshold', path: 'verify_analysis.strong_threshold', detectors: ['verify'], inheritMode: 'blank-inherits' }
    ];

    // ── Accessors (pure; no DOM access) ──────────────────────────────────────

    function getField(id) {
        for (var i = 0; i < FIELDS.length; i++) {
            if (FIELDS[i].id === id) return FIELDS[i];
        }
        return null;
    }

    function getFieldByPath(path) {
        for (var i = 0; i < FIELDS.length; i++) {
            if (FIELDS[i].path === path) return FIELDS[i];
        }
        return null;
    }

    function runsLive(detectorType) {
        return ON_DEMAND_ONLY.indexOf(detectorType) === -1;
    }

    // Merges a field's per-detector rule override onto its default rule (D3's
    // per-detector rule form - see cfg-duration above). Fields with no
    // `byDetector` (everything except cfg-duration today) just return a copy
    // of `default`. Always a fresh object - never `field.rule.default`/
    // `field.rule.byDetector[...]` themselves - so a caller free to mutate the
    // result (as toggleDetectorSection does) can never corrupt this registry's
    // own declared data.
    function effectiveRule(field, detectorType) {
        if (!field || !field.rule) return null;
        var merged = Object.assign({}, field.rule.default);
        if (field.rule.byDetector && field.rule.byDetector[detectorType]) {
            Object.assign(merged, field.rule.byDetector[detectorType]);
        }
        return merged;
    }

    function deriveFieldRules() {
        var rules = {};
        FIELDS.forEach(function (field) {
            if (!field.id || !field.rule) return;
            rules[field.id] = Object.assign({}, field.rule.default);
        });
        return rules;
    }

    var VLM_TYPICAL_ENDPOINT_IMAGE_CAP = 8;

    // Models offered as explicit options wherever a VLM model name is picked (the live
    // stream-config editor and the VOD inline editor); a stored model_name outside this
    // set is shown through each editor's "Other" affordance.
    var VLM_MODEL_OPTIONS = [
        { value: 'Qwen/Qwen3-VL-4B-Instruct-FP8', label: 'Qwen3-VL-4B (Qwen)' },
        { value: 'nvidia/NVIDIA-Nemotron-Nano-12B-v2-VL-FP8', label: 'Nemotron Nano 12B VL (NVIDIA)' },
        { value: 'google/gemma-3-4b-it', label: 'Gemma 3 4B (Google)' },
        { value: 'nvidia/Cosmos3-Edge', label: 'Cosmos3 Edge (NVIDIA)' },
        { value: 'nvidia/Cosmos3-Nano', label: 'Cosmos3 Nano (NVIDIA)' }
    ];

    // What the review stage runs when neither the config nor the baseline names a model.
    var VERIFY_FALLBACK_REVIEW_MODEL = 'nvidia/Cosmos3-Nano';

    VIF.fieldRegistry = {
        detectorTypes: DETECTOR_TYPES,
        VERIFY_FALLBACK_REVIEW_MODEL: VERIFY_FALLBACK_REVIEW_MODEL,
        sections: SECTIONS,
        fields: FIELDS,
        VLM_TYPICAL_ENDPOINT_IMAGE_CAP: VLM_TYPICAL_ENDPOINT_IMAGE_CAP,
        VLM_MODEL_OPTIONS: VLM_MODEL_OPTIONS,
        getField: getField,
        getFieldByPath: getFieldByPath,
        runsLive: runsLive,
        effectiveRule: effectiveRule,
        deriveFieldRules: deriveFieldRules
    };
})();
