/**
 * Camera Offline Alert
 * ====================
 * Watches `cameras.*.online` and pushes one notification once a camera
 * has been offline for longer than `OFFLINE_GRACE_MS`. The grace period
 * suppresses false alerts during Bosch's brief session-renewal pause and
 * normal Wi-Fi reassociations.
 *
 * Setup:
 *   1. Adjust `OFFLINE_GRACE_MS` (default 5 min).
 *   2. Adapt the `sendTo()` call to your notification adapter.
 *   3. Save + Run. The regex subscribes to every camera under
 *      `bosch-smart-home-camera.0` automatically.
 */
'use strict';

const OFFLINE_GRACE_MS = 5 * 60 * 1000;
const pending = new Map();

on({
    id: /^bosch-smart-home-camera\.0\.cameras\.[^.]+\.online$/,
    change: 'ne',
}, (obj) => {
    const camRoot = obj.id.slice(0, obj.id.lastIndexOf('.'));
    const nameState = getState(`${camRoot}.name`);
    const camName = (nameState && nameState.val) || camRoot;

    if (obj.state.val === false) {
        if (pending.has(camRoot)) return;
        const handle = setTimeout(() => {
            log(`Camera ${camName} still offline after ${OFFLINE_GRACE_MS / 60000} min`, 'warn');
            // Replace with your notification adapter:
            sendTo('telegram.0', { text: `Bosch camera offline: ${camName}` });
            pending.delete(camRoot);
        }, OFFLINE_GRACE_MS);
        pending.set(camRoot, handle);
    } else {
        const handle = pending.get(camRoot);
        if (handle) {
            clearTimeout(handle);
            pending.delete(camRoot);
            log(`Camera ${camName} recovered before grace expired`, 'info');
        }
    }
});
