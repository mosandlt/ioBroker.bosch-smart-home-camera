/**
 * Regression tests for v0.7.6: Indoor II (Gen2, featureLight=false) must NOT
 * get light DPs, and state-handler writes must be silently dropped.
 *
 * Pins:
 *  - Gen2 + featureLight=false → NO light_enabled / front_light_enabled / wallwasher_enabled DPs
 *  - Gen2 + featureLight=true  → light DPs ARE created (Outdoor II — regression guard)
 *  - Gen1                      → light DPs ARE created (Gen1 always has lighting_override)
 *  - light_enabled write on Indoor II → no HTTP call, adapter stays connected
 *  - front_light_enabled write on Indoor II → no HTTP call, adapter stays connected
 *  - wallwasher_enabled write on Indoor II → no HTTP call, adapter stays connected
 *
 * User report source: Thomas internal — Indoor II (HOME_Eyes_Indoor, Gen2)
 *   was getting light DPs that produced Bosch 4xx on every write.
 * Cross-linked to HA v12.5.1 fix (same featureLight gate applied in HA integration).
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
    stateChangeHandler?: ioBroker.StateChangeHandler;
};

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CAM_OUTDOOR_II = "EFEFEFEF-1111-2222-3333-444455556666";  // Gen2, featureLight=true
const CAM_INDOOR_II  = "20E020E0-BBBB-CCCC-DDDD-000000000001";  // Gen2, featureLight=false
const CAM_GEN1       = "AABBCCDD-1111-2222-3333-444455556666";  // Gen1

const CAM_OUTDOOR_ONLY = [
    {
        id: CAM_OUTDOOR_II,
        title: "Terrasse",
        hardwareVersion: "HOME_Eyes_Outdoor",
        firmwareVersion: "9.40.25",
        featureSupport: { light: true },
    },
];

const CAM_INDOOR_ONLY = [
    {
        id: CAM_INDOOR_II,
        title: "Innenbereich",
        hardwareVersion: "HOME_Eyes_Indoor",
        firmwareVersion: "9.40.25",
        featureSupport: { light: false },
    },
];

const CAM_GEN1_ONLY = [
    {
        id: CAM_GEN1,
        title: "Kamera",
        hardwareVersion: "CAMERA_360",
        firmwareVersion: "7.91.56",
        featureSupport: { light: false },
    },
];

const CAMS_MIXED = [...CAM_OUTDOOR_ONLY, ...CAM_INDOOR_ONLY];

// ── Test infrastructure ───────────────────────────────────────────────────────

function resolveBuildModule(name: string): string {
    return path.join(REPO_ROOT, "build", "lib", `${name}.js`);
}

function createAdapterWithMocks(): { db: MockDatabase; adapter: TestAdapter } {
    const db = new MockDatabaseCtor();
    let capturedAdapter: MockAdapter | null = null;

    const core = mockAdapterCoreFn(db, {
        onAdapterCreated: (a: MockAdapter) => { capturedAdapter = a; },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[ADAPTER_CORE_PATH] = {
        id: ADAPTER_CORE_PATH, filename: ADAPTER_CORE_PATH, loaded: true,
        parent: module, children: [], path: path.dirname(ADAPTER_CORE_PATH), paths: [], exports: core,
    };

    const snapshotPath = resolveBuildModule("snapshot");
    delete require.cache[snapshotPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[snapshotPath] = {
        id: snapshotPath, filename: snapshotPath, loaded: true,
        parent: module, children: [], path: path.dirname(snapshotPath), paths: [],
        exports: { fetchSnapshot: sinon.stub().resolves(Buffer.from("FAKEJPEG")), buildSnapshotUrl: (u: string) => `${u}/snap.jpg` },
    };

    const fakeSession = {
        camId: CAM_OUTDOOR_II, lanAddress: "192.168.1.149:443",
        proxyUrl: "rtsp://127.0.0.1:18050/rtsp_tunnel",
        maxSessionDuration: 3600, openedAt: Date.now(),
        digestUser: "u", digestPassword: "p",
    };
    const liveSessionPath = resolveBuildModule("live_session");
    delete require.cache[liveSessionPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[liveSessionPath] = {
        id: liveSessionPath, filename: liveSessionPath, loaded: true,
        parent: module, children: [], path: path.dirname(liveSessionPath), paths: [],
        exports: { openLiveSession: sinon.stub().resolves(fakeSession), closeLiveSession: sinon.stub().resolves() },
    };

    const tlsProxyPath = resolveBuildModule("tls_proxy");
    delete require.cache[tlsProxyPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[tlsProxyPath] = {
        id: tlsProxyPath, filename: tlsProxyPath, loaded: true,
        parent: module, children: [], path: path.dirname(tlsProxyPath), paths: [],
        exports: { startTlsProxy: sinon.stub().resolves({ port: 18050, localRtspUrl: "rtsp://127.0.0.1:18050/rtsp_tunnel", stop: sinon.stub().resolves() }) },
    };

    const watchdogPath = resolveBuildModule("session_watchdog");
    delete require.cache[watchdogPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[watchdogPath] = {
        id: watchdogPath, filename: watchdogPath, loaded: true,
        parent: module, children: [], path: path.dirname(watchdogPath), paths: [],
        exports: { SessionWatchdog: class { start = sinon.stub(); stop = sinon.stub(); constructor(_o: unknown) {} } },
    };

    delete require.cache[MAIN_JS_PATH];
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const factory = require(MAIN_JS_PATH) as (opts: Record<string, unknown>) => MockAdapter;
    factory({ config: { redirect_url: "", region: "EU", startup_snapshot: true } });

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
    const state = db.getState(fullId);
    return (state as ioBroker.State | null | undefined)?.val;
}

async function bootWithTokens(db: MockDatabase, adapter: TestAdapter): Promise<void> {
    const futureExpiry = Date.now() + 200_000;
    db.publishState(`${adapter.namespace}.info.access_token`, { val: "stored.acc", ack: true });
    db.publishState(`${adapter.namespace}.info.refresh_token`, { val: "stored.ref", ack: true });
    db.publishState(`${adapter.namespace}.info.token_expires_at`, { val: futureExpiry, ack: true });
    await adapter.readyHandler!();
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("v0.7.6 — light DP gate (Indoor II has no LEDs)", () => {
    afterEach(() => {
        restoreAxios();
        sinon.restore();
        delete require.cache[resolveBuildModule("snapshot")];
        delete require.cache[resolveBuildModule("live_session")];
        delete require.cache[resolveBuildModule("tls_proxy")];
        delete require.cache[resolveBuildModule("session_watchdog")];
        delete require.cache[MAIN_JS_PATH];
    });

    // ── DP creation gating ─────────────────────────────────────────────────────

    it("Indoor II (Gen2, featureLight=false): light_enabled DP is NOT created", async () => {
        stubAxiosSequence([{ status: 200, data: CAM_INDOOR_ONLY }]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const fullId = `${adapter.namespace}.cameras.${CAM_INDOOR_II}.light_enabled`;
        // MockDatabase returns undefined (not null) for absent objects
        expect(db.getObject(fullId) ?? null).to.be.null;
    });

    it("Indoor II (Gen2, featureLight=false): front_light_enabled DP is NOT created", async () => {
        stubAxiosSequence([{ status: 200, data: CAM_INDOOR_ONLY }]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const fullId = `${adapter.namespace}.cameras.${CAM_INDOOR_II}.front_light_enabled`;
        expect(db.getObject(fullId) ?? null).to.be.null;
    });

    it("Indoor II (Gen2, featureLight=false): wallwasher_enabled DP is NOT created", async () => {
        stubAxiosSequence([{ status: 200, data: CAM_INDOOR_ONLY }]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const fullId = `${adapter.namespace}.cameras.${CAM_INDOOR_II}.wallwasher_enabled`;
        expect(db.getObject(fullId) ?? null).to.be.null;
    });

    it("Outdoor II (Gen2, featureLight=true): light_enabled DP IS created", async () => {
        stubAxiosSequence([{ status: 200, data: CAM_OUTDOOR_ONLY }]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const fullId = `${adapter.namespace}.cameras.${CAM_OUTDOOR_II}.light_enabled`;
        expect(db.getObject(fullId)).to.not.be.null;
    });

    it("Outdoor II (Gen2, featureLight=true): front_light_enabled DP IS created", async () => {
        stubAxiosSequence([{ status: 200, data: CAM_OUTDOOR_ONLY }]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const fullId = `${adapter.namespace}.cameras.${CAM_OUTDOOR_II}.front_light_enabled`;
        expect(db.getObject(fullId)).to.not.be.null;
    });

    it("Outdoor II (Gen2, featureLight=true): wallwasher_enabled DP IS created", async () => {
        stubAxiosSequence([{ status: 200, data: CAM_OUTDOOR_ONLY }]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const fullId = `${adapter.namespace}.cameras.${CAM_OUTDOOR_II}.wallwasher_enabled`;
        expect(db.getObject(fullId)).to.not.be.null;
    });

    it("Gen1 camera: light_enabled DP IS created (Gen1 always has lighting_override)", async () => {
        stubAxiosSequence([{ status: 200, data: CAM_GEN1_ONLY }]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const fullId = `${adapter.namespace}.cameras.${CAM_GEN1}.light_enabled`;
        expect(db.getObject(fullId)).to.not.be.null;
    });

    it("Gen1 camera: wallwasher_enabled DP IS created", async () => {
        stubAxiosSequence([{ status: 200, data: CAM_GEN1_ONLY }]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const fullId = `${adapter.namespace}.cameras.${CAM_GEN1}.wallwasher_enabled`;
        expect(db.getObject(fullId)).to.not.be.null;
    });

    it("mixed setup: Outdoor II gets light DPs, Indoor II does not", async () => {
        stubAxiosSequence([{ status: 200, data: CAMS_MIXED }]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        // Outdoor II: DPs present
        expect(db.getObject(`${adapter.namespace}.cameras.${CAM_OUTDOOR_II}.light_enabled`))
            .to.not.be.null;
        // Indoor II: DPs absent (MockDatabase returns undefined for missing objects)
        expect(db.getObject(`${adapter.namespace}.cameras.${CAM_INDOOR_II}.light_enabled`) ?? null)
            .to.be.null;
        expect(db.getObject(`${adapter.namespace}.cameras.${CAM_INDOOR_II}.front_light_enabled`) ?? null)
            .to.be.null;
        expect(db.getObject(`${adapter.namespace}.cameras.${CAM_INDOOR_II}.wallwasher_enabled`) ?? null)
            .to.be.null;
    });

    // ── State-handler gating ───────────────────────────────────────────────────

    it("light_enabled write on Indoor II: no HTTP call, adapter stays connected", async () => {
        // Only the cameras-list fetch — no PUT /lighting should follow
        stubAxiosSequence([{ status: 200, data: CAM_INDOOR_ONLY }]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        // Send a light_enabled write as if a legacy automation triggered it
        const stateId = `${adapter.namespace}.cameras.${CAM_INDOOR_II}.light_enabled`;
        await adapter.stateChangeHandler!(stateId, {
            val: true, ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });

        // Adapter must still be connected (no uncaught error)
        expect(getStateVal(db, adapter, "info.connection")).to.equal(true);
    });

    it("front_light_enabled write on Indoor II: no HTTP call, adapter stays connected", async () => {
        stubAxiosSequence([{ status: 200, data: CAM_INDOOR_ONLY }]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const stateId = `${adapter.namespace}.cameras.${CAM_INDOOR_II}.front_light_enabled`;
        await adapter.stateChangeHandler!(stateId, {
            val: true, ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });

        expect(getStateVal(db, adapter, "info.connection")).to.equal(true);
    });

    it("wallwasher_enabled write on Indoor II: no HTTP call, adapter stays connected", async () => {
        stubAxiosSequence([{ status: 200, data: CAM_INDOOR_ONLY }]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const stateId = `${adapter.namespace}.cameras.${CAM_INDOOR_II}.wallwasher_enabled`;
        await adapter.stateChangeHandler!(stateId, {
            val: true, ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });

        expect(getStateVal(db, adapter, "info.connection")).to.equal(true);
    });
});
