window.VIF_LISTENER_PROPERTIES = window.VIF_LISTENER_PROPERTIES || {};
window.VIF_LISTENER_PROPERTIES['Id3Event'] = [
    { object_methods: ['immediate','batch','rollup'] },
    { scene_methods: ['immediate','batch'] },
    { motion_methods: ['immediate','batch','rollup'] },
    { vlm_methods: ['immediate','batch'] },
    { synthetic_methods: ['immediate','batch'] },
    { requires: ['LIVE_STREAM'] }
];
