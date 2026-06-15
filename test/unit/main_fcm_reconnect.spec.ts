/**
 * v0.6.2 — FCM auto-reconnect on disconnect
 *
 * Before v0.6.2 the adapter only logged "FCM disconnected — adapter continues
 * polling" and never re-armed the FCM socket. A single MTalk server reset
 * (Google occasionally rotates the push backend) would leave the adapter on the
 * 30 s polling fallback forever, costing one event window (~30-45 s gap before
 * the next /v11/events poll caught up).
 *
 * v0.6.2 schedules an exponential-backoff reconnect: 5 s, 30 s, 120 s, then
 * 600 s cap (mirrors the HA integration's stream-reconnect pattern).
 * Successful reconnect resets the backoff. Pending timer cleared on unload.
 *
 * Test strategy: replace adapter.setTimeout with a capturing stub so we can
 * inspect (delay, callback) without actually waiting. Manually emit "disconnect"
 * on the FakeFcmListener (visible via adapter._fcmListener) and walk the
 * scheduled callbacks to verify backoff progression.
 */

import { expect } from "chai";
import * as sinon from "sinon";
import * as path from "path";
import { EventEmitter } from "events";

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

const LIVE_SESSION_PATH = path.join(REPO_ROOT, "build", "lib", "live_session.js");
const RCP_PATH = path.join(REPO_ROOT, "build", "lib", "rcp.js");
const SNAPSHOT_PATH = path.join(REPO_ROOT, "build", "lib", "snapshot.js");
const TLS_PROXY_PATH = path.join(REPO_ROOT, "build", "lib", "tls_proxy.js");
const FCM_PATH = path.join(REPO_ROOT, "build", "lib", "fcm.js");
const SESSION_WATCHDOG_PATH = path.join(REPO_ROOT, "build", "lib", "session_watchdog.js");

type TestAdapter = MockAdapter & {
    readyHandler?: () => Promise<void>;
    unloadHandler?: (cb: () => void) => void;
};

const CAM_GEN2 = "EFEFEFEF-1111-2222-3333-444455556666";
const CAMERAS_BODY = [
    {
        id: CAM_GEN2,
        title: "Terrasse",
        hardwareVersion: "HOME_Eyes_Outdoor",
        firmwareVersion: "9.40.25",
    },
];

class FakeFcmCbsRegistrationError extends Error {
    constructor() {
        super("CBS registration rejected (fake test error)");
        this.name = "FcmCbsRegistrationError";
    }
}

class FakeFcmListener extends EventEmitter {
    public start: sinon.SinonStub;
    public stop: sinon.SinonStub = sinon.stub().resolves(undefined);

    constructor(startStub: sinon.SinonStub) {
        super();
        this.start = startStub;
    }
}

interface ScheduledTimer {
    fn: () => void;
    ms: number;
    fired: boolean;
}

interface ReconnectFixture {
    db: MockDatabase;
    adapter: TestAdapter;
    fcmListener: FakeFcmListener;
    timers: ScheduledTimer[];
    /** Find the next un-fired timer with the given delay and invoke it (sync wrapper). */
    fireTimer(expectedMs: number): Promise<void>;
    /** Pending timers whose delay matches one of the FCM backoff steps. */
    pendingFcmTimers(): ScheduledTimer[];
}

/**
 * Token-refresh and FCM-backoff both go through `this.setTimeout`. We isolate
 * the FCM ones by their distinctive delays (5/30/120/600 s) — no other
 * setTimeout in the adapter uses those values.
 */
const FCM_BACKOFF_DELAYS = new Set([5_000, 30_000, 120_000, 600_000]);

function injectModule(resolvedPath: string, exports: object): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[resolvedPath] = {
        id: resolvedPath,
        filename: resolvedPath,
        loaded: true,
        parent: module,
        children: [],
        path: path.dirname(resolvedPath),
        paths: [],
        exports,
    };
}

