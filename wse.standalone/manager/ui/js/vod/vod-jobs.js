/* Jobs list — GET /vod/jobs with tag filter and offset/limit paging, plus the shared
   cancel / resume / delete flows the report page reuses.

   Every async continuation checks its mount generation (V.gen) before touching the DOM:
   all views render into the shared #vod-view root, so a late fetch from a view the user
   has left must never repaint, and a timer armed for a dead mount must clear itself. */
window.VIF = window.VIF || {};
VIF.vod = VIF.vod || {};
(function (V) {
	'use strict';
	const { h, clear, api, toast, modal } = V;

	/* ---------- shared job actions ---------- */

	const actions = {
		/** POST cancel answers 202 with a snapshot; the stop lands asynchronously. */
		cancel: async (job, refresh) => {
			try {
				await api.cancelJob(job.jobId);
				toast('Cancel accepted — the job settles to cancelled shortly.');
				refresh();
			} catch (e) { toast(e.message, 'err'); }
		},

		/**
		 * Resume, handling the one 409 a UI can fix: an inline job whose credentials were
		 * redacted from the manifest needs them re-supplied as the config it ran.
		 */
		resume: async (job, refresh) => {
			try {
				await api.resumeJob(job.jobId);
				toast('Resume accepted — continuing from the last stored window.');
				refresh();
			} catch (e) {
				if (e.status === 409 && /credentials/i.test(e.message)) credentialModal(job, e.message, refresh);
				else toast(e.message, 'err');
			}
		},

		del: async (job, refresh) => {
			if (!window.confirm('Remove job ' + job.jobId + '?\n\nThis deletes its record, stored results and thumbnail. '
				+ 'Its source file stays in the content directory; delete it from the New Analysis file list if you no longer need it.')) return;
			try {
				await api.deleteJob(job.jobId);
				toast('Job removed.');
				refresh();
			} catch (e) { toast(e.message, 'err'); }
		},

		jsonl: async (job) => {
			try { await api.downloadJsonl(job.jobId); }
			catch (e) { toast(e.message, 'err'); }
		},
	};

	function credentialModal(job, refusal, refresh) {
		const ta = h('textarea', { class: 'input', spellcheck: 'false', placeholder: '{\n  "detector": {\n    "type": "' + (job.detectorType || 'vlm') + '",\n    ...the inline config this job was submitted with, credentials included\n  }\n}' });
		modal('Re-supply this job’s credentials',
			h('div', null,
				h('p', { class: 'hint', style: 'margin-top:0' }, refusal),
				h('p', { class: 'hint' },
					'Inline credentials are never written to disk, so a resume needs the original config again — ',
					'paste it below, credentials included. Only the credentials are taken; the analysis must match what the job ran.'),
				ta),
			[{
				label: 'Resume with these credentials', primary: true,
				onclick: async (close) => {
					let config;
					try { config = JSON.parse(ta.value); }
					catch (e) { toast('That is not valid JSON: ' + e.message, 'err'); return; }
					try {
						await api.resumeJob(job.jobId, config);
						close();
						toast('Resume accepted — continuing from the last stored window.');
						refresh();
					} catch (e) { toast(e.message, 'err'); }
				},
			}]);
	}

	function isTerminal(job) {
		return job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled';
	}

	function canResume(job) {
		return job.state === 'failed' || job.state === 'cancelled' || (job.state === 'completed' && job.resultsTruncated);
	}

	/* ---------- the analysis-options modal ----------
	   What the job actually ran: the single-job resource's redacted effective_config, falling
	   back to the inline config as submitted. One modal for both kinds — a stream group config
	   may have been edited since the job used it, so the record beats today's document. */

	/** Leaf fields as "path.to.key: value" rows; the listener subtree is summarised instead. */
	function flattenConfig(obj, prefix, rows) {
		for (const [k, v] of Object.entries(obj)) {
			if (v === null || v === undefined) continue;
			const key = prefix ? prefix + '.' + k : k;
			if (k === 'listeners' && !prefix) {
				rows.push([key, Object.keys(v).join(' · ') || '(none)']);
			} else if (Array.isArray(v)) {
				rows.push([key, v.map((x) => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(', ')]);
			} else if (typeof v === 'object') {
				flattenConfig(v, key, rows);
			} else {
				rows.push([key, String(v)]);
			}
		}
		return rows;
	}

	V.showJobOptions = async function (job) {
		let detail = (job.effectiveConfig || job.config) ? job : null;
		if (!detail) {
			const gen = V.gen; // any navigation (and the swap-out watchdog) bumps it
			try { detail = await api.getJob(job.jobId); }
			catch (e) { if (gen === V.gen) toast(e.message, 'err'); return; }
			if (gen !== V.gen) return; // don't pop a stale modal over whatever mounted since
		}
		const config = detail.effectiveConfig || detail.config;
		const groupName = detail.streamGroupConfig || job.streamGroupConfig;
		const type = (config && config.detector && config.detector.type)
			|| detail.detectorType || job.detectorType || null;
		const meta = type ? V.DETECTOR_META[type] : null;

		const body = [];
		if (meta) {
			body.push(h('div', { class: 'drow', style: 'padding:0 0 12px' },
				h('span', { class: 'dbadge' }, meta.badge),
				h('div', null,
					h('div', { class: 'dname' }, meta.name),
					h('div', { class: 'ddesc' }, meta.desc))));
		}
		if (config) {
			const rows = flattenConfig(config, '', []);
			body.push(h('div', { class: 'kgrid' }, rows.map(([k, v]) => [
				h('span', { class: 'kk' }, k), h('span', { class: 'kv' }, v)])));
			body.push(h('p', { class: 'hint', style: 'margin:12px 0 0' },
				'The config as recorded at submit — credential fields are redacted from the record.',
				groupName ? ' The stored config may have been edited since; this is what the job ran.' : null));
			body.push(h('details', { style: 'margin-top:10px' },
				h('summary', { class: 'hint', style: 'cursor:pointer' }, 'Raw JSON'),
				h('pre', null, JSON.stringify(config, null, 2))));
		} else {
			body.push(h('p', { class: 'hint', style: 'margin:0' },
				'This job’s record carries no config snapshot — only the detector type ('
				+ (type || 'unknown') + ') is known.'));
		}
		modal(groupName ? 'Config ' + groupName : 'Inline config' + (meta ? ' — ' + meta.name : ''),
			h('div', null, body),
			groupName ? [{
				label: 'Open in Stream Configs',
				onclick: (close) => {
					close();
					// Preselect the job's group in the editor, which keys on its match rule; a
					// group deleted since just opens the editor unselected.
					const group = (V.store.groups || []).find(
						(g) => String(g.name).toLowerCase() === String(groupName).toLowerCase());
					if (group) V.openStreamConfig(group);
					else window.loadAjaxPluginContent('server', 'vif', 'stream-config.html', '');
				},
			}] : null);
	};

	/* ---------- thumbnails ----------
	   The endpoint 404s while nothing is decoded yet (and always, for clip-path synthetic
	   jobs), and the image changes while the job runs. So: never treat a miss as final
	   until the job is, refetch while the job is live, and fetch once more after it ends
	   for the representative frame. Cache entries: jobId -> {url, state}. The cache
	   lives on V so re-executions of this script (every fragment visit) reuse it instead
	   of stranding the old object URLs. */

	const thumbs = V._thumbs = V._thumbs || new Map();

	function thumbCell(job) {
		const holder = h('div', { class: 'thumb' }, job.state === 'pending' ? 'queued' : '…');
		const entry = thumbs.get(job.jobId);
		if (entry) applyThumb(holder, entry.url, job);

		const settledSynthetic = entry && entry.url === null && job.detectorType === 'synthetic';
		const needsFetch = job.state !== 'pending' && !settledSynthetic
			&& (!entry || !isTerminal({ state: entry.state }));
		if (needsFetch) {
			api.thumbnail(job.jobId).then((url) => {
				const prior = thumbs.get(job.jobId);
				if (prior && prior.url && prior.url !== url) URL.revokeObjectURL(prior.url);
				thumbs.set(job.jobId, { url, state: job.state });
				applyThumb(holder, url, job); // harmless if the row was re-rendered meanwhile
			}).catch(() => { /* keep the placeholder */ });
		}
		return holder;
	}

	function applyThumb(holder, url, job) {
		clear(holder);
		if (url) holder.appendChild(h('img', { src: url, alt: '' }));
		else holder.appendChild(document.createTextNode(
			job.detectorType === 'synthetic' ? 'no frame (clip path)'
				: isTerminal(job) ? 'no frame' : 'no frame yet'));
	}

	/** Drop cached thumbnails for jobs no longer on screen (deleted, evicted, other page). */
	function pruneThumbs(page) {
		const keep = new Set((page && page.jobs ? page.jobs : []).map((j) => j.jobId));
		for (const [id, entry] of Array.from(thumbs.entries())) {
			if (!keep.has(id)) {
				if (entry.url) URL.revokeObjectURL(entry.url);
				thumbs.delete(id);
			}
		}
	}

	/* ---------- row rendering ---------- */

	const REQUESTS_TIP = 'Analysis requests the service answered.\nEach request covers one slice of media: either frames of video or a media window.';

	function stateCell(job) {
		const bits = [h('span', { class: 'st st-' + job.state }, job.state)];
		if (job.resultsTruncated) bits.push(' ', h('span', { class: 'tag tag-e' }, 'results truncated'));
		if (job.errorCause) bits.push(' ', h('span', { class: 'tag tag-e', title: job.errorCause }, V.causeLabel(job.errorCause)));
		// The resumed chip is current status, not history: it shows only while the
		// job is still going. On finished jobs the fact lives in the report's
		// Requests cell and its timing tooltips.
		const settled = job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled';
		if (job.resumes && !settled) bits.push(' ', h('span', { class: 'tag tag-o' }, 'resumed ×' + job.resumes));

		const lines = [];
		if (job.state === 'pending') {
			lines.push(h('div', { class: 'l2' }, 'queued — waiting for a worker'));
		} else if (job.state === 'connecting') {
			lines.push(h('div', { class: 'l2' }, 'opening the source · connecting to the analysis service'));
		} else if (job.state === 'running') {
			const pct = job.sourceDurationMs ? Math.min(100, Math.round(100 * job.mediaTimeMs / job.sourceDurationMs))
				: (job.requestsTotal ? Math.min(100, Math.round(100 * job.requestsSent / job.requestsTotal)) : 0);
			lines.push(h('div', { style: 'display:flex;gap:9px;align-items:center;margin-top:5px' },
				h('span', { class: 'bar' }, h('i', { style: 'width:' + pct + '%' })),
				h('span', { class: 'mono', style: 'font-size:11px', title: REQUESTS_TIP }, job.requestsSent + ' / ' + (job.requestsTotal || '?') + ' requests')));
			lines.push(h('div', { class: 'l2' }, V.fmtMediaMs(job.mediaTimeMs)
				+ (job.sourceDurationMs ? ' of ' + V.fmtMediaMs(job.sourceDurationMs) : '') + ' of source analyzed'));
			if (job.resultsTruncated) lines.push(h('div', { class: 'l2' }, 'storing rows is failing — the analysis continues; resume after it ends to fill the gap'));
		} else if (job.state === 'completed') {
			lines.push(h('div', { class: 'l2' }, h('span', { title: REQUESTS_TIP }, job.requestsSent + ' requests')));
			if (job.resultsTruncated) lines.push(h('div', { class: 'l2' }, 'stored rows stop short of the analysis — resume fills the gap'));
		} else if (job.state === 'failed') {
			if (job.error) lines.push(h('div', { class: 'l2', title: job.error }, V.humanizeMs(job.error)));
			if (job.errorCause && V.RETRY_GLOSS[job.errorCause]) lines.push(h('div', { class: 'l2' }, V.RETRY_GLOSS[job.errorCause]));
		} else if (job.state === 'cancelled') {
			lines.push(h('div', { class: 'l2' },
				h('span', { title: REQUESTS_TIP }, job.requestsSent + ' / ' + (job.requestsTotal || '?') + ' requests'),
				' · partial results kept · resumable'));
		}
		return h('td', { class: 'scell' }, h('div', null, bits), lines);
	}

	/** The group's decoded match rule (live / scene.*) — derived names read badly.
	    Falls back to the raw name until the groups listing loads, or when the
	    group has been deleted since. */
	function configRule(name) {
		if (!name) return null;
		const g = (V.store.groups || []).find((x) => x.name === name);
		const m = g && g.match;
		return m && m.application && m.streamPattern ? m.application + ' / ' + m.streamPattern : name;
	}

	function timingCell(job) {
		const queueWait = V.jobQueueWait(job);
		const duration = V.jobDuration(job);
		// One relative anchor answers "when": what terminal jobs did and when they
		// did it, when a running job started, how long a pending one has waited.
		// The absolute timeline lives in the tooltip.
		const terminal = job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled';
		const verb = job.state === 'completed' ? 'finished'
			: terminal ? job.state
			: job.state === 'running' ? 'started' : 'queued';
		const anchor = terminal ? (job.endedAt || job.queuedAt)
			: job.state === 'running' ? (job.startedAt || job.queuedAt) : job.queuedAt;
		const tip = V.jobTimingTip(job);
		const ago = V.fmtAgo(anchor);
		return h('td', { class: 'scell mono', style: 'font-size:11px;color:var(--ink-60)' },
			ago ? h('div', { title: tip }, verb + ' ' + ago) : null,
			duration !== null ? h('div', { title: 'How long the analysis actually took, start to finish; not the length of the video.' }, 'analyzed in ' + V.fmtDurationMs(duration)) : null);
	}

	function actionsCell(job, refresh) {
		const btns = [];
		if (!isTerminal(job)) btns.push(h('button', { class: 'btn btn-sm', onclick: () => actions.cancel(job, refresh) }, 'Cancel'));
		if (canResume(job)) btns.push(h('button', { class: 'btn btn-sm', onclick: () => actions.resume(job, refresh) }, 'Resume'));
		if (job.storeResults !== false && isTerminal(job)) btns.push(h('button', { class: 'btn btn-sm btn-ghost', onclick: () => actions.jsonl(job) }, 'JSONL'));
		btns.push(h('button', { class: 'btn btn-sm', onclick: () => V.nav('job', { id: job.jobId }) }, 'View'));
		if (isTerminal(job)) btns.push(h('button', { class: 'btn btn-sm btn-danger', onclick: () => actions.del(job, refresh) }, 'Delete'));
		return h('td', null, h('div', { class: 'acts' }, btns));
	}

	/* ---------- the view ---------- */

	const view = {
		state: { tag: '', tagDraft: null, stateFilter: '', offset: 0, limit: 25, refreshMs: 5000, page: null, error: null, fetchSeq: 0 },
		timer: null,
		gen: 0,

		async mount(root) {
			this.root = root;
			this.gen = V.gen = (V.gen || 0) + 1;
			this.render();
			await this.refresh();
			if (this.gen !== V.gen) return;
			this.arm();
		},

		destroy() {
			if (this.timer) { clearInterval(this.timer); this.timer = null; }
			if (this._tagTimer) { clearTimeout(this._tagTimer); this._tagTimer = null; }
		},

		arm() {
			this.destroy();
			if (!this.state.refreshMs) return;
			const gen = this.gen;
			this.timer = setInterval(() => {
				if (gen !== V.gen) { this.destroy(); return; }
				this.refresh();
			}, this.state.refreshMs);
		},

		/** Refresh now, and again a few times — a 202'd cancel/resume settles asynchronously. */
		settleRefresh() {
			const gen = this.gen;
			this.refresh();
			for (const ms of [1500, 4000, 9000]) {
				setTimeout(() => { if (gen === V.gen) this.refresh(); }, ms);
			}
		},

		/** The whole listing (state filter applied server-side), for the client-side
		    tag search. Retention caps the job count, so this is a page or two;
		    a 500-job ceiling guards a raised cap. */
		async fetchAllJobs() {
			const s = this.state;
			const all = [];
			let offset = 0, total = Infinity;
			while (offset < total && all.length < 500) {
				const p = await api.listJobs({ state: s.stateFilter, offset, limit: 100 });
				total = p.total || 0;
				for (const j of (p.jobs || [])) all.push(j);
				if (!p.count) break;
				offset += p.count;
			}
			return { all, total };
		},

		async refresh(force) {
			const s = this.state;
			const gen = this.gen;
			const seq = ++s.fetchSeq;
			let page = null, error = null;
			try {
				// The settings feed the strip below the toolbar; the groups let the options
				// modal preselect a job's config in the editor. Both are read once per mount.
				const sideLoads = [
					V.store.vodSettings ? Promise.resolve(null) : api.vodSettings().catch(() => null),
					V.store.groups ? Promise.resolve(null) : api.streamGroups().catch(() => null),
				];
				const q = s.tag.trim().toLowerCase();
				if (!q) {
					[page] = await Promise.all([
						api.listJobs({ state: s.stateFilter, offset: s.offset, limit: s.limit }),
						...sideLoads,
					]);
				} else {
					// Tag search is a contains-match, case-insensitive — the API only
					// filters exact tags, so the listing is fetched whole and matched
					// here; paging then runs over the matches.
					const [{ all }] = await Promise.all([this.fetchAllJobs(), ...sideLoads]);
					const matches = all.filter((j) => (j.tag || '').toLowerCase().indexOf(q) >= 0);
					const jobs = matches.slice(s.offset, s.offset + s.limit);
					page = { jobs, total: matches.length, offset: s.offset, count: jobs.length };
				}
			} catch (e) {
				error = e.message;
			}
			// Stale-mount or superseded-request responses must not touch anything.
			if (gen !== V.gen || seq !== s.fetchSeq) return;
			if (page && page.count === 0 && page.total > 0 && s.offset > 0) {
				// Retention shrank the list under us — clamp back to the last real page.
				s.offset = Math.max(0, Math.floor((page.total - 1) / s.limit) * s.limit);
				return this.refresh();
			}
			s.page = page || s.page;
			s.error = error;
			if (page) pruneThumbs(page);
			// Don't repaint over the user's typing (unless the user asked for this refresh).
			const active = document.activeElement;
			if (!force && active && this.root.contains(active) && active.matches('input,textarea,select')) return;
			this.render();
		},

		render() {
			if (this.gen !== V.gen) return;
			const s = this.state;
			// Captured BEFORE clear() detaches the old nodes: a repaint replaces the
			// tag input, and when the user was typing in it, focus and caret are
			// handed to the new node below so the keyboard never goes dead.
			const oldActive = document.activeElement;
			const restoreTagFocus = !!(oldActive && oldActive.id === 'vod-tag-input');
			const tagCaret = restoreTagFocus && oldActive.selectionStart != null ? oldActive.selectionStart : null;
			const restoreScroll = V.snapshotScroll(this.root);
			const root = clear(this.root);
			root.appendChild(h('div', { class: 'phead' },
				h('div', null, h('h2', null, 'On-Demand Jobs')),
				h('div', { class: 'sp' },
					h('button', { class: 'btn btn-pri', onclick: () => V.nav('new') }, 'New Analysis'))));
			root.appendChild(h('div', { class: 'rule2' }));

			const tagInput = h('input', { id: 'vod-tag-input', class: 'input', style: 'width:160px;padding:5px 9px;font-size:12px', placeholder: 'tag',
				value: s.tagDraft !== null ? s.tagDraft : s.tag,
				oninput: (e) => {
					s.tagDraft = e.target.value;
					// Auto-apply once the tag is specific enough (3+ characters),
					// debounced so typing doesn't fetch per keystroke; emptying the
					// box auto-clears an applied filter. Matching stays exact — the
					// server filters and totals, so paging stays honest.
					clearTimeout(this._tagTimer);
					const v = e.target.value.trim();
					if (v.length >= 3 || (v === '' && s.tag)) {
						this._tagTimer = setTimeout(() => { if (this.gen === V.gen) applyTag(); }, 450);
					}
				} });
			const applyTag = () => { s.tag = (s.tagDraft !== null ? s.tagDraft : s.tag).trim(); s.tagDraft = s.tag; s.offset = 0; this.refresh(true); };
			const clearTag = () => { s.tag = ''; s.tagDraft = null; s.offset = 0; this.refresh(true); };
			tagInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyTag(); });

			const page = s.page;
			const total = page ? page.total : 0;
			const from = page && page.count ? page.offset + 1 : 0;
			const to = page ? page.offset + (page.count || 0) : 0;

			// The state filter rides the listing API (VI-806): the server filters
			// and totals, so paging and "Showing x–y of z" stay exact at any depth.
			const STATE_FILTERS = [
				['', 'All states'],
				['pending,connecting,running', 'Active'],
				['running', 'Running'],
				['pending,connecting', 'Queued'],
				['completed', 'Completed'],
				['failed', 'Failed'],
				['cancelled', 'Cancelled'],
			];
			root.appendChild(h('div', { class: 'toolbar' },
				h('div', { class: 'field', style: 'flex-direction:row;align-items:center;gap:8px' },
					h('label', { style: 'font-size:11px' }, 'State'),
					h('select', { class: 'input sel', style: 'padding:5px 6px;font-size:12px',
						onchange: (e) => { s.stateFilter = e.target.value; s.offset = 0; this.refresh(true); } },
						STATE_FILTERS.map(([value, label]) =>
							h('option', { value: value, selected: s.stateFilter === value }, label))),
					h('label', { style: 'font-size:11px' }, 'Tag'), tagInput,
					h('button', { class: 'btn btn-sm', onclick: applyTag }, 'Filter'),
					h('button', { class: 'btn btn-sm btn-ghost', title: 'Clear the tag filter', onclick: clearTag }, 'Clear')),
				h('div', { style: 'margin-left:auto;display:flex;align-items:center;gap:12px' },
					h('button', { class: 'btn btn-sm', onclick: () => this.refresh() }, 'Refresh'),
					h('label', { class: 'hint' }, 'Auto-refresh ',
						h('select', { class: 'input sel', style: 'padding:3px 6px;font-size:11.5px', onchange: (e) => { s.refreshMs = parseInt(e.target.value, 10); this.arm(); } },
							h('option', { value: '5000', selected: s.refreshMs === 5000 }, '5s'),
							h('option', { value: '15000', selected: s.refreshMs === 15000 }, '15s'),
							h('option', { value: '0', selected: !s.refreshMs }, 'off'))),
					h('span', { class: 'mono', style: 'font-size:11.5px;color:var(--ink-60)' },
						total ? 'Showing ' + from + '–' + to + ' of ' + total : 'No jobs'),
					h('button', { class: 'btn btn-sm btn-ghost', disabled: !page || s.offset <= 0, onclick: () => { s.offset = Math.max(0, s.offset - s.limit); this.refresh(); } }, '‹ Prev'),
					h('button', { class: 'btn btn-sm', disabled: !page || to >= total, onclick: () => { s.offset = s.offset + s.limit; this.refresh(); } }, 'Next ›'))));
			if (restoreTagFocus) {
				tagInput.focus();
				if (tagCaret != null) { try { tagInput.setSelectionRange(tagCaret, tagCaret); } catch (e) { /* type-dependent */ } }
			}

			const vod = V.store.vodSettings;
			if (vod) {
				// An absent member is the Engine's own default — show that rather than
				// nothing. Read-only here: editing lives under Configs → On-Demand Configs.
				// A webhook shows as its host (the whole URL in the tooltip) — "set"
				// answered nothing; a missing URL parses as the literal fallback.
				let webhookLabel = 'none';
				let webhookTitle = 'Every job’s lifecycle changes POST to this URL.\nA job can name its own webhook instead.\nNone is configured.';
				if (vod.lifecycleWebhook) {
					try { webhookLabel = new URL(vod.lifecycleWebhook).host; } catch (e) { webhookLabel = 'set'; }
					webhookTitle = 'Every job’s lifecycle changes POST here.\nA job can name its own webhook instead.\n' + vod.lifecycleWebhook;
				}
				root.appendChild(h('div', { class: 'strip-cfg' },
					h('span', { title: 'How many jobs are analyzed at once.\nThe rest wait in queue.' },
						'Workers ', h('b', null, String(vod.maxConcurrentJobs ?? 1))),
					h('span', { title: 'How many job records are kept.\nPast the cap, the oldest finished jobs are forgotten.\nTTL is a time limit on finished jobs; no TTL keeps them until the cap pushes them out.' },
						'Retention ', h('b', null, (vod.maxJobs ?? 25) + ' jobs · ' + (vod.jobTtlSeconds ? 'TTL ' + vod.jobTtlSeconds + 's' : 'no TTL'))),
					vod.contentDir ? h('span', { title: 'Where a job’s source file is resolved from.' },
						'Content root ', h('b', null, vod.contentDir)) : null,
					h('span', { title: webhookTitle }, 'Global webhook ', h('b', null, webhookLabel)),
					h('span', { title: 'A job stopped by a transient failure resumes on its own.\nTransient: dropped connection, service restart, unreachable endpoint.\nUp to 3 attempts; the counter resets on progress.\nOff leaves such jobs failed for a manual resume.' },
						'Auto-resume ', h('b', null, vod.autoResume === false ? 'off' : 'on'))));
			}

			if (s.error) root.appendChild(h('div', { class: 'errbanner', style: 'margin-top:14px' }, s.error));

			if (!page || !page.jobs || !page.jobs.length) {
				// Name the active filter in the empty state ("No active jobs.");
				// only the unfiltered, whole-history view earns a "yet".
				let stateLabel = '';
				STATE_FILTERS.forEach(([value, label]) => {
					if (value && value === s.stateFilter) stateLabel = label.toLowerCase() + ' ';
				});
				root.appendChild(h('div', { class: 'empty' },
					s.error ? 'Nothing to show.'
						: 'No ' + stateLabel + 'jobs' + (s.tag ? ' with tags matching "' + s.tag + '"' : '') + ((s.stateFilter || s.tag) ? '. ' : ' yet. '),
					h('a', { href: '#', onclick: (e) => { e.preventDefault(); V.nav('new'); } }, 'Start an analysis'), '.'));
				restoreScroll(root.lastElementChild);
				return;
			}

			const refresh = () => this.settleRefresh();
			root.appendChild(h('table', { class: 'jobs' },
				h('tr', null,
					h('th', { style: 'width:300px' }, 'Media'),
					h('th', { style: 'width:180px' }, 'Analysis'),
					h('th', { style: 'width:330px' }, 'State'),
					h('th', { style: 'width:170px' }, 'Timing'),
					h('th', { style: 'text-align:right' }, 'Actions')),
				page.jobs.map((job) => h('tr', null,
					h('td', null, h('div', { class: 'fcell fclick', role: 'button', tabindex: '0', title: 'Open this job',
						onclick: () => V.nav('job', { id: job.jobId }),
						onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); V.nav('job', { id: job.jobId }); } } },
						thumbCell(job),
						h('div', null, h('div', { class: 'fname' }, job.file),
							job.tag ? h('div', { class: 'fmeta' }, h('span', { class: 'tag tag-n' }, job.tag)) : null))),
					h('td', { class: 'scell' },
						h('div', { class: 'l1', style: 'display:flex;align-items:center;gap:6px;white-space:nowrap' },
							job.detectorType ? h('img', { class: 'dticon', src: 'wse-plugins/server/vif/'
								+ (['object', 'scene', 'vlm', 'synthetic'].indexOf(job.detectorType) >= 0 ? job.detectorType : 'unknown') + '.png', alt: '' }) : null,
							(V.DETECTOR_META[job.detectorType] || {}).name || job.detectorType || '—'),
						h('div', { class: 'l2 mono' }, (job.streamGroupConfig || job.detectorType)
							? h('a', { href: '#', class: 'cfglink',
								title: (job.streamGroupConfig ? job.streamGroupConfig + '\n' : '')
									+ 'Show the analysis options this job ran with',
								onclick: (e) => { e.preventDefault(); V.showJobOptions(job); } },
								configRule(job.streamGroupConfig) || 'inline config')
							: 'known once running')),
					stateCell(job),
					timingCell(job),
					actionsCell(job, refresh)))));
			restoreScroll(root.lastElementChild);
		},
	};

	V.jobActions = actions;
	V.jobHelpers = { isTerminal, canResume, credentialModal };
	V.views = V.views || {};
	V.views.jobs = view;
})(window.VIF.vod);
