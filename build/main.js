"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.BoschSmartHomeCamera = void 0;
const net = __importStar(require("node:net"));
const utils = __importStar(require("@iobroker/adapter-core"));
// adapter-config.d.ts augments ioBroker.AdapterConfig — included via tsconfig src/**/*.ts,
// no runtime import needed (import would fail: .d.ts files produce no .js output)
const auth_1 = require("./lib/auth");
// login.ts is kept for tests / future headless paths but not called from here.
// See deprecation notice in src/lib/login.ts.
const cameras_1 = require("./lib/cameras");
const live_session_1 = require("./lib/live_session");
const session_watchdog_1 = require("./lib/session_watchdog");
// digestRequest is used for LOCAL RCP writes (HTTPS + Digest auth, Gen2 port 443)
const digest_1 = require("./lib/digest");
const snapshot_1 = require("./lib/snapshot");
const mjpeg_snapshot_1 = require("./lib/mjpeg_snapshot");
const snapshot_server_1 = require("./lib/snapshot_server");
const tls_proxy_1 = require("./lib/tls_proxy");
const fcm_1 = require("./lib/fcm");
const alarm_light_1 = require("./lib/alarm_light");
const maintenance_1 = require("./lib/maintenance");
const mqtt_bridge_1 = require("./lib/mqtt_bridge");
const rcp_lan_helper_1 = require("./lib/rcp_lan_helper");
const cloud_feature_flags_1 = require("./lib/cloud_feature_flags");
// ── Adapter class ─────────────────────────────────────────────────────────────
/**
 *
 */