async function createFixture(fcmStart: sinon.SinonStub): Promise<ReconnectFixture> {
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

    // Capture the single FcmListener instance the adapter constructs.
    // Using a `class extends FakeFcmListener` lets the `new FcmListener(...)`
    // call in main.ts produce an instance that we can grab via the side-effect
    // assignment in the subclass constructor.
    let createdFcmListener: FakeFcmListener | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const CapturingFcm = class extends FakeFcmListener {
        constructor(..._args: unknown[]) {
            super(fcmStart);
            createdFcmListener = this;
        }
    };

    injectModule(FCM_PATH, {
        FcmListener: CapturingFcm,
        FcmCbsRegistrationError: FakeFcmCbsRegistrationError,
        CLOUD_API: "https://residential.cbs.boschsecurity.com",
        FCM_SENDER_ID: "404630424405",
    });
    injectModule(LIVE_SESSION_PATH, {
        openLiveSession: sinon.stub().resolves(undefined),
        closeLiveSession: sinon.stub().resolves(undefined),
        LiveSessionError: class extends Error {},
        CameraOfflineError: class extends Error {},
        SessionLimitError: class extends Error {},
    });
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const realRcp = require(RCP_PATH) as Record<string, unknown>;
    injectModule(RCP_PATH, { ...realRcp, sendRcpCommand: sinon.stub().resolves({ payload: Buffer.alloc(0) }) });
    injectModule(SNAPSHOT_PATH, {
        fetchSnapshot: sinon.stub().resolves(Buffer.from([0xff, 0xd8, 0xff])),
        buildSnapshotUrl: (u: string): string => `${u}/snap.jpg`,
        SnapshotError: class extends Error {},
    });
    injectModule(TLS_PROXY_PATH, {
        startTlsProxy: sinon.stub().resolves({
            port: 18010,
            localRtspUrl: "rtsp://127.0.0.1:18010/rtsp_tunnel",
            stop: sinon.stub().resolves(undefined),
        }),
    });
    injectModule(SESSION_WATCHDOG_PATH, {
        SessionWatchdog: class {
            start(): void {}
            stop(): void {}
            isRunning(): boolean { return false; }
        },
    });

    // stubAxiosSequence MUST be called BEFORE constructing the adapter —
    // createHttpClient() (in the BoschSmartHomeCamera constructor) snapshots
    // axios.defaults.adapter at instantiation. A later stub doesn't reach the
    // captured http client. See helpers/axios-mock + main_handlers.spec.ts.
    stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);

    delete require.cache[MAIN_JS_PATH];
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const factory = require(MAIN_JS_PATH) as (opts: Record<string, unknown>) => MockAdapter;
    factory({ config: { redirect_url: "", region: "EU", startup_snapshot: true } });

    if (!capturedAdapter) throw new Error("adapter not captured");
    const adapter = capturedAdapter as TestAdapter;

    // Capturing setTimeout — the fix's _scheduleFcmReconnect calls this.setTimeout
    const timers: ScheduledTimer[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).setTimeout = (fn: () => void, ms: number) => {
        const entry: ScheduledTimer = { fn, ms, fired: false };
        timers.push(entry);
        return entry;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).clearTimeout = (h: unknown): void => {
        const entry = h as ScheduledTimer | null;
        if (entry) entry.fired = true; // mark cancelled
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).setInterval = (_fn: () => void, _ms: number) => null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).clearInterval = (_h: unknown): void => undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).terminate = (): void => undefined;

    // Boot with stored tokens (skips login flow)
    const futureExpiry = Date.now() + 200_000;
    db.publishState(`${adapter.namespace}.info.access_token`, { val: "stored.tok", ack: true });
    db.publishState(`${adapter.namespace}.info.refresh_token`, { val: "stored.ref", ack: true });
    db.publishState(`${adapter.namespace}.info.token_expires_at`, { val: futureExpiry, ack: true });

    await adapter.readyHandler!();

    if (!createdFcmListener) throw new Error("FcmListener was not constructed by onReady");
    const fcmListener = createdFcmListener as FakeFcmListener;

    const fireTimer = async (expectedMs: number): Promise<void> => {
        const entry = timers.find((t) => !t.fired && t.ms === expectedMs);
        if (!entry) {
            const summary = timers.map((t, i) => `[${i}] ms=${t.ms} fired=${t.fired}`).join(", ");
            throw new Error(`no pending timer at ${expectedMs} ms; have: ${summary || "<none>"}`);
        }
        entry.fired = true;
        const result = entry.fn();
        // _scheduleFcmReconnect's setTimeout callback is sync wrapping an async
        // method via `void this._attemptFcmReconnect()`. Drain microtasks so
        // pending promise chains (including the next scheduleReconnect call)
        // settle before the test reads `timers`.
        await Promise.resolve(result);
        await new Promise<void>((r) => setImmediate(r));
        await new Promise<void>((r) => setImmediate(r));
    };

    const pendingFcmTimers = (): ScheduledTimer[] =>
        timers.filter((t) => !t.fired && FCM_BACKOFF_DELAYS.has(t.ms));

    return { db, adapter, fcmListener, timers, fireTimer, pendingFcmTimers };
}

