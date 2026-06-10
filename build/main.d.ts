/**
 * Bosch Smart Home Camera — ioBroker Adapter
 *
 * Entry point. Authenticates against Bosch Keycloak (OAuth2 PKCE),
 * discovers cameras via the Bosch Residential Cloud API, and manages
 * ioBroker state objects for each camera entity.
 *
 * Implementation roadmap:
 *   1. [auth.ts]         OAuth2 PKCE login → access_token + refresh_token
 *   2. [cameras.ts]      GET /v11/video_inputs → camera list
 *   3. [states]          Create ioBroker state tree per camera
 *   4. [live_session.ts] Open proxy session per camera (v0.2.0)
 *   5. [tls_proxy.ts]    Register RTSPS sources as local RTSP via TLS proxy (v0.2.0)
 *   6. [fcm.ts]          FCM push registration → motion/audio/person events (stub → v0.3.0)
 *   7. [rcp.ts]          RCP+ protocol helpers (unused since v0.3.0 — all commands use Cloud API)
 *   8. [snapshot.ts]     Snapshot fetch + write to adapter file-store (v0.2.0)
 *   9. [maintenance.ts]  RSS-based cloud maintenance / outage discovery (v0.7.0)
 */
import * as utils from "@iobroker/adapter-core";
/**
 *
 */
