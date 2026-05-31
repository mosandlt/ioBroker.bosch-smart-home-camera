/**
 * v0.7.7 — Audio level, intrusion detection, WiFi info, motion-active window tests.
 *
 * Covers:
 *  - microphone_level: Gen2 write → PUT /audio {microphoneLevel}; Gen1 ignored
 *  - speaker_level: Gen2 write → PUT /audio {speakerLevel}; Gen1 ignored
 *  - intrusion_sensitivity: Gen2 write → PUT /intrusionDetectionConfig {sensitivity}; Gen1 ignored
 *  - intrusion_distance: Gen2 write → PUT /intrusionDetectionConfig {detectionDistance}; Gen1 ignored
 *  - WiFi info: _pollSingleCameraState writes wifi DPs from /wifiinfo (200); 404 = no-op
 *  - motion_active_window: adapter config option drives _motionActiveWindowMs getter
 *    (10–300 s valid; out-of-range → fallback 90 s)
 */

import { expect } from "chai";
import * as sinon from "sinon";
import * as path from "path";

import { stubAxiosSequence, restoreAxios } from "./helpers/axios-mock";

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

const CAM_GEN2 = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";
const CAM_GEN1 = "AABBCCDD-1111-2222-3333-444455556666";

const CAMERAS_GEN2_ONLY = [
    {
        id: CAM_GEN2,
        title: "Terrasse",
        hardwareVersion: "HOME_Eyes_Outdoor",
        firmwareVersion: "9.40.25",
        featureSupport: { light: true },
    },
];

const CAMERAS_BOTH = [
    {
        id: CAM_GEN1,
        title: "Indoor",
        hardwareVersion: "CAMERA_360",
        firmwareVersion: "7.91.56",
        featureSupport: { light: false },
    },
    {
        id: CAM_GEN2,
        title: "Terrasse",
        hardwareVersion: "HOME_Eyes_Outdoor",
        firmwareVersion: "9.40.25",
        featureSupport: { light: true },
    },
];

function resolveBuildModule(name: string): string {
    return path.join(REPO_ROOT, "build", "lib", `${name}.js`);
}

/**
 * Create adapter with standard lib mocks.
 * stubAxiosSequence MUST be called by the caller BEFORE calling this function.
 */
