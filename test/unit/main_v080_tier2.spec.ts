/**
 * v0.8.0 — Tier-2 gap-list features:
 *   - lens_elevation: Gen2 write → PUT /lens_elevation {elevation}; Gen1 ignored
 *   - darkness_threshold: Gen2 Outdoor write → PUT /lighting {darknessThreshold}; Indoor ignored; Gen1 ignored
 *   - siren_duration: Indoor II write → GET cache miss + PUT /alarm_settings full body; Outdoor ignored
 *   - alarm_activation_delay: Indoor II write → GET cache miss + PUT /alarm_settings; Outdoor ignored
 *   - pre_alarm_delay: Indoor II write → GET cache miss + PUT /alarm_settings; Outdoor ignored
 *   - DP existence: correct gating per hardwareVersion
 *   - _pollLensElevation: 200 seeds cache + DP; 404 no-op
 *   - _pollGlobalLighting: 200 seeds cache + DP (float→percent); 404 no-op
 *   - _pollAlarmSettings: 200 seeds cache + DPs; 404 no-op
 *
 * PIN_EVERY_MODE: one test per write path + gate test + poll test.
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

const CAM_GEN2_OUTDOOR = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";
const CAM_GEN2_INDOOR = "20E053B5-ABCD-1111-2222-333344445555";
const CAM_GEN1 = "AABBCCDD-1111-2222-3333-444455556666";

const CAMERAS_GEN2_OUTDOOR_ONLY = [
    {
        id: CAM_GEN2_OUTDOOR,
        title: "Terrasse",
        hardwareVersion: "HOME_Eyes_Outdoor",
        firmwareVersion: "9.40.25",
        featureSupport: { light: true },
    },
];

const CAMERAS_GEN2_INDOOR_ONLY = [
    {
        id: CAM_GEN2_INDOOR,
        title: "Innenbereich",
        hardwareVersion: "HOME_Eyes_Indoor",
        firmwareVersion: "9.40.25",
        featureSupport: { light: false },
    },
];

const CAMERAS_GEN1_ONLY = [
    {
        id: CAM_GEN1,
        title: "Indoor360",
        hardwareVersion: "CAMERA_360",
        firmwareVersion: "7.91.56",
        featureSupport: { light: false },
    },
];

const CAMERAS_OUTDOOR_AND_INDOOR = [
    {
        id: CAM_GEN2_OUTDOOR,
        title: "Terrasse",
        hardwareVersion: "HOME_Eyes_Outdoor",
        firmwareVersion: "9.40.25",
        featureSupport: { light: true },
    },
    {
        id: CAM_GEN2_INDOOR,
        title: "Innenbereich",
        hardwareVersion: "HOME_Eyes_Indoor",
        firmwareVersion: "9.40.25",
        featureSupport: { light: false },
    },
];

function resolveBuildModule(name: string): string {
    return path.join(REPO_ROOT, "build", "lib", `${name}.js`);
}

function createAdapterWithMocks(_cameras: unknown[]): { db: MockDatabase; adapter: TestAdapter } {
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
        id: snapshotPath, filename: snapshotPath, loaded: true, parent: module,
        children: [], path: path.dirname(snapshotPath), paths: [],
        exports: {
            fetchSnapshot: sinon.stub().resolves(Buffer.from("FAKEJPEG")),
            buildSnapshotUrl: (u: string) => `${u}/snap.jpg`,
        },
    };

    // live_session mock
    const fakeSession = {
        camId: CAM_GEN2_OUTDOOR,
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
        id: liveSessionPath, filename: liveSessionPath, loaded: true, parent: module,
        children: [], path: path.dirname(liveSessionPath), paths: [],
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
        id: tlsProxyPath, filename: tlsProxyPath, loaded: true, parent: module,
        children: [], path: path.dirname(tlsProxyPath), paths: [],
        exports: {
            startTlsProxy: sinon.stub().resolves({
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
        id: watchdogPath, filename: watchdogPath, loaded: true, parent: module,
        children: [], path: path.dirname(watchdogPath), paths: [],
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
    factory({ config: { redirect_url: "", region: "EU" } });

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
    db.publishState(`${adapter.namespace}.info.token_expires_at`, { val: futureExpiry, ack: true });
    await adapter.readyHandler!();
}

afterEach(() => {
    restoreAxios();
    sinon.restore();
    delete require.cache[resolveBuildModule("snapshot")];
    delete require.cache[resolveBuildModule("live_session")];
    delete require.cache[resolveBuildModule("tls_proxy")];
    delete require.cache[resolveBuildModule("session_watchdog")];
    delete require.cache[MAIN_JS_PATH];
});

// ── lens_elevation DP existence ─────────────────────────────────────────────

describe("v0.8.0 lens_elevation DP existence", () => {
    it("Gen2 Outdoor gets lens_elevation DP on boot", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN2_OUTDOOR_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_OUTDOOR_ONLY);
        await bootWithTokens(db, adapter);

        const obj = db.getObject(`${adapter.namespace}.cameras.${CAM_GEN2_OUTDOOR}.lens_elevation`);
        expect(obj).to.not.equal(undefined, "Gen2 Outdoor must have lens_elevation DP");
    });

    it("Gen2 Indoor gets lens_elevation DP on boot", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN2_INDOOR_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_INDOOR_ONLY);
        await bootWithTokens(db, adapter);

        const obj = db.getObject(`${adapter.namespace}.cameras.${CAM_GEN2_INDOOR}.lens_elevation`);
        expect(obj).to.not.equal(undefined, "Gen2 Indoor must have lens_elevation DP");
    });

    it("Gen1 does NOT get lens_elevation DP", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN1_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN1_ONLY);
        await bootWithTokens(db, adapter);

        const obj = db.getObject(`${adapter.namespace}.cameras.${CAM_GEN1}.lens_elevation`);
        expect(obj).to.equal(undefined, "Gen1 must NOT have lens_elevation DP");
    });
});

// ── lens_elevation write ─────────────────────────────────────────────────────

describe("v0.8.0 lens_elevation write", () => {
    it("Gen2: write 2.5 → PUT /lens_elevation {elevation: 2.5}, state acked", async () => {
        stubAxiosSequence([
            { status: 200, data: CAMERAS_GEN2_OUTDOOR_ONLY }, // boot cameras
            { status: 204, data: null }, // PUT /lens_elevation
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_OUTDOOR_ONLY);
        await bootWithTokens(db, adapter);

        const leId = `${adapter.namespace}.cameras.${CAM_GEN2_OUTDOOR}.lens_elevation`;
        await adapter.stateChangeHandler!(leId, {
            val: 2.5, ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });

        const state = db.getState(leId) as ioBroker.State | null;
        expect(state?.val).to.equal(2.5);
        expect(state?.ack).to.equal(true);
    });

    it("Gen1: write ignored — not acked", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN1_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN1_ONLY);
        await bootWithTokens(db, adapter);

        const leId = `${adapter.namespace}.cameras.${CAM_GEN1}.lens_elevation`;
        await adapter.stateChangeHandler!(leId, {
            val: 2.0, ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });

        const state = db.getState(leId) as ioBroker.State | null;
        expect(state?.ack === true).to.equal(false, "Gen1 lens_elevation must not be acked");
    });
});

// ── _pollLensElevation ────────────────────────────────────────────────────────

describe("v0.8.0 _pollLensElevation", () => {
    it("200 response seeds cache and mirrors DP", async () => {
        stubAxiosSequence([
            { status: 200, data: CAMERAS_GEN2_OUTDOOR_ONLY }, // boot cameras fetch
            { status: 200, data: { elevation: 3.0 } }, // _pollLensElevation
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_OUTDOOR_ONLY);
        await bootWithTokens(db, adapter);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollLensElevation("stored.acc", CAM_GEN2_OUTDOOR);

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_OUTDOOR}.lens_elevation`)).to.equal(3.0);
    });

    it("404 response: no-op, DP unchanged", async () => {
        stubAxiosSequence([
            { status: 200, data: CAMERAS_GEN2_OUTDOOR_ONLY },
            { status: 404, data: null },
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_OUTDOOR_ONLY);
        await bootWithTokens(db, adapter);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollLensElevation("stored.acc", CAM_GEN2_OUTDOOR);

        const state = db.getState(
            `${adapter.namespace}.cameras.${CAM_GEN2_OUTDOOR}.lens_elevation`,
        ) as ioBroker.State | null;
        // DP exists (created in ensureCameraObjects) but poll 404 must not write a value
        expect(state?.val === undefined || state?.val === 2.0).to.equal(
            true,
            "404 poll must not overwrite default",
        );
    });
});

// ── darkness_threshold DP existence ─────────────────────────────────────────

describe("v0.8.0 darkness_threshold DP existence", () => {
    it("Gen2 Outdoor gets darkness_threshold DP", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN2_OUTDOOR_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_OUTDOOR_ONLY);
        await bootWithTokens(db, adapter);

        const obj = db.getObject(`${adapter.namespace}.cameras.${CAM_GEN2_OUTDOOR}.darkness_threshold`);
        expect(obj).to.not.equal(undefined, "Gen2 Outdoor must have darkness_threshold DP");
    });

    it("Gen2 Indoor does NOT get darkness_threshold DP", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN2_INDOOR_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_INDOOR_ONLY);
        await bootWithTokens(db, adapter);

        const obj = db.getObject(`${adapter.namespace}.cameras.${CAM_GEN2_INDOOR}.darkness_threshold`);
        expect(obj).to.equal(undefined, "Gen2 Indoor must NOT have darkness_threshold DP");
    });

    it("Gen1 does NOT get darkness_threshold DP", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN1_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN1_ONLY);
        await bootWithTokens(db, adapter);

        const obj = db.getObject(`${adapter.namespace}.cameras.${CAM_GEN1}.darkness_threshold`);
        expect(obj).to.equal(undefined, "Gen1 must NOT have darkness_threshold DP");
    });
});

// ── darkness_threshold write ──────────────────────────────────────────────────

describe("v0.8.0 darkness_threshold write", () => {
    it("Gen2 Outdoor: write 47 → PUT /lighting {darknessThreshold: 0.47, ...}, state acked", async () => {
        stubAxiosSequence([
            { status: 200, data: CAMERAS_GEN2_OUTDOOR_ONLY }, // boot cameras
            { status: 204, data: null }, // PUT /lighting
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_OUTDOOR_ONLY);
        await bootWithTokens(db, adapter);

        const dtId = `${adapter.namespace}.cameras.${CAM_GEN2_OUTDOOR}.darkness_threshold`;
        await adapter.stateChangeHandler!(dtId, {
            val: 47, ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });

        const state = db.getState(dtId) as ioBroker.State | null;
        expect(state?.val).to.equal(47);
        expect(state?.ack).to.equal(true);
    });

    it("Gen2 Indoor: write ignored — not acked", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN2_INDOOR_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_INDOOR_ONLY);
        await bootWithTokens(db, adapter);

        const dtId = `${adapter.namespace}.cameras.${CAM_GEN2_INDOOR}.darkness_threshold`;
        await adapter.stateChangeHandler!(dtId, {
            val: 50, ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });

        const state = db.getState(dtId) as ioBroker.State | null;
        expect(state?.ack === true).to.equal(false, "Gen2 Indoor darkness_threshold must not be acked");
    });

    it("Gen1: write ignored — not acked", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN1_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN1_ONLY);
        await bootWithTokens(db, adapter);

        const dtId = `${adapter.namespace}.cameras.${CAM_GEN1}.darkness_threshold`;
        await adapter.stateChangeHandler!(dtId, {
            val: 50, ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });

        const state = db.getState(dtId) as ioBroker.State | null;
        expect(state?.ack === true).to.equal(false, "Gen1 darkness_threshold must not be acked");
    });
});

// ── _pollGlobalLighting ────────────────────────────────────────────────────────

describe("v0.8.0 _pollGlobalLighting", () => {
    it("200 response: darknessThreshold 0.47 → DP = 47%", async () => {
        stubAxiosSequence([
            { status: 200, data: CAMERAS_GEN2_OUTDOOR_ONLY },
            { status: 200, data: { darknessThreshold: 0.47, softLightFading: true } },
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_OUTDOOR_ONLY);
        await bootWithTokens(db, adapter);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollGlobalLighting("stored.acc", CAM_GEN2_OUTDOOR);

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_OUTDOOR}.darkness_threshold`)).to.equal(47);
    });

    it("404 response: no-op", async () => {
        stubAxiosSequence([
            { status: 200, data: CAMERAS_GEN2_OUTDOOR_ONLY },
            { status: 404, data: null },
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_OUTDOOR_ONLY);
        await bootWithTokens(db, adapter);

        // Must not throw
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollGlobalLighting("stored.acc", CAM_GEN2_OUTDOOR);

        const state = db.getState(
            `${adapter.namespace}.cameras.${CAM_GEN2_OUTDOOR}.darkness_threshold`,
        ) as ioBroker.State | null;
        // Default value set in DP creation (50) or undefined — not overwritten
        expect(state?.val === undefined || state?.val === 50).to.equal(true);
    });
});

// ── alarm settings DP existence ─────────────────────────────────────────────

describe("v0.8.0 alarm settings DP existence", () => {
    it("Gen2 Indoor gets siren_duration, alarm_activation_delay, pre_alarm_delay DPs", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN2_INDOOR_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_INDOOR_ONLY);
        await bootWithTokens(db, adapter);

        for (const dp of ["siren_duration", "alarm_activation_delay", "pre_alarm_delay"]) {
            const obj = db.getObject(`${adapter.namespace}.cameras.${CAM_GEN2_INDOOR}.${dp}`);
            expect(obj).to.not.equal(undefined, `Gen2 Indoor must have ${dp} DP`);
        }
    });

    it("Gen2 Outdoor does NOT get alarm settings DPs", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN2_OUTDOOR_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_OUTDOOR_ONLY);
        await bootWithTokens(db, adapter);

        for (const dp of ["siren_duration", "alarm_activation_delay", "pre_alarm_delay"]) {
            const obj = db.getObject(`${adapter.namespace}.cameras.${CAM_GEN2_OUTDOOR}.${dp}`);
            expect(obj).to.equal(undefined, `Gen2 Outdoor must NOT have ${dp} DP`);
        }
    });

    it("Gen1 does NOT get alarm settings DPs", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN1_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN1_ONLY);
        await bootWithTokens(db, adapter);

        for (const dp of ["siren_duration", "alarm_activation_delay", "pre_alarm_delay"]) {
            const obj = db.getObject(`${adapter.namespace}.cameras.${CAM_GEN1}.${dp}`);
            expect(obj).to.equal(undefined, `Gen1 must NOT have ${dp} DP`);
        }
    });
});

// ── siren_duration write ──────────────────────────────────────────────────────

describe("v0.8.0 siren_duration write", () => {
    it("Indoor II: write 90 → GET cache miss + PUT /alarm_settings, state acked", async () => {
        stubAxiosSequence([
            { status: 200, data: CAMERAS_GEN2_INDOOR_ONLY }, // boot cameras
            {
                status: 200,
                data: { alarmDelayInSeconds: 60, alarmActivationDelaySeconds: 30, preAlarmDelayInSeconds: 30 },
            }, // GET /alarm_settings (cache miss)
            { status: 204, data: null }, // PUT /alarm_settings
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_INDOOR_ONLY);
        await bootWithTokens(db, adapter);

        const sdId = `${adapter.namespace}.cameras.${CAM_GEN2_INDOOR}.siren_duration`;
        await adapter.stateChangeHandler!(sdId, {
            val: 90, ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });

        const state = db.getState(sdId) as ioBroker.State | null;
        expect(state?.val).to.equal(90);
        expect(state?.ack).to.equal(true);
    });

    it("Gen2 Outdoor: write ignored — not acked", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN2_OUTDOOR_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_OUTDOOR_ONLY);
        await bootWithTokens(db, adapter);

        const sdId = `${adapter.namespace}.cameras.${CAM_GEN2_OUTDOOR}.siren_duration`;
        await adapter.stateChangeHandler!(sdId, {
            val: 90, ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });

        const state = db.getState(sdId) as ioBroker.State | null;
        expect(state?.ack === true).to.equal(false, "Gen2 Outdoor siren_duration must not be acked");
    });
});

// ── alarm_activation_delay write ─────────────────────────────────────────────

describe("v0.8.0 alarm_activation_delay write", () => {
    it("Indoor II: write 45 → cache miss GET + PUT, state acked", async () => {
        stubAxiosSequence([
            { status: 200, data: CAMERAS_GEN2_INDOOR_ONLY },
            {
                status: 200,
                data: { alarmDelayInSeconds: 60, alarmActivationDelaySeconds: 30, preAlarmDelayInSeconds: 30 },
            },
            { status: 204, data: null },
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_INDOOR_ONLY);
        await bootWithTokens(db, adapter);

        const aadId = `${adapter.namespace}.cameras.${CAM_GEN2_INDOOR}.alarm_activation_delay`;
        await adapter.stateChangeHandler!(aadId, {
            val: 45, ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });

        const state = db.getState(aadId) as ioBroker.State | null;
        expect(state?.val).to.equal(45);
        expect(state?.ack).to.equal(true);
    });

    it("Gen2 Outdoor: write ignored — not acked", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN2_OUTDOOR_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_OUTDOOR_ONLY);
        await bootWithTokens(db, adapter);

        const aadId = `${adapter.namespace}.cameras.${CAM_GEN2_OUTDOOR}.alarm_activation_delay`;
        await adapter.stateChangeHandler!(aadId, {
            val: 45, ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });

        const state = db.getState(aadId) as ioBroker.State | null;
        expect(state?.ack === true).to.equal(false, "Gen2 Outdoor alarm_activation_delay must not be acked");
    });
});

// ── pre_alarm_delay write ──────────────────────────────────────────────────────

describe("v0.8.0 pre_alarm_delay write", () => {
    it("Indoor II: write 20 → cache miss GET + PUT, state acked", async () => {
        stubAxiosSequence([
            { status: 200, data: CAMERAS_GEN2_INDOOR_ONLY },
            {
                status: 200,
                data: { alarmDelayInSeconds: 60, alarmActivationDelaySeconds: 30, preAlarmDelayInSeconds: 30 },
            },
            { status: 204, data: null },
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_INDOOR_ONLY);
        await bootWithTokens(db, adapter);

        const padId = `${adapter.namespace}.cameras.${CAM_GEN2_INDOOR}.pre_alarm_delay`;
        await adapter.stateChangeHandler!(padId, {
            val: 20, ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });

        const state = db.getState(padId) as ioBroker.State | null;
        expect(state?.val).to.equal(20);
        expect(state?.ack).to.equal(true);
    });

    it("Gen2 Outdoor: write ignored — not acked", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN2_OUTDOOR_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_OUTDOOR_ONLY);
        await bootWithTokens(db, adapter);

        const padId = `${adapter.namespace}.cameras.${CAM_GEN2_OUTDOOR}.pre_alarm_delay`;
        await adapter.stateChangeHandler!(padId, {
            val: 20, ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });

        const state = db.getState(padId) as ioBroker.State | null;
        expect(state?.ack === true).to.equal(false, "Gen2 Outdoor pre_alarm_delay must not be acked");
    });
});

// ── _pollAlarmSettings ─────────────────────────────────────────────────────────

describe("v0.8.0 _pollAlarmSettings", () => {
    it("200 response seeds cache and mirrors DPs", async () => {
        const alarmPayload = {
            alarmDelayInSeconds: 75,
            alarmActivationDelaySeconds: 10,
            preAlarmDelayInSeconds: 35,
        };
        stubAxiosSequence([
            { status: 200, data: CAMERAS_GEN2_INDOOR_ONLY },
            { status: 200, data: alarmPayload },
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_INDOOR_ONLY);
        await bootWithTokens(db, adapter);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollAlarmSettings("stored.acc", CAM_GEN2_INDOOR);

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_INDOOR}.siren_duration`)).to.equal(75);
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_INDOOR}.alarm_activation_delay`)).to.equal(10);
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_INDOOR}.pre_alarm_delay`)).to.equal(35);
    });

    it("404 response: no-op — no error thrown", async () => {
        stubAxiosSequence([
            { status: 200, data: CAMERAS_GEN2_INDOOR_ONLY },
            { status: 404, data: null },
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_INDOOR_ONLY);
        await bootWithTokens(db, adapter);

        // Must not throw
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollAlarmSettings("stored.acc", CAM_GEN2_INDOOR);
        void db; // no assertion needed — test passes if no throw
    });
});

// ── mixed: both Gen2 cameras correct DP gating ───────────────────────────────

describe("v0.8.0 mixed Gen2 Outdoor + Indoor DP gating", () => {
    it("Outdoor gets darkness_threshold, Indoor does not", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_OUTDOOR_AND_INDOOR }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_OUTDOOR_AND_INDOOR);
        await bootWithTokens(db, adapter);

        const outdoorDt = db.getObject(`${adapter.namespace}.cameras.${CAM_GEN2_OUTDOOR}.darkness_threshold`);
        const indoorDt = db.getObject(`${adapter.namespace}.cameras.${CAM_GEN2_INDOOR}.darkness_threshold`);
        expect(outdoorDt).to.not.equal(undefined, "Outdoor must have darkness_threshold");
        expect(indoorDt).to.equal(undefined, "Indoor must NOT have darkness_threshold");
    });

    it("Indoor gets alarm DPs, Outdoor does not", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_OUTDOOR_AND_INDOOR }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_OUTDOOR_AND_INDOOR);
        await bootWithTokens(db, adapter);

        const indoorSd = db.getObject(`${adapter.namespace}.cameras.${CAM_GEN2_INDOOR}.siren_duration`);
        const outdoorSd = db.getObject(`${adapter.namespace}.cameras.${CAM_GEN2_OUTDOOR}.siren_duration`);
        expect(indoorSd).to.not.equal(undefined, "Indoor must have siren_duration");
        expect(outdoorSd).to.equal(undefined, "Outdoor must NOT have siren_duration");
    });

    it("Both cameras get lens_elevation DP", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_OUTDOOR_AND_INDOOR }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_OUTDOOR_AND_INDOOR);
        await bootWithTokens(db, adapter);

        const outdoorLe = db.getObject(`${adapter.namespace}.cameras.${CAM_GEN2_OUTDOOR}.lens_elevation`);
        const indoorLe = db.getObject(`${adapter.namespace}.cameras.${CAM_GEN2_INDOOR}.lens_elevation`);
        expect(outdoorLe).to.not.equal(undefined, "Outdoor must have lens_elevation");
        expect(indoorLe).to.not.equal(undefined, "Indoor must have lens_elevation");
    });
});
