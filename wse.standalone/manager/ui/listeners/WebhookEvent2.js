window.VIF_LISTENER_PROPERTIES = window.VIF_LISTENER_PROPERTIES || {};
// No field carries a `default`: syncPropertyFields() stores a blank field's
// placeholder as its value, and a placeholder is built from the default — so an
// example destination would be saved as the real one. A `hint` only shows.
window.VIF_LISTENER_PROPERTIES['WebhookEvent2'] = [
    { object_methods: ['immediate','batch','rollup'] },
    { scene_methods: ['immediate','batch'] },
    { motion_methods: ['immediate','batch','rollup'] },
    { vlm_methods: ['immediate','batch'] },
    { synthetic_methods: ['immediate','batch'] },
    { requires: [] },
    { key: 'url', label: 'Destination URL', type: 'text', tooltip: 'Where detections are POSTed: an absolute http(s) URL with a host, e.g. https://hooks.example.com/vi. Leave it empty and this listener delivers nowhere and says so in the log.' },
    { key: 'credential_secret', label: 'Credential Secret', type: 'secret', tooltip: 'A secret from the Secrets page, sent as the credential. It is resolved at delivery, so rotating the value needs no change here — and only its name is ever stored on this listener or served by a read.' },
    { key: 'credential_header', label: 'Credential Header', type: 'text', hint: 'Authorization', tooltip: 'The header the key is sent in. Blank uses "Authorization". If the receiving service expects its key in another header, name it here, like DD-API-KEY. Headers the webhook sets itself, such as Content-Type, can’t be used.' }
];