function createAdapterWithMocks(
    _cameras: unknown[],
    configOverrides: Record<string, unknown> = {},
): { db: MockDatabase; adapter: TestAdapter } {
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
    const fakeSession = {
        camId: CAM_GEN2,
        lanAddress: "192.168.1.149:443",
        proxyUrl: "rtsp://127.0.0.1:18010/rtsp_tunnel",
        maxSessionDuration: 3600,
        openedAt: Date.now(),
        digestUser: "u",
        digestPassword: "p",
    };
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
            openLiveSession: sinon.stub().resolves(fakeSession),
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
            startTlsProxy: sinon
                .stub()
                .resolves({
                    port: 18010,
                    localRtspUrl: "rtsp://127.0.0.1:18010/rtsp_tunnel",
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

function getStateVal(db: MockDatabase, adapter: TestAdapter, id: string): unknown {
    const fullId = `${adapter.namespace}.${id}`;
    const state = db.getState(fullId) as ioBroker.State | null | undefined;
    return state?.val;
}

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

// ── Teardown ────────────────────────────────────────────────────────────────

afterEach(() => {
    restoreAxios();
    sinon.restore();
    delete require.cache[resolveBuildModule("snapshot")];
    delete require.cache[resolveBuildModule("live_session")];
    delete require.cache[resolveBuildModule("tls_proxy")];
    delete require.cache[resolveBuildModule("session_watchdog")];
    delete require.cache[MAIN_JS_PATH];
});

// ── microphone_level ────────────────────────────────────────────────────────
// Note: _pollSingleCameraState runs in the periodic timer (not during boot).
// For write tests the boot sequence only needs the cameras fetch response;
// stateChangeHandler calls then consume subsequent axios responses.

describe("v0.7.7 microphone_level", () => {
    it("Gen2: write 80 → PUT /audio {microphoneLevel:80}, state acked", async () => {
        stubAxiosSequence([
            { status: 200, data: CAMERAS_GEN2_ONLY }, // cameras fetch (boot)
            { status: 204, data: null }, // PUT /audio
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);

        const micId = `${adapter.namespace}.cameras.${CAM_GEN2}.microphone_level`;
        await adapter.stateChangeHandler!(micId, {
            val: 80,
            ack: false,
            ts: Date.now(),
            lc: Date.now(),
            from: "user",
        });

        const state = db.getState(micId) as ioBroker.State | null;
        expect(state?.val).to.equal(80);
        expect(state?.ack).to.equal(true);
        void db;
    });

    it("Gen1: write ignored — no PUT, state not acked", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BOTH }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_BOTH);
        await bootWithTokens(db, adapter);

        const micId = `${adapter.namespace}.cameras.${CAM_GEN1}.microphone_level`;
        await adapter.stateChangeHandler!(micId, {
            val: 60,
            ack: false,
            ts: Date.now(),
            lc: Date.now(),
            from: "user",
        });

        // State should NOT be acked
        const state = db.getState(micId) as ioBroker.State | null;
        expect(state?.ack === true).to.equal(false, "Gen1 microphone_level must not be acked");
    });
});

// ── speaker_level ───────────────────────────────────────────────────────────

describe("v0.7.7 speaker_level", () => {
    it("Gen2: write 40 → PUT /audio {speakerLevel:40}, state acked", async () => {
        stubAxiosSequence([
            { status: 200, data: CAMERAS_GEN2_ONLY },
            { status: 204, data: null }, // PUT /audio
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);

        const spkId = `${adapter.namespace}.cameras.${CAM_GEN2}.speaker_level`;
        await adapter.stateChangeHandler!(spkId, {
            val: 40,
            ack: false,
            ts: Date.now(),
            lc: Date.now(),
            from: "user",
        });

        const state = db.getState(spkId) as ioBroker.State | null;
        expect(state?.val).to.equal(40);
        expect(state?.ack).to.equal(true);
    });

    it("Gen1: write ignored — not acked", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BOTH }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_BOTH);
        await bootWithTokens(db, adapter);

        const spkId = `${adapter.namespace}.cameras.${CAM_GEN1}.speaker_level`;
        await adapter.stateChangeHandler!(spkId, {
            val: 70,
            ack: false,
            ts: Date.now(),
            lc: Date.now(),
            from: "user",
        });

        const state = db.getState(spkId) as ioBroker.State | null;
        expect(state?.ack === true).to.equal(false, "Gen1 speaker_level must not be acked");
    });
});

// ── intrusion_sensitivity ───────────────────────────────────────────────────

