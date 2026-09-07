/* Shared helpers for the On-Demand fragment: DOM building, formatting, toasts, modals.
   Everything hangs off VIF.vod; fragments re-execute their scripts on every visit, so
   each module re-assigns onto the same persistent namespace object. */
window.VIF = window.VIF || {};
VIF.vod = VIF.vod || {};
(function (V) {
	'use strict';

	/** h('div', {class: 'x', onclick: fn, title: '...'}, child, [children], 'text') */
	function h(tag, attrs) {
		const el = document.createElement(tag);
		if (attrs) {
			for (const [k, v] of Object.entries(attrs)) {
				if (v === null || v === undefined || v === false) continue;
				if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
				else if (k === 'class') el.className = v;
				else if (k === 'value') el.value = v;
				else if (k === 'checked') el.checked = true;
				else if (k === 'disabled') el.disabled = true;
				else if (k === 'selected') el.selected = true;
				else el.setAttribute(k, v);
			}
		}
		append(el, Array.prototype.slice.call(arguments, 2));
		return el;
	}

	function append(el, kids) {
		for (const kid of kids) {
			if (kid === null || kid === undefined || kid === false) continue;
			if (Array.isArray(kid)) append(el, kid);
			else if (kid instanceof Node) el.appendChild(kid);
			else el.appendChild(document.createTextNode(String(kid)));
		}
	}

	function clear(el) {
		while (el.firstChild) el.removeChild(el.firstChild);
		return el;
	}

	/**
	 * Snapshot every scrolled ancestor of `el` (plus the page itself) and return a
	 * restore function to call after the re-render rebuilt the root. Restoring matters
	 * because filtering usually SHRINKS the content (50 browser rows become 2) and the
	 * browser then clamps the scroll toward the top — the strip or the filter toolbar
	 * the user just clicked flies away. The restore puts the offsets back, and when the
	 * rebuilt page is too short to reach the old offset it pads `growEl` (the view's
	 * bottom section) by exactly the missing amount instead of letting the view jump.
	 * The pad is re-derived from scratch on every render, so it shrinks away as soon
	 * as the content grows back or the user scrolls up.
	 */
	function snapshotScroll(el) {
		const saved = [];
		for (let n = el; n; n = n.parentElement) {
			if (n.scrollTop || n.scrollLeft) saved.push([n, n.scrollTop, n.scrollLeft]);
		}
		const doc = document.scrollingElement;
		if (doc && (doc.scrollTop || doc.scrollLeft) && !saved.some((entry) => entry[0] === doc)) {
			saved.push([doc, doc.scrollTop, doc.scrollLeft]);
		}
		return (growEl) => {
			for (const [n, top, left] of saved) {
				n.scrollTop = top;
				n.scrollLeft = left;
				if (growEl && growEl.isConnected && n.scrollTop < top) {
					growEl.style.minHeight = (growEl.offsetHeight + (top - n.scrollTop)) + 'px';
					n.scrollTop = top;
				}
			}
		};
	}

	function fmtBytes(n) {
		if (n === null || n === undefined) return '';
		if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
		if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
		if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
		return n + ' B';
	}

	/** Media time in ms -> "m:ss" / "h:mm:ss" on the source timeline. */
	function fmtMediaMs(ms) {
		if (ms === null || ms === undefined) return '';
		const s = Math.floor(ms / 1000);
		const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
		const p = (n) => String(n).padStart(2, '0');
		return hh > 0 ? hh + ':' + p(mm) + ':' + p(ss) : mm + ':' + p(ss);
	}

	/** The instant a job timestamp names. The SDK parses the API's RFC 3339 date-times into
	    Date objects; a plain string is parsed here for a record that carried one. */
	function jobInstant(job, key) {
		const value = job[key];
		if (!value) return null;
		const ms = value instanceof Date ? value.getTime() : Date.parse(value);
		return Number.isNaN(ms) ? null : ms;
	}

	/** A clock time in the browser's zone: "HH:mm:ss", with the date kept when it isn't today. */
	function fmtClock(instant) {
		const ms = instant instanceof Date ? instant.getTime() : instant;
		if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
		const d = new Date(ms);
		const hms = p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
		return localDay(d) === localDay(new Date()) ? hms : localDay(d) + ' ' + hms;
	}

	function localDay(d) {
		return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
	}

	function p2(n) {
		return String(n).padStart(2, '0');
	}

	/** Coarse relative time: "just now", "5m ago", "3h ago", "2d ago", then the date. */
	function fmtAgo(instant) {
		const ms = instant instanceof Date ? instant.getTime()
			: typeof instant === 'string' ? Date.parse(instant) : instant;
		if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
		const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
		if (s < 45) return 'just now';
		if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm ago';
		if (s < 86400) return Math.round(s / 3600) + 'h ago';
		if (s < 7 * 86400) return Math.round(s / 86400) + 'd ago';
		return localDay(new Date(ms));
	}

	/** An elapsed span: "<1s" / "42s" / "3m 07s" / "1h 02m 07s". */
	function fmtDurationMs(ms) {
		if (ms === null || ms === undefined || ms < 0) return '';
		if (ms < 1000) return '<1s';
		const s = Math.round(ms / 1000);
		if (s < 60) return s + 's';
		const m = Math.floor(s / 60);
		if (m < 60) return m + 'm ' + p2(s % 60) + 's';
		return Math.floor(m / 60) + 'h ' + p2(m % 60) + 'm ' + p2(s % 60) + 's';
	}

	/** The absolute timeline for a job's timing tooltips: queued, waited, started, ended. */
	function jobTimingTip(job) {
		const wait = jobQueueWait(job);
		return [
			job.queuedAt ? 'queued ' + fmtClock(new Date(job.queuedAt)) : null,
			wait !== null && wait >= 1000 ? 'waited ' + fmtDurationMs(wait) + ' for a worker' : null,
			job.startedAt ? 'started ' + fmtClock(new Date(job.startedAt)) : null,
			job.endedAt ? 'ended ' + fmtClock(new Date(job.endedAt)) : null,
		].filter(Boolean).join('\n');
	}

	/** How long the job has run: started -> ended, still counting while it runs. Null before a worker picked it up. */
	function jobDuration(job) {
		const started = jobInstant(job, 'startedAt');
		if (started === null) return null;
		const ended = jobInstant(job, 'endedAt');
		return Math.max(0, (ended !== null ? ended : Date.now()) - started);
	}

	/**
	 * How long the job waited for a worker. Null on resumed jobs: the timestamps belong to
	 * the latest run while queued_at is still the original submit, so the wait is no longer
	 * knowable from the record.
	 */
	function jobQueueWait(job) {
		if (job.resumes) return null;
		const queued = jobInstant(job, 'queuedAt');
		if (queued === null) return null;
		const started = jobInstant(job, 'startedAt');
		if (started !== null) return Math.max(0, started - queued);
		if (job.state === 'pending') return Math.max(0, Date.now() - queued);
		const ended = jobInstant(job, 'endedAt'); // e.g. cancelled while still queued
		return ended !== null ? Math.max(0, ended - queued) : null;
	}

	/** error_cause -> how the Engine reacts, per the documented retry classes. */
	const RETRY_GLOSS = {
		response_timeout: 'usually transient: auto-resume retries quickly',
		disconnected: 'usually transient: auto-resume retries quickly',
		detector_restarted: 'usually transient: auto-resume retries quickly',
		send_failed: 'usually transient: auto-resume retries quickly',
		endpoint_degraded: 'the endpoint is down or loading: auto-resume retries patiently',
		not_connected: 'the endpoint is down or loading: auto-resume retries patiently',
		connect_failed: 'the endpoint is down or loading: auto-resume retries patiently',
		detector_error: 'service error: auto-resume retries patiently',
		config_drift: 'won’t retry: fix the config, then resume manually',
		coverage_shortfall: 'won’t retry: the source decodes short',
		source_error: 'won’t retry: the source can’t be opened',
		store_error: 'won’t retry: results couldn’t be stored',
		engine_restart: 'interrupted by a restart: resume manually',
	};

	/** The failure-cause enum as words: RESPONSE_TIMEOUT reads "response timeout". */
	function causeLabel(cause) {
		return String(cause || '').toLowerCase().replace(/_/g, ' ');
	}

	/** Millisecond figures in service error text become durations: 120000ms reads 2m 00s. */
	function humanizeMs(text) {
		return String(text || '').replace(/\b(\d{4,})ms\b/g, (all, n) => fmtDurationMs(+n));
	}

	const DETECTOR_META = {
		object: {
			badge: 'OBJ', name: 'Object Detection',
			desc: 'Finds and tracks objects frame by frame.',
			outs: 'outputs → detections[]{class_name, confidence, track_id, bbox}',
		},
		scene: {
			badge: 'SCN', name: 'Scene Detection',
			desc: 'Classifies what each sampled window shows.',
			outs: 'outputs → detections[]{class_name, confidence}',
		},
		vlm: {
			badge: 'VLM', name: 'VLM Analysis',
			desc: 'A vision-language model reviews sampled frames against your prompt.',
			outs: 'outputs → content, detections[]{class_name, reasoning}, token_count, degraded',
		},
		synthetic: {
			badge: 'SVD', name: 'Synthetic Detection',
			desc: 'Scores keyframe-aligned clips of the file for AI-generated content.',
			outs: 'outputs → synthetic_score, synthetic_logit, verdict, per_clip_scores[]',
		},
	};

	function toast(msg, kind) {
		const el = h('div', { class: 'toast' + (kind === 'err' ? ' err' : kind === 'warn' ? ' warn' : '') }, msg);
		document.getElementById('vod-toasts').appendChild(el);
		setTimeout(() => el.remove(), kind === 'err' ? 9000 : kind === 'warn' ? 7000 : 4500);
	}

	/**
	 * Opens the Stream Configs editor on this stream group config: the editor restores its
	 * selection from this localStorage key when it loads (vif-stream-config.js, loadStreams),
	 * so no editor change is needed — it keys on the group's match rule, which is the
	 * app/stream pair the editor lists. Storage failing just opens the editor unselected.
	 */
	function openStreamConfig(group) {
		const match = (group && group.match) || {};
		try {
			window.localStorage.setItem('vif.stream-config.selected-stream.' + window.location.host,
				(match.application || '') + '::' + (match.streamPattern || ''));
		} catch (e) { /* fall through to the plain page open */ }
		window.loadAjaxPluginContent('server', 'vif', 'stream-config.html', '');
	}

	/** Modal with arbitrary body; buttons: [{label, primary, onclick(close)}]. Returns close(). */
	function modal(title, body, buttons) {
		const root = document.getElementById('vod-modal-root');
		const close = () => clear(root);
		const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) close(); } },
			h('div', { class: 'modal' },
				h('div', { class: 'mh' }, h('h3', null, title),
					h('button', { class: 'btn btn-ghost btn-sm', style: 'margin-left:auto', onclick: close }, 'Close')),
				h('div', { class: 'mb' }, body),
				buttons && buttons.length ? h('div', { class: 'mf' },
					buttons.map((b) => h('button', {
						class: 'btn' + (b.primary ? ' btn-pri' : ''),
						onclick: () => b.onclick(close),
					}, b.label))) : null));
		clear(root).appendChild(back);
		return close;
	}

	V.h = h;
	V.clear = clear;
	V.snapshotScroll = snapshotScroll;
	V.fmtBytes = fmtBytes;
	V.fmtMediaMs = fmtMediaMs;
	V.fmtClock = fmtClock;
	V.fmtAgo = fmtAgo;
	V.jobTimingTip = jobTimingTip;
	V.fmtDurationMs = fmtDurationMs;
	V.jobDuration = jobDuration;
	V.jobQueueWait = jobQueueWait;
	V.RETRY_GLOSS = RETRY_GLOSS;
	V.causeLabel = causeLabel;
	V.humanizeMs = humanizeMs;
	V.DETECTOR_META = DETECTOR_META;
	V.toast = toast;
	V.modal = modal;
	V.openStreamConfig = openStreamConfig;
})(window.VIF.vod);
