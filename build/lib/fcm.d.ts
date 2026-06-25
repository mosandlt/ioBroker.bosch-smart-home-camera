/**
 * FCM (Firebase Cloud Messaging) push receiver for Bosch Smart Home Camera.
 *
 * Port of the Python fcm.py → TypeScript EventEmitter pattern using @aracna/fcm.
 *
 * ## Library: @aracna/fcm v1.0.32
 *
 * Speaks MTalk/MCS protocol to mtalk.google.com:5228, same as the Python
 * firebase-messaging (sdb9696). Registration flow:
 *   1. createFcmECDH() + generateFcmAuthSecret() → ECDH key pair + auth secret
 *   2. registerToFCM({ appID, ece, firebase }) → { acg: { id, securityToken }, token }
 *   3. FcmClient({ acg, ece }).connect() → persistent TLS socket, emits "message-data"
 *
 * FCM push from Bosch is a silent wake-up ("data-only" message) — no notification
 * payload. The adapter fetches fresh events from /v11/events on each push.
 *
 * ## Push mode
 * - "android": register as Android OSS app (FCM_ANDROID_APP_ID)
 * - "auto":    use Android OSS app (default; mirrors HA v12.4.5+ cleanup)
 *
 * ## Credential persistence
 * ACG ID / ACG security token / ECDH keys must be persisted across restarts to avoid
 * re-registration on every adapter start. Pass `savedCredentials.raw` (FcmCredentials.raw)
 * back in on the next start — same pattern as Python `saved_fcm_creds`.
 *
 * ## Reconnect
 * The FcmClient does NOT auto-reconnect on socket close. The caller is responsible for
 * re-calling start() after a "disconnect" event (with exponential back-off). The
 * coordinator's watchdog timer handles this.
 *
 * Constants mirrored from Python fcm.py:
 *   FCM_SENDER_ID = "404630424405"
 *
 * Firebase config (Android, "bosch-smart-cameras" project) — public app identifiers
 * embedded in every Bosch Smart Camera APK, vendor-confirmed for OSS use (2026-04-20).
 */
import { EventEmitter } from "node:events";
import type { AxiosInstance } from "axios";
import { FcmClient, createFcmECDH, generateFcmAuthSecret, registerToFCM } from "@aracna/fcm";
export { CLOUD_API } from "./auth";
/**
 * How often (in ms) to re-register the FCM token with Bosch CBS while the
 * MTalk socket remains alive. Bosch can drop the server-side device
 * registration (TTL / FW upgrade / re-pair) without closing the socket,
 * causing pushes to silently stop. A 24-hour periodic re-register keeps the
 * registration fresh without hammering the CBS endpoint.
 */
export declare const CBS_REREGISTER_INTERVAL_MS: number;
export declare const FCM_SENDER_ID = "404630424405";
export declare const FCM_ANDROID_APP_ID = "1:404630424405:android:9e5b6b58e4c70075";
/**
 * Payload emitted on every motion / audio-alarm / person event.
 * Mirrors the event_payload dict in Python fcm.py _on_fcm_push().
 */
export interface FcmEventPayload {
    /** Bosch camera UUID (videoInputId) */
    cameraId: string;
    /** Human-readable camera name */
    cameraName: string;
    /** ISO 8601 timestamp from Bosch event API */
    timestamp: string;
    /** Normalised event type */
    eventType: "motion" | "audio_alarm" | "person";
    /** Bosch cloud image URL (may be empty until clip is ready) */
    imageUrl?: string;
    /** Bosch cloud event UUID */
    eventId?: string;
}
/**
 * Persisted FCM credential blob — must be stored by the caller and passed back
 * in on the next adapter start via `savedCredentials.raw` to avoid re-registration.
 * Mirrors `saved_fcm_creds` pattern in Python HA integration.
 */
