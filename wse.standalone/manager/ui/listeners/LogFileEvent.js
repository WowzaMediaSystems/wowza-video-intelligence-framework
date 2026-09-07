window.VIF_LISTENER_PROPERTIES = window.VIF_LISTENER_PROPERTIES || {};
window.VIF_LISTENER_PROPERTIES['LogFileEvent'] = [
    { object_methods: ['batch'] },
    { scene_methods: ['immediate'] },
    { vlm_methods: ['immediate'] },
    { synthetic_methods: ['immediate'] },
    { requires: [] },
    { key: 'log_file_name', label: 'Log File Name', type: 'text', default: 'wowzastreamingengine_vi.log' , tooltip: 'Name of the logfile, relative to the server\'s VideoIntelligenceLogRootDir. May include subdirectories, e.g. {{stream_name}}/vi.log' }
];
