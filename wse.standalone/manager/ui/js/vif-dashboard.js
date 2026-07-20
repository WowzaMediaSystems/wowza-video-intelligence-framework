(function () {
    window.VIF = window.VIF || {};
    var VIF = window.VIF;
    VIF.dashboard = VIF.dashboard || {};

    // Single source of truth for the dashboard's warn/alert color
    // thresholds (metric cards, GPU-table cells, and setFramesDetected's
    // "frames analyzed rate" coloring).
    var DASHBOARD_THRESHOLDS = {
        CPU_PCT: { warn: 50, alert: 70 },
        GPU_UTIL_PCT: { warn: 50, alert: 70 },
        GPU_MEMORY_PCT: { warn: 40, alert: 70 },
        GPU_ENCODE_PCT: { warn: 50, alert: 70 },
        GPU_DECODE_PCT: { warn: 50, alert: 70 },
        FRAMES_ANALYZED_RATE_PCT: { alert: 25, warn: 50 }
    };

    var FRAMES_ROLLING_WINDOW_MS = 60000;

    var DASHBOARD_COMPACT_METRICS = true;

    VIF.dashboard.init = function () {

        if (typeof window.__vifPlaybackDestroy === 'function') {
            try {
                window.__vifPlaybackDestroy();
            } catch (error) {
                console.error("Error destroying existing playback session:", error);
            }
        }

        var resolvedServer = VIF.core.resolveServer();
        var serverUrl = resolvedServer.serverUrl;
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

        jsonData = null;
        var lastStreamCount=0;
        var thumbnailsOn = false;
        var skipStatusUpdate = 0;
        var dashboardMutationInFlight = false;
        var liveUpdatesPromise = null;
        var dashboardRenderInFlight = false;
        var activeSkipSliderInteractions = new Set();
        var framesDetectedHistory = {};

        // Last committed frames-detected display per stream, plus a consecutive-"0 of 0"
        // counter. A single "0 of 0" reading is normally just the gap between two analysis
        // bursts, so setFramesDetected() holds the previous reading the first time it appears
        // and only commits to "0 of 0" once it repeats. Pruned alongside framesDetectedHistory.
        var framesDetectedDisplay = {};

        async function getLiveUpdates() {
            if (liveUpdatesPromise) {
                return liveUpdatesPromise;
            }

            liveUpdatesPromise = (async () => {
                try {

                    const response = await fetch(`${serverUrl}/v1/server/plugin/vif/status`, {
                        method: 'GET',
                        headers: {
                            'Authorization': `Basic ${encodedCredentials}`,
                            'Content-Type': 'application/json'
                        }
                    });
                    const nextJsonData = await response.json();

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
            ['btn-default-config', 'btn-stream-configs'].forEach((btnId) => {
                const btn = document.getElementById(btnId);
                if (!btn) return;
                btn.disabled = !enabled;
                btn.title = enabled ? '' : 'Waiting for Engine connection';
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
                    renderHostCard('host-display', "WSE", jsonData.host.wse_version, undefined, "a","e");
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

                renderWseHostGroup();
                // jsonData.vis_instances is undefined for a legacy VIC jar's /status
                // payload; renderInferenceGroups treats that as "no groups" and
                // leaves the WSE Host group as the only thing rendered (F13/D5).
                renderInferenceGroups(jsonData.vis_instances);

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

        function pruneFramesDetectedHistory(streams) {
            const currentIds = Array.isArray(streams)
                ? streams.map((stream) => stream.app_name + "-" + stream.stream_name)
                : [];
            Object.keys(framesDetectedHistory).forEach((id) => {
                if (currentIds.indexOf(id) === -1) {
                    delete framesDetectedHistory[id];
                    delete framesDetectedDisplay[id];
                }
            });
        }

        function renderNoActiveStreamsRow(tbody) {
            if (!tbody) return;
            clearElementContent(tbody);
            const tr = document.createElement('tr');
            tr.className = 'empty-streams-row';
            tr.innerHTML = '<td colspan="8">No VIF Streams</td>';
            tbody.appendChild(tr);
        }

        function renderStreamData(streams) {
            pruneFramesDetectedHistory(streams);

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
                            <td align="right">
                                <strong id="${id}-stream-name"></strong>
                                <br>
                                <div class="vif-controls">Active&nbsp;
                                    <label class="switch">
                                        <input type="checkbox" id="${id}-activeToggle">
                                        <span class="slider-switch"></span>
                                    </label>
                                </div>
                            </td>
                            <td class="align-right">
                                <div class="vif-row"><div title="source resolution" id="${id}-res"></div>&nbsp;@&nbsp;<div title="Source fps" id="${id}-fps"></div><div title="Inference fps" id="${id}-dfps"></div>&nbsp;(<div title="equivalent ms" id="${id}-equ"></div>) </div>
                                <div class="vif-row" id="${id}-gopContainer" style="${(stream.use_transcoder && stream.detector_type !== 'synthetic') ? 'display:none;' : ''}"><div title="gop size" id="${id}-gop"></div></div>
                                <div class="vif-controls align-right vif-skip-controls" id="${id}-skipSliderContainer" style="${(stream.use_transcoder && stream.detector_type !== 'synthetic') ? '' : 'display:none;'}">
                                    <div class="vif-skip-line">Inference fps<input type="range" class="slider" id="${id}-skipSlider" min="1" max="${stream.frame_rate}" value="${stream.inference_fps}"><span id="${id}-skipValue" class="vif-skip-value">${stream.inference_fps}</span></div>
                                    <div class="vif-skip-note-line"><span id="${id}-frames-window" class="frames-window-note"></span></div>
                                </div>
                                <div class="align-right" id="${id}-vihost" style="font-style:italic"></div>
                                <div id="${id}-sts"></div>
                                <div id="${id}-vlm-health" class="row-status-line"></div>
                            </td>
                            <td align="right"><div id="${id}-ping"></div></td>
                            <td align="right"><div id="${id}-ttl-proc"></div></td>
                            <td align="right"><div id="${id}-frame-detect" title="Total Object Processing Time"></div></td>
                            <td align="right"><div id="${id}-frame-detect-avg"></div></td>
                            <td align="right"><a id="${id}-thumbnail-link"><img src="${pathPrefix}thumb.png" id="${id}-thumbnail" height=110 alt="Thumbnail"></a></td>
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
                        if(stream.gop_size != null && stream.gop_size >0) {
                            const mismatch = stream.gop_size != null && stream.frame_grab_interval != null
                                && Math.round(stream.gop_size / stream.frame_rate * 1000) !== Math.round(stream.frame_grab_interval * 1000);
                            gopEl.style.color = mismatch ? '#cc9900' : '';
                            if (mismatch) {
                                gopEl.textContent += ` (${Math.round(stream.gop_size / stream.frame_rate * 1000)}ms with frame grab of ${Math.round(stream.frame_grab_interval * 1000)}ms)`;
                            }
                        }
                    }
                    const skipSliderContainer = document.getElementById(id+"-skipSliderContainer");
                    if (skipSliderContainer) skipSliderContainer.style.display = (stream.use_transcoder && !isSynthetic) ? '' : 'none';
                    slider = document.getElementById(id+"-skipSlider");
                    slider.max = stream.frame_rate;
                    slider.dataset.windowed = (stream.detector_type === 'scene' || stream.detector_type === 'vlm') ? 'true' : 'false';
                    slider.dataset.duration = (stream.duration != null) ? String(stream.duration) : '';
                    if (!isSkipSliderInteracting(stream.app_name, stream.stream_name)) {
                        slider.value = stream.inference_fps;
                        updateSkipFrameDisplay(id);
                    }
                    dfps = document.getElementById(id+"-dfps");
                    dfps.textContent = `/${stream.inference_fps}fps`;
                    dfps.style.display = (stream.use_transcoder && !isSynthetic) ? '' : 'none';
                    equ = document.getElementById(id+"-equ");
                    equ.textContent = `${Number(1/stream.frame_rate*1000).toFixed(0)}ms`

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


                    reason = document.getElementById(id+"-reason");
                    reason.textContent = `${stream.reason}`;
                    reason.title = reason.textContent;
                    reason.className = 'row-status-line ' + (reason.textContent.toLowerCase().includes('error') ? 'text-alert' : 'text-warn');

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

            const rand = new Date().getTime();
            const thumbnail_link = document.getElementById(thumbnailId+"-link");
            var stream_name = stream.stream_name;
            loadImage(`${serverUrl}/v1/server/plugin/vif/applications/${encodeURIComponent(stream.app_name)}/streams/${encodeURIComponent(stream_name)}/thumbnail?fitMode=fitheight&height=180&overlay=true&random=+${rand}`,`${pathPrefix}thumb.png`,thumbnailId);
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


        function getFramesDetectedAggregate(streamId, frms, frmsTtl) {
            const now = Date.now();
            let history = framesDetectedHistory[streamId];
            if (!history) {
                history = [];
                framesDetectedHistory[streamId] = history;
            }
            history.push({ t: now, frms: frms, frmsTtl: frmsTtl });
            while (history.length > 0 && now - history[0].t > FRAMES_ROLLING_WINDOW_MS) {
                history.shift();
            }
            let best = history[0];
            for (let i = 1; i < history.length; i++) {
                if (history[i].frmsTtl >= best.frmsTtl) {
                    best = history[i];
                }
            }
            return best;
        }

        function setFramesDetected(frameDetectId, stream) {
            const frame_detect2 = document.getElementById(frameDetectId);
            const streamId = stream.app_name + "-" + stream.stream_name;
            if(!stream.active) {
                frame_detect2.textContent = `-`;
                frame_detect2.className = '';
                // Start clean the next time this stream goes active, instead
                // of momentarily showing a burst reading from before it was
                // toggled off.
                delete framesDetectedHistory[streamId];
                delete framesDetectedDisplay[streamId];
            }
            else {
                let frms = 0;
                let frms_ttl = 0;
                const perf = stream.performance;
                if(perf.video_frames_ttl > 0) {
					frms = perf.frames_detected;
					frms_ttl = perf.video_frames_ttl;
                }

                const aggregate = getFramesDetectedAggregate(streamId, frms, frms_ttl);
                const aggFrms = aggregate.frms;
                const aggFrmsTtl = aggregate.frmsTtl;
                const v = aggFrmsTtl > 0 ? Math.min((aggFrms / aggFrmsTtl) * 100.0, 100.0) : 0;

                const text = `${aggFrms} of ${aggFrmsTtl} frames (${Number(v).toFixed(0)}%)`;
                const title = `${aggFrms} of the ${aggFrmsTtl} frames WSE recently captured were analyzed by VIS (${Number(v).toFixed(0)}% keep-up)`;

                // Red/alert only for a genuine stall: connected AND zero
                // analyzed frames anywhere in the rolling window - never
                // merely because this poll landed in the gap between two
                // bursts. When not connected, the stream-status cell already
                // carries its own alert; don't stack a second one here on
                // top of the zero reading that naturally follows.
                const isConnected = String(stream.status).toLowerCase() === 'connected';
                let cls;
                if (aggFrmsTtl === 0) {
                    cls = isConnected ? 'text-alert' : '';
                } else {
                    cls = v < DASHBOARD_THRESHOLDS.FRAMES_ANALYZED_RATE_PCT.alert ? 'text-alert' : v < DASHBOARD_THRESHOLDS.FRAMES_ANALYZED_RATE_PCT.warn ? 'text-warn' : 'text-good';
                }

                // A lone "0 of 0" reading is normally just the gap between two analysis
                // bursts, not a real stall. Hold the previous reading the first time it
                // appears; only commit to "0 of 0" once it repeats on a later poll.
                let display = framesDetectedDisplay[streamId];
                if (!display) {
                    display = { text: null, title: null, cls: null, zeroStreak: 0 };
                    framesDetectedDisplay[streamId] = display;
                }
                if (aggFrmsTtl === 0) {
                    display.zeroStreak++;
                    if (display.zeroStreak === 1 && display.text !== null) {
                        frame_detect2.textContent = display.text;
                        frame_detect2.title = display.title;
                        frame_detect2.className = display.cls;
                        return;
                    }
                } else {
                    display.zeroStreak = 0;
                }

                frame_detect2.textContent = text;
                frame_detect2.title = title;
                frame_detect2.className = cls;
                display.text = text;
                display.title = title;
                display.cls = cls;
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
                        if (col.alert != null && cell.value > col.alert) {
                            td.classList.add('gpu-cell-alert');
                        } else if (col.warn != null && cell.value > col.warn) {
                            td.classList.add('gpu-cell-warn');
                        }
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

        function renderHostCard(container, label, value, unit, yellow, red)
        {
            const hostContainer = document.getElementById(container);

            // // Alert Logic for Host
            let alertClass = '';
            if (value > yellow) {
                alertClass = 'card-warn';
            }
            if (value > red) {
                alertClass = 'card-alert';
            }
            if(unit === undefined) {
                unit = '';
            }

            const card = document.createElement('div');
            card.className = `metric-card ${alertClass}`;
            card.innerHTML = `
                <div class="metric-label">${label}</div>
                <div class="metric-value">${value}${unit}</div>
            `;
            hostContainer.appendChild(card);
            return card;
        }

        function renderWseHostGroup()
        {
            renderHostCard('host-display', "WSE", jsonData.host.wse_version);
            renderHostCard('host-display', "WSE VIF Module", jsonData.host.vif_module_version);
            renderHostCard('host-display', "CPU", Number(jsonData.host.cpu_avg).toFixed(0), "%",
                DASHBOARD_THRESHOLDS.CPU_PCT.warn, DASHBOARD_THRESHOLDS.CPU_PCT.alert);

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
                        { key: 'utilization', label: 'Utilization',
                            warn: DASHBOARD_THRESHOLDS.GPU_UTIL_PCT.warn, alert: DASHBOARD_THRESHOLDS.GPU_UTIL_PCT.alert },
                        // nvidia-smi's memory-CONTROLLER utilization (how busy
                        // the memory bus was), NOT VRAM in use - labeled "Mem
                        // Bandwidth" to distinguish it from the Inference
                        // groups' "Memory" column, which does show real VRAM
                        // used/total. Honest label + tooltip.
                        { key: 'mem_bandwidth', label: 'Mem Bandwidth',
                            tip: "Percent of time the GPU's memory controller was busy — not VRAM in use.",
                            warn: DASHBOARD_THRESHOLDS.GPU_MEMORY_PCT.warn, alert: DASHBOARD_THRESHOLDS.GPU_MEMORY_PCT.alert },
                        { key: 'encode', label: 'Encode',
                            warn: DASHBOARD_THRESHOLDS.GPU_ENCODE_PCT.warn, alert: DASHBOARD_THRESHOLDS.GPU_ENCODE_PCT.alert },
                        { key: 'decode', label: 'Decode',
                            warn: DASHBOARD_THRESHOLDS.GPU_DECODE_PCT.warn, alert: DASHBOARD_THRESHOLDS.GPU_DECODE_PCT.alert },
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

        function formatBytes(bytes)
        {
            if (bytes == null) return '';
            const gb = bytes / (1024 * 1024 * 1024);
            if (gb >= 1) return `${gb.toFixed(1)} GB`;
            return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
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
                title.textContent = instance.version
                    ? `Inference — ${instance.host} (${instance.version})`
                    : `Inference — ${instance.host}`;
                title.title = 'If the Inference Service runs on the same machine as WSE, this may be the same physical GPU shown under WSE Host.';
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
                    renderHostCard(grid.id, "CPU", Number(instance.cpu_pct).toFixed(0), "%",
                        DASHBOARD_THRESHOLDS.CPU_PCT.warn, DASHBOARD_THRESHOLDS.CPU_PCT.alert);
                }

                const gpus = Array.isArray(instance.gpus) ? instance.gpus : [];
                if (gpus.length > 0) {
                    renderGpuTableCard(group, `vis-instance-${index}-gpu-table`, [
                        { key: 'utilization', label: 'Utilization',
                            warn: DASHBOARD_THRESHOLDS.GPU_UTIL_PCT.warn, alert: DASHBOARD_THRESHOLDS.GPU_UTIL_PCT.alert },
                        { key: 'memory', label: 'Memory',
                            warn: DASHBOARD_THRESHOLDS.GPU_MEMORY_PCT.warn, alert: DASHBOARD_THRESHOLDS.GPU_MEMORY_PCT.alert },
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

        function updateThumbnail()
        {
            thumbnailsOn = !thumbnailsOn;
            lastStreamCount = 0;
            renderDashboard();
        }

        async function updateActive(id, appName, streamName) {
            if (dashboardMutationInFlight) return;
            checkbox = document.getElementById(id+'-activeToggle');
            const data = {
                active: checkbox.checked
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

        async function apiCall(appName, streamName, data)
        {
            const response = await fetch(`${serverUrl}/v1/server/plugin/vif/applications/${encodeURIComponent(appName)}/streams/${encodeURIComponent(streamName)}`, {
                method: 'PUT',
                body: JSON.stringify(data),
                headers: {
                    'Authorization': `Basic ${encodedCredentials}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`);
            }

            const contentType = response.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
                return await response.json();
            }
            return await response.text();
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
            return ` = ${frames} frames / ${dur}s request`;
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
                        noteTip.title = 'Batched detectors send one request per window. Each window contains "Inference FPS × duration" frames.';
                        noteEl.insertAdjacentElement('afterend', noteTip);
                    }
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
                inference_fps: parseInt(slider.value)
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
        thumbnails.addEventListener('change', updateThumbnail.bind());

        renderdashboardId = setInterval(renderDashboard, 1000);
        securityCheckId = setInterval(securityCheck,15000);
    };
})();