describe("v0.7.7 intrusion_sensitivity", () => {
    it("Gen2: write 5 → GET cache miss + PUT full body, state acked (v0.7.14)", async () => {
        // v0.7.14: Bosch rejects DELTA PUTs with HTTP 400 — handler now
        // GETs the full config (when cache is empty) then PUTs the
        // merged body. Pin sequence: boot cameras → GET intrusion config →
        // PUT full body → 204 success.
        stubAxiosSequence([
            { status: 200, data: CAMERAS_GEN2_ONLY }, // boot cameras
            {
                status: 200,
                data: {
                    enabled: true,
                    sensitivity: 3,
                    detectionMode: "ALL_MOTIONS",
                    distance: 5,
                },
            }, // GET /intrusionDetectionConfig (cache miss)
            { status: 204, data: null }, // PUT /intrusionDetectionConfig (full body)
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);

        const isId = `${adapter.namespace}.cameras.${CAM_GEN2}.intrusion_sensitivity`;
        await adapter.stateChangeHandler!(isId, {
            val: 5,
            ack: false,
            ts: Date.now(),
            lc: Date.now(),
            from: "user",
        });

        const state = db.getState(isId) as ioBroker.State | null;
        expect(state?.val).to.equal(5);
        expect(state?.ack).to.equal(true);
    });

    it("Gen2: out-of-range write (10) is acked CLAMPED to 7 (v1.0.5)", async () => {
        // Regression: the generic ack path wrote the raw state.val, so a write
        // of 10 acked 10 even though _handleIntrusionWrite clamps the PUT to 7.
        // The handler now clamps + acks the clamped value (mirrors distance).
        stubAxiosSequence([
            { status: 200, data: CAMERAS_GEN2_ONLY }, // boot cameras
            {
                status: 200,
                data: {
                    enabled: true,
                    sensitivity: 3,
                    detectionMode: "ALL_MOTIONS",
                    distance: 5,
                },
            }, // GET /intrusionDetectionConfig (cache miss)
            { status: 204, data: null }, // PUT /intrusionDetectionConfig (full body)
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);

        const isId = `${adapter.namespace}.cameras.${CAM_GEN2}.intrusion_sensitivity`;
        await adapter.stateChangeHandler!(isId, {
            val: 10,
            ack: false,
            ts: Date.now(),
            lc: Date.now(),
            from: "user",
        });

        const state = db.getState(isId) as ioBroker.State | null;
        expect(state?.val).to.equal(7, "out-of-range sensitivity must be acked clamped to 7");
        expect(state?.ack).to.equal(true);
    });

    it("Gen2: write rejected with HTTP 443 (privacy mode) → clear error (v0.7.14)", async () => {
        // v0.7.14 maps Bosch's 443 to "cam is in privacy mode, disable
        // privacy first" instead of bubbling up a generic axios error.
        stubAxiosSequence([
            { status: 200, data: CAMERAS_GEN2_ONLY },
            { status: 443, data: null }, // GET /intrusionDetectionConfig (privacy blocked)
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);

        const isId = `${adapter.namespace}.cameras.${CAM_GEN2}.intrusion_sensitivity`;
        await adapter.stateChangeHandler!(isId, {
            val: 5,
            ack: false,
            ts: Date.now(),
            lc: Date.now(),
            from: "user",
        });
        // Not acked — user write failed
        const state = db.getState(isId) as ioBroker.State | null;
        expect(state?.ack === true).to.equal(false, "443 must not ack user write");
    });

    it("Gen1: write ignored — not acked", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BOTH }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_BOTH);
        await bootWithTokens(db, adapter);

        const isId = `${adapter.namespace}.cameras.${CAM_GEN1}.intrusion_sensitivity`;
        await adapter.stateChangeHandler!(isId, {
            val: 4,
            ack: false,
            ts: Date.now(),
            lc: Date.now(),
            from: "user",
        });

        const state = db.getState(isId) as ioBroker.State | null;
        expect(state?.ack === true).to.equal(
            false,
            "Gen1 intrusion_sensitivity must not be acked",
        );
    });

    it("intrusion_sensitivity DP object created for Gen2 on boot", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN2_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);

        const obj = db.getObject(
            `${adapter.namespace}.cameras.${CAM_GEN2}.intrusion_sensitivity`,
        );
        expect(obj).to.not.equal(undefined, "intrusion_sensitivity DP must exist for Gen2");
    });
});

// ── intrusion_distance ──────────────────────────────────────────────────────

