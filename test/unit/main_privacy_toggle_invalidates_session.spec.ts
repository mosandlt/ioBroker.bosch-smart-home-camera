/**
 * Regression test — privacy toggle via Bosch app must invalidate the cached
 * LiveSession so the next ensureLiveSession() fetches rotated Digest creds.
 *
 * Source: forum.iobroker.net post #1341076 (Jaschkopf, 2026-05-23).
 *   "Privacy mode ON via Bosch app, later OFF — BlueIris and VLC then refuse
 *    the stream URL with 'Check Port/User/Password'.  Adapter restart fixes
 *    it."
 *
 * Root cause: Bosch rotates the Digest credentials of the RTSP stream URL
 * on every privacy-state edge (camera-side enforcement).  Our
 * _liveSessions cache holds the pre-toggle creds.  ensureLiveSession()
 * inside its 60 s TTL window keeps returning that cached session — the
 * stream_url DP keeps publishing the now-stale creds — external clients
 * get 401.
 *
 * Fix: _pollSingleCameraState() now drops the cached LiveSession on every
 * detected privacy-state change so the next ensureLiveSession() call is
 * forced to issue a fresh PUT /connection.  Both ON→OFF and OFF→ON edges
 * are covered because Bosch invalidates creds on both transitions.
 *
 * Pins:
 *   1. Privacy ON→OFF detected by poll → cached session deleted
 *   2. Privacy OFF→ON detected by poll → cached session deleted
 *   3. Privacy state unchanged (re-poll same value) → cached session kept
 *   4. No cached session present (cold start) → no-op, no crash
 */

import { expect } from "chai";
import * as sinon from "sinon";
import * as path from "path";

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

const CAM_A = "EFEFEFEF-1111-2222-3333-444455556666";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

interface PollStub {
    _liveSessions: Map<string, { digestUser: string; digestPassword: string; openedAt: number }>;
    _sessionWatchdogs: Map<string, { stop: () => void }>;
    _streamGeneration: Map<string, number>;
    _cameras: Map<string, unknown>;
    _livestreamEnabled: Map<string, boolean>;
    _lanIpMap: Map<string, string>;
    getStateAsync: sinon.SinonStub;
    upsertState: sinon.SinonStub;
    _publishStreamParts: sinon.SinonStub;
    ensureLiveSession: sinon.SinonStub;
    _tcpPing: sinon.SinonStub;
    _pollWifiInfo: sinon.SinonStub;
    _pollIntrusionConfig: sinon.SinonStub;
    _pollAudioState: sinon.SinonStub;
    _pollIntrusionState: sinon.SinonStub;
    _pollLightingState: sinon.SinonStub;
    _pollMotionConfig: sinon.SinonStub;
    _pollRecordingOptions: sinon.SinonStub;
    _pollNotificationTypes: sinon.SinonStub;
    _pollBatchDLeds: sinon.SinonStub;
    _pollCommissioned: sinon.SinonStub;
    // v0.9.0
    _pollPrivacySound: sinon.SinonStub;
    _pollAutofollow: sinon.SinonStub;
    // v0.9.1 — _pollUnreadCount replaced cam.numberOfUnreadEvents listing-field read
    _pollUnreadCount: sinon.SinonStub;
    log: { info: sinon.SinonStub; debug: sinon.SinonStub; warn: sinon.SinonStub };
}

function makeStub(opts: {
    hasSession?: boolean;
    currentPrivacyDp?: boolean | null;
    livestreamEnabled?: boolean;
    ensureLiveSessionRejects?: boolean;
}): PollStub {
    const ensureStub = sinon.stub();
    if (opts.ensureLiveSessionRejects) {
        ensureStub.rejects(new Error("camera unreachable on LAN"));
    } else {
        ensureStub.resolves({
            digestUser: "cbs-FRESH",
            digestPassword: "fresh-pass",
            openedAt: Date.now(),
        });
    }
    const stub: PollStub = {
        _liveSessions: new Map(),
        _sessionWatchdogs: new Map(),
        _streamGeneration: new Map(),
        _cameras: new Map(),
        _livestreamEnabled: new Map(),
        _lanIpMap: new Map(),
        getStateAsync: sinon
            .stub()
            .resolves(
                opts.currentPrivacyDp === null
                    ? null
                    : { val: opts.currentPrivacyDp ?? false, ack: true },
            ),
        upsertState: sinon.stub().resolves(),
        _publishStreamParts: sinon.stub().resolves(),
        ensureLiveSession: ensureStub,
        _tcpPing: sinon.stub().resolves(false),
        _pollWifiInfo: sinon.stub().resolves(),
        _pollIntrusionConfig: sinon.stub().resolves(),
        _pollAudioState: sinon.stub().resolves(),
        _pollIntrusionState: sinon.stub().resolves(),
        _pollLightingState: sinon.stub().resolves(),
        _pollMotionConfig: sinon.stub().resolves(),
        _pollRecordingOptions: sinon.stub().resolves(),
        _pollNotificationTypes: sinon.stub().resolves(),
        _pollBatchDLeds: sinon.stub().resolves(),
        _pollCommissioned: sinon.stub().resolves(),
        // v0.9.0
        _pollPrivacySound: sinon.stub().resolves(),
        _pollAutofollow: sinon.stub().resolves(),
        // v0.9.1
        _pollUnreadCount: sinon.stub().resolves(),
        log: { info: sinon.stub(), debug: sinon.stub(), warn: sinon.stub() },
    };
    if (opts.hasSession) {
        stub._liveSessions.set(CAM_A, {
            digestUser: "cbs-PRE-TOGGLE",
            digestPassword: "pre-toggle-pass",
            openedAt: Date.now() - 5000,
        });
    }
    if (opts.livestreamEnabled !== undefined) {
        stub._livestreamEnabled.set(CAM_A, opts.livestreamEnabled);
    }
    return stub;
}

