/* Boot, API access and internal navigation for the On-Demand fragment.

   V.api is a thin façade over the v2 SDK client (VIF.sdk.VifClient via VIF.core.createClient):
   documents come back in the SDK's camelCase shape, refusals as VifError subclasses whose
   .message is the problem detail and whose .status is the HTTP status. V.store caches the
   documents the views read but none of them owns.

   The standalone experiment routed on location.hash; here WSEM owns the page URL, so
   views navigate through V.nav(name, params) instead. Nothing calls a destroy hook when
   loadAjaxPluginContent swaps this fragment out, so a watchdog notices the fragment root
   leaving the document, stops the active view's timers and bumps the mount generation
   (V.gen) — the same self-teardown convention vif-dashboard.js uses. */
window.VIF = window.VIF || {};
VIF.vod = VIF.vod || {};
(function (V) {
	'use strict';

	// Built on first use: constructing the client resolves the Manager chrome's
	// connection and credentials, which a fragment script must not assume at load.
	let client = null;
	function vif() {
		if (!client) client = VIF.core.createClient();
		return client;
	}

	const store = {
		vodSettings: null,
		groups: null,
		defaults: null,
		secretNames: null,
		listenerTypes: null,
	};

	function download(blob, name) {
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = name;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(a.href), 30000);
	}

	/** POST the raw bytes; the target name rides the query string. XHR rather than the SDK's
	    own upload because this one has to be abortable — the xhr rides the promise as .xhr,
	    and progress arrives as a 0..1 fraction. */
	function upload(relPath, file, onProgress) {
		const xhr = new XMLHttpRequest();
		const promise = new Promise((resolve, reject) => {
			xhr.open('POST', vif().raw.vodFileUploadUrl(relPath));
			xhr.setRequestHeader('Authorization', 'Basic ' + VIF.core.resolveServer().encodedCredentials);
			xhr.setRequestHeader('Content-Type', 'video/mp4');
			if (onProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
			xhr.onload = () => {
				const type = xhr.getResponseHeader('Content-Type') || '';
				let body = null;
				if (/[\/+]json\b/.test(type)) {
					try { body = JSON.parse(xhr.responseText); } catch (e) { /* malformed refusal body */ }
				} else if (xhr.responseText) {
					body = { message: xhr.responseText };
				}
				if (xhr.status >= 200 && xhr.status < 300) resolve(body);
				else reject(VIF.sdk.errorFor(xhr.status, body, type, xhr.statusText));
			};
			xhr.onerror = () => reject(new VIF.sdk.VifError(
				'The upload could not reach the Engine — connection lost or refused.', 0, null));
			xhr.onabort = () => reject(Object.assign(
				new VIF.sdk.VifError('Upload cancelled.', 0, null), { cancelled: true }));
			xhr.send(file);
		});
		promise.xhr = xhr;
		return promise;
	}

	function blank(value) {
		return (value === undefined || value === null || value === '') ? undefined : value;
	}

	const api = {
		listFiles: () => vif().vod.files.list(),

		upload: upload,

		/** 204; 404 when it is already gone, 409 naming the job while one is queued or running on it. */
		deleteFile: (name) => vif().vod.files.delete(name),

		listJobs: (p) => vif().vod.jobs.list({
			tag: blank(p && p.tag), state: blank(p && p.state),
			offset: blank(p && p.offset), limit: blank(p && p.limit),
		}),

		getJob: (id) => vif().vod.jobs.get(id),

		submitJob: (request) => vif().vod.jobs.create(request),

		/** 202: a snapshot at accept time — poll until the state settles to cancelled. */
		cancelJob: (id) => vif().vod.jobs.cancel(id),

		/** config: only for an inline job whose credentials were redacted; else omit. */
		resumeJob: (id, config) => vif().vod.jobs.resume(id, config),

		deleteJob: (id) => vif().vod.jobs.delete(id),

		results: (id, p) => vif().vod.jobs.results(id, {
			offset: blank(p && p.offset), limit: blank(p && p.limit),
			fromMs: blank(p && p.from_ms), toMs: blank(p && p.to_ms),
		}),

		/** Streams the stored NDJSON into a browser download. */
		downloadJsonl: async (id) => download(await vif().vod.jobs.resultsFile(id), id + '.jsonl'),

		/** @return an object URL for the JPEG, or null when the job has no frame to show. */
		thumbnail: async (id) => {
			try {
				return URL.createObjectURL(await vif().vod.jobs.thumbnail(id));
			} catch (e) {
				if (e.status === 404) return null;
				throw e;
			}
		},

		/** A tracked document: assign to its fields, then save() sends the merge patch. */
		vodSettings: async () => (store.vodSettings = await vif().persist.vodSettings().get()),

		/** The secrets ref: get() answers the names, update({values}) sets, rotates and removes. */
		secrets: () => vif().persist.secrets(),

		secretNames: async () => (store.secretNames = (await vif().persist.secrets().get()).names),

		streamGroups: async () => (store.groups = await vif().persist.streamGroupConfigs.list()),

		defaultConfig: async () => (store.defaults = await vif().persist.streamGroupConfigs.default().get()),

		listenerTypes: async () => (store.listenerTypes = await vif().listenerTypes()),

		/** Server-side probe of an OpenAI-compatible endpoint — the browser cannot reach
		    compose-internal hostnames. */
		vlmTest: (url, apiKey) => vif().probes.vlmEndpoint({ url: url, apiKey: blank(apiKey) }),
	};

	V.api = api;
	V.store = store;

	V.init = function () {
		const root = document.getElementById('vod-root');
		let current = null;

		// Page-level navigation is the global tab row (part of this fragment's
		// header); each sub-view carries its own up-one-level button. The settings
		// view presents as the Configs area's On-Demand Configs surface — its
		// chrome lights the Configs pill and shows the config sub-tabs, so a
		// Configs sub-tab click never appears to change the primary tab.
		function setChrome(name) {
			const configs = name === 'settings';
			const show = (id, on) => {
				const el = document.getElementById(id);
				if (el) el.style.display = on ? '' : 'none';
			};
			show('vod-tabs-ondemand', !configs);
			show('vod-tabs-configs', configs);
			show('vod-subtabs-configs', configs);
			// The chrome decides the stickiness too: living on the settings view
			// counts as the Configs area (that's the pill that is lit), every
			// other view as On-Demand — so re-entering VIF and the Configs tab
			// itself both return to the surface last in use.
			try {
				sessionStorage.setItem('vifLastTab', configs ? 'configs' : 'ondemand');
				if (configs) sessionStorage.setItem('vifConfigsPage', 'settings');
			} catch (e) { /* non-sticky */ }
		}

		V.nav = function (name, params) {
			const viewRoot = document.getElementById('vod-view');
			if (!viewRoot) return; // the fragment was swapped out under a late continuation
			if (current && current.destroy) current.destroy();
			const resolved = V.views[name] ? name : 'jobs';
			current = V.views[resolved];
			setChrome(resolved);
			current.mount(viewRoot, params || {});
		};

		const watchdog = setInterval(() => {
			if (root.isConnected) return;
			clearInterval(watchdog);
			if (current && current.destroy) current.destroy();
			// Strand this instance's in-flight continuations — but only if the
			// generation still belongs to our last mount. A re-injected fragment
			// (e.g. a fast Back-to-Dashboard roundtrip) has already claimed a
			// newer gen; bumping past it would strand ITS first fetch, leaving
			// the fresh jobs view stuck on the empty scaffold.
			if (current && current.gen === V.gen) {
				V.gen = V.gen + 1;
			}
			current = null;
		}, 1000);

		V.nav('jobs');
	};
})(window.VIF.vod);
