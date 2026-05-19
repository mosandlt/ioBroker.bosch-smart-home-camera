/**
 * Snapshot on Motion
 * ==================
 * When a Bosch camera fires `motion_active=true`, immediately request a
 * fresh JPEG via `snapshot_trigger`. The adapter writes the image path to
 * `cameras.<id>.snapshot_path` and the base64 payload to
 * `last_event_image`. After a short grace this script forwards
 * `snapshot_path` to a notification adapter so the image lands on your
 * phone within seconds of the motion event.
 *
 * Setup:
 *   1. Replace `<CAM_UUID>` with your camera ID (Objects tab →
 *      bosch-smart-home-camera.0.cameras.<UUID>).
 *   2. Adapt the `sendTo()` call at the bottom to whatever notification
 *      adapter you use — telegram, signal-cmb, pushover, email, etc.
 *      Each adapter accepts a slightly different message shape; see its
 *      docs.
 *   3. Save + Run.
 *
 * For multiple cameras either duplicate the `on()` block or replace the
 * exact id with a regex, e.g.
 *   on({ id: /^bosch-smart-home-camera\.0\.cameras\.[^.]+\.motion_active$/,
 *        val: true, ack: true }, ...)
 */
'use strict';

const CAM = 'bosch-smart-home-camera.0.cameras.<CAM_UUID>';
const SNAPSHOT_GRACE_MS = 2000;

on({ id: `${CAM}.motion_active`, val: true, ack: true }, (obj) => {
    log(`Motion on ${obj.id} — requesting snapshot`, 'info');
    setState(`${CAM}.snapshot_trigger`, true, false);

    setTimeout(() => {
        const pathState = getState(`${CAM}.snapshot_path`);
        if (!pathState || !pathState.val) {
            log('snapshot_path is empty — skipping notify', 'warn');
            return;
        }
        // Replace with your notification adapter call:
        sendTo('telegram.0', { text: pathState.val, type: 'photo' });
    }, SNAPSHOT_GRACE_MS);
});
