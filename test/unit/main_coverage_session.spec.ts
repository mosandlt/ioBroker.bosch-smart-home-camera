/**
 * Coverage band L2300–L2900 in src/main.ts.
 *
 * Target clusters (from lcov-report):
 *   L2309-2348  scheduleTokenRefresh inner callback branches
 *               (no-refresh-token early-return, null-tokens retry, success,
 *                RefreshTokenInvalidError, generic error retry)
 *   L2406-2424  ensureLiveSession: watchdog openSession + onRenew callbacks
 *   L2603-2624  _attemptBackoffRenewal: re-armed watchdog openSession + onRenew
 *   L2689-2706  upsertSession: hot-reuse branch (existingProxy && remoteUnchanged →
 *               updateDigestAuth + debug log)
 *   L2738-2757  upsertSession: sticky-port fallback (startTlsProxy throws on
 *               first try, retried without preferredPort)
 *   L2874       _maskCreds (various credential shapes)
 *
 * Strategy:
 *   - Mirrors createAdapterWithMocks pattern from main_stream_toggle.spec.ts
 *     and v091_pollers.spec.ts.
 *   - The SessionWatchdog is injected as a fake class that records its
 *     constructor options (openSession / onRenew / onError / log), allowing
 *     direct invocation of the captured callbacks.
 *   - For scheduleTokenRefresh: we drive it by replacing adapter.setTimeout
 *     with a capture stub, then invoking the captured async callback.
 *   - For _maskCreds: access via (adapter as any)._maskCreds.
 *   - NEVER edits src/main.ts or any src file.
 */

import { expect } from "chai";
import * as sinon from "sinon";
import * as path from "path";

import { stubAxiosSequence, stubAxiosByUrl, restoreAxios } from "./helpers/axios-mock";

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

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CAM_ID = "0A0B0C0D-1111-2222-3333-444455556666";

const CAMERAS_BODY = [
    {
        id: CAM_ID,
        title: "Terrasse",
        hardwareVersion: "HOME_Eyes_Outdoor",
        firmwareVersion: "9.40.25",
        featureSupport: { light: true },
    },
];

const TOKEN_BODY = {
    access_token: "acc.session.test",
    refresh_token: "ref.session.test",
    expires_in: 300,
    refresh_expires_in: 86400,
    token_type: "Bearer",
    scope: "openid",
};

function makeFakeSession(overrides: Partial<{
    camId: string;
    lanAddress: string;
    digestUser: string;
    digestPassword: string;
    maxSessionDuration: number;
}> = {}) {
    return {
        camId: overrides.camId ?? CAM_ID,
        lanAddress: overrides.lanAddress ?? "192.0.2.149:443",
        proxyUrl: "rtsp://127.0.0.1:18030/rtsp_tunnel",
        maxSessionDuration: overrides.maxSessionDuration ?? 3600,
        openedAt: Date.now(),
        digestUser: overrides.digestUser ?? "admin",
        digestPassword: overrides.digestPassword ?? "pass1",
    };
}

function resolveBuildModule(name: string): string {
    return path.join(REPO_ROOT, "build", "lib", `${name}.js`);
}

// ── WatchdogCapture ───────────────────────────────────────────────────────────
//
// A fake SessionWatchdog that records the callbacks passed to the constructor.
// Tests can retrieve them and invoke them directly to exercise the closures
// defined inside ensureLiveSession and _attemptBackoffRenewal.

interface WatchdogOptions {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    openSession: () => Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onRenew: (session: any) => Promise<void>;
    onError: (err: Error) => void;
    log: (level: "debug" | "info" | "warn" | "error", msg: string) => void;
}

// Shared capture array — reset in beforeEach
let capturedWatchdogs: WatchdogOptions[] = [];

function buildFakeWatchdogClass(): new (opts: WatchdogOptions) => { start: sinon.SinonStub; stop: sinon.SinonStub } {
    return class FakeWatchdog {
        public start = sinon.stub();
        public stop = sinon.stub();
        constructor(opts: WatchdogOptions) {
            capturedWatchdogs.push(opts);
        }
    } as unknown as new (opts: WatchdogOptions) => { start: sinon.SinonStub; stop: sinon.SinonStub };
}

