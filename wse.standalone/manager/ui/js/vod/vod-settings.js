/* VOD settings — the /persist/vod-settings document. Revisioned: a save sends a merge patch of
   the fields the form changed, quoting the revision it read them at. The secrets document is
   global now (it holds endpoint and service credentials too) and is edited on the chrome's own
   Secrets page; this view only reads the names for the webhook-secret picker. The standalone
   experiment's connection panel is gone: in the Manager the connection comes from the chrome
   via VIF.core.resolveServer(). */
window.VIF = window.VIF || {};
VIF.vod = VIF.vod || {};

/**
 * The lifecycle test-fire request for what the form shows, or a reason it cannot be sent.
 * Unchanged settings go without a url, so the Engine tests what it actually sends to:
 * the saved destination with its ${ENV} placeholder resolved. An edited destination goes as
 * typed with the credential beside it — except one still carrying a placeholder, which only
 * the saved settings resolve.
 *
 * @returns {{request?: object, refusal?: string}}
 */
VIF.vod.lifecycleTestRequest = function (form, stored) {
    const trim = (value) => (value == null ? '' : String(value).trim());
    const shown = { url: trim(form.url), secret: trim(form.secret), header: trim(form.header) };
    if (!shown.url) {
        return { refusal: 'Set a Destination URL first.' };
    }
    const saved = { url: trim(stored.url), secret: trim(stored.secret), header: trim(stored.header) };
    if (shown.url === saved.url && shown.secret === saved.secret && shown.header === saved.header) {
        return { request: {} };
    }
    if (shown.url.indexOf('${') !== -1) {
        return { refusal: 'Save first to test this destination: a ${…} placeholder is resolved only from saved settings.' };
    }
    const request = { url: shown.url };
    if (shown.secret) request.credentialSecret = shown.secret;
    if (shown.header) request.credentialHeader = shown.header;
    return { request: request };
};

/**
 * Saves the edits through the loaded settings document, which the SDK saves from its own
 * members. A refused save puts them back, so the page never takes unsaved values for saved
 * ones; the form keeps showing what was typed.
 */
VIF.vod.saveEdits = async function (loaded, changed) {
    const before = {};
    const absent = [];
    for (const key of Object.keys(changed)) {
        if (Object.prototype.hasOwnProperty.call(loaded, key)) before[key] = loaded[key];
        else absent.push(key);
    }
    Object.assign(loaded, changed);
    try {
        await loaded.save();
    } catch (err) {
        Object.assign(loaded, before);
        for (const key of absent) delete loaded[key];
        throw err;
    }
};