export interface FcmRawCredentials {
    /** ACG ID as a decimal string (bigint can't be JSON-serialised natively) */
    acgId: string;
    /** ACG security token as a decimal string */
    acgSecurityToken: string;
    /** ECE auth secret (Uint8Array serialised as number array for JSON) */
    authSecret: number[];
    /** ECDH private key (Uint8Array serialised as number array for JSON) */
    ecdhPrivateKey: number[];
    /** ECDH public key (Uint8Array serialised as number array for JSON) */
    ecdhPublicKey: number[];
    /** Push mode used for this registration */
    mode: "android";
}
/**
 * FCM credentials returned after successful registration.
 * Intended to be persisted by the caller across restarts.
 */
export interface FcmCredentials {
    /**
     *
     */
    fcmToken: string;
    /** Push mode actually used */
    mode: "android";
    /** Raw credential blob for persistence across restarts (pass as savedCredentials.raw) */
    raw: FcmRawCredentials;
}
/**
 * Options for FcmListener construction.
 */
export interface FcmListenerOptions {
    /**
     * Push registration mode.
     * - "android" → register as Android OSS app (FCM_ANDROID_APP_ID)
     * - "auto"    → use Android OSS app (default; same as "android" since v0.6.1)
     */
    mode?: "android" | "auto";
    /**
     * Previously saved credentials (survives adapter restart — skip re-register
     * if token is still valid). Mirrors `saved_fcm_creds` in Python.
     */
    savedCredentials?: FcmCredentials;
}
/**
 * Thrown when CBS device registration fails with a non-retryable HTTP error.
 */
export declare class FcmCbsRegistrationError extends Error {
    readonly httpStatus: number;
    /**
     *
     * @param httpStatus
     * @param message
     */
    constructor(httpStatus: number, message: string);
}
/**
 * Thrown when FCM registration fails (network error or Google API rejection).
 */
export declare class FcmRegistrationError extends Error {
    readonly cause?: unknown | undefined;
    /**
     *
     * @param message
     * @param cause
     */
    constructor(message: string, cause?: unknown | undefined);
}
/**
 * FCM push-notification listener for Bosch Smart Home Camera events.
 *
 * Events emitted:
 *   "motion"      → FcmEventPayload
 *   "audio_alarm" → FcmEventPayload
 *   "person"      → FcmEventPayload
 *   "push"        → FcmClientMessageData (raw push, for coordinator to fetch events)
 *   "registered"  → FcmCredentials
 *   "error"       → Error
 *   "disconnect"  → void
 *
 * Usage:
 * ```typescript
 * const fcm = new FcmListener(httpClient, bearerToken);
 * fcm.on("push", () => { coordinator.fetchEvents(); });
 * fcm.on("registered", (creds) => { saveCredentials(creds); });
 * await fcm.start();
 * // ...
 * await fcm.stop();
 * ```
 *
 * Note: Bosch pushes are silent wake-up signals with no event payload. The
 * coordinator should listen to "push" and immediately call the Bosch /v11/events
 * API — same as Python async_handle_fcm_push().
 * The "motion", "audio_alarm", "person" events are emitted only when the raw
 * push message contains explicit event-type data in its data dict.
 */
/**
 * Injectable FCM dependencies — allows tests to override the @aracna/fcm
 * functions without sinon module-property stubbing (which fails on ES module
 * non-configurable exports).
 *
 * Production code uses the real @aracna/fcm functions (default).
 * Tests pass a `deps` object with sinon stubs.
 */
export interface FcmDeps {
    /**
     *
     */
    registerToFCM: typeof registerToFCM;
    /**
     *
     */
    createFcmECDH: typeof createFcmECDH;
    /**
     *
     */
    generateFcmAuthSecret: typeof generateFcmAuthSecret;
    /**
     *
     */
    FcmClient: typeof FcmClient;
    /**
     * Injectable timer — ioBroker adapter uses adapter.setInterval(); tests can
     * inject a controllable mock. Default: globalThis.setInterval.
     */
    setInterval: (callback: () => void, delay: number) => unknown;
    /**
     * Injectable timer — ioBroker adapter uses adapter.clearInterval(); tests
     * can inject a controllable mock. Default: globalThis.clearInterval.
     */
    clearInterval: (id: unknown) => void;
}
/**
 *
 */
