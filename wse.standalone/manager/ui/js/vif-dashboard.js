(function () {
    window.VIF = window.VIF || {};
    var VIF = window.VIF;
    VIF.dashboard = VIF.dashboard || {};

    // Thresholds for setFramesDetected's "frames analyzed rate" coloring. CPU and
    // GPU readings are reported without threshold shading.
    var DASHBOARD_THRESHOLDS = {
        FRAMES_ANALYZED_RATE_PCT: { alert: 25, warn: 50 }
    };

    var DASHBOARD_COMPACT_METRICS = true;

    VIF.dashboard.init = function () {

        if (typeof window.__vifPlaybackDestroy === 'function') {
            try {
                window.__vifPlaybackDestroy();
            } catch (error) {
                console.error("Error destroying existing playback session:", error);
            }
        }

        // Each AJAX load of shm.html re-runs init(). Tear down the previous
        // instance's intervals first, or its render loop keeps running against
        // the new DOM with stale closure state (thumbnailsOn/lastStreamCount).
        if (typeof window.__vifDashboardDestroy === 'function') {
            try {
                window.__vifDashboardDestroy();
            } catch (error) {
                console.error("Error destroying existing dashboard session:", error);
            }
        }

        var resolvedServer = VIF.core.resolveServer();
        // Used only by the thumbnail fetch and the Spring-session probe - direct
        // fetches, not SDK calls, that carry their own Authorization header.
        var encodedCredentials = resolvedServer.encodedCredentials;
        var pathPrefix = 'wse-plugins/server/vif/';
        var host = resolvedServer.host;
        var protocol = resolvedServer.protocol;
        var hostname = resolvedServer.hostname;

        if (DASHBOARD_COMPACT_METRICS) {
            var dashboardRoot = document.querySelector('.vif-dashboard');
            if (dashboardRoot) {
                dashboardRoot.classList.add('vif-metrics-compact');
            }
        }

        var jsonData = null;
        var renderdashboardId = null;
        var securityCheckId = null;
        var lastStreamCount=0;
        // Host-scoped so separate Engines the same browser talks to keep their own preference.
        var THUMBNAILS_STORAGE_KEY = `vif.dashboard.thumbnails.${window.location.host}`;
        var thumbnailsOn = getStoredThumbnailsOn();
        var skipStatusUpdate = 0;
        var dashboardMutationInFlight = false;
        var liveUpdatesPromise = null;
        var dashboardRenderInFlight = false;
        var activeSkipSliderInteractions = new Set();

        async function getLiveUpdates() {
            if (liveUpdatesPromise) {
                return liveUpdatesPromise;
            }

            liveUpdatesPromise = (async () => {
                try {

                    const status = await VIF.core.client().status();
                    // The renderers below read the v1 flat status shape; the adapter
                    // is the whole translation.
                    const nextJsonData = {
                        host: VIF.v2map.hostFromV2(status.host),
                        streams: (status.streams || []).map(VIF.v2map.streamRowFromV2),
                        vis_instances: VIF.v2map.visInstancesFromV2(status.visInstances)
                    };

                    nextJsonData.streams.sort((a, b) => {
                      const nameA = a.app_name+a.stream_name;
                      const nameB = b.app_name+b.stream_name;

                      if (nameA < nameB) {
                        return -1; // a comes first
                      }
                      if (nameA > nameB) {
                        return 1; // b comes first
                      }
                      return 0; // names are equal
                    });

                    jsonData = nextJsonData;

                } catch (error) {
                    console.error("Error fetching data:", error);
                    defaultJson();
                }
            })();

            try {
                return await liveUpdatesPromise;
            } finally {
                liveUpdatesPromise = null;
            }
        }

        function initJson()
        {
            jsonData = {
                host: {
                    wse_version: "connecting",
                }
            };
        }

        function defaultJson()
        {
            jsonData = {
                host: {
                    wse_version: "offline",
                }
            };
            lastStreamCount = 0;
        }

        function releaseObjectUrlsInContainer(containerElement)
        {
            if (!containerElement) return;
            containerElement.querySelectorAll('img[data-object-url]').forEach((imgElement) => {
                const objectUrl = imgElement.dataset.objectUrl;
                if (objectUrl) {
                    URL.revokeObjectURL(objectUrl);
                    delete imgElement.dataset.objectUrl;
                }
            });
        }

        function clearElementContent(containerElement)
        {
            if (!containerElement) return;
            releaseObjectUrlsInContainer(containerElement);
            containerElement.innerHTML = '';
        }

        function setRowControlsDisabled(rowId, disabled)
        {
            const row = document.getElementById(rowId);
            if (!row) return;
            row.querySelectorAll('input[type="checkbox"], input[type="range"]').forEach((control) => {
                control.disabled = disabled;
            });
        }

        function setConfigButtonsEnabled(enabled)
        {
            ['btn-stream-configs', 'btn-vod-settings'].forEach((btnId) => {
                const btn = document.getElementById(btnId);
                if (!btn) return;
                btn.disabled = !enabled;
                // Enabled buttons keep their descriptive tooltip (data-desc).
                btn.title = enabled ? (btn.dataset.desc || '') : 'Waiting for Engine connection';
            });
        }

        function setDashboardBanner(message, variant)
        {
            const banner = document.getElementById('dashboard-banner');
            if (!banner) return;
            if (!message) {
                banner.style.display = 'none';
                banner.innerHTML = '';
                banner.className = 'dashboard-banner';
                return;
            }
            banner.className = `dashboard-banner dashboard-banner-${variant || 'info'}`;
            banner.innerHTML = message;
            banner.style.display = 'block';
        }

        function getStreamInteractionKey(appName, streamName)
        {
            return `${appName}/${streamName}`;
        }

        function setSkipSliderInteraction(appName, streamName, isInteracting)
        {
            const interactionKey = getStreamInteractionKey(appName, streamName);
            if (isInteracting) {
                activeSkipSliderInteractions.add(interactionKey);
            } else {
                activeSkipSliderInteractions.delete(interactionKey);
            }
        }

        function isSkipSliderInteracting(appName, streamName)
        {
            return activeSkipSliderInteractions.has(getStreamInteractionKey(appName, streamName));
        }

        async function runDashboardMutation(rowId, updateAction)
        {
            if (dashboardMutationInFlight) {
                return false;
            }

            dashboardMutationInFlight = true;
            skipStatusUpdate = Math.max(skipStatusUpdate, 2);
            setRowControlsDisabled(rowId, true);

            try {
                await updateAction();
                return true;
            } finally {
                dashboardMutationInFlight = false;
                setRowControlsDisabled(rowId, false);
            }
        }

        function restoreDashboardStateNow()
        {
            skipStatusUpdate = 0;
            renderDashboard();
        }

        async function renderDashboard() {
            if (dashboardRenderInFlight) {
                return;
            }

            dashboardRenderInFlight = true;
            try {
                hostContainer = document.getElementById('host-display');
                if(hostContainer == null)
                {
                    clearInterval(renderdashboardId);
                    clearInterval(securityCheckId);
                    return;
                }

                if(dashboardMutationInFlight) {
                    return;
                }

                if(skipStatusUpdate > 0) {
                    skipStatusUpdate = skipStatusUpdate - 1;
                    return;
                }

                await getLiveUpdates();

                if(jsonData == null)
                    return;

                hostContainer = document.getElementById('host-display');
                if(hostContainer == null)
                {
                    clearInterval(renderdashboardId);
                    clearInterval(securityCheckId);
                    return;
                }

                // --- RENDER HOST CARDS ---
                hostContainer = document.getElementById('host-display');
                hostContainer.innerHTML = '';
                hostContainer = document.getElementById('host-stats');
                hostContainer.innerHTML = '';
                hostContainer = document.getElementById('host-nvidia');
                hostContainer.innerHTML = '';

                if(jsonData.host.vif_module_version === undefined)
                {
                    // Synthetic placeholder payloads only (initJson()/defaultJson()) -
                    // a real /status response always has vif_module_version, even the
                    // legacy shape without vis_instances. Distinguish "still waiting
                    // for the first poll" from "lost the connection" for the banner.
                    const isOffline = jsonData.host.wse_version === 'offline';
                    setConfigButtonsEnabled(false);
                    setDashboardBanner(
                        isOffline
                            ? 'Offline &mdash; lost connection to the Engine. Retrying&hellip;'
                            : 'Connecting to Engine&hellip;',
                        isOffline ? 'alert' : 'info'
                    );
                    renderStatBand();
                    renderHostCard('host-display', "WSE", jsonData.host.wse_version);
                    renderInferenceGroups([]);
                    const tbody = document.getElementById('streams-body');
                    const thumbnailDisplay = document.getElementById('thumbnail-display');
                    clearElementContent(tbody);
                    clearElementContent(thumbnailDisplay);
                    active_streams = document.getElementById('active-streams');
                    active_streams.textContent = "-";
                    header_values = document.getElementById("header-values");
                    header_values.textContent = "";
                    return;
                }

                // Config buttons are always visible in the markup (F13) - only their
                // disabled/tooltip state changes here, never display.
                setConfigButtonsEnabled(true);

                renderStatBand();
                renderWseHostGroup();
                // The stat band's bulleted cells carry the per-instance story;
                // the empty call just clears the container. The WSE Host group
                // above remains for the multi-GPU-host case.
                renderInferenceGroups([]);

                active_stream_count = get_active_stream_count(jsonData.streams);
                active_streams = document.getElementById('active-streams');
                active_streams.textContent = active_stream_count;

                setDashboardBanner(null);

                renderStreamData(jsonData.streams);
            } finally {
                dashboardRenderInFlight = false;
            }
        }

        function get_active_stream_count(streams) {
            count = 0;
            streams.forEach((stream) => {
                if(stream.active) {
                    count++;
                }
            });
            return count;
        }

        function renderNoActiveStreamsRow(tbody) {
            if (!tbody) return;
            clearElementContent(tbody);
            const tr = document.createElement('tr');
            tr.className = 'empty-streams-row';
            tr.innerHTML = '<td colspan="8">'
                + '<div class="empty-icon"><svg width="30" height="30" viewBox="0 0 24 24" fill="none"'
                + ' stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
                + '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/>'
                + '<path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>'
                + '<path d="M7.2 12c1.3-2.1 2.9-3.2 4.8-3.2s3.5 1.1 4.8 3.2c-1.3 2.1-2.9 3.2-4.8 3.2s-3.5-1.1-4.8-3.2Z"/>'
                + '<circle cx="12" cy="12" r="1.4"/></svg></div>'
                + '<div class="empty-title">No VIF-enabled live streams are currently being published.</div>'
                + '<div class="empty-hint">Publish a stream that matches an existing configuration under '
                + '<a href="#" onclick="event.preventDefault(); loadAjaxPluginContent(\'server\', \'vif\', \'stream-config.html\', \'\')">Configs → Stream Configs</a>'
                + ' and it will appear in this dashboard.</div></td>';
            tbody.appendChild(tr);
        }

        function renderStreamData(streams) {
            const tbody = document.getElementById('streams-body');
            const table = document.getElementById('streams-table');
            const tblWrap = document.getElementById('table-wrapper');
            const thumbWrap = document.getElementById('thumbnail-wrapper');
            const thumbnailDisplay = document.getElementById('thumbnail-display');
            if(thumbnailsOn)
            {
                tblWrap.style.display = "none";
                clearElementContent(tbody);
                thumbWrap.style.display = "inline-block";

                if (lastStreamCount !== streams.length) {
                    clearElementContent(thumbnailDisplay);
                    streams.forEach((stream, index) => {
                        renderThumbnailCard('thumbnail-display', stream);
                    });
                }
                streams.forEach((stream, index) => {
                    const id = stream.app_name+"-"+stream.stream_name;
                    rand = new Date().getTime();

                    setThumbnail(id+"-thumbnail", stream);
                    setFramesDetected(id+"-frame-detect-avg", stream);
                });
            }
            else
            {
                thumbWrap.style.display = "none";
                clearElementContent(thumbnailDisplay);
                tblWrap.style.display = "inline-block";

                if (!Array.isArray(streams) || streams.length === 0) {
                    renderNoActiveStreamsRow(tbody);
                    header_values = document.getElementById("header-values");
                    header_values.textContent = "";
                    lastStreamCount = 0;
                    return;
                }

                // If number of streams changed, rebuild the whole table
                // if (tbody.rows.length !== streams.length*2) {
                if (lastStreamCount !== streams.length) {
                    clearElementContent(tbody);
                    streams.forEach((stream, index) => {
                        const tr = document.createElement('tr');
                        // We create cells with specific classes/IDs to target them later if needed
                        // But simpler is to access by cell index since table structure is fixed
                        const id = stream.app_name+"-"+stream.stream_name;
                        tr.id = id + '-row';

                        tr.innerHTML = `
                            <td class="stream-type-cell">
                                <img id="${id}-type" class="stream-type-icon" src="${pathPrefix}unknown.png" alt="">
                                <div id="${id}-model-name" class="stream-type-meta-line" title="Model"></div>
                                <div id="${id}-duration" class="stream-type-meta-line stream-type-meta-secondary" title="Window"></div>
                            </td>
                            <td>
                                <strong id="${id}-stream-name"></strong>
                                <br>
                                <div class="vif-controls">Active&nbsp;
                                    <label class="switch">
                                        <input type="checkbox" id="${id}-activeToggle">
                                        <span class="slider-switch"></span>
                                    </label>
                                </div>
                            </td>
                            <td>
                                <div class="vif-row"><div title="source resolution" id="${id}-res"></div>&nbsp;@&nbsp;<div title="Source fps" id="${id}-fps"></div></div>
                                <div class="vif-row" id="${id}-gopContainer" style="${(stream.use_transcoder && stream.detector_type !== 'synthetic') ? 'display:none;' : ''}"><div title="gop size" id="${id}-gop"></div></div>
                                <div class="vif-controls vif-skip-controls" id="${id}-skipSliderContainer" style="${(stream.use_transcoder && stream.detector_type !== 'synthetic') ? '' : 'display:none;'}">
                                    <div class="vif-skip-line">Inference fps<input type="range" class="slider" id="${id}-skipSlider" min="1" max="${stream.frame_rate}" value="${stream.inference_fps}"><span id="${id}-skipValue" class="vif-skip-value">${stream.inference_fps}</span></div>
                                    <div class="vif-skip-note-line"><span id="${id}-frames-window" class="frames-window-note"></span></div>
                                </div>
                                <div id="${id}-vihost"></div>
                                <div id="${id}-sts"></div>
                                <div id="${id}-vlm-health" class="row-status-line"></div>
                            </td>
                            <td><div id="${id}-ping"></div></td>
                            <td><div id="${id}-ttl-proc"></div></td>
                            <td><div id="${id}-frame-detect" title="Total Object Processing Time"></div></td>
                            <td><div id="${id}-frame-detect-avg"></div></td>
                            <td><a id="${id}-thumbnail-link"><img src="${pathPrefix}thumb.png" id="${id}-thumbnail" height=110 alt="Thumbnail"></a></td>
                        `;
                        tbody.appendChild(tr);
                        const tr2 = document.createElement('tr');
                        tr2.innerHTML = `
                            <td colspan="8" class="row-status-cell align-left">
                                <div id="${id}-reason" class="row-status-line"></div>
                            </td>`;
                        tbody.appendChild(tr2);
                        active = document.getElementById(id+'-activeToggle');
                        active.addEventListener('change', updateActive.bind(null, id, stream.app_name, stream.stream_name));

                        slider = document.getElementById(id+"-skipSlider");
                        slider.addEventListener('input', handleSkipFrameInput.bind(null, id, stream.app_name, stream.stream_name));
                        slider.addEventListener('change', updateSkipFrame.bind(null, id, stream.app_name, stream.stream_name));
                        slider.addEventListener('blur', clearSkipFrameInteraction.bind(null, stream.app_name, stream.stream_name));

                    });

                }

                // Now Update Values inside the rows without replacing the row itself
                ttl_proc_avg = 0;
                ttl_frame_detect_avg = 0;
                streams.forEach((stream, index) => {
                    const row = tbody.rows[index];
                    if (!row) return;

                    const perf = stream.performance;
                    const id = stream.app_name+"-"+stream.stream_name;
                    // Synthetic taps every source packet — inference_fps does nothing, so hide the
                    // inference-fps slider and the "/Nfps" suffix and show the keyframe interval
                    // instead (the GOP is what governs a synthetic window's cadence).
                    const isSynthetic = stream.detector_type === 'synthetic';

                    vif_type = document.getElementById(id+"-type");
                    const detectorTypeIconPath = getDetectorTypeIconPath(stream.detector_type);
                    if (vif_type.getAttribute('src') !== detectorTypeIconPath) {
                        vif_type.src = detectorTypeIconPath;
                    }
                    vif_type.title = `${toTitleCaseRegex(stream.detector_type)} Detection`;
                    vif_type.alt = `${toTitleCaseRegex(stream.detector_type)} detection`;

                    model_name = document.getElementById(id+"-model-name");
                    model_name.textContent = `Model: ${stream.model_name || '-'}`;

                    duration = document.getElementById(id+"-duration");
                    if ((stream.detector_type == "scene" || stream.detector_type == "vlm")
                        && isFinite(Number(stream.duration)) && Number(stream.duration) > 0) {
                        duration.textContent = `Window: ${stream.duration}s`;
                    } else {
                        duration.textContent = "";
                    }

                    stream_name = document.getElementById(id+"-stream-name");
                    stream_name.textContent = stream.app_name + "/" + stream.stream_name;

                    active = document.getElementById(id+'-activeToggle');
                    active.checked = stream.active;

                    res = document.getElementById(id+"-res");
                    res.textContent = `${stream.width}x${stream.height}`;
                    fps = document.getElementById(id+"-fps");
                    fps.textContent = `${stream.frame_rate}fps`
                    const gopContainer = document.getElementById(id+"-gopContainer");
                    if (gopContainer) gopContainer.style.display = (stream.use_transcoder && !isSynthetic) ? 'none' : '';
                    const gopEl = document.getElementById(id+"-gop");
                    if (gopEl) {
                        gopEl.textContent = stream.gop_size != null ? `Key Frame Interval:${stream.gop_size}` : '';
                        gopEl.title = 'gop size';
                        gopEl.style.color = '';
                        if(stream.gop_size != null && stream.gop_size >0) {
                            // The grab-interval comparison only means something where the keyframe
                            // grabber feeds the detector; synthetic taps every source packet, so
                            // its GOP is judged against the window below, not the grab interval.
                            const mismatch = !isSynthetic && stream.gop_size != null && stream.frame_grab_interval != null
                                && Math.round(stream.gop_size / stream.frame_rate * 1000) !== Math.round(stream.frame_grab_interval * 1000);
                            gopEl.style.color = mismatch ? '#cc9900' : '';
                            if (mismatch) {
                                gopEl.textContent += ` (${Math.round(stream.gop_size / stream.frame_rate * 1000)}ms with frame grab of ${Math.round(stream.frame_grab_interval * 1000)}ms)`;
                            }
                            // Synthetic windows are keyframe-aligned, so the source GOP sets the
                            // verdict cadence; when it dwarfs the configured window, warn on the
                            // row and point at the encoder setting that fixes it (the module logs
                            // the same GOP-bound WARN server-side).
                            const windowS = Number(stream.duration);
                            const gopS = stream.gop_size / stream.frame_rate;
                            if (isSynthetic && isFinite(windowS) && windowS > 0 && isFinite(gopS) && gopS > windowS * 1.5) {
                                gopEl.style.color = '#cc9900';
                                gopEl.textContent += ` · verdicts every ~${gopS.toFixed(1)}s, not the configured ${windowS}s`;
                                gopEl.title = 'Synthetic windows are keyframe-aligned, so the source keyframe interval'
                                    + ' sets the verdict cadence. Shorten it to the window length in your encoder;'
                                    + ' in OBS: Settings > Output (Advanced mode) > Keyframe Interval = ' + windowS + 's.';
                            }
                        }
                    }
                    const skipSliderContainer = document.getElementById(id+"-skipSliderContainer");
                    if (skipSliderContainer) skipSliderContainer.style.display = (stream.use_transcoder && !isSynthetic) ? '' : 'none';
                    slider = document.getElementById(id+"-skipSlider");
                    slider.max = stream.frame_rate;
                    slider.dataset.windowed = (stream.detector_type === 'scene' || stream.detector_type === 'vlm') ? 'true' : 'false';
                    slider.dataset.detector = stream.detector_type || '';
                    slider.dataset.duration = (stream.duration != null) ? String(stream.duration) : '';
                    if (!isSkipSliderInteracting(stream.app_name, stream.stream_name)) {
                        slider.value = stream.inference_fps;
                        updateSkipFrameDisplay(id);
                    }
                    sts = document.getElementById(id+"-sts");
                    sts.textContent = `${stream.status}`;
                    sts.className = stream.status.toLowerCase() == 'connected' ? 'text-good' : stream.status.toLowerCase() == 'disabled' || stream.status.toLowerCase() == 'error' ? 'text-alert' : 'text-warn';

                    // Upstream-endpoint health (endpoint_degraded; legacy spelling
                    // vlm_degraded) for the detectors served by a remote endpoint:
                    // the VLM server and the synthetic detector's SVD NIM.
                    vlmHealth = document.getElementById(id+"-vlm-health");
                    if (stream.detector_type === 'vlm' || stream.detector_type === 'synthetic') {
                        vlmHealth.style.display = '';
                        if (stream.endpoint_degraded === true || stream.vlm_degraded === true) {
                            vlmHealth.textContent = stream.detector_type === 'synthetic'
                                ? "AI offline — SVD endpoint unreachable"
                                : "AI offline — VLM endpoint unreachable";
                            // Full message on hover (it truncates to one reserved
                            // line); keep the row-status-line slot class.
                            vlmHealth.title = vlmHealth.textContent;
                            vlmHealth.className = "row-status-line text-alert";
                        } else {
                            vlmHealth.textContent = "";
                            vlmHealth.title = "";
                            vlmHealth.className = "row-status-line";
                        }
                    } else {
                        vlmHealth.style.display = 'none';
                        vlmHealth.textContent = "";
                        vlmHealth.title = "";
                        vlmHealth.className = "row-status-line";
                    }

                    // vi_service_url is user-entered config relayed verbatim by
                    // /status; it may not parse (no scheme) or parse hostless.
                    let viHostLabel = stream.vi_service_url || '';
                    try {
                        const parsedHostname = new URL(stream.vi_service_url).hostname;
                        if (parsedHostname) viHostLabel = parsedHostname;
                    } catch (e) { /* keep the raw configured value */ }
                    viHost = document.getElementById(id+"-vihost");
                    viHost.textContent = stream.vi_service_version != null
                        ? `${viHostLabel} (${stream.vi_service_version})`
                        : viHostLabel;


                    // A stream notice renders as a calm chip (dot + short label);
                    // the raw server line is one click away via the popover
                    // (data-vif-tip -> VIF.core.initClickTips). Rebuilt only when
                    // the text actually changes, so a repeatedly-firing notice
                    // doesn't churn the DOM or dismiss an open popover.
                    reason = document.getElementById(id+"-reason");
                    const reasonText = stream.reason != null ? String(stream.reason) : '';
                    if (!reasonText) {
                        if (reason.dataset.vifTip !== undefined) delete reason.dataset.vifTip;
                        reason.className = 'row-status-line';
                        reason.textContent = '';
                    } else if (reason.dataset.vifTip !== reasonText) {
                        const isError = reasonText.toLowerCase().includes('error');
                        reason.dataset.vifTip = reasonText;
                        // Raw server text — worth a copy button (see initClickTips).
                        reason.dataset.vifTipCopy = '1';
                        reason.className = 'row-status-line vif-alert-chip'
                            + (isError ? ' vif-alert-chip-error' : '');
                        reason.textContent = '';
                        const dot = document.createElement('span');
                        dot.className = 'vif-alert-dot';
                        const label = document.createElement('span');
                        label.textContent = (isError ? 'Stream error' : 'Stream notice')
                            + ' — view details';
                        reason.appendChild(dot);
                        reason.appendChild(label);
                    }

                    ping = document.getElementById(id+"-ping");
                    if(!stream.active) {
                        ping.textContent= "-";
                    } else {
                        ping.textContent= `${Math.round(perf.ping_rtt_avg)} ms`;
                    }

                    ttt_proc = document.getElementById(id+"-ttl-proc");
                    if(!stream.active) {
                        ttt_proc.textContent = "-";
                    } else {
                        ttt_proc.textContent = `${Number(perf.total_processing_time_avg).toFixed(0)} ms`;
                    }
                    ttl_proc_avg = ttl_proc_avg + perf.total_processing_time_avg;

                    frame_detect = document.getElementById(id+"-frame-detect");
                    if(!stream.active) {
                        frame_detect.textContent = "-";
                    } else {
                        frame_detect.textContent = `${Number(perf.frame_detect_time_avg).toFixed(0)} ms`;
                    }
                    ttl_frame_detect_avg = ttl_frame_detect_avg + perf.frame_detect_time_avg;

                    setFramesDetected(id+"-frame-detect-avg", stream);
                    setThumbnail(id+"-thumbnail", stream);

                });
                header_values = document.getElementById("header-values");
                if(active_stream_count == 0) {
                    header_values.textContent = "";

                } else {
                    header_values.textContent = `Processing avg ${Number(ttl_proc_avg/active_stream_count).toFixed(0)} ms · Detect avg ${Number(ttl_frame_detect_avg/active_stream_count).toFixed(0)} ms`;
                }
            }
            lastStreamCount = streams.length;
        }

        function setThumbnail(thumbnailId, stream)
        {
            const thumbnail = document.getElementById(thumbnailId);
            const thumbnail_link = document.getElementById(thumbnailId+"-link");
            // Both can be gone when a concurrent render pass rebuilt the
            // table/thumbnail containers between this pass's DOM lookups.
            if (!thumbnail || !thumbnail_link) return;

            const rand = new Date().getTime();
            var stream_name = stream.stream_name;
            const thumbnailUrl = VIF.core.client().runtime.streams.ref(stream.app_name, stream_name).thumbnailUrl(
                VIF.v2map.thumbnailParamsFromV1({ fitMode: 'fitheight', height: 180, overlay: true }));
            loadImage(`${thumbnailUrl}&random=${rand}`,`${pathPrefix}thumb.png`,thumbnailId);
            if(stream.use_transcoder)
            {
                stream_name = stream_name + "-vi";
            }
            thumbnail_link.href = `javascript:loadPlayerPage('${hostname}','${stream.app_name}','${stream_name}')`;
        }

        function getDetectorTypeIconPath(detectorType) {
            const normalizedType = String(detectorType || '').toLowerCase();
            if (normalizedType === 'object' || normalizedType === 'scene' || normalizedType === 'vlm' || normalizedType === 'synthetic') {
                return `${pathPrefix}${normalizedType}.png`;
            }
            return `${pathPrefix}unknown.png`;
        }

        function swapImageSource(imgElement, nextSrc, isObjectUrl) {
            if (!imgElement) return;

            const previousObjectUrl = imgElement.dataset.objectUrl;
            if (previousObjectUrl) {
                URL.revokeObjectURL(previousObjectUrl);
                delete imgElement.dataset.objectUrl;
            }

            imgElement.src = nextSrc;
            if (isObjectUrl) {
                imgElement.dataset.objectUrl = nextSrc;
            }
        }

        async function loadImage(imageUrl, defaultImageUrl, imgElementId) {
            const imgElement = document.getElementById(imgElementId);
            if (!imgElement) return;

            const requestId = String((parseInt(imgElement.dataset.requestId || '0', 10) || 0) + 1);
            imgElement.dataset.requestId = requestId;

            try {
                const response = await fetch(imageUrl, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Basic ${encodedCredentials}`,
                        'Content-Type': 'application/json'
                    }
                });
                if (!response.ok) {
                    // Handle HTTP error statuses (e.g., 404, 500)
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                // Convert the response to a Blob (binary data)
                const imageBlob = await response.blob();
                // Create an object URL for the blob
                const objectUrl = URL.createObjectURL(imageBlob);

                if (imgElement.dataset.requestId !== requestId) {
                    URL.revokeObjectURL(objectUrl);
                    return;
                }

                swapImageSource(imgElement, objectUrl, true);

            } catch (error) {
                // Handle network errors or errors thrown in the try block
                console.error("Error loading image:", error);
                if (imgElement.dataset.requestId === requestId) {
                    swapImageSource(imgElement, defaultImageUrl, false);
                }
            }
        }


        function setFramesDetected(frameDetectId, stream) {
            const frame_detect2 = document.getElementById(frameDetectId);
            if(!stream.active) {
                frame_detect2.textContent = `-`;
                frame_detect2.className = '';
            }
            else {
                // frames_detected / video_frames_ttl arrive as rolling 10s totals
                // (StreamStats.FRAMES_ANALYZED_SPAN_SECONDS ROLLING_SUM stores), so
                // they can be shown directly - no client-side history,
                // sample-picking, or zero-gap holding. Any single-sample pick was
                // wrong in one direction or the other, because the two counters are
                // written at different instants (capture vs response): max-captured
                // pinned "0 of X", max-analyzed showed "20 of 10" when responses
                // bunched into one bucket.
                const perf = stream.performance;
                const frmsTtl = Math.round(perf.video_frames_ttl || 0);
                // The analyzed total can transiently exceed the captured total when a
                // response's capture buckets age past the span horizon before it does;
                // more-than-captured is always a reading artifact, so clamp it.
                const frms = Math.min(Math.round(perf.frames_detected || 0), frmsTtl);
                const v = frmsTtl > 0 ? Math.min((frms / frmsTtl) * 100.0, 100.0) : 0;

                // The cell shows only the keep-up rate - raw frame counts confused
                // more than they informed. No per-value tooltip: the 1s refresh
                // rewriting a title under the cursor makes the native tooltip blink.
                const text = `${Number(v).toFixed(0)}%`;

                // Zero captures while connected is a stall (or, for a window-based
                // detector, a response cadence longer than the 10s span - operators
                // should size duration within it). When not connected, the
                // stream-status cell already carries its own alert; don't stack a
                // second one here.
                const isConnected = String(stream.status).toLowerCase() === 'connected';
                let cls;
                if (frmsTtl === 0) {
                    cls = isConnected ? 'text-alert' : '';
                } else {
                    cls = v < DASHBOARD_THRESHOLDS.FRAMES_ANALYZED_RATE_PCT.alert ? 'text-alert' : v < DASHBOARD_THRESHOLDS.FRAMES_ANALYZED_RATE_PCT.warn ? 'text-warn' : 'text-good';
                }

                frame_detect2.textContent = text;
                frame_detect2.removeAttribute('title');
                frame_detect2.className = cls;
            }
        }

        function renderThumbnailCard(container, stream) {
            const id = stream.app_name+"-"+stream.stream_name;
            const hostContainer = document.getElementById(container);
            const card = document.createElement('div');
            card.className = `metric-card`;
            card.innerHTML = `
                 <b>${stream.app_name} / ${stream.stream_name}</b>&nbsp;(${stream.width}x${stream.height} @ ${stream.frame_rate}fps)<br>
                 <a id="${id}-thumbnail-link"><img id="${id}-thumbnail" class="thumbnail-card-image" alt="Thumbnail"></a>
                <br><div id="${id}-frame-detect-avg"></div>
            `;
            hostContainer.appendChild(card);
        }

        // Per-GPU metrics as one aligned table: a row per GPU, a column per
        // metric. Warn/alert coloring is per cell, so one hot GPU flags only
        // its own reading.
        // columns: [{key, label, tip?, warn?, alert?}]
        // rows: [{device, cells: [{value, unit?, title?}]}], cells aligned
        // with columns; a null value renders as '-'.
        function renderGpuTableCard(parent, cardId, columns, rows)
        {
            const card = document.createElement('div');
            card.className = 'metric-card gpu-table-card';
            card.id = cardId;

            const table = document.createElement('table');
            table.className = 'gpu-table';

            const headRow = document.createElement('tr');
            const deviceTh = document.createElement('th');
            deviceTh.textContent = 'GPU';
            headRow.appendChild(deviceTh);
            columns.forEach((col) => {
                const th = document.createElement('th');
                th.textContent = col.label;
                if (col.tip) {
                    const tip = document.createElement('span');
                    tip.className = 'vif-help-tip';
                    tip.title = col.tip;
                    tip.textContent = '?';
                    th.appendChild(tip);
                }
                headRow.appendChild(th);
            });
            const thead = document.createElement('thead');
            thead.appendChild(headRow);
            table.appendChild(thead);

            const tbody = document.createElement('tbody');
            rows.forEach((row) => {
                const tr = document.createElement('tr');
                tr.setAttribute('data-gpu', row.device);
                const deviceTd = document.createElement('td');
                deviceTd.className = 'gpu-device';
                deviceTd.textContent = row.device;
                tr.appendChild(deviceTd);
                row.cells.forEach((cell, i) => {
                    const col = columns[i];
                    const td = document.createElement('td');
                    td.setAttribute('data-metric', col.key);
                    if (cell.value != null) {
                        td.textContent = `${Number(cell.value).toFixed(0)}${cell.unit || ''}`;
                    } else {
                        td.textContent = '-';
                    }
                    if (cell.title) td.title = cell.title;
                    tr.appendChild(td);
                });
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);

            card.appendChild(table);
            parent.appendChild(card);
            return card;
        }

        function renderHostCard(container, label, value, unit)
        {
            const hostContainer = document.getElementById(container);

            if(unit === undefined) {
                unit = '';
            }

            const card = document.createElement('div');
            card.className = 'metric-card';
            card.innerHTML = `
                <div class="metric-label">${label}</div>
                <div class="metric-value">${value}${unit}</div>
            `;
            hostContainer.appendChild(card);
            return card;
        }

        // --- Top stat band ------------------------------------------------------
        // One flat row of labeled cells is the primary metrics presentation; the
        // detailed card groups render into #vif-metric-details, revealed only when a
        // single aggregate row cannot carry the data honestly (several GPUs or
        // several inference instances). All text lands via textContent — the host
        // and version strings come from the server.

        function bandCell(band, label, opts)
        {
            opts = opts || {};
            const cell = document.createElement('div');
            cell.className = 'vif-stat-cell' + (opts.muted ? ' vif-stat-cell-muted' : '');
            const labelEl = document.createElement('div');
            labelEl.className = 'vif-stat-label';
            labelEl.textContent = label;
            // Info tips ride the click-popover pattern (initClickTips): a small
            // circled tip on the label, matching the streams-table headers, instead
            // of a hover title on the whole cell.
            if (opts.tip) {
                const tipEl = document.createElement('span');
                tipEl.className = 'vif-help-tip';
                tipEl.textContent = '?';
                tipEl.title = opts.tip;
                labelEl.appendChild(tipEl);
            }
            cell.appendChild(labelEl);
            const valueEl = document.createElement('div');
            valueEl.className = 'vif-stat-value';
            const textEl = document.createElement('span');
            textEl.textContent = opts.value != null ? String(opts.value) : '\u2013';
            valueEl.appendChild(textEl);
            if (opts.barPct != null && isFinite(opts.barPct)) {
                const bar = document.createElement('span');
                bar.className = 'vif-stat-bar';
                const fill = document.createElement('span');
                fill.style.width = Math.max(0, Math.min(100, opts.barPct)) + '%';
                bar.appendChild(fill);
                valueEl.appendChild(bar);
            }
            cell.appendChild(valueEl);
            // sub: one line, or an array rendered one row each — identity strings
            // and load figures read better stacked than dot-joined into a long
            // run-on that wraps mid-token.
            const subs = Array.isArray(opts.sub) ? opts.sub : (opts.sub ? [opts.sub] : []);
            subs.forEach((line) => {
                if (!line) return;
                const subEl = document.createElement('div');
                subEl.className = 'vif-stat-sub';
                subEl.textContent = line;
                cell.appendChild(subEl);
            });
            // Multi-value cells (several inference GPUs) render one bulleted
            // line per entry instead of a single subline.
            if (opts.subLines && opts.subLines.length) {
                opts.subLines.forEach((line) => {
                    const lineEl = document.createElement('div');
                    lineEl.className = 'vif-stat-sub';
                    lineEl.textContent = '• ' + line;
                    cell.appendChild(lineEl);
                });
            }
            band.appendChild(cell);
        }

        // {id: value} -> {id, value} of the largest entry, or null when empty.
        function maxEntry(map)
        {
            let best = null;
            if (map) {
                for (const id in map) {
                    const value = Number(map[id]);
                    if (!isNaN(value) && (best == null || value > best.value)) {
                        best = { id: id, value: value };
                    }
                }
            }
            return best;
        }

        function setMetricDetailsVisible(visible)
        {
            const details = document.getElementById('vif-metric-details');
            if (details) details.classList.toggle('is-visible', !!visible);
        }

        // The Inference Host cell's sticky headline host (see renderStatBand).
        let primaryInferenceHost = null;

        function renderStatBand()
        {
            const band = document.getElementById('vif-stat-band');
            if (!band) return;
            clearElementContent(band);

            const host = jsonData.host || {};

            // Placeholder payloads (initJson/defaultJson) — the banner explains the
            // state; the band keeps the page shape with muted cells.
            if (host.vif_module_version === undefined) {
                bandCell(band, 'WSE Host', { value: host.wse_version, muted: true });
                bandCell(band, 'WSE GPU', { muted: true });
                bandCell(band, 'VIF Module', { muted: true });
                bandCell(band, 'Inference Host', { muted: true });
                bandCell(band, 'Inference GPU', { muted: true });
                bandCell(band, 'Inference GPU Memory', { muted: true });
                setMetricDetailsVisible(false);
                return;
            }

            const wireInstances = Array.isArray(jsonData.vis_instances) ? jsonData.vis_instances : [];
            // Sticky primary: the first host seen stays the headline (and first
            // bullet) until it leaves the wire, then the earliest remaining host
            // is promoted — so the cell doesn't reshuffle between polls.
            if (primaryInferenceHost == null
                    || !wireInstances.some((inst) => inst.host === primaryInferenceHost)) {
                primaryInferenceHost = wireInstances.length > 0 ? wireInstances[0].host : null;
            }
            const instances = wireInstances.slice().sort((a, b) =>
                (a.host === primaryInferenceHost ? -1 : 0) - (b.host === primaryInferenceHost ? -1 : 0));
            const first = instances.length > 0 ? instances[0] : null;

            bandCell(band, 'WSE Host', {
                value: host.wse_version,
                sub: 'CPU ' + Number(host.cpu_avg).toFixed(0) + '%',
            });

            // The WSE HOST's own GPU — a different physical device than the
            // inference GPU on split deployments, so it keeps its own cell
            // beside WSE Host: utilization as the value, the card identity and
            // video-engine load as the subline.
            const hostUtil = maxEntry(host.gpu_avg);
            const decode = maxEntry(host.gpu_decode_avg);
            const encode = maxEntry(host.gpu_encode_avg);
            const memBus = maxEntry(host.gpu_memory_avg);
            // Two sublines: what the card IS, then what its video engine is doing —
            // one dot-joined run-on wrapped mid-token on long GPU names.
            const gpuIdentity = [];
            if (host.nvidia_gpu_type && host.nvidia_gpu_type !== 'unknown') gpuIdentity.push(host.nvidia_gpu_type);
            if (host.cuda_version) gpuIdentity.push('CUDA ' + host.cuda_version);
            const videoEngine = [];
            if (decode) videoEngine.push('Decode ' + decode.value.toFixed(0) + '%');
            if (encode) videoEngine.push('Encode ' + encode.value.toFixed(0) + '%');
            if (memBus) videoEngine.push('Mem bus ' + memBus.value.toFixed(0) + '%');
            bandCell(band, 'WSE GPU', {
                value: hostUtil ? hostUtil.value.toFixed(0) + '%' : null,
                barPct: hostUtil ? hostUtil.value : null,
                sub: [gpuIdentity.join(' · '), videoEngine.join(' · ')],
                muted: hostUtil == null,
                tip: "The Wowza Streaming Engine (WSE) host machine's GPU: utilization, video-engine (decode/encode) load, and memory-bus busy share (not VRAM in use)."
                    + (host.nvidia_driver_version ? ' Driver ' + host.nvidia_driver_version + '.' : ''),
            });

            bandCell(band, 'VIF Module', { value: host.vif_module_version });

            // One host: hostname headline, version/CPU subline. Several hosts:
            // the count as the headline and one bulleted line per host \u2014 the
            // same shape as the GPU cells beside it.
            function hostBits(inst) {
                const bits = [];
                if (inst.version) bits.push(inst.version);
                if (inst.reachable === false) bits.push('metrics unavailable');
                else if (inst.cpu_pct != null) bits.push('CPU ' + Number(inst.cpu_pct).toFixed(0) + '%');
                return bits;
            }
            if (instances.length > 1) {
                const hostLines = instances.slice(0, 4).map((inst) => {
                    const bits = hostBits(inst);
                    return String(inst.host || '?') + (bits.length ? ' \u2014 ' + bits.join(' \u00B7 ') : '');
                });
                if (instances.length > 4) hostLines.push('+' + (instances.length - 4) + ' more');
                bandCell(band, 'Inference Host', {
                    value: first.host,
                    subLines: hostLines,
                    tip: 'The headline host is the first that connected; it keeps '
                        + 'that place until it disconnects. Up to four connected hosts '
                        + 'are listed below it; any further ones are counted.',
                });
            } else if (first) {
                bandCell(band, 'Inference Host', {
                    value: first.host,
                    sub: hostBits(first).join(' \u00B7 '),
                    muted: first.reachable === false,
                });
            } else {
                bandCell(band, 'Inference Host', { value: 'none connected', muted: true });
            }

            // GPU utilization/memory: every inference GPU across every instance,
            // host-tagged. The cell's headline is the busiest GPU; with several
            // GPUs (or hosts) the subline becomes a bulleted per-GPU list.
            // Utilization falls back to the WSE host GPU when no instance
            // reports any (labeled as such).
            const allGpus = [];
            instances.forEach((inst) => {
                (Array.isArray(inst.gpus) ? inst.gpus : []).forEach((gpu) => {
                    allGpus.push({
                        label: (instances.length > 1 ? String(inst.host || '?') + ' ' : '')
                            + String(gpu.device != null ? gpu.device : ''),
                        util: gpu.utilization_pct != null ? Number(gpu.utilization_pct) : null,
                        usedBytes: gpu.memory_used_bytes,
                        totalBytes: gpu.memory_total_bytes,
                    });
                });
            });
            const multiGpu = allGpus.length > 1;
            let util = null;
            let utilDevice = null;
            allGpus.forEach((gpu) => {
                if (gpu.util != null && (util == null || gpu.util > util)) {
                    util = gpu.util;
                    utilDevice = gpu.label;
                }
            });
            let utilSource = '';
            if (util == null) {
                const hostBest = maxEntry(host.gpu_avg);
                if (hostBest) {
                    util = hostBest.value;
                    utilDevice = 'GPU ' + hostBest.id;
                    utilSource = ' (WSE host)';
                }
            }
            // The card/driver/CUDA identify the WSE HOST's GPU, not the inference
            // instance's (which can be a different machine entirely) — they
            // belong to the WSE GPU cell below, never this one.
            const utilLines = multiGpu
                ? allGpus.slice(0, 4).map((gpu) =>
                    gpu.label + ' — ' + (gpu.util != null ? gpu.util.toFixed(0) + '%' : 'n/a'))
                : [];
            if (multiGpu && allGpus.length > 4) utilLines.push('+' + (allGpus.length - 4) + ' more');
            bandCell(band, 'Inference GPU', {
                value: util != null ? util.toFixed(0) + '%' : null,
                barPct: util,
                sub: multiGpu ? '' : (utilDevice != null ? String(utilDevice) + utilSource : ''),
                subLines: utilLines,
                muted: util == null,
                tip: 'How busy the GPU running the models is. Low values mean headroom '
                    + 'for more streams or higher concurrent executions. Sustained values '
                    + 'near 100% mean analysis may fall behind: lower the Inference FPS '
                    + 'on busy streams or add GPU capacity.'
                    + (multiGpu ? ' The headline value is the busiest GPU.' : ''),
            });

            let memPct = null;
            let memSub = '';
            allGpus.forEach((gpu) => {
                if (gpu.usedBytes != null && gpu.totalBytes) {
                    const pct = (gpu.usedBytes / gpu.totalBytes) * 100;
                    if (memPct == null || pct > memPct) {
                        memPct = pct;
                        memSub = formatBytes(gpu.usedBytes) + ' / ' + formatBytes(gpu.totalBytes);
                    }
                }
            });
            const memLines = [];
            if (multiGpu) {
                allGpus.slice(0, 4).forEach((gpu) => {
                    if (gpu.usedBytes != null && gpu.totalBytes) {
                        memLines.push(gpu.label + ' — '
                            + ((gpu.usedBytes / gpu.totalBytes) * 100).toFixed(0) + '% ('
                            + formatBytes(gpu.usedBytes) + ' / ' + formatBytes(gpu.totalBytes) + ')');
                    }
                });
                if (allGpus.length > 4) memLines.push('+' + (allGpus.length - 4) + ' more');
            }
            bandCell(band, 'Inference GPU Memory', {
                value: memPct != null ? memPct.toFixed(0) + '%' : null,
                barPct: memPct,
                sub: memLines.length ? '' : memSub,
                subLines: memLines,
                muted: memPct == null,
                tip: 'VRAM in use on the inference GPU. Models keep their memory while '
                    + 'loaded, so a high value even with idle streams is normal. It limits '
                    + 'how many different models fit at once, not how busy they are.'
                    + (multiGpu ? ' The headline value is the fullest GPU.' : ''),
            });

            const hostGpuIds = {};
            [host.gpu_avg, host.gpu_memory_avg, host.gpu_encode_avg, host.gpu_decode_avg].forEach((map) => {
                if (map) for (const id in map) hostGpuIds[id] = true;
            });
            const hostGpuCount = Object.keys(hostGpuIds).length;
            // The band's bulleted cells carry the multi-host / multi-GPU story
            // themselves; the detail groups are only worth revealing for
            // a multi-GPU WSE HOST (per-GPU decode/encode has no band slot).
            setMetricDetailsVisible(hostGpuCount > 1);
        }

        function renderWseHostGroup()
        {
            renderHostCard('host-display', "WSE", jsonData.host.wse_version);
            renderHostCard('host-display', "WSE VIF Module", jsonData.host.vif_module_version);
            renderHostCard('host-display', "CPU", Number(jsonData.host.cpu_avg).toFixed(0), "%");

            const infoLine = document.getElementById('host-nvidia');
            if(jsonData.host.nvidia_gpu_type != 'unknown')
            {
                if (infoLine) {
                    infoLine.textContent = `Card: ${jsonData.host.nvidia_gpu_type}  ·  Driver: ${jsonData.host.nvidia_driver_version}  ·  CUDA: ${jsonData.host.cuda_version}`;
                }

                const metricMaps = [
                    jsonData.host.gpu_avg,
                    jsonData.host.gpu_memory_avg,
                    jsonData.host.gpu_encode_avg,
                    jsonData.host.gpu_decode_avg
                ];
                const gpuIds = [];
                metricMaps.forEach((map) => {
                    for (var id in map) {
                        if (gpuIds.indexOf(id) === -1) gpuIds.push(id);
                    }
                });
                gpuIds.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

                if (gpuIds.length > 0) {
                    const pct = (map, id) => (map && map[id] != null) ? Number(map[id]) : null;
                    renderGpuTableCard(document.getElementById('host-stats'), 'host-gpu-table', [
                        { key: 'utilization', label: 'Utilization' },
                        // nvidia-smi's memory-CONTROLLER utilization (how busy
                        // the memory bus was), NOT VRAM in use - labeled "Mem
                        // Bandwidth" to distinguish it from the Inference
                        // groups' "Memory" column, which does show real VRAM
                        // used/total. Honest label + tooltip.
                        { key: 'mem_bandwidth', label: 'Mem Bandwidth',
                            tip: "Percent of time the GPU's memory controller was busy — not VRAM in use." },
                        { key: 'encode', label: 'Encode' },
                        { key: 'decode', label: 'Decode' },
                    ], gpuIds.map((id) => ({
                        device: id,
                        cells: metricMaps.map((map) => ({ value: pct(map, id), unit: '%' })),
                    })));
                }
            }
            else if (infoLine) {
                infoLine.textContent = '';
            }
        }

        // Binary units, labeled as such: nvidia-smi and card specs count in
        // GiB/MiB, and printing them as "GB" understates by ~7%.
        function formatBytes(bytes)
        {
            if (bytes == null) return '';
            const gib = bytes / (1024 * 1024 * 1024);
            if (gib >= 1) return `${gib.toFixed(1)} GiB`;
            return `${(bytes / (1024 * 1024)).toFixed(0)} MiB`;
        }

        function renderInferenceGroups(visInstances)
        {
            const container = document.getElementById('vis-instances-container');
            if (!container) return;
            clearElementContent(container);

            if (!Array.isArray(visInstances) || visInstances.length === 0) {
                return;
            }

            visInstances.forEach((instance, index) => {
                const group = document.createElement('div');
                group.className = 'metric-group';

                const title = document.createElement('div');
                title.className = 'metric-group-title';
                // The tooltip belongs on an inline span, not the full-width row: a title
                // on the <div> fires anywhere across the empty space beside the heading.
                const titleText = document.createElement('span');
                titleText.className = 'metric-group-title-text';
                titleText.textContent = instance.version
                    ? `Inference — ${instance.host} (${instance.version})`
                    : `Inference — ${instance.host}`;
                titleText.title = 'If the Inference Service runs on the same machine as Wowza Streaming Engine (WSE), this may be the same physical GPU shown under WSE Host.';
                title.appendChild(titleText);
                group.appendChild(title);

                const streamList = Array.isArray(instance.streams) ? instance.streams : [];
                const streamsLine = document.createElement('div');
                streamsLine.className = 'host-info-line';
                streamsLine.textContent = streamList.length > 0
                    ? `Streams: ${streamList.join(', ')}`
                    : 'No streams currently routed to this instance';
                group.appendChild(streamsLine);

                const grid = document.createElement('div');
                grid.className = 'host-container metric-grid';
                grid.id = `vis-instance-${index}-grid`;
                group.appendChild(grid);

                container.appendChild(group);

                if (instance.reachable === false) {
                    // Stale gpus/cpu, per the contract - never render blank.
                    const card = document.createElement('div');
                    card.className = 'metric-card metric-card-muted';
                    card.title = instance.age_seconds != null
                        ? `Last seen ${instance.age_seconds}s ago`
                        : 'Reachability unknown';
                    card.innerHTML = `
                        <div class="metric-label">Status</div>
                        <div class="metric-value">Metrics unavailable</div>
                    `;
                    grid.appendChild(card);
                    return;
                }

                // cpu_pct is null (not 0) on older VIS builds with no CPU gauge -
                // omit the card entirely rather than show a misleading "0%"/"-".
                if (instance.cpu_pct != null) {
                    renderHostCard(grid.id, "CPU", Number(instance.cpu_pct).toFixed(0), "%");
                }

                const gpus = Array.isArray(instance.gpus) ? instance.gpus : [];
                if (gpus.length > 0) {
                    renderGpuTableCard(group, `vis-instance-${index}-gpu-table`, [
                        { key: 'utilization', label: 'Utilization' },
                        { key: 'memory', label: 'Memory' },
                    ], gpus.map((gpu, gpuIndex) => {
                        const hasMemTotals = gpu.memory_used_bytes != null && gpu.memory_total_bytes;
                        const memPct = hasMemTotals ? (gpu.memory_used_bytes / gpu.memory_total_bytes) * 100 : null;
                        return {
                            device: gpu.device || String(gpuIndex),
                            cells: [
                                { value: gpu.utilization_pct != null ? Number(gpu.utilization_pct) : null, unit: '%' },
                                { value: memPct, unit: '%',
                                    title: hasMemTotals ? `${formatBytes(gpu.memory_used_bytes)} / ${formatBytes(gpu.memory_total_bytes)}` : '' },
                            ],
                        };
                    }));
                }

                if (gpus.length === 0 && instance.cpu_pct == null) {
                    const card = document.createElement('div');
                    card.className = 'metric-card metric-card-muted';
                    card.innerHTML = `
                        <div class="metric-label">Status</div>
                        <div class="metric-value">No metrics reported</div>
                    `;
                    grid.appendChild(card);
                }
            });
        }

        function getStoredThumbnailsOn()
        {
            try {
                return window.localStorage.getItem(THUMBNAILS_STORAGE_KEY) === 'true';
            } catch (error) {
                return false;
            }
        }

        function storeThumbnailsOn(isOn)
        {
            try {
                window.localStorage.setItem(THUMBNAILS_STORAGE_KEY, isOn ? 'true' : 'false');
            } catch (error) {
                // Ignore storage issues and keep the page working normally.
            }
        }

        function updateThumbnail()
        {
            const toggle = document.getElementById('thumbnailToggle');
            thumbnailsOn = toggle ? toggle.checked : !thumbnailsOn;
            storeThumbnailsOn(thumbnailsOn);
            lastStreamCount = 0;
            renderDashboard();
        }

        async function updateActive(id, appName, streamName) {
            if (dashboardMutationInFlight) return;
            checkbox = document.getElementById(id+'-activeToggle');
            const data = {
                config: { active: checkbox.checked }
            }
            try {
                await runDashboardMutation(id + '-row', async () => {
                    await apiCall(appName, streamName, data);
                });
            } catch (error) {
                console.error("Error updating active data:", error);
                restoreDashboardStateNow();
            }
        }

        // A runtime-only write (ephemeral - never persisted): read the running
        // stream, set the members `settings` names on the tracked model, and save
        // — the patch carries exactly those members and quotes the revision just
        // read. The read lives inside the attempt, so a lost revision race
        // re-reads and retries once.
        async function apiCall(appName, streamName, settings)
        {
            const streams = VIF.core.client().runtime.streams;
            return VIF.core.withConflictRetry(async () => {
                const current = await streams.get(appName, streamName);
                assignLeaves(current, settings);
                return current.save();
            });
        }

        // Writes each leaf of `patch` onto `target`, so a tracked model marks the
        // leaves rather than the section that holds them.
        function assignLeaves(target, patch)
        {
            Object.keys(patch).forEach((key) => {
                const value = patch[key];
                const nested = value !== null && typeof value === 'object' && !Array.isArray(value);
                if (nested && target[key] !== null && typeof target[key] === 'object') {
                    assignLeaves(target[key], value);
                } else {
                    target[key] = value;
                }
            });
        }

        function toTitleCaseRegex(str) {
          // Normalize to lowercase first
          return str.toLowerCase().replace(/(^|\s)\S/g, function(match) {
            return match.toUpperCase();
          });
        }

        function computeFramesWindowNote(sliderValue, durationRaw, windowed) {
            if (!windowed) return '';
            const dur = Number(durationRaw);
            const fps = Number(sliderValue);
            if (!isFinite(dur) || dur <= 0 || !isFinite(fps)) return '';
            const frames = Math.max(1, Math.round(fps * dur));
            return ` = ${frames} frames per ${dur}s window`;
        }

        function updateSkipFrameDisplay(id) {
            const slider = document.getElementById(`${id}-skipSlider`);
            if (!slider) return;
            skipValueDisplay = document.getElementById(`${id}-skipValue`);
            if (!skipValueDisplay) return;
            const n = parseInt(slider.value);
            skipValueDisplay.innerText = n;
            const noteEl = document.getElementById(`${id}-frames-window`);
            if (noteEl) {
                const noteText = computeFramesWindowNote(slider.value, slider.dataset.duration, slider.dataset.windowed === 'true');
                noteEl.textContent = noteText;
                // Circled-? help-tip for the per-window note: its explanatory
                // title lives on the tip, appended right AFTER the note - but only
                // while the note actually has text (non-windowed detectors leave
                // the note empty), so a lone "?" never floats there on its own.
                let noteTip = document.getElementById(`${id}-frames-window-tip`);
                if (noteText) {
                    if (!noteTip) {
                        noteTip = document.createElement('span');
                        noteTip.id = `${id}-frames-window-tip`;
                        noteTip.className = 'vif-help-tip';
                        noteTip.textContent = '?';
                        noteEl.insertAdjacentElement('afterend', noteTip);
                    }
                    // VLM endpoints cap images per request and the service thins oversized
                    // windows before the model sees them, so a VLM row's tip must not imply
                    // every captured frame is analyzed. Scene windows have no such cap.
                    noteTip.title = slider.dataset.detector === 'vlm'
                        ? 'One analysis request per window: Inference FPS × duration frames.\n'
                            + 'VLM endpoints cap images per request (the bundled endpoint defaults to 8). '
                            + 'Frames beyond the cap are evenly subsampled away by the service, '
                            + 'so they add bandwidth, not analysis.'
                        : 'Batched detectors send one request per window. Each window contains "Inference FPS × duration" frames.';
                } else if (noteTip) {
                    noteTip.remove();
                }
            }
        }

        function handleSkipFrameInput(id, appName, streamName) {
            setSkipSliderInteraction(appName, streamName, true);
            updateSkipFrameDisplay(id);
        }

        function clearSkipFrameInteraction(appName, streamName) {
            setSkipSliderInteraction(appName, streamName, false);
        }

        async function updateSkipFrame(id, appName, streamName) {
            if (dashboardMutationInFlight) return;
            const slider = document.getElementById(`${id}-skipSlider`);
            if (!slider) return;
            clearSkipFrameInteraction(appName, streamName);
            const data = {
                config: { processing: { inferenceFps: parseInt(slider.value) } }
            };
            try {
                await runDashboardMutation(id + '-row', async () => {
                    await apiCall(appName, streamName, data);
                });
            } catch (error) {
                console.error("Error updating skip frame data:", error);
                restoreDashboardStateNow();
            }
        }

        function loadPlayerPage(host, appName, streamName)
        {
			playback_host = pluginProperties.playback_host || host;
			playback_port = pluginProperties.playback_port ? `:${pluginProperties.playback_port}` : "";
            const playbackUrl = `${protocol}//${playback_host}${playback_port}/${appName}/${streamName}/playlist.m3u8`;
            loadAjaxPluginContent("server","vif", `playback.html?src=${encodeURIComponent(playbackUrl)}`, "");
        }
        // Must stay a true global - see the file-header comment: the
        // thumbnail link's `javascript:loadPlayerPage(...)` href resolves
        // this name against the global scope at click time.
        window.loadPlayerPage = loadPlayerPage;

        function securityCheck()
        {
            springSecurityCheck();
        }

        async function springSecurityCheck() {
            try {

                const response = await fetch(`${protocol}//${host}`, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Basic ${encodedCredentials}`,
                        'Content-Type': 'application/json'
                    }
                });

                content = await response.text();

            } catch (error) {
                // Config buttons stay visible (F13) - defaultJson() + renderDashboard()
                // below drive them into the disabled "Waiting for Engine connection"
                // state via the offline branch of renderDashboard's early return.
                defaultJson();
                clearInterval(renderdashboardId);
                clearInterval(securityCheckId);
                renderDashboard();
                console.error("Security Error:", error);
            }
        }

        // 🎮 Konami Code Easter Egg
        var konamiCode = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyO', 'KeyW', 'KeyZ', 'KeyA'];
        var konamiIndex = 0;
        function handleKonami(e) {
            const key = e.code;
            if (key === konamiCode[konamiIndex]) {
                konamiIndex++;
                console.log(`Konami: ${konamiIndex}/${konamiCode.length}`);
                if (konamiIndex === konamiCode.length) {
                    activateEasterEgg();
                    konamiIndex = 0;
                }
            } else {
                konamiIndex = 0;
            }
        }
        // Remove the OLD reference if it exists, then store the new one
        if (window._konamiHandler) {
            window.removeEventListener('keydown', window._konamiHandler);
        }
        window._konamiHandler = handleKonami;
        window.addEventListener('keydown', window._konamiHandler);

        function activateEasterEgg() {
            // Create Matrix canvas
            const canvas = document.createElement('canvas');
            canvas.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100vw;
                height: 100vh;
                z-index: 9999;
                pointer-events: none;
            `;
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            document.body.appendChild(canvas);

            const ctx = canvas.getContext('2d');
            const letters = 'WOWZA'.split('');
            const fontSize = 16;
            const columns = Math.floor(canvas.width / fontSize);
            const drops = Array(columns).fill(1);

            // Show message
            const msg = document.createElement('div');
            msg.innerHTML = '🔥 WOWZA VIF 🔥';
            msg.style.cssText = `
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: linear-gradient(135deg, #ff8400 0%, #ff5500 100%);
                color: white;
                padding: 30px 50px;
                border-radius: 16px;
                font-size: 28px;
                font-weight: bold;
                z-index: 10001;
                box-shadow: 0 20px 60px rgba(255,132,0,0.5);
                animation: popIn 0.5s cubic-bezier(0.68, -0.55, 0.265, 1.55);
                text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
            `;
            document.body.appendChild(msg);

            // Add animation keyframes
            const style = document.createElement('style');
            style.textContent = `
                @keyframes popIn {
                    0% { transform: translate(-50%, -50%) scale(0); opacity: 0; }
                    100% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
                }
            `;
            document.head.appendChild(style);

            // Matrix rain animation
            let frameCount = 0;
            const maxFrames = 300; // ~5 seconds at 60fps

            function drawMatrix() {
                ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
                ctx.fillRect(0, 0, canvas.width, canvas.height);

                ctx.fillStyle = '#ff8400';
                ctx.font = `bold ${fontSize}px monospace`;
                ctx.shadowBlur = 10;
                ctx.shadowColor = '#ff8400';

                for (let i = 0; i < drops.length; i++) {
                    const letter = letters[Math.floor(Math.random() * letters.length)];
                    ctx.fillText(letter, i * fontSize, drops[i] * fontSize);

                    if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) {
                        drops[i] = 0;
                    }
                    drops[i]++;
                }

                frameCount++;
                if (frameCount < maxFrames) {
                    requestAnimationFrame(drawMatrix);
                } else {
                    // Fade out and cleanup
                    canvas.style.transition = 'opacity 0.5s';
                    canvas.style.opacity = '0';
                    setTimeout(() => canvas.remove(), 500);
                }
            }

            drawMatrix();

            // Remove message after 3 seconds
            setTimeout(() => msg.remove(), 3000);
        }

        initJson();
        renderDashboard();
        thumbnails = document.getElementById('thumbnailToggle');
        thumbnails.checked = thumbnailsOn;
        thumbnails.addEventListener('change', updateThumbnail.bind());

        renderdashboardId = setInterval(renderDashboard, 1000);
        securityCheckId = setInterval(securityCheck,15000);

        window.__vifDashboardDestroy = function () {
            clearInterval(renderdashboardId);
            clearInterval(securityCheckId);
            window.__vifDashboardDestroy = null;
        };
    };
})();
