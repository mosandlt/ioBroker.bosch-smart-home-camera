# ioBroker.bosch-smart-home-camera

[![NPM version](https://img.shields.io/npm/v/iobroker.bosch-smart-home-camera.svg)](https://www.npmjs.com/package/iobroker.bosch-smart-home-camera)
[![Downloads](https://img.shields.io/npm/dm/iobroker.bosch-smart-home-camera.svg)](https://www.npmjs.com/package/iobroker.bosch-smart-home-camera)
![Number of Installations](https://iobroker.live/badges/bosch-smart-home-camera-installed.svg)
[![License](https://img.shields.io/npm/l/iobroker.bosch-smart-home-camera.svg)](https://github.com/mosandlt/ioBroker.bosch-smart-home-camera/blob/main/LICENSE)
[![GitHub Release](https://img.shields.io/github/release/mosandlt/ioBroker.bosch-smart-home-camera.svg)](https://github.com/mosandlt/ioBroker.bosch-smart-home-camera/releases)
[![GitHub Activity](https://img.shields.io/github/commit-activity/y/mosandlt/ioBroker.bosch-smart-home-camera.svg)](https://github.com/mosandlt/ioBroker.bosch-smart-home-camera/commits/main)
[![Test and Release](https://github.com/mosandlt/ioBroker.bosch-smart-home-camera/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/mosandlt/ioBroker.bosch-smart-home-camera/actions/workflows/test-and-release.yml)
[![Project Maintenance](https://img.shields.io/badge/maintainer-%40mosandlt-blue.svg)](https://github.com/mosandlt)
[![BuyMeCoffee](https://img.shields.io/badge/buy%20me%20a%20coffee-donate-yellow.svg)](https://buymeacoffee.com/mosandlts)
[![Community Forum](https://img.shields.io/badge/community-forum-brightgreen.svg)](https://forum.iobroker.net/topic/84538)
![AI-Assisted](https://img.shields.io/badge/AI--Assisted-blue.svg)

[![NPM](https://nodei.co/npm/iobroker.bosch-smart-home-camera.png?downloads=true)](https://www.npmjs.com/package/iobroker.bosch-smart-home-camera)

ioBroker adapter for Bosch Smart Home Cameras (Eyes Outdoor, 360 Indoor, Gen2 Eyes Indoor II + Outdoor II). The full core feature set is functional end-to-end and verified live against real hardware.

**Supported models:** Eyes Outdoor (Gen1), Eyes Outdoor II (Gen2), 360 Indoor (Gen1), Eyes Indoor II (Gen2) — model-specific timing and configuration is automatic.

> **No official API.** This adapter uses the reverse-engineered Bosch Cloud API, discovered via mitmproxy traffic analysis of the official Bosch Smart Camera app.

---

## Table of Contents

- [Integration Comparison](#integration-comparison) — pick the right project for your platform
- [Supported Cameras](#supported-cameras)
- [Disclaimer](#disclaimer)
- [Setup](#setup)
- [Architecture](#architecture)
  - [Network Connectivity](#network-connectivity) — required ports, VLAN/subnet pitfalls
- [Status](#status)
- [Datapoints](#datapoints)
- [Dashboard](#dashboard)
- [Example Automations](#example-automations)
- [MQTT Bridge](#mqtt-bridge)
- [External Recorders (BlueIris, Frigate)](#external-recorders-blueiris-frigate)
- [Development](#development)
- [Existing Adapter Landscape](#existing-adapter-landscape)
- [Release Process](#release-process)
- [Related Projects](#related-projects)
- [Changelog](#changelog)
- [License](#license)

---

## Integration Comparison

The Bosch Smart Home Camera reverse-engineered API is exposed via four sibling projects. Pick the one that fits your platform.

| Feature | [Home Assistant Integration](https://github.com/mosandlt/Bosch-Smart-Home-Camera-Tool-HomeAssistant) | [Python CLI Tool](https://github.com/mosandlt/Bosch-Smart-Home-Camera-Tool-Python) | [ioBroker Adapter](https://github.com/mosandlt/ioBroker.bosch-smart-home-camera) | [MCP Server](https://github.com/mosandlt/Bosch-Smart-Home-Camera-Tool-MCP) | [Frontend (NiceGUI)](https://github.com/mosandlt/Bosch-Smart-Home-Camera-Tool-Python-frontend) | [Node-RED](https://github.com/mosandlt/Bosch-Smart-Home-Camera-Tool-NodeRED) |
|---|---|---|---|---|---|---|
| **Maturity** | v15.0+ — HA Quality Scale **Platinum** | v10.12+ stable (Mini-NVR BETA) | v1.8+ stable · npm | v1.7+ stable · PyPI | v0.4.0 **alpha** · PyPI | v0.4.0 **alpha** · npm |
| **Platform** | Home Assistant (HACS) | Standalone Python 3.10+ CLI | ioBroker (npm) | Python 3.10+ · pipx / uvx · stdio + streamable-HTTP for MCP clients (Claude Desktop, Claude Code, custom) | NiceGUI web app · Python 3.10+ | Node-RED palette · npm |
| **Login** | OAuth2 PKCE (browser) | OAuth2 PKCE (browser) | OAuth2 PKCE (browser) | OAuth2 PKCE (browser, one-time) | ◑ shares CLI `bosch_config.json` | ◑ refresh-token from CLI |
| **Snapshots** | ✅ Native `Camera.image` | ✅ `snapshot` command | ✅ File-store + base64 DP | ✅ `bosch_camera_snapshot` (LAN-only) | ✅ live + event fallback | ✅ `snapshot` node |
| **Live RTSP stream (LAN)** | ✅ via HA Stream component | ✅ ffmpeg/RTSPS output | ✅ TLS proxy → local RTSP | ✅ `bosch_camera_stream_url` (LAN-only, no cloud relay) | ◑ internal (go2rtc) | ◑ `stream-url` node (URL only) |
| **WebRTC (sub-second latency)** | ✅ via integrated go2rtc | ✅ *(v10.6.0)* `live --webrtc` | ❌ | ❌ | ✅ via go2rtc (else snapshot) | ❌ |
| **Dual-stream URL (main + sub)** | ✅ `sensor.bosch_<n>_stream_url` + `_sub` *(v12.4.0, opt-in per cam)* | ✅ `info` shows both · `live --sub` *(v10.5.0)* | ✅ `stream_url` + `stream_url_sub` *(v0.5.3 experimental)* | ◑ `bosch_camera_stream_url` — main stream only | ❌ *(sub-stream only)* | ◑ URL only — no sub option |
| **External recorder (BlueIris, Frigate)** | ✅ via go2rtc | ✅ stdout pipe | ✅ Digest-creds URL + LAN bind option | ✅ URL returned, hand off to ffmpeg / go2rtc downstream | ❌ | ◑ `stream-url` → wire downstream |
| **Privacy mode** | ✅ switch entity | ✅ command | ✅ DP | ✅ `bosch_camera_privacy_set` (LAN-fallback via `prefer_local`) | ✅ toggle | ✅ `privacy` node |
| **Front spotlight (Gen1/Gen2)** | ✅ light entity | ✅ command | ✅ DP | ✅ `bosch_camera_light_set` (LAN-fallback) | ❌ *(Phase 2 stub)* | ✅ `bosch-camera-light` node *(v0.3.0-alpha)* |
| **RGB wallwasher (Gen2 Outdoor II)** | ✅ light w/ RGB | ◑ on/off only — no RGB | ✅ color + brightness DPs | ❌ *(on/off only — RGB not exposed)* | ❌ | ◑ on/off + intensity only — no RGB *(v0.3.0-alpha)* |
| **Panic-alarm siren** | ✅ button entity *(Gen2 Indoor II)* | ✅ command *(Gen2 Indoor II only)* | ✅ DP | ✅ `bosch_camera_siren_trigger` *(Gen2 Indoor II only)* | ✅ trigger + duration *(Gen2 Indoor II only)* | ❌ |
| **Firmware update** | ✅ Update-Entity + Repairs fix-flow, install button *(v14.4.10)* | ✅ status + install *(v10.11.0)* | ✅ firmware states + install trigger, write-lock guard *(v1.8.0)* | ✅ status + install tools *(v1.7.0)* | ◑ read-only status display, no install action | ✅ status + install nodes *(v0.4.0-alpha)* |
| **Image rotation 180°** | ✅ switch | ❌ | ✅ DP | ❌ | ❌ | ❌ |
| **Motion / person / audio events** | ✅ FCM push + polling fallback | ◑ `watch` command only (events cmd removed) | ✅ FCM push + polling fallback | ✅ `bosch_camera_events` (on-demand pull) | ◑ pull-only events table | ✅ `event` node (poll) |
| **Motion edge-trigger state** | ✅ `binary_sensor.motion` | n/a | ✅ `motion_active` DP *(v0.5.3)* | n/a *(request-response, no subscription)* | ❌ | ❌ |
| **Auto-snapshot on motion** | ✅ refreshes Camera entity | n/a | ✅ writes `last_event_image` base64 *(v0.5.3)* | n/a *(no background loop)* | ❌ | ❌ |
| **Synthetic motion trigger (external sensor)** | ✅ service | n/a | ✅ DP | ❌ | ❌ | ❌ |
| **Motion zones / privacy masks** | ✅ read + write | ✅ read + write | ✅ read + write *(v1.8.0)* | ✅ get / set / clear *(v1.7.0)* | ❌ *(no visual editor yet)* | ❌ |
| **Automation rules / schedules** | ✅ read + write | ✅ read + write | ✅ full CRUD *(v1.8.0)* | ✅ list / add / edit / delete *(v1.7.0)* | ✅ full CRUD (list/add/edit/delete) | ❌ |
| **Lighting schedule** | ✅ read (write via service, Gen1 Eyes Outdoor only) | ✅ read + write | ✅ read *(Gen1-only, v1.2.0)* | ✅ get / set *(v1.7.0)* | ✅ read + write *(outdoor Eyes cameras)* | ❌ |
| **Cloud clip download (history ~30 d)** | ✅ via Media Browser | ❌ | ❌ *(parked — no community request yet)* | ❌ *(intentionally not exposed — large payloads)* | ❌ *(use CLI)* | ◑ `clip_url` in event payload |
| **Mini-NVR (local recording)** | ✅ continuous + event-buffered, ring-buffer preroll *(v11.2.0 BETA → v14.7.0 modes)* | ◑ event-triggered segment muxing, no preroll ring *(v10.7.0 BETA)* | ❌ *(delegates to external recorder via credential-free RTSP endpoint)* | ❌ *(no NVR concept)* | ◑ continuous only, no event-buffered *(v0.4.0-alpha)* | ◑ continuous only via `bosch-camera-nvr-record` node *(v0.4.0-alpha)* |
| **SMB / NAS clip upload** | ✅ | ✅ *(v10.7.0 BETA)* | ❌ | ❌ | ❌ | ❌ |
| **Camera sharing (friends)** | ✅ services (share / invite / list) | ✅ command | ✅ share / invite / remove *(Gen2 only, v1.8.0)* | ✅ list / invite / share / unshare / remove *(v1.7.0)* | ✅ list/invite/remove/share/unshare | ❌ |
| **Pan / tilt (360° Gen1)** | ✅ services | ✅ command | ✅ `pan_position` DP | ✅ `bosch_camera_pan` | ✅ slider wired to live API | ❌ |
| **Named pan presets (home / left / right / back-left / back-right)** | ✅ opt-in select entity | ✅ `pan --preset` flag | ✅ `pan_preset` DP | ✅ `bosch_camera_pan preset=` | ❌ | ❌ |
| **Two-way audio / intercom** | ❌ | ✅ command | ❌ | ◑ listen-only `bosch_camera_intercom_open` *(v1.7.0)* | ❌ | ❌ |
| **Webhook delivery on events** | ✅ service + opt-in options | ✅ `watch --webhook URL` | ✅ via MQTT bridge | ❌ *(request-response model)* | ❌ | ❌ |
| **MQTT event bridge (motion / audio / person)** | n/a *(HA event bus native)* | n/a *(single-run)* | ✅ admin-config | n/a | ❌ | ❌ |
| **Apple HomeKit (via HA Core bridge)** | ✅ documented | n/a | n/a | n/a | n/a | n/a |
| **Snapshot scheduler / time-lapse** | ✅ examples/ YAML | ✅ cron + ffmpeg examples | ✅ Blockly example | n/a | ❌ | ❌ |
| **Native dashboard card / widget** | ✅ 2 Lovelace cards (single + grid) | n/a | ✅ 2 vis-2 widgets — BoschCamera + BoschOverview multi-cam | n/a | ✅ *(is itself a web dashboard)* | ❌ |
| **Picture-in-Picture survives backgrounded tab** | ✅ `hass-suspend-when-hidden` keep-alive *(v14.0.0)* | n/a (no UI) | ✅ own PiP + freeze-recovery, Web-Worker heartbeat *(v1.7.2/v1.7.3)* | n/a (no UI) | ✅ reconnect-timeout + freeze-recovery *(v0.4.0-alpha)* | n/a (no UI) |
| **Cloud-relay REMOTE fallback** | ✅ auto-switch when LAN unreachable | ✅ remote mode | ❌ *(LOCAL-only by design)* | ❌ *(media LAN-only; status/events via cloud)* | ◑ inherits CLI | ◑ REMOTE opt (manual) |
| **Browser-based admin / config UI** | ✅ HA Config Flow | n/a (CLI) | ✅ JSON-config tabs | n/a (LLM-mediated; config via CLI / MCP client) | ✅ Settings page | ◑ editor config node |
| **UI languages** | EN · DE · FR · ES · IT · NL · PL · PT · RU · UK · ZH-Hans *(v12.4.0)* | EN · DE · FR · ES · IT · NL · PL · PT · RU · UK · ZH-Hans *(v10.3.0)* | EN · DE · FR · ES · IT · NL · PL · PT · RU · UK · ZH-CN | n/a *(no UI — LLM is the front-end)* | ◑ backend i18n · UI mostly EN | n/a *(English only)* |

**Legend:** ✅ supported · ❌ not supported / not planned · n/a not applicable for this platform.

> All four projects share the same reverse-engineered Cloud API + RCP protocol research, but evolve independently. The Home Assistant integration is the most feature-complete reference implementation; the Python CLI is the lowest-level / scriptable surface; the ioBroker adapter targets VIS dashboards and Blockly automations; the MCP server exposes a curated, LAN-first tool surface to MCP clients (Claude Desktop, Claude Code, custom) for natural-language camera control.

---

## Supported Cameras

All four current [Bosch Smart Home](https://www.bosch-smarthome.com) cameras are supported.

| Camera | Generation | Type | Codec / FW seen | Highlights |
|---|---|---|---|---|
| **360° Indoor** | Gen1 | Indoor | H.264 + AAC · FW 7.91.x | Pan/tilt motor, autofollow, IR night vision, mechanical privacy shutter |
| **Eyes Indoor II** | Gen2 | Indoor | H.264 + AAC · FW 9.40.x | Built-in 75 dB siren, Audio+ glass-break / smoke / CO, ZONES detection mode, RGB LEDs, retractable head (Privacy hardware button) |
| **Eyes Outdoor** | Gen1 | Outdoor (IP66) | H.264 + AAC · FW 7.91.x | Front spotlight, motion-triggered light, ambient-light sensor, schedule-driven illumination |
| **Eyes Outdoor II** | Gen2 | Outdoor (IP66) | H.264 + AAC · FW 9.40.x | Front + Top + Bottom RGB LED groups, DualRadar (motion + intrusion), wallwasher mode, mounting-elevation parameter |

---

## Disclaimer

**This project is an independent, community-developed adapter. It is not affiliated with, endorsed by, or connected to Robert Bosch GmbH. "Bosch" and "Bosch Smart Home" are registered trademarks of Robert Bosch GmbH.**

This adapter communicates with a reverse-engineered, undocumented API. Provided **"as is"**, without warranty. Use at your own risk. The API may change or be shut down by Bosch at any time. Reverse engineering was performed solely for interoperability under **§ 69e of the German Copyright Act (UrhG)** and **EU Directive 2009/24/EC**.

---

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

---

## Architecture

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

### Network Connectivity

The ioBroker host must be able to reach each camera's IP on the LAN. The Bosch cloud auto-discovers the camera IP, but stream/snapshot/RCP traffic flows directly from the ioBroker host to the camera. If a firewall, VLAN boundary, or guest network blocks that path, the live MJPEG/RTSP stream and on-demand snapshot fall back to a (slower) cloud path.

#### Required ports

| Direction | Protocol / Port | Purpose | Required |
|---|---|---|---|
| ioBroker host → camera IP | **TCP/443** | Snapshots, camera REST API, RTSPS live stream (everything tunnels through one TLS connection) | **Yes** |
| ioBroker host → `*.boschsecurity.com` | TCP/443 | OAuth, REMOTE/cloud fallback stream, FCM push registration | Yes |
| ioBroker host → `fcm.googleapis.com` / `mtalk.google.com` | TCP/5228 | FCM push notifications (auto-falls-back to polling) | Optional |
| External recorder (BlueIris/Frigate/iobroker.cameras) → ioBroker host | TCP/`stream_port` | Local RTSP relay exposed by the adapter | Only when used |

The adapter itself **only needs TCP/443 from the ioBroker host to the camera**. No UDP, no inbound port-forward on your router.

#### Common pitfalls

- **Camera in a different subnet/VLAN than ioBroker** — e.g. cameras on `192.168.168.x` and ioBroker on `192.168.1.x`. The router/firewall must allow the ioBroker host's IP outbound to the camera's IP on TCP/443.
- **IoT/guest network isolation** (FRITZ!Box "Gastzugang", Unifi guest network) blocks LAN-to-LAN by default.
- **Camera reachable from the Bosch app but not from ioBroker** — the app talks via the cloud, so this proves nothing about LAN reachability.
- **External recorder cannot reach the relay** — the adapter binds the RTSP relay on the ioBroker host. Make sure your recorder VM/container can reach `stream_host:stream_port` on the LAN.

#### Quick check from the ioBroker host

```bash
nc -vz 192.168.x.y 443
curl -k -v --connect-timeout 5 https://192.168.x.y/   # alternative
```

If both time out or return "connection refused", the issue is between ioBroker and the camera (network/firewall), not the adapter.

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
    participant Cam as Camera LAN :443

    DP->>Adapter: handlePrivacyToggle / _applyLightingState
    Adapter->>Cloud: PUT /v11/.../privacy or lighting
    Cloud-->>Adapter: 5xx (cloud outage)
    Adapter->>Adapter: lan_ip known + Gen2?
    Adapter->>RCP: RCP write (0x0d00 / 0x0c22)
    RCP->>Cam: HTTPS Digest + payload
    Cam-->>Adapter: 200 OK (local fallback)
    Adapter-->>DP: update + _localWriteAt stamp
```

---

## Status

**Stable (v1.5.2)** — verified live against 4 cameras (Gen1 + Gen2, FW 7.91.56 / 9.40.102) on a real ioBroker instance. Cloud API contracts confirmed against the iOS app via mitmproxy.

What works:
- Browser-based OAuth2 PKCE login via Bosch SingleKey ID (no programmatic password handling — captcha/MFA happen in the browser)
- Token auto-refresh (~45 min cadence; 4xx → re-login required, 5xx → silent retry). Stored `refresh_token` also used at startup to mint a fresh `access_token` silently — no PKCE re-login required after restart, even if the adapter was stopped longer than the 1 h access-token lifetime.
- Camera discovery (Gen1 + Gen2, `GET /v11/video_inputs`)
- Per-camera state tree: `name`, `firmware_version`, `hardware_version`, `generation`, `online`, `privacy_enabled`, `light_enabled`, `front_light_enabled`, `wallwasher_enabled`, `image_rotation_180`, `snapshot_trigger`, `motion_trigger`, `motion_trigger_event_type`, `snapshot_path`, `stream_url`, `stream_host`, `stream_port`, `stream_path`, `last_motion_at`, `last_motion_event_type`
- Privacy toggle via Bosch Cloud API `PUT /v11/video_inputs/{id}/privacy`
- Light toggle, Gen-specific and now split into independent datapoints:
  - Gen2: `PUT /lighting/switch/front` + `/topdown`
  - Gen1: `PUT /lighting_override` (frontLightOn + wallwasherOn)
  - `front_light_enabled` and `wallwasher_enabled` can be toggled independently; `light_enabled` remains as a legacy combined switch
- Synthetic motion trigger (`motion_trigger` write-only button + `motion_trigger_event_type` selector) for external sensor integration without waiting for Bosch FCM push
- Snapshot trigger writes JPEG into the adapter file-store (`/<namespace>/cameras/<id>/snapshot.jpg`), with automatic retry on the first "stream has been aborted" hiccup that Bosch Gen2 firmware emits after idle. One startup snapshot per camera flips `cameras.<id>.online` from the default `false` to the real state immediately.
- Per-camera TLS proxy: `stream_url = rtsp://127.0.0.1:<port>/rtsp_tunnel` for use in `iobroker.cameras` or go2rtc. LOCAL-only by design — no cloud relay.
- RTSP session watchdog: LOCAL sessions renew automatically ~60 s before `maxSessionDuration` expires — 24/7 recording works without hourly stream drops
- FCM push listener (`@aracna/fcm@1.0.32` MTalk/MCS) for sub-second motion / audio-alarm / person events. `info.fcm_active` reflects state: `healthy` / `polling` / `error` / `disconnected` / `stopped`. When push registration fails the adapter falls back to `/v11/events` polling every 60 s (`info.fcm_active=polling`) — events still arrive, just with higher latency. The polling interval is configurable via the `poll_interval` setting (API requests / Power saving tab, v1.4.1+).
- Encrypted credential storage (`encryptedNative` — js-controller encrypts the refresh token at rest)
- 1166+ unit tests passing

---

## Datapoints

Per-camera datapoints under `cameras.<id>.*`:

| Datapoint | Type | Description |
|---|---|---|
| `name` | string | Camera name (from Bosch account) |
| `firmware_version` | string | Current firmware version |
| `hardware_version` | string | Hardware model string |
| `generation` | string | `Gen1` or `Gen2` |
| `online` | boolean | Camera reachable |
| `privacy_enabled` | boolean | Privacy mode on/off |
| `front_light_enabled` | boolean | Front spotlight on/off |
| `wallwasher_enabled` | boolean | RGB wallwasher on/off (Gen2 outdoor) |
| `wallwasher_color` | string | HEX `#RRGGBB`, empty = warm white mode |
| `wallwasher_brightness` | number | 0–100 |
| `image_rotation_180` | boolean | 180° image flip |
| `livestream_enabled` | boolean | Opt-in RTSP livestream switch |
| `stream_url` | string | `rtsp://user:pwd@host:port/rtsp_tunnel?inst=1&…` |
| `stream_url_sub` | string | Sub-stream URL (`inst=2`, experimental) |
| `stream_host` | string | Host part of `stream_url` — paste into iobroker.cameras "Camera IP" |
| `stream_port` | number | Port part of `stream_url` — paste into iobroker.cameras "Port" |
| `stream_path` | string | Path+query of `stream_url` — paste into iobroker.cameras "Path" (Protocol = TCP) |
| `snapshot_trigger` | button | Fetch fresh JPEG to `snapshot_path` |
| `snapshot_path` | string | File-store path for last JPEG |
| `last_event_image` | string | Base64 `data:image/jpeg;base64,…` (auto-snapshot on motion) |
| `last_event_image_at` | string | ISO 8601 timestamp of last event image |
| `motion_trigger` | boolean | Write `true` to inject a synthetic motion event |
| `motion_trigger_event_type` | string | `motion` / `person` / `audio_alarm` |
| `motion_active` | boolean | Edge-trigger: `true` for 90 s after motion, then `false` |
| `last_motion_at` | string | ISO 8601 timestamp of last motion event |
| `last_motion_event_type` | string | `motion` / `person` / `audio_alarm` |
| `pan_position` | number | Pan angle ±120° (360° Gen1 only) |
| `pan_preset` | string | Named preset: `home`, `left`, `right`, `back-left`, `back-right` |
| `siren_active` | boolean | Trigger 75 dB siren (Gen2 Indoor II) |
| `lan_reachable` | boolean | TCP-ping result against camera LAN IP |
| `lan_ip` | string | Camera LAN IP (persisted on each session open) |
| `maintenance_state` | string | `active` / `scheduled` / `none` |
| `intrusion_sensitivity` | number | DualRadar sensitivity 1–5 (Gen2) |
| `intrusion_distance` | number | DualRadar detection distance 1–8 m (Gen2) |
| `wifi_signal_pct` | number | WiFi signal strength 0–100 % |
| `mic_level` | number | Microphone recording level 0–100 |
| `speaker_level` | number | Intercom speaker volume 0–100 |
| `last_status_notification` | string | JSON: camera online/offline transition payload |
| `_proxy_port` | number | Sticky TLS proxy port (persisted across restarts) |

Adapter-wide datapoints under `info.*`:

| Datapoint | Description |
|---|---|
| `connection` | Boolean — at least one camera connected |
| `connection_status` | `logged_out` / `awaiting_login` / `connected` / `auth_error` |
| `login_url` | Bosch OAuth URL (clickable link in Admin UI) |
| `last_login_at` | ISO 8601 of last successful token mint |
| `fcm_active` | `healthy` / `polling` / `error` / `disconnected` / `stopped` |
| `maintenance.state` | `active` / `scheduled` / `past` / `recent` / `unknown` / `idle` |
| `maintenance.title` | Parsed announcement title |
| `maintenance.scheduled_start` | ISO 8601 start |
| `maintenance.scheduled_end` | ISO 8601 end |
| `maintenance.camera_relevant` | Boolean — announcement mentions cameras |
| `maintenance.last_fetched` | ISO 8601 of last successful RSS fetch |
| `maintenance.last_notification` | JSON payload for Blockly notification routing |

---

## Dashboard

A ready-to-import VIS-2 example dashboard is in
[`docs/vis-2-example/`](./docs/vis-2-example/) — all four cameras in a 2×2
grid with snapshot refresh (every 5 s), privacy + light toggles, snapshot
trigger button, and a status bar.

Quick install:

```bash
cp docs/vis-2-example/vis-views.json ~/iobroker-data/files/vis-2.0/main/
iobroker restart vis-2
```

Then open `http://HOST:8082/vis-2/index.html#Cameras` in your browser.

See [`docs/vis-2-example/README.md`](./docs/vis-2-example/README.md) for the
walkthrough, including how to swap the camera UUIDs and how to wire go2rtc /
HLS for low-latency live video instead of the default snapshot refresh.

### VIS-2 Camera widget

The adapter ships two built-in **VIS-2 widgets** (React / Module-Federation, built from `src-widgets/`) that can be dropped onto any VIS-2 view without importing a JSON file.

**Requirements:** VIS-2 adapter ≥ 2.13 installed and running.

---

#### Bosch Camera (single camera)

**How to use:**

1. Open the VIS-2 editor (`http://HOST:8082/vis-2/index.html?edit=1`).
2. In the widget panel, find the **Bosch Smart Home Camera** widget set.
3. Drag **Bosch Camera** onto your view.
4. Set **Camera datapoint** to any DP under
   `bosch-smart-home-camera.0.cameras.<UUID>` (e.g. `.name`) — the camera is
   detected automatically from the path.
5. Pick a **Stream mode** (see below).

**Stream modes:**

| Mode | What it shows | Needs | Audio |
|---|---|---|---|
| **Snapshot (near-live)** *(default)* | `<img>` polled from the adapter's snapshot HTTP server (`snapshot_url`) at a configurable interval (default 1 s) | `snapshot_http_port` set in the adapter | no |
| **MJPEG (frames)** | continuous JPEG frames from the local RTSP proxy via FFmpeg, drawn on a canvas; play button starts the stream | `livestream_enabled = true` + `ffmpeg` on the host | no |
| **go2rtc WebRTC** | low-latency live video via a native `<video>` element + WebRTC; automatic HLS fallback if ICE fails | go2rtc running with the camera's `stream_url` as source | **yes** — audio toggle + volume slider + pause-guard |

**Feature set:**
- Status badges: Online/Offline, Motion, Privacy, Connecting (pulsing), stream uptime, HLS-fallback banner, last event, maintenance banner
- Privacy state and Offline clearly separated; cloud-reconciled online status
- Tap-to-play gate (no auto-start); stream and privacy cooldown guards
- Optimistic UI: toggle buttons flip instantly, auto-revert on error
- Digital zoom (pinch/wheel) in fullscreen
- Page Visibility API: snapshot rate throttled in the background
- Motion-zone and privacy-mask SVG overlays
- Pan buttons ◀◀ ◀ ▶ ▶▶ with a position readout; only for the Gen1 360° indoor (`hardware_version==="INDOOR"`)
- Frosted-glass control bar (iOS/Android/auto theme; normal/minimal/compact layout)
- Fullscreen via a React portal (covers the whole screen)
- Picture-in-Picture (WebRTC mode): pop the live stream into the browser's floating, always-on-top window — over **all** apps on macOS Safari, over the browser on Chrome. The window title shows the camera name. Only **one** PiP window is allowed by the browser, so while one camera floats the PiP button on every other BoschCamera widget on the view greys out; it survives a stream reconnect. Hidden where the browser lacks PiP (most iOS/Android WebViews, snapshot/MJPEG modes).
- Collapsible bottom-sheet accordions for all advanced settings: notifications, advanced, Gen2 automation/security, light & camera (incl. `front_light_intensity` slider), diagnostics, zones, services
- 11 UI languages (de/en/es/fr/it/nl/pl/pt/ru/uk/zh-cn)

> **Live subtitles & translation (browser feature, no setup):** if your camera has audio, **Chrome → Settings → Accessibility → Live Caption** transcribes spoken audio in the WebRTC stream on-device in real time, and **Live Translate** can translate the captions into your language. No widget changes needed — it captions whatever audio plays in the tab (works alongside Picture-in-Picture).

**Building the widget** (for contributors): `npm run build:widget` installs `src-widgets/`, runs the Vite/Module-Federation build and copies the bundle into `widgets/bosch-smart-home-camera/`.

---

#### Bosch Camera Overview (multi-camera grid)

The **Bosch Camera Overview** widget shows every camera of an adapter instance in a responsive grid — no manual per-camera configuration.

**Configuration fields:**

| Field | Description |
|---|---|
| **Adapter instance** | e.g. `bosch-smart-home-camera.0` |
| **Columns** | Fixed column count (0 = automatic) |
| **Min. tile width** | Minimum width per tile in pixels |
| **Hide offline** | Do not show offline cameras |
| **Per-tile controls** | Privacy and light toggle directly on each tile |

**Feature set:**
- Auto-discovery of all cameras of the selected instance
- Sorting: online first, then privacy, then offline
- Click-to-expand: clicking a tile opens the camera as a BoschCamera widget in the fullscreen portal
- Same status badges as BoschCamera (Online/Offline/Motion/Privacy)

---

## Example Automations

A growing library of 20 ready-to-import scripts lives in
[`docs/examples/`](./docs/examples/) — 8 Blockly XML files for the visual editor and
12 plain JavaScript snippets side-by-side. Themes covered:

- **Master switches** — one virtual datapoint flips wallwasher / privacy
  on every camera in lock-step.
- **Motion handling** — snapshot-on-motion with notification, Hue-PIR →
  synthetic Bosch motion bridge, burst-aggregation notify, presence-driven
  privacy.
- **Light scenes** — dusk-driven auto-wallwasher, full driveway scene
  (Hue floodlight + Bosch wallwasher/frontlight),
  vacation deterrent, door-sensor light.
- **Bot / dashboard integration** — Telegram `/snap` command, last-event
  slideshow for VIS, stream-URL push to a Fully Kiosk tablet.
- **Status & safety** — camera-offline alert, FCM-push degradation
  monitor, panic-siren trigger, weather-suppressed alerts, sleep-mode
  mute, garage-door coordination, night-mode schedule.
- **Snapshot scheduler / time-lapse** —
  [`docs/examples/snapshot-blockly.md`](./docs/examples/snapshot-blockly.md):
  hourly Blockly XML + JavaScript scheduler (06:00–22:00 cron), plus a
  motion-triggered variant with 15-minute throttle. Writes
  `snapshot_trigger`, reads back `snapshot_path`. Includes an ffmpeg
  one-liner to assemble the collected JPEGs into an mp4 time-lapse.

Open javascript adapter → Scripts → new Blockly (or JavaScript) → paste.
Replace the `<CAM_UUID>` / `<PRESENCE_OID>` / lux-sensor / Telegram-bot
placeholders with your actual object IDs from the Objects tab. The
folder's [README](./docs/examples/README.md) has the full index, prerequisites,
and notification-adapter call patterns (Telegram, signal-cmb, Pushover,
email).

→ **Contribute your own**: drop a working script as a code block in the
[ioBroker forum thread](https://forum.iobroker.net/topic/84538) or open a
PR — community examples are explicitly welcome.

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

Note on **live streaming in the browser**: no browser supports RTSP natively.
The adapter publishes a per-camera `stream_url`
(`rtsp://<user>:<password>@127.0.0.1:<port>/rtsp_tunnel?…`) via a local TLS
proxy for use with ffmpeg / mpv / `iobroker.cameras` / go2rtc. For VIS
itself, either use the snapshot refresh in the example dashboard or bridge
via go2rtc → WebRTC/HLS.

### `stream_url` is empty / go2rtc says "connection refused"

The livestream is **opt-in and OFF by default** — each open session counts
against the Bosch LOCAL session quota and keeps a TLS proxy + watchdog running
24/7, so the adapter never starts it on its own. While it is off, the per-camera
proxy does not listen, `cameras.<id>.stream_url` stays empty, and any go2rtc /
recorder pointed at the port gets `connection refused`. Snapshots and motion
events work without it.

1. Set `cameras.<id>.livestream_enabled = true` (per camera). The session opens,
   the proxy starts listening, and `cameras.<id>.stream_url` is populated.
2. Copy that URL into go2rtc / `iobroker.cameras` / your recorder.
3. If go2rtc (or the recorder) runs on a **different host** than ioBroker, the
   default `127.0.0.1` bind is unreachable from there → still `connection
   refused`. Enable **Expose RTSP proxy to LAN** in the adapter settings and set
   the **External hostname / LAN IP** (see the LAN-recorder steps below); the
   URL then uses your ioBroker host's LAN IP instead of `127.0.0.1`.

---

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
  "cam_name":  "Front Door",
  "event_id":  "evt-uuid-or-empty",
  "event_type": "motion"
}
```

**Compatible consumers:** Node-RED, openHAB, Home Assistant (MQTT integration),
Frigate, Zigbee2MQTT sidecars, any standard MQTT subscriber.

**Example Node-RED subscription:**
```
bosch/cameras/<camera-id>/motion
```

Wire it to a Telegram notification, a Frigate alert, or a Home Assistant
`mqtt.sensor` — no ioBroker adapter required on the subscriber side.

---

## External Recorders (BlueIris, Frigate)

```mermaid
flowchart LR
    Cam["Bosch Camera<br/>LAN :443<br/>HTTPS only"] -->|RTSP-over-TLS<br/>tunneled| Proxy["Adapter TLS proxy<br/>port: per-camera<br/>bind: 127.0.0.1 or LAN"]
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

### Person-only recording via CodeProject AI

A workflow described on the ioBroker forum: add each `stream_url` as an RTSP camera in BlueIris,
enable 24/7 sub-stream recording with a short retention (e.g. 7 days), and
wire BlueIris's motion-detection alerts into [CodeProject AI](https://www.codeproject.com/AI/)
running YOLO. Only when CodeProject classifies a frame as a person (or
another configured class — dog, cat, vehicle, license plate, face) does
BlueIris flip to mainstream recording, with a few seconds of pre-roll. Cuts
storage and false-positive alerts dramatically while keeping the rich
mainstream footage for events that matter.

### iobroker.cameras (snapshot / Vis tile)

[iobroker.cameras](https://github.com/ioBroker/ioBroker.cameras) wraps a
generic RTSP source into JPEG snapshots and a Vis MJPEG tile (no H.264/audio —
for full live playback use this adapter's [VIS-2 Camera widget](#vis-2-camera-widget)
or go2rtc instead). It does **not** take a full `rtsp://…` URL in one field —
it builds the URL from separate fields, so the `stream_url` has to be split.

> **Recommended: turn on the always-on RTSP endpoint.** iobroker.cameras pulls
> a frame on its own schedule. By default the local RTSP proxy only listens
> while a live stream is running, so a poll that lands while the stream is off
> hits a closed port and iobroker.cameras logs `Connection refused`. Enable
> **Settings → RTSP / Stream → Keep the RTSP endpoint reachable at all times**
> (`stream_persistent_endpoint`). The adapter then keeps a listener bound on a
> stable per-camera port at all times and opens the Bosch session automatically
> when iobroker.cameras connects, releasing it again after an idle timeout — so
> the endpoint is always reachable without permanently using one of the 3 shared
> Bosch sessions. With it on, skip step&nbsp;1; `stream_url` / `stream_host` /
> `stream_port` / `stream_path` are populated and stable from adapter start.
> Forum #84538.

1. (Only needed if the always-on endpoint above is off.) Enable the stream: set
   `cameras.<id>.livestream_enabled = true`. The proxy starts and
   `cameras.<id>.stream_url` populates, e.g.
   `rtsp://127.0.0.1:8554/rtsp_tunnel?inst=1&enableaudio=1&fmtp=1&maxSessionDuration=3600`.
2. In the `cameras.0` instance add a camera, type **RTSP** (the generic
   ffmpeg-snapshot type). To save you splitting the URL by hand, the adapter
   also publishes the three parts as ready-to-paste datapoints —
   `cameras.<id>.stream_host`, `stream_port` and `stream_path`:

   | iobroker.cameras field | Copy from datapoint | Example | Notes |
   |---|---|---|---|
   | **Camera IP** | `stream_host` | `127.0.0.1` | Same host → `127.0.0.1`. LAN IP appears here automatically when **Expose RTSP proxy to LAN** is on. |
   | **Port** | `stream_port` | `8554` | Sticky across restarts. |
   | **Protocol** | *(set manually)* | **TCP** | Must be changed — the field defaults to UDP, but the proxy is TCP-only. |
   | **Path** | `stream_path` | `/rtsp_tunnel?inst=1&enableaudio=1&fmtp=1&maxSessionDuration=3600` | Query string included — copy verbatim. |
   | **Username / Password** | — | *(leave empty)* | The proxy injects Bosch Digest auth transparently; no credentials needed. |

3. Save. iobroker.cameras serves the snapshot at
   `http://<iobroker-host>:8082/cameras.0/<camera-name>` (use that URL in a Vis
   Basic-Image widget) and offers the live MJPEG tile via its bundled Vis
   widget.

Because both adapters normally run on the same ioBroker host, `127.0.0.1`
works directly — **Expose RTSP proxy to LAN** is only needed when
iobroker.cameras runs on a different machine.

---

## Development

```bash
npm install
npm run build        # tsc → build/
npm run watch        # auto-rebuild on save
npm test             # unit tests (1166 passing)
npm run lint
npm run test:coverage          # coverage report → coverage/index.html (HTML) + lcov
npm run test:coverage:check    # enforce thresholds: 80% lines/functions, 70% branches
```

### CI/CD & testing

The full pipeline — test layers (lint → unit + coverage → package validation →
CodeQL/gitleaks/dependency-review → adapter integration → repochecker → release
smoke), all GitHub Actions workflows, and the release flow — is documented with
diagrams in [`docs/ci-cd.md`](./docs/ci-cd.md). Quality standards and the
ioBroker Latest→Stable progression are in
[`docs/TESTING_AND_QUALITY.md`](./docs/TESTING_AND_QUALITY.md).

Security layer (GitHub Actions): **CodeQL** (SAST), **gitleaks** (secret scan),
**dependency-review** + **Dependabot**, with least-privilege workflow permissions.

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

---

## Existing Adapter Landscape

- **[iobroker.bshb](https://github.com/holomekc/ioBroker.bshb)** — SHC Local REST API (thermostats, switches, alarms). Camera on/off only, no stream or snapshot. Active maintainer.
- **[iobroker.cameras](https://github.com/ioBroker/ioBroker.cameras)** — generic HTTP snapshot / RTSP wrapper. Pair this adapter's `stream_url` state with iobroker.cameras to get a Vis tile — see [iobroker.cameras (snapshot / Vis tile)](#iobrokercameras-snapshot--vis-tile) for the field-by-field config.
- **[iobroker.onvif](https://github.com/iobroker-community-adapters/ioBroker.onvif)** — generic ONVIF. Bosch cameras don't currently expose a local ONVIF endpoint, so this adapter is the only path for Bosch hardware.

---

## Release Process

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

---

## Related Projects

Part of a five-implementation family for Bosch Smart Home Cameras (plus an alpha frontend):

| Implementation | Repo | Status |
|---|---|---|
| 🏆 Home Assistant Integration | [Bosch-Smart-Home-Camera-Tool-HomeAssistant](https://github.com/mosandlt/Bosch-Smart-Home-Camera-Tool-HomeAssistant) | **v14.4.1** · HA Quality Scale **Platinum** · production-ready |
| 🐍 Python CLI | [Bosch-Smart-Home-Camera-Tool-Python](https://github.com/mosandlt/Bosch-Smart-Home-Camera-Tool-Python) | **v10.10.4** · Mini-NVR + SMB upload (BETA) · LAN-fallback (ping / --local) · PTZ presets · webhook delivery · capture / research / standalone |
| 🟢 **ioBroker Adapter** (this repo) | [ioBroker.bosch-smart-home-camera](https://github.com/mosandlt/ioBroker.bosch-smart-home-camera) | **v1.7.7** · stable · npm · always-on RTSP endpoint · daily event counters · MQTT bridge · PTZ presets · VIS-2 single + overview widgets |
| 🤖 MCP Server | [Bosch-Smart-Home-Camera-Tool-MCP](https://github.com/mosandlt/Bosch-Smart-Home-Camera-Tool-MCP) | **v1.5.5** · cred-rotation · PTZ presets · TOFU cert pinning · LAN-ping + prefer_local · Claude Code / Claude Desktop integration |
| 🔴 Node-RED nodes (alpha) | [Bosch-Smart-Home-Camera-Tool-NodeRED](https://github.com/mosandlt/Bosch-Smart-Home-Camera-Tool-NodeRED) | v0.2.5-alpha · cloud nodes (event / snapshot / privacy / stream-url / config) |

Also: [Bosch Smart Home Camera — Python Frontend (NiceGUI)](https://github.com/mosandlt/Bosch-Smart-Home-Camera-Tool-Python-frontend) — v0.1.5-alpha (dashboard + camera detail + settings) — community interest welcome

HA stays the **reference implementation** — features land there first; the Python CLI, ioBroker Adapter and MCP Server catch up over time.

---

## Changelog

### 1.8.2 (2026-07-14)
Docs-only release: refreshed the sibling-repo version table in the README. No functional changes.

### 1.8.1 (2026-07-13)
Performance/reliability fix: local camera (digest auth) and cloud API HTTPS requests now reuse pooled keep-alive connections instead of opening a fresh TCP+TLS connection per request, cutting per-request latency and connection overhead. Also fixes a related agent-cleanup gap so pooled connections are properly torn down on adapter unload instead of leaking sockets. No functional/state changes.

### 1.8.0 (2026-07-11)
New: cloud-API WRITE for the management tier, closing a feature-parity gap with the HA integration and Python CLI (same `/v11` endpoints, byte-verified against both). Writable states per camera: `motion_zones_set`/`privacy_masks_set` (POST array of `{x,y,w,h}`, `[]` clears all), `rule_create`/`rule_update`/`rule_delete` (automation rules), `firmware_install` (button — installs the pending firmware update, guarded against a double-press or an already-in-progress install). Gen2 only: `camera_share`, `friend_invite`, `friend_remove`. New read-only firmware status states: `firmware_current_version`, `firmware_latest_version`, `firmware_update_available`, `firmware_updating`. This is cloud write only — the on-device RCP zone/mask editor stays parked until Bosch's permanent local user (summer 2026). Also adds a blocking `npm audit --omit=dev` CI gate ahead of the deploy job. 38 new tests, full suite 1367 → 1405 passing, coverage gate green.

### 1.7.8 (2026-07-07)
Docs-only release: repository-checker keyword fix (`package.json`/`io-package.json`, PR #46), refreshed sibling-repo version references in the "Related Projects" table, dev-sandbox Node version doc fix, devDependency bumps (`@types/node`, `@iobroker/adapter-react-v5`). No functional changes.

### 1.7.7 (2026-07-03)
ioBroker.repositories PR#5983 manual-review hardening (mcm1957, 2026-07-02): log/notification text is English-only now (was German, leaking untranslated into `this.log.*`); external camera IDs are sanitized (ioBroker `FORBIDDEN_CHARS`) before use in object paths; removed the dead `region` config option (`EU`/`US` dropdown had no effect — `CLOUD_API` is, and remains, hardcoded); README now credits/links Bosch Smart Home; minor dead-code cleanup (`_maskCreds`, `_featureFlagsCache`, `EVENT_POLL_INTERVAL_MS`). `mqtt_password` `protectedNative`/`encryptedNative` confirmed correct at the io-package.json root (already in place; a first attempt moved them under `common`, which `@iobroker/repochecker`'s schema rejects — reverted before release). New regression tests pin all of the above. No functional/behavioral change for existing installs beyond the language fix.

### 1.7.6 (2026-06-28)
CI: integration test harness (@iobroker/testing), build job, Node 22/24 matrix, coverage gate (≥80%), i18n E5606 gate. No functional changes.

### 1.7.5 (2026-06-25)
Cross-version port of Home Assistant v13.7.8–v13.7.9 WebRTC stability fixes.

- **Stale-PC guard (fix):** after a WebRTC reconnect, late `mute` events from the old peer connection no longer trigger a new recovery — ending an endless loop where every reconnect caused another one.
- **getStats freeze oracle (fix):** the player now checks `framesDecoded` via `getStats` every 5 s to catch a go2rtc silent stall or a Chrome 145 muted-background-pause that the existing frame-callback / stall timer may not see.
- **Dead-track CGNAT detection → sticky HLS (fix):** when WebRTC connects but delivers zero decoded frames (bytes flowing = decoder stall; no bytes = CGNAT cut), the player escalates to HLS for the rest of the session instead of retrying WebRTC in an endless loop.
- **iOS native-HLS 8s watchdog (fix):** Safari/iOS AVPlayer can hang at load with no self-recovery; a watchdog hard-reloads the element if `playing` does not fire within 8 s.
- **Faster reconnect (improvement):** recovery restart delay reduced from 2000 ms to 1000 ms.

### 1.7.4 (2026-06-23)
FCM push reliability: periodic 24 h re-registration prevents silent push loss on long-lived sessions.

### 1.7.3 (2026-06-21)
Cross-version port of the Home Assistant v13.7.5 fix.

- **Picture-in-Picture freeze in a background tab (fix):** follow-up to 1.7.2. With the live stream floating in Picture-in-Picture and the browser tab left in the background, the floating window could still freeze for up to a minute before recovering, because Chrome throttles the player's periodic freeze-check timer to about once a minute in a hidden tab. The player now drives that check from a Web Worker, which runs on a separate thread Chrome does not throttle, so a frozen Picture-in-Picture stream is detected and reconnected in about ten seconds instead of up to a minute. The worker only acts on a Picture-in-Picture window you are actively watching (a plain hidden tab is left alone to conserve the camera session) and falls back cleanly to the existing timer where Web Workers are unavailable. Also hardens the freeze check so a slow reconnect's first frame can't briefly look frozen.

### 1.7.2 (2026-06-19)
Cross-version port of the Home Assistant v13.7.4 fix.

- **Picture-in-Picture freeze after a tab switch (fix):** with the live WebRTC stream floating in Picture-in-Picture (vis-2 widget overlay), switching to another browser tab for a while could freeze the floating window; returning to the tab resumed the in-page video but the floating window stayed frozen. A hidden tab heavily throttles the player's periodic stall check, and the underlying go2rtc WebRTC stream can quietly die in the background. The player now detects a freeze without that throttled timer — it watches for presented video frames (which keep flowing to a Picture-in-Picture window even while the tab is hidden) and listens for the WebRTC track going silent or the connection failing, then reconnects into the **same** floating window automatically with no interaction. The reconnect reuses the existing video element so Picture-in-Picture picks the stream straight back up.

### 1.7.1 (2026-06-18)
- **Daily counters now bucket by local date (fix):** `events_today`, `movement_count` and `audio_count` were bucketed by UTC day, but Bosch event timestamps carry an explicit timezone offset (e.g. `+02:00[Europe/Berlin]`) — so events in the hours around local midnight were counted on the wrong day and the counters rolled over at UTC midnight instead of local midnight. They now bucket by each event's local calendar date, matching the Home Assistant integration (issue #34). `last_motion_at` and event freshness were already correct.

### 1.7.0 (2026-06-18)
Cross-version round porting the latest Home Assistant integration features and fixes.

- **Daily event counters (new):** per-camera `events_today`, `movement_count` and `audio_count` datapoints, derived from the cloud event list and bucketed by **UTC** day (mirrors the HA sensors; UTC avoids the mis-count around local midnight). Refreshed on every poll so they roll over at UTC midnight without needing a new event.
- **BoschOverview widget — live stream + status:** the expanded (click-to-enlarge) overlay now plays live **WebRTC/HLS** via go2rtc (grid tiles stay snapshot so the camera's ~3-session limit is respected), with a snapshot fallback on stream error. Added a cloud **maintenance banner** above the grid and a **last-event timestamp** badge per tile.
- **Widget reliability:** per-camera volume/mute localStorage keys (multiple cameras no longer overwrite each other's volume); a second tile of the *same* camera auto-mutes the first (different cameras stay independent); offline/privacy tiles now show the last good frame as a dimmed backdrop instead of a black box.
- **Backend fixes:** concurrent snapshot triggers for the same camera are coalesced onto one session/fetch (no double-open); a camera stays online during an active cloud-maintenance window while it is still locally streaming, instead of being flipped offline by the maintenance-related snapshot failures.

### 1.6.1 (2026-06-16)
- **FCM push reliability:** the motion-event safety-net poll is no longer suppressed after a failed cloud fetch. A transient cloud hiccup during a push used to stamp the defer-timestamp *before* the fetch succeeded, keeping the safety poll quiet for up to 5 minutes and delaying motion detection. The defer-timestamp now advances only after a definitive response (+3 regression tests). Cross-version of the Home Assistant integration's event-poll fix.

### 1.6.0 (2026-06-15)
Cross-platform reliability round for the BoschCamera VIS-2 widget and the adapter, driven by a structured bug-hunt (Chrome, Safari, Firefox, Edge on macOS, Windows, iOS, Android, Linux).

- **iOS Picture-in-Picture** now works: the widget falls back to the WebKit presentation-mode API where the standard PiP API is unavailable, and leaves PiP correctly when the stream stops.
- **Touch-friendly volume:** the volume control is reachable by tap (it was hover-only); audio recovers after the browser/AudioContext is interrupted by Android backgrounding or doze.
- **Reconnect fixes:** a Picture-in-Picture listener leak on re-start is fixed, a conflicting `muted` prop no longer fights the imperative mute control, and the control pill-bar scrolls instead of clipping on narrow screens.
- **Adapter robustness:** the motion-event safety-net poll now survives an FCM push reconnect (it could previously be cancelled and never re-armed, freezing motion timestamps), and several shutdown-time timer warnings were eliminated.

### 1.5.7 (2026-06-15)
Cross-version parity with the Home Assistant card v13.5.17 — live-stream reliability + quieter controls for the BoschCamera VIS-2 widget.

- **Live sound survives an auto-reconnect:** the stream no longer comes back muted after a stall / HLS-fallback / session refresh (the shared AudioContext keeps the unmute intent across reconnect; the pause-guard remains the safety net).
- **Tab-switch & bfcache recovery:** the live (WebRTC) stream now restarts when the page returns to the foreground or is restored from the browser's back/forward cache (`pageshow`/`visibilitychange`), instead of staying frozen.
- **Quieter controls:** the audio and Picture-in-Picture buttons appear only while a live stream is playing (hidden over an idle/snapshot tile). Card corners no longer flicker on re-composite (`isolation: isolate`).
- **WebRTC robustness:** ICE `disconnected` is treated as transient (only `failed` falls back to HLS, no more premature downgrade); audio/video tracks are accumulated into one MediaStream (no srcObject re-assign flash); a leaked `playing`/`pause` listener on WebRTC→HLS fallback is fixed; a light stall-checker re-plays a live `<video>` the browser paused in the background.
- **Maintenance banner** is dismissable with an × (per browser session). **Privacy placeholder** now shows the last-event time.

### 1.5.6 (2026-06-14)
Picture-in-Picture for the VIS-2 camera widget (live WebRTC view).

- **Picture-in-Picture:** a new button in the BoschCamera widget's control bar floats the live WebRTC stream into the browser's always-on-top window — over every app on macOS Safari, over the browser on Chrome. The floating window's title shows the camera name (via the Media Session API).
- **Single-PiP greying:** the browser allows only one PiP window at a time, so while one camera is floating, the PiP button on every other BoschCamera widget on the view greys out; it lights up on the active one and re-enables for all when PiP closes.
- The window keeps playing across a stream reconnect, and the button is hidden where the browser lacks PiP support (most iOS/Android WebViews; snapshot/MJPEG modes). New tooltip strings added in all 11 UI languages.

### 1.5.5 (2026-06-13)
Settings-page reorganisation, German translation polish and concurrency hardening for the always-on RTSP endpoint.

- **Settings page reorganised into tabs:** Connection · RTSP / Stream · Events / Notifications · API requests / Power saving · MQTT Bridge. The always-on RTSP endpoint option (`stream_persistent_endpoint`, still opt-in / default off) moved from the *Power saving* tab to **RTSP / Stream**, next to the other external-recorder settings (LAN exposure, external host, max session duration) where it belongs.
- **German translations polished:** the stream-settings labels/help that shipped machine-translated in v1.5.4 (e.g. *"Freigabesitzung nach Leerlauf(en)"*) are now natural German.
- **Concurrency hardening:** two recorders connecting to the same camera's always-on endpoint at the exact same moment now share a single `ensureLiveSession` instead of racing to open two Bosch sessions (one of the 3 shared slots could previously be wasted). +15 regression tests.

### 1.5.4 (2026-06-13)
New: optional always-on RTSP endpoint for external recorders (iobroker.cameras, BlueIris, Frigate).

- **Always-on RTSP endpoint (`stream_persistent_endpoint`, opt-in, default off):** the local RTSP proxy previously listened only while a live stream was running. An external recorder such as iobroker.cameras polls the RTSP URL on its own schedule, so a poll that landed while the stream was off hit a closed port and the recorder logged `Connection refused` (forum #84538). When the new option is enabled (Settings → RTSP / Stream), the adapter keeps a lightweight TCP listener bound on a stable per-camera port at all times. The Bosch session + TLS proxy are opened on demand the moment a recorder connects and released again after `stream_persistent_idle_timeout` seconds (default 60 s) with no client — so the endpoint is always reachable without permanently occupying one of the 3 shared Bosch sessions. `stream_url` / `stream_host` / `stream_port` / `stream_path` stay populated and stable from adapter start. A live stream the user explicitly enabled (`livestream_enabled = true`) is never auto-released.

### 1.5.3 (2026-06-12)
Fix: Bosch cloud connection failed to start after the v1.5.1 TLS hardening.

- **Cloud TLS partial-chain fix:** v1.5.1 pinned only the Bosch "Video CA 2A" intermediate certificate. Node.js (unlike the Python/HA integrations) has no equivalent of OpenSSL's `PARTIAL_CHAIN` flag, so it could not anchor the certificate chain at the pinned intermediate and every Bosch cloud handshake failed with `unable to get issuer certificate`. On systems without a valid persisted camera state this blocked camera discovery on startup ("No persisted camera state found — cannot start"). The adapter now verifies cloud certificates by checking the hostname, validity and that the leaf is either signed by the pinned Bosch CA or chains to a trusted system root (used by the Let's Encrypt OAuth host). MITM protection from v1.5.1 is fully preserved — self-signed, expired, hostname-mismatch and untrusted-root certificates are still rejected.

### 1.5.2 (2026-06-11)
Automatic cleanup of orphaned camera object subtrees.

- **Orphaned camera objects pruned on start:** removing a camera from the Bosch account previously left behind a `cameras.<uuid>` object subtree in ioBroker with no way to clean it up without manual object deletion. The adapter now detects these orphaned subtrees on each successful camera fetch and removes them automatically. A safety guard prevents any deletion when the cloud fetch returns an empty list (e.g. during a cloud outage), so no active camera data is lost.

### 1.5.1 (2026-06-11)
Security: TLS certificate verification for Bosch cloud and proxy connections.

- **TLS certificate verification (CWE-295):** the cloud API calls and the video proxy tunnel now validate the private Bosch CA instead of accepting any certificate, closing a potential MITM gap for OAuth tokens on the local network. Local camera endpoints are not affected.

### 1.5.0 (2026-06-10)
Fixes motion silently freezing, plus a configurable stream session length and an opt-in idle-stream reaper.

- **Fix — motion / snapshots no longer silently freeze after a while** (forum #84538): the cameras kept detecting motion in the Bosch app, but `last_motion_at` / `last_event_image_at` stopped updating and only an adapter restart brought them back. Root cause: the FCM push library does not surface a raw TCP socket death (its health check stays "connected"), and event polling was only ever started when FCM *failed at startup* — so a silently-dead push connection left motion frozen indefinitely. Like Home Assistant, the adapter now runs an always-on safety-net event poll: it fetches events roughly every 5 minutes while FCM looks healthy, and every poll interval once FCM is known to be down, so motion is never missed for longer than the safety window regardless of FCM.
- **New setting — stream `maxSessionDuration`** (RTSP / Stream tab, `0` = camera default, range 600–21600 s): a continuous go2rtc / recorder pull could drop with a timeout at the camera's 3600 s session boundary before the adapter's renewed session took over. Raise this (e.g. 5000) to keep the stream running longer between renewals, without editing the URL by hand.
- **New setting — turn off unwatched live streams** (API requests / Power saving tab, opt-in, default off, experimental): an enabled live stream keeps occupying one of the 3 shared Bosch sessions even when nobody is watching. When enabled, the adapter reads how many clients are actually pulling the local RTSP proxy and, after the configured idle timeout with none, turns the live stream off to free the session. A stream that something is really watching is never stopped.
- **New settings — diagnostic polling** (API requests / Power saving tab): a *Poll diagnostic datapoints* switch (default on) and a separate *Diagnostic poll interval* (default 300 s, range 60–7200 s). The rarely-changing diagnostics — motion zones, light/ambient config, alarm settings, ONVIF/RCP info and cloud feature flags — can now be slowed down or turned off entirely to cut cloud requests, independently of the main poll interval. The core states (online, privacy, motion, snapshots, light, livestream) are unaffected.
- **Quieter log:** the RTSP Digest-rotation `401` (expected, self-healing churn when Bosch rotates the stream credentials and the client reconnects) is now logged at debug instead of warn.

### 1.4.1 (2026-06-10)
Options to reduce load on the shared Bosch session limit, plus dependency updates.

- **New "API requests / Power saving" settings tab.** Your cameras share a hard limit of only 3 simultaneous Bosch sessions across the Bosch app, Home Assistant, this adapter and any recorder, and the cloud is polled per camera — the new options let you cut that load. Request-heavy options are off by default on a fresh install; motion, manual snapshots and on-demand live streams keep working regardless.
- **`startup_snapshot` (default off):** the adapter no longer opens a Bosch session per camera at start just to learn the online state. Online/offline is now resolved the cheap, session-less way (a LAN TCP ping, falling back to the cloud `/ping` and `/commissioned` checks). Turn it on to fetch a real boot image per camera.
- **`poll_interval` (default 60 s, range 30–3600 s):** configurable cloud poll cadence. Each tick is several cloud requests per camera, so raising it reduces request volume roughly proportionally; motion push (FCM) stays near-instant.
- **Widget "Auto-refresh indoor snapshot" (default off):** the indoor snapshot pulse (360° every 5 s, Gen2 indoor every 10 s) is now opt-in per widget, so a dashboard tile no longer repeatedly opens a Bosch session unless you ask it to.
- **Dependencies:** `axios` 1.16.1 → 1.17.0 (security hardening) and `@aracna/core` 1.4.4 → 1.5.0 (matches the `@aracna/fcm` peer requirement).

### 1.4.0 (2026-06-10)
A second multi-camera widget, the single-camera card brought to Home Assistant parity, and two tile fixes.

- **New "Bosch Camera Overview" VIS-2 widget:** a multi-camera grid that discovers every camera automatically, sorts them into online / privacy / offline tiers, shows a snapshot and per-tile quick controls, and expands a tile to the full card on click.
- **Single-camera card brought to Home Assistant parity:** the WebRTC iframe is replaced by a native `<video>` element (go2rtc `RTCPeerConnection` with an HLS fallback), which adds an audio toggle, a volume slider, a pause-guard and digital zoom. The full control set is now reachable through a catalog-driven bottom-sheet (gear button) instead of a fixed list, with model-gated pan, motion-zone/privacy-mask overlays and status badges.
- **Privacy cameras now report `online` correctly:** a reachable camera in privacy mode no longer shows as offline. The state is reconciled from the cloud (LAN-TCP → ping → commissioned) so the tile shows "Online" / a privacy placeholder instead of a false "Offline".
- **Fix — no broken-image flash when leaving privacy mode:** turning privacy off briefly showed the browser's broken-image glyph before the first frame loaded. A loading veil now covers the snapshot until a real frame arrives, and the image is refetched immediately on the privacy reveal.
- **Fix — indoor tiles auto-refresh their snapshot:** the cached snapshot only updated on motion, so a panning or busy indoor camera looked frozen. Indoor tiles now pull a fresh snapshot while visible (Gen1 360° every 5 s, the indoor model every 10 s); outdoor cameras are unchanged.

### 1.3.0 (2026-06-08)
New VIS-2 camera widget (React) with live video, plus a livestream-stability fix.

- **New VIS-2 "Bosch Camera" widget (React / Module Federation):** drop it on any VIS-2 view. Three stream modes — **snapshot** (near-live image), **live MJPEG** (started by the play button, streamed from the local RTSP proxy), and **go2rtc WebRTC** (low-latency + audio). iOS/Android-style frosted control bar with privacy, livestream, light, snapshot, pan and siren buttons; actions are gated while privacy is on (only the privacy toggle and fullscreen stay active). Pan is shown only on the Gen1 360° indoor. Fullscreen renders via a portal so it always covers the whole screen, and offline cameras get a clear "Offline" state.
- **Fix:** the RTSP proxy is no longer torn down ~60 s after start when the livestream is enabled during a snapshot (a race armed the snapshot idle-teardown with a stale flag), so VLC/recorders/the widget no longer get "connection refused".

### 1.2.7 (2026-06-07)
Easier integration with the ioBroker.cameras adapter.

- **New per-camera datapoints `stream_host`, `stream_port`, `stream_path`:** the live-stream URL is now also published as three separate read-only fields. The generic RTSP camera type in the [ioBroker.cameras](https://github.com/ioBroker/ioBroker.cameras) adapter has no single full-URL input, so these can be pasted field by field without splitting `stream_url` by hand (forum request). They are populated alongside `stream_url` on stream start and cleared on teardown and on privacy-driven credential rotation.
- **README:** added an "External recorders → ioBroker.cameras" how-to with the field-by-field mapping (set Protocol to TCP — the proxy is TCP-only).

### 1.2.6 (2026-06-07)
Object-structure roles corrected for the ioBroker repository review.

- **Invalid `common.role` values fixed (repochecker object-structure check E1008/E1009):** status states (`info.fcm_active`, `info.connection_status`, `info.maintenance.state`) now use `info.status`; ISO-8601 timestamp states (`last_motion_at`, `last_event_image_at`, …) use `date` instead of `value.time` (which only allows `number`); writable string selects (`stream_quality`, `motion_sensitivity`, `detection_mode`) use `text` instead of the non-catalogue `level.mode`; JSON diagnostics (`onvif_scopes`, `cloud.feature_flags`) use `json`; the WiFi signal percentage uses `value`; the pan angle uses `level`; the string event id (`last_seen_event_id`) uses `text` instead of `value`.
- **Automatic one-time migration:** on first start of 1.2.6 existing installations have these roles rewritten in place (idempotent), so no manual object cleanup is needed.

### 1.2.5 (2026-06-04)
Stream setup is easier to discover.

- **Empty `stream_url` / go2rtc "connection refused":** the livestream is opt-in and OFF by default, so on a fresh install `stream_url` stays empty and a go2rtc / recorder pointed at the not-yet-listening proxy port gets `connection refused`, with nothing to signal why (forum #84538). The adapter now logs a one-time, actionable hint at startup while no camera streams (set `cameras.<id>.livestream_enabled=true`; enable "Expose RTSP proxy to LAN" if go2rtc runs on another host), the `stream_url` datapoint name states it stays empty until `livestream_enabled=true`, and the README has a new troubleshooting section. No behaviour change — streaming was always opt-in.

### 1.2.4 (2026-06-04)
Adapter icon fix.

- **Adapter icon:** the admin icon was a solid blue placeholder; replaced it with the real red Bosch camera logo (the blue tile had shown in the ioBroker admin and in the adapter catalogue).

### 1.2.3 (2026-06-04)
Session-quota log noise + snapshot retry hardening.

- **HTTP 444 session-quota:** when a camera shares Bosch's hard 3-session limit with the mobile app or another integration (Home Assistant / Python CLI), a 444 recurs every 60 s. The handler now warns **once per 5-minute window** (subsequent hits at `debug`), fires the "close other clients" advisory only when first crossing the threshold, and **caps the auto-retry loop at 5 attempts** — after that it logs a single info line and resumes on the next motion event / manual snapshot instead of looping forever.
- **Snapshot after motion:** the `snap.jpg` retry now does up to 2 attempts with increasing backoff (0.8 s, 1.6 s) instead of one, so an empty/aborted image in the first moment after a motion trigger (camera still warming the stream) no longer fails.

### 1.2.2 (2026-06-04)
Log-noise cleanup + Home Assistant polling parity.

- **Privacy HTTP 442:** the per-camera motion-config poll returned `442` (privacy mode / settings frozen) on every slow-tier tick for a camera in privacy mode, and logged a `Motion config poll failed` line each time. `442` is now treated like `443` — a benign "keep last value" skip, no log.
- **MJPEG fast-path:** soft FFmpeg failures (non-zero exit / empty / non-JPEG output — all of which fall back to `snap.jpg`) dropped from `warn` to `debug`, and the MJPEG path is now disabled for a camera after 2 consecutive failures this session (no more FFmpeg spawn + fallback on every snapshot for cameras whose RTSP sub-stream rejects it).
- **First-snapshot abort:** the expected Bosch "stream has been aborted" on the first `snap.jpg` after idle is now logged at `silly` (it always retries).
- **Empty snapshot after motion:** an empty `snap.jpg` body right after a motion trigger (camera still warming the stream) is now retried instead of failing.
- **Shutdown:** timers no longer re-arm during `onUnload`, removing the `setTimeout called, but adapter is shutting down` warnings.
- **Polling interval:** the event-poll fallback and the camera-state base tick are now 60 s (was 30 s), matching the Home Assistant integration's default `scan_interval`; the slow diagnostic tier still lands at 300 s.

### 1.2.1 (2026-06-04)
FCM push fix.

Push registration failed with `HTTP 401 UNAUTHENTICATED` at the Google FCM Registrations API, so the adapter fell back to event polling every 30 s. Cause: the web-push registration sent the well-known default Chrome VAPID key as `applicationPubKey`, which Google rejects — the registration token used to receive Bosch push was therefore never issued. Fixed by omitting the default VAPID (`applicationPubKey: null`), matching the Home Assistant / Python client. Push now registers reliably and motion/person/audio events arrive instantly instead of with up to 30 s delay.

Also added a self-heal: when persisted FCM credentials are rejected by Google on start, the adapter retries once with a fresh registration before falling back to polling.

Offline-camera handling: an offline camera can never serve a stream, so the first live-session attempt hit Bosch's shared session quota (`HTTP 444`) and the adapter then retried every 60 s forever, spamming the log and burning the 3-session budget shared with the Bosch App / other integrations. The 444 handler now confirms the camera's status with a session-less probe (LAN ping, then cloud `/ping` / `/commissioned`, mirroring Home Assistant); a genuinely offline camera is marked `online=false` and the retry loop stops, while a real quota contention on an online camera still retries.

### 1.2.0 (2026-06-03)
Management-tier read-only datapoints (Home Assistant parity).

New per-camera datapoints under `cameras.<id>` (all read-only):
- **Motion zones:** `motion_zones` (raw JSON array of `{x,y,w,h}`) + `motion_zones_count`.
- **Privacy masks:** `privacy_masks` (raw JSON) + `privacy_masks_count`.
- **Automation rules:** `rules` (raw JSON array of `{id,name,isActive,startTime,endTime,weekdays}`) + `rules_count`.
- **Floodlight schedule (Gen1 only):** `lighting_schedule_status` (the `scheduleStatus` mode) + `lighting_schedule` (raw JSON from `lighting_options`). Gen2 already exposes `ambient_light_schedule` via `/lighting/ambient`.
- **Friend sharing (Gen2 only):** `shared_with_friends` (raw JSON array) + `shared_with_friends_count`. Gen1 cameras do not expose this endpoint.

These are polled on the slow tier (~every 300 s) and are best-effort: HTTP 404/442/443/444 keep the last-known value and never raise. The matching write paths (zone/rule/share editing) are intentionally not wired yet.

Internal: global `eslint .` is now clean (widgets linted against real browser/VIS globals instead of being ignored).

### 1.1.0 (2026-06-02)
Feature + hardening release.

New features (Home Assistant parity + ioBroker-native):
- **Local HTTP snapshot server** (`snapshot_http_port`, role `url.cam`) so VIS image widgets / the type-detector can load the latest JPEG per camera, plus a `sendTo("bosch-smart-home-camera.0", "snapshot", {camId|name})` command returning the JPEG as buffer/base64 for Telegram/Signal/Pushover.
- **Push notifications:** global on/off (`notifications_enabled`) and six per-type toggles (`notify_movement` / `_person` / `_audio` / `_trouble` / `_camera_alarm` / `_trouble_email`).
- **Motion:** `motion_enabled` on/off + `motion_sensitivity` select; `detection_mode` select (Gen2: all_motions / only_humans / zones); `record_sound`.
- **Gen2 Indoor II alarm system:** `alarm_arm`, `alarm_mode`, `pre_alarm` switches + `alarm_state` sensor.
- **LEDs / overlay:** `status_led` (Gen2), `timestamp_overlay`, `power_led_brightness` (Gen2 Indoor); **Gen2 Outdoor lighting:** `motion_light_enabled` + `motion_light_sensitivity`, `ambient_light_enabled` + `ambient_light_schedule` sensor.
- `intercom_enabled` two-way audio (Gen2); `commissioned` status sensor; all new admin strings translated into 11 languages.

Stability fixes (several mirrored from the Home Assistant integration):
- FCM push no longer dies permanently after the hourly token refresh (the listener's bearer token is now kept current).
- Stream session-renewal hardening: a stream torn down during a renewal can no longer be resurrected (generation guard), emergency/on-demand sessions get a proper start time, and an external privacy toggle now stops the watchdog so no Bosch session leaks.
- Snapshot HTTP server closes cleanly on unload (keep-alive clients), the cached frame is published before the path so reactive consumers don't 404, and a 444 session-quota retry now reschedules instead of getting stuck.
- A CBS push-registration failure now falls back to event polling instead of leaving the adapter without any event source; Digest auth sends `cnonce` only when `qop` is present (RFC 7616); the duplicate-event guard now covers both the push and the polling path.

Internal: `npm run test:fast` (parallel mocha) for ~5× faster local runs; ~28 new regression tests (full suite 1092 passing).

### 1.0.5 (2026-06-01)
- `intrusion_sensitivity` now acknowledges the clamped 0-7 value instead of the raw input (mirroring `intrusion_distance`, fixed in 1.0.3), so the datapoint never shows a sensitivity the camera did not actually receive.

### 1.0.4 (2026-05-31)
Internal hardening release, no functional changes:
- All polling and watchdog timers (event poll, state poll, maintenance poll, session-renewal, LAN ping, snapshot retry) are now created through the adapter-core `setInterval` / `setTimeout`, so the adapter core cancels them automatically on unload — no orphaned timers outliving `onUnload`. HTTP fetch timeouts now use `AbortSignal.timeout()`.
- New CI security layer: CodeQL static analysis (Python and JavaScript/TypeScript), gitleaks full-history secret scanning, and a dependency-review gate, plus least-privilege `permissions` on every workflow and a `docs/ci-cd.md` pipeline document.
- README restructured to match the Home Assistant project layout; copyright line switched to ASCII `(c)` (repository-checker E6033).

### 1.0.3 (2026-05-29)
Write-path fixes (cross-version with the Home Assistant integration and Python CLI), live-verified on the dev sandbox against firmware 9.40.102:
- **Intrusion detection distance** now clamps to 1–8 m. The camera rejects values above 8 with HTTP 400, so writing `intrusion_distance` = 9 or 10 previously failed with `Failed to handle intrusion_distance … status code 400`. The datapoint maximum, label and acked value now all reflect the 1–8 range.
- **Intercom audio levels** are written as the full `{audioEnabled, microphoneLevel, speakerLevel}` body (read-merge-write). Setting `speaker_level` no longer silently wipes `microphone_level`.
- **Pan** acks the clamped angle that was actually written instead of the raw user value, and a busy camera (HTTP 444, too many simultaneous live sessions) is now reported as a session-quota warning instead of a hard error.

### 1.0.2 (2026-05-29)
Removed the `@aracna/fcm` registration log noise: the library no longer prints raw `postAcgRegister` / `PHONE_REGISTRATION_ERROR` lines to the ioBroker log on every push-registration attempt — its internal loggers (which run through `@aracna/core`'s `Logger`) are disabled at import. FCM health is still reported via `info.fcm_active`. As a side effect this references `@aracna/core` explicitly in source, satisfying repository-checker W5060. No functional changes.

### 1.0.1 (2026-05-29)
Repository-checker compliance hotfix: news entries translated into all 11 languages (E1054); current version listed in the README changelog (E6006); changelog consolidated into the README, with old entries archived in `CHANGELOG_OLD.md` (W6017/W6018/W6020); prettier config added (W0076); admin and vis-widget i18n completed for all 11 languages and migrated to the short `{lang}.json` format (W5612/W5603/S5601); obsolete eslint devDependencies dropped (W0078); dependencies refreshed — axios, axios-cookiejar-support, typescript, c8, eslint — and a `@tsconfig/node22` base added (W0083/S0085/S0088). No functional changes.

### 1.0.0 (2026-05-28)
Out of beta. v0.9.0 features — `privacy_sound_enabled`, `autofollow_enabled` (360° cameras), `unread_events_count` + `mark_all_read` button, `last_seen_event_id` persisted across restarts — plus v0.9.1 follow-up fixes: 442-unsupported-feature cache (no warn-storm for the Outdoor privacy_sound poll), unread count sourced from `GET /v11/events` (the listing's `numberOfUnreadEvents` field proved unreliable), and exponential backoff (30→300 s) on WiFi / autofollow / privacy-sound polls returning HTTP 444.

### 0.8.0 (2026-05-25)
HA-feature parity wave — ONVIF Scopes, RCP version, cloud feature flags, MJPEG inst=3 snapshot, 444 session-quota proper sensor state. Repochecker bot preflight added (E1032 news count ≤ 7, E1105 visWidgets components, E0028 Node ≥ 22). Engines bumped to Node 22 LTS; matrix `[22.x, 24.x]`. `@types/node` pinned to `^22.0.0` (Dependabot major-version ignore added).

### 0.7.15 (2026-05-24)
Hotfix — `upsertState` cache / DB divergence.

- **Symptom**: sandbox running v0.7.14 showed `privacy_enabled = True ack=True ts=16:10 UTC` while the state-poll loop kept logging `State poll: privacy ON → OFF (from cloud)` every 30 s. The DP `ts` stayed frozen for 4+ hours despite each poll calling `upsertState` with a new value.
- **Root cause**: `upsertState` set the in-memory `_stateCache` BEFORE awaiting `setStateAsync`. If the DB write failed or rejected for any reason, the cache held the new value while the DB still held the old one. From that point on every subsequent `upsertState` call hit the cache short-circuit (`_stateCache.get(id) === value` → return early) and silently skipped the write — the DP was frozen on the stale DB value for the rest of the adapter's lifetime.
- **Fix**: await `setStateAsync` first; only update `_stateCache` after a successful write. A failed write leaves the cache at the old value, so the next call retries instead of skipping.
- **+4 pinned tests** in `main_upsertstate_cache_divergence.spec.ts` covering: successful write updates cache; throwing write leaves cache untouched + next call retries; repeated identical writes still short-circuit; recovery after multiple transient failures. Full suite: **614 passing / 0 failing / 4 pending**.

### 0.7.14 (2026-05-24)
Live-audit pass on the Indoor II camera surfaced eight latent bugs in the data plane, all fixed in one round.

- **`wifi_signal_pct` stuck at 0**: the `wifiinfo` endpoint returns `signalStrength` as a percent (0–100), not dBm — verified live against firmware 9.40.102. v0.7.7 had assumed dBm semantics and looked for a `signalStrengthPercentage` field that does not exist. The percent now maps to `wifi_signal_pct` directly.
- **`wifi_signal_strength` DP retired**: it was labelled "dBm" but always received percent values from v0.7.7 onward. v0.7.14 migration removes the DP from existing instances so users don't see two contradictory readings.
- **`trouble_disconnect` no longer classified as motion**: pre-v0.7.14 the `fetchAndProcessEvents` polling fallback wrote every cloud event — including connectivity status events (`trouble_disconnect`, `trouble_reconnect`) — into `last_motion_at` / `last_motion_event_type` and flipped `motion_active=true`. v0.7.14 limits motion DPs to an allowlist (`motion`, `person`, `audio_alarm`); status events are info-logged and skipped.
- **Stale events no longer replay on every restart**: `_lastSeenEventId` is in-memory only, so after each adapter restart the newest cached cloud event was re-processed — including four-week-old `trouble_disconnect` events from offline Gen1 cameras. Side effects (motion_active flip, auto-snapshot, MQTT publish) are now skipped for events older than 15 minutes; `last_motion_at` still updates as a historical "last motion seen" record.
- **`lan_reachable` refreshes per poll**: pre-v0.7.14 the TCP-ping only fired during cloud outages, so `lan_reachable` stayed at its `false` default during normal operation. v0.7.14 fires a fire-and-forget per-camera TCP-ping inside every `_pollSingleCameraState` tick (no impact on poll latency).
- **`online` flips true under privacy mode**: the snapshot-based reachability check fails when the camera is in privacy mode, so `online` stayed at the default `false` even when the camera was clearly alive (TCP-pings succeed, cloud state syncs). v0.7.14 also flips `online=true` whenever the new periodic TCP-ping succeeds.
- **Intrusion DPs mirror real cloud values**: `intrusion_sensitivity` and `intrusion_distance` were never read from `/intrusionDetectionConfig` — they showed only the DP defaults (3, 5). New `_pollIntrusionConfig` runs in every Gen2 state poll, caches the full body, and mirrors `sensitivity` + `distance` to the DPs.
- **Intrusion writes succeed**: Bosch's `intrusionDetectionConfig` endpoint rejects DELTA PUTs with HTTP 400 — pre-v0.7.14 sent `{sensitivity: N}` or `{detectionDistance: N}`. v0.7.14 reads the full config from the write-cache (or fetches it on first write), merges the user's change, and PUTs the full body. Also: the `distance` field is named `distance`, not `detectionDistance`. Verified live with `{"enabled":true,"sensitivity":4,"detectionMode":"ALL_MOTIONS","distance":8}` → HTTP 204.
- **HTTP 443 surfaces clearly**: Bosch returns 443 ("non-standard") on every config-write while the camera is in privacy mode. HA already maps this to a `privacy_blocked` error; v0.7.14 mirrors that and throws "cam is in privacy mode, disable privacy first" instead of a generic axios error.

Tests: existing pinned tests in `main_audio_intrusion_wifi.spec.ts` updated for the GET→PUT-full-body sequence and the new percent mapping; `main.spec.ts` polling-fallback test uses a fresh timestamp to exercise the post-stale-filter path. Full suite: **610 passing / 0 failing / 4 pending**.

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
- **+9 tests** in `test/unit/main_cloud_503_handling.spec.ts` (all passing).

### 0.7.9 (2026-05-20)
MQTT Bridge.

- **MQTT Bridge** (`src/lib/mqtt_bridge.ts`): optional publisher that connects to any MQTT broker on adapter ready and publishes `motion` / `person` / `audio_alarm` events as JSON payloads under configurable topic prefixes. Supports plain MQTT and TLS (`mqtts://`), optional username/password auth. Wired into all three event paths: FCM push, polling fallback, synthetic triggers.
- **Admin UI tab "MQTT Bridge"**: 6 config fields — enable toggle, broker host, port, TLS, username, password, topic prefix. All broker-detail fields hidden when bridge is disabled.
- **npm dep `mqtt@^5.15.1`** added to `dependencies`.
- **+13 tests** in `test/unit/main_mqtt_bridge.spec.ts`.
- **VIS-2 Camera Tile widget (alpha)**: custom `bosch-camera-tile` widget for VIS-2 dashboards — displays `snapshot_path` image with auto-refresh, privacy-mode overlay badge, and stream URL copy button. See `widgets/bosch-camera-tile/` and [`## VIS-2 Camera Tile widget (alpha)`](#vis-2-camera-tile-widget-alpha) section.

### 0.7.8 (2026-05-20)
Emergency LiveSession fix + PTZ pan presets.

- **Emergency LiveSession restart**: if a live-session open fails with 503 / timeout, the adapter now immediately retries once with a fresh Digest auth challenge instead of waiting for the next poll tick. Prevents a 30 s dead-stream window after transient cloud hiccups.
- **PTZ pan presets** (`pan_preset` DP): new string data point alongside `pan_position`. Accepts named presets: `home`, `left`, `right`, `back-left`, `back-right`. Writing a preset name triggers the same RCP pan command as the numeric position DP. Mirrors HA integration's opt-in select entity.

### 0.7.4 (2026-05-19)
LAN-fallback feature set.

- **Coordinator outage-ping sweep**: when the state-poll GET returns 5xx or fails, a throttled (once per 30 s) fan-out TCP-connect probe runs against every known camera on port 443 so `cameras.<id>.lan_reachable` has a fresh value during cloud outages.
- **Persistent LAN-IP map**: `cameras.<id>.lan_ip` is written on every successful live-session open (`upsertSession`). On adapter start the map is reloaded from these states so the TCP-ping path has a working address book even before the first successful cloud refresh.
- **`cameras.<id>.lan_reachable` state**: boolean DP (read-only). Always reflects the last TCP-probe result; honors the post-write grace period.
- **Post-write grace period (30 s)**: after a successful local RCP write the camera briefly rotates Digest creds and tears down its HTTPS endpoint. `_localWriteAt` is stamped on every successful local write; `isLanReachable()` treats the camera as reachable during the 30 s window so the DP does not flap to `false` after every privacy/light toggle.
- **Cloud-degraded startup**: when `fetchCameras()` fails on startup (Bosch cloud 5xx), the adapter now rehydrates known camera IDs from the ioBroker object DB and kicks an immediate LAN-ping sweep instead of silently returning. Adapter stays alive and becomes fully operational once the cloud recovers.
- **Front-light Gen2 LOCAL RCP fallback**: `_applyLightingState()` now catches cloud errors and retries via `_localWriteFrontLight()` (RCP `0x0c22`, T_WORD, num=1, brightness 0–100).
- **Privacy LOCAL RCP fallback**: `handlePrivacyToggle()` now catches cloud errors and retries via `_localWritePrivacy()` (RCP `0x0d00`, P_OCTET) for Gen2 cameras with a known LAN IP.
- **+16 unit tests** in `test/unit/main_lan_fallback.spec.ts`. 572 tests total.

### 0.7.2 (2026-05-19)
Notification hooks for maintenance lifecycle and camera availability changes.

- **Maintenance lifecycle notifications** (scheduled → active → past): when the RSS-derived `info.maintenance.state` enters `scheduled`, `active`, or `past`, the adapter writes a JSON payload to the new `info.maintenance.last_notification` DP. Three notifications per window: announcement when first seen as scheduled, "active" when the window opens, "ended" when it closes. Deduped by `(RSS link, state)` so a poll tick during the same phase stays silent.
- **Per-camera offline / online transition notifications**: when `cameras.<id>.online` flips, a JSON payload is written to the new `cameras.<id>.last_status_notification` DP. The first observation after adapter start is silent (baseline recording). Payload: `{ title, message, status, ts }`.
- Both notification DPs are writable via Blockly `on-change` triggers: parse the JSON, extract `title` + `message`, and forward to Telegram, Pushover, or any other notification adapter.
- **+9 unit tests** covering the full transition matrix, dedupe, stale-past suppression, unknown-flap silence.

### 0.7.0 (2026-05-19)
Cloud maintenance / outage discovery.

- **`info.maintenance.state`** — string DP: `active` / `scheduled` / `past` / `recent` / `unknown` / `idle`. Classifies the latest announcement relative to the current time.
- **`info.maintenance.title`, `.link`, `.scheduled_start`, `.scheduled_end`, `.summary`, `.source`, `.camera_relevant`** — full parsed announcement fields.
- **`info.maintenance.last_fetched`** — ISO 8601 timestamp of the last successful community site contact.
- **Fetch cadence**: one immediate fetch at adapter startup, then every 3 600 s. Reactive re-fetch (5 min cooldown) on any 5xx from the camera cloud API.
- **Fallback chain**: primary RSS (Wartungsarbeiten → Statusmeldungen) → HTML board page.
- **Berlin TZ** (MEZ/MESZ, DST-aware) parsed from German DD.MM.YYYY HH:MM–HH:MM text.
- **+39 unit tests** covering RSS parser, Atom format, MEZ/MESZ DST, fallback chain, camera-relevance filter, all state classifier branches. 481 tests total.

### 0.6.2 (2026-05-18)
FCM push channel now self-heals after transient socket drops.

- **FCM auto-reconnect with exponential backoff** (5 s → 30 s → 120 s → 600 s cap). A successful retry restores `info.fcm_active` to `healthy` within seconds and resets the backoff so the next disconnect starts from 5 s again. The pending reconnect timer is cancelled on unload so the adapter never tries to start a half-torn-down listener during shutdown.
- **+6 unit tests** covering the backoff progression, success/reset path, re-entrancy guard against rapid-fire disconnect events, and onUnload cleanup. 442 tests total.

### 0.6.1 (2026-05-18)
Cleanup: removed legacy iOS FCM code paths.

- **`FCM_IOS_APP_ID` constant removed** — the adapter has used only the Android Firebase key since its first release; the constant was dead code.
- **`mode: "ios"` dispatch chain removed** — `FcmListenerOptions.mode`, `FcmCredentials.mode`, and `FcmRawCredentials.mode` now accept `"android" | "auto"` only.
- **`_registerWithCbs()` always posts `deviceType: "ANDROID"`** — the `"IOS"` branch is gone.
- **Legacy-creds back-compat**: users who stored credentials with `mode: "ios"` from a hypothetical pre-cleanup install will have their persisted mode rewritten to `"android"` on first start — no re-registration triggered.

### 0.6.0 (2026-05-16)
Security hardening + reliability round.

- **OAuth tokens + PKCE secrets are AES-encrypted at rest** via the ioBroker system secret. Migration is automatic on first start.
- **FCM credentials persisted across restarts** (`info.fcm_creds`, encrypted). Previously every adapter start triggered a full re-registration.
- **Camera-state poll runs per-camera in parallel** (`Promise.all`). With 4 cameras the per-tick wall-clock drops from ~N × 250 ms to ~250 ms.
- **Timer hygiene**: `motion_active` auto-clear (90 s) and snapshot-idle teardown (60 s) now use adapter-core's `this.setTimeout` / `this.clearTimeout`, so adapter unload cancels them reliably.
- **Snapshot-saved log line is now `debug`** (was `info`) — it was firing on every motion event and flooding logs on busy installations.
- **+51 unit tests** covering the new encryption paths, FCM credential persistence, livestream toggle teardown, event processing dedup, siren / wallwasher handlers, idle teardown window, and reachability tracker. 436 tests total, 0 failing.

### 0.5.5 (2026-05-16)
Two forum-driven bugfixes reported against v0.5.4.

- **`motion_active` now flips on the FCM-polling-fallback path** (`info.fcm_active="polling"`). The shared post-event helper (`_onMotionFired()`) was only being called by the real FCM event handler and the synthetic motion trigger — not by `fetchAndProcessEvents()`. Affected users saw `last_motion_at` update correctly while `motion_active` stayed permanently `false`.
- **Light state now syncs back from the Bosch app**. The 30 s state poll now derives `front_light_enabled` from `frontLightSettings.brightness > 0` and `wallwasher_enabled` from `max(topLed, bottomLed) brightness > 0`, so app toggles propagate within ~30 s.

### 0.5.4 (2026-05-15)
Login UX overhaul plus three small quality fixes.

- **One-click Bosch login button** in the instance settings. The browser-OAuth URL is also published as the `info.login_url` datapoint and rendered as a clickable link in the Admin UI.
- **No more terminate/restart loop while waiting for login**. If a stale `redirect_url` or an expired PKCE pair causes the code exchange to fail, the adapter now clears the stale state, regenerates a fresh login URL, sets `info.connection_status=auth_error`, and stays alive in awaiting-login mode.
- **Reset-login button**: new `Reset login (clear tokens & restart)` button in the instance settings.
- **`info.connection_status` text state** (`logged_out` | `awaiting_login` | `connected` | `auth_error`).
- **`info.last_login_at` ISO timestamp** of the most recent successful token mint.
- **Privacy mode no longer flips `online=false`**: an indoor camera in permanent privacy mode used to drift offline after a few startup-snapshot retries.
- **`last_motion_at` is now valid ISO 8601**: strips the trailing `[zone-id]` from Bosch's `ZonedDateTime#toString` format so Blockly scripts and VIS widgets can parse the field with standard tooling.

### 0.5.3 (2026-05-14)
Five forum-driven improvements focused on the BlueIris / NVR-recorder integration.

- **RTSP-aware proxy with transparent Digest auth**: the TLS proxy now speaks RTSP and handles the Bosch Digest auth dance itself. Clients (BlueIris, iobroker.cameras, Frigate) connect to a clean `rtsp://host:port/rtsp_tunnel?inst=1&…` URL — no credentials in the URL anymore.
- **Snapshot session keep-alive (60 s idle window)**: rapid `snapshot_trigger` bursts reuse the warm Bosch session instead of paying `PUT /v11/.../connection` on every snap.
- **`cameras.<id>.motion_active`** (new, boolean, read-only): edge-trigger DP, flips `true` on every motion / person / audio event, auto-clears to `false` after 90 s.
- **`cameras.<id>.last_event_image`** + **Auto-snapshot on motion**: every FCM motion / person / audio_alarm event now fetches a fresh JPEG and writes it as a `data:image/jpeg;base64,…` string.
- **`cameras.<id>.stream_url_sub`** (new, experimental): sub-stream URL via `inst=2` alongside the main `inst=1` `stream_url`.

### 0.5.2 (2026-05-14)
Per-camera livestream switch — default OFF.

- **`cameras.<id>.livestream_enabled`** (new, boolean, writable, default `false`): explicit on/off switch for the continuous RTSP livestream. Streaming is now opt-in.
- **Snapshots remain unaffected**: every `snapshot_trigger` still opens a session, fetches the JPEG, and then — when `livestream_enabled` is `false` — closes the session right after.

### 0.5.1 (2026-05-14)
Gen2 siren + RGB wallwasher colour, plus v0.5.0 forum-driven fixes.

- **Siren** (Gen2 only): new `cameras.<id>.siren_active` boolean DP. Write `true` to trigger the integrated 75 dB siren (panic alarm), `false` to silence.
- **RGB wallwasher** (Gen2 outdoor): two new DPs — `cameras.<id>.wallwasher_color` (HEX `#RRGGBB`, empty string = warm white mode) and `cameras.<id>.wallwasher_brightness` (0…100).
- Privacy state now syncs back from the Bosch app every 30 s.
- `stream_url` now embeds Digest credentials and Bosch query params so external recorders no longer get "401 Unauthorized" on connect.
- TLS-proxy port is sticky across session renewals and adapter restarts (persisted in `cameras.<id>._proxy_port`).
- New admin tab "RTSP / Stream": tickbox to bind the proxy to `0.0.0.0` plus an external-host field so the published URL uses the ioBroker host's LAN IP.

### 0.4.0 (2026-05-13)
- Light-datapoint split: `front_light_enabled` + `wallwasher_enabled` can now be controlled independently
- Synthetic motion trigger: write `true` to `cameras.<id>.motion_trigger` (select event type via `motion_trigger_event_type`) to inject a motion/person/audio_alarm event from an external sensor
- RTSP session watchdog: LOCAL Bosch sessions renew automatically ~60 s before `maxSessionDuration` expires
- Cloud-relay media paths fully removed: adapter enforces LOCAL-only for all media (RTSP + snapshots)

Older releases (0.0.1 – 0.3.3) are archived in [CHANGELOG_OLD.md](./CHANGELOG_OLD.md).

---

## License

MIT License — see [LICENSE](./LICENSE).

Copyright (c) 2026 mosandlt
