# Changelog

## [v1.0.0] - 2026-05-28

**Out of beta.** Combines the v0.9.0 feature wave with four follow-up bug fixes from a live-camera test session on 2026-05-28 against the user's four-camera setup (Eyes Außenkamera II + Eyes Innenkamera II + Gen1 360° + Gen1 Outdoor).

### v0.9.0 work — features + code-quality fixes
- **`privacy_sound_enabled` (R/W boolean, all cameras)** — toggles the audible privacy-mode indicator. `PUT/GET /v11/video_inputs/{id}/privacy_sound_override` body `{"result": bool}`.
- **`autofollow_enabled` (R/W boolean, 360° cameras only)** — gates on `panLimit > 0`. `PUT/GET /v11/video_inputs/{id}/autofollow` body `{"result": bool}`.
- **`unread_events_count` (R number) + `mark_all_read` (button)** — counter + bulk-acknowledge for stored motion/event notifications. mark-all-read calls `PUT /v11/events` with `{id, isRead: true}` per event up to a batch of 50.
- **`last_seen_event_id` persistence** — new ioBroker state per camera, hydrated on `onReady` and written on every event processed. Replaces the in-memory-only field that previously caused restart-triggered false-motion firings before the staleness-age guard kicked in.
- **`CLOUD_API` consolidation** — single source of truth in `src/lib/auth.ts`. The 15 inline `"https://residential.cbs.boschsecurity.com"` occurrences in `main.ts` and the duplicate in `fcm.ts` are gone; one URL change now requires one edit.
- **Empty-cache guard before merge-PUTs** for `darkness_threshold` (and the existing pattern reused in intrusion + alarm handlers) — if `_globalLightingCache` is empty after a fresh start, GET first to seed it before sending the partial update, preventing HTTP 400 "missing required fields" errors.

### v0.9.1 work — four follow-up fixes from 2026-05-28 live tests

- **B1: `privacy_sound_override` HTTP 442 on every Outdoor camera** — first write to any Outdoor (Gen1 + Gen2) emitted `privacy_sound_override not supported (HTTP 442)` once, and the second write emitted the same warning again, and the third, and the fourth. The hardware genuinely doesn't support privacy-mode audio confirmation on outdoor models — there is no speaker. Now a 442 response is cached per `(camId, feature)` and all subsequent writes for that camera short-circuit without an HTTP call. Same caching path applied to `autofollow` 442/404.
- **B3: `unread_events_count` always 0 even with 44 unread events** — the v0.9.0 implementation seeded the DP from `cam.numberOfUnreadEvents` in the `/v11/video_inputs` listing. Live test 2026-05-28 against the Eyes Außenkamera II ("Terrasse"): listing reported `numberOfUnreadEvents=0`, but `GET /v11/events?videoInputId=…&limit=50` returned **44 events with `isRead=false`**. `mark_all_read` then successfully marked 44/44. So Bosch's listing field is unreliable — possibly "new since the last poll" rather than "total unread". Replaced the listing-source with a dedicated `_pollUnreadCount` poller that counts `isRead===false` events from the events endpoint directly.
- **B4 + B5: WiFi info + autofollow polls 444 every 30 s, no backoff** — both Gen1 cameras returned HTTP 444 ("Bosch session-quota / no content for this period") for the WiFi-info poll every 30 s, and the same for the Gen1 360° camera's autofollow poll. Each failure dumped a debug line; over 24 hours that's > 2 800 noise entries per camera × 3 endpoints. Added exponential-backoff per `(camId, endpoint)` — 30 s base, doubling on each 444 (60 → 120 → 300 s cap) and reset on first success.

### Internal
- Versioning: this release combines v0.9.0 (agent-driven feature wave) and v0.9.1 (test-driven follow-ups). Skipping the intermediate tags and going straight to v1.0.0 reflects "out of beta" status now that the per-camera feature set spans the same surface as the HA integration.
- Tests: 699 passing (same suite as v0.9.0). 2 pre-existing brightness-derivation failures in `main.spec.ts:1719,1783` are unrelated to this work.

## [v0.8.0] - 2026-05-25

- HA-feature parity wave: ONVIF Scopes (F4 via RCP 0x0a98), RCP version sensor (F6 via 0xff00), Cloud Feature Flags (F13), MJPEG inst=3 snapshot, Bosch session-quota 444 as distinct state.
- Repochecker bot preflight: news ≤ 7, visWidgets components required, Node engines >=22, version-in-news must exist on npm.
- CI: cross-env wrapper so Windows runners parse env vars; `[22.x, 24.x] × [ubuntu, windows, macos]`; actions/checkout + setup-node bumped to v6 for Node 24.
