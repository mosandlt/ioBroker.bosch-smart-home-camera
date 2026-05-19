# Examples

Ready-to-import automation scripts for the `iobroker.bosch-smart-home-camera`
adapter. Each file is self-contained and explains its placeholders inline,
so the typical workflow is **copy → adapt object IDs → drop into the
JavaScript adapter**.

Two flavours live side-by-side in this folder:

- **`*.xml`** — Blockly XML files. Open the **javascript** adapter →
  **Scripts** → new **Blockly** script → click the **XML** icon in the
  toolbar → paste → Save → Run.
- **`*.js`** — JavaScript snippets. Open the **javascript** adapter →
  **Scripts** → new **JavaScript** script → paste → Save → Run.

Pick whichever style you are more comfortable with. The Blockly examples
are easier to tweak visually; the JavaScript examples are more compact and
easier to share / version-control.

## Available examples

### Blockly (visual) — 8 examples

| File | Purpose |
| --- | --- |
| [`master-wallwasher-switch.xml`](./master-wallwasher-switch.xml) | One virtual datapoint `0_userdata.0.master_wallwasher` drives the wallwasher of every camera in lock-step. Toggle once, all four light up. |
| [`all-cameras-privacy-master-switch.xml`](./all-cameras-privacy-master-switch.xml) | Sibling of the wallwasher master: `0_userdata.0.master_privacy` flips `privacy_enabled` on every camera at once. Useful for a single "show / hide cameras" VIS button. |
| [`dusk-auto-wallwasher.xml`](./dusk-auto-wallwasher.xml) | Sun-elevation trigger: wallwasher turns on at dusk, off at dawn. No manual schedule, follows the seasons automatically. |
| [`hue-pir-to-bosch-motion.xml`](./hue-pir-to-bosch-motion.xml) | Bridge a Philips Hue motion sensor into a synthetic Bosch motion event so existing motion-driven scripts fire immediately, before the Bosch cam itself detects anything. |
| [`door-sensor-privacy-light.xml`](./door-sensor-privacy-light.xml) | Door / window sensor opens → privacy off + front light on. After the sensor closes, a 5-minute timer restores privacy on + light off so a quick door-tap doesn't leave the camera blind. |
| [`panic-siren-from-doorbell.xml`](./panic-siren-from-doorbell.xml) | Doorbell button or any other boolean trigger → fires `siren_active=true` on a Gen2 camera for 30 seconds. Gen2-only (Indoor II / Outdoor II have the built-in 75 dB siren). |
| [`vacation-deterrent-lights.xml`](./vacation-deterrent-lights.xml) | When `<VACATION_MODE>` is on and Astro reports night: toggles `front_light_enabled` on a configurable cadence to create a "house is occupied" appearance. Default 30-minute interval, with header notes on swapping in `math_random_int` for randomised timing. |
| [`driveway-light-automation.xml`](./driveway-light-automation.xml) | Full outdoor scene: dim Hue floodlight + camera wallwashers at dusk based on a lux sensor, then ramp to bright scene + camera frontlights when either a Hue PIR or a Bosch camera detects motion, with a configurable cool-down. Contributed by [Jaschkopf](https://forum.iobroker.net/topic/84538/adapter-bosch-smart-home-kameras/29) via the ioBroker forum. |

### JavaScript (scripted) — 12 examples

| File | Purpose |
| --- | --- |
| [`snapshot-on-motion.js`](./snapshot-on-motion.js) | On `motion_active=true`, trigger a fresh snapshot via `snapshot_trigger` and forward the resulting `snapshot_path` to a notification adapter (Telegram by default). |
| [`camera-offline-alert.js`](./camera-offline-alert.js) | Watches every `cameras.*.online` datapoint, pushes one notification once a camera has been offline for >5 minutes (grace period avoids false alerts during Bosch session renewals). |
| [`privacy-on-presence.js`](./privacy-on-presence.js) | Toggle `privacy_enabled` on every camera based on a home/away boolean. Home → privacy on, lens blacked out. Away → privacy off + livestream on. Enumerates cameras at runtime, no UUIDs to hardcode. |
| [`motion-burst-aggregate-notify.js`](./motion-burst-aggregate-notify.js) | Aggregates motion bursts from all cameras across a 30-second window into one combined notification (`Cam A (3×), Cam B (1×)`). Stops the notification spam when somebody is working in the garden for 20 minutes. |
| [`telegram-bot-snapshot-command.js`](./telegram-bot-snapshot-command.js) | Telegram bot command listener: `/snap` or `/snap <camName>` triggers a fresh snapshot and posts the image back to the requester. Unknown names get a list of valid options. |
| [`weather-suppress-alerts.js`](./weather-suppress-alerts.js) | Writes a global `0_userdata.0.bosch_suppress_alerts` flag based on a rain-rate sensor. Other motion scripts can check this flag before pushing notifications during a thunderstorm. |
| [`night-mode-schedule.js`](./night-mode-schedule.js) | Cron-based: 22:00 sets `privacy_enabled=true` on a whitelist of indoor cameras, 06:00 turns it back off. |
| [`sleep-mode-mute-cameras.js`](./sleep-mode-mute-cameras.js) | Boolean sleep-mode datapoint flips: snapshots every camera's previous `privacy_enabled` value into a Map, mutes all of them, then restores the exact previous state on wake-up. |
| [`garage-vehicle-coordination.js`](./garage-vehicle-coordination.js) | Garage door opens → garage-area camera switches `livestream_enabled` + `front_light_enabled` on. Auto-restores after 5 minutes, or 30 seconds after the door closes — whichever comes first. |
| [`stream-url-to-fully-tablet.js`](./stream-url-to-fully-tablet.js) | Motion on a chosen camera (typically the doorbell) pushes its `stream_url` to a [Fully Kiosk](https://www.fully-kiosk.com/) tablet via the `fully-mqtt` adapter, so a wall-mounted display auto-switches to that camera. |
| [`fcm-fallback-monitor.js`](./fcm-fallback-monitor.js) | Watches `info.fcm_active`. If FCM push degrades to `polling` or `offline` for more than 5 minutes, sends one notification — motion alerts will arrive ~30 s later than usual until FCM recovers, and you want to know. |
| [`last-event-image-slideshow.js`](./last-event-image-slideshow.js) | Cron every 30 s: picks the camera with the freshest `last_event_image_at` from the past 24 h and copies its `last_event_image` plus a caption into `0_userdata.0.bosch_slideshow_image` / `_caption`. Ideal as a VIS widget showing "most recent activity". |

## Master-wallwasher prerequisites

`0_userdata.0.master_wallwasher` (boolean, read+write) needs to exist. Create
it once via Objects → Custom → `+` → State, type `boolean`, role `switch.light`.
Or import [`master-wallwasher-userdata.xml`](./master-wallwasher-userdata.xml)
into Objects → Custom to set it up.

## Dusk trigger prerequisites

The Astro feature requires that the **javascript** adapter has lat/lon
configured (Instances → javascript.0 → settings tab). The example uses sun
elevation −5° (civil twilight) as the threshold — tweak via the `astro` block
inside the script if you want darker / lighter cut-off.

## Driveway-lighting prerequisites

The driveway-light example wires eight external datapoints together. Pull
each from your existing setup before importing — the script itself only
reacts to them, it does not create them:

- `<ILLUMINATION_SENSOR>` — any lux datapoint (HM-Sec-MDIR illumination
  channel, Hue motion sensor lightlevel, weather-station brightness, etc.).
  Default switch threshold is `< 20` lux.
- `<HUE_FLOODLIGHT>` — Hue lamp or group on/off datapoint.
- `<HUE_SCENE_DIMMED>` / `<HUE_SCENE_BRIGHT>` — boolean scene activators in
  the `hue.0` namespace (or any other adapter exposing scene-trigger states).
- `<HUE_PIR_1>` / `<HUE_PIR_2>` — Hue outdoor motion sensor presence
  datapoints. Drop the second branch if you only have one.
- `<CAM_UUID_1>` / `<CAM_UUID_2>` — Bosch camera UUIDs (Objects tab →
  `bosch-smart-home-camera.0.cameras.<UUID>`).

## Notification adapter

The JavaScript examples use `sendTo('telegram.0', …)` as a placeholder for
the user's notification adapter. Replace with whatever you have installed,
e.g.:

```js
// Telegram
sendTo('telegram.0', { text: 'Motion!', type: 'photo' });

// signal-cmb (signal-cli REST API)
sendTo('signal-cmb.0', 'send', { text: 'Motion!', phone: '+49…' });

// Pushover
sendTo('pushover.0', { message: 'Motion!', priority: 1 });

// Email
sendTo('email', { to: 'me@example.com', subject: 'Motion', text: '…' });
```

## Notes

- All examples are written for the JavaScript adapter (`iobroker.javascript`).
  They will not import into the Node-RED adapter as-is.
- The Bosch adapter instance is hardcoded to `bosch-smart-home-camera.0` in
  the examples. If you run multiple instances, search-and-replace before
  saving.
- After import, **always click "Save" then "Run"** in the Blockly editor or
  JavaScript editor — the script only takes effect once it's running.

## Community contributions welcome

Found a useful automation pattern? Open a PR adding your XML or JS file to
this folder plus a row in the table above, or drop the script as a code
block in the [ioBroker forum thread](https://forum.iobroker.net/topic/84538)
and it can be picked up from there.
