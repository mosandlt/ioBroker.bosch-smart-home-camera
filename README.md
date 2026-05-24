# ioBroker.bosch-smart-home-camera

ioBroker adapter for Bosch Smart Home Cameras (Eyes Outdoor, 360 Indoor, Gen2 Eyes Indoor II + Outdoor II) — beta. The full core feature set is functional end-to-end and verified live against real hardware.

> **No official API.** This adapter uses the reverse-engineered Bosch Cloud API, discovered via mitmproxy traffic analysis of the official Bosch Smart Camera app.

[![GitHub Release][releases-shield]][releases]
[![GitHub Activity][commits-shield]][commits]
[![License][license-shield]](LICENSE)

[![Project Maintenance][maintenance-shield]][user_profile]
[![BuyMeCoffee][buymecoffeebadge]][buymecoffee]

[![Community Forum][forum-shield]][forum]
![AI-Assisted](https://img.shields.io/badge/AI--Assisted-blue?style=for-the-badge)

[releases-shield]: https://img.shields.io/github/release/mosandlt/ioBroker.bosch-smart-home-camera.svg?style=for-the-badge
[releases]: https://github.com/mosandlt/ioBroker.bosch-smart-home-camera/releases
[commits-shield]: https://img.shields.io/github/commit-activity/y/mosandlt/ioBroker.bosch-smart-home-camera.svg?style=for-the-badge
[commits]: https://github.com/mosandlt/ioBroker.bosch-smart-home-camera/commits/main
[license-shield]: https://img.shields.io/github/license/mosandlt/ioBroker.bosch-smart-home-camera.svg?style=for-the-badge
[maintenance-shield]: https://img.shields.io/badge/maintainer-%40mosandlt-blue.svg?style=for-the-badge
[user_profile]: https://github.com/mosandlt
[buymecoffeebadge]: https://img.shields.io/badge/buy%20me%20a%20coffee-donate-yellow.svg?style=for-the-badge
[buymecoffee]: https://buymeacoffee.com/mosandlts
[forum-shield]: https://img.shields.io/badge/community-forum-brightgreen.svg?style=for-the-badge
[forum]: https://forum.iobroker.net/topic/84538

---

## Table of Contents

- [Integration Comparison](#integration-comparison) — pick the right project for your platform
- [Status](#status)
- [Setup](#setup)
- [Datapoints](#datapoints)
- [Changelog](#changelog)
- [License](#license)

---

## Integration Comparison

The Bosch Smart Home Camera reverse-engineered API is exposed via five sibling projects. Pick the one that fits your platform.

| Feature | [Home Assistant Integration](https://github.com/mosandlt/Bosch-Smart-Home-Camera-Tool-HomeAssistant) | [Python CLI Tool](https://github.com/mosandlt/Bosch-Smart-Home-Camera-Tool-Python) | [ioBroker Adapter](https://github.com/mosandlt/ioBroker.bosch-smart-home-camera) | [MCP Server](https://github.com/mosandlt/Bosch-Smart-Home-Camera-Tool-MCP) |
|---|---|---|---|---|
| **Maturity** | v12.8+ — HA Quality Scale **Platinum** | v10.7+ stable (Mini-NVR BETA) | v0.7+ beta | v1.3+ stable · PyPI |
| **Platform** | Home Assistant (HACS) | Standalone Python 3.10+ CLI | ioBroker (npm) | Python 3.10+ · pipx / uvx · stdio + streamable-HTTP for MCP clients (Claude Desktop, Claude Code, custom) |
| **Login** | OAuth2 PKCE (browser) | OAuth2 PKCE (browser) | OAuth2 PKCE (browser) | OAuth2 PKCE (browser, one-time) |
| **Snapshots** | ✅ Native `Camera.image` | ✅ `snapshot` command | ✅ File-store + base64 DP | ✅ `bosch_camera_snapshot` (LAN-only) |
| **Live RTSP stream (LAN)** | ✅ via HA Stream component | ✅ ffmpeg/RTSPS output | ✅ TLS proxy → local RTSP | ✅ `bosch_camera_stream_url` (LAN-only, no cloud relay) |
| **WebRTC (sub-second latency)** | ✅ via integrated go2rtc | ✅ *(v10.6.0)* `live --webrtc` | ❌ | ❌ |
| **Dual-stream URL (main + sub)** | ✅ `sensor.bosch_<n>_stream_url` + `_sub` *(v12.4.0, opt-in per cam)* | ✅ `info` shows both · `live --sub` *(v10.5.0)* | ✅ `stream_url` + `stream_url_sub` *(v0.5.3 experimental)* | ✅ via `bosch_camera_info` (verbose URLs) |
| **External recorder (BlueIris, Frigate)** | ✅ via go2rtc | ✅ stdout pipe | ✅ Digest-creds URL + LAN bind option | ✅ URL returned, hand off to ffmpeg / go2rtc downstream |
| **Privacy mode** | ✅ switch entity | ✅ command | ✅ DP | ✅ `bosch_camera_privacy_set` (LAN-fallback via `prefer_local`) |
| **Front spotlight (Gen1/Gen2)** | ✅ light entity | ✅ command | ✅ DP | ✅ `bosch_camera_light_set` (LAN-fallback) |
| **RGB wallwasher (Gen2 Outdoor II)** | ✅ light w/ RGB | ✅ command | ✅ color + brightness DPs | ❌ *(on/off only — RGB not exposed)* |
| **Panic-alarm siren** | ✅ button entity *(Gen2 Indoor II)* | ✅ command *(Gen1 360° only)* | ✅ DP | ❌ *(intentionally not exposed)* |
| **Image rotation 180°** | ✅ switch | ✅ flag | ✅ DP | ❌ |
| **Motion / person / audio events** | ✅ FCM push + polling fallback | ✅ event-watch command | ✅ FCM push + polling fallback | ✅ `bosch_camera_events` (on-demand pull) |
| **Motion edge-trigger state** | ✅ `binary_sensor.motion` | n/a | ✅ `motion_active` DP *(v0.5.3)* | n/a *(request-response, no subscription)* |
| **Auto-snapshot on motion** | ✅ refreshes Camera entity | n/a | ✅ writes `last_event_image` base64 *(v0.5.3)* | n/a *(no background loop)* |
| **Synthetic motion trigger (external sensor)** | ✅ service | n/a | ✅ DP | ❌ |
| **Cloud clip download (history ~30 d)** | ✅ via Media Browser | ❌ | ❌ *(parked — no community request yet)* | ❌ *(intentionally not exposed — large payloads)* |
| **Mini-NVR (motion-triggered local recording)** | ✅ *(v11.2.0 BETA)* | ✅ *(v10.7.0 BETA)* | ❌ | ❌ |
| **SMB / NAS clip upload** | ✅ | ✅ *(v10.7.0 BETA)* | ❌ | ❌ |
| **Audio-alarm sensitivity (Gen2)** | ✅ select | ✅ command | ❌ | ❌ |
| **Camera sharing (friends)** | ❌ | ✅ command | ❌ | ❌ *(intentionally not exposed — needs user-driven flow)* |
| **Pan / tilt (360° Gen1)** | ✅ services | ✅ command | ✅ `pan_position` DP | ✅ `bosch_camera_pan` |
| **Named pan presets (home / left / right / back-left / back-right)** | ✅ opt-in select entity | ✅ `pan --preset` flag | ✅ `pan_preset` DP | ✅ `bosch_camera_pan preset=` |
| **Two-way audio / intercom** | ❌ | ✅ command | ❌ | ❌ *(intentionally not exposed — timing-sensitive)* |
| **Webhook delivery on events** | ✅ service + opt-in options | ✅ `watch --webhook URL` | ✅ via MQTT bridge | ❌ *(request-response model)* |
| **MQTT event bridge (motion / audio / person)** | n/a *(HA event bus native)* | n/a *(single-run)* | ✅ admin-config | n/a |
| **Apple HomeKit (via HA Core bridge)** | ✅ documented | n/a | n/a | n/a |
| **Snapshot scheduler / time-lapse** | ✅ examples/ YAML | ✅ cron + ffmpeg examples | ✅ Blockly example | n/a |
| **Custom Lovelace card** | ✅ 2 cards (single + grid) | n/a | n/a | n/a |
| **ioBroker VIS dashboard** | n/a | n/a | ✅ via `snapshot_path` + `stream_url` + VIS-2 widget (alpha) | n/a |
| **Cloud-relay REMOTE fallback** | ✅ auto-switch when LAN unreachable | ✅ remote mode | ❌ *(LOCAL-only by design)* | ❌ *(media LAN-only; status/events via cloud)* |
| **Browser-based admin / config UI** | ✅ HA Config Flow | n/a (CLI) | ✅ JSON-config tabs | n/a (LLM-mediated; config via CLI / MCP client) |
| **UI languages** | EN · DE · FR · ES · IT · NL · PL · PT · RU · UK · ZH-Hans *(v12.4.0)* | EN · DE · FR · ES · IT · NL · PL · PT · RU · UK · ZH-Hans *(v10.3.0)* | EN · DE · FR · ES · IT · NL · PL · PT · RU · UK · ZH-CN | n/a *(no UI — LLM is the front-end)* |

**Legend:** ✅ supported · ❌ not supported / not planned · n/a not applicable for this platform.

> All five projects share the same reverse-engineered Cloud API + RCP protocol research, but evolve independently. The Home Assistant integration is the most feature-complete reference implementation; the Python CLI is the lowest-level / scriptable surface; the ioBroker adapter targets VIS dashboards and Blockly automations; the MCP server exposes a curated, LAN-first tool surface to MCP clients (Claude Desktop, Claude Code, custom) for natural-language camera control; the Node-RED nodes bring drag-and-drop flows to the same API surface.


---

## Changelog

### 0.7.13 (2026-05-24)
Privacy-toggle fix part 2 — TLS proxy now actually rotates its bound Digest creds.

- **Root cause of v0.7.12's residual 401**: the TLS proxy held its `digestUser` / `digestPassword` in a closure captured at proxy-start time. On the cached-proxy reuse path (same remote, sticky port), `upsertSession` republished the public `stream_url` with the freshly-issued creds but **never refreshed the proxy's own in-memory creds** — every reconnect from BlueIris/VLC still ran the Digest dance with the pre-toggle values.
- **Fix (`src/lib/tls_proxy.ts`)**: `digestAuth` is now stored in a mutable holder and exposed via `TlsProxyHandle.updateDigestAuth(user, password)`. Each per-connection auth-handler attachment reads the current values, so future connections pick up rotated creds without restarting the listener (sticky port + already-published `stream_url` survive untouched).
- **Wire-up (`src/main.ts` `upsertSession`)**: on the reuse branch, `proxyHandle.updateDigestAuth(session.digestUser, session.digestPassword)` is called with every session refresh.
- **Eager refresh (`_pollSingleCameraState`)**: on a detected ON→OFF privacy edge, if `livestream_enabled === true`, fire-and-forget `ensureLiveSession()` so the proxy's Digest creds are rotated **before** the next BlueIris/VLC reconnect attempt. Off-state edges or off-streaming cams stay no-op.
- **Defense-in-depth (`src/lib/rtsp_auth.ts`)**: when the camera responds 401 to our authed retry (i.e. we still got stale creds in), the proxy now forwards the 401 honestly + ends the client socket instead of unconditionally entering `INJECTING` mode with proven-bad creds. The next client reconnect retries against the by-then-refreshed proxy.
- **+13 pinned tests**: `rtsp_auth.spec.ts` covers AUTH_RESPONDING+401 abort path; `tls_proxy.spec.ts` covers `updateDigestAuth` API + idempotency; `main_privacy_toggle_invalidates_session.spec.ts` covers all 6 modes of the eager refresh (ON→OFF + livestream=true → fired; ON→OFF + livestream=false → not; ON→OFF + flag missing → not; OFF→ON → not regardless of livestream; ensureLiveSession rejects → no crash; unchanged state → not).

### 0.7.12 (2026-05-23)
Privacy-toggle invalidates cached LiveSession + clears `stream_url` DPs.

- **Symptom**: BlueIris and VLC refused to play `cameras.<id>.stream_url` after a privacy-mode toggle via the Bosch app, returning "Check Port/User/Password" / 401 until the adapter was restarted.
- **Root cause**: Bosch rotates the Digest credentials of the RTSP stream URL on every privacy-state edge (ON→OFF and OFF→ON). Our `_liveSessions` cache holds the pre-toggle creds for up to 60 s, so the published `stream_url` DPs kept advertising the now-stale credentials.
- **Fix (`_pollSingleCameraState`)**: every detected privacy-state change drops the cached `LiveSession` and clears both `stream_url` + `stream_url_sub` DPs to `""`. The next `ensureLiveSession()` call (next stream-toggle, snapshot, RCP write, or watchdog tick) is forced to issue a fresh `PUT /connection` and re-publish the URLs with rotated credentials. The empty-string clear also signals to external clients that the stream is temporarily unavailable, preventing them from silently retrying the stale URL.
- **+4 pinned tests** in `test/unit/main_privacy_toggle_invalidates_session.spec.ts`.

### 0.7.11 (2026-05-21)
Login UX: urgency warning + tab-first workflow + README recovery steps.

- **60-second urgency warning**: login dialog now displays an orange warning above the auth-code paste field emphasising that the Bosch auth code expires in ~60 seconds — prevents the most common "code expired" failure on slow copy-paste.
- **Tab-first workflow**: keyboard flow restructured so Tab moves directly to the paste field after opening the Bosch login tab, reducing fumble rate.
- **README recovery steps**: README rewritten with explicit "code expired" recovery path — what to click when the code times out mid-flow.

### 0.7.10 (2026-05-20)
Cloud-503 handling — honest error messages, exponential renewal backoff, maintenance-window detection. Closes [#9](https://github.com/mosandlt/ioBroker.bosch-smart-home-camera/issues/9).

- **Honest error messages**: 503 during active Bosch maintenance window → `[bosch-maintenance]` INFO (not WARN). 401/403 → "LAN session credentials expired". "Camera offline or unreachable" only after 3 consecutive LAN TCP failures.
- **Exponential renewal backoff** (`_handleRenewalFailure`, `_attemptBackoffRenewal`): on watchdog renewal failure the stream stays alive and retries at 5 s → 15 s → 45 s → 120 s → 300 s → every 300 s. Only tears down after (a) session age ≥ 60 min and renewal still failing, or (b) 3 consecutive LAN TCP connect failures.
- **Per-camera `maintenance_state` DP** (`cameras.<id>.maintenance_state`): string read-only, one of `"active"` / `"scheduled"` / `"none"`. Populated by the existing hourly RSS poll and reactive 5xx re-fetches.
- **+9 tests** in `test/unit/main_cloud_503_handling.spec.ts` (all passing). Cross-port note in commit: same improvements are due in HA `tls_proxy.py`/`__init__.py`, Python CLI `bosch_camera.py`, MCP `lan_rcp.py`.

### 0.7.9 (2026-05-20)
MQTT Bridge.

- **MQTT Bridge** (`src/lib/mqtt_bridge.ts`): optional publisher that connects to any MQTT broker on adapter ready and publishes `motion` / `person` / `audio_alarm` events as JSON payloads under configurable topic prefixes. Supports plain MQTT and TLS (`mqtts://`), optional username/password auth. Wired into all three event paths: FCM push, polling fallback, synthetic triggers.
- **Admin UI tab "MQTT Bridge"**: 6 config fields — enable toggle, broker host, port, TLS, username, password, topic prefix. All broker-detail fields hidden when bridge is disabled.
- **npm dep `mqtt@^5.15.1`** added to `dependencies`.
- **+13 tests** in `test/unit/main_mqtt_bridge.spec.ts`: Layer 1 (MqttBridge class direct — disabled=no-op, missing host=warn, valid=connect, per-type topic routing, publish-no-op-when-disconnected, disconnect); Layer 2 (adapter integration — onReady wires connect, onUnload calls disconnect, disabled skips both).
- **VIS-2 Camera Tile widget (alpha)**: custom `bosch-camera-tile` widget for VIS-2 dashboards — displays `snapshot_path` image with auto-refresh, privacy-mode overlay badge, and stream URL copy button. See `widgets/bosch-camera-tile/` and [`## VIS-2 Camera Tile widget (alpha)`](#vis-2-camera-tile-widget-alpha) section.

### 0.7.8 (2026-05-20)
Emergency LiveSession fix + PTZ pan presets.

- **Emergency LiveSession restart**: if a live-session open fails with 503 / timeout, the adapter now immediately retries once with a fresh Digest auth challenge instead of waiting for the next poll tick. Prevents a 30 s dead-stream window after transient cloud hiccups.
- **PTZ pan presets** (`pan_preset` DP): new string data point alongside `pan_position`. Accepts named presets: `home`, `left`, `right`, `back-left`, `back-right`. Writing a preset name triggers the same RCP pan command as the numeric position DP. Mirrors HA integration's opt-in select entity.

### 0.7.4 (2026-05-19)
LAN-fallback feature set — mirrors HA integration v12.4.10.

- **Coordinator outage-ping sweep**: when the state-poll GET returns 5xx or fails, a throttled (once per 30 s) fan-out TCP-connect probe runs against every known camera on port 443 so `cameras.<id>.lan_reachable` has a fresh value during cloud outages.
- **Persistent LAN-IP map**: `cameras.<id>.lan_ip` is written on every successful live-session open (`upsertSession`). On adapter start the map is reloaded from these states so the TCP-ping path has a working address book even before the first successful cloud refresh.
- **`cameras.<id>.lan_reachable` state**: boolean DP (read-only), mirrors the HA `binary_sensor.*_lan_reachable`. Always reflects the last TCP-probe result; honors the post-write grace period.
- **Post-write grace period (30 s)**: after a successful local RCP write the camera briefly rotates Digest creds and tears down its HTTPS endpoint. `_localWriteAt` is stamped on every successful local write; `isLanReachable()` treats the camera as reachable during the 30 s window so the DP does not flap to `false` after every privacy/light toggle.
- **Cloud-degraded startup**: when `fetchCameras()` fails on startup (Bosch cloud 5xx), the adapter now rehydrates known camera IDs from the ioBroker object DB and kicks an immediate LAN-ping sweep instead of silently returning. Adapter stays alive and becomes fully operational once the cloud recovers.
- **Front-light Gen2 LOCAL RCP fallback**: `_applyLightingState()` now catches cloud errors and retries via `_localWriteFrontLight()` (RCP `0x0c22`, T_WORD, num=1, brightness 0–100). Wallwasher stays cloud-only (RGB payload too complex for unauthenticated RCP).
- **Privacy LOCAL RCP fallback**: `handlePrivacyToggle()` now catches cloud errors and retries via `_localWritePrivacy()` (RCP `0x0d00`, P_OCTET) for Gen2 cameras with a known LAN IP.
- **+16 unit tests** in `test/unit/main_lan_fallback.spec.ts` covering `is_lan_reachable_*`, `grace_period_*`, `outage_ping_throttles`, `outage_ping_runs_after_window`, `outage_ping_no_cams_silent`, `local_write_grace_blocks_offline_flap`, `local_light_write_fallback_fires_on_cloud_5xx`. 572 tests total.

### 0.7.2 (2026-05-19)
Notification hooks for maintenance lifecycle and camera availability changes — mirrors the HA integration's v12.4.8 feature.

- **Maintenance lifecycle notifications** (scheduled → active → past): when the RSS-derived `info.maintenance.state` enters `scheduled`, `active`, or `past`, the adapter writes a JSON payload to the new `info.maintenance.last_notification` DP. Three notifications per window: announcement when first seen as scheduled, "läuft" when the window opens, "beendet" when it closes. Deduped by `(RSS link, state)` so a poll tick during the same phase stays silent. The `past` notification only fires if `active` was announced first for the same link — prevents spam from stale historical windows discovered after an adapter restart. Non-actionable states (recent / unknown / idle) stay silent.
- **Per-camera offline / online transition notifications**: when `cameras.<id>.online` flips, a JSON payload is written to the new `cameras.<id>.last_status_notification` DP. The first observation after adapter start is silent (baseline recording) — reboots inside an outage do not re-announce. Transitions involving `unknown` are also silent (transient cloud flap). Payload: `{ title, message, status, ts }`.
- Both notification DPs are writable via Blockly `on-change` triggers: parse the JSON, extract `title` + `message`, and forward to Telegram, Pushover, or any other notification adapter.
- **+9 unit tests** in `test/unit/main_maintenance_announce.spec.ts` + `test/unit/main_camera_status_announce.spec.ts` covering the full transition matrix, dedupe, stale-past suppression, unknown-flap silence, per-camera isolation, and notify-failure containment.

### 0.7.0 (2026-05-19)
Cloud maintenance / outage discovery: when Bosch announces a maintenance window in their community forum, the adapter fetches the RSS feeds and surfaces the state in `info.maintenance.*` data points — so automations can react before users notice a cloud outage.

- **`info.maintenance.state`** — string DP: `active` / `scheduled` / `past` / `recent` / `unknown` / `idle`. Classifies the latest announcement relative to the current time.
- **`info.maintenance.title`, `.link`, `.scheduled_start`, `.scheduled_end`, `.summary`, `.source`, `.camera_relevant`** — full parsed announcement fields.
- **`info.maintenance.last_fetched`** — ISO 8601 timestamp of the last successful community site contact.
- **Fetch cadence**: one immediate fetch at adapter startup, then every 3 600 s. Reactive re-fetch (5 min cooldown) on any 5xx from the camera cloud API.
- **Fallback chain**: primary RSS (Wartungsarbeiten → Statusmeldungen) → HTML board page. If all sources fail, the last cached state is kept — a community site outage does not destroy the known maintenance status.
- **Berlin TZ** (MEZ/MESZ, DST-aware) parsed from German DD.MM.YYYY HH:MM–HH:MM text.
- **+39 unit tests** covering RSS parser, Atom format, MEZ/MESZ DST, fallback chain, camera-relevance filter, all state classifier branches. 481 tests total.

### 0.6.2 (2026-05-18)
Resilience fix: FCM push channel now self-heals after transient socket drops. `@aracna/fcm`'s `FcmClient` does not auto-reconnect on socket close, so any transient MTalk drop (e.g. Google server rotation) would have left the adapter on the 30 s event-polling fallback until the next restart.

- **FCM auto-reconnect with exponential backoff** (5 s → 30 s → 120 s → 600 s cap). Before v0.6.2 the adapter's `disconnect` handler only logged the event and flipped `info.fcm_active` to `disconnected`. Now a successful retry restores `info.fcm_active` to `healthy` within seconds and resets the backoff so the next disconnect starts from 5 s again. The pending reconnect timer is cancelled on unload so the adapter never tries to start a half-torn-down listener during shutdown.
- **+6 unit tests** covering the backoff progression, success/reset path, re-entrancy guard against rapid-fire disconnect events, and onUnload cleanup. 442 tests total.

### 0.6.1 (2026-05-18)
Cleanup: removed legacy iOS FCM code paths aligned with HA integration v12.4.5.

- **`FCM_IOS_APP_ID` constant removed** — the adapter has used only the OSS-sanctioned Android Firebase key since its first release; the constant was dead code.
- **`mode: "ios"` dispatch chain removed** — `FcmListenerOptions.mode`, `FcmCredentials.mode`, and `FcmRawCredentials.mode` now accept `"android" | "auto"` only. `"auto"` is a direct alias for `"android"` (no iOS fallback).
- **`_registerWithCbs()` always posts `deviceType: "ANDROID"`** — the `"IOS"` branch is gone.
- **Legacy-creds back-compat**: users who stored credentials with `mode: "ios"` from a hypothetical pre-cleanup install will have their persisted mode rewritten to `"android"` on first start — no re-registration triggered.

### 0.6.0 (2026-05-16)
Security hardening + reliability round. Prepares the codebase for the official ioBroker repository PR.

- **OAuth tokens + PKCE secrets are AES-encrypted at rest** via the ioBroker system secret. Before v0.6.0, anyone with read access to the adapter namespace could see the 30-day `refresh_token` in plaintext via the Admin Objects tab. Migration is automatic on first start: any plaintext value found in `info.access_token` / `info.refresh_token` / `info.pkce_verifier` / `info.pkce_state` is re-written in encrypted form transparently.
- **FCM credentials persisted across restarts** (`info.fcm_creds`, encrypted). Previously every adapter start triggered a full re-registration: fresh ECDH key pair, fresh ACG id, fresh CBS `POST /v11/devices`. Now the listener replays the saved credentials and skips the handshake — saves ~1 s startup latency and a round-trip.
- **Camera-state poll runs per-camera in parallel** (`Promise.all`). With 4 cameras the per-tick wall-clock drops from ~N × 250 ms to ~250 ms. Each camera owns its own DP namespace, so concurrent writes don't race.
- **Timer hygiene**: `motion_active` auto-clear (90 s) and snapshot-idle teardown (60 s) now use adapter-core's `this.setTimeout` / `this.clearTimeout`, so adapter unload cancels them reliably.
- **Snapshot-saved log line is now `debug`** (was `info`) — it was firing on every motion event and flooding logs on busy installations.
- **+51 unit tests** covering the new encryption paths, FCM credential persistence, livestream toggle teardown, event processing dedup, siren / wallwasher handlers, idle teardown window, and reachability tracker. 436 tests total, 0 failing.
- **README cleaned** for the ioBroker repository PR: localised product names normalised to English, duplicate Changelog section merged into a single block, admin icon scaled to 200×200, Node 24 added to the CI matrix.

### 0.5.5 (2026-05-16)
Two forum-driven bugfixes reported against v0.5.4 on the ioBroker forum (post #1339866).

- **`motion_active` now flips on the FCM-polling-fallback path** (`info.fcm_active="polling"`). The shared post-event helper (`_onMotionFired()`, introduced in v0.5.3) was only being called by the real FCM event handler and the synthetic motion trigger — not by `fetchAndProcessEvents()`, the `/v11/events` polling loop the adapter runs when FCM registration fails. Affected users saw `last_motion_at` update correctly on every motion / person / audio_alarm event while `motion_active` stayed permanently `false`, breaking Blockly automations that listened for the rising edge. The polling path now calls the same helper, so the 90 s auto-clear timer and the auto-snapshot side-effects fire identically on both push and pull.
- **Light state now syncs back from the Bosch app**. The 30 s state poll (added in v0.5.1 for `privacy_enabled` sync) already fetched `/lighting/switch` on every tick for Gen2 cameras with `featureSupport.light=true` — but only wrote the brightness and colour into `wallwasher_brightness` / `wallwasher_color`. The boolean on/off DPs (`front_light_enabled`, `wallwasher_enabled`) were never derived from the response, so app-side light toggles stayed invisible to ioBroker until the next adapter restart. The poll now derives `front_light_enabled` from `frontLightSettings.brightness > 0` and `wallwasher_enabled` from `max(topLed, bottomLed) brightness > 0`, so app toggles propagate within ~30 s. No new HTTP call; the data was already on the wire. Gen1 cameras (Eyes Outdoor, 360°) are unchanged — `/lighting_override` is not polled today, so app-side toggles on Gen1 still wait for the next adapter restart.

### 0.5.4 (2026-05-15)
Login UX overhaul plus three small quality fixes the live-test surfaced.

- **One-click Bosch login button** in the instance settings (Forum #84538 feedback). The browser-OAuth URL is now also published as the `info.login_url` datapoint and rendered as a clickable link in the Admin UI — no more fishing the 300-char URL out of the log inspector. The new **Open Bosch Login in browser** button opens the URL directly in a new tab via the adapter's `getLoginUrl` sendTo handler. Once login succeeds, both the link and the button hide themselves.
- **No more terminate/restart loop while waiting for login**. If a stale `redirect_url` or an expired PKCE pair causes the code exchange to fail, the adapter now clears the stale state, regenerates a fresh login URL, sets `info.connection_status=auth_error`, and stays alive in awaiting-login mode. Previously the adapter terminated on every restart attempt, making it look broken in the instance overview.
- **Reset-login button**: new `Reset login (clear tokens & restart)` button (with confirmation prompt) in the instance settings. Wipes access/refresh tokens, PKCE pair, redirect_url and login_url in one click, then restarts the adapter to begin a fresh OAuth flow. Useful when a user is stuck or wants to switch to a different Bosch account.
- **`info.connection_status` text state** (`logged_out` | `awaiting_login` | `connected` | `auth_error`) — richer diagnostics for Blockly and VIS dashboards than the existing `info.connection` boolean.
- **`info.last_login_at` ISO timestamp** of the most recent successful token mint (fresh login or silent refresh). Helps gauge how close the refresh_token is to the ~30-day offline_access expiry.
- **Privacy mode no longer flips `online=false`**: an indoor camera in permanent privacy mode used to drift offline after a few startup-snapshot retries. The reachability tracker now treats privacy refusals as a user state, not a connectivity failure (Forum #84538 confused-state report).
- **`last_motion_at` is now valid ISO 8601**: Bosch sends timestamps in Java's `ZonedDateTime#toString` format (`2026-05-15T06:51:47.604+02:00[Europe/Berlin]`). The trailing `[zone-id]` broke `new Date()`. The adapter now strips it so Blockly scripts and VIS widgets can parse the field with standard tooling. Note: existing automations reading the raw string will see one less trailing token; numeric comparisons via `new Date(…).getTime()` start working from this release.
- **Snapshot keep-alive documentation honesty**: the v0.5.3 release notes claimed *~200 ms* warm-burst latency. Live measurements on Gen2 Eyes Outdoor II showed 2–5 s typical, occasionally 10–15 s — the camera's own snapshot endpoint dominates the round-trip, not the Bosch session-open. The wall-clock saving from the cached session is ~0.5–1 s (the avoided `PUT /v11/.../connection`). Updated wording in this release.

### 0.5.3 (2026-05-14)
Five forum-driven improvements — focused on the BlueIris / NVR-recorder integration story.

- **RTSP-aware proxy with transparent Digest auth (fixes forum #84538 BlueIris Error 8000007a)**: the TLS proxy now speaks RTSP and handles the Bosch Digest auth dance itself. Clients (BlueIris, iobroker.cameras, Frigate, …) connect to a clean `rtsp://host:port/rtsp_tunnel?inst=1&…` URL — **no credentials in the URL anymore**. The proxy parses the first 401 challenge from the camera, computes the response, swallows the 401, and injects an `Authorization: Digest …` header on every subsequent client request. Back-compat: clients that already send their own `Authorization` header (legacy in-URL creds path, VLC after a 401) are byte-piped through unchanged. Jaschkopf no longer needs to enter Digest credentials in BlueIris's own fields.
- **Snapshot session keep-alive (60 s idle window)**: rapid `snapshot_trigger` bursts (a Card opening, an automation polling every 5 s, a blockly script) reuse the warm Bosch session instead of paying `PUT /v11/.../connection` on every snap. Saves daily LOCAL session quota; the wall-clock saving per burst-snap is ~0.5–1 s (the `PUT /connection` round-trip) — the rest of the latency (~2–5 s typical, occasional 10–15 s when the camera is busy with its own motion engine) comes from the camera's snapshot endpoint itself and is not adapter-side.
- **`cameras.<id>.motion_active`** (new, boolean, read-only): edge-trigger DP, flips `true` on every motion / person / audio event, auto-clears to `false` after 90 s of no further events. Gives Blockly automations the clean rising/falling edge the existing `last_motion_at` timestamp doesn't provide.
- **`cameras.<id>.last_event_image`** + **Auto-snapshot on motion**: every FCM motion / person / audio_alarm event now fetches a fresh JPEG and writes it as a `data:image/jpeg;base64,…` string to `last_event_image` (plus matching `last_event_image_at` timestamp). Ready for Telegram / Signal / Matrix push automations without scripting. Toggle in new admin tab **Events / Notifications** (`auto_snapshot_on_motion`, default ON).
- **`cameras.<id>.stream_url_sub`** (new, experimental): sub-stream URL via `inst=2` alongside the main `inst=1` `stream_url`. Same Bosch session, same TLS proxy, zero extra quota cost. Lets BlueIris record the main stream while displaying the lower-bitrate substream for CPU savings. Depends on the camera firmware actually serving `inst=2` (Gen2 Eyes typically does; Gen1 may not).

### 0.5.2 (2026-05-14)
Per-camera livestream switch — default OFF.

- **`cameras.<id>.livestream_enabled`** (new, boolean, writable, default `false`): explicit on/off switch for the continuous RTSP livestream. Previous behaviour opened a 24/7 Bosch LOCAL session + TLS proxy + RTSP watchdog on every adapter start — one open session per camera, consuming the daily LOCAL session quota even when nobody was watching the stream. Streaming is now opt-in:
  - **Write `true`** → adapter calls `PUT /v11/video_inputs/{id}/connection`, spawns the TLS proxy on the sticky port, arms the RTSP watchdog (renews ~60 s before `maxSessionDuration` so external recorders see no drop), and populates `cameras.<id>.stream_url` with the digest-credentials URL.
  - **Write `false`** → watchdog cancelled, TLS proxy stopped, Bosch session closed via `DELETE /v11/video_inputs/{id}/connection`, `stream_url` cleared.
- **Snapshots remain unaffected**: every `snapshot_trigger` (and the one-per-camera startup snapshot that probes the `online` state) still opens a session, fetches the JPEG, and then — when `livestream_enabled` is `false` — closes the session right after so no proxy or watchdog stays running.
- **BlueIris recipe (forum #84538 post 14)**: VLC accepts `rtsp://user:pass@host/...` directly, BlueIris does not. To consume the stream in BlueIris, paste just `rtsp://<host>:<port>/rtsp_tunnel?…` into the address field (strip the `user:pass@` part), enter the Digest username and password in BlueIris's separate **Username / Password** fields, and set **RTSP Authentication = Digest**. Error code `8000007a (CheckPort/User/Password)` typically means BlueIris failed to apply the in-URL credentials — entering them in the dedicated fields resolves it.

### 0.5.1 (2026-05-14)
Adds Gen2 siren + RGB wallwasher colour, plus the v0.5.0 forum-driven fixes:

- **Siren** (Gen2 only): new `cameras.<id>.siren_active` boolean DP. Write `true` to trigger the integrated 75 dB siren (panic alarm), `false` to silence. Backed by `PUT /v11/video_inputs/{id}/panic_alarm` with `{status: "ON"|"OFF"}` — the same endpoint the official Bosch app uses.
- **RGB wallwasher** (Gen2 outdoor with `featureSupport.light=true`, i.e. Eyes Outdoor II): two new DPs — `cameras.<id>.wallwasher_color` (HEX `#RRGGBB`, empty string = warm white mode) and `cameras.<id>.wallwasher_brightness` (0…100). Drives both top and bottom LED groups in unison via `PUT /v11/video_inputs/{id}/lighting/switch`. The front spotlight stays untouched (controlled by `front_light_enabled` as before).
- Privacy state now syncs back from the Bosch app: every 30 s the adapter refetches `/v11/video_inputs` and mirrors `privacyMode` into `cameras.<id>.privacy_enabled`. Previously, setting privacy via the app left the ioBroker DP stale (forum #84538).
- `stream_url` now embeds Digest credentials and Bosch query params (`rtsp://<user>:<password>@host:port/rtsp_tunnel?inst=1&enableaudio=1&fmtp=1&maxSessionDuration=…`) so external recorders (BlueIris, Frigate, `iobroker.cameras`) no longer get "401 Unauthorized" on connect.
- TLS-proxy port is sticky across session renewals and adapter restarts (persisted in `cameras.<id>._proxy_port`). External recorders no longer need URL reconfiguration after each hourly Bosch session refresh.
- New admin tab "RTSP / Stream": tickbox to bind the proxy to `0.0.0.0` (instead of `127.0.0.1`) plus an external-host field so the published URL uses the ioBroker host's LAN IP — required when BlueIris / Frigate runs on a separate machine.
- Motion trigger DP description clarified: `motion_trigger` is for ioBroker-side automations only; it updates `last_motion_at` but does **not** make the Bosch app create a recording.

### 0.4.0 (2026-05-13)
- Light-datapoint split: `front_light_enabled` + `wallwasher_enabled` can now be controlled independently (e.g. a dusk sensor drives the wallwasher only, without touching the front spotlight)
- Synthetic motion trigger: write `true` to `cameras.<id>.motion_trigger` (select event type via `motion_trigger_event_type`) to inject a motion/person/audio_alarm event from an external sensor (e.g. Philips Hue in the driveway) so automations fire immediately without waiting for the Bosch FCM push
- RTSP session watchdog: LOCAL Bosch sessions renew automatically ~60 s before `maxSessionDuration` expires — BlueIris and similar 24/7 recorders no longer see an hourly stream drop
- Cloud-relay media paths fully removed: adapter enforces LOCAL-only for all media (RTSP + snapshots); if the camera is unreachable on the LAN a clear error is logged — no silent fallback to `proxy-NN.live.cbs.boschsecurity.com:42090`

Older releases (0.0.1 – 0.3.3) are archived in [CHANGELOG_OLD.md](./CHANGELOG_OLD.md).

## Status

**Beta (v0.7.13)** — verified live against 4 cameras (Gen1 + Gen2, FW 7.91.56 / 9.40.25) on a real ioBroker instance. Cloud API contracts confirmed against the iOS app via mitmproxy.

What works:
- Browser-based OAuth2 PKCE login via Bosch SingleKey ID (no programmatic password handling — captcha/MFA happen in the browser)
- Token auto-refresh (~45 min cadence; 4xx → re-login required, 5xx → silent retry). Stored `refresh_token` also used at startup to mint a fresh `access_token` silently — no PKCE re-login required after restart, even if the adapter was stopped longer than the 1 h access-token lifetime.
- Camera discovery (Gen1 + Gen2, `GET /v11/video_inputs`)
- Per-camera state tree: `name`, `firmware_version`, `hardware_version`, `generation`, `online`, `privacy_enabled`, `light_enabled`, `front_light_enabled`, `wallwasher_enabled`, `image_rotation_180`, `snapshot_trigger`, `motion_trigger`, `motion_trigger_event_type`, `snapshot_path`, `stream_url`, `last_motion_at`, `last_motion_event_type`
- Privacy toggle via Bosch Cloud API `PUT /v11/video_inputs/{id}/privacy`
- Light toggle, Gen-specific and now split into independent datapoints:
  - Gen2: `PUT /lighting/switch/front` + `/topdown`
  - Gen1: `PUT /lighting_override` (frontLightOn + wallwasherOn)
  - `front_light_enabled` and `wallwasher_enabled` can be toggled independently; `light_enabled` remains as a legacy combined switch
- Synthetic motion trigger (`motion_trigger` write-only button + `motion_trigger_event_type` selector) for external sensor integration without waiting for Bosch FCM push
- Snapshot trigger writes JPEG into the adapter file-store (`/<namespace>/cameras/<id>/snapshot.jpg`), with automatic retry on the first "stream has been aborted" hiccup that Bosch Gen2 firmware emits after idle. One startup snapshot per camera flips `cameras.<id>.online` from the default `false` to the real state immediately.
- Per-camera TLS proxy: `stream_url = rtsp://127.0.0.1:<port>/rtsp_tunnel` for use in `iobroker.cameras` or go2rtc. LOCAL-only by design — no cloud relay.
- RTSP session watchdog: LOCAL sessions renew automatically ~60 s before `maxSessionDuration` expires — 24/7 recording works without hourly stream drops
- FCM push listener (`@aracna/fcm@1.0.32` MTalk/MCS) for sub-second motion / audio-alarm / person events. `info.fcm_active` reflects state: `healthy` / `polling` / `error` / `disconnected` / `stopped`. When push registration fails the adapter falls back to `/v11/events` polling every 30 s (`info.fcm_active=polling`) — events still arrive, just with higher latency.
- Encrypted credential storage (`encryptedNative` — js-controller encrypts the refresh token at rest)
- 572+ unit tests passing

### Architecture

```mermaid
flowchart LR
    Cam["Bosch Cameras<br/>Gen1 + Gen2<br/>HTTPS :443"] -->|TLS tunnel| Proxy["Adapter TLS proxy<br/>127.0.0.1:&lt;port&gt;"]
    Cloud[Bosch CBS API<br/>residential.cbs<br/>.boschsecurity.com] -->|"FCM push<br/>OAuth2 PKCE<br/>REST: events / video_inputs<br/>/ lighting / privacy"| Adapter
    Adapter[ioBroker Adapter<br/>Node.js] --> DPs[(Encrypted DPs<br/>encryptedNative)]
    Proxy --> Adapter
    DPs --> VIS[VIS / VIS-2<br/>Dashboard]
    DPs --> Blockly[Blockly / JS<br/>automations]
    Proxy -.->|rtsp://...<br/>LAN-bind opt| Recorders[BlueIris / Frigate<br/>iobroker.cameras]
    Adapter -->|file-store| Snapshots[snapshot.jpg<br/>last_event_image]
```

### Maintenance RSS flow

```mermaid
sequenceDiagram
    participant Tick as Adapter tick (hourly)
    participant RSS as Bosch Community RSS
    participant MP as maintenance parser
    participant DP as info.maintenance.*

    Tick->>RSS: fetch Wartungsarbeiten + Statusmeldungen
    RSS-->>MP: raw feed entries (+ HTML fallback)
    MP-->>MP: parse title / time window / camera_relevant
    MP-->>DP: state: active / scheduled / past / recent / idle
    DP-->>DP: last_notification written on state transition
    Note over Tick,DP: reactive re-fetch (5 min cooldown) on any 5xx
```

### LAN-fallback during cloud outage

```mermaid
sequenceDiagram
    participant DP as cameras.<id>.privacy_enabled<br/>cameras.<id>.front_light_enabled
    participant Adapter
    participant Cloud as Bosch CBS API
    participant RCP as Camera LAN RCP
    participant Cam as Camera 192.168.x.y:443

    DP->>Adapter: handlePrivacyToggle / _applyLightingState
    Adapter->>Cloud: PUT /v11/.../privacy or lighting
    Cloud-->>Adapter: 5xx (cloud outage)
    Adapter->>Adapter: lan_ip known + Gen2?
    Adapter->>RCP: RCP write (0x0d00 / 0x0c22)
    RCP->>Cam: HTTPS Digest + payload
    Cam-->>Adapter: 200 OK (local fallback)
    Adapter-->>DP: update + _localWriteAt stamp
```

## Setup

> ⚠ **The Bosch auth code in the redirect URL expires in ~60 seconds.** Open the adapter Admin dialog in one tab BEFORE you click the login button, so you can paste the URL back the moment Bosch redirects you. If the code expires, just click "Open Bosch Login in browser" again — a fresh URL is generated each time.

1. **Install** the adapter and create an instance (the adapter starts in "waiting for login" mode).
2. **Open the adapter's Admin dialog** (Instances → bosch-smart-home-camera → wrench icon). The Connection tab shows the login flow inline; **keep this dialog open** in one tab.
3. **Click "Open Bosch Login in browser"** — Bosch SingleKey ID opens in a new tab. Log in (captcha / MFA if prompted).
4. **Bosch redirects** your browser to `https://www.bosch.com/boschcam?code=…&state=…`. The page may show blank or a 404 — that is expected. **Immediately copy** the full URL from the address bar.
5. **Switch back to the adapter Admin tab** and paste the URL into "Pasted callback URL", then Save. Do this within ~60 seconds of the redirect, otherwise the auth code expires and you have to start over.
6. The adapter restarts, exchanges the auth code for tokens, fetches your cameras, and starts the FCM listener. Future restarts skip the browser step as long as the stored refresh token is still valid.

**Fallback if the Admin button is not available** (very old ioBroker Admin versions): the adapter also publishes the login URL as a state object — open `Objects → bosch-smart-home-camera.0 → info → login_url` and click the value to launch the login. The redirect-paste step is the same.

**If the auth code expires** (you'll see `code expired` in the log after pasting), don't panic — just click "Open Bosch Login in browser" again. The adapter generates a fresh URL each time you press the button.

If the refresh token is ever rejected (after a Bosch password change or extended downtime), the adapter logs a new login URL and you repeat steps 3–5.

### OAuth2 PKCE login flow

```mermaid
sequenceDiagram
    autonumber
    participant U as User (browser)
    participant A as ioBroker Adapter
    participant B as Bosch SingleKey ID

    A->>A: generate PKCE verifier + state
    A->>U: log login URL (challenge + state)
    U->>B: open URL, enter credentials, solve captcha/MFA
    B->>U: redirect to bosch.com/boschcam?code=...&state=...
    U->>A: paste callback URL into Admin UI
    A->>B: POST /token (code + PKCE verifier)
    B-->>A: access_token + refresh_token
    A->>A: AES-encrypt + persist (info.access_token / info.refresh_token / info.fcm_creds)
    A->>B: GET /v11/video_inputs (with bearer)
    B-->>A: camera list
    A->>A: build per-camera DP tree, start FCM listener
```

## Dashboard

A ready-to-import VIS-2 example dashboard is in
[`docs/vis-2-example/`](./docs/vis-2-example/) — all four cameras in a 2×2
grid with snapshot refresh (every 5 s), privacy + light toggles, snapshot
trigger button, and a status bar.

Quick install:

```bash
cp docs/vis-2-example/vis-views.json ~/iobroker-data/files/vis-2.0/main/
iobroker restart vis-2
# Open http://HOST:8082/vis-2/index.html#Cameras
```

See [`docs/vis-2-example/README.md`](./docs/vis-2-example/README.md) for the
walkthrough, including how to swap the camera UUIDs and how to wire go2rtc /
HLS for low-latency live video instead of the default snapshot refresh.

### VIS-2 Camera Tile widget (alpha)

Starting with v0.7.9 the adapter ships a built-in **VIS-2 widget** that can be
dropped onto any VIS-2 view without importing a JSON file.

**Requirements:** VIS-2 adapter installed and running.

**How to use:**

1. Open the VIS-2 editor (`http://HOST:8082/vis-2/index.html?edit=1`).
2. In the widget panel, find the **Bosch Smart Home Camera** widget set.
3. Drag **Bosch Camera Tile** onto your view.
4. In the widget properties, set **Camera ID datapoint** to any DP under
   `bosch-smart-home-camera.0.cameras.<UUID>` (e.g. `.name`) — the adapter
   extracts the UUID automatically.
5. Optionally: adjust **Snapshot refresh** (default 30 s), toggle the light
   button visibility, and set a fixed tile width.

**What the tile shows:**

- Camera name + Online/Offline badge
- Live snapshot image (auto-refreshed at the configured interval)
- Motion and Privacy badges when active
- Privacy toggle button (reads/writes `privacy_enabled`)
- Light toggle button (reads/writes `front_light_enabled`; hide via settings
  for cameras without LEDs such as the Indoor II)

> **Alpha status:** the widget registers via a vanilla-JS bundle without React.
> It works with VIS-2 >= 2.0 but has not been stress-tested across all VIS-2
> versions. Feedback welcome via GitHub Issues.

### Motion / event flow (camera → DP → automation)

```mermaid
flowchart TD
    Cam[Camera detects motion<br/>or audio alarm] -->|FCM push<br/>MTalk/MCS| L[Adapter FCM listener<br/>_aracna/fcm_]
    L -->|persistent_id dedup| F{fetchEvents<br/>GET /v11/events}
    F -->|new event| N["normalize event:<br/>id, type, tags, timestamp"]
    N --> C{eventTags / type}
    C -->|MOVEMENT + PERSON| EP[last_event_type=person<br/>motion_active=true 90s]
    C -->|MOVEMENT| EM[last_event_type=movement<br/>motion_active=true 90s]
    C -->|AUDIO_ALARM| EA[last_event_type=audio_alarm]
    EP & EM & EA --> S[fetch snapshot<br/>→ snapshot.jpg<br/>→ last_event_image base64]
    EP & EM & EA --> T[Blockly / JS trigger]
    T -->|sendTo notify| Out[Telegram / Signal /<br/>Pushover / e-mail]
    L -.->|register fail<br/>3x| Poll[Polling fallback<br/>every 30s<br/>info.fcm_active=polling]
```

## Example automations

A growing library of 20 ready-to-import scripts lives in
[`examples/`](./examples/) — 8 Blockly XML files for the visual editor and
12 plain JavaScript snippets side-by-side. Themes covered:

- **Master switches** — one virtual datapoint flips wallwasher / privacy
  on every camera in lock-step.
- **Motion handling** — snapshot-on-motion with notification, Hue-PIR →
  synthetic Bosch motion bridge, burst-aggregation notify, presence-driven
  privacy.
- **Light scenes** — dusk-driven auto-wallwasher, full driveway scene
  (Hue floodlight + Bosch wallwasher/frontlight, contributed by
  [Jaschkopf](https://forum.iobroker.net/topic/84538/adapter-bosch-smart-home-kameras/29)),
  vacation deterrent, door-sensor light.
- **Bot / dashboard integration** — Telegram `/snap` command, last-event
  slideshow for VIS, stream-URL push to a Fully Kiosk tablet.
- **Status & safety** — camera-offline alert, FCM-push degradation
  monitor, panic-siren trigger, weather-suppressed alerts, sleep-mode
  mute, garage-door coordination, night-mode schedule.
- **Snapshot scheduler / time-lapse** —
  [`examples/snapshot-blockly.md`](./examples/snapshot-blockly.md):
  hourly Blockly XML + JavaScript scheduler (06:00–22:00 cron), plus a
  motion-triggered variant with 15-minute throttle. Writes
  `snapshot_trigger`, reads back `snapshot_path`. Includes an ffmpeg
  one-liner to assemble the collected JPEGs into an mp4 time-lapse.

Open javascript adapter → Scripts → new Blockly (or JavaScript) → paste.
Replace the `<CAM_UUID>` / `<PRESENCE_OID>` / lux-sensor / Telegram-bot
placeholders with your actual object IDs from the Objects tab. The
folder's [README](./examples/README.md) has the full index, prerequisites,
and notification-adapter call patterns (Telegram, signal-cmb, Pushover,
email).

→ **Contribute your own**: drop a working script as a code block in the
[ioBroker forum thread](https://forum.iobroker.net/topic/84538) or open a
PR — community examples are explicitly welcome.

Note on **live streaming in the browser**: no browser supports RTSP natively.
The adapter publishes a per-camera `stream_url`
(`rtsp://<user>:<password>@127.0.0.1:<port>/rtsp_tunnel?…`) via a local TLS
proxy for use with ffmpeg / mpv / `iobroker.cameras` / go2rtc. For VIS
itself, either use the snapshot refresh in the example dashboard or bridge
via go2rtc → WebRTC/HLS.

### External recorders (BlueIris, Frigate)

```mermaid
flowchart LR
    Cam["Bosch Camera<br/>192.168.x.y:443<br/>HTTPS only"] -->|RTSP-over-TLS<br/>tunneled| Proxy["Adapter TLS proxy<br/>port: per-camera<br/>bind: 127.0.0.1 or LAN"]
    Proxy -->|"rtsp://user:pwd@<br/>host:&lt;port&gt;/rtsp_tunnel<br/>?inst=1&enableaudio=1"| B[BlueIris]
    Proxy -->|"rtsp://...?inst=1"| F[Frigate]
    Proxy -->|"rtsp://...?inst=2 sub"| ICam[iobroker.cameras]
    Cloud[Bosch CBS API] -.->|hourly session renew<br/>~60s before timeout| Proxy
```

By default the proxy listens on `127.0.0.1` — reachable from the ioBroker
host itself but not from another machine. To use a recorder on a separate
host:

1. Admin UI → "RTSP / Stream" tab → tick **Expose RTSP proxy to LAN**.
2. Set **External hostname / LAN IP** to the ioBroker host's LAN IP, e.g.
   `192.168.1.50`.
3. Save → adapter restarts → `cameras.<id>.stream_url` becomes
   `rtsp://<user>:<password>@192.168.1.50:<sticky-port>/rtsp_tunnel?…`.
4. Copy that URL into BlueIris / Frigate / your recorder.

The port is sticky across adapter restarts and Bosch session renewals
(persisted in `cameras.<id>._proxy_port`) — set the URL in your recorder
once and it keeps working.

#### Person-only recording via CodeProject AI

A workflow described by [Jaschkopf](https://forum.iobroker.net/topic/84538/adapter-bosch-smart-home-kameras/29)
on the ioBroker forum: add each `stream_url` as an RTSP camera in BlueIris,
enable 24/7 sub-stream recording with a short retention (e.g. 7 days), and
wire BlueIris's motion-detection alerts into [CodeProject AI](https://www.codeproject.com/AI/)
running YOLO. Only when CodeProject classifies a frame as a person (or
another configured class — dog, cat, vehicle, license plate, face) does
BlueIris flip to mainstream recording, with a few seconds of pre-roll. Cuts
storage and false-positive alerts dramatically while keeping the rich
mainstream footage for events that matter.

## MQTT Bridge

When enabled, the adapter publishes every motion / person / audio\_alarm event
as a JSON message to an MQTT broker of your choice — making Bosch camera events
available to any MQTT consumer without ioBroker-specific bindings.

**Admin UI → "MQTT Bridge" tab:**

| Field | Default | Description |
|---|---|---|
| Enable MQTT Bridge | `false` | Master switch |
| Broker host / IP | — | Hostname or IP, e.g. `192.168.1.10` |
| Broker port | `1883` | 1–65535 |
| Use TLS (mqtts://) | `false` | Encrypted connection |
| Username | — | Optional |
| Password | — | Optional, stored encrypted |
| Topic prefix | `bosch/cameras` | All topics live under this prefix |

**Topic layout:**

```
<prefix>/<cam-uuid>/motion      motion or unclassified movement
<prefix>/<cam-uuid>/person      person detected
<prefix>/<cam-uuid>/audio       audio_alarm event
```

**Payload (JSON):**

```json
{
  "timestamp": "2026-05-20T10:00:00.000Z",
  "cam_name":  "Terrasse",
  "event_id":  "evt-uuid-or-empty",
  "event_type": "motion"
}
```

**Compatible consumers:** Node-RED, openHAB, Home Assistant (MQTT integration),
Frigate, Zigbee2MQTT sidecars, any standard MQTT subscriber.

**Example Node-RED subscription:**
```
bosch/cameras/EF791764-.../motion
```

Wire it to a Telegram notification, a Frigate alert, or a Home Assistant
`mqtt.sensor` — no ioBroker adapter required on the subscriber side.

## Roadmap

| Version | Scope |
| --- | --- |
| v0.8.x | Motion zone read (RCP `0x0c0a`/`0x0c00`) — local-only; write blocked pending Bosch summer local-user |
| v1.0.0 | ioBroker repository listing (stable badge) + feature parity checkpoint |

Image rotation (v0.3.0) is a client-side display flag — Bosch's Cloud API has no rotation endpoint and RCP+ `0x0810` WRITE returns HTTP 401 on Gen2 FW 9.40.25, mirroring the HA integration's approach.

## Development

```bash
npm install
npm run build        # tsc → build/
npm run watch        # auto-rebuild on save
npm test             # unit tests (572 passing)
npm run lint
npm run test:coverage          # coverage report → coverage/index.html (HTML) + lcov
npm run test:coverage:check    # enforce thresholds: 80% lines/functions, 70% branches
```

### Manual deploy to a local ioBroker test instance

```bash
SRC=$(pwd)
DST=$HOME/iobroker-test/node_modules/iobroker.bosch-smart-home-camera
rm -rf "$DST/build" && cp -r "$SRC/build" "$DST/"
cp "$SRC/io-package.json" "$DST/"
cp -r "$SRC/admin" "$DST/"
~/iobroker-test/iob upload bosch-smart-home-camera
~/iobroker-test/iob restart bosch-smart-home-camera.0
```

## Existing adapter landscape

- **[iobroker.bshb](https://github.com/holomekc/ioBroker.bshb)** — SHC Local REST API (thermostats, switches, alarms). Camera on/off only, no stream or snapshot. Active maintainer.
- **[iobroker.cameras](https://github.com/ioBroker/ioBroker.cameras)** — generic HTTP snapshot / RTSP wrapper. Pair this adapter's `stream_url` state with iobroker.cameras to get a Vis tile.
- **[iobroker.onvif](https://github.com/iobroker-community-adapters/ioBroker.onvif)** — generic ONVIF. Bosch cameras don't currently expose a local ONVIF endpoint, so this adapter is the only path for Bosch hardware.

## Release process

This adapter uses [`@alcalzone/release-script`](https://github.com/AlCalzone/release-script) for version bumps.

```bash
npm run release patch    # 0.3.0 → 0.3.1
npm run release minor    # 0.3.0 → 0.4.0
npm run release major    # 0.3.0 → 1.0.0
```

1. Builds + runs the full test suite (must pass)
2. Bumps version in `package.json` + `io-package.json`
3. Auto-generates a news entry from commits since the last release
4. Creates the `vX.Y.Z` tag and pushes — GitHub Actions auto-publishes to npm

## Related Projects

This adapter is part of a 5-implementation family for Bosch Smart Home Cameras:

| Implementation | Repo | Status |
|---|---|---|
| 🏆 Home Assistant Integration | [Bosch-Smart-Home-Camera-Tool-HomeAssistant](https://github.com/mosandlt/Bosch-Smart-Home-Camera-Tool-HomeAssistant) | **v12.8.4** · HA Quality Scale **Platinum** · production-ready |
| 🐍 Python CLI | [Bosch-Smart-Home-Camera-Tool-Python](https://github.com/mosandlt/Bosch-Smart-Home-Camera-Tool-Python) | v10.7.6 · Mini-NVR + SMB upload (BETA) · LAN-fallback (ping / --local) · capture / research / no-HA standalone |
| 🟢 **ioBroker Adapter** (this repo) | [ioBroker.bosch-smart-home-camera](https://github.com/mosandlt/ioBroker.bosch-smart-home-camera) | v0.7.13 · beta · npm |
| 🤖 MCP Server | [Bosch-Smart-Home-Camera-Tool-MCP](https://github.com/mosandlt/Bosch-Smart-Home-Camera-Tool-MCP) | v1.3.5 · LAN-ping + prefer_local · Claude Code / Claude Desktop integration |
| 🔴 Node-RED nodes (alpha) | [Bosch-Smart-Home-Camera-Tool-NodeRED](https://github.com/mosandlt/Bosch-Smart-Home-Camera-Tool-NodeRED) | v0.1.0-alpha · skeleton |

HA stays the **reference implementation** — features land there first; the Python CLI and this adapter catch up over time.

## License

MIT License — see [LICENSE](./LICENSE).

Copyright © 2026 mosandlt
