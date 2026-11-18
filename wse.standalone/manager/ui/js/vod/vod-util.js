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
					growEl.style.minHeight = Math.ceil(growEl.getBoundingClientRect().height + (top - n.scrollTop)) + 'px';
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

	/** Date and clock, always dated: today's date reads "today". For lists that
	    mix ages, where a bare clock time would leave the day ambiguous. */
	function fmtDayClock(instant) {
		const ms = instant instanceof Date ? instant.getTime() : instant;
		if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
		const d = new Date(ms);
		const hms = p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
		return (localDay(d) === localDay(new Date()) ? 'today' : localDay(d)) + ' ' + hms;
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
		endpoint_rejected: 'won’t retry: fix the endpoint credentials, then resume manually',
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
		motion: {
			badge: 'MOV', name: 'Motion Detection',
			desc: 'Watches for movement from one frame to the next.',
			outs: 'outputs → detections[]{class_name, confidence, track_id, bbox}',
		},
		vlm: {
			badge: 'VLM', name: 'VLM Analysis',
			desc: 'A vision-language model reviews sampled frames against your prompt.',
			outs: 'outputs → content, detections[]{class_name, reasoning}, token_count, degraded',
		},
		synthetic: {
			badge: 'SVD', name: 'AI-Generated Video Detection',
			desc: 'Scores each stretch of the file for how likely it is AI-generated.',
			outs: 'outputs → synthetic_score, synthetic_logit, verdict, per_clip_scores[]',
		},
		chain: {
			badge: 'CHN', name: 'Chain Analysis',
			desc: 'Runs named stages over the same captured video window.',
			outs: 'Results show every retained stage in execution order.',
		},
		verify: {
			badge: 'VFY', name: 'Verify',
			desc: 'Scores every window for AI-generated content; a vision-language model reviews what crosses the threshold.',
			outs: 'outputs → verdict, windows[]{score, verdict}, review{verdict, confidence, attributes}',
		},
	};

	/** The state as the UI speaks it: the wire's "pending" reads "queued", the word
	    every other surface (sub-line, thumb, timing verb, state filter) already uses. */
	function stateLabel(state) {
		return state === 'pending' ? 'queued' : state;
	}

	function toast(msg, kind) {
		VIF.core.toast(msg, kind, 'vod-toasts');
	}

	/* The Loop, Muted and Speed settings for the VOD players: sticky for every player
	   (report, verify report and file preview), host-scoped like the dashboard's
	   thumbnail preference. A choice storage refuses is kept in memory, so the controls
	   still show what the video does. */
	const playerMemory = V.playerMemory = V.playerMemory || {};
	function playerSetting(name) {
		const key = 'vif.vod.player-' + name + '.' + window.location.host;
		return {
			on() {
				if (key in playerMemory) return playerMemory[key];
				try { return window.localStorage.getItem(key) === '1'; } catch (e) { return false; }
			},
			set(on) {
				try { window.localStorage.setItem(key, on ? '1' : '0'); delete playerMemory[key]; }
				catch (e) { playerMemory[key] = on; }
			}
		};
	}
	const playerLoop = playerSetting('loop');
	const playerMuted = playerSetting('muted');
	function playerLoopOn() { return playerLoop.on(); }
	function setPlayerLoop(on) { playerLoop.set(on); }
	function playerMutedOn() { return playerMuted.on(); }

	const PLAYER_SPEEDS = [0.5, 1, 1.5, 2];
	const speedKey = 'vif.vod.player-speed.' + window.location.host;
	function playerSpeed() {
		let stored = speedKey in playerMemory ? playerMemory[speedKey] : null;
		if (stored === null) { try { stored = window.localStorage.getItem(speedKey); } catch (e) { /* unreadable: normal speed */ } }
		return PLAYER_SPEEDS.indexOf(Number(stored)) >= 0 ? Number(stored) : 1;
	}
	function setPlayerSpeed(speed) {
		try { window.localStorage.setItem(speedKey, String(speed)); delete playerMemory[speedKey]; }
		catch (e) { playerMemory[speedKey] = speed; }
	}
	function applySpeed(video, speed) {
		video.defaultPlaybackRate = speed; // survives the reload a new HLS source does
		video.playbackRate = speed;
	}

	/**
	 * A video element for the VOD players. The browser's own menu is left empty so it doesn't
	 * show: speed is set from playerSpeedButtons. Its rate changing by any route re-marks the
	 * speed buttons on the page that control it.
	 */
	function playerVideo() {
		const video = h('video', { controls: '', playsinline: '', preload: 'metadata',
			disablepictureinpicture: '', controlslist: 'nodownload noplaybackrate noremoteplayback' });
		video.disablePictureInPicture = true;
		applySpeed(video, playerSpeed());
		video.addEventListener('ratechange', () => document.querySelectorAll('.pspeed').forEach((group) => {
			if (group.followRate) group.followRate(video);
		}));
		return video;
	}

	/**
	 * Speed buttons for a VOD player; the pick changes the playing video at once and sticks.
	 * A rate that is none of the buttons marks none.
	 */
	function playerSpeedButtons(video) {
		const group = h('span', { class: 'pspeed', role: 'group', 'aria-label': 'Playback speed' }, h('span', null, 'Speed'));
		const mark = (speed) => group.querySelectorAll('button').forEach((b) => {
			const on = Number(b.dataset.speed) === speed;
			b.classList.toggle('on', on);
			b.setAttribute('aria-pressed', on ? 'true' : 'false');
		});
		group.followRate = (changed) => { if (video() === changed) mark(changed.playbackRate); };
		PLAYER_SPEEDS.forEach((speed) => group.appendChild(h('button', { type: 'button', 'data-speed': String(speed),
			onclick: () => { setPlayerSpeed(speed); if (video()) applySpeed(video(), speed); mark(speed); } }, speed + '×')));
		mark(video() ? video().playbackRate : playerSpeed());
		return group;
	}

	/**
	 * The Speed buttons and the Loop and Muted checkboxes beside a VOD player. Each changes the
	 * playing video at once and sticks for every player opened after; video() is the player now showing, if any.
	 */
	function playerToggles(video) {
		// The label zeroes its margin and weight: the Manager's Bootstrap gives a label a 5px
		// bottom margin (which flex centers into a 2.5px droop) and bold text.
		const toggle = (label, setting, apply) => h('label', { class: 'hint', style: 'margin:0;font-weight:400;display:inline-flex;align-items:center;gap:5px;cursor:pointer' },
			h('input', { type: 'checkbox', style: 'margin:0;width:12px;height:12px', checked: setting.on() ? 'checked' : null,
				onchange: (e) => { setting.set(e.target.checked); if (video()) apply(video(), e.target.checked); } }),
			label);
		return h('span', { style: 'margin-left:auto;display:inline-flex;align-items:center;gap:12px' },
			playerSpeedButtons(video),
			toggle('Loop', playerLoop, (v, on) => { v.loop = on; }),
			toggle('Mute by Default', playerMuted, (v, on) => { v.muted = on; }));
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

	/** Opens the Stream Configs editor on "+ New Stream Config" with the detector type preselected. */
	function openNewStreamConfig(detectorType) {
		try {
			window.localStorage.setItem('vif.stream-config.selected-stream.' + window.location.host, '__new__');
			window.localStorage.setItem('vif.stream-config.new-detector-type.' + window.location.host, detectorType);
		} catch (e) { /* fall through to the plain page open */ }
		window.loadAjaxPluginContent('server', 'vif', 'stream-config.html', '');
	}

	/** Where the Engine plays a content-directory file from: its stock `vod` application, over HLS. */
	function filePlaybackUrl(file) {
		const props = (typeof pluginProperties !== 'undefined' && pluginProperties) || {};
		const conn = (window.VIF && VIF.core && VIF.core.resolveServer) ? VIF.core.resolveServer() : null;
		if (!file || !conn) return null;
		let engineHost;
		try { engineHost = new URL(conn.serverUrl).hostname; } catch (e) { return null; }
		// Same overrides the live dashboard player honors; default to the Engine's
		// standard streaming port. Page protocol, so an https Manager never tries
		// mixed-content http media (it needs playback_host/playback_port pointed at
		// an https streaming port instead).
		const host = props.playback_host || engineHost;
		const port = props.playback_port ? ':' + props.playback_port : ':1935';
		// _definst_ is mandatory: without it the Engine parses a subfolder (qa-vod/…)
		// as the application-instance name.
		// Per segment, not encodeURI: '#' or '?' in a legal file name must not truncate the path.
		const path = file.split('/').map(encodeURIComponent).join('/');
		return conn.protocol + '//' + host + port + '/vod/_definst_/mp4:' + path + '/playlist.m3u8';
	}

	/**
	 * Whether the Engine serves a playlist at this address. A compose Engine without the vod
	 * application answers 404, and without CORS headers, so the fetch may throw instead.
	 */
	async function playlistAnswers(url) {
		try { return (await fetch(url, { cache: 'no-store' })).ok; } catch (e) { return false; }
	}

	/* Where a dialog's focus wraps to, among those of these that are rendered. Tab itself is the
	   browser's: this list only picks the first and the last stop, and a control it misses is still reached. */
	const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), '
		+ 'textarea:not([disabled]), summary, video[controls], [tabindex]:not([tabindex="-1"])';

	let dismissModal = null;

	/** Modal dialog with arbitrary body; buttons: [{label, primary, onclick(close)}]. Returns close().
	    While it is open the view behind is inert and focus stays in the dialog; closing hands focus
	    back to the control that opened it. onClose runs once, however the modal is dismissed. */
	function modal(title, body, buttons, onClose) {
		if (dismissModal) dismissModal();
		const root = document.getElementById('vod-modal-root');
		const view = document.getElementById('vod-view');
		const opener = document.activeElement;
		let open = true;
		const release = () => {
			document.removeEventListener('focusin', keepFocus);
			if (view) view.inert = false;
		};
		const close = () => {
			if (!open) return;
			open = false;
			dismissModal = null;
			release();
			clear(root);
			if (onClose) onClose();
			// A list that re-rendered while the modal was up has replaced its opener.
			if (opener && opener.isConnected && opener.focus) opener.focus();
			else if (view && view.isConnected) { view.setAttribute('tabindex', '-1'); view.focus(); }
		};
		const dialog = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1' },
			h('div', { class: 'mh' }, h('h3', null, title),
				h('button', { class: 'btn btn-ghost btn-sm', style: 'margin-left:auto', onclick: close }, 'Close')),
			h('div', { class: 'mb' }, body),
			buttons && buttons.length ? h('div', { class: 'mf' },
				buttons.map((b) => h('button', {
					class: 'btn' + (b.primary ? ' btn-pri' : ''),
					onclick: () => b.onclick(close),
				}, b.label))) : null);
		// A drag across the dialog's edge (off the seek bar, a text selection) reports its
		// click on the backdrop; only a press and a release that both land there dismiss.
		let pressedBackdrop = false;
		let releasedBackdrop = false;
		// Tab leaves the dialog onto one of these, and keepFocus wraps it round.
		const before = h('span', { class: 'mtrap', tabindex: '0', 'aria-hidden': 'true' });
		const after = h('span', { class: 'mtrap', tabindex: '0', 'aria-hidden': 'true' });
		const back = h('div', { class: 'modal-back',
			onclick: (e) => { if (e.target === back && pressedBackdrop && releasedBackdrop) close(); } }, before, dialog, after);
		// Capturing: the player's controls keep some of their mouse events to themselves.
		back.addEventListener('mousedown', (e) => { pressedBackdrop = e.target === back; releasedBackdrop = false; }, true);
		back.addEventListener('mouseup', (e) => { releasedBackdrop = e.target === back; }, true);
		const stops = () => Array.from(dialog.querySelectorAll(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
		function keepFocus(e) {
			// A fragment swapped out with the modal still up must not keep steering focus.
			if (!back.isConnected) { release(); return; }
			if (dialog.contains(e.target)) return;
			const all = stops();
			(all[e.target === before ? all.length - 1 : 0] || dialog).focus();
		}
		clear(root).appendChild(back);
		if (view) view.inert = true;
		document.addEventListener('focusin', keepFocus);
		dismissModal = close;
		dialog.focus();
		return close;
	}

	V.h = h;
	V.clear = clear;
	V.snapshotScroll = snapshotScroll;
	V.fmtBytes = fmtBytes;
	V.fmtMediaMs = fmtMediaMs;
	V.fmtClock = fmtClock;
	V.fmtDayClock = fmtDayClock;
	V.fmtAgo = fmtAgo;
	V.jobTimingTip = jobTimingTip;
	V.fmtDurationMs = fmtDurationMs;
	V.jobDuration = jobDuration;
	V.jobQueueWait = jobQueueWait;
	V.RETRY_GLOSS = RETRY_GLOSS;
	V.causeLabel = causeLabel;
	V.humanizeMs = humanizeMs;
	V.DETECTOR_META = DETECTOR_META;
	V.stateLabel = stateLabel;
	V.toast = toast;
	V.playerLoopOn = playerLoopOn;
	V.setPlayerLoop = setPlayerLoop;
	V.playerMutedOn = playerMutedOn;
	V.filePlaybackUrl = filePlaybackUrl;
	V.playlistAnswers = playlistAnswers;
	V.playerToggles = playerToggles;
	V.playerVideo = playerVideo;
	V.playerSpeedButtons = playerSpeedButtons;
	V.playerSpeed = playerSpeed;
	V.modal = modal;
	V.openStreamConfig = openStreamConfig;
	V.openNewStreamConfig = openNewStreamConfig;
})(window.VIF.vod);
