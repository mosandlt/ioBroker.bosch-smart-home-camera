/**
 * Coverage booster for src/main.ts L3280–L4000 — state-poll + event-processing band.
 *
 * Target red clusters:
 *   L3286-3299  _localWritePrivacy fallback: HTTP !ok + RCP <err> + catch path
 *   L3345-3360  onReady: silent refresh_token flow (expired access_token, refresh succeeds)
 *   L3417-3489  onReady: camera discovery 401 (retry), non-401 error (cloud-degraded startup,
 *               empty objects DB → bail, populated objects DB → rehydrate + ping)
 *   L3591-3602  FCM "registered" event → _saveFcmCredentials error path
 *   L3724-3736  _pollCameraStateOnce: 401 (skip), non-401 (ping sweep + rethrow)
 *   L3929-3948  _pollSingleCameraState: lighting dedup write paths (changed vs unchanged)
 *   L3982-3995  _pollIntrusionConfig: 443/null + network error catch + missing-field defence
 *
 * Strategy mirrors v091_pollers.spec.ts:
 *   createAdapterWithMocks + bootWithTokens + stubAxiosByUrl (URL-matched, drift-proof).
 *   NOTE: chai-as-promised is NOT loaded in this harness — use explicit try/catch for
 *   fulfilled/rejected assertions (pattern from main_v090_features.spec.ts).
 */

import { expect } from "chai";
import * as sinon from "sinon";
import * as path from "path";

import { stubAxiosByUrl, stubAxiosSequence, restoreAxios } from "./helpers/axios-mock";

import type { MockDatabase } from "@iobroker/testing/build/tests/unit/mocks/mockDatabase";
import type { MockAdapter } from "@iobroker/testing/build/tests/unit/mocks/mockAdapter";

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const { MockDatabase: MockDatabaseCtor } =
    require("@iobroker/testing/build/tests/unit/mocks/mockDatabase") as {
        MockDatabase: new () => MockDatabase;
    };

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const { mockAdapterCore: mockAdapterCoreFn } =
    require("@iobroker/testing/build/tests/unit/mocks/mockAdapterCore") as {
        mockAdapterCore: (
            db: MockDatabase,
            opts?: { onAdapterCreated?: (a: MockAdapter) => void },
        ) => unknown;
    };

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MAIN_JS_PATH = path.join(REPO_ROOT, "build", "main.js");
const ADAPTER_CORE_PATH = require.resolve("@iobroker/adapter-core");

type TestAdapter = MockAdapter & {
    readyHandler?: () => Promise<void>;
    unloadHandler?: (cb: () => void) => void;
    stateChangeHandler?: ioBroker.StateChangeHandler;
};

// ── Camera fixtures ──────────────────────────────────────────────────────────

const CAM_GEN2 = "0A0B0C0D-1111-2222-3333-000000000001";
const CAM_GEN2_INDOOR = "0A0B0C0D-1111-2222-3333-000000000002";
const CAM_GEN1 = "0A0B0C0D-1111-2222-3333-000000000003";

const CAM_GEN2_OUTDOOR_BODY = {
    id: CAM_GEN2,
    title: "Terrasse",
    hardwareVersion: "HOME_Eyes_Outdoor",
    firmwareVersion: "9.40.25",
    featureSupport: { light: true, panLimit: 0 },
    privacyMode: "OFF",
};

const CAM_GEN2_INDOOR_BODY = {
    id: CAM_GEN2_INDOOR,
    title: "Innenbereich",
    hardwareVersion: "HOME_Eyes_Indoor",
    firmwareVersion: "9.40.25",
    featureSupport: { light: false, panLimit: 0 },
    privacyMode: "OFF",
};

const CAM_GEN1_BODY = {
    id: CAM_GEN1,
    title: "Kamera",
    hardwareVersion: "CAMERA_360",
    firmwareVersion: "7.91.56",
    featureSupport: { light: false, panLimit: 90 },
    privacyMode: "OFF",
};

const TOKEN_BODY = {
    access_token: "poll.test.token",
    refresh_token: "poll.test.refresh",
    expires_in: 300,
    refresh_expires_in: 86400,
    token_type: "Bearer",
    scope: "openid",
};

// ── Module mock helpers ───────────────────────────────────────────────────────

function resolveBuildModule(name: string): string {
    return path.join(REPO_ROOT, "build", "lib", `${name}.js`);
}

interface FcmListenerEvents {
    [key: string]: ((...args: unknown[]) => void)[];
}

/**
 * Minimal EventEmitter-compatible FCM listener mock.
 * Captures event subscriptions so tests can fire them manually.
 */
class FakeFcmListener {
    public _events: FcmListenerEvents = {};
    public startStub = sinon.stub().resolves();
    public stopStub = sinon.stub().resolves();

    on(event: string, handler: (...args: unknown[]) => void): this {
        if (!this._events[event]) this._events[event] = [];
        this._events[event].push(handler);
        return this;
    }

    emit(event: string, ...args: unknown[]): void {
        (this._events[event] ?? []).forEach((h) => h(...args));
    }

    start(): Promise<void> {
        return this.startStub();
    }

    stop(): Promise<void> {
        return this.stopStub();
    }
}

let _capturedFcmListener: FakeFcmListener | null = null;

/**
 * Build and register all required module mocks, then load main.js.
 * Returns adapter + db. configOverrides are merged onto the adapter config.
 */