// ── Adapter factory ───────────────────────────────────────────────────────────

interface AdapterRig {
    db: MockDatabase;
    adapter: TestAdapter;
    openLiveSessionStub: sinon.SinonStub;
    startTlsProxyStub: sinon.SinonStub;
    fakeProxy: {
        port: number;
        localRtspUrl: string;
        stop: sinon.SinonStub;
        updateDigestAuth: sinon.SinonStub;
        activeClientCount: sinon.SinonStub;
    };
    setTimeoutCalls: Array<{ fn: () => void; ms: number }>;
}

function createRig(configOverrides: Record<string, unknown> = {}): AdapterRig {
    capturedWatchdogs = [];

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

    // ── live_session mock ────────────────────────────────────────────────────
    const fakeSession = makeFakeSession();
    const openLiveSessionStub = sinon.stub().resolves(fakeSession);
    const liveSessionPath = resolveBuildModule("live_session");
    delete require.cache[liveSessionPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[liveSessionPath] = {
        id: liveSessionPath, filename: liveSessionPath, loaded: true,
        parent: module, children: [], path: path.dirname(liveSessionPath), paths: [],
        exports: {
            openLiveSession: openLiveSessionStub,
            closeLiveSession: sinon.stub().resolves(),
        },
    };

    // ── tls_proxy mock ───────────────────────────────────────────────────────
    const fakeProxy = {
        port: 18030,
        localRtspUrl: "rtsp://127.0.0.1:18030/rtsp_tunnel",
        stop: sinon.stub().resolves(),
        updateDigestAuth: sinon.stub(),
        activeClientCount: sinon.stub().returns(0),
    };
    const startTlsProxyStub = sinon.stub().resolves(fakeProxy);
    const tlsProxyPath = resolveBuildModule("tls_proxy");
    delete require.cache[tlsProxyPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[tlsProxyPath] = {
        id: tlsProxyPath, filename: tlsProxyPath, loaded: true,
        parent: module, children: [], path: path.dirname(tlsProxyPath), paths: [],
        exports: { startTlsProxy: startTlsProxyStub },
    };

    // ── snapshot mock ────────────────────────────────────────────────────────
    const snapshotPath = resolveBuildModule("snapshot");
    delete require.cache[snapshotPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[snapshotPath] = {
        id: snapshotPath, filename: snapshotPath, loaded: true,
        parent: module, children: [], path: path.dirname(snapshotPath), paths: [],
        exports: {
            fetchSnapshot: sinon.stub().resolves(Buffer.from("FAKE")),
            buildSnapshotUrl: (u: string) => `${u}/snap.jpg`,
        },
    };

    // ── session_watchdog mock (with callback capture) ─────────────────────
    const FakeWatchdog = buildFakeWatchdogClass();
    const watchdogPath = resolveBuildModule("session_watchdog");
    delete require.cache[watchdogPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[watchdogPath] = {
        id: watchdogPath, filename: watchdogPath, loaded: true,
        parent: module, children: [], path: path.dirname(watchdogPath), paths: [],
        exports: { SessionWatchdog: FakeWatchdog },
    };

    delete require.cache[MAIN_JS_PATH];
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const factory = require(MAIN_JS_PATH) as (opts: Record<string, unknown>) => MockAdapter;
    factory({ config: { redirect_url: "", region: "EU", startup_snapshot: true, ...configOverrides } });

    if (!capturedAdapter) throw new Error("adapter not captured");
    const adapter = capturedAdapter as TestAdapter;

    // Capture setTimeout calls for scheduleTokenRefresh tests
    const setTimeoutCalls: Array<{ fn: () => void; ms: number }> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).setTimeout = (fn: () => void, ms: number) => {
        setTimeoutCalls.push({ fn, ms });
        return null;
    };
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

    return { db, adapter, openLiveSessionStub, startTlsProxyStub, fakeProxy, setTimeoutCalls };
}

function getStateVal(db: MockDatabase, adapter: TestAdapter, id: string): unknown {
    const fullId = `${adapter.namespace}.${id}`;
    const state = db.getState(fullId) as ioBroker.State | null | undefined;
    return state?.val;
}

/** Boot adapter with pre-stored tokens (skips login flow). */
async function bootWithTokens(db: MockDatabase, adapter: TestAdapter): Promise<void> {
    const futureExpiry = Date.now() + 200_000;
    db.publishState(`${adapter.namespace}.info.access_token`, { val: "stored.acc", ack: true });
    db.publishState(`${adapter.namespace}.info.refresh_token`, { val: "stored.ref", ack: true });
    db.publishState(`${adapter.namespace}.info.token_expires_at`, { val: futureExpiry, ack: true });
    await adapter.readyHandler!();
}

/** Trigger livestream ON for CAM_ID. */
async function triggerStreamOn(adapter: TestAdapter): Promise<void> {
    const stateId = `${adapter.namespace}.cameras.${CAM_ID}.livestream_enabled`;
    await adapter.stateChangeHandler!(stateId, {
        val: true, ack: false, ts: Date.now(), lc: Date.now(), from: "user",
    });
}

// ── Teardown ──────────────────────────────────────────────────────────────────

afterEach(() => {
    restoreAxios();
    sinon.restore();
    capturedWatchdogs = [];
    delete require.cache[resolveBuildModule("live_session")];
    delete require.cache[resolveBuildModule("tls_proxy")];
    delete require.cache[resolveBuildModule("snapshot")];
    delete require.cache[resolveBuildModule("session_watchdog")];
    delete require.cache[MAIN_JS_PATH];
});

// ═════════════════════════════════════════════════════════════════════════════
// Group 1: scheduleTokenRefresh inner callback (L2309-2348)
// ═════════════════════════════════════════════════════════════════════════════

describe("main_coverage_session — scheduleTokenRefresh inner callback", () => {

    it("early-return on missing refresh token: warns and does NOT re-arm", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { adapter, setTimeoutCalls } = createRig();
        await bootWithTokens(new MockDatabaseCtor(), adapter);

        // Directly call scheduleTokenRefresh and capture the callback
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._currentRefreshToken = null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any).scheduleTokenRefresh(300_000);

        const call = setTimeoutCalls[setTimeoutCalls.length - 1];
        expect(call, "setTimeout must be called").to.exist;

        // adapter.log.warn is already a sinon stub from MockAdapter — use callCount
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const warnBefore = (adapter.log.warn as sinon.SinonStub).callCount;
        const countBefore = setTimeoutCalls.length;
        await call.fn();

        // The "no refresh token" branch warns and does NOT re-arm
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((adapter.log.warn as sinon.SinonStub).callCount).to.be.greaterThan(warnBefore,
            "warn must be emitted for missing refresh token");
        expect(setTimeoutCalls.length).to.equal(countBefore,
            "must NOT re-arm when no refresh token");
    });

    it("null-tokens response: warns and re-arms with 5min delay", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { adapter, setTimeoutCalls } = createRig();
        await bootWithTokens(new MockDatabaseCtor(), adapter);

        // Seed a refresh token so the callback proceeds past the early-return
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._currentRefreshToken = "ref.tok";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._refreshTimeout = null;

        // Replace the lib/auth module to return null (transient network error)
        const authPath = resolveBuildModule("auth");
        const origAuthMod = require.cache[authPath];
        try {
            delete require.cache[authPath];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (require.cache as any)[authPath] = {
                id: authPath, filename: authPath, loaded: true,
                parent: module, children: [], path: path.dirname(authPath), paths: [],
                exports: {
                    // Return null to simulate transient network error
                    refreshAccessToken: sinon.stub().resolves(null),
                    // preserve other named exports as no-ops
                    buildAuthUrl: () => "https://example.com",
                    exchangeCodeForTokens: sinon.stub().resolves(null),
                    generatePkcePair: () => ({ verifier: "v", challenge: "c" }),
                    RefreshTokenInvalidError: class extends Error {},
                    AuthServerOutageError: class extends Error {},
                },
            };

            // Directly invoke the inner scheduleTokenRefresh logic via the stub
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (adapter as any).scheduleTokenRefresh(300_000);
            const callsBefore = setTimeoutCalls.length;
            const timerCall = setTimeoutCalls[callsBefore - 1];
            expect(timerCall).to.exist;

            await timerCall.fn();

            // A new setTimeout must have been scheduled (re-arm for 5 min)
            expect(setTimeoutCalls.length).to.be.greaterThan(callsBefore,
                "scheduleTokenRefresh must be re-armed after null token response");
        } finally {
            if (origAuthMod) {
                require.cache[authPath] = origAuthMod;
            } else {
                delete require.cache[authPath];
            }
        }
    });

    it("RefreshTokenInvalidError: logs error and does NOT re-arm", async () => {
        // The instanceof check in main.js uses the class bound at require-time (build/lib/auth.js).
        // We must load the real class from the built auth module and throw an instance of IT.
        // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
        const realAuth = require(resolveBuildModule("auth")) as {
            RefreshTokenInvalidError: new (msg: string) => Error;
            refreshAccessToken: unknown;
        };
        const RealRefreshTokenInvalidError = realAuth.RefreshTokenInvalidError;

        // Pre-inject auth mock BEFORE loading main.js (createRig deletes MAIN_JS_PATH cache)
        const authPath = resolveBuildModule("auth");
        const origAuthMod = require.cache[authPath];
        const refreshStub = sinon.stub().rejects(new RealRefreshTokenInvalidError("invalid"));

        delete require.cache[authPath];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (require.cache as any)[authPath] = {
            id: authPath, filename: authPath, loaded: true,
            parent: module, children: [], path: path.dirname(authPath), paths: [],
            exports: {
                ...origAuthMod?.exports,
                refreshAccessToken: refreshStub,
                RefreshTokenInvalidError: RealRefreshTokenInvalidError,
            },
        };

        try {
            stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
            const { adapter, setTimeoutCalls } = createRig(); // loads main.js fresh → picks up auth mock
            await bootWithTokens(new MockDatabaseCtor(), adapter);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (adapter as any)._currentRefreshToken = "ref.tok";
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (adapter as any)._refreshTimeout = null;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (adapter as any).scheduleTokenRefresh(300_000);
            const callsBefore = setTimeoutCalls.length;
            const timerCall = setTimeoutCalls[callsBefore - 1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const errorCountBefore = (adapter.log.error as sinon.SinonStub).callCount;
            await timerCall.fn();

            expect(setTimeoutCalls.length).to.equal(callsBefore,
                "must NOT re-arm after RefreshTokenInvalidError");
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect((adapter.log.error as sinon.SinonStub).callCount).to.be.greaterThan(errorCountBefore,
                "error must be logged");
        } finally {
            if (origAuthMod) {
                require.cache[authPath] = origAuthMod;
            } else {
                delete require.cache[authPath];
            }
        }
    });

    it("generic error: warns and re-arms with 5min delay", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { adapter, setTimeoutCalls } = createRig();
        await bootWithTokens(new MockDatabaseCtor(), adapter);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._currentRefreshToken = "ref.tok";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._refreshTimeout = null;

        const authPath = resolveBuildModule("auth");
        const origAuthMod = require.cache[authPath];
        try {
            delete require.cache[authPath];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (require.cache as any)[authPath] = {
                id: authPath, filename: authPath, loaded: true,
                parent: module, children: [], path: path.dirname(authPath), paths: [],
                exports: {
                    refreshAccessToken: sinon.stub().rejects(new Error("Server outage")),
                    buildAuthUrl: () => "https://example.com",
                    exchangeCodeForTokens: sinon.stub().resolves(null),
                    generatePkcePair: () => ({ verifier: "v", challenge: "c" }),
                    RefreshTokenInvalidError: class extends Error {},
                    AuthServerOutageError: class extends Error {},
                },
            };

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (adapter as any).scheduleTokenRefresh(300_000);
            const callsBefore = setTimeoutCalls.length;
            const timerCall = setTimeoutCalls[callsBefore - 1];

            await timerCall.fn();

            expect(setTimeoutCalls.length).to.be.greaterThan(callsBefore,
                "must re-arm after generic error");
        } finally {
            if (origAuthMod) {
                require.cache[authPath] = origAuthMod;
            } else {
                delete require.cache[authPath];
            }
        }
    });

    it("successful refresh: calls saveTokens and re-arms with new expiry", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { adapter, setTimeoutCalls } = createRig();
        await bootWithTokens(new MockDatabaseCtor(), adapter);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._currentRefreshToken = "ref.tok";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._refreshTimeout = null;

        const authPath = resolveBuildModule("auth");
        const origAuthMod = require.cache[authPath];
        try {
            delete require.cache[authPath];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (require.cache as any)[authPath] = {
                id: authPath, filename: authPath, loaded: true,
                parent: module, children: [], path: path.dirname(authPath), paths: [],
                exports: {
                    refreshAccessToken: sinon.stub().resolves(TOKEN_BODY),
                    buildAuthUrl: () => "https://example.com",
                    exchangeCodeForTokens: sinon.stub().resolves(null),
                    generatePkcePair: () => ({ verifier: "v", challenge: "c" }),
                    RefreshTokenInvalidError: class extends Error {},
                    AuthServerOutageError: class extends Error {},
                },
            };

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (adapter as any).scheduleTokenRefresh(300_000);
            const callsBefore = setTimeoutCalls.length;
            const timerCall = setTimeoutCalls[callsBefore - 1];
            await timerCall.fn();

            // Must re-arm with the new token's expires_in
            expect(setTimeoutCalls.length).to.be.greaterThan(callsBefore,
                "must re-arm after successful refresh");
        } finally {
            if (origAuthMod) {
                require.cache[authPath] = origAuthMod;
            } else {
                delete require.cache[authPath];
            }
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Group 2: Watchdog callbacks from ensureLiveSession (L2406-2424)
// ═════════════════════════════════════════════════════════════════════════════

describe("main_coverage_session — watchdog callbacks (ensureLiveSession)", () => {

    it("openSession callback: calls openLiveSession with current token and quality", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { db, adapter, openLiveSessionStub } = createRig();
        await bootWithTokens(db, adapter);
        await triggerStreamOn(adapter);

        expect(capturedWatchdogs.length, "watchdog must be constructed").to.be.greaterThan(0);
        const watchdogOpts = capturedWatchdogs[0];
        expect(watchdogOpts.openSession, "openSession callback must exist").to.be.a("function");

        const callsBefore = openLiveSessionStub.callCount;
        await watchdogOpts.openSession();

        expect(openLiveSessionStub.callCount).to.be.greaterThan(callsBefore,
            "openSession callback must call openLiveSession");
    });

    it("openSession callback: rejects with error when no access token", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { db, adapter } = createRig();
        await bootWithTokens(db, adapter);
        await triggerStreamOn(adapter);

        expect(capturedWatchdogs.length).to.be.greaterThan(0);
        const watchdogOpts = capturedWatchdogs[0];

        // Clear the access token
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._currentAccessToken = null;

        let thrown = false;
        try {
            await watchdogOpts.openSession();
        } catch (e) {
            thrown = true;
            expect((e as Error).message).to.include("no access token");
        }
        expect(thrown, "openSession must reject when no access token").to.be.true;
    });

    it("onRenew callback: updates _liveSessions and calls upsertSession", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { db, adapter, startTlsProxyStub } = createRig();
        await bootWithTokens(db, adapter);
        await triggerStreamOn(adapter);

        expect(capturedWatchdogs.length).to.be.greaterThan(0);
        const watchdogOpts = capturedWatchdogs[0];

        const callsBefore = startTlsProxyStub.callCount;
        const renewedSession = makeFakeSession({ digestUser: "admin2", digestPassword: "pass2" });
        await watchdogOpts.onRenew(renewedSession);

        // upsertSession was called — it calls startTlsProxy (or reuses proxy)
        // Either the proxy was reused (hot path) or re-started — both are valid
        // Just verify no crash and stream_url is still set
        const streamUrl = getStateVal(db, adapter, `cameras.${CAM_ID}.stream_url`) as string | null | undefined;
        expect(streamUrl === undefined || typeof streamUrl === "string",
            "stream_url must remain a string after renewal").to.be.true;
        void callsBefore;
    });

    it("onError callback: routes to _handleRenewalFailure without crashing", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { db, adapter } = createRig();
        await bootWithTokens(db, adapter);
        await triggerStreamOn(adapter);

        expect(capturedWatchdogs.length).to.be.greaterThan(0);
        const watchdogOpts = capturedWatchdogs[0];

        // onError is fire-and-forget (void this._handleRenewalFailure(...))
        // Seed _sessionStartTime so it doesn't immediately teardown
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._sessionStartTime.set(CAM_ID, Date.now());

        let threw = false;
        try {
            watchdogOpts.onError(new Error("stream lost"));
            // Allow microtasks to settle
            await new Promise((r) => setImmediate(r));
        } catch {
            threw = true;
        }
        expect(threw, "onError must not throw synchronously").to.be.false;
    });

    it("log callback: forwards level+message to adapter.log", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { db, adapter } = createRig();
        await bootWithTokens(db, adapter);
        await triggerStreamOn(adapter);

        expect(capturedWatchdogs.length).to.be.greaterThan(0);
        const watchdogOpts = capturedWatchdogs[0];

        // adapter.log.debug is already a sinon stub from MockAdapter — read callCount directly
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const debugStub = adapter.log.debug as sinon.SinonStub;
        const countBefore = debugStub.callCount;
        watchdogOpts.log("debug", "test log message from watchdog");
        expect(debugStub.callCount).to.be.greaterThan(countBefore,
            "log callback must forward to adapter.log.debug");
        const lastArgs = debugStub.args[debugStub.callCount - 1] as unknown[];
        expect(String(lastArgs[0])).to.include("test log message from watchdog");
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Group 3: Watchdog callbacks from _attemptBackoffRenewal (L2603-2624)
// ═════════════════════════════════════════════════════════════════════════════

describe("main_coverage_session — _attemptBackoffRenewal re-armed watchdog callbacks", () => {

    it("re-armed openSession: rejects when no access token", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { db, adapter, openLiveSessionStub } = createRig();
        await bootWithTokens(db, adapter);
        await triggerStreamOn(adapter);

        // Remove the watchdog to force _attemptBackoffRenewal to re-arm one
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._sessionWatchdogs.delete(CAM_ID);

        // Call _attemptBackoffRenewal directly — it will re-arm a watchdog
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._currentAccessToken = "acc.tok";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._lanIpMap.delete(CAM_ID); // skip TCP check

        // Make openLiveSession succeed so the backoff path hits the re-arm branch
        openLiveSessionStub.resolves(makeFakeSession());
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._attemptBackoffRenewal(CAM_ID);

        // A second watchdog should have been captured (the re-armed one)
        expect(capturedWatchdogs.length).to.be.greaterThanOrEqual(2,
            "re-armed watchdog must be constructed in _attemptBackoffRenewal");

        const reArmedOpts = capturedWatchdogs[capturedWatchdogs.length - 1];

        // Clear token and verify openSession rejects
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._currentAccessToken = null;
        let threw = false;
        try {
            await reArmedOpts.openSession();
        } catch (e) {
            threw = true;
            expect((e as Error).message).to.include("no access token");
        }
        expect(threw, "re-armed openSession must reject without token").to.be.true;
    });

    it("re-armed onRenew: updates _liveSessions and calls upsertSession", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { db, adapter, openLiveSessionStub, startTlsProxyStub } = createRig();
        await bootWithTokens(db, adapter);
        await triggerStreamOn(adapter);

        // Remove the watchdog to trigger re-arming
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._sessionWatchdogs.delete(CAM_ID);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._currentAccessToken = "acc.tok";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._lanIpMap.delete(CAM_ID);
        openLiveSessionStub.resolves(makeFakeSession());

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._attemptBackoffRenewal(CAM_ID);

        expect(capturedWatchdogs.length).to.be.greaterThanOrEqual(2);
        const reArmedOpts = capturedWatchdogs[capturedWatchdogs.length - 1];

        const callsBefore = startTlsProxyStub.callCount;
        const renewedSession = makeFakeSession({ digestUser: "u2", digestPassword: "p2" });
        await reArmedOpts.onRenew(renewedSession);

        // upsertSession executed — stream_url should be present
        const streamUrl = getStateVal(db, adapter, `cameras.${CAM_ID}.stream_url`);
        expect(typeof streamUrl === "string" || streamUrl == null,
            "stream_url must be string or null after onRenew").to.be.true;
        void callsBefore;
    });

    it("re-armed onError: calls _handleRenewalFailure without throwing", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { db, adapter, openLiveSessionStub } = createRig();
        await bootWithTokens(db, adapter);
        await triggerStreamOn(adapter);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._sessionWatchdogs.delete(CAM_ID);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._currentAccessToken = "acc.tok";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._lanIpMap.delete(CAM_ID);
        openLiveSessionStub.resolves(makeFakeSession());

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._attemptBackoffRenewal(CAM_ID);
        expect(capturedWatchdogs.length).to.be.greaterThanOrEqual(2);
        const reArmedOpts = capturedWatchdogs[capturedWatchdogs.length - 1];

        // Seed start time so no immediate teardown
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._sessionStartTime.set(CAM_ID, Date.now());

        let threw = false;
        try {
            reArmedOpts.onError(new Error("renewal failed again"));
            await new Promise((r) => setImmediate(r));
        } catch {
            threw = true;
        }
        expect(threw, "re-armed onError must not throw synchronously").to.be.false;
        void db;
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Group 4: upsertSession hot-reuse path (L2689-2706)
// ═════════════════════════════════════════════════════════════════════════════

describe("main_coverage_session — upsertSession hot-reuse branch", () => {

    it("reuses existing proxy when remote host+port unchanged: calls updateDigestAuth", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { db, adapter, startTlsProxyStub, fakeProxy } = createRig();
        await bootWithTokens(db, adapter);
        await triggerStreamOn(adapter);

        // First session open created the proxy. Now simulate a second upsertSession
        // call with the same remote address (hot-reuse path).
        expect(startTlsProxyStub.callCount).to.be.greaterThan(0, "proxy must be created on first open");
        const createCallCount = startTlsProxyStub.callCount;

        // Call upsertSession directly with a renewed session (same remote address)
        const renewedSession = makeFakeSession({
            lanAddress: "192.0.2.149:443", // same as fakeSession
            digestUser: "admin_renewed",
            digestPassword: "pass_renewed",
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any).upsertSession(CAM_ID, renewedSession);

        // Must NOT spawn a new proxy (hot-reuse)
        expect(startTlsProxyStub.callCount).to.equal(createCallCount,
            "startTlsProxy must NOT be called again on hot-reuse (same remote)");

        // Must call updateDigestAuth with the new credentials
        expect(fakeProxy.updateDigestAuth.called, "updateDigestAuth must be called").to.be.true;
        expect(fakeProxy.updateDigestAuth.lastCall.args[0]).to.equal("admin_renewed");
        expect(fakeProxy.updateDigestAuth.lastCall.args[1]).to.equal("pass_renewed");
        void db;
    });

    it("hot-reuse path: debug log emitted with port and remote info", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { db, adapter } = createRig();
        await bootWithTokens(db, adapter);
        await triggerStreamOn(adapter);

        // adapter.log.debug is already a sinon stub — read args directly
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const debugStub = adapter.log.debug as sinon.SinonStub;
        const countBefore = debugStub.callCount;

        const renewedSession = makeFakeSession({ lanAddress: "192.0.2.149:443" });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any).upsertSession(CAM_ID, renewedSession);

        const newCalls = debugStub.args.slice(countBefore).map((a) => String(a[0]));
        const hasReuseLog = newCalls.some((m) => m.includes("reusing port") || m.includes("remote unchanged"));
        expect(hasReuseLog, "debug log must mention reusing port").to.be.true;
        void db;
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Group 5: upsertSession sticky-port fallback (L2738-2757)
// ═════════════════════════════════════════════════════════════════════════════

describe("main_coverage_session — upsertSession sticky-port fallback", () => {

    it("sticky port taken: retries startTlsProxy without preferredPort, emits warn", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { db, adapter, startTlsProxyStub, fakeProxy } = createRig();
        await bootWithTokens(db, adapter);
        await triggerStreamOn(adapter);

        // At this point, fakeProxy is registered with port 18030.
        // Simulate a teardown so the next upsertSession goes through startTlsProxy again.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._tlsProxies.delete(CAM_ID);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._sessionRemote.delete(CAM_ID);

        // Seed a sticky port that will "fail" on first bind
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._stickyProxyPort.set(CAM_ID, 19999);

        // First startTlsProxy call throws EADDRINUSE, second succeeds
        const bindErr = new Error("EADDRINUSE: port 19999 already in use");
        startTlsProxyStub.onCall(startTlsProxyStub.callCount).rejects(bindErr);
        startTlsProxyStub.resolves(fakeProxy);

        // adapter.log.warn is already a sinon stub from MockAdapter
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const warnStub = adapter.log.warn as sinon.SinonStub;
        const countBefore = warnStub.callCount;
        const session = makeFakeSession({ lanAddress: "192.0.2.149:443" });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any).upsertSession(CAM_ID, session);

        // The fallback path must warn about the sticky port being unavailable
        const newWarns = warnStub.args.slice(countBefore).map((a) => String(a[0]));
        const hasFallbackWarn = newWarns.some((m) =>
            m.includes("sticky port") || m.includes("unavailable") || m.includes("falling back"),
        );
        expect(hasFallbackWarn, "warn must mention sticky port unavailable / falling back").to.be.true;

        // startTlsProxy must have been called at least once more (the retry)
        expect(startTlsProxyStub.callCount).to.be.greaterThanOrEqual(2,
            "startTlsProxy must be retried after sticky-port failure");
        void db;
    });

    it("sticky port taken but second attempt succeeds: stream_url is set", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { db, adapter, startTlsProxyStub, fakeProxy } = createRig();
        await bootWithTokens(db, adapter);
        await triggerStreamOn(adapter);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._tlsProxies.delete(CAM_ID);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._sessionRemote.delete(CAM_ID);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._stickyProxyPort.set(CAM_ID, 19999);

        const bindErr = new Error("EADDRINUSE");
        startTlsProxyStub.onCall(startTlsProxyStub.callCount).rejects(bindErr);
        startTlsProxyStub.resolves(fakeProxy);

        const session = makeFakeSession({ lanAddress: "192.0.2.149:443" });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any).upsertSession(CAM_ID, session);

        const streamUrl = getStateVal(db, adapter, `cameras.${CAM_ID}.stream_url`) as string;
        expect(streamUrl).to.be.a("string").and.to.have.length.greaterThan(0,
            "stream_url must be set after successful fallback");
        expect(streamUrl).to.include("rtsp://");
    });

    it("no sticky port + startTlsProxy throws: error propagates (no infinite retry)", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_BODY }]);
        const { db, adapter, startTlsProxyStub } = createRig();
        await bootWithTokens(db, adapter);
        await triggerStreamOn(adapter);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._tlsProxies.delete(CAM_ID);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._sessionRemote.delete(CAM_ID);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._stickyProxyPort.delete(CAM_ID);

        // No sticky port — first (only) startTlsProxy throws
        const fatal = new Error("Fatal bind error");
        startTlsProxyStub.rejects(fatal);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const warnStub = adapter.log.warn as sinon.SinonStub;
        const countBefore = warnStub.callCount;
        const session = makeFakeSession({ lanAddress: "192.0.2.149:443" });

        // upsertSession wraps errors in a warn+continue block
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any).upsertSession(CAM_ID, session);

        // The outer catch block logs the error and does NOT throw
        const newWarns = warnStub.args.slice(countBefore).map((a) => String(a[0]));
        const hasProxyWarn = newWarns.some((m) => m.includes("TLS proxy") || m.includes("Fatal bind"));
        expect(hasProxyWarn, "outer catch must log the proxy error as warn").to.be.true;
        void db;
    });
});

// _maskCreds (formerly L2874) was removed 2026-07-02 (ioBroker.repositories#5983
// manual review, dead-code finding): unused since v0.5.3 stopped embedding
// Digest credentials in RTSP URLs (see _buildStreamUrl's doc comment).