describe("v0.7.7 intrusion_distance", () => {
    it("Gen2: write 7 → GET cache miss + PUT full body (v0.7.14)", async () => {
        // v0.7.14: handler now PUTs full body including `distance` (was
        // `detectionDistance` pre-v0.7.14 — wrong field name caused 400).
        stubAxiosSequence([
            { status: 200, data: CAMERAS_GEN2_ONLY }, // boot cameras
            {
                status: 200,
                data: {
                    enabled: true,
                    sensitivity: 3,
                    detectionMode: "ALL_MOTIONS",
                    distance: 5,
                },
            }, // GET /intrusionDetectionConfig
            { status: 204, data: null }, // PUT /intrusionDetectionConfig (full body)
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);

        const idId = `${adapter.namespace}.cameras.${CAM_GEN2}.intrusion_distance`;
        await adapter.stateChangeHandler!(idId, {
            val: 7,
            ack: false,
            ts: Date.now(),
            lc: Date.now(),
            from: "user",
        });

        const state = db.getState(idId) as ioBroker.State | null;
        expect(state?.val).to.equal(7);
        expect(state?.ack).to.equal(true);
    });

    it("Gen1: write ignored — not acked", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BOTH }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_BOTH);
        await bootWithTokens(db, adapter);

        const idId = `${adapter.namespace}.cameras.${CAM_GEN1}.intrusion_distance`;
        await adapter.stateChangeHandler!(idId, {
            val: 3,
            ack: false,
            ts: Date.now(),
            lc: Date.now(),
            from: "user",
        });

        const state = db.getState(idId) as ioBroker.State | null;
        expect(state?.ack === true).to.equal(false, "Gen1 intrusion_distance must not be acked");
    });
});

// ── WiFi info DPs ───────────────────────────────────────────────────────────
//
// WiFi DPs are populated by _pollWifiInfo (called from _pollSingleCameraState).
// The poll timer never fires in unit tests. We test _pollWifiInfo directly
// by injecting its HTTP calls into the boot-time stub sequence and calling
// the private method after boot via (adapter as any)._pollWifiInfo().
// Note: _httpClient is created via axios.create() — it inherits the default
// adapter set at creation time. We therefore arm the stub BEFORE createAdapter
// and use the same single boot-stub for the wifiinfo call too.

