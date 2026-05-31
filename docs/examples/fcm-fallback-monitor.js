/**
 * FCM Fallback Monitor
 * =====================
 * Watches `bosch-smart-home-camera.0.info.fcm_active` and alerts when the
 * adapter falls back from Firebase Cloud Messaging (FCM) to polling mode.
 *
 * Why this matters:
 *   FCM push delivers motion events in < 1 s. The polling fallback checks
 *   every ~30 s, so motion notifications arrive up to half a minute late.
 *   Common causes of a fallback: expired token, Firebase quota exceeded,
 *   or a network issue blocking outbound FCM traffic.
 *
 * Logic:
 *   - `fcm_active` = "firebase"   → all good, cancel any pending alert.
 *   - `fcm_active` = "polling"
 *     or "offline"               → start 5-min grace timer.
 *   - If still not "firebase" after 5 min → send notification once.
 *   - If FCM recovers before grace expires → clearTimeout, no alert.
 *
 * Setup:
 *   1. Adapt the `sendTo()` call to your notification adapter.
 *   2. Adjust `GRACE_MS` if you want a shorter or longer grace period.
 *   3. Save + Run.
 */
'use strict';

const FCM_STATE = 'bosch-smart-home-camera.0.info.fcm_active';
const GRACE_MS = 5 * 60 * 1000;

let graceHandle = null;

on({ id: FCM_STATE, change: 'any' }, (obj) => {
    const val = obj.state && obj.state.val;

    if (val === 'firebase') {
        if (graceHandle !== null) {
            clearTimeout(graceHandle);
            graceHandle = null;
            log('FCM recovered — grace timer cleared', 'info');
        }
        return;
    }

    // Degraded state: polling or offline
    if (graceHandle !== null) return; // timer already running

    log(`FCM degraded (${val}) — grace timer started`, 'warn');
    graceHandle = setTimeout(() => {
        graceHandle = null;
        const current = getState(FCM_STATE);
        const currentVal = current && current.val;
        if (currentVal === 'firebase') return; // recovered just in time

        const msg = `Bosch-Kamera: FCM-Push inaktiv (Status: ${currentVal}). Benachrichtigungen kommen ggf. mit Verzögerung an.`;
        log(msg, 'warn');
        // Replace with your notification adapter:
        sendTo('telegram.0', { text: msg });
    }, GRACE_MS);
});
