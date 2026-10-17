/* Report — one job: a stat band and windows derived from the stored rows, the score
   strip as the chart, a row-browser drawer over the results API, and the failure/resume flows.

   The 2s poll and every async continuation are guarded by the mount generation (V.gen):
   a stale fetch must neither repaint the shared #vod-view root nor leave a timer behind.
   Renders happen only when the job actually progressed, keep <details> open-state and
   list scroll, and are skipped while the user is typing in one of the page's inputs. */
window.VIF = window.VIF || {};
VIF.vod = VIF.vod || {};
(function (V) {
	'use strict';
	const { h, clear, api, toast, DETECTOR_META } = V;

	const ROW_CAP = 5000; // strip/band fetch cap; the browser below pages server-side
	const STRIP_HUES = 6; // distinct class colors — must match the --strip-c0..c5 tokens in vod.css

	const view = {
		state: null,
		timer: null,
		gen: 0,
		reloading: false,

		async mount(root, params) {
			this.root = root;
			this.gen = V.gen = (V.gen || 0) + 1;
			this.reloading = false;
			this.stopPlayer(); // a remount must never inherit the previous job's stream
			this.state = {
				id: params && params.id, job: null, error: null,
				rows: [], rowsTotal: 0, rowsPartial: false, noResults: null,
				browser: { offset: 0, limit: 50, from_ms: '', to_ms: '', page: null, error: null, seq: 0 },
				tail: false, settlePolls: 0, thumbUrl: null, openRows: new Set(),
				playerOn: false, playError: null, stripSel: null,
				browserOpen: false, openZero: new Set(), openZeroPane: new Set(),
			};
			if (!this.state.id) { this.state.error = 'No job selected.'; this.render(); return; }
			this.render();
			await this.reload(true);
			if (this.gen !== V.gen) return;
			this.arm();
		},

		destroy() {
			if (this.timer) { clearInterval(this.timer); this.timer = null; }
			if (this.state && this.state.thumbUrl) { URL.revokeObjectURL(this.state.thumbUrl); this.state.thumbUrl = null; }
			this.stopPlayer();
		},

		arm() {
			if (this.timer) clearInterval(this.timer);
			const gen = this.gen;
			this.timer = setInterval(() => {
				if (gen !== V.gen) { clearInterval(this.timer); return; }
				const s = this.state;
				if (!s.job || isTerminal(s.job)) {
					// One more settle-poll after a cancel/resume, then stop burning requests.
					if (s.settlePolls > 0) { s.settlePolls--; this.reload(false); }
					return;
				}
				this.reload(false);
			}, 2000);
		},

		async reload(first) {
			if (this.reloading) return; // a slow sweep must not overlap the next tick
			this.reloading = true;
			const gen = this.gen;
			const s = this.state;
			let changed = !!first;
			try {
				// The header decodes the config's match rule from the groups listing;
				// a deep link lands here before anything else has loaded it.
				if (first && !V.store.groups) await api.streamGroups().catch(() => null);
				const job = await api.getJob(s.id);
				if (gen !== V.gen) return;
				const prev = s.job;
				changed = changed || !prev || prev.state !== job.state
					|| prev.requestsSent !== job.requestsSent || prev.mediaTimeMs !== job.mediaTimeMs;
				s.job = job;
				// The filter rests on the whole clip: from zero to the running time.
				if (first && !s.browser.from_ms && !s.browser.to_ms) {
					s.browser.from_ms = '00:00:00';
					if (job.sourceDurationMs) s.browser.to_ms = this.msToPaddedTc(job.sourceDurationMs);
				}
				if (s.error) { s.error = null; changed = true; }
				if (job.storeResults !== false && changed) {
					await this.fetchRows(gen);
					await this.fetchBrowserPage();
					if (s.tail && s.browser.page && s.browser.page.total) {
						const last = Math.max(0, Math.floor((s.browser.page.total - 1) / s.browser.limit) * s.browser.limit);
						if (s.browser.offset !== last) { s.browser.offset = last; await this.fetchBrowserPage(); }
					}
					await this.fetchThumb(gen);
				} else if (first) {
					await this.fetchThumb(gen);
				}
			} catch (e) {
				if (gen !== V.gen) return;
				if (s.error !== e.message) { s.error = e.message; changed = true; }
			} finally {
				this.reloading = false;
			}
			if (gen !== V.gen || !changed) return;
			// Don't repaint over the user's typing; the next progressed tick catches up.
			const active = document.activeElement;
			if (!first && active && this.root.contains(active) && active.matches('input,textarea,select')) return;
			this.render();
		},

		/** Appends only the rows not fetched yet — the results file is append-only. */
		async fetchRows(gen) {
			const s = this.state;
			try {
				let offset = s.rows.length, total = Infinity;
				while (offset < total && s.rows.length < ROW_CAP) {
					const page = await api.results(s.id, { offset, limit: 1000 });
					if (gen !== V.gen) return;
					total = page.total || 0;
					for (const r of (page.results || [])) s.rows.push(r);
					if (!page.count) break;
					offset += page.count;
				}
				s.rowsTotal = total === Infinity ? s.rows.length : total;
				s.rowsPartial = s.rows.length < s.rowsTotal;
				s.noResults = null;
			} catch (e) {
				if (e.status === 404) { s.noResults = e.message; }
				else toast(e.message, 'err');
			}
		},

		async fetchBrowserPage() {
			const s = this.state, b = s.browser;
			const gen = this.gen;
			const seq = ++b.seq;
			// The boxes hold human time; the API takes milliseconds.
			let from = this.parseTcMs(b.from_ms), to = this.parseTcMs(b.to_ms);
			if (from === null || to === null) {
				b.page = null;
				b.error = '“' + (from === null ? b.from_ms : b.to_ms) + '” is not a time: use m:ss, h:mm:ss.mmm, or milliseconds.';
				return;
			}
			if (from !== '' && to !== '' && +from > +to) {
				b.page = null;
				b.error = 'The from time is after the to time.';
				return;
			}
			// A zero from and a to at (or past) the clip's end are the resting
			// defaults, not filters: the request goes out unfiltered.
			if (from !== '' && +from === 0) from = '';
			if (to !== '' && s.job && s.job.sourceDurationMs && +to >= s.job.sourceDurationMs) to = '';
			try {
				const page = await api.results(s.id, { offset: b.offset, limit: b.limit, from_ms: from, to_ms: to });
				if (gen !== V.gen || seq !== b.seq) return;
				b.page = page;
				b.error = null;
			} catch (e) {
				if (gen !== V.gen || seq !== b.seq) return;
				b.page = null;
				b.error = e.message;
			}
		},

		async fetchThumb(gen) {
			const s = this.state;
			if (this.detectorType() === 'synthetic') return;
			const url = await api.thumbnail(s.id).catch(() => null);
			if (gen !== V.gen) { if (url) URL.revokeObjectURL(url); return; }
			if (s.thumbUrl) URL.revokeObjectURL(s.thumbUrl);
			s.thumbUrl = url;
		},

		/**
		 * The header facts as a labeled two-pair grid: Source/Status, Detection type/
		 * Config, Job/Tag. The config shows its decoded match rule the way the jobs
		 * table and the picker spell it; the job id is compressed to a copyable chip
		 * with the full id in the tooltip.
		 */
		renderJobMeta(job, type, copyId) {
			const s = this.state;
			const group = (V.store.groups || []).find(
				(x) => String(x.name).toLowerCase() === String(job.streamGroupConfig || '').toLowerCase());
			const m = (group && group.match) || {};
			const rule = m.application && m.streamPattern
				? m.application + ' / ' + m.streamPattern : (job.streamGroupConfig || 'inline');
			const shortId = s.id.length > 14 ? s.id.slice(0, 8) + '…' + s.id.slice(-5) : s.id;
			const cells = [];
			const put = (label, value) => cells.push(
				h('span', { class: 'jlabel' }, label + ':'), h('span', { class: 'jvcell' }, value));
			// Detection type gets the live dashboard's detector glyph and the model it
			// ran: object shows its RF-DETR variant, vlm its endpoint model, synthetic
			// the NVIDIA SVD NIM (named in text; shipping NVIDIA's logo is a licensing
			// question, the word is not).
			const det = (job.effectiveConfig || job.config || {}).detector || {};
			const nvidia = type === 'synthetic'; // the one branded model: the SVD NIM
			const model = type === 'object' ? det.model
				: type === 'vlm' ? (det.endpoint && det.endpoint.model)
				: nvidia ? 'SVD' : null;
			put('Source', h('span', { class: 'jval' }, job.file || s.id));
			put('Status', h('span', { class: 'st st-' + job.state }, job.state));
			put('Job ID', h('a', { href: '#', class: 'jid mono', title: 'vod-' + s.id + '\nClick to copy', onclick: copyId },
				'vod-' + shortId + ' ⧉'));
			if (job.streamGroupConfig || type) put('Config',
				h('a', { href: '#', class: 'cfglink mono', title: 'Show the analysis options this job ran with',
					onclick: (e) => { e.preventDefault(); V.showJobOptions(job); } }, rule));
			// Endpoint models arrive as org/name paths (Qwen/Qwen3-VL-4B-Instruct-FP8)
			// and wrap the row: show the basename, ellipsize what still overflows,
			// and keep the full path in the tooltip.
			const modelShort = model ? String(model).split('/').pop() : null;
			if (type) put('Detection type',
				h('span', { class: 'jval', style: 'display:inline-flex;align-items:center;gap:6px;min-width:0' },
					h('img', { class: 'dticon', src: 'wse-plugins/server/vif/'
						+ (['object', 'scene', 'vlm', 'synthetic'].indexOf(type) >= 0 ? type : 'unknown') + '.png', alt: '' }),
					h('span', { style: 'white-space:nowrap' }, DETECTOR_META[type] ? DETECTOR_META[type].name : type),
					modelShort ? h('span', { class: 'jmodel', title: modelShort === model ? null : model },
						'· ' + modelShort) : null,
					nvidia ? h('img', { class: 'nvlogo', src: 'wse-plugins/server/vif/nvidia-logo-horz.svg',
						alt: 'NVIDIA', title: 'NVIDIA SVD NIM' }) : null));
			if (job.tag) put('Tag', h('span', { class: 'tag tag-n' }, job.tag));
			return h('div', { class: 'jgrid' }, cells);
		},

		/**
		 * Synthetic clips cut at keyframes, so a keyframe-sparse file realizes fewer,
		 * longer windows than the configured grid predicts, and the Requests cell then
		 * reads as lost work (1 / 6). Explain it with the job's own numbers. Null when
		 * the signature doesn't fit: not synthetic, not completed, or windows landed
		 * close enough to the grid (the same 1.5x bar the dashboard's cadence warning uses).
		 */
		gopBoundNotice(job) {
			if (this.detectorType() !== 'synthetic' || job.state !== 'completed') return null;
			const cfg = job.effectiveConfig || job.config || {};
			const configuredS = cfg.processing && Number(cfg.processing.windowSeconds);
			const answered = Number(job.requestsSent);
			const sourceS = Number(job.sourceDurationMs) / 1000;
			if (!(configuredS > 0) || !(answered >= 1) || !(sourceS > 0)) return null;
			const realizedS = sourceS / answered;
			if (!(realizedS > configuredS * 1.5)) return null;
			return h('div', { class: 'rnotice' }, h('span', { class: 'ndot' }),
				'Each verdict covers about ' + realizedS.toFixed(realizedS >= 10 ? 0 : 1)
				+ 's of video instead of the ' + configuredS + 's configured. The file can only be '
				+ 'split at its keyframes, which are about that far apart. For ' + configuredS
				+ 's verdicts, re-encode with a keyframe every ' + configuredS + 's or less.');
		},

		/** The VLM job's mode (detect / describe / custom), null off-vlm. One derivation
		    for the pane, the stat band and the Mode cell, so they can never disagree. */
		vlmMode() {
			if (this.detectorType() !== 'vlm') return null;
			const job = this.state.job || {};
			const det = (job.effectiveConfig || job.config || {}).detector || {};
			if (det.mode) return String(det.mode).toLowerCase();
			if (det.custom) return 'custom';
			if (det.detect || (det.classes || []).length) return 'detect';
			return 'describe';
		},

		detectorType() {
			const s = this.state;
			return (s.job && s.job.detectorType) || (s.rows && s.rows[0] && s.rows[0].detector_type) || null;
		},

		/** classification_threshold as the job ran it: the effective config resolved every layer. */
		threshold() {
			const job = this.state.job;
			const config = job && (job.effectiveConfig || job.config);
			const detector = config && config.detector;
			return (detector && detector.classificationThreshold) ?? null;
		},

		/* ---------- player ----------
		   The source file plays over the Engine's own HLS (the stock `vod` application,
		   same content directory this job read from). The <video> element and hls.js
		   instance live on the view, not in state: render() re-appends the same node so
		   paging or a details toggle never restarts playback. */

		playbackUrl() {
			const s = this.state;
			if (!s.job || !s.job.file) return null;
			const props = (typeof pluginProperties !== 'undefined' && pluginProperties) || {};
			const conn = (window.VIF && VIF.core && VIF.core.resolveServer) ? VIF.core.resolveServer() : null;
			if (!conn) return null;
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
			const file = s.job.file.split('/').map(encodeURIComponent).join('/');
			return conn.protocol + '//' + host + port + '/vod/_definst_/mp4:' + file + '/playlist.m3u8';
		},

		async startPlayer(seekMs) {
			const s = this.state;
			if (s.playerOn) { if (seekMs !== undefined) this.seekTo(seekMs); return; }
			const url = this.playbackUrl();
			if (!url) return;
			const gen = this.gen;
			// Probe before mounting: a compose Engine without the vod application answers
			// 404 (and without CORS headers, so the fetch may throw) — keep the thumbnail
			// and say why instead of showing a dead player.
			let ok = false;
			try { ok = (await fetch(url, { cache: 'no-store' })).ok; } catch (e) { /* no app or unreachable */ }
			if (gen !== V.gen) return;
			// A second click (▶ then a strip cell) can resolve its probe after the first
			// already mounted — never mount twice, just honor the seek.
			if (s.playerOn) { if (seekMs !== undefined) this.seekTo(seekMs); return; }
			if (!ok) {
				s.playError = 'No HLS playlist at ' + url + '. Playback needs the Engine’s standard "vod" '
					+ 'application (stock installs ship it; the compose stack may need it created once, see the VOD guide).';
				this.render();
				return;
			}
			this.pendingSeekMs = seekMs === undefined ? null : seekMs;
			this.mountPlayer(url);
		},

		mountPlayer(url) {
			const s = this.state;
			const video = h('video', { controls: '', playsinline: '', preload: 'metadata' });
			if (window.Hls && Hls.isSupported()) {
				const hls = new Hls({ enableWorker: true });
				this.hls = hls;
				hls.loadSource(url);
				hls.attachMedia(video);
				hls.on(Hls.Events.ERROR, (evt, data) => {
					// Instance identity, not generations: stopPlayer nulls this.hls on every
					// teardown, so an orphaned instance can never kill the active player.
					if (!data.fatal || this.hls !== hls) return;
					this.stopPlayer();
					s.playError = 'Playback failed (' + (data.details || data.type) + '); keeping the thumbnail.';
					this.render();
				});
			} else if (video.canPlayType('application/vnd.apple.mpegurl')) {
				video.src = url; // native HLS (Safari)
			} else {
				s.playError = 'HLS playback is not supported in this browser.';
				this.render();
				return;
			}
			video.addEventListener('loadedmetadata', () => {
				if (this.gen !== V.gen || this.videoEl !== video) return;
				if (this.pendingSeekMs !== null && this.pendingSeekMs !== undefined) {
					video.currentTime = this.pendingSeekMs / 1000;
					this.pendingSeekMs = null;
				}
				video.play().catch(() => { /* autoplay blocked — the controls are right there */ });
			});
			video.addEventListener('timeupdate', () => this.movePlayhead());
			this.videoEl = video;
			s.playerOn = true;
			s.playError = null;
			this.render();
		},

		stopPlayer() {
			if (this.hls) { try { this.hls.destroy(); } catch (e) { /* already torn down */ } this.hls = null; }
			if (this.videoEl) {
				try { this.videoEl.pause(); this.videoEl.removeAttribute('src'); this.videoEl.load(); } catch (e) { /* detached */ }
				this.videoEl = null;
			}
			this.pendingSeekMs = null;
			if (this.state) this.state.playerOn = false;
		},

		seekTo(ms) {
			if (!this.videoEl) return;
			if (this.videoEl.readyState >= 1) this.videoEl.currentTime = ms / 1000;
			else this.pendingSeekMs = ms;
		},

		/** Direct DOM: the marker rides timeupdate, far too often to re-render for. */
		movePlayhead() {
			const mark = this.root && this.root.querySelector('.stripwrap .pmark');
			const cellBox = this.root && this.root.querySelector('.stripwrap .pcell');
			const v = this.videoEl;
			const endMs = this.stripEndMs || 0;
			const live = v && endMs && this.state.playerOn;
			if (mark) {
				if (!live) { mark.style.display = 'none'; }
				else {
					mark.style.display = 'block';
					mark.style.left = Math.min(100, 100 * (v.currentTime * 1000) / endMs).toFixed(2) + '%';
				}
			}
			// The outline sits on the cell whose window contains the playhead — found
			// by the cells' real time spans, placed by the cell's own layout box.
			if (cellBox) {
				const spans = this.cellSpans || [];
				let idx = -1;
				if (live) {
					const t = v.currentTime * 1000;
					for (let i = 0; i < spans.length; i++) { if (spans[i].s <= t) idx = i; else break; }
				}
				const cellEl = idx >= 0 ? this.root.querySelectorAll('.stripwrap .strip > i')[idx] : null;
				if (!live || !cellEl) { cellBox.style.display = 'none'; }
				else {
					cellBox.style.display = 'block';
					cellBox.style.left = cellEl.offsetLeft + 'px';
					cellBox.style.width = cellEl.offsetWidth + 'px';
				}
			}
			this.syncPlayingRow(false);
		},

		/**
		 * Highlights the window row under the playhead and, while Follow is engaged,
		 * keeps it centered in the list. Same direct-DOM discipline as the strip
		 * marker: this rides timeupdate, far too often to re-render for.
		 */
		syncPlayingRow(force) {
			const s = this.state;
			const list = this.root && this.root.querySelector('.wlist');
			const v = this.videoEl;
			if (!list || !v || !s.playerOn) return;
			const t = v.currentTime * 1000;
			let hit = null;
			list.querySelectorAll('[data-from]').forEach((el) => {
				const from = +el.dataset.from;
				const to = +(el.dataset.to || el.dataset.from);
				const on = t >= from && (t < to || (to <= from && t < from + 1000));
				el.classList.toggle('playing', on);
				if (on) hit = el;
			});
			if (hit && (force || s.followTail !== false)) {
				const delta = hit.getBoundingClientRect().top - list.getBoundingClientRect().top;
				const target = Math.max(0, list.scrollTop + delta - list.clientHeight / 2 + hit.offsetHeight / 2);
				if (Math.abs(list.scrollTop - target) > 4) { this.progScroll = true; list.scrollTop = target; }
			}
		},

		/** Where this row starts on the media timeline, in ms — null when unknowable. */
		rowStartMs(r) {
			const w = (r && r.detection_window) || {};
			if (typeof w.from_time_code === 'number') return w.from_time_code;
			if (typeof w.from_frame === 'string') {
				const m = w.from_frame.match(/^(\d+):(\d\d):(\d\d)/); // clip rows carry timecode strings
				if (m) return ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000;
			}
			return null;
		},

		/** Where this row ends on the media timeline, in ms — null when unknowable. */
		rowEndMs(r) {
			const w = (r && r.detection_window) || {};
			if (typeof w.to_time_code === 'number') return w.to_time_code;
			if (typeof w.to_frame === 'string') {
				const m = w.to_frame.match(/^(\d+):(\d\d):(\d\d)/);
				if (m) return ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000;
			}
			return null;
		},

		/* ---------- derivations ---------- */

		rowValue(r, type) {
			if (type === 'synthetic') return typeof r.synthetic_score === 'number' ? r.synthetic_score : 0;
			const dets = r.detections || [];
			if (type === 'vlm') return dets.length ? 1 : 0;
			let max = 0;
			for (const d of dets) if (typeof d.confidence === 'number' && d.confidence > max) max = d.confidence;
			return max;
		},

		rowLow(r, type) {
			if (type === 'synthetic') return r.verdict !== 'synthetic';
			return (r.detections || []).length === 0;
		},

		/** Per-class {name, count, max} over these rows, most detections first (ties: higher
		    confidence, then name). Real class names only — the VLM describe sentinel and
		    custom-schema rows have none, so those jobs simply yield no entries. */
		classEntries(rows) {
			const agg = new Map();
			for (const r of rows) for (const d of (r.detections || [])) {
				if (!d.class_name || d.class_name === 'description' || (d.data && typeof d.data === 'object')) continue;
				const e = agg.get(d.class_name) || { name: d.class_name, count: 0, max: 0 };
				e.count++;
				if (typeof d.confidence === 'number' && d.confidence > e.max) e.max = d.confidence;
				agg.set(d.class_name, e);
			}
			return Array.from(agg.values())
				.sort((a, b) => b.count - a.count || b.max - a.max || (a.name < b.name ? -1 : 1));
		},

		/** The prose a VLM row carries: content, the describe sentinel's reasoning, or the
		    custom-schema data fields rendered flat. Null when the row said nothing. */
		vlmRowText(r) {
			if (r.content) return r.content;
			for (const d of (r.detections || [])) {
				if (d.class_name === 'description' && d.reasoning) return d.reasoning;
				if (d.data && typeof d.data === 'object') {
					return Object.keys(d.data).map((k) => {
						const v = d.data[k];
						return k + ': ' + (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));
					}).join(' · ');
				}
			}
			return null;
		},

		/** ms → "m:ss" / "h:mm:ss", with ".mmm" only when the value isn't a whole second. */
		msToTc(ms) {
			const hh = Math.floor(ms / 3600000), mm = Math.floor(ms / 60000) % 60, ss = Math.floor(ms / 1000) % 60;
			const frac = Math.round(ms % 1000);
			const pad = (n) => String(n).padStart(2, '0');
			return (hh ? hh + ':' + pad(mm) : String(mm)) + ':' + pad(ss)
				+ (frac ? '.' + String(frac).padStart(3, '0') : '');
		},

		/** As msToTc, but fully padded (00:00:04) to match the drawer rows' clip timecodes. */
		msToPaddedTc(ms) {
			const pad = (n) => String(n).padStart(2, '0');
			const frac = Math.round(ms % 1000);
			return pad(Math.floor(ms / 3600000)) + ':' + pad(Math.floor(ms / 60000) % 60)
				+ ':' + pad(Math.floor(ms / 1000) % 60)
				+ (frac ? '.' + String(frac).padStart(3, '0') : '');
		},

		/** "h:mm:ss.mmm" / "m:ss" / "ss.mmm" / plain ms → ms as a string for the results
		    filter. '' stays '', unparseable text is null so the caller can say so. */
		parseTcMs(text) {
			const t = String(text || '').trim();
			if (!t) return '';
			if (/^\d+$/.test(t)) return t; // plain milliseconds
			let m = t.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/);
			if (m) {
				return String(((+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000
					+ +(m[4] || '0').padEnd(3, '0'));
			}
			m = t.match(/^(\d+)\.(\d{1,3})$/); // bare seconds with a fraction
			if (m) return String((+m[1]) * 1000 + +m[2].padEnd(3, '0'));
			return null;
		},

		windowLabel(r) {
			const w = r.detection_window || {};
			// A single-frame window (object rows) is one instant: show it once, with the
			// sub-second part — five frames inside the same second must not read alike.
			if (typeof w.from_time_code === 'number' && w.to_time_code === w.from_time_code) {
				return this.msToTc(w.from_time_code);
			}
			if (w.from_frame && w.to_frame) {
				if (w.from_frame === w.to_frame) return w.from_frame.replace(/^00:(0?)/, '').replace(/\.000$/, '');
				return w.from_frame.slice(0, 8) + ' – ' + w.to_frame.slice(0, 8);
			}
			if (typeof w.from_time_code === 'number') return V.fmtMediaMs(w.from_time_code) + ' – ' + V.fmtMediaMs(w.to_time_code || w.from_time_code);
			return '';
		},

		/** <details> whose open state survives the poll re-renders. */
		keyedDetails(key, attrs) {
			const s = this.state;
			const el = h.apply(null, ['details', Object.assign({}, attrs, { open: s.openRows.has(key) ? '' : null })]
				.concat(Array.prototype.slice.call(arguments, 2)));
			el.addEventListener('toggle', () => {
				if (el.open) s.openRows.add(key); else s.openRows.delete(key);
			});
			return el;
		},

		/* ---------- render ---------- */

		render() {
			if (this.gen !== V.gen) return;
			const s = this.state;
			// Keep the windows list's scroll across re-renders.
			const priorList = this.root.querySelector('.wlist');
			const priorScroll = priorList ? priorList.scrollTop : 0;
			// clear() detaches the video; re-appending the same node below keeps its buffer
			// and position, but some engines pause on the move — resume at the end.
			const wasPlaying = this.videoEl && !this.videoEl.paused && !this.videoEl.ended;
			const restoreScroll = V.snapshotScroll(this.root);

			const root = clear(this.root);
			const crumb = () => h('a', { class: 'crumb', href: '#', onclick: (e) => { e.preventDefault(); V.nav('jobs'); } }, '← On-Demand Jobs');
			if (s.error && !s.job) {
				root.appendChild(h('div', { class: 'phead' },
					h('div', null, crumb(), h('h2', null, 'Job'))));
				root.appendChild(h('div', { class: 'errbanner', style: 'margin-top:14px' }, s.error));
				restoreScroll();
				return;
			}
			if (!s.job) { root.appendChild(h('div', { class: 'empty' }, 'Loading…')); restoreScroll(); return; }

			const job = s.job;
			const type = this.detectorType();
			const refresh = () => { s.settlePolls = 6; this.reload(false); };

			// header
			const headBtns = [];
			if (job.storeResults !== false) headBtns.push(h('button', { class: 'btn', onclick: () => V.jobActions.jsonl(job) }, 'Download JSONL'));
			if (!isTerminal(job)) headBtns.push(h('button', { class: 'btn btn-danger', onclick: () => V.jobActions.cancel(job, refresh) }, 'Cancel'));
			if (V.jobHelpers.canResume(job)) headBtns.push(h('button', { class: 'btn', onclick: () => V.jobActions.resume(job, refresh) }, 'Resume'));
			if (isTerminal(job)) headBtns.push(h('button', { class: 'btn btn-danger', onclick: () => V.jobActions.del(job, () => { V.nav('jobs'); }) }, 'Delete'));

			const copyId = (e) => {
				e.preventDefault();
				const id = 'vod-' + s.id;
				if (navigator.clipboard && navigator.clipboard.writeText) {
					navigator.clipboard.writeText(id).then(() => toast('Job id copied')).catch(() => toast(id));
				} else toast(id);
			};
			root.appendChild(h('div', { class: 'phead' },
				h('div', null,
					crumb(),
					this.renderJobMeta(job, type, copyId)),
				h('div', { class: 'sp' }, headBtns)));

			if (s.error) root.appendChild(h('div', { class: 'errbanner' }, s.error));

			if (job.listenerWarning) {
				// The module's warning is wire-speak (Id3Event needs [LIVE_STREAM]);
				// the tooltip translates it into which listeners sat this job out and why.
				const skipped = [];
				const re = /(\S+) needs \[([^\]]+)\]/g;
				let match;
				while ((match = re.exec(job.listenerWarning))) skipped.push(match);
				const NEEDS = { LIVE_STREAM: 'only applicable for live streams' };
				const tip = skipped.length
					? 'Event listeners not used for this file job:\n' + skipped.map((x) =>
						x[1] + ' (' + (NEEDS[x[2]] || 'only applicable with ' + x[2].toLowerCase().replace(/_/g, ' ')) + ')').join('\n')
					: job.listenerWarning;
				const n = skipped.length || (job.listenerWarning.match(/needs \[/g) || []).length;
				// The title sits on an inline span, not the block: the notice div spans
				// the page, and a block-level title pops the tooltip wherever the cursor
				// happens to hover in all that empty width.
				root.appendChild(h('div', { class: 'rnotice' },
					h('span', { title: tip, style: 'display:inline-flex;align-items:center;gap:8px' },
						h('span', { class: 'ndot' }),
						n === 1 ? '1 event listener doesn’t apply to file jobs and was skipped'
							: (n ? n + ' event listeners' : 'Some event listeners') + ' don’t apply to file jobs and were skipped')));
			}

			const gopNotice = this.gopBoundNotice(job);
			if (gopNotice) root.appendChild(gopNotice);

			// failure banner
			if (job.state === 'failed') {
				root.appendChild(h('div', { class: 'failband' },
					job.errorCause ? h('span', { class: 'tag tag-e', style: 'margin-top:2px', title: job.errorCause },
						V.causeLabel(job.errorCause)) : null,
					h('div', { style: 'flex:1;min-width:260px' },
						h('div', { style: 'font-weight:700;font-size:13px' }, 'The job stopped early'),
						job.error ? h('div', { class: 'fx', style: 'margin-top:4px', title: job.error },
							V.humanizeMs(job.error)) : null,
						h('div', { class: 'hint', style: 'margin-top:6px' },
							(job.errorCause && V.RETRY_GLOSS[job.errorCause] ? V.RETRY_GLOSS[job.errorCause] + '. ' : ''),
							'Progress is kept: a resume continues from the last stored window, appending to the same results file.',
							job.resumes ? ' Resumed ×' + job.resumes + ' so far.' : '')),
					V.jobHelpers.canResume(job) ? h('button', { class: 'btn btn-pri', style: 'align-self:center', onclick: () => V.jobActions.resume(job, refresh) }, 'Resume') : null));
			}

			// stat band, then the strip across the full width, then the two columns,
			// with the raw rows tucked into the drawer at the bottom.
			root.appendChild(this.renderStatBand(job, type));

			if (job.storeResults === false) {
				root.appendChild(h('div', { class: 'empty' },
					'This job was submitted with store_results: false, so it is status only: nothing for the results endpoint to serve, no resume point.'));
			} else if (s.noResults) {
				root.appendChild(h('div', { class: 'empty' }, s.noResults));
			} else {
				root.appendChild(this.renderStrip(type));
				root.appendChild(h('div', { class: 'rbody' },
					h('div', null, this.renderWindows(type)),
					h('div', null, this.renderFrame(type))));
				root.appendChild(this.renderBrowser());
			}

			const newList = this.root.querySelector('.wlist');
			if (newList) {
				// Tail mode jumps to the newest row; playback mode positions via
				// syncPlayingRow when movePlayhead runs at the end of this render.
				if (this.tailMode() && this.followEligible() && s.followTail !== false) {
					this.progScroll = true;
					newList.scrollTop = newList.scrollHeight;
				} else if (priorScroll) {
					newList.scrollTop = priorScroll;
				}
				this.hookWindowFollow(newList);
			}
			if (wasPlaying && this.videoEl && this.videoEl.paused) this.videoEl.play().catch(() => { /* fine */ });
			restoreScroll(this.letPageShrink ? null : root.lastElementChild);
			this.letPageShrink = false;
			this.movePlayhead();
		},

		/* One glance across the band: progress (or duration once done) first, what the
		   detector found in the middle, the request ledger last. The definitions live in
		   the tooltips so the labels stay short. */
		renderStatBand(job, type) {
			const s = this.state;
			const rows = s.rows || [];
			const cell = (label, value, sub, tip, barPct, barCls) => h('div', { class: 'rcell' },
				h('div', { class: 'rcl' }, label,
					tip ? h('span', { class: 'vif-help-tip', title: tip }, '?') : null),
				h('div', { class: 'rcv' }, value),
				sub ? h('div', { class: 'rcs' }, sub) : null,
				barPct !== undefined ? h('div', { class: 'rpbar' + (barCls ? ' ' + barCls : ''), role: 'progressbar', 'aria-valuemin': '0',
					'aria-valuemax': '100', 'aria-valuenow': String(Math.round(barPct)) },
					h('i', { style: 'width:' + barPct.toFixed(1) + '%' })) : null);
			const cells = [];

			if (job.state === 'completed') {
				// Duration is the video's own length; how long the analysis took is
				// the qualifier under it, and the submit/finish clock is tip detail.
				const duration = V.jobDuration(job);
				cells.push(cell('Duration', V.fmtMediaMs(job.sourceDurationMs || job.mediaTimeMs) || '—',
					[duration !== null ? 'analyzed in ' + V.fmtDurationMs(duration) : null,
						job.endedAt ? 'finished ' + V.fmtAgo(job.endedAt) : null].filter(Boolean).join(' · '),
					'The length of the video.\n'
					+ [job.queuedAt ? 'submitted ' + V.fmtClock(new Date(job.queuedAt)) : null,
						job.endedAt ? 'finished ' + V.fmtClock(new Date(job.endedAt)) : null].filter(Boolean).join('\n')));
			} else {
				const pct = job.sourceDurationMs ? Math.min(100, 100 * job.mediaTimeMs / job.sourceDurationMs)
					: job.requestsTotal ? Math.min(100, 100 * job.requestsSent / job.requestsTotal) : 0;
				cells.push(cell('Progress', Math.round(pct) + '%',
					V.fmtMediaMs(job.mediaTimeMs) + (job.sourceDurationMs ? ' of ' + V.fmtMediaMs(job.sourceDurationMs) : '') + ' analyzed',
					'How far through the video the analysis is, by media time; not how long it has been running.', pct));
			}

			const partialSub = s.rowsPartial ? ' · first ' + ROW_CAP + ' rows' : '';
			const partialTip = s.rowsPartial
				? ' These numbers read the first ' + ROW_CAP + ' stored rows; the Detection details drawer below pages through all of them.' : '';

			if (type === 'synthetic' && rows.length) {
				const scores = rows.map((r) => r.synthetic_score).filter((x) => typeof x === 'number');
				const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
				const peak = scores.length ? Math.max.apply(null, scores) : null;
				const threshold = this.threshold();
				const flagged = rows.filter((r) => r.verdict === 'synthetic').length;
				// The headline follows the video-level score (the mean across windows)
				// against the same threshold the windows use — the model vendor's own
				// presentation, so a few hot windows cannot brand a mostly-real video.
				// The one guardrail on top: a long contiguous flagged run reads as a
				// spliced-in segment and promotes the headline even when the mean is low.
				let run = 0, runEnd = -1, streak = 0;
				rows.forEach((r, i) => {
					streak = r.verdict === 'synthetic' ? streak + 1 : 0;
					if (streak > run) { run = streak; runEnd = i; }
				});
				const RUN_PROMOTES = 5;
				const over = mean !== null && threshold !== null && mean >= +threshold;
				const promoted = !over && run >= RUN_PROMOTES;
				const thrLabel = threshold !== null ? Math.round(100 * +threshold) + '%' : null;
				const runFrom = run ? this.rowStartMs(rows[runEnd - run + 1]) : null;
				const runTo = run ? this.rowEndMs(rows[runEnd]) : null;
				// Equal billing under the judgment: how much of the timeline each side
				// holds, by duration (the strip's own currency), dominant side first.
				// Windows the service could not score sit on neither side of the bar.
				const durOf = (want) => rows.reduce((a, r) => {
					if (r.verdict !== want) return a;
					const s0 = this.rowStartMs(r), e0 = this.rowEndMs(r);
					return a + (s0 !== null && e0 !== null && e0 > s0 ? e0 - s0 : 0);
				}, 0);
				const synMs = durOf('synthetic'), realMs = durOf('real');
				const knownMs = synMs + realMs;
				const unscored = rows.filter((r) => r.verdict !== 'synthetic' && r.verdict !== 'real').length;
				const balance = knownMs ? (synMs >= realMs
					? 'synthetic ' + V.fmtMediaMs(synMs) + ' · real ' + V.fmtMediaMs(realMs)
					: 'real ' + V.fmtMediaMs(realMs) + ' · synthetic ' + V.fmtMediaMs(synMs)) : null;
				// The share line continues the headline when the headline names synthetic
				// ("Synthetic content detected / in 57% of the video"); under "Likely real
				// video" it stands alone instead. Duration-based, like the bar it sits on.
				const synPct = knownMs ? Math.round(100 * synMs / knownMs) : 0;
				const synPctLabel = flagged && synPct === 0 ? '<1%' : synPct + '%';
				const share = flagged && knownMs
					? ((over || promoted ? 'in ' : 'synthetic in ') + synPctLabel + ' of the video')
					: null;
				// The tooltip is one explainer paragraph, then Label: value receipts.
				// One currency throughout the cell: time of the video, never window
				// counts — two percentages measuring different things read as a bug.
				const receipts = [];
				if (flagged) {
					receipts.push('Flagged: ' + V.fmtMediaMs(synMs) + ' of the video (' + synPctLabel + ')');
					receipts.push('Longest run: '
						+ (runFrom !== null && runTo !== null && runTo > runFrom
							? V.fmtMediaMs(runTo - runFrom) + ' (' + V.fmtMediaMs(runFrom) + ' – ' + V.fmtMediaMs(runTo) + ')'
							: run + (run === 1 ? ' window' : ' windows')));
				}
				if (unscored) receipts.push('Unscored: ' + unscored + (unscored === 1 ? ' window' : ' windows') + ', no score from the service');
				cells.push(cell('Verdict',
					!flagged ? 'No synthetic content detected'
						: over ? 'Synthetic content detected'
						: promoted ? 'Synthetic segment detected'
						: 'Likely real video',
					[share ? h('div', { class: 'rcsv' }, share) : null,
						h('div', null, (balance || (thrLabel ? 'threshold ' + thrLabel : 'no scored windows')) + partialSub)],
					(mean !== null ? 'Synthetic score ' + Math.round(100 * mean) + '%: the average across all '
							+ rows.length + ' analyzed windows'
							+ (thrLabel ? ', judged against the ' + thrLabel + ' classification threshold' : '')
							+ '. Lower means stronger evidence of real content.'
						: 'Each window is judged against the classification threshold' + (thrLabel ? ' (' + thrLabel + ')' : '') + '.')
					+ (receipts.length ? '\n\n' + receipts.join('\n') : '')
					+ partialTip,
					knownMs ? 100 * synMs / knownMs : undefined, 'syn'));
				cells.push(cell('Peak score', peak !== null ? peak.toFixed(3) : '—',
					mean !== null ? 'mean ' + mean.toFixed(3) : null,
					'A window\'s score is the model\'s probability that its clip is synthetic. Peak is the strongest window in the file; mean averages every window.'));
			} else if (type === 'vlm' && rows.length) {
				const answered = rows.filter((r) => r.content || (r.detections || []).length).length;
				const degraded = rows.filter((r) => r.degraded).length;
				cells.push(cell('Windows answered', answered + ' / ' + rows.length,
					(degraded ? degraded + ' degraded' : 'one model call each') + partialSub,
					'Windows where the model returned content or detections. Degraded windows got no usable answer '
					+ '(endpoint trouble) but the job kept going.' + partialTip));
				const modeKey = this.vlmMode() || 'describe';
				cells.push(cell('Mode', modeKey.charAt(0).toUpperCase() + modeKey.slice(1),
					(rows.find((r) => r.model_name) || {}).model_name || null,
					'How the VLM was prompted: Detect names classes to find, Describe asks for free-form prose, '
					+ 'Custom runs the job’s own prompt or schema.'));
				if (modeKey === 'detect') {
					// Detect answers are classes per window, so it reports like object
					// and scene do: sightings and distinct classes.
					let total = 0; const classes = new Set();
					for (const r of rows) for (const d of (r.detections || [])) { total++; if (d.class_name) classes.add(d.class_name); }
					const det = (job.effectiveConfig || job.config || {}).detector || {};
					const cfgN = (((det.detect || {}).classes) || det.classes || []).length;
					cells.push(cell('Detections', String(total), 'raw, across stored windows' + partialSub,
						'Every detection in every stored window, added up.\nThe same subject seen in five windows counts five times: this counts sightings, not distinct objects.' + partialTip));
					cells.push(cell('Classes seen', String(classes.size), cfgN ? 'of ' + cfgN + ' configured' : null,
						'Distinct class names among the detections so far.' + partialTip));
				}
			} else if ((type === 'object' || type === 'scene') && rows.length) {
				let total = 0; const classes = new Set();
				for (const r of rows) for (const d of (r.detections || [])) { total++; if (d.class_name) classes.add(d.class_name); }
				cells.push(cell('Detections', String(total), 'raw, across stored windows' + partialSub,
					'Every detection in every stored window, added up.\nThe same object seen in five windows counts five times: this counts sightings, not distinct objects.' + partialTip));
				cells.push(cell('Windows', String(s.rowsTotal || rows.length), 'one analysis request each',
					'Each window is one slice of media the service analyzed and answered, with one stored row each.'));
				const cfg = (job.effectiveConfig || job.config || {}).detector || {};
				const cfgN = (cfg.classes || []).length;
				cells.push(cell('Classes seen', String(classes.size), cfgN ? 'of ' + cfgN + ' configured' : null,
					'Distinct class names among the detections so far.' + partialTip));
			}

			// The ratio only informs when the numbers diverge (running, keyframe-bound,
			// truncated); a finished job that answered everything says so in one number.
			const settled = job.state === 'completed' && job.requestsTotal
				&& job.requestsSent >= job.requestsTotal;
			cells.push(cell('Requests',
				settled ? String(job.requestsSent) : job.requestsSent + ' / ' + (job.requestsTotal || '?'),
				(settled ? 'all requests answered' : 'answered / expected')
					+ (job.resumes ? ' · resumed ×' + job.resumes : ''),
				(type === 'object'
					? 'Total analysis requests processed by the service.'
					: 'Total window requests processed by the service.')
				+ (this.detectorType() === 'synthetic'
					? '\nFewer than expected usually means the video has few keyframes: windows can only start at a keyframe, so they come out longer and fewer.' : '')
				+ (job.resumes ? '\nThis job resumed ' + job.resumes + ' time' + (job.resumes > 1 ? 's' : '')
					+ ' and continued from the last stored window.' : '')));

			return h('div', { class: 'rband' }, cells);
		},

		renderStrip(type) {
			const s = this.state;
			const rows = s.rows || [];
			this.browserColors = null;
			if (!rows.length) return h('div', { class: 'stripblock' },
				h('div', { class: 'eyebrow', style: 'margin-bottom:6px' }, 'Score strip'),
				h('div', { class: 'hint' }, s.job && !isTerminal(s.job) ? 'Rows appear here as the service answers.' : 'No stored rows: the analysis found nothing to store, or none were kept.'));

			const BIN_LIMIT = 120;
			const lastW = rows[rows.length - 1].detection_window || {};
			const endMs = s.job.sourceDurationMs || lastW.to_time_code || lastW.from_time_code || 0;
			this.stripEndMs = endMs;

			const mkCell = (bucket, i, n) => {
				const entries = this.classEntries(bucket);
				return {
					idx: i, rows: bucket, n: bucket.length,
					v: Math.max.apply(null, bucket.map((r) => this.rowValue(r, type))),
					low: bucket.every((r) => this.rowLow(r, type)),
					startMs: this.rowStartMs(bucket[0]) ?? Math.round(endMs * i / n),
					lastEndMs: this.rowEndMs(bucket[bucket.length - 1]),
					entries, classes: new Set(entries.map((e) => e.name)),
				};
			};
			let cells;
			if (rows.length <= BIN_LIMIT) {
				cells = rows.map((r, i) => mkCell([r], i, rows.length));
			} else {
				cells = [];
				const per = rows.length / BIN_LIMIT;
				for (let i = 0; i < BIN_LIMIT; i++) {
					// a binned cell covers its whole bucket — start/end/hovercard say so
					const bucket = rows.slice(Math.floor(i * per), Math.max(Math.floor(i * per) + 1, Math.floor((i + 1) * per)));
					cells.push(mkCell(bucket, i, BIN_LIMIT));
				}
			}
			for (let i = 0; i < cells.length; i++) {
				const c = cells[i];
				c.endMs = c.lastEndMs != null && c.lastEndMs > c.startMs ? c.lastEndMs
					: (i + 1 < cells.length ? cells[i + 1].startMs : endMs);
			}
			// The playhead finds its cell by these spans, not by index arithmetic:
			// keyframe-bound windows make cell durations uneven.
			this.cellSpans = cells.map((c) => ({ s: c.startMs ?? 0, e: c.endMs ?? 0 }));

			// Class colors: stable hues for the top classes across every stored row, the
			// rest lumped as "other". Synthetic and text-mode VLM jobs have no classes,
			// so they keep the plain accent strip and get no legend.
			const rank = type === 'synthetic' ? [] : this.classEntries(rows);
			const top = rank.slice(0, STRIP_HUES);
			const colorIdx = new Map(top.map((e, i) => [e.name, i]));
			this.browserColors = colorIdx; // the drawer's chips reuse the strip's hues
			const otherCount = rank.slice(STRIP_HUES).reduce((a, e) => a + e.count, 0);
			if (s.stripSel && !top.some((e) => e.name === s.stripSel)) s.stripSel = null;

			const seekable = isTerminal(s.job) && !!s.job.file;
			const cardCtx = { type, seekable, hasClasses: top.length > 0 };
			const card = h('div', { class: 'stripcard', style: 'display:none' });
			this.cardEl = card;
			this.cellCount = cells.length;

			// Synthetic cells take the alert red (via CSS, the spec pins no inline
			// backgrounds here): score opacity ramps pale pink to deep red, so
			// flagged runs read as flagged instead of blending into the grays.
			const strip = h('div', { class: 'strip' + (type === 'synthetic' ? ' syn' : ''), onmouseleave: () => { card.style.display = 'none'; } },
				cells.map((c) => {
					// The legend selection dims every cell without that class — inline, because
					// the cell's own opacity is inline and would win over a CSS rule.
					const dim = s.stripSel && !c.classes.has(s.stripSel);
					const style = [];
					// The strip is a timeline: a cell's width is its window's share of the
					// media time, so the axis below and the playhead stay honest even when
					// keyframe-bound windows run long and short.
					style.push('flex:' + Math.max(1, (c.endMs || 0) - (c.startMs || 0)) + ' 1 0px');
					if (dim) style.push('opacity:.12');
					else if (!c.low) style.push('opacity:' + Math.max(0.15, Math.min(1, c.v)).toFixed(2));
					// Synthetic first: its real rows carry detections too, and letting those
					// reach the class-hue path paints every cell --strip-other gray (the
					// color index is empty for synthetic). Flagged cells take the alert red
					// and the score opacity ramps it pale pink to deep red.
					if (!c.low && type === 'synthetic') {
						style.push('background:var(--alert-color)');
					} else if (!c.low && c.entries.length) {
						const ci = colorIdx.get(c.entries[0].name);
						style.push('background:var(' + (ci !== undefined ? '--strip-c' + ci : '--strip-other') + ')');
					}
					return h('i', {
						class: [c.low ? 'low' : null, dim ? 'dim' : null].filter(Boolean).join(' ') || null,
						style: style.join(';') || null,
						onmouseenter: () => this.showStripCard(c, cardCtx),
						onclick: () => { this.syncBrowser(c); if (seekable) this.startPlayer(c.startMs); },
					});
				}));
			const wrap = h('div', { class: 'stripwrap' + (seekable ? ' seek' : '') },
				strip, h('div', { class: 'pmark', style: 'display:none' }),
				h('div', { class: 'pcell', style: 'display:none' }), card);
			this.stripWrapEl = wrap;

			const axis = [0, 0.25, 0.5, 0.75, 1].map((f) => V.fmtMediaMs(Math.round(endMs * f)));
			const caption = (type === 'synthetic'
				? rows.length + ' windows · darker red = more synthetic · gray = not flagged'
				: rows.length + ' windows · ' + (top.length ? 'color = leading class · ' : '')
					+ 'darker is higher ' + (type === 'vlm' ? 'activity' : 'confidence') + ' · gray = empty')
				+ (rows.length > BIN_LIMIT ? ' · binned to ' + BIN_LIMIT + ' cells' : '')
				+ (seekable ? ' · click a cell to play + browse its rows' : ' · click a cell to browse its rows');

			const legend = top.length ? h('div', { class: 'legend' },
				top.map((e, i) => h('button', {
					class: 'lchip' + (s.stripSel === e.name ? ' on' : ''),
					title: (e.max ? 'max conf ' + e.max.toFixed(2) + ' · ' : '') + 'click to highlight windows with ' + e.name,
					onclick: () => { s.stripSel = s.stripSel === e.name ? null : e.name; this.render(); },
				}, h('span', { class: 'sw', style: 'background:var(--strip-c' + i + ')' }), e.name, h('span', { class: 'lc' }, '×' + e.count))),
				otherCount ? h('span', { class: 'lchip static', title: (rank.length - top.length) + ' more classes share one color' },
					h('span', { class: 'sw', style: 'background:var(--strip-other)' }), 'other', h('span', { class: 'lc' }, '×' + otherCount)) : null) : null;

			return h('div', { class: 'stripblock' },
				h('div', { style: 'display:flex;align-items:baseline;gap:10px;margin-bottom:6px;flex-wrap:wrap' },
					h('span', { class: 'eyebrow' }, 'Score strip'),
					h('span', { style: 'font-size:11px;color:var(--ink-52)' }, caption)),
				wrap,
				h('div', { class: 'axis' }, axis.map((t) => h('span', null, t))),
				legend);
		},

		/** Point the row browser at this cell's slice of the timeline: the results filter
		    selects on window start in [from_ms, to_ms), so the range is exactly the cell. */
		syncBrowser(cell) {
			const s = this.state, b = s.browser;
			s.tail = false;
			s.browserOpen = true; // the drawer must show the rows the click just selected
			b.from_ms = this.msToPaddedTc(Math.max(0, Math.floor(cell.startMs)));
			b.to_ms = cell.endMs > cell.startMs ? this.msToPaddedTc(Math.ceil(cell.endMs)) : '';
			b.offset = 0;
			s.openRows.clear();
			s.openZero.clear();
			this.fetchBrowserPage().then(() => this.render());
		},

		/** Populate and place the hovercard for this cell. Direct DOM, like the playhead:
		    hover happens far too often to re-render for, and the card is pointer-inert so
		    it can never steal the hover or the click from the cells under it. */
		showStripCard(c, ctx) {
			const card = this.cardEl, wrap = this.stripWrapEl;
			if (!card || !wrap) return;
			const flags = [];
			if (c.rows.some((r) => r.degraded)) flags.push('degraded');
			if (c.rows.some((r) => r.truncated)) flags.push('truncated');
			clear(card);
			card.appendChild(h('div', { class: 'sch' },
				V.fmtMediaMs(c.startMs) + ' – ' + V.fmtMediaMs(c.endMs) + (c.n > 1 ? ' · ' + c.n + ' windows' : '')));
			card.appendChild(h('div', { class: 'scb' }, this.stripCardBody(c, ctx),
				flags.map((f) => [' ', h('span', { class: 'tag tag-e' }, f)])));
			card.appendChild(h('div', { class: 'scf' },
				ctx.seekable ? 'Click to play from here and list the rows below.' : 'Click to list these rows below.'));
			card.style.display = 'block';
			const center = wrap.clientWidth * (c.idx + 0.5) / this.cellCount;
			card.style.left = Math.round(Math.min(Math.max(0, center - card.offsetWidth / 2),
				Math.max(0, wrap.clientWidth - card.offsetWidth))) + 'px';
		},

		/** What happened in this cell, one line, detector-aware. */
		stripCardBody(c, ctx) {
			if (ctx.type === 'synthetic') {
				if (c.n === 1) {
					const r = c.rows[0];
					const score = typeof r.synthetic_score === 'number' ? 'score ' + r.synthetic_score.toFixed(3) : null;
					return [score, r.verdict || 'real'].filter(Boolean).join(' · ');
				}
				const flagged = c.rows.filter((r) => r.verdict === 'synthetic').length;
				return 'peak ' + c.v.toFixed(3) + ' · ' + flagged + ' of ' + c.n + ' flagged';
			}
			if (c.entries.length) { // object / scene / VLM detect classes
				if (c.n === 1) {
					const shown = c.entries.slice(0, 4)
						.map((e) => e.name + ' ×' + e.count + (e.max ? ' · ' + e.max.toFixed(2) : ''));
					return shown.join(' — ') + (c.entries.length > 4 ? ' — +' + (c.entries.length - 4) + ' more' : '');
				}
				const names = c.entries.slice(0, 4).map((e) => e.name).join(', ')
					+ (c.entries.length > 4 ? ' +' + (c.entries.length - 4) + ' more' : '');
				return (ctx.type === 'vlm' ? '' : 'peak ' + c.v.toFixed(2) + ' · ') + names;
			}
			if (ctx.type === 'vlm') {
				const texts = c.rows.map((r) => this.vlmRowText(r)).filter(Boolean);
				if (texts.length) {
					const first = texts[0].split('\n')[0];
					const clipped = first.length > 140 ? first.slice(0, 140) + '…' : first;
					return (c.n > 1 ? texts.length + ' of ' + c.n + ' answered · ' : '') + clipped;
				}
				return ctx.hasClasses ? 'no detections' : 'no answer';
			}
			return 'no detections';
		},

		renderFrame(type) {
			const s = this.state;
			const seekable = isTerminal(s.job) && !!s.job.file;
			let inner;
			if (s.playerOn && this.videoEl) {
				inner = h('div', { class: 'frame vframe' }, this.videoEl);
			} else if (seekable && !s.thumbUrl) {
				// A playable job with no still to show: the pane is the player's
				// poster, so it invites play instead of apologizing about frames.
				inner = h('div', { class: 'noframe' },
					h('button', { class: 'playbtn inline', title: 'Play the source file (Engine HLS)',
						onclick: () => this.startPlayer() }, '▶'),
					h('span', { class: 'nf1' }, 'Play the source video'));
			} else if (type === 'synthetic') {
				inner = h('div', { class: 'noframe' },
					h('span', { class: 'nf1' }, 'No preview for synthetic analysis'),
					h('span', null, 'The Engine sends the video to the analysis service without decoding frames, so there is no image to show.'));
			} else if (s.thumbUrl) {
				inner = h('div', { class: 'frame' }, h('img', { src: s.thumbUrl, alt: 'job thumbnail' }));
			} else {
				inner = h('div', { class: 'noframe' },
					h('span', { class: 'nf1' }, 'No frame yet'),
					h('span', null, 'The thumbnail is the frame the detector is seeing; it appears once decoding starts.'));
			}
			if (!s.playerOn && seekable && s.thumbUrl) {
				inner = h('div', { class: 'posterwrap' }, inner,
					h('button', { class: 'playbtn', title: 'Play the source file (Engine HLS)',
						onclick: () => this.startPlayer() }, '▶'));
			}
			return h('div', null,
				h('div', { class: 'eyebrow', style: 'margin-bottom:8px' }, s.playerOn || seekable ? 'Player' : 'Frame'),
				inner,
				s.playerOn ? h('div', { style: 'display:flex;gap:10px;align-items:center;margin-top:6px' },
					h('span', { class: 'hint' }, 'Click the score strip to jump around the source.'),
					h('button', { class: 'btn btn-sm btn-ghost', style: 'margin-left:auto',
						onclick: () => { this.stopPlayer(); this.render(); } }, 'Close player')) : null,
				s.playError ? h('div', { class: 'hint', style: 'margin-top:6px;color:var(--alert-color)' }, s.playError) : null,
				!isTerminal(s.job) && type !== 'synthetic' && !s.playerOn ? h('div', { class: 'hint', style: 'margin-top:6px' }, 'Live while the job runs; a representative frame once finished.') : null);
		},

		/* ---------- follow the tail ----------
		   While a job runs, the windows list tracks its newest row, the way a log
		   viewer tails a file: on by default, paused by scrolling up (or the button),
		   re-engaged by the button or by scrolling back to the bottom. During
		   playback the same follow tracks the row under the playhead instead. */

		/** Tail mode: the job is still producing rows, so follow means the newest one. */
		tailMode() {
			return this.state.job && !isTerminal(this.state.job);
		},

		followEligible() {
			// Every detector's pane is chronological now: tail the newest row while
			// the job runs, track the playhead row while the source plays.
			return this.tailMode() || !!this.state.playerOn;
		},

		followBtn() {
			if (!this.followEligible()) return null;
			const s = this.state;
			return h('button', {
				class: 'wfollow' + (s.followTail !== false ? ' on' : ''),
				title: 'Auto-scroll to the newest window as results arrive; scrolling up pauses it',
				onclick: (e) => {
					const btn = e.currentTarget;
					const now = !btn.classList.contains('on');
					s.followTail = now;
					btn.classList.toggle('on', now);
					if (now && this.tailMode()) {
						const list = this.root.querySelector('.wlist');
						if (list) { this.progScroll = true; list.scrollTop = list.scrollHeight; }
					} else if (now) {
						this.syncPlayingRow(true);
					}
				},
			}, '⤓ Follow');
		},

		hookWindowFollow(list) {
			if (!this.followEligible() || list.dataset.followHooked) return;
			list.dataset.followHooked = '1';
			list.addEventListener('scroll', () => {
				// The render's own jumps must not count as the user scrolling.
				if (this.progScroll) { this.progScroll = false; return; }
				const s = this.state;
				if (this.tailMode()) {
					// Scrolling back to the bottom re-engages, log-viewer style.
					const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 24;
					if ((s.followTail !== false) === atBottom) return;
					s.followTail = atBottom;
				} else {
					// Playback mode has no natural re-engage point: any manual
					// scroll pauses; the button brings the playhead row back.
					if (s.followTail === false) return;
					s.followTail = false;
				}
				const btn = this.root.querySelector('.wfollow');
				if (btn) btn.classList.toggle('on', s.followTail !== false);
			});
		},

		/* One line standing in for rows[i..j) — a run of windows with nothing to
		   show. A click fans the run back out. Same shape as the drawer's rbz. */
		zeroRunLine(rows, i, j, label) {
			const s = this.state;
			const a = this.rowStartMs(rows[i]), z = this.rowEndMs(rows[j - 1]);
			return h('div', { class: 'rbz', role: 'button', tabindex: '0',
				'data-from': a != null ? String(a) : null,
				'data-to': z != null ? String(z) : null,
				title: 'Show the ' + (j - i) + ' individual windows',
				onclick: () => { s.openZeroPane.add('z' + i); this.render(); } },
				h('span', { style: 'color:var(--ink-52)' }, 'w' + String(i + 1).padStart(2, '0') + ' – w' + String(j).padStart(2, '0')),
				a !== null && z !== null ? h('span', null, V.fmtMediaMs(a) + ' – ' + V.fmtMediaMs(z)) : null,
				h('span', null, (j - i) + ' windows · ' + label),
				h('span', { class: 'rbzx' }, 'show ▸'));
		},

		renderWindows(type) {
			const s = this.state;
			const rows = s.rows || [];
			const threshold = type === 'synthetic' ? this.threshold() : null;

			if (type === 'synthetic') {
				return h('div', null,
					h('div', { style: 'display:flex;align-items:center;margin-bottom:9px' },
						h('div', { class: 'eyebrow' }, 'Windows'), this.followBtn()),
					h('div', { class: 'wlist' }, rows.map((r, i) => {
						const low = this.rowLow(r, type);
						const fromMs = this.rowStartMs(r), toMs = this.rowEndMs(r);
						return h('div', { class: 'wrow' + (low ? ' low' : ''),
							'data-from': fromMs != null ? String(fromMs) : null,
							'data-to': toMs != null ? String(toMs) : null },
							h('span', { class: 'ws' }, typeof r.synthetic_score === 'number' ? r.synthetic_score.toFixed(3) : '—'),
							h('span', { class: 'wt' }, this.windowLabel(r)),
							h('span', { class: 'wv' }, low ? (r.verdict || 'real') + (threshold !== null ? ' · below ' + threshold : '') : (r.verdict || '')),
							r.degraded ? h('span', { class: 'tag tag-e' }, 'degraded') : null,
							(r.per_clip_scores || []).length ? this.keyedDetails('clip' + i, { style: 'margin-left:auto' },
								h('summary', { style: 'font-size:11px;color:var(--ink-40);cursor:pointer' }, 'w' + String(i + 1).padStart(2, '0') + ' · per-clip ▸'),
								h('div', { class: 'mono', style: 'font-size:10.5px;padding:4px 0;width:100%' },
									r.per_clip_scores.map((c) => h('div', null,
										'frame ' + c.frame_id + ' · p=' + (typeof c.probability === 'number' ? c.probability.toFixed(3) : '—')
										+ (typeof c.logit === 'number' ? ' · logit ' + c.logit.toFixed(2) : ''))))) :
								h('span', { style: 'margin-left:auto;color:var(--ink-40);font-size:11px' }, 'w' + String(i + 1).padStart(2, '0')));
					})),
					h('div', { class: 'hint', style: 'margin-top:10px' },
						'One verdict per window. The raw responses are under Detection details below.'));
			}

			// Detect-mode VLM answers are classes per window, the same shape as object
			// and scene, so they share the chronological list below; only the prose
			// modes (describe, custom) get the block pane.
			if (type === 'vlm' && this.vlmMode() !== 'detect') {
				// Describe: the sentinel class_name "description" with the prose in
				// `reasoning` — render the prose, a badge saying DESCRIBE says nothing.
				// Custom schema: only `data` — render its fields.
				const said = (d, lead) => {
					if (d.data && typeof d.data === 'object') {
						return h('div', { class: 'mono', style: 'font-size:12px;width:100%' },
							Object.keys(d.data).map((k) => {
								const v = d.data[k];
								return h('div', null, k + ': '
									+ (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v)));
							}));
					}
					if (d.class_name === 'description' && d.reasoning)
						return h('p', { class: lead ? 'reason-lead' : 'reason', style: 'margin:0;width:100%' }, d.reasoning);
					return h('span', { class: 'tag tag-o', title: d.reasoning || '' }, d.class_name || '?');
				};
				const hasAnswer = (r) => !!(r.content || (r.detections || []).length);
				const block = (r, i, lead) => {
					const fromMs = this.rowStartMs(r), toMs = this.rowEndMs(r);
					return h('div', { class: 'wblock',
						'data-from': fromMs != null ? String(fromMs) : null,
						'data-to': toMs != null ? String(toMs) : null },
						h('div', { class: 'eyebrow', style: 'margin-bottom:4px' }, this.windowLabel(r),
							r.degraded ? [' ', h('span', { class: 'tag tag-e' }, 'degraded')] : null,
							r.truncated ? [' ', h('span', { class: 'tag tag-e' }, 'truncated')] : null),
						r.content ? h('p', { class: lead ? 'reason-lead' : 'reason', style: 'margin:0' }, r.content) : null,
						(r.detections || []).length ? h('div', { style: 'margin-top:6px;display:flex;gap:6px;flex-wrap:wrap' },
							r.detections.map((d) => said(d, lead))) : null);
				};
				// A window the model had nothing to say about stays on the timeline as a
				// slim row; long stretches of them collapse to one line, like the drawer.
				const emptyRow = (r, i) => {
					const fromMs = this.rowStartMs(r), toMs = this.rowEndMs(r);
					return h('div', { class: 'wrow low',
						'data-from': fromMs != null ? String(fromMs) : null,
						'data-to': toMs != null ? String(toMs) : null },
						h('span', { class: 'wt' }, this.windowLabel(r)),
						h('span', { class: 'wv' }, 'no answer'),
						r.degraded ? h('span', { class: 'tag tag-e' }, 'degraded') : null,
						h('span', { style: 'margin-left:auto;color:var(--ink-40);font-size:11px' }, 'w' + String(i + 1).padStart(2, '0')));
				};
				const out = [];
				let lead = true, i = 0;
				while (i < rows.length) {
					let j = i;
					while (j < rows.length && !hasAnswer(rows[j])) j++;
					if (j - i >= 3 && !s.openZeroPane.has('z' + i)) {
						out.push(this.zeroRunLine(rows, i, j, 'no answer'));
						i = j;
					} else if (j > i) {
						for (let k = i; k < j; k++) out.push(emptyRow(rows[k], k));
						i = j;
					} else {
						out.push(block(rows[i], i, lead));
						lead = false;
						i++;
					}
				}
				return h('div', null,
					h('div', { style: 'display:flex;align-items:center;margin-bottom:9px' },
						h('div', { class: 'eyebrow' }, 'What the model saw'), this.followBtn()),
					!rows.length ? h('div', { class: 'hint' }, 'No windows analyzed yet.') :
						h('div', { class: 'wlist', style: 'border:none;display:flex;flex-direction:column;gap:16px;max-height:460px' }, out));
			}

			// object / scene / vlm-detect: the same chronological pane as synthetic,
			// one row per analyzed window with its detections summarized by class.
			// Per-class totals live in the strip legend, which this pane used to
			// duplicate. VLM detections carry a reasoning the chip's tooltip keeps.
			const vlmChips = type === 'vlm';
			const rowNode = (r, i) => {
				const dets = r.detections || [];
				const byClass = new Map();
				for (const d of dets) {
					const k = d.class_name || '?';
					const e = byClass.get(k) || { n: 0, why: [] };
					e.n++;
					if (d.reasoning) e.why.push(d.reasoning);
					byClass.set(k, e);
				}
				const entries = Array.from(byClass.entries());
				const fromMs = this.rowStartMs(r), toMs = this.rowEndMs(r);
				return h('div', { class: 'wrow' + (dets.length ? '' : ' low'),
					'data-from': fromMs != null ? String(fromMs) : null,
					'data-to': toMs != null ? String(toMs) : null },
					h('span', { class: 'ws' }, String(dets.length)),
					h('span', { class: 'wt' }, this.windowLabel(r)),
					vlmChips && entries.length
						? h('span', { class: 'wv', style: 'display:flex;gap:6px;flex-wrap:wrap;align-items:center' },
							entries.map(([k, e]) => h('span', { class: 'tag tag-o', title: e.why.join('\n') || null },
								k + (e.n > 1 ? ' ×' + e.n : ''))))
						: h('span', { class: 'wv' },
							entries.map(([k, e]) => k + (e.n > 1 ? ' ×' + e.n : '')).join(' · ')
							|| (vlmChips ? 'no answer' : 'no detections')),
					r.degraded ? h('span', { class: 'tag tag-e' }, 'degraded') : null,
					h('span', { style: 'margin-left:auto;color:var(--ink-40);font-size:11px' }, 'w' + String(i + 1).padStart(2, '0')));
			};
			// Long stretches of empty windows collapse to one line, like the drawer.
			const listOut = [];
			let li = 0;
			while (li < rows.length) {
				let j = li;
				while (j < rows.length && !(rows[j].detections || []).length) j++;
				if (j - li >= 3 && !s.openZeroPane.has('z' + li)) {
					listOut.push(this.zeroRunLine(rows, li, j, vlmChips ? 'no answer' : 'no detections'));
					li = j;
				} else if (j > li) {
					for (let k = li; k < j; k++) listOut.push(rowNode(rows[k], k));
					li = j;
				} else {
					listOut.push(rowNode(rows[li], li));
					li++;
				}
			}
			return h('div', null,
				h('div', { style: 'display:flex;align-items:center;margin-bottom:9px' },
					h('div', { class: 'eyebrow' }, 'Windows'), this.followBtn()),
				h('div', { class: 'wlist' }, listOut),
				h('div', { class: 'hint', style: 'margin-top:10px' },
					'One row per analyzed window. Class totals are in the legend above; the raw responses are under Detection details below.'));
		},

		/* The raw rows live in a drawer, closed by default — the sections above tell the
		   story; this is the evidence. A strip-cell click opens it (syncBrowser), pointed
		   at that cell's window. */
		renderBrowser() {
			const s = this.state, b = s.browser;
			const type = this.detectorType();
			const page = b.page;
			const total = page ? page.total : 0;
			const from = page && page.count ? page.offset + 1 : 0;
			const to = page ? page.offset + (page.count || 0) : 0;
			const refetch = () => { s.openRows.clear(); s.openZero.clear(); this.fetchBrowserPage().then(() => this.render()); };
			// Valid means Apply can act: both boxes parse and the range runs forward.
			const rangeInvalid = () => {
				const f = this.parseTcMs(b.from_ms), t = this.parseTcMs(b.to_ms);
				return f === null || t === null || (f !== '' && t !== '' && +f > +t);
			};
			const num = (label, key) => h('div', { class: 'field' }, h('label', null, label),
				h('input', { class: 'input', value: b[key], placeholder: '00:00:00',
					title: 'hh:mm:ss.mmm, m:ss, or milliseconds',
					oninput: (e) => {
						// Only what a timecode can contain survives typing: digits, at
						// most two ':' before at most one '.', nothing else. Whatever
						// still parses wrong (or runs backward) flags amber live and
						// disables Apply, so the parse banner is unreachable by typing.
						let colons = 0, dot = false, clean = '';
						for (const ch of e.target.value.replace(/[^\d:.]/g, '')) {
							if (ch === ':') { if (colons >= 2 || dot) continue; colons++; }
							else if (ch === '.') { if (dot) continue; dot = true; }
							clean += ch;
						}
						if (clean !== e.target.value) e.target.value = clean;
						b[key] = clean.trim();
						const mine = this.parseTcMs(b[key]);
						const other = this.parseTcMs(b[key === 'from_ms' ? 'to_ms' : 'from_ms']);
						const inverted = mine !== null && other !== null && mine !== '' && other !== ''
							&& (key === 'from_ms' ? +mine > +other : +mine < +other);
						e.target.style.borderColor = mine === null || inverted ? 'var(--alert-color)' : '';
						const apply = this.root.querySelector('.rb-apply');
						if (apply) apply.disabled = rangeInvalid();
					} }));

			const brief = (r) => {
				if (type === 'synthetic') return (r.verdict || '') + (typeof r.synthetic_score === 'number' ? ' · ' + r.synthetic_score.toFixed(3) : '');
				if (type === 'vlm') {
					// A describe/custom row is its text, not a count of one.
					const d = (r.detections || [])[0];
					const text = d && d.class_name === 'description' && d.reasoning ? d.reasoning
						: d && d.data && typeof d.data === 'object' ? JSON.stringify(d.data) : null;
					if (text) return text.length > 90 ? text.slice(0, 90) + '…' : text;
				}
				const n = (r.detections || []).length;
				return n + ' detection' + (n === 1 ? '' : 's');
			};

			// One chip per class, aggregated within the row: name ×count and its top
			// confidence, colored like the strip. Rows without class entries (synthetic,
			// VLM prose, empties) keep the plain text brief.
			const chips = (r) => {
				const entries = this.classEntries([r]);
				if (!entries.length) return h('span', null, brief(r));
				const cmap = this.browserColors;
				const shown = entries.slice(0, 4);
				return h('span', { class: 'rchips' },
					shown.map((e) => {
						const ci = cmap ? cmap.get(e.name) : undefined;
						return h('span', { class: 'rchip' },
							h('span', { class: 'sw', style: 'background:var(' + (ci !== undefined ? '--strip-c' + ci : '--strip-other') + ')' }),
							e.name,
							e.count > 1 ? h('span', { class: 'ct' }, '×' + e.count) : null,
							e.max ? h('span', { class: 'cf' }, e.max.toFixed(2)) : null);
					}),
					entries.length > 4 ? h('span', { class: 'rchip more' }, '+' + (entries.length - 4) + ' more') : null);
			};

			const rowNode = (r, i) => this.keyedDetails('row' + (page.offset + i), { class: 'rbrow' },
				h('summary', null,
					h('span', { style: 'color:var(--ink-52)' }, 'row ' + (page.offset + i + 1)),
					h('span', null, this.windowLabel(r)),
					chips(r),
					h('span', { class: 'rawlink', style: 'margin-left:auto;color:var(--accent-700)' }, 'raw JSON ▸')),
				h('pre', null, JSON.stringify(r, null, 2)));

			// Long stretches of nothing collapse to one line; a click fans the run back
			// out into its individual rows.
			const isEmpty = (r) => {
				if (type === 'synthetic') return false;
				if (type === 'vlm') return !this.vlmRowText(r) && !(r.detections || []).length;
				return !(r.detections || []).length;
			};
			const rowsOut = [];
			if (page && page.results) {
				const rs = page.results;
				let i = 0;
				while (i < rs.length) {
					let j = i;
					while (j < rs.length && isEmpty(rs[j])) j++;
					const runKey = 'z' + (page.offset + i);
					if (j - i >= 3 && !s.openZero.has(runKey)) {
						const a = this.rowStartMs(rs[i]), z = this.rowEndMs(rs[j - 1]);
						rowsOut.push(h('div', { class: 'rbz', role: 'button', tabindex: '0',
							title: 'Show the ' + (j - i) + ' individual rows',
							onclick: () => { s.openZero.add(runKey); this.render(); } },
							h('span', { style: 'color:var(--ink-52)' }, 'rows ' + (page.offset + i + 1) + '–' + (page.offset + j)),
							a !== null && z !== null ? h('span', null, V.fmtMediaMs(a) + ' – ' + V.fmtMediaMs(z)) : null,
							h('span', null, (j - i) + ' windows · ' + (type === 'vlm' ? 'no answer' : 'no detections')),
							h('span', { class: 'rbzx' }, 'show ▸')));
						i = j;
					} else if (j > i) {
						// a short empty run, or one the user fanned out — whole run, row by row
						for (let k = i; k < j; k++) rowsOut.push(rowNode(rs[k], k));
						i = j;
					} else {
						rowsOut.push(rowNode(rs[i], i));
						i++;
					}
				}
			}

			return h('div', { class: 'rowbrowser' + (s.browserOpen ? ' open' : '') },
				h('button', { class: 'rbhead', 'aria-expanded': s.browserOpen ? 'true' : 'false',
					// Collapsing asks the page to shrink — the scroll pad would keep the
					// drawer frozen at its expanded height, an empty bordered void.
					onclick: () => { s.browserOpen = !s.browserOpen; this.letPageShrink = !s.browserOpen; this.render(); } },
					h('span', { class: 'chev' }, s.browserOpen ? '▾' : '▸'),
					'Detection details',
					total ? h('span', { class: 'rbcount' }, String(total)) : null,
					h('span', { class: 'rbhint' }, s.browserOpen
						? 'every stored analysis response'
						: 'the raw rows behind the numbers above, or click a strip cell')),
				!s.browserOpen ? null : [
					h('div', { class: 'rbtools' },
						num('from', 'from_ms'), num('to', 'to_ms'),
						h('button', { class: 'btn btn-sm rb-apply', style: 'align-self:flex-end',
							disabled: rangeInvalid() ? 'disabled' : null,
							onclick: () => { b.offset = 0; refetch(); } }, 'Apply'),
						h('button', { class: 'btn btn-sm btn-ghost', style: 'align-self:flex-end', title: 'Reset the range to the whole clip and show every stored row',
							onclick: () => {
								b.from_ms = '00:00:00';
								b.to_ms = s.job && s.job.sourceDurationMs ? this.msToPaddedTc(s.job.sourceDurationMs) : '';
								b.offset = 0; refetch();
							} }, 'Clear'),
						s.job && !isTerminal(s.job) ? h('label', { class: 'hint', style: 'align-self:flex-end;display:flex;gap:6px;align-items:center' },
							h('input', { type: 'checkbox', checked: s.tail ? 'checked' : null, onchange: (e) => {
								s.tail = e.target.checked;
								if (s.tail && b.page && b.page.total) {
									b.offset = Math.max(0, Math.floor((b.page.total - 1) / b.limit) * b.limit);
									this.fetchBrowserPage().then(() => this.render());
								}
							} }),
							'live tail · follow the newest rows') : null,
						h('div', { style: 'margin-left:auto;display:flex;gap:8px;align-items:flex-end' },
							h('span', { class: 'mono', style: 'font-size:11.5px;color:var(--ink-60)' },
								total ? 'rows ' + from + '–' + to + ' of ' + total : 'no rows'),
							h('button', { class: 'btn btn-sm btn-ghost', disabled: b.offset <= 0, onclick: () => { s.tail = false; b.offset = Math.max(0, b.offset - b.limit); refetch(); } }, '‹'),
							h('button', { class: 'btn btn-sm btn-ghost', disabled: !page || to >= total, onclick: () => { s.tail = false; b.offset = b.offset + b.limit; refetch(); } }, '›'))),
					b.error ? h('div', { class: 'errbanner', style: 'margin:12px' }, b.error) : null,
					rowsOut,
				]);
		},
	};

	function isTerminal(job) {
		return job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled';
	}

	V.views = V.views || {};
	V.views.job = view;
})(window.VIF.vod);
