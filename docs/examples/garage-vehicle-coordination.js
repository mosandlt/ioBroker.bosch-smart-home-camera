/**
 * Garage / Vehicle Coordination
 * ==============================
 * When the garage door opens the assigned camera switches to active
 * mode: livestream on and front light on. A 5-minute timeout
 * automatically restores both to their default off state. If the door
 * closes before the timeout, the defaults are restored after a short
 * 30-second grace period (gives a vehicle time to fully clear the
 * entrance before the light goes off).
 *
 * Setup:
 *   1. Replace `<GARAGE_DOOR_OID>` with your garage door boolean state
 *      (true = open). Typical sources: homematic shutter contact,
 *      z-wave sensor, or a virtual switch.
 *   2. Replace `<CAM_UUID>` with the camera covering the garage.
 *   3. Adjust `AUTO_RESTORE_MS` / `CLOSE_GRACE_MS` if needed.
 *   4. Save + Run.
 *
 * Placeholders: <GARAGE_DOOR_OID>, <CAM_UUID>
 */
'use strict';

const GARAGE_DOOR_OID  = '<GARAGE_DOOR_OID>';
const CAM              = 'bosch-smart-home-camera.0.cameras.<CAM_UUID>';
const AUTO_RESTORE_MS  = 5 * 60 * 1000;   // 5 min after open
const CLOSE_GRACE_MS   = 30 * 1000;        // 30 s grace after close

let autoRestoreHandle = null;
let graceHandle       = null;

function activateCamera() {
    clearTimeout(graceHandle);
    graceHandle = null;
    setState(`${CAM}.livestream_enabled`, true,  false);
    setState(`${CAM}.front_light_enabled`, true, false);
    log('Garage open — camera and front light activated', 'info');

    clearTimeout(autoRestoreHandle);
    autoRestoreHandle = setTimeout(() => {
        restoreCamera('auto-restore after 5 min');
    }, AUTO_RESTORE_MS);
}

function restoreCamera(reason) {
    clearTimeout(autoRestoreHandle);
    clearTimeout(graceHandle);
    autoRestoreHandle = null;
    graceHandle       = null;
    setState(`${CAM}.livestream_enabled`,  false, false);
    setState(`${CAM}.front_light_enabled`, false, false);
    log(`Garage camera restored (${reason})`, 'info');
}

on({ id: GARAGE_DOOR_OID, change: 'ne' }, (obj) => {
    if (obj.state.val === true) {
        activateCamera();
    } else {
        // Door closed — restore after grace period
        clearTimeout(graceHandle);
        graceHandle = setTimeout(() => {
            restoreCamera('door closed + 30 s grace');
        }, CLOSE_GRACE_MS);
    }
});
