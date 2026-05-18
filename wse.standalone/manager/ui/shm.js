
        if (typeof window.__vifPlaybackDestroy === 'function') {
            try {
                window.__vifPlaybackDestroy();
            } catch (error) {
                console.error("Error destroying existing playback session:", error);
            }
        }

        jsonData = null;
        vifPlaybackUrl = '';
        var credentials = `${username}:${password}`;
        var encodedCredentials = btoa(credentials);
        var lastStreamCount=0;
        var thumbnailsOn = false;
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

        function setDashboardControlsDisabled(disabled)
        {
            document.querySelectorAll('#streams-table input[type="checkbox"], #streams-table input[type="range"]').forEach((control) => {
                control.disabled = disabled;
            });
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

        async function runDashboardMutation(updateAction)
        {
            if (dashboardMutationInFlight) {
                return false;
            }

            dashboardMutationInFlight = true;
            skipStatusUpdate = Math.max(skipStatusUpdate, 2);
            setDashboardControlsDisabled(true);

            try {
                await updateAction();
                return true;
            } finally {
                dashboardMutationInFlight = false;
                setDashboardControlsDisabled(false);
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
                    renderHostCard('host-display', "WSE", jsonData.host.wse_version, undefined, "a","e");
                    const tbody = document.getElementById('streams-body');
                    const thumbnailDisplay = document.getElementById('thumbnail-display');
                    clearElementContent(tbody);
                    clearElementContent(thumbnailDisplay);
                    active_streams = document.getElementById('active-streams');
                    active_streams.textContent = "-";
                    header_values = document.getElementById("header-values");
                    header_values.textContent = "";
                    document.getElementById('config-streams').style.display = "none";
                    return;
                }

                document.getElementById('config-streams').style.display = "inline-block";

                renderHostCard('host-display', "WSE", jsonData.host.wse_version);
                renderHostCard('host-display', "WSE VIF Module", jsonData.host.vif_module_version);
                renderHostCard('host-display', "CPU", Number(jsonData.host.cpu_avg).toFixed(0), "%", 50, 70);

                if(jsonData.host.nvidia_gpu_type != 'unknown')
                {
                    renderHostCard('host-nvidia', "Card", jsonData.host.nvidia_gpu_type);
                    renderHostCard('host-nvidia', "Driver", jsonData.host.nvidia_driver_version);
                    renderHostCard('host-nvidia', "Cuda", jsonData.host.cuda_version);

                    renderHostCardValues('host-stats', "GPU", jsonData.host.gpu_avg, "%", 50, 70 );
                    renderHostCardValues('host-stats', "GPU Memory", jsonData.host.gpu_memory_avg, "%", 40, 70 );
                    renderHostCardValues('host-stats', "GPU Encode", jsonData.host.gpu_encode_avg, "%", 50, 70 );
                    renderHostCardValues('host-stats', "GPU Decode", jsonData.host.gpu_decode_avg, "%", 50, 70 );
                }
                active_stream_count = get_active_stream_count(jsonData.streams);
                active_streams = document.getElementById('active-streams');
                active_streams.textContent = active_stream_count;

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
            tr.innerHTML = '<td colspan="8">No active streams</td>';
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
                                <div class="vif-controls" id="${id}-overlay-controls">Overlay&nbsp;
                                    <label class="switch">
                                        <input type="checkbox" id="${id}-overlayToggle">
                                        <span class="slider-switch"></span>
                                    </label>
                                </div>
                            </td>
                            <td class="align-right">
                                <div class="vif-row"><div title="source resolution" id="${id}-res"></div>&nbsp;@&nbsp;<div title="source fps" id="${id}-fps"></div> / <div title="detected fps" id="${id}-dfps"></div>&nbsp;(<div title="equivalent ms" id="${id}-equ"></div>) </div>
                                <div class="vif-row" id="${id}-gopContainer" style="${stream.use_transcoder ? 'display:none;' : ''}"><div title="gop size" id="${id}-gop"></div></div>
                                <div class="vif-controls align-right" id="${id}-skipSliderContainer" style="${stream.use_transcoder ? '' : 'display:none;'}">
                                    Skipped fps<input type="range" class="slider" id="${id}-skipSlider" min="0" max="${stream.frame_rate-1}" value="${stream.skip_frames}"><span id="${id}-skipValue">${stream.skip_frames}</span>
                                </div>
                                <div class="align-right" id="${id}-vihost" style="font-style:italic"></div>
                                <div id="${id}-sts"></div>
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
                            <td colspan=8 align="left" height=14>
                                <div id="${id}-reason"></div>
                            </td>`;
                        tbody.appendChild(tr2);
                        active = document.getElementById(id+'-activeToggle');
                        active.addEventListener('change', updateActive.bind(null, id, stream.app_name, stream.stream_name));

                        overlay = document.getElementById(id+'-overlayToggle');
                        overlay.addEventListener('change', updateOverlay.bind(null, id, stream.app_name, stream.stream_name));

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
                    if(stream.detector_type == "scene") {
                        duration.textContent = `Window: ${stream.duration}s`;
                    } else {
                        duration.textContent = "";
                    }

                    stream_name = document.getElementById(id+"-stream-name");
                    stream_name.textContent = stream.app_name + "/" + stream.stream_name;

                    active = document.getElementById(id+'-activeToggle');
                    active.checked = stream.active;

                    overlay_controls = document.getElementById(id+'-overlay-controls');
                    overlay_controls.style.display = "flex";
                    overlay = document.getElementById(id+'-overlayToggle');
                    const overlayMethods = getOverlayListenerMethods(stream.vif_event_listeners);
                    overlay.checked = Array.isArray(overlayMethods) && overlayMethods.indexOf("immediate") !== -1;

                    res = document.getElementById(id+"-res");
                    res.textContent = `${stream.width}x${stream.height}`;
                    fps = document.getElementById(id+"-fps");
                    fps.textContent = `${stream.frame_rate}fps`
                    const gopContainer = document.getElementById(id+"-gopContainer");
                    if (gopContainer) gopContainer.style.display = stream.use_transcoder ? 'none' : '';
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
                    if (skipSliderContainer) skipSliderContainer.style.display = stream.use_transcoder ? '' : 'none';
                    slider = document.getElementById(id+"-skipSlider");
                    slider.max = Math.max(stream.frame_rate-1, 0);
                    if (!isSkipSliderInteracting(stream.app_name, stream.stream_name)) {
                        slider.value = stream.skip_frames;
                        updateSkipFrameDisplay(id);
                    }
                    dfps = document.getElementById(id+"-dfps");
                    dfps.textContent = `${stream.frame_rate-stream.skip_frames}fps`
                    equ = document.getElementById(id+"-equ");
                    equ.textContent = `${Number(1/stream.frame_rate*1000).toFixed(0)}ms`

                    sts = document.getElementById(id+"-sts");
                    sts.textContent = `${stream.status}`;
                    sts.className = stream.status.toLowerCase() == 'connected' ? 'text-good' : stream.status.toLowerCase() == 'disabled' || stream.status.toLowerCase() == 'error' ? 'text-alert' : 'text-warn';

                    const url = new URL(stream.vi_service_url);
                    viHost = document.getElementById(id+"-vihost");
                    viHost.textContent = `${url.hostname} (${stream.vi_service_version})`;


                    reason = document.getElementById(id+"-reason");
                    reason.textContent = `${stream.reason}`;
                    reason.className = reason.textContent.toLowerCase().includes('error') ? 'text-alert' : 'text-warn';

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
                    header_values.textContent = `(${Number(ttl_proc_avg/active_stream_count).toFixed(0)}ms / ${Number(ttl_frame_detect_avg/active_stream_count).toFixed(0)}ms)`
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
            loadImage(`${serverUrl}/v1/server/plugin/vif/applications/${stream.app_name}/streams/${stream_name}/thumbnail?fitMode=fitheight&height=180&overlay=true&random=+${rand}`,`${pathPrefix}thumb.png`,thumbnailId);
            if(stream.use_transcoder)
            {
                stream_name = stream_name + "-vi";
            }
            thumbnail_link.href = `javascript:loadPlayerPage('${hostname}','${stream.app_name}','${stream_name}')`;
        }

        function getDetectorTypeIconPath(detectorType) {
            const normalizedType = String(detectorType || '').toLowerCase();
            if (normalizedType === 'object' || normalizedType === 'scene' || normalizedType === 'vlm') {
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
                frame_detect2.textContent = `- | - | -`;
                frame_detect2.className = '';
            }
            else {
                let v = 0;
                let frms = 0;
                let frms_ttl = 0;
                const perf = stream.performance;
                if(perf.video_frames_ttl > 0) {
                    if(stream.detector_type == "object") {
                        v = Math.min( (perf.object_frames_detected / perf.video_frames_ttl)*100.0,100.0);
                        frms = perf.object_frames_detected;
                        frms_ttl = perf.video_frames_ttl;
                    }
                    else {
                        v = Math.min( (perf.scene_frames_detected / perf.video_frames_ttl)*100.0,100.0);
                        frms = perf.scene_frames_detected;
                        frms_ttl = perf.video_frames_ttl;
                    }
                }
                frame_detect2.textContent = `${frms} | ${frms_ttl} | ${Number(v).toFixed(0)}%`;
                frame_detect2.className = v < 25.0 ? 'text-alert' : v < 50 ? 'text-warn' : 'text-good';
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

        function renderHostCardValues(container, label, values, unit, yellow, red)
        {
            const hostContainer = document.getElementById(container);
            let alertClass = '';
            if(unit === undefined) {
                unit = '';
            }
            statsString = "";
            for(var gpuId in values) {
                if(Object.keys(values).length > 1) {
                    statsString+= `${gpuId}: ${Number(values[gpuId]).toFixed(0)}${unit}<br>`;
                }
                else {
                    statsString+= `${Number(values[gpuId]).toFixed(0)}${unit}<br>`;
                }
                if (values[gpuId] > yellow) {
                    alertClass = 'card-warn';
                }
                if (values[gpuId] > red) {
                    alertClass = 'card-alert';
                }
            }

            const card = document.createElement('div');
            card.className = `metric-card ${alertClass}`;
            card.innerHTML = `
                <div class="metric-label">${label}</div>
                <div class="metric-value">${statsString}</div>
            `;

            hostContainer.appendChild(card);
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
        }

        function updateThumbnail()
        {
            thumbnailsOn = !thumbnailsOn;
            lastStreamCount = 0;
            renderDashboard();
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

        async function getCurrentStreamConfig(appName, streamName)
        {
            const response = await fetch(`${serverUrl}/v1/server/plugin/vif/applications/${appName}/streams/${streamName}`, {
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

        async function updateOverlay(id, appName, streamName)
        {
            if (dashboardMutationInFlight) return;
            overlay = document.getElementById(id+'-overlayToggle');
            methods = ['disabled'];
            if(overlay.checked) {
                methods = ['immediate'];
            }

            try {
                await runDashboardMutation(async () => {
                    const currentConfig = await getCurrentStreamConfig(appName, streamName);
                    const listeners = (currentConfig && currentConfig.vif_event_listeners) ? currentConfig.vif_event_listeners : {};
                    const overlayName = getOverlayListenerName(listeners);
                    const currentOverlay = listeners[overlayName] || {};

                    listeners[overlayName] = Object.assign({}, currentOverlay, {
                        class_name: currentOverlay.class_name || 'OverlayEvent',
                        methods: methods
                    });

                    const data = {
                        vif_event_listeners: listeners
                    };

                    await apiCall(appName, streamName, data);
                });
            } catch (error) {
                console.error("Error updating overlay data:", error);
                restoreDashboardStateNow();
            }
        }

        async function updateActive(id, appName, streamName) {
            if (dashboardMutationInFlight) return;
            checkbox = document.getElementById(id+'-activeToggle');
            const data = {
                active: checkbox.checked
            }
            try {
                await runDashboardMutation(async () => {
                    await apiCall(appName, streamName, data);
                });
            } catch (error) {
                console.error("Error updating active data:", error);
                restoreDashboardStateNow();
            }
        }

        async function apiCall(appName, streamName, data)
        {
            const response = await fetch(`${serverUrl}/v1/server/plugin/vif/applications/${appName}/streams/${streamName}`, {
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

        function updateSkipFrameDisplay(id) {
            const slider = document.getElementById(`${id}-skipSlider`);
            if (!slider) return;
            skipValueDisplay = document.getElementById(`${id}-skipValue`);
            if (!skipValueDisplay) return;
            const n = parseInt(slider.value);
            skipValueDisplay.innerText = n;
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
                skip_frames: slider.value
            };
            try {
                await runDashboardMutation(async () => {
                    await apiCall(appName, streamName, data);
                });
            } catch (error) {
                console.error("Error updating skip frame data:", error);
                restoreDashboardStateNow();
            }
        }

        function loadPlayerPage(host, appName, streamName)
        {
            vifPlaybackUrl = `${protocol}//${host}/${appName}/${streamName}/playlist.m3u8`;
            loadAjaxPluginContent("server","vif", "playback.html","");
        }

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
                document.getElementById('config-streams').style.display = "none";
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
