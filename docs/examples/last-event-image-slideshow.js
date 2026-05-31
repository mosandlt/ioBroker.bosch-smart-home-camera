/**
 * Last Event Image Slideshow
 * ===========================
 * Every 30 seconds: finds the camera with the most recent motion event
 * (sorted by `last_event_image_at`), copies its `last_event_image` (base64
 * JPEG) into a shared userdata state so a VIS dashboard can display a
 * rotating "last seen motion" image without any per-camera binding.
 *
 * Target states (created automatically if missing):
 *   0_userdata.0.bosch_slideshow_image    — base64 JPEG string
 *   0_userdata.0.bosch_slideshow_caption  — "Terrasse — 14:32:07"
 *
 * Behaviour:
 *   - If no camera fired motion in the last 24 h, the existing image is
 *     kept unchanged and the caption notes "Kein Ereignis in 24 h".
 *   - Cameras without a `last_event_image_at` timestamp are skipped.
 *
 * Setup:
 *   1. In VIS add an "HTML" widget and bind `src` to
 *      `0_userdata.0.bosch_slideshow_image` (use the base64 img helper).
 *   2. Optionally display `0_userdata.0.bosch_slideshow_caption` as a label.
 *   3. Save + Run. No camera IDs to configure.
 */
'use strict';

const IMAGE_OID   = '0_userdata.0.bosch_slideshow_image';
const CAPTION_OID = '0_userdata.0.bosch_slideshow_caption';
const MAX_AGE_MS  = 24 * 60 * 60 * 1000;

function ensureState(id, defaultVal, type) {
    if (!getObject(id)) {
        setObject(id, {
            type: 'state',
            common: { name: id, type: type, role: 'state', read: true, write: true, def: defaultVal },
            native: {},
        });
    }
}

ensureState(IMAGE_OID,   '', 'string');
ensureState(CAPTION_OID, '', 'string');

schedule('*/30 * * * * *', () => {
    const now = Date.now();
    let best = null; // { root, name, image, ts }

    $('state[id=bosch-smart-home-camera.0.cameras.*.last_event_image_at]').each((tsId) => {
        const tsState = getState(tsId);
        if (!tsState || !tsState.val) return;

        const ts = new Date(tsState.val).getTime();
        if (isNaN(ts) || now - ts > MAX_AGE_MS) return;

        if (best === null || ts > best.ts) {
            const camRoot = tsId.slice(0, tsId.lastIndexOf('.'));
            const nameState = getState(`${camRoot}.name`);
            const imgState  = getState(`${camRoot}.last_event_image`);

            if (!imgState || !imgState.val) return;

            best = {
                root:  camRoot,
                name:  (nameState && nameState.val) || camRoot,
                image: imgState.val,
                ts:    ts,
            };
        }
    });

    if (!best) {
        setState(CAPTION_OID, 'Kein Ereignis in 24 h', false);
        return;
    }

    const timeStr = new Date(best.ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setState(IMAGE_OID,   best.image,                    false);
    setState(CAPTION_OID, `${best.name} — ${timeStr}`,   false);
});
