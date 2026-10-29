/* Chain definitions and retained stage history for the On-Demand pages. */
window.VIF = window.VIF || {};
VIF.vod = VIF.vod || {};
(function (V) {
	'use strict';
	const { h } = V;

	function stages(detector) { return (detector && detector.stages) || []; }
	function vodOnly(detector) { return stages(detector).some((s) => s.detector && s.detector.type === 'synthetic'); }
	function rings(row) { return Array.isArray(row.rings) ? row.rings : []; }
	function degraded(row) {
		return !!row.degraded || rings(row).some((r) => r.degraded || (r.synthetic && r.synthetic.degraded)
			|| (r.vlm || []).some((v) => v.degraded));
	}
	function brief(row) {
		if (!Array.isArray(row.rings)) return 'Historical final result · earlier stage history unavailable';
		const path = rings(row).map((r) => r.stage_name || 'Unnamed stage');
		return path.length ? path.join(' → ') : 'No stage results retained';
	}
	function summary(rows) {
		return {
			windows: rows.length,
			executions: rows.reduce((n, row) => n + rings(row).length, 0),
			degraded: rows.filter(degraded).length,
			historical: rows.filter((row) => !Array.isArray(row.rings)).length
		};
	}

	function definition(detector) {
		const configured = stages(detector);
		return h('div', { class: 'chain-definition', 'data-chain-mode': detector.mode || 'linear' },
			h('div', { class: 'drow' }, h('span', { class: 'dbadge' }, 'CHN'),
				h('div', null, h('div', { class: 'dname' }, 'Chain analysis'),
					h('div', { class: 'ddesc' }, configured.length + ' stage' + (configured.length === 1 ? '' : 's')
						+ ' · ' + (detector.mode || 'linear') + ' · up to ' + (detector.maxRings ?? 8) + ' executions per window'))),
			h('ol', { class: 'chain-stages' }, configured.map((stage) => {
				const type = (stage.detector || {}).type || 'unknown';
				const selection = stage.frameSelection || {};
				return h('li', null, h('strong', null, stage.name), ' · ' + type,
					stage.crop ? h('span', { class: 'tag tag-n' }, 'crop preceding detections') : null,
					selection.mode && selection.mode !== 'all'
						? h('span', { class: 'tag tag-n' }, selection.mode === 'every_nth'
							? 'every ' + selection.stride + ' frames' : selection.mode + ' frame') : null,
					stage.routing ? h('span', { class: 'tag tag-n' }, 'conditional route') : null);
			})),
			h('p', { class: 'hint' }, vodOnly(detector)
				? 'VOD only: this chain includes synthetic video detection.'
				: 'Available for VOD and live streams. Every stage shares the same captured window.'),
			detector.mode === 'dynamic' ? h('p', { class: 'hint' },
				'The installed decision listener chooses the next stage. An interrupted window restarts from its first stage on resume.') : null,
			h('details', null, h('summary', { class: 'hint' }, 'View chain definition'),
				h('pre', null, JSON.stringify(VIF.sdk.toWire(detector), null, 2))));
	}

	function confidence(value) { return typeof value === 'number' ? value.toFixed(3) : null; }
	function provenance(value) {
		if (value.source_ring_index == null && value.source_detection_index == null) return null;
		return h('div', { class: 'hint' }, 'Crop from execution ' + (Number(value.source_ring_index) + 1)
			+ ', detection ' + (Number(value.source_detection_index) + 1) + '; coordinates refer to the full frame.');
	}
	function payload(ring) {
		const type = ring.detections_type || ring.detector_type;
		const synthetic = ring.synthetic || (type === 'synthetic' ? ring : null);
		if (synthetic) return h('div', { class: 'chain-payload' },
			h('strong', null, synthetic.verdict || 'unknown'),
			typeof synthetic.synthetic_score === 'number' ? ' · score ' + confidence(synthetic.synthetic_score) : null,
			synthetic.degraded ? h('p', { class: 'hint' }, 'The endpoint was unavailable; this window has no usable verdict.') : null);
		const vlm = ring.vlm || (type === 'vlm' && ring.content ? [ring] : []);
		if (vlm.length) return h('div', { class: 'chain-payload' }, vlm.map((item) =>
			h('div', null, item.content ? h('pre', { class: 'chain-content' },
				typeof item.content === 'string' ? item.content : JSON.stringify(item.content, null, 2))
				: h('span', { class: 'hint' }, item.degraded ? 'No answer: endpoint unavailable.' : 'No answer returned.'),
			item.truncated ? h('span', { class: 'tag tag-n' }, 'response truncated') : null,
			provenance(item))));
		const detections = ring.detections || [];
		if (!detections.length) return h('p', { class: 'hint' }, ring.degraded ? 'No usable result: endpoint unavailable.' : 'No detections returned.');
		return h('ul', { class: 'chain-detections' }, detections.map((d) => h('li', null,
			h('strong', null, d.class_name || 'Result'),
			confidence(d.confidence) !== null ? ' · confidence ' + confidence(d.confidence) : null,
			d.track_id != null ? ' · track ' + d.track_id : null,
			d.bbox ? h('span', { class: 'mono' }, ' · box ' + JSON.stringify(d.bbox)) : null,
			d.reasoning ? h('p', null, d.reasoning) : null,
			d.data ? h('pre', { class: 'chain-content' }, JSON.stringify(d.data, null, 2)) : null,
			provenance(d))));
	}

	function windowResults(row, detector) {
		const retained = Array.isArray(row.rings);
		const executed = rings(row);
		const names = new Set(executed.map((ring) => ring.stage_name));
		const omitted = retained ? stages(detector).filter((stage) => !names.has(stage.name)).map((stage) => stage.name) : [];
		return h('div', { class: 'chain-window-results' },
			!retained ? h('p', { class: 'hint' },
				'This older record kept only the final result. Earlier stage results are unavailable.') : null,
			h('ol', { class: 'chain-executions' }, (retained ? executed : [row]).map((ring, index) =>
				h('li', { 'data-stage-name': ring.stage_name || '' },
					h('div', { class: 'chain-stage-heading' },
						h('strong', null, ring.stage_name || (retained ? 'Unnamed stage' : 'Retained final result')),
						' · ' + (ring.detections_type || ring.detector_type || 'unknown'),
						retained ? h('span', { class: 'hint' }, 'execution ' + (index + 1)) : null,
						(ring.degraded || (ring.synthetic && ring.synthetic.degraded) || (ring.vlm || []).some((v) => v.degraded))
							? h('span', { class: 'tag tag-e' }, 'degraded') : null),
					payload(ring)))),
			omitted.length ? h('p', { class: 'hint chain-skipped' }, 'Not run this window: ' + omitted.join(', ')
				+ '. Routing or the execution limit can finish a window before every stage runs.') : null);
	}

	function windows(report) {
		const state = report.state;
		const detector = ((state.job.effectiveConfig || state.job.config || {}).detector) || {};
		const canPlay = V.jobHelpers.isTerminal(state.job) && !!state.job.file;
		return h('div', { class: 'chain-results' },
			h('div', { style: 'display:flex;align-items:center;margin-bottom:9px' },
				h('div', { class: 'eyebrow' }, 'Chain windows'), report.followBtn()),
			h('div', { class: 'wlist' }, state.rows.map((row, index) =>
				report.keyedDetails('chainWindow' + index, { class: 'wrow chain-window',
					'data-from': report.rowStartMs(row), 'data-to': report.rowEndMs(row) },
				h('summary', null, h('span', { class: 'wt' }, report.windowLabel(row)),
					h('span', { class: 'chain-path' }, brief(row)),
					degraded(row) ? h('span', { class: 'tag tag-e' }, 'degraded') : null),
				canPlay && report.rowStartMs(row) !== null
					? h('button', { class: 'btn btn-sm', onclick: () => report.startPlayer(report.rowStartMs(row)) }, 'Play this window') : null,
				windowResults(row, detector)))),
			!state.rows.length ? h('p', { class: 'hint' }, 'Stage results appear here as windows finish.') : null,
			h('p', { class: 'hint' }, 'Stages appear in execution order, including revisits. Expand a window to read each result.'));
	}

	V.chain = { stages, vodOnly, rings, degraded, brief, summary, definition, windowResults, windows };
})(window.VIF.vod);