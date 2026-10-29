window.VIF_LISTENER_PROPERTIES = window.VIF_LISTENER_PROPERTIES || {};
// Neither field carries a `default`: syncPropertyFields() stores a blank field's
// placeholder as its value, and a placeholder is built from the default — so an
// example destination would be saved as the real one.
window.VIF_LISTENER_PROPERTIES['WebhookEvent2'] = [
    { object_methods: ['immediate','rollup','batch'] },
    { scene_methods: ['immediate'] },
    { motion_methods: ['immediate','rollup','batch'] },
    { vlm_methods: ['immediate'] },
    { synthetic_methods: ['immediate'] },
    { requires: [] },
    { key: 'url', label: 'Destination URL', type: 'text', tooltip: 'Where detections are POSTed: an absolute http(s) URL with a host, e.g. https://hooks.example.com/vi. Leave it empty and this listener delivers nowhere and says so in the log.' },
    { key: 'credential_secret', label: 'Credential Secret', type: 'secret', tooltip: 'A secret from the Secrets page, sent as the credential. It is resolved at delivery, so rotating the value needs no change here — and only its name is ever stored on this listener or served by a read.' },
    { key: 'credential_header', label: 'Credential Header', type: 'text', tooltip: 'The header the credential is sent under. Empty means Authorization; a consumer that wants its key elsewhere names that header here, e.g. DD-API-KEY. Headers the delivery owns, such as Content-Type, are refused.' }
];