/** What the operator reads after a lifecycle test fire, including whether the credential went. */
VIF.vod.lifecycleTestOutcome = function (result, header) {
    let credential;
    if (result.credential === 'sent') credential = 'with the credential under ' + (header || 'Authorization');
    else credential = 'without a credential';
    if (result.delivered) {
        return { ok: true, message: '\u2713 Delivered' + (result.status ? ' (HTTP ' + result.status + ')' : '') + ', ' + credential };
    }
    const reason = result.error || 'the destination did not accept it';
    return { ok: false, message: '\u2717 ' + (result.credential === 'unresolved' ? reason : reason + ' (sent ' + credential + ')') };
};

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
			// Back navigation is a top-left crumb, the same as every other sub-view.
			root.appendChild(h('div', { class: 'phead' },
				h('div', null,
					h('a', { class: 'crumb', href: '#',
						onclick: (e) => { e.preventDefault(); V.nav('jobs'); } }, '← On-Demand Jobs'),
					h('h2', null, 'On-Demand Configs'))));
			root.appendChild(h('div', { class: 'rule2' }));
			root.appendChild(h('div', { class: 'setgrid one' }, this.renderVod()));
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
			const str = (key, label, hint, placeholder) => h('div', { class: 'field' }, h('label', null, label),
				h('input', { class: 'input', type: 'text', value: vod[key] ?? '', autocomplete: 'off', placeholder: placeholder || null,
					oninput: (e) => { edited[key] = e.target.value; } }),
				hint ? h('span', { class: 'hint' }, hint) : null);
			// Bytes are the document's unit, but nobody reads 10737418240: the value
			// speaks for itself through a live gloss, and the placeholder leads human.
			const uploadGloss = h('span', { class: 'hint mono' },
				vod.maxUploadBytes ? '= ' + V.fmtBytes(vod.maxUploadBytes) : '');
			const uploadField = h('div', { class: 'field' }, h('label', null, 'Max upload size (bytes)'),
				h('input', { class: 'input', value: vod.maxUploadBytes ?? '', placeholder: '10 GB (10737418240 bytes)',
					oninput: (e) => {
						edited.maxUploadBytes = e.target.value;
						const raw = String(e.target.value).trim();
						const n = parseInt(raw, 10);
						uploadGloss.textContent = raw !== '' && Number.isFinite(n) && n >= 0 ? '= ' + V.fmtBytes(n) : '';
					} }),
				h('span', { class: 'hint' }, 'Bigger uploads are refused before a byte is written. Blank keeps the current value.'),
				uploadGloss);
			// The credential reads as the sentence it is: [secret] sent as [header]. The
			// picker offers names from the secrets document below, never a value; clearing
			// sends "" (the document's usual off switch).
			const secretNames = this.secretNames || [];
			const credentialRow = h('div', { class: 'field' }, h('label', null, 'Credential'),
				h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' },
					h('select', { class: 'input', style: 'max-width:280px',
						onchange: (e) => { edited.lifecycleWebhookSecret = e.target.value; } },
						h('option', { value: '' }, secretNames.length ? '(no credential)' : '(none — add a secret on the Secrets page first)'),
						secretNames.map((n) => h('option', { value: n, selected: (vod.lifecycleWebhookSecret || '') === n ? 'selected' : null }, n))),
					h('span', { class: 'hint', style: 'white-space:nowrap' }, 'sent as'),
					h('input', { class: 'input', style: 'max-width:200px', type: 'text', autocomplete: 'off',
						value: vod.lifecycleWebhookHeader ?? '', placeholder: 'Authorization',
						oninput: (e) => { edited.lifecycleWebhookHeader = e.target.value; } })),
				h('span', { class: 'hint' },
					'The picked secret’s value rides each delivery under this header. Most services read Authorization; '
					+ 'some want a name of their own, like X-Api-Key. Blank sends Authorization. The secret is only ever '
					+ 'sent to the URL above — a job that sets its own webhook URL picks its own secret at submit. '
					+ 'The secrets themselves live on the Secrets page.'));
			// What a test fire reads: the form as it stands, against the settings as loaded.
			const shownLifecycle = () => ({
				url: edited.lifecycleWebhook ?? vod.lifecycleWebhook,
				secret: edited.lifecycleWebhookSecret ?? vod.lifecycleWebhookSecret,
				header: edited.lifecycleWebhookHeader ?? vod.lifecycleWebhookHeader,
			});
			const testOutcome = h('div', { class: 'vlmtest', style: 'display:none' });
			const showTest = (cls, text) => {
				testOutcome.className = 'vlmtest ' + cls;
				testOutcome.textContent = text;
				testOutcome.style.display = '';
			};
			const testRow = h('div', { class: 'field' },
				h('div', null, h('button', { class: 'btn', onclick: async (e) => {
					const button = e.currentTarget;
					const shown = shownLifecycle();
					const plan = VIF.vod.lifecycleTestRequest(shown, {
						url: vod.lifecycleWebhook, secret: vod.lifecycleWebhookSecret, header: vod.lifecycleWebhookHeader });
					if (plan.refusal) { showTest('err', plan.refusal); return; }
					button.disabled = true;
					showTest('busy', 'Sending…');
					try {
						const result = await api.probeLifecycleWebhook(plan.request);
						const outcome = VIF.vod.lifecycleTestOutcome(result, String(shown.header || '').trim());
						showTest(outcome.ok ? 'ok' : 'err', outcome.message);
					} catch (err) {
						showTest('err', '\u2717 ' + err.message);
					} finally {
						button.disabled = false;
					}
				} }, 'Send test event')),
				h('span', { class: 'hint' }, 'Posts one status event marked as a test — no job is involved — to the destination and credential shown above, saved or not.'),
				testOutcome);
			const autoResume = h('label', { class: 'hint', style: 'display:flex;gap:7px;align-items:center' },
				h('input', { type: 'checkbox', checked: vod.autoResume === false ? null : 'checked',
					onchange: (e) => { edited.autoResume = e.target.checked; } }),
				'Auto-resume jobs that failed for temporary reasons (up to 3 attempts; the counter resets when a retry makes progress)');

			return h('div', { class: 'setcard' },
				h('div', { class: 'eyebrow' }, 'On-Demand job settings'),
				h('div', { class: 'grid2' },
					num('maxConcurrentJobs', 'Concurrent jobs', 'How many jobs run at once; the rest wait their turn. Applies immediately; blank keeps the current value.', '1'),
					num('maxJobs', 'Jobs kept', 'Past this cap, the oldest finished jobs are removed along with their stored results. Blank keeps the current value.', '25')),
				num('jobTtlSeconds', 'Job expiry (seconds)', 'Forget finished jobs this many seconds after they end, results and all. Empty or 0 switches this off.', '0 (off)'),
				uploadField,
				h('div', { class: 'eyebrow', style: 'margin-top:8px' }, 'Lifecycle webhook'),
				h('p', { class: 'hint', style: 'margin:0' },
					'Every job posts its status changes here, unless it names its own destination at submit.'),
				str('lifecycleWebhook', 'Destination URL',
					'An http(s) URL, or an ${ENV_VAR} placeholder resolved when Streaming Engine reads it. Blank sends no updates.',
					'https://your-service.example/vif/status'),
				credentialRow,
				testRow,
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
						await VIF.vod.saveEdits(this.loaded, changed);
						toast('Settings saved. They apply immediately.');
						this.render();
					} catch (e) { toast(e.message, 'err'); }
				} }, 'Save vod settings')),
				h('div', { style: 'margin-top:6px;display:flex;flex-direction:column;gap:5px' },
					h('div', { class: 'eyebrow' }, 'Storage directories'),
					h('div', { class: 'lockrow' }, h('span', { class: 'k' }, 'content_dir'), h('span', { class: 'v' }, vod.contentDir || '(default: Streaming Engine content/)')),
					h('div', { class: 'lockrow' }, h('span', { class: 'k' }, 'jobs_dir'), h('span', { class: 'v' }, vod.jobsDir || '(default: Streaming Engine vif-vod-jobs/)')),
					h('p', { class: 'hint', style: 'margin:2px 0 0' },
						'Where uploaded videos live (content_dir) and where job records and results are kept (jobs_dir). '
						+ 'They cannot be edited on this page: change them in the settings file or over the REST API, and the '
						+ 'change takes effect at the next Streaming Engine restart. The wait is deliberate, since moving the directories '
						+ 'while jobs are running would separate those jobs from their files.')));
		},
	};

	V.views = V.views || {};
	V.views.settings = view;
})(window.VIF.vod);
