// vif-chain-builder.js - the chain builder's views: the step palette, the flow of step tiles
// with the connectors between them, the Get started screen and the results strip.
//
// It draws from chain editor state (vif-chain-editor.js) and reports what the user did through
// callbacks. The stream config page owns the state, the per-step settings forms, the selection
// and saving. The wording helpers are pure and tested under plain Node
// (src/test/js/vif-chain-builder.test.js); the render functions need a DOM.
(function () {
    'use strict';

    window.VIF = window.VIF || {};

    var STEPS = {
        motion: { label: 'Watch for movement', icon: 'M3 12h4l3-7 4 14 3-7h4',
                  blurb: 'A quick check that wakes the later steps only when something moves. Always the first step.' },
        object: { label: 'Find objects', icon: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
                  blurb: 'Finds people, vehicles and other everyday things, and draws a box around each one.' },
        scene: { label: 'Recognize a scene', icon: 'M3 5h18v14H3zM3 15l5-5 5 5 3-3 5 5',
                 blurb: 'Recognizes what is happening, such as fire, smoke or a crowd forming.' },
        vlm: { label: 'Ask an AI model', icon: 'M4 5h16v11h-9l-5 4v-4H4z',
               blurb: 'Describes what is in view, or checks for things you name in plain words.' },
        synthetic: { label: 'Spot AI-generated video', chip: 'AI-generated video', icon: 'M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z',
                     blurb: 'Scores how likely the video was made by AI. Recorded video only.' }
    };
    var STEP_ORDER = ['motion', 'object', 'scene', 'vlm', 'synthetic'];

    var GUIDED_CARDS = [
        { pick: 'motion', title: 'Movement', text: 'Only look when something moves. Saves effort on quiet cameras.', icon: STEPS.motion.icon },
        { pick: 'objects', title: 'Objects', text: 'Find and box everything the model knows, or just the things you pick.', icon: STEPS.object.icon },
        { pick: 'scene', title: 'A situation', text: 'Recognize situations you name, such as fire or a crowd forming.', icon: STEPS.scene.icon },
        { pick: 'check', title: 'Specific things you name', text: 'An AI model checks for each thing you list, such as a person not wearing a hard hat.',
          icon: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11' },
        { pick: 'describe', title: 'A plain description', text: 'An AI model writes what is happening.', icon: STEPS.vlm.icon },
        { pick: 'synthetic', title: 'AI-generated video', text: 'Scores whether the video was made by AI. Recorded video only.', icon: STEPS.synthetic.icon }
    ];
    var GUIDED_PREVIEW = { synthetic: 'AI-generated video', motion: 'Movement', objects: 'Objects', scene: 'A situation',
                           check: 'Check for things you name', describe: 'Describe with an AI model' };

    // Movement and AI-generated video can't share a chain, the same rule the palette applies.
    function guidedBlockReason(pick, picks) {
        if (pick === 'synthetic' && picks.indexOf('motion') !== -1) return 'Can’t join a chain that watches for movement.';
        if (pick === 'motion' && picks.indexOf('synthetic') !== -1) return 'Can’t join a chain that spots AI-generated video.';
        return '';
    }

    function isSet(value) { return value !== undefined && value !== null; }

    function percent(fraction) { return Math.round(fraction * 1000) / 10; }

    function listText(list, joiner) {
        return list && list.length ? list.join(joiner || ', ') : '';
    }

    function sameSet(a, b) {
        return (a || []).length === (b || []).length && (a || []).every(function (name) { return (b || []).indexOf(name) !== -1; });
    }

    // A long list of picks reads as its first few and how many more; all of a model's list
    // (`known`) reads as everything it knows.
    function picksText(list, known, joiner) {
        if (known && known.length && sameSet(list, known)) return 'Everything it knows';
        if (list && list.length > 6) return list.slice(0, 3).join(joiner || ', ') + ' and ' + (list.length - 3) + ' more';
        return listText(list, joiner);
    }

    function stepLabel(type) {
        return STEPS[type] ? STEPS[type].label : String(type || 'Unknown step');
    }

    function vlmTask(detector) {
        if (detector.mode) return detector.mode;
        if (detector.detect) return 'detect';
        if (detector.custom) return 'custom';
        return 'describe';
    }

    function detectorSummary(detector, known) {
        switch (detector.type) {
            case 'motion':
                return isSet(detector.sensitivity) ? 'Sensitivity ' + detector.sensitivity + ' of 10' : 'Default sensitivity';
            case 'object': {
                var what = picksText(detector.classes, known);
                var text = isSet(detector.checkpointPath)
                    ? window.VIF.chainPresets.modelLabel(detector.checkpointPath) + ' model: ' + (what || 'nothing picked yet')
                    : what || 'Nothing picked yet';
                if (isSet(detector.minConfidence)) text += ', ' + percent(detector.minConfidence) + '% sure or more';
                if (detector.tracking && detector.tracking.method === 'byte-track') text += ', follows each one';
                return text;
            }
            case 'scene':
                return listText(detector.classes) || 'No scenes yet';
            case 'vlm': {
                var task = vlmTask(detector);
                if (task === 'detect') return 'Checks for ' + (listText((detector.detect || {}).classes) || 'nothing yet');
                if (task === 'custom') return 'Follows your instructions';
                return 'Describes what it sees';
            }
            case 'synthetic':
                return isSet(detector.classificationThreshold)
                    ? 'Flags clips scoring above ' + percent(detector.classificationThreshold) + '%'
                    : 'Flags clips that look AI-generated';
            default:
                return '';
        }
    }

    /**
     * One line saying what a step does, in the words its tile shows. `known`, when given, is
     * everything a Find objects step's model finds.
     */
    function stepSummary(stage, known) {
        var parts = [detectorSummary(stage.detector || {}, known)];
        var selection = stage.frameSelection;
        if (selection && selection.mode === 'every_nth' && isSet(selection.stride)) parts.push('one frame in every ' + selection.stride);
        else if (selection && selection.mode && selection.mode !== 'all') parts.push(selection.mode + ' frame only');
        if (stage.crop) parts.push('inside each ' + (listText(stage.crop.classes, ' or ') || 'box'));
        return parts.filter(Boolean).join(' · ');
    }

    // A rule waiting for every one of a long list of its step's picks reads as anything the step looks for.
    function ruleText(rule, stage) {
        var picks = ((stage || {}).detector || {}).classes;
        var text = (rule.classes || []).length > 6 && sameSet(rule.classes, picks) ? 'anything it looks for'
            : picksText(rule.classes, null, ' or ') || 'nothing picked';
        var limits = [];
        if (isSet(rule.minConfidence)) limits.push(percent(rule.minConfidence) + '% sure or more');
        if (isSet(rule.minCount) && rule.minCount > 1) limits.push('at least ' + rule.minCount);
        return limits.length ? text + ' (' + limits.join(', ') + ')' : text;
    }

    function stepIndexNamed(stages, name) {
        for (var i = 0; i < (stages || []).length; i++) {
            if (typeof stages[i].name === 'string' && stages[i].name.trim() === name) return i;
        }
        return -1;
    }

    // A go-to target by step number and label when the chain's steps are given; by name otherwise.
    function targetText(target, stages) {
        if (!target || typeof target.stage !== 'string') return 'stop';
        var name = target.stage.trim();
        var index = stepIndexNamed(stages, name);
        if (index === -1) return 'go to ' + name;
        return 'go to step ' + (index + 1) + ' (' + stepLabel((stages[index].detector || {}).type) + ')';
    }

    /**
     * A step's condition in plain words: `when` it holds, `then` what runs, and `otherwise`
     * what runs when it does not. Null when the step has no condition. With the chain's
     * `stages`, go-to targets read as step numbers rather than names.
     */
    function conditionText(stage, stages) {
        var routing = stage.routing;
        if (!routing) return null;
        // An always route has no rules: whatever the step found, the chain goes one way.
        if (routing.onDone) return { when: 'Every time', then: targetText(routing.onDone, stages), otherwise: 'stop' };
        var rules = routing.rules || [];
        var when;
        var type = (stage.detector || {}).type;
        if (type === 'motion') when = 'When something moves';
        else if (type === 'synthetic') when = 'When the clip looks AI-generated';
        else if (!rules.length) when = 'Never matches';
        // A rule waiting for nothing is never met, so the chain stops here every time.
        else if (rules.every(function (rule) { return !(rule.classes || []).length; })) when = 'Nothing picked to wait for';
        else when = 'When it finds ' + rules.map(function (rule) { return ruleText(rule, stage); }).join(routing.match === 'all' ? ', and also ' : ', or ');
        return { when: when, then: targetText(routing.onMatch, stages), otherwise: targetText(routing.onNoMatch, stages) };
    }

    function stepNamed(stages, target) {
        return target && typeof target.stage === 'string' ? stepIndexNamed(stages, target.stage.trim()) : -1;
    }

    /**
     * Where conditions send the chain other than straight on to the next step: each outcome
     * that goes to another step, or stops short of a later step, as { from, to, kind } with
     * `to` a step index or 'end' and `kind` 'then' or 'otherwise'. Stopping when the
     * condition fails is the usual case and is left out, as is stopping after the last step.
     */
    function branches(stages) {
        var out = [];
        (stages || []).forEach(function (stage, index) {
            var routing = stage.routing;
            if (!routing) return;
            var outcomes = routing.onDone ? [['then', routing.onDone]] : [['then', routing.onMatch], ['otherwise', routing.onNoMatch]];
            outcomes.forEach(function (outcome) {
                var kind = outcome[0], target = outcome[1];
                var to = stepNamed(stages, target);
                if (to !== -1) {
                    if (to !== index + 1) out.push({ from: index, to: to, kind: kind });
                } else if (kind === 'then' && index < stages.length - 1) {
                    out.push({ from: index, to: 'end', kind: kind });
                }
            });
        });
        return out;
    }

    /** Whether the condition after step `index` stops the chain short of a later step, which drawBranches marks with a dot. */
    function stopsShort(stages, index) {
        return branches(stages).some(function (branch) { return branch.from === index && branch.to === 'end'; });
    }

    /**
     * Whether some condition that isn't met stops the chain: the clip then sends no detections.
     * A miss that goes to another step runs that step instead. Reads the outcome as the
     * condition chip words it (see conditionText).
     */
    function missStops(stages) {
        return (stages || []).some(function (stage) {
            return !!stage.routing && !stage.routing.onDone && conditionText(stage, stages).otherwise === 'stop';
        });
    }

    /** Whether the step after `index` can follow straight on from it: no condition, or one whose outcome leads there. */
    function leadsOn(stages, index) {
        var routing = (stages[index] || {}).routing;
        if (!routing) return true;
        return [routing.onMatch, routing.onNoMatch, routing.onDone].some(function (target) { return stepNamed(stages, target) === index + 1; });
    }

    /**
     * The steps nothing leads to: not the first, not straight on from the step before, and no
     * condition's target. They never run until a Go to points at them.
     */
    function unreachable(stages) {
        var list = stages || [];
        var targeted = {};
        branches(list).forEach(function (branch) { if (branch.to !== 'end') targeted[branch.to] = true; });
        var out = [];
        for (var i = 1; i < list.length; i++) {
            if (!leadsOn(list, i - 1) && !targeted[i]) out.push(i);
        }
        return out;
    }

    /** The guided setup's chain, in run order, as the words its preview line shows. */
    function guidedPreview(picks) {
        var shown = window.VIF.chainPresets.GUIDED_PICKS.filter(function (pick) { return (picks || []).indexOf(pick) !== -1; });
        return shown.length ? shown.map(function (pick) { return GUIDED_PREVIEW[pick]; }).join(' → ') : 'Nothing picked yet.';
    }

    /** Where a dragged stage at `from` lands when dropped at gap `at` (0 is before the first). */
    function moveTarget(from, at) {
        return at > from ? at - 1 : at;
    }

    // ── DOM helpers ──────────────────────────────────────────────────────────

    var SVG_NS = 'http://www.w3.org/2000/svg';

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function button(text, className, onClick) {
        var node = el('button', className, text);
        node.type = 'button';
        if (onClick) node.addEventListener('click', onClick);
        return node;
    }

    function icon(path, size) {
        var svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', String(size || 18));
        svg.setAttribute('height', String(size || 18));
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.8');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        var line = document.createElementNS(SVG_NS, 'path');
        line.setAttribute('d', path);
        svg.appendChild(line);
        return svg;
    }

    function iconBox(path) {
        var box = el('span', 'cb-icon');
        box.appendChild(icon(path));
        return box;
    }

    var DRAG_TYPE = 'text/x-vif-step';
    var DRAG_STAGE = 'text/x-vif-stage';

    function draggedKind(event) {
        var types = Array.prototype.slice.call(event.dataTransfer ? event.dataTransfer.types : []);
        if (types.indexOf(DRAG_STAGE) !== -1) return 'stage';
        if (types.indexOf(DRAG_TYPE) !== -1) return 'type';
        return '';
    }

    // ── palette ──────────────────────────────────────────────────────────────

    /**
     * The "Add a step" list. `blocked` maps a step type to the reason it cannot be added now;
     * `onAdd(type)` runs on a click, and every unblocked step can also be dragged into the flow.
     */
    function renderPalette(container, blocked, onAdd) {
        container.replaceChildren();
        container.appendChild(el('span', 'cb-heading', 'Add a step:'));
        STEP_ORDER.forEach(function (type) {
            var reason = (blocked || {})[type] || '';
            var item = button('', 'cb-step', function () { if (!reason) onAdd(type); });
            // Not disabled, so the reason still shows as a tooltip.
            item.classList.toggle('is-blocked', !!reason);
            item.setAttribute('aria-disabled', String(!!reason));
            item.draggable = !reason;
            item.dataset.stepType = type;
            item.title = reason || STEPS[type].blurb;
            item.append(iconBox(STEPS[type].icon), el('span', 'cb-step-label', STEPS[type].chip || STEPS[type].label));
            item.setAttribute('aria-label', STEPS[type].label);
            item.addEventListener('dragstart', function (event) {
                event.dataTransfer.setData(DRAG_TYPE, type);
                event.dataTransfer.effectAllowed = 'copy';
            });
            container.appendChild(item);
        });
    }

    // ── flow ─────────────────────────────────────────────────────────────────

    function dropZone(at, actions, label) {
        var zone = el('div', 'cb-drop' + (label ? ' cb-drop-empty' : ''), label || '');
        zone.dataset.at = String(at);
        zone.addEventListener('dragover', function (event) {
            if (!draggedKind(event)) return;
            event.preventDefault();
            zone.classList.add('is-over');
        });
        zone.addEventListener('dragleave', function () { zone.classList.remove('is-over'); });
        zone.addEventListener('drop', function (event) {
            zone.classList.remove('is-over');
            var kind = draggedKind(event);
            if (!kind) return;
            event.preventDefault();
            if (kind === 'type') actions.insert(event.dataTransfer.getData(DRAG_TYPE), at);
            else actions.move(Number(event.dataTransfer.getData(DRAG_STAGE)), at);
        });
        return zone;
    }

    function startsWithMotion(stages) {
        return ((stages[0] || {}).detector || {}).type === 'motion';
    }

    // The gap above Watch for movement, which always runs first: it keeps its place but takes no drops.
    function gapAt(at, stages, actions) {
        return at === 0 && startsWithMotion(stages) ? el('div', 'cb-drop') : dropZone(at, actions);
    }

    function stageTile(stage, index, view) {
        var type = (stage.detector || {}).type;
        var tile = el('div', 'cb-tile');
        tile.draggable = !(index === 0 && type === 'motion');
        tile.dataset.index = String(index);
        tile.dataset.stepType = type || '';
        var selected = view.selection.kind === 'stage' && view.selection.index === index;
        tile.classList.toggle('is-selected', selected);
        var failed = view.stageHasError(index);
        var warned = !failed && !!view.stageHasWarning && view.stageHasWarning(index);
        tile.classList.toggle('has-error', failed);
        tile.classList.toggle('has-warning', warned);
        var main = button('', 'cb-tile-main', function () { view.actions.select({ kind: 'stage', index: index }); });
        main.setAttribute('aria-pressed', String(selected));
        main.dataset.focusKey = 'stage:' + index;
        var name = typeof stage.name === 'string' ? stage.name.trim() : '';
        var text = el('span', 'cb-tile-text');
        var title = el('span', 'cb-tile-title');
        if (view.mode === 'dynamic') title.append(el('span', 'cb-tile-name', name || 'no name yet'), el('span', 'cb-tile-label', stepLabel(type)));
        else {
            title.append(el('span', 'cb-tile-num', String(index + 1)));
            // A name someone chose shows beside the step type; one the builder gave doesn't.
            if (name && !window.VIF.chainPresets.isGivenName(name)) title.appendChild(el('span', 'cb-tile-name', name));
            title.appendChild(el('span', 'cb-tile-label', stepLabel(type)));
        }
        text.append(title, el('span', 'cb-tile-summary', stepSummary(stage, view.knownClasses ? view.knownClasses(index) : null)));
        main.append(iconBox(STEPS[type] ? STEPS[type].icon : STEPS.object.icon), text);
        if (failed) main.appendChild(el('span', 'cb-tile-flag', 'Needs attention'));
        else if (warned) main.appendChild(el('span', 'cb-tile-flag cb-tile-warn', '\u26a0 Has a warning'));
        else if (view.mode !== 'dynamic' && unreachable(view.state.stages).indexOf(index) !== -1) {
            main.appendChild(el('span', 'cb-tile-flag cb-tile-off', 'Nothing leads here'));
        }
        tile.classList.toggle('has-flag', !!main.querySelector('.cb-tile-flag'));
        tile.appendChild(main);
        var moves = !selected || !view.actions.nudge ? null
            : view.mode === 'dynamic' ? firstMove(index, view) : moveArrows(index, view);
        if (moves) {
            tile.classList.add('has-moves');
            tile.appendChild(moves);
        }
        tile.addEventListener('dragstart', function (event) {
            event.dataTransfer.setData(DRAG_STAGE, String(index));
            event.dataTransfer.effectAllowed = 'move';
            tile.classList.add('is-dragging');
        });
        tile.addEventListener('dragend', function () { tile.classList.remove('is-dragging'); });
        return tile;
    }

    // Up and down for the selected step, only where the step can go: Watch for movement stays
    // first, so it never moves down and the step under it never moves up. Null when it can't move.
    function moveArrows(index, view) {
        var stages = view.state.stages;
        if (stages.length < 2) return null;
        var type = function (at) { return ((stages[at] || {}).detector || {}).type; };
        var box = el('span', 'cb-tile-moves');
        if (type(index) === 'motion') {
            box.appendChild(el('span', 'cb-tile-pinned', 'Always first'));
            return box;
        }
        var arrow = function (glyph, label, delta) {
            var item = button(glyph, 'cb-tile-move', function () { view.actions.nudge(index, delta); });
            item.title = label;
            item.setAttribute('aria-label', label);
            item.dataset.focusKey = 'move:' + delta;
            return item;
        };
        if (index > 0 && !(index === 1 && type(0) === 'motion')) box.appendChild(arrow('↑', 'Move up', -1));
        if (index < stages.length - 1) box.appendChild(arrow('↓', 'Move down', 1));
        return box.childNodes.length ? box : null;
    }

    function connector(stage, index, view) {
        var line = el('div', 'cb-conn');
        var condition = conditionText(stage, view.state.stages);
        var last = index === view.state.stages.length - 1;
        if (condition) {
            var selected = view.selection.kind === 'gate' && view.selection.index === index;
            var cond = button('', 'cb-cond', function () { view.actions.select({ kind: 'gate', index: index }); });
            cond.classList.toggle('is-selected', selected);
            var condFailed = view.routeHasError(index);
            var condWarned = !condFailed && !!view.routeHasWarning && view.routeHasWarning(index);
            cond.classList.toggle('has-error', condFailed);
            cond.classList.toggle('has-warning', condWarned);
            cond.setAttribute('aria-pressed', String(selected));
            cond.dataset.focusKey = 'gate:' + index;
            var target = function (text) { return text === 'stop' ? 'stop the chain' : text.replace(/^go to /, ''); };
            // Stopping when it finds nothing is the usual case, so only a jump elsewhere is spelled out.
            // The otherwise part is set apart the way its line is: grey and dashed.
            var then = el('span', 'cb-cond-then', '\u2192 ' + target(condition.then));
            if (condition.otherwise !== 'stop') then.appendChild(el('span', 'cb-cond-else', ', otherwise ' + target(condition.otherwise)));
            cond.append(el('span', 'cb-cond-when', condition.when), then);
            if (condWarned) cond.appendChild(el('span', 'cb-cond-flag', '\u26a0 Has a warning'));
            line.classList.toggle('cb-conn-stops', view.mode !== 'dynamic' && stopsShort(view.state.stages, index));
            line.appendChild(cond);
            return line;
        }
        if (last) return null;
        line.appendChild(el('span', 'cb-then', 'Then'));
        var add = button('Add a condition', 'cb-add-cond', function () { view.actions.addCondition(index); });
        add.dataset.focusKey = 'cond:' + index;
        line.appendChild(add);
        return line;
    }

    function svgEl(tag, attrs) {
        var node = document.createElementNS(SVG_NS, tag);
        Object.keys(attrs).forEach(function (key) { node.setAttribute(key, String(attrs[key])); });
        return node;
    }

    /**
     * Draws the chain's branches (see branches()) over the flow: each leaves its condition
     * chip to the left, runs down or up a lane in a gutter beside the steps, and arrives at
     * its step from the left; a stop ends in a dot to the chip's right. Lanes are measured
     * from the rendered steps, so this runs after every render and whenever the flow changes size.
     */
    function drawBranches(container, view) {
        var old = container.querySelector(':scope > .cb-branches');
        if (old) old.remove();
        var list = view.mode === 'dynamic' ? [] : branches(view.state.stages || []);
        // The shortest jumps take the inner lanes, so lines cross as little as possible.
        var span = function (branch) { return branch.to === 'end' ? 0 : Math.abs(branch.to - branch.from); };
        list.sort(function (a, b) { return span(a) - span(b); });
        var lanes = list.filter(function (branch) { return branch.to !== 'end'; }).length;
        // More than two lanes sit further apart, so a busy chain's lines stay easy to follow.
        var laneGap = lanes > 2 ? 13 : 8;
        // Room beside the steps for the lanes, plus a run into the step long enough to show the arrowhead.
        var gutter = lanes ? 26 + laneGap * lanes : 0;
        var padding = gutter ? gutter + 'px' : '';
        if (container.style.paddingLeft !== padding) container.style.paddingLeft = padding;
        if (!list.length) return;
        var box = container.getBoundingClientRect();
        if (!box.width) return;
        var svg = svgEl('svg', { 'class': 'cb-branches', width: box.width, height: box.height, 'aria-hidden': 'true' });
        var lane = 0;
        // Lines that leave the same condition, or arrive at the same step, are spread apart
        // around its middle instead of sharing one point.
        var leaving = {}, arriving = {}, left = {}, arrived = {};
        list.forEach(function (branch) {
            leaving[branch.from] = (leaving[branch.from] || 0) + 1;
            if (branch.to !== 'end') arriving[branch.to] = (arriving[branch.to] || 0) + 1;
        });
        var spread = function (seen, key, total, gap) {
            var at = seen[key] || 0;
            seen[key] = at + 1;
            return (at - (total[key] - 1) / 2) * gap;
        };
        list.forEach(function (branch) {
            var chip = container.querySelector('[data-focus-key="gate:' + branch.from + '"]');
            if (!chip) return;
            var from = chip.getBoundingClientRect();
            var sy = from.top - box.top + from.height / 2 + spread(left, branch.from, leaving, 8);
            var shape;
            if (branch.to === 'end') {
                var sx = from.right - box.left;
                shape = svgEl('g', {});
                shape.append(svgEl('path', { d: 'M' + sx + ',' + sy + ' h18' }), svgEl('circle', { cx: sx + 23, cy: sy, r: 4 }));
            } else {
                var tile = container.querySelector('.cb-tile[data-index="' + branch.to + '"] .cb-tile-main');
                if (!tile) return;
                var to = tile.getBoundingClientRect();
                var x = gutter - 20 - laneGap * lane;
                var ty = to.top - box.top + to.height / 2 + spread(arrived, branch.to, arriving, 10);
                var tip = to.left - box.left, r = 6, down = ty > sy ? 1 : -1;
                lane += 1;
                shape = svgEl('g', {});
                shape.append(
                    svgEl('path', { d: 'M' + (from.left - box.left) + ',' + sy + ' H' + (x + r) + ' Q' + x + ',' + sy + ' ' + x + ',' + (sy + down * r)
                        + ' V' + (ty - down * r) + ' Q' + x + ',' + ty + ' ' + (x + r) + ',' + ty + ' H' + (tip - 8) }),
                    svgEl('polygon', { points: (tip - 9) + ',' + (ty - 4.5) + ' ' + tip + ',' + ty + ' ' + (tip - 9) + ',' + (ty + 4.5) }));
            }
            shape.dataset.from = String(branch.from);
            shape.classList.add(branch.kind === 'otherwise' ? 'is-otherwise' : 'is-then');
            shape.classList.toggle('is-active', chip.classList.contains('is-selected'));
            svg.appendChild(shape);
        });
        // A redraw keeps the chips, so each chip is bound once and finds whichever lines are drawn now.
        container.querySelectorAll('.cb-cond').forEach(function (chip) {
            if (chip._branchHover) return;
            chip._branchHover = true;
            var mine = function () {
                return container.querySelectorAll(':scope > .cb-branches [data-from="' + chip.dataset.focusKey.split(':')[1] + '"]');
            };
            chip.addEventListener('mouseenter', function () { mine().forEach(function (each) { each.classList.add('is-hot'); }); });
            chip.addEventListener('mouseleave', function () { mine().forEach(function (each) { each.classList.remove('is-hot'); }); });
        });
        container.appendChild(svg);
    }

    function paletteRow(view) {
        var row = el('div', 'cb-palette');
        renderPalette(row, view.palette.blocked, view.palette.onAdd);
        return row;
    }

    function sectionLabel(text, sub) {
        var label = el('div', 'cb-flow-label', text);
        if (sub) label.appendChild(el('span', 'cb-flow-sub', sub));
        return label;
    }

    function decisionCard(view) {
        var selected = view.selection.kind === 'chain';
        var card = button('', 'cb-decision', function () { view.actions.select({ kind: 'chain' }); });
        card.classList.toggle('is-selected', selected);
        card.classList.toggle('has-error', view.decisionHasError);
        card.setAttribute('aria-pressed', String(selected));
        card.dataset.focusKey = 'decision';
        var className = ((view.state.decisionListener || {}).className || '').trim();
        var text = el('span', 'cb-tile-text');
        text.append(el('span', 'cb-tile-label', 'Your code picks the next step after each one runs'),
            el('span', 'cb-tile-summary', className || 'Class name not set yet'));
        card.append(iconBox('M8 9l-4 3 4 3M16 9l4 3-4 3M14 5l-4 14'), text);
        return card;
    }

    /**
     * The chain's steps top to bottom. `view` carries the state, the selection
     * ({kind: 'stage'|'gate', index} or {kind: 'chain'}), error lookups, the blocked step types,
     * and the `actions` the user can take: select, insert, move and addCondition.
     */
    // With your code deciding, only the step that runs first has a place, so the one move that
    // matters is making a step that one. Watch for movement keeps it when it's there.
    function firstMove(index, view) {
        var entry = ((view.state.stages[0] || {}).detector || {}).type;
        var box = el('span', 'cb-tile-moves');
        if (index === 0) {
            if (entry === 'motion') box.appendChild(el('span', 'cb-tile-pinned', 'Always first'));
        } else if (entry !== 'motion' && view.actions.move) {
            var item = button('Run this first', 'cb-tile-move', function () { view.actions.move(index, 0); });
            item.dataset.focusKey = 'move:first';
            box.appendChild(item);
        }
        return box.childNodes.length ? box : null;
    }

    function renderDynamicSteps(container, stages, view) {
        container.appendChild(sectionLabel('Runs first'));
        container.appendChild(gapAt(0, stages, view.actions));
        container.appendChild(stageTile(stages[0], 0, view));
        container.appendChild(el('div', 'cb-dyn-link'));
        container.appendChild(decisionCard(view));
        if (stages.length === 1) {
            container.appendChild(sectionLabel('Steps your code can pick', 'Add the steps your code can choose from.'));
            return;
        }
        container.appendChild(sectionLabel('Steps your code can pick',
            'After each step, your code returns the name of the next step to run, which can be any step below or the one '
            + 'that runs first, or tells the chain to stop for the clip being analyzed. A clip ends after ' + (view.maxRings || 8)
            + ' step runs, set by “Maximum step runs per clip”.'));
        var set = el('div', 'cb-pick-set');
        stages.slice(1).forEach(function (stage, offset) { set.appendChild(stageTile(stage, offset + 1, view)); });
        container.appendChild(set);
        container.appendChild(el('div', 'cb-dyn-back', '↻ Each of these goes back to your code after it runs.'));
    }

    function renderFlow(container, view) {
        var focusKey = document.activeElement && container.contains(document.activeElement)
            ? document.activeElement.dataset.focusKey : null;
        container.replaceChildren();
        var stages = view.state.stages || [];
        var dynamic = view.mode === 'dynamic';
        container.classList.toggle('is-dynamic', dynamic);
        if (!stages.length) {
            container.appendChild(dropZone(0, view.actions, 'Drag a step here to start, or click one below.'));
            if (view.palette) container.appendChild(paletteRow(view));
            if (view.actions.showGetStarted) {
                container.appendChild(button('Back to Get started', 'cb-back', function () { view.actions.showGetStarted(); }));
            }
        } else {
            if (dynamic) renderDynamicSteps(container, stages, view);
            else {
                stages.forEach(function (stage, index) {
                    var zone = gapAt(index, stages, view.actions);
                    // No line into a step that the one before never leads to; a branch line may reach it.
                    if (index > 0 && !leadsOn(stages, index - 1)) zone.classList.add('cb-drop-off');
                    container.appendChild(zone);
                    container.appendChild(stageTile(stage, index, view));
                    var line = connector(stage, index, view);
                    if (line) container.appendChild(line);
                });
            }
            container.appendChild(dropZone(stages.length, view.actions));
            if (view.palette) container.appendChild(paletteRow(view));
            if (view.send) {
                var send = el('div', 'cb-send-slot');
                send.id = 'chain-send';
                renderSend(send, view.send);
                container.appendChild(send);
            } else {
                container.appendChild(el('div', 'cb-end', dynamic ? 'Ends when your code says so' : 'End'));
            }
        }
        container._flowView = view;
        if (typeof ResizeObserver !== 'undefined' && !container._flowWatch) {
            container._flowWatch = new ResizeObserver(function () { drawBranches(container, container._flowView); });
            container._flowWatch.observe(container);
        }
        drawBranches(container, view);
        if (!focusKey) return;
        var again = container.querySelector('[data-focus-key="' + focusKey + '"]');
        if (again) again.focus({ preventScroll: true });
    }

    // ── Get started ──────────────────────────────────────────────────────────

    function choiceCard(title, text, iconPath, onClick, badge) {
        var card = button('', 'cb-choice', onClick);
        var head = el('span', 'cb-choice-head');
        head.appendChild(iconBox(iconPath));
        if (badge) head.appendChild(el('span', 'cb-badge', badge));
        card.append(head, el('span', 'cb-choice-title', title), el('span', 'cb-choice-text', text));
        return card;
    }

    /**
     * The screen a new, empty chain opens on. `handlers.onChain(state)` receives a ready-made
     * guided chain; `handlers.onBuild()` asks for the empty builder.
     */
    function createGetStarted(container, handlers) {
        var view = 'choose';
        var picks = [];

        function show(next) { view = next; render(); }

        function renderChoose() {
            container.appendChild(el('div', 'cb-eyebrow', 'New model chain'));
            container.appendChild(el('h3', 'cb-title', 'Set up a model chain'));
            container.appendChild(el('p', 'cb-lead', 'A chain runs several steps on the same video. Add a condition, and a step runs only when the one before it detects what you’ve selected.'));
            var grid = el('div', 'cb-choices');
            grid.append(
                choiceCard('Choose what you want to detect', 'We build the chain from your picks.',
                    'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01', function () { show('guided'); }));
            // Build it yourself is hidden for now; handlers.onBuild still opens the empty builder.
            container.appendChild(grid);
        }

        function renderGuided() {
            container.appendChild(el('h3', 'cb-title', 'What do you want to detect?'));
            container.appendChild(el('p', 'cb-lead', 'Pick all that apply. We’ll put them in the right order, and then you pick what each step looks for.'));
            var grid = el('div', 'cb-picks');
            grid.setAttribute('role', 'group');
            grid.setAttribute('aria-label', 'What do you want to detect? Pick all that apply.');
            GUIDED_CARDS.forEach(function (card) {
                var on = picks.indexOf(card.pick) !== -1;
                var reason = guidedBlockReason(card.pick, picks);
                var item = button('', 'cb-pick', function () {
                    if (reason) return;
                    var at = picks.indexOf(card.pick);
                    if (at === -1) picks.push(card.pick); else picks.splice(at, 1);
                    render();
                });
                item.disabled = !!reason;
                item.classList.toggle('is-on', on);
                item.setAttribute('aria-pressed', String(on));
                item.dataset.focusKey = 'pick:' + card.title;
                var text = el('span', 'cb-pick-text');
                text.append(el('span', 'cb-pick-title', card.title), el('span', 'cb-pick-blurb', card.text));
                if (reason) text.appendChild(el('span', 'cb-pick-reason', reason));
                item.append(iconBox(card.icon), text);
                if (!reason) item.appendChild(el('span', 'cb-check'));
                grid.appendChild(item);
            });
            container.appendChild(grid);
            var preview = el('p', 'cb-preview');
            preview.setAttribute('role', 'status');
            preview.append(el('strong', null, 'Your chain: '), document.createTextNode(guidedPreview(picks)));
            container.appendChild(preview);
            var actions = el('div', 'cb-actions');
            var create = button('Create my chain', 'cb-primary', function () {
                if (picks.length) handlers.onChain(window.VIF.chainPresets.guidedChain(picks));
            });
            create.disabled = !picks.length;
            actions.append(button('Back', 'btn-secondary', function () { show('choose'); }), create);
            container.appendChild(actions);
        }

        function render() {
            var focusKey = document.activeElement && container.contains(document.activeElement)
                ? document.activeElement.dataset.focusKey : null;
            container.replaceChildren();
            if (view === 'guided') renderGuided();
            else renderChoose();
            var again = focusKey && container.querySelector('[data-focus-key="' + focusKey + '"]');
            if (again) again.focus({ preventScroll: true });
        }

        return {
            render: render,
            reset: function () { view = 'choose'; picks = []; render(); }
        };
    }

    // ── results ──────────────────────────────────────────────────────────────

    /**
     * The "Results go to" strip. `destinations` is [{name, type, off}] for the config's event
     * listeners; `onEdit` opens the listener settings.
     */
    /**
     * The line under Send results: whose detections go out, and when. A chain a missed
     * condition can stop also says what such a clip sends (see missStops).
     */
    function sendText(send) {
        if (!send.destinations.length) return 'Results go nowhere yet.';
        if (send.dynamic && send.afterEveryStep) return 'Each step\u2019s detections, as each step finishes';
        if (send.dynamic) return send.everyStep ? 'Every step\u2019s detections, when the clip ends' : 'The last step\u2019s detections, when the clip ends';
        if (!send.missStops) return send.everyStep ? 'Every step\u2019s detections, after each clip' : 'The last step\u2019s detections, after each clip';
        return send.everyStep ? 'Every step\u2019s detections, after each clip, even when an unmet condition stops the chain'
            : 'The last step\u2019s detections, after each clip. None when an unmet condition stops the chain';
    }

    /** A destination chip's label: its kind, with its name when two share a kind. */
    function destinationLabel(each, all) {
        var kind = each.type || each.name;
        var label = kind.charAt(0).toUpperCase() + kind.slice(1);
        var twins = all.filter(function (other) { return (other.type || other.name) === kind; }).length;
        return twins > 1 ? label + ' (' + each.name + ')' : label;
    }

    /**
     * The card that ends the chain: where its results go. `send`: {destinations: [{name, type,
     * off}], everyStep, dynamic, afterEveryStep, missStops, selected, onOpen(), onEdit(name), onAdd()}.
     */
    function renderSend(container, send) {
        container.replaceChildren();
        var card = el('div', 'cb-send');
        card.classList.toggle('is-selected', !!send.selected);
        var head = button('', 'cb-send-head', function () { send.onOpen(); });
        head.dataset.focusKey = 'send';
        head.setAttribute('aria-pressed', String(!!send.selected));
        head.append(iconBox('M22 2L11 13M22 2l-7 20-4-9-9-4z'), el('span', 'cb-send-title', 'Send results'),
            el('span', 'cb-send-change', 'Change'));
        card.appendChild(head);
        card.appendChild(el('p', 'cb-send-text', sendText(send)));
        var chips = el('div', 'cb-send-chips');
        send.destinations.forEach(function (each) {
            var chip = button(destinationLabel(each, send.destinations) + (each.off ? ' \u00b7 off' : ''),
                'cb-send-chip' + (each.off ? ' is-off' : ''), function () { send.onEdit(each.name); });
            chip.title = each.name;
            chips.appendChild(chip);
        });
        chips.appendChild(button('+ Add a destination', 'cb-send-add', function () { send.onAdd(); }));
        card.appendChild(chips);
        container.appendChild(card);
    }


    window.VIF.chainBuilder = {
        STEP_ORDER: STEP_ORDER,
        stepLabel: stepLabel,
        stepSummary: stepSummary,
        conditionText: conditionText,
        branches: branches,
        stopsShort: stopsShort,
        missStops: missStops,
        leadsOn: leadsOn,
        unreachable: unreachable,
        guidedPreview: guidedPreview,
        moveTarget: moveTarget,
        renderPalette: renderPalette,
        renderFlow: renderFlow,
        createGetStarted: createGetStarted,
        sendText: sendText,
        destinationLabel: destinationLabel,
        renderSend: renderSend
    };
})();
