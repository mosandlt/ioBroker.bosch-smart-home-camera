/**
 * Stream URL to Fully Kiosk Tablet on Motion
 * ===========================================
 * When a specific camera detects motion, the script reads `stream_url`
 * and pushes it to a Fully Kiosk Browser tablet via the `fully-mqtt`
 * adapter (`loadURL` command). Useful for a wall-mounted door-phone
 * display that shows the entrance camera automatically when someone
 * approaches.
 *
 * Requirements:
 *   - iobroker.fully-mqtt adapter installed and configured.
 *
 * Setup:
 *   1. Replace `<CAM_UUID>` with your camera ID (Objects tab →
 *      bosch-smart-home-camera.0.cameras.<UUID>).
 *   2. Replace `<TABLET_DEVICE>` with the fully-mqtt device identifier,
 *      e.g. `Kitchen-Tablet` (see fully-mqtt.0.devices.<name>).
 *   3. Adjust `STREAM_GRACE_MS` if the stream URL needs a moment to
 *      become valid after motion starts (default 1 s).
 *   4. Save + Run.
 *
 * Placeholders: <CAM_UUID>, <TABLET_DEVICE>
 */
'use strict';

const CAM          = 'bosch-smart-home-camera.0.cameras.<CAM_UUID>';
const TABLET       = '<TABLET_DEVICE>';
const STREAM_GRACE_MS = 1000;

on({ id: `${CAM}.motion_active`, val: true, ack: true }, (obj) => {
    log(`Motion on ${obj.id} — loading stream on tablet ${TABLET}`, 'info');

    setTimeout(() => {
        const urlState = getState(`${CAM}.stream_url`);
        if (!urlState || !urlState.val) {
            log('stream_url is empty — skipping tablet load', 'warn');
            return;
        }
        // fully-mqtt adapter: send loadURL command to the tablet
        sendTo('fully-mqtt.0', 'send', {
            device:  TABLET,
            command: 'loadURL',
            params:  { url: urlState.val },
        });
        log(`Sent stream URL to tablet ${TABLET}`, 'info');
    }, STREAM_GRACE_MS);
});