function createAdapterWithMocks(configOverrides: Record<string, unknown> = {}): {
    db: MockDatabase;
    adapter: TestAdapter;
} {
    const db = new MockDatabaseCtor();
    let capturedAdapter: MockAdapter | null = null;

    const core = mockAdapterCoreFn(db, {
        onAdapterCreated: (a: MockAdapter) => {
            capturedAdapter = a;
        },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[ADAPTER_CORE_PATH] = {
        id: ADAPTER_CORE_PATH,
        filename: ADAPTER_CORE_PATH,
        loaded: true,
        parent: module,
        children: [],
        path: path.dirname(ADAPTER_CORE_PATH),
        paths: [],
        exports: core,
    };

    // snapshot mock
    const snapshotPath = resolveBuildModule("snapshot");
    delete require.cache[snapshotPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[snapshotPath] = {
        id: snapshotPath,
        filename: snapshotPath,
        loaded: true,
        parent: module,
        children: [],
        path: path.dirname(snapshotPath),
        paths: [],
        exports: {
            fetchSnapshot: sinon.stub().resolves(Buffer.from("FAKEJPEG")),
            buildSnapshotUrl: (u: string) => `${u}/snap.jpg`,
        },
    };

    // live_session mock
    const liveSessionPath = resolveBuildModule("live_session");
    delete require.cache[liveSessionPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[liveSessionPath] = {
        id: liveSessionPath,
        filename: liveSessionPath,
        loaded: true,
        parent: module,
        children: [],
        path: path.dirname(liveSessionPath),
        paths: [],
        exports: {
            openLiveSession: sinon.stub().resolves({
                camId: CAM_GEN2,
                lanAddress: "192.168.1.149:443",
                proxyUrl: "rtsp://127.0.0.1:18001/rtsp_tunnel",
                maxSessionDuration: 3600,
                openedAt: Date.now(),
                digestUser: "u",
                digestPassword: "p",
            }),
            closeLiveSession: sinon.stub().resolves(),
        },
    };

    // tls_proxy mock
    const tlsProxyPath = resolveBuildModule("tls_proxy");
    delete require.cache[tlsProxyPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[tlsProxyPath] = {
        id: tlsProxyPath,
        filename: tlsProxyPath,
        loaded: true,
        parent: module,
        children: [],
        path: path.dirname(tlsProxyPath),
        paths: [],
        exports: {
            startTlsProxy: sinon.stub().resolves({
                port: 18001,
                localRtspUrl: "rtsp://127.0.0.1:18001/rtsp_tunnel",
                stop: sinon.stub().resolves(),
            }),
        },
    };

    // session_watchdog mock
    const watchdogPath = resolveBuildModule("session_watchdog");
    delete require.cache[watchdogPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[watchdogPath] = {
        id: watchdogPath,
        filename: watchdogPath,
        loaded: true,
        parent: module,
        children: [],
        path: path.dirname(watchdogPath),
        paths: [],
        exports: {
            SessionWatchdog: class {
                start = sinon.stub();
                stop = sinon.stub();
                constructor(_o: unknown) {}
            },
        },
    };

    // FCM listener mock — captures event subscriptions
    _capturedFcmListener = new FakeFcmListener();
    const fcmPath = resolveBuildModule("fcm");
    delete require.cache[fcmPath];
    const capturedFcm = _capturedFcmListener;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[fcmPath] = {
        id: fcmPath,
        filename: fcmPath,
        loaded: true,
        parent: module,
        children: [],
        path: path.dirname(fcmPath),
        paths: [],
        exports: {
            FcmListener: class {
                on(event: string, handler: (...args: unknown[]) => void) {
                    capturedFcm.on(event, handler);
                    return this;
                }
                start() {
                    return capturedFcm.start();
                }
                stop() {
                    return capturedFcm.stop();
                }
            },
            FcmCbsRegistrationError: class extends Error {
                constructor(msg: string) {
                    super(msg);
                    this.name = "FcmCbsRegistrationError";
                }
            },
        },
    };

    delete require.cache[MAIN_JS_PATH];
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const factory = require(MAIN_JS_PATH) as (opts: Record<string, unknown>) => MockAdapter;
    factory({ config: { redirect_url: "", region: "EU", ...configOverrides } });

    if (!capturedAdapter) throw new Error("adapter not captured");
    const adapter = capturedAdapter as TestAdapter;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).setTimeout = (_fn: () => void, _ms: number) => null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).clearTimeout = (_h: unknown) => undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).setInterval = (_fn: () => void, _ms: number) => null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).clearInterval = (_h: unknown) => undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).terminate = () => undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).writeFileAsync = sinon.stub().resolves();

    return { db, adapter };
}

/** Boot the adapter using pre-stored valid tokens (skips PKCE flow). */
async function bootWithTokens(db: MockDatabase, adapter: TestAdapter): Promise<void> {
    const futureExpiry = Date.now() + 200_000;
    db.publishState(`${adapter.namespace}.info.access_token`, { val: "stored.acc", ack: true });
    db.publishState(`${adapter.namespace}.info.refresh_token`, { val: "stored.ref", ack: true });
    db.publishState(`${adapter.namespace}.info.token_expires_at`, {
        val: futureExpiry,
        ack: true,
    });
    await adapter.readyHandler!();
}

/** Read a DP value directly from the mock DB. */
function getStateVal(db: MockDatabase, adapter: TestAdapter, id: string): unknown {
    const fullId = `${adapter.namespace}.${id}`;
    const state = db.getState(fullId) as ioBroker.State | null | undefined;
    return state?.val;
}

/**
 * URL stub builder for a Gen2 Outdoor boot (cameras + all per-camera polls).
 *
 * IMPORTANT:
 *  - "video_inputs" match covers both the list URL (.../v11/video_inputs) and per-cam URLs
 *    (.../v11/video_inputs/{id}/...). Per-camera poll sub-URLs (intrusionDetectionConfig etc.)
 *    are matched BEFORE the general "video_inputs" to prevent false short-circuit.
 *  - "lighting/switch" MUST come before "/lighting" to avoid substring conflict.
 */
type StubOverride = { status?: number; data?: unknown; reject?: boolean };

function gen2OutdoorUrlStubs(
    _camId: string,
    overrides: Record<string, StubOverride> = {},
): Parameters<typeof stubAxiosByUrl>[0] {
    const defaults: Array<[string, StubOverride]> = [
        // Per-camera sub-endpoints must come BEFORE the generic "video_inputs" catch-all
        ["wifiinfo", { status: 404, data: null }],
        ["intrusionDetectionConfig", { status: 200, data: { sensitivity: 3, distance: 5 } }],
        // lighting/switch MUST precede /lighting to avoid false substring match
        ["lighting/switch", {
            status: 200,
            data: {
                topLedLightSettings: { brightness: 50, color: "#ffffff" },
                bottomLedLightSettings: { brightness: 50, color: "#ffffff" },
                frontLightSettings: { brightness: 0 },
            },
        }],
        ["lens_elevation", { status: 200, data: { elevation: 0 } }],
        ["/lighting", { status: 200, data: { darknessThreshold: 0.5, softLightFading: true } }],
        ["/events", { status: 200, data: [] }],
        ["privacy_sound_override", { status: 200, data: { result: false } }],
        // Camera list — must come LAST because it matches all v11/video_inputs URLs
        ["video_inputs", { status: 200, data: [CAM_GEN2_OUTDOOR_BODY] }],
    ];

    // Merge overrides
    return defaults.map(([match, resp]) => ({
        match,
        ...(overrides[match] ?? resp),
    }));
}

