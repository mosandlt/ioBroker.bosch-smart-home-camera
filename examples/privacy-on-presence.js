/**
 * Privacy On Presence
 * ===================
 * Flips `privacy_enabled` on every Bosch camera based on a presence /
 * away-mode datapoint. Home → privacy on (lens blacked out). Away →
 * privacy off + livestream on so the cameras actively record / stream.
 *
 * Works with any boolean home/away datapoint. Common sources:
 *   - `icloud.0.devices.<phone>.atHome`
 *   - `hm-rpc.0.presence`
 *   - `0_userdata.0.house_mode_home`
 *   - any virtual switch you toggle from a VIS widget or Alexa routine
 *
 * Setup:
 *   1. Replace `<PRESENCE_OID>` with your presence boolean. Adjust the
 *      truthiness check at line 26 if your datapoint uses a string like
 *      `'home'` / `'away'` instead of `true` / `false`.
 *   2. Save + Run. The script enumerates all cameras at runtime — no
 *      camera IDs to hardcode.
 */
'use strict';

const PRESENCE_OID = '<PRESENCE_OID>';

on({ id: PRESENCE_OID, change: 'ne' }, (obj) => {
    const home = obj.state.val === true;
    $('state[id=bosch-smart-home-camera.0.cameras.*.privacy_enabled]').each((id) => {
        setState(id, home, false);
    });
    if (!home) {
        $('state[id=bosch-smart-home-camera.0.cameras.*.livestream_enabled]').each((id) => {
            setState(id, true, false);
        });
    }
    log(`Presence ${home ? 'home' : 'away'} → privacy=${home}`, 'info');
});