export declare class FcmListener extends EventEmitter {
    private readonly _httpClient;
    private _bearerToken;
    private readonly _options;
    /** Injectable deps — overridable in tests. */
    readonly _deps: FcmDeps;
    private _fcmToken;
    private _running;
    private _clientHandle;
    /** Periodic CBS re-registration timer — cleared on stop(). */
    private _reregisterTimer;
    /**
     *
     * @param httpClient
     * @param bearerToken
     * @param options
     * @param deps
     */
    constructor(httpClient: AxiosInstance, bearerToken: string, options?: FcmListenerOptions, deps?: Partial<FcmDeps>);
    /**
     * v1.1.0: refresh the bearer token used for the Bosch CBS registration.
     * The adapter must call this whenever its OAuth access token is renewed
     * (and before a reconnect) so the next start() / _registerWithCbs uses a
     * live token instead of the expired one captured at construction.
     *
     * @param token the current Bosch access_token
     */
    updateBearerToken(token: string): void;
    /**
     * Register with FCM and start listening for push notifications.
     *
     * Step 1: Generate or restore ECDH key pair + auth secret.
     * Step 2: Register with Google FCM (registerToFCM) → get ACG tokens + FCM token.
     * Step 3: Register the FCM token with Bosch CBS (POST /v11/devices).
     * Step 4: Start FcmClient TLS socket → emit "push" on every incoming message.
     *
     * @fires "registered" with FcmCredentials once FCM + CBS registration complete.
     * @throws FcmRegistrationError   if Google FCM registration fails.
     * @throws FcmCbsRegistrationError if Bosch CBS rejects the token (HTTP 4xx).
     */
    start(): Promise<void>;
    /**
     * Stop the listener cleanly. Closes the MTalk TLS socket and sets state to
     * stopped. Safe to call multiple times (idempotent).
     *
     * @fires "disconnect"
     */
    stop(): Promise<void>;
    /**
     * Returns the current FCM device token, or null if not yet registered.
     */
    getFcmToken(): string | null;
    /**
     * Returns true when the FCM TLS socket is active and receiving pushes.
     */
    isHealthy(): boolean;
    /**
     * Attempt FCM registration + CBS registration + client start for a single mode.
     * Returns true on success, false on any error (caller logs and falls back).
     *
     * @param mode
     */
    private _tryStart;
    /**
     * Register the FCM device token with Bosch CBS.
     *
     * Endpoint: POST /v11/devices  { deviceType: "ANDROID", deviceToken }
     * HTTP 204 → success. HTTP 500 + "sh:internal.error" → already registered
     * (treat as success, same as Python register_fcm_with_bosch()).
     *
     * @param token FCM registration token returned by Google FCM.
     * @throws FcmCbsRegistrationError on non-retryable HTTP 4xx.
     */
    _registerWithCbs(token: string): Promise<void>;
    /**
     * Handle an incoming FCM push message from Bosch.
     *
     * Bosch pushes are typically silent wake-ups (no event-type data in payload).
     * Always emits "push" so the coordinator can fetch /v11/events immediately.
     * If the data dict contains event type info, also parses and emits the typed event.
     *
     * Mirrors Python _on_fcm_push() + async_handle_fcm_push() flow.
     *
     * @param data
     */
    private _onPush;
    /**
     * Parse a raw FCM notification payload into a typed FcmEventPayload.
     * Mirrors the event-type normalisation in Python _on_fcm_push() +
     * async_handle_fcm_push():
     *   - eventType=MOVEMENT + eventTags=["PERSON"] → eventType="person"
     *   - eventType=MOVEMENT                        → eventType="motion"
     *   - eventType=AUDIO_ALARM                     → eventType="audio_alarm"
     *
     * @param raw
     * @returns Parsed payload, or null if the event type is not recognised.
     */
    _parseNotification(raw: Record<string, unknown>): FcmEventPayload | null;
}
//# sourceMappingURL=fcm.d.ts.map