declare class BoschSmartHomeCamera extends utils.Adapter {
    /** setTimeout handle for the token refresh re-arm loop (ioBroker.Timeout | null). */
    private _refreshTimeout;
    /** Current refresh_token (kept in memory to avoid repeated state reads). */
    private _currentRefreshToken;
    /** Current access_token (kept in memory). */
    private _currentAccessToken;
    /** Cache: skip DB write when value is unchanged (iobroker.ring upsertState pattern). */
    private _stateCache;
    /** Axios instance shared across all HTTP calls. */
    private _httpClient;
    /** Live sessions keyed by camera ID. Re-opened when stale. */
    private _liveSessions;
    /** TLS proxy handles keyed by camera ID. */
    private _tlsProxies;
    private _webStream;
    /** Camera metadata keyed by camera ID (populated in onReady from fetchCameras). */
    private _cameras;
    /** FCM push listener (null until onReady wires it up). */
    private _fcmListener;
    /** RTSP session watchdogs keyed by camera ID. Renew LOCAL sessions before expiry. */
    private _sessionWatchdogs;
    /**
     * Client-side image rotation flag per camera ID.
     * Bosch Cloud API has no rotation endpoint — flag is stored here so
     * downstream callers (snapshot post-processing, UI) can apply 180° transforms.
     */
    private _imageRotation;
    /**
     * Stream-quality preference per camera ID. v0.5.0 — controls the
     * `highQualityVideo` flag in PUT /v11/video_inputs/{id}/connection.
     * Default "high" (full bitrate). Changing this state forces the next
     * ensureLiveSession() to re-open with the new flag.
     */
    private _streamQuality;
    /**
     * ISO timestamp of the latest processed event per camera.
     * Used by fetchAndProcessEvents() to skip events we've already seen.
     * Keyed by camera ID. float('-inf') equivalent → empty string means "not seen".
     */
    private _lastSeenEventId;
    /**
     * Count of consecutive snapshot failures per camera ID.
     * Used to flip `online=false` only after a sustained outage, not on the first
     * transient network blip. Reset on every successful snapshot.
     */
    private _snapshotFailCount;
    private _mjpegFailCount;
    private static readonly MJPEG_FASTPATH_MAX_FAILS;
    private _isUnloading;
    /** Consecutive snapshot failures before a camera is marked offline. */
    private static readonly OFFLINE_THRESHOLD;
    /**
     * v1.3.x: last cloud-reachability reconcile per camera (Date.now() ms).
     * A privacy-mode camera refuses snapshots, so the snapshot path can never
     * confirm its `online` state — when the adapter host is not on the camera
     * LAN that left `online` stuck at its last value (a live privacy camera
     * looked "offline"). We reconcile via the cloud (_resolveCameraStatus) in
     * the privacy branch, throttled to avoid a cloud round-trip every poll.
     */
    private _lastCloudReconcile;
    private static readonly CLOUD_RECONCILE_MIN_MS;
    /**
     * Timestamps (Date.now() ms) of recent HTTP 444 session-quota hits per camera.
     * Pruned to _SESSION_QUOTA_WINDOW_MS on each new hit.
     * When ≥ _SESSION_QUOTA_NOTIFY_THRESHOLD hits occur within the window,
     * the `session_limit_hit` DP is set to true and a warn-log is emitted.
     * Cleared when the camera opens a session successfully.
     */
    private _sessionLimitHits;
    private static readonly SESSION_QUOTA_WINDOW_MS;
    private static readonly SESSION_QUOTA_NOTIFY_THRESHOLD;
    private static readonly MAX_SESSION_RETRIES;
    /**
     * v0.9.1: per-(camId,feature) cache for endpoints that responded HTTP 442
     * (feature not supported on this hardware). Eliminates the warn-storm where
     * every privacy_sound_override write to an Outdoor camera produced the same
     * 442 + the same warn log. Once a feature is in this set, subsequent writes
     * and polls return early without any HTTP call.
     */
    private _unsupportedFeatures;
    /**
     * v0.9.1: per-(camId,poll-endpoint) exponential backoff for pollers that
     * receive consistent 444 (Bosch session-quota / "no content for this
     * period"). Without this the WiFi-info poll for offline cameras spammed
     * the debug log every 30 s forever. Sequence: 30s, 60s, 120s, 300s cap.
     * Resets to 30s on first success.
     */
    private _pollBackoff;
    private static readonly POLL_BACKOFF_BASE_MS;
    private static readonly POLL_BACKOFF_CAP_MS;
    /**
     * Polling timer for /v11/events when FCM push registration failed.
     * Drives event ingestion without push so motion/audio events still surface.
     * Undefined when FCM is healthy (push is the primary path).
     */
    private _eventPollTimer;
    /**
     * Event-poll interval (ms) when FCM push is unavailable.
     * v1.2.2: 60 s to match the Home Assistant integration's default
     * `scan_interval` (60 s) — was 30 s.
     */
    private static readonly EVENT_POLL_INTERVAL_MS;
    /**
     * v0.6.2: pending FCM auto-reconnect timer.
     * Armed on the listener's "disconnect" event and walks the backoff array
     * below. Cleared on successful reconnect, on unload, and re-armed on every
     * failed start() retry.
     */
    private _fcmReconnectTimer;
    /**
     * v0.6.2: current backoff attempt index (0 → 5 s, 1 → 30 s, 2 → 120 s,
     * 3+ → 600 s cap). Reset to 0 on successful reconnect.
     */
    private _fcmReconnectAttempt;
    /**
     * v0.6.2: exponential-backoff schedule for FCM auto-reconnect (ms).
     * Last entry is the cap — any attempt beyond this index reuses 600 s.
     * Tuned for Google MTalk server rotation (typically heals in seconds)
     * while keeping log noise bounded if push stays unreachable.
     */
    private static readonly FCM_RECONNECT_BACKOFF_MS;
    /**
     * Periodic poll of /v11/video_inputs to pick up app-side state changes
     * (privacy toggled via the Bosch app, camera renamed, …). Independent of
     * FCM — runs always so DPs stay accurate even with push healthy.
     * Forum #84538: user set privacy_enabled via ioBroker, toggled it off
     * via the app, ioBroker DP stayed `true` because we only fetched once.
     */
    private _statePollTimer;
    /**
     * Camera-state poll interval (ms).
     * v1.2.2: 60 s base tick to match the Home Assistant coordinator's default
     * `scan_interval` (60 s) — was 30 s. The slow tier still lands at 300 s via
     * SLOW_TIER_THRESHOLD=5 (5 × 60 s), matching HA's do_slow (every 5th tick).
     */
    private static readonly STATE_POLL_INTERVAL_MS;
    /**
     * v0.7.0: periodic timer for cloud maintenance / outage discovery.
     * Fetches Bosch community RSS feeds every hour and surfaces the latest
     * maintenance window in `info.maintenance.*` state objects.
     */
    private _maintenanceTimer;
    /** Maintenance poll interval (ms). */
    private static readonly MAINTENANCE_POLL_INTERVAL_MS;
    /**
     * Last-known maintenance window. Cached here so a transient community-site
     * outage does not destroy the state — we keep the previous value until we
     * get a fresh successful parse.
     */
    private _lastMaintenanceWindow;
    /**
     * Epoch ms of the last maintenance fetch that actually contacted the
     * community site (successful or 503). Used to enforce a 5-min cooldown
     * on reactive re-fetches triggered by 5xx API responses.
     */
    private _maintenanceLastFetchMs;
    /**
     * v0.7.2: dedupe key for maintenance lifecycle notifications.
     * Stores the last `[link, state]` pair we actually fired a notification for.
     * The `past` state only fires when `active` for the same link was previously
     * announced — prevents spam from stale historical windows on adapter restart.
     * null = no notification sent yet this adapter session.
     */
    private _maintenanceNotifiedKey;
    /**
     * v0.7.2: last-known online/offline status per camera ID.
     * null (missing key) = first observation since adapter start → silent baseline.
     * Transitions involving "unknown" are also silent (transient cloud flap).
     */
    private _lastCameraStatus;
    /**
     * Sticky TLS-proxy port per camera ID. Set on first proxy start
     * (ephemeral free port from the OS), then reused across session renewals
     * and adapter restarts so external recorders (BlueIris) keep working
     * without re-configuring the URL on every hourly session renewal.
     */
    private _stickyProxyPort;
    /**
     * Remembered upstream LAN address (`<ip>:<port>`) per camera. Used by
     * `upsertSession()` to decide whether a renewed Bosch session points at
     * the same camera (→ keep the proxy + port intact) or at a different
     * address (→ tear down + restart).
     */
    private _sessionRemote;
    /**
     * v0.7.4: last known LAN IP (host only, no port) per camera ID.
     * Seeded at onReady from persisted `cameras.<id>.lan_ip` states so
     * the TCP-ping path has a working address book even before the first
     * successful cloud refresh.
     */
    private _lanIpMap;
    /**
     * v0.7.4: result of the last TCP-connect probe to port 443 per camera.
     * Tuple: [reachable, performance.now()-equivalent via Date.now()].
     */
    private _lanReachable;
    /**
     * v0.7.4: monotonic-style timestamp (Date.now()) of the last
     * `_pingAllCamsDuringOutage` sweep. float(-Infinity) semantics via
     * -Infinity so the first outage tick always runs immediately.
     */
    private _lastOutagePingAt;
    /**
     * v0.7.4: timestamp (Date.now()) of the last successful local RCP write
     * per camera. Used by `_inLocalWriteGrace()` to suppress a brief
     * "LAN offline" blip that follows every privacy / light toggle (the
     * camera tears down its HTTPS endpoint while Digest creds rotate, ~5–15 s).
     */
    private _localWriteAt;
    /** v0.7.4: post-write grace window (ms). Mirrors HA's _LOCAL_WRITE_GRACE_S. */
    private static readonly LOCAL_WRITE_GRACE_MS;
    /**
     * Diagnostic slow-tier: counter incremented on every STATE_POLL_INTERVAL_MS tick.
     * When it reaches SLOW_TIER_THRESHOLD (5), the slow-tier tasks run and it resets.
     * STATE_POLL_INTERVAL_MS=60s × 5 = 300s cadence — mirrors HA's do_slow logic.
     */
    private _diagPollTick;
    /** Slow-tier runs every SLOW_TIER_THRESHOLD state-poll ticks (5 × 60s = 300s). */
    private static readonly SLOW_TIER_THRESHOLD;
    /**
     * F13: cached cloud feature flags result. Null until first successful fetch.
     * Account-level — one per adapter instance (not per camera).
     */
    private _featureFlagsCache;
    /** v0.7.4: outage-ping throttle (ms). */
    private static readonly OUTAGE_PING_THROTTLE_MS;
    /** v0.7.4: TCP-connect timeout for LAN-reachability probe (ms). */
    private static readonly LAN_PING_TIMEOUT_MS;
    /**
     * Desired siren (panic_alarm) state per Gen2 camera. The Bosch cloud has
     * no GET for this state — the iOS/Android apps keep their own copy and
     * we do the same. Wiped on adapter restart (camera also auto-stops the
     * siren after a hardware-defined timeout, so a stale `true` is fine to
     * forget).
     */
    private _sirenState;
    /**
     * v0.7.10: renewal backoff state per camera. Tracks how many consecutive
     * cloud renewal failures have occurred and when the next retry should fire.
     * Reset to attempt=0 on a successful renewal.
     */
    private _renewalBackoff;
    /**
     * v0.7.10: wall-clock epoch (ms) when the Bosch live session was first opened
     * per camera. Used to detect the 60-min natural session expiry — if the
     * session has been alive for ≥ SESSION_MAX_AGE_MS AND the latest renewal
     * is still failing, we tear down rather than retrying indefinitely.
     */
    private _sessionStartTime;
    /**
     * v0.7.10: consecutive LAN TCP-connect failure count per camera.
     * Incremented in the renewal-retry path when the LAN probe fails.
     * Reset to 0 on a successful TCP connect. Teardown is triggered after
     * LAN_TCP_FAIL_THRESHOLD consecutive failures.
     */
    private _lanTcpFailCount;
    private _streamGeneration;
    /** v0.7.10: exponential backoff steps (ms) for cloud renewal retries. */
    private static readonly RENEWAL_BACKOFF_MS;
    /** v0.7.10: maximum Bosch session lifetime (ms). Matches Bosch 60-min limit. */
    private static readonly SESSION_MAX_AGE_MS;
    /** v0.7.10: LAN TCP failures before stream teardown. */
    private static readonly LAN_TCP_FAIL_THRESHOLD;
    /**
     * Cached lighting state per Gen2 camera (frontLight + topLed + bottomLed
     * brightness/color/whiteBalance). Seeded by the state-poll GET on the
     * `/lighting/switch` endpoint and updated from every PUT response. Used
     * to merge incremental DP writes into the full body Bosch requires.
     */
    private _lightingCache;
    private _intrusionConfigCache;
    private _audioCache;
    private _lensElevationCache;
    private _globalLightingCache;
    private _alarmSettingsCache;
    private _alarmStatusCache;
    private _notificationsCache;
    private _motionLightCache;
    private _ambientLightCache;
    private static readonly NOTIFY_TYPE_MAP;
    private _motionCache;
    /**
     * Whether a continuous live RTSP stream is active per camera ID.
     * Default: false (no livestream on adapter start — Bosch counts every
     * open session against the daily LOCAL session limit, so we don't want
     * to burn quota on cameras the user isn't actively watching). When
     * `cameras.<id>.livestream_enabled` is true, ensureLiveSession() keeps
     * the Bosch session + TLS proxy + watchdog alive; when false, the
     * adapter still opens short-lived sessions for snapshots but tears them
     * down after the idle window so no proxy/watchdog stays running.
     */
    private _livestreamEnabled;
    /**
     * v0.7.9: optional MQTT bridge. Null when mqtt_enabled=false.
     * Wired up in onReady, torn down in onUnload.
     */
    private _mqttBridge;
    /**
     * v0.5.3: pending "idle teardown" timer per camera (livestream OFF mode).
     * After each snapshot the timer is reset; when it finally fires we close
     * the Bosch session + TLS proxy + watchdog. Lets back-to-back
     * snapshot_trigger writes (e.g. a Card opening, an automation polling)
     * reuse the warm session instead of paying the PUT /connection cost
     * every time. Cleared eagerly on _teardownStream, livestream toggle ON,
     * and onUnload.
     */
    private _snapshotIdleTimers;
    /**
     * Idle window after a snapshot before the session is torn down (ms).
     * Sized to match SESSION_TTL_MS in ensureLiveSession so a snapshot
     * burst within the window always reuses the cached session instead of
     * forcing a fresh `PUT /v11/.../connection`.
     */
    private static readonly SNAPSHOT_SESSION_IDLE_MS;
    /**
     * v0.5.3: per-camera "motion_active=true" auto-clear timers. When a
     * motion event fires we set motion_active=true; this timer flips it
     * back to false after MOTION_ACTIVE_WINDOW_MS so automations have a
     * clean rising/falling edge to listen on. Re-armed (window slides) on
     * every follow-up event within the window.
     */
    private _motionActiveTimers;
    /**
     * v1.1.0: latest JPEG per camera, served by the local HTTP snapshot server
     * (started in onReady when snapshot_http_port > 0). Populated wherever a
     * fresh snapshot buffer is fetched; the server only reads from this map.
     */
    private _latestSnapshots;
    /** v1.1.0: HTTP snapshot server handle (undefined when the port is 0/off). */
    private _snapshotServer?;
    /** v1.1.0: host used to build the public snapshot_url (LAN IP, detected once). */
    private _snapshotHost;
    /**
     * How long `cameras.<id>.motion_active` stays true after the last
     * motion event before auto-clearing (ms). Default 90 s, configurable
     * via adapter option `motion_active_window` (10–300 s). Mirrors the HA
     * integration's EVENT_ACTIVE_WINDOW.
     */
    private get _motionActiveWindowMs();
    /**
     *
     * @param options
     */
    constructor(options?: Partial<utils.AdapterOptions>);
    /**
     * vis-2 BoschCamera widget (mode "mjpeg") subscription handler. The widget
     * calls socket.subscribeOnInstance(inst, "startCamera/<camId>", {width}, cb);
     * we register the viewer and start a shared FFmpeg MJPEG stream. Requires an
     * active live session (livestream_enabled=true) so the TLS proxy listens.
     *
     * @param info adapter-core subscribe info
     * @param info.clientId UI client id used to push frames via sendToUI
     * @param info.message wrapped subscription message ({type, data})
     */
    private onUiClientSubscribe;
    /**
     * vis-2 widget unsubscribe / heartbeat-timeout handler — drops the viewer
     * and stops FFmpeg when the camera has no more viewers.
     *
     * @param info adapter-core unsubscribe info
     * @param info.clientId UI client id that is leaving
     * @param info.message optional wrapped message ({type}) on explicit unsubscribe
     */
    private onUiClientUnsubscribe;
    /**
     * Build the local RTSP URL FFmpeg reads for a camera's MJPEG web stream, or
     * null when no TLS proxy is active for it (livestream not enabled).
     *
     * @param camId camera cloud-ID
     */
    private _resolveWebStreamUrl;
    /**
     * v0.5.4: handle sendTo messages from Admin UI.
     *
     * Commands:
     *   - "getLoginUrl": return the current info.login_url value so the Admin
     *     UI can render a "Login bei Bosch" button that opens the URL in a
     *     new tab without forcing the user to copy a 300-char log line.
     *   - "resetLogin": clear all OAuth state (tokens, PKCE pair, pasted URL)
     *     and generate a fresh login URL. Used when a user is stuck in an
     *     auth_error loop or wants to log in with a different Bosch account.
     *
     * @param obj Inbound ioBroker message from Admin (carries command, from, callback).
     */
    private onMessage;
    /**
     * v1.1.0: resolve a sendTo("snapshot") camera reference to a known cloud
     * UUID. Accepts the exact UUID (case-insensitive), the camera name
     * (case-insensitive), or — when exactly one camera is configured — an
     * empty string. Returns null when it cannot be resolved unambiguously.
     *
     * @param requested cloud-ID, camera name, or "" for the sole camera
     */
    private _resolveCameraId;
    /**
     * Write a state only if the value changed (iobroker.ring upsertState pattern).
     * Always creates the object if it doesn't exist yet, then sets ack=true.
     *
     * @param id
     * @param value
     */
    private upsertState;
    /** Ensure the info channel + connection/token states exist. */
    private ensureInfoObjects;
    /**
     * Ensure `info.maintenance.*` state objects exist.
     * Called once in onReady before the first maintenance fetch.
     */
    private ensureMaintenanceObjects;
    /**
     * Fetch maintenance status, update `_lastMaintenanceWindow`, and write all
     * `info.maintenance.*` state objects atomically.
     *
     * If the community site is unreachable (fetchMaintenance returns null), the
     * previous cached window is kept — the states are NOT overwritten with idle/empty
     * values, because a transient community outage should not destroy a known
     * maintenance state.
     */
    private _refreshMaintenanceStatus;
    /**
     * Fire a user notification when the maintenance window enters a new lifecycle state.
     *
     * Mirrors `_async_maybe_announce_maintenance` from the HA integration exactly:
     * - Only `scheduled`, `active`, `past` trigger notifications.
     * - Each (link, state) pair fires at most once (deduped in-memory).
     * - `past` only fires if we previously announced `active` for the same link,
     *   suppressing stale historical windows discovered after an adapter restart.
     * - Non-actionable states (recent / unknown / idle) stay silent.
     *
     * Notification delivery: writes a JSON string to `info.maintenance.last_notification`
     * (hookable via Blockly/scripts) and calls `this.log.info` for the log.
     * Non-fatal — a misconfigured notification consumer must not break maintenance discovery.
     *
     * @param mw  The active MaintenanceWindow (camera_relevant already checked at caller).
     * @param state  Pre-computed state for `mw` (avoids a second classifyState call).
     */
    private _maybeAnnounceMaintenanceState;
    /**
     * Start the hourly maintenance poll.
     * Idempotent — a second call while the timer is already armed is a no-op.
     */
    private _startMaintenancePolling;
    /**
     * Reactive maintenance re-fetch triggered by a 5xx response on a cloud API call.
     *
     * Enforces a 5-minute cooldown so a sustained cloud outage (which causes every
     * camera state-poll to 5xx) doesn't hammer the community RSS feeds once per 30 s.
     */
    private _triggerMaintenanceFetchOn5xx;
    private static readonly SECRET_PREFIX;
    private _encryptSecret;
    private _decryptSecret;
    /**
     * One-shot migration for users upgrading from <=v0.5.x: re-encrypt any
     * plaintext token / PKCE secret found in state storage and overwrite the
     * state with the AES-wrapped form. Idempotent — already-encrypted values
     * are skipped.
     */
    private _migrateLegacySecrets;
    /**
     * v0.7.6: remove light DPs for Gen2 cameras that have no LED hardware
     * (featureLight=false, e.g. Eyes Indoor II). These DPs were created
     * unconditionally by <=v0.7.5 — clean them up on first adapter-restart
     * after upgrade so users don't see phantom switches in their object tree.
     *
     * Safe to call repeatedly: delObjectAsync is a no-op when the object
     * doesn't exist.
     *
     * @param cameras  camera list fetched from Bosch Cloud
     */
    /**
     * v0.7.14: remove the `wifi_signal_strength` DP — it was created by
     * v0.7.7 with unit "dBm" but in reality received the API's
     * `signalStrength` percentage (0-100). The percentage now lives in
     * `wifi_signal_pct`; keeping the misnamed DP around would mislead
     * users into thinking dBm data is available. Safe to call repeatedly.
     *
     * @param cameras  camera list fetched from Bosch Cloud
     */
    private _migrateWifiSignalDp;
    /**
     * v1.2.6 migration: fix `common.role` values that are not in the ioBroker
     * role catalogue (repochecker object-structure check E1008/E1009). Older
     * installs created states with roles that the checker rejects:
     *   indicator.status / indicator.state → info.status (string status text)
     *   level.mode                         → text        (writable string enum)
     *   value.signal                       → value       (read-only number %)
     *   value.angle                        → level       (writable number, degrees)
     *   info                               → json        (JSON diagnostic string)
     *   value.time + common.type "string"  → date        (value.time needs number)
     *   value + common.type "string"       → text        (value needs number)
     * `setObjectNotExistsAsync` never rewrites an existing object, so a plain
     * version bump would leave old installs on the invalid roles — this sweep
     * extends every affected state in place. Idempotent: a state already on the
     * correct role is skipped.
     */
    private _migrateStateRoles;
    private _migrateLightDps;
    /**
     * Read + decrypt + JSON-parse the persisted FCM credentials. Returns null
     * if the state is empty, the ciphertext is unusable, or the payload is
     * not the expected shape — the caller falls back to a fresh registration.
     */
    private _loadSavedFcmCredentials;
    /**
     * Encrypt + persist FCM credentials so the next adapter start can replay
     * them as `savedCredentials`. JSON-stringify so the FcmRawCredentials blob
     * (ECDH key + ACG id/token + auth secret) round-trips intact.
     *
     * @param creds
     */
    private _saveFcmCredentials;
    /**
     * Create the cameras device + one channel per camera.
     * Uses setObjectNotExistsAsync to preserve user history config.
     *
     * @param cameras
     */
    private ensureCameraObjects;
    /**
     * Ensure the top-level `cloud` channel and F13 feature-flags DPs exist.
     * Called once in onReady after cameras are discovered.
     */
    private ensureCloudObjects;
    /**
     * Save tokens to ioBroker states (survives adapter restart).
     *
     * @param tokens
     */
    private saveTokens;
    /**
     * Load tokens from ioBroker states (from a previous run).
     * Returns null if tokens are absent or already expired.
     */
    private loadStoredTokens;
    /**
     * Schedule the next token refresh at 75% of remaining token lifetime.
     * Uses this.setTimeout (adapter-core) so ioBroker auto-cancels on unload.
     *
     * @param expiresInMs  Milliseconds until the current access_token expires.
     */
    private scheduleTokenRefresh;
    /**
     * Ensure a fresh live session exists for the given camera ID (LOCAL only).
     *
     * Caches sessions and reuses them while they are within 30 s of being opened.
     * On a fresh session, spawns a TLS proxy and arms the RTSP session watchdog
     * so the stream renews automatically before the Bosch LOCAL session expires.
     *
     * This adapter is LOCAL-only by design: cloud-relay paths are never used
     * for media. If the camera is unreachable on the LAN, the call throws.
     *
     * @param camId
     */
    private ensureLiveSession;
    /**
     * v0.7.10: Route a cloud 5xx log through the appropriate level.
     *
     * When the Bosch maintenance feed says a window is active, a 503 is expected
     * and should be an INFO rather than WARN to avoid alarm fatigue.
     * When no maintenance is active, keep WARN so the user notices a real outage.
     *
     * @param camPrefix  Short camera ID prefix for log context
     * @param status     HTTP status code (e.g. 503)
     * @param retryIn    Seconds until the next retry (for WARN message)
     */
    private _routeCloudErrorLog;
    /**
     * v0.7.10: Handle a failed watchdog renewal with graceful backoff.
     *
     * Behaviour:
     *   1. Keep the existing session alive (do NOT tear down immediately).
     *   2. Retry with exponential backoff: 5 s → 15 s → 45 s → 120 s → 300 s, then every 300 s.
     *   3. On each retry attempt:
     *      a. TCP-connect to the camera LAN IP first. Three consecutive TCP failures → teardown.
     *      b. If TCP succeeds, try cloud renewal. On success → reset backoff, re-arm watchdog.
     *      c. On 401/403 → call emergency session refresh; on 503 → log with maintenance routing.
     *   4. Tear down only when:
     *      (a) Session has naturally expired (≥ 60 min) AND renewal still fails, OR
     *      (b) LAN TCP connect fails 3 times in a row.
     *
     * @param camId  Camera UUID
     * @param err    Error from the last failed openSession() call
     */
    private _handleRenewalFailure;
    /**
     * v0.7.10: Perform a single backoff renewal attempt for the given camera.
     *
     * 1. TCP-connect to camera LAN IP (port 443). Three consecutive failures → teardown.
     * 2. If LAN is reachable, try openLiveSession.
     * 3. On success: reset backoff, replace live session, re-arm watchdog.
     * 4. On failure: schedule the next retry via _handleRenewalFailure.
     *
     * @param camId  Camera UUID
     */
    private _attemptBackoffRenewal;
    /**
     * v0.7.10: Synchronous teardown wrapper used by the backoff renewal path.
     * Kicks off _teardownStream fire-and-forget (stream teardown is always
     * best-effort; the caller must not await it in the backoff path to avoid
     * blocking the retry loop).
     *
     * @param camId  Camera UUID
     */
    private _doTeardownStream;
    /**
     * Spawn (or replace) the TLS proxy for the given session and update stream_url.
     * Extracted so both ensureLiveSession and the watchdog onRenew callback can reuse it.
     *
     * Two forum-driven behaviours (issue #84538):
     *   - **Sticky port**: on first run the OS picks a free ephemeral port; we
     *     persist it (`_stickyProxyPort` + state `cameras.<id>._proxy_port`)
     *     and reuse it on every renewal / adapter restart so an external
     *     recorder (BlueIris) keeps the same URL. Falls back to a new
     *     ephemeral port if the old one is taken (e.g. another process).
     *   - **Credentials in URL**: Bosch's RTSP endpoint demands Digest auth;
     *     embed `user:password@host:port` so the recorder can authenticate
     *     without a separate config step.
     *
     * @param camId    Camera UUID
     * @param session  Freshly opened LiveSession (always LOCAL)
     */
    private upsertSession;
    /**
     * Resolve the RTSP proxy bind host + URL host from adapter config.
     * Default: bind 127.0.0.1, URL uses 127.0.0.1 (legacy behaviour).
     * `rtsp_expose_to_lan=true` → bind 0.0.0.0, URL uses `rtsp_external_host`
     * (falls back to 127.0.0.1 if the field is empty — that still works for
     * tools running on the ioBroker host, just not for LAN recorders).
     */
    private _rtspBindConfig;
    /**
     * Build the public RTSP URL with embedded Digest credentials and the
     * query params Bosch cameras expect (inst, enableaudio, fmtp,
     * maxSessionDuration). Mirrors the HA integration's `local_rtsp_url`
     * shape in __init__.py.
     *
     * @param proxy
     * @param session
     * @param instance
     */
    private _buildStreamUrl;
    /**
     * Publish the host / port / path parts of a built stream URL into the
     * split datapoints (stream_host / stream_port / stream_path) so users can
     * paste each value straight into iobroker.cameras, which composes its RTSP
     * URL from separate fields rather than one full-URL input (forum #84538).
     * Pass an empty string to clear all three (stream torn down).
     *
     * @param camId camera cloud-ID
     * @param url   full `rtsp://host:port/path?query`, or "" to clear
     */
    private _publishStreamParts;
    /**
     * Replace `user:password@` with `***:***@` for log lines.
     *
     * @param url
     */
    private _maskCreds;
    /**
     * Generate (or reuse) a PKCE pair, build the Bosch auth URL, and log it.
     *
     * The verifier is stored in info.pkce_verifier so it survives restarts —
     * regenerated only after a successful code exchange or explicit reset.
     * This prevents "stale verifier" errors when the user copies the URL from
     * one adapter start and pastes after a second restart.
     */
    private showLoginUrl;
    /**
     * Exchange a pasted OIDC redirect URL for access + refresh tokens.
     *
     * Reads the stored PKCE verifier, extracts the auth code from the URL,
     * calls Keycloak token endpoint, saves tokens, and clears the paste field.
     *
     * @param url  Full redirect URL pasted by the user
     * @returns TokenResult on success
     * @throws Error if code extraction or token exchange fails
     */
    private handleRedirectPaste;
    /**
     * Called once the adapter DB connection is ready.
     *
     * 1. Ensure info + token states exist
     * 2. Load stored tokens or perform fresh login
     * 3. Fetch camera list
     * 4. Create per-camera state tree
     * 5. Set info.connection = true
     * 6. Arm token refresh loop
     * 7. Start FCM listener (real push via @aracna/fcm, sets info.fcm_active = "healthy")
     */
    /**
     * True if a successful local RCP write happened within LOCAL_WRITE_GRACE_MS.
     * During that window a TCP-connect failure is suppressed — the camera
     * briefly tears down its HTTPS endpoint while rotating Digest creds.
     *
     * @param camId
     * @param now
     */
    _inLocalWriteGrace(camId: string, now?: number): boolean;
    /**
     * Most recent LAN-TCP reachability for `camId`, or null if not yet probed.
     * Honors the post-write grace period so the UI does not flip to offline
     * for a few seconds after every privacy / light toggle.
     *
     * @param camId
     */
    isLanReachable(camId: string): boolean | null;
    /**
     * TCP-connect probe to the camera's LAN port 443.
     * Writes the result to `_lanReachable` and updates the `cameras.<id>.lan_reachable` DP.
     *
     * @param camId
     */
    private _tcpPing;
    /**
     * Ping every known camera concurrently during a cloud outage.
     * Throttled to once per OUTAGE_PING_THROTTLE_MS so a flapping cloud
     * does not hammer the LAN. Mirrors HA's `_async_outage_ping_all`.
     */
    _pingAllCamsDuringOutage(): Promise<void>;
    /**
     * Emergency LiveSession opener for LAN-RCP writes (v0.7.8).
     *
     * Called when `_liveSessions` has no entry for a Gen2 camera just before a
     * local RCP write — e.g. immediately after adapter start when no stream has
     * been opened yet.
     *
     * Behaviour:
     *   - Returns Digest credentials {user, password} on success.
     *   - Returns undefined when no access token is available or when the cloud
     *     returns an error (CameraOfflineError / LiveSessionError / 503). Callers
     *     fall through to unauthenticated best-effort fetch.
     *   - The opened session is stored in `_liveSessions` so subsequent RCP
     *     writes within the same session window reuse it without a new PUT.
     *
     * @param camId  Camera UUID
     */
    private _openEmergencySession;
    /**
     * Write the front-light brightness directly via local RCP (Gen2).
     * RCP 0x0c22 (T_WORD, num=1) — brightness 0–100.
     *
     * v0.7.5: Gen2 cameras listen only on HTTPS port 443 and require HTTP Digest
     * auth on /rcp.xml (HTTP port 80 → connection refused; verified 2026-05-20).
     * Credentials (`cbs-XXXXXXXX` cycling user/pass) come from the cloud
     * PUT /connection response stored in the active LiveSession.
     * Returns true on success.
     *
     * @param camIp     Camera LAN IP address
     * @param brightness  Brightness 0–100 (clamped)
     * @param auth      Optional Digest credentials {user, password}; required for Gen2
     * @param auth.user
     * @param auth.password
     */
    private _localWriteFrontLight;
    /**
     * Write privacy mode directly via local RCP (Gen2).
     * RCP 0x0d00 (P_OCTET) — mirrors HA's rcp_local_write_privacy.
     *
     * v0.7.5: Gen2 cameras listen only on HTTPS port 443 and require HTTP Digest
     * auth on /rcp.xml (HTTP port 80 → connection refused; verified 2026-05-20).
     * Credentials (`cbs-XXXXXXXX` cycling user/pass) come from the cloud
     * PUT /connection response stored in the active LiveSession.
     * Returns true on success.
     *
     * @param camIp   Camera LAN IP address
     * @param enabled  true = privacy ON, false = privacy OFF
     * @param auth    Optional Digest credentials {user, password}; required for Gen2
     * @param auth.user
     * @param auth.password
     */
    private _localWritePrivacy;
    private onReady;
    /**
     * Periodic refetch of `/v11/video_inputs` to mirror app-side state changes
     * (privacy, in the future also name / firmware) into ioBroker DPs.
     *
     * Designed to be cheap — single GET, ~1–2 kB JSON per call, 30 s cadence.
     * Idempotent: re-calling while a timer is already armed is a no-op.
     * Stops itself on token expiry; the token-refresh loop will re-arm.
     */
    private _startStatePolling;
    /**
     * Single tick of the state poll: GET /v11/video_inputs, sync per-camera
     * fields that exist in that response back to DPs (currently just
     * privacy_enabled; light fields live on /lighting and aren't polled).
     */
    private _pollCameraStateOnce;
    /**
     * Per-camera body of `_pollCameraStateOnce` (extracted for `Promise.all`).
     *
     * @param token
     * @param cam
     * @param doSlowTier
     */
    private _pollSingleCameraState;
    /**
     * v0.7.14: Fetch intrusionDetectionConfig and mirror sensitivity +
     * distance into the per-camera DPs so users see the actual cloud
     * values instead of the placeholder DP defaults (3 / 5). Also seeds
     * the cache so the user-write handler has a full baseline body to
     * merge into. Gen2-only endpoint.
     *
     * @param token  Current access_token
     * @param camId  Camera UUID
     */
    private _pollIntrusionConfig;
    /**
     * v1.1.0: fetch GET /v11/video_inputs/{id}/motion and mirror `enabled` →
     * motion_enabled DP + `motionAlarmConfiguration` → motion_sensitivity DP
     * (lower-cased to match the select option keys). Also seeds _motionCache
     * so the write handler has a full baseline body to merge into (Bosch /motion
     * rejects partial PUTs). All cameras. Best-effort — errors swallowed.
     * 404/443 (privacy) → keep last-known DP values.
     *
     * @param token  Current access_token
     * @param camId  Camera UUID
     */
    private _pollMotionConfig;
    /**
     * v1.1.0: poll GET /v11/video_inputs/{id}/recording_options and mirror
     * `recordSound` → record_sound DP. All cameras. 404/443 → keep last value.
     * Best-effort — errors swallowed.
     *
     * @param token  Current access_token
     * @param camId  Camera UUID
     */
    private _pollRecordingOptions;
    /**
     * v1.1.0: poll GET /v11/video_inputs/{id}/notifications, seed
     * _notificationsCache and mirror each present type key into its notify_* DP.
     * All cameras. 404/443 → keep last value. Best-effort — errors swallowed.
     *
     * @param token  Current access_token
     * @param camId  Camera UUID
     */
    private _pollNotificationTypes;
    /**
     * v1.1.0: read the Batch-D toggle states and mirror them into DPs:
     *  - timestamp_overlay ← GET /timestamp.result (all cameras)
     *  - status_led ← GET /ledlights.state ("ON"/"OFF") (Gen2)
     *  - power_led_brightness ← GET /iconLedBrightness.value (Gen2 Indoor)
     * Best-effort — each GET 404/443/error keeps the last DP value.
     *
     * @param token Current access_token
     * @param cam   Camera metadata (for generation/model gating)
     */
    private _pollBatchDLeds;
    /**
     * v1.1.0: read /lighting/motion + /lighting/ambient and mirror DPs:
     *  - motion_light_enabled ← lightOnMotionEnabled · motion_light_sensitivity ← motionLightSensitivity
     *  - ambient_light_enabled ← ambientLightEnabled · ambient_light_schedule (derived enum)
     * Seeds _motionLightCache / _ambientLightCache for the write merges. Gen2
     * Outdoor only. Best-effort — 404/443/errors keep last value.
     *
     * @param token Current access_token
     * @param camId Camera UUID
     */
    private _pollOutdoorLighting;
    /**
     * v1.2.0: mirror the cloud "management" GET endpoints into READ-only DPs.
     *
     * All endpoints live under /v11/video_inputs/{id}/… and ride the slow tier.
     * WRITE paths (zone / rule / share editing) are intentionally not wired —
     * see docs/family-parity-status.md "parked" section.
     *
     *   motion_sensitive_areas → motion_zones_count + motion_zones (Gen1; Gen2 → 404)
     *   privacy_masks          → privacy_masks_count + privacy_masks
     *   rules                  → rules_count + rules
     *   lighting_options       → lighting_schedule_status + lighting_schedule (Gen1)
     *   shared_with_friends    → shared_with_friends_count + shared_with_friends (Gen2)
     *
     * Tolerated non-2xx (keep last-known DP, never throw): 404 (endpoint absent
     * for this generation), 442 (model unsupported), 443 (privacy mode active),
     * 444 (camera offline).
     *
     * @param token  Current access_token
     * @param cam    Camera metadata (generation gates which endpoints run)
     */
    private _pollManagementReads;
    /**
     * Helper for the array-returning management endpoints. GETs
     * /v11/video_inputs/{id}/{endpoint}; on a 2xx array response writes
     * `cameras.{id}.{dpBase}_count` (length) and `cameras.{id}.{dpBase}` (raw
     * JSON). Non-2xx or non-array → no write (keeps the last-known value).
     * Best-effort: swallows network errors.
     *
     * @param token     Current access_token
     * @param camId     Camera UUID
     * @param endpoint  Cloud endpoint path segment (e.g. "rules")
     * @param dpBase    DP base name (e.g. "rules" → rules_count + rules)
     */
    private _pollCloudListDp;
    /**
     * GETs the Gen1 floodlight schedule (/lighting_options) and mirrors
     * `scheduleStatus` → lighting_schedule_status plus the full object →
     * lighting_schedule (raw JSON). Indoor/360 Gen1 answer 442 → no write.
     * Best-effort.
     *
     * @param token  Current access_token
     * @param camId  Camera UUID
     */
    private _pollLightingSchedule;
    /**
     * v1.1.0: GET /v11/video_inputs/{id}/commissioned → map {configured,
     * connected, commissioned} into the commissioned DP enum
     * (commissioned / not_commissioned / not_connected). All cameras, read-only.
     * Best-effort — 404/443/errors keep last value. Mirrors HA BoschCommissionedSensor.
     *
     * @param token Current access_token
     * @param camId Camera UUID
     */
    private _pollCommissioned;
    /**
     * Poll lens elevation from GET /v11/video_inputs/{id}/lens_elevation.
     * Seeds the write-cache and mirrors the value into the DP.
     * Gen2 only. Best-effort — errors swallowed.
     *
     * @param token  Current access_token
     * @param camId  Camera UUID
     */
    private _pollLensElevation;
    /**
     * Poll global lighting config from GET /v11/video_inputs/{id}/lighting.
     * Seeds the write-cache and mirrors darknessThreshold (0.0–1.0) → DP (0–100 %).
     * Gen2 Outdoor only. Best-effort — errors swallowed.
     *
     * @param token  Current access_token
     * @param camId  Camera UUID
     */
    private _pollGlobalLighting;
    /**
     * Poll alarm settings from GET /v11/video_inputs/{id}/alarm_settings.
     * Seeds the write-cache and mirrors alarm delay fields into DPs.
     * HOME_Eyes_Indoor / CAMERA_INDOOR_GEN2 only. Best-effort — errors swallowed.
     *
     * @param token  Current access_token
     * @param camId  Camera UUID
     */
    private _pollAlarmSettings;
    /**
     * v1.1.0: poll GET /v11/video_inputs/{id}/alarmStatus → mirror
     * `intrusionSystem` into the alarm_state sensor (lower-cased string) and the
     * alarm_arm switch (ACTIVE → true, else false). Gen2 Indoor II only.
     * Best-effort — 404/443 keep last value, errors swallowed.
     *
     * @param token  Current access_token
     * @param camId  Camera UUID
     */
    private _pollAlarmStatus;
    /**
     * F4/F6 slow-tier: fetch ONVIF scopes (RCP 0x0a98) and RCP version (0xff00)
     * directly from the camera's LAN HTTPS endpoint using cached cbs Digest creds.
     *
     * Called on every slow-tier tick (every SLOW_TIER_THRESHOLD × STATE_POLL_INTERVAL_MS ≈ 300 s).
     * Fully best-effort — errors are swallowed, DPs keep their last known value.
     * Requires an active LiveSession so cbs Digest creds are available.
     *
     * @param camId  Camera UUID
     */
    private _pollLanDiagnostics;
    /**
     * F13: fetch cloud feature flags from GET /v11/feature_flags.
     *
     * Account-level (not per-camera). Called on slow-tier ticks (≈ 300 s).
     * Caches result in _featureFlagsCache; DPs updated only on change.
     * Best-effort — errors are silently ignored.
     *
     * @param token  Current access_token
     */
    private _pollFeatureFlags;
    /**
     * Fetch WiFi info for one camera and update DPs.
     * GET /v11/video_inputs/{id}/wifiinfo — 200 with body, 404 on Ethernet.
     * Best-effort: errors are logged at debug level and ignored.
     *
     * @param token  Current access_token
     * @param camId  Camera UUID
     */
    /** v0.9.1 — return true if (camId, feature) hit HTTP 442 before. */
    private _isFeatureUnsupported;
    /** v0.9.1 — record that (camId, feature) hit HTTP 442; future calls short-circuit. */
    private _markFeatureUnsupported;
    /** v0.9.1 — backoff key for (camId, endpoint). */
    private _backoffKey;
    /** v0.9.1 — return true if this poll should be skipped due to backoff. */
    private _shouldSkipPoll;
    /**
     * v0.9.1 — record poll outcome and update backoff window.
     * On success: clear backoff entry (next poll runs immediately).
     * On 444/failure: exponential backoff 30→60→120→300s (cap).
     */
    private _recordPollResult;
    private _pollWifiInfo;
    /**
     * v0.9.1 — replaces the misleading `cam.numberOfUnreadEvents` listing field.
     * Live testing 2026-05-28 showed `numberOfUnreadEvents` reports 0 even when
     * GET /v11/events returns dozens of `isRead=false` events for the same camera
     * (mark_all_read found 44/44 unread that the listing claimed didn't exist).
     * This poller does its own count via the events endpoint.
     */
    private _pollUnreadCount;
    /**
     * Called whenever a subscribed state changes.
     * Only acts on ack=false states (user commands, not adapter-reported values).
     * Routes writes to the appropriate per-camera handler.
     *
     * @param id
     * @param state
     */
    private onStateChange;
    /**
     * Handle an FCM motion/person/audio_alarm push event.
     * Writes per-camera last_motion_at + last_motion_event_type, flips
     * motion_active=true (with auto-clear timer), and — when
     * `auto_snapshot_on_motion` is on — fetches a fresh JPEG and publishes
     * it as base64 in last_event_image so Telegram / Signal / Matrix
     * automations can push it directly.
     *
     * @param ev
     */
    private onFcmEvent;
    /**
     * v0.7.9: publish a camera event to the MQTT bridge (fire-and-forget).
     * No-op when the bridge is not connected.
     *
     * @param camId      Camera UUID
     * @param eventType  "motion" | "person" | "audio_alarm"
     * @param timestamp  ISO 8601 timestamp
     * @param eventId    Event identifier (may be empty string)
     */
    private _publishMqttEvent;
    /**
     * v0.5.3: shared post-event side effects, called by both real FCM
     * events and synthetic motion triggers. Flips motion_active=true with
     * a 90 s auto-clear, and — when auto_snapshot_on_motion is enabled —
     * fires a fresh snapshot in the background (reuses the warm session
     * via the v0.5.3 keep-alive optimization for rapid bursts).
     *
     * @param camId Camera UUID
     */
    private _onMotionFired;
    /**
     * Write microphone or speaker level to the Bosch cloud API.
     * PUT /v11/video_inputs/{id}/audio body: {microphoneLevel, speakerLevel}
     * Gen2 only.
     *
     * @param camId  Camera UUID (must be Gen2)
     * @param field  "microphone" | "speaker"
     * @param level  0–100
     */
    private _handleAudioLevelWrite;
    /**
     * v1.1.0: enable/disable intercom (two-way audio) — Gen2. PUT /audio with
     * `audioEnabled` merged into the FULL body (same /audio endpoint + cache as
     * the speaker/mic levels, so they aren't clobbered). Mirrors HA BoschIntercomSwitch.
     *
     * @param camId Camera UUID (Gen2)
     * @param on    true → intercom on
     */
    private _handleIntercomWrite;
    /**
     * v1.1.0: enable/disable Bosch push notifications for a camera.
     * PUT /v11/video_inputs/{id}/enable_notifications
     * body {"enabledNotificationsStatus": "FOLLOW_CAMERA_SCHEDULE" | "ALWAYS_OFF"}.
     * Cloud-only (works even when the camera is offline). No generation gate.
     * Mirrors HA BoschNotificationsSwitch (turning ON always sends
     * FOLLOW_CAMERA_SCHEDULE, never ON_CAMERA_SCHEDULE).
     *
     * @param camId   Camera UUID
     * @param enabled true → FOLLOW_CAMERA_SCHEDULE, false → ALWAYS_OFF
     */
    private _handleNotificationsWrite;
    /**
     * v1.1.0: write motion detection config to the Bosch cloud API.
     * PUT /v11/video_inputs/{id}/motion — the API requires the FULL body
     * {enabled, motionAlarmConfiguration}; a partial PUT silently drops the
     * omitted field. So GET-from-cache (or live) → merge the one delta field →
     * PUT the merged body → cache it (mirrors _handleAudioLevelWrite).
     * Shared by motion_enabled and motion_sensitivity. Privacy-blocked on
     * Gen2 Indoor → Bosch returns HTTP 443; we surface that as a warning.
     *
     * @param camId Camera UUID
     * @param delta partial motion config to merge into the cached full body
     * @param delta.enabled motion detection on/off
     * @param delta.sensitivity lower-case sensitivity option key (super_high…off)
     */
    private _handleMotionWrite;
    /**
     * Write intrusion detection config to the Bosch cloud API.
     * PUT /v11/video_inputs/{id}/intrusionDetectionConfig
     * Gen2 only.
     *
     * @param camId  Camera UUID (must be Gen2)
     * @param delta  {sensitivity?, distance?}
     * @param delta.sensitivity
     * @param delta.distance
     * @param delta.detectionMode upper-case API enum (ALL_MOTIONS/ONLY_HUMANS/ZONES)
     */
    private _handleIntrusionWrite;
    /**
     * v1.1.0: toggle recording audio via PUT /v11/video_inputs/{id}/recording_options.
     * Single-key body {recordSound:bool} (no full-body merge needed). All cameras.
     * Mirrors HA BoschRecordSoundSwitch. Returns false on 443 (privacy) so the
     * caller skips the optimistic ack.
     *
     * @param camId Camera UUID
     * @param on    true → record sound, false → mute recordings
     */
    private _handleRecordSoundWrite;
    /**
     * v1.1.0: generic single-key PUT helper for the Batch-D toggles
     * (ledlights / timestamp / iconLedBrightness) — no full-body merge needed.
     * Returns false on 443 (privacy) so the caller skips the optimistic ack.
     *
     * @param camId    Camera UUID
     * @param endpoint sub-path after /video_inputs/{id}/ (e.g. "ledlights")
     * @param body     single-key request body
     * @param label    log label
     */
    private _putSingleKey;
    /** v1.1.0: status-LED on/off (Gen2). PUT /ledlights {state:"ON"|"OFF"}. */
    private _handleStatusLedWrite;
    /** v1.1.0: timestamp/date overlay (all cams). PUT /timestamp {result:bool}. */
    private _handleTimestampWrite;
    /** v1.1.0: power/icon-LED brightness (Gen2 Indoor). PUT /iconLedBrightness {value:0-4}. */
    private _handlePowerLedBrightnessWrite;
    /**
     * v1.1.0: full-body-merge PUT helper for a /lighting/{sub} sub-endpoint
     * (motion / ambient). GET-from-cache (or live) → set the delta keys → PUT
     * the whole object → cache it. Returns false on 443 (privacy).
     *
     * @param camId    Camera UUID
     * @param sub      "motion" | "ambient"
     * @param cache    the matching cache map
     * @param delta    keys to merge into the full body
     */
    private _putLightingMerge;
    /** v1.1.0: motion-light on/off + sensitivity (Gen2 Outdoor, /lighting/motion). */
    private _handleMotionLightWrite;
    /** v1.1.0: ambient-light on/off (Gen2 Outdoor, /lighting/ambient). */
    private _handleAmbientLightWrite;
    /**
     * v1.1.0: toggle a single notification type via PUT /v11/video_inputs/{id}/
     * notifications. Bosch requires the FULL body, so GET-from-cache (or live) →
     * set the one key → PUT the merged object → cache it. Mirrors
     * HA BoschNotificationTypeSwitch. Returns false on 443 (privacy).
     *
     * @param camId  Camera UUID
     * @param apiKey one of movement/person/audio/trouble/cameraAlarm/troubleEmail
     * @param on     desired value
     */
    private _handleNotificationTypeWrite;
    /**
     * Set lens mounting height via PUT /v11/video_inputs/{id}/lens_elevation.
     * Gen2 only. Range clamped to 0.5–5.0 m.
     *
     * @param camId      Camera UUID (must be Gen2)
     * @param elevation  Height in metres (clamped)
     */
    private _handleLensElevationWrite;
    /**
     * Set darkness threshold via PUT /v11/video_inputs/{id}/lighting.
     * Converts user-facing 0–100 % to Bosch float 0.0–1.0.
     * Merges with cached softLightFading field (Bosch requires full body).
     * Gen2 Outdoor only.
     *
     * @param camId  Camera UUID (must be Gen2 Outdoor)
     * @param pct    Threshold percentage 0–100
     */
    private _handleDarknessThresholdWrite;
    /**
     * Write alarm settings via PUT /v11/video_inputs/{id}/alarm_settings.
     * Merges delta into the full cached body (Bosch may reject partial bodies).
     * HOME_Eyes_Indoor / CAMERA_INDOOR_GEN2 only.
     *
     * @param camId   Camera UUID
     * @param delta   Partial update: one or more of {alarmDelayInSeconds, alarmActivationDelaySeconds, preAlarmDelayInSeconds}
     * @param delta.alarmDelayInSeconds
     * @param delta.alarmActivationDelaySeconds
     * @param delta.preAlarmDelayInSeconds
     * @param delta.alarmMode "ON"/"OFF" — alarm mode enable
     * @param delta.preAlarmMode "ON"/"OFF" — pre-alarm warning enable
     */
    private _handleAlarmSettingsWrite;
    /**
     * v1.1.0: arm/disarm the Gen2 Indoor II alarm system via
     * PUT /v11/video_inputs/{id}/intrusionSystem/arming {arm:bool} (single key).
     * Read-mirrored from GET /alarmStatus.intrusionSystem (_pollAlarmStatus).
     * Mirrors HA BoschAlarmSystemArmSwitch.
     *
     * @param camId Camera UUID (Gen2 Indoor II)
     * @param arm   true → arm, false → disarm
     */
    private _handleAlarmArmWrite;
    /**
     * Inject a synthetic motion event for a camera.
     *
     * Writes last_motion_at + last_motion_event_type states exactly as FCM events do,
     * so downstream automations that listen for Bosch motion states fire immediately
     * without waiting for the real Bosch FCM push.
     *
     * Scope: ioBroker-local only. This DOES NOT cause a recording in the
     * Bosch cloud / Bosch app — the camera's own motion engine decides when
     * to record, and Bosch exposes no API to inject a recording externally.
     * Use this for ioBroker-side scenes/automations (light, scene, push),
     * not as a remote "record now" trigger. Forum #84538 post 10.
     *
     * Forum reference: ioBroker forum #84538 (Jaschkopf — Philips Hue in driveway).
     *
     * @param camId      Camera UUID
     * @param eventType  "motion" | "person" | "audio_alarm"
     */
    private triggerSyntheticMotion;
    /**
     * Trigger / silence the Gen2 panic-alarm siren.
     *
     * PUT /v11/video_inputs/{id}/panic_alarm body {"status": "ON"|"OFF"} → 204.
     * Stateful — the camera keeps blaring until OFF is sent (or its hardware
     * timeout fires, which Bosch hasn't documented; observed ~3 min).
     *
     * @param camId    Camera UUID (must be Gen2)
     * @param enabled  true → trigger siren, false → silence
     */
    private handleSirenToggle;
    /**
     * Set privacy sound override (audible indicator on privacy mode change).
     * GET/PUT /v11/video_inputs/{id}/privacy_sound_override  body: {"result": bool}
     * HTTP 442 = endpoint not supported on this camera model (silently ignored).
     *
     * @param camId    Camera UUID
     * @param enabled  true = play sound when privacy mode changes
     */
    private _handlePrivacySoundWrite;
    /**
     * Poll privacy sound state from GET /v11/video_inputs/{id}/privacy_sound_override.
     * Best-effort — errors and HTTP 442 swallowed.
     *
     * @param token  Current access_token
     * @param camId  Camera UUID
     */
    private _pollPrivacySound;
    /**
     * Set autofollow state for a Gen1 360° camera.
     * GET/PUT /v11/video_inputs/{id}/autofollow  body: {"result": bool}
     * Only supported when panLimit > 0 (CAMERA_360).
     *
     * @param camId    Camera UUID (must have panLimit > 0)
     * @param enabled  true = enable auto-follow
     */
    private _handleAutofollowWrite;
    /**
     * Poll autofollow state from GET /v11/video_inputs/{id}/autofollow.
     * Best-effort — errors swallowed.
     *
     * @param token  Current access_token
     * @param camId  Camera UUID (panLimit > 0 expected)
     */
    private _pollAutofollow;
    /**
     * Mark all recent events as read for a camera.
     * Fetches the last 20 events, then calls PUT /v11/events with {id, isRead: true}
     * for each one. Best-effort — individual failures are swallowed.
     * Python CLI reference: api_mark_events_read() (PUT /v11/events per event).
     *
     * @param camId  Camera UUID
     */
    private _handleMarkAllRead;
    /**
     * Pan the Gen1 360° camera to an absolute position.
     *
     * Gated on `panLimit > 0` — only CAMERA_360 (Gen1 indoor) supports pan.
     * API: PUT /v11/video_inputs/{id}/pan  body: {absolutePosition: int}
     * Range: -panLimit to +panLimit degrees.
     *
     * @param camId     Camera UUID
     * @param position  Target angle in degrees (clamped to panLimit range)
     */
    private _handlePanWrite;
    /**
     * Apply a wallwasher (top + bottom LED) update to a Gen2 camera.
     *
     * The Bosch lighting/switch endpoint requires the full body — caller
     * passes only the delta and we merge into the cached state. If we have
     * no cache yet (first call after start, before the state-poll tick has
     * fetched), seed with `DEFAULT_LIGHTING_STATE` so the front spotlight
     * isn't accidentally re-enabled.
     *
     * Empty-string colour switches the LEDs to white-balance mode (warm
     * white). Use case: user clears the picker to "no colour".
     *
     * @param camId   Camera UUID (must be Gen2 with featureSupport.light)
     * @param delta   {brightness?, color?}  — only the changed fields
     * @param delta.brightness
     * @param delta.color
     */
    private handleWallwasherUpdate;
    /**
     * v1.3.x: Set the front spotlight brightness (0..100) for a Gen2 camera.
     *
     * Uses PUT /v11/video_inputs/{id}/lighting/switch with only
     * frontLightSettings.brightness changed; the wallwasher (top+bottom) LED
     * groups stay at their current cached values. Mirrors HA's
     * `number.<cam>_front_light_intensity` entity.
     *
     * Gen2 + featureLight=true only — same gating as wallwasher_brightness.
     *
     * @param camId     Camera UUID
     * @param brightness  0..100
     */
    private handleFrontLightIntensityUpdate;
    /**
     * Switch the stream-quality preference for a camera and force a session
     * re-open so the new highQualityVideo flag takes effect immediately.
     *
     * The Bosch Cloud API only honours `highQualityVideo` at the
     * `PUT /v11/video_inputs/{id}/connection` call — it cannot be changed
     * on a live session. So we close the existing session (via DELETE),
     * drop the cached LiveSession, and let the next snapshot/stream call
     * re-open with the new flag.
     *
     * @param camId
     * @param quality  "high" or "low"
     */
    private handleStreamQualityChange;
    /**
     * Arm (or reset) the post-snapshot idle teardown timer for one camera.
     * Called from `handleSnapshotTrigger` in `finally` when livestream is
     * OFF. Each new snapshot resets the timer so a Card / automation
     * burst keeps the Bosch session warm for `SNAPSHOT_SESSION_IDLE_MS`
     * (default 60 s) — only the first snap pays the `PUT /connection`
     * cost, subsequent snaps reuse the cached session.
     *
     * @param camId  Camera UUID
     */
    private _armSnapshotIdleTeardown;
    /**
     * Cancel the pending idle-teardown timer for one camera, if any.
     *
     * @param camId
     */
    private _cancelSnapshotIdleTeardown;
    /**
     * Tear down everything that keeps a livestream alive for one camera:
     * session watchdog, TLS proxy, Bosch live session (DELETE /connection),
     * and the public stream_url DP. Used by:
     *   - the livestream toggle (user sets livestream_enabled=false)
     *   - the post-snapshot idle timer when livestream is OFF (auto-cleanup
     *     so a Card burst doesn't accidentally start 24/7 streaming, but
     *     consecutive snaps within the idle window reuse the warm session).
     * Best-effort throughout — Bosch may have already closed the session
     * server-side after a transient network drop.
     *
     * @param camId  Camera UUID
     */
    private _teardownStream;
    /**
     * v1.2.5: emit a one-time, actionable startup hint when livestream is OFF on
     * every camera (the default). Without it new users see an empty `stream_url`
     * and their go2rtc / recorder reports "connection refused" — because the TLS
     * proxy only listens while a livestream is active (forum #84538, vowill).
     *
     * Fires once per adapter start, info level, and only when NO camera streams.
     * As soon as any camera has `livestream_enabled=true` it stays silent. The
     * `rtsp_expose_to_lan` reminder is appended only when the proxy is bound to
     * 127.0.0.1, the other root cause of a cross-host "connection refused".
     *
     * @param cameras  discovered cameras (already hydrated into _livestreamEnabled)
     * @returns true if the hint was logged, false if any camera streams (testable)
     */
    private _logLivestreamHintIfAllOff;
    /**
     * Start or stop the continuous RTSP livestream for one camera.
     * Default behaviour for the adapter is OFF — each open Bosch session
     * counts against the LOCAL daily quota, and the TLS proxy + RTSP
     * watchdog stay running 24/7 once armed. The user opts in per camera.
     *
     * @param camId    Camera UUID
     * @param enabled  true → ensureLiveSession (session + proxy + watchdog
     *                          + stream_url), false → _teardownStream
     */
    private handleLivestreamToggle;
    /**
     * Fetch fresh events for all known cameras from the Bosch Cloud API.
     *
     * Called on every FCM "push" (silent wake-up — Bosch sends no event payload
     * in the push itself). Mirrors Python async_handle_fcm_push() in fcm.py.
     *
     * Endpoint: GET /v11/events?videoInputId={camId}&limit=5
     * Returns: array of event objects (newest first) or empty array.
     *
     * Event object fields (confirmed via HA integration):
     *   { id, eventType, eventTags, timestamp/createdAt, videoInputId }
     * Gen2: eventType=MOVEMENT + eventTags=["PERSON"] → normalise to "person"
     */
    private fetchAndProcessEvents;
    /**
     * Privacy mode: PUT /v11/video_inputs/{camId}/privacy with
     * { privacyMode: "ON" | "OFF", durationInSeconds: null }.
     *
     * Matches HA's `async_cloud_set_privacy_mode()` in shc.py. Cloud-API path
     * is the primary (fast ~150ms) and works for both Gen1 + Gen2. RCP+ LOCAL
     * is NOT used here because Bosch's Gen2 firmware rejects WRITE 0x0808 over
     * Digest auth (verified live: HTTP 401 even with correct credentials).
     *
     * @param camId
     * @param enabled
     */
    private handlePrivacyToggle;
    /**
     * Camera light: Cloud-API PUT, Gen-specific endpoint.
     *
     * Gen2: PUT /v11/video_inputs/{id}/lighting/switch/front + /topdown
     *       with body { enabled: true|false }
     * Gen1: PUT /v11/video_inputs/{id}/lighting_override
     *       with body { frontLightOn, wallwasherOn, frontLightIntensity? }
     *
     * Matches HA's `async_cloud_set_camera_light()` in shc.py.
     *
     * @param camId
     * @param enabled
     */
    private handleLightToggle;
    /**
     * v0.4.0: toggle the front spotlight only, keep wallwasher untouched.
     * Requested by ioBroker forum #84538 for dusk-sensor-driven group switching.
     *
     * @param camId
     * @param enabled
     */
    private handleFrontLightToggle;
    /**
     * v0.4.0: toggle the wallwasher (Gen1) / top-down LED strip (Gen2) only,
     * keep front spotlight untouched.
     *
     * @param camId
     * @param enabled
     */
    private handleWallwasherToggle;
    /**
     * Read a boolean state with default false (treats null/undefined/non-bool as false).
     *
     * @param id
     */
    private _readBoolState;
    /**
     * Single source of truth for the lighting REST calls. All three public
     * handlers (legacy combined, front-only, wallwasher-only) funnel through
     * here so we only have one place that knows the Bosch endpoints.
     *
     * Endpoint matrix:
     *   Gen1: PUT /v11/video_inputs/{id}/lighting_override
     *         body: { frontLightOn, wallwasherOn, frontLightIntensity? }
     *   Gen2: PUT /v11/video_inputs/{id}/lighting/switch/front   { enabled }
     *         PUT /v11/video_inputs/{id}/lighting/switch/topdown { enabled }
     *
     * After a successful call the per-light state objects are ack'd so that
     * `light_enabled` (legacy combined) and the two new datapoints stay in sync.
     *
     * @param camId
     * @param state
     * @param state.frontLight
     * @param state.wallwasher
     */
    private _applyLightingState;
    /**
     * Image rotation: pure client-side flag — no Bosch Cloud API endpoint exists.
     *
     * Bosch's Cloud API has no image-rotation field (confirmed in the HA integration:
     * "Cloud API does not expose any image-rotation field; this switch is a pure
     * client-side display flag"). RCP+ 0x0810 returned HTTP 401 on Gen2 FW 9.40.25
     * with valid Digest auth — and even if it worked, it would only affect the
     * camera's own RTSP stream orientation, not how ioBroker consumers display it.
     *
     * The flag is stored in-memory (_imageRotation) so downstream callers (snapshot
     * post-processing, UI consumers reading the state) can apply 180° transforms.
     *
     * @param camId
     * @param rotated180
     */
    private handleImageRotationToggle;
    /**
     * Snapshot fetch: opens a live session, downloads JPEG via snap.jpg URL,
     * writes to the adapter file-store, and updates cameras.<id>.snapshot_path.
     *
     * Bosch cameras frequently abort the first snap.jpg request after a long
     * idle period with "stream has been aborted" — observed live on Gen2
     * Outdoor (Terrasse, FW 9.40.25). The second attempt (within ~5s) always
     * succeeds. We retry once with a short backoff before giving up; mirrors
     * HA integration's snap.jpg retry pattern.
     *
     * @param camId
     * @param opts
     * @param opts.asMotionEvent
     */
    private handleSnapshotTrigger;
    /**
     * Fetch a snapshot via snap.jpg with one retry on transient errors.
     *
     * Extracted from handleSnapshotTrigger so the MJPEG fast path can fall back
     * to this without code duplication.
     *
     * @param camId
     * @param snapUrl  Full snap.jpg URL (from buildSnapshotUrl)
     * @param session  Live session providing Digest credentials
     * @param session.digestUser
     * @param session.digestPassword
     */
    private _fetchSnapJpgWithRetry;
    /**
     * Start the polling fallback: re-fetch /v11/events every 30 s.
     *
     * Activated only when FCM push registration fails for both iOS and Android.
     * Mirrors HA's `fcm_push_mode=polling` behaviour — adapter stays usable, just
     * with higher motion-event latency (~30 s vs. ~2 s with push).
     *
     * Idempotent: re-calling while a timer is already armed is a no-op.
     */
    private _startEventPolling;
    /**
     * v0.6.2: arm an FCM reconnect attempt with exponential backoff.
     * No-op if a timer is already pending (re-entrancy guard) or if the
     * listener has been torn down (adapter shutting down).
     */
    private _scheduleFcmReconnect;
    /**
     * v0.6.2: re-call `_fcmListener.start()` after a disconnect.
     * Success → reset backoff, mark info.fcm_active="healthy".
     * Failure → bump attempt counter, re-schedule via {@link _scheduleFcmReconnect}.
     * Treats a missing listener as terminal (adapter is unloading).
     */
    private _attemptFcmReconnect;
    /**
     * Update `cameras.<id>.online` based on snapshot reachability.
     *
     * Bosch's list endpoint does not expose connectivity, so the only signal we have
     * is whether snapshot fetches succeed. We mark a camera offline only after
     * {@link BoschSmartHomeCamera.OFFLINE_THRESHOLD} consecutive failures —
     * a single transient "stream has been aborted" must not flip the state.
     *
     * @param camId
     * @param reachable
     */
    /**
     * v0.5.4: Bosch returns timestamps in Java's ZonedDateTime#toString format
     * — "2026-05-15T06:51:47.604+02:00[Europe/Berlin]". The trailing
     * `[zone-id]` is IETF/Java-only and breaks any standard ISO 8601 parser
     * including JavaScript's `new Date()`. Strip it so consumers can parse.
     *
     * @param raw Bosch timestamp (e.g. from /v11/events `timestamp` field).
     * @returns ISO 8601 string, or the input unchanged if no zone suffix.
     */
    private static normaliseBoschTimestamp;
    /**
     * Resolve a camera's live online status WITHOUT opening a live session,
     * mirroring the HA integration's `_check_status` (LAN-TCP primary, cloud
     * `/ping` + `/commissioned` fallback). Used to skip live-session/snapshot
     * attempts for OFFLINE cameras: an offline camera can never serve a stream,
     * so trying only burns Bosch's shared 3-session budget and spams HTTP 444.
     * Forum #84538 (offline cameras).
     *
     * @param camId Camera UUID
     * @returns "ONLINE" | "OFFLINE" | "SESSION_LIMIT" | "UPDATING" | "UNKNOWN"
     */
    private _resolveCameraStatus;
    /**
     * Handle a Bosch HTTP 444 session-quota error.
     *
     * - Records the hit timestamp in _sessionLimitHits.
     * - Sets cameras.<id>.session_limit_hit = true.
     * - Warns at WARN level (not debug) on every hit so the user notices.
     * - After SESSION_QUOTA_NOTIFY_THRESHOLD (3) hits in SESSION_QUOTA_WINDOW_MS (5 min),
     *   logs an additional warning advising to close other Bosch clients.
     * - Schedules a 60s auto-retry (Bosch orphaned slots expire within ~60s).
     * - Does NOT increment _snapshotFailCount — quota is not a connectivity failure.
     *
     * @param camId  Camera UUID
     */
    private _handleSessionLimitError;
    private markCameraReachability;
    /**
     * Reconcile `cameras.<id>.online` from the cloud (LAN-TCP → /ping →
     * /commissioned) for cameras the snapshot path can't probe (privacy mode).
     * Only acts on definitive ONLINE/OFFLINE; UNKNOWN/UPDATING/SESSION_LIMIT
     * leave the DP unchanged. Throttled per camera to {@link CLOUD_RECONCILE_MIN_MS}
     * so it does not add a cloud round-trip on every poll.
     *
     * @param camId Camera UUID
     */
    private _reconcileOnlineViaCloud;
    /**
     * Fire a user notification when a camera flips between online and offline.
     *
     * Mirrors `_async_maybe_announce_camera_status` from the HA integration exactly:
     * - The first observation per camera is silent (records baseline without notifying).
     * - Only `online → offline` and `offline → online` transitions notify.
     * - Transitions involving `unknown` are silent (transient coordinator flap).
     *
     * Notification delivery: writes a JSON string to `cameras.<id>.last_status_notification`
     * (hookable via Blockly/scripts) and calls `this.log.info`.
     * Non-fatal — notification failures must not break reachability tracking.
     *
     * @param camId       Camera ID.
     * @param newStatus   "online" | "offline" | "unknown".
     */
    private _maybeannounceCameraStatus;
    /**
     * Called when the adapter is stopped.
     * Cleans up TLS proxies, FCM listener, live sessions, and the refresh timer.
     * Must always call callback() — ioBroker enforces a timeout.
     *
     * @param callback
     */
    private onUnload;
}
export { BoschSmartHomeCamera };
//# sourceMappingURL=main.d.ts.map