function loadMethod(): { pollSingleCameraState: AnyFn } {
    const db = new MockDatabaseCtor();
    let capturedAdapter: MockAdapter | null = null;
    const core = mockAdapterCoreFn(db, {
        onAdapterCreated: (a) => {
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
    delete require.cache[MAIN_JS_PATH];
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const factory = require(MAIN_JS_PATH) as (opts: Record<string, unknown>) => MockAdapter;
    factory({ config: { redirect_url: "", region: "EU" } });
    if (!capturedAdapter) throw new Error("adapter not captured");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proto = capturedAdapter as any;
    const pollSingleCameraState = proto._pollSingleCameraState as AnyFn | undefined;
    if (typeof pollSingleCameraState !== "function") {
        throw new Error("_pollSingleCameraState not found");
    }
    return { pollSingleCameraState };
}

describe("privacy-toggle invalidates cached LiveSession (forum #1341076)", () => {
    let method: ReturnType<typeof loadMethod>;

    before(() => {
        method = loadMethod();
    });
    afterEach(() => {
        sinon.restore();
    });

    it("ON→OFF transition deletes the cached LiveSession + clears stream_url DPs", async () => {
        const stub = makeStub({ hasSession: true, currentPrivacyDp: true });
        const cam = { id: CAM_A, name: "Terrasse", privacyMode: "OFF" };
        expect(stub._liveSessions.has(CAM_A)).to.equal(true);
        await method.pollSingleCameraState.call(stub, "token", cam);
        expect(stub._liveSessions.has(CAM_A)).to.equal(false);
        expect(stub.log.info.called).to.equal(true);
        const msg = stub.log.info.firstCall?.args?.[0] || "";
        expect(msg).to.include("Privacy toggled externally");
        // stream_url + stream_url_sub cleared so external clients refuse
        // to use stale creds instead of getting silent 401s.
        const upsertCalls = stub.upsertState.getCalls().map((c) => c.args);
        expect(upsertCalls).to.deep.include([`cameras.${CAM_A}.stream_url`, ""]);
        expect(upsertCalls).to.deep.include([`cameras.${CAM_A}.stream_url_sub`, ""]);
    });

    it("OFF→ON transition deletes the cached LiveSession", async () => {
        const stub = makeStub({ hasSession: true, currentPrivacyDp: false });
        const cam = { id: CAM_A, name: "Terrasse", privacyMode: "ON" };
        expect(stub._liveSessions.has(CAM_A)).to.equal(true);
        await method.pollSingleCameraState.call(stub, "token", cam);
        expect(stub._liveSessions.has(CAM_A)).to.equal(false);
        expect(stub.log.info.called).to.equal(true);
    });

    it("unchanged state keeps the cached LiveSession (no-op)", async () => {
        const stub = makeStub({ hasSession: true, currentPrivacyDp: false });
        const cam = { id: CAM_A, name: "Terrasse", privacyMode: "OFF" };
        await method.pollSingleCameraState.call(stub, "token", cam);
        // privacy stayed OFF → no transition → session kept
        expect(stub._liveSessions.has(CAM_A)).to.equal(true);
        expect(stub.log.info.called).to.equal(false);
    });

    it("transition detected but no cached session present → no crash", async () => {
        const stub = makeStub({ hasSession: false, currentPrivacyDp: true });
        const cam = { id: CAM_A, name: "Terrasse", privacyMode: "OFF" };
        await method.pollSingleCameraState.call(stub, "token", cam);
        // No session to invalidate, but upsertState still fires
        expect(stub._liveSessions.has(CAM_A)).to.equal(false);
        expect(stub.upsertState.called).to.equal(true);
    });
});

// v0.7.13 — eager LiveSession refresh on ON→OFF transitions so the TLS
// proxy's bound Digest creds are rotated BEFORE the next BlueIris/VLC
// reconnect attempt. Forum #1341076.
describe("privacy ON→OFF eager LiveSession refresh (forum #1341076)", () => {
    let method: ReturnType<typeof loadMethod>;
    before(() => {
        method = loadMethod();
    });
    afterEach(() => {
        sinon.restore();
    });

    it("ON→OFF + livestream_enabled=true → ensureLiveSession fired exactly once", async () => {
        const stub = makeStub({
            hasSession: true,
            currentPrivacyDp: true,
            livestreamEnabled: true,
        });
        const cam = { id: CAM_A, name: "Terrasse", privacyMode: "OFF" };
        await method.pollSingleCameraState.call(stub, "token", cam);
        // Eager refresh happens after the await chain — give the fire-and-forget
        // microtask one tick to run, then assert.
        await new Promise((r) => setImmediate(r));
        expect(stub.ensureLiveSession.calledOnceWithExactly(CAM_A)).to.equal(true);
    });

    it("ON→OFF + livestream_enabled=false → no eager refresh (no stream to keep alive)", async () => {
        const stub = makeStub({
            hasSession: true,
            currentPrivacyDp: true,
            livestreamEnabled: false,
        });
        const cam = { id: CAM_A, name: "Terrasse", privacyMode: "OFF" };
        await method.pollSingleCameraState.call(stub, "token", cam);
        await new Promise((r) => setImmediate(r));
        expect(stub.ensureLiveSession.called).to.equal(false);
    });

    it("ON→OFF + livestream_enabled missing (cold start before users seeded) → no eager refresh", async () => {
        // _livestreamEnabled.get() returns undefined when no DP was ever read
        const stub = makeStub({ hasSession: true, currentPrivacyDp: true });
        // Note: opts.livestreamEnabled NOT set → map empty → .get() → undefined
        const cam = { id: CAM_A, name: "Terrasse", privacyMode: "OFF" };
        await method.pollSingleCameraState.call(stub, "token", cam);
        await new Promise((r) => setImmediate(r));
        expect(stub.ensureLiveSession.called).to.equal(false);
    });

    it("OFF→ON + livestream_enabled=true → no eager refresh (cam now in privacy, can't stream)", async () => {
        const stub = makeStub({
            hasSession: true,
            currentPrivacyDp: false,
            livestreamEnabled: true,
        });
        const cam = { id: CAM_A, name: "Terrasse", privacyMode: "ON" };
        await method.pollSingleCameraState.call(stub, "token", cam);
        await new Promise((r) => setImmediate(r));
        expect(stub.ensureLiveSession.called).to.equal(false);
    });

    it("ensureLiveSession rejects → no crash (fire-and-forget, debug-logged)", async () => {
        const stub = makeStub({
            hasSession: true,
            currentPrivacyDp: true,
            livestreamEnabled: true,
            ensureLiveSessionRejects: true,
        });
        const cam = { id: CAM_A, name: "Terrasse", privacyMode: "OFF" };
        await method.pollSingleCameraState.call(stub, "token", cam);
        // Wait one extra tick for the .catch() to run
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        expect(stub.ensureLiveSession.called).to.equal(true);
        // Failure routed to debug, not warn/info (non-fatal: next consumer will retry)
        const debugCalls = stub.log.debug.getCalls().map((c) => String(c.args?.[0] ?? ""));
        const refreshFailLog = debugCalls.find((m) =>
            m.includes("Eager LiveSession refresh after privacy ON→OFF failed"),
        );
        expect(refreshFailLog, "debug log records the swallowed rejection").to.not.equal(undefined);
    });

    it("unchanged state (no transition) → no eager refresh", async () => {
        const stub = makeStub({
            hasSession: true,
            currentPrivacyDp: false,
            livestreamEnabled: true,
        });
        const cam = { id: CAM_A, name: "Terrasse", privacyMode: "OFF" };
        // current OFF, new OFF → no transition → eager refresh must NOT fire
        await method.pollSingleCameraState.call(stub, "token", cam);
        await new Promise((r) => setImmediate(r));
        expect(stub.ensureLiveSession.called).to.equal(false);
    });
});

// v1.1.0 regression — privacy toggle must also stop watchdog + bump generation
describe("privacy toggle stops watchdog + bumps generation (v1.1.0 regression)", () => {
    let method: ReturnType<typeof loadMethod>;
    before(() => {
        method = loadMethod();
    });
    afterEach(() => {
        sinon.restore();
    });

    it("OFF→ON: watchdog stopped + deleted + generation bumped", async () => {
        const stub = makeStub({ hasSession: true, currentPrivacyDp: false });
        const stopStub = sinon.stub();
        stub._sessionWatchdogs.set(CAM_A, { stop: stopStub });
        stub._streamGeneration.set(CAM_A, 3);

        const cam = { id: CAM_A, name: "Terrasse", privacyMode: "ON" };
        // currentPrivacyDp=false (OFF), cam.privacyMode=ON → OFF→ON external toggle
        await method.pollSingleCameraState.call(stub, "token", cam);

        // v1.1.0: watchdog must be stopped and removed so it cannot resurrect
        // a Bosch session that will never be cleanly torn down (server-side leak).
        expect(stopStub.calledOnce, "watchdog.stop() called").to.equal(true);
        expect(stub._sessionWatchdogs.has(CAM_A), "watchdog removed from map").to.equal(false);

        // v1.1.0: generation must be bumped so any stale backoff-renewal
        // timer that fires after the session was dropped bails immediately.
        const newGen = stub._streamGeneration.get(CAM_A) ?? 0;
        expect(newGen, "generation incremented from 3").to.be.greaterThan(3);
    });
});