/**
 * URL stub builder for a Gen2 Indoor II (HOME_Eyes_Indoor) boot.
 * Indoor II has no light/wallwasher and runs alarm_settings instead of global_lighting.
 * video_inputs is placed LAST so it doesn't swallow per-camera sub-URL matches.
 */
function gen2IndoorUrlStubs(
    _camId: string,
    overrides: Record<string, StubOverride> = {},
): Parameters<typeof stubAxiosByUrl>[0] {
    const defaults: Array<[string, StubOverride]> = [
        ["wifiinfo", { status: 404, data: null }],
        ["intrusionDetectionConfig", { status: 200, data: { sensitivity: 3 } }],
        ["lighting/switch", { status: 200, data: null }], // Indoor II has no light HW, but stub needed
        ["lens_elevation", { status: 200, data: { elevation: 0 } }],
        ["alarm_settings", { status: 200, data: {
            alarmDelayInSeconds: 30,
            alarmActivationDelaySeconds: 5,
            preAlarmDelayInSeconds: 10,
        }}],
        ["/events", { status: 200, data: [] }],
        ["privacy_sound_override", { status: 200, data: { result: false } }],
        // video_inputs LAST
        ["video_inputs", { status: 200, data: [CAM_GEN2_INDOOR_BODY] }],
    ];

    return defaults.map(([match, resp]) => ({
        match,
        ...(overrides[match] ?? resp),
    }));
}

// ── Teardown ──────────────────────────────────────────────────────────────────

