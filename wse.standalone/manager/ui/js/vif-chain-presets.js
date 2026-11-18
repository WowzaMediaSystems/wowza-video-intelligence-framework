// vif-chain-presets.js - what a chain step starts as and what a new condition waits for,
// shared by the Get started screen's guided setup and the builder's own Add a step and
// Add a condition, so a chain built by hand matches one the guided setup builds. Each
// returns chain editor state (vif-chain-editor.js) and is pure, so it is tested under
// plain Node (src/test/js/vif-chain-presets.test.js).
(function () {
    'use strict';

    window.VIF = window.VIF || {};

    var GATE_CONFIDENCE = 0.5;
    // NVIDIA's two named settings for the AI-generated video detector: a clip counts as
    // AI-generated when its score is above the setting.
    var SYNTHETIC_BALANCED = 0.44;
    var SYNTHETIC_CATCH_MORE = 0.26;

    var STAGES = {
        motion: function () { return { name: 'movement', detector: { type: 'motion' } }; },
        // What a step looks for is the user's to pick; a new step starts with nothing picked.
        object: function () { return { name: 'objects', detector: { type: 'object', classes: [] } }; },
        scene: function () { return { name: 'scene', detector: { type: 'scene', classes: [] } }; },
        // An AI model step gets every chosen frame in one request, so it starts on one frame.
        vlm: function () { return { name: 'ask-ai', detector: { type: 'vlm', mode: 'describe' }, frameSelection: { mode: 'middle' } }; },
        // A new check starts on the balanced setting rather than on whatever the default is.
        synthetic: function () { return { name: 'ai-check', detector: { type: 'synthetic', classificationThreshold: SYNTHETIC_BALANCED } }; }
    };

    // Names an AI model step was once given; chains saved with them still count as unnamed.
    var EARLIER_GIVEN_NAMES = ['describe', 'check'];

    /**
     * Whether `name` is one a new step is given (objects, scene-2, …) rather than one someone
     * chose, so a step's box shows only names that were chosen.
     */
    function isGivenName(name) {
        var match = /^(.+?)(?:-\d+)?$/.exec(typeof name === 'string' ? name.trim() : '');
        if (!match) return false;
        return Object.keys(STAGES).some(function (type) { return STAGES[type]().name === match[1]; })
            || EARLIER_GIVEN_NAMES.indexOf(match[1]) !== -1;
    }

    /** A fresh step of `type`, with the settings every new step of that type starts with. */
    function newStage(type) {
        if (!STAGES[type]) throw new RangeError('no step type ' + type);
        return STAGES[type]();
    }

    // The guided setup's safety check: the AI model step asked about named things.
    function checkStage() {
        return { name: 'ask-ai', detector: { type: 'vlm', mode: 'detect', detect: { classes: [], reasoningLevel: 'low' } },
            frameSelection: { mode: 'middle' } };
    }

    /** What a condition on `stage` waits for: movement, an AI-generated verdict, or whatever the step itself looks for. */
    function gateClasses(stage) {
        var detector = stage.detector || {};
        if (detector.type === 'motion') return ['motion'];
        if (detector.type === 'synthetic') return ['synthetic'];
        if (detector.type === 'object' || detector.type === 'scene') return (detector.classes || []).slice();
        if (detector.type === 'vlm' && detector.detect) return (detector.detect.classes || []).slice();
        return [];
    }

    /**
     * The condition a step starts with: it waits for what the step looks for, at half
     * confidence for an object step, goes on to `next`, and otherwise ends the chain.
     * A scene step's confidence already starts at its own sensitivity cutoff, so a scene
     * condition takes whatever the step reports. A step that answers in free text has nothing
     * to wait for, so its condition always goes on to `next`.
     */
    function conditionFor(stage, next) {
        var classes = gateClasses(stage);
        var type = (stage.detector || {}).type;
        var nextName = next && typeof next.name === 'string' ? next.name.trim() : '';
        var target = nextName ? { stage: nextName } : { end: true };
        if (window.VIF.chainEditor.isFreeFormVlm(stage.detector)) return { onDone: target };
        var rule = classes.length ? { classes: classes } : {};
        if (type === 'object') rule.minConfidence = GATE_CONFIDENCE;
        return { rules: [rule], match: 'any', onMatch: target, onNoMatch: { end: true } };
    }

    // In run order: a guided chain follows this order whatever order the picks arrive in.
    // AI-generated video and movement can't share a chain; with both picked, movement is dropped.
    var GUIDED_STAGES = {
        synthetic: STAGES.synthetic,
        motion: STAGES.motion,
        objects: STAGES.object,
        scene: STAGES.scene,
        check: checkStage,
        describe: STAGES.vlm
    };
    var GUIDED_PICKS = Object.keys(GUIDED_STAGES);

    /**
     * Whether a step gets a condition on the step after it by default: any step that reports
     * something to wait for does, even before its picks are made, since its condition follows
     * them. An AI description or answer in its own words reports nothing a condition can match.
     */
    function gatesNext(stage) {
        var detector = stage.detector || {};
        if (detector.type === 'vlm') return detector.mode === 'detect';
        return ['motion', 'object', 'scene', 'synthetic'].indexOf(detector.type) !== -1;
    }

    /** The chain the guided setup builds from `picks` (keys of GUIDED_PICKS); unknown keys are ignored. */
    function guidedChain(picks) {
        var chosen = GUIDED_PICKS.filter(function (key) { return (picks || []).indexOf(key) !== -1; });
        if (chosen.indexOf('synthetic') !== -1) chosen = chosen.filter(function (key) { return key !== 'motion'; });
        var stages = chosen.map(function (key) { return GUIDED_STAGES[key](); });
        // Both AI model picks start with the same name; the second takes a number.
        var named = {};
        stages.forEach(function (stage) {
            var count = named[stage.name] = (named[stage.name] || 0) + 1;
            if (count > 1) stage.name += '-' + count;
        });
        var routed = false;
        stages.forEach(function (stage, index) {
            var next = stages[index + 1];
            if (!next || !gatesNext(stage)) return;
            stage.routing = conditionFor(stage, next);
            routed = true;
        });
        return { mode: routed ? 'conditional' : 'linear', stages: stages };
    }

    function trimmed(name) { return typeof name === 'string' ? name.trim() : ''; }

    /**
     * `state` after the step named `removed` was taken out, with the conditions that pointed at it
     * repaired: one that went to it goes on to `following` (the step that came after it), or is
     * dropped when there is none; an otherwise that went to it stops instead. Returns a new state.
     */
    function repairAfterRemoval(state, removed, following) {
        var next = JSON.parse(JSON.stringify(state));
        var gone = trimmed(removed);
        if (!gone) return next;
        var after = trimmed(following);
        next.stages.forEach(function (stage) {
            var routing = stage.routing;
            if (!routing) return;
            ['onMatch', 'onDone'].forEach(function (key) {
                if (!routing[key] || trimmed(routing[key].stage) !== gone) return;
                if (after && after !== trimmed(stage.name)) routing[key] = { stage: after };
                else delete stage.routing;
            });
            if (!stage.routing) return;
            if (routing.onNoMatch && trimmed(routing.onNoMatch.stage) === gone) routing.onNoMatch = { end: true };
        });
        return next;
    }

    /**
     * `state` with the step just added at `index` given the conditions the guided setup would
     * give it: a condition before it that went on to the step it now sits in front of goes on to
     * it instead, a step before it with no condition waits for what it finds, and the new step
     * gates the one after it when it reports something. Returns a new state.
     */
    function wireInsertedStage(state, index) {
        var next = JSON.parse(JSON.stringify(state));
        var stage = next.stages[index];
        var previous = next.stages[index - 1];
        var following = next.stages[index + 1];
        var followingName = following ? trimmed(following.name) : '';
        if (previous && previous.routing) {
            ['onMatch', 'onDone'].forEach(function (key) {
                var target = previous.routing[key];
                if (target && followingName && trimmed(target.stage) === followingName) previous.routing[key] = { stage: trimmed(stage.name) };
            });
        } else if (previous && gatesNext(previous)) {
            previous.routing = conditionFor(previous, stage);
        }
        if (following && gatesNext(stage)) stage.routing = conditionFor(stage, following);
        if ((previous && previous.routing) || stage.routing) next.mode = 'conditional';
        return next;
    }

    /**
     * `state` with step `from` moved by `delta`, the way the step order reads: a condition that
     * went on to the step right after it goes on to whichever step follows it now, and one left
     * with nothing after it is dropped. Watch for movement always runs first, so a move that
     * would take it off the top or put a step above it leaves the chain as it was. Returns a
     * new state.
     */
    function moveStageRewiringNextSteps(state, from, delta) {
        var stages = state.stages || [];
        var to = from + delta;
        var startsWithMotion = stages.length > 0 && (stages[0].detector || {}).type === 'motion';
        if (startsWithMotion && (from === 0 || to === 0)) return JSON.parse(JSON.stringify(state));
        var moved = window.VIF.chainEditor.moveStage(state, from, delta);
        if (window.VIF.chainEditor.chainMode(moved) === 'dynamic') return moved;
        var order = stages.map(function (stage, index) { return index; });
        if (to >= 0 && to < order.length) order.splice(to, 0, order.splice(from, 1)[0]);
        moved.stages.forEach(function (stage, at) {
            var routing = stage.routing;
            if (!routing) return;
            var wasNext = stages[order[at] + 1] ? trimmed(stages[order[at] + 1].name) : '';
            var nowNext = moved.stages[at + 1] ? trimmed(moved.stages[at + 1].name) : '';
            if (!wasNext || wasNext === nowNext) return;
            ['onMatch', 'onDone'].forEach(function (key) {
                if (!stage.routing || !routing[key] || trimmed(routing[key].stage) !== wasNext) return;
                if (nowNext) routing[key] = { stage: nowNext };
                else delete stage.routing;
            });
        });
        return moved;
    }

    /**
     * What a condition waits for (`waitsFor`) once its step's picks change from `before` to
     * `after`. A dropped pick leaves the condition; a new pick joins it only while it waited
     * for exactly what the step looked for, so a condition narrowed on purpose stays narrow.
     * One that would wait for nothing, and so never be met, waits for the step's picks. One
     * whose step had nothing picked keeps what it waited for that the step now looks for, and
     * takes on the step's picks only when none of it is left.
     */
    function conditionAfterPicks(waitsFor, before, after) {
        if (!before.length && after.length) {
            var kept = waitsFor.filter(function (name) { return after.indexOf(name) !== -1; });
            return kept.length ? kept : after.slice();
        }
        var dropped = before.filter(function (name) { return after.indexOf(name) === -1; });
        var added = after.filter(function (name) { return before.indexOf(name) === -1; });
        var matched = before.length > 0 && waitsFor.length === before.length
            && waitsFor.every(function (name) { return before.indexOf(name) !== -1; });
        var next = waitsFor.filter(function (name) { return dropped.indexOf(name) === -1; });
        if (matched) next = next.concat(added);
        if (!next.length) next = after.length ? after.slice() : waitsFor.slice();
        return next;
    }

    /**
     * `state` with zoom turned off on every step that has no boxes to zoom in on: the first
     * step, which nothing runs before, and any step none of whose leading steps draws boxes
     * (see the editor's cropSources). Dynamic mode decides at runtime and is left alone.
     * Returns a new state.
     */
    function withoutBoxlessZoom(state) {
        var next = JSON.parse(JSON.stringify(state));
        (next.stages || []).forEach(function (stage, index) {
            if (!stage.crop) return;
            var sources = window.VIF.chainEditor.cropSources(next, index);
            if (sources === null) return;
            var drawsBoxes = sources.some(function (each) {
                var type = (each.detector || {}).type;
                return type === 'object' || type === 'motion';
            });
            if (!drawsBoxes) delete stage.crop;
        });
        return next;
    }

    /**
     * `state` with no condition on a step that has just become its last, by uid against `before`,
     * when that condition goes on to a step: the step it names now comes earlier. A condition that
     * only stops the chain filters what the chain delivers, so it stays wherever the step lands.
     * Your code deciding has no conditions, so it is left alone. Returns a new state.
     */
    function withoutLastStepCondition(before, state) {
        var next = JSON.parse(JSON.stringify(state));
        var stages = next.stages || [];
        var last = stages[stages.length - 1];
        var was = (before.stages || [])[(before.stages || []).length - 1];
        var becameLast = !!last && (!was || last.uid === undefined || last.uid !== was.uid);
        var goesOn = !!last && !!last.routing && ['onMatch', 'onNoMatch', 'onDone'].some(function (key) {
            return !!last.routing[key] && trimmed(last.routing[key].stage) !== '';
        });
        if (becameLast && goesOn && window.VIF.chainEditor.chainMode(next) !== 'dynamic') delete last.routing;
        return next;
    }

    /**
     * `state` with following objects turned off on each step the chain can't pass every
     * frame exactly once (see the editor's trackingBlocker). Returns a new state.
     */
    function withoutBlockedFollowing(state) {
        var next = JSON.parse(JSON.stringify(state));
        (next.stages || []).forEach(function (stage, index) {
            var tracking = (stage.detector || {}).tracking;
            if (!tracking || tracking.method !== 'byte-track') return;
            if (window.VIF.chainEditor.trackingBlocker(next, index)) stage.detector.tracking = { method: 'none' };
        });
        return next;
    }

    /** A model file's name as people read it: models/fire_smoke.pth reads "Fire smoke". */
    function modelLabel(path) {
        var base = String(path || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
        return base ? base.charAt(0).toUpperCase() + base.slice(1) : '';
    }

    window.VIF.chainPresets = {
        conditionAfterPicks: conditionAfterPicks,
        modelLabel: modelLabel,
        withoutBlockedFollowing: withoutBlockedFollowing,
        withoutBoxlessZoom: withoutBoxlessZoom,
        withoutLastStepCondition: withoutLastStepCondition,
        repairAfterRemoval: repairAfterRemoval,
        moveStageRewiringNextSteps: moveStageRewiringNextSteps,
        wireInsertedStage: wireInsertedStage,
        GUIDED_PICKS: GUIDED_PICKS,
        SYNTHETIC_BALANCED: SYNTHETIC_BALANCED,
        SYNTHETIC_CATCH_MORE: SYNTHETIC_CATCH_MORE,
        newStage: newStage,
        isGivenName: isGivenName,
        gatesNext: gatesNext,
        conditionFor: conditionFor,
        guidedChain: guidedChain
    };
})();
