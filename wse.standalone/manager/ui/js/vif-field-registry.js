(function () {
    window.VIF = window.VIF || {};
    var VIF = window.VIF;

    var DETECTOR_TYPES = ['object', 'scene', 'vlm', 'synthetic'];

    // ── Section containers ──────────────────────────────────────────────────
    // toggleDetectorSection()'s four `document.getElementById('*-analysis-
    // section').style.display = detectorType === '<x>' ? 'block' : 'none'`
    // lines - one detector each, 'block' when active, 'none' otherwise.
    var SECTIONS = [
        { group: 'object-analysis-section', detectors: ['object'] },
        { group: 'scene-analysis-section', detectors: ['scene'] },
        { group: 'vlm-analysis-section', detectors: ['vlm'] },
        { group: 'synthetic-analysis-section', detectors: ['synthetic'] }
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
            id: 'cfg-inference-fps',
            path: 'inference_fps',
            // Group is shown only when "useTranscoder && detectorType !== 'synthetic'" -
            // the detector part of that condition is every type but synthetic.
            detectors: ['object', 'scene', 'vlm'],
            group: 'cfg-inference-fps-group',
            transcoderGate: 'on',
            rule: { default: { min: -1, max: 120, integer: true, label: 'Inference FPS' } },
            help: { prefix: 'inference-fps-help', detectors: ['object', 'scene', 'vlm'] },
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
            detectors: ['scene', 'vlm', 'synthetic'],
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
                    scene: { max: 5 },
                    vlm: { max: 5 }
                }
            },
            help: { prefix: 'duration-help', detectors: ['scene', 'vlm', 'synthetic'] },
            inheritMode: 'blank-inherits'
        },
        {
            id: null, // checkbox - sent unconditionally in buildConfigJson today (F9 leak, e.g. into synthetic payloads)
            path: 'auto_frame_throttle',
            detectors: ['object', 'scene', 'vlm'],
            group: 'cfg-auto-frame-throttle-group',
            help: { prefix: 'throttle-help', detectors: ['object', 'scene', 'vlm'] },
            inheritMode: 'always-explicit' // booleans have no blank state
        },
        {
            id: null, // checkbox - already correctly gated in buildConfigJson today (only sent for scene/vlm; not an F9 leak)
            path: 'catch_up_to_live',
            detectors: ['scene', 'vlm'],
            group: 'cfg-catch-up-to-live-group',
            help: { prefix: 'catchup-live-help', detectors: ['scene', 'vlm'] },
            inheritMode: 'always-explicit' // booleans have no blank state
        },
        {
            id: 'cfg-catch-up-max-behind',
            path: 'catch_up_max_behind_seconds',
            detectors: ['scene', 'vlm'],
            group: 'cfg-catch-up-max-behind-group',
            rule: { default: { min: 0, max: 30, decimals: 1, label: 'Catch-up Max Behind (s)' } },
            help: { prefix: 'catchup-behind-help', detectors: ['scene', 'vlm'] },
            // One of the plan's F7 finding's 3 fields that already blank->null correctly:
            // buildConfigJson reads it via an explicit `.value.trim() === '' ? null :
            // parseFloat(...)`, not readNumericInputValue().
            inheritMode: 'blank-inherits'
        },
        {
            id: null, // checkbox
            path: 'ignore_untracked_objects',
            detectors: ['object'],
            inheritMode: 'always-explicit' // booleans have no blank state
        },
        {
            id: null, // cfg-frame-grab: static HTML min/step (markup), not FIELD_RULES-managed
            path: 'frame_grab_interval',
            detectors: ['object', 'scene', 'vlm'],
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
        { id: 'cfg-synthetic-endpoint', path: 'synthetic_analysis.endpoint', detectors: ['synthetic'], inheritMode: 'blank-inherits' },
        { id: 'cfg-synthetic-use-tls', path: 'synthetic_analysis.use_tls', detectors: ['synthetic'], inheritMode: 'blank-inherits' },
        { id: 'cfg-synthetic-tls-ca-cert', path: 'synthetic_analysis.tls_ca_cert', detectors: ['synthetic'], inheritMode: 'blank-inherits' },
        { id: 'cfg-synthetic-tls-client-cert', path: 'synthetic_analysis.tls_client_cert', detectors: ['synthetic'], inheritMode: 'blank-inherits' },
        { id: 'cfg-synthetic-tls-client-key', path: 'synthetic_analysis.tls_client_key', detectors: ['synthetic'], inheritMode: 'blank-inherits' },
        { id: 'cfg-synthetic-api-key', path: 'synthetic_analysis.api_key', detectors: ['synthetic'], inheritMode: 'blank-inherits' },
        { id: 'cfg-synthetic-function-id', path: 'synthetic_analysis.function_id', detectors: ['synthetic'], inheritMode: 'blank-inherits' },
        { id: 'cfg-synthetic-classification-threshold', path: 'synthetic_analysis.classification_threshold', detectors: ['synthetic'], inheritMode: 'blank-inherits' }
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

    VIF.fieldRegistry = {
        detectorTypes: DETECTOR_TYPES,
        sections: SECTIONS,
        fields: FIELDS,
        VLM_TYPICAL_ENDPOINT_IMAGE_CAP: VLM_TYPICAL_ENDPOINT_IMAGE_CAP,
        getField: getField,
        getFieldByPath: getFieldByPath,
        effectiveRule: effectiveRule,
        deriveFieldRules: deriveFieldRules
    };
})();
