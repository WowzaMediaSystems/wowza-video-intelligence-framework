window.VIF_LISTENER_PROPERTIES = window.VIF_LISTENER_PROPERTIES || {};
window.VIF_LISTENER_PROPERTIES['OverlayEvent'] = [
    { object_methods: ['immediate'] },
    { scene_methods: ['immediate'] },
    { key: 'fade_step', label: 'Fade Step', type: 'number', default: 20, tooltip: 'Number of frames over which overlays fade out' },
    { key: 'jitter', label: 'Jitter', type: 'number', default: 0, tooltip: 'dont draw if pixel change is less that this' },
    { key: 'show_stats', label: 'Show Stats', type: 'boolean', default: true, tooltip: 'Overlay system stats on page' },
    { key: 'replace_video', label: 'Replace Video', type: 'boolean', default: true, tooltip: 'Replace the original video with the overlay rendering.  Only for Detector Type: Object' },
    { key: 'debug_string', label: 'Debug String', type: 'text', default: '' , tooltip: 'Title overlay using date format pattern, e.g. \'Cam-01:\' yyyy-MM-dd HH:mm:ss' }
];
