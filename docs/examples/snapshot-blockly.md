# Snapshot Scheduler / Time-Lapse — Blockly & JavaScript

Hourly snapshot scheduler for the `iobroker.bosch-smart-home-camera` adapter.
Two flavours: a **Blockly XML** import for the visual editor and a **plain
JavaScript** version for more control. Both write the snapshot file path to a
userdata datapoint and optionally assemble an ffmpeg command for time-lapse
creation.

---

## Prerequisites

1. **javascript adapter** running (`iobroker.javascript`).
2. At least one camera discovered — check
   `bosch-smart-home-camera.0.cameras.<UUID>.online` is `true`.
3. Replace `<CAM_UUID>` with the camera's actual UUID from the Objects tab
   (`bosch-smart-home-camera.0.cameras.<UUID>`).
4. The snapshot output path (`/tmp/bosch-timelapse/<UUID>/`) must be writable
   by the ioBroker process. Adjust to a persistent path if needed
   (e.g. `/opt/iobroker/bosch-timelapse/`).
5. Optional: create a userdata string DP
   `0_userdata.0.bosch_last_timelapse_path` (role `text`) to receive the
   last written filename — useful for VIS widgets.

---

## Blockly XML — import into visual editor

Open **javascript adapter → Scripts → new Blockly → XML icon → paste**:

```xml
<xml xmlns="https://developers.google.com/blockly/xml">
  <!--
    Hourly snapshot scheduler for Bosch Smart Home Camera
    Replace <CAM_UUID> with your camera UUID from the Objects tab.
    Saves snapshot path to:  0_userdata.0.bosch_last_timelapse_path
  -->
  <block type="procedures_defnoreturn" id="bosch_timelapse_main" x="10" y="10">
    <field name="NAME">boschTakeTimeLapseSnap</field>
    <comment pinned="false" h="80" w="160">Trigger a snapshot and record the path</comment>
    <statement name="STACK">

      <!-- Build the output filename: /tmp/bosch-timelapse/<UUID>/YYYYmmdd_HHMM.jpg -->
      <block type="variables_set">
        <field name="VAR">snapPath</field>
        <value name="VALUE">
          <block type="text_join">
            <mutation items="4"></mutation>
            <value name="ADD0"><block type="text"><field name="TEXT">/tmp/bosch-timelapse/&lt;CAM_UUID&gt;/</field></block></value>
            <value name="ADD1">
              <block type="convert_object2string">
                <value name="VALUE">
                  <block type="math_formatFloat">
                    <value name="NUM"><block type="time_get_with_type"><field name="OPTION">YYYYMMDDHHmm</field><field name="OID"></field><field name="OID2"></field></block></value>
                    <value name="DIGITS"><block type="math_number"><field name="NUM">0</field></block></value>
                  </block>
                </value>
              </block>
            </value>
            <value name="ADD2"><block type="text"><field name="TEXT">.jpg</field></block></value>
            <value name="ADD3"><block type="text"><field name="TEXT"></field></block></value>
          </block>
        </value>
      </block>

      <!-- Trigger the snapshot — adapter writes JPEG to snapshot_path -->
      <block type="control_setState">
        <value name="OID">
          <block type="text">
            <field name="TEXT">bosch-smart-home-camera.0.cameras.&lt;CAM_UUID&gt;.snapshot_trigger</field>
          </block>
        </value>
        <value name="VALUE">
          <block type="logic_boolean"><field name="BOOL">TRUE</field></block>
        </value>
      </block>

      <!-- Wait 6 seconds for the adapter to write the JPEG -->
      <block type="timeouts_wait">
        <value name="DELAY"><block type="math_number"><field name="NUM">6000</field></block></value>

        <statement name="STATEMENT">
          <!-- Store the path in userdata for VIS / other scripts -->
          <block type="control_setState">
            <value name="OID">
              <block type="text">
                <field name="TEXT">0_userdata.0.bosch_last_timelapse_path</field>
              </block>
            </value>
            <value name="VALUE">
              <block type="variables_get"><field name="VAR">snapPath</field></block>
            </value>
          </block>
        </statement>
      </block>

    </statement>
  </block>

  <!-- Schedule: every full hour between 06:00 and 22:00 -->
  <block type="schedule" id="bosch_timelapse_schedule" x="10" y="280">
    <field name="SCHEDULE">0 6-22 * * *</field>
    <statement name="STATEMENT">
      <block type="procedures_callnoreturn">
        <mutation name="boschTakeTimeLapseSnap"></mutation>
      </block>
    </statement>
  </block>
</xml>
```

> **Note on the timestamp block**: the `time_get_with_type` Blockly block may
> not be available in all javascript adapter versions. If you see an unknown
> block error, switch to the JavaScript version below — it uses plain
> `Date` arithmetic that works everywhere.

---

## JavaScript version — more control, easier to adapt

Open **javascript adapter → Scripts → new JavaScript → paste**:

```javascript
// ─────────────────────────────────────────────────────────────────────────
// Bosch Smart Home Camera — Snapshot Scheduler / Time-Lapse
// ─────────────────────────────────────────────────────────────────────────
// Saves one snapshot per hour (06:00–22:00) to a dated folder.
// The adapter writes the JPEG; this script just triggers it and records
// the resulting snapshot_path for VIS / other automations.
//
// Replace <CAM_UUID> with the camera UUID from the Objects tab.
// Multiple cameras: duplicate the schedule block with each UUID.
// ─────────────────────────────────────────────────────────────────────────

const CAM_UUID = '<CAM_UUID>';                         // ← replace
const SNAP_DP  = `bosch-smart-home-camera.0.cameras.${CAM_UUID}.snapshot_trigger`;
const PATH_DP  = `bosch-smart-home-camera.0.cameras.${CAM_UUID}.snapshot_path`;
const LAST_DP  = '0_userdata.0.bosch_last_timelapse_path'; // optional userdata DP

// ── Helper: zero-pad a number to width ──────────────────────────────────────
function pad(n, width = 2) {
    return String(n).padStart(width, '0');
}

// ── Build a sortable timestamp string YYYYMMDD_HHMM ─────────────────────────
function nowStamp() {
    const d = new Date();
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_`
         + `${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// ── Take one snapshot and record the path ───────────────────────────────────
function takeSnap() {
    const ts = nowStamp();
    log(`[bosch-timelapse] Triggering snapshot for ${CAM_UUID} at ${ts}`);

    // Trigger: adapter fetches JPEG from camera and writes snapshot_path
    setState(SNAP_DP, true, false);

    // After 6 s the JPEG should be written; read back the path
    setTimeout(() => {
        const snapPath = getState(PATH_DP).val;
        log(`[bosch-timelapse] Snapshot written: ${snapPath}`);

        // Optionally forward to a shared userdata DP for VIS widgets
        if (existsState(LAST_DP)) {
            setState(LAST_DP, `${ts}: ${snapPath}`, false);
        }
    }, 6000);
}

// ── Schedule: every full hour, 06:00–22:00 ──────────────────────────────────
// Cron: minute=0, hours 6 through 22, every day.
// Change to e.g. '*/15 6-22 * * *' for every 15 minutes.
// Change to '*/10 * * * *' for every 10 minutes, all day.
schedule('0 6-22 * * *', () => {
    takeSnap();
});

log('[bosch-timelapse] Scheduler registered — hourly 06:00–22:00.');
```

---

## Variant: motion-triggered snapshot with 15-minute throttle

```javascript
// ── Motion-triggered time-lapse (15 min throttle) ──────────────────────────
const CAM_UUID   = '<CAM_UUID>';
const MOTION_DP  = `bosch-smart-home-camera.0.cameras.${CAM_UUID}.motion_active`;
const SNAP_DP    = `bosch-smart-home-camera.0.cameras.${CAM_UUID}.snapshot_trigger`;

const THROTTLE_MS = 15 * 60 * 1000;  // 15 minutes — change as needed
let lastSnap = 0;

on({ id: MOTION_DP, change: 'ne', val: true }, () => {
    const now = Date.now();
    if (now - lastSnap < THROTTLE_MS) {
        log('[bosch-timelapse] Motion detected but throttled — skipping.');
        return;
    }
    lastSnap = now;
    setState(SNAP_DP, true, false);
    log('[bosch-timelapse] Motion snapshot triggered.');
});
```

---

## Assembling the time-lapse with ffmpeg

Run on the machine that holds the snapshot files (the ioBroker host, or any
Linux/macOS box after copying the folder):

```bash
# Hourly shots for one day (24 frames) at 12 fps → 2-second clip:
ffmpeg \
  -framerate 12 \
  -pattern_type glob \
  -i '/tmp/bosch-timelapse/<CAM_UUID>/*.jpg' \
  -vf "scale=1920:-2,format=yuv420p" \
  -c:v libx264 -crf 22 -preset slow \
  /tmp/bosch-timelapse/timelapse_<CAM_UUID>.mp4
```

Framerate guide:

| Capture interval | 24 fps output | 12 fps output |
|---|---|---|
| Every 10 min | 1 h → 0.25 s | 1 h → 0.5 s |
| Every hour | 1 day → 0.67 s | 1 day → 1.3 s |
| Every 15 min | 1 day → 4 s | 1 day → 8 s |
| Every day | 1 year → 15 s | 1 year → 30 s |

---

## Datapoints used

| Datapoint | Direction | Purpose |
|---|---|---|
| `bosch-smart-home-camera.0.cameras.<UUID>.snapshot_trigger` | write `true` | Triggers a fresh snapshot |
| `bosch-smart-home-camera.0.cameras.<UUID>.snapshot_path` | read | Path to the last written JPEG |
| `bosch-smart-home-camera.0.cameras.<UUID>.motion_active` | subscribe | Rising edge = motion detected |
| `0_userdata.0.bosch_last_timelapse_path` | write (optional) | Last snapshot path for VIS display |
