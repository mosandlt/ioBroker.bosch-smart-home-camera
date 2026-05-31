/**
 * Night Mode Schedule — Indoor Camera Privacy
 * ============================================
 * Enables `privacy_enabled` on a configurable list of indoor cameras
 * at a set time each evening (default 22:00) and disables it again in
 * the morning (default 06:00) via cron schedules. Outdoor cameras are
 * intentionally excluded.
 *
 * Why a whitelist instead of auto-discovery?
 * The JS adapter cannot filter adapter objects by the `generation` or
 * `type` field at runtime without multiple async getObject calls. A
 * simple hard-coded list is explicit and easy to review.
 *
 * Setup:
 *   1. Fill `INDOOR_CAMERAS` with the UUIDs of your indoor cameras.
 *      Find them in Objects tab → bosch-smart-home-camera.0.cameras.
 *   2. Adjust `CRON_NIGHT` / `CRON_MORNING` if needed (cron syntax).
 *   3. Save + Run.
 *
 * Placeholders: <INDOOR_CAM_UUID_1>, <INDOOR_CAM_UUID_2>
 */
'use strict';

const INDOOR_CAMERAS = [
    '<INDOOR_CAM_UUID_1>',
    '<INDOOR_CAM_UUID_2>',
];

const CRON_NIGHT   = '0 22 * * *';
const CRON_MORNING = '0 6 * * *';

function setPrivacy(enabled) {
    INDOOR_CAMERAS.forEach((uuid) => {
        const id = `bosch-smart-home-camera.0.cameras.${uuid}.privacy_enabled`;
        setState(id, enabled, false);
        log(`Night mode: set ${id} → ${enabled}`, 'info');
    });
}

schedule(CRON_NIGHT,   () => setPrivacy(true));
schedule(CRON_MORNING, () => setPrivacy(false));

log('Night-mode schedule active (privacy ON ' +
    CRON_NIGHT + ', OFF ' + CRON_MORNING + ')', 'info');
