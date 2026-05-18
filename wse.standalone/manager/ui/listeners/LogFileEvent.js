window.VIF_LISTENER_PROPERTIES = window.VIF_LISTENER_PROPERTIES || {};
window.VIF_LISTENER_PROPERTIES['LogFileEvent'] = [
    { object_methods: ['batch'] },
    { scene_methods: ['immediate'] },
    { key: 'log_file_name', label: 'Log File Name', type: 'text', default: 'wowzastreamingengine_vi.log' , tooltip: 'Name of the logfile' },
    { key: 'log_file_path', label: 'Log File Path', type: 'text', default: '{{com.wowza.wms.ConfigHome}}/logs' , tooltip: 'Path to the logfile' }
];