function getStateVal(db: MockDatabase, adapter: TestAdapter, id: string): unknown {
    const fullId = `${adapter.namespace}.${id}`;
    const state = db.getState(fullId);
    return (state as ioBroker.State | null | undefined)?.val;
}

describe("main adapter — FCM auto-reconnect on disconnect (v0.6.2)", () => {
    afterEach(() => {
        restoreAxios();
        sinon.restore();
        delete require.cache[MAIN_JS_PATH];
        delete require.cache[FCM_PATH];
        delete require.cache[LIVE_SESSION_PATH];
        delete require.cache[RCP_PATH];
        delete require.cache[SNAPSHOT_PATH];
        delete require.cache[TLS_PROXY_PATH];
        delete require.cache[SESSION_WATCHDOG_PATH];
    });

    it("disconnect event schedules a reconnect at 5 s (first attempt)", async () => {
        const fcmStart = sinon.stub().resolves(undefined);
        const f = await createFixture(fcmStart);

        // Sanity: onReady called start() exactly once at boot
        expect(fcmStart.callCount, "start() called once at boot").to.equal(1);
        // info.fcm_active is "healthy" after successful boot
        expect(getStateVal(f.db, f.adapter, "info.fcm_active")).to.equal("healthy");

        // MTalk drops
        f.fcmListener.emit("disconnect");

        // State flips to "disconnected" (existing behavior preserved)
        // setStateAsync is async; let it settle
        await new Promise<void>((r) => setImmediate(r));
        expect(getStateVal(f.db, f.adapter, "info.fcm_active")).to.equal("disconnected");

        // A reconnect timer is armed at 5 s
        const pending = f.pendingFcmTimers();
        expect(pending, "exactly one reconnect timer pending").to.have.lengthOf(1);
        expect(pending[0].ms, "first backoff is 5 s").to.equal(5_000);
    });

    it("event-poll safety net is armed even when FCM starts healthy (forum #84538)", async () => {
        // Regression for Reiner's report: @aracna/fcm hides a raw TCP socket
        // death, so a healthy-looking-but-dead FCM used to freeze motion forever
        // because event polling was only ever started on an FCM START failure.
        const fcmStart = sinon.stub().resolves(undefined);
        const f = await createFixture(fcmStart);

        expect(getStateVal(f.db, f.adapter, "info.fcm_active")).to.equal("healthy");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((f.adapter as any)._fcmHealthy, "FCM marked healthy").to.equal(true);
        // The always-on safety-net event poll must be armed despite a healthy FCM.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((f.adapter as any)._eventPollTimer, "event poll armed on healthy FCM").to.not.equal(
            undefined,
        );
    });

    it("on backoff fire: calls _fcmListener.start() and flips state to healthy on success", async () => {
        const fcmStart = sinon.stub().resolves(undefined);
        const f = await createFixture(fcmStart);

        f.fcmListener.emit("disconnect");
        await new Promise<void>((r) => setImmediate(r));

        // Fire the 5 s timer
        await f.fireTimer(5_000);

        expect(fcmStart.callCount, "start() called twice — boot + reconnect").to.equal(2);
        expect(getStateVal(f.db, f.adapter, "info.fcm_active")).to.equal("healthy");

        // No further timer queued after success
        const pending = f.pendingFcmTimers();
        expect(pending, "no further reconnect scheduled after success").to.have.lengthOf(0);
    });

    it("BUG-2: successful reconnect does NOT clear the always-on safety-net event poll (forum #84538)", async () => {
        // Before the fix, _attemptFcmReconnect called clearInterval(_eventPollTimer)
        // on success. This permanently killed the safety-net poll — a subsequent
        // silent FCM death would freeze motion forever with no polling fallback.
        // Fix: _fcmHealthy = true already throttles the tick; never stop the timer.
        const fcmStart = sinon.stub().resolves(undefined);
        const f = await createFixture(fcmStart);

        // Record what clearInterval was called with
        const clearedHandles: unknown[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (f.adapter as any).clearInterval = (h: unknown): void => {
            clearedHandles.push(h);
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pollTimerBefore = (f.adapter as any)._eventPollTimer;

        f.fcmListener.emit("disconnect");
        await new Promise<void>((r) => setImmediate(r));

        await f.fireTimer(5_000); // triggers _attemptFcmReconnect → success

        expect(getStateVal(f.db, f.adapter, "info.fcm_active")).to.equal("healthy");

        // The poll timer must NOT have been cleared during reconnect
        expect(clearedHandles, "clearInterval must NOT be called on reconnect").to.have.lengthOf(0);

        // The poll timer reference must be unchanged (still whatever it was at boot)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pollTimerAfter = (f.adapter as any)._eventPollTimer;
        expect(pollTimerAfter, "event poll timer unchanged after reconnect").to.equal(pollTimerBefore);

        // _fcmHealthy must be true so the safety net runs at slow cadence
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((f.adapter as any)._fcmHealthy, "FCM marked healthy after reconnect").to.equal(true);
    });

    it("backoff progression 5 s → 30 s → 120 s → 600 s on repeated failures", async () => {
        // start() rejects every time
        const fcmStart = sinon.stub();
        // Boot: resolve once so onReady completes
        fcmStart.onCall(0).resolves(undefined);
        // Reconnect attempts: keep failing
        fcmStart.rejects(new Error("MTalk still unreachable"));

        const f = await createFixture(fcmStart);

        f.fcmListener.emit("disconnect");
        await new Promise<void>((r) => setImmediate(r));

        // 1st reconnect at 5 s — fails → schedule 30 s
        await f.fireTimer(5_000);
        let pending = f.pendingFcmTimers();
        expect(pending.map((t) => t.ms), "after 1st failure: 30 s next").to.deep.equal([30_000]);

        // 2nd reconnect at 30 s — fails → schedule 120 s
        await f.fireTimer(30_000);
        pending = f.pendingFcmTimers();
        expect(pending.map((t) => t.ms), "after 2nd failure: 120 s next").to.deep.equal([120_000]);

        // 3rd reconnect at 120 s — fails → schedule 600 s (cap)
        await f.fireTimer(120_000);
        pending = f.pendingFcmTimers();
        expect(pending.map((t) => t.ms), "after 3rd failure: 600 s cap").to.deep.equal([600_000]);

        // 4th reconnect at 600 s — fails → stays at 600 s cap
        await f.fireTimer(600_000);
        pending = f.pendingFcmTimers();
        expect(pending.map((t) => t.ms), "subsequent failures stay at 600 s cap").to.deep.equal([
            600_000,
        ]);
    });

    it("successful reconnect resets backoff — next disconnect schedules 5 s again", async () => {
        const fcmStart = sinon.stub();
        fcmStart.onCall(0).resolves(undefined); // boot
        fcmStart.onCall(1).rejects(new Error("transient")); // 1st reconnect fails
        fcmStart.onCall(2).resolves(undefined); // 2nd reconnect succeeds
        fcmStart.resolves(undefined); // future calls succeed

        const f = await createFixture(fcmStart);

        f.fcmListener.emit("disconnect");
        await new Promise<void>((r) => setImmediate(r));

        await f.fireTimer(5_000); // fails → 30 s
        await f.fireTimer(30_000); // succeeds → backoff reset

        expect(getStateVal(f.db, f.adapter, "info.fcm_active")).to.equal("healthy");
        let pending = f.pendingFcmTimers();
        expect(pending, "no timer pending after success").to.have.lengthOf(0);

        // Second disconnect → starts at 5 s again
        f.fcmListener.emit("disconnect");
        await new Promise<void>((r) => setImmediate(r));
        pending = f.pendingFcmTimers();
        expect(pending.map((t) => t.ms), "backoff reset to 5 s on next disconnect").to.deep.equal([
            5_000,
        ]);
    });

    it("repeated disconnect events do not queue multiple timers (re-entrancy guard)", async () => {
        const fcmStart = sinon.stub().resolves(undefined);
        const f = await createFixture(fcmStart);

        // Three rapid-fire disconnects before any timer fires
        f.fcmListener.emit("disconnect");
        f.fcmListener.emit("disconnect");
        f.fcmListener.emit("disconnect");
        await new Promise<void>((r) => setImmediate(r));

        const pending = f.pendingFcmTimers();
        expect(pending, "exactly one timer despite 3 disconnect events").to.have.lengthOf(1);
        expect(pending[0].ms).to.equal(5_000);
    });

    it("onUnload clears the pending reconnect timer", async () => {
        const fcmStart = sinon.stub().resolves(undefined);
        const f = await createFixture(fcmStart);

        f.fcmListener.emit("disconnect");
        await new Promise<void>((r) => setImmediate(r));

        let pending = f.pendingFcmTimers();
        expect(pending, "timer armed before unload").to.have.lengthOf(1);
        const timerEntry = pending[0];

        await new Promise<void>((resolve) => {
            f.adapter.unloadHandler!(() => resolve());
        });

        // clearTimeout in our capturing stub marks fired=true
        expect(timerEntry.fired, "pending reconnect timer cleared on unload").to.equal(true);
    });
});
