/**
 * Coverage for src/main.ts L4400-5430
 *
 * Target clusters:
 *   L4401-4410  light_enabled auto-snapshot (gen2-no-light gate)
 *   L4546-4588  pan_position + pan_preset dispatch (via onStateChange)
 *   L4722-4731  onFcmEvent — writes last_motion_at / last_motion_event_type, calls _onMotionFired
 *   L5218-5230  _pollPrivacySoundOverride — 442/444/success/error arms
 *   L5300-5319  _pollAutofollow — 442/404/444/success/error arms
 *
 * Axis constraint (important):
 *   The adapter's _httpClient is created in the constructor and captures
 *   axios.defaults.adapter at CONSTRUCTION TIME — not at request time.
 *   Therefore the axios stub MUST be installed before createAdapterWithMocks()
 *   is called. Use stubAxiosByUrl (URL-routing) so boot calls (cameras list,
 *   per-camera pollers) and feature-specific calls (pan PUT, privacy_sound GET)
 *   can all coexist in one stub without ordering problems.
 *
 * warn stub caveat:
 *   MockAdapter pre-wraps log.warn as a sinon stub. sinon.spy() on an already-
 *   wrapped method throws "already stubbed". Instead we read the pre-existing
 *   stub's callArgs via (adapter.log.warn as sinon.SinonStub).args.
 */

import { expect } from "chai";
import * as sinon from "sinon";
import * as path from "path";
import { EventEmitter } from "events";

import { stubAxiosByUrl, restoreAxios } from "./helpers/axios-mock";

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

function resolveBuildModule(name: string): string {
    return path.join(REPO_ROOT, "build", "lib", `${name}.js`);
}

// ── Camera fixtures ────────────────────────────────────────────────────────────

const CAM_GEN2_ID = "0A0B0C0D-1111-2222-3333-444455556666";
const CAM_360_ID = "0E0F1011-1111-2222-3333-000000000001";

/** Gen2 outdoor with light hardware */
const CAM_GEN2_BODY = {
    id: CAM_GEN2_ID,
    title: "Terrasse",
    hardwareVersion: "HOME_Eyes_Outdoor",
    firmwareVersion: "9.40.25",
    featureSupport: { light: true },
};

/** Gen2 indoor WITHOUT light hardware */
const CAM_GEN2_NO_LIGHT_BODY = {
    id: CAM_GEN2_ID,
    title: "Innenbereich",
    hardwareVersion: "HOME_Eyes_Indoor",
    firmwareVersion: "9.40.25",
    featureSupport: { light: false },
};

/** Gen1 CAMERA_360 with panLimit */
const CAM_360_BODY = {
    id: CAM_360_ID,
    title: "Kamera",
    hardwareVersion: "CAMERA_360",
    firmwareVersion: "7.91.56",
    featureSupport: { panLimit: 120 },
};

// ── FakeFcmListener ────────────────────────────────────────────────────────────

class FakeFcmCbsRegistrationError extends Error {
    constructor() {
        super("CBS registration rejected (fake)");
        this.name = "FcmCbsRegistrationError";
    }
}

class FakeFcmListener extends EventEmitter {
    public start: sinon.SinonStub = sinon.stub().resolves(undefined);
    public stop: sinon.SinonStub = sinon.stub().resolves(undefined);
}

// ── Types ──────────────────────────────────────────────────────────────────────

type TestAdapter = MockAdapter & {
    readyHandler?: () => Promise<void>;
    unloadHandler?: (cb: () => void) => void;
    stateChangeHandler?: ioBroker.StateChangeHandler;
};

interface AdapterFixture {
    db: MockDatabase;
    adapter: TestAdapter;
    /** Returns the FcmListener after bootWithTokens() has constructed it. */
    getFcmListener: () => FakeFcmListener;
}

// ── Factory ────────────────────────────────────────────────────────────────────
// NOTE: stubAxiosByUrl / stubAxiosSequence must be called BEFORE this function —
// the adapter snapshots axios.defaults.adapter in the constructor.

