/**
 * Sleep Mode — Mute All Cameras
 * ==============================
 * Watches a boolean `sleep_mode` state. When sleep mode activates all
 * cameras are muted: livestream is disabled and privacy is enabled. The
 * previous `privacy_enabled` value per camera is saved so that it is
 * restored correctly when sleep mode deactivates.
 *
 * Setup:
 *   1. Create a boolean datapoint `0_userdata.0.sleep_mode`
 *      (type boolean, default false) or point `SLEEP_OID` to an
 *      existing away/do-not-disturb state.
 *   2. Save + Run.
 *
 * Placeholders: none — script enumerates all cameras automatically.
 */
'use strict';

const SLEEP_OID     = '0_userdata.0.sleep_mode';
const PRIVACY_PAT   = 'bosch-smart-home-camera.0.cameras.*.privacy_enabled';
const LIVESTREAM_PAT = 'bosch-smart-home-camera.0.cameras.*.livestream_enabled';

/** Stores previous privacy_enabled values keyed by full datapoint ID. */
const privacySnapshot = new Map();

on({ id: SLEEP_OID, change: 'ne' }, (obj) => {
    const sleeping = obj.state.val === true;

    if (sleeping) {
        // Save current privacy state, then mute everything
        $(`state[id=${PRIVACY_PAT}]`).each((id) => {
            const cur = getState(id);
            privacySnapshot.set(id, cur ? cur.val : false);
            setState(id, true, false);
        });
        $(`state[id=${LIVESTREAM_PAT}]`).each((id) => {
            setState(id, false, false);
        });
        log('Sleep mode ON — all cameras muted', 'info');
    } else {
        // Restore privacy; leave livestream off (user controls it manually)
        $(`state[id=${PRIVACY_PAT}]`).each((id) => {
            const prev = privacySnapshot.has(id) ? privacySnapshot.get(id) : false;
            setState(id, prev, false);
        });
        privacySnapshot.clear();
        log('Sleep mode OFF — privacy states restored', 'info');
    }
});
