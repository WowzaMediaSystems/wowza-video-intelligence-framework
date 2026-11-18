window.VIF_LISTENER_PROPERTIES = window.VIF_LISTENER_PROPERTIES || {};
window.VIF_LISTENER_PROPERTIES['LogFileEvent'] = [
    { object_methods: ['immediate','batch','rollup'] },
    { scene_methods: ['immediate','batch'] },
    { motion_methods: ['immediate','batch','rollup'] },
    { vlm_methods: ['immediate','batch'] },
    { synthetic_methods: ['immediate','batch'] },
    { requires: [] },
    { key: 'log_file_name', label: 'Log File Name', type: 'text', default: 'wowzastreamingengine_vi.log' , tooltip: 'Name of the logfile, relative to the server\'s VideoIntelligenceLogRootDir. May include subdirectories, e.g. {{stream_name}}/vi.log' }
];
