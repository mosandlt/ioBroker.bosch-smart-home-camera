RE-CHECK!

Object-structure check addressed. The 14 reported issues, plus a few of the same class that only show up in a full v1.x dump, are fixed in v1.2.6 (npm + GitHub).

Role corrections, all validated against `lib/config_StateRoles.js`:

- `info.fcm_active`, `info.connection_status`, `info.maintenance.state`: `indicator.status` / `indicator.state` are not in the catalogue, now `info.status`.
- `last_motion_at`, `last_event_image_at`: `value.time` only supports `common.type` number, but these hold ISO-8601 strings, now `date`.
- `stream_quality`, `motion_sensitivity`, `detection_mode`: `level.mode` is not a catalogue role (only the `level.mode.*` leaves are), now `text`.
- `onvif_scopes`, `cloud.feature_flags`: bare `info` is not valid, now `json`.
- `wifi_signal_pct`: `value.signal` is not in the catalogue, now `value`.
- `pan_position`: `value.angle` is not in the catalogue, now `level`.
- `last_seen_event_id`: `value` requires number, the id is a string, now `text`.

Since `setObjectNotExistsAsync` never rewrites an existing object, v1.2.6 also ships a one-time idempotent migration in `onReady` that rewrites these roles on existing installs. Verified on a running sandbox: 42 objects corrected on the first start after the update, 0 on the next start, no errors.

Fresh anonymized object dump from a running v1.2.6 install (4 cameras + the `info` channel, all datapoints populated; cloud-IDs, camera names, IPs and MACs scrubbed, state values omitted):
https://gist.github.com/mosandlt/fc86420f9bb6e1ebf6a90349ce9ec690

Glad to re-upload it as a `bosch-smart-home-camera.0.json` file attachment if the object-structure bot needs the attachment to re-run.
