/* Chain definitions and retained stage history for the On-Demand pages. */
window.VIF = window.VIF || {};
VIF.vod = VIF.vod || {};
(function (V) {
	'use strict';
	const { h } = V;

	function stages(detector) { return (detector && detector.stages) || []; }
	function vodOnly(detector) { return stages(detector).some((s) => s.detector && s.detector.type === 'synthetic'); }
	const results = VIF.chainResults;
	function rings(row) { return Array.isArray(row.rings) ? row.rings : []; }
	function degraded(row) { return !!row.degraded || rings(row).some(results.unreachable); }
	// Your code picks steps by name, so a dynamic chain shows every name; elsewhere only a
	// name someone chose, not one the builder gave (objects, scene-2, …).
	function showsName(detector, name) {
		return !!name && (detector.mode === 'dynamic' || !VIF.chainPresets.isGivenName(name));
	}
	/**
	 * A step as the builder names it: its plain label, with the step number when two steps
	 * share a label, and its name when it shows one.
	 */
	function stepName(detector, name) {
		const configured = stages(detector);
		const index = configured.findIndex((s) => s.name === name);
		if (index === -1) return name || 'A step';
		const type = (configured[index].detector || {}).type;
		const label = VIF.chainBuilder.stepLabel(type);
		const twins = configured.filter((s) => (s.detector || {}).type === type).length > 1;
		return label + (twins ? ' (step ' + (index + 1) + ')' : '') + (showsName(detector, name) ? ' · ' + name : '');
	}
	// A chain with a scene, AI model or AI-generated video step works on clips; the rest go frame by frame.
	function unitOf(detector) {
		return stages(detector).some((s) => ['scene', 'vlm', 'synthetic'].includes((s.detector || {}).type)) ? 'clip' : 'frame';
	}
	function brief(row, detector) {
		if (!Array.isArray(row.rings)) return 'Older record: only the final result was kept';
		const path = rings(row).map((r) => stepName(detector || {}, r.stage_name));
		return path.length ? path.join(' → ') : 'No step results kept';
	}
	function summary(rows) {
		return {
			windows: rows.length,
			executions: rows.reduce((n, row) => n + rings(row).length, 0),
			degraded: rows.filter(degraded).length,
			historical: rows.filter((row) => !Array.isArray(row.rings)).length
		};
	}

	// What decides the next step, in the words the Stream Configs builder uses.
	function decidedBy(detector) {
		if (detector.mode === 'dynamic') return 'your code decides what runs next';
		return stages(detector).some((s) => s.routing) ? 'conditions you set decide what runs next' : 'steps run in order';
	}
	// A chain with a scene, AI model or AI-generated video step works on clips; the rest go frame by frame.
	function unit(detector) {
		return stages(detector).some((s) => ['scene', 'vlm', 'synthetic'].includes((s.detector || {}).type)) ? 'clip' : 'frame';
	}
	function conditionLine(stage, configured) {
		const words = VIF.chainBuilder.conditionText(stage, configured);
		if (!words) return null;
		const target = (text) => (text === 'stop' ? 'stop the chain' : text.replace(/^go to /, ''));
		// Stopping when it finds nothing is the usual case, so only a jump elsewhere is spelled out.
		const outcome = target(words.then) + (words.otherwise === 'stop' ? '' : ', otherwise ' + target(words.otherwise));
		return h('div', { class: 'chain-cond' }, h('span', { class: 'chain-cond-when' }, words.when), ' → ' + outcome);
	}

	function definition(detector) {
		const configured = stages(detector);
		const words = VIF.chainBuilder;
		const dynamic = detector.mode === 'dynamic';
		return h('div', { class: 'chain-definition', 'data-chain-mode': detector.mode || 'linear' },
			h('div', { class: 'drow' }, h('span', { class: 'dbadge' }, 'CHN'),
				h('div', null, h('div', { class: 'dname' }, 'Chain analysis'),
					h('div', { class: 'ddesc' }, configured.length + ' step' + (configured.length === 1 ? '' : 's')
						+ ' · ' + decidedBy(detector) + ' · up to ' + (detector.maxRings ?? 8) + ' step runs per ' + unit(detector)))),
			h('ol', { class: 'chain-stages' }, configured.map((stage) => {
				const summary = words.stepSummary(stage);
				return h('li', { 'data-stage-name': stage.name || '' },
					h('strong', null, words.stepLabel((stage.detector || {}).type)),
					showsName(detector, stage.name) ? h('span', { class: 'mono chain-step-name' }, ' ' + stage.name) : null,
					summary ? h('span', { class: 'chain-step-summary' }, ' · ' + summary) : null,
					dynamic ? null : conditionLine(stage, configured));
			})),
			h('p', { class: 'hint' }, vodOnly(detector)
				? 'Recorded video only: this chain spots AI-generated video, so live streams that match it won’t start.'
				: 'Runs on recorded and live video. Every step looks at the same ' + unit(detector) + '.'),
			dynamic ? h('p', { class: 'hint' },
				'Your code, installed on the Streaming Engine, picks the next step after each one runs. A job that stops partway starts that clip again from step 1 when it resumes.') : null,
			h('details', null, h('summary', { class: 'hint' }, 'View this chain as JSON'),
				h('pre', null, JSON.stringify(VIF.sdk.toWire(detector), null, 2))));
	}

	function confidence(value) { return typeof value === 'number' ? value.toFixed(3) : null; }
	const { sure, where } = results;
	function provenance(value) {
		if (value.source_ring_index == null && value.source_detection_index == null) return null;
		return h('div', { class: 'hint' }, 'Looked inside find ' + (Number(value.source_detection_index) + 1)
			+ ' of run ' + (Number(value.source_ring_index) + 1) + '; boxes are measured on the full picture.');
	}
	function fields(data) {
		return h('div', { class: 'chain-fields' }, Object.keys(data).map((key) => {
			const value = data[key];
			return h('div', null, h('span', { class: 'chain-field-key' }, key + ':'),
				' ' + (value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value)));
		}));
	}

	function verdict(synthetic) {
		if (synthetic.degraded) return h('p', { class: 'hint' }, 'The service couldn’t be reached, so there is no verdict here.');
		const said = synthetic.verdict || 'unknown';
		return h('div', { class: 'chain-payload' },
			h('span', { class: 'tag chain-verdict chain-verdict-' + (said === 'synthetic' || said === 'real' ? said : 'unknown') }, said),
			typeof synthetic.synthetic_score === 'number' ? ' · score ' + confidence(synthetic.synthetic_score) : null);
	}

	// One AI model call: its description as prose, the things a check named with the
	// model's reasoning, or the fields of an answer in the user's own format.
	function answer(item) {
		const found = item.content && typeof item.content === 'object' ? null : VIF.chainResults.vlmAnswers(item);
		let said;
		if (!found) said = fields(item.content);
		else if (!found.length) said = h('span', { class: 'hint' }, item.degraded ? 'No answer: the AI model couldn’t be reached.'
			: String(item.content || '').trim() ? 'Found none of these.' : 'No answer came back.');
		else said = found.map((f) => (f.data ? fields(f.data)
			: f.label === 'description' ? h('p', { class: 'chain-prose' }, f.reasoning)
				: h('div', { class: 'chain-answer' }, h('span', { class: 'tag tag-o' }, f.label || '?'),
					f.reasoning ? h('span', { class: 'chain-reason' }, ' ' + f.reasoning) : null)));
		return h('div', null, said, item.truncated ? h('span', { class: 'tag tag-n' }, 'answer cut short') : null, provenance(item));
	}

	// Each frame's finds of the same thing collapse to one line, strongest first; the
	// individual finds and their boxes open underneath.
	function grouped(detections, type) {
		const trackLabel = type === 'motion' ? 'moving area #' : 'object #';
		return h('ul', { class: 'chain-detections' }, results.groups(detections).map((group) => {
			const detail = results.groupDetail(group, type);
			const reasons = Array.from(new Set(group.items.map((d) => d.reasoning).filter(Boolean)));
			const boxed = group.items.some((d) => d.bbox);
			const detailed = boxed || group.items.some((d) => d.data || d.source_ring_index != null || d.source_detection_index != null || d.track_id != null);
			return h('li', null,
				h('strong', null, group.name),
				detail ? ' · ' + detail : null,
				reasons.map((reason) => h('p', null, reason)),
				detailed ? h('details', { class: 'chain-finds' }, h('summary', { class: 'hint' }, boxed ? 'Show where' : 'Show details'),
					h('ul', null, group.items.map((d) => h('li', null,
						sure(results.score(d)),
						d.track_id != null ? ' · ' + trackLabel + d.track_id : null,
						d.frame_id != null ? ' · frame ' + d.frame_id : null,
						d.bbox ? h('span', { class: 'mono' }, ' · ' + where(d.bbox)) : null,
						d.data ? fields(d.data) : null,
						provenance(d))))) : null);
		}));
	}

	function payload(ring) {
		const type = ring.detections_type || ring.detector_type;
		const synthetic = ring.synthetic || (type === 'synthetic' ? ring : null);
		if (synthetic) return verdict(synthetic);
		const vlm = ring.vlm || (type === 'vlm' && ring.content ? [ring] : []);
		if (vlm.length) return h('div', { class: 'chain-payload' }, vlm.map(answer));
		const detections = ring.detections || [];
		if (!detections.length) return h('p', { class: 'hint' }, ring.degraded ? 'No result: the service couldn’t be reached.' : 'Found nothing.');
		return grouped(detections, type);
	}

	function windowResults(row, detector) {
		const retained = Array.isArray(row.rings);
		const executed = rings(row);
		const names = new Set(executed.map((ring) => ring.stage_name));
		const omitted = retained ? stages(detector).filter((stage) => !names.has(stage.name)) : [];
		const unit = unitOf(detector);
		return h('div', { class: 'chain-window-results' },
			!retained ? h('p', { class: 'hint' },
				'This older record kept only the final result, not each step’s.') : null,
			h('ol', { class: 'chain-executions' }, (retained ? executed : [row]).map((ring) =>
				h('li', { 'data-stage-name': ring.stage_name || '' },
					h('div', { class: 'chain-stage-heading' },
						h('strong', null, ring.stage_name ? stepName(detector, ring.stage_name) : (retained ? 'A step' : 'Final result')),
						results.unreachable(ring) ? h('span', { class: 'tag tag-e' }, 'service unavailable') : null),
					payload(ring)))),
			omitted.length ? h('p', { class: 'hint chain-skipped' }, skippedText(row, detector, omitted, unit)) : null);
	}

	/**
	 * Why a clip left steps out. How the chain ended explains only the steps after the last
	 * one that ran; a step before it was passed over by a condition that led elsewhere.
	 */
	function skippedText(row, detector, omitted, unit) {
		const named = (list) => {
			const names = list.map((stage) => stepName(detector, stage.name));
			return names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0];
		};
		const last = rings(row)[rings(row).length - 1];
		const after = last ? stepName(detector, last.stage_name) : null;
		const reached = last ? stages(detector).findIndex((stage) => stage.name === last.stage_name) : -1;
		const earlier = omitted.filter((stage) => stages(detector).indexOf(stage) < reached);
		const later = omitted.filter((stage) => !earlier.includes(stage));
		const ended = !after ? null
			: row.end_reason === 'no_match' ? 'this ' + unit + ' didn’t meet the condition after ' + after + '.'
			: row.end_reason === 'match_end' ? 'this ' + unit + ' met the condition after ' + after + ', which stops the chain.'
			: row.end_reason === 'degraded' ? after + ' couldn’t reach its service, so the chain ended.'
			: row.end_reason === 'max_rings' ? 'this ' + unit + ' reached its maximum step runs.'
			: null;
		if (detector.mode === 'dynamic' && !ended) return named(omitted) + ' didn’t run on this ' + unit + ': your code decides what runs next.';
		if (!ended) {
			return named(omitted) + ' didn’t run on this ' + unit + '. A step runs only when a condition leads to it, and a ' + unit
				+ ' stops once it reaches its maximum step runs.';
		}
		const passed = detector.mode === 'dynamic' ? 'your code picked another step.' : 'a condition led to another step.';
		return [earlier.length ? named(earlier) + ' didn’t run: ' + passed : null,
			later.length ? named(later) + ' didn’t run: ' + ended : null].filter(Boolean).join(' ');
	}

	/** What a clip found, in one line, or "nothing found" and where a condition stopped the chain. */
	function findings(row, detector) {
		if (!Array.isArray(row.rings)) return results.ringFinding(row) || 'nothing found';
		const said = results.clipFinding(rings(row));
		if (said) return said;
		const last = rings(row)[rings(row).length - 1];
		return 'nothing found' + (last && row.end_reason === 'no_match'
			? ' (stopped at ' + stepName(detector || {}, last.stage_name) + ')' : '');
	}
	// A clip where every step ran fine and none found anything.
	function quiet(row) {
		return Array.isArray(row.rings) && !degraded(row) && rings(row).every((ring) => !results.ringFinding(ring));
	}
	// Where the run of three or more quiet clips holding clip i starts, as the clip list folds
	// it; null when the clip isn't folded away.
	function foldStart(rows, i) {
		if (!rows[i] || !quiet(rows[i])) return null;
		let first = i, last = i;
		while (first > 0 && quiet(rows[first - 1])) first--;
		while (last + 1 < rows.length && quiet(rows[last + 1])) last++;
		return last - first + 1 >= 3 ? first : null;
	}

	// Case and accents don't count in a search: "cafe" finds "Café".
	function plain(text) { return String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
	// The values an answer in the user's own format holds, without its keys.
	function values(data) {
		if (data === null || data === undefined) return [];
		return typeof data === 'object' ? Object.values(data).flatMap(values) : [String(data)];
	}
	const searchable = new WeakMap();
	/**
	 * What a clip or window said, for the list's search: every class its steps named, every AI
	 * answer and reason in full, the values of an answer in the user's own format, and a verdict.
	 */
	function clipText(row) {
		if (searchable.has(row)) return searchable.get(row);
		const said = [];
		const find = (label, reasoning, data) => said.push(label === 'description' ? null : label, reasoning, ...values(data));
		(Array.isArray(row.rings) ? rings(row) : [row]).forEach((ring) => {
			const type = ring.detections_type || ring.detector_type;
			const synthetic = ring.synthetic || (type === 'synthetic' ? ring : null);
			const detections = ring.detections || [];
			if (synthetic) {
				if (synthetic.degraded || !synthetic.verdict) return;
				if (synthetic.verdict === 'synthetic') said.push(ALERT_FIND);
				said.push(synthetic.verdict);
			} else if ((type === 'vlm' || ring.vlm) && (ring.vlm || !detections.length)) {
				results.aiFindings(ring).forEach((f) => find(f.label, f.reasoning, f.data));
			} else {
				if (type === 'motion' && detections.length) said.push('movement');
				detections.forEach((d) => find(d.class_name, d.reasoning, d.data));
			}
		});
		const text = plain(said.filter(Boolean).join(' '));
		searchable.set(row, text);
		return text;
	}
	/** Whether a clip says every word of `query`, in any order, case and accents aside. A blank query matches every clip. */
	function clipMatches(row, query) {
		const words = plain(query || '').split(/\s+/).filter(Boolean);
		if (!words.length) return true;
		const text = clipText(row);
		return words.every((word) => text.includes(word));
	}

	// The find an AI-generated video verdict adds to a clip; the strip paints it in the alert color.
	const ALERT_FIND = 'AI-generated video';

	/**
	 * A clip as the score strip reads a row: the things its steps found as detections, how
	 * sure, how many steps ran, and its one-line finding. Movement counts only when nothing
	 * else turned up; an AI description or AI-generated video verdict counts as a find.
	 */
	function stripRow(row, detector) {
		const executed = Array.isArray(row.rings) ? rings(row) : [row];
		const names = new Set(executed.map((ring) => ring.stage_name).filter(Boolean));
		const found = [];
		let moved = false, described = false, alert = false;
		executed.forEach((ring) => {
			const type = ring.detections_type || ring.detector_type;
			const synthetic = ring.synthetic || (type === 'synthetic' ? ring : null);
			if (synthetic) {
				if (!synthetic.degraded && synthetic.verdict === 'synthetic') {
					alert = true;
					found.push({ class_name: ALERT_FIND, confidence: synthetic.synthetic_score });
				}
				return;
			}
			if (type === 'vlm' || ring.vlm) {
				results.aiFindings(ring).forEach((f) => {
					if (f.label && f.label !== 'description') found.push({ class_name: f.label });
					else if (f.reasoning || f.data) described = true;
				});
				return;
			}
			(ring.detections || []).forEach((d) => {
				if (type === 'motion') moved = true;
				else found.push({ class_name: d.class_name || 'Result', confidence: results.score(d) });
			});
		});
		const sureness = found.reduce((top, d) => (typeof d.confidence === 'number' && d.confidence > top ? d.confidence : top), 0);
		const movementOnly = !found.length && !described && moved;
		return {
			detection_window: row.detection_window,
			detections: found,
			degraded: degraded(row),
			chain: {
				row,
				steps: executed.length,
				// A step that ran again is still one step of the chain.
				distinct: names.size + executed.filter((ring) => !ring.stage_name).length,
				alert,
				movementOnly,
				described: !found.length && described,
				quiet: !found.length && !described && !moved,
				value: sureness || (found.length || described || movementOnly ? 0.75 : 0),
				finding: findings(row, detector),
				path: brief(row, detector)
			}
		};
	}

	function windows(report) {
		const state = report.state;
		const rows = state.rows;
		const detector = ((state.job.effectiveConfig || state.job.config || {}).detector) || {};
		const canPlay = V.jobHelpers.isTerminal(state.job) && !!state.job.file;
		const unit = unitOf(detector);
		const clipRow = (row, index) => report.keyedDetails('chainWindow' + index, { class: 'wrow chain-window', 'data-clip': String(index),
			'data-from': report.rowStartMs(row), 'data-to': report.rowSpanEndMs(row) },
			h('summary', null, h('span', { class: 'wt' }, report.windowLabel(row)),
				h('span', { class: 'chain-finding' + (quiet(row) ? ' quiet' : '') }, findings(row, detector)),
				degraded(row) ? h('span', { class: 'tag tag-e' }, 'service unavailable') : null),
			canPlay && report.rowStartMs(row) !== null
				? h('button', { class: 'btn btn-sm', onclick: () => report.startPlayer(report.rowStartMs(row)) }, 'Play this ' + unit) : null,
			windowResults(row, detector));
		// Three or more quiet clips in a row fold into one line, as the other reports do.
		const quietRun = (from, to) => {
			const start = report.windowLabel(rows[from]).split(' – ')[0];
			const end = report.windowLabel(rows[to - 1]).split(' – ').pop();
			return report.keyedDetails('chainQuiet' + from, { class: 'wrow chain-window chain-quiet',
				'data-from': report.rowStartMs(rows[from]), 'data-to': report.rowSpanEndMs(rows[to - 1]) },
			h('summary', null, h('span', { class: 'wt' }, start === end ? start : start + ' – ' + end),
				h('span', { class: 'chain-finding quiet' }, (to - from) + ' ' + unit + 's, nothing found')),
			rows.slice(from, to).map((row, offset) => clipRow(row, from + offset)));
		};
		// A search lists only the clips that match, each on its own line: a quiet clip says nothing to match.
		const query = (state.clipSearch || '').trim();
		const list = [];
		for (let i = 0; i < rows.length;) {
			if (query) { if (clipMatches(rows[i], query)) list.push(clipRow(rows[i], i)); i++; continue; }
			let j = i;
			while (j < rows.length && quiet(rows[j])) j++;
			if (j - i >= 3) { list.push(quietRun(i, j)); i = j; }
			else if (j > i) { for (; i < j; i++) list.push(clipRow(rows[i], i)); }
			else { list.push(clipRow(rows[i], i)); i++; }
		}
		const closeAll = 'Close every open ' + unit;
		return h('div', { class: 'chain-results' },
			h('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:9px' },
				h('div', { class: 'eyebrow' }, unit === 'clip' ? 'Clips' : 'Frames'),
				// Beside the list's name, away from the search box: it closes clips, it doesn't clear the search.
				rows.length ? h('button', { class: 'btn btn-sm btn-ghost chain-close-all', title: closeAll, 'aria-label': closeAll,
					onclick: () => report.closeClips() }, '↺') : null,
				rows.length ? h('span', { class: 'hint chain-list-hint' }, query
					? list.length + ' of ' + rows.length + ' ' + unit + 's' + report.loadedSoFar()
					: 'Open a ' + unit + ' to see what each step found.') : null,
				rows.length ? report.searchBox(unit) : null,
				report.followBtn()),
			h('div', { class: 'wlist' }, list),
			query && !list.length ? h('p', { class: 'hint' }, 'No ' + unit + ' says “' + query + '”. The search covers what each step found and every AI answer.') : null,
			!rows.length ? h('p', { class: 'hint' }, 'Each ' + unit + '’s step results appear here as it finishes.') : null);
	}

	V.chain = { stages, vodOnly, rings, degraded, brief, summary, definition, windowResults, findings, quiet, foldStart, clipMatches, stripRow, ALERT_FIND, windows, unitOf };
})(window.VIF.vod);