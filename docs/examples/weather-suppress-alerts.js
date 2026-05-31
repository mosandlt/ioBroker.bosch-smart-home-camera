/**
 * Weather-Based Alert Suppression
 * ================================
 * Reads a rain-rate datapoint and sets a global boolean flag
 * `0_userdata.0.bosch_suppress_alerts`. Other motion-alert scripts
 * should check this flag before sending notifications so that
 * rain-triggered false positives are silently dropped.
 *
 * How to use the flag in other scripts:
 *   if (getState('0_userdata.0.bosch_suppress_alerts').val === true) return;
 *
 * Compatible rain-rate sources (pick one, adapt OID):
 *   - daswetter.0.NextHours.*.rain_value
 *   - openweathermap.0.forecast.current.precipitation
 *   - hmip.0.devices.<rain-sensor>.channels.0.rain_counter_current
 *   - 0_userdata.0.my_rain_sensor_mm_per_hour
 *
 * Setup:
 *   1. Create a boolean datapoint in 0_userdata.0 named
 *      `bosch_suppress_alerts` (type boolean, default false).
 *   2. Replace `<RAIN_RATE_OID>` with your rain-rate datapoint.
 *   3. Adjust `RAIN_THRESHOLD_MM_H` (default 0.5 mm/h).
 *   4. Save + Run.
 *
 * Placeholders: <RAIN_RATE_OID>
 */
'use strict';

const RAIN_RATE_OID       = '<RAIN_RATE_OID>';
const RAIN_THRESHOLD_MM_H = 0.5;
const SUPPRESS_OID        = '0_userdata.0.bosch_suppress_alerts';

on({ id: RAIN_RATE_OID, change: 'ne' }, (obj) => {
    const rate     = parseFloat(obj.state.val) || 0;
    const suppress = rate > RAIN_THRESHOLD_MM_H;
    setState(SUPPRESS_OID, suppress, false);
    log(`Rain rate ${rate} mm/h → suppress_alerts=${suppress}`, 'info');
});

// Initialise flag on script start from current sensor value
(function init() {
    const current = getState(RAIN_RATE_OID);
    if (!current) return;
    const rate = parseFloat(current.val) || 0;
    setState(SUPPRESS_OID, rate > RAIN_THRESHOLD_MM_H, false);
})();
