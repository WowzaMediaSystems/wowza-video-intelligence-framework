/* New Analysis — three steps on one page: Source (file browser over GET /vod/files),
   Analysis (a stream group config, an inline config, or both), Outputs & options.

   The form's config is a v2 Config document in the SDK's camelCase spelling; the request
   preview shows the wire form of it, and the Advanced JSON box accepts either spelling. */
window.VIF = window.VIF || {};
VIF.vod = VIF.vod || {};
(function (V) {
	'use strict';
	const { h, clear, api, toast, modal, DETECTOR_META } = V;

	/* Only the two listener types that can run against a file job are offered —
	   ID3 and overlay need a live output stream and would be auto-skipped anyway.
	   `cls` is the implementing class the Engine reports in its listener types. */
	const LISTENER_DEFS = [
		{ type: 'webhook', cls: 'WebhookEvent2', key: 'Webhook', label: 'Webhook', defTrigger: 'batch',
			hint: 'Queues detections to the Engine’s webhooks feature — delivery needs a target configured there.' },
		{ type: 'log', cls: 'LogFileEvent', key: 'Log', label: 'Log file (JSONL)', defTrigger: 'immediate',
			hint: 'Appends detection JSON to a rolling file under the Engine’s VIF log directory.' },
	];

	/** The detector a stream group config selects, or null when it inherits one. */
	function groupDetector(group) {
		return (group && group.config && group.config.detector) || null;
	}

	/** The VLM endpoint members the default config publishes; the key is never echoed. */
	function vlmDefaults() {
		const detectors = (V.store.defaults && V.store.defaults.detectors) || {};
		return (detectors.vlm && detectors.vlm.endpoint) || {};
	}

	/* Same completion the live editor applies to a typed endpoint: a bare host gets a
	   scheme, a host[:port] with no path gets /v1 (the OpenAI-style base). */
	function normalizeVlmEndpoint(s) {
		s = (s || '').trim();
		if (!s) return null;
		if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) s = 'http://' + s;
		const rest = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
		if (!/\/./.test(rest)) s = s.replace(/\/$/, '') + '/v1';
		return s;
	}

	/** What deleting a file means for the jobs that name it, for the confirm. */
	function referencingJobs(jobs) {
		if (!jobs) return 'The jobs list could not be read, so which jobs reference it is unknown.';
		if (!jobs.length) return 'No job references it.';
		const finished = jobs.filter((j) => j.state === 'completed').length;
		const stopped = jobs.filter((j) => j.state === 'failed' || j.state === 'cancelled').length;
		const live = jobs.length - finished - stopped;
		const parts = [];
		if (finished) parts.push(finished + ' finished (kept; their results stay)');
		if (stopped) parts.push(stopped + ' cancelled or failed (kept, but they can no longer be resumed)');
		if (live) parts.push(live + ' queued or running (the Engine refuses the delete until they are cancelled)');
		return jobs.length + (jobs.length === 1 ? ' job references it: ' : ' jobs reference it: ') + parts.join('; ') + '.';
	}

	const view = {
		state: null,

		freshState() {
			return {
				// selected is a list: one submit fires one job per file, same analysis for all.
				files: null, filesError: null, filter: '', selected: [],
				uploads: [], dragDepth: 0,
				mode: 'config', groupName: '',
				config: { detector: { type: 'synthetic' }, processing: {} },
				vlmModelOther: false, vlmVerify: null,
				jsonDraft: null, jsonDirty: false, jsonOpen: false,
				storeResults: true, webhookMode: 'inherit', webhookUrl: '', webhookSecret: '', autoResume: 'inherit', tag: '',
				queueDepth: null, submitting: false, submitError: null,
			};
		},

		async mount(root) {
			this.root = root;
			this.gen = V.gen = (V.gen || 0) + 1;
			this.state = this.freshState();
			// A drop that misses the dropzone by a few pixels must not make the browser
			// navigate the whole Manager to the local file. Outside the zone the cursor
			// says "not allowed"; the zone's own handlers run first and are unaffected.
			this.undocDrag();
			this.dragGuard = (e) => {
				e.preventDefault();
				if (e.type === 'dragover' && e.dataTransfer && e.target.closest && !e.target.closest('.fbrowse'))
					e.dataTransfer.dropEffect = 'none';
			};
			document.addEventListener('dragover', this.dragGuard);
			document.addEventListener('drop', this.dragGuard);
			this.render();
			const s = this.state;
			try {
				// The groups always fresh, not from the store: the Edit link hands the user to
				// the Stream Configs editor, and what they saved there must be what this shows.
				const [files, groups, jobs] = await Promise.all([
					api.listFiles(),
					api.streamGroups(),
					api.listJobs({ state: 'pending,connecting,running', limit: 1 }).catch(() => null),
					api.defaultConfig().catch(() => null),
					api.secretNames().catch(() => null),
					api.listenerTypes().catch(() => null),
					V.store.vodSettings ? Promise.resolve(null) : api.vodSettings().catch(() => null),
				]);
				s.files = files;
				if (!s.groupName && groups.length) s.groupName = groups[0].name;
				if (jobs) s.queueDepth = jobs.total;
			} catch (e) {
				s.filesError = e.message;
			}
			if (this.gen !== V.gen) return; // the user left this view while we were loading
			this.render();
		},

		destroy() {
			this.undocDrag();
			// A fragment swap or view change must not keep pushing bytes at the Engine.
			for (const u of (this.state && this.state.uploads) || []) {
				if (u.xhr) { u.aborted = true; u.xhr.abort(); }
			}
		},

		undocDrag() {
			if (!this.dragGuard) return;
			document.removeEventListener('dragover', this.dragGuard);
			document.removeEventListener('drop', this.dragGuard);
			this.dragGuard = null;
		},

		/* ---------- state helpers ---------- */

		selectedGroup() {
			return (V.store.groups || []).find((g) => g.name === this.state.groupName) || null;
		},

		/** The config object as it will be posted: empty strings and empty blocks dropped. */
		prunedConfig() {
			const prune = (obj) => {
				const out = {};
				for (const [k, v] of Object.entries(obj)) {
					if (v === '' || v === null || v === undefined) continue;
					if (typeof v === 'object' && !Array.isArray(v)) {
						const inner = prune(v);
						if (Object.keys(inner).length) out[k] = inner;
					} else if (Array.isArray(v)) {
						if (v.length) out[k] = v;
					} else out[k] = v;
				}
				return out;
			};
			return prune(this.state.config);
		},

		requestBody(file) {
			const s = this.state;
			const body = { file: file ? file.file : (s.selected[0] ? s.selected[0].file : '(pick a file in step 01)') };
			if (s.mode === 'config') body.streamGroupConfig = s.groupName;
			else body.config = this.prunedConfig();
			if (!s.storeResults) body.storeResults = false;
			if (s.tag.trim()) body.tag = s.tag.trim();
			if (s.webhookMode === 'custom') body.lifecycleWebhook = s.webhookUrl.trim();
			if (s.webhookMode === 'custom' && s.webhookSecret) body.lifecycleWebhookSecret = s.webhookSecret;
			if (s.webhookMode === 'off') body.lifecycleWebhook = '';
			if (s.autoResume === 'on') body.autoResume = true;
			if (s.autoResume === 'off') body.autoResume = false;
			return body;
		},

		/** What "View request JSON" shows: the wire body, or one per selected file. */
		requestPreview() {
			const s = this.state;
			if (s.selected.length <= 1) return VIF.sdk.toWire(this.requestBody(s.selected[0]));
			return s.selected.map((f) => VIF.sdk.toWire(this.requestBody(f)));
		},

		async submit() {
			const s = this.state;
			if (!s.selected.length) { toast('Pick a source file first.', 'err'); return; }
			if (s.mode === 'config' && !s.groupName) {
				toast((V.store.groups || []).length ? 'Pick a stored config first.'
					: 'No stream configs on this Engine yet. Create one under Configs → Stream Configs.', 'err');
				return;
			}
			if (s.webhookMode === 'custom' && !s.webhookUrl.trim()) {
				// An empty string is the API's opt-out — silently identical to "Off", so refuse instead.
				toast('Enter a webhook URL, or choose Inherit global / Off.', 'err');
				return;
			}
			if (s.jsonDirty) { toast('The Advanced JSON has unapplied edits — Apply or discard them first.', 'err'); return; }
			if (s.uploads.some((u) => !u.done && !u.error)) {
				// A successful submit navigates away, and leaving this view aborts uploads.
				toast('Uploads are still running — wait for them or cancel them first.', 'err');
				return;
			}
			// Freeze the batch up front — the form goes inert while the loop runs, but the
			// header/crumb navigation stays live, so nothing after this may read live state.
			const batch = s.selected.map((f) => ({ file: f.file, body: this.requestBody(f) }));
			// Captured, not re-read: mount() re-syncs this.gen, so a leave-and-come-back
			// during the loop would fool a live comparison (same trap refresh() avoids).
			const gen = this.gen;
			s.submitting = true;
			this.render();
			// One POST per file, sequentially: the API takes one source per job, and the
			// worker pool serializes the runs anyway — no batch endpoint to gain anything.
			const queued = [], failed = [];
			for (const item of batch) {
				try {
					const created = await api.submitJob(item.body);
					queued.push(created.jobId);
					// The submit response's listener_warning is NOT toasted: the report
					// this navigates to shows it as a persistent notice, in plain words.
				} catch (e) {
					failed.push({ file: item.file, error: e.message });
				}
			}
			if (gen !== V.gen) return; // the user left (or remounted) this view mid-submit
			if (!failed.length) {
				if (queued.length === 1) {
					toast('Job queued: ' + queued[0]);
					V.nav('job', { id: queued[0] });
				} else {
					toast(queued.length + ' jobs queued.');
					V.nav('jobs');
				}
				return;
			}
			// Keep only the files that failed selected, so a retry resubmits just those.
			s.submitting = false;
			s.selected = s.selected.filter((f) => failed.some((x) => x.file === f.file));
			s.submitError = (queued.length ? queued.length + ' job' + (queued.length === 1 ? '' : 's') + ' queued — ' : '')
				+ failed.map((x) => x.file + ': ' + x.error).join(' · ');
			this.render();
		},

		/* ---------- uploads (step 01) ---------- */

		/** One POST per file, sequentially; progress mutates the row DOM directly so a
		    long upload never fights the keyboard for the rest of the form. */
		async startUploads(fileList) {
			const s = this.state;
			const gen = this.gen;
			const files = Array.from(fileList || []);
			if (!files.length || s.submitting) return;
			const batch = [];
			for (const f of files) {
				if (!/\.(mp4|m4v|mov|f4v)$/i.test(f.name)) {
					s.uploads.push({ name: f.name, pct: 0, error: 'not an analysable container (.mp4 · .m4v · .mov · .f4v)' });
					continue;
				}
				if (s.uploads.some((u) => u.name === f.name && !u.error && !u.done)) continue; // queued or in flight
				const existing = (s.files && s.files.files) || [];
				if (existing.some((x) => x.file === f.name)) {
					s.uploads.push({ name: f.name, pct: 0, error: 'already exists on the Engine — uploads never overwrite' });
					continue;
				}
				const u = { name: f.name, pct: 0, file: f };
				s.uploads.push(u);
				batch.push(u);
			}
			this.render();
			for (const u of batch) {
				if (gen !== V.gen) return; // the user left this view; destroy() aborted the rest
				if (u.aborted) { u.error = 'cancelled'; continue; }
				const post = api.upload(u.name, u.file, (pct) => {
					u.pct = pct;
					if (u.barEl) u.barEl.style.width = Math.round(pct * 100) + '%';
					if (u.pctEl) u.pctEl.textContent = Math.round(pct * 100) + '%';
				});
				u.xhr = post.xhr;
				try {
					await post;
					u.done = true;
				} catch (e) {
					u.error = e.cancelled ? 'cancelled' : e.message;
				}
				u.xhr = null;
				u.file = null;
				if (gen !== V.gen) return;
				this.render();
			}
			// One listing refresh for the whole batch, then auto-select what landed so the
			// upload flows straight into a submit. Only THIS batch: an earlier upload the
			// user deselected must stay deselected.
			try { s.files = await api.listFiles(); s.filesError = null; } catch (e) { /* keep the old listing */ }
			if (gen !== V.gen) return;
			for (const u of batch) {
				if (!u.done) continue;
				const hit = ((s.files && s.files.files) || []).find((x) => x.file === u.name);
				if (hit && !s.selected.some((x) => x.file === hit.file)) s.selected = s.selected.concat([hit]);
			}
			this.render();
		},

		renderUploads() {
			const s = this.state;
			if (!s.uploads.length) return null;
			return h('div', { class: 'upl' }, s.uploads.map((u) => {
				const pctEl = h('span', { class: 'uplpct mono' }, Math.round(u.pct * 100) + '%');
				const barInner = h('i', { style: 'width:' + Math.round(u.pct * 100) + '%' });
				u.pctEl = pctEl;
				u.barEl = barInner;
				return h('div', { class: 'uplitem' + (u.error ? ' err' : '') },
					h('div', { class: 'uplrow' },
						h('span', { class: 'fname', style: 'flex:1;min-width:0;font-size:12px' }, u.name),
						u.error ? h('span', { class: 'uplmsg' }, u.error)
							: u.done ? h('span', { class: 'uplmsg ok' }, 'uploaded ✓')
								: pctEl,
						u.xhr ? h('button', { class: 'btn btn-sm btn-ghost', title: 'Cancel this upload',
							onclick: () => { u.aborted = true; u.xhr.abort(); } }, '✕')
							: h('button', { class: 'btn btn-sm btn-ghost', title: 'Dismiss',
								// aborted first: a still-queued item must not upload after its row is gone
								onclick: () => { u.aborted = true; s.uploads = s.uploads.filter((x) => x !== u); this.render(); } }, '✕')),
					u.error || u.done ? null : h('div', { class: 'uplbar' }, barInner));
			}));
		},

		/* ---------- step 01: source ---------- */

		renderSource() {
			const s = this.state;
			const filterInput = h('input', { class: 'input', placeholder: 'Search files…', value: s.filter,
				oninput: (e) => { s.filter = e.target.value; this.renderFileList(); } });
			this.fileListEl = h('div', { class: 'flist' });
			const fileInput = h('input', { type: 'file', multiple: '', accept: '.mp4,.m4v,.mov,.f4v', style: 'display:none',
				onchange: (e) => { this.startUploads(e.target.files); e.target.value = ''; } });
			const browser = h('div', { class: 'fbrowse' + (s.dragDepth > 0 ? ' drophot' : '') },
				h('div', { class: 'fbtools' }, filterInput,
					h('button', { class: 'btn btn-sm btn-ghost', title: 'Clear the search',
						onclick: () => { s.filter = ''; filterInput.value = ''; this.renderFileList(); } }, 'Clear'),
					h('button', { class: 'btn btn-sm', onclick: async () => {
						try { s.files = await api.listFiles(); s.filesError = null; } catch (e) { s.filesError = e.message; }
						if (this.gen !== V.gen) return;
						this.render();
					} }, 'Refresh'),
					h('button', { class: 'btn btn-sm', title: 'Upload video files into the Engine’s content directory',
						onclick: () => fileInput.click() }, 'Upload'),
					fileInput),
				this.fileListEl,
				this.renderUploads(),
				h('div', { class: 'drophint' }, 'Drag & drop video files here to upload them — they land in the Engine’s content directory and appear in this list.'),
				s.files && s.files.truncated ? h('div', { class: 'fbanner' },
					'Showing the first 500 files — the listing is capped. Narrow it on the server.') : null);
			browser.addEventListener('dragenter', (e) => {
				e.preventDefault();
				if (++s.dragDepth === 1) browser.classList.add('drophot');
			});
			browser.addEventListener('dragover', (e) => { e.preventDefault(); });
			browser.addEventListener('dragleave', () => {
				if (--s.dragDepth <= 0) { s.dragDepth = 0; browser.classList.remove('drophot'); }
			});
			browser.addEventListener('drop', (e) => {
				e.preventDefault();
				s.dragDepth = 0;
				browser.classList.remove('drophot');
				this.startUploads(e.dataTransfer && e.dataTransfer.files);
			});
			this.renderFileList();

			return h('div', { class: 'stepL' },
				h('div', { class: 'stephead' }, h('span', { class: 'no' }, '01'), h('h3', null, 'Source')),
				s.filesError ? h('div', { class: 'errbanner', style: 'margin:0 0 12px' }, s.filesError) : null,
				browser,
				s.selected.length ? h('div', { class: 'selcard', style: 'align-items:flex-start' },
					h('div', { style: 'flex:1;min-width:0' },
						s.selected.map((f) => h('div', { class: 'selrow' },
							h('span', { class: 'fname', style: 'font-size:12.5px;flex:1' }, f.file),
							h('span', { class: 'fmeta', style: 'margin:0;flex-shrink:0' }, V.fmtBytes(f.sizeBytes)),
							h('button', { class: 'btn btn-sm btn-ghost', title: 'Remove from the selection',
								onclick: () => { s.selected = s.selected.filter((x) => x.file !== f.file); this.render(); } }, '✕'))),
						h('div', { class: 'hint', style: 'margin-top:7px' },
							s.selected.length > 1
								? s.selected.length + ' files — one job per file, all with the same analysis and options.'
								: 'Listed by extension (.mp4 · .m4v · .mov · .f4v) — the H.264 track is probed only when the job runs; an HEVC-only .mp4 submits fine and then fails as source_error.')),
					h('button', { class: 'btn btn-sm btn-ghost', style: 'flex-shrink:0', onclick: () => { s.selected = []; this.render(); } },
						s.selected.length > 1 ? 'Clear all' : 'Clear')) : null,
				// Sampling is a Custom-mode concern: with a stored config every knob
				// came back disabled and saying "from config" — three dead inputs.
				s.mode === 'custom' ? h('div', { class: 'hr2' }) : null,
				s.mode === 'custom' ? this.renderSampling() : null);
		},

		renderFileList() {
			const s = this.state;
			const el = clear(this.fileListEl);
			if (!s.files) { el.appendChild(h('div', { class: 'frow muted' }, 'Loading…')); return; }
			const list = (s.files.files || []).filter((f) => !s.filter || f.file.toLowerCase().includes(s.filter.toLowerCase()));
			if (!list.length) { el.appendChild(h('div', { class: 'frow muted' }, 'No analyzable files under the content root.')); return; }
			for (const f of list) {
				const picked = s.selected.some((x) => x.file === f.file);
				const toggle = () => {
					s.selected = picked ? s.selected.filter((x) => x.file !== f.file) : s.selected.concat([f]);
					this.render();
				};
				// A div, not a button: the row carries a Delete button of its own, and a
				// button cannot contain one.
				el.appendChild(h('div', { class: 'frow' + (picked ? ' sel' : ''), role: 'button', tabindex: '0',
					title: picked ? 'Click to remove from the selection' : 'Click to add to the selection',
					onclick: toggle,
					onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } } },
					h('span', { class: 'fck' }, picked ? '✓' : ''),
					h('span', { class: 'fn' }, f.file),
					h('span', { class: 'fs' }, V.fmtBytes(f.sizeBytes)),
					h('span', { class: 'fm' }, V.fmtClock(f.modifiedAt)),
					h('button', { class: 'btn btn-sm btn-ghost fdel', title: 'Delete this file from the Engine’s content directory',
						onclick: (e) => { e.stopPropagation(); this.deleteFile(f); } }, 'Delete')));
			}
		},

		/** DELETE /vod/files?file=…, after a confirm that says what the jobs list knows about the file. */
		async deleteFile(f) {
			const s = this.state;
			const gen = this.gen;
			let referencing = null;
			try { referencing = ((await api.listJobs({ limit: 1000 })).jobs || []).filter((j) => j.file === f.file); }
			catch (e) { /* no jobs list: the confirm goes without the count */ }
			if (gen !== V.gen) return;
			if (!window.confirm('Delete ' + f.file + ' (' + V.fmtBytes(f.sizeBytes) + ') from the content directory?\n\n'
				+ referencingJobs(referencing))) return;
			try {
				await api.deleteFile(f.file);
				toast('File deleted.');
			} catch (e) {
				if (e.status !== 404) { toast(e.message, 'err'); return; }
				toast('The file was already gone.', 'warn');
			}
			s.selected = s.selected.filter((x) => x.file !== f.file);
			try { s.files = await api.listFiles(); s.filesError = null; } catch (e) { /* keep the old listing */ }
			if (gen !== V.gen) return;
			this.render();
		},

		/* ---------- frame sampling (step 01, Custom mode only — a stored config
		   carries its own sampling, so the section does not render there) ---------- */

		renderSampling() {
			const s = this.state;
			const type = (s.config.detector || {}).type || '';
			const clipPath = type === 'synthetic';
			const p = s.config.processing || (s.config.processing = {});

			const heightVal = p.videoHeight === 0 || p.videoHeight === undefined ? 'MODEL'
				: p.videoHeight === -1 ? 'SOURCE' : 'CUSTOM';

			return h('div', null,
				h('div', { class: 'eyebrow', style: 'margin-bottom:9px' }, 'Frame Sampling'),
				h('div', { class: 'grid3' },
					h('div', { class: 'field' }, h('label', null, 'Inference FPS'),
						h('input', { class: 'input' + (clipPath ? ' dis' : ''), disabled: clipPath,
							value: p.inferenceFps ?? '', placeholder: 'default',
							oninput: (e) => { p.inferenceFps = e.target.value === '' ? undefined : parseInt(e.target.value, 10); this.updateJson(); } })),
					h('div', { class: 'field' }, h('label', null, 'Window (seconds)'),
						h('input', { class: 'input' + (type === 'object' ? ' dis' : ''), disabled: type === 'object',
							value: p.windowSeconds ?? '', placeholder: clipPath ? '2' : 'default',
							oninput: (e) => { p.windowSeconds = e.target.value === '' ? undefined : parseFloat(e.target.value); this.updateJson(); } })),
					h('div', { class: 'field' }, h('label', null, 'Inference height'),
						h('select', { class: 'input sel' + (clipPath ? ' dis' : ''), disabled: clipPath,
							onchange: (e) => {
								const v = e.target.value;
								p.videoHeight = v === 'MODEL' ? 0 : v === 'SOURCE' ? -1 : (p.videoHeight > 0 ? p.videoHeight : 720);
								this.render();
							} },
							h('option', { value: 'MODEL', selected: heightVal === 'MODEL' }, 'MODEL'),
							h('option', { value: 'SOURCE', selected: heightVal === 'SOURCE' }, 'SOURCE'),
							h('option', { value: 'CUSTOM', selected: heightVal === 'CUSTOM' }, 'CUSTOM')))),
				heightVal === 'CUSTOM' && !clipPath ? h('div', { class: 'field', style: 'margin-top:10px;max-width:160px' },
					h('label', null, 'Custom height (px)'),
					h('input', { class: 'input', value: p.videoHeight > 0 ? p.videoHeight : '',
						oninput: (e) => { p.videoHeight = parseInt(e.target.value, 10) || 0; this.updateJson(); } })) : null,
				h('p', { class: 'hint', style: 'margin:9px 0 0' },
					clipPath ? 'Synthetic analyzes keyframe-aligned clips — window length is the one sampling knob; FPS and height apply to frame-path types.'
						: 'Same fields as a live stream config, so a config tuned on live transfers to VOD unchanged. The Engine estimates total requests when the job starts.'));
		},

		/* ---------- step 02: analysis ---------- */

		renderAnalysis() {
			const s = this.state;
			const groups = V.store.groups || [];

			const seg = h('div', { class: 'seg' },
				h('button', { class: 'opt' + (s.mode === 'config' ? ' on' : ''), onclick: () => { s.mode = 'config'; this.render(); } }, 'Stored config'),
				h('button', { class: 'opt' + (s.mode === 'custom' ? ' on' : ''), onclick: () => { s.mode = 'custom'; this.render(); } }, 'Custom'));

			// Custom mode is parked for now: the toggle row is hidden, not removed —
			// the machinery stays wired, and unhiding is deleting one style.
			const body = [h('div', { style: 'display:none;gap:12px;align-items:center;margin-bottom:12px;flex-wrap:wrap' }, seg,
				h('span', { class: 'hint' }, 'the API takes ', h('span', { class: 'mono' }, 'stream_group_config'), ', ',
					h('span', { class: 'mono' }, 'config'), ' or both — this form sends one'))];

			if (s.mode === 'config') {
				if (!groups.length) {
					body.push(h('div', { class: 'empty', style: 'padding:24px 0' },
						'No stream configs on this Engine yet. Create one under ',
						h('a', { href: '#', onclick: (e) => {
							e.preventDefault();
							window.loadAjaxPluginContent('server', 'vif', 'stream-config.html', '');
						} }, 'Configs → Stream Configs'),
						', then come back.'));
				} else {
					const group = this.selectedGroup();
					body.push(h('div', { class: 'field', style: 'margin-bottom:12px' }, h('label', null, 'Config'),
						h('div', { style: 'display:flex;gap:8px;align-items:center' },
							h('select', { class: 'input sel', style: 'flex:1;min-width:0', onchange: (e) => { s.groupName = e.target.value; this.render(); } },
								groups.map((g) => {
									// Derived group names spell punctuation out (live_vlm_DotStar) —
									// label with the decoded match rule the way the Stream Configs
									// page shows it. The value stays the name, the API identity a
									// submit sends; the name is appended only to break a tie when
									// two groups share one rule.
									const type = (groupDetector(g) || {}).type;
									const m = g.match || {};
									const rule = m.application && m.streamPattern ? m.application + ' / ' + m.streamPattern : g.name;
									const dup = groups.some((o) => o !== g && o.match
										&& o.match.application === m.application && o.match.streamPattern === m.streamPattern);
									return h('option', { value: g.name, selected: g.name === s.groupName },
										rule + (dup ? ' (' + g.name + ')' : '') + (type ? ' · ' + type : ''));
								})),
							group ? h('button', { class: 'btn btn-sm', style: 'flex-shrink:0',
								title: 'Open this config in the Stream Configs editor — come back here when it is saved',
								onclick: () => V.openStreamConfig(group) }, 'Edit ↗') : null)));
					if (group) body.push(this.detectorCard(group));
				}
			} else {
				body.push(this.renderCustom());
			}

			return h('div', null,
				h('div', { class: 'stephead' }, h('span', { class: 'no' }, '02'), h('h3', null, 'Analysis')),
				body);
		},

		/** Read-only preview card: type badge, model tag, outputs manifest, threshold strip. */
		detectorCard(group) {
			const det = groupDetector(group) || {};
			const type = det.type || '';
			const meta = DETECTOR_META[type] || { badge: '?', name: type || 'unknown', desc: '', outs: '' };
			const endpoint = det.endpoint || {};
			const modelTag =
				type === 'object' ? (det.checkpointPath || det.model) :
				type === 'vlm' ? (endpoint.model || vlmDefaults().model) :
				type === 'synthetic' ? 'NVIDIA Maxine SVD' : null;
			const baselines = (V.store.defaults && V.store.defaults.detectors) || {};
			const threshold = type === 'synthetic'
				? (det.classificationThreshold
					?? (baselines.synthetic && baselines.synthetic.classificationThreshold))
				: null;
			// Which of the config's listeners a file job can serve, by the same set the custom
			// editor offers; the submit response's listener_warning is the authoritative answer.
			const vodCapable = new Set(LISTENER_DEFS.map((x) => x.type));
			const runs = [], flagged = [];
			for (const [name, l] of Object.entries((group.config && group.config.listeners) || {})) {
				(l && vodCapable.has(l.type) ? runs : flagged).push(name);
			}

			return h('div', { class: 'dcard' },
				h('div', { class: 'drow' },
					h('span', { class: 'dbadge' }, meta.badge),
					h('div', null,
						h('div', { class: 'dname' }, meta.name, modelTag ? h('span', { class: 'tag tag-n' }, modelTag) : null),
						h('div', { class: 'ddesc' }, meta.desc),
						h('div', { class: 'douts' }, meta.outs))),
				type === 'synthetic' ? h('div', { class: 'gstrip' },
					h('span', { class: 'gl' }, 'Verdict'),
					h('span', { class: 'gx' }, 'window is "synthetic" when score ≥ ' + (threshold ?? 'the classification_threshold'))) : null,
				h('div', { class: 'dfoot' }, runs.length || flagged.length
					? ['Listeners from this config: ',
						runs.join(' · '),
						runs.length && flagged.length ? ' · ' : null,
						flagged.length ? h('span', { class: 'dwarn' },
							flagged.join(' · ') + ' — skipped for file jobs; detections still land in the stored results') : null]
					: 'No event listeners configured — detections land in the stored results only.'));
		},

		renderCustom() {
			const s = this.state;
			const d = s.config.detector || (s.config.detector = { type: 'synthetic' });
			const type = d.type || 'synthetic';
			const typeSeg = h('div', { class: 'seg' }, ['object', 'scene', 'vlm', 'synthetic'].map((t) =>
				h('button', { class: 'opt' + (t === type ? ' on' : ''), onclick: () => {
					// A detector is atomic, so the type switch replaces the whole section;
					// sampling and listeners sit beside it and carry over. Rollup only
					// accumulates object detections, so it degrades to batch off that type.
					s.config.detector = t === 'vlm' ? { type: t, mode: 'detect' } : { type: t };
					if (t !== 'object') {
						for (const l of Object.values(s.config.listeners || {})) {
							if (l && l.trigger === 'rollup') l.trigger = 'batch';
						}
					}
					s.vlmModelOther = false;
					this.clearVlmVerify();
					s.jsonDraft = null;
					s.jsonDirty = false;
					this.render();
				} }, t)));

			const block = (obj, name) => obj[name] || (obj[name] = {});
			const txt = (obj, key, label, opts) => h('div', { class: 'field' }, h('label', null, label),
				h('input', Object.assign({ class: 'input', value: obj[key] ?? '',
					oninput: (e) => {
						const raw = e.target.value;
						obj[key] = raw === '' ? undefined
							: (opts && opts.num ? (raw.endsWith('.') ? raw : (isNaN(Number(raw)) ? raw : Number(raw))) : raw);
						this.updateJson();
					} }, opts && opts.attrs)));
			const grow = (el) => { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; };
			const area = (obj, key, label) => {
				const ta = h('textarea', { class: 'input', value: obj[key] ?? '', spellcheck: 'false',
					oninput: (e) => { obj[key] = e.target.value === '' ? undefined : e.target.value; grow(e.target); this.updateJson(); } });
				// Fit prefilled content once attached — scrollHeight reads 0 while detached.
				requestAnimationFrame(() => { if (ta.offsetParent) grow(ta); });
				return h('div', { class: 'field' }, h('label', null, label), ta);
			};
			const classNames = (obj) => h('div', { class: 'field' }, h('label', null, 'Class names (comma-separated)'),
				h('input', { class: 'input', value: (obj.classes || []).join(', '),
					oninput: (e) => {
						const arr = e.target.value.split(',').map((x) => x.trim()).filter(Boolean);
						obj.classes = arr.length ? arr : undefined;
						this.updateJson();
					} }));

			let fields = null;
			if (type === 'object') {
				fields = h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
					classNames(d),
					h('div', { class: 'grid2' },
						h('div', { class: 'field' }, h('label', null, 'Model'),
							h('select', { class: 'input sel', onchange: (e) => { d.model = e.target.value || undefined; this.updateJson(); } },
								h('option', { value: '', selected: !d.model }, 'default'),
								['nano', 'small', 'medium', 'large'].map((m) =>
									h('option', { value: m, selected: d.model === m }, m)))),
						txt(d, 'minConfidence', 'Confidence threshold', { num: true })),
					txt(d, 'checkpointPath', 'Checkpoint path'),
					h('p', { class: 'hint', style: 'margin:0' },
						'A checkpoint path is custom weights on the VIS host, and overrides the model above.'));
			} else if (type === 'scene') {
				fields = h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
					classNames(d),
					h('div', { class: 'grid2' },
						txt(d, 'minConfidence', 'Confidence threshold', { num: true }),
						txt(d, 'sensitivity', 'Sensitivity', { num: true })));
			} else if (type === 'vlm') {
				const endpoint = block(d, 'endpoint');
				const generation = block(d, 'generation');
				const globals = vlmDefaults();
				const mode = d.mode || (d.mode = 'detect');
				const modelOptions = (window.VIF.fieldRegistry && VIF.fieldRegistry.VLM_MODEL_OPTIONS) || [];
				const known = modelOptions.map((o) => o.value);
				const isOther = s.vlmModelOther || (endpoint.model !== undefined && !known.includes(endpoint.model));

				const modeSeg = h('div', { class: 'field' }, h('label', null, 'Mode'),
					h('div', { class: 'seg' }, ['detect', 'describe', 'custom'].map((m) =>
						h('button', { class: 'opt' + (m === mode ? ' on' : ''), onclick: () => { d.mode = m; this.render(); } }, m))));

				const modelField = h('div', { class: 'field' }, h('label', null, 'Model'),
					h('select', { class: 'input sel', onchange: (e) => {
						const v = e.target.value;
						if (v === '__other__') s.vlmModelOther = true;
						else { s.vlmModelOther = false; endpoint.model = v || undefined; }
						this.clearVlmVerify();
						this.render();
					} },
						h('option', { value: '', selected: !isOther && endpoint.model === undefined },
							'default' + (globals.model ? ' (' + globals.model + ')' : '')),
						modelOptions.map((o) => h('option', { value: o.value, selected: !isOther && endpoint.model === o.value }, o.label)),
						h('option', { value: '__other__', selected: isOther }, 'Other…')),
					isOther ? h('input', { class: 'input', style: 'margin-top:6px', placeholder: 'org/model-name',
						value: endpoint.model ?? '',
						oninput: (e) => { endpoint.model = e.target.value === '' ? undefined : e.target.value; this.clearVlmVerify(); this.updateJson(); } }) : null);

				const endpointField = h('div', { class: 'field' }, h('label', null, 'Endpoint URL'),
					h('input', { class: 'input', value: endpoint.url ?? '', placeholder: globals.url || 'default',
						oninput: (e) => { endpoint.url = e.target.value === '' ? undefined : e.target.value; this.clearVlmVerify(); this.updateJson(); },
						onblur: (e) => {
							const norm = normalizeVlmEndpoint(e.target.value);
							if (norm && norm !== e.target.value) { e.target.value = norm; endpoint.url = norm; this.updateJson(); }
						} }));

				const detect = mode === 'detect' ? block(d, 'detect') : null;
				const prompt = mode === 'custom' ? block(block(d, 'custom'), 'prompt') : null;
				const busy = s.vlmVerify && s.vlmVerify.cls === 'busy';
				this.vlmVerifyEl = s.vlmVerify ? h('div', { class: 'vlmtest ' + s.vlmVerify.cls }, s.vlmVerify.text) : null;

				fields = h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
					h('div', { class: 'grid2' }, modelField, endpointField),
					h('div', { class: 'grid2' },
						h('div', { class: 'field' }, h('label', null, 'API key'),
							h('input', { class: 'input', type: 'password', autocomplete: 'off', value: endpoint.apiKey ?? '',
								oninput: (e) => { endpoint.apiKey = e.target.value === '' ? undefined : e.target.value; this.clearVlmVerify(); this.updateJson(); } })),
						modeSeg),
					detect ? classNames(detect) : null,
					detect ? h('div', { class: 'field' }, h('label', null, 'Reasoning level'),
						h('select', { class: 'input sel', onchange: (e) => { detect.reasoningLevel = e.target.value || undefined; this.updateJson(); } },
							h('option', { value: '', selected: !detect.reasoningLevel }, 'default'),
							['low', 'medium', 'high'].map((m) => h('option', { value: m, selected: detect.reasoningLevel === m }, m)))) : null,
					h('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
						h('button', { class: 'btn btn-sm', disabled: busy || null,
							title: 'The Engine probes <endpoint>/models — the browser can’t reach compose-internal hostnames',
							onclick: () => this.verifyVlmEndpoint() }, busy ? 'Verifying…' : 'Verify endpoint'),
						h('span', { class: 'hint' }, 'Checks the endpoint from the Engine; a single served model is adopted into the form.')),
					this.vlmVerifyEl,
					prompt ? area(prompt, 'user', 'User prompt') : null,
					prompt ? area(prompt, 'system', 'System prompt') : null,
					prompt ? h('p', { class: 'hint', style: 'margin:0' },
						'A response schema is a whole JSON document — set it in the Advanced JSON below, as custom.responseSchema.') : null,
					mode === 'describe' ? h('p', { class: 'hint', style: 'margin:0' },
						'Describe mode has no settings of its own: the model narrates each window in its own words.') : null,
					h('div', { class: 'grid2' },
						txt(generation, 'maxTokens', 'Max tokens', { num: true }),
						txt(generation, 'temperature', 'Temperature', { num: true })),
					h('p', { class: 'hint', style: 'margin:0' },
						'Inline credentials are never written to disk on the Engine — a resume of this job will ask for them again.'));
			} else {
				const endpoint = block(d, 'endpoint');
				fields = h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
					h('div', { class: 'grid2' },
						txt(endpoint, 'address', 'Endpoint'),
						txt(endpoint, 'functionId', 'Function ID')),
					h('div', { class: 'grid2' },
						txt(endpoint, 'apiKey', 'API key', { attrs: { type: 'password', autocomplete: 'off' } }),
						txt(d, 'classificationThreshold', 'Classification threshold', { num: true })),
					h('label', { class: 'hint', style: 'display:flex;gap:7px;align-items:center' },
						h('input', { type: 'checkbox', checked: (endpoint.tls && endpoint.tls.enabled) === true ? 'checked' : null,
							onchange: (e) => { endpoint.tls = e.target.checked ? { enabled: true } : undefined; this.updateJson(); } }),
						'Use TLS to the SVD endpoint'),
					h('p', { class: 'hint', style: 'margin:0' },
						'Unset fields inherit the Engine’s default config. Inline credentials are never written to disk.'));
			}

			// Hand-typed JSON survives every re-render until it is applied or the type changes.
			// The dirty affordances flip live in the input handler — a full render here would
			// rebuild the DOM and throw the user out of the textarea mid-typing.
			const DIRTY_HINT = 'Unapplied edits — the form and submit ignore them until you Apply.';
			const CLEAN_HINT = 'Any Config field works here, not just the essentials above.';
			const discardBtn = h('button', { class: 'btn btn-sm btn-ghost', disabled: !s.jsonDirty,
				onclick: () => { s.jsonDraft = null; s.jsonDirty = false; this.render(); } }, 'Discard edits');
			const jsonHint = h('span', { class: 'hint' }, s.jsonDirty ? DIRTY_HINT : CLEAN_HINT);
			this.jsonArea = h('textarea', { class: 'input mono', spellcheck: 'false', style: 'min-height:150px;font-size:11px',
				oninput: (e) => {
					s.jsonDraft = e.target.value;
					if (!s.jsonDirty) { s.jsonDirty = true; discardBtn.disabled = false; jsonHint.textContent = DIRTY_HINT; }
				} });
			this.jsonArea.value = s.jsonDirty && s.jsonDraft !== null ? s.jsonDraft : JSON.stringify(this.prunedConfig(), null, 2);

			const json = h('details', { open: s.jsonOpen ? '' : null },
				h('summary', { class: 'hint', style: 'cursor:pointer' }, 'Advanced JSON — the config this job will be submitted with'),
				h('div', { style: 'display:flex;flex-direction:column;gap:8px;margin-top:8px' },
					this.jsonArea,
					h('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
						h('button', { class: 'btn btn-sm', onclick: () => {
							try {
								// fromWire also accepts a document pasted in the API's own
								// spelling; a camelCase one passes through unchanged.
								s.config = VIF.sdk.fromWire(JSON.parse(this.jsonArea.value));
								// The JSON is authoritative; the form re-infers its VLM affordances from it.
								s.vlmModelOther = false;
								this.clearVlmVerify();
								s.jsonDraft = null;
								s.jsonDirty = false;
								this.render();
								toast('Config JSON applied to the form.');
							} catch (e) { toast('Not valid JSON: ' + e.message, 'err'); }
						} }, 'Apply JSON to form'),
						discardBtn,
						jsonHint)));
			json.addEventListener('toggle', () => { s.jsonOpen = json.open; });

			return h('div', { style: 'display:flex;flex-direction:column;gap:13px' },
				h('div', { class: 'field' }, h('label', null, 'Detector type'), typeSeg),
				fields,
				this.renderListeners(),
				json);
		},

		/* ---------- listeners (custom mode) ---------- */

		renderListeners() {
			const s = this.state;
			const type = (s.config.detector || {}).type || 'synthetic';
			const listeners = s.config.listeners || {};
			const available = V.store.listenerTypes;
			const entryOf = (def) => Object.entries(listeners).find(([, l]) => l && l.type === def.type);

			const rows = LISTENER_DEFS.map((def) => {
				if (available && !available.some((known) => known.name === def.cls)) return null;
				const hit = entryOf(def);
				const entry = hit && hit[1];
				const trigger = (entry && entry.trigger) || def.defTrigger;
				const triggers = type === 'object' ? ['immediate', 'batch', 'rollup'] : ['immediate', 'batch'];
				const opts = triggers.includes(trigger) ? triggers : triggers.concat([trigger]);
				return h('div', { class: 'checkrow', style: 'padding:6px 0' },
					h('input', { type: 'checkbox', checked: entry ? 'checked' : null,
						onchange: (e) => {
							const map = s.config.listeners || (s.config.listeners = {});
							if (e.target.checked) {
								let key = hit ? hit[0] : def.key;
								// an unrelated pasted listener may sit under the reserved key —
								// claim a free key rather than clobbering it
								if (!hit) { let n = 2; while (map[key]) key = def.key + String(n++); }
								map[key] = { type: def.type, trigger: trigger };
							} else {
								delete map[hit ? hit[0] : def.key];
								if (!Object.keys(map).length) delete s.config.listeners;
							}
							this.render();
						} }),
					h('div', { style: 'flex:1' },
						h('div', { class: 'ol' }, def.label,
							entry ? h('select', { class: 'input sel', style: 'width:auto;display:inline-block;margin-left:10px;font-size:11.5px;padding:2px 26px 2px 8px',
								title: 'When the listener fires',
								onchange: (e) => { entry.trigger = e.target.value; this.updateJson(); } },
								opts.map((m) => h('option', { value: m, selected: m === trigger }, m))) : null),
						h('div', { class: 'oh' }, def.hint)));
			}).filter(Boolean);

			const managed = new Set(LISTENER_DEFS.map((x) => x.type));
			const others = Object.entries(listeners)
				.filter(([, l]) => !l || !managed.has(l.type)).map(([k]) => k);

			return h('div', null,
				h('div', { class: 'eyebrow', style: 'margin-bottom:4px' }, 'Listeners'),
				rows.length ? rows : h('p', { class: 'hint' }, 'This Engine reports no VOD-capable listeners.'),
				others.length ? h('p', { class: 'hint', style: 'margin:4px 0 0' },
					'Also from the JSON: ' + others.join(' · ') + ' — managed in the Advanced JSON only; live-stream outputs (overlay, ID3) are auto-skipped for file jobs.') : null,
				h('p', { class: 'hint', style: 'margin:6px 0 0' },
					'Detections always land in the stored results — listeners are extra outputs. They’re recorded verbatim in the job’s options, so keep secrets out of listener properties.'));
		},

		updateJson() {
			const s = this.state;
			if (this.jsonArea && !s.jsonDirty && document.activeElement !== this.jsonArea)
				this.jsonArea.value = JSON.stringify(this.prunedConfig(), null, 2);
		},

		/* ---------- VLM endpoint verification (custom mode) ---------- */

		/** Drops a shown probe result. Direct DOM, no render(): this runs from input
		    handlers, and a re-render mid-typing would throw the user out of the field. */
		clearVlmVerify() {
			this.vlmVerifySeq = (this.vlmVerifySeq || 0) + 1; // an in-flight probe is now stale
			if (!this.state.vlmVerify) return;
			this.state.vlmVerify = null;
			if (this.vlmVerifyEl) { this.vlmVerifyEl.style.display = 'none'; this.vlmVerifyEl = null; }
		},

		async verifyVlmEndpoint() {
			const s = this.state;
			const detector = s.config.detector || (s.config.detector = { type: 'vlm', mode: 'detect' });
			const b = detector.endpoint || (detector.endpoint = {});
			const globals = vlmDefaults();
			const url = normalizeVlmEndpoint(b.url) || globals.url || null;
			if (!url) {
				s.vlmVerify = { cls: 'err', text: '✗ No VLM endpoint configured — type one here or set the default config’s.' };
				this.render();
				return;
			}
			// Only this form's key: the API never echoes a stored one, and never sends a stored
			// one to a URL the caller supplied.
			const apiKey = b.apiKey || '';
			const gen = this.gen;
			const seq = this.vlmVerifySeq = (this.vlmVerifySeq || 0) + 1;
			s.vlmVerify = { cls: 'busy', text: 'Verifying ' + url + '…' };
			this.render();
			let result;
			try {
				result = await api.vlmTest(url, apiKey);
			} catch (e) {
				result = { reachable: false, error: e.message };
			}
			if (gen !== V.gen || seq !== this.vlmVerifySeq) return; // left the view, or edited the fields mid-probe
			s.vlmVerify = this.vlmVerifyOutcome(result, b, globals);
			this.render();
		},

		/** The live editor's reading of the probe: match → ok; exactly one served model → adopt it. */
		vlmVerifyOutcome(result, b, globals) {
			const models = Array.isArray(result.models) ? result.models : [];
			if (result.reachable && models.length) {
				const configured = b.model || globals.model;
				if (configured && models.includes(configured))
					return { cls: 'ok', text: '✓ Reachable — serving: ' + models.join(', ') + ' (matches the configured model)' };
				if (models.length === 1) {
					b.model = models[0];
					this.state.vlmModelOther = false; // render infers Other for a model outside the list
					return { cls: 'warn', text: '⚠ Reachable — serving: ' + models[0] + '; the configured model ('
						+ (configured || 'unset') + ') did not match, so the form was updated.' };
				}
				return { cls: 'warn', text: '⚠ Reachable — serving: ' + models.join(', ') + ', which does not match the '
					+ 'configured model (' + (configured || 'unset') + '). Pick one of the served models.' };
			}
			if (result.reachable)
				return { cls: 'warn', text: '⚠ ' + (result.error || 'Endpoint reachable but returned no models') };
			return { cls: 'err', text: '✗ ' + (result.error || 'Endpoint unreachable') };
		},

		/* ---------- step 03: outputs & options ---------- */

		/* Authorization for a custom destination: pick a name from the secrets document; the
		   value rides only the deliveries, never the submit body or the job record. */
		secretPicker() {
			const s = this.state;
			const names = V.store.secretNames || [];
			if (!names.length) {
				if (s.webhookSecret) s.webhookSecret = '';
				return h('span', null, 'To authenticate deliveries, add a named secret on the settings page and pick it here.');
			}
			if (s.webhookSecret && !names.includes(s.webhookSecret)) s.webhookSecret = '';
			return h('select', { class: 'input', style: 'max-width:360px;font-size:11.5px', onchange: (e) => { s.webhookSecret = e.target.value; } },
				h('option', { value: '' }, 'No Authorization secret'),
				names.map((n) => h('option', { value: n, selected: s.webhookSecret === n ? 'selected' : null }, n)));
		},

		renderOutputs() {
			const s = this.state;
			const globalHook = V.store.vodSettings && V.store.vodSettings.lifecycleWebhook;
			const tri = (value, set) => h('div', { class: 'seg', style: 'transform:scale(.92);transform-origin:left center' },
				[['inherit', 'Inherit global'], ['custom', 'Custom'], ['off', 'Off']].map(([v, label]) =>
					h('button', { class: 'opt' + (value === v ? ' on' : ''), onclick: () => { set(v); this.render(); } }, label)));

			return h('div', null,
				h('div', { class: 'stephead' }, h('span', { class: 'no' }, '03'), h('h3', null, 'Outputs & options')),
				h('div', { class: 'checkrow' },
					h('input', { type: 'checkbox', checked: s.storeResults ? 'checked' : null, onchange: (e) => { s.storeResults = e.target.checked; this.render(); } }),
					h('div', null, h('div', { class: 'ol' }, 'Store results (JSONL)'),
						h('div', { class: 'oh' }, s.storeResults
							? 'Every analysis response kept raw and media-time-stamped; pageable, downloadable, readable while running.'
							: 'Status-only job: nothing for the results endpoint to serve, and no resume point.'))),
				h('div', { class: 'checkrow' },
					h('div', { style: 'width:15px' }),
					h('div', { style: 'flex:1' }, h('div', { class: 'ol' }, 'Lifecycle webhook'),
						h('div', { class: 'oh', style: 'display:flex;flex-direction:column;gap:7px;margin-top:6px' },
							tri(s.webhookMode, (v) => { s.webhookMode = v; }),
							s.webhookMode === 'inherit' ? h('span', null, globalHook ? 'Global destination: ' + globalHook : 'No global webhook is configured — inherit means none.') : null,
							s.webhookMode === 'custom' ? h('input', { class: 'input', style: 'max-width:360px;font-size:11.5px', placeholder: 'https://…', value: s.webhookUrl, oninput: (e) => { s.webhookUrl = e.target.value; } }) : null,
							s.webhookMode === 'custom' ? this.secretPicker() : null,
							s.webhookMode === 'custom' ? h('span', null, 'A per-job URL is stored in the job’s manifest on disk — don’t embed tokens in it; a named secret sends the Authorization header without the value ever touching the job record.') : null,
							s.webhookMode === 'off' ? h('span', null, 'Sends "" — this job posts no lifecycle notifications.') : null))),
				h('div', { class: 'checkrow' },
					h('div', { style: 'width:15px' }),
					h('div', null, h('div', { class: 'ol' }, 'Auto-resume'),
						h('div', { class: 'oh', style: 'margin-top:6px' },
							tri(s.autoResume === 'on' ? 'custom' : s.autoResume, (v) => { s.autoResume = v === 'custom' ? 'on' : v; }),
							h('div', { style: 'margin-top:5px' }, 'Transient failures retry on a backoff, up to 3 attempts; the counter resets on progress. "Custom" forces it on for this job.')))),
				h('div', { class: 'checkrow' },
					h('div', { style: 'width:15px' }),
					h('div', null, h('div', { class: 'ol' }, 'Tag'),
						h('div', { class: 'oh', style: 'margin-top:6px' },
							h('input', { class: 'input', style: 'max-width:220px;font-size:11.5px', placeholder: 'nightly', value: s.tag, oninput: (e) => { s.tag = e.target.value; } }),
							h('div', { style: 'margin-top:4px' }, 'Free-form label · exact-match filter on the jobs list.')))));
		},

		/* ---------- assembly ---------- */

		render() {
			const s = this.state;
			const root = clear(this.root);
			// Forward actions live top right (the jobs view's New Analysis button);
			// going back is a crumb top left, the same as the report page.
			root.appendChild(h('div', { class: 'phead' },
				h('div', null,
					h('a', { class: 'crumb', href: '#',
						onclick: (e) => { e.preventDefault(); V.nav('jobs'); } }, '← On-Demand Jobs'),
					h('h2', null, 'New Analysis'))));
			root.appendChild(h('div', { class: 'rule2' }));
			if (s.submitError) root.appendChild(h('div', { class: 'errbanner', style: 'margin-top:14px' }, s.submitError));
			// inert while submitting: the batch is frozen at submit, so the form must not
			// suggest that edits or selection changes could still reach it.
			root.appendChild(h('div', { class: 'steps', inert: s.submitting ? 'true' : null },
				this.renderSource(),
				h('div', { class: 'stepR' }, this.renderAnalysis(), h('div', { class: 'hr2' }), this.renderOutputs())));
			const n = s.selected.length;
			// The bar states only what has news: a queue notice when jobs are
			// actually ahead, nothing when the analysis would start right away.
			// The endpoint trivia lives on the buttons (JSON view, Start tooltip).
			root.appendChild(h('div', { class: 'footbar' },
				s.queueDepth ? h('div', { class: 'fstat' }, h('div', { class: 'fl' }, 'Queue'),
					h('div', { class: 'fv' }, s.queueDepth + ' job' + (s.queueDepth === 1 ? '' : 's') + ' ahead of ' + (n > 1 ? 'these' : 'this one') + '; starts when a worker frees up')) : null,
				h('div', { class: 'sp' },
					h('button', { class: 'btn', onclick: () => modal('Request JSON' + (n > 1 ? ' — one job per file' : ''), h('pre', null, JSON.stringify(this.requestPreview(), null, 2))) }, 'View request JSON'),
					h('button', { class: 'btn btn-pri', disabled: s.submitting,
						title: 'POST /v2/vif/vod/jobs' + (n > 1 ? ' × ' + n : '') + '\nRuns in the background; the jobs list tracks progress.',
						onclick: () => this.submit() },
						s.submitting ? 'Submitting…' : (n > 1 ? 'Start ' + n + ' analyses' : 'Start analysis')))));
		},
	};

	V.views = V.views || {};
	V.views.new = view;
})(window.VIF.vod);