describe("v0.7.7 WiFi info DPs (v0.7.14: field mapping fixed)", () => {
    it("wifiinfo 200: signalStrength (percent 0-100) → wifi_signal_pct DP (v0.7.14)", async () => {
        // v0.7.14: Bosch's wifiinfo response uses `signalStrength` as a
        // PERCENT 0-100 (verified live against Terrasse=86 + Innenbereich=
        // 100). Pre-v0.7.14 wrote it to wifi_signal_strength labelled
        // "dBm" and looked for the non-existent `signalStrengthPercentage`.
        const wifiPayload = {
            ssid: "MyHomeWiFi",
            signalStrength: 86, // PERCENT 0-100, not dBm
            ipAddress: "192.168.1.42",
            macAddress: "64-da-a0-33-14-af",
        };
        stubAxiosSequence([
            { status: 200, data: CAMERAS_GEN2_ONLY }, // boot cameras fetch
            { status: 200, data: wifiPayload }, // _pollWifiInfo GET /wifiinfo
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollWifiInfo("stored.acc", CAM_GEN2);

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2}.wifi_ssid`)).to.equal("MyHomeWiFi");
        // signalStrength=86 → wifi_signal_pct=86 (new mapping)
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2}.wifi_signal_pct`)).to.equal(86);
    });

    it("wifiinfo 404 (Ethernet cam): DPs stay at default — no error", async () => {
        // Boot: cameras + wifiinfo 404
        stubAxiosSequence([
            { status: 200, data: CAMERAS_GEN2_ONLY }, // boot cameras
            { status: 404, data: null }, // _pollWifiInfo → Ethernet (no-op)
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollWifiInfo("stored.acc", CAM_GEN2);

        // DP exists (created in ensureCameraObjects) but value not written (404 no-op)
        const ssidState = db.getState(
            `${adapter.namespace}.cameras.${CAM_GEN2}.wifi_ssid`,
        ) as ioBroker.State | null;
        const ssid = ssidState?.val;
        expect(ssid === undefined || ssid === "").to.equal(
            true,
            "wifi_ssid should be empty/default on 404",
        );
    });

    it("wifi_ssid DP object created for all cameras", async () => {
        // DP objects are created in ensureCameraObjects (called during boot)
        stubAxiosSequence([{ status: 200, data: CAMERAS_BOTH }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_BOTH);
        await bootWithTokens(db, adapter);

        // Both cameras should have wifi DPs (created in ensureCameraObjects)
        const gen1Obj = db.getObject(`${adapter.namespace}.cameras.${CAM_GEN1}.wifi_ssid`);
        const gen2Obj = db.getObject(`${adapter.namespace}.cameras.${CAM_GEN2}.wifi_ssid`);
        expect(gen1Obj).to.not.equal(undefined, "Gen1 must have wifi_ssid DP");
        expect(gen2Obj).to.not.equal(undefined, "Gen2 must have wifi_ssid DP");
    });
});

// ── motion_active_window config option ─────────────────────────────────────
// _motionActiveWindowMs is a getter — readable directly from adapter instance.

describe("v0.7.7 motion_active_window option", () => {
    it("valid config 120 s → _motionActiveWindowMs returns 120000", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN2_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY, {
            motion_active_window: 120,
        });
        await bootWithTokens(db, adapter);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ms = (adapter as any)._motionActiveWindowMs as number;
        expect(ms).to.equal(120_000);
        void db;
    });

    it("config 90 (default) → 90000 ms", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN2_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY, {
            motion_active_window: 90,
        });
        await bootWithTokens(db, adapter);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((adapter as any)._motionActiveWindowMs).to.equal(90_000);
        void db;
    });

    it("config undefined → fallback 90000 ms", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN2_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((adapter as any)._motionActiveWindowMs).to.equal(90_000);
        void db;
    });

    it("config 5 (below minimum) → fallback 90000 ms", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN2_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY, {
            motion_active_window: 5,
        });
        await bootWithTokens(db, adapter);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((adapter as any)._motionActiveWindowMs).to.equal(90_000);
        void db;
    });

    it("config 400 (above maximum) → fallback 90000 ms", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN2_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY, {
            motion_active_window: 400,
        });
        await bootWithTokens(db, adapter);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((adapter as any)._motionActiveWindowMs).to.equal(90_000);
        void db;
    });

    it("config 10 (minimum boundary) → 10000 ms", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN2_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY, {
            motion_active_window: 10,
        });
        await bootWithTokens(db, adapter);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((adapter as any)._motionActiveWindowMs).to.equal(10_000);
        void db;
    });

    it("config 300 (maximum boundary) → 300000 ms", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN2_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY, {
            motion_active_window: 300,
        });
        await bootWithTokens(db, adapter);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((adapter as any)._motionActiveWindowMs).to.equal(300_000);
        void db;
    });
});

// ── audio + intrusion DP existence for Gen2 ────────────────────────────────

describe("v0.7.7 DP existence", () => {
    it("Gen2 gets microphone_level, speaker_level, intrusion_sensitivity, intrusion_distance DPs", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN2_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);

        for (const dp of [
            "microphone_level",
            "speaker_level",
            "intrusion_sensitivity",
            "intrusion_distance",
        ]) {
            const obj = db.getObject(`${adapter.namespace}.cameras.${CAM_GEN2}.${dp}`);
            expect(obj).to.not.equal(undefined, `Gen2 must have ${dp} DP`);
        }
    });

    it("Gen1 does NOT get microphone_level, speaker_level, intrusion DPs", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BOTH }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_BOTH);
        await bootWithTokens(db, adapter);

        for (const dp of [
            "microphone_level",
            "speaker_level",
            "intrusion_sensitivity",
            "intrusion_distance",
        ]) {
            const obj = db.getObject(`${adapter.namespace}.cameras.${CAM_GEN1}.${dp}`);
            expect(obj).to.equal(undefined, `Gen1 must NOT have ${dp} DP`);
        }
    });
});