class BoschSmartHomeCamera extends utils.Adapter {
    /** setTimeout handle for the token refresh re-arm loop (ioBroker.Timeout | null). */
    _refreshTimeout = null;
    /** Current refresh_token (kept in memory to avoid repeated state reads). */
    _currentRefreshToken = null;
    /** Current access_token (kept in memory). */
    _currentAccessToken = null;
    /** Cache: skip DB write when value is unchanged (iobroker.ring upsertState pattern). */
    _stateCache = new Map();
    /** Axios instance shared across all HTTP calls. */
    _httpClient = (0, auth_1.createHttpClient)();
    /** Live sessions keyed by camera ID. Re-opened when stale. */
    _liveSessions = new Map();
    /** TLS proxy handles keyed by camera ID. */
    _tlsProxies = new Map();
    /** Camera metadata keyed by camera ID (populated in onReady from fetchCameras). */
    _cameras = new Map();
    /** FCM push listener (null until onReady wires it up). */
    _fcmListener = null;
    /** RTSP session watchdogs keyed by camera ID. Renew LOCAL sessions before expiry. */
    _sessionWatchdogs = new Map();
    /**
     * Client-side image rotation flag per camera ID.
     * Bosch Cloud API has no rotation endpoint — flag is stored here so
     * downstream callers (snapshot post-processing, UI) can apply 180° transforms.
     */
    _imageRotation = {};
    /**
     * Stream-quality preference per camera ID. v0.5.0 — controls the
     * `highQualityVideo` flag in PUT /v11/video_inputs/{id}/connection.
     * Default "high" (full bitrate). Changing this state forces the next
     * ensureLiveSession() to re-open with the new flag.
     */
    _streamQuality = new Map();
    /**
     * ISO timestamp of the latest processed event per camera.
     * Used by fetchAndProcessEvents() to skip events we've already seen.
     * Keyed by camera ID. float('-inf') equivalent → empty string means "not seen".
     */
    _lastSeenEventId = {};
    /**
     * Count of consecutive snapshot failures per camera ID.
     * Used to flip `online=false` only after a sustained outage, not on the first
     * transient network blip. Reset on every successful snapshot.
     */
    _snapshotFailCount = new Map();
    /** Consecutive snapshot failures before a camera is marked offline. */
    static OFFLINE_THRESHOLD = 3;
    /**
     * Timestamps (Date.now() ms) of recent HTTP 444 session-quota hits per camera.
     * Pruned to _SESSION_QUOTA_WINDOW_MS on each new hit.
     * When ≥ _SESSION_QUOTA_NOTIFY_THRESHOLD hits occur within the window,
     * the `session_limit_hit` DP is set to true and a warn-log is emitted.
     * Cleared when the camera opens a session successfully.
     */
    _sessionLimitHits = new Map();
    static SESSION_QUOTA_WINDOW_MS = 300_000; // 5 minutes
    static SESSION_QUOTA_NOTIFY_THRESHOLD = 3;
    /**
     * v0.9.1: per-(camId,feature) cache for endpoints that responded HTTP 442
     * (feature not supported on this hardware). Eliminates the warn-storm where
     * every privacy_sound_override write to an Outdoor camera produced the same
     * 442 + the same warn log. Once a feature is in this set, subsequent writes
     * and polls return early without any HTTP call.
     */
    _unsupportedFeatures = new Map();
    /**
     * v0.9.1: per-(camId,poll-endpoint) exponential backoff for pollers that
     * receive consistent 444 (Bosch session-quota / "no content for this
     * period"). Without this the WiFi-info poll for offline cameras spammed
     * the debug log every 30 s forever. Sequence: 30s, 60s, 120s, 300s cap.
     * Resets to 30s on first success.
     */
    _pollBackoff = new Map();
    static POLL_BACKOFF_BASE_MS = 30_000;
    static POLL_BACKOFF_CAP_MS = 300_000;
    /**
     * Polling timer for /v11/events when FCM push registration failed.
     * Drives event ingestion without push so motion/audio events still surface.
     * Undefined when FCM is healthy (push is the primary path).
     */
    _eventPollTimer = undefined;
    /** Event-poll interval (ms) when FCM push is unavailable. */
    static EVENT_POLL_INTERVAL_MS = 30_000;
    /**
     * v0.6.2: pending FCM auto-reconnect timer.
     * Armed on the listener's "disconnect" event and walks the backoff array
     * below. Cleared on successful reconnect, on unload, and re-armed on every
     * failed start() retry.
     */
    _fcmReconnectTimer = null;
    /**
     * v0.6.2: current backoff attempt index (0 → 5 s, 1 → 30 s, 2 → 120 s,
     * 3+ → 600 s cap). Reset to 0 on successful reconnect.
     */
    _fcmReconnectAttempt = 0;
    /**
     * v0.6.2: exponential-backoff schedule for FCM auto-reconnect (ms).
     * Last entry is the cap — any attempt beyond this index reuses 600 s.
     * Tuned for Google MTalk server rotation (typically heals in seconds)
     * while keeping log noise bounded if push stays unreachable.
     */
    static FCM_RECONNECT_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000];
    /**
     * Periodic poll of /v11/video_inputs to pick up app-side state changes
     * (privacy toggled via the Bosch app, camera renamed, …). Independent of
     * FCM — runs always so DPs stay accurate even with push healthy.
     * Forum #84538: user set privacy_enabled via ioBroker, toggled it off
     * via the app, ioBroker DP stayed `true` because we only fetched once.
     */
    _statePollTimer = undefined;
    /** Camera-state poll interval (ms). */
    static STATE_POLL_INTERVAL_MS = 30_000;
    /**
     * v0.7.0: periodic timer for cloud maintenance / outage discovery.
     * Fetches Bosch community RSS feeds every hour and surfaces the latest
     * maintenance window in `info.maintenance.*` state objects.
     */
    _maintenanceTimer = undefined;
    /** Maintenance poll interval (ms). */
    static MAINTENANCE_POLL_INTERVAL_MS = 3_600_000; // 1 hour
    /**
     * Last-known maintenance window. Cached here so a transient community-site
     * outage does not destroy the state — we keep the previous value until we
     * get a fresh successful parse.
     */
    _lastMaintenanceWindow = null;
    /**
     * Epoch ms of the last maintenance fetch that actually contacted the
     * community site (successful or 503). Used to enforce a 5-min cooldown
     * on reactive re-fetches triggered by 5xx API responses.
     */
    _maintenanceLastFetchMs = 0;
    /**
     * v0.7.2: dedupe key for maintenance lifecycle notifications.
     * Stores the last `[link, state]` pair we actually fired a notification for.
     * The `past` state only fires when `active` for the same link was previously
     * announced — prevents spam from stale historical windows on adapter restart.
     * null = no notification sent yet this adapter session.
     */
    _maintenanceNotifiedKey = null;
    /**
     * v0.7.2: last-known online/offline status per camera ID.
     * null (missing key) = first observation since adapter start → silent baseline.
     * Transitions involving "unknown" are also silent (transient cloud flap).
     */
    _lastCameraStatus = {};
    /**
     * Sticky TLS-proxy port per camera ID. Set on first proxy start
     * (ephemeral free port from the OS), then reused across session renewals
     * and adapter restarts so external recorders (BlueIris) keep working
     * without re-configuring the URL on every hourly session renewal.
     */
    _stickyProxyPort = new Map();
    /**
     * Remembered upstream LAN address (`<ip>:<port>`) per camera. Used by
     * `upsertSession()` to decide whether a renewed Bosch session points at
     * the same camera (→ keep the proxy + port intact) or at a different
     * address (→ tear down + restart).
     */
    _sessionRemote = new Map();
    /**
     * v0.7.4: last known LAN IP (host only, no port) per camera ID.
     * Seeded at onReady from persisted `cameras.<id>.lan_ip` states so
     * the TCP-ping path has a working address book even before the first
     * successful cloud refresh.
     */
    _lanIpMap = new Map();
    /**
     * v0.7.4: result of the last TCP-connect probe to port 443 per camera.
     * Tuple: [reachable, performance.now()-equivalent via Date.now()].
     */
    _lanReachable = new Map();
    /**
     * v0.7.4: monotonic-style timestamp (Date.now()) of the last
     * `_pingAllCamsDuringOutage` sweep. float(-Infinity) semantics via
     * -Infinity so the first outage tick always runs immediately.
     */
    _lastOutagePingAt = -Infinity;
    /**
     * v0.7.4: timestamp (Date.now()) of the last successful local RCP write
     * per camera. Used by `_inLocalWriteGrace()` to suppress a brief
     * "LAN offline" blip that follows every privacy / light toggle (the
     * camera tears down its HTTPS endpoint while Digest creds rotate, ~5–15 s).
     */
    _localWriteAt = new Map();
    /** v0.7.4: post-write grace window (ms). Mirrors HA's _LOCAL_WRITE_GRACE_S. */
    static LOCAL_WRITE_GRACE_MS = 30_000;
    /**
     * Diagnostic slow-tier: counter incremented on every STATE_POLL_INTERVAL_MS tick.
     * When it reaches SLOW_TIER_THRESHOLD (10), the slow-tier tasks run and it resets.
     * STATE_POLL_INTERVAL_MS=30s × 10 = 300s cadence — mirrors HA's do_slow logic.
     */
    _diagPollTick = 0;
    /** Slow-tier runs every SLOW_TIER_THRESHOLD state-poll ticks (10 × 30s = 300s). */
    static SLOW_TIER_THRESHOLD = 10;
    /**
     * F13: cached cloud feature flags result. Null until first successful fetch.
     * Account-level — one per adapter instance (not per camera).
     */
    _featureFlagsCache = null;
    /** v0.7.4: outage-ping throttle (ms). */
    static OUTAGE_PING_THROTTLE_MS = 30_000;
    /** v0.7.4: TCP-connect timeout for LAN-reachability probe (ms). */
    static LAN_PING_TIMEOUT_MS = 1_500;
    /**
     * Desired siren (panic_alarm) state per Gen2 camera. The Bosch cloud has
     * no GET for this state — the iOS/Android apps keep their own copy and
     * we do the same. Wiped on adapter restart (camera also auto-stops the
     * siren after a hardware-defined timeout, so a stale `true` is fine to
     * forget).
     */
    _sirenState = new Map();
    /**
     * v0.7.10: renewal backoff state per camera. Tracks how many consecutive
     * cloud renewal failures have occurred and when the next retry should fire.
     * Reset to attempt=0 on a successful renewal.
     */
    _renewalBackoff = new Map();
    /**
     * v0.7.10: wall-clock epoch (ms) when the Bosch live session was first opened
     * per camera. Used to detect the 60-min natural session expiry — if the
     * session has been alive for ≥ SESSION_MAX_AGE_MS AND the latest renewal
     * is still failing, we tear down rather than retrying indefinitely.
     */
    _sessionStartTime = new Map();
    /**
     * v0.7.10: consecutive LAN TCP-connect failure count per camera.
     * Incremented in the renewal-retry path when the LAN probe fails.
     * Reset to 0 on a successful TCP connect. Teardown is triggered after
     * LAN_TCP_FAIL_THRESHOLD consecutive failures.
     */
    _lanTcpFailCount = new Map();
    // v1.1.0: per-camera stream generation counter — incremented on every
    // teardown so a backoff-renewal timer scheduled before the teardown bails
    // when it finally fires instead of resurrecting a stream the user stopped.
    // Mirrors HA's _auto_renew_generation guard (the renewal task checks the
    // generation at the top of every iteration, even after the backoff sleep).
    _streamGeneration = new Map();
    /** v0.7.10: exponential backoff steps (ms) for cloud renewal retries. */
    static RENEWAL_BACKOFF_MS = [5_000, 15_000, 45_000, 120_000, 300_000];
    /** v0.7.10: maximum Bosch session lifetime (ms). Matches Bosch 60-min limit. */
    static SESSION_MAX_AGE_MS = 60 * 60 * 1_000;
    /** v0.7.10: LAN TCP failures before stream teardown. */
    static LAN_TCP_FAIL_THRESHOLD = 3;
    /**
     * Cached lighting state per Gen2 camera (frontLight + topLed + bottomLed
     * brightness/color/whiteBalance). Seeded by the state-poll GET on the
     * `/lighting/switch` endpoint and updated from every PUT response. Used
     * to merge incremental DP writes into the full body Bosch requires.
     */
    _lightingCache = new Map();
    // v0.7.14: cached intrusionDetectionConfig body from cloud GET so the
    // user-write handler can merge a single field (sensitivity/distance)
    // into the full body. Bosch rejects DELTA PUTs with HTTP 400.
    _intrusionConfigCache = new Map();
    // v1.0.3: cached /audio body from cloud GET so the audio-level write
    // handler can merge a single field (microphoneLevel/speakerLevel) into
    // the full body. Bosch's /audio PUT requires the FULL body — a partial
    // PUT silently drops the other level (and audioEnabled). Mirrors the
    // intrusionDetectionConfig GET→merge→PUT pattern.
    _audioCache = new Map();
    // v0.8.0: lens elevation cache (Gen2, float 0.5–5.0 m).
    // Seeded by slow-tier GET /lens_elevation poll; used by write handler to confirm value.
    _lensElevationCache = new Map();
    // v0.8.0: global lighting cache (Gen2 Outdoor only) for darkness_threshold.
    // GET /lighting → {"darknessThreshold": 0.47, "softLightFading": bool}.
    // PUT /lighting requires full body — cache holds both fields.
    _globalLightingCache = new Map();
    // v0.8.0: alarm_settings cache (HOME_Eyes_Indoor only).
    // GET /alarm_settings → {alarmDelayInSeconds, alarmActivationDelaySeconds, preAlarmDelayInSeconds, ...}.
    // PUT /alarm_settings requires the full body — cache holds all fields.
    _alarmSettingsCache = new Map();
    // v1.1.0: motion config cache (all cameras).
    // GET /v11/video_inputs/{id}/motion → {enabled, motionAlarmConfiguration, ...}.
    // PUT /motion requires the FULL body — both motion_enabled and
    // motion_sensitivity writes merge into this cached baseline so neither
    // clobbers the other (mirrors _audioCache / _intrusionConfigCache).
    _motionCache = new Map();
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
    _livestreamEnabled = new Map();
    /**
     * v0.7.9: optional MQTT bridge. Null when mqtt_enabled=false.
     * Wired up in onReady, torn down in onUnload.
     */
    _mqttBridge = null;
    /**
     * v0.5.3: pending "idle teardown" timer per camera (livestream OFF mode).
     * After each snapshot the timer is reset; when it finally fires we close
     * the Bosch session + TLS proxy + watchdog. Lets back-to-back
     * snapshot_trigger writes (e.g. a Card opening, an automation polling)
     * reuse the warm session instead of paying the PUT /connection cost
     * every time. Cleared eagerly on _teardownStream, livestream toggle ON,
     * and onUnload.
     */
    // v0.6.0: ioBroker.Timeout (from this.setTimeout) — adapter-core auto-cancels on unload.
    _snapshotIdleTimers = new Map();
    /**
     * Idle window after a snapshot before the session is torn down (ms).
     * Sized to match SESSION_TTL_MS in ensureLiveSession so a snapshot
     * burst within the window always reuses the cached session instead of
     * forcing a fresh `PUT /v11/.../connection`.
     */
    static SNAPSHOT_SESSION_IDLE_MS = 60_000;
    /**
     * v0.5.3: per-camera "motion_active=true" auto-clear timers. When a
     * motion event fires we set motion_active=true; this timer flips it
     * back to false after MOTION_ACTIVE_WINDOW_MS so automations have a
     * clean rising/falling edge to listen on. Re-armed (window slides) on
     * every follow-up event within the window.
     */
    // v0.6.0: ioBroker.Timeout (from this.setTimeout) — adapter-core auto-cancels on unload.
    _motionActiveTimers = new Map();
    /**
     * v1.1.0: latest JPEG per camera, served by the local HTTP snapshot server
     * (started in onReady when snapshot_http_port > 0). Populated wherever a
     * fresh snapshot buffer is fetched; the server only reads from this map.
     */
    _latestSnapshots = new Map();
    /** v1.1.0: HTTP snapshot server handle (undefined when the port is 0/off). */
    _snapshotServer;
    /** v1.1.0: host used to build the public snapshot_url (LAN IP, detected once). */
    _snapshotHost = "127.0.0.1";
    /**
     * How long `cameras.<id>.motion_active` stays true after the last
     * motion event before auto-clearing (ms). Default 90 s, configurable
     * via adapter option `motion_active_window` (10–300 s). Mirrors the HA
     * integration's EVENT_ACTIVE_WINDOW.
     */
    get _motionActiveWindowMs() {
        const cfg = this.config.motion_active_window;
        if (typeof cfg === "number" && cfg >= 10 && cfg <= 300) {
            return cfg * 1000;
        }
        return 90_000; // default
    }
    /**
     *
     * @param options
     */
    constructor(options = {}) {
        super({
            ...options,
            name: "bosch-smart-home-camera",
        });
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
        this.on("message", this.onMessage.bind(this));
    }
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
    async onMessage(obj) {
        if (!obj || typeof obj !== "object") {
            return;
        }
        if (obj.command === "getLoginUrl") {
            const state = await this.getStateAsync("info.login_url");
            const url = typeof state?.val === "string" ? state.val : "";
            if (obj.callback) {
                if (url) {
                    this.sendTo(obj.from, obj.command, { openUrl: url }, obj.callback);
                }
                else {
                    this.sendTo(obj.from, obj.command, {
                        error: "Already logged in or login URL not yet generated. Use 'Reset login' to start a fresh login.",
                    }, obj.callback);
                }
            }
            return;
        }
        if (obj.command === "resetLogin") {
            try {
                // Clear persisted tokens + paste field so a fresh PKCE cycle
                // starts on the next adapter restart.
                await this.setStateAsync("info.access_token", "", true);
                await this.setStateAsync("info.refresh_token", "", true);
                await this.setStateAsync("info.token_expires_at", 0, true);
                await this.setStateAsync("info.pkce_verifier", "", true);
                await this.setStateAsync("info.pkce_state", "", true);
                await this.setStateAsync("info.login_url", "", true);
                await this.setStateAsync("info.connection", false, true);
                await this.setStateAsync("info.connection_status", "logged_out", true);
                try {
                    await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
                        native: { redirect_url: "" },
                    });
                }
                catch {
                    this.log.debug("resetLogin: could not clear redirect_url — non-fatal");
                }
                this._currentAccessToken = null;
                this._currentRefreshToken = null;
                this.log.info("Login state reset — adapter will restart to begin a fresh login.");
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, {
                        result: "ok",
                        message: "Login state cleared. The adapter is restarting.",
                    }, obj.callback);
                }
                // Trigger a restart so onReady re-runs the showLoginUrl path.
                this.terminate("Login reset requested via Admin UI", 11);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.log.error(`resetLogin failed: ${msg}`);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { error: msg }, obj.callback);
                }
            }
            return;
        }
        // v1.1.0: on-demand snapshot for scripts / notification adapters
        // (Telegram, Signal, Pushover, …). This is the standard ioBroker
        // camera-adapter contract: sendTo("bosch-smart-home-camera.0",
        // "snapshot", {camId}, cb) → callback receives a fresh JPEG. camId
        // may be the cloud UUID or the camera name (case-insensitive); when
        // exactly one camera is configured it may be omitted entirely.
        if (obj.command === "snapshot") {
            const reply = (payload) => {
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, payload, obj.callback);
                }
            };
            try {
                const msg = (obj.message ?? {});
                const requested = typeof msg.camId === "string"
                    ? msg.camId
                    : typeof msg.cameraId === "string"
                        ? msg.cameraId
                        : typeof msg.id === "string"
                            ? msg.id
                            : typeof msg.name === "string"
                                ? msg.name
                                : "";
                const camId = this._resolveCameraId(requested);
                if (!camId) {
                    reply({
                        error: requested
                            ? `unknown camera "${requested}" — pass a valid cloud-ID or camera name`
                            : "no camId given and more than one camera configured — pass {camId|name}",
                    });
                    return;
                }
                // Reuse the fully-tested snapshot path (MJPEG fast-path + snap.jpg
                // fallback + session reuse); it populates _latestSnapshots.
                await this.handleSnapshotTrigger(camId);
                const buf = this._latestSnapshots.get(camId);
                if (!buf || buf.length === 0) {
                    reply({ error: `no snapshot available for ${camId.slice(0, 8)}` });
                    return;
                }
                const base64 = buf.toString("base64");
                reply({
                    // `data` (raw Buffer) is what notification adapters such as
                    // telegram accept directly; base64/dataUrl cover the rest.
                    data: buf,
                    mimeType: "image/jpeg",
                    base64,
                    dataUrl: `data:image/jpeg;base64,${base64}`,
                    camId,
                });
            }
            catch (err) {
                const m = err instanceof Error ? err.message : String(err);
                this.log.warn(`sendTo snapshot failed: ${m}`);
                reply({ error: m });
            }
            return;
        }
    }
    /**
     * v1.1.0: resolve a sendTo("snapshot") camera reference to a known cloud
     * UUID. Accepts the exact UUID (case-insensitive), the camera name
     * (case-insensitive), or — when exactly one camera is configured — an
     * empty string. Returns null when it cannot be resolved unambiguously.
     *
     * @param requested cloud-ID, camera name, or "" for the sole camera
     */
    _resolveCameraId(requested) {
        const ids = Array.from(this._cameras.keys());
        if (!requested) {
            return ids.length === 1 ? ids[0] : null;
        }
        const lc = requested.toLowerCase();
        for (const [id, cam] of this._cameras) {
            if (id.toLowerCase() === lc || (cam.name && cam.name.toLowerCase() === lc)) {
                return id;
            }
        }
        return null;
    }
    // ── State helpers ───────────────────────────────────────────────────────
    /**
     * Write a state only if the value changed (iobroker.ring upsertState pattern).
     * Always creates the object if it doesn't exist yet, then sets ack=true.
     *
     * @param id
     * @param value
     */
    async upsertState(id, value) {
        if (this._stateCache.get(id) === value) {
            return;
        }
        // v0.7.15: write FIRST, cache AFTER. Pre-v0.7.15 set the cache
        // before the await; if setStateAsync then failed/rejected, the
        // cache held the new value while the DB still held the old one,
        // and every subsequent upsertState call skipped via the cache
        // short-circuit — the DP was stuck on the stale DB value for
        // the rest of the adapter's lifetime. Sandbox-observed live:
        // privacy_enabled stuck at True with ts frozen for 4+ hours
        // while the state-poll loop kept logging "ON → OFF" every 30 s.
        await this.setStateAsync(id, value, true);
        this._stateCache.set(id, value);
    }
    // ── Object creation ─────────────────────────────────────────────────────
    /** Ensure the info channel + connection/token states exist. */
    async ensureInfoObjects() {
        // info.connection is pre-created via instanceObjects in io-package.json,
        // but we defensively create it here too so tests pass without a full ioBroker host.
        await this.setObjectNotExistsAsync("info", {
            type: "channel",
            common: { name: "Adapter information" },
            native: {},
        });
        // Root "meta" object is required by ioBroker's writeFileAsync() to be able
        // to store binary files under bosch-smart-home-camera.0/<path>. Without it
        // writeFileAsync throws "is not an object of type 'meta'". The object_id
        // must be the full namespace ("bosch-smart-home-camera.0") which is foreign
        // from the adapter's perspective (it manages bosch-smart-home-camera.0.*),
        // hence extendForeignObject. We only set if missing — never clobber.
        try {
            const existing = await this.getForeignObjectAsync(this.namespace);
            if (!existing) {
                await this.setForeignObjectAsync(this.namespace, {
                    type: "meta",
                    common: {
                        name: "Bosch Smart Home Camera adapter data",
                        type: "meta.folder",
                    },
                    native: {},
                });
            }
        }
        catch (err) {
            this.log.warn(`Could not ensure meta object for file storage: ${err.message}`);
        }
        await this.setObjectNotExistsAsync("info.connection", {
            type: "state",
            common: {
                role: "indicator.connected",
                name: "Connected to Bosch cloud",
                type: "boolean",
                read: true,
                write: false,
                def: false,
            },
            native: {},
        });
        // Token states — read-only, user must not edit these.
        // Stored here so they survive adapter restarts without a new login.
        await this.setObjectNotExistsAsync("info.access_token", {
            type: "state",
            common: {
                role: "text",
                name: "OAuth2 access token",
                type: "string",
                read: true,
                write: false,
                def: "",
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("info.refresh_token", {
            type: "state",
            common: {
                role: "text",
                name: "OAuth2 refresh token",
                type: "string",
                read: true,
                write: false,
                def: "",
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("info.token_expires_at", {
            type: "state",
            common: {
                role: "value.time",
                name: "Token expiry (epoch ms)",
                type: "number",
                read: true,
                write: false,
                def: 0,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("info.fcm_active", {
            type: "state",
            common: {
                role: "indicator.status",
                name: "FCM push listener status: healthy / polling / disconnected / error / stub / stopped",
                type: "string",
                read: true,
                write: false,
                def: "stub",
            },
            native: {},
        });
        // PKCE verifier + state stored across restarts so a stale URL still works
        // (regenerated only after successful code exchange or explicit reset).
        await this.setObjectNotExistsAsync("info.pkce_verifier", {
            type: "state",
            common: {
                role: "text",
                name: "PKCE code_verifier (internal — do not share)",
                type: "string",
                read: true,
                write: false,
                def: "",
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("info.pkce_state", {
            type: "state",
            common: {
                role: "text",
                name: "OIDC state parameter (CSRF protection — internal)",
                type: "string",
                read: true,
                write: false,
                def: "",
            },
            native: {},
        });
        // v0.5.4: surface the Bosch OAuth URL as a datapoint so the Admin UI
        // can render it as a clickable link instead of forcing users to fish
        // a 300-char log line out of the Log Inspector (Forum #84538 feedback).
        await this.setObjectNotExistsAsync("info.login_url", {
            type: "state",
            common: {
                role: "url",
                name: "Bosch OAuth login URL — open in browser when set",
                type: "string",
                read: true,
                write: false,
                def: "",
            },
            native: {},
        });
        // v0.5.4: text state for richer connection diagnostics than the boolean
        // info.connection — Blockly / VIS can branch on the specific phase.
        await this.setObjectNotExistsAsync("info.connection_status", {
            type: "state",
            common: {
                role: "indicator.state",
                name: "Adapter login phase (logged_out | awaiting_login | connected | auth_error)",
                type: "string",
                read: true,
                write: false,
                def: "logged_out",
                states: {
                    logged_out: "logged out",
                    awaiting_login: "awaiting login",
                    connected: "connected",
                    auth_error: "auth error",
                },
            },
            native: {},
        });
        // v0.5.4: timestamp of the most recent successful token mint (either
        // fresh PKCE login or silent refresh). Helps users diagnose how stale
        // the refresh_token is — Bosch's offline_access tokens live ~30 days.
        await this.setObjectNotExistsAsync("info.last_login_at", {
            type: "state",
            common: {
                role: "date",
                name: "Timestamp of last successful Bosch token mint (ISO 8601)",
                type: "string",
                read: true,
                write: false,
                def: "",
            },
            native: {},
        });
        // v0.6.0: persisted FCM credentials (ECDH key + ACG creds). Saved on
        // every `registered` event from FcmListener and replayed via
        // `savedCredentials` on next adapter start to avoid a fresh ECDH /
        // ACG / CBS POST roundtrip on every restart.
        await this.setObjectNotExistsAsync("info.fcm_creds", {
            type: "state",
            common: {
                role: "json",
                name: "Persisted FCM credentials (encrypted, sensitive)",
                type: "string",
                read: true,
                write: false,
                def: "",
            },
            native: {},
        });
    }
    // ── Maintenance state objects (v0.7.0) ───────────────────────────────────
    /**
     * Ensure `info.maintenance.*` state objects exist.
     * Called once in onReady before the first maintenance fetch.
     */
    async ensureMaintenanceObjects() {
        await this.setObjectNotExistsAsync("info.maintenance", {
            type: "channel",
            common: { name: "Cloud maintenance / outage status" },
            native: {},
        });
        const states = [
            {
                id: "info.maintenance.state",
                role: "indicator.state",
                name: "Maintenance state (active/scheduled/past/recent/unknown/idle)",
                type: "string",
                def: "idle",
            },
            {
                id: "info.maintenance.title",
                role: "text",
                name: "Maintenance announcement title",
                type: "string",
                def: "",
            },
            {
                id: "info.maintenance.link",
                role: "url",
                name: "Link to the community board post",
                type: "string",
                def: "",
            },
            {
                id: "info.maintenance.scheduled_start",
                role: "date",
                name: "Scheduled maintenance start (ISO 8601 UTC)",
                type: "string",
                def: "",
            },
            {
                id: "info.maintenance.scheduled_end",
                role: "date",
                name: "Scheduled maintenance end (ISO 8601 UTC)",
                type: "string",
                def: "",
            },
            {
                id: "info.maintenance.summary",
                role: "text",
                name: "Short summary from the announcement body",
                type: "string",
                def: "",
            },
            {
                id: "info.maintenance.source",
                role: "text",
                name: "Source feed (rss:Wartungsarbeiten / html:Statusmeldungen / …)",
                type: "string",
                def: "",
            },
            {
                id: "info.maintenance.camera_relevant",
                role: "indicator",
                name: "True if the announcement mentions cameras/video/CBS/cloud",
                type: "boolean",
                def: false,
            },
            {
                id: "info.maintenance.last_fetched",
                role: "date",
                name: "Timestamp of last successful maintenance feed fetch (ISO 8601 UTC)",
                type: "string",
                def: "",
            },
            {
                id: "info.maintenance.last_notification",
                role: "text",
                name: "Last maintenance lifecycle notification (JSON: title + message + state + ts)",
                type: "string",
                def: "",
            },
        ];
        for (const s of states) {
            await this.setObjectNotExistsAsync(s.id, {
                type: "state",
                common: {
                    role: s.role,
                    name: s.name,
                    type: s.type,
                    read: true,
                    write: false,
                    def: s.def,
                },
                native: {},
            });
        }
    }
    /**
     * Fetch maintenance status, update `_lastMaintenanceWindow`, and write all
     * `info.maintenance.*` state objects atomically.
     *
     * If the community site is unreachable (fetchMaintenance returns null), the
     * previous cached window is kept — the states are NOT overwritten with idle/empty
     * values, because a transient community outage should not destroy a known
     * maintenance state.
     */
    async _refreshMaintenanceStatus() {
        this._maintenanceLastFetchMs = Date.now();
        try {
            const mw = await (0, maintenance_1.fetchMaintenance)();
            if (mw !== null) {
                this._lastMaintenanceWindow = mw;
            }
            const active = this._lastMaintenanceWindow;
            const state = active !== null ? (0, maintenance_1.classifyState)(active) : "idle";
            await Promise.all([
                this.upsertState("info.maintenance.state", state),
                this.upsertState("info.maintenance.title", active?.title ?? ""),
                this.upsertState("info.maintenance.link", active?.link ?? ""),
                this.upsertState("info.maintenance.scheduled_start", active?.scheduled_start ?? ""),
                this.upsertState("info.maintenance.scheduled_end", active?.scheduled_end ?? ""),
                this.upsertState("info.maintenance.summary", active?.summary ?? ""),
                this.upsertState("info.maintenance.source", active?.source ?? ""),
                this.upsertState("info.maintenance.camera_relevant", active?.camera_relevant ?? false),
                this.upsertState("info.maintenance.last_fetched", active !== null ? new Date().toISOString() : ""),
            ]);
            this.log.debug(`Maintenance status: state=${state}${active ? ` source=${active.source} title="${active.title.slice(0, 60)}"` : ""}`);
            // v0.7.10: mirror maintenance state to per-camera DPs as "active" | "scheduled" | "none"
            const perCamState = state === "active" ? "active" : state === "scheduled" ? "scheduled" : "none";
            for (const camId of this._cameras.keys()) {
                void this.upsertState(`cameras.${camId}.maintenance_state`, perCamState).catch(() => undefined);
            }
            // v0.7.2: lifecycle notifications (scheduled → active → past)
            if (active !== null) {
                await this._maybeAnnounceMaintenanceState(active, state);
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.debug(`Maintenance fetch error (non-fatal): ${msg}`);
        }
    }
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
    async _maybeAnnounceMaintenanceState(mw, state) {
        if (!mw.camera_relevant) {
            return;
        }
        if (state !== "scheduled" && state !== "active" && state !== "past") {
            return;
        }
        // `past` only announces when we already announced `active` for this link.
        // Suppresses stale past-window discovery (e.g. adapter restart after window closed).
        if (state === "past") {
            const prior = this._maintenanceNotifiedKey;
            if (prior === null || prior[0] !== mw.link || prior[1] !== "active") {
                this._maintenanceNotifiedKey = [mw.link, state];
                return;
            }
        }
        const notifyKey = [mw.link, state];
        if (this._maintenanceNotifiedKey !== null &&
            this._maintenanceNotifiedKey[0] === notifyKey[0] &&
            this._maintenanceNotifiedKey[1] === notifyKey[1]) {
            return;
        }
        const verbMap = {
            scheduled: "geplant",
            active: "läuft",
            past: "beendet",
        };
        const verb = verbMap[state] ?? state;
        const title = `Bosch Cloud-Wartung ${verb}`;
        let when = "";
        if (mw.scheduled_start !== null && mw.scheduled_end !== null) {
            try {
                const startMs = new Date(mw.scheduled_start).getTime();
                const endMs = new Date(mw.scheduled_end).getTime();
                // Format as Europe/Berlin (approximate: just use ISO local-time slices)
                const fmt = (ms) => new Date(ms)
                    .toLocaleString("de-DE", {
                    timeZone: "Europe/Berlin",
                    hour: "2-digit",
                    minute: "2-digit",
                    weekday: "short",
                    day: "2-digit",
                    month: "2-digit",
                })
                    .replace(",", "");
                when = `${fmt(startMs)}–${new Date(endMs).toLocaleString("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" })}`;
            }
            catch {
                when = "";
            }
        }
        const bodyParts = [mw.title || "Wartungsmeldung"];
        if (when) {
            bodyParts.push(when);
        }
        if (state === "active") {
            bodyParts.push("Live-Bild und Snapshots ggf. eingeschränkt.");
        }
        else if (state === "past") {
            bodyParts.push("Cloud-Dienste sollten wieder normal funktionieren.");
        }
        if (mw.link) {
            bodyParts.push(mw.link);
        }
        const message = bodyParts.join("\n");
        this.log.info(`[maintenance] ${title}: ${message.split("\n")[0]}`);
        try {
            const payload = JSON.stringify({ title, message, state, ts: new Date().toISOString() });
            await this.upsertState("info.maintenance.last_notification", payload);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.debug(`Maintenance notification DP write failed (non-fatal): ${msg}`);
        }
        this._maintenanceNotifiedKey = notifyKey;
    }
    /**
     * Start the hourly maintenance poll.
     * Idempotent — a second call while the timer is already armed is a no-op.
     */
    _startMaintenancePolling() {
        if (this._maintenanceTimer) {
            return;
        }
        const timer = this.setInterval(() => {
            void this._refreshMaintenanceStatus().catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                this.log.debug(`Maintenance poll tick error: ${msg}`);
            });
        }, BoschSmartHomeCamera.MAINTENANCE_POLL_INTERVAL_MS);
        this._maintenanceTimer = timer;
    }
    /**
     * Reactive maintenance re-fetch triggered by a 5xx response on a cloud API call.
     *
     * Enforces a 5-minute cooldown so a sustained cloud outage (which causes every
     * camera state-poll to 5xx) doesn't hammer the community RSS feeds once per 30 s.
     */
    _triggerMaintenanceFetchOn5xx() {
        const COOLDOWN_MS = 5 * 60_000;
        if (Date.now() - this._maintenanceLastFetchMs < COOLDOWN_MS) {
            return;
        }
        void this._refreshMaintenanceStatus().catch(() => undefined);
    }
    // ── Secret encryption (v0.6.0) ───────────────────────────────────────────
    // Sensitive states (access_token, refresh_token, pkce_verifier, pkce_state,
    // fcm_creds) are wrapped with the ioBroker system secret. Stored values
    // start with the SECRET_PREFIX so legacy plaintext entries from <=v0.5.x
    // can be detected, decrypted in-place once, and overwritten on first read.
    static SECRET_PREFIX = "__enc__";
    _encryptSecret(plain) {
        if (!plain) {
            return "";
        }
        // adapter-core provides this.encrypt at runtime; the unit-test
        // MockAdapter omits it, so fall back to a plaintext pass-through there.
        // Production always has it (verified by integration test).
        const encrypt = this.encrypt;
        if (typeof encrypt !== "function") {
            return plain;
        }
        return BoschSmartHomeCamera.SECRET_PREFIX + encrypt.call(this, plain);
    }
    _decryptSecret(stored) {
        if (typeof stored !== "string" || stored === "") {
            return "";
        }
        if (stored.startsWith(BoschSmartHomeCamera.SECRET_PREFIX)) {
            const decrypt = this.decrypt;
            if (typeof decrypt !== "function") {
                // Test-mode pass-through; production never reaches this branch.
                return stored.slice(BoschSmartHomeCamera.SECRET_PREFIX.length);
            }
            try {
                return decrypt.call(this, stored.slice(BoschSmartHomeCamera.SECRET_PREFIX.length));
            }
            catch (err) {
                this.log.warn(`Could not decrypt persisted secret — discarding stale ciphertext (${err instanceof Error ? err.message : String(err)})`);
                return "";
            }
        }
        // Legacy plaintext from <=v0.5.x — return as-is so the adapter keeps
        // working on first run; the next write (saveTokens / showLoginUrl)
        // will overwrite the state with the encrypted form.
        return stored;
    }
    /**
     * One-shot migration for users upgrading from <=v0.5.x: re-encrypt any
     * plaintext token / PKCE secret found in state storage and overwrite the
     * state with the AES-wrapped form. Idempotent — already-encrypted values
     * are skipped.
     */
    async _migrateLegacySecrets() {
        const sensitiveIds = [
            "info.access_token",
            "info.refresh_token",
            "info.pkce_verifier",
            "info.pkce_state",
        ];
        let migrated = 0;
        for (const id of sensitiveIds) {
            try {
                const st = await this.getStateAsync(id);
                const val = typeof st?.val === "string" ? st.val : "";
                if (val && !val.startsWith(BoschSmartHomeCamera.SECRET_PREFIX)) {
                    await this.setStateAsync(id, this._encryptSecret(val), true);
                    migrated++;
                }
            }
            catch {
                // State does not exist yet (fresh install) — skip silently.
            }
        }
        if (migrated > 0) {
            this.log.info(`v0.6.0: migrated ${migrated} legacy plaintext secret state${migrated === 1 ? "" : "s"} to encrypted storage`);
        }
    }
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
    async _migrateWifiSignalDp(cameras) {
        let removed = 0;
        for (const cam of cameras) {
            const fullId = `cameras.${cam.id}.wifi_signal_strength`;
            try {
                const obj = await this.getObjectAsync(fullId);
                if (obj) {
                    await this.delObjectAsync(fullId);
                    removed++;
                    this.log.info(`v0.7.14 migration: removed mislabelled DP ${fullId} ` +
                        `(was "dBm" but always received percent; use wifi_signal_pct)`);
                }
            }
            catch {
                // ignore
            }
        }
        if (removed > 0) {
            this.log.info(`v0.7.14 migration: removed ${removed} obsolete wifi_signal_strength DP(s)`);
        }
    }
    async _migrateLightDps(cameras) {
        const LIGHT_DPS = ["light_enabled", "front_light_enabled", "wallwasher_enabled"];
        let removed = 0;
        for (const cam of cameras) {
            if (cam.generation !== 2 || cam.featureLight === true) {
                continue; // Gen1 always has light; Gen2 with light=true keeps DPs
            }
            for (const dp of LIGHT_DPS) {
                const fullId = `cameras.${cam.id}.${dp}`;
                try {
                    const obj = await this.getObjectAsync(fullId);
                    if (obj) {
                        await this.delObjectAsync(fullId);
                        removed++;
                        this.log.info(`v0.7.6 migration: removed obsolete DP ${fullId} (Indoor II has no light hardware)`);
                    }
                }
                catch {
                    // Object may not exist — ignore silently
                }
            }
        }
        if (removed > 0) {
            this.log.info(`v0.7.6 migration: removed ${removed} orphaned light DP(s) from Gen2 no-light camera(s)`);
        }
    }
    /**
     * Read + decrypt + JSON-parse the persisted FCM credentials. Returns null
     * if the state is empty, the ciphertext is unusable, or the payload is
     * not the expected shape — the caller falls back to a fresh registration.
     */
    async _loadSavedFcmCredentials() {
        try {
            const st = await this.getStateAsync("info.fcm_creds");
            const plain = this._decryptSecret(st?.val);
            if (!plain) {
                return null;
            }
            // Use a loose type for JSON parse so we can handle legacy "ios" mode
            // stored before v0.6.1 (back-compat migration — no re-registration needed).
            const parsedRaw = JSON.parse(plain);
            const rawMode = parsedRaw.mode;
            if (typeof parsedRaw.fcmToken === "string" &&
                parsedRaw.fcmToken.length > 0 &&
                // Accept legacy "ios" mode from creds stored before v0.6.1 cleanup;
                // treat as "android" on rehydration — functional behaviour is identical.
                (rawMode === "ios" || rawMode === "android") &&
                parsedRaw.raw &&
                typeof parsedRaw.raw === "object") {
                if (rawMode === "ios") {
                    // Legacy creds migration: rewrite to android so subsequent saves
                    // use the current type (no functional re-registration needed).
                    parsedRaw.mode = "android";
                    parsedRaw.raw.mode = "android";
                }
                this.log.debug("Replaying persisted FCM credentials — skipping fresh registration");
                return parsedRaw;
            }
            return null;
        }
        catch (err) {
            this.log.debug(`Persisted FCM credentials not usable (${err instanceof Error ? err.message : String(err)}) — fresh registration`);
            return null;
        }
    }
    /**
     * Encrypt + persist FCM credentials so the next adapter start can replay
     * them as `savedCredentials`. JSON-stringify so the FcmRawCredentials blob
     * (ECDH key + ACG id/token + auth secret) round-trips intact.
     *
     * @param creds
     */
    async _saveFcmCredentials(creds) {
        const payload = JSON.stringify(creds);
        await this.setStateAsync("info.fcm_creds", this._encryptSecret(payload), true);
    }
    /**
     * Create the cameras device + one channel per camera.
     * Uses setObjectNotExistsAsync to preserve user history config.
     *
     * @param cameras
     */
    async ensureCameraObjects(cameras) {
        // Top-level "cameras" device
        await this.setObjectNotExistsAsync("cameras", {
            type: "device",
            common: { name: "Bosch cameras" },
            native: {},
        });
        for (const cam of cameras) {
            const prefix = `cameras.${cam.id}`;
            // Channel per camera
            await this.setObjectNotExistsAsync(prefix, {
                type: "channel",
                common: { name: cam.name },
                native: {},
            });
            await this.setObjectNotExistsAsync(`${prefix}.name`, {
                type: "state",
                common: {
                    role: "text",
                    name: "Camera name",
                    type: "string",
                    read: true,
                    write: false,
                },
                native: {},
            });
            await this.setObjectNotExistsAsync(`${prefix}.firmware_version`, {
                type: "state",
                common: {
                    role: "text",
                    name: "Firmware version",
                    type: "string",
                    read: true,
                    write: false,
                },
                native: {},
            });
            await this.setObjectNotExistsAsync(`${prefix}.hardware_version`, {
                type: "state",
                common: {
                    role: "text",
                    name: "Hardware version / model",
                    type: "string",
                    read: true,
                    write: false,
                },
                native: {},
            });
            await this.setObjectNotExistsAsync(`${prefix}.generation`, {
                type: "state",
                common: {
                    role: "value",
                    name: "Camera generation (1 or 2)",
                    type: "number",
                    read: true,
                    write: false,
                },
                native: {},
            });
            await this.setObjectNotExistsAsync(`${prefix}.online`, {
                type: "state",
                common: {
                    role: "indicator.connected",
                    name: "Camera online",
                    type: "boolean",
                    read: true,
                    write: false,
                    def: false,
                },
                native: {},
            });
            // v0.8.0: session_limit_hit — true when Bosch returns HTTP 444
            // (too many simultaneous live sessions). Auto-clears after ~5 min
            // without further 444 hits. NOT the same as offline (camera reachable).
            await this.setObjectNotExistsAsync(`${prefix}.session_limit_hit`, {
                type: "state",
                common: {
                    role: "indicator.alarm",
                    name: "Session limit hit (HTTP 444 — too many concurrent sessions)",
                    type: "boolean",
                    read: true,
                    write: false,
                    def: false,
                },
                native: {},
            });
            // Writable states — user commands
            await this.setObjectNotExistsAsync(`${prefix}.privacy_enabled`, {
                type: "state",
                common: {
                    name: "Privacy mode (camera dark)",
                    role: "switch",
                    type: "boolean",
                    read: true,
                    write: true,
                    def: false,
                },
                native: {},
            });
            // v1.1.0: push-notification on/off (all cameras, cloud-only — works
            // even when the camera is offline). PUT /enable_notifications
            // {enabledNotificationsStatus: FOLLOW_CAMERA_SCHEDULE|ALWAYS_OFF}.
            // Read mirrored from the listing field notificationsEnabledStatus.
            // Mirrors HA BoschNotificationsSwitch.
            await this.setObjectNotExistsAsync(`${prefix}.notifications_enabled`, {
                type: "state",
                common: {
                    name: "Push notifications (Bosch app) on/off",
                    role: "switch",
                    type: "boolean",
                    read: true,
                    write: true,
                    def: true,
                },
                native: {},
            });
            // v1.1.0: motion detection on/off (all cameras). PUT /motion
            // {enabled, motionAlarmConfiguration} — full body merged via
            // _motionCache. Privacy-blocked on Gen2 Indoor (HTTP 443).
            // Mirrors HA BoschMotionEnabledSwitch.
            await this.setObjectNotExistsAsync(`${prefix}.motion_enabled`, {
                type: "state",
                common: {
                    name: "Motion detection on/off",
                    role: "switch",
                    type: "boolean",
                    read: true,
                    write: true,
                    def: true,
                },
                native: {},
            });
            // v1.1.0: motion sensitivity select. Shares PUT /motion with
            // motion_enabled (full body via _motionCache). API enum values are
            // the upper-cased option keys. Mirrors HA BoschMotionSensitivitySelect.
            await this.setObjectNotExistsAsync(`${prefix}.motion_sensitivity`, {
                type: "state",
                common: {
                    name: "Motion sensitivity",
                    role: "level.mode",
                    type: "string",
                    read: true,
                    write: true,
                    def: "high",
                    states: {
                        super_high: "Super high",
                        high: "High",
                        medium_high: "Medium high",
                        medium_low: "Medium low",
                        low: "Low",
                        off: "Off",
                    },
                },
                native: {},
            });
            // v0.7.6: gate light DPs on featureLight — Indoor II (Gen2, no LEDs)
            // must not get DPs that can never work. Gen1 always has light hardware
            // (lighting_override endpoint); Gen2 only when featureSupport.light=true.
            const hasLight = cam.generation < 2 ? true : cam.featureLight === true;
            if (hasLight) {
                await this.setObjectNotExistsAsync(`${prefix}.light_enabled`, {
                    type: "state",
                    common: {
                        name: "Camera light (legacy — toggles both front_light + wallwasher)",
                        role: "switch.light",
                        type: "boolean",
                        read: true,
                        write: true,
                        def: false,
                    },
                    native: {},
                });
                // v0.4.0: separate front light + wallwasher datapoints so external
                // sensors (dusk script, motion → wallwasher-only, etc.) can drive
                // each light source individually. Mirrors Bosch's own /lighting_override
                // (Gen1) and /lighting/switch/{front,topdown} (Gen2) split.
                await this.setObjectNotExistsAsync(`${prefix}.front_light_enabled`, {
                    type: "state",
                    common: {
                        name: "Front spotlight (Gen1 frontLight / Gen2 front)",
                        role: "switch.light",
                        type: "boolean",
                        read: true,
                        write: true,
                        def: false,
                    },
                    native: {},
                });
                await this.setObjectNotExistsAsync(`${prefix}.wallwasher_enabled`, {
                    type: "state",
                    common: {
                        name: "Wallwasher / top-down LED strip (Gen1 wallwasher / Gen2 topdown)",
                        role: "switch.light",
                        type: "boolean",
                        read: true,
                        write: true,
                        def: false,
                    },
                    native: {},
                });
            }
            // v0.5.1: integrated 75 dB siren (Gen2 only). Backed by
            // PUT /v11/video_inputs/{id}/panic_alarm body {"status": "ON"|"OFF"} (204).
            // Stateful — siren keeps blaring until OFF is sent. The Bosch
            // cloud has no GET for this state, so the DP reflects the
            // adapter's last write (cleared on restart).
            if (cam.generation >= 2) {
                await this.setObjectNotExistsAsync(`${prefix}.siren_active`, {
                    type: "state",
                    common: {
                        name: "Siren (75 dB panic alarm) — write true to trigger, false to silence",
                        role: "switch",
                        type: "boolean",
                        read: true,
                        write: true,
                        def: false,
                    },
                    native: {},
                });
            }
            // v0.7.8: pan control — Gen1 360° Indoor only (CAMERA_360, panLimit > 0).
            // Presets: home(0°) / left(-60°) / right(+60°) / back-left(-120°) / back-right(+120°).
            // API: PUT /v11/video_inputs/{id}/pan  body {absolutePosition: int}
            if (cam.panLimit > 0) {
                await this.setObjectNotExistsAsync(`${prefix}.pan_position`, {
                    type: "state",
                    common: {
                        name: `Pan position in degrees (range: -${cam.panLimit} to +${cam.panLimit})`,
                        role: "value.angle",
                        type: "number",
                        min: -cam.panLimit,
                        max: cam.panLimit,
                        unit: "°",
                        read: true,
                        write: true,
                        def: 0,
                    },
                    native: {},
                });
                await this.setObjectNotExistsAsync(`${prefix}.pan_preset`, {
                    type: "state",
                    common: {
                        name: "Pan preset: home (0°) / left (-60°) / right (+60°) / back-left (-120°) / back-right (+120°)",
                        role: "text",
                        type: "string",
                        states: {
                            home: "home (0°)",
                            left: "left (-60°)",
                            right: "right (+60°)",
                            "back-left": "back-left (-120°)",
                            "back-right": "back-right (+120°)",
                        },
                        read: true,
                        write: true,
                        def: "home",
                    },
                    native: {},
                });
            }
            // v0.5.1: Gen2 RGB lighting (Eyes Outdoor II + Indoor II) — backed
            // by PUT /v11/video_inputs/{id}/lighting/switch. The user-facing
            // "wallwasher" concept maps to top+bottom LED groups together
            // (front spotlight has white-balance only, no RGB).
            //   wallwasher_color      — string  "#RRGGBB" or "" (= white-balance)
            //   wallwasher_brightness — number  0..100
            // Gated on featureSupport.light so cams without the multi-LED rig
            // don't get useless DPs.
            if (cam.generation >= 2 && cam.featureLight === true) {
                await this.setObjectNotExistsAsync(`${prefix}.wallwasher_color`, {
                    type: "state",
                    common: {
                        name: "Wallwasher RGB colour (Gen2 top+bottom LEDs) — HEX, empty = white",
                        role: "level.color.rgb",
                        type: "string",
                        read: true,
                        write: true,
                        def: "",
                    },
                    native: {},
                });
                await this.setObjectNotExistsAsync(`${prefix}.wallwasher_brightness`, {
                    type: "state",
                    common: {
                        name: "Wallwasher brightness (Gen2 top+bottom LEDs) 0..100",
                        role: "level.brightness",
                        type: "number",
                        min: 0,
                        max: 100,
                        unit: "%",
                        read: true,
                        write: true,
                        def: 0,
                    },
                    native: {},
                });
            }
            // Indoor-only in practice — created for all cameras; can be filtered later by generation/hardwareVersion
            await this.setObjectNotExistsAsync(`${prefix}.image_rotation_180`, {
                type: "state",
                common: {
                    name: "Image rotated 180° (ceiling mount)",
                    role: "switch",
                    type: "boolean",
                    read: true,
                    write: true,
                    def: false,
                },
                native: {},
            });
            await this.setObjectNotExistsAsync(`${prefix}.snapshot_trigger`, {
                type: "state",
                common: {
                    name: "Trigger snapshot refresh (write true to fetch new)",
                    role: "button",
                    type: "boolean",
                    read: false,
                    write: true,
                    def: false,
                },
                native: {},
            });
            // v0.4.0: synthetic motion trigger — lets external sensors (Hue, etc.)
            // inject a motion event so automations listening for Bosch motion fire
            // without waiting for the real Bosch FCM push.
            // Forum reference: ioBroker forum #84538 (Jaschkopf).
            //
            // IMPORTANT: this only updates ioBroker DPs (`last_motion_at`,
            // `last_motion_event_type`). It does NOT cause a recording in the
            // Bosch app — the camera's cloud-side motion engine decides when
            // to record and we have no API to inject that. Forum #84538 post 10.
            await this.setObjectNotExistsAsync(`${prefix}.motion_trigger`, {
                type: "state",
                common: {
                    name: "Inject synthetic motion event for ioBroker automations " +
                        "(updates last_motion_at — does NOT create a Bosch-app recording)",
                    role: "button",
                    type: "boolean",
                    read: false,
                    write: true,
                    def: false,
                },
                native: {},
            });
            await this.setObjectNotExistsAsync(`${prefix}.motion_trigger_event_type`, {
                type: "state",
                common: {
                    name: "Event type for synthetic motion trigger",
                    role: "text",
                    type: "string",
                    read: true,
                    write: true,
                    def: "motion",
                    states: {
                        motion: "motion",
                        person: "person",
                        audio_alarm: "audio_alarm",
                    },
                },
                native: {},
            });
            await this.setObjectNotExistsAsync(`${prefix}.snapshot_path`, {
                type: "state",
                common: {
                    name: "Path to last fetched snapshot JPEG (in adapter data folder)",
                    role: "text.url",
                    type: "string",
                    read: true,
                    write: false,
                    def: "",
                },
                native: {},
            });
            // v1.1.0: HTTP snapshot URL with role "url.cam" — the ioBroker
            // type-detector recognises a state with this role as a camera, and
            // VIS camera/image widgets render it directly. Populated only when
            // the local snapshot HTTP server is enabled (snapshot_http_port > 0);
            // stays "" otherwise so consumers can tell the feature is off.
            await this.setObjectNotExistsAsync(`${prefix}.snapshot_url`, {
                type: "state",
                common: {
                    name: "HTTP URL of the latest snapshot (for VIS / url.cam consumers)",
                    role: "url.cam",
                    type: "string",
                    read: true,
                    write: false,
                    def: "",
                },
                native: {},
            });
            await this.setObjectNotExistsAsync(`${prefix}.stream_url`, {
                type: "state",
                common: {
                    name: "Local RTSP URL for RTSPS stream (copy into go2rtc / iobroker.cameras)",
                    role: "text.url",
                    type: "string",
                    read: true,
                    write: false,
                    def: "",
                },
                native: {},
            });
            // v0.5.2: explicit on/off switch for the continuous RTSP livestream.
            // Default OFF so adapter start never auto-opens long-running Bosch
            // sessions (each open session counts against the daily LOCAL quota
            // and keeps the TLS proxy + RTSP watchdog running 24/7). Set true
            // to start streaming; set false to tear down the proxy/watchdog
            // and free the Bosch session. Snapshots work regardless — they
            // open a short-lived session that closes right after the JPEG.
            await this.setObjectNotExistsAsync(`${prefix}.livestream_enabled`, {
                type: "state",
                common: {
                    name: "Continuous RTSP livestream — write true to start, false to stop (default OFF)",
                    role: "switch.enable",
                    type: "boolean",
                    read: true,
                    write: true,
                    def: false,
                },
                native: {},
            });
            // v0.5.0: stream quality preference. Toggling this state closes the
            // current LOCAL session and opens a new one with the matching
            // highQualityVideo flag — useful for mobile dashboards / metered
            // links where the full-bitrate primary stream wastes bandwidth.
            await this.setObjectNotExistsAsync(`${prefix}.stream_quality`, {
                type: "state",
                common: {
                    name: "Stream quality: high (full bitrate) / low (bandwidth saver)",
                    role: "level.mode",
                    type: "string",
                    read: true,
                    write: true,
                    def: "high",
                    states: {
                        high: "High (full bitrate)",
                        low: "Low (bandwidth saver)",
                    },
                },
                native: {},
            });
            await this.setObjectNotExistsAsync(`${prefix}.last_motion_at`, {
                type: "state",
                common: {
                    name: "Timestamp of last motion/person/audio event (ISO 8601)",
                    role: "value.time",
                    type: "string",
                    read: true,
                    write: false,
                    def: "",
                },
                native: {},
            });
            await this.setObjectNotExistsAsync(`${prefix}.last_motion_event_type`, {
                type: "state",
                common: {
                    name: "Type of last event: motion / person / audio_alarm",
                    role: "text",
                    type: "string",
                    read: true,
                    write: false,
                    def: "",
                },
                native: {},
            });
            // v0.5.3: edge-trigger boolean for automations. Goes true on every
            // motion/person/audio_alarm event and auto-clears after
            // _motionActiveWindowMs (default 90 s, configurable via
            // motion_active_window option) so Blockly etc. can listen for
            // the rising edge instead of having to diff timestamps.
            await this.setObjectNotExistsAsync(`${prefix}.motion_active`, {
                type: "state",
                common: {
                    name: "True while a motion/person/audio event is recent (auto-clears after configured window, default 90 s)",
                    role: "sensor.motion",
                    type: "boolean",
                    read: true,
                    write: false,
                    def: false,
                },
                native: {},
            });
            // v0.5.3: base64 JPEG of the snapshot taken right when motion fired.
            // Use this for Telegram/Signal/Matrix push pipelines that consume
            // a base64 image directly — no need to read the file store.
            // String length can reach ~150 kB; ioBroker handles that fine.
            await this.setObjectNotExistsAsync(`${prefix}.last_event_image`, {
                type: "state",
                common: {
                    name: "Base64-encoded JPEG fetched on the last motion event (for Telegram/Signal/Matrix push)",
                    role: "text",
                    type: "string",
                    read: true,
                    write: false,
                    def: "",
                },
                native: {},
            });
            // v0.5.3: timestamp matching last_event_image, so consumers can
            // tell whether the base64 buffer is the current event's snap or
            // a leftover from an earlier event when auto-snapshot was off.
            await this.setObjectNotExistsAsync(`${prefix}.last_event_image_at`, {
                type: "state",
                common: {
                    name: "Timestamp of the JPEG in last_event_image (ISO 8601)",
                    role: "value.time",
                    type: "string",
                    read: true,
                    write: false,
                    def: "",
                },
                native: {},
            });
            // v0.5.3: dual-stream — sub-stream URL via inst=2 (CPP6 firmware
            // serves up to 4 video instances per encoder; Bosch cameras
            // typically expose inst=1 (main, high bitrate) + inst=2 (sub,
            // lower bitrate). Experimental: if your camera firmware doesn't
            // serve inst=2, the URL returns RTSP SETUP error and BlueIris/
            // Frigate just won't connect — main stream is unaffected.
            await this.setObjectNotExistsAsync(`${prefix}.stream_url_sub`, {
                type: "state",
                common: {
                    name: "Sub-stream RTSP URL (inst=2, lower bitrate) — experimental, depends on camera firmware",
                    role: "text.url",
                    type: "string",
                    read: true,
                    write: false,
                    def: "",
                },
                native: {},
            });
            // v0.7.2: last online/offline notification payload (JSON string).
            // Hookable via Blockly on-change triggers for push notifications.
            await this.setObjectNotExistsAsync(`${prefix}.last_status_notification`, {
                type: "state",
                common: {
                    name: "Last camera online/offline notification (JSON: title + message + status + ts)",
                    role: "text",
                    type: "string",
                    read: true,
                    write: false,
                    def: "",
                },
                native: {},
            });
            // v0.7.4: LAN IP + reachability (always readable, survives cloud outage).
            await this.setObjectNotExistsAsync(`${prefix}.lan_ip`, {
                type: "state",
                common: {
                    name: "Last known LAN IP of camera (persisted for offline fallback)",
                    role: "text",
                    type: "string",
                    read: true,
                    write: false,
                    def: "",
                },
                native: {},
            });
            await this.setObjectNotExistsAsync(`${prefix}.lan_reachable`, {
                type: "state",
                common: {
                    name: "LAN reachability — TCP-connect port 443 (always available, honors grace period)",
                    role: "indicator.connected",
                    type: "boolean",
                    read: true,
                    write: false,
                    def: false,
                },
                native: {},
            });
            // v0.7.10: per-camera maintenance state from global RSS poll.
            await this.setObjectNotExistsAsync(`${prefix}.maintenance_state`, {
                type: "state",
                common: {
                    name: "Bosch cloud maintenance state — 'active' | 'scheduled' | 'none'",
                    role: "text",
                    type: "string",
                    read: true,
                    write: false,
                    def: "none",
                },
                native: {},
            });
            // v0.7.7: audio-level DPs (Gen2 only — microphone + speaker present
            // on both Eyes Outdoor II and Eyes Indoor II).
            if (cam.generation >= 2) {
                await this.setObjectNotExistsAsync(`${prefix}.microphone_level`, {
                    type: "state",
                    common: {
                        name: "Microphone sensitivity 0–100 (Gen2) — write to change",
                        role: "level",
                        type: "number",
                        min: 0,
                        max: 100,
                        read: true,
                        write: true,
                        def: 50,
                    },
                    native: {},
                });
                await this.setObjectNotExistsAsync(`${prefix}.speaker_level`, {
                    type: "state",
                    common: {
                        name: "Speaker volume 0–100 (Gen2) — write to change",
                        role: "level.volume",
                        type: "number",
                        min: 0,
                        max: 100,
                        read: true,
                        write: true,
                        def: 50,
                    },
                    native: {},
                });
            }
            // v0.7.7: intrusion detection DPs (Gen2 only).
            if (cam.generation >= 2) {
                await this.setObjectNotExistsAsync(`${prefix}.intrusion_sensitivity`, {
                    type: "state",
                    common: {
                        name: "Intrusion detection sensitivity 0–7 (Gen2) — write to change",
                        role: "level",
                        type: "number",
                        min: 0,
                        max: 7,
                        read: true,
                        write: true,
                        def: 3,
                    },
                    native: {},
                });
                await this.setObjectNotExistsAsync(`${prefix}.intrusion_distance`, {
                    type: "state",
                    common: {
                        name: "Intrusion detection distance 1–8 m (Gen2) — write to change",
                        role: "level",
                        type: "number",
                        min: 1,
                        max: 8,
                        unit: "m",
                        read: true,
                        write: true,
                        def: 5,
                    },
                    native: {},
                });
            }
            // v0.7.7: WiFi info DPs (read-only, refreshed from cloud poll).
            // v0.7.14: Bosch API returns `signalStrength` as percent 0-100,
            // NOT dBm — the dBm-labelled DP was wrong from v0.7.7 onward.
            // Old `wifi_signal_strength` (mislabelled "dBm") is no longer
            // written; migration block below removes it from existing instances.
            await this.setObjectNotExistsAsync(`${prefix}.wifi_ssid`, {
                type: "state",
                common: {
                    name: "WiFi SSID",
                    role: "text",
                    type: "string",
                    read: true,
                    write: false,
                    def: "",
                },
                native: {},
            });
            await this.setObjectNotExistsAsync(`${prefix}.wifi_signal_pct`, {
                type: "state",
                common: {
                    name: "WiFi signal strength percentage 0–100",
                    role: "value.signal",
                    type: "number",
                    min: 0,
                    max: 100,
                    unit: "%",
                    read: true,
                    write: false,
                    def: 0,
                },
                native: {},
            });
            // v0.8.0: lens elevation (Gen2 only, float 0.5–5.0 m).
            // Controls perspective correction in person/intrusion detection.
            // GET/PUT /v11/video_inputs/{id}/lens_elevation → {"elevation": float}.
            if (cam.generation >= 2) {
                await this.setObjectNotExistsAsync(`${prefix}.lens_elevation`, {
                    type: "state",
                    common: {
                        name: "Lens elevation (mounting height) 0.5–5.0 m (Gen2) — write to change",
                        role: "level",
                        type: "number",
                        min: 0.5,
                        max: 5.0,
                        unit: "m",
                        read: true,
                        write: true,
                        def: 2.0,
                    },
                    native: {},
                });
            }
            // v0.8.0: darkness threshold (Gen2 Outdoor only, 0–100 %).
            // Controls day/night lighting switch point.
            // GET/PUT /v11/video_inputs/{id}/lighting → {"darknessThreshold": 0.47, "softLightFading": bool}.
            // Stored by Bosch as 0.0–1.0 float; exposed here as 0–100 integer.
            if (cam.generation >= 2 &&
                cam.hardwareVersion !== "HOME_Eyes_Indoor" &&
                cam.hardwareVersion !== "CAMERA_INDOOR_GEN2") {
                await this.setObjectNotExistsAsync(`${prefix}.darkness_threshold`, {
                    type: "state",
                    common: {
                        name: "Darkness threshold 0–100 % (Gen2 Outdoor) — 0=always day, 100=always night",
                        role: "level",
                        type: "number",
                        min: 0,
                        max: 100,
                        unit: "%",
                        read: true,
                        write: true,
                        def: 50,
                    },
                    native: {},
                });
            }
            // v0.8.0: alarm settings (HOME_Eyes_Indoor / CAMERA_INDOOR_GEN2 only).
            // GET/PUT /v11/video_inputs/{id}/alarm_settings → {alarmDelayInSeconds, alarmActivationDelaySeconds, preAlarmDelayInSeconds, ...}.
            if (cam.hardwareVersion === "HOME_Eyes_Indoor" ||
                cam.hardwareVersion === "CAMERA_INDOOR_GEN2") {
                await this.setObjectNotExistsAsync(`${prefix}.siren_duration`, {
                    type: "state",
                    common: {
                        name: "Siren duration in seconds (alarm_settings.alarmDelayInSeconds) 10–300",
                        role: "level.timer",
                        type: "number",
                        min: 10,
                        max: 300,
                        unit: "s",
                        read: true,
                        write: true,
                        def: 60,
                    },
                    native: {},
                });
                await this.setObjectNotExistsAsync(`${prefix}.alarm_activation_delay`, {
                    type: "state",
                    common: {
                        name: "Alarm activation delay in seconds (alarm_settings.alarmActivationDelaySeconds) 0–600",
                        role: "level.timer",
                        type: "number",
                        min: 0,
                        max: 600,
                        unit: "s",
                        read: true,
                        write: true,
                        def: 30,
                    },
                    native: {},
                });
                await this.setObjectNotExistsAsync(`${prefix}.pre_alarm_delay`, {
                    type: "state",
                    common: {
                        name: "Pre-alarm LED warning duration in seconds (alarm_settings.preAlarmDelayInSeconds) 0–300",
                        role: "level.timer",
                        type: "number",
                        min: 0,
                        max: 300,
                        unit: "s",
                        read: true,
                        write: true,
                        def: 30,
                    },
                    native: {},
                });
            }
            // v0.9.0: persisted last-seen event ID — survives adapter restarts so
            // fetchAndProcessEvents() does not re-fire side effects for historical events.
            await this.setObjectNotExistsAsync(`${prefix}.last_seen_event_id`, {
                type: "state",
                common: {
                    role: "value",
                    name: "ID of the last cloud event processed (persisted, diagnostic)",
                    type: "string",
                    read: true,
                    write: false,
                    def: "",
                },
                native: {},
            });
            // F4: ONVIF scopes (LAN RCP 0x0a98, slow-tier 300s, diagnostic)
            await this.setObjectNotExistsAsync(`${prefix}.onvif_scopes`, {
                type: "state",
                common: {
                    name: "ONVIF scopes from RCP 0x0a98 (LAN, diagnostic) — JSON",
                    role: "info",
                    type: "string",
                    read: true,
                    write: false,
                    def: "",
                },
                native: {},
            });
            // F6: RCP protocol version (LAN RCP 0xff00, slow-tier 300s, diagnostic)
            await this.setObjectNotExistsAsync(`${prefix}.rcp_version`, {
                type: "state",
                common: {
                    name: "RCP protocol version from camera firmware (LAN, diagnostic)",
                    role: "info.firmware",
                    type: "string",
                    read: true,
                    write: false,
                    def: "",
                },
                native: {},
            });
            // v0.9.0: privacy_sound_enabled — plays audible indicator on privacy mode change.
            // API: GET/PUT /v11/video_inputs/{id}/privacy_sound_override  body: {"result": bool}
            // All camera generations support this endpoint (442 = not supported, handled gracefully).
            await this.setObjectNotExistsAsync(`${prefix}.privacy_sound_enabled`, {
                type: "state",
                common: {
                    name: "Privacy sound — plays a sound when privacy mode changes",
                    role: "switch",
                    type: "boolean",
                    read: true,
                    write: true,
                    def: false,
                },
                native: {},
            });
            // v0.9.0: autofollow_enabled — Gen1 360° only (CAMERA_360, panLimit > 0).
            // API: GET/PUT /v11/video_inputs/{id}/autofollow  body: {"result": bool}
            if (cam.panLimit > 0) {
                await this.setObjectNotExistsAsync(`${prefix}.autofollow_enabled`, {
                    type: "state",
                    common: {
                        name: "Auto-follow mode — camera tracks motion automatically (Gen1 360° only)",
                        role: "switch",
                        type: "boolean",
                        read: true,
                        write: true,
                        def: false,
                    },
                    native: {},
                });
            }
            // v0.9.0: unread_events_count — count from numberOfUnreadEvents in camera listing.
            await this.setObjectNotExistsAsync(`${prefix}.unread_events_count`, {
                type: "state",
                common: {
                    name: "Number of unread cloud events",
                    role: "value",
                    type: "number",
                    read: true,
                    write: false,
                    def: 0,
                },
                native: {},
            });
            // v0.9.0: mark_all_read — button to mark all events as read.
            // Writes PUT /v11/events with {id, isRead: true} for each recent unread event.
            await this.setObjectNotExistsAsync(`${prefix}.mark_all_read`, {
                type: "state",
                common: {
                    name: "Mark all camera events as read (write true to trigger)",
                    role: "button",
                    type: "boolean",
                    read: false,
                    write: true,
                    def: false,
                },
                native: {},
            });
            // Set initial values
            await this.upsertState(`${prefix}.name`, cam.name);
            await this.upsertState(`${prefix}.firmware_version`, cam.firmwareVersion);
            await this.upsertState(`${prefix}.hardware_version`, cam.hardwareVersion);
            await this.upsertState(`${prefix}.generation`, cam.generation);
            await this.upsertState(`${prefix}.online`, cam.online);
            // v0.9.1: seed unread_events_count from cached state if any, else 0.
            // The accurate value lands on the first poll tick via _pollUnreadCount
            // (listing's `numberOfUnreadEvents` is unreliable — see v0.9.1 notes).
            const unreadState = await this.getStateAsync(`${prefix}.unread_events_count`);
            await this.upsertState(`${prefix}.unread_events_count`, typeof unreadState?.val === "number" ? unreadState.val : 0);
            // Seed in-memory livestream flag from the persisted state so a
            // restart preserves whatever the user toggled before. Default
            // false when no state exists yet (fresh install).
            const lsState = await this.getStateAsync(`${prefix}.livestream_enabled`);
            this._livestreamEnabled.set(cam.id, lsState?.val === true);
        }
    }
    /**
     * Ensure the top-level `cloud` channel and F13 feature-flags DPs exist.
     * Called once in onReady after cameras are discovered.
     */
    async ensureCloudObjects() {
        await this.setObjectNotExistsAsync("cloud", {
            type: "channel",
            common: { name: "Bosch cloud account info" },
            native: {},
        });
        // F13: cloud feature flags — display (comma-separated enabled flags)
        await this.setObjectNotExistsAsync("cloud.feature_flags", {
            type: "state",
            common: {
                name: "Bosch cloud feature flags (enabled, diagnostic)",
                role: "info",
                type: "string",
                read: true,
                write: false,
                def: "",
            },
            native: {},
        });
        // F13: raw JSON for tooling / debugging
        await this.setObjectNotExistsAsync("cloud.feature_flags_raw", {
            type: "state",
            common: {
                name: "Bosch cloud feature flags raw JSON (diagnostic)",
                role: "json",
                type: "string",
                read: true,
                write: false,
                def: "",
            },
            native: {},
        });
    }
    // ── Token persistence ───────────────────────────────────────────────────
    /**
     * Save tokens to ioBroker states (survives adapter restart).
     *
     * @param tokens
     */
    async saveTokens(tokens) {
        const expiresAt = Date.now() + tokens.expires_in * 1000;
        this._currentAccessToken = tokens.access_token;
        this._currentRefreshToken = tokens.refresh_token;
        // v1.1.0: keep the FCM listener's bearer token current. Bosch tokens
        // expire ~1 h; without this the next FCM reconnect re-registers with
        // CBS using the stale construction-time token → HTTP 401 → push lost
        // permanently. saveTokens runs on initial login AND every refresh.
        this._fcmListener?.updateBearerToken(tokens.access_token);
        // v0.6.0: tokens are AES-wrapped via this.encrypt() before persisting so
        // a user reading the Objects tab in Admin no longer sees plaintext.
        await this.upsertState("info.access_token", this._encryptSecret(tokens.access_token));
        await this.upsertState("info.refresh_token", this._encryptSecret(tokens.refresh_token));
        await this.upsertState("info.token_expires_at", expiresAt);
        // v0.5.4: diagnostics — both Blockly and VIS dashboards can branch on these.
        await this.setStateAsync("info.last_login_at", new Date().toISOString(), true);
        await this.setStateAsync("info.connection_status", "connected", true);
    }
    /**
     * Load tokens from ioBroker states (from a previous run).
     * Returns null if tokens are absent or already expired.
     */
    async loadStoredTokens() {
        const [atState, rtState, expState] = await Promise.all([
            this.getStateAsync("info.access_token"),
            this.getStateAsync("info.refresh_token"),
            this.getStateAsync("info.token_expires_at"),
        ]);
        const accessToken = this._decryptSecret(atState?.val);
        const refreshToken = this._decryptSecret(rtState?.val);
        const expiresAt = typeof expState?.val === "number" ? expState.val : 0;
        if (!accessToken || !refreshToken || !expiresAt) {
            return null;
        }
        // Consider expired if within 60s of expiry (gives room for the refresh call itself)
        if (Date.now() >= expiresAt - 60_000) {
            return null;
        }
        return { accessToken, refreshToken, expiresAt };
    }
    // ── Token refresh loop (setTimeout re-arm pattern) ──────────────────────
    /**
     * Schedule the next token refresh at 75% of remaining token lifetime.
     * Uses this.setTimeout (adapter-core) so ioBroker auto-cancels on unload.
     *
     * @param expiresInMs  Milliseconds until the current access_token expires.
     */
    scheduleTokenRefresh(expiresInMs) {
        // Refresh at 75% of token lifetime — leaves a safety buffer before expiry.
        const refreshIn = Math.max(60_000, expiresInMs * 0.75);
        // this.setTimeout returns ioBroker.Timeout | undefined — cast via unknown to normalise
        this._refreshTimeout =
            this.setTimeout(async () => {
                this._refreshTimeout = null;
                if (!this._currentRefreshToken) {
                    this.log.warn("Token refresh skipped — no refresh token in memory");
                    return;
                }
                try {
                    const newTokens = await (0, auth_1.refreshAccessToken)(this._httpClient, this._currentRefreshToken);
                    if (!newTokens) {
                        // Transient network error — retry in 5 min
                        this.log.warn("Token refresh returned null (network) — retrying in 5 min");
                        this.scheduleTokenRefresh(5 * 60_000);
                        return;
                    }
                    await this.saveTokens(newTokens);
                    this.log.debug(`Token refresh successful — next refresh in ~${Math.round((newTokens.expires_in * 0.75) / 60)} min`);
                    this.scheduleTokenRefresh(newTokens.expires_in * 1000);
                }
                catch (err) {
                    if (err instanceof auth_1.RefreshTokenInvalidError) {
                        this.log.error("Refresh token invalid — please reconfigure credentials in Admin UI");
                        await this.setStateAsync("info.connection", false, true);
                        // Do NOT re-arm — user must re-configure and restart the adapter
                    }
                    else {
                        // AuthServerOutageError or unexpected — retry in 5 min
                        const msg = err instanceof Error ? err.message : String(err);
                        this.log.warn(`Token refresh failed: ${msg} — retrying in 5 min`);
                        this.scheduleTokenRefresh(5 * 60_000);
                    }
                }
            }, refreshIn) ?? null;
    }
    // ── Live session management ─────────────────────────────────────────────
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
    async ensureLiveSession(camId) {
        // v0.5.3: bumped from 30 s → 60 s so a snapshot burst inside the
        // SNAPSHOT_SESSION_IDLE_MS keep-alive window can always reuse the
        // cached session. Watchdog handles real session renewal at ~T-60s
        // before maxSessionDuration; this TTL is only a safety net against
        // an externally-killed session (camera reboot, cloud-side close).
        const SESSION_TTL_MS = 60_000;
        const existing = this._liveSessions.get(camId);
        if (existing && Date.now() - existing.openedAt < SESSION_TTL_MS) {
            return existing; // still fresh
        }
        if (!this._currentAccessToken) {
            throw new Error(`Cannot open live session for ${camId} — no access token`);
        }
        // Open a fresh LOCAL session — throws if camera unreachable on LAN
        const highQuality = (this._streamQuality.get(camId) ?? "high") === "high";
        const session = await (0, live_session_1.openLiveSession)(this._httpClient, this._currentAccessToken, camId, highQuality);
        this._liveSessions.set(camId, session);
        // Spawn (or replace) TLS proxy + update stream_url + arm watchdog
        await this.upsertSession(camId, session);
        // Arm session watchdog if not already running
        if (!this._sessionWatchdogs.has(camId)) {
            // v0.7.10: record session start time for 60-min expiry detection
            this._sessionStartTime.set(camId, Date.now());
            // Reset backoff and LAN-fail counters on a fresh session open
            this._renewalBackoff.delete(camId);
            this._lanTcpFailCount.delete(camId);
            // v1.1.0: the generation this watchdog is armed with — passed to
            // onError so a teardown during an in-flight renewal still bails.
            const armedGen = this._streamGeneration.get(camId) ?? 0;
            const watchdog = new session_watchdog_1.SessionWatchdog({
                openSession: () => {
                    if (!this._currentAccessToken) {
                        return Promise.reject(new Error(`Cannot renew session for ${camId} — no access token`));
                    }
                    const hq = (this._streamQuality.get(camId) ?? "high") === "high";
                    return (0, live_session_1.openLiveSession)(this._httpClient, this._currentAccessToken, camId, hq);
                },
                onRenew: async (newSession) => {
                    // Reset backoff + LAN-fail on successful renewal
                    this._renewalBackoff.delete(camId);
                    this._lanTcpFailCount.delete(camId);
                    this._sessionStartTime.set(camId, Date.now());
                    // v1.1.0: publish the session ONLY after the proxy is up.
                    // upsertSession can throw if startTlsProxy fails (sticky +
                    // ephemeral both fail); setting _liveSessions first left a
                    // session with no proxy in the map (clients/RCP then fail).
                    await this.upsertSession(camId, newSession);
                    this._liveSessions.set(camId, newSession);
                },
                onError: (err) => {
                    // v0.7.10: graceful renewal backoff — keep session alive and retry
                    void this._handleRenewalFailure(camId, err, armedGen);
                },
                log: (level, msg) => this.log[level](msg),
                setTimeout: this.setTimeout.bind(this),
                clearTimeout: (t) => this.clearTimeout(t),
            });
            watchdog.start(session);
            this._sessionWatchdogs.set(camId, watchdog);
        }
        return session;
    }
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
    _routeCloudErrorLog(camPrefix, status, retryIn) {
        const mw = this._lastMaintenanceWindow;
        const isMaintenance = mw !== null && (0, maintenance_1.classifyState)(mw) === "active";
        if (isMaintenance) {
            this.log.info(`[bosch-maintenance] Bosch cloud temporarily unavailable (HTTP ${status}) — ` +
                `current session continues until expiry (camera ${camPrefix})`);
        }
        else if (status === 401 || status === 403) {
            this.log.warn(`LAN session credentials expired (HTTP ${status}), refreshing (camera ${camPrefix})`);
        }
        else {
            this.log.warn(`Bosch cloud returned ${status} for session renewal — will retry in ${retryIn}s (camera ${camPrefix})`);
        }
    }
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
    _handleRenewalFailure(camId, err, armedGeneration) {
        const camPrefix = camId.slice(0, 8);
        // v1.1.0: drop the now-dead watchdog from the map. The watchdog always
        // calls stop() on itself BEFORE invoking onError→here (session_watchdog
        // _renew lines 197/211), so the map entry is a stopped, never-firing
        // object. If left in place, the re-arm guard `if (!_sessionWatchdogs
        // .has(camId))` in _attemptBackoffRenewal sees it, skips re-arming, and
        // the recovered session then runs with NO watchdog → never renews →
        // dies at the 60-min cap. Removing it lets the backoff-success path
        // arm a fresh watchdog.
        this._sessionWatchdogs.delete(camId);
        const backoffSteps = BoschSmartHomeCamera.RENEWAL_BACKOFF_MS;
        const backoff = this._renewalBackoff.get(camId) ?? { attempt: 0, nextRetryMs: 0 };
        const attempt = backoff.attempt;
        // Determine HTTP status from error name for routing
        let httpStatus = 503; // default assumption for cloud errors
        if (err.name === "LiveSessionError") {
            if (err.message.includes("401")) {
                httpStatus = 401;
            }
            else if (err.message.includes("403")) {
                httpStatus = 403;
            }
        }
        const retryDelayMs = backoffSteps[Math.min(attempt, backoffSteps.length - 1)];
        const retryInS = Math.round(retryDelayMs / 1000);
        this._routeCloudErrorLog(camPrefix, httpStatus, retryInS);
        this._triggerMaintenanceFetchOn5xx();
        // Check whether the session has naturally expired (≥ 60 min)
        const sessionStart = this._sessionStartTime.get(camId) ?? -Infinity;
        const sessionAge = Date.now() - sessionStart;
        if (sessionAge >= BoschSmartHomeCamera.SESSION_MAX_AGE_MS) {
            this.log.warn(`RTSP watchdog: session for camera ${camPrefix} has exceeded 60 min ` +
                `and cloud renewal is still failing — tearing down`);
            this._doTeardownStream(camId);
            return;
        }
        // Schedule the next retry
        this._renewalBackoff.set(camId, {
            attempt: attempt + 1,
            nextRetryMs: Date.now() + retryDelayMs,
        });
        this.log.debug(`RTSP watchdog: camera ${camPrefix} — scheduling renewal retry #${attempt + 1} in ${retryInS} s`);
        // Use adapter setTimeout so it's automatically cancelled on unload.
        // v1.1.0: use the generation the failing watchdog was ARMED with
        // (armedGeneration) when available, falling back to the current value.
        // Capturing the current value here would miss a teardown that bumped the
        // generation while this watchdog's renewal was already in-flight — the
        // scheduled retry would then match and resurrect a torn-down stream.
        const gen = armedGeneration ?? this._streamGeneration.get(camId) ?? 0;
        this.setTimeout(() => {
            void this._attemptBackoffRenewal(camId, gen).catch((retryErr) => {
                const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                this.log.debug(`RTSP watchdog: backoff retry threw unexpectedly: ${msg}`);
            });
        }, retryDelayMs);
    }
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
    async _attemptBackoffRenewal(camId, expectedGeneration) {
        const camPrefix = camId.slice(0, 8);
        // v1.1.0: bail if the stream was torn down after this retry was armed.
        // A teardown bumps _streamGeneration; a stale retry must NOT re-open a
        // session the user stopped (HA: generation check at top of renew loop).
        if (expectedGeneration !== undefined &&
            (this._streamGeneration.get(camId) ?? 0) !== expectedGeneration) {
            this.log.debug(`RTSP watchdog: skipping stale renewal for ${camPrefix} — stream was torn down`);
            return;
        }
        // ── LAN TCP-connect check ─────────────────────────────────────────────
        if (this._lanIpMap.has(camId)) {
            const reachable = await this._tcpPing(camId);
            if (!reachable) {
                const prev = this._lanTcpFailCount.get(camId) ?? 0;
                const next = prev + 1;
                this._lanTcpFailCount.set(camId, next);
                this.log.warn(`Camera ${camPrefix} LAN unreachable (TCP fail ${next}/${BoschSmartHomeCamera.LAN_TCP_FAIL_THRESHOLD})`);
                if (next >= BoschSmartHomeCamera.LAN_TCP_FAIL_THRESHOLD) {
                    this.log.error(`Camera offline or unreachable — ${next} consecutive LAN TCP failures for camera ${camPrefix}`);
                    this._doTeardownStream(camId);
                    return;
                }
                // Not yet at threshold — schedule next backoff retry
                const fakeErr = new Error(`LAN TCP connect failed (attempt ${next})`);
                this._handleRenewalFailure(camId, fakeErr, expectedGeneration);
                return;
            }
            // LAN TCP succeeded — reset the consecutive failure counter
            this._lanTcpFailCount.set(camId, 0);
        }
        // ── Cloud renewal attempt ─────────────────────────────────────────────
        if (!this._currentAccessToken) {
            this.log.warn(`RTSP watchdog: no access token for camera ${camPrefix} — skipping renewal retry`);
            this._handleRenewalFailure(camId, new Error("No access token for renewal retry"), expectedGeneration);
            return;
        }
        try {
            const hq = (this._streamQuality.get(camId) ?? "high") === "high";
            const newSession = await (0, live_session_1.openLiveSession)(this._httpClient, this._currentAccessToken, camId, hq);
            // v1.1.0: the openLiveSession await above is a window in which a
            // teardown (user stop / privacy toggle / LAN-fail) can run and bump
            // the generation. If it did, this stream is no longer wanted — do
            // NOT resurrect it (publish session + proxy + watchdog). Close the
            // just-opened orphan session so it doesn't leak server-side. The
            // top-of-function guard only covers a teardown BEFORE this retry ran.
            if (expectedGeneration !== undefined &&
                (this._streamGeneration.get(camId) ?? 0) !== expectedGeneration) {
                this.log.debug(`RTSP watchdog: stream for ${camPrefix} torn down during renewal — discarding new session`);
                if (this._currentAccessToken) {
                    void (0, live_session_1.closeLiveSession)(this._httpClient, this._currentAccessToken, camId).catch(() => undefined);
                }
                return;
            }
            // Success — reset state and re-arm watchdog
            this._renewalBackoff.delete(camId);
            this._lanTcpFailCount.delete(camId);
            this._sessionStartTime.set(camId, Date.now());
            // v1.1.0: publish the session only after the proxy is up (upsertSession
            // can throw on proxy-start failure → don't leave a proxy-less session).
            await this.upsertSession(camId, newSession);
            this._liveSessions.set(camId, newSession);
            // Re-arm watchdog if it was stopped
            if (!this._sessionWatchdogs.has(camId)) {
                // v1.1.0: this re-armed watchdog belongs to the generation this
                // backoff chain is running under — pass it to onError so a
                // teardown during a future in-flight renewal still bails.
                const armedGenInner = expectedGeneration ?? this._streamGeneration.get(camId) ?? 0;
                const watchdog = new session_watchdog_1.SessionWatchdog({
                    openSession: () => {
                        if (!this._currentAccessToken) {
                            return Promise.reject(new Error(`Cannot renew session for ${camId} — no access token`));
                        }
                        const hqInner = (this._streamQuality.get(camId) ?? "high") === "high";
                        return (0, live_session_1.openLiveSession)(this._httpClient, this._currentAccessToken, camId, hqInner);
                    },
                    onRenew: async (renewedSession) => {
                        this._renewalBackoff.delete(camId);
                        this._lanTcpFailCount.delete(camId);
                        this._sessionStartTime.set(camId, Date.now());
                        // v1.1.0: publish session only after the proxy is up.
                        await this.upsertSession(camId, renewedSession);
                        this._liveSessions.set(camId, renewedSession);
                    },
                    onError: (renewErr) => {
                        void this._handleRenewalFailure(camId, renewErr, armedGenInner);
                    },
                    log: (level, msg) => this.log[level](msg),
                    setTimeout: this.setTimeout.bind(this),
                    clearTimeout: (t) => this.clearTimeout(t),
                });
                watchdog.start(newSession);
                this._sessionWatchdogs.set(camId, watchdog);
            }
            this.log.info(`RTSP watchdog: cloud renewal backoff succeeded for camera ${camPrefix}`);
        }
        catch (renewErr) {
            const error = renewErr instanceof Error ? renewErr : new Error(String(renewErr));
            this._handleRenewalFailure(camId, error, expectedGeneration);
        }
    }
    /**
     * v0.7.10: Synchronous teardown wrapper used by the backoff renewal path.
     * Kicks off _teardownStream fire-and-forget (stream teardown is always
     * best-effort; the caller must not await it in the backoff path to avoid
     * blocking the retry loop).
     *
     * @param camId  Camera UUID
     */
    _doTeardownStream(camId) {
        // v1.1.0: bump the generation so any backoff-renewal timer already
        // armed for this camera bails when it fires (stops a torn-down stream
        // from being resurrected). HA: _auto_renew_generation increment.
        this._streamGeneration.set(camId, (this._streamGeneration.get(camId) ?? 0) + 1);
        this._renewalBackoff.delete(camId);
        this._lanTcpFailCount.delete(camId);
        this._sessionStartTime.delete(camId);
        void this._teardownStream(camId).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.debug(`_doTeardownStream: _teardownStream threw: ${msg}`);
        });
    }
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
    async upsertSession(camId, session) {
        try {
            // lanAddress: "192.168.x.x:443" — always LOCAL
            const [h, pStr] = session.lanAddress.split(":");
            const remoteHost = h;
            const remotePort = parseInt(pStr ?? "443", 10);
            // ── Hot-reuse: same upstream + alive proxy → just refresh stream_url
            // with the new Digest credentials. Keeps port stable across renewals.
            const existingProxy = this._tlsProxies.get(camId);
            const existingRemote = this._sessionRemote.get(camId);
            const remoteUnchanged = existingRemote === `${remoteHost}:${remotePort}`;
            let proxyHandle;
            if (existingProxy && remoteUnchanged) {
                proxyHandle = existingProxy;
                // v0.7.13: refresh the Digest creds the proxy uses for the
                // auth-aware path. Without this, a privacy-toggle-driven
                // session refresh would update the published stream_url
                // but leave the proxy's in-memory Digest creds stuck on
                // the pre-toggle values — BlueIris/VLC then get 401 on
                // every reconnect until the adapter restarts.
                // Forum #1341076 (Jaschkopf, 2026-05-23).
                proxyHandle.updateDigestAuth(session.digestUser, session.digestPassword);
                this.log.debug(`TLS proxy for ${camId.slice(0, 8)}: reusing port ${proxyHandle.port} ` +
                    `(remote unchanged ${remoteHost}:${remotePort})`);
            }
            else {
                if (existingProxy) {
                    await existingProxy.stop().catch(() => undefined);
                    this._tlsProxies.delete(camId);
                }
                // Sticky-port: prefer the previously used port if known
                let preferredPort = this._stickyProxyPort.get(camId);
                if (preferredPort === undefined) {
                    const persisted = await this.getStateAsync(`cameras.${camId}._proxy_port`);
                    const v = persisted?.val;
                    if (typeof v === "number" && v > 0 && v < 65_536) {
                        preferredPort = v;
                    }
                }
                const { bindHost, urlHost } = this._rtspBindConfig();
                // v0.5.3: forward the session's Digest creds to the proxy so
                // it can handle auth transparently for clients that don't.
                const digestAuth = {
                    user: session.digestUser,
                    password: session.digestPassword,
                };
                try {
                    proxyHandle = await (0, tls_proxy_1.startTlsProxy)({
                        remoteHost,
                        remotePort,
                        cameraId: camId,
                        localPort: preferredPort,
                        bindHost,
                        urlHost,
                        digestAuth,
                        log: (level, msg) => this.log[level](msg),
                    });
                }
                catch (bindErr) {
                    // Sticky port no longer available — fall back to ephemeral
                    const msg = bindErr instanceof Error ? bindErr.message : String(bindErr);
                    if (preferredPort !== undefined) {
                        this.log.warn(`TLS proxy for ${camId.slice(0, 8)}: sticky port ${preferredPort} ` +
                            `unavailable (${msg}) — falling back to ephemeral port`);
                        proxyHandle = await (0, tls_proxy_1.startTlsProxy)({
                            remoteHost,
                            remotePort,
                            cameraId: camId,
                            bindHost,
                            urlHost,
                            digestAuth,
                            log: (level, msg2) => this.log[level](msg2),
                        });
                    }
                    else {
                        throw bindErr;
                    }
                }
                this._tlsProxies.set(camId, proxyHandle);
                this._sessionRemote.set(camId, `${remoteHost}:${remotePort}`);
                this._stickyProxyPort.set(camId, proxyHandle.port);
                // v0.7.4: persist the LAN IP so cloud-degraded startups can
                // ping cameras without first needing a cloud round-trip.
                // Only write when the IP actually changes (throttle DB writes).
                if (remoteHost && this._lanIpMap.get(camId) !== remoteHost) {
                    this._lanIpMap.set(camId, remoteHost);
                    void this.upsertState(`cameras.${camId}.lan_ip`, remoteHost).catch(() => undefined);
                }
                // Persist sticky port so it survives adapter restart
                await this.setObjectNotExistsAsync(`cameras.${camId}._proxy_port`, {
                    type: "state",
                    common: {
                        name: "Sticky TLS proxy port (auto-managed)",
                        role: "value",
                        type: "number",
                        read: true,
                        write: false,
                        def: 0,
                    },
                    native: {},
                });
                await this.upsertState(`cameras.${camId}._proxy_port`, proxyHandle.port);
            }
            // Build the public URL with Digest credentials + RTSP query params.
            // Bosch RTSP demands Digest auth; without `user:pass@…` consumers
            // (cameras adapter, BlueIris, FFmpeg without separate auth) return
            // "401 Unauthorized". The query params mirror what HA / Python CLI
            // build: inst=1 (main), enableaudio=1, fmtp=1, maxSessionDuration.
            // v0.5.3: also publish inst=2 (sub-stream) under stream_url_sub so
            // BlueIris / Frigate can do mainstream-record + substream-display
            // and save CPU. Same Bosch session, same TLS proxy, same auth.
            const credsUrl = this._buildStreamUrl(proxyHandle, session, 1);
            const subUrl = this._buildStreamUrl(proxyHandle, session, 2);
            await this.setObjectNotExistsAsync(`cameras.${camId}.stream_url`, {
                type: "state",
                common: {
                    name: "Local RTSP URL — auth handled transparently by the proxy",
                    role: "text.url",
                    type: "string",
                    read: true,
                    write: false,
                    def: "",
                },
                native: {},
            });
            await this.upsertState(`cameras.${camId}.stream_url`, credsUrl);
            await this.upsertState(`cameras.${camId}.stream_url_sub`, subUrl);
            this.log.info(`TLS proxy for camera ${camId.slice(0, 8)}: ` +
                `stream_url = ${credsUrl} | stream_url_sub = ${subUrl}`);
        }
        catch (proxyErr) {
            // TLS proxy failure is non-fatal for RCP/snapshot — log and continue
            const msg = proxyErr instanceof Error ? proxyErr.message : String(proxyErr);
            this.log.warn(`Could not start TLS proxy for ${camId}: ${msg}`);
        }
    }
    /**
     * Resolve the RTSP proxy bind host + URL host from adapter config.
     * Default: bind 127.0.0.1, URL uses 127.0.0.1 (legacy behaviour).
     * `rtsp_expose_to_lan=true` → bind 0.0.0.0, URL uses `rtsp_external_host`
     * (falls back to 127.0.0.1 if the field is empty — that still works for
     * tools running on the ioBroker host, just not for LAN recorders).
     */
    _rtspBindConfig() {
        const exposeLan = this.config.rtsp_expose_to_lan === true;
        if (!exposeLan) {
            return { bindHost: "127.0.0.1", urlHost: "127.0.0.1" };
        }
        const ext = typeof this.config.rtsp_external_host === "string"
            ? this.config.rtsp_external_host.trim()
            : "";
        return { bindHost: "0.0.0.0", urlHost: ext || "127.0.0.1" };
    }
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
    _buildStreamUrl(proxy, session, instance = 1) {
        // v0.5.3: stream URL no longer embeds Digest credentials. The TLS
        // proxy now handles RTSP Digest auth itself (see lib/rtsp_auth.ts),
        // so consumers get a clean `rtsp://host:port/rtsp_tunnel?…` URL
        // that works with clients which strip in-URL creds (BlueIris,
        // Forum #84538 posts 13–18). VLC / FFmpeg also keep working — the
        // proxy detects whether the client supplies its own Authorization
        // header and only injects when needed.
        const dur = session.maxSessionDuration > 0 ? session.maxSessionDuration : 3600;
        return `${proxy.localRtspUrl}?inst=${instance}&enableaudio=1&fmtp=1&maxSessionDuration=${dur}`;
    }
    /**
     * Replace `user:password@` with `***:***@` for log lines.
     *
     * @param url
     */
    _maskCreds(url) {
        return url.replace(/(rtsp:\/\/)([^@/]+)@/, "$1***:***@");
    }
    // ── PKCE browser-login helpers ──────────────────────────────────────────
    /**
     * Generate (or reuse) a PKCE pair, build the Bosch auth URL, and log it.
     *
     * The verifier is stored in info.pkce_verifier so it survives restarts —
     * regenerated only after a successful code exchange or explicit reset.
     * This prevents "stale verifier" errors when the user copies the URL from
     * one adapter start and pastes after a second restart.
     */
    async showLoginUrl() {
        // Check if we already have a stored verifier (reuse across restarts).
        // v0.6.0: verifier/state are AES-wrapped on disk; _decryptSecret also
        // returns legacy plaintext from <=v0.5.x unchanged, so old installs
        // still match before the next overwrite.
        const existingVerifier = this._decryptSecret((await this.getStateAsync("info.pkce_verifier"))?.val);
        let verifier;
        let challenge;
        let state;
        if (existingVerifier && existingVerifier.length > 10) {
            // Reuse stored verifier — derive challenge from it
            const { createHash, randomBytes } = await Promise.resolve().then(() => __importStar(require("node:crypto")));
            verifier = existingVerifier;
            challenge = createHash("sha256").update(verifier).digest("base64url");
            const existingState = this._decryptSecret((await this.getStateAsync("info.pkce_state"))?.val);
            state =
                existingState && existingState.length > 4
                    ? existingState
                    : randomBytes(16).toString("base64url");
        }
        else {
            // Generate a fresh PKCE pair
            const { randomBytes } = await Promise.resolve().then(() => __importStar(require("node:crypto")));
            const pair = (0, auth_1.generatePkcePair)();
            verifier = pair.verifier;
            challenge = pair.challenge;
            state = randomBytes(16).toString("base64url");
            await this.setStateAsync("info.pkce_verifier", this._encryptSecret(verifier), true);
            await this.setStateAsync("info.pkce_state", this._encryptSecret(state), true);
        }
        const authUrl = (0, auth_1.buildAuthUrl)(challenge, state);
        // v0.5.4: publish URL as a state so the Admin UI can render a clickable
        // link. Survives adapter restarts (PKCE verifier is also persisted) so
        // the user doesn't have to time the login between two restart cycles.
        await this.setStateAsync("info.login_url", authUrl, true);
        await this.setStateAsync("info.connection_status", "awaiting_login", true);
        this.log.info("Login required. Open this URL in your browser and log in to Bosch:");
        this.log.info(authUrl);
        this.log.info("After Bosch redirects you, copy the full redirect URL " +
            "(https://www.bosch.com/boschcam?code=...&state=...) " +
            "and paste it into the 'redirect_url' field in Admin UI, then save.");
    }
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
    async handleRedirectPaste(url) {
        const code = (0, auth_1.extractCode)(url);
        if (!code) {
            throw new Error("No 'code' parameter found in pasted URL. " +
                "Make sure to copy the full URL from the browser address bar after Bosch redirects you.");
        }
        const verifier = this._decryptSecret((await this.getStateAsync("info.pkce_verifier"))?.val);
        if (!verifier || verifier.length < 10) {
            throw new Error("No PKCE verifier stored. " +
                "Please restart the adapter first (without a redirect_url) to generate a login URL, " +
                "then open that URL in your browser before pasting the redirect URL.");
        }
        const tokens = await (0, auth_1.exchangeCode)(this._httpClient, code, verifier);
        if (!tokens) {
            throw new Error("Token exchange returned null (transient network error). " +
                "Please try again — paste the same redirect URL or generate a new login URL.");
        }
        await this.saveTokens(tokens);
        // Clear paste field so it is not re-used on the next adapter restart
        try {
            await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
                native: { redirect_url: "" },
            });
        }
        catch {
            // Non-fatal — log at debug level; the code has been consumed anyway
            this.log.debug("Could not clear redirect_url in adapter config — non-fatal");
        }
        // Clear stored PKCE pair (verifier consumed — regenerate fresh on next login)
        await this.setStateAsync("info.pkce_verifier", "", true);
        await this.setStateAsync("info.pkce_state", "", true);
        // v0.5.4: hide the Admin-UI login link once login succeeded
        await this.setStateAsync("info.login_url", "", true);
        this.log.info("Login successful — tokens stored. Adapter is now connected.");
        return tokens;
    }
    // ── Lifecycle ───────────────────────────────────────────────────────────
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
    // ── v0.7.4 LAN-fallback helpers ─────────────────────────────────────────
    /**
     * True if a successful local RCP write happened within LOCAL_WRITE_GRACE_MS.
     * During that window a TCP-connect failure is suppressed — the camera
     * briefly tears down its HTTPS endpoint while rotating Digest creds.
     *
     * @param camId
     * @param now
     */
    _inLocalWriteGrace(camId, now = Date.now()) {
        const last = this._localWriteAt.get(camId) ?? -Infinity;
        return now - last < BoschSmartHomeCamera.LOCAL_WRITE_GRACE_MS;
    }
    /**
     * Most recent LAN-TCP reachability for `camId`, or null if not yet probed.
     * Honors the post-write grace period so the UI does not flip to offline
     * for a few seconds after every privacy / light toggle.
     *
     * @param camId
     */
    isLanReachable(camId) {
        const entry = this._lanReachable.get(camId);
        const now = Date.now();
        if (entry === undefined) {
            return this._inLocalWriteGrace(camId, now) ? true : null;
        }
        const [reachable] = entry;
        if (!reachable && this._inLocalWriteGrace(camId, now)) {
            return true;
        }
        return reachable;
    }
    /**
     * TCP-connect probe to the camera's LAN port 443.
     * Writes the result to `_lanReachable` and updates the `cameras.<id>.lan_reachable` DP.
     *
     * @param camId
     */
    async _tcpPing(camId) {
        const ip = this._lanIpMap.get(camId);
        if (!ip) {
            return false;
        }
        const result = await new Promise((resolve) => {
            const sock = net.createConnection({ host: ip, port: 443 });
            const timer = this.setTimeout(() => {
                sock.destroy();
                resolve(false);
            }, BoschSmartHomeCamera.LAN_PING_TIMEOUT_MS);
            sock.once("connect", () => {
                this.clearTimeout(timer);
                sock.destroy();
                resolve(true);
            });
            sock.once("error", () => {
                this.clearTimeout(timer);
                resolve(false);
            });
        });
        this._lanReachable.set(camId, [result, Date.now()]);
        // Update the persistent DP so automations can read it
        void this.upsertState(`cameras.${camId}.lan_reachable`, result).catch(() => undefined);
        // v0.7.14: a privacy-mode cam refuses HTTPS so the snapshot-based
        // `online` flip never lands and the DP stays at the default false
        // even though the cam is clearly alive (TCP-pings succeed, cloud
        // state syncs, privacy toggles propagate). When LAN-ping confirms
        // the cam is reachable, mark it online — this is at least as
        // truthful as the snapshot path. Snapshot-driven online=false on
        // OFFLINE_THRESHOLD failures still wins for non-privacy outages.
        if (result) {
            try {
                const cur = await this.getStateAsync(`cameras.${camId}.online`);
                if (cur?.val !== true) {
                    await this.setStateAsync(`cameras.${camId}.online`, true, true);
                }
            }
            catch {
                // ignore — best-effort
            }
        }
        return result;
    }
    /**
     * Ping every known camera concurrently during a cloud outage.
     * Throttled to once per OUTAGE_PING_THROTTLE_MS so a flapping cloud
     * does not hammer the LAN. Mirrors HA's `_async_outage_ping_all`.
     */
    async _pingAllCamsDuringOutage() {
        const now = Date.now();
        if (now - this._lastOutagePingAt < BoschSmartHomeCamera.OUTAGE_PING_THROTTLE_MS) {
            return;
        }
        this._lastOutagePingAt = now;
        // Collect known cam IDs: from _cameras map + _lanIpMap (edge case: first
        // startup mid-outage, _cameras may not yet be populated).
        const camIds = new Set([...this._cameras.keys(), ...this._lanIpMap.keys()]);
        if (camIds.size === 0) {
            return;
        }
        const results = await Promise.allSettled([...camIds].map((id) => this._tcpPing(id)));
        const ok = results.filter((r) => r.status === "fulfilled" && r.value === true).length;
        this.log.info(`Outage LAN-ping: ${ok}/${camIds.size} cam(s) reachable (${[...camIds]
            .map((id, i) => {
            const r = results[i];
            return `${id.slice(0, 8)}=${r.status === "fulfilled" ? (r.value ? "on" : "off") : "err"}`;
        })
            .join(", ")})`);
    }
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
    async _openEmergencySession(camId) {
        if (!this._currentAccessToken) {
            return undefined;
        }
        try {
            const hq = (this._streamQuality.get(camId) ?? "high") === "high";
            const session = await (0, live_session_1.openLiveSession)(this._httpClient, this._currentAccessToken, camId, hq);
            this._liveSessions.set(camId, session);
            // v1.1.0: stamp the session start time. Without it, if this
            // emergency session is later adopted by a watchdog (cache-hit in
            // ensureLiveSession), _handleRenewalFailure reads the -Infinity
            // default → sessionAge=Infinity ≥ SESSION_MAX_AGE_MS → the stream
            // is torn down on the FIRST cloud hiccup instead of after 60 min.
            this._sessionStartTime.set(camId, Date.now());
            this.log.info(`Emergency LiveSession opened for LAN-RCP write on camera ${camId.slice(0, 8)}`);
            return { user: session.digestUser, password: session.digestPassword };
        }
        catch {
            // Cloud unavailable (503, LiveSessionError, etc.) — fall through to
            // unauthenticated best-effort fetch in caller.
            return undefined;
        }
    }
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
    async _localWriteFrontLight(camIp, brightness, auth) {
        const val = Math.max(0, Math.min(100, Math.round(brightness)));
        const payload = val.toString(16).padStart(4, "0");
        const url = new URL(`https://${camIp}/rcp.xml`);
        url.searchParams.set("command", "0x0c22");
        url.searchParams.set("direction", "WRITE");
        url.searchParams.set("type", "T_WORD");
        url.searchParams.set("payload", `0x${payload}`);
        url.searchParams.set("num", "1");
        try {
            if (auth) {
                // Gen2: HTTPS port 443 + HTTP Digest auth (RFC 7616)
                const resp = await (0, digest_1.digestRequest)(url.toString(), auth.user, auth.password, {
                    method: "GET",
                    timeout: 5_000,
                    rejectUnauthorized: false,
                });
                if (resp.status !== 200) {
                    this.log.debug(`_localWriteFrontLight: HTTP ${resp.status} for ${camIp} (digest)`);
                    return false;
                }
                if (/<err>/i.test(resp.data.toString())) {
                    this.log.debug(`_localWriteFrontLight: RCP error in response from ${camIp}`);
                    return false;
                }
                return true;
            }
            // Fallback: unauthenticated fetch (Gen1 or pre-session Gen2 best-effort)
            const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(5_000) });
            if (!resp.ok) {
                this.log.debug(`_localWriteFrontLight: HTTP ${resp.status} for ${camIp}`);
                return false;
            }
            const text = await resp.text();
            if (/<err>/i.test(text)) {
                this.log.debug(`_localWriteFrontLight: RCP error in response from ${camIp}`);
                return false;
            }
            return true;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.debug(`_localWriteFrontLight: ${camIp} ${msg}`);
            return false;
        }
    }
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
    async _localWritePrivacy(camIp, enabled, auth) {
        const payload = enabled ? "0x00010000" : "0x00000000";
        const url = new URL(`https://${camIp}/rcp.xml`);
        url.searchParams.set("command", "0x0d00");
        url.searchParams.set("direction", "WRITE");
        url.searchParams.set("type", "P_OCTET");
        url.searchParams.set("payload", payload);
        try {
            if (auth) {
                // Gen2: HTTPS port 443 + HTTP Digest auth (RFC 7616)
                const resp = await (0, digest_1.digestRequest)(url.toString(), auth.user, auth.password, {
                    method: "GET",
                    timeout: 5_000,
                    rejectUnauthorized: false,
                });
                if (resp.status !== 200) {
                    this.log.debug(`_localWritePrivacy: HTTP ${resp.status} for ${camIp} (digest)`);
                    return false;
                }
                if (/<err>/i.test(resp.data.toString())) {
                    this.log.debug(`_localWritePrivacy: RCP error in response from ${camIp}`);
                    return false;
                }
                return true;
            }
            // Fallback: unauthenticated fetch (Gen1 or pre-session Gen2 best-effort)
            const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(5_000) });
            if (!resp.ok) {
                this.log.debug(`_localWritePrivacy: HTTP ${resp.status} for ${camIp}`);
                return false;
            }
            const text = await resp.text();
            if (/<err>/i.test(text)) {
                this.log.debug(`_localWritePrivacy: RCP error in response from ${camIp}`);
                return false;
            }
            return true;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.debug(`_localWritePrivacy: ${camIp} ${msg}`);
            return false;
        }
    }
    async onReady() {
        this.log.info("Bosch Smart Home Camera adapter starting…");
        // Ensure object tree for info/token states
        await this.ensureInfoObjects();
        // v0.7.0: ensure maintenance state objects exist before the first fetch
        await this.ensureMaintenanceObjects();
        // v0.6.0: one-shot re-encrypt of any plaintext token/PKCE secret left
        // behind by an upgrade from <=v0.5.x.
        await this._migrateLegacySecrets();
        await this.setStateAsync("info.connection", false, true);
        // ── Step 1: Obtain tokens (PKCE browser flow) ──────────────────────
        let tokens;
        const stored = await this.loadStoredTokens();
        if (stored) {
            this.log.info("Valid tokens found in state storage — skipping login");
            this._currentAccessToken = stored.accessToken;
            this._currentRefreshToken = stored.refreshToken;
            // Synthesise a minimal TokenResult so we can start the refresh loop
            tokens = {
                access_token: stored.accessToken,
                refresh_token: stored.refreshToken,
                expires_in: Math.max(1, Math.floor((stored.expiresAt - Date.now()) / 1000)),
                refresh_expires_in: 0,
                token_type: "Bearer",
                scope: "",
            };
        }
        else {
            // No valid access token. Before falling back to PKCE re-login try to
            // mint a fresh access_token from the stored refresh_token — the
            // common case after the adapter has been stopped longer than the
            // 3600 s access-token lifetime. Without this step a 1 h restart
            // pause would force the user back through the browser-login flow
            // even though the refresh_token (offline_access, ~30 d) is still
            // valid.
            const rtState = await this.getStateAsync("info.refresh_token");
            const storedRefreshToken = this._decryptSecret(rtState?.val);
            let refreshed = null;
            if (storedRefreshToken) {
                try {
                    refreshed = await (0, auth_1.refreshAccessToken)(this._httpClient, storedRefreshToken);
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    this.log.warn(`Refresh token exchange failed (${msg}) — falling back to browser login`);
                }
            }
            if (refreshed) {
                this.log.info("Stored access token expired — refreshed silently via offline refresh_token");
                await this.saveTokens(refreshed);
                tokens = refreshed;
            }
            else {
                // Refresh either absent or rejected — user must redo PKCE login
                const pastedUrl = this.config.redirect_url ?? "";
                if (pastedUrl && pastedUrl.includes("code=")) {
                    // Step 2: user pasted callback URL — extract code, exchange for tokens
                    try {
                        tokens = await this.handleRedirectPaste(pastedUrl);
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        this.log.error(`Login failed: ${msg}`);
                        // v0.5.4: do NOT terminate — that produces the "kaputt"
                        // restart-loop the forum complained about (Forum #84538).
                        // Instead: clear the stale paste, drop the stale PKCE
                        // pair, regenerate a fresh login URL into info.login_url
                        // so the Admin UI button works, and stay alive waiting
                        // for the next paste.
                        try {
                            await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
                                native: {
                                    redirect_url: "",
                                },
                            });
                        }
                        catch {
                            // Non-fatal — the user can clear redirect_url manually
                            this.log.debug("Could not auto-clear stale redirect_url — non-fatal");
                        }
                        await this.setStateAsync("info.pkce_verifier", "", true);
                        await this.setStateAsync("info.pkce_state", "", true);
                        await this.setStateAsync("info.connection", false, true);
                        await this.setStateAsync("info.connection_status", "auth_error", true);
                        await this.showLoginUrl();
                        this.log.info("Stay-alive in awaiting-login mode — open info.login_url or the 'Open Bosch Login' button to retry.");
                        return;
                    }
                }
                else {
                    // Step 1: no tokens, no pasted URL — generate PKCE pair and show login URL
                    await this.showLoginUrl();
                    // Stay alive in "waiting for setup" mode — user needs to paste URL
                    await this.setStateAsync("info.connection", false, true);
                    return;
                }
            }
        }
        // ── Step 2: Discover cameras ───────────────────────────────────────
        let cameras;
        try {
            cameras = await (0, cameras_1.fetchCameras)(this._httpClient, tokens.access_token);
            this.log.info(`Found ${cameras.length} camera(s)`);
        }
        catch (err) {
            if (err instanceof cameras_1.UnauthorizedError) {
                // Token rejected despite being fresh — refresh and retry once
                this.log.warn("Camera discovery returned 401 — attempting token refresh before retry");
                try {
                    const refreshed = await (0, auth_1.refreshAccessToken)(this._httpClient, tokens.refresh_token);
                    if (!refreshed) {
                        throw new Error("refresh returned null");
                    }
                    await this.saveTokens(refreshed);
                    cameras = await (0, cameras_1.fetchCameras)(this._httpClient, refreshed.access_token);
                    tokens = refreshed;
                }
                catch (retryErr) {
                    const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                    this.log.error(`Camera discovery failed after token refresh: ${msg}`);
                    await this.setStateAsync("info.connection", false, true);
                    return;
                }
            }
            else {
                const msg = err instanceof Error ? err.message : String(err);
                this.log.warn(`Camera discovery failed on startup (${msg}) — attempting cloud-degraded startup from persisted state`);
                await this.setStateAsync("info.connection", false, true);
                // v0.7.0: reactive maintenance check on 5xx at startup
                this._triggerMaintenanceFetchOn5xx();
                // v0.7.4: cloud-degraded startup — rehydrate from persisted ioBroker
                // object DB. Walk cameras.* channel objects to find previously known
                // cam IDs, seed the LAN-IP map, and kick an immediate ping sweep so
                // the lan_reachable DPs have a useful value right away.
                const allObjs = await this.getAdapterObjectsAsync();
                // Collect cam IDs from top-level channels matching cameras.<UUID-ish>
                const rehydratedIds = [];
                for (const key of Object.keys(allObjs)) {
                    // key looks like: bosch-smart-home-camera.0.cameras.<camId>
                    const m = /^[^.]+\.\d+\.cameras\.([^.]+)$/.exec(key);
                    if (m) {
                        rehydratedIds.push(m[1]);
                    }
                }
                if (rehydratedIds.length === 0) {
                    // Truly first-time install with no persisted data — bail out
                    this.log.error("No persisted camera state found — cannot start in cloud-degraded mode. " +
                        "Adapter will wait for cloud to recover.");
                    return;
                }
                const idPreview = rehydratedIds.map((id) => id.slice(0, 8)).join(", ");
                this.log.info(`Cloud-degraded startup: rehydrated ${rehydratedIds.length} camera ID(s) from object DB: ${idPreview}`);
                // Seed the LAN-IP map from persisted states
                for (const camId of rehydratedIds) {
                    const ipState = await this.getStateAsync(`cameras.${camId}.lan_ip`);
                    if (typeof ipState?.val === "string" && ipState.val) {
                        this._lanIpMap.set(camId, ipState.val);
                    }
                }
                // Kick an immediate LAN-ping sweep so the lan_reachable DPs have a
                // useful state right away (before the next state-poll tick).
                void this._pingAllCamsDuringOutage().catch(() => undefined);
                // Stay alive — the state-poll timer will re-try cloud discovery
                // periodically and the adapter becomes fully operational once the
                // cloud recovers without needing a restart.
                return;
            }
        }
        // ── Step 3: Create state tree ──────────────────────────────────────
        // v0.7.6: remove orphaned light DPs from Gen2 no-light cameras (upgrade migration)
        await this._migrateLightDps(cameras);
        // v0.7.14: remove mislabelled wifi_signal_strength DP (was "dBm" but
        // always received percent — superseded by wifi_signal_pct)
        await this._migrateWifiSignalDp(cameras);
        await this.ensureCameraObjects(cameras);
        // F13: ensure cloud.feature_flags + cloud.feature_flags_raw DPs exist
        await this.ensureCloudObjects();
        // v1.1.0: clear the upsertState shadow cache on every onReady alongside
        // _cameras/_lanIpMap. It survived restarts before, so a value the cache
        // believed was already written (but the DB lost, or that changed cloud-side
        // while the adapter was down) could be skipped by the equality short-circuit
        // in upsertState — the DP would never be refreshed this session.
        this._stateCache.clear();
        // Populate in-memory camera cache (used by handlers for Gen1/Gen2 dispatch)
        this._cameras.clear();
        for (const cam of cameras) {
            this._cameras.set(cam.id, cam);
        }
        // Hydrate runtime preference maps from persisted states so user-set
        // values survive adapter restarts (states themselves are ioBroker-persisted,
        // but the in-memory shadow maps are reset on every onReady).
        for (const cam of cameras) {
            const qState = await this.getStateAsync(`cameras.${cam.id}.stream_quality`);
            const q = typeof qState?.val === "string" ? qState.val : "high";
            this._streamQuality.set(cam.id, q === "low" ? "low" : "high");
        }
        // v0.7.4: seed the LAN-IP map from persisted states so the TCP-ping
        // path has a working address book even before the first successful
        // cloud refresh. The real LAN IP is written on every successful state
        // poll (see _pollSingleCameraState). Reloaded on every onReady so a
        // changed IP (e.g. after DHCP reassignment) is picked up on restart.
        this._lanIpMap.clear();
        for (const cam of cameras) {
            const ipState = await this.getStateAsync(`cameras.${cam.id}.lan_ip`);
            if (typeof ipState?.val === "string" && ipState.val) {
                this._lanIpMap.set(cam.id, ipState.val);
            }
        }
        if (this._lanIpMap.size > 0) {
            this.log.info(`Loaded ${this._lanIpMap.size} persisted LAN IP(s) for cloud-degraded LAN ping`);
        }
        // v0.9.0: restore persisted last-seen event IDs so side effects (motion_active,
        // auto-snapshot, MQTT) are not re-fired for events we already processed before restart.
        for (const cam of cameras) {
            const evIdState = await this.getStateAsync(`cameras.${cam.id}.last_seen_event_id`);
            if (typeof evIdState?.val === "string" && evIdState.val) {
                this._lastSeenEventId[cam.id] = evIdState.val;
            }
        }
        // Subscribe to all camera states so onStateChange receives user writes
        await this.subscribeStatesAsync("cameras.*");
        // ── Step 4: Mark connected + arm refresh loop ──────────────────────
        await this.upsertState("info.connection", true);
        await this.setStateAsync("info.connection_status", "connected", true);
        this.scheduleTokenRefresh(tokens.expires_in * 1000);
        // ── Step 4b: Auto-snapshot per camera to flip `online` from default ─
        // ensureCameraObjects() seeds `online=false` (list endpoint lacks the
        // field). Fire one snapshot per camera so markCameraReachability() can
        // flip it to the real state. Fire-and-forget — failure is logged at
        // debug, never blocks adapter start.
        for (const cam of cameras) {
            void this.handleSnapshotTrigger(cam.id).catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                this.log.debug(`Startup snapshot for ${cam.id.slice(0, 8)} failed: ${msg}`);
            });
        }
        // ── Step 5: FCM push listener (real implementation v0.3.0) ──────────
        // v0.6.0: load previously persisted FCM credentials so the listener
        // can skip the full ECDH/ACG/CBS handshake on every restart. Falls
        // back to a fresh registration if the state is empty, the ciphertext
        // is stale, or the JSON is malformed.
        const savedFcmCreds = await this._loadSavedFcmCredentials();
        this._fcmListener = new fcm_1.FcmListener(this._httpClient, tokens.access_token, {
            savedCredentials: savedFcmCreds ?? undefined,
        });
        // Silent push wake-up — Bosch sends no payload; fetch events from API
        this._fcmListener.on("push", () => {
            // v1.1.0: guard the fire-and-forget promise — fetchAndProcessEvents
            // awaits network + setStateAsync and can reject; an uncaught
            // rejection here would surface as an UnhandledPromiseRejection.
            void this.fetchAndProcessEvents().catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                this.log.debug(`FCM push event processing failed: ${msg}`);
            });
        });
        // Typed event fallback — when push contains explicit event-type data
        this._fcmListener.on("motion", (ev) => {
            void this.onFcmEvent(ev).catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                this.log.warn(`FCM typed event processing failed: ${msg}`);
            });
        });
        this._fcmListener.on("audio_alarm", (ev) => {
            void this.onFcmEvent(ev).catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                this.log.warn(`FCM typed event processing failed: ${msg}`);
            });
        });
        this._fcmListener.on("person", (ev) => {
            void this.onFcmEvent(ev).catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                this.log.warn(`FCM typed event processing failed: ${msg}`);
            });
        });
        // Registration success — log token prefix + persist creds + mark healthy
        this._fcmListener.on("registered", (creds) => {
            this.log.info(`FCM registered: ${creds.fcmToken.substring(0, 12)}...`);
            void this.setStateAsync("info.fcm_active", "healthy", true);
            // v0.6.0: persist the raw credentials so the next adapter start
            // can replay them as `savedCredentials` and avoid the full
            // ECDH/ACG/CBS handshake (saves ~1 s and a CBS round-trip).
            void this._saveFcmCredentials(creds).catch((err) => {
                this.log.warn(`Could not persist FCM credentials: ${err instanceof Error ? err.message : String(err)}`);
            });
        });
        // Per-mode failure diagnostic — emitted by FcmListener._tryStart on every
        // mode that fails to register. Without this log the user sees only the
        // generic "both iOS and Android failed" message and can't diagnose the
        // real cause (network, CBS auth, @aracna/fcm bug, ...).
        this._fcmListener.on("mode-failed", (info) => {
            this.log.warn(`FCM ${info.mode} registration failed: ${info.error.message}`);
            if (info.error.stack) {
                this.log.debug(`FCM ${info.mode} stack: ${info.error.stack}`);
            }
        });
        // Error events from FCM internals
        this._fcmListener.on("error", (err) => {
            this.log.error(`FCM error: ${err.message}`);
            void this.setStateAsync("info.fcm_active", "error", true);
        });
        // MTalk socket closed. The @aracna/fcm FcmClient does not auto-reconnect
        // (see src/lib/fcm.ts header comment), so we re-arm the listener here
        // with exponential backoff. Without this, a single transient MTalk
        // drop (e.g. Google server rotation) would leave the adapter on the
        // 30 s event-polling fallback until the next restart.
        this._fcmListener.on("disconnect", () => {
            this.log.warn("FCM disconnected — scheduling reconnect");
            void this.setStateAsync("info.fcm_active", "disconnected", true);
            this._scheduleFcmReconnect();
        });
        try {
            await this._fcmListener.start();
            await this.setStateAsync("info.fcm_active", "healthy", true);
            this.log.info("FCM push listener started");
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (err instanceof fcm_1.FcmCbsRegistrationError) {
                // v1.1.0: a CBS auth/token failure still must fall back to event
                // polling — otherwise the adapter has NO event mechanism (push
                // failed, polling never started) until a manual restart. The
                // token-refresh loop runs independently, so once the token is
                // renewed the 30s poll recovers. Log at error level (auth issue)
                // but keep the adapter usable.
                this.log.error(`FCM CBS registration failed (auth/token issue): ${msg} — falling back to event polling`);
                await this.setStateAsync("info.fcm_active", "polling", true);
                this._startEventPolling();
            }
            else {
                // FCM registration failed. Fall back to polling
                // (mirrors HA's `fcm_push_mode=polling` default-fallback) — adapter
                // stays usable; events arrive via the polling timer every 30 s.
                this.log.warn(`FCM push unavailable (${msg}) — falling back to event polling every ${BoschSmartHomeCamera.EVENT_POLL_INTERVAL_MS / 1000}s`);
                await this.setStateAsync("info.fcm_active", "polling", true);
                this._startEventPolling();
            }
            // Don't crash — adapter still usable without push (polling fallback)
        }
        // ── Step 6: Periodic camera-state poll (privacy + future fields) ────
        // Even with FCM push healthy we need this — Bosch never pushes a
        // privacy-toggle event, so app-side privacy changes only surface via
        // the next GET /v11/video_inputs. Forum #84538.
        this._startStatePolling();
        // ── Step 7: Cloud maintenance / outage discovery (v0.7.0) ────────────
        // Kick off an immediate fetch so the state is populated on the first
        // adapter start, then refresh every hour. Fire-and-forget — a community
        // site outage must never block adapter startup.
        void this._refreshMaintenanceStatus().catch(() => undefined);
        this._startMaintenancePolling();
        // ── Step 8: MQTT Bridge (v0.7.9) ─────────────────────────────────────
        // Optional publish of camera events to an external MQTT broker.
        // Connection errors are logged but must not block adapter startup.
        if (this.config.mqtt_enabled) {
            this._mqttBridge = new mqtt_bridge_1.MqttBridge(this.config, this.log);
            void this._mqttBridge.connect().catch((err) => {
                this.log.warn(`MQTT Bridge: initial connect failed — ${err instanceof Error ? err.message : String(err)}`);
            });
        }
        // ── Step 9: local HTTP snapshot server (v1.1.0) ──────────────────────
        // Optional. Serves the latest cached JPEG per camera over plain HTTP on
        // the LAN so VIS / url.cam consumers can load it without a token. Bind
        // errors (e.g. port in use) are logged but must not block startup.
        const snapPort = Number(this.config.snapshot_http_port) || 0;
        if (snapPort > 0) {
            this._snapshotHost = (0, snapshot_server_1.detectLanIp)();
            try {
                this._snapshotServer = await (0, snapshot_server_1.startSnapshotServer)({
                    port: snapPort,
                    getSnapshot: (camId) => this._latestSnapshots.get(camId),
                    log: this.log,
                });
                // Publish the url.cam endpoint for every known camera now — the
                // URL is valid even before the first snapshot is cached (it 404s
                // until then, which VIS image widgets handle gracefully).
                for (const camId of this._cameras.keys()) {
                    await this.setStateAsync(`cameras.${camId}.snapshot_url`, (0, snapshot_server_1.snapshotUrl)(this._snapshotHost, snapPort, camId), true);
                }
            }
            catch (err) {
                this.log.warn(`snapshot server disabled — ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        this.log.info(`Bosch Smart Home Camera adapter ready — ${cameras.length} camera(s) active`);
    }
    /**
     * Periodic refetch of `/v11/video_inputs` to mirror app-side state changes
     * (privacy, in the future also name / firmware) into ioBroker DPs.
     *
     * Designed to be cheap — single GET, ~1–2 kB JSON per call, 30 s cadence.
     * Idempotent: re-calling while a timer is already armed is a no-op.
     * Stops itself on token expiry; the token-refresh loop will re-arm.
     */
    _startStatePolling() {
        if (this._statePollTimer) {
            return;
        }
        const timer = this.setInterval(() => {
            void this._pollCameraStateOnce().catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                this.log.debug(`Camera state poll tick failed: ${msg}`);
            });
        }, BoschSmartHomeCamera.STATE_POLL_INTERVAL_MS);
        this._statePollTimer = timer;
    }
    /**
     * Single tick of the state poll: GET /v11/video_inputs, sync per-camera
     * fields that exist in that response back to DPs (currently just
     * privacy_enabled; light fields live on /lighting and aren't polled).
     */
    async _pollCameraStateOnce() {
        const token = this._currentAccessToken;
        if (!token) {
            // Token refresh in flight — skip; next tick will retry
            return;
        }
        let cameras;
        try {
            cameras = await (0, cameras_1.fetchCameras)(this._httpClient, token);
        }
        catch (err) {
            if (err instanceof cameras_1.UnauthorizedError) {
                // Let the refresh loop handle it — don't fight here
                this.log.debug("State poll: 401 — token refresh will recover");
                return;
            }
            // v0.7.0: reactive maintenance re-fetch on 5xx — a sustained cloud
            // outage triggers the community RSS check (with 5 min cooldown).
            this._triggerMaintenanceFetchOn5xx();
            // v0.7.4: kick an outage ping sweep so the lan_reachable DPs have
            // a fresh state even though the cloud-driven data loop won't run.
            void this._pingAllCamsDuringOutage().catch(() => undefined);
            throw err;
        }
        // Slow-tier diagnostics: every SLOW_TIER_THRESHOLD ticks (10 × 30s = 300s).
        // F4/F6 run per-camera inside _pollSingleCameraState (slow-tier gate passed via arg).
        // F13 runs at account level here.
        this._diagPollTick++;
        const doSlowTier = this._diagPollTick >= BoschSmartHomeCamera.SLOW_TIER_THRESHOLD;
        if (doSlowTier) {
            this._diagPollTick = 0;
            // F13: cloud feature flags — account-level, fetch once per 300s
            void this._pollFeatureFlags(token).catch(() => undefined);
        }
        // v0.6.0: poll each camera in parallel. With 4 cameras the per-tick
        // wall-time drops from ~N * 250 ms to ~250 ms because every camera
        // owns its own DP namespace (`cameras.<id>.*`), so concurrent writes
        // don't race.
        await Promise.all(cameras.map((cam) => this._pollSingleCameraState(token, cam, doSlowTier)));
    }
    /**
     * Per-camera body of `_pollCameraStateOnce` (extracted for `Promise.all`).
     *
     * @param token
     * @param cam
     * @param doSlowTier
     */
    async _pollSingleCameraState(token, cam, doSlowTier = false) {
        // Refresh the in-memory metadata cache too (so generation/name stays
        // current after a Bosch-app rename)
        this._cameras.set(cam.id, cam);
        // v0.7.14: keep `lan_reachable` fresh. Pre-v0.7.14 the DP was only
        // updated during cloud outages, so users on a healthy cloud always
        // saw `lan_reachable=false` (the default) even when the cam was
        // pingable. Fire-and-forget so it runs in parallel with the cloud
        // queries below; no impact on poll latency.
        if (this._lanIpMap.has(cam.id)) {
            void this._tcpPing(cam.id).catch(() => undefined);
        }
        if (cam.privacyMode !== undefined) {
            const desired = cam.privacyMode === "ON";
            // Only write when changed — upsertState already dedupes, but a
            // log line per camera every 30 s would be noisy.
            const current = await this.getStateAsync(`cameras.${cam.id}.privacy_enabled`);
            if (current?.val !== desired) {
                await this.upsertState(`cameras.${cam.id}.privacy_enabled`, desired);
                this.log.debug(`State poll: ${cam.id.slice(0, 8)} privacy ` +
                    `${current?.val ? "ON" : "OFF"} → ${desired ? "ON" : "OFF"} (from cloud)`);
                // External privacy-toggle (user pressed Privat in the Bosch
                // app, not via this adapter) rotates the camera's Digest
                // credentials server-side. The cached LiveSession holds the
                // pre-toggle credentials and will keep publishing them as
                // the stream_url DP — external clients (BlueIris, VLC, ...)
                // then get 401 / "Check Port/User/Password" until we issue
                // a fresh PUT /connection.
                // Bug repro: forum.iobroker.net post #1341076 (Jaschkopf,
                // 2026-05-23) — both ON→OFF and OFF→ON paths handled here
                // because Bosch invalidates the prior creds on both edges.
                //
                // Fix: drop the cached session AND clear the published
                // stream_url DPs so consumers see "no stream" immediately
                // (instead of stale creds that 401). The next ensureLiveSession
                // call (next stream-toggle, snapshot, RCP write, or watchdog
                // tick) unconditionally fetches rotated Digest creds and
                // re-publishes the URLs.
                if (this._liveSessions.has(cam.id)) {
                    const oldSession = this._liveSessions.get(cam.id);
                    this._liveSessions.delete(cam.id);
                    // v1.1.0: stop the watchdog + bump the generation too.
                    // Otherwise it keeps counting down against the dropped
                    // session and, on its next renewal, opens a NEW Bosch
                    // session that the eventual _teardownStream misses
                    // (its has()-check is false) → server-side session leak.
                    // HA cancels the renewal task BEFORE dropping the session.
                    const staleWatchdog = this._sessionWatchdogs.get(cam.id);
                    if (staleWatchdog) {
                        staleWatchdog.stop();
                        this._sessionWatchdogs.delete(cam.id);
                    }
                    this._streamGeneration.set(cam.id, (this._streamGeneration.get(cam.id) ?? 0) + 1);
                    // Clear the now-stale stream URLs so external clients see
                    // an empty value (and refuse to connect with bogus creds)
                    // instead of trying the stale URL and getting a 401.
                    await this.upsertState(`cameras.${cam.id}.stream_url`, "");
                    await this.upsertState(`cameras.${cam.id}.stream_url_sub`, "");
                    this.log.info(`Privacy toggled externally for ${cam.id.slice(0, 8)} — ` +
                        `dropped cached LiveSession (opened ${oldSession ? Math.round((Date.now() - oldSession.openedAt) / 1000) : "?"}s ago) ` +
                        `+ cleared stream_url DPs so external clients reconnect with rotated Digest creds`);
                }
                // v0.7.13: ON→OFF (camera is streamable again) AND someone
                // is actively pulling the stream → eagerly fetch a fresh
                // LiveSession so the TLS proxy's in-memory Digest creds
                // are refreshed BEFORE the next BlueIris/VLC reconnect.
                // Without this eager refresh, the proxy keeps its stale
                // creds until something else (snapshot, watchdog, …) calls
                // ensureLiveSession — meanwhile clients see 401 in their
                // RTSP auth dance. Forum #1341076 (Jaschkopf, 2026-05-23).
                if (desired === false && this._livestreamEnabled.get(cam.id) === true) {
                    void this.ensureLiveSession(cam.id).catch((err) => {
                        const msg = err instanceof Error ? err.message : String(err);
                        this.log.debug(`Eager LiveSession refresh after privacy ON→OFF failed for ` +
                            `${cam.id.slice(0, 8)} — ${msg} (next consumer will retry)`);
                    });
                }
            }
        }
        // ── v0.7.7 WiFi info — GET /v11/video_inputs/{id}/wifiinfo ─────────
        // Read-only; best-effort (camera may be on Ethernet → 404).
        // Fetched for all cameras in the coordinator poll cycle.
        await this._pollWifiInfo(token, cam.id);
        // v1.1.0: mirror push-notification status from the listing field
        // (notificationsEnabledStatus) → notifications_enabled DP, so a toggle
        // made in the Bosch app propagates back to ioBroker. ALWAYS_OFF → false,
        // FOLLOW_CAMERA_SCHEDULE / ON_CAMERA_SCHEDULE → true; absent → skip.
        if (cam.notificationsEnabledStatus !== undefined) {
            const notifOn = cam.notificationsEnabledStatus.toUpperCase() !== "ALWAYS_OFF";
            await this.upsertState(`cameras.${cam.id}.notifications_enabled`, notifOn);
        }
        // v1.1.0: motion enabled + sensitivity — GET /motion mirrors both DPs
        // AND seeds _motionCache so the write handler has a full body to merge
        // into (Bosch /motion rejects partial PUTs). All cameras.
        await this._pollMotionConfig(token, cam.id);
        // v0.7.14: Gen2 intrusionDetectionConfig — mirrors sensitivity +
        // distance into DPs AND seeds the write-cache so the user-write
        // handler has a full body to merge into (Bosch rejects DELTA PUTs).
        if (cam.generation >= 2) {
            await this._pollIntrusionConfig(token, cam.id);
        }
        // v0.8.0: lens elevation (Gen2 only) — seed write-cache + mirror DP.
        if (cam.generation >= 2) {
            await this._pollLensElevation(token, cam.id);
        }
        // v0.8.0: global lighting (Gen2 Outdoor only) — darkness_threshold DP.
        if (cam.generation >= 2 &&
            cam.hardwareVersion !== "HOME_Eyes_Indoor" &&
            cam.hardwareVersion !== "CAMERA_INDOOR_GEN2") {
            await this._pollGlobalLighting(token, cam.id);
        }
        // v0.8.0: alarm settings (Indoor II only) — siren_duration, alarm_activation_delay, pre_alarm_delay DPs.
        if (cam.hardwareVersion === "HOME_Eyes_Indoor" ||
            cam.hardwareVersion === "CAMERA_INDOOR_GEN2") {
            await this._pollAlarmSettings(token, cam.id);
        }
        // F4/F6 slow-tier LAN diagnostic reads — all cameras, before the Gen1/no-light
        // early return so Gen1 cams still get ONVIF scopes + RCP version.
        // Gated on slow-tier tick; best-effort (errors swallowed inside helper).
        if (doSlowTier) {
            await this._pollLanDiagnostics(cam.id);
        }
        // v0.9.1: unread_events_count — sourced from GET /v11/events (count of
        // isRead=false events). The listing's `cam.numberOfUnreadEvents` field
        // was found unreliable in live testing 2026-05-28 (reported 0 while
        // 44 events were actually unread on the-gen2-outdoor). See _pollUnreadCount.
        await this._pollUnreadCount(token, cam.id);
        // v0.9.0: privacy_sound_enabled — poll current state for all cameras.
        await this._pollPrivacySound(token, cam.id);
        // v0.9.0: autofollow_enabled — Gen1 360° only (panLimit > 0).
        if (cam.panLimit > 0) {
            await this._pollAutofollow(token, cam.id);
        }
        // ── Gen2 lighting/switch — seed cache + sync wallwasher DPs ────────
        // /lighting/switch is a separate endpoint (not in /v11/video_inputs),
        // so we fetch it per-camera. Only Gen2 cams with featureSupport.light
        // get this path — Gen1 has no RGB hardware.
        if (cam.generation < 2 || cam.featureLight !== true) {
            return;
        }
        const ls = await (0, alarm_light_1.fetchLightingState)(this._httpClient, token, cam.id);
        if (!ls) {
            return;
        }
        this._lightingCache.set(cam.id, ls);
        // Mirror wallwasher (top+bottom LED) into DPs. Use the brighter of
        // the two groups as the displayed brightness; colour follows the top
        // LED (they're driven together by wallwasher writes anyway).
        const top = ls.topLedLightSettings;
        const bot = ls.bottomLedLightSettings;
        const brightness = Math.max(top.brightness, bot.brightness);
        const color = top.color ?? bot.color ?? "";
        const frontOn = ls.frontLightSettings.brightness > 0;
        const wallOn = brightness > 0;
        // Batch the 4 getStateAsync reads instead of serialising them.
        const [curBr, curCol, curFront, curWall] = await Promise.all([
            this.getStateAsync(`cameras.${cam.id}.wallwasher_brightness`),
            this.getStateAsync(`cameras.${cam.id}.wallwasher_color`),
            this.getStateAsync(`cameras.${cam.id}.front_light_enabled`),
            this.getStateAsync(`cameras.${cam.id}.wallwasher_enabled`),
        ]);
        const writes = [];
        if (curBr?.val !== brightness) {
            writes.push(this.upsertState(`cameras.${cam.id}.wallwasher_brightness`, brightness));
        }
        if (curCol?.val !== color) {
            writes.push(this.upsertState(`cameras.${cam.id}.wallwasher_color`, color));
        }
        // Derive the boolean on/off DPs from brightness so app-side toggles
        // propagate back to ioBroker. Without this, the user saw stream +
        // colour update but front_light_enabled / wallwasher_enabled stayed
        // frozen at the last adapter-initiated value (forum #1339866).
        if (curFront?.val !== frontOn) {
            writes.push(this.upsertState(`cameras.${cam.id}.front_light_enabled`, frontOn));
        }
        if (curWall?.val !== wallOn) {
            writes.push(this.upsertState(`cameras.${cam.id}.wallwasher_enabled`, wallOn));
        }
        await Promise.all(writes);
    }
    // ── v0.7.7 WiFi info poll ───────────────────────────────────────────────
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
    async _pollIntrusionConfig(token, camId) {
        try {
            const url = `${auth_1.CLOUD_API}/v11/video_inputs/${camId}/intrusionDetectionConfig`;
            const resp = await this._httpClient.get(url, {
                headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
                // 443 = privacy mode active, settings frozen (HA convention).
                // Skip silently — DPs keep their last-known value from the
                // pre-privacy poll, write-cache stays fresh until privacy
                // is lifted.
                validateStatus: (s) => (s >= 200 && s < 300) || s === 404 || s === 443,
            });
            if (resp.status === 404 || resp.status === 443 || !resp.data) {
                return;
            }
            const data = resp.data;
            this._intrusionConfigCache.set(camId, { ...data });
            const sensitivity = typeof data.sensitivity === "number" ? data.sensitivity : undefined;
            const distance = typeof data.distance === "number" ? data.distance : undefined;
            const writes = [];
            if (sensitivity !== undefined) {
                writes.push(this.upsertState(`cameras.${camId}.intrusion_sensitivity`, sensitivity));
            }
            if (distance !== undefined) {
                writes.push(this.upsertState(`cameras.${camId}.intrusion_distance`, distance));
            }
            await Promise.all(writes);
        }
        catch (err) {
            this.log.debug(`Intrusion config poll for ${camId.slice(0, 8)} failed: ` +
                `${err instanceof Error ? err.message : String(err)}`);
        }
    }
    // ── v1.1.0 motion config poll ───────────────────────────────────────────
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
    async _pollMotionConfig(token, camId) {
        try {
            const url = `${auth_1.CLOUD_API}/v11/video_inputs/${camId}/motion`;
            const resp = await this._httpClient.get(url, {
                headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
                validateStatus: (s) => (s >= 200 && s < 300) || s === 404 || s === 443,
            });
            if (resp.status === 404 || resp.status === 443 || !resp.data) {
                return;
            }
            const data = resp.data;
            this._motionCache.set(camId, { ...data });
            const writes = [];
            if (typeof data.enabled === "boolean") {
                writes.push(this.upsertState(`cameras.${camId}.motion_enabled`, data.enabled));
            }
            if (typeof data.motionAlarmConfiguration === "string") {
                const sens = data.motionAlarmConfiguration.toLowerCase();
                const allowed = new Set([
                    "super_high",
                    "high",
                    "medium_high",
                    "medium_low",
                    "low",
                    "off",
                ]);
                if (allowed.has(sens)) {
                    writes.push(this.upsertState(`cameras.${camId}.motion_sensitivity`, sens));
                }
            }
            await Promise.all(writes);
        }
        catch (err) {
            this.log.debug(`Motion config poll for ${camId.slice(0, 8)} failed: ` +
                `${err instanceof Error ? err.message : String(err)}`);
        }
    }
    // ── v0.8.0 lens elevation poll ──────────────────────────────────────────
    /**
     * Poll lens elevation from GET /v11/video_inputs/{id}/lens_elevation.
     * Seeds the write-cache and mirrors the value into the DP.
     * Gen2 only. Best-effort — errors swallowed.
     *
     * @param token  Current access_token
     * @param camId  Camera UUID
     */
    async _pollLensElevation(token, camId) {
        try {
            const url = `${auth_1.CLOUD_API}/v11/video_inputs/${camId}/lens_elevation`;
            const resp = await this._httpClient.get(url, {
                headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
                validateStatus: (s) => (s >= 200 && s < 300) || s === 404 || s === 443,
            });
            if (resp.status === 404 || resp.status === 443 || !resp.data) {
                return;
            }
            const data = resp.data;
            const elevation = typeof data.elevation === "number" ? data.elevation : undefined;
            if (elevation !== undefined) {
                this._lensElevationCache.set(camId, elevation);
                await this.upsertState(`cameras.${camId}.lens_elevation`, elevation);
            }
        }
        catch (err) {
            this.log.debug(`Lens elevation poll for ${camId.slice(0, 8)} failed: ` +
                `${err instanceof Error ? err.message : String(err)}`);
        }
    }
    // ── v0.8.0 global lighting (darkness_threshold) poll ───────────────────
    /**
     * Poll global lighting config from GET /v11/video_inputs/{id}/lighting.
     * Seeds the write-cache and mirrors darknessThreshold (0.0–1.0) → DP (0–100 %).
     * Gen2 Outdoor only. Best-effort — errors swallowed.
     *
     * @param token  Current access_token
     * @param camId  Camera UUID
     */
    async _pollGlobalLighting(token, camId) {
        try {
            const url = `${auth_1.CLOUD_API}/v11/video_inputs/${camId}/lighting`;
            const resp = await this._httpClient.get(url, {
                headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
                validateStatus: (s) => (s >= 200 && s < 300) || s === 404 || s === 443,
            });
            if (resp.status === 404 || resp.status === 443 || !resp.data) {
                return;
            }
            const data = resp.data;
            this._globalLightingCache.set(camId, { ...data });
            const dt = typeof data.darknessThreshold === "number" ? data.darknessThreshold : undefined;
            if (dt !== undefined) {
                // Convert from Bosch float (0.0–1.0) to user-facing percent (0–100)
                await this.upsertState(`cameras.${camId}.darkness_threshold`, Math.round(dt * 100));
            }
        }
        catch (err) {
            this.log.debug(`Global lighting poll for ${camId.slice(0, 8)} failed: ` +
                `${err instanceof Error ? err.message : String(err)}`);
        }
    }
    // ── v0.8.0 alarm settings poll ─────────────────────────────────────────
    /**
     * Poll alarm settings from GET /v11/video_inputs/{id}/alarm_settings.
     * Seeds the write-cache and mirrors alarm delay fields into DPs.
     * HOME_Eyes_Indoor / CAMERA_INDOOR_GEN2 only. Best-effort — errors swallowed.
     *
     * @param token  Current access_token
     * @param camId  Camera UUID
     */
    async _pollAlarmSettings(token, camId) {
        try {
            const url = `${auth_1.CLOUD_API}/v11/video_inputs/${camId}/alarm_settings`;
            const resp = await this._httpClient.get(url, {
                headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
                validateStatus: (s) => (s >= 200 && s < 300) || s === 404 || s === 443,
            });
            if (resp.status === 404 || resp.status === 443 || !resp.data) {
                return;
            }
            const data = resp.data;
            this._alarmSettingsCache.set(camId, { ...data });
            const writes = [];
            const sirenDur = typeof data.alarmDelayInSeconds === "number" ? data.alarmDelayInSeconds : undefined;
            const actDelay = typeof data.alarmActivationDelaySeconds === "number"
                ? data.alarmActivationDelaySeconds
                : undefined;
            const preDelay = typeof data.preAlarmDelayInSeconds === "number"
                ? data.preAlarmDelayInSeconds
                : undefined;
            if (sirenDur !== undefined) {
                writes.push(this.upsertState(`cameras.${camId}.siren_duration`, sirenDur));
            }
            if (actDelay !== undefined) {
                writes.push(this.upsertState(`cameras.${camId}.alarm_activation_delay`, actDelay));
            }
            if (preDelay !== undefined) {
                writes.push(this.upsertState(`cameras.${camId}.pre_alarm_delay`, preDelay));
            }
            await Promise.all(writes);
        }
        catch (err) {
            this.log.debug(`Alarm settings poll for ${camId.slice(0, 8)} failed: ` +
                `${err instanceof Error ? err.message : String(err)}`);
        }
    }
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
    async _pollLanDiagnostics(camId) {
        const session = this._liveSessions.get(camId);
        if (!session) {
            // No active session — skip silently (user hasn't opened a stream yet)
            return;
        }
        // F4: ONVIF scopes via RCP 0x0a98
        try {
            const raw = await (0, rcp_lan_helper_1.fetchRcpLan)(session, "0x0a98");
            if (raw) {
                const scopes = (0, rcp_lan_helper_1.parseOnvifScopes)(raw);
                await this.upsertState(`cameras.${camId}.onvif_scopes`, JSON.stringify(scopes));
                this.log.debug(`F4 ONVIF scopes for ${camId.slice(0, 8)}: ` +
                    `name="${scopes.name}" hw="${scopes.hardware}" profiles=${JSON.stringify(scopes.profiles)}`);
            }
        }
        catch (err) {
            this.log.debug(`F4 ONVIF scopes poll error for ${camId.slice(0, 8)}: ` +
                `${err instanceof Error ? err.message : String(err)}`);
        }
        // F6: RCP protocol version via 0xff00
        try {
            const raw = await (0, rcp_lan_helper_1.fetchRcpLan)(session, "0xff00");
            if (raw && raw.length >= 4) {
                const ver = (0, rcp_lan_helper_1.formatRcpVersion)(raw);
                if (ver) {
                    await this.upsertState(`cameras.${camId}.rcp_version`, ver);
                    this.log.debug(`F6 RCP version for ${camId.slice(0, 8)}: ${ver}`);
                }
            }
        }
        catch (err) {
            this.log.debug(`F6 RCP version poll error for ${camId.slice(0, 8)}: ` +
                `${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /**
     * F13: fetch cloud feature flags from GET /v11/feature_flags.
     *
     * Account-level (not per-camera). Called on slow-tier ticks (≈ 300 s).
     * Caches result in _featureFlagsCache; DPs updated only on change.
     * Best-effort — errors are silently ignored.
     *
     * @param token  Current access_token
     */
    async _pollFeatureFlags(token) {
        try {
            const result = await (0, cloud_feature_flags_1.fetchFeatureFlags)(this._httpClient, token);
            if (!result) {
                return;
            }
            this._featureFlagsCache = result;
            await Promise.all([
                this.upsertState("cloud.feature_flags", result.display),
                this.upsertState("cloud.feature_flags_raw", result.raw),
            ]);
            this.log.debug(`F13 feature flags: ${result.display || "(none)"}`);
        }
        catch (err) {
            this.log.debug(`F13 feature flags poll error: ` +
                `${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /**
     * Fetch WiFi info for one camera and update DPs.
     * GET /v11/video_inputs/{id}/wifiinfo — 200 with body, 404 on Ethernet.
     * Best-effort: errors are logged at debug level and ignored.
     *
     * @param token  Current access_token
     * @param camId  Camera UUID
     */
    // ── v0.9.1 helpers ────────────────────────────────────────────────────────
    /** v0.9.1 — return true if (camId, feature) hit HTTP 442 before. */
    _isFeatureUnsupported(camId, feature) {
        return this._unsupportedFeatures.get(camId)?.has(feature) ?? false;
    }
    /** v0.9.1 — record that (camId, feature) hit HTTP 442; future calls short-circuit. */
    _markFeatureUnsupported(camId, feature) {
        let set = this._unsupportedFeatures.get(camId);
        if (!set) {
            set = new Set();
            this._unsupportedFeatures.set(camId, set);
        }
        set.add(feature);
    }
    /** v0.9.1 — backoff key for (camId, endpoint). */
    _backoffKey(camId, endpoint) {
        return `${camId}:${endpoint}`;
    }
    /** v0.9.1 — return true if this poll should be skipped due to backoff. */
    _shouldSkipPoll(camId, endpoint) {
        const entry = this._pollBackoff.get(this._backoffKey(camId, endpoint));
        return entry !== undefined && Date.now() < entry.nextAttempt;
    }
    /**
     * v0.9.1 — record poll outcome and update backoff window.
     * On success: clear backoff entry (next poll runs immediately).
     * On 444/failure: exponential backoff 30→60→120→300s (cap).
     */
    _recordPollResult(camId, endpoint, success) {
        const key = this._backoffKey(camId, endpoint);
        if (success) {
            this._pollBackoff.delete(key);
            return;
        }
        const prev = this._pollBackoff.get(key);
        const failCount = (prev?.failCount ?? 0) + 1;
        const delay = Math.min(BoschSmartHomeCamera.POLL_BACKOFF_BASE_MS * Math.pow(2, failCount - 1), BoschSmartHomeCamera.POLL_BACKOFF_CAP_MS);
        this._pollBackoff.set(key, { failCount, nextAttempt: Date.now() + delay });
    }
    async _pollWifiInfo(token, camId) {
        // v0.9.1: skip when backoff window is open (camera returning consistent 444).
        if (this._shouldSkipPoll(camId, "wifiinfo")) {
            return;
        }
        try {
            const url = `${auth_1.CLOUD_API}/v11/video_inputs/${camId}/wifiinfo`;
            const resp = await this._httpClient.get(url, {
                headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
                validateStatus: (s) => (s >= 200 && s < 300) || s === 404 || s === 444,
            });
            if (resp.status === 444) {
                // Camera returns 444 when it has no recent data for this window —
                // typical for offline cams or just-after-quota. Apply backoff.
                this._recordPollResult(camId, "wifiinfo", false);
                return;
            }
            if (resp.status === 404) {
                // Camera on Ethernet — no WiFi data, leave DPs as-is
                return;
            }
            const data = resp.data;
            // v0.7.14: Bosch's wifiinfo response uses `signalStrength` as a
            // PERCENTAGE 0-100, not dBm. Verified live against the-gen2-outdoor
            // (signalStrength=86) and 20E053B5 (signalStrength=100) on
            // FW 9.40.25. The `signalStrengthPercentage` field that v0.7.7
            // looked for never existed — dead lookup removed.
            const ssid = typeof data.ssid === "string" ? data.ssid : undefined;
            const pct = typeof data.signalStrength === "number" ? data.signalStrength : undefined;
            const writes = [];
            if (ssid !== undefined) {
                writes.push(this.upsertState(`cameras.${camId}.wifi_ssid`, ssid));
            }
            if (pct !== undefined) {
                writes.push(this.upsertState(`cameras.${camId}.wifi_signal_pct`, pct));
            }
            await Promise.all(writes);
            // v0.9.1: record success — reset backoff window
            this._recordPollResult(camId, "wifiinfo", true);
        }
        catch (err) {
            this._recordPollResult(camId, "wifiinfo", false);
            this.log.debug(`WiFi info poll for ${camId.slice(0, 8)} failed: ` +
                `${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /**
     * v0.9.1 — replaces the misleading `cam.numberOfUnreadEvents` listing field.
     * Live testing 2026-05-28 showed `numberOfUnreadEvents` reports 0 even when
     * GET /v11/events returns dozens of `isRead=false` events for the same camera
     * (mark_all_read found 44/44 unread that the listing claimed didn't exist).
     * This poller does its own count via the events endpoint.
     */
    async _pollUnreadCount(token, camId) {
        if (this._shouldSkipPoll(camId, "unread_events")) {
            return;
        }
        try {
            const url = `${auth_1.CLOUD_API}/v11/events?videoInputId=${camId}&limit=50`;
            const resp = await this._httpClient.get(url, {
                headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
                validateStatus: (s) => (s >= 200 && s < 300) || s === 444,
            });
            if (resp.status === 444) {
                this._recordPollResult(camId, "unread_events", false);
                return;
            }
            const events = Array.isArray(resp.data)
                ? resp.data
                : [];
            const unread = events.reduce((n, ev) => (ev.isRead === false ? n + 1 : n), 0);
            await this.upsertState(`cameras.${camId}.unread_events_count`, unread);
            this._recordPollResult(camId, "unread_events", true);
        }
        catch (err) {
            this._recordPollResult(camId, "unread_events", false);
            this.log.debug(`Unread events poll for ${camId.slice(0, 8)} failed: ` +
                `${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /**
     * Called whenever a subscribed state changes.
     * Only acts on ack=false states (user commands, not adapter-reported values).
     * Routes writes to the appropriate per-camera handler.
     *
     * @param id
     * @param state
     */
    async onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        } // ignore null deletions + already-ack'd values
        // id format: <namespace>.cameras.<camId>.<stateName>
        // Strip namespace prefix to get the relative id
        const ns = `${this.namespace}.`;
        const relId = id.startsWith(ns) ? id.slice(ns.length) : id;
        const idParts = relId.split(".");
        if (idParts[0] !== "cameras" || idParts.length < 3) {
            return;
        }
        const camId = idParts[1];
        const stateName = idParts.slice(2).join(".");
        this.log.debug(`State change: ${id} = ${state.val} (from user)`);
        try {
            switch (stateName) {
                case "privacy_enabled": {
                    const enabled = Boolean(state.val);
                    await this.handlePrivacyToggle(camId, enabled);
                    // Capture a fresh snapshot only when leaving privacy (live view is hidden while ON).
                    // Fire-and-forget — snapshot fetch can take a few seconds and must not block the ack path.
                    if (!enabled) {
                        void this.handleSnapshotTrigger(camId).catch((err) => {
                            const msg = err instanceof Error ? err.message : String(err);
                            this.log.debug(`Auto-snapshot after privacy off failed for ${camId}: ${msg}`);
                        });
                    }
                    break;
                }
                case "notifications_enabled":
                    // v1.1.0: push-notification schedule on/off (all cameras).
                    // Skip generic ack if the write was rejected (privacy 443).
                    if (!(await this._handleNotificationsWrite(camId, Boolean(state.val)))) {
                        return;
                    }
                    break;
                case "motion_enabled":
                    // v1.1.0: motion detection on/off (shared /motion endpoint).
                    // Skip the generic ack when the write was rejected (privacy
                    // 443) so the DP keeps its real value instead of a misleading
                    // optimistic one — the next poll re-syncs from the device.
                    if (!(await this._handleMotionWrite(camId, { enabled: Boolean(state.val) }))) {
                        return;
                    }
                    break;
                case "motion_sensitivity": {
                    // v1.1.0: motion sensitivity select (shared /motion endpoint).
                    const sens = typeof state.val === "string" ? state.val : "";
                    const allowed = new Set([
                        "super_high",
                        "high",
                        "medium_high",
                        "medium_low",
                        "low",
                        "off",
                    ]);
                    if (!allowed.has(sens)) {
                        this.log.warn(`motion_sensitivity write for ${camId.slice(0, 8)} ignored — invalid value "${sens}"`);
                        return; // skip ack — keep the last valid value
                    }
                    if (!(await this._handleMotionWrite(camId, { sensitivity: sens }))) {
                        return; // skip ack — write rejected (privacy 443)
                    }
                    break;
                }
                case "light_enabled": {
                    // v0.7.6: Indoor II (Gen2, featureLight=false) has no LEDs —
                    // ignore writes that may arrive from old automations on existing installs.
                    const camLight = this._cameras.get(camId);
                    const hasLightHw = camLight?.generation !== 2 || camLight.featureLight === true;
                    if (!hasLightHw) {
                        this.log.warn(`light_enabled write for ${camId.slice(0, 8)} ignored — camera has no light hardware`);
                        break;
                    }
                    await this.handleLightToggle(camId, Boolean(state.val));
                    // Refresh snapshot so the dashboard reflects the new lighting.
                    void this.handleSnapshotTrigger(camId).catch((err) => {
                        const msg = err instanceof Error ? err.message : String(err);
                        this.log.debug(`Auto-snapshot after light toggle failed for ${camId}: ${msg}`);
                    });
                    break;
                }
                case "front_light_enabled": {
                    const camFront = this._cameras.get(camId);
                    const hasFrontHw = camFront?.generation !== 2 || camFront.featureLight === true;
                    if (!hasFrontHw) {
                        this.log.warn(`front_light_enabled write for ${camId.slice(0, 8)} ignored — camera has no light hardware`);
                        break;
                    }
                    await this.handleFrontLightToggle(camId, Boolean(state.val));
                    void this.handleSnapshotTrigger(camId).catch((err) => {
                        const msg = err instanceof Error ? err.message : String(err);
                        this.log.debug(`Auto-snapshot after front_light toggle failed for ${camId}: ${msg}`);
                    });
                    break;
                }
                case "wallwasher_enabled": {
                    const camWW = this._cameras.get(camId);
                    const hasWwHw = camWW?.generation !== 2 || camWW.featureLight === true;
                    if (!hasWwHw) {
                        this.log.warn(`wallwasher_enabled write for ${camId.slice(0, 8)} ignored — camera has no light hardware`);
                        break;
                    }
                    await this.handleWallwasherToggle(camId, Boolean(state.val));
                    void this.handleSnapshotTrigger(camId).catch((err) => {
                        const msg = err instanceof Error ? err.message : String(err);
                        this.log.debug(`Auto-snapshot after wallwasher toggle failed for ${camId}: ${msg}`);
                    });
                    break;
                }
                case "image_rotation_180":
                    await this.handleImageRotationToggle(camId, Boolean(state.val));
                    break;
                case "snapshot_trigger":
                    if (state.val) {
                        await this.handleSnapshotTrigger(camId);
                        // Reset trigger button to false (no longer "pending")
                        await this.setStateAsync(id, false, true);
                    }
                    return; // skip generic ack below
                case "motion_trigger":
                    if (state.val) {
                        // Read the sibling event-type state (default "motion")
                        const etState = await this.getStateAsync(`cameras.${camId}.motion_trigger_event_type`);
                        const validTypes = new Set(["motion", "person", "audio_alarm"]);
                        const rawEt = typeof etState?.val === "string" ? etState.val : "motion";
                        const eventType = validTypes.has(rawEt) ? rawEt : "motion";
                        await this.triggerSyntheticMotion(camId, eventType);
                        // Reset trigger button to false
                        await this.setStateAsync(id, false, true);
                    }
                    return; // skip generic ack below
                case "stream_quality":
                    await this.handleStreamQualityChange(camId, String(state.val));
                    break;
                case "livestream_enabled":
                    await this.handleLivestreamToggle(camId, Boolean(state.val));
                    break;
                case "siren_active":
                    await this.handleSirenToggle(camId, Boolean(state.val));
                    break;
                case "wallwasher_color":
                    await this.handleWallwasherUpdate(camId, {
                        color: typeof state.val === "string" ? state.val : "",
                    });
                    break;
                case "wallwasher_brightness":
                    await this.handleWallwasherUpdate(camId, {
                        brightness: typeof state.val === "number"
                            ? state.val
                            : parseInt(String(state.val), 10),
                    });
                    break;
                case "microphone_level": {
                    // v0.7.7: audio level — PUT /v11/video_inputs/{id}/audio (Gen2)
                    const camAudio = this._cameras.get(camId);
                    if (!camAudio || camAudio.generation < 2) {
                        this.log.warn(`microphone_level write for ${camId.slice(0, 8)} ignored — Gen2 only`);
                        return; // skip ack — not a supported state on this camera
                    }
                    await this._handleAudioLevelWrite(camId, "microphone", Number(state.val));
                    break;
                }
                case "speaker_level": {
                    // v0.7.7: audio level — PUT /v11/video_inputs/{id}/audio (Gen2)
                    const camSpk = this._cameras.get(camId);
                    if (!camSpk || camSpk.generation < 2) {
                        this.log.warn(`speaker_level write for ${camId.slice(0, 8)} ignored — Gen2 only`);
                        return; // skip ack
                    }
                    await this._handleAudioLevelWrite(camId, "speaker", Number(state.val));
                    break;
                }
                case "intrusion_sensitivity": {
                    // v0.7.7: intrusion detection config (Gen2)
                    const camIs = this._cameras.get(camId);
                    if (!camIs || camIs.generation < 2) {
                        this.log.warn(`intrusion_sensitivity write for ${camId.slice(0, 8)} ignored — Gen2 only`);
                        return; // skip ack
                    }
                    {
                        // v1.0.5: clamp to the valid 0–7 range and ack the CLAMPED
                        // value (mirrors intrusion_distance) so the UI never shows a
                        // sensitivity the camera never received (object max is 7).
                        const reqSensitivity = Math.max(0, Math.min(7, Math.round(Number(state.val))));
                        await this._handleIntrusionWrite(camId, { sensitivity: reqSensitivity });
                        await this.setStateAsync(id, reqSensitivity, true);
                    }
                    return; // already acked clamped value
                }
                case "intrusion_distance": {
                    // v0.7.7: intrusion detection config (Gen2)
                    const camId2 = this._cameras.get(camId);
                    if (!camId2 || camId2.generation < 2) {
                        this.log.warn(`intrusion_distance write for ${camId.slice(0, 8)} ignored — Gen2 only`);
                        return; // skip ack
                    }
                    {
                        // v1.0.3: clamp to the valid 1–8 m range (Bosch rejects
                        // > 8 with HTTP 400) and ack the CLAMPED value so the UI
                        // doesn't show an out-of-range distance the camera never
                        // received (object max is 8).
                        const reqDistance = Math.max(1, Math.min(8, Math.round(Number(state.val))));
                        await this._handleIntrusionWrite(camId, { distance: reqDistance });
                        await this.setStateAsync(id, reqDistance, true);
                    }
                    return; // already acked clamped value
                }
                case "pan_position": {
                    // v0.7.8: absolute pan position — Gen1 CAMERA_360 only (panLimit > 0)
                    const camPan = this._cameras.get(camId);
                    if (!camPan || camPan.panLimit <= 0) {
                        this.log.warn(`pan_position write for ${camId.slice(0, 8)} ignored — camera has no pan hardware`);
                        return; // skip ack
                    }
                    {
                        // v1.0.3: ack the CLAMPED position (not the raw user
                        // value) so the UI reflects where the camera actually
                        // moved. _handlePanWrite clamps to ±panLimit.
                        const appliedPan = await this._handlePanWrite(camId, Math.round(Number(state.val)));
                        // null = session-quota 444 (handled as warn) → leave
                        // the position un-acked so it shows as pending.
                        if (appliedPan !== null) {
                            await this.setStateAsync(id, appliedPan, true);
                        }
                    }
                    return; // already acked clamped value (or skipped on 444)
                }
                case "pan_preset": {
                    // v0.7.8: named pan preset — Gen1 CAMERA_360 only (panLimit > 0)
                    const camPreset = this._cameras.get(camId);
                    if (!camPreset || camPreset.panLimit <= 0) {
                        this.log.warn(`pan_preset write for ${camId.slice(0, 8)} ignored — camera has no pan hardware`);
                        return; // skip ack
                    }
                    const PAN_PRESET_MAP = {
                        home: 0,
                        left: -60,
                        right: 60,
                        "back-left": -120,
                        "back-right": 120,
                    };
                    const presetName = String(state.val).toLowerCase();
                    if (!(presetName in PAN_PRESET_MAP)) {
                        this.log.warn(`pan_preset write for ${camId.slice(0, 8)}: unknown preset "${presetName}" — ignored`);
                        return; // skip ack
                    }
                    const appliedPreset = await this._handlePanWrite(camId, PAN_PRESET_MAP[presetName]);
                    // Also ack the position DP so UI stays in sync — use the
                    // clamped value actually written (v1.0.3). null = 444
                    // session-quota (handled as warn) → skip position sync.
                    if (appliedPreset !== null) {
                        await this.setStateAsync(`cameras.${camId}.pan_position`, appliedPreset, true);
                    }
                    break;
                }
                case "lens_elevation": {
                    // v0.8.0: lens mounting height — PUT /lens_elevation (Gen2 only)
                    const camLe = this._cameras.get(camId);
                    if (!camLe || camLe.generation < 2) {
                        this.log.warn(`lens_elevation write for ${camId.slice(0, 8)} ignored — Gen2 only`);
                        return; // skip ack
                    }
                    await this._handleLensElevationWrite(camId, Number(state.val));
                    break;
                }
                case "darkness_threshold": {
                    // v0.8.0: darkness threshold — PUT /lighting (Gen2 Outdoor only)
                    const camDt = this._cameras.get(camId);
                    if (!camDt ||
                        camDt.generation < 2 ||
                        camDt.hardwareVersion === "HOME_Eyes_Indoor" ||
                        camDt.hardwareVersion === "CAMERA_INDOOR_GEN2") {
                        this.log.warn(`darkness_threshold write for ${camId.slice(0, 8)} ignored — Gen2 Outdoor only`);
                        return; // skip ack
                    }
                    await this._handleDarknessThresholdWrite(camId, Number(state.val));
                    break;
                }
                case "siren_duration": {
                    // v0.8.0: siren duration — PUT /alarm_settings (Indoor II only)
                    const camSd = this._cameras.get(camId);
                    if (!camSd ||
                        (camSd.hardwareVersion !== "HOME_Eyes_Indoor" &&
                            camSd.hardwareVersion !== "CAMERA_INDOOR_GEN2")) {
                        this.log.warn(`siren_duration write for ${camId.slice(0, 8)} ignored — Indoor II only`);
                        return; // skip ack
                    }
                    await this._handleAlarmSettingsWrite(camId, {
                        alarmDelayInSeconds: Math.round(Number(state.val)),
                    });
                    break;
                }
                case "alarm_activation_delay": {
                    // v0.8.0: alarm activation delay — PUT /alarm_settings (Indoor II only)
                    const camAad = this._cameras.get(camId);
                    if (!camAad ||
                        (camAad.hardwareVersion !== "HOME_Eyes_Indoor" &&
                            camAad.hardwareVersion !== "CAMERA_INDOOR_GEN2")) {
                        this.log.warn(`alarm_activation_delay write for ${camId.slice(0, 8)} ignored — Indoor II only`);
                        return; // skip ack
                    }
                    await this._handleAlarmSettingsWrite(camId, {
                        alarmActivationDelaySeconds: Math.round(Number(state.val)),
                    });
                    break;
                }
                case "pre_alarm_delay": {
                    // v0.8.0: pre-alarm LED delay — PUT /alarm_settings (Indoor II only)
                    const camPad = this._cameras.get(camId);
                    if (!camPad ||
                        (camPad.hardwareVersion !== "HOME_Eyes_Indoor" &&
                            camPad.hardwareVersion !== "CAMERA_INDOOR_GEN2")) {
                        this.log.warn(`pre_alarm_delay write for ${camId.slice(0, 8)} ignored — Indoor II only`);
                        return; // skip ack
                    }
                    await this._handleAlarmSettingsWrite(camId, {
                        preAlarmDelayInSeconds: Math.round(Number(state.val)),
                    });
                    break;
                }
                case "privacy_sound_enabled": {
                    // v0.9.0: privacy sound override — GET/PUT /privacy_sound_override
                    await this._handlePrivacySoundWrite(camId, Boolean(state.val));
                    break;
                }
                case "autofollow_enabled": {
                    // v0.9.0: autofollow — Gen1 360° only (panLimit > 0)
                    const camAf = this._cameras.get(camId);
                    if (!camAf || camAf.panLimit <= 0) {
                        this.log.warn(`autofollow_enabled write for ${camId.slice(0, 8)} ignored — Gen1 360° only`);
                        return; // skip ack
                    }
                    await this._handleAutofollowWrite(camId, Boolean(state.val));
                    break;
                }
                case "mark_all_read": {
                    // v0.9.0: mark all events as read
                    if (state.val) {
                        await this._handleMarkAllRead(camId);
                        await this.setStateAsync(id, false, true);
                    }
                    return; // skip generic ack below (button pattern)
                }
                default:
                    return; // unknown writable state — no-op
            }
            // On success: ack the state with the value the user requested
            await this.setStateAsync(id, state.val, true);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.error(`Failed to handle ${stateName} for ${camId}: ${msg}`);
            // Don't ack — leave state in user-set (ack=false) so it's visible as "pending failed"
        }
    }
    // ── FCM event handler ───────────────────────────────────────────────────
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
    async onFcmEvent(ev) {
        const prefix = `cameras.${ev.cameraId}`;
        const ts = BoschSmartHomeCamera.normaliseBoschTimestamp(ev.timestamp);
        await this.setStateAsync(`${prefix}.last_motion_at`, ts, true);
        await this.setStateAsync(`${prefix}.last_motion_event_type`, ev.eventType, true);
        // v1.1.0: record this event id in the SAME dedup map+state that the
        // 30s polling fallback checks (fetchAndProcessEvents). Without it, an
        // FCM-processed event is re-discovered + re-fired by the poll after an
        // adapter restart (duplicate motion_active/snapshot/MQTT). HA applies
        // one dedup key to both the push and poll paths. Only when the FCM
        // payload carried an id (same Bosch event id as GET /v11/events).
        if (ev.eventId) {
            this._lastSeenEventId[ev.cameraId] = ev.eventId;
            await this.setStateAsync(`${prefix}.last_seen_event_id`, ev.eventId, true);
        }
        this.log.info(`FCM event [${ev.eventType}] for camera ${ev.cameraId.slice(0, 8)} at ${ev.timestamp}`);
        this._publishMqttEvent(ev.cameraId, ev.eventType, ts, ev.eventId ?? "");
        await this._onMotionFired(ev.cameraId);
    }
    /**
     * v0.7.9: publish a camera event to the MQTT bridge (fire-and-forget).
     * No-op when the bridge is not connected.
     *
     * @param camId      Camera UUID
     * @param eventType  "motion" | "person" | "audio_alarm"
     * @param timestamp  ISO 8601 timestamp
     * @param eventId    Event identifier (may be empty string)
     */
    _publishMqttEvent(camId, eventType, timestamp, eventId) {
        if (!this._mqttBridge) {
            return;
        }
        const cam = this._cameras.get(camId);
        const camName = cam?.name ?? camId.slice(0, 8);
        this._mqttBridge.publish(camId, camName, eventType, timestamp, eventId);
    }
    /**
     * v0.5.3: shared post-event side effects, called by both real FCM
     * events and synthetic motion triggers. Flips motion_active=true with
     * a 90 s auto-clear, and — when auto_snapshot_on_motion is enabled —
     * fires a fresh snapshot in the background (reuses the warm session
     * via the v0.5.3 keep-alive optimization for rapid bursts).
     *
     * @param camId Camera UUID
     */
    async _onMotionFired(camId) {
        // Edge-trigger boolean: set true, arm 90 s auto-clear
        await this.setStateAsync(`cameras.${camId}.motion_active`, true, true);
        const previous = this._motionActiveTimers.get(camId);
        if (previous) {
            this.clearTimeout(previous);
        }
        // v0.6.0: use this.setTimeout so adapter-core auto-cancels on unload
        // (the explicit clearTimeout in onUnload remains for graceful shutdown).
        const clearTimer = this.setTimeout(() => {
            this._motionActiveTimers.delete(camId);
            void this.setStateAsync(`cameras.${camId}.motion_active`, false, true).catch((err) => {
                this.log.debug(`motion_active auto-clear for ${camId.slice(0, 8)} threw: ` +
                    `${err instanceof Error ? err.message : String(err)}`);
            });
        }, this._motionActiveWindowMs);
        if (clearTimer) {
            this._motionActiveTimers.set(camId, clearTimer);
        }
        // Optional: auto-snapshot — default true, opt-out via adapter config
        // (the field is `undefined` on legacy installs that never saw the
        // option, so treat `undefined` like `true`).
        const optedOut = this.config.auto_snapshot_on_motion === false;
        if (!optedOut) {
            void this.handleSnapshotTrigger(camId, { asMotionEvent: true }).catch((err) => {
                this.log.debug(`Auto-snapshot on motion for ${camId.slice(0, 8)} failed: ` +
                    `${err instanceof Error ? err.message : String(err)}`);
            });
        }
    }
    // ── v0.7.7 audio-level handler ──────────────────────────────────────────
    /**
     * Write microphone or speaker level to the Bosch cloud API.
     * PUT /v11/video_inputs/{id}/audio body: {microphoneLevel, speakerLevel}
     * Gen2 only.
     *
     * @param camId  Camera UUID (must be Gen2)
     * @param field  "microphone" | "speaker"
     * @param level  0–100
     */
    async _handleAudioLevelWrite(camId, field, level) {
        if (!this._currentAccessToken) {
            throw new Error("no access token — adapter not ready");
        }
        const clamped = Math.max(0, Math.min(100, Math.round(level)));
        const url = `${auth_1.CLOUD_API}/v11/video_inputs/${camId}/audio`;
        const headers = {
            Authorization: `Bearer ${this._currentAccessToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
        };
        // v1.0.3: Bosch's /audio PUT requires the FULL body
        // {audioEnabled, microphoneLevel, speakerLevel}. A partial PUT with
        // only the changed level silently drops the other level (and
        // audioEnabled). GET current → merge the one field → PUT full body,
        // mirroring _handleIntrusionWrite. Bug: setting speaker_level wiped
        // microphone_level back to the device default.
        let audio;
        const cached = this._audioCache.get(camId);
        if (cached) {
            audio = { ...cached };
        }
        else {
            const getResp = await this._httpClient.get(url, {
                headers,
                validateStatus: (s) => s >= 200 && s < 300,
            });
            audio = getResp.data ?? {};
        }
        if (field === "microphone") {
            audio.microphoneLevel = clamped;
        }
        else {
            audio.speakerLevel = clamped;
        }
        const resp = await this._httpClient.put(url, audio, {
            headers,
            validateStatus: (s) => s >= 200 && s < 300,
        });
        // Cache the full body we just wrote so the next single-field write
        // doesn't need another GET.
        this._audioCache.set(camId, { ...audio });
        this.log.info(`Audio ${field} level set to ${clamped} for ${camId.slice(0, 8)} (HTTP ${resp.status})`);
    }
    // ── v1.1.0 push-notifications handler ───────────────────────────────────
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
    async _handleNotificationsWrite(camId, enabled) {
        if (!this._currentAccessToken) {
            throw new Error("no access token — adapter not ready");
        }
        const url = `${auth_1.CLOUD_API}/v11/video_inputs/${camId}/enable_notifications`;
        const body = {
            enabledNotificationsStatus: enabled ? "FOLLOW_CAMERA_SCHEDULE" : "ALWAYS_OFF",
        };
        const resp = await this._httpClient.put(url, body, {
            headers: {
                Authorization: `Bearer ${this._currentAccessToken}`,
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            // v1.1.0: accept 443 (privacy mode) like _handleMotionWrite — a
            // partial PUT during privacy returns 443; without this axios rejects
            // → unhandled rejection AND the generic ack still fires (misleading).
            validateStatus: (s) => (s >= 200 && s < 300) || s === 443,
        });
        if (resp.status === 443) {
            this.log.warn(`notifications write for ${camId.slice(0, 8)} rejected — camera in privacy mode (HTTP 443)`);
            return false; // skip ack — DP keeps its real value, poll re-syncs
        }
        this.log.info(`Notifications ${enabled ? "ON" : "OFF"} for ${camId.slice(0, 8)} (HTTP ${resp.status})`);
        return true;
    }
    // ── v1.1.0 motion-detection handler ─────────────────────────────────────
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
    async _handleMotionWrite(camId, delta) {
        if (!this._currentAccessToken) {
            throw new Error("no access token — adapter not ready");
        }
        const url = `${auth_1.CLOUD_API}/v11/video_inputs/${camId}/motion`;
        const headers = {
            Authorization: `Bearer ${this._currentAccessToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
        };
        // Full-body merge: start from the cached baseline or a live GET.
        let motion;
        const cached = this._motionCache.get(camId);
        if (cached) {
            motion = { ...cached };
        }
        else {
            const getResp = await this._httpClient.get(url, {
                headers,
                // 443 = privacy mode active, motion config frozen (HA convention).
                validateStatus: (s) => (s >= 200 && s < 300) || s === 443,
            });
            if (getResp.status === 443) {
                this.log.warn(`motion write for ${camId.slice(0, 8)} skipped — camera in privacy mode (HTTP 443)`);
                return false; // skip ack — keep last known value
            }
            motion = getResp.data ?? {};
        }
        if (delta.enabled !== undefined) {
            motion.enabled = delta.enabled;
        }
        if (delta.sensitivity !== undefined) {
            // API enum is the upper-cased option key (super_high → SUPER_HIGH).
            motion.motionAlarmConfiguration = delta.sensitivity.toUpperCase();
        }
        const resp = await this._httpClient.put(url, motion, {
            headers,
            validateStatus: (s) => (s >= 200 && s < 300) || s === 443,
        });
        if (resp.status === 443) {
            this.log.warn(`motion write for ${camId.slice(0, 8)} rejected — camera in privacy mode (HTTP 443)`);
            return false;
        }
        this._motionCache.set(camId, { ...motion });
        this.log.info(`Motion config ${JSON.stringify(delta)} for ${camId.slice(0, 8)} (HTTP ${resp.status})`);
        return true;
    }
    // ── v0.7.7 intrusion-detection handler ─────────────────────────────────
    /**
     * Write intrusion detection config to the Bosch cloud API.
     * PUT /v11/video_inputs/{id}/intrusionDetectionConfig
     * Gen2 only.
     *
     * @param camId  Camera UUID (must be Gen2)
     * @param delta  {sensitivity?, distance?}
     * @param delta.sensitivity
     * @param delta.distance
     */
    async _handleIntrusionWrite(camId, delta) {
        if (!this._currentAccessToken) {
            throw new Error("no access token — adapter not ready");
        }
        const url = `${auth_1.CLOUD_API}/v11/video_inputs/${camId}/intrusionDetectionConfig`;
        const headers = {
            Authorization: `Bearer ${this._currentAccessToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
        };
        // v0.7.14: Bosch rejects DELTA PUTs with HTTP 400 — the endpoint
        // requires the FULL config body (detectionMode, sensitivity,
        // distance, enabled, …). HA does GET → mutate → PUT full body.
        // Mirror that. Bug reproduced live: setting sensitivity=4 against
        // Innenbereich (FW 9.40.102) returned 400 until this fix.
        const cachedRaw = this._intrusionConfigCache.get(camId);
        let cfg;
        if (cachedRaw) {
            cfg = { ...cachedRaw };
        }
        else {
            // First write before any successful GET — fetch fresh config
            // so we know the missing required fields.
            const getResp = await this._httpClient.get(url, {
                headers,
                validateStatus: (s) => (s >= 200 && s < 300) || s === 443,
            });
            if (getResp.status === 443) {
                throw new Error(`Bosch rejected intrusion-config GET with HTTP 443 — cam is in privacy mode; ` +
                    `disable privacy first to read or change the config`);
            }
            cfg = getResp.data ?? {};
            this._intrusionConfigCache.set(camId, { ...cfg });
        }
        if (delta.sensitivity !== undefined) {
            cfg.sensitivity = Math.max(0, Math.min(7, Math.round(delta.sensitivity)));
        }
        if (delta.distance !== undefined) {
            // v1.0.3: Bosch rejects distance > 8 with HTTP 400 (verified live
            // FW 9.40.102). Was min(10) → sending 9/10 returned 400. Clamp to 8.
            cfg.distance = Math.max(1, Math.min(8, Math.round(delta.distance)));
        }
        // v0.7.14: HTTP 443 from Bosch = "cam is in privacy mode, config
        // writes are rejected". HA's same response shows a localised
        // `privacy_blocked` error. We surface a clear message so users
        // know to disable privacy first, not a generic "Bad Request".
        const resp = await this._httpClient.put(url, cfg, {
            headers,
            validateStatus: (s) => (s >= 200 && s < 300) || s === 443,
        });
        if (resp.status === 443) {
            throw new Error(`Bosch rejected intrusion-config PUT with HTTP 443 — cam is in privacy mode; ` +
                `disable privacy first to change sensitivity/distance`);
        }
        // Update cache with the body we just successfully wrote
        this._intrusionConfigCache.set(camId, { ...cfg });
        this.log.info(`Intrusion config updated for ${camId.slice(0, 8)} (HTTP ${resp.status}): ${JSON.stringify(cfg)}`);
    }
    // ── v0.8.0 lens elevation write handler ────────────────────────────────
    /**
     * Set lens mounting height via PUT /v11/video_inputs/{id}/lens_elevation.
     * Gen2 only. Range clamped to 0.5–5.0 m.
     *
     * @param camId      Camera UUID (must be Gen2)
     * @param elevation  Height in metres (clamped)
     */
    async _handleLensElevationWrite(camId, elevation) {
        if (!this._currentAccessToken) {
            throw new Error("no access token — adapter not ready");
        }
        const clamped = Math.max(0.5, Math.min(5.0, Math.round(elevation * 100) / 100));
        const url = `${auth_1.CLOUD_API}/v11/video_inputs/${camId}/lens_elevation`;
        const resp = await this._httpClient.put(url, { elevation: clamped }, {
            headers: {
                Authorization: `Bearer ${this._currentAccessToken}`,
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            validateStatus: (s) => s >= 200 && s < 300,
        });
        this._lensElevationCache.set(camId, clamped);
        this.log.info(`Lens elevation set to ${clamped} m for ${camId.slice(0, 8)} (HTTP ${resp.status})`);
    }
    // ── v0.8.0 darkness threshold write handler ────────────────────────────
    /**
     * Set darkness threshold via PUT /v11/video_inputs/{id}/lighting.
     * Converts user-facing 0–100 % to Bosch float 0.0–1.0.
     * Merges with cached softLightFading field (Bosch requires full body).
     * Gen2 Outdoor only.
     *
     * @param camId  Camera UUID (must be Gen2 Outdoor)
     * @param pct    Threshold percentage 0–100
     */
    async _handleDarknessThresholdWrite(camId, pct) {
        if (!this._currentAccessToken) {
            throw new Error("no access token — adapter not ready");
        }
        const clamped = Math.max(0, Math.min(100, Math.round(pct)));
        const boschValue = Math.round((clamped / 100) * 10000) / 10000; // 4 decimal places like HA
        const url = `${auth_1.CLOUD_API}/v11/video_inputs/${camId}/lighting`;
        const headers = {
            Authorization: `Bearer ${this._currentAccessToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
        };
        // Bosch requires full body — seed cache from GET when empty (e.g. after restart)
        let cached = this._globalLightingCache.get(camId);
        if (!cached) {
            try {
                const getResp = await this._httpClient.get(url, {
                    headers,
                    validateStatus: (s) => s >= 200 && s < 300,
                });
                cached = getResp.data ?? {};
                this._globalLightingCache.set(camId, { ...cached });
            }
            catch {
                this.log.warn(`darkness_threshold: failed to load current config for ${camId.slice(0, 8)}, using defaults`);
                cached = {};
            }
        }
        const softLightFading = typeof cached.softLightFading === "boolean" ? cached.softLightFading : true;
        const body = { darknessThreshold: boschValue, softLightFading };
        const resp = await this._httpClient.put(url, body, {
            headers,
            validateStatus: (s) => s >= 200 && s < 300,
        });
        this._globalLightingCache.set(camId, { ...cached, ...body });
        this.log.info(`Darkness threshold set to ${clamped}% (${boschValue}) for ${camId.slice(0, 8)} (HTTP ${resp.status})`);
    }
    // ── v0.8.0 alarm settings write handler ───────────────────────────────
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
     */
    async _handleAlarmSettingsWrite(camId, delta) {
        if (!this._currentAccessToken) {
            throw new Error("no access token — adapter not ready");
        }
        const url = `${auth_1.CLOUD_API}/v11/video_inputs/${camId}/alarm_settings`;
        const headers = {
            Authorization: `Bearer ${this._currentAccessToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
        };
        // Seed cache from GET if not yet available (first write before poll ran)
        let cfg = this._alarmSettingsCache.get(camId);
        if (!cfg) {
            const getResp = await this._httpClient.get(url, {
                headers,
                validateStatus: (s) => s >= 200 && s < 300,
            });
            cfg = getResp.data ?? {};
            this._alarmSettingsCache.set(camId, { ...cfg });
        }
        else {
            cfg = { ...cfg };
        }
        // Apply delta
        if (delta.alarmDelayInSeconds !== undefined) {
            cfg.alarmDelayInSeconds = Math.max(10, Math.min(300, delta.alarmDelayInSeconds));
        }
        if (delta.alarmActivationDelaySeconds !== undefined) {
            cfg.alarmActivationDelaySeconds = Math.max(0, Math.min(600, delta.alarmActivationDelaySeconds));
        }
        if (delta.preAlarmDelayInSeconds !== undefined) {
            cfg.preAlarmDelayInSeconds = Math.max(0, Math.min(300, delta.preAlarmDelayInSeconds));
        }
        const resp = await this._httpClient.put(url, cfg, {
            headers,
            validateStatus: (s) => s >= 200 && s < 300,
        });
        this._alarmSettingsCache.set(camId, { ...cfg });
        this.log.info(`Alarm settings updated for ${camId.slice(0, 8)} (HTTP ${resp.status}): ${JSON.stringify(delta)}`);
    }
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
    async triggerSyntheticMotion(camId, eventType) {
        const ts = new Date().toISOString();
        const prefix = `cameras.${camId}`;
        await this.setStateAsync(`${prefix}.last_motion_at`, ts, true);
        await this.setStateAsync(`${prefix}.last_motion_event_type`, eventType, true);
        this.log.info(`Synthetic ${eventType} trigger for camera ${camId.slice(0, 8)}`);
        this._publishMqttEvent(camId, eventType, ts, "");
        // v0.5.3: same side-effects as a real FCM event so synthetic
        // triggers (Philips Hue motion in the driveway, …) also flip
        // motion_active and refresh last_event_image.
        await this._onMotionFired(camId);
    }
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
    async handleSirenToggle(camId, enabled) {
        const cam = this._cameras.get(camId);
        if (!cam || cam.generation < 2) {
            this.log.warn(`Siren request for ${camId.slice(0, 8)} ignored — not a Gen2 camera`);
            throw new Error("siren not supported on this camera");
        }
        if (!this._currentAccessToken) {
            throw new Error("no access token — adapter not ready");
        }
        const ok = await (0, alarm_light_1.setPanicAlarm)(this._httpClient, this._currentAccessToken, camId, enabled);
        if (!ok) {
            throw new Error(`PUT /panic_alarm returned non-success for ${camId.slice(0, 8)}`);
        }
        this._sirenState.set(camId, enabled);
        this.log.info(`Siren ${enabled ? "TRIGGERED" : "stopped"} for camera ${camId.slice(0, 8)}`);
    }
    // ── v0.9.0 privacy sound handler ─────────────────────────────────────────
    /**
     * Set privacy sound override (audible indicator on privacy mode change).
     * GET/PUT /v11/video_inputs/{id}/privacy_sound_override  body: {"result": bool}
     * HTTP 442 = endpoint not supported on this camera model (silently ignored).
     *
     * @param camId    Camera UUID
     * @param enabled  true = play sound when privacy mode changes
     */
    async _handlePrivacySoundWrite(camId, enabled) {
        // v0.9.1: previous warn-storm finding — every write to an Outdoor camera
        // returned HTTP 442 and emitted the same warn line. Outdoor cameras don't
        // have the speaker hardware for privacy-toggle audio confirmation, so the
        // feature is unsupported by design. Once we see 442 we cache it and short-
        // circuit subsequent writes for this camera without any HTTP call.
        if (this._isFeatureUnsupported(camId, "privacy_sound")) {
            this.log.debug(`privacy_sound_override skipped for ${camId.slice(0, 8)} — cached as unsupported (442)`);
            return;
        }
        if (!this._currentAccessToken) {
            throw new Error("no access token — adapter not ready");
        }
        const url = `${auth_1.CLOUD_API}/v11/video_inputs/${camId}/privacy_sound_override`;
        const resp = await this._httpClient.put(url, { result: enabled }, {
            headers: {
                Authorization: `Bearer ${this._currentAccessToken}`,
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            validateStatus: (s) => (s >= 200 && s < 300) || s === 442,
        });
        if (resp.status === 442) {
            this._markFeatureUnsupported(camId, "privacy_sound");
            this.log.warn(`privacy_sound_override not supported on camera ${camId.slice(0, 8)} (HTTP 442) — ` +
                `caching as unsupported; further writes will short-circuit`);
            return;
        }
        this.log.info(`Privacy sound ${enabled ? "enabled" : "disabled"} for ${camId.slice(0, 8)} (HTTP ${resp.status})`);
    }
    /**
     * Poll privacy sound state from GET /v11/video_inputs/{id}/privacy_sound_override.
     * Best-effort — errors and HTTP 442 swallowed.
     *
     * @param token  Current access_token
     * @param camId  Camera UUID
     */
    async _pollPrivacySound(token, camId) {
        // v0.9.1: skip if cached unsupported or in backoff window.
        if (this._isFeatureUnsupported(camId, "privacy_sound")) {
            return;
        }
        if (this._shouldSkipPoll(camId, "privacy_sound")) {
            return;
        }
        try {
            const url = `${auth_1.CLOUD_API}/v11/video_inputs/${camId}/privacy_sound_override`;
            const resp = await this._httpClient.get(url, {
                headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
                validateStatus: (s) => (s >= 200 && s < 300) || s === 442 || s === 444,
            });
            if (resp.status === 442) {
                this._markFeatureUnsupported(camId, "privacy_sound");
                return;
            }
            if (resp.status === 444) {
                this._recordPollResult(camId, "privacy_sound", false);
                return;
            }
            if (!resp.data) {
                return;
            }
            const data = resp.data;
            const enabled = typeof data.result === "boolean" ? data.result : undefined;
            if (enabled !== undefined) {
                await this.upsertState(`cameras.${camId}.privacy_sound_enabled`, enabled);
            }
            this._recordPollResult(camId, "privacy_sound", true);
        }
        catch (err) {
            this._recordPollResult(camId, "privacy_sound", false);
            this.log.debug(`Privacy sound poll for ${camId.slice(0, 8)} failed: ` +
                `${err instanceof Error ? err.message : String(err)}`);
        }
    }
    // ── v0.9.0 autofollow handler ─────────────────────────────────────────────
    /**
     * Set autofollow state for a Gen1 360° camera.
     * GET/PUT /v11/video_inputs/{id}/autofollow  body: {"result": bool}
     * Only supported when panLimit > 0 (CAMERA_360).
     *
     * @param camId    Camera UUID (must have panLimit > 0)
     * @param enabled  true = enable auto-follow
     */
    async _handleAutofollowWrite(camId, enabled) {
        const cam = this._cameras.get(camId);
        if (!cam || cam.panLimit <= 0) {
            throw new Error(`Autofollow not supported for camera ${camId.slice(0, 8)} (panLimit=0)`);
        }
        if (!this._currentAccessToken) {
            throw new Error("no access token — adapter not ready");
        }
        const url = `${auth_1.CLOUD_API}/v11/video_inputs/${camId}/autofollow`;
        const resp = await this._httpClient.put(url, { result: enabled }, {
            headers: {
                Authorization: `Bearer ${this._currentAccessToken}`,
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            validateStatus: (s) => (s >= 200 && s < 300) || s === 442,
        });
        if (resp.status === 442) {
            this.log.warn(`Autofollow not supported on ${camId.slice(0, 8)} (HTTP 442)`);
            return;
        }
        this.log.info(`Autofollow ${enabled ? "enabled" : "disabled"} for ${camId.slice(0, 8)} (HTTP ${resp.status})`);
    }
    /**
     * Poll autofollow state from GET /v11/video_inputs/{id}/autofollow.
     * Best-effort — errors swallowed.
     *
     * @param token  Current access_token
     * @param camId  Camera UUID (panLimit > 0 expected)
     */
    async _pollAutofollow(token, camId) {
        // v0.9.1: skip if cached unsupported or in backoff window.
        if (this._isFeatureUnsupported(camId, "autofollow")) {
            return;
        }
        if (this._shouldSkipPoll(camId, "autofollow")) {
            return;
        }
        try {
            const url = `${auth_1.CLOUD_API}/v11/video_inputs/${camId}/autofollow`;
            const resp = await this._httpClient.get(url, {
                headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
                validateStatus: (s) => (s >= 200 && s < 300) || s === 442 || s === 404 || s === 444,
            });
            if (resp.status === 442 || resp.status === 404) {
                this._markFeatureUnsupported(camId, "autofollow");
                return;
            }
            if (resp.status === 444) {
                this._recordPollResult(camId, "autofollow", false);
                return;
            }
            if (!resp.data) {
                return;
            }
            const data = resp.data;
            const enabled = typeof data.result === "boolean" ? data.result : undefined;
            if (enabled !== undefined) {
                await this.upsertState(`cameras.${camId}.autofollow_enabled`, enabled);
            }
            this._recordPollResult(camId, "autofollow", true);
        }
        catch (err) {
            this._recordPollResult(camId, "autofollow", false);
            this.log.debug(`Autofollow poll for ${camId.slice(0, 8)} failed: ` +
                `${err instanceof Error ? err.message : String(err)}`);
        }
    }
    // ── v0.9.0 mark-all-read handler ─────────────────────────────────────────
    /**
     * Mark all recent events as read for a camera.
     * Fetches the last 20 events, then calls PUT /v11/events with {id, isRead: true}
     * for each one. Best-effort — individual failures are swallowed.
     * Python CLI reference: api_mark_events_read() (PUT /v11/events per event).
     *
     * @param camId  Camera UUID
     */
    async _handleMarkAllRead(camId) {
        if (!this._currentAccessToken) {
            throw new Error("no access token — adapter not ready");
        }
        const token = this._currentAccessToken;
        const headers = {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
        };
        // Fetch recent events to get their IDs
        const listUrl = `${auth_1.CLOUD_API}/v11/events?videoInputId=${camId}&limit=20`;
        const listResp = await this._httpClient.get(listUrl, {
            headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
            validateStatus: (s) => s >= 200 && s < 300,
        });
        const events = Array.isArray(listResp.data)
            ? listResp.data
            : [];
        if (events.length === 0) {
            this.log.info(`mark_all_read: no events to mark for ${camId.slice(0, 8)}`);
            return;
        }
        let marked = 0;
        for (const ev of events) {
            const evId = typeof ev.id === "string" ? ev.id : null;
            if (!evId) {
                continue;
            }
            try {
                await this._httpClient.put(`${auth_1.CLOUD_API}/v11/events`, { id: evId, isRead: true }, { headers, validateStatus: (s) => s >= 200 && s < 300 });
                marked++;
            }
            catch {
                // best-effort
            }
        }
        // Update unread count to 0 after marking
        await this.upsertState(`cameras.${camId}.unread_events_count`, 0);
        this.log.info(`mark_all_read: marked ${marked}/${events.length} events as read for ${camId.slice(0, 8)}`);
    }
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
    async _handlePanWrite(camId, position) {
        const cam = this._cameras.get(camId);
        if (!cam || cam.panLimit <= 0) {
            throw new Error(`Pan not supported for camera ${camId.slice(0, 8)} (panLimit=0)`);
        }
        if (!this._currentAccessToken) {
            throw new Error("no access token — adapter not ready");
        }
        const clamped = Math.max(-cam.panLimit, Math.min(cam.panLimit, position));
        const url = `${auth_1.CLOUD_API}/v11/video_inputs/${camId}/pan`;
        const resp = await this._httpClient.put(url, {
            absolutePosition: clamped,
        }, {
            headers: {
                Authorization: `Bearer ${this._currentAccessToken}`,
                "Content-Type": "application/json",
            },
            // v1.0.3: allow 444 through so we can treat the session-quota
            // case as a graceful warn instead of a hard error (below).
            validateStatus: (s) => (s >= 200 && s < 300) || s === 444,
        });
        if (resp.status === 444) {
            // v1.0.3: pan needs a live session; Bosch returns 444 when the
            // camera's session slots are full (Bosch App / parallel HA / Python
            // clients on the same physical camera). Mirror the stream path's
            // graceful session-quota treatment — warn + set the session_limit_hit
            // DP — instead of logging a hard "Failed to handle pan_position"
            // error. Return null so the caller leaves the position un-acked.
            this.log.warn(`[session-quota] pan for camera ${camId.slice(0, 8)} rejected with HTTP 444 — ` +
                `too many simultaneous live sessions. Close other Bosch clients and retry.`);
            try {
                await this.setStateAsync(`cameras.${camId}.session_limit_hit`, true, true);
            }
            catch (err) {
                this.log.debug(`session_limit_hit DP write failed for ${camId.slice(0, 8)} (non-fatal): ` +
                    `${err instanceof Error ? err.message : String(err)}`);
            }
            return null;
        }
        if (resp.status !== 200) {
            throw new Error(`PUT /pan returned HTTP ${resp.status} for camera ${camId.slice(0, 8)}`);
        }
        this.log.info(`Pan → ${clamped}° for camera ${camId.slice(0, 8)}`);
        // v1.0.3: return the value actually written so the caller acks the
        // clamped position, not the raw (possibly out-of-range) user input.
        return clamped;
    }
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
    async handleWallwasherUpdate(camId, delta) {
        const cam = this._cameras.get(camId);
        if (!cam || cam.generation < 2 || cam.featureLight !== true) {
            this.log.warn(`Wallwasher request for ${camId.slice(0, 8)} ignored — Gen2 lighting not supported`);
            throw new Error("wallwasher not supported on this camera");
        }
        if (!this._currentAccessToken) {
            throw new Error("no access token — adapter not ready");
        }
        const current = this._lightingCache.get(camId) ?? alarm_light_1.DEFAULT_LIGHTING_STATE;
        // Translate "" → null (white-balance), undefined → keep current
        let colorArg;
        if (delta.color === undefined) {
            colorArg = undefined;
        }
        else if (delta.color === "") {
            colorArg = null;
        }
        else {
            colorArg = delta.color;
        }
        let brightnessArg;
        if (delta.brightness !== undefined) {
            brightnessArg = Number.isFinite(delta.brightness) ? delta.brightness : 0;
        }
        const next = (0, alarm_light_1.buildWallwasherUpdate)(current, brightnessArg, colorArg);
        const result = await (0, alarm_light_1.putLightingState)(this._httpClient, this._currentAccessToken, camId, next);
        if (!result) {
            throw new Error(`PUT /lighting/switch returned non-success for ${camId.slice(0, 8)}`);
        }
        this._lightingCache.set(camId, result);
        this.log.info(`Wallwasher update for camera ${camId.slice(0, 8)}: ` +
            `top brightness=${result.topLedLightSettings.brightness} ` +
            `color=${result.topLedLightSettings.color ?? `wb=${result.topLedLightSettings.whiteBalance}`}`);
    }
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
    async handleStreamQualityChange(camId, quality) {
        const normalised = quality === "low" ? "low" : "high";
        const previous = this._streamQuality.get(camId) ?? "high";
        if (previous === normalised) {
            return; // no-op
        }
        this._streamQuality.set(camId, normalised);
        this.log.info(`Stream quality for ${camId.slice(0, 8)}: ${previous} → ${normalised} ` +
            `(closing session so next stream request re-opens with new flag)`);
        // Close existing session so the next ensureLiveSession() picks up the
        // new highQualityVideo flag. Best-effort — proxy stays serving the
        // existing stream until the next renewal cycle.
        if (this._liveSessions.has(camId)) {
            if (this._currentAccessToken) {
                try {
                    await (0, live_session_1.closeLiveSession)(this._httpClient, this._currentAccessToken, camId);
                }
                catch (err) {
                    // Best-effort — Bosch may already have closed it
                    this.log.debug(`closeLiveSession during quality change for ${camId.slice(0, 8)}: ` +
                        `${err instanceof Error ? err.message : String(err)}`);
                }
            }
            this._liveSessions.delete(camId);
        }
        // Stop the watchdog too — the next ensureLiveSession() rebuilds it
        // with the renewed maxSessionDuration for the new session.
        const watchdog = this._sessionWatchdogs.get(camId);
        if (watchdog) {
            watchdog.stop();
            this._sessionWatchdogs.delete(camId);
        }
    }
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
    _armSnapshotIdleTeardown(camId) {
        // Cancel any previous pending teardown so the window slides on every snap
        const previous = this._snapshotIdleTimers.get(camId);
        if (previous) {
            this.clearTimeout(previous);
        }
        // v0.6.0: use this.setTimeout so adapter-core auto-cancels on unload.
        const timer = this.setTimeout(() => {
            this._snapshotIdleTimers.delete(camId);
            void this._teardownStream(camId).catch((err) => {
                this.log.debug(`Idle teardown for ${camId.slice(0, 8)} threw: ` +
                    `${err instanceof Error ? err.message : String(err)}`);
            });
        }, BoschSmartHomeCamera.SNAPSHOT_SESSION_IDLE_MS);
        if (timer) {
            this._snapshotIdleTimers.set(camId, timer);
        }
    }
    /**
     * Cancel the pending idle-teardown timer for one camera, if any.
     *
     * @param camId
     */
    _cancelSnapshotIdleTeardown(camId) {
        const timer = this._snapshotIdleTimers.get(camId);
        if (timer) {
            this.clearTimeout(timer);
            this._snapshotIdleTimers.delete(camId);
        }
    }
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
    async _teardownStream(camId) {
        // v0.5.3: cancel any pending idle-teardown timer first so this
        // explicit teardown can't race with a delayed timer firing later
        // and trying to close an already-closed session.
        this._cancelSnapshotIdleTeardown(camId);
        // Stop watchdog FIRST so it doesn't fire a renewal after we close
        const watchdog = this._sessionWatchdogs.get(camId);
        if (watchdog) {
            watchdog.stop();
            this._sessionWatchdogs.delete(camId);
        }
        // Stop the TLS proxy (frees the bound port)
        const proxy = this._tlsProxies.get(camId);
        if (proxy) {
            try {
                await proxy.stop();
            }
            catch (err) {
                this.log.debug(`_teardownStream: proxy.stop() for ${camId.slice(0, 8)} threw: ` +
                    `${err instanceof Error ? err.message : String(err)}`);
            }
            this._tlsProxies.delete(camId);
        }
        this._sessionRemote.delete(camId);
        // Close the Bosch live session — frees the LOCAL session slot
        if (this._liveSessions.has(camId) && this._currentAccessToken) {
            try {
                await (0, live_session_1.closeLiveSession)(this._httpClient, this._currentAccessToken, camId);
            }
            catch (err) {
                this.log.debug(`_teardownStream: closeLiveSession for ${camId.slice(0, 8)} threw: ` +
                    `${err instanceof Error ? err.message : String(err)}`);
            }
        }
        this._liveSessions.delete(camId);
        // Clear the public stream_url DPs (main + sub) so consumers see "no stream"
        await this.upsertState(`cameras.${camId}.stream_url`, "");
        await this.upsertState(`cameras.${camId}.stream_url_sub`, "");
    }
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
    async handleLivestreamToggle(camId, enabled) {
        const previous = this._livestreamEnabled.get(camId) === true;
        this._livestreamEnabled.set(camId, enabled);
        if (previous === enabled) {
            return; // no-op
        }
        if (enabled) {
            // v0.5.3: cancel any pending snapshot idle teardown — once
            // livestream is on, the session must stay alive indefinitely
            // (watchdog handles natural renewal). Without this cancel, a
            // snapshot triggered just before the user enabled livestream
            // could fire the idle timer 60 s later and tear down the
            // freshly-opened stream.
            this._cancelSnapshotIdleTeardown(camId);
            // Open Bosch session + spawn TLS proxy + arm watchdog + populate stream_url
            try {
                await this.ensureLiveSession(camId);
                this.log.info(`Livestream STARTED for camera ${camId.slice(0, 8)}`);
            }
            catch (err) {
                if (err instanceof live_session_1.SessionLimitError) {
                    // v0.8.0: 444 session-quota — track + warn + schedule retry
                    await this._handleSessionLimitError(camId);
                    return;
                }
                throw err;
            }
        }
        else {
            await this._teardownStream(camId);
            this.log.info(`Livestream STOPPED for camera ${camId.slice(0, 8)}`);
        }
    }
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
    async fetchAndProcessEvents() {
        if (!this._currentAccessToken) {
            return;
        }
        const token = this._currentAccessToken;
        const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
        for (const [camId] of this._cameras) {
            try {
                const url = `${auth_1.CLOUD_API}/v11/events?videoInputId=${camId}&limit=5`;
                const resp = await this._httpClient.get(url, {
                    headers,
                    validateStatus: () => true,
                });
                if (resp.status !== 200 || !Array.isArray(resp.data) || resp.data.length === 0) {
                    continue;
                }
                const events = resp.data;
                const newest = events[0];
                const newestId = (newest.id ?? "");
                const prevId = this._lastSeenEventId[camId] ?? "";
                // Skip if we've already processed this event (dedup)
                if (!newestId || newestId === prevId) {
                    continue;
                }
                this._lastSeenEventId[camId] = newestId;
                // v0.9.0: persist so restarts don't re-fire side effects for old events.
                // v1.1.0: AWAIT the persist (was fire-and-forget) so a crash/unload
                // right after the in-memory update can't leave the OLD id in storage
                // → on restart the dedup would miss and the event re-fires. Mirrors
                // the FCM path (onFcmEvent) which already awaits.
                try {
                    await this.setStateAsync(`cameras.${camId}.last_seen_event_id`, newestId, true);
                }
                catch (err) {
                    this.log.debug(`last_seen_event_id persist for ${camId.slice(0, 8)} failed: ` +
                        `${err instanceof Error ? err.message : String(err)}`);
                }
                // Normalise event type — mirrors HA fcm.py PERSON upgrade logic
                const rawType = (newest.eventType ?? "").toUpperCase();
                const tags = (newest.eventTags ?? []);
                let eventType;
                if (rawType === "MOVEMENT" && tags.includes("PERSON")) {
                    eventType = "person";
                }
                else if (rawType === "MOVEMENT") {
                    eventType = "motion";
                }
                else if (rawType === "AUDIO_ALARM") {
                    eventType = "audio_alarm";
                }
                else if (rawType === "PERSON") {
                    eventType = "person";
                }
                else {
                    eventType = rawType.toLowerCase() || "motion";
                }
                // Timestamp — prefer ISO string, fall back to current time
                const rawTs = (newest.timestamp ?? newest.createdAt ?? "") ||
                    new Date().toISOString();
                const ts = BoschSmartHomeCamera.normaliseBoschTimestamp(rawTs);
                const prefix = `cameras.${camId}`;
                // v0.7.14: classify event type. Bosch's `/v11/events` mixes
                // real motion ("motion"/"person"/"audio_alarm") with status
                // events ("trouble_disconnect", "trouble_reconnect", arming
                // changes, ...). Pre-v0.7.14 wrote ALL of them to
                // `last_motion_at` + `last_motion_event_type` and flipped
                // `motion_active=true`, which (a) misclassified a 4-week-old
                // disconnect as a fresh motion event after every adapter
                // restart and (b) triggered auto-snapshot for non-motion
                // events. Now route only true motion events through the
                // motion DPs; status events are info-logged + skipped.
                const MOTION_EVENT_TYPES = new Set(["motion", "person", "audio_alarm"]);
                const isMotion = MOTION_EVENT_TYPES.has(eventType);
                // v0.7.14: stale-event guard for side effects. `_lastSeenEventId`
                // lives in memory only, so on every adapter restart the very
                // first poll surfaces the newest event for each camera even
                // when it is hours/weeks old (offline Gen1 cams whose last
                // cloud event is a 2026-04-27 trouble_disconnect). Historical
                // DPs (last_motion_at) still update so "letzte Bewegung
                // gesehen" stays accurate, but motion_active / auto-snapshot
                // / MQTT publish are suppressed for events older than the
                // cutoff so an adapter restart doesn't fire scenes for
                // four-week-old motion.
                const eventTs = new Date(ts).getTime();
                // v1.1.0: an UNPARSEABLE timestamp (new Date(ts) → NaN) must be
                // treated as STALE (Infinity age), not fresh. Pre-v1.1.0 it fell
                // back to age 0 → isFresh=true → motion_active flip + auto-snapshot
                // fired for malformed events, the opposite of the intended guard.
                const eventAgeMs = Number.isFinite(eventTs)
                    ? Date.now() - eventTs
                    : Number.POSITIVE_INFINITY;
                const MAX_FRESH_AGE_MS = 15 * 60_000;
                const isFresh = eventAgeMs <= MAX_FRESH_AGE_MS;
                if (isMotion) {
                    await this.setStateAsync(`${prefix}.last_motion_at`, ts, true);
                    await this.setStateAsync(`${prefix}.last_motion_event_type`, eventType, true);
                    if (isFresh) {
                        this.log.info(`Motion event [${eventType}] for camera ${camId.slice(0, 8)} at ${ts} (id=${newestId.slice(0, 8)})`);
                        this._publishMqttEvent(camId, eventType, ts, newestId);
                        // Same side-effects as the FCM path: flip motion_active=true,
                        // arm the 90 s auto-clear timer, and optionally fire an
                        // auto-snapshot. Without this call, users on the polling
                        // fallback (info.fcm_active="polling") saw last_motion_at
                        // update but motion_active stuck at false (forum #1339866).
                        await this._onMotionFired(camId);
                    }
                    else {
                        this.log.debug(`Stale motion event [${eventType}] for ${camId.slice(0, 8)} ` +
                            `(age ${Math.round(eventAgeMs / 60_000)}min, id=${newestId.slice(0, 8)}) — ` +
                            `last_motion_at updated, side effects suppressed`);
                    }
                }
                else {
                    // Non-motion status event (trouble_disconnect, …). Logged
                    // for visibility but does NOT update motion DPs or fire
                    // auto-snapshot. The cam may already be unreachable so a
                    // snapshot attempt would just queue a failed Bosch call.
                    if (isFresh) {
                        this.log.info(`Status event [${eventType}] for camera ${camId.slice(0, 8)} at ${ts} ` +
                            `(id=${newestId.slice(0, 8)}) — not classified as motion`);
                    }
                    else {
                        this.log.debug(`Stale status event [${eventType}] for ${camId.slice(0, 8)} ` +
                            `(age ${Math.round(eventAgeMs / 60_000)}min, id=${newestId.slice(0, 8)}) — suppressed`);
                    }
                }
            }
            catch (err) {
                this.log.debug(`fetchAndProcessEvents failed for ${camId.slice(0, 8)}: ${err.message}`);
            }
        }
    }
    // ── Camera command handlers ─────────────────────────────────────────────
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
    async handlePrivacyToggle(camId, enabled) {
        // v0.7.4: attempt cloud first, fall back to local RCP on cloud failure
        // (mirrors HA's async_cloud_set_privacy_mode + rcp_local_write_privacy chain).
        let cloudErr = null;
        if (this._currentAccessToken) {
            const url = `${auth_1.CLOUD_API}/v11/video_inputs/${camId}/privacy`;
            const body = { privacyMode: enabled ? "ON" : "OFF", durationInSeconds: null };
            try {
                const resp = await this._httpClient.put(url, body, {
                    headers: {
                        Authorization: `Bearer ${this._currentAccessToken}`,
                        "Content-Type": "application/json",
                        Accept: "application/json",
                    },
                    validateStatus: () => true,
                });
                if ([200, 201, 204].includes(resp.status)) {
                    this.log.info(`Privacy mode ${enabled ? "ON" : "OFF"} set via cloud for camera ${camId.slice(0, 8)}`);
                    return;
                }
                cloudErr = `HTTP ${resp.status}`;
            }
            catch (err) {
                cloudErr = err instanceof Error ? err.message : String(err);
            }
        }
        else {
            cloudErr = "no access token";
        }
        // Cloud failed — try Gen2 local RCP fallback (HTTPS port 443 + Digest auth)
        const cam = this._cameras.get(camId);
        const isGen2 = cam?.generation === 2;
        const lanIp = this._lanIpMap.get(camId);
        if (isGen2 && lanIp) {
            this.log.debug(`Privacy cloud failed (${cloudErr}) — trying Gen2 LOCAL RCP for ${camId.slice(0, 8)}`);
            // Pass Digest credentials from the active LiveSession (cbs-XXXXXXXX cycling user/pass).
            // v0.7.8: if no session is open (adapter just started, no stream opened yet),
            // try to open an emergency session to obtain Digest credentials before the write.
            const session = this._liveSessions.get(camId);
            let auth = session
                ? { user: session.digestUser, password: session.digestPassword }
                : undefined;
            if (!auth) {
                auth = await this._openEmergencySession(camId);
            }
            const ok = await this._localWritePrivacy(lanIp, enabled, auth);
            if (ok) {
                this.log.info(`Privacy mode ${enabled ? "ON" : "OFF"} set via LOCAL RCP for camera ${camId.slice(0, 8)}`);
                // Record write timestamp so is_lan_reachable() suppresses the
                // transient "offline" blip while creds rotate (~5–15 s).
                this._localWriteAt.set(camId, Date.now());
                return;
            }
            this.log.debug(`Privacy LOCAL RCP fallback also failed for ${camId.slice(0, 8)} — camera may not accept writes`);
        }
        throw new Error(`Cloud privacy PUT failed (${cloudErr}) and no working LAN fallback available for ${camId.slice(0, 8)}`);
    }
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
    async handleLightToggle(camId, enabled) {
        // Legacy combined switch — moves both lights together.
        await this._applyLightingState(camId, {
            frontLight: enabled,
            wallwasher: enabled,
        });
    }
    /**
     * v0.4.0: toggle the front spotlight only, keep wallwasher untouched.
     * Requested by ioBroker forum #84538 for dusk-sensor-driven group switching.
     *
     * @param camId
     * @param enabled
     */
    async handleFrontLightToggle(camId, enabled) {
        const currentWallwasher = await this._readBoolState(`cameras.${camId}.wallwasher_enabled`);
        await this._applyLightingState(camId, {
            frontLight: enabled,
            wallwasher: currentWallwasher,
        });
    }
    /**
     * v0.4.0: toggle the wallwasher (Gen1) / top-down LED strip (Gen2) only,
     * keep front spotlight untouched.
     *
     * @param camId
     * @param enabled
     */
    async handleWallwasherToggle(camId, enabled) {
        const currentFront = await this._readBoolState(`cameras.${camId}.front_light_enabled`);
        await this._applyLightingState(camId, {
            frontLight: currentFront,
            wallwasher: enabled,
        });
    }
    /**
     * Read a boolean state with default false (treats null/undefined/non-bool as false).
     *
     * @param id
     */
    async _readBoolState(id) {
        const s = await this.getStateAsync(id);
        return s?.val === true;
    }
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
    async _applyLightingState(camId, state) {
        if (!this._currentAccessToken) {
            throw new Error(`Cannot set light for ${camId} — no access token`);
        }
        const cam = this._cameras.get(camId);
        // v0.7.6: Indoor II is Gen2 but has no LED hardware (featureLight=false).
        // Sending PUT /lighting/switch to it returns 4xx — bail early with a clear log.
        if (cam?.generation === 2 && cam.featureLight !== true) {
            this.log.warn(`Light request for ${camId.slice(0, 8)} ignored — Gen2 camera has no light hardware (featureLight=false)`);
            return;
        }
        const isGen2 = cam?.generation === 2;
        const headers = {
            Authorization: `Bearer ${this._currentAccessToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
        };
        let cloudFrontErr = null;
        let cloudFrontOk = false;
        if (isGen2) {
            const base = `${auth_1.CLOUD_API}/v11/video_inputs/${camId}/lighting/switch`;
            try {
                const [r1, r2] = await Promise.all([
                    this._httpClient.put(`${base}/front`, { enabled: state.frontLight }, { headers, validateStatus: () => true }),
                    this._httpClient.put(`${base}/topdown`, { enabled: state.wallwasher }, { headers, validateStatus: () => true }),
                ]);
                const ok1 = [200, 201, 204].includes(r1.status);
                const ok2 = [200, 201, 204].includes(r2.status);
                if (ok1 || ok2) {
                    cloudFrontOk = true;
                }
                else {
                    cloudFrontErr = `HTTP front=${r1.status} topdown=${r2.status}`;
                }
            }
            catch (err) {
                cloudFrontErr = err instanceof Error ? err.message : String(err);
            }
            // v0.7.5: Gen2 front-light local RCP fallback (HTTPS port 443 + Digest auth;
            // mirrors HA's rcp_local_write_front_light). Wallwasher stays cloud-only
            // (RGB payload too complex for RCP).
            if (!cloudFrontOk) {
                const lanIp = this._lanIpMap.get(camId);
                if (lanIp) {
                    this.log.debug(`Light cloud failed (${cloudFrontErr}) — trying Gen2 LOCAL RCP for ${camId.slice(0, 8)}`);
                    const brightness = state.frontLight ? 100 : 0;
                    // Pass Digest credentials from the active LiveSession (cbs-XXXXXXXX cycling user/pass).
                    // v0.7.8: if no session is open (adapter just started, no stream opened yet),
                    // try to open an emergency session to obtain Digest credentials before the write.
                    const session = this._liveSessions.get(camId);
                    let auth = session
                        ? { user: session.digestUser, password: session.digestPassword }
                        : undefined;
                    if (!auth) {
                        auth = await this._openEmergencySession(camId);
                    }
                    const localOk = await this._localWriteFrontLight(lanIp, brightness, auth);
                    if (localOk) {
                        this.log.info(`Front-light ${state.frontLight ? "ON" : "OFF"} set via LOCAL RCP for ${camId.slice(0, 8)}`);
                        this._localWriteAt.set(camId, Date.now());
                        cloudFrontOk = true; // treat as success for state-sync below
                    }
                    else {
                        this.log.debug(`Light LOCAL RCP fallback also failed for ${camId.slice(0, 8)}`);
                    }
                }
                if (!cloudFrontOk) {
                    throw new Error(`Cloud light PUT Gen2 failed (${cloudFrontErr}) and no working LAN fallback`);
                }
            }
        }
        else {
            const url = `${auth_1.CLOUD_API}/v11/video_inputs/${camId}/lighting_override`;
            const body = {
                frontLightOn: state.frontLight,
                wallwasherOn: state.wallwasher,
                ...(state.frontLight ? { frontLightIntensity: 1.0 } : {}),
            };
            const resp = await this._httpClient.put(url, body, {
                headers,
                validateStatus: () => true,
            });
            if (![200, 201, 204].includes(resp.status)) {
                throw new Error(`Cloud light PUT Gen1 returned HTTP ${resp.status}`);
            }
        }
        // Keep all three light states in sync (front_light + wallwasher + legacy combined)
        await this.setStateAsync(`cameras.${camId}.front_light_enabled`, state.frontLight, true);
        await this.setStateAsync(`cameras.${camId}.wallwasher_enabled`, state.wallwasher, true);
        await this.setStateAsync(`cameras.${camId}.light_enabled`, state.frontLight && state.wallwasher, true);
        this.log.info(`Camera light front=${state.frontLight ? "ON" : "OFF"} wallwasher=${state.wallwasher ? "ON" : "OFF"} for ${camId.slice(0, 8)} (gen${isGen2 ? 2 : 1})`);
    }
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
    // Kept async to match the sibling toggle handlers (handlePrivacyToggle, handleLightToggle)
    // — the dispatcher in onStateChange awaits all of them uniformly.
    // eslint-disable-next-line @typescript-eslint/require-await
    async handleImageRotationToggle(camId, rotated180) {
        this._imageRotation[camId] = rotated180;
        this.log.info(`Image rotation ${rotated180 ? "180°" : "0°"} set for camera ${camId.slice(0, 8)}`);
    }
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
    async handleSnapshotTrigger(camId, opts = {}) {
        let session;
        try {
            session = await this.ensureLiveSession(camId);
        }
        catch (err) {
            if (err instanceof live_session_1.SessionLimitError) {
                // v0.8.0: 444 session-quota — do NOT mark camera offline,
                // do NOT increment snapshotFailCount. Track + warn + retry.
                await this._handleSessionLimitError(camId);
                return;
            }
            throw err;
        }
        const snapUrl = (0, snapshot_1.buildSnapshotUrl)(session.proxyUrl);
        // v0.5.2: when livestream is OFF (default), a snapshot must NOT leave
        // a long-running session + proxy + watchdog behind.
        // v0.5.3: instead of tearing down immediately we arm an idle timer
        // in `finally`; back-to-back snaps within
        // SNAPSHOT_SESSION_IDLE_MS reset it and reuse the cached session.
        // After the idle window expires the timer fires _teardownStream.
        const livestreamOn = this._livestreamEnabled.get(camId) === true;
        try {
            let buf;
            // v0.7.16: MJPEG fast path — Gen2 + LAN reachable + config opt-in.
            // Skips when privacy is ON (camera refuses RTSP while private).
            const cam = this._cameras.get(camId);
            const lanEntry = this._lanReachable.get(camId);
            const lanReachable = lanEntry?.[0] === true;
            const privacyOn = (await this.getStateAsync(`cameras.${camId}.privacy_enabled`))?.val === true;
            const useMjpeg = this.config.use_mjpeg_snapshot !== false && // default true
                cam?.generation === 2 &&
                lanReachable &&
                !privacyOn &&
                session.digestUser &&
                session.digestPassword;
            if (useMjpeg) {
                const lanIp = this._lanIpMap.get(camId) ?? session.lanAddress.split(":")[0];
                const mjpegBuf = await (0, mjpeg_snapshot_1.fetchMjpegSnapshot)(lanIp, 443, session.digestUser, session.digestPassword, this.log, 8000, {
                    set: (cb, ms) => this.setTimeout(cb, ms),
                    clear: (h) => this.clearTimeout(h),
                });
                if (mjpegBuf !== null) {
                    buf = mjpegBuf;
                }
                else {
                    // MJPEG failed — fall through to snap.jpg
                    this.log.debug(`MJPEG snapshot failed for ${camId.slice(0, 8)}, falling back to snap.jpg`);
                    buf = await this._fetchSnapJpgWithRetry(camId, snapUrl, session);
                }
            }
            else {
                buf = await this._fetchSnapJpgWithRetry(camId, snapUrl, session);
            }
            const filePath = `cameras/${camId}/snapshot.jpg`;
            await this.writeFileAsync(this.namespace, filePath, buf);
            // v1.1.0: hand the freshest frame to the local HTTP snapshot server
            // BEFORE publishing snapshot_path — a consumer reacting to the
            // snapshot_path change may immediately GET the HTTP snapshot URL,
            // so the buffer must already be in the map or it 404s / serves a
            // stale frame (no-op when the server is disabled — map unread).
            this._latestSnapshots.set(camId, buf);
            await this.setStateAsync(`cameras.${camId}.snapshot_path`, `/${this.namespace}/${filePath}`, true);
            // v0.5.3: motion-event snapshots additionally publish the JPEG as
            // base64 so push integrations (Telegram, Signal, Matrix) can
            // forward the picture without reading the adapter file store.
            if (opts.asMotionEvent) {
                const b64 = `data:image/jpeg;base64,${buf.toString("base64")}`;
                await this.setStateAsync(`cameras.${camId}.last_event_image`, b64, true);
                await this.setStateAsync(`cameras.${camId}.last_event_image_at`, new Date().toISOString(), true);
            }
            await this.markCameraReachability(camId, true);
            this.log.debug(`Snapshot saved for camera ${camId.slice(0, 8)}: ${buf.length} bytes`);
        }
        finally {
            if (!livestreamOn) {
                // v0.5.3: arm idle teardown instead of closing immediately so
                // a burst of snapshot_triggers reuses the warm session. The
                // timer is reset on every snap, so the window always extends
                // SNAPSHOT_SESSION_IDLE_MS from the *last* snap.
                this._armSnapshotIdleTeardown(camId);
            }
        }
    }
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
    async _fetchSnapJpgWithRetry(camId, snapUrl, session) {
        try {
            return await (0, snapshot_1.fetchSnapshot)(snapUrl, session.digestUser, session.digestPassword);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Only retry on "aborted" / connection-reset errors — not on auth (401)
            // or non-image content type (no point retrying those).
            const isTransient = /abort|reset|ECONNRESET|socket hang up|timeout/i.test(msg);
            if (!isTransient) {
                await this.markCameraReachability(camId, false);
                throw err;
            }
            this.log.debug(`Snapshot retry for ${camId.slice(0, 8)}: ${msg}`);
            await new Promise((r) => {
                this.setTimeout(() => r(), 800);
            });
            try {
                return await (0, snapshot_1.fetchSnapshot)(snapUrl, session.digestUser, session.digestPassword);
            }
            catch (retryErr) {
                await this.markCameraReachability(camId, false);
                throw retryErr;
            }
        }
    }
    /**
     * Start the polling fallback: re-fetch /v11/events every 30 s.
     *
     * Activated only when FCM push registration fails for both iOS and Android.
     * Mirrors HA's `fcm_push_mode=polling` behaviour — adapter stays usable, just
     * with higher motion-event latency (~30 s vs. ~2 s with push).
     *
     * Idempotent: re-calling while a timer is already armed is a no-op.
     */
    _startEventPolling() {
        if (this._eventPollTimer) {
            return;
        }
        const timer = this.setInterval(() => {
            void this.fetchAndProcessEvents().catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                this.log.debug(`Event polling tick failed: ${msg}`);
            });
        }, BoschSmartHomeCamera.EVENT_POLL_INTERVAL_MS);
        this._eventPollTimer = timer;
    }
    /**
     * v0.6.2: arm an FCM reconnect attempt with exponential backoff.
     * No-op if a timer is already pending (re-entrancy guard) or if the
     * listener has been torn down (adapter shutting down).
     */
    _scheduleFcmReconnect() {
        if (this._fcmReconnectTimer !== null) {
            return;
        }
        if (!this._fcmListener) {
            return;
        }
        const backoff = BoschSmartHomeCamera.FCM_RECONNECT_BACKOFF_MS;
        const idx = Math.min(this._fcmReconnectAttempt, backoff.length - 1);
        const delayMs = backoff[idx];
        this.log.debug(`Scheduling FCM reconnect in ${delayMs / 1000}s (attempt ${this._fcmReconnectAttempt + 1})`);
        // this.setTimeout returns ioBroker.Timeout | undefined — coalesce to null
        // so the field type stays `ioBroker.Timeout | null` (matches `_refreshTimeout`).
        this._fcmReconnectTimer =
            this.setTimeout(() => {
                this._fcmReconnectTimer = null;
                void this._attemptFcmReconnect();
            }, delayMs) ?? null;
    }
    /**
     * v0.6.2: re-call `_fcmListener.start()` after a disconnect.
     * Success → reset backoff, mark info.fcm_active="healthy".
     * Failure → bump attempt counter, re-schedule via {@link _scheduleFcmReconnect}.
     * Treats a missing listener as terminal (adapter is unloading).
     */
    async _attemptFcmReconnect() {
        if (!this._fcmListener) {
            return;
        }
        try {
            await this._fcmListener.start();
            this._fcmReconnectAttempt = 0;
            // v1.1.0: push works again — stop the polling fallback so we don't
            // keep hitting /v11/events every 30 s for the adapter's lifetime
            // (it was started when push first failed and is otherwise never
            // cleared). If push dies again the disconnect→reconnect path
            // re-arms it.
            if (this._eventPollTimer) {
                this.clearInterval(this._eventPollTimer);
                this._eventPollTimer = undefined;
            }
            await this.setStateAsync("info.fcm_active", "healthy", true);
            this.log.info("FCM push listener reconnected");
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.warn(`FCM reconnect attempt failed: ${msg}`);
            this._fcmReconnectAttempt += 1;
            this._scheduleFcmReconnect();
        }
    }
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
    static normaliseBoschTimestamp(raw) {
        if (typeof raw !== "string") {
            // v1.1.0: coerce — some Bosch firmware returns a numeric epoch for
            // timestamp/createdAt. Returning it unchanged wrote a number into
            // the type:"string" last_motion_at DP. String() keeps the DP typed.
            return String(raw);
        }
        return raw.replace(/\[[^\]]+\]$/, "");
    }
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
    async _handleSessionLimitError(camId) {
        const now = Date.now();
        const window = BoschSmartHomeCamera.SESSION_QUOTA_WINDOW_MS;
        const threshold = BoschSmartHomeCamera.SESSION_QUOTA_NOTIFY_THRESHOLD;
        // Prune + record
        const hits = (this._sessionLimitHits.get(camId) ?? []).filter((t) => now - t < window);
        hits.push(now);
        this._sessionLimitHits.set(camId, hits);
        const camPrefix = camId.slice(0, 8);
        this.log.warn(`[session-quota] Bosch returned HTTP 444 for camera ${camPrefix} — ` +
            `too many simultaneous live sessions. Hit ${hits.length} of ${threshold} in the 5-min window.`);
        // Set DP session_limit_hit = true
        try {
            await this.setStateAsync(`cameras.${camId}.session_limit_hit`, true, true);
        }
        catch (err) {
            this.log.debug(`session_limit_hit DP write failed for ${camPrefix} (non-fatal): ` +
                `${err instanceof Error ? err.message : String(err)}`);
        }
        if (hits.length >= threshold) {
            this.log.warn(`[session-quota] ${hits.length} session-quota hits in 5 min for camera ` +
                `${camPrefix} — close the Bosch App on other devices or disable ` +
                `parallel integrations (HA, Python CLI). Retry auto-scheduled in 60 s.`);
        }
        // Auto-retry after 60 s — Bosch releases orphaned slots within ~60 s.
        // Fire-and-forget; if the retry also hits 444, _handleSessionLimitError is called again.
        this.setTimeout(() => {
            this.log.debug(`[session-quota] Auto-retry ensureLiveSession for ${camPrefix}`);
            void this.ensureLiveSession(camId)
                .then(async () => {
                // Successful retry → clear session_limit_hit DP
                this._sessionLimitHits.delete(camId);
                await this.setStateAsync(`cameras.${camId}.session_limit_hit`, false, true);
                this.log.info(`[session-quota] Session-quota recovered for camera ${camPrefix}`);
            })
                .catch((retryErr) => {
                const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                this.log.debug(`[session-quota] Auto-retry still failed for ${camPrefix}: ${msg}`);
                // v1.1.0: if the retry ALSO hit the session quota, schedule
                // another 60 s retry. Without this the camera stays stuck at
                // session_limit_hit=true until a user-triggered snapshot or an
                // adapter restart (the setTimeout comment above wrongly claimed
                // this re-scheduling already happened). The loop self-terminates
                // once Bosch releases a slot and ensureLiveSession succeeds.
                if (retryErr instanceof live_session_1.SessionLimitError) {
                    void this._handleSessionLimitError(camId);
                }
            });
        }, 60_000);
    }
    async markCameraReachability(camId, reachable) {
        if (reachable) {
            if (this._snapshotFailCount.get(camId)) {
                this._snapshotFailCount.delete(camId);
            }
            // v0.8.0: clear session_limit_hit on successful reachability
            if (this._sessionLimitHits.has(camId)) {
                this._sessionLimitHits.delete(camId);
                try {
                    await this.setStateAsync(`cameras.${camId}.session_limit_hit`, false, true);
                }
                catch {
                    // non-fatal
                }
            }
            await this.setStateAsync(`cameras.${camId}.online`, true, true);
            // v0.7.2: notify on online/offline transition
            await this._maybeannounceCameraStatus(camId, "online");
            return;
        }
        // v0.5.4: privacy_enabled=true makes the camera refuse snapshots — that is
        // a USER state, not a reachability problem. Don't count those failures
        // toward the offline threshold; without this guard, an indoor camera in
        // permanent privacy mode drifts to online=false after 3 startup probes
        // even though the Bosch cloud happily syncs its config.
        try {
            const priv = await this.getStateAsync(`cameras.${camId}.privacy_enabled`);
            if (priv?.val === true) {
                this.log.debug(`Skipping reachability decrement for ${camId.slice(0, 8)} — privacy mode is ON`);
                return;
            }
        }
        catch {
            // Fall through — if we can't read the privacy state, treat the
            // failure normally so a truly unreachable camera still flips offline.
        }
        const failures = (this._snapshotFailCount.get(camId) ?? 0) + 1;
        this._snapshotFailCount.set(camId, failures);
        if (failures >= BoschSmartHomeCamera.OFFLINE_THRESHOLD) {
            await this.setStateAsync(`cameras.${camId}.online`, false, true);
            // v0.7.2: notify on offline threshold reached
            await this._maybeannounceCameraStatus(camId, "offline");
        }
    }
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
    async _maybeannounceCameraStatus(camId, newStatus) {
        const last = this._lastCameraStatus[camId];
        if (last === undefined) {
            // First tick after startup — record baseline silently.
            this._lastCameraStatus[camId] = newStatus;
            return;
        }
        if (newStatus === last) {
            return;
        }
        // Skip transitions involving "unknown" — transient cloud hickups can flap
        // status to unknown for one tick; do not convert that into notification spam.
        if (newStatus === "unknown" || last === "unknown") {
            this._lastCameraStatus[camId] = newStatus;
            return;
        }
        this._lastCameraStatus[camId] = newStatus;
        // Resolve camera display name from the _cameras map.
        const camName = this._cameras.get(camId)?.name || camId.slice(0, 8);
        let title;
        let message;
        if (newStatus === "offline") {
            title = `Bosch Kamera ${camName} offline`;
            message =
                `Bosch Kamera ${camName} ist offline. ` +
                    "Live-Bild und Snapshots sind bis zur Wiederverbindung nicht verfügbar.";
        }
        else {
            title = `Bosch Kamera ${camName} wieder online`;
            message = `Bosch Kamera ${camName} ist wieder erreichbar.`;
        }
        this.log.info(`[camera-status] ${title}`);
        try {
            const payload = JSON.stringify({
                title,
                message,
                status: newStatus,
                ts: new Date().toISOString(),
            });
            await this.upsertState(`cameras.${camId}.last_status_notification`, payload);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.debug(`Camera status notification DP write failed (non-fatal): ${msg}`);
        }
    }
    /**
     * Called when the adapter is stopped.
     * Cleans up TLS proxies, FCM listener, live sessions, and the refresh timer.
     * Must always call callback() — ioBroker enforces a timeout.
     *
     * @param callback
     */
    onUnload(callback) {
        void (async () => {
            try {
                // Clear the refresh timer (this.clearTimeout auto-tracks via adapter-core)
                if (this._refreshTimeout) {
                    this.clearTimeout(this._refreshTimeout);
                    this._refreshTimeout = null;
                }
                // Stop event polling timer (only set when FCM fell back to polling)
                if (this._eventPollTimer) {
                    this.clearInterval(this._eventPollTimer);
                    this._eventPollTimer = undefined;
                }
                // Stop camera-state poll timer (always armed when adapter is healthy)
                if (this._statePollTimer) {
                    this.clearInterval(this._statePollTimer);
                    this._statePollTimer = undefined;
                }
                // v0.7.0: stop maintenance poll timer
                if (this._maintenanceTimer) {
                    this.clearInterval(this._maintenanceTimer);
                    this._maintenanceTimer = undefined;
                }
                // v0.6.2: cancel any pending FCM reconnect timer BEFORE
                // nulling the listener — otherwise a timer that fires during
                // shutdown would try to start() a half-torn-down listener.
                if (this._fcmReconnectTimer) {
                    this.clearTimeout(this._fcmReconnectTimer);
                    this._fcmReconnectTimer = null;
                }
                this._fcmReconnectAttempt = 0;
                // Stop FCM listener
                if (this._fcmListener) {
                    try {
                        await this._fcmListener.stop();
                    }
                    catch {
                        /* best-effort */
                    }
                    this._fcmListener = null;
                }
                // v0.5.3: cancel pending snapshot idle teardown timers
                // before stopping the watchdogs/proxies — otherwise a timer
                // that fires during shutdown would try to close an
                // already-closed session.
                for (const [, timer] of this._snapshotIdleTimers) {
                    this.clearTimeout(timer);
                }
                this._snapshotIdleTimers.clear();
                // v0.5.3: cancel motion_active auto-clear timers so they
                // don't fire after shutdown and try to write states on a
                // dead adapter.
                for (const [, timer] of this._motionActiveTimers) {
                    this.clearTimeout(timer);
                }
                this._motionActiveTimers.clear();
                // v1.1.0: stop the local HTTP snapshot server + drop cached frames
                if (this._snapshotServer) {
                    try {
                        await this._snapshotServer.close();
                    }
                    catch {
                        /* best-effort */
                    }
                    this._snapshotServer = undefined;
                }
                this._latestSnapshots.clear();
                // Stop all session watchdogs BEFORE stopping TLS proxies
                // (prevents watchdog renewal racing with cleanup)
                for (const [, watchdog] of this._sessionWatchdogs) {
                    watchdog.stop();
                }
                this._sessionWatchdogs.clear();
                // Stop all TLS proxies
                for (const [, handle] of this._tlsProxies) {
                    try {
                        await handle.stop();
                    }
                    catch {
                        /* best-effort */
                    }
                }
                this._tlsProxies.clear();
                // Close all live sessions (best-effort — camera may be gone)
                if (this._currentAccessToken) {
                    const token = this._currentAccessToken;
                    for (const [camId] of this._liveSessions) {
                        try {
                            await (0, live_session_1.closeLiveSession)(this._httpClient, token, camId);
                        }
                        catch {
                            /* best-effort */
                        }
                    }
                }
                this._liveSessions.clear();
                // v0.7.9: disconnect MQTT bridge
                if (this._mqttBridge) {
                    try {
                        await this._mqttBridge.disconnect();
                    }
                    catch {
                        /* best-effort */
                    }
                    this._mqttBridge = null;
                }
                // Best-effort connection flag (async — may not complete if ioBroker kills us)
                void this.setStateAsync("info.connection", false, true).catch(() => undefined);
                void this.setStateAsync("info.fcm_active", "stopped", true).catch(() => undefined);
                this.log.info("Bosch Smart Home Camera adapter stopped");
            }
            catch {
                // swallow — we must always call callback
            }
            finally {
                callback();
            }
        })();
    }
}
exports.BoschSmartHomeCamera = BoschSmartHomeCamera;
// ── Bootstrap ─────────────────────────────────────────────────────────────────
if (require.main !== module) {
    // Called by ioBroker adapter host — export factory
    module.exports = (options) => new BoschSmartHomeCamera(options);
}
else {
    // Run directly for local debugging: node build/main.js
    (() => new BoschSmartHomeCamera())();
}
//# sourceMappingURL=main.js.map