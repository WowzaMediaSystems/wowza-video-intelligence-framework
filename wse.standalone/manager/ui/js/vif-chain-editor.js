// vif-chain-editor.js - the chain editor's state core.
//
// The state mirrors the v2 SDK's ChainDetector (camelCase, as vif-api.js reads it):
// { mode, resultMode, maxRings, decisionTimeoutSeconds, dispatchIntermediateRings,
//   decisionListener, stages: [{ name, detector: { type, ... }, routing, crop, frameSelection }] }.
// Everything here is pure data in and out - no DOM, no fetch - so it loads and is tested
// under plain Node (src/test/js/vif-chain-editor.test.js). Transitions return a new state
// and never mutate the one passed in.
(function () {
    'use strict';

    window.VIF = window.VIF || {};

    var STAGE_TYPES = ['object', 'scene', 'vlm', 'synthetic', 'motion'];
    var MODES = ['linear', 'conditional', 'dynamic'];
    var FRAME_SELECTION_MODES = ['all', 'first', 'middle', 'last', 'every_nth'];
    var RESERVED_STAGE_NAMES = ['__terminal__', '__done__'];
    var SERVER_DEFAULT_MAX_RINGS = 8;

    var STAGE_DETECTOR_MEMBERS = {
        object: ['classes', 'model', 'checkpointPath', 'minConfidence', 'tracking', 'tiling'],
        scene: ['classes', 'sensitivity', 'classSensitivity', 'minConfidence', 'baseline'],
        vlm: ['endpoint', 'mode', 'detect', 'custom', 'generation'],
        synthetic: ['endpoint', 'classificationThreshold'],
        motion: ['sensitivity', 'minDisplacement', 'mergeDistance', 'suppressGlobalChanges']
    };

    var STAGE_MEMBERS = ['name', 'detector', 'routing', 'crop', 'frameSelection'];
    var CHAIN_MEMBERS = ['mode', 'resultMode', 'maxRings', 'decisionTimeoutSeconds',
        'dispatchIntermediateRings', 'decisionListener'];
    var DYNAMIC_MEMBERS = ['decisionListener', 'decisionTimeoutSeconds', 'dispatchIntermediateRings'];

    var OPAQUE_MEMBERS = { classHints: 1, classSensitivity: 1, responseSchema: 1, properties: 1 };

    var CONDITIONAL_ROUTING_MEMBERS = { rules: 'rules', match: 'match', onMatch: 'on_match', onNoMatch: 'on_no_match' };

    function isSet(value) { return value !== undefined && value !== null; }

    function copy(value) {
        return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    }

    function withoutNulls(value) {
        if (Array.isArray(value)) return value.map(withoutNulls);
        if (!value || typeof value !== 'object') return value;
        var out = {};
        Object.keys(value).forEach(function (key) {
            if (!isSet(value[key])) return;
            out[key] = OPAQUE_MEMBERS[key] ? copy(value[key]) : withoutNulls(value[key]);
        });
        return out;
    }

    function pick(source, keys) {
        var out = {};
        keys.forEach(function (key) {
            if (isSet(source[key])) out[key] = copy(source[key]);
        });
        return out;
    }

    function stageFrom(stage) {
        return pick(stage || {}, STAGE_MEMBERS);
    }

    /** The mode a state runs in; an absent mode is linear. */
    function chainMode(state) {
        return state.mode || 'linear';
    }

    // ── load / seed / collect ────────────────────────────────────────────────

    /** Editor state from a read chain detector (`flat.chain_detector`); never aliases it. */
    function initChain(detector) {
        detector = detector || {};
        var state = pick(detector, CHAIN_MEMBERS);
        state.stages = (detector.stages || []).map(stageFrom);
        return state;
    }

    /** The state a new chain config starts from: one unnamed object stage. */
    function newChain() {
        return { mode: 'linear', stages: [{ name: '', detector: { type: 'object' } }] };
    }

    function collectDetector(detector) {
        detector = detector || {};
        var members = STAGE_DETECTOR_MEMBERS[detector.type];
        var out = members ? pick(detector, ['type'].concat(members)) : copy(detector);
        return withoutNulls(out);
    }

    function trimTarget(target) {
        var out = withoutNulls(target);
        if (typeof out.stage === 'string') out.stage = out.stage.trim();
        return out;
    }

    function collectRouting(routing) {
        var out = withoutNulls(routing);
        if (out.onDone) {
            out.onDone = trimTarget(out.onDone);
        } else {
            out.rules = out.rules || [];
        }
        if (out.onMatch) out.onMatch = trimTarget(out.onMatch);
        if (out.onNoMatch) out.onNoMatch = trimTarget(out.onNoMatch);
        return out;
    }

    /** The rule a motion route saves in place of `rule`: the motion class, and `rule`'s minCount if set. */
    function lockedMotionRule(rule) {
        var out = { classes: ['motion'] };
        if (isSet((rule || {}).minCount)) out.minCount = rule.minCount;
        return out;
    }

    function collectStage(stage, mode) {
        var out = { name: typeof stage.name === 'string' ? stage.name.trim() : stage.name };
        out.detector = collectDetector(stage.detector);
        if (isSet(stage.routing) && mode === 'conditional') {
            out.routing = collectRouting(stage.routing);
            if (out.detector.type === 'motion' && out.routing.rules) out.routing.rules = out.routing.rules.map(lockedMotionRule);
        }
        if (isSet(stage.crop)) out.crop = withoutNulls(stage.crop);
        if (isSet(stage.frameSelection)) out.frameSelection = withoutNulls(stage.frameSelection);
        return out;
    }

    /**
     * The v2 chain detector a save writes. Stages replace wholesale, so no member inside a
     * stage is ever null; '' stays (it clears a stored secret), `rules` is always sent with
     * routing that has no `onDone`, and the members of a mode the chain is not in are never
     * emitted.
     */
    function collectChainDetector(state) {
        var mode = chainMode(state);
        var out = { type: 'chain' };
        CHAIN_MEMBERS.forEach(function (key) {
            if (!isSet(state[key])) return;
            if (mode !== 'dynamic' && DYNAMIC_MEMBERS.indexOf(key) !== -1) return;
            out[key] = key === 'decisionListener' ? withoutNulls(state[key]) : copy(state[key]);
        });
        out.stages = (state.stages || []).map(function (stage) {
            return collectStage(stage, mode);
        });
        return out;
    }

    // ── validate ─────────────────────────────────────────────────────────────

    function stageNameErrors(stage, path, seen) {
        var name = typeof stage.name === 'string' ? stage.name.trim() : '';
        if (name === '') return [path + '.name: a stage name is required.'];
        if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) {
            return [path + '.name: control characters are not allowed in a stage name.'];
        }
        if (RESERVED_STAGE_NAMES.indexOf(name) !== -1) {
            return [path + '.name: ' + name + ' is reserved; choose another stage name.'];
        }
        if (seen[name]) return [path + ".name: duplicates stage '" + name + "'."];
        seen[name] = true;
        return [];
    }

    function frameSelectionErrors(stage, type, path) {
        var selection = stage.frameSelection;
        if (!isSet(selection)) return [];
        var errors = [];
        path += '.frame_selection';
        if (FRAME_SELECTION_MODES.indexOf(selection.mode) === -1) {
            errors.push(path + '.mode: must be one of ' + FRAME_SELECTION_MODES.join(', ') + '.');
        } else if (type === 'synthetic' && selection.mode !== 'all') {
            errors.push(path + ".mode: must be 'all' for a synthetic stage, which analyzes the whole clip.");
        }
        if (selection.mode === 'every_nth') {
            if (!Number.isInteger(selection.stride) || selection.stride < 2) {
                errors.push(path + '.stride: every_nth needs a whole-number stride of at least 2.');
            }
        } else if (isSet(selection.stride)) {
            errors.push(path + ".stride: only mode 'every_nth' takes a stride.");
        }
        return errors;
    }

    /**
     * The index of the first scene, vlm or synthetic stage, which makes the whole chain
     * capture clip windows; -1 when only object and motion stages leave it checking one
     * frame at a time.
     */
    function windowStageIndex(state) {
        var stages = state.stages || [];
        for (var i = 0; i < stages.length; i++) {
            var type = (stages[i].detector || {}).type;
            if (type === 'scene' || type === 'vlm' || type === 'synthetic') return i;
        }
        return -1;
    }

    /**
     * How many of `captured` frames a stage's frame selection keeps: every one, one
     * representative, or for every_nth the first, every nth and always the last.
     */
    function selectedFrameCount(captured, selection) {
        if (!(captured > 0)) return 0;
        var mode = selection && selection.mode;
        if (!mode || mode === 'all') return captured;
        if (mode === 'every_nth') {
            var n = Number(selection.stride);
            if (!(n >= 2)) return captured;
            var last = captured - 1;
            return Math.floor(last / n) + 1 + (last % n === 0 ? 0 : 1);
        }
        return 1;
    }

    function frameCadenceErrors(stage, windowStage, path) {
        var selection = stage.frameSelection;
        if (windowStage !== -1 || !isSet(selection) || !isSet(selection.mode) || selection.mode === 'all') return [];
        return [path + '.frame_selection: only a chain with a scene, vlm or synthetic stage checks clips;'
            + ' with only object and motion stages each check carries a single frame.'];
    }

    function cropsBehind(predecessor) {
        var type = (predecessor.detector || {}).type;
        return type === 'object' || type === 'motion';
    }

    /**
     * The stages that can run right before stage `index`, whose detections a crop would use:
     * in linear mode the one above it; in conditional mode every stage whose routing targets
     * it, plus the one above it when that one has no routing and falls through. Null in
     * dynamic mode, where the code decides at runtime.
     */
    function cropSourcesIn(stages, mode, index) {
        if (index <= 0 || index >= stages.length) return [];
        if (mode === 'dynamic') return null;
        if (mode !== 'conditional') return [stages[index - 1]];
        var name = trimmedName(stages[index].name);
        var sources = [];
        stages.forEach(function (stage, at) {
            if (at === index) return;
            var routing = stage.routing;
            if (!routing) {
                if (at === index - 1) sources.push(stage);
                return;
            }
            var leadsHere = [routing.onMatch, routing.onNoMatch, routing.onDone].some(function (target) {
                return target && name !== '' && trimmedName(target.stage) === name;
            });
            if (leadsHere) sources.push(stage);
        });
        return sources;
    }

    function cropSources(state, index) {
        return cropSourcesIn(state.stages || [], chainMode(state), index);
    }

    /**
     * Whether stage `index` may add a crop: never the entry, a synthetic or a motion stage,
     * and only when a stage that can run right before it draws boxes (object or motion),
     * which dynamic mode can't know ahead of time.
     */
    function offersCrop(state, index) {
        var stages = state.stages || [];
        if (index <= 0 || index >= stages.length) return false;
        var type = (stages[index].detector || {}).type;
        if (type === 'synthetic' || type === 'motion') return false;
        var sources = cropSources(state, index);
        return sources === null || sources.some(cropsBehind);
    }

    // The frames a stage looks at, as a frame selection mode. Movement always looks at every one.
    function frameModeOf(stage) {
        if ((stage.detector || {}).type === 'motion') return 'all';
        var selection = stage.frameSelection;
        return selection && selection.mode ? selection.mode : 'all';
    }

    var SINGLE_FRAME_MODES = ['first', 'middle', 'last'];

    // The frame choices that always share a frame with one of each mode. One in every few always
    // keeps the first and last frames; a pairing that depends on the clip's length is left out.
    var SHARED_FRAME_CHOICES = {
        all: FRAME_SELECTION_MODES,
        first: ['all', 'first', 'every_nth'],
        middle: ['all', 'middle'],
        last: ['all', 'last', 'every_nth'],
        every_nth: ['all', 'first', 'last', 'every_nth']
    };

    /**
     * The frame choices stage `index` can make while it looks inside boxes and still get boxes
     * from every stage that draws them before it: a crop comes only from frames both looked at.
     */
    function cropFrameChoices(state, index) {
        var choices = FRAME_SELECTION_MODES.slice();
        (cropSources(state, index) || []).filter(cropsBehind).forEach(function (source) {
            var shared = SHARED_FRAME_CHOICES[frameModeOf(source)] || FRAME_SELECTION_MODES;
            choices = choices.filter(function (mode) { return shared.indexOf(mode) !== -1; });
        });
        return choices;
    }

    // A crop stage on one frame whose every box-drawing source looks only at a different one
    // never gets a box. Returns that source's index, or -1.
    function deadCropSource(stages, mode, index) {
        var stage = stages[index];
        var own = frameModeOf(stage);
        if (!isSet(stage.crop) || SINGLE_FRAME_MODES.indexOf(own) === -1) return -1;
        var drawing = (cropSourcesIn(stages, mode, index) || []).filter(cropsBehind);
        if (!drawing.length) return -1;
        var dead = drawing.every(function (source) {
            var theirs = frameModeOf(source);
            return SINGLE_FRAME_MODES.indexOf(theirs) !== -1 && theirs !== own;
        });
        return dead ? stages.indexOf(drawing[0]) : -1;
    }

    function cropErrors(stages, index, mode, path) {
        var stage = stages[index];
        if (!isSet(stage.crop)) return [];
        var detector = stage.detector || {};
        if (index === 0) return [path + '.crop: the entry stage has no preceding detections to crop.'];
        if (detector.type === 'synthetic') return [path + ".crop: a synthetic stage analyzes the whole clip and cannot crop."];
        if (detector.type === 'motion') return [path + '.crop: a motion stage compares whole consecutive frames and cannot crop.'];
        var errors = [];
        var sources = cropSourcesIn(stages, mode, index);
        if (mode === 'linear' && !cropsBehind(stages[index - 1])) {
            errors.push(path + '.crop: needs an object or motion stage immediately before it in linear mode.');
        } else if (sources !== null && !sources.some(cropsBehind)) {
            errors.push(path + '.crop: none of the stages that lead to it is an object or motion stage, so there are no boxes to crop.');
        }
        if (detector.type === 'object') {
            if (detector.tracking && detector.tracking.method === 'byte-track') {
                errors.push(path + ".detector.tracking: must be 'none' when the stage crops.");
            }
            if (detector.tiling && isSet(detector.tiling.mode) && detector.tiling.mode !== 'none') {
                errors.push(path + ".detector.tiling: must be 'none' when the stage crops.");
            }
        }
        return errors;
    }

    function trimmedName(name) {
        return typeof name === 'string' ? name.trim() : '';
    }

    function targetErrors(target, names, motionEntry, path) {
        if (!isSet(target)) return [];
        var named = isSet(target.stage);
        if (named === isSet(target.end) || (!named && target.end !== true)) {
            return [path + ': must name a stage or the end of the window.'];
        }
        if (!named) return [];
        var stage = trimmedName(target.stage);
        if (stage === '') return [path + '.stage: choose a stage.'];
        if (names.indexOf(stage) === -1) return [path + ".stage: there is no stage named '" + stage + "'."];
        if (motionEntry !== '' && stage === motionEntry) {
            return [path + ".stage: cannot target the motion entry stage '" + motionEntry
                + "'; a revisited motion stage re-differences the same window and can never fire."];
        }
        return [];
    }

    function ruleErrors(rule, path) {
        var errors = [];
        rule = rule || {};
        if (isSet(rule.minConfidence)
            && (typeof rule.minConfidence !== 'number' || !(rule.minConfidence >= 0 && rule.minConfidence <= 1))) {
            errors.push(path + '.min_confidence: must be between 0% and 100%.');
        }
        if (isSet(rule.minCount) && (!Number.isInteger(rule.minCount) || rule.minCount < 1)) {
            errors.push(path + '.min_count: must be a whole number of at least 1.');
        }
        return errors;
    }

    function conditionalRoutingMembers(routing) {
        return Object.keys(CONDITIONAL_ROUTING_MEMBERS).filter(function (key) {
            return isSet(routing[key]);
        }).map(function (key) { return CONDITIONAL_ROUTING_MEMBERS[key]; });
    }

    function routingErrors(stage, mode, names, motionEntry, path) {
        var routing = stage.routing;
        if (!isSet(routing)) return [];
        path += '.routing';
        if (mode !== 'conditional') return [path + ': only a conditional chain routes; this route will not be saved.'];
        if (isSet(routing.onDone)) {
            var mixed = conditionalRoutingMembers(routing);
            var shapeErrors = mixed.length
                ? [path + '.on_done: cannot be combined with ' + mixed.join(', ') + '; a route either has rules or always goes one way.']
                : [];
            return shapeErrors.concat(targetErrors(routing.onDone, names, motionEntry, path + '.on_done'));
        }
        if (isFreeFormVlm(stage.detector)) {
            return [path + ": this stage's output has no classes to match; use on_done (Always)."];
        }
        var errors = [];
        (routing.rules || []).forEach(function (rule, index) {
            errors.push.apply(errors, ruleErrors(rule, path + '.rules[' + index + ']'));
        });
        if (!isSet(routing.onMatch)) errors.push(path + '.on_match: choose where a match goes.');
        errors.push.apply(errors, targetErrors(routing.onMatch, names, motionEntry, path + '.on_match'));
        errors.push.apply(errors, targetErrors(routing.onNoMatch, names, motionEntry, path + '.on_no_match'));
        return errors;
    }

    var JAVA_CLASS_NAME = /^[\p{L}_$][\p{L}\p{N}_$]*(\.[\p{L}_$][\p{L}\p{N}_$]*)*$/u;

    function chainLevelErrors(state, mode) {
        var errors = [];
        if (isSet(state.maxRings) && (!Number.isInteger(state.maxRings) || state.maxRings < 1 || state.maxRings > 64)) {
            errors.push('max_rings: must be a whole number from 1 to 64.');
        }
        if (mode !== 'dynamic') return errors;
        var className = trimmedName((state.decisionListener || {}).className);
        if (className === '') {
            errors.push('decision_listener.class_name: add its class name.');
        } else if (!JAVA_CLASS_NAME.test(className)) {
            errors.push('decision_listener.class_name: must be a Java class name, like com.example.Decider.');
        }
        var timeout = state.decisionTimeoutSeconds;
        if (isSet(timeout) && (typeof timeout !== 'number' || !isFinite(timeout) || timeout <= 0)) {
            errors.push('decision_timeout_seconds: must be a positive number of seconds.');
        }
        return errors;
    }

    function hasSyntheticStage(state) {
        return (state.stages || []).some(function (stage) {
            return (stage.detector || {}).type === 'synthetic';
        });
    }

    /**
     * Why byte-track cannot run on the stage at `index` in this chain: a synthetic stage
     * anywhere fixes clip-window cadence (reason 'clip'); on a scene/vlm (windowed) chain
     * only the entry tracks, so a later stage is blocked by the window source (reason
     * 'window') and the entry by dynamic mode (reason 'dynamic'), its own frame thinning
     * (reason 'selection') or a route that re-enters it (reason 'route'); on a frame-cadence
     * chain a non-object entry filters what later stages see (reason 'entry'). Null when
     * byte-track is legal on that stage.
     */
    function trackingBlocker(state, index) {
        var stages = state.stages || [];
        if (!stages.length) return null;
        for (var i = 0; i < stages.length; i++) {
            if ((stages[i].detector || {}).type === 'synthetic') {
                return { reason: 'clip', name: trimmedName(stages[i].name), type: 'synthetic' };
            }
        }
        var windowStage = null;
        for (var j = 0; j < stages.length && !windowStage; j++) {
            var type = (stages[j].detector || {}).type;
            if (type === 'scene' || type === 'vlm') windowStage = stages[j];
        }
        if (!windowStage) {
            var entry = (stages[0].detector || {}).type;
            if (entry !== 'object') return { reason: 'entry', name: trimmedName(stages[0].name), type: entry };
            return null;
        }
        var windowType = (windowStage.detector || {}).type;
        if (index > 0) return { reason: 'window', name: trimmedName(windowStage.name), type: windowType };
        if (chainMode(state) === 'dynamic') return { reason: 'dynamic', name: trimmedName(windowStage.name), type: windowType };
        var selection = stages[0].frameSelection;
        if (isSet(selection) && selection.mode && selection.mode !== 'all') {
            return { reason: 'selection', name: trimmedName(stages[0].name), type: 'object' };
        }
        var entryName = trimmedName(stages[0].name);
        for (var k = 0; k < stages.length; k++) {
            var routing = stages[k].routing;
            if (!isSet(routing)) continue;
            var targets = [routing.onMatch, routing.onNoMatch, routing.onDone];
            for (var t = 0; t < targets.length; t++) {
                if (targets[t] && targets[t].stage && trimmedName(targets[t].stage) === entryName) {
                    return { reason: 'route', name: trimmedName(stages[k].name), type: windowType };
                }
            }
        }
        return null;
    }

    function trackingErrors(stage, blocker, path) {
        var detector = stage.detector || {};
        if (!blocker || isSet(stage.crop) || detector.type !== 'object') return [];
        if (!detector.tracking || detector.tracking.method !== 'byte-track') return [];
        var named = blocker.name ? " '" + blocker.name + "'" : '';
        var cause;
        if (blocker.reason === 'entry') {
            cause = 'the ' + blocker.type + ' entry stage' + named + ' filters which frames reach later stages';
        } else if (blocker.reason === 'clip') {
            cause = 'the synthetic stage' + named + ' fixes the chain to clip-window cadence';
        } else if (blocker.reason === 'window') {
            cause = 'the ' + blocker.type + ' stage' + named + ' gives the chain a multi-frame cadence and only the entry stage sees every window';
        } else if (blocker.reason === 'dynamic') {
            cause = 'a dynamic client may revisit the entry stage and re-feed the tracker the same window';
        } else if (blocker.reason === 'selection') {
            cause = 'frame selection on this stage thins the frames the tracker must see';
        } else {
            cause = 'the route on stage' + named + ' re-enters this stage, re-feeding the tracker the same window';
        }
        return [path + ".detector.tracking: 'byte-track' requires every captured frame to reach its object stage"
            + ' exactly once; ' + cause + ', so track IDs would be unreliable.'];
    }

    /**
     * Whether a stage's output is free-form text with no classes a rule could match: a VLM in
     * describe mode, or in custom mode without a response schema. A stored block without a mode
     * reads as detect when it has detect settings, custom when it has custom ones, else describe.
     */
    /**
     * Mirrors the service's resolved output shape: a custom stage with classes and no custom
     * user prompt keeps the service's per-class schema (a system prompt alone does not
     * suppress it), so its rules can match those classes.
     */
    function isFreeFormVlm(detector) {
        if (!detector || detector.type !== 'vlm') return false;
        var mode = detector.mode;
        if (!isSet(mode)) mode = isSet(detector.detect) ? 'detect' : (isSet(detector.custom) ? 'custom' : 'describe');
        if (mode === 'describe') return true;
        if (mode !== 'custom') return false;
        var custom = detector.custom || {};
        if (isSet(custom.responseSchema)) return false;
        if (!custom.classes || !custom.classes.length) return true;
        return isSet(custom.prompt) && isSet(custom.prompt.user);
    }

    /**
     * `state` with each free-form VLM stage's match-pair route rewritten as `onDone` to the
     * target its miss branch named (the end of the window when it named none): rules on such a
     * stage never match, so that branch is the one that ran.
     */
    function withFreeFormRoutesAsOnDone(state) {
        var next = copy(state);
        (next.stages || []).forEach(function (stage) {
            var routing = stage.routing;
            if (!isSet(routing) || isSet(routing.onDone) || !isFreeFormVlm(stage.detector)) return;
            stage.routing = { onDone: isSet(routing.onNoMatch) ? routing.onNoMatch : { end: true } };
        });
        return next;
    }

    function maxRingsWarnings(state, mode, count) {
        var rings = isSet(state.maxRings) ? state.maxRings : SERVER_DEFAULT_MAX_RINGS;
        if (!Number.isInteger(rings) || rings < 1 || rings > 64 || rings >= count) return [];
        var prefix = isSet(state.maxRings)
            ? 'max_rings: '
            : 'max_rings: at the default of ' + SERVER_DEFAULT_MAX_RINGS + ', ';
        if (mode === 'linear') return [prefix + 'stages ' + (rings + 1) + '+ can never run.'];
        return [prefix + 'a window stops after ' + rings + (rings === 1 ? ' stage run' : ' stage runs')
            + ', fewer than the ' + count + ' stages here.'];
    }

    function isJustMotion(classes) {
        return classes.length === 1 && typeof classes[0] === 'string'
            && classes[0].trim().toLowerCase() === 'motion';
    }

    function motionRouteWarnings(rules, path) {
        var warnings = [];
        rules.forEach(function (rule, index) {
            var rulePath = path + '[' + index + ']';
            if (isSet((rule || {}).minConfidence)) {
                warnings.push(rulePath + '.min_confidence: a motion route drops this on save; filter movement with Min Displacement.');
            }
            if (isSet((rule || {}).classes) && !isJustMotion(rule.classes)) {
                warnings.push(rulePath + '.classes: a motion route matches the motion class; the save rewrites this list.');
            }
        });
        return warnings;
    }

    // The stages a stage can hand the window to: the next one when it has no route, otherwise
    // each stage its route names.
    function nextStageIndexes(stages, names, index) {
        var routing = stages[index].routing;
        if (!isSet(routing)) return index + 1 < stages.length ? [index + 1] : [];
        return ['onMatch', 'onNoMatch', 'onDone'].map(function (key) {
            var target = routing[key];
            return isSet(target) && typeof target.stage === 'string' ? names.indexOf(target.stage.trim()) : -1;
        }).filter(function (at) { return at !== -1; });
    }

    function leadsBackTo(stages, names, from, to) {
        var seen = {};
        var queue = [from];
        while (queue.length) {
            var at = queue.shift();
            if (at === to) return true;
            if (seen[at]) continue;
            seen[at] = true;
            queue.push.apply(queue, nextStageIndexes(stages, names, at));
        }
        return false;
    }

    // A route to an earlier stage, or its own, that can lead back to this stage repeats stages
    // until max_rings ends the window. A route back to a motion entry is an error already.
    function backRouteWarnings(stages, index) {
        var routing = stages[index].routing;
        if (!isSet(routing)) return [];
        var names = stages.map(function (stage) { return trimmedName(stage.name); });
        var wire = { onMatch: 'on_match', onNoMatch: 'on_no_match', onDone: 'on_done' };
        var warnings = [];
        Object.keys(wire).forEach(function (key) {
            var target = routing[key];
            if (!isSet(target) || typeof target.stage !== 'string') return;
            var at = names.indexOf(target.stage.trim());
            if (at === -1 || at > index) return;
            if (at === 0 && (stages[0].detector || {}).type === 'motion') return;
            if (!leadsBackTo(stages, names, at, index)) return;
            warnings.push('stages[' + index + '].routing.' + wire[key] + ': goes back to stages[' + at
                + '], which leads back here, so a window can run the same stages again until max_rings ends it.');
        });
        return warnings;
    }

    function routingWarnings(stage, path) {
        var routing = stage.routing;
        if (!isSet(routing) || isSet(routing.onDone) || isFreeFormVlm(stage.detector)) return [];
        if (!(routing.rules || []).length) {
            return [path + '.routing.rules: no rules — this route always takes the No-match path.'];
        }
        if ((stage.detector || {}).type === 'motion') {
            return motionRouteWarnings(routing.rules, path + '.routing.rules');
        }
        return [];
    }

    function chainWarnings(state, mode) {
        var stages = state.stages || [];
        var warnings = maxRingsWarnings(state, mode, stages.length);
        if (hasSyntheticStage(state)) {
            warnings.push('stages: a synthetic stage runs on-demand only — live streams matching this config will refuse to start.');
        }
        stages.forEach(function (stage, index) {
            var selection = stage.frameSelection;
            if ((stage.detector || {}).type !== 'motion' || !selection || !selection.mode || selection.mode === 'all') return;
            warnings.push('stages[' + index + '].frame_selection: a motion stage compares each frame with the one before it;'
                + ' looking at fewer frames keeps it from seeing movement. Set it back to every frame.');
        });
        stages.forEach(function (stage, index) {
            var source = deadCropSource(stages, mode, index);
            if (source === -1) return;
            warnings.push('stages[' + index + '].frame_selection: looks at different frames than stages[' + source
                + '], so it never gets a box to look inside.');
        });
        if (mode !== 'conditional') return warnings;
        stages.forEach(function (stage, index) {
            warnings.push.apply(warnings, routingWarnings(stage, 'stages[' + index + ']'));
            warnings.push.apply(warnings, backRouteWarnings(stages, index));
        });
        return warnings;
    }

    /**
     * The shapes the editor must never save, as `errors`, and the legal-but-degraded ones
     * a save still allows, as `warnings`. Pure; each message starts with the member's wire
     * path (`stages[1].crop: ...`).
     */
    /**
     * The steps still waiting for what they look for, as errors in validateChain's form. The
     * Manager asks for picks even where the service would take none: an object step's empty
     * list means everything there, which should be chosen on purpose with Select all.
     */
    function missingPicks(state) {
        var named = function (list) {
            return Array.isArray(list) && list.some(function (name) { return typeof name === 'string' && name.trim() !== ''; });
        };
        var errors = [];
        (state.stages || []).forEach(function (stage, index) {
            var detector = stage.detector || {};
            var path = 'stages[' + index + ']';
            if ((detector.type === 'object' || detector.type === 'scene') && !named(detector.classes)) {
                errors.push(path + '.detector.classes: pick at least one thing to look for.');
            } else if (detector.type === 'vlm' && detector.mode === 'detect' && !named((detector.detect || {}).classes)) {
                errors.push(path + '.detector.detect.classes: add at least one thing to check for.');
            }
        });
        return errors;
    }

    function validateChain(state) {
        var stages = state.stages || [];
        var mode = chainMode(state);
        var errors = chainLevelErrors(state, mode);
        if (stages.length === 0) errors.push('stages: add at least one step.');
        var names = stages.map(function (stage) { return trimmedName(stage.name); });
        var entryIsMotion = stages.length > 0 && (stages[0].detector || {}).type === 'motion';
        var motionEntry = entryIsMotion ? trimmedName(stages[0].name) : '';
        var windowStage = windowStageIndex(state);
        var seen = {};
        stages.forEach(function (stage, index) {
            var path = 'stages[' + index + ']';
            var type = stage.detector && stage.detector.type;
            errors.push.apply(errors, stageNameErrors(stage, path, seen));
            if (STAGE_TYPES.indexOf(type) === -1) {
                errors.push(path + '.detector.type: must be object, scene, vlm, motion or synthetic.');
            } else if (type === 'synthetic' && mode === 'dynamic') {
                errors.push(path + '.detector.type: a dynamic chain holds frames only and cannot run a synthetic stage.');
            } else if (type === 'synthetic' && entryIsMotion) {
                errors.push(path + '.detector.type: a synthetic stage switches the chain to clip windows, which a motion entry does not support.');
            } else if (type === 'motion' && index > 0) {
                errors.push(path + '.detector.type: motion runs only as the entry stage; a later motion stage would compare frames across routed gaps.');
            }
            errors.push.apply(errors, frameSelectionErrors(stage, type, path));
            errors.push.apply(errors, frameCadenceErrors(stage, windowStage, path));
            errors.push.apply(errors, cropErrors(stages, index, mode, path));
            errors.push.apply(errors, trackingErrors(stage, trackingBlocker(state, index), path));
            errors.push.apply(errors, routingErrors(stage, mode, names, motionEntry, path));
        });
        return { errors: errors, warnings: chainWarnings(state, mode) };
    }

    // ── transitions ──────────────────────────────────────────────────────────

    function checkIndex(index, size) {
        if (!Number.isInteger(index) || index < 0 || index >= size) {
            throw new RangeError('no stage at index ' + index);
        }
    }

    function checkStageType(type) {
        if (STAGE_TYPES.indexOf(type) === -1) throw new TypeError('a chain stage cannot be ' + type);
    }

    /** Replaces stage `index`'s detector with a bare one of `type`; the old type's members drop. */
    function setStageType(state, index, type) {
        checkIndex(index, state.stages.length);
        checkStageType(type);
        var next = copy(state);
        var stage = next.stages[index];
        if (stage.detector && stage.detector.type === type) return next;
        stage.detector = { type: type };
        if (type === 'synthetic') {
            delete stage.crop;
            if (stage.frameSelection && stage.frameSelection.mode !== 'all') delete stage.frameSelection;
        }
        if (type === 'motion') delete stage.crop;
        return next;
    }

    /** Sets the execution mode, dropping the members the mode being left owned. */
    function switchMode(state, mode) {
        if (MODES.indexOf(mode) === -1) throw new TypeError('unknown chain mode ' + mode);
        var next = copy(state);
        next.mode = mode;
        if (mode !== 'conditional') {
            next.stages.forEach(function (stage) { delete stage.routing; });
        }
        if (mode !== 'dynamic') {
            DYNAMIC_MEMBERS.forEach(function (key) { delete next[key]; });
        }
        return next;
    }

    /** Inserts an unnamed stage of `type` at `atIndex`, the end when omitted. */
    function addStage(state, type, atIndex) {
        checkStageType(type);
        var at = atIndex === undefined ? state.stages.length : atIndex;
        checkIndex(at, state.stages.length + 1);
        var next = copy(state);
        next.stages.splice(at, 0, { name: '', detector: { type: type } });
        return next;
    }

    function removeStage(state, index) {
        checkIndex(index, state.stages.length);
        var next = copy(state);
        next.stages.splice(index, 1);
        return next;
    }

    /** Moves stage `index` by `delta` places; a move past either end changes nothing. */
    function moveStage(state, index, delta) {
        checkIndex(index, state.stages.length);
        var next = copy(state);
        var target = index + delta;
        if (target < 0 || target >= next.stages.length) return next;
        var moved = next.stages.splice(index, 1)[0];
        next.stages.splice(target, 0, moved);
        return next;
    }

    /**
     * Renames stage `index` and points every route that named its old trimmed name at the new one.
     * Routes stay put when either name is shared with another stage, since they can't tell which
     * stage they meant.
     */
    function renameStage(state, index, name) {
        checkIndex(index, state.stages.length);
        var next = copy(state);
        var from = trimmedName(next.stages[index].name);
        var to = trimmedName(name);
        var shared = next.stages.some(function (stage, i) {
            return i !== index && (trimmedName(stage.name) === from || trimmedName(stage.name) === to);
        });
        next.stages[index].name = name;
        if (from === '' || to === '' || shared) return next;
        next.stages.forEach(function (stage) {
            if (!stage.routing) return;
            ['onMatch', 'onNoMatch', 'onDone'].forEach(function (key) {
                var target = stage.routing[key];
                if (target && typeof target.stage === 'string' && target.stage.trim() === from) target.stage = to;
            });
        });
        return next;
    }

    window.VIF.chainEditor = {
        STAGE_TYPES: STAGE_TYPES,
        MODES: MODES,
        FRAME_SELECTION_MODES: FRAME_SELECTION_MODES,
        STAGE_DETECTOR_MEMBERS: STAGE_DETECTOR_MEMBERS,
        chainMode: chainMode,
        initChain: initChain,
        newChain: newChain,
        collectChainDetector: collectChainDetector,
        validateChain: validateChain,
        missingPicks: missingPicks,
        hasSyntheticStage: hasSyntheticStage,
        trackingBlocker: trackingBlocker,
        windowStageIndex: windowStageIndex,
        selectedFrameCount: selectedFrameCount,
        isFreeFormVlm: isFreeFormVlm,
        withFreeFormRoutesAsOnDone: withFreeFormRoutesAsOnDone,
        offersCrop: offersCrop,
        cropSources: cropSources,
        cropFrameChoices: cropFrameChoices,
        lockedMotionRule: lockedMotionRule,
        setStageType: setStageType,
        switchMode: switchMode,
        addStage: addStage,
        removeStage: removeStage,
        moveStage: moveStage,
        renameStage: renameStage
    };
})();
