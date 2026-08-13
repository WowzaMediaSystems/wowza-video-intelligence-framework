(function () {
    window.VIF = window.VIF || {};
    var VIF = window.VIF;
    VIF.playback = VIF.playback || {};

    VIF.playback.init = function () {
    var CONFIG = {
      EVENT_TYPE_SCENE_DETECTION_POSTIFX: 'detection',
      EVENT_TYPE_PDT: 'programDateTime',

      CONFIDENCE_THRESHOLDS: {
        HIGH: 0.75,
        MEDIUM_HIGH: 0.50,
        MEDIUM_LOW: 0.25
      },
      BADGE_COLORS: {
        LOADING: '#f0ad4e',
        READY: '#ff8400',
        PLAYING: '#5cb85c',
        PAUSED: '#f0ad4e',
        ERROR: '#d9534f'
      },

      FORMATTED_IDLE_PLACEHOLDER_HTML: '<div class="placeholder-text">Waiting for playback to start...<br>Click play to see ID3 metadata events</div>',
      RAW_IDLE_PLACEHOLDER_HTML: '<div class="placeholder-text">Waiting for playback to start...<br>Click play to see raw ID3 metadata</div>',
      MAX_HISTORY_ITEMS: 100
    };

    var elements = {
      playerUrl: document.getElementById('playerUrl'),
      errorMessage: document.getElementById('errorMessage'),
      playerElement: document.getElementById('playerElement'),
      eventDisplay: document.getElementById('eventDisplay'),
      logDisplay: document.getElementById('logDisplay'),
      statusBadge: document.getElementById('statusBadge'),
      formattedView: document.getElementById('formattedView'),
      rawView: document.getElementById('rawView'),
      copyStatusFormatted: document.getElementById('copyStatusFormatted'),
      copyStatusRaw: document.getElementById('copyStatusRaw'),
      labelTabFormatted: document.getElementById('labelTabFormatted'),
      labelTabRaw: document.getElementById('labelTabRaw'),
      overlayToggle: document.getElementById('overlayToggle'),
      overlayControlGroup: document.getElementById('overlayControlGroup')
    };

    var resolvedServer = VIF.core.resolveServer();
    var serverUrl = resolvedServer.serverUrl;
    var encodedCredentials = resolvedServer.encodedCredentials;

    // Config-stream identity ({app, stream}) the currently loaded playback URL
    // resolved to, or null when the URL isn't a VIF-managed stream. A monotonic
    // token guards against a slow resolve for an old URL landing after the user
    // has already loaded a newer one.
    var overlayConfigStream = null;
    var overlayResolveToken = 0;

    var myPlayer = null;
    var playerStartTime = null;
    var currentLoadingUrl = null;

    var hasUserPressedPlay = false;

    // Pause state (Option A: no hard-freeze)
    var isPaused = false;

    // Copy timers
    var copyTimers = { formatted: null, raw: null };

    // PDT anchor state
    var pdtAnchorIso = null;
    var pdtAnchorMediaTime = null;
    var recentEventGuids = [];

    var urlParams = new URLSearchParams(window.location.search);
	var hashUrl = decodeURIComponent(window.location.hash.slice(1));
	var hashParamsStr = hashUrl.split('?')[1];
	var hashParams = new URLSearchParams(hashParamsStr);

	var srcParam = urlParams.get('src') || hashParams.get('src');

    // F16: the per-second [dbg] poll below must stay quiet unless explicitly
    // requested via ?debug=true — default (no ?debug) ships with no console spam.
    var debugEnabled = urlParams.get('debug') === 'true';

    if (srcParam) elements.playerUrl.value = srcParam;

    if (elements.overlayToggle) {
      elements.overlayToggle.addEventListener('change', onOverlayToggleChange);
    }

    function getOverlayListenerName(listeners) {
      if (listeners && listeners.Overlays !== undefined) return 'Overlays';
      if (listeners && listeners.OverlayEvent !== undefined) return 'OverlayEvent';
      return 'Overlays';
    }

    function getOverlayListenerMethods(listeners) {
      if (!listeners) return null;
      const overlayName = getOverlayListenerName(listeners);
      const overlayListener = listeners[overlayName];
      if (!overlayListener) return null;
      if (Array.isArray(overlayListener)) return overlayListener;
      if (typeof overlayListener === 'string') return [overlayListener];
      if (overlayListener.methods) {
        return Array.isArray(overlayListener.methods) ? overlayListener.methods : [overlayListener.methods];
      }
      return null;
    }

    // Parse a loaded HLS URL into a {app, stream} config identity. Only the
    // exact shape /{app}/{stream}/playlist.m3u8 resolves; anything else
    // (deeper/shorter paths, non-playlist filenames, unparseable URLs) returns
    // null and leaves the toggle hidden.
    function parseStreamIdentity(rawUrl) {
      let parsed;
      try {
        parsed = new URL(rawUrl, window.location.href);
      } catch (e) {
        return null;
      }
      const segments = parsed.pathname.split('/').filter((s) => s.length > 0);
      if (segments.length !== 3) return null;
      if (segments[2] !== 'playlist.m3u8') return null;
      return { app: segments[0], stream: segments[1] };
    }

    async function fetchStreamConfig(app, stream) {
      const response = await fetch(`${serverUrl}/v1/server/plugin/vif/applications/${encodeURIComponent(app)}/streams/${encodeURIComponent(stream)}`, {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${encodedCredentials}`,
          'Content-Type': 'application/json'
        }
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return await response.json();
    }

    function showOverlayControl() {
      if (elements.overlayControlGroup) elements.overlayControlGroup.style.display = 'flex';
    }

    function hideOverlayControl() {
      if (elements.overlayControlGroup) elements.overlayControlGroup.style.display = 'none';
    }

    // Resolve the loaded URL to a VIF-managed stream and, if it is one, seed and
    // reveal the overlay toggle. Called on every (re)load; starts by hiding the
    // control so an unresolvable URL leaves it hidden.
    async function resolveOverlayControl(rawUrl) {
      const token = ++overlayResolveToken;
      hideOverlayControl();
      overlayConfigStream = null;

      if (!elements.overlayToggle || !elements.overlayControlGroup) return;

      const identity = parseStreamIdentity(rawUrl);
      if (!identity) return;

      const app = identity.app;
      let stream = identity.stream;
      let config = null;

      try {
        config = await fetchStreamConfig(app, stream);
      } catch (e) {
        // Transcoded playback streams are named `<config-stream>-vi`; retry once
        // with the suffix stripped and adopt whichever name succeeded.
        if (stream.endsWith('-vi')) {
          const baseStream = stream.slice(0, -3);
          try {
            config = await fetchStreamConfig(app, baseStream);
            stream = baseStream;
          } catch (e2) {
            return;
          }
        } else {
          return;
        }
      }

      // A newer load superseded this resolve while we were awaiting — drop it.
      if (token !== overlayResolveToken) return;
      if (!config) return;

      overlayConfigStream = { app: app, stream: stream };
      const methods = getOverlayListenerMethods(config.vif_event_listeners);
      elements.overlayToggle.checked = Array.isArray(methods) && methods.indexOf('immediate') !== -1;
      showOverlayControl();
    }

    // On toggle: re-GET the live config, merge the overlay listener, and PUT it
    // back on the SAME non-/config route (runtime-only — never persisted). The
    // switch is disabled while in flight; on error it reverts to its prior state.
    async function onOverlayToggleChange() {
      if (!overlayConfigStream) return;
      const app = overlayConfigStream.app;
      const stream = overlayConfigStream.stream;
      const desired = elements.overlayToggle.checked;

      elements.overlayToggle.disabled = true;
      try {
        const config = await fetchStreamConfig(app, stream);
        const listeners = (config && config.vif_event_listeners) ? config.vif_event_listeners : {};
        const overlayName = getOverlayListenerName(listeners);
        const currentOverlay = listeners[overlayName] || {};

        listeners[overlayName] = Object.assign({}, currentOverlay, {
          class_name: currentOverlay.class_name || 'OverlayEvent',
          methods: desired ? ['immediate'] : ['disabled']
        });

        const response = await fetch(`${serverUrl}/v1/server/plugin/vif/applications/${encodeURIComponent(app)}/streams/${encodeURIComponent(stream)}`, {
          method: 'PUT',
          body: JSON.stringify({ vif_event_listeners: listeners }),
          headers: {
            'Authorization': `Basic ${encodedCredentials}`,
            'Content-Type': 'application/json'
          }
        });
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`);
        }
        hideError();
      } catch (e) {
        console.error('Error updating overlay:', e);
        elements.overlayToggle.checked = !desired;
        showError('Failed to update the overlay for this stream. Please try again.');
      } finally {
        elements.overlayToggle.disabled = false;
      }
    }

    // function persistParamsToUrl(explicitSrc) {
    //   const params = new URLSearchParams(window.location.search);
    //   const src = explicitSrc ?? elements.playerUrl.value.trim();

    //   if (src) params.set('src', src);

    //   history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
    // }

    // --- Time helpers (PDT + timeline) ---
    function pad2(n) { return String(n).padStart(2, '0'); }
    function pad3(n) { return String(n).padStart(3, '0'); }

    function formatVideoClock(seconds) {
      if (!Number.isFinite(seconds) || seconds < 0) return 'n/a';
      const totalMs = Math.floor(seconds * 1000);
      const ms = totalMs % 1000;
      const totalSec = Math.floor(totalMs / 1000);
      const s = totalSec % 60;
      const totalMin = Math.floor(totalSec / 60);
      const m = totalMin % 60;
      const h = Math.floor(totalMin / 60);
      return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${pad3(ms)}`;
    }

    function formatWallClock(dt) {
      const hh = dt.getUTCHours();
      const mm = dt.getUTCMinutes();
      const ss = dt.getUTCSeconds();
      const ms = dt.getUTCMilliseconds();
      return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}.${pad3(ms)} UTC`;
    }

    function wallClockForMediaTime(mediaTime) {
      if (!pdtAnchorIso || typeof pdtAnchorMediaTime !== 'number') return null;
      const anchorDate = new Date(pdtAnchorIso);
      if (Number.isNaN(anchorDate.getTime())) return null;

      const deltaMs = (mediaTime - pdtAnchorMediaTime) * 1000;
      const dt = new Date(anchorDate.getTime() + deltaMs);
      return formatWallClock(dt);
    }

    function updatePdtAnchorFromCue(cue) {
      const iso = cue?.value?.data || cue?.value?.programDateTime || cue?.programDateTime || cue?.text || cue?.value;
      if (typeof iso === 'string' && iso.includes('T')) {
        pdtAnchorIso = iso;
        pdtAnchorMediaTime = cue.startTime;
      }
    }

    function formatTimestampForDisplay(cueStartSeconds, videoCurrentSeconds) {
      const pdt = wallClockForMediaTime(cueStartSeconds);
      const video = formatVideoClock(videoCurrentSeconds);
      if (pdt) return `${pdt} (video=${video})`;
      return `t=${formatVideoClock(cueStartSeconds)} (video=${video})`;
    }

    // Keeping this for placeholder timing only
    function formatTime(seconds) {
      const mins = Math.floor(seconds / 60);
      const secs = Math.floor(seconds % 60);
      return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    function getPlayerTime() {
      if (!playerStartTime) {
        playerStartTime = Date.now();
        return '00:00';
      }
      const elapsedSeconds = (Date.now() - playerStartTime) / 1000;
      return formatTime(elapsedSeconds);
    }

    function switchTab() {
      const selectedTab = document.querySelector('input[name="eventTab"]:checked').value;
      elements.formattedView.classList.remove('active');
      elements.rawView.classList.remove('active');
      if (selectedTab === 'formatted') elements.formattedView.classList.add('active');
      else elements.rawView.classList.add('active');
    }

    function getConfidenceClass(confidence) {
      if (confidence > CONFIG.CONFIDENCE_THRESHOLDS.HIGH) return 'confidence-high';
      if (confidence > CONFIG.CONFIDENCE_THRESHOLDS.MEDIUM_HIGH) return 'confidence-medium-high';
      if (confidence > CONFIG.CONFIDENCE_THRESHOLDS.MEDIUM_LOW) return 'confidence-medium-low';
      return 'confidence-low';
    }

    function clearPlaceholder(element) {
      const placeholder = element.querySelector('.placeholder-text');
      if (placeholder) element.innerHTML = '';
    }

    function getFormattedPlaceholderHtml() {
      if (hasUserPressedPlay) {
        return `<div class="placeholder-text">Playing... awaiting detections</div>`;
      }
      return CONFIG.FORMATTED_IDLE_PLACEHOLDER_HTML;
    }

    function getRawPlaceholderHtml() {
      if (hasUserPressedPlay) {
        return '<div class="placeholder-text">Playing... awaiting ID3 metadata</div>';
      }
      return CONFIG.RAW_IDLE_PLACEHOLDER_HTML;
    }

    function resetFormattedDisplay() {
      elements.eventDisplay.innerHTML = getFormattedPlaceholderHtml();
      elements.eventDisplay.scrollTop = 0;
    }

    function resetRawDisplay() {
      elements.logDisplay.innerHTML = getRawPlaceholderHtml();
      elements.logDisplay.scrollTop = 0;
    }

    function trimHistory(containerEl, selector, maxItems) {
      const items = containerEl.querySelectorAll(selector);
      if (items.length > maxItems) {
        for (let i = maxItems; i < items.length; i++) items[i].remove();
      }
    }

    function displayRawLog(eventType, data, timestamp) {
      if (eventType.endsWith(CONFIG.EVENT_TYPE_PDT)) return;

      let logContent = '';
      try {
        const parsed = typeof data === 'string' ? JSON.parse(data) : data;
        logContent = `<div class="log-entry" data-event-type="${escapeHtml(eventType)}">
          <div class="log-timestamp">${timestamp} => ${eventType}</div>
          <div class="log-json">${escapeHtml(JSON.stringify(parsed, null, 2))}</div>
        </div>`;
      } catch (e) {
        logContent = `<div class="log-entry" data-event-type="${escapeHtml(eventType)}">
          <div class="log-timestamp">${timestamp} => ${eventType}</div>
          <div class="log-json">${escapeHtml(String(data))}</div>
        </div>`;
      }

      clearPlaceholder(elements.logDisplay);
      elements.logDisplay.insertAdjacentHTML('afterbegin', logContent);
      trimHistory(elements.logDisplay, '.log-entry', CONFIG.MAX_HISTORY_ITEMS);
      elements.logDisplay.scrollTop = 0;
    }

    function displayEvent(eventType, data, timestamp) {
      if (!eventType.endsWith(CONFIG.EVENT_TYPE_SCENE_DETECTION_POSTIFX)) return;

      try {
        const parsed = typeof data === 'string' ? JSON.parse(data) : data;

        // Normalize a raw detection (object / scene / VLM) to the renderer's shape.
        // confidence may be a rolled-up object ({avg}), a plain number, or absent:
        // VLM windows carry no confidence (the server omits the null key), so the
        // .avg access must be guarded or it throws and the whole event is dropped.
        // A custom-schema VLM window carries only its structured `data` object (no
        // meaningful class_name); surface that via `data` so it renders its fields
        // instead of a generic placeholder label.
        const normalize = (det) => {
          let confidence = null;
          if (det.confidence && typeof det.confidence.avg === 'number') confidence = det.confidence.avg;
          else if (typeof det.confidence === 'number') confidence = det.confidence;
          return {
            label: det.class_name ?? det.label ?? null,
            confidence,
            reasoning: det.reasoning || null,
            data: (det.data && typeof det.data === 'object') ? det.data : null,
          };
        };

        let detections = [];
        if (parsed.vif_data && Array.isArray(parsed.vif_data)) {
          parsed.vif_data.forEach((viEntry) => {
            if (viEntry.detections && viEntry.detections.length > 0) {
              viEntry.detections.forEach(det => detections.push(normalize(det)));
            }
          });
        } else if (parsed.detections && Array.isArray(parsed.detections)) {
          detections = parsed.detections.map(normalize);
        } else {
          return;
        }

        detections = detections
          .sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1));

        if (detections.length === 0) return;

        const isVlm = eventType === 'vlm-detection';
        const labels = detections.map(d => {
          // Custom-schema VLM output: render its structured fields directly — there
          // is no class to badge and a placeholder label reads as a bogus detection.
          if (d.data) {
            const rows = Object.keys(d.data).map(k => {
              const v = d.data[k];
              const valStr = (v !== null && typeof v === 'object') ? JSON.stringify(v) : String(v);
              return `<div><span class="detection-data-key">${escapeHtml(k)}:</span> ${escapeHtml(valStr)}</div>`;
            }).join('');
            return `<div class="detection-data">${rows}</div>`;
          }
          // confidence is absent for VLM (use != null to catch both null and the
          // omitted/undefined key, else Number(undefined) renders "(NaN)").
          const confidenceClass = d.confidence != null ? getConfidenceClass(d.confidence) : '';
          const confidenceStr = d.confidence != null ? ` (${Number(d.confidence).toFixed(2)})` : '';
          const reasoningStr = isVlm && d.reasoning ? `<div class="detection-reasoning">${escapeHtml(d.reasoning)}</div>` : '';
          const labelStr = d.label != null ? escapeHtml(d.label) : '';
          return `<span class="detection-label ${confidenceClass}">${labelStr}${confidenceStr}</span>${reasoningStr}`;
        }).join('');

        const content = `
          <div class="event-item">
            <div class="event-time">${escapeHtml(timestamp)}</div>
            <div class="event-data">${labels}</div>
          </div>
        `;

        clearPlaceholder(elements.eventDisplay);
        elements.eventDisplay.insertAdjacentHTML('afterbegin', content);
        trimHistory(elements.eventDisplay, '.event-item', CONFIG.MAX_HISTORY_ITEMS);
        elements.eventDisplay.scrollTop = 0;
      } catch (e) {
        console.error('Error parsing event data:', e);
      }
    }

    function updateStatusBadge(text, color) {
      elements.statusBadge.textContent = text;
      elements.statusBadge.style.background = color;
    }

    function showError(message) {
      elements.errorMessage.textContent = message;
      elements.errorMessage.classList.remove('hidden');
    }

    // hls.js buries the useful part of a failure in the error payload, so a 404 on the manifest,
    // a CORS rejection and a parse error all look alike unless it is unpacked.
    function describeHlsError(data) {
      const parts = [];
      if (data.details) parts.push(data.details);
      if (data.response && data.response.code) {
        parts.push('HTTP ' + data.response.code + (data.response.text ? ' ' + data.response.text : ''));
      }
      const reason = data.reason || (data.error && data.error.message);
      if (reason) parts.push(reason);
      const target = (data.response && data.response.url) || data.url;
      if (target) parts.push(target);
      return parts.join(' - ') || (data.type || 'unknown error');
    }

    function describeMediaError(mediaError) {
      if (!mediaError) return 'unknown error';
      const codes = {
        1: 'playback aborted',
        2: 'network error',
        3: 'decode error',
        4: 'source not supported (wrong URL, or the stream is not publishing)'
      };
      const label = codes[mediaError.code] || ('media error ' + mediaError.code);
      return mediaError.message ? label + ' - ' + mediaError.message : label;
    }

    function hideError() {
      elements.errorMessage.classList.add('hidden');
    }

    function escapeHtml(str) {
      return String(str)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
    }

    function isPlaybackMounted() {
      return !!document.getElementById('playerElement') && !!document.getElementById('playerUrl');
    }

    // --- Copy UX helpers (icon hides, status shows for 1 second) ---
    function setTabCopiedState(which, message) {
      const labelEl = (which === 'formatted') ? elements.labelTabFormatted : elements.labelTabRaw;
      const statusEl = (which === 'formatted') ? elements.copyStatusFormatted : elements.copyStatusRaw;

      if (!labelEl || !statusEl) return;

      statusEl.textContent = message || '';
      labelEl.classList.add('copied');

      if (copyTimers[which]) clearTimeout(copyTimers[which]);
      copyTimers[which] = setTimeout(() => {
        labelEl.classList.remove('copied');
        statusEl.textContent = '';
        copyTimers[which] = null;
      }, 1000);
    }

    // --- Clipboard helpers ---
    async function copyTextToClipboard(text) {
      if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text);
      }

      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }

    // A structured-VLM window renders its output as a .detection-data block of "<key>: <value>" rows
    // (see displayEvent). Reconstruct that back into a {key: value} object; values are JSON-parsed when
    // possible (numbers/booleans/objects/null) and kept as strings otherwise.
    function dataFieldsFromDiv(dataEl) {
      const obj = {};
      Array.from(dataEl.children).forEach(row => {
        const keyEl = row.querySelector('.detection-data-key');
        if (!keyEl) return;
        const key = (keyEl.textContent || '').replace(/:\s*$/, '').trim();
        if (!key) return;
        const valStr = (row.textContent || '').slice((keyEl.textContent || '').length).trim();
        let value = valStr;
        try { value = JSON.parse(valStr); } catch (e) { /* not JSON — keep the raw string */ }
        obj[key] = value;
      });
      return obj;
    }

    // VLM detections: a class name + free-text reasoning (no confidence) for unstructured output, and a
    // structured `data` object for custom-schema output. Both shapes can appear within one event-item.
    function vlmDetectionsFromItem(item) {
      const detections = [];
      Array.from(item.querySelectorAll('.detection-label')).forEach(el => {
        const reasoningEl = el.nextElementSibling;
        const reasoning = (reasoningEl && reasoningEl.classList.contains('detection-reasoning'))
          ? (reasoningEl.textContent || '').trim()
          : null;
        detections.push({ class_name: (el.textContent || '').trim(), reasoning });
      });
      Array.from(item.querySelectorAll('.detection-data')).forEach(dataEl => {
        detections.push({ data: dataFieldsFromDiv(dataEl) });
      });
      return detections;
    }

    function buildFormattedPayloadFromDiv() {
      const type = rawEventType();
      const isVlm = type === 'vlm-detection';
      const items = Array.from(document.querySelectorAll('#eventDisplay .event-item'));
      const out = items.reverse().map(item => {
        const timeEl = item.querySelector('.event-time');

        const detections = isVlm
          ? vlmDetectionsFromItem(item)
          : Array.from(item.querySelectorAll('.detection-label')).map(el => {
              const t = (el.textContent || '').trim(); // "person (0.93)"
              const m = t.match(/^(.*)\s+\(([-\d.]+)\)\s*$/);
              if (m) return { label: m[1], confidence: Number(m[2]) };
              return { label: t, confidence: null };
            });

        return {
          timestamp: timeEl ? timeEl.textContent.trim() : null,
          detections
        };
      });

      return {
        type,
        view: 'formatted',
        events: out
      };
    }

    // The detector type shown, taken from the raw ID3 events (their `info`/eventType, e.g.
    // "object-detection" / "scene-detection" / "vlm-detection"), rather than a fixed default. Uses the
    // newest raw entry's stamped type; falls back to "scene-detection" when no raw event is present.
    function rawEventType() {
      const entry = document.querySelector('#logDisplay .log-entry[data-event-type]');
      const type = entry && entry.getAttribute('data-event-type');
      return type ? type : 'scene-detection';
    }

    function buildRawPayloadFromDiv() {
      const entries = Array.from(document.querySelectorAll('#logDisplay .log-entry'));
      const out = entries.reverse().map(entry => {
        const tsEl = entry.querySelector('.log-timestamp');
        const jsonEl = entry.querySelector('.log-json');

        const ts = tsEl ? tsEl.textContent.trim() : null;
        const rawText = jsonEl ? jsonEl.textContent : '';

        let parsed = null;
        try { parsed = rawText ? JSON.parse(rawText) : null; } catch (e) {}

        return { timestamp: ts, data: parsed ?? rawText };
      });

      return {
        type: 'scene-detection',
        view: 'raw',
        events: out
      };
    }

    async function copyFormattedDetections() {
      try {
        const payloadObj = buildFormattedPayloadFromDiv();
        const payload = JSON.stringify(payloadObj, null, 2);
        await copyTextToClipboard(payload);
        setTabCopiedState('formatted', (payloadObj.events?.length ? 'Copied' : 'Empty'));
      } catch (e) {
        console.error('Copy formatted failed:', e);
        setTabCopiedState('formatted', 'Failed');
      }
    }

    async function copyRawDetections() {
      try {
        const payloadObj = buildRawPayloadFromDiv();
        const payload = JSON.stringify(payloadObj, null, 2);
        await copyTextToClipboard(payload);
        setTabCopiedState('raw', (payloadObj.events?.length ? 'Copied' : 'Empty'));
      } catch (e) {
        console.error('Copy raw failed:', e);
        setTabCopiedState('raw', 'Failed');
      }
    }

    // Wrappers prevent label click from toggling the tab
    function onCopyFormattedFromTab(e) {
      e.preventDefault();
      e.stopPropagation();
      copyFormattedDetections();
    }

    function onCopyRawFromTab(e) {
      e.preventDefault();
      e.stopPropagation();
      copyRawDetections();
    }

    function clearFormattedDetections() {
      resetFormattedDisplay();
      setTabCopiedState('formatted', 'Cleared');
    }

    function clearRawDetections() {
      resetRawDisplay();
      setTabCopiedState('raw', 'Cleared');
    }

    function onClearFormattedFromTab(e) {
      e.preventDefault();
      e.stopPropagation();
      clearFormattedDetections();
    }

    function onClearRawFromTab(e) {
      e.preventDefault();
      e.stopPropagation();
      clearRawDetections();
    }

    function clearPlaybackDebugInterval() {
      if (window.__vifPlaybackDebugInterval) {
        clearInterval(window.__vifPlaybackDebugInterval);
        window.__vifPlaybackDebugInterval = null;
      }
    }

    function destroyPlaybackSession(options) {
      const shouldClearPlaybackUrl = !options || options.clearPlaybackUrl !== false;

      clearPlaybackDebugInterval();
      if (shouldClearPlaybackUrl) {
        currentLoadingUrl = null;
      }

      if (myPlayer != null) {
        try {
          myPlayer.destroy();
        } catch (e) {
          console.error('Error destroying player:', e);
        } finally {
          myPlayer = null;
        }
      }

      const videoElement = document.querySelector('#playerElement video');
      if (videoElement) {
        try {
          videoElement.pause();
          videoElement.removeAttribute('src');
          videoElement.load();
        } catch (e) {
          console.error('Error clearing video element:', e);
        }
      }
    }

    window.__vifPlaybackDestroy = destroyPlaybackSession;

    function mainPage()
    {
      destroyPlaybackSession();
      loadAjaxPluginContent("server","vif", "shm.html","");
    }

	document.addEventListener('visibilitychange', function() {
		if (document.visibilityState === 'visible') {
			console.log('Page is visible again, resuming stream loading if paused.');
		    const videoElement = document.querySelector('#playerElement video');
			if (!videoElement || !myPlayer) return;
			videoElement.currentTime = myPlayer.liveSyncPosition;
		}
	});

    // --- Player creation ---
    function createPlayer() {
      const url = elements.playerUrl.value.trim();
      if (!url) {
        showError('Please enter a stream URL');
        return;
      }

      hideError();
      currentLoadingUrl = url;
      //persistParamsToUrl(url);

      resolveOverlayControl(url);

      isPaused = false;

      pdtAnchorIso = null;
      pdtAnchorMediaTime = null;

      destroyPlaybackSession({ clearPlaybackUrl: false });

      const playerContainer = elements.playerElement.parentNode;
      const newPlayerElement = document.createElement('div');
      newPlayerElement.id = 'playerElement';
      playerContainer.replaceChild(newPlayerElement, elements.playerElement);
      elements.playerElement = newPlayerElement;

      setTimeout(() => initializeNewPlayer(url), 500);
    }

    function initializeNewPlayer(url) {
      playerStartTime = null;
      hasUserPressedPlay = false;

      resetFormattedDisplay();
      resetRawDisplay();

      updateStatusBadge('Loading...', CONFIG.BADGE_COLORS.LOADING);

      const video = document.createElement('video');
      video.controls = true;
      video.playsInline = true;
      video.style.cssText = 'width:100%;height:100%;object-fit:contain;';
      elements.playerElement.appendChild(video);

      function onId3Cue(cue) {
        if (!hasUserPressedPlay || isPaused) return;
        const v = cue.value;
        if (!v) return;

        const eventType = v.info;
        const eventData = v.data;

        if (eventType === CONFIG.EVENT_TYPE_PDT) {
          updatePdtAnchorFromCue({ value: v, startTime: cue.startTime });
          console.log('[pdt] anchor set', { pdtAnchorIso, pdtAnchorMediaTime });
        } else {
			try {
			const parsed = typeof eventData === 'string' ? JSON.parse(eventData) : eventData;
			const guid = parsed && parsed.guid;
			if (guid && recentEventGuids.includes(guid)) return;
			if (guid) {
				recentEventGuids.push(guid);
				if (recentEventGuids.length > 25) recentEventGuids.shift();
			}
			} catch (e) { /* non-JSON data — no dedup */ }
	        console.log(`[player] ID3 event: ${eventType}`, eventData);
		}

        const timestamp = formatTimestampForDisplay(cue.startTime, video.currentTime);
        displayEvent(eventType, eventData, timestamp);
        displayRawLog(eventType, eventData, timestamp);
      }

      video.textTracks.addEventListener('addtrack', (e) => {
        if (e.track.kind !== 'metadata') return;
        e.track.mode = 'hidden';
        e.track.addEventListener('cuechange', () => {
          const cues = e.track.activeCues;
          if (!cues) return;
          for (let i = 0; i < cues.length; i++) onId3Cue(cues[i]);
        });
      });

      video.addEventListener('play', () => {
        hasUserPressedPlay = true;
        if (!playerStartTime) playerStartTime = Date.now();
        isPaused = false;
        updateStatusBadge('Playing', CONFIG.BADGE_COLORS.PLAYING);
        console.log('[player] play');
        clearPlaceholder(elements.eventDisplay);
        clearPlaceholder(elements.logDisplay);
        if (!elements.eventDisplay.querySelector('.event-item')) resetFormattedDisplay();
        if (!elements.logDisplay.querySelector('.log-entry')) resetRawDisplay();
        elements.eventDisplay.scrollTop = 0;
        elements.logDisplay.scrollTop = 0;
      });

      video.addEventListener('pause', () => {
        isPaused = true;
        updateStatusBadge('Paused', CONFIG.BADGE_COLORS.PAUSED);
        console.log('[player] pause');
      });

      if (Hls.isSupported()) {
        const hls = new Hls({
          liveSyncDurationCount: 0,
          liveDurationInfinity: true,
          enableWorker: true,
          lowLatencyMode: true,
          backBufferLength: 90
        });
        myPlayer = hls;
        hls.loadSource(url);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          updateStatusBadge('Ready', CONFIG.BADGE_COLORS.READY);
          console.log('[player] ready');
          video.play().catch(e => console.warn('[player] autoplay blocked:', e));
        });

        hls.on(Hls.Events.ERROR, (event, data) => {
          if (!data.fatal) return;
          console.error('[player] fatal error:', data);
          if (url !== currentLoadingUrl) return;
          updateStatusBadge('Error', CONFIG.BADGE_COLORS.ERROR);
          showError('Failed to load stream: ' + describeHlsError(data));
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Native HLS (Safari)
        myPlayer = { destroy: () => { video.src = ''; } };
        video.src = url;
        video.addEventListener('loadedmetadata', () => {
          updateStatusBadge('Ready', CONFIG.BADGE_COLORS.READY);
          video.play().catch(e => console.warn('[player] autoplay blocked:', e));
        });
        video.addEventListener('error', () => {
          console.error('[player] fatal error:', video.error);
          if (url !== currentLoadingUrl) return;
          updateStatusBadge('Error', CONFIG.BADGE_COLORS.ERROR);
          showError('Failed to load stream: ' + describeMediaError(video.error) + ' (' + url + ')');
        });
      } else {
        showError('HLS playback is not supported in this browser.');
      }
    }

    if (srcParam) createPlayer();

    window.addEventListener('pagehide', () => {
      destroyPlaybackSession();
    });

    window.addEventListener('beforeunload', () => {
      destroyPlaybackSession();
    });

    clearPlaybackDebugInterval();
    window.__vifPlaybackDebugInterval = setInterval(() => {
      if (!isPlaybackMounted()) {
        destroyPlaybackSession({ clearPlaybackUrl: false });
        return;
      }
      const v = document.querySelector('#playerElement video');
      if (!v) return;
      const b = v.buffered;
      if (!b || b.length === 0) return;
      const end = b.end(b.length - 1);
      if (!debugEnabled) return;
      console.log('[dbg] currentTime=', v.currentTime.toFixed(3),
        'bufferEnd=', end.toFixed(3),
        'behindLive=', (end - v.currentTime).toFixed(3),
        'paused=', v.paused);
    }, 1000);

    console.log("VIF ID3 Metadata Player Loaded");

    // Must stay true globals - see the file-header comment: playback.html's
    // markup calls each of these via inline onclick=""/onchange="" attributes,
    // which resolve identifiers against the global scope at click time.
    window.createPlayer = createPlayer;
    window.mainPage = mainPage;
    window.switchTab = switchTab;
    window.onClearFormattedFromTab = onClearFormattedFromTab;
    window.onCopyFormattedFromTab = onCopyFormattedFromTab;
    window.onClearRawFromTab = onClearRawFromTab;
    window.onCopyRawFromTab = onCopyRawFromTab;
    };
})();
