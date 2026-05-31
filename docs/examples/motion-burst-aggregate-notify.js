/**
 * Motion Burst Aggregate Notify
 * ==============================
 * Collects motion events from all Bosch cameras over a 30-second window
 * and sends a single aggregated notification instead of one alert per
 * trigger. Useful when someone is working in the garden or passing
 * repeatedly — prevents notification spam.
 *
 * Logic:
 *   - Each `motion_active=true` increments a per-camera counter.
 *   - A debounce timer is started (or reset) on every new event.
 *   - After 30 s of silence the timer fires and sends ONE message, e.g.:
 *     "Bewegung erkannt bei: Garten (3x), Terrasse (1x)"
 *
 * Setup:
 *   1. Adapt the `sendTo()` call to your notification adapter
 *      (telegram, pushover, signal-cmb, email, …).
 *   2. Optionally increase `BURST_WINDOW_MS` for quieter environments.
 *   3. Save + Run. No camera IDs to configure — all cameras are covered
 *      automatically via the regex subscription.
 */
'use strict';

const BURST_WINDOW_MS = 30 * 1000;

/** @type {Map<string, number>} camName → hit count within current window */
const counts = new Map();
let debounceHandle = null;

on({
    id: /^bosch-smart-home-camera\.0\.cameras\.[^.]+\.motion_active$/,
    val: true,
    ack: true,
}, (obj) => {
    const camRoot = obj.id.slice(0, obj.id.lastIndexOf('.'));
    const nameState = getState(`${camRoot}.name`);
    const camName = (nameState && nameState.val) || camRoot;

    counts.set(camName, (counts.get(camName) || 0) + 1);
    log(`Motion burst: ${camName} (${counts.get(camName)}x so far)`, 'info');

    if (debounceHandle !== null) {
        clearTimeout(debounceHandle);
    }

    debounceHandle = setTimeout(() => {
        debounceHandle = null;
        const parts = [];
        counts.forEach((n, name) => parts.push(`${name} (${n}x)`));
        counts.clear();

        const msg = 'Bewegung erkannt bei: ' + parts.join(', ');
        log(msg, 'info');
        // Replace with your notification adapter:
        sendTo('telegram.0', { text: msg });
    }, BURST_WINDOW_MS);
});