function createAdapterWithMocks(
    configOverrides: Record<string, unknown> = {},
): AdapterFixture {
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

    // Capture the FcmListener the adapter constructs lazily (after tokens present)
    let capturedFcmListener: FakeFcmListener | null = null;
    const CapturingFcm = class extends FakeFcmListener {
        constructor(..._args: unknown[]) {
            super();
            capturedFcmListener = this;
        }
    };

    const FCM_PATH = resolveBuildModule("fcm");
    delete require.cache[FCM_PATH];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[FCM_PATH] = {
        id: FCM_PATH,
        filename: FCM_PATH,
        loaded: true,
        parent: module,
        children: [],
        path: path.dirname(FCM_PATH),
        paths: [],
        exports: {
            FcmListener: CapturingFcm,
            FcmCbsRegistrationError: FakeFcmCbsRegistrationError,
            CLOUD_API: "https://residential.cbs.boschsecurity.com",
            FCM_SENDER_ID: "000000000000",
        },
    };

    // snapshot mock
    const snapshotPath = resolveBuildModule("snapshot");
    delete require.cache[snapshotPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[snapshotPath] = {
        id: snapshotPath, filename: snapshotPath, loaded: true,
        parent: module, children: [], path: path.dirname(snapshotPath), paths: [],
        exports: {
            fetchSnapshot: sinon.stub().resolves(Buffer.from([0xff, 0xd8, 0xff])),
            buildSnapshotUrl: (u: string) => `${u}/snap.jpg`,
            SnapshotError: class extends Error {},
        },
    };

    // live_session mock
    const liveSessionPath = resolveBuildModule("live_session");
    delete require.cache[liveSessionPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[liveSessionPath] = {
        id: liveSessionPath, filename: liveSessionPath, loaded: true,
        parent: module, children: [], path: path.dirname(liveSessionPath), paths: [],
        exports: {
            openLiveSession: sinon.stub().resolves({
                camId: CAM_GEN2_ID, lanAddress: "192.168.1.149:443",
                proxyUrl: "rtsp://127.0.0.1:18010/rtsp_tunnel",
                maxSessionDuration: 3600, openedAt: Date.now(),
                digestUser: "u", digestPassword: "p",
            }),
            closeLiveSession: sinon.stub().resolves(),
            LiveSessionError: class extends Error {},
            CameraOfflineError: class extends Error {},
            SessionLimitError: class extends Error {},
        },
    };

    // tls_proxy mock
    const tlsProxyPath = resolveBuildModule("tls_proxy");
    delete require.cache[tlsProxyPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[tlsProxyPath] = {
        id: tlsProxyPath, filename: tlsProxyPath, loaded: true,
        parent: module, children: [], path: path.dirname(tlsProxyPath), paths: [],
        exports: {
            startTlsProxy: sinon.stub().resolves({
                port: 18010, localRtspUrl: "rtsp://127.0.0.1:18010/rtsp_tunnel",
                stop: sinon.stub().resolves(),
            }),
        },
    };

    // rcp mock (needed for Gen1 cameras)
    const rcpPath = resolveBuildModule("rcp");
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const realRcp = require(rcpPath) as Record<string, unknown>;
    delete require.cache[rcpPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[rcpPath] = {
        id: rcpPath, filename: rcpPath, loaded: true,
        parent: module, children: [], path: path.dirname(rcpPath), paths: [],
        exports: { ...realRcp, sendRcpCommand: sinon.stub().resolves({ payload: Buffer.alloc(0) }) },
    };

    // session_watchdog mock
    const watchdogPath = resolveBuildModule("session_watchdog");
    delete require.cache[watchdogPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[watchdogPath] = {
        id: watchdogPath, filename: watchdogPath, loaded: true,
        parent: module, children: [], path: path.dirname(watchdogPath), paths: [],
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
    factory({ config: { redirect_url: "", region: "EU", startup_snapshot: true, ...configOverrides } });

    if (!capturedAdapter) throw new Error("adapter not captured");
    const adapter = capturedAdapter as TestAdapter;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).setTimeout = (_fn: () => void, _ms: number) => ({ __mockTimer: true });
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

    const getFcmListener = (): FakeFcmListener => {
        if (!capturedFcmListener) throw new Error("FcmListener not constructed — call bootWithTokens() first");
        return capturedFcmListener;
    };

    return { db, adapter, getFcmListener };
}

function getStateVal(db: MockDatabase, adapter: TestAdapter, id: string): unknown {
    const fullId = `${adapter.namespace}.${id}`;
    const state = db.getState(fullId) as ioBroker.State | null | undefined;
    return state?.val;
}

/** Read warn calls from the MockAdapter's pre-existing warn stub. */
function getWarnCalls(adapter: TestAdapter): string[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const warnStub = (adapter as any).log?.warn;
    if (!warnStub || typeof warnStub.args === "undefined") return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (warnStub.args as unknown[][]).map((a) => String(a[0]));
}

/** Count of warn calls made AFTER the `baseline` index. */
function warnCallsSince(adapter: TestAdapter, baseline: number): string[] {
    return getWarnCalls(adapter).slice(baseline);
}

async function bootWithTokens(db: MockDatabase, adapter: TestAdapter): Promise<void> {
    const futureExpiry = Date.now() + 200_000;
    db.publishState(`${adapter.namespace}.info.access_token`, { val: "stored.acc", ack: true });
    db.publishState(`${adapter.namespace}.info.refresh_token`, { val: "stored.ref", ack: true });
    db.publishState(`${adapter.namespace}.info.token_expires_at`, { val: futureExpiry, ack: true });
    await adapter.readyHandler!();
}

// ── Teardown ───────────────────────────────────────────────────────────────────

afterEach(() => {
    restoreAxios();
    sinon.restore();
    delete require.cache[MAIN_JS_PATH];
    delete require.cache[resolveBuildModule("fcm")];
    delete require.cache[resolveBuildModule("snapshot")];
    delete require.cache[resolveBuildModule("live_session")];
    delete require.cache[resolveBuildModule("tls_proxy")];
    delete require.cache[resolveBuildModule("rcp")];
    delete require.cache[resolveBuildModule("session_watchdog")];
});

// ═══════════════════════════════════════════════════════════════════════════════
// onFcmEvent — L4722-4731
// ═══════════════════════════════════════════════════════════════════════════════

describe("main adapter — onFcmEvent (L4722-4731)", () => {

    it("FCM motion event: writes last_motion_at and last_motion_event_type", async () => {
        stubAxiosByUrl([
            { match: "video_inputs", method: "get", status: 200, data: [CAM_GEN2_BODY] },
        ]);
        const { db, adapter, getFcmListener } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        const fcmListener = getFcmListener();

        const ts = "2026-05-28T10:00:00.000Z";
        fcmListener.emit("motion", {
            cameraId: CAM_GEN2_ID,
            eventType: "motion",
            timestamp: ts,
            eventId: "evt-fcm-001",
        });

        await new Promise<void>((r) => setImmediate(r));
        await new Promise<void>((r) => setImmediate(r));

        const lastMotionAt = getStateVal(db, adapter, `cameras.${CAM_GEN2_ID}.last_motion_at`);
        expect(lastMotionAt, "last_motion_at should be written").to.be.a("string").and.to.have.length.greaterThan(0);
        expect(lastMotionAt as string).to.not.include("[");

        const eventType = getStateVal(db, adapter, `cameras.${CAM_GEN2_ID}.last_motion_event_type`);
        expect(eventType, "last_motion_event_type should be 'motion'").to.equal("motion");
    });

    it("FCM person event: writes last_motion_event_type=person", async () => {
        stubAxiosByUrl([
            { match: "video_inputs", method: "get", status: 200, data: [CAM_GEN2_BODY] },
        ]);
        const { db, adapter, getFcmListener } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        const fcmListener = getFcmListener();

        fcmListener.emit("person", {
            cameraId: CAM_GEN2_ID,
            eventType: "person",
            timestamp: "2026-05-28T11:00:00.000+02:00",
            eventId: "evt-fcm-002",
        });

        await new Promise<void>((r) => setImmediate(r));
        await new Promise<void>((r) => setImmediate(r));

        const eventType = getStateVal(db, adapter, `cameras.${CAM_GEN2_ID}.last_motion_event_type`);
        expect(eventType, "last_motion_event_type should be 'person'").to.equal("person");
    });

    it("FCM audio_alarm event: writes last_motion_event_type=audio_alarm", async () => {
        stubAxiosByUrl([
            { match: "video_inputs", method: "get", status: 200, data: [CAM_GEN2_BODY] },
        ]);
        const { db, adapter, getFcmListener } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        const fcmListener = getFcmListener();

        fcmListener.emit("audio_alarm", {
            cameraId: CAM_GEN2_ID,
            eventType: "audio_alarm",
            timestamp: "2026-05-28T12:00:00.000Z",
            eventId: undefined,   // exercises L4729: ev.eventId ?? ""
        });

        await new Promise<void>((r) => setImmediate(r));
        await new Promise<void>((r) => setImmediate(r));

        const eventType = getStateVal(db, adapter, `cameras.${CAM_GEN2_ID}.last_motion_event_type`);
        expect(eventType, "last_motion_event_type should be 'audio_alarm'").to.equal("audio_alarm");
    });

    it("FCM event: onFcmEvent sets motion_active=true (delegates to _onMotionFired)", async () => {
        stubAxiosByUrl([
            { match: "video_inputs", method: "get", status: 200, data: [CAM_GEN2_BODY] },
        ]);
        const { db, adapter, getFcmListener } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        const fcmListener = getFcmListener();

        fcmListener.emit("motion", {
            cameraId: CAM_GEN2_ID,
            eventType: "motion",
            timestamp: "2026-05-28T13:00:00.000Z",
            eventId: "evt-motion-active",
        });

        await new Promise<void>((r) => setImmediate(r));
        await new Promise<void>((r) => setImmediate(r));

        const motionActive = getStateVal(db, adapter, `cameras.${CAM_GEN2_ID}.motion_active`);
        expect(motionActive, "motion_active should be true after FCM motion").to.equal(true);
    });

    it("FCM event: timestamp with [Europe/Berlin] suffix is stripped", async () => {
        stubAxiosByUrl([
            { match: "video_inputs", method: "get", status: 200, data: [CAM_GEN2_BODY] },
        ]);
        const { db, adapter, getFcmListener } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        const fcmListener = getFcmListener();

        // Java ZonedDateTime format from Bosch push
        fcmListener.emit("motion", {
            cameraId: CAM_GEN2_ID,
            eventType: "motion",
            timestamp: "2026-05-28T08:51:47.604+02:00[Europe/Berlin]",
            eventId: "evt-tz-001",
        });

        await new Promise<void>((r) => setImmediate(r));
        await new Promise<void>((r) => setImmediate(r));

        const ts = getStateVal(db, adapter, `cameras.${CAM_GEN2_ID}.last_motion_at`) as string;
        expect(ts, "timestamp should not contain bracket suffix").to.not.include("[");
        expect(() => new Date(ts), "stripped timestamp should be valid ISO").to.not.throw();
    });

    it("FCM event: eventId present — no crash (MQTT bridge absent, no-op)", async () => {
        stubAxiosByUrl([
            { match: "video_inputs", method: "get", status: 200, data: [CAM_GEN2_BODY] },
        ]);
        const { db, adapter, getFcmListener } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        const fcmListener = getFcmListener();

        // No MQTT bridge connected → _publishMqttEvent is a no-op (no throw)
        let threw = false;
        try {
            fcmListener.emit("motion", {
                cameraId: CAM_GEN2_ID,
                eventType: "motion",
                timestamp: "2026-05-28T14:00:00.000Z",
                eventId: "evt-mqtt-001",
            });
        } catch {
            threw = true;
        }

        await new Promise<void>((r) => setImmediate(r));
        expect(threw, "no error should be thrown when MQTT bridge is absent").to.equal(false);
        void db;
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// _handlePanWrite via stateChangeHandler (L5391-5419, L4546-4588)
// ═══════════════════════════════════════════════════════════════════════════════

describe("main adapter — _handlePanWrite via stateChangeHandler (L4546-4588, L5391-5419)", () => {

    it("pan_position on CAMERA_360: PUT /pan succeeds → state ack'd", async () => {
        // pan PUT must be stubbed BEFORE adapter construction
        stubAxiosByUrl([
            { match: "video_inputs", method: "get", status: 200, data: [CAM_360_BODY] },
            { match: "/pan", method: "put", status: 200, data: {} },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `${adapter.namespace}.cameras.${CAM_360_ID}.pan_position`;
        await adapter.stateChangeHandler!(id, {
            val: 45, ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });

        const acked = getStateVal(db, adapter, `cameras.${CAM_360_ID}.pan_position`);
        expect(acked, "pan_position should be ack'd after successful write").to.equal(45);
    });

    it("pan_position gate: non-360 camera (panLimit=0) → warn logged", async () => {
        stubAxiosByUrl([
            { match: "video_inputs", method: "get", status: 200, data: [CAM_GEN2_BODY] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const warnsBefore = getWarnCalls(adapter).length;
        const id = `${adapter.namespace}.cameras.${CAM_GEN2_ID}.pan_position`;
        await adapter.stateChangeHandler!(id, {
            val: 45, ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });

        await new Promise<void>((r) => setImmediate(r));
        const newWarns = warnCallsSince(adapter, warnsBefore);
        expect(
            newWarns.some((w) => /pan_position.*no pan hardware/.test(w)),
            "warn should mention 'no pan hardware'",
        ).to.equal(true);
        void db;
    });

    it("pan_preset 'home': resolves to angle 0, acks pan_position", async () => {
        stubAxiosByUrl([
            { match: "video_inputs", method: "get", status: 200, data: [CAM_360_BODY] },
            { match: "/pan", method: "put", status: 200, data: {} },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `${adapter.namespace}.cameras.${CAM_360_ID}.pan_preset`;
        await adapter.stateChangeHandler!(id, {
            val: "home", ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });
        await new Promise<void>((r) => setImmediate(r));

        const pos = getStateVal(db, adapter, `cameras.${CAM_360_ID}.pan_position`);
        expect(pos, "pan_position ack'd to 0 for 'home'").to.equal(0);
    });

    it("pan_preset 'left': resolves to angle -60", async () => {
        stubAxiosByUrl([
            { match: "video_inputs", method: "get", status: 200, data: [CAM_360_BODY] },
            { match: "/pan", method: "put", status: 200, data: {} },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `${adapter.namespace}.cameras.${CAM_360_ID}.pan_preset`;
        await adapter.stateChangeHandler!(id, {
            val: "left", ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });
        await new Promise<void>((r) => setImmediate(r));

        const pos = getStateVal(db, adapter, `cameras.${CAM_360_ID}.pan_position`);
        expect(pos, "pan_position ack'd to -60 for 'left'").to.equal(-60);
    });

    it("pan_preset 'right': resolves to angle +60", async () => {
        stubAxiosByUrl([
            { match: "video_inputs", method: "get", status: 200, data: [CAM_360_BODY] },
            { match: "/pan", method: "put", status: 200, data: {} },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `${adapter.namespace}.cameras.${CAM_360_ID}.pan_preset`;
        await adapter.stateChangeHandler!(id, {
            val: "right", ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });
        await new Promise<void>((r) => setImmediate(r));

        const pos = getStateVal(db, adapter, `cameras.${CAM_360_ID}.pan_position`);
        expect(pos, "pan_position ack'd to +60 for 'right'").to.equal(60);
    });

    it("pan_preset 'back-left': resolves to angle -120", async () => {
        stubAxiosByUrl([
            { match: "video_inputs", method: "get", status: 200, data: [CAM_360_BODY] },
            { match: "/pan", method: "put", status: 200, data: {} },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `${adapter.namespace}.cameras.${CAM_360_ID}.pan_preset`;
        await adapter.stateChangeHandler!(id, {
            val: "back-left", ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });
        await new Promise<void>((r) => setImmediate(r));

        const pos = getStateVal(db, adapter, `cameras.${CAM_360_ID}.pan_position`);
        expect(pos, "pan_position ack'd to -120 for 'back-left'").to.equal(-120);
    });

    it("pan_preset 'back-right': resolves to angle +120", async () => {
        stubAxiosByUrl([
            { match: "video_inputs", method: "get", status: 200, data: [CAM_360_BODY] },
            { match: "/pan", method: "put", status: 200, data: {} },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `${adapter.namespace}.cameras.${CAM_360_ID}.pan_preset`;
        await adapter.stateChangeHandler!(id, {
            val: "back-right", ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });
        await new Promise<void>((r) => setImmediate(r));

        const pos = getStateVal(db, adapter, `cameras.${CAM_360_ID}.pan_position`);
        expect(pos, "pan_position ack'd to +120 for 'back-right'").to.equal(120);
    });

    it("pan_preset gate: non-360 camera → warn logged", async () => {
        stubAxiosByUrl([
            { match: "video_inputs", method: "get", status: 200, data: [CAM_GEN2_BODY] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const warnsBefore = getWarnCalls(adapter).length;
        const id = `${adapter.namespace}.cameras.${CAM_GEN2_ID}.pan_preset`;
        await adapter.stateChangeHandler!(id, {
            val: "home", ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });

        await new Promise<void>((r) => setImmediate(r));
        const newWarns = warnCallsSince(adapter, warnsBefore);
        expect(
            newWarns.some((w) => /pan_preset.*no pan hardware/.test(w)),
            "warn should mention 'no pan hardware'",
        ).to.equal(true);
        void db;
    });

    it("pan_preset unknown value: warn logged, pan_position not written", async () => {
        stubAxiosByUrl([
            { match: "video_inputs", method: "get", status: 200, data: [CAM_360_BODY] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const warnsBefore = getWarnCalls(adapter).length;
        const id = `${adapter.namespace}.cameras.${CAM_360_ID}.pan_preset`;
        await adapter.stateChangeHandler!(id, {
            val: "diagonal", ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });

        await new Promise<void>((r) => setImmediate(r));
        const newWarns = warnCallsSince(adapter, warnsBefore);
        expect(
            newWarns.some((w) => /unknown preset.*diagonal/.test(w)),
            "warn should mention unknown preset name",
        ).to.equal(true);
        void db;
    });

    it("_handlePanWrite HTTP non-200 → state not ack'd (error arm, L5413)", async () => {
        // PUT /pan returns 403 → _handlePanWrite throws → catch path → no state ack
        stubAxiosByUrl([
            { match: "video_inputs", method: "get", status: 200, data: [CAM_360_BODY] },
            { match: "/pan", method: "put", status: 403, data: { error: "forbidden" } },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        // Pre-seed so we can detect a wrong re-ack to value 90
        db.publishState(`${adapter.namespace}.cameras.${CAM_360_ID}.pan_position`, { val: 0, ack: true });

        const id = `${adapter.namespace}.cameras.${CAM_360_ID}.pan_position`;
        await adapter.stateChangeHandler!(id, {
            val: 90, ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });

        await new Promise<void>((r) => setImmediate(r));
        // Error path: ack is skipped → pan_position stays at the pre-seeded value 0
        const pos = getStateVal(db, adapter, `cameras.${CAM_360_ID}.pan_position`);
        expect(pos, "pan_position should remain 0 on HTTP error").to.equal(0);
        void db;
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// light_enabled auto-snapshot gate (L4401-4410)
// ═══════════════════════════════════════════════════════════════════════════════

describe("main adapter — light_enabled auto-snapshot gate (L4401-4410)", () => {

    it("light_enabled on Gen2 WITH light hardware: no 'no light hardware' warn", async () => {
        stubAxiosByUrl([
            { match: "video_inputs", method: "get", status: 200, data: [CAM_GEN2_BODY] },
            // handleLightToggle PUT; no matter what URL, just succeed
            { match: "lighting", method: "put", status: 200, data: {} },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const warnsBefore = getWarnCalls(adapter).length;
        const id = `${adapter.namespace}.cameras.${CAM_GEN2_ID}.light_enabled`;
        await adapter.stateChangeHandler!(id, {
            val: true, ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });

        await new Promise<void>((r) => setImmediate(r));
        const newWarns = warnCallsSince(adapter, warnsBefore);
        const hasNoHwWarn = newWarns.some((w) => w.includes("no light hardware"));
        expect(hasNoHwWarn, "should NOT warn about no light hardware for supported camera").to.equal(false);
        void db;
    });

    it("light_enabled on Gen2 WITHOUT light hardware (featureLight=false): warns + skips (L4396-4400)", async () => {
        stubAxiosByUrl([
            { match: "video_inputs", method: "get", status: 200, data: [CAM_GEN2_NO_LIGHT_BODY] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const warnsBefore = getWarnCalls(adapter).length;
        const id = `${adapter.namespace}.cameras.${CAM_GEN2_ID}.light_enabled`;
        await adapter.stateChangeHandler!(id, {
            val: true, ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });

        await new Promise<void>((r) => setImmediate(r));
        const newWarns = warnCallsSince(adapter, warnsBefore);
        expect(
            newWarns.some((w) => w.includes("no light hardware")),
            "should warn about no light hardware for Gen2 Indoor",
        ).to.equal(true);
        void db;
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// _pollPrivacySoundOverride (L5218-5230) — 442/444/success/error branches
// ═══════════════════════════════════════════════════════════════════════════════

describe("main adapter — _pollPrivacySoundOverride arms (L5218-5230)", () => {

    it("442 response: feature cached unsupported — no privacy_sound_enabled state", async () => {
        stubAxiosByUrl([
            { match: "video_inputs", method: "get", status: 200, data: [CAM_GEN2_BODY] },
            { match: "privacy_sound_override", method: "get", status: 442, data: null },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        await new Promise<void>((r) => setImmediate(r));

        const val = getStateVal(db, adapter, `cameras.${CAM_GEN2_ID}.privacy_sound_enabled`);
        expect(
            val === undefined || val === null || val === false,
            "privacy_sound_enabled must not be set on 442",
        ).to.equal(true);
        void db;
    });

    it("200 response with result=true: writes privacy_sound_enabled=true", async () => {
        // privacy_sound_override MUST come before video_inputs (first-match-wins;
        // both URLs contain "video_inputs").
        stubAxiosByUrl([
            { match: "privacy_sound_override", method: "get", status: 200, data: { result: true } },
            { match: "video_inputs", method: "get", status: 200, data: [CAM_GEN2_BODY] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // Trigger the per-camera poller directly (it's normally on a 30s interval).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollCameraStateOnce();
        await new Promise<void>((r) => setImmediate(r));

        const val = getStateVal(db, adapter, `cameras.${CAM_GEN2_ID}.privacy_sound_enabled`);
        expect(val, "privacy_sound_enabled should be true").to.equal(true);
        void db;
    });

    it("444 response (camera in privacy mode): graceful skip, no crash", async () => {
        stubAxiosByUrl([
            { match: "video_inputs", method: "get", status: 200, data: [CAM_GEN2_BODY] },
            { match: "privacy_sound_override", method: "get", status: 444, data: null },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        await new Promise<void>((r) => setImmediate(r));
        // No crash = success
        void db;
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// _pollAutofollow (L5300-5319) — 442/404/444/success/error branches
// ═══════════════════════════════════════════════════════════════════════════════

describe("main adapter — _pollAutofollow arms (L5300-5319)", () => {

    it("442 response: feature cached unsupported — no autofollow_enabled state", async () => {
        stubAxiosByUrl([
            { match: "video_inputs", method: "get", status: 200, data: [CAM_360_BODY] },
            { match: "autofollow", method: "get", status: 442, data: null },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        await new Promise<void>((r) => setImmediate(r));

        const val = getStateVal(db, adapter, `cameras.${CAM_360_ID}.autofollow_enabled`);
        expect(
            val === undefined || val === null || val === false,
            "autofollow_enabled must not be set on 442",
        ).to.equal(true);
        void db;
    });

    it("404 response: feature cached unsupported (same as 442)", async () => {
        stubAxiosByUrl([
            { match: "video_inputs", method: "get", status: 200, data: [CAM_360_BODY] },
            { match: "autofollow", method: "get", status: 404, data: null },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        await new Promise<void>((r) => setImmediate(r));

        const val = getStateVal(db, adapter, `cameras.${CAM_360_ID}.autofollow_enabled`);
        expect(
            val === undefined || val === null || val === false,
            "autofollow_enabled must not be set on 404",
        ).to.equal(true);
        void db;
    });

    it("444 response (privacy active): graceful skip, no crash", async () => {
        stubAxiosByUrl([
            { match: "video_inputs", method: "get", status: 200, data: [CAM_360_BODY] },
            { match: "autofollow", method: "get", status: 444, data: null },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        await new Promise<void>((r) => setImmediate(r));
        void db;
    });

    it("200 response with result=false: writes autofollow_enabled=false", async () => {
        // autofollow MUST come before video_inputs (first-match-wins)
        stubAxiosByUrl([
            { match: "autofollow", method: "get", status: 200, data: { result: false } },
            { match: "video_inputs", method: "get", status: 200, data: [CAM_360_BODY] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // Trigger the per-camera poller directly (normally on 30s interval)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollCameraStateOnce();
        await new Promise<void>((r) => setImmediate(r));

        const val = getStateVal(db, adapter, `cameras.${CAM_360_ID}.autofollow_enabled`);
        expect(val, "autofollow_enabled should be false").to.equal(false);
        void db;
    });

    it("200 response with result=true: writes autofollow_enabled=true", async () => {
        // autofollow MUST come before video_inputs (first-match-wins)
        stubAxiosByUrl([
            { match: "autofollow", method: "get", status: 200, data: { result: true } },
            { match: "video_inputs", method: "get", status: 200, data: [CAM_360_BODY] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // Trigger the per-camera poller directly (normally on 30s interval)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollCameraStateOnce();
        await new Promise<void>((r) => setImmediate(r));

        const val = getStateVal(db, adapter, `cameras.${CAM_360_ID}.autofollow_enabled`);
        expect(val, "autofollow_enabled should be true").to.equal(true);
        void db;
    });
});

// ── v1.0.3 regression — write-path clamp + full-body PUT ────────────────────────
//
// Live-reproduced on the dev sandbox (FW 9.40.102): setting intrusion_distance
// = 10 logged `Failed to handle intrusion_distance … status code 400` because
// the handler clamped to min(10) and Bosch rejects > 8. These pin the three
// write-path fixes (also applied cross-version to HA/Python):
//   BUG 1  intrusion distance clamps to 1–8 (was 1–10) and acks the clamped value
//   BUG 2  audio level PUT sends the FULL body (GET → merge → PUT); never a
//          partial body that silently drops the other level
//   BUG 3  pan_position acks the CLAMPED angle, not the raw user value
//
// NOTE on stub order: the cameras-list, intrusion-config and audio URLs all
// contain "video_inputs". stubAxiosByUrl is first-match-wins, so the specific
// matchers MUST precede the generic "video_inputs" rule.
describe("v1.0.3 regression — write-path clamp + full-body PUT", () => {
    it("BUG1 intrusion_distance 10 → clamped + acked to 8; PUT body distance=8", async () => {
        stubAxiosByUrl([
            {
                match: "intrusionDetectionConfig",
                method: "get",
                status: 200,
                data: { enabled: true, sensitivity: 3, detectionMode: "ALL_MOTIONS", distance: 5 },
            },
            { match: "intrusionDetectionConfig", method: "put", status: 204, data: null },
            { match: "video_inputs", method: "get", status: 200, data: [CAM_GEN2_BODY] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const putSpy = sinon.spy((adapter as any)._httpClient, "put");
        const id = `${adapter.namespace}.cameras.${CAM_GEN2_ID}.intrusion_distance`;
        await adapter.stateChangeHandler!(id, {
            val: 10, ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });
        await new Promise<void>((r) => setImmediate(r));

        expect(
            getStateVal(db, adapter, `cameras.${CAM_GEN2_ID}.intrusion_distance`),
            "intrusion_distance acked to clamped 8, not raw 10",
        ).to.equal(8);
        const cfgPut = putSpy
            .getCalls()
            .find((c) => String(c.args[0]).includes("intrusionDetectionConfig"));
        expect(cfgPut, "intrusionDetectionConfig PUT must have happened").to.not.equal(undefined);
        expect(
            (cfgPut!.args[1] as { distance: number }).distance,
            "PUT body distance must be clamped to 8 (Bosch rejects > 8)",
        ).to.equal(8);
    });

    it("BUG1 intrusion_distance 7 → stays 7 (within range)", async () => {
        stubAxiosByUrl([
            {
                match: "intrusionDetectionConfig",
                method: "get",
                status: 200,
                data: { enabled: true, sensitivity: 3, detectionMode: "ALL_MOTIONS", distance: 5 },
            },
            { match: "intrusionDetectionConfig", method: "put", status: 204, data: null },
            { match: "video_inputs", method: "get", status: 200, data: [CAM_GEN2_BODY] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `${adapter.namespace}.cameras.${CAM_GEN2_ID}.intrusion_distance`;
        await adapter.stateChangeHandler!(id, {
            val: 7, ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });
        await new Promise<void>((r) => setImmediate(r));

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_ID}.intrusion_distance`)).to.equal(7);
    });

    it("BUG2 speaker_level write sends FULL /audio body, preserving microphoneLevel", async () => {
        stubAxiosByUrl([
            {
                match: "/audio",
                method: "get",
                status: 200,
                data: { audioEnabled: true, microphoneLevel: 30, speakerLevel: 40 },
            },
            { match: "/audio", method: "put", status: 200, data: {} },
            { match: "video_inputs", method: "get", status: 200, data: [CAM_GEN2_BODY] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const putSpy = sinon.spy((adapter as any)._httpClient, "put");
        const id = `${adapter.namespace}.cameras.${CAM_GEN2_ID}.speaker_level`;
        await adapter.stateChangeHandler!(id, {
            val: 70, ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });
        await new Promise<void>((r) => setImmediate(r));

        const audioPut = putSpy.getCalls().find((c) => String(c.args[0]).includes("/audio"));
        expect(audioPut, "/audio PUT must have happened").to.not.equal(undefined);
        const body = audioPut!.args[1] as { microphoneLevel?: number; speakerLevel?: number };
        expect(body.speakerLevel, "speakerLevel set to new value 70").to.equal(70);
        expect(
            body.microphoneLevel,
            "microphoneLevel preserved from GET (30), not dropped by partial PUT",
        ).to.equal(30);
        void db;
    });

    it("BUG3 pan_position 999 → clamped + acked to panLimit (120), not 999", async () => {
        stubAxiosByUrl([
            { match: "/pan", method: "put", status: 200, data: {} },
            { match: "video_inputs", method: "get", status: 200, data: [CAM_360_BODY] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const putSpy = sinon.spy((adapter as any)._httpClient, "put");
        const id = `${adapter.namespace}.cameras.${CAM_360_ID}.pan_position`;
        await adapter.stateChangeHandler!(id, {
            val: 999, ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });
        await new Promise<void>((r) => setImmediate(r));

        expect(
            getStateVal(db, adapter, `cameras.${CAM_360_ID}.pan_position`),
            "pan_position acked to clamped 120, not raw 999",
        ).to.equal(120);
        const panPut = putSpy.getCalls().find((c) => String(c.args[0]).includes("/pan"));
        expect(panPut, "/pan PUT must have happened").to.not.equal(undefined);
        expect(
            (panPut!.args[1] as { absolutePosition: number }).absolutePosition,
            "PUT absolutePosition clamped to 120",
        ).to.equal(120);
    });

    it("BUG3 pan_position 444 (session quota) → warn, session_limit_hit set, NOT a hard error", async () => {
        // Live-reproduced: pan against a session-saturated camera returned 444
        // and logged a hard `Failed to handle pan_position … 444` error. It must
        // instead be a graceful session-quota warn (mirroring the stream path).
        stubAxiosByUrl([
            { match: "/pan", method: "put", status: 444, data: null },
            { match: "video_inputs", method: "get", status: 200, data: [CAM_360_BODY] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const warnsBefore = getWarnCalls(adapter).length;
        // log.error is pre-stubbed by MockAdapter — read its calls directly
        // (re-wrapping with sinon.spy throws "already stubbed").
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const errStub = (adapter as any).log.error as sinon.SinonStub;
        const errBefore = errStub.args.length;
        const id = `${adapter.namespace}.cameras.${CAM_360_ID}.pan_position`;
        await adapter.stateChangeHandler!(id, {
            val: 60, ack: false, ts: Date.now(), lc: Date.now(), from: "user",
        });
        await new Promise<void>((r) => setImmediate(r));

        // No hard "Failed to handle pan_position" error logged
        const panErrors = (errStub.args as unknown[][])
            .slice(errBefore)
            .filter((a) => /Failed to handle pan_position/.test(String(a[0])));
        expect(panErrors.length, "444 must NOT produce a hard pan error").to.equal(0);
        // session-quota warn emitted
        const newWarns = warnCallsSince(adapter, warnsBefore);
        expect(
            newWarns.some((w) => /session-quota.*444/.test(w)),
            "session-quota 444 warn should be logged",
        ).to.equal(true);
        // session_limit_hit DP set true
        expect(getStateVal(db, adapter, `cameras.${CAM_360_ID}.session_limit_hit`)).to.equal(true);
        // position NOT acked (stays pending ack:false)
        const posState = db.getState(
            `${adapter.namespace}.cameras.${CAM_360_ID}.pan_position`,
        ) as ioBroker.State | null;
        expect(posState?.ack === true, "pan_position must not be acked on 444").to.equal(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FCM "error-logged" event wiring to main adapter (v1.7.4 Fix B)
// ═══════════════════════════════════════════════════════════════════════════════

describe("main adapter — FCM error-logged event wiring (v1.7.4)", () => {
    it("FCM 'error-logged' event is forwarded to adapter.log.warn", async () => {
        // Ensures that a non-fatal CBS re-registration failure (emitted as
        // 'error-logged' by FcmListener) surfaces in the ioBroker log as a
        // warn — not swallowed silently.
        stubAxiosByUrl([
            { match: "video_inputs", method: "get", status: 200, data: [CAM_GEN2_BODY] },
        ]);
        const { db, adapter, getFcmListener } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        const fcmListener = getFcmListener();

        const warnsBefore = getWarnCalls(adapter).length;
        fcmListener.emit("error-logged", "CBS periodic re-register failed: HTTP 503");

        await new Promise<void>((r) => setImmediate(r));

        const newWarns = warnCallsSince(adapter, warnsBefore);
        expect(
            newWarns.some((w) => /CBS periodic re-register failed/.test(w)),
            "error-logged must be forwarded to log.warn",
        ).to.equal(true);
    });
});
