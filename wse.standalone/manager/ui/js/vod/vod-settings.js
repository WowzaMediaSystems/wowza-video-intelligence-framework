/* VOD settings — the /persist/vod-settings document and the /persist/secrets document beside
   it. Both are revisioned: a save sends a merge patch of the fields the form changed, quoting
   the revision it read them at. The standalone experiment's connection panel is gone: in the
   Manager the connection comes from the chrome via VIF.core.resolveServer(). */
window.VIF = window.VIF || {};
VIF.vod = VIF.vod || {};
(function (V) {
	'use strict';
	const { h, clear, api, toast } = V;

	const view = {
		async mount(root) {
			this.root = root;
			this.gen = V.gen = (V.gen || 0) + 1;
			this.loaded = null;
			this.secretNames = null;
			this.error = null;
			this.secretsState = null;
			this.render();
			try {
				const [settings, names] = await Promise.all([api.vodSettings(), api.secretNames()]);
				this.loaded = settings;
				this.secretNames = names;
			} catch (e) {
				this.error = e.message;
			}
			if (this.gen !== V.gen) return; // the user left this view while we were loading
			this.render();
		},

		destroy() {},

		render() {
			const root = clear(this.root);
			root.appendChild(h('div', { class: 'phead' },
				h('div', null, h('h2', null, 'On-Demand Configs')),
				h('div', { class: 'sp' },
					h('button', { class: 'btn', onclick: () => V.nav('jobs') }, '← On-Demand Jobs'))));
			root.appendChild(h('div', { class: 'rule2' }));
			root.appendChild(h('div', { class: 'setgrid one' }, this.renderVod(), this.renderSecrets()));
		},

		/* Webhook secrets — named Authorization values a submit references by name. Values are
		   never redisplayed here: an input is a rotation, blank means keep, and a deletion sends
		   the name as null, which is how a merge patch removes it. */
		renderSecrets() {
			if (this.error || !this.loaded) return null;
			const stored = this.secretNames || [];
			const st = this.secretsState || (this.secretsState = { edits: {}, removed: {}, adds: [] });
			const redraw = () => this.render();

			const existingRow = (name) => {
				const gone = !!st.removed[name];
				return h('div', { style: 'display:flex;gap:7px;align-items:center' },
					h('span', { class: 'k', style: 'min-width:150px;overflow-wrap:anywhere' + (gone ? ';text-decoration:line-through;opacity:.55' : '') }, name),
					gone ? h('span', { class: 'hint', style: 'flex:1;margin:0' }, 'deleted on save')
						: h('input', { class: 'input', type: 'password', autocomplete: 'new-password', style: 'flex:1',
							placeholder: '(unchanged — type to rotate)', value: st.edits[name] || '',
							oninput: (e) => { st.edits[name] = e.target.value; } }),
					h('button', { class: 'btn', onclick: () => { st.removed[name] = !gone; if (!gone) delete st.edits[name]; redraw(); } }, gone ? 'Keep' : 'Delete'));
			};
			const addRow = (row, i) => h('div', { style: 'display:flex;gap:7px;align-items:center' },
				h('input', { class: 'input', style: 'min-width:150px;max-width:150px', placeholder: 'name', value: row.name, oninput: (e) => { row.name = e.target.value; } }),
				h('input', { class: 'input', type: 'password', autocomplete: 'new-password', style: 'flex:1', placeholder: 'Authorization value — "Bearer …" or an ${ENV_VAR} placeholder', value: row.value, oninput: (e) => { row.value = e.target.value; } }),
				h('button', { class: 'btn', onclick: () => { st.adds.splice(i, 1); redraw(); } }, 'Drop'));

			return h('div', { class: 'setcard' },
				h('div', { class: 'eyebrow' }, 'Webhook secrets — the secrets document'),
				h('p', { class: 'hint', style: 'margin:0 0 8px' },
					'Named Authorization values a job references at submit (lifecycle_webhook_secret) to authenticate its own webhook destination — the job record keeps the name only. Any client that can submit jobs can direct any named secret at a URL of its choosing, so file webhook credentials here and nothing else.'),
				stored.length ? h('div', { style: 'display:flex;flex-direction:column;gap:7px' }, stored.map(existingRow))
					: h('p', { class: 'hint', style: 'margin:0' }, 'No secrets configured.'),
				st.adds.length ? h('div', { style: 'display:flex;flex-direction:column;gap:7px;margin-top:7px' }, st.adds.map(addRow)) : null,
				h('div', { style: 'display:flex;gap:7px;margin-top:8px' },
					h('button', { class: 'btn', onclick: () => { st.adds.push({ name: '', value: '' }); redraw(); } }, 'Add secret'),
					h('button', { class: 'btn btn-pri', onclick: () => this.saveSecrets() }, 'Save secrets')));
		},

		async saveSecrets() {
			const st = this.secretsState;
			if (!st) return;
			const stored = this.secretNames || [];
			const values = {};
			const referenced = this.loaded.lifecycleWebhookSecret;
			for (const name of Object.keys(st.removed)) {
				if (!st.removed[name]) continue;
				// The server refuses this save too (a dangling global reference is a 400);
				// catching it here just gives the reason a face.
				if (name === referenced) { toast('"' + name + '" is the global webhook secret — clear that setting first.', 'err'); return; }
				values[name] = null;
			}
			for (const [name, value] of Object.entries(st.edits)) {
				if (st.removed[name]) continue;
				if (value.trim()) values[name] = value.trim();
			}
			for (const row of st.adds) {
				const name = row.name.trim();
				if (!name && !row.value.trim()) continue;
				if (!name || !row.value.trim()) { toast('A new secret needs both a name and a value.', 'err'); return; }
				if (stored.includes(name) || Object.prototype.hasOwnProperty.call(values, name)) { toast('Secret "' + name + '" is already defined — rotate it on its own row.', 'err'); return; }
				values[name] = row.value.trim();
			}
			if (!Object.keys(values).length) { toast('Nothing changed.'); return; }
			try {
				this.secretNames = V.store.secretNames = (await api.secrets().update({ values })).names;
				this.secretsState = null;
				toast('Secrets saved.');
				this.render();
			} catch (e) { toast(e.message, 'err'); }
		},

		renderVod() {
			if (this.error) return h('div', { class: 'setcard' }, h('div', { class: 'eyebrow' }, 'VOD settings'), h('div', { class: 'errbanner', style: 'margin:0' }, this.error));
			if (!this.loaded) return h('div', { class: 'setcard' }, h('div', { class: 'eyebrow' }, 'VOD settings'), h('p', { class: 'hint' }, 'Loading…'));

			const vod = this.loaded;
			const edited = {}; // raw values as typed; parsed and validated at save
			// Placeholders are the Engine's actual defaults (VodSettingsResolver / job TTL off).
			const num = (key, label, hint, defaultValue) => h('div', { class: 'field' }, h('label', null, label),
				h('input', { class: 'input', value: vod[key] ?? '', placeholder: defaultValue,
					oninput: (e) => { edited[key] = e.target.value; } }),
				hint ? h('span', { class: 'hint' }, hint) : null);
			const str = (key, label, hint, type) => h('div', { class: 'field' }, h('label', null, label),
				h('input', { class: 'input', type: type || 'text', value: vod[key] ?? '', autocomplete: 'off',
					oninput: (e) => { edited[key] = e.target.value; } }),
				hint ? h('span', { class: 'hint' }, hint) : null);
			// A name from the secrets document below, not a value: the picker offers what is
			// saved there, and clearing sends "" (the document's usual off switch).
			const secretNames = this.secretNames || [];
			const sel = (key, label, hint) => h('div', { class: 'field' }, h('label', null, label),
				h('select', { class: 'input', onchange: (e) => { edited[key] = e.target.value; } },
					h('option', { value: '' }, secretNames.length ? '(none)' : '(none — add a webhook secret below first)'),
					secretNames.map((n) => h('option', { value: n, selected: (vod[key] || '') === n ? 'selected' : null }, n))),
				hint ? h('span', { class: 'hint' }, hint) : null);
			const autoResume = h('label', { class: 'hint', style: 'display:flex;gap:7px;align-items:center' },
				h('input', { type: 'checkbox', checked: vod.autoResume === false ? null : 'checked',
					onchange: (e) => { edited.autoResume = e.target.checked; } }),
				'Auto-resume transiently failed jobs (up to 3 attempts, counter resets on progress)');

			return h('div', { class: 'setcard' },
				h('div', { class: 'eyebrow' }, 'VOD settings — the vod-settings document'),
				h('div', { class: 'grid2' },
					num('maxConcurrentJobs', 'Concurrent jobs', 'worker pool; applies immediately; blank keeps the current value', '1'),
					num('maxJobs', 'Jobs kept', 'oldest finished evicted past the cap; blank keeps the current value', '25')),
				num('jobTtlSeconds', 'Job TTL (seconds)', 'forget finished jobs this long after they end; empty or 0 = off', '0 (off)'),
				num('maxUploadBytes', 'Max upload size (bytes)', 'a larger upload is refused with 413; blank keeps the current value', '10737418240 (10 GiB)'),
				str('lifecycleWebhook', 'Global lifecycle webhook', 'default status-webhook destination for every job'),
				sel('lifecycleWebhookSecret', 'Webhook Authorization secret', 'a webhook secret (below) sent only to the global destination above — per-job URLs name their own at submit'),
				autoResume,
				h('div', null, h('button', { class: 'btn btn-pri', onclick: async () => {
					const NUMERIC = ['maxConcurrentJobs', 'maxJobs', 'jobTtlSeconds', 'maxUploadBytes'];
					const changed = {};
					for (const [k, v] of Object.entries(edited)) {
						if (typeof v === 'boolean' || !NUMERIC.includes(k)) { changed[k] = v; continue; }
						const raw = String(v).trim();
						if (raw === '') {
							// The patch carries only what changed, so a blank sends nothing —
							// except the TTL, whose documented off switch is an explicit 0.
							if (k === 'jobTtlSeconds') changed[k] = 0;
							continue;
						}
						const n = parseInt(raw, 10);
						if (Number.isNaN(n) || n < 0) { toast(k + ' must be a whole number.', 'err'); return; }
						changed[k] = n;
					}
					if (!Object.keys(changed).length) { toast('Nothing changed.'); return; }
					try {
						Object.assign(this.loaded, changed);
						await this.loaded.save();
						toast('Saved. Caps apply immediately; directories wait for a restart.');
						this.render();
					} catch (e) { toast(e.message, 'err'); }
				} }, 'Save vod settings')),
				h('div', { style: 'margin-top:6px;display:flex;flex-direction:column;gap:5px' },
					h('div', { class: 'eyebrow' }, 'Restart-only'),
					h('div', { class: 'lockrow' }, h('span', { class: 'k' }, 'content_dir'), h('span', { class: 'v' }, vod.contentDir || '(default: Engine content/)')),
					h('div', { class: 'lockrow' }, h('span', { class: 'k' }, 'jobs_dir'), h('span', { class: 'v' }, vod.jobsDir || '(default: Engine vif-vod-jobs/)')),
					h('p', { class: 'hint', style: 'margin:2px 0 0' }, 'Moving either under running jobs would strand them, so the Engine applies directory changes at the next start. Edit them by patching the settings document, or in its file.')));
		},
	};

	V.views = V.views || {};
	V.views.settings = view;
})(window.VIF.vod);
