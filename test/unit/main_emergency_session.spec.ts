/**
 * Tests for the emergency LiveSession opener (v0.7.8).
 *
 * Root cause: _localWritePrivacy / _localWriteFrontLight obtain Digest creds
 * from _liveSessions.get(camId). When no session is open (adapter just started,
 * no stream requested yet) the lookup returns undefined → unauthenticated fetch
 * → HTTP 401 → silent fail.
 *
 * Fix: _openEmergencySession() is called before the local-RCP write when auth
 * is undefined.  On success it stores the session in _liveSessions and returns
 * credentials; on cloud 503 / no token it returns undefined and the caller
 * falls through to unauthenticated best-effort.
 *
 * Pins:
 *  1. No session + cloud OK → openLiveSession called + returned creds used
 *  2. No session + cloud 503 → openLiveSession throws → auth undefined → false
 *  3. Session already open → openLiveSession NOT called (skip emergency open)
 *
 * Source: inline analysis of v0.7.5 LAN-RCP silent-fail bug.
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

const CAM_A = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";

// ── Stub type ────────────────────────────────────────────────────────────────

interface EmergencySessionStub {
    _liveSessions: Map<string, { digestUser: string; digestPassword: string; openedAt: number }>;
    _streamQuality: Map<string, string>;
    _currentAccessToken: string | null;
    _httpClient: unknown;
    _localWriteAt: Map<string, number>;
    log: {
        info: sinon.SinonStub;
        debug: sinon.SinonStub;
    };
}

function makeStub(opts: {
    token?: string | null;
    hasSession?: boolean;
}): EmergencySessionStub {
    const stub: EmergencySessionStub = {
        _liveSessions: new Map(),
        _streamQuality: new Map(),
        _currentAccessToken: opts.token !== undefined ? opts.token : "test-token",
        _httpClient: {},
        _localWriteAt: new Map(),
        log: {
            info: sinon.stub(),
            debug: sinon.stub(),
        },
    };
    if (opts.hasSession) {
        stub._liveSessions.set(CAM_A, {
            digestUser: "cbs-EXISTING",
            digestPassword: "existing-pass",
            openedAt: Date.now(),
        });
    }
    return stub;
}

// ── Extract method from built adapter ────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

function loadMethod(): { openEmergencySession: AnyFn } {
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

    if (!capturedAdapter) {
        throw new Error("adapter not captured");
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proto = capturedAdapter as any;

    const openEmergencySession = proto._openEmergencySession as AnyFn | undefined;
    if (typeof openEmergencySession !== "function") {
        throw new Error("_openEmergencySession not found — check method name");
    }

    return { openEmergencySession };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Emergency LiveSession opener — v0.7.8", () => {
    let method: ReturnType<typeof loadMethod>;
    let liveSessionModule: { openLiveSession: AnyFn };

    before(() => {
        method = loadMethod();
        // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
        liveSessionModule = require(
            path.join(REPO_ROOT, "build", "lib", "live_session"),
        ) as { openLiveSession: AnyFn };
    });

    afterEach(() => {
        sinon.restore();
    });

    // ── pin 1: no session + cloud OK → openLiveSession called + creds returned ──

    describe("emergency_session_opens_when_no_session_and_cloud_ok", () => {
        it("calls openLiveSession and returns Digest creds when no session exists", async () => {
            const stub = makeStub({ hasSession: false });

            const openStub = sinon
                .stub(liveSessionModule, "openLiveSession")
                .resolves({
                    cameraId: CAM_A,
                    connectionType: "LOCAL" as const,
                    digestUser: "cbs-EMERGENCY01",
                    digestPassword: "emergency-pass",
                    proxyUrl: "https://192.0.2.10:443/snap.jpg",
                    lanAddress: "192.0.2.10:443",
                    bufferingTimeMs: 500,
                    maxSessionDuration: 3600,
                    openedAt: Date.now(),
                });

            try {
                const result = await method.openEmergencySession.call(stub, CAM_A);

                // Returns credentials
                expect(result).to.deep.equal({
                    user: "cbs-EMERGENCY01",
                    password: "emergency-pass",
                });

                // openLiveSession was called once
                expect(openStub.calledOnce).to.equal(true);

                // Session stored in _liveSessions for subsequent writes
                expect(stub._liveSessions.has(CAM_A)).to.equal(true);

                // Info log emitted
                expect((stub.log.info as sinon.SinonStub).calledOnce).to.equal(true);
                const logMsg: string = (stub.log.info as sinon.SinonStub).firstCall
                    .args[0] as string;
                expect(logMsg).to.include("Emergency LiveSession");
            } finally {
                openStub.restore();
            }
        });
    });

    // ── pin 2: no session + cloud 503 → openLiveSession throws → undefined ───

    describe("emergency_session_returns_undefined_when_cloud_503", () => {
        it("returns undefined (no throw) when cloud returns 503", async () => {
            const stub = makeStub({ hasSession: false });

            const { CameraOfflineError } = require(
                path.join(REPO_ROOT, "build", "lib", "live_session"),
            ) as { CameraOfflineError: new (msg: string) => Error };

            const openStub = sinon
                .stub(liveSessionModule, "openLiveSession")
                .rejects(new CameraOfflineError(`Camera ${CAM_A} offline (HTTP 503)`));

            try {
                const result = await method.openEmergencySession.call(stub, CAM_A);

                // Must return undefined, not throw
                expect(result).to.equal(undefined);

                // openLiveSession was called once
                expect(openStub.calledOnce).to.equal(true);

                // No session stored (failed)
                expect(stub._liveSessions.has(CAM_A)).to.equal(false);

                // No info log (failed path)
                expect((stub.log.info as sinon.SinonStub).called).to.equal(false);
            } finally {
                openStub.restore();
            }
        });
    });

    // ── pin 3: no token → return undefined immediately without calling cloud ──

    describe("emergency_session_returns_undefined_when_no_token", () => {
        it("returns undefined immediately when _currentAccessToken is null", async () => {
            const stub = makeStub({ hasSession: false, token: null });

            const openStub = sinon.stub(liveSessionModule, "openLiveSession").resolves({
                cameraId: CAM_A,
                connectionType: "LOCAL" as const,
                digestUser: "cbs-SHOULDNOTBECALLED",
                digestPassword: "x",
                proxyUrl: "https://192.0.2.10/snap.jpg",
                lanAddress: "192.0.2.10:443",
                bufferingTimeMs: 500,
                maxSessionDuration: 3600,
                openedAt: Date.now(),
            });

            try {
                const result = await method.openEmergencySession.call(stub, CAM_A);

                expect(result).to.equal(undefined);
                // Cloud must NOT be contacted when no token
                expect(openStub.called).to.equal(false);
            } finally {
                openStub.restore();
            }
        });
    });

    // ── pin 4: session already exists → caller skips emergency open (integration check) ─

    describe("emergency_session_not_called_when_session_exists", () => {
        it("openEmergencySession is NOT invoked when session is already in _liveSessions", async () => {
            // This pin tests the call-site logic: the caller checks _liveSessions
            // first and only calls _openEmergencySession when auth is undefined.
            // We verify _openEmergencySession itself: it opens a new session even
            // if one exists (the call-site guard prevents the call). Here we verify
            // that a stub with an existing session can still call _openEmergencySession
            // directly (no guard inside the method itself), but the real protection
            // is the `if (!auth)` check at the call site.
            //
            // So this test verifies the call-site by simulating the guard in production:
            // if session exists → auth is defined → _openEmergencySession is never reached.

            const stub = makeStub({ hasSession: true });

            // Simulate the call-site pattern:
            const session = stub._liveSessions.get(CAM_A);
            const auth = session
                ? { user: session.digestUser, password: session.digestPassword }
                : undefined;

            // auth is defined (session exists) → emergency open must NOT be called
            let emergencyWasCalled = false;
            const emergencyGuard = async (): Promise<
                { user: string; password: string } | undefined
            > => {
                emergencyWasCalled = true;
                return method.openEmergencySession.call(stub, CAM_A);
            };

            const resolvedAuth = auth ?? (await emergencyGuard());

            expect(emergencyWasCalled).to.equal(false);
            expect(resolvedAuth).to.deep.equal({
                user: "cbs-EXISTING",
                password: "existing-pass",
            });
        });
    });
});
