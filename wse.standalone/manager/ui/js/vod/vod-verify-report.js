/* Verify report — one verify job: the verdict banner, the per-window outcome strip
   (which fills up as the job runs), then side by side the player + score timeline
   and the review's reasoning and attribute rubric for the selected window (the one
   that decided the verdict until a click or the playhead picks another), with the
   two-stage pipeline band under them. Data comes from the job document (its verify
   summary) and
   GET /vod/jobs/{jobId}/verify-report; the raw drawer pages the stored rows.

   Same discipline as the generic report page: the 2s poll and every async
   continuation are guarded by the mount generation (V.gen), renders happen only when
   the job progressed, and the <video>/hls.js instances live on the view so a repaint
   never restarts playback. */
window.VIF = window.VIF || {};
VIF.vod = VIF.vod || {};
(function (V) {
	'use strict';
	const { h, clear, api, toast, DETECTOR_META } = V;

	const SVGNS = 'http://www.w3.org/2000/svg';
	function sv(tag, attrs) {
		const el = document.createElementNS(SVGNS, tag);
		for (const k in (attrs || {})) {
			if (attrs[k] === null || attrs[k] === undefined) continue;
			if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), attrs[k]);
			else el.setAttribute(k, attrs[k]);
		}
		for (let i = 2; i < arguments.length; i++) {
			const kid = arguments[i];
			if (kid === null || kid === undefined) continue;
			el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
		}
		return el;
	}

	/* The six attributes Verify's review assesses, in presentation order; a key the
	   model adds beyond them still renders, prettified from its name. */
	const ATTRIBUTES = [
		['physical_accuracy', 'Physical accuracy'],
		['temporal_consistency', 'Temporal consistency'],
		['lighting_shadow', 'Lighting & shadow'],
		['texture_micro_detail', 'Texture & micro-detail'],
		['edge_boundary_artifacts', 'Edge & boundary artifacts'],
		['motion_plausibility', 'Motion plausibility'],
	];

	function prettyKey(key) {
		const s = String(key).replace(/_/g, ' ');
		return s.charAt(0).toUpperCase() + s.slice(1);
	}

	function isTerminal(job) {
		return job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled';
	}

	/* A window after both stages, as the strip colors it. */
	const OUTCOME_CLASS = { synthetic: 'vw-syn', cleared: 'vw-clr', undecided: 'vw-und', real: 'vw-real', unscored: 'vw-unk' };

	function usableReview(w) {
		return !!(w.review && w.review.windowsReviewed > 0);
	}

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
				id: params && params.id, job: null, report: null, reportMissing: null, error: null,
				thumbUrl: null, playerOn: false, playError: null, selWindow: null,
				raw: { open: false, offset: 0, limit: 50, page: null, error: null, seq: 0 },
				openRows: new Set(), settlePolls: 0,
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
				if (s.error) { s.error = null; changed = true; }
				if (job.storeResults !== false && changed) {
					try {
						s.report = await api.verifyReport(s.id);
						s.reportMissing = null;
					} catch (e) {
						// 404 while nothing is stored yet (or a non-verify job): the page
						// stands on the job document's own summary.
						if (e.status === 404) { s.report = null; s.reportMissing = e.message; }
						else toast(e.message, 'err');
					}
					if (gen !== V.gen) return;
					if (s.raw.open) await this.fetchRawPage();
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

		async fetchThumb(gen) {
			const s = this.state;
			const url = await api.thumbnail(s.id).catch(() => null);
			if (gen !== V.gen) { if (url) URL.revokeObjectURL(url); return; }
			if (s.thumbUrl) URL.revokeObjectURL(s.thumbUrl);
			s.thumbUrl = url;
		},

		async fetchRawPage() {
			const s = this.state, b = s.raw;
			const gen = this.gen;
			const seq = ++b.seq;
			try {
				const page = await api.results(s.id, { offset: b.offset, limit: b.limit });
				if (gen !== V.gen || seq !== b.seq) return;
				b.page = page;
				b.error = null;
			} catch (e) {
				if (gen !== V.gen || seq !== b.seq) return;
				b.page = null;
				b.error = e.message;
			}
		},

		/** The summary this page stands on: the rows-derived one when the report is
		    readable, else the job document's own — one source per render, never a mix. */
		summary() {
			const s = this.state;
			if (s.report && s.report.summary) return s.report.summary;
			return (s.job && s.job.verify) || null;
		},

		windows() {
			return (this.state.report && this.state.report.windows) || [];
		},

		flagThreshold() {
			const sum = this.summary();
			if (sum && typeof sum.flagThreshold === 'number') return sum.flagThreshold;
			const det = ((this.state.job || {}).effectiveConfig || (this.state.job || {}).config || {}).detector || {};
			return typeof det.flagThreshold === 'number' ? det.flagThreshold : null;
		},

		/* The score above which a flagged window is final; null when the job predates the
		   setting or it is 1, where the line would sit on the chart's edge and mean nothing. */
		strongThreshold() {
			const sum = this.summary();
			const det = ((this.state.job || {}).effectiveConfig || (this.state.job || {}).config || {}).detector || {};
			const v = sum && typeof sum.strongThreshold === 'number' ? sum.strongThreshold
				: typeof det.strongThreshold === 'number' ? det.strongThreshold : null;
			return v !== null && v < 1 ? v : null;
		},

		reviewModel() {
			const s = this.state;
			const review = s.report && s.report.review;
			if (review && review.model) return review.model;
			const det = ((s.job || {}).effectiveConfig || (s.job || {}).config || {}).detector || {};
			return (det.review && det.review.model) || null;
		},

		/* ---------- player ----------
		   Same machinery as the generic report page: the source file over the Engine's
		   stock `vod` HLS application; <video> and hls.js live on the view so a repaint
		   re-appends the same node. */

		playbackUrl() {
			const s = this.state;
			if (!s.job || !s.job.file) return null;
			const props = (typeof pluginProperties !== 'undefined' && pluginProperties) || {};
			const conn = (window.VIF && VIF.core && VIF.core.resolveServer) ? VIF.core.resolveServer() : null;
			if (!conn) return null;
			let engineHost;
			try { engineHost = new URL(conn.serverUrl).hostname; } catch (e) { return null; }
			const host = props.playback_host || engineHost;
			const port = props.playback_port ? ':' + props.playback_port : ':1935';
			// _definst_ is mandatory; per-segment encoding so '#' or '?' in a legal
			// file name never truncates the path.
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
			// 404 (possibly as a CORS throw) — keep the thumbnail and say why.
			let ok = false;
			try { ok = (await fetch(url, { cache: 'no-store' })).ok; } catch (e) { /* no app or unreachable */ }
			if (gen !== V.gen) return;
			if (s.playerOn) { if (seekMs !== undefined) this.seekTo(seekMs); return; }
			if (!ok) {
				s.playError = await this.playRefusal(url);
				if (gen !== V.gen) return;
				this.render();
				return;
			}
			this.pendingSeekMs = seekMs === undefined ? null : seekMs;
			this.mountPlayer(url);
		},

		/* Two very different failures share the probe: the vod application is
		   missing, or the source file itself is gone. The files listing says which,
		   so the error can name the actual problem. */
		async playRefusal(url) {
			const s = this.state;
			let fileGone = false;
			try {
				const listing = await api.listFiles();
				fileGone = !listing.truncated
					&& !(listing.files || []).some((f) => f.file === (s.job && s.job.file));
			} catch (e) { /* listing unavailable: keep the generic message */ }
			return fileGone
				? 'The source file ' + s.job.file + ' is no longer in the content directory, so there is '
					+ 'nothing to play. The stored results and this report remain readable.'
				: 'No HLS playlist at ' + url + '. Playback needs the Engine’s standard "vod" '
					+ 'application (stock installs ship it; the compose stack may need it created once, see the VOD guide).';
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
			video.addEventListener('seeked', () => { this.seekInFlight = false; this.movePlayhead(); });
			video.loop = V.playerLoopOn();
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
			this.seekInFlight = false;
			if (this.state) this.state.playerOn = false;
		},

		seekTo(ms) {
			if (!this.videoEl) return;
			if (this.videoEl.readyState >= 1) {
				this.videoEl.currentTime = ms / 1000;
				// Every caller is a "show me this moment" gesture, so a player that had
				// ended (or was paused) plays again instead of seeking silently.
				this.videoEl.play().catch(() => { /* autoplay blocked — the controls are right there */ });
			} else {
				this.pendingSeekMs = ms;
			}
		},

		/* Direct DOM: the markers ride timeupdate, far too often to re-render for. The
		   window under the playhead becomes the selected one, so Stage 2 follows playback. */
		movePlayhead() {
			const line = this.playheadEl;
			const v = this.videoEl;
			const endMs = this.timelineEndMs || 0;
			const live = v && endMs && this.state.playerOn;
			if (line) {
				if (!live) line.setAttribute('display', 'none');
				else {
					const x = Math.min(1000, 1000 * (v.currentTime * 1000) / endMs);
					line.removeAttribute('display');
					line.setAttribute('x1', x.toFixed(1));
					line.setAttribute('x2', x.toFixed(1));
				}
			}
			const mark = this.stripMarkEl, cellBox = this.stripCellBoxEl;
			const t = live ? v.currentTime * 1000 : -1;
			const under = live ? this.windows().find((w) => w.fromMs <= t && t < w.toMs) : null;
			if (mark) {
				if (!live) mark.style.display = 'none';
				else { mark.style.display = 'block'; mark.style.left = Math.min(100, 100 * t / endMs).toFixed(2) + '%'; }
			}
			if (cellBox) {
				const cellEl = under && this.cellEls ? this.cellEls.get(under.index) : null;
				if (!cellEl) cellBox.style.display = 'none';
				else {
					cellBox.style.display = 'block';
					cellBox.style.left = cellEl.offsetLeft + 'px';
					cellBox.style.width = cellEl.offsetWidth + 'px';
				}
			}
			// A click's seek lands a moment later; until it does the old position must
			// not steal the selection back.
			if (under && !this.seekInFlight && under.index !== this.state.selWindow) this.selectWindow(under, { fromPlayhead: true });
		},

		selectWindow(w, opts) {
			const s = this.state;
			const seekable = isTerminal(s.job) && !!s.job.file;
			const seek = seekable && !(opts && opts.fromPlayhead);
			if (s.selWindow !== w.index) {
				s.selWindow = w.index;
				this.applySelection();
			}
			if (seek) {
				this.seekInFlight = true;
				// Belt and braces: a browser that never fires seeked must not freeze the follow.
				clearTimeout(this.seekTimer);
				this.seekTimer = setTimeout(() => { this.seekInFlight = false; }, 1500);
				this.startPlayer(w.fromMs);
			}
		},

		/* Selection changes are direct DOM too: the timeline point, the strip cell, the
		   line under the chart and the Stage 2 panel — a full render would restart nothing
		   but would scroll and flicker on every window the playhead crosses. */
		applySelection() {
			const s = this.state;
			if (this.pointEls) for (const [idx, c] of this.pointEls) c.setAttribute('r', idx === s.selWindow ? '5' : '3.5');
			if (this.cellEls) for (const [idx, el] of this.cellEls) el.classList.toggle('sel', idx === s.selWindow);
			if (this.selLineEl) {
				const sel = s.selWindow !== null ? this.windows().find((w) => w.index === s.selWindow) : null;
				clear(this.selLineEl);
				this.selLineEl.style.display = sel ? '' : 'none';
				if (sel) this.selLineEl.appendChild(document.createTextNode(this.selectionLine(sel)));
			}
			if (this.reviewEl && s.job) {
				const shown = this.reviewEl;
				shown.replaceWith(this.renderReview(s.job)); // renderReview re-points reviewEl at the new section
			}
		},

		selectionLine(sel) {
			return this.windowName(sel) + ' · ' + this.windowLabel(sel)
				+ ' · score ' + this.fmtScore(sel.score) + ' · ' + this.outcomeLine(sel);
		},

		/** What became of the window across both stages, in the legend's words. */
		outcomeLine(w) {
			switch (w.outcome) {
				case 'synthetic': return w.strong ? 'flagged · above the strong threshold, final' : 'flagged · the model confirmed synthetic';
				case 'cleared': return 'flagged · model review: no signs of generation';
				case 'undecided': return w.reviewed ? 'flagged · the model gave no verdict' : 'flagged · not reviewed';
				case 'unscored': return 'no score from the detector';
				default: return 'below the flag threshold, not reviewed';
			}
		},

		windowName(w) {
			return 'w' + String(w.index + 1).padStart(2, '0');
		},

		/* ---------- formatting ---------- */

		fmtScore(x) {
			return typeof x === 'number' ? x.toFixed(3) : '—';
		},

		windowLabel(w) {
			return V.fmtMediaMs(w.fromMs) + ' – ' + V.fmtMediaMs(w.toMs);
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
			const wasPlaying = this.videoEl && !this.videoEl.paused && !this.videoEl.ended;
			const restoreScroll = V.snapshotScroll(this.root);
			// Everything renders inside .vpage: it caps the content width so the banner,
			// strip, grid, band and drawer share one right edge on wide monitors.
			const root = h('div', { class: 'vpage' });
			clear(this.root).appendChild(root);
			// The selection-driven pieces are rebuilt below, or not at all on this render.
			this.reviewEl = null; this.pointEls = null; this.cellEls = null; this.selLineEl = null;
			this.stripMarkEl = null; this.stripCellBoxEl = null;
			const crumb = () => h('a', { class: 'crumb', href: '#', onclick: (e) => { e.preventDefault(); V.nav('jobs'); } }, '← On-Demand Jobs');
			if (s.error && !s.job) {
				root.appendChild(h('div', { class: 'phead' },
					h('div', null, crumb(), h('h2', null, 'Verify report'))));
				root.appendChild(h('div', { class: 'errbanner', style: 'margin-top:14px' }, s.error));
				restoreScroll();
				return;
			}
			if (!s.job) { root.appendChild(h('div', { class: 'empty' }, 'Loading…')); restoreScroll(); return; }

			const job = s.job;
			const refresh = () => { s.settlePolls = 6; this.reload(false); };

			const headBtns = [];
			if (job.storeResults !== false) headBtns.push(h('button', { class: 'btn', onclick: () => V.jobActions.jsonl(job) }, 'Download JSONL'));
			if (!isTerminal(job)) headBtns.push(h('button', { class: 'btn btn-danger', onclick: () => V.jobActions.cancel(job, refresh) }, 'Cancel'));
			if (V.jobHelpers.canResume(job)) headBtns.push(h('button', { class: 'btn', onclick: () => V.jobActions.resume(job, refresh) }, 'Resume'));
			if (isTerminal(job)) headBtns.push(h('button', { class: 'btn btn-danger', onclick: () => V.jobActions.del(job, () => { V.nav('jobs'); }) }, 'Delete'));

			root.appendChild(h('div', { class: 'phead' },
				h('div', null, crumb(), this.renderJobMeta(job)),
				h('div', { class: 'sp' }, headBtns)));

			if (s.error) root.appendChild(h('div', { class: 'errbanner' }, s.error));

			if (job.listenerWarning) {
				root.appendChild(h('div', { class: 'rnotice' },
					h('span', { title: job.listenerWarning, style: 'display:inline-flex;align-items:center;gap:8px' },
						h('span', { class: 'ndot' }),
						'Some event listeners don’t apply to file jobs and were skipped')));
			}

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

			root.appendChild(this.renderBanner(job));
			if (job.storeResults !== false) root.appendChild(this.renderWindowStrip(job));

			if (job.storeResults === false) {
				root.appendChild(h('div', { class: 'empty' },
					'This job was submitted with store_results: false, so it is verdict only: no stored rows, no timeline, no resume point.'));
				root.appendChild(h('div', { class: 'vgrid' },
					h('div', null, this.renderFrame(job))));
				root.appendChild(this.renderRail(job));
			} else {
				root.appendChild(h('div', { class: 'vgrid' },
					h('div', null,
						this.renderFrame(job),
						this.renderTimeline(job)),
					this.renderReview(job)));
				root.appendChild(this.renderRail(job));
				root.appendChild(this.renderRaw());
			}

			if (wasPlaying && this.videoEl && this.videoEl.paused) this.videoEl.play().catch(() => { /* fine */ });
			restoreScroll(this.letPageShrink ? null : root.lastElementChild);
			this.letPageShrink = false;
			this.movePlayhead();
		},

		/** The header facts, in the generic report's labeled-grid shape. */
		renderJobMeta(job) {
			const s = this.state;
			const group = (V.store.groups || []).find(
				(x) => String(x.name).toLowerCase() === String(job.streamGroupConfig || '').toLowerCase());
			const m = (group && group.match) || {};
			const rule = m.application && m.streamPattern
				? m.application + ' / ' + m.streamPattern : (job.streamGroupConfig || 'inline');
			const shortId = s.id.length > 14 ? s.id.slice(0, 8) + '…' + s.id.slice(-5) : s.id;
			const copyId = (e) => {
				e.preventDefault();
				const id = 'vod-' + s.id;
				if (navigator.clipboard && navigator.clipboard.writeText) {
					navigator.clipboard.writeText(id).then(() => toast('Job id copied')).catch(() => toast(id));
				} else toast(id);
			};
			const cells = [];
			const put = (label, value) => cells.push(
				h('span', { class: 'jlabel' }, label + ':'), h('span', { class: 'jvcell' }, value));
			put('Source', h('span', { class: 'jval' }, job.file || s.id));
			put('Status', h('span', { class: 'st st-' + job.state }, V.stateLabel(job.state)));
			put('Job ID', h('a', { href: '#', class: 'jid mono', title: 'vod-' + s.id + '\nClick to copy', onclick: copyId },
				'vod-' + shortId + ' ⧉'));
			put('Config', h('a', { href: '#', class: 'cfglink mono', title: 'Show the analysis options this job ran with',
				onclick: (e) => { e.preventDefault(); V.showJobOptions(job); } }, rule));
			if (job.tag) put('Tag', h('span', { class: 'tag tag-n verbatim' }, job.tag));
			const model = this.reviewModel();
			const modelShort = model ? String(model).split('/').pop() : null;
			// The detection type is the page's headline fact: its own line above
			// the labeled grid, a step larger (.dtline).
			const dtLine = h('div', { class: 'dtline' },
				h('span', { class: 'dtlabel' }, 'Detection type:'),
				h('img', { class: 'dticon', src: 'wse-plugins/server/vif/verify.png', alt: '' }),
				h('span', { style: 'white-space:nowrap' }, DETECTOR_META.verify.name),
				modelShort ? h('span', { class: 'jmodel', title: modelShort === model ? null : model },
					'· SVD + ' + modelShort) : h('span', { class: 'jmodel' }, '· SVD + VLM'));
			return h('div', null, dtLine, h('div', { class: 'jgrid' }, cells));
		},

		/** The NVIDIA attribution the banner carries as its bottom line. */
		nvLine(job) {
			return h('div', { class: 'nvline' },
				h('img', { class: 'nvlogo', src: 'wse-plugins/server/vif/nvidia-logo-horz.svg', alt: 'NVIDIA' }),
				h('span', { style: 'font-weight:600' }, 'Powered by NVIDIA AI'),
				h('span', { class: 'hint' }, 'SVD synthetic-video detection'
					+ (this.reviewModel() ? ' · ' + String(this.reviewModel()).split('/').pop() : '')),
				job.storeResults === false ? null : h('span', { class: 'hint nvprog mono' }, this.windowsProgress(job)));
		},

		/* The verdict and the numbers behind it, in the SVD page's card lineup:
		   Duration (Progress while running), Evaluation (the SVD verdict card's
		   presentation over the two-stage outcome - a plain headline sentence,
		   the share of the video and the duration balance under it, the red
		   share bar), Model Analysis, Requests. */
		renderBanner(job) {
			const sum = this.summary();
			const running = !isTerminal(job);
			const cell = (label, value, sub, tip, barPct, barCls) => h('div', { class: 'rcell' },
				h('div', { class: 'rcl' }, label,
					tip ? h('span', { class: 'vif-help-tip', title: tip }, '?') : null),
				h('div', { class: 'rcv' }, value),
				sub ? h('div', { class: 'rcs' }, sub) : null,
				barPct !== undefined ? h('div', { class: 'rpbar' + (barCls ? ' ' + barCls : ''), role: 'progressbar', 'aria-valuemin': '0',
					'aria-valuemax': '100', 'aria-valuenow': String(Math.round(barPct)) },
					h('i', { style: 'width:' + barPct.toFixed(1) + '%' })) : null);
			const cells = [];

			// Duration / Progress: the SVD page's first cell, same logic.
			if (job.state === 'completed') {
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

			if (!sum || (running && !sum.windowsTotal)) {
				cells.push(cell('Evaluation', running ? 'Analyzing…' : '—'));
				return h('div', null, h('div', { class: 'rband' }, cells), this.nvLine(job));
			}

			// Evaluation. Durations by outcome carry the balance and the share, the
			// strip's own currency; with no readable report the summary's share fills in.
			const windows = this.windows();
			const durOf = (wanted) => windows.reduce((a, w) =>
				a + (wanted.indexOf(w.outcome) >= 0 ? Math.max(0, w.toMs - w.fromMs) : 0), 0);
			// The model's opinion never clears a flagged window (VI-961): time it
			// reviewed without confirming stays its own bucket, never counted real.
			const synMs = durOf(['synthetic']);
			const realMs = durOf(['real']);
			const reviewedMs = durOf(['cleared']);
			const knownMs = synMs + realMs + reviewedMs;
			// The share says "of the video", so it divides by the video: unscored and
			// undecided time is part of the video even though no bucket owns it.
			const videoMs = job.sourceDurationMs || job.mediaTimeMs || knownMs;
			const synPct = knownMs ? Math.round(100 * synMs / videoMs)
				: typeof sum.syntheticShare === 'number' ? Math.round(100 * sum.syntheticShare) : null;
			const synPctLabel = sum.windowsSynthetic && synPct === 0 ? '<1%' : synPct + '%';
			// An all-unscored job carries windowsFlagged 0 with verdict uncertain: nothing was
			// verified, so "no synthetic content" would be false assurance.
			const headline = sum.verdict === 'uncertain' ? 'Analysis inconclusive'
				: !sum.windowsFlagged ? 'No synthetic content detected'
				: sum.verdict === 'synthetic' || sum.verdict === 'mixed' ? 'Synthetic content detected'
				: sum.verdict === 'authentic' ? 'No synthetic content confirmed'
				: 'Analysis inconclusive';
			const share = sum.windowsSynthetic && synPct !== null ? 'in ' + synPctLabel + ' of the video' : null;
			const balance = knownMs ? (synMs >= realMs
				? 'synthetic ' + V.fmtMediaMs(synMs) + ' · real ' + V.fmtMediaMs(realMs)
				: 'real ' + V.fmtMediaMs(realMs) + ' · synthetic ' + V.fmtMediaMs(synMs))
				+ (reviewedMs ? ' · model-reviewed ' + V.fmtMediaMs(reviewedMs) : '') : null;
			// How the two stages relate, in one clause under the balance.
			const concur = sum.verdict === 'synthetic' && sum.reviewVerdict === 'synthetic' ? 'both stages concur'
				: sum.verdict === 'authentic' && !sum.windowsFlagged ? 'no window crossed the flag threshold'
				: sum.verdict === 'authentic' ? 'flagged windows were model-reviewed; none confirmed synthetic'
				: sum.verdict === 'uncertain' && !sum.windowsFlagged ? 'the detector scored no window'
				: sum.verdict === 'uncertain' ? 'flagged, but the review was inconclusive' : null;
			const thrLabel = typeof sum.flagThreshold === 'number' ? Math.round(100 * sum.flagThreshold) + '%' : null;
			// Unlike the SVD page, no video-level average is judged here: the flag
			// threshold routes each window to the model, and the headline reports
			// the per-window outcomes. The tooltip must not claim otherwise - and
			// must not present the model's opinion as a clearance.
			const evalTip = 'Each window gets a synthetic score. A window scoring over the '
				+ (thrLabel ? thrLabel + ' ' : '') + 'flag threshold goes to the AI model for additional reasoning; '
				+ 'it counts as synthetic when the model concurs, or when the score passes the strong threshold. '
				+ 'A model opinion of authentic is reasoning, not a clearance: the window stays model-reviewed.'
				+ (typeof sum.svdMeanScore === 'number'
					? '\n\nMean synthetic score across the scored windows: ' + Math.round(100 * sum.svdMeanScore) + '%.' : '');
			cells.push(h('div', { class: 'rcell' },
				// VI-942: a running job hedges its headline; only a finished one states it plain.
				h('div', { class: 'rcl' }, running ? 'Evaluation so far' : 'Evaluation',
					h('span', { class: 'vif-help-tip', title: evalTip }, '?')),
				h('div', { class: 'rcv' }, headline,
					sum.degraded ? [' ', h('span', { class: 'tag tag-e', title: 'A scoring or review endpoint outage degraded some windows.' }, 'degraded')] : null),
				h('div', { class: 'rcs' },
					share ? h('div', { class: 'rcsv' }, share) : null,
					h('div', null, [balance || (thrLabel ? 'threshold ' + thrLabel : null), concur].filter(Boolean).join(' · '))),
				knownMs ? h('div', { class: 'rpbar syn', role: 'progressbar', 'aria-valuemin': '0',
					'aria-valuemax': '100', 'aria-valuenow': String(Math.round(100 * synMs / videoMs)) },
					h('i', { style: 'width:' + (100 * synMs / videoMs).toFixed(1) + '%' })) : null));

			// Model Analysis: how many windows the review model took up.
			const reviewed = windows.length ? windows.filter((w) => w.reviewed).length
				: (this.state.report && this.state.report.review && typeof this.state.report.review.windowsReviewed === 'number')
					? this.state.report.review.windowsReviewed : null;
			const model = this.reviewModel();
			const modelShort = model ? String(model).split('/').pop() : null;
			cells.push(cell('Model Analysis', reviewed !== null ? String(reviewed) : '—',
				reviewed !== null ? (modelShort ? 'by ' + modelShort : (reviewed === 1 ? 'window reviewed' : 'windows reviewed'))
					: 'report not readable',
				'How many windows required additional analysis by the selected AI model based on configured confidence thresholds'));

			// Requests: the SVD page's ledger cell, same logic.
			const settled = job.state === 'completed';
			const unstarted = !job.requestsSent && !job.requestsTotal && !isTerminal(job);
			cells.push(cell('Requests',
				settled ? String(job.requestsSent)
					: unstarted ? '—' : job.requestsSent + ' / ' + (job.requestsTotal || '?'),
				(settled ? 'all requests answered' : unstarted ? 'waiting for a worker' : 'answered / expected')
					+ (job.resumes ? ' · resumed ×' + job.resumes : ''),
				'Total window requests processed by the service.'
				+ '\nFewer than expected usually means the video has few keyframes: windows can only start at a keyframe, so they come out longer and fewer.'
				+ (job.resumes ? '\nThis job resumed ' + job.resumes + ' time' + (job.resumes > 1 ? 's' : '')
					+ ' and continued from the last stored window.' : '')));

			return h('div', null, h('div', { class: 'rband' }, cells), this.nvLine(job));
		},

		renderFrame(job) {
			const s = this.state;
			const seekable = isTerminal(job) && !!job.file;
			let inner;
			if (s.playerOn && this.videoEl) {
				inner = h('div', { class: 'frame vframe' }, this.videoEl);
			} else if (seekable && !s.thumbUrl) {
				inner = h('div', { class: 'noframe' },
					h('button', { class: 'playbtn inline', title: 'Play the source file (Engine HLS)',
						onclick: () => this.startPlayer() }, '▶'),
					h('span', { class: 'nf1' }, 'Play the source video'));
			} else if (s.thumbUrl) {
				inner = h('div', { class: 'frame' }, h('img', { src: s.thumbUrl, alt: 'job thumbnail' }));
			} else {
				inner = h('div', { class: 'noframe' },
					h('span', { class: 'nf1' }, 'No frame yet'),
					h('span', null, 'The thumbnail is a frame the review stage is seeing; it appears once decoding starts.'));
			}
			if (!s.playerOn && seekable && s.thumbUrl) {
				inner = h('div', { class: 'posterwrap' }, inner,
					h('button', { class: 'playbtn', title: 'Play the source file (Engine HLS)',
						onclick: () => this.startPlayer() }, '▶'));
			}
			return h('div', null,
				inner,
				// Every element in this row gets the same 16px line box (the button
				// explicitly - a button does not inherit line-height). The label
				// zeroes its margins and weight: the Manager's Bootstrap styles
				// label with a 5px bottom margin (which flex centers into a 2.5px
				// droop) and bold text.
				s.playerOn ? h('div', { style: 'display:flex;gap:10px;align-items:center;margin-top:6px;line-height:16px' },
					h('span', { class: 'hint' }, 'Click a window on the strip or the timeline to jump there.'),
					h('label', { class: 'hint', style: 'margin:0 0 0 auto;font-weight:400;display:inline-flex;align-items:center;gap:5px;cursor:pointer' },
						h('input', { type: 'checkbox', style: 'margin:0;width:12px;height:12px', checked: V.playerLoopOn() ? 'checked' : null,
							onchange: (e) => { V.setPlayerLoop(e.target.checked); if (this.videoEl) this.videoEl.loop = e.target.checked; } }),
						'Loop'),
					h('button', { class: 'btn btn-sm btn-ghost', style: 'line-height:16px',
						onclick: () => { this.stopPlayer(); this.render(); } }, 'Stop player')) : null,
				s.playError ? h('div', { class: 'hint', style: 'margin-top:6px;color:var(--alert-color)' }, s.playError) : null);
		},

		/* The score timeline: one point per scored window on a media-time axis, the flag
		   threshold as the dashed gate line, the strong threshold above it, flagged points in
		   the alert color. */
		renderTimeline(job) {
			const s = this.state;
			const windows = this.windows();
			const flagThreshold = this.flagThreshold();
			const strongThreshold = this.strongThreshold();
			const caption = windows.length
				? windows.length + ' windows · one score per keyframe-aligned window'
					+ (strongThreshold !== null
						? ' · above the synthetic detection threshold a window is synthetic on the score alone · between the thresholds the model adds analysis'
						: ' · flagged windows get model analysis')
				: null;
			const head = h('div', { style: 'display:flex;align-items:baseline;gap:10px;margin:18px 0 6px;flex-wrap:wrap' },
				h('span', { class: 'eyebrow' }, 'Score timeline'),
				caption ? h('span', { style: 'font-size:11px;color:var(--ink-52)' }, caption) : null,
				windows.length ? h('span', { class: 'vlegend' },
					h('span', null, h('i', { class: 'lw syn' }), 'synthetic'),
					h('span', null, h('i', { class: 'lw clr' }), 'model reviewed'),
					h('span', null, h('i', { class: 'lw ok' }), 'real'),
					h('span', null, h('i', { class: 'lw thr' }), 'flag threshold'),
					strongThreshold !== null ? h('span', null, h('i', { class: 'lw thr' }), 'strong threshold') : null,
					s.playerOn ? h('span', null, h('i', { class: 'lw ph' }), 'playhead') : null) : null);

			if (!windows.length) {
				this.playheadEl = null;
				this.pointEls = null;
				this.selLineEl = null;
				return h('div', null, head,
					h('div', { class: 'hint' }, s.reportMissing && isTerminal(job) ? s.reportMissing
						: !isTerminal(job) ? 'Windows appear here as the service scores them.'
						: 'No stored windows: the analysis stored nothing to draw.'));
			}

			const endMs = job.sourceDurationMs || windows[windows.length - 1].toMs || 1;
			this.timelineEndMs = endMs;
			const X = (ms) => 1000 * Math.min(1, ms / endMs);
			const Y = (score) => 12 + 196 * (1 - Math.max(0, Math.min(1, score)));
			const seekable = isTerminal(job) && !!job.file;

			const pts = windows.map((w) => ({
				w, x: X((w.fromMs + w.toMs) / 2 || w.fromMs), y: Y(w.score),
			}));
			const grid = sv('g', { stroke: 'var(--divider)', 'stroke-width': '1' });
			for (let i = 0; i <= 5; i++) {
				const y = 12 + 196 * i / 5;
				grid.appendChild(sv('line', { x1: 0, y1: y, x2: 1000, y2: y }));
			}
			for (let i = 1; i < 4; i++) grid.appendChild(sv('line', { x1: i * 250, y1: 12, x2: i * 250, y2: 208 }));

			const yLabels = sv('g', { 'font-size': '10', fill: 'var(--ink-52)', 'text-anchor': 'end' });
			['1.0', '0.8', '0.6', '0.4', '0.2', '0.0'].forEach((t, i) =>
				yLabels.appendChild(sv('text', { x: -8, y: 16 + 196 * i / 5 }, t)));
			const xLabels = sv('g', { 'font-size': '10', fill: 'var(--ink-52)', 'text-anchor': 'middle' });
			[0, 0.25, 0.5, 0.75, 1].forEach((f) =>
				xLabels.appendChild(sv('text', { x: 1000 * f, y: 226 }, V.fmtMediaMs(Math.round(endMs * f)))));

			const chart = sv('svg', { viewBox: '0 0 1044 252', class: 'vtl', role: 'img',
				'aria-label': 'Per-window synthetic scores against the thresholds' });
			const plot = sv('g', { transform: 'translate(36,8)' });
			// The whole plot seeks to the nearest window — the points are small targets.
			plot.appendChild(sv('rect', { x: 0, y: 12, width: 1000, height: 196, fill: 'var(--n100)',
				class: seekable ? 'vpt seek' : null,
				onclick: (e) => {
					const box = chart.getBoundingClientRect();
					if (!box.width) return;
					const x = (e.clientX - box.left) / box.width * 1044 - 36;
					let best = null;
					for (const p of pts) if (!best || Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
					if (best) this.selectWindow(best.w);
				} }));
			plot.appendChild(grid);
			if (pts.length > 1) {
				const line = pts.map((p) => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');
				plot.appendChild(sv('polygon', { fill: 'var(--accent-100)',
					points: pts[0].x.toFixed(1) + ',208 ' + line + ' ' + pts[pts.length - 1].x.toFixed(1) + ',208' }));
				plot.appendChild(sv('polyline', { fill: 'none', stroke: 'var(--accent-600)', 'stroke-width': '2',
					'stroke-linejoin': 'round', points: line }));
			}
			if (flagThreshold !== null) {
				const ty = Y(flagThreshold);
				plot.appendChild(sv('line', { x1: 0, y1: ty, x2: 1000, y2: ty,
					stroke: 'var(--ink-52)', 'stroke-width': '2', 'stroke-dasharray': '7 5' }));
				plot.appendChild(sv('text', { x: 1000, y: ty - 6, 'text-anchor': 'end', 'font-size': '10',
					fill: 'var(--ink-60)' }, 'flag ' + flagThreshold));
			}
			if (strongThreshold !== null) {
				const sy = Y(strongThreshold);
				plot.appendChild(sv('line', { x1: 0, y1: sy, x2: 1000, y2: sy,
					stroke: 'var(--alert-color)', 'stroke-width': '1.5', 'stroke-dasharray': '3 5' }));
				plot.appendChild(sv('text', { x: 1000, y: sy - 6, 'text-anchor': 'end', 'font-size': '10',
					fill: 'var(--alert-color)' }, 'strong ' + strongThreshold));
			}
			this.pointEls = new Map();
			for (const p of pts) {
				const o = p.w.outcome;
				// Flagged stays in the red family whatever the review said: a reviewed
				// point is a light-red ring, never a color that could read as real.
				const fill = o === 'synthetic' ? 'var(--alert-color)' : o === 'cleared' ? 'var(--alert-bg)' : 'var(--bg)';
				const stroke = o === 'synthetic' || o === 'cleared' || o === 'undecided' ? 'var(--alert-color)'
					: o === 'unscored' ? 'var(--n400)' : 'var(--ink-52)';
				const c = sv('circle', {
					cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: s.selWindow === p.w.index ? '5' : '3.5',
					fill: fill,
					stroke: stroke,
					'stroke-width': '2', class: 'vpt' + (seekable ? ' seek' : ''),
					onclick: () => this.selectWindow(p.w),
				});
				c.appendChild(sv('title', null, this.windowTip(p.w, seekable)));
				this.pointEls.set(p.w.index, c);
				plot.appendChild(c);
			}
			this.playheadEl = sv('line', { x1: 0, y1: 4, x2: 0, y2: 208,
				stroke: 'var(--ink)', 'stroke-width': '2', display: 'none' });
			plot.appendChild(this.playheadEl);
			plot.appendChild(yLabels);
			plot.appendChild(xLabels);
			chart.appendChild(plot);

			const sel = s.selWindow !== null ? windows.find((w) => w.index === s.selWindow) : null;
			this.selLineEl = h('div', { class: 'vselline mono', style: sel ? null : 'display:none' },
				sel ? this.selectionLine(sel) : null);
			return h('div', null, head, chart, this.selLineEl);
		},

		windowTip(w, seekable) {
			return this.windowName(w) + ' · ' + this.windowLabel(w)
				+ ' · score ' + this.fmtScore(w.score) + ' · ' + this.outcomeLine(w)
				+ (w.degraded ? ' · degraded' : '')
				+ (seekable ? '\nClick to play from here' : '');
		},

		/** The strip's caption: scored windows against the Engine's estimate while running. */
		windowsProgress(job) {
			const scored = this.windows().length;
			if (isTerminal(job)) return scored ? scored + ' windows' : '';
			const expected = Math.max(job.requestsTotal || 0, scored);
			return expected ? scored + ' of ' + expected + ' windows scored' : scored + ' windows scored';
		},

		/* One cell per window on a media-time axis, colored by its outcome after both stages
		   — the quick read of where the file is synthetic, cleared, real or unanswered. While the job runs the Engine's
		   window estimate pads the strip with pending cells, so it fills up as a progress
		   bar; clicking a scored cell selects it (and seeks the player). */
		renderWindowStrip(job) {
			const s = this.state;
			const windows = this.windows();
			const running = !isTerminal(job);
			const expected = running ? Math.max(job.requestsTotal || 0, windows.length) : windows.length;
			this.cellEls = new Map();
			this.stripMarkEl = null;
			this.stripCellBoxEl = null;
			if (!expected) {
				return h('div', { class: 'vstripblock' },
					h('div', { class: 'strip vstrip empty' }),
					h('div', { class: 'hint', style: 'margin-top:5px' }, running
						? 'The strip fills in as the service scores each window.'
						: s.reportMissing ? s.reportMissing : 'No stored windows to draw.'));
			}
			const scoredEnd = windows.length ? windows[windows.length - 1].toMs : 0;
			const endMs = Math.max(job.sourceDurationMs || 0, scoredEnd) || 1;
			const pending = expected - windows.length;
			const avg = windows.length ? scoredEnd / windows.length : 0;
			const pendingWidth = pending > 0 ? (endMs > scoredEnd ? (endMs - scoredEnd) / pending : (avg || 1)) : 0;
			const seekable = !running && !!job.file;

			const cells = windows.map((w) => {
				const cls = ['vw', OUTCOME_CLASS[w.outcome] || 'vw-unk'];
				if (w.strong) cls.push('vw-strong');
				if (s.selWindow === w.index) cls.push('sel');
				const el = h('i', { class: cls.join(' '), title: this.windowTip(w, seekable),
					style: 'flex:' + Math.max(1, w.toMs - w.fromMs) + ' 1 0px',
					onclick: () => this.selectWindow(w) });
				this.cellEls.set(w.index, el);
				return el;
			});
			for (let i = 0; i < pending; i++) {
				cells.push(h('i', { class: 'vw vw-pend', title: 'not scored yet', style: 'flex:' + Math.max(1, pendingWidth) + ' 1 0px' }));
			}
			this.stripMarkEl = h('div', { class: 'pmark', style: 'display:none' });
			this.stripCellBoxEl = h('div', { class: 'pcell', style: 'display:none' });
			const wrap = h('div', { class: 'stripwrap vstripwrap' + (seekable ? ' seek' : '') },
				h('div', { class: 'strip vstrip' }, cells), this.stripMarkEl, this.stripCellBoxEl);
			const axis = [0, 0.25, 0.5, 0.75, 1].map((f) => V.fmtMediaMs(Math.round(endMs * f)));
			const counts = { synthetic: 0, strong: 0, cleared: 0, undecided: 0, real: 0, unscored: 0 };
			for (const w of windows) {
				if (w.outcome in counts) counts[w.outcome]++;
				if (w.strong) counts.strong++;
			}
			const key = (cls, label, n) => h('span', null, h('i', { class: 'vw ' + cls }), label, n === undefined ? null : h('span', { class: 'lc' }, ' ×' + n));
			return h('div', { class: 'vstripblock' }, wrap,
				h('div', { class: 'axis' }, axis.map((t) => h('span', null, t))),
				h('div', { class: 'vlegend vstriplegend' },
					key('vw-syn', 'synthetic', counts.synthetic),
					counts.strong ? key('vw-syn vw-strong', 'strong', counts.strong) : null,
					counts.cleared ? key('vw-clr', 'model reviewed', counts.cleared) : null,
					counts.undecided ? key('vw-und', 'no verdict', counts.undecided) : null,
					key('vw-real', 'real', counts.real),
					counts.unscored ? key('vw-unk', 'no score', counts.unscored) : null,
					pending > 0 ? key('vw-pend', 'pending', pending) : null,
					h('span', { class: 'hint', style: 'margin-left:auto' }, seekable ? 'click a window to play it and read its review' : 'click a window to read its review')));
		},

		/* The window Stage 2 opens on: the highest-scoring synthetic window, else the
		   highest-scoring window with a usable review; null when nothing was reviewed. */
		decidingWindow() {
			let best = null;
			for (const w of this.windows()) if (w.outcome === 'synthetic' && (!best || w.score > best.score)) best = w;
			if (best) return best;
			for (const w of this.windows()) if (usableReview(w) && (!best || w.score > best.score)) best = w;
			return best;
		},

		/* The review's verdicts and adverse findings, counted over the reviewed windows. */
		reviewTallies() {
			const t = { reviewed: 0, noAnswer: 0, verdicts: { synthetic: 0, authentic: 0, uncertain: 0 }, adverse: {} };
			for (const w of this.windows()) {
				if (!w.review) continue;
				if (!w.review.windowsReviewed) { t.noAnswer++; continue; }
				t.reviewed++;
				if (w.review.verdict in t.verdicts) t.verdicts[w.review.verdict]++;
				const attrs = w.review.attributes || {};
				for (const key of Object.keys(attrs)) {
					if (attrs[key] && attrs[key].finding === 'adverse') t.adverse[key] = (t.adverse[key] || 0) + 1;
				}
			}
			return t;
		},


		/* Stage 2: one window's review at a time — the clicked one, the one under the
		   playhead, or by default the window that decided the verdict — with the review's
		   verdicts tallied over every reviewed window beside it. The element is kept on the
		   view so a selection change can swap it without a page render. */
		renderReview(job) {
			const s = this.state;
			const sum = this.summary();
			const windows = this.windows();
			const deciding = this.decidingWindow();
			const picked = s.selWindow !== null ? windows.find((w) => w.index === s.selWindow) : null;
			const sel = picked || deciding;
			const pickedByDefault = sel && !picked
				? (sel.outcome === 'synthetic' ? 'the window that decided the verdict' : 'the highest-scoring reviewed window')
				: null;
			const scope = sel ? [
				h('span', { class: 'vscope mono' }, this.windowName(sel) + ' · ' + this.windowLabel(sel)),
				pickedByDefault ? h('span', { class: 'hint' }, pickedByDefault) : null,
			] : null;
			const head = h('div', { class: 'vreviewhead' },
				h('span', { class: 'eyebrow' }, 'Stage 2 — VLM reasoning'), scope);
			const section = (body) => {
				const el = h('div', { class: 'vreviewsec' }, head, body);
				this.reviewEl = el;
				return el;
			};

			if (!sel) {
				const reason = !sum ? 'The review runs on windows the scoring stage flags.'
					: sum.windowsFlagged === 0 ? 'No window crossed the flag threshold, so the review model never ran.'
					: !isTerminal(job) && !sum.degraded ? 'Flagged windows are being reviewed — the reasoning lands here.'
					: 'Flagged windows could not be reviewed (the review endpoint gave no usable answer), so the verdict stays uncertain.';
				return section(h('div', { class: 'hint' }, reason));
			}

			const name = this.windowName(sel);
			// The prose name for the note sentences: "Window 05", not the terse w05.
			const longName = 'Window ' + String(sel.index + 1).padStart(2, '0');
			if (!sel.reviewed) {
				return section(h('div', { class: 'hint' }, sel.verdict === 'unknown'
					? name + ' has no score — the scoring endpoint gave no answer for it — so it was not reviewed.'
					: [longName + ' scored ' + this.fmtScore(sel.score) + ' which is below the threshold to be considered authentic. ',
						h('b', null, 'No model review is necessary.')]));
			}
			if (!sel.review) return section(h('div', { class: 'hint' }, name + ' was flagged, but no review was recorded for it.'));
			if (!sel.review.windowsReviewed) {
				return section(h('div', { class: 'hint' }, name + ' was flagged, but the review endpoint gave no usable answer for it.'
					+ (sel.strong ? ' It scored ' + this.fmtScore(sel.score) + ' which is above the synthetic detection threshold and counts as synthetic on the score alone.' : '')));
			}
			const finalNote = sel.strong
				? h('div', { class: 'hint', style: 'margin:0 0 10px' }, longName + ' scored ' + this.fmtScore(sel.score)
					+ ' which is above the synthetic detection threshold. The information below is the reasoning model’s explanation of what it observes.')
				: h('div', { class: 'hint', style: 'margin:0 0 10px' }, longName + ' scored ' + this.fmtScore(sel.score)
					+ ' which is below the synthetic detection threshold and above the minimum threshold to be considered authentic. '
					+ 'The content may very well be synthetic so a vision language model is providing additional analysis below using the noted attributes.');
			return section(this.reviewBody(sel.review, finalNote));
		},

		/** One window's review: the reasoning, its meta line and the six-attribute rubric. */
		reviewBody(review, note) {
			const paragraphs = String(review.reasoning || '').split(/\n{2,}|\n/).map((x) => x.trim()).filter(Boolean);
			const attrs = review.attributes || {};
			const shown = ATTRIBUTES.map(([key, label]) => [key, label, attrs[key]]);
			for (const key of Object.keys(attrs)) {
				if (!ATTRIBUTES.some(([k]) => k === key)) shown.push([key, prettyKey(key), attrs[key]]);
			}
			return h('div', { class: 'vreview' },
				h('div', null,
					note,
					paragraphs.length ? paragraphs.map((p) => h('p', { class: 'reason', style: 'margin:0 0 10px' }, p))
						: h('p', { class: 'hint', style: 'margin:0 0 10px' }, 'The model returned no reasoning text.'),
					// The model's own verdict and confidence stay out of the meta line:
					// the review is reasoning, and printing a verdict here would read
					// as an adjudication (VI-961). The outcome lives on the strip.
					review.model ? h('div', { class: 'vmeta' },
						h('span', null, 'Model ', h('b', { class: 'mono' }, review.model))) : null),
				h('div', { class: 'vattrs' },
					h('div', { class: 'vsl', style: 'margin-bottom:8px' }, 'Attributes assessed'),
					shown.map(([key, label, a]) => h('div', { class: 'vattr' },
						h('div', { class: 'vattrh' },
							h('span', { class: 'sq' + (a ? (a.finding === 'adverse' ? ' adv' : ' clr') : '') }),
							h('span', { class: 'vattrname' + (a ? '' : ' off') }, label)),
						h('div', { class: 'vattrnote' }, a ? (a.note || (a.finding === 'adverse' ? 'found adverse' : 'no issue found'))
							: 'not assessed')))));
		},

		/* The pipeline band under the grid: the pipeline as the user should understand
		   it — two stages and the gate between them — plus what this job delivered. */
		renderRail(job) {
			const sum = this.summary();
			const flagThreshold = this.flagThreshold();
			const review = this.state.report && this.state.report.review;
			const tallies = this.reviewTallies();
			const kv = (label, value) => h('div', { class: 'vkv' },
				h('span', null, label), h('span', { class: 'mono' }, value));
			const stageHead = (no, name, sub) => h('div', { class: 'vstagehead' },
				h('span', { class: 'dbadge' }, no),
				h('div', null, h('div', { class: 'dname' }, name), h('div', { class: 'ddesc' }, sub)));

			const threshold = flagThreshold !== null ? 'the ' + flagThreshold + ' threshold' : 'the flag threshold';
			const gate = () => {
				if (!sum || !sum.windowsTotal) {
					return { cls: '', label: 'Gate', text: 'windows over ' + threshold + ' go to review' };
				}
				if (sum.windowsFlagged > 0) {
					return { cls: ' on', label: 'Gate crossed', text: sum.windowsFlagged + ' window'
						+ (sum.windowsFlagged === 1 ? '' : 's') + ' over ' + threshold };
				}
				return { cls: '', label: 'Gate not crossed', text: 'no window over ' + threshold };
			};
			const g = gate();

			const model = this.reviewModel();
			const config = job.effectiveConfig || job.config || {};
			const listeners = Object.entries(config.listeners || {});
			const delivered = [];
			if (job.storeResults !== false) {
				delivered.push(h('div', { class: 'vdel' }, h('span', { class: 'sq adv' }),
					h('span', null, 'Results stored', sum ? ' · ' + sum.windowsTotal + ' windows' : '',
						' — ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); V.jobActions.jsonl(job); } }, 'JSONL'))));
			} else {
				delivered.push(h('div', { class: 'vdel' }, h('span', { class: 'sq' }),
					h('span', { class: 'muted' }, 'Results not stored (status only)')));
			}
			for (const [name, l] of listeners) {
				delivered.push(h('div', { class: 'vdel' }, h('span', { class: 'sq adv' }),
					h('span', null, name + (l && l.type ? ' · ' + l.type : ''))));
			}
			delivered.push(h('div', { class: 'vdel' }, h('span', { class: 'sq adv' }),
				h('span', null, 'Verdict on the job document', h('span', { class: 'muted' }, ' — and its lifecycle webhook'))));

			return h('div', { class: 'vrail' },
				h('div', { class: 'vsl vrailhead' }, 'Pipeline — Verify'),
				h('div', { class: 'vband' },
					h('div', null,
						stageHead('1', 'Synthetic Detection', 'NVIDIA SVD'),
						h('div', { class: 'vstagekv' },
							kv('Windows scored', sum ? String(sum.windowsTotal) : '—'),
							kv('Above flag threshold', sum ? String(sum.windowsFlagged) : '—'),
							this.strongThreshold() !== null ? kv('Above strong threshold ' + this.strongThreshold(),
								sum ? String(sum.windowsStrong || 0) + (sum.windowsStrong ? ' · final' : '') : '—') : null,
							kv('Peak score', this.fmtScore(sum && sum.svdPeakScore)),
							kv('Mean score', this.fmtScore(sum && sum.svdMeanScore)))),
					h('div', null,
						h('div', { class: 'vsl' }, 'Gate'),
						h('div', { class: 'gatechip' + g.cls },
							h('div', { class: 'gcl' }, g.label),
							h('div', { class: 'gcx mono' }, g.text))),
					h('div', null,
						stageHead('2', 'VLM Review', model ? String(model).split('/').pop() : 'vision-language model'),
						h('div', { class: 'vstagekv' },
							kv('Windows reviewed', review ? String(review.windowsReviewed) : (sum && sum.windowsFlagged ? '…' : '0')),
							kv('Confirmed synthetic', String(tallies.verdicts.synthetic)),
							kv('No synthetic signs found', String(tallies.verdicts.authentic)),
							kv('Synthetic after both stages', sum ? String(sum.windowsSynthetic || 0) : '—'))),
					h('div', null,
						h('div', { class: 'vsl', style: 'margin-bottom:8px' }, 'Delivered'),
						h('div', { style: 'display:flex;flex-direction:column;gap:7px' }, delivered))));
		},

		/* The raw rows in a drawer, closed by default — the sections above tell the
		   story; this is the evidence, paged straight off the results API. */
		renderRaw() {
			const s = this.state, b = s.raw;
			const page = b.page;
			const total = page ? page.total : 0;
			const from = page && page.count ? page.offset + 1 : 0;
			const to = page ? page.offset + (page.count || 0) : 0;
			const refetch = () => { s.openRows.clear(); this.fetchRawPage().then(() => this.render()); };

			const brief = (r) => {
				let score = null, reviewed = false;
				for (const ring of (r.rings || [])) {
					if (ring.synthetic) score = ring.synthetic;
					if (Array.isArray(ring.vlm) && ring.vlm.length) reviewed = true;
				}
				if (!score) return r.type || '';
				return (score.verdict || '')
					+ (typeof score.synthetic_score === 'number' ? ' · ' + score.synthetic_score.toFixed(3) : '')
					+ (reviewed ? ' · reviewed' : '');
			};
			const rowLabel = (r) => {
				const w = r.detection_window || {};
				return typeof w.from_time_code === 'number'
					? V.fmtMediaMs(w.from_time_code) + ' – ' + V.fmtMediaMs(w.to_time_code || w.from_time_code) : '';
			};
			const rowNode = (r, i) => this.keyedDetails('row' + (page.offset + i), { class: 'rbrow' },
				h('summary', null,
					h('span', { style: 'color:var(--ink-52)' }, 'row ' + (page.offset + i + 1)),
					h('span', null, rowLabel(r)),
					h('span', null, brief(r)),
					h('span', { class: 'rawlink', style: 'margin-left:auto;color:var(--accent-700)' }, 'raw JSON ▸')),
				h('pre', null, JSON.stringify(r, null, 2)));

			return h('div', { class: 'rowbrowser' + (b.open ? ' open' : '') },
				h('button', { class: 'rbhead', 'aria-expanded': b.open ? 'true' : 'false',
					onclick: () => {
						b.open = !b.open;
						this.letPageShrink = !b.open;
						if (b.open && !b.page) { this.fetchRawPage().then(() => this.render()); return; }
						this.render();
					} },
					h('span', { class: 'chev' }, b.open ? '▾' : '▸'),
					'Raw detections',
					total ? h('span', { class: 'rbcount' }, String(total)) : null,
					h('span', { class: 'rbhint' }, b.open ? 'every stored analysis response' : 'the stored rows behind the report')),
				!b.open ? null : [
					h('div', { class: 'rbtools' },
						h('div', { style: 'margin-left:auto;display:flex;gap:8px;align-items:flex-end' },
							h('span', { class: 'mono', style: 'font-size:11.5px;color:var(--ink-60)' },
								total ? 'rows ' + from + '–' + to + ' of ' + total : 'no rows'),
							h('button', { class: 'btn btn-sm btn-ghost', disabled: b.offset <= 0,
								onclick: () => { b.offset = Math.max(0, b.offset - b.limit); refetch(); } }, '‹'),
							h('button', { class: 'btn btn-sm btn-ghost', disabled: !page || to >= total,
								onclick: () => { b.offset = b.offset + b.limit; refetch(); } }, '›'))),
					b.error ? h('div', { class: 'errbanner', style: 'margin:12px' }, b.error) : null,
					page && page.results ? page.results.map((r, i) => rowNode(r, i)) : null,
				]);
		},
	};

	V.views = V.views || {};
	V.views.verify = view;
})(window.VIF.vod);