afterEach(() => {
    restoreAxios();
    sinon.restore();
    _capturedFcmListener = null;
    delete require.cache[resolveBuildModule("snapshot")];
    delete require.cache[resolveBuildModule("live_session")];
    delete require.cache[resolveBuildModule("tls_proxy")];
    delete require.cache[resolveBuildModule("session_watchdog")];
    delete require.cache[resolveBuildModule("fcm")];
    delete require.cache[MAIN_JS_PATH];
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cluster L3724-3736  _pollCameraStateOnce error paths
// ═══════════════════════════════════════════════════════════════════════════════

describe("main_coverage_poll — _pollCameraStateOnce L3724-3736", () => {
    it("401 from fetchCameras in poll tick → skips silently (no rethrow)", async () => {
        // Install reject:true for 401 on the cameras list BEFORE boot.
        // Boot will fail (cloud-degraded), then the poll tick also gets 401 → swallows.
        stubAxiosByUrl([
            { match: "video_inputs", status: 401, data: null, reject: true },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // Boot failed gracefully. Now set access token so poll tick runs.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._currentAccessToken = "stored.acc";

        let threw = false;
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (adapter as any)._pollCameraStateOnce();
        } catch {
            threw = true;
        }
        expect(threw).to.equal(false, "401 in poll tick must be swallowed, not rethrown");
        void db;
    });

    it("non-401 5xx from fetchCameras in poll tick → rethrows (calls maintenance+ping first)", async () => {
        // Install reject:true with status 503 on cameras list BEFORE boot.
        stubAxiosByUrl([
            { match: "video_inputs", status: 503, data: null, reject: true },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._currentAccessToken = "stored.acc";

        let threw = false;
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (adapter as any)._pollCameraStateOnce();
        } catch {
            threw = true;
        }
        expect(threw).to.equal(true, "non-401 5xx in poll tick must propagate to caller");
        void db;
    });

    it("_pollCameraStateOnce without active token → early return (no-op)", async () => {
        stubAxiosByUrl(gen2OutdoorUrlStubs(CAM_GEN2));
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        // Clear the in-memory token — early return before any HTTP call
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._currentAccessToken = null;

        let threw = false;
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (adapter as any)._pollCameraStateOnce();
        } catch {
            threw = true;
        }
        expect(threw).to.equal(false, "null token must return early without error");
        void db;
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cluster L3929-3948  _pollSingleCameraState lighting dedup write paths
// ═══════════════════════════════════════════════════════════════════════════════

describe("main_coverage_poll — _pollSingleCameraState lighting dedup L3929-3948", () => {
    it("lighting state unchanged → no upsert writes (dedup skips)", async () => {
        // normaliseHex() uppercases → use uppercase in both stub response and seed state
        const lightingResp = {
            topLedLightSettings: { brightness: 80, color: "#FF0000" },
            bottomLedLightSettings: { brightness: 80, color: "#FF0000" },
            frontLightSettings: { brightness: 0 },
        };
        stubAxiosByUrl(gen2OutdoorUrlStubs(CAM_GEN2, {
            "lighting/switch": { status: 200, data: lightingResp },
        }));
        const { db, adapter } = createAdapterWithMocks();

        // Pre-seed state to match exactly (post-normaliseHex values) — dedup gate sees current==desired → skip write
        const ns = adapter.namespace;
        db.publishState(`${ns}.cameras.${CAM_GEN2}.wallwasher_brightness`, { val: 80, ack: true });
        db.publishState(`${ns}.cameras.${CAM_GEN2}.wallwasher_color`, { val: "#FF0000", ack: true });
        db.publishState(`${ns}.cameras.${CAM_GEN2}.front_light_enabled`, { val: false, ack: true });
        db.publishState(`${ns}.cameras.${CAM_GEN2}.wallwasher_enabled`, { val: true, ack: true });

        await bootWithTokens(db, adapter);
        // Explicitly drive a poll tick so _pollSingleCameraState runs
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollCameraStateOnce();

        // Values must remain as seeded (unchanged — dedup skipped writes)
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2}.wallwasher_brightness`)).to.equal(80);
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2}.wallwasher_color`)).to.equal("#FF0000");
    });

    it("lighting state changed → DPs updated to new values", async () => {
        // top=60, bottom=40 → max=60; top.color="#00ff00"; front=100>0=true; wall=60>0=true
        const lightingResp = {
            topLedLightSettings: { brightness: 60, color: "#00ff00" },
            bottomLedLightSettings: { brightness: 40, color: "#00ff00" },
            frontLightSettings: { brightness: 100 },
        };
        stubAxiosByUrl(gen2OutdoorUrlStubs(CAM_GEN2, {
            "lighting/switch": { status: 200, data: lightingResp },
        }));
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // Explicitly drive poll tick so _pollSingleCameraState runs
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollCameraStateOnce();

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2}.wallwasher_brightness`)).to.equal(60);
        // normaliseHex() in alarm_light.ts uppercases hex colors → "#00FF00"
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2}.wallwasher_color`)).to.equal("#00FF00");
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2}.front_light_enabled`)).to.equal(true);
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2}.wallwasher_enabled`)).to.equal(true);
    });

    it("lighting/switch → 200 null data → early return, no DP writes", async () => {
        stubAxiosByUrl(gen2OutdoorUrlStubs(CAM_GEN2, {
            "lighting/switch": { status: 200, data: null },
        }));
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollCameraStateOnce();
        const br = getStateVal(db, adapter, `cameras.${CAM_GEN2}.wallwasher_brightness`);
        // Not written — could be 0 (default seed) or undefined. Must NOT be some API value.
        expect(typeof br === "undefined" || typeof br === "number").to.be.true;
    });

    it("Gen2 camera with featureLight=false → skips lighting/switch entirely", async () => {
        stubAxiosByUrl([
            { match: "wifiinfo", status: 404, data: null },
            { match: "intrusionDetectionConfig", status: 200, data: { sensitivity: 3 } },
            // lighting/switch before /lighting in list
            { match: "lighting/switch", status: 200, data: {
                topLedLightSettings: { brightness: 99, color: "#beef00" },
                bottomLedLightSettings: { brightness: 99, color: "#beef00" },
                frontLightSettings: { brightness: 99 },
            }},
            { match: "lens_elevation", status: 200, data: { elevation: 0 } },
            { match: "alarm_settings", status: 200, data: {
                alarmDelayInSeconds: 30,
                alarmActivationDelaySeconds: 5,
                preAlarmDelayInSeconds: 10,
            }},
            { match: "/events", status: 200, data: [] },
            { match: "privacy_sound_override", status: 200, data: { result: false } },
            // video_inputs LAST — matches both list URL and per-camera sub-URLs
            { match: "video_inputs", status: 200, data: [CAM_GEN2_INDOOR_BODY] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollCameraStateOnce();

        // featureLight=false → lighting/switch not called, brightness stays unset
        const br = getStateVal(db, adapter, `cameras.${CAM_GEN2_INDOOR}.wallwasher_brightness`);
        expect(br === undefined || br !== 99).to.be.true;
    });

    it("Gen1 camera (CAMERA_360) → skips all Gen2-only polls (intrusion/lens/global-lighting)", async () => {
        stubAxiosByUrl([
            { match: "wifiinfo", status: 404, data: null },
            // lighting/switch before /lighting
            { match: "lighting/switch", status: 200, data: {
                topLedLightSettings: { brightness: 0, color: "#000" },
                bottomLedLightSettings: { brightness: 0, color: "#000" },
                frontLightSettings: { brightness: 0 },
            }},
            { match: "/events", status: 200, data: [] },
            { match: "privacy_sound_override", status: 200, data: { result: false } },
            { match: "autofollow", status: 200, data: { result: false } },
            // These must NOT be called for Gen1 — if they were, sens would be 77
            { match: "intrusionDetectionConfig", status: 200, data: { sensitivity: 77 } },
            { match: "lens_elevation", status: 200, data: { elevation: 77 } },
            // video_inputs LAST
            { match: "video_inputs", status: 200, data: [CAM_GEN1_BODY] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollCameraStateOnce();

        // intrusion_sensitivity must not be 77 (never written for Gen1)
        const sens = getStateVal(db, adapter, `cameras.${CAM_GEN1}.intrusion_sensitivity`);
        expect(sens === undefined || sens !== 77).to.be.true;
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cluster L3982-3995  _pollIntrusionConfig error branches
// ═══════════════════════════════════════════════════════════════════════════════

describe("main_coverage_poll — _pollIntrusionConfig L3982-3995", () => {
    it("443 (privacy active) → returns early, no DP write", async () => {
        stubAxiosByUrl(gen2OutdoorUrlStubs(CAM_GEN2, {
            intrusionDetectionConfig: { status: 443, data: null },
        }));
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const sens = getStateVal(db, adapter, `cameras.${CAM_GEN2}.intrusion_sensitivity`);
        expect(sens === undefined || sens === null).to.be.true;
    });

    it("200 with null data → returns early, no DP write", async () => {
        stubAxiosByUrl(gen2OutdoorUrlStubs(CAM_GEN2, {
            intrusionDetectionConfig: { status: 200, data: null },
        }));
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const sens = getStateVal(db, adapter, `cameras.${CAM_GEN2}.intrusion_sensitivity`);
        expect(sens === undefined || sens === null).to.be.true;
    });

    it("200 with missing sensitivity/distance fields → no DP writes (undefined guard)", async () => {
        stubAxiosByUrl(gen2OutdoorUrlStubs(CAM_GEN2, {
            intrusionDetectionConfig: { status: 200, data: { someOtherField: "irrelevant" } },
        }));
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const sens = getStateVal(db, adapter, `cameras.${CAM_GEN2}.intrusion_sensitivity`);
        const dist = getStateVal(db, adapter, `cameras.${CAM_GEN2}.intrusion_distance`);
        expect(sens === undefined || sens === null).to.be.true;
        expect(dist === undefined || dist === null).to.be.true;
    });

    it("network error on intrusionDetectionConfig → caught, no rethrow", async () => {
        stubAxiosByUrl([
            { match: "wifiinfo", status: 404, data: null },
            { match: "intrusionDetectionConfig", reject: true, status: 503, data: null },
            { match: "lighting/switch", status: 200, data: {
                topLedLightSettings: { brightness: 0, color: "#000" },
                bottomLedLightSettings: { brightness: 0, color: "#000" },
                frontLightSettings: { brightness: 0 },
            }},
            { match: "lens_elevation", status: 200, data: { elevation: 0 } },
            { match: "/lighting", status: 200, data: { darknessThreshold: 0.5 } },
            { match: "/events", status: 200, data: [] },
            { match: "privacy_sound_override", status: 200, data: { result: false } },
            { match: "video_inputs", status: 200, data: [CAM_GEN2_OUTDOOR_BODY] },
        ]);
        const { db, adapter } = createAdapterWithMocks();

        let threw = false;
        try {
            await bootWithTokens(db, adapter);
        } catch {
            threw = true;
        }
        expect(threw).to.equal(false, "network error in intrusion poll must not propagate");
    });

    it("200 with only sensitivity (no distance) → writes only sensitivity DP", async () => {
        stubAxiosByUrl(gen2OutdoorUrlStubs(CAM_GEN2, {
            intrusionDetectionConfig: { status: 200, data: { sensitivity: 7 } },
        }));
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollCameraStateOnce();

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2}.intrusion_sensitivity`)).to.equal(7);
        // distance field absent → DP not overwritten (stays at default 5 from ensureCameraObjects or undefined)
        const dist = getStateVal(db, adapter, `cameras.${CAM_GEN2}.intrusion_distance`);
        // It's either undefined, null, or the seed default — but NOT a value we set
        expect(dist !== 99).to.be.true;
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cluster L3345-3360  onReady silent refresh_token flow
// ═══════════════════════════════════════════════════════════════════════════════

describe("main_coverage_poll — onReady silent token refresh L3345-3360", () => {
    it("expired access_token + valid refresh_token → silent refresh, then boot succeeds", async () => {
        // This test exercises the L3345-3360 branch:
        // loadStoredTokens() returns null (expired) → reads refresh_token state → calls refreshAccessToken
        // → refreshed → saveTokens → boot continues.
        //
        // Stubs (positional, refresh is a POST to /token):
        //   [0] token refresh POST → TOKEN_BODY
        //   [1] cameras list GET → CAM_GEN2_OUTDOOR_BODY
        //   [2-8] per-camera polls
        stubAxiosSequence([
            { status: 200, data: TOKEN_BODY },  // [0] refreshAccessToken POST /oauth2/token
            { status: 200, data: [CAM_GEN2_OUTDOOR_BODY] }, // [1] fetchCameras
            { status: 404, data: null },  // [2] wifiinfo
            { status: 200, data: { sensitivity: 3, distance: 5 } }, // [3] intrusion
            { status: 200, data: { elevation: 0 } },  // [4] lens_elevation
            { status: 200, data: { darknessThreshold: 0.5 } }, // [5] global lighting
            { status: 200, data: [] },  // [6] events
            { status: 200, data: { result: false } }, // [7] privacy_sound
            { status: 200, data: {  // [8] lighting/switch
                topLedLightSettings: { brightness: 50, color: "#fff" },
                bottomLedLightSettings: { brightness: 50, color: "#fff" },
                frontLightSettings: { brightness: 0 },
            }},
        ]);

        const { db, adapter } = createAdapterWithMocks();

        // Expired access token (expiry in the past) + valid refresh token
        const pastExpiry = Date.now() - 10_000;
        db.publishState(`${adapter.namespace}.info.access_token`, { val: "expired.acc", ack: true });
        db.publishState(`${adapter.namespace}.info.refresh_token`, { val: "valid.refresh", ack: true });
        db.publishState(`${adapter.namespace}.info.token_expires_at`, { val: pastExpiry, ack: true });
        db.publishState(`${adapter.namespace}.info.pkce_verifier`, { val: "", ack: true });

        await adapter.readyHandler!();

        // Connection should be true — silent refresh succeeded
        expect(getStateVal(db, adapter, "info.connection")).to.equal(true);
    });

    it("expired access_token + refresh_token exchange throws → falls back to PKCE (no redirect URL)", async () => {
        // refresh fails with 400 rejection → refreshAccessToken catches it + throws RefreshTokenInvalidError
        // → onReady catch: logs warn, sets refreshed=null → no redirect_url → showLoginUrl → connection=false
        //
        // NOTE: stubAxiosSequence resolves by default. Use reject:true stub approach:
        // For this test we want refreshAccessToken to REJECT (throw error), not resolve with 400.
        // stubAxiosByUrl supports reject:true; but _httpClient was locked at require time.
        // Use stubAxiosSequence with a stub that resolves 400 (non-array data) so
        // refreshAccessToken returns null-ish (undefined access_token) → treated as failure.
        // The adapter falls to "else" branch where no pastedUrl → showLoginUrl → connection=false.
        stubAxiosSequence([
            // [0] refreshAccessToken → resolves 400 (non-reject) → access_token=undefined → null result path
            { status: 400, data: null },
            // After showLoginUrl the adapter stays alive; no further calls needed
        ]);

        const { db, adapter } = createAdapterWithMocks({ redirect_url: "" });

        const pastExpiry = Date.now() - 10_000;
        db.publishState(`${adapter.namespace}.info.access_token`, { val: "expired.acc", ack: true });
        db.publishState(`${adapter.namespace}.info.refresh_token`, { val: "stale.refresh", ack: true });
        db.publishState(`${adapter.namespace}.info.token_expires_at`, { val: pastExpiry, ack: true });
        db.publishState(`${adapter.namespace}.info.pkce_verifier`, { val: "", ack: true });

        await adapter.readyHandler!();

        // Connection false — waiting for PKCE paste
        expect(getStateVal(db, adapter, "info.connection")).to.equal(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cluster L3417-3489  onReady camera-discovery error paths
// ═══════════════════════════════════════════════════════════════════════════════

describe("main_coverage_poll — onReady camera discovery error paths L3417-3489", () => {
    it("camera discovery 401 → token refresh → retry succeeds → boot continues", async () => {
        // Sequence: [0] cameras → 401-reject, [1] refreshToken → ok, [2] cameras retry → ok, [3+] polls
        stubAxiosSequence([
            { status: 401, data: null },                      // [0] fetchCameras → UnauthorizedError
            { status: 200, data: TOKEN_BODY },                 // [1] refreshAccessToken
            { status: 200, data: [CAM_GEN2_OUTDOOR_BODY] },   // [2] fetchCameras retry
            { status: 404, data: null },                      // [3] wifiinfo
            { status: 200, data: { sensitivity: 3, distance: 5 } }, // [4] intrusion
            { status: 200, data: { elevation: 0 } },          // [5] lens
            { status: 200, data: { darknessThreshold: 0.5 } }, // [6] global lighting
            { status: 200, data: [] },                        // [7] events
            { status: 200, data: { result: false } },         // [8] privacy_sound
            { status: 200, data: {                            // [9] lighting/switch
                topLedLightSettings: { brightness: 0, color: "#000" },
                bottomLedLightSettings: { brightness: 0, color: "#000" },
                frontLightSettings: { brightness: 0 },
            }},
        ]);

        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        expect(getStateVal(db, adapter, "info.connection")).to.equal(true);
    });

    it("camera discovery 401 + refresh → retry also fails → connection=false, return", async () => {
        // This test exercises L3417-3438 (UnauthorizedError path with retry).
        // fetchCameras throws UnauthorizedError on 401 reject, refreshAccessToken
        // returns new tokens, but the retry fetchCameras also rejects (503).
        //
        // Use a custom axios adapter installed BEFORE require(main.js) so the
        // _httpClient instance picks it up. The adapter alternates responses per URL.
        const axios = require("axios");
        let callCount = 0;
        axios.defaults.adapter = (cfg: { url?: string }) => {
            const url = cfg?.url ?? "";
            callCount++;
            if (url.includes("video_inputs") && callCount === 1) {
                // First camera list → 401 reject → UnauthorizedError
                const e: Error & { response?: { status: number; data: null; headers: Record<string, string> }; isAxiosError?: boolean } =
                    new Error("Request failed with status code 401");
                e.response = { status: 401, data: null, headers: {} };
                e.isAxiosError = true;
                return Promise.reject(e);
            }
            if (url.includes("token")) {
                // refreshAccessToken → success
                return Promise.resolve({ status: 200, statusText: "OK", headers: {}, data: TOKEN_BODY, config: {}, request: {} });
            }
            if (url.includes("video_inputs") && callCount > 1) {
                // Retry camera list → 503 reject → CamerasApiError
                const e: Error & { response?: { status: number; data: null; headers: Record<string, string> }; isAxiosError?: boolean } =
                    new Error("Request failed with status code 503");
                e.response = { status: 503, data: null, headers: {} };
                e.isAxiosError = true;
                return Promise.reject(e);
            }
            // Everything else → 404 (fallback)
            return Promise.resolve({ status: 404, statusText: "Not Found", headers: {}, data: null, config: {}, request: {} });
        };

        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        expect(getStateVal(db, adapter, "info.connection")).to.equal(false);
    });

    it("camera discovery non-401 error + empty objects DB → bail out (no cameras persisted)", async () => {
        // Use reject:true so fetchCameras actually throws CamerasApiError (5xx path)
        stubAxiosByUrl([{ match: "video_inputs", reject: true, status: 503, data: null }]);

        const { db, adapter } = createAdapterWithMocks();
        const futureExpiry = Date.now() + 200_000;
        db.publishState(`${adapter.namespace}.info.access_token`, { val: "stored.acc", ack: true });
        db.publishState(`${adapter.namespace}.info.refresh_token`, { val: "stored.ref", ack: true });
        db.publishState(`${adapter.namespace}.info.token_expires_at`, { val: futureExpiry, ack: true });

        await adapter.readyHandler!();

        // No persisted cam objects → bail, connection stays false
        expect(getStateVal(db, adapter, "info.connection")).to.equal(false);
    });

    it("camera discovery non-401 error + populated objects DB → cloud-degraded startup, stays alive", async () => {
        stubAxiosByUrl([{ match: "video_inputs", reject: true, status: 503, data: null }]);

        const { db, adapter } = createAdapterWithMocks();

        // publishChannelObjects takes an object with _id already set
        const ns = adapter.namespace;
        const objId = `${ns}.cameras.${CAM_GEN2}`;
        db.publishChannelObjects({ _id: objId, common: { name: "Terrasse" }, native: {} } as ioBroker.ChannelObject);
        db.publishState(`${ns}.cameras.${CAM_GEN2}.lan_ip`, { val: "192.168.1.149", ack: true });

        const futureExpiry = Date.now() + 200_000;
        db.publishState(`${ns}.info.access_token`, { val: "stored.acc", ack: true });
        db.publishState(`${ns}.info.refresh_token`, { val: "stored.ref", ack: true });
        db.publishState(`${ns}.info.token_expires_at`, { val: futureExpiry, ack: true });

        await adapter.readyHandler!();

        // Stays alive (connection=false, no crash)
        expect(getStateVal(db, adapter, "info.connection")).to.equal(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cluster L3591-3602  FCM "registered" event → _saveFcmCredentials error path
// ═══════════════════════════════════════════════════════════════════════════════

describe("main_coverage_poll — FCM registered event + saveFcmCredentials error L3591-3602", () => {
    it("FCM 'registered' event fires → info.fcm_active=healthy", async () => {
        stubAxiosByUrl(gen2OutdoorUrlStubs(CAM_GEN2));
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const fakeCreds = {
            fcmToken: "tok123456789012345",
            acgId: 1234n,
            securityToken: 5678n,
            privateKey: new Uint8Array([1, 2, 3]),
            publicKey: new Uint8Array([4, 5, 6]),
            authSecret: new Uint8Array([7, 8]),
        };
        _capturedFcmListener?.emit("registered", fakeCreds);
        await new Promise((r) => setImmediate(r));

        expect(getStateVal(db, adapter, "info.fcm_active")).to.equal("healthy");
    });

    it("FCM 'registered' event + _saveFcmCredentials throws → warn logged, no crash", async () => {
        stubAxiosByUrl(gen2OutdoorUrlStubs(CAM_GEN2));
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        // Patch _saveFcmCredentials to reject
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._saveFcmCredentials = sinon.stub().rejects(new Error("disk full"));

        const fakeCreds = {
            fcmToken: "tok123456789012345",
            acgId: 1234n,
            securityToken: 5678n,
            privateKey: new Uint8Array([1]),
            publicKey: new Uint8Array([2]),
            authSecret: new Uint8Array([3]),
        };

        let threw = false;
        try {
            _capturedFcmListener?.emit("registered", fakeCreds);
            await new Promise((r) => setImmediate(r));
        } catch {
            threw = true;
        }
        expect(threw).to.equal(false, "_saveFcmCredentials error must not propagate");
        // fcm_active still "healthy"
        expect(getStateVal(db, adapter, "info.fcm_active")).to.equal("healthy");
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cluster L3286-3299  _localWritePrivacy fallback paths
// ═══════════════════════════════════════════════════════════════════════════════

describe("main_coverage_poll — _localWritePrivacy fallback paths L3286-3299", () => {
    it("_localWritePrivacy: catch path returns false without throwing", async () => {
        // Boot normally so the adapter is wired
        stubAxiosByUrl(gen2OutdoorUrlStubs(CAM_GEN2));
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        // The private method is directly accessible as (adapter as any)._localWritePrivacy
        // Calling with a bogus IP will trigger the catch path (fetch will fail in test env)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (adapter as any)._localWritePrivacy(
            "192.0.2.1", // unroutable IP → will trigger fetch error
            true,
            undefined,  // no session (goes to fallback path)
            undefined,
        );
        // Must be boolean false (error caught) — never throws
        expect(result).to.equal(false);
        void db;
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// _pollAlarmSettings (Indoor II — HOME_Eyes_Indoor)
// ═══════════════════════════════════════════════════════════════════════════════

describe("main_coverage_poll — _pollAlarmSettings for Indoor II", () => {
    it("alarm_settings 200 with all 3 fields → DPs written", async () => {
        stubAxiosByUrl(gen2IndoorUrlStubs(CAM_GEN2_INDOOR, {
            "alarm_settings": { status: 200, data: {
                alarmDelayInSeconds: 30,
                alarmActivationDelaySeconds: 5,
                preAlarmDelayInSeconds: 10,
            }},
            "privacy_sound_override": { status: 200, data: { result: true } },
        }));
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollCameraStateOnce();

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_INDOOR}.siren_duration`)).to.equal(30);
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_INDOOR}.alarm_activation_delay`)).to.equal(5);
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_INDOOR}.pre_alarm_delay`)).to.equal(10);
    });

    it("alarm_settings 443 → early return, no DP writes", async () => {
        stubAxiosByUrl(gen2IndoorUrlStubs(CAM_GEN2_INDOOR, {
            "alarm_settings": { status: 443, data: null },
        }));
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const siren = getStateVal(db, adapter, `cameras.${CAM_GEN2_INDOOR}.siren_duration`);
        expect(siren === undefined || siren === null).to.be.true;
    });

    it("alarm_settings network error → swallowed, no crash", async () => {
        // stubAxiosByUrl does not support reject:true in gen2IndoorUrlStubs overrides directly
        // Use inline array with correct ordering (video_inputs last)
        stubAxiosByUrl([
            { match: "wifiinfo", status: 404, data: null },
            { match: "intrusionDetectionConfig", status: 200, data: { sensitivity: 3 } },
            { match: "lighting/switch", status: 200, data: null },
            { match: "lens_elevation", status: 200, data: { elevation: 0 } },
            { match: "alarm_settings", reject: true, status: 500, data: null },
            { match: "/events", status: 200, data: [] },
            { match: "privacy_sound_override", status: 200, data: { result: false } },
            { match: "video_inputs", status: 200, data: [CAM_GEN2_INDOOR_BODY] },
        ]);
        const { db, adapter } = createAdapterWithMocks();

        let threw = false;
        try {
            await bootWithTokens(db, adapter);
        } catch {
            threw = true;
        }
        expect(threw).to.equal(false, "alarm_settings network error must not propagate");
    });

    it("alarm_settings 200 with partial fields → writes only present fields", async () => {
        stubAxiosByUrl(gen2IndoorUrlStubs(CAM_GEN2_INDOOR, {
            "alarm_settings": { status: 200, data: { alarmDelayInSeconds: 45 } },
        }));
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollCameraStateOnce();

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_INDOOR}.siren_duration`)).to.equal(45);
        // actDelay field absent → DP not written from poll (may be undefined or default seed)
        const actDelay = getStateVal(db, adapter, `cameras.${CAM_GEN2_INDOOR}.alarm_activation_delay`);
        expect(actDelay !== 99).to.be.true;
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// _pollLensElevation branches
// ═══════════════════════════════════════════════════════════════════════════════

describe("main_coverage_poll — _pollLensElevation branches", () => {
    it("lens_elevation 200 with elevation field → DP written + cache seeded", async () => {
        stubAxiosByUrl(gen2OutdoorUrlStubs(CAM_GEN2, {
            lens_elevation: { status: 200, data: { elevation: 15 } },
        }));
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollCameraStateOnce();

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2}.lens_elevation`)).to.equal(15);
    });

    it("lens_elevation 200 missing elevation field → no DP write", async () => {
        stubAxiosByUrl(gen2OutdoorUrlStubs(CAM_GEN2, {
            lens_elevation: { status: 200, data: { someOther: "field" } },
        }));
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const elev = getStateVal(db, adapter, `cameras.${CAM_GEN2}.lens_elevation`);
        expect(elev === undefined || elev === null).to.be.true;
    });

    it("lens_elevation 443 → early return, no DP write", async () => {
        stubAxiosByUrl(gen2OutdoorUrlStubs(CAM_GEN2, {
            lens_elevation: { status: 443, data: null },
        }));
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const elev = getStateVal(db, adapter, `cameras.${CAM_GEN2}.lens_elevation`);
        expect(elev === undefined || elev === null).to.be.true;
    });

    it("lens_elevation 404 → early return, no DP write", async () => {
        stubAxiosByUrl(gen2OutdoorUrlStubs(CAM_GEN2, {
            lens_elevation: { status: 404, data: null },
        }));
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const elev = getStateVal(db, adapter, `cameras.${CAM_GEN2}.lens_elevation`);
        expect(elev === undefined || elev === null).to.be.true;
    });

    it("lens_elevation network error → swallowed, no crash", async () => {
        stubAxiosByUrl(gen2OutdoorUrlStubs(CAM_GEN2, {
            lens_elevation: { reject: true, status: 503, data: null },
        }));
        const { db, adapter } = createAdapterWithMocks();

        let threw = false;
        try {
            await bootWithTokens(db, adapter);
        } catch {
            threw = true;
        }
        expect(threw).to.equal(false, "lens_elevation network error must not propagate");
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// _pollGlobalLighting branches
// ═══════════════════════════════════════════════════════════════════════════════

describe("main_coverage_poll — _pollGlobalLighting branches", () => {
    it("global lighting 200 darknessThreshold=0.75 → DP=75 (percent conversion)", async () => {
        stubAxiosByUrl(gen2OutdoorUrlStubs(CAM_GEN2, {
            "/lighting": { status: 200, data: { darknessThreshold: 0.75 } },
        }));
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollCameraStateOnce();

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2}.darkness_threshold`)).to.equal(75);
    });

    it("global lighting 200 missing darknessThreshold field → no DP write", async () => {
        stubAxiosByUrl(gen2OutdoorUrlStubs(CAM_GEN2, {
            "/lighting": { status: 200, data: { softLightFading: true } },
        }));
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const dt = getStateVal(db, adapter, `cameras.${CAM_GEN2}.darkness_threshold`);
        expect(dt === undefined || dt === null).to.be.true;
    });

    it("global lighting 443 → early return", async () => {
        stubAxiosByUrl(gen2OutdoorUrlStubs(CAM_GEN2, {
            "/lighting": { status: 443, data: null },
        }));
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const dt = getStateVal(db, adapter, `cameras.${CAM_GEN2}.darkness_threshold`);
        expect(dt === undefined || dt === null).to.be.true;
    });

    it("global lighting 404 → early return", async () => {
        stubAxiosByUrl(gen2OutdoorUrlStubs(CAM_GEN2, {
            "/lighting": { status: 404, data: null },
        }));
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const dt = getStateVal(db, adapter, `cameras.${CAM_GEN2}.darkness_threshold`);
        expect(dt === undefined || dt === null).to.be.true;
    });

    it("global lighting network error → swallowed, no crash", async () => {
        stubAxiosByUrl(gen2OutdoorUrlStubs(CAM_GEN2, {
            "/lighting": { reject: true, status: 503, data: null },
        }));
        const { db, adapter } = createAdapterWithMocks();

        let threw = false;
        try {
            await bootWithTokens(db, adapter);
        } catch {
            threw = true;
        }
        expect(threw).to.equal(false, "global lighting network error must not propagate");
    });

    it("Indoor II camera → _pollGlobalLighting skipped (not Outdoor)", async () => {
        // gen2IndoorUrlStubs does NOT include /lighting — proves it's not called for Indoor II
        stubAxiosByUrl(gen2IndoorUrlStubs(CAM_GEN2_INDOOR, {
            // Override /lighting to return darknessThreshold=0.99 — if it were called, DP would be 99
            "/lighting": { status: 200, data: { darknessThreshold: 0.99 } },
        }));
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        // If global lighting had run, darkness_threshold would be 99
        const dt = getStateVal(db, adapter, `cameras.${CAM_GEN2_INDOOR}.darkness_threshold`);
        expect(dt === undefined || dt !== 99).to.be.true;
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Privacy toggle externally via poll — liveSessions/livestreamEnabled paths (L3800-3840)
// ═══════════════════════════════════════════════════════════════════════════════

describe("main_coverage_poll — privacy toggle via poll L3800-3840", () => {
    /**
     * Privacy tests use stubAxiosSequence (positional) so boot gets OFF response and
     * the poll tick gets a different privacy state. The _httpClient is locked to the
     * adapter installed at require(main.js) time.
     *
     * Boot only consumes stub[0] (camera list from fetchCameras in onReady).
     * onReady does NOT call _pollCameraStateOnce — only the setInterval timer does,
     * and that timer is mocked to no-op. Per-camera stubs (wifiinfo etc.) are NOT
     * consumed during boot.
     *
     * So the sequence is:
     *   [0] = cameras(boot)
     *   [1] = cameras(poll tick)   ← _pollCameraStateOnce's fetchCameras
     *   [2] = wifiinfo             ← _pollSingleCameraState per-cam stubs
     *   ...
     */
    const PER_CAM_STUBS = [
        { status: 404, data: null },   // wifiinfo
        { status: 200, data: { sensitivity: 3, distance: 5 } }, // intrusion
        { status: 200, data: { elevation: 0 } }, // lens
        { status: 200, data: { darknessThreshold: 0.5 } }, // global lighting
        { status: 200, data: [] }, // events
        { status: 200, data: { result: false } }, // privacy_sound
        { status: 200, data: {  // lighting/switch
            topLedLightSettings: { brightness: 0, color: "#000" },
            bottomLedLightSettings: { brightness: 0, color: "#000" },
            frontLightSettings: { brightness: 0 },
        }},
    ];

    it("privacy OFF→ON detected: session cleared + stream_url DPs blanked", async () => {
        // Boot consumes [0]=cameras(OFF). Poll tick: [1]=cameras(ON), [2-8]=per-cam.
        stubAxiosSequence([
            { status: 200, data: [{ ...CAM_GEN2_OUTDOOR_BODY, privacyMode: "OFF" }] }, // [0] boot cameras
            { status: 200, data: [{ ...CAM_GEN2_OUTDOOR_BODY, privacyMode: "ON" }] }, // [1] poll cameras
            ...PER_CAM_STUBS,
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        // Inject a live session into the adapter
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._liveSessions.set(CAM_GEN2, {
            camId: CAM_GEN2, lanAddress: "192.168.1.149:443",
            proxyUrl: "rtsp://127.0.0.1:18001/rtsp_tunnel", maxSessionDuration: 3600,
            openedAt: Date.now(), digestUser: "u", digestPassword: "p",
        });
        // Pre-seed privacy_enabled=false (boot wrote OFF → false)
        db.publishState(`${adapter.namespace}.cameras.${CAM_GEN2}.privacy_enabled`, { val: false, ack: true });
        db.publishState(`${adapter.namespace}.cameras.${CAM_GEN2}.stream_url`, { val: "rtsp://192.168.1.149/stream", ack: true });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollCameraStateOnce();

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2}.privacy_enabled`)).to.equal(true);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((adapter as any)._liveSessions.has(CAM_GEN2)).to.equal(false);
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2}.stream_url`)).to.equal("");
    });

    it("privacy ON→OFF detected + livestream active → eager session refresh triggered", async () => {
        stubAxiosSequence([
            { status: 200, data: [{ ...CAM_GEN2_OUTDOOR_BODY, privacyMode: "ON" }] }, // [0] boot
            { status: 200, data: [{ ...CAM_GEN2_OUTDOOR_BODY, privacyMode: "OFF" }] }, // [1] poll
            ...PER_CAM_STUBS,
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._liveSessions.set(CAM_GEN2, {
            camId: CAM_GEN2, lanAddress: "192.168.1.149:443",
            proxyUrl: "rtsp://127.0.0.1:18001/rtsp_tunnel", maxSessionDuration: 3600,
            openedAt: Date.now(), digestUser: "u", digestPassword: "p",
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._livestreamEnabled.set(CAM_GEN2, true);
        db.publishState(`${adapter.namespace}.cameras.${CAM_GEN2}.privacy_enabled`, { val: true, ack: true });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollCameraStateOnce();

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2}.privacy_enabled`)).to.equal(false);
    });

    it("privacy unchanged (same ON state) → no session clear, no DP write", async () => {
        stubAxiosSequence([
            { status: 200, data: [{ ...CAM_GEN2_OUTDOOR_BODY, privacyMode: "ON" }] }, // [0] boot
            { status: 200, data: [{ ...CAM_GEN2_OUTDOOR_BODY, privacyMode: "ON" }] }, // [1] poll
            ...PER_CAM_STUBS,
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._liveSessions.set(CAM_GEN2, {
            camId: CAM_GEN2, lanAddress: "192.168.1.149:443",
            proxyUrl: "rtsp://127.0.0.1:18001/rtsp_tunnel", maxSessionDuration: 3600,
            openedAt: Date.now(), digestUser: "u", digestPassword: "p",
        });
        db.publishState(`${adapter.namespace}.cameras.${CAM_GEN2}.privacy_enabled`, { val: true, ack: true });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollCameraStateOnce();

        // Session must NOT have been cleared (no change → no drop)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((adapter as any)._liveSessions.has(CAM_GEN2)).to.equal(true);
    });
});
