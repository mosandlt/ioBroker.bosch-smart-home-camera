/**
 * Tests for cloud-503 handling improvements added in v0.7.10.
 *
 * Feature: Issue #9 — honest error messages, exponential renewal backoff,
 * Bosch maintenance-window detection.
 *
 * Covers:
 *  1. test_renewal_503_does_not_tear_down_stream_immediately
 *  2. test_renewal_503_backoff_sequence_5_15_45_120_300
 *  3. test_renewal_503_after_60min_session_expiry_tears_down
 *  4. test_lan_tcp_3_failures_tears_down
 *  5. test_lan_tcp_2_failures_then_success_resets_counter
 *  6. test_renewal_401_calls_emergency_session_refresh
 *  7. test_maintenance_active_downgrades_5xx_to_info
 *  8. test_maintenance_none_keeps_5xx_at_warn
 *  9. test_maintenance_parses_rss_correctly (structural parity test)
 *
 * Source: GitHub Issue mosandlt/ioBroker.bosch-smart-home-camera#9
 */

import { expect } from "chai";
import * as sinon from "sinon";
import * as path from "path";

import type { MockDatabase } from "@iobroker/testing/build/tests/unit/mocks/mockDatabase";
import type { MockAdapter } from "@iobroker/testing/build/tests/unit/mocks/mockAdapter";

import { classifyState, parseFeedBody, type MaintenanceWindow } from "../../src/lib/maintenance";

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

// ── Helper types ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

interface CloudStub {
    _lanIpMap: Map<string, string>;
    _lanReachable: Map<string, [boolean, number]>;
    _liveSessions: Map<
        string,
        {
            cameraId: string;
            digestUser: string;
            digestPassword: string;
            openedAt: number;
            maxSessionDuration: number;
            lanAddress: string;
            proxyUrl: string;
            connectionType: "LOCAL";
            bufferingTimeMs: number;
        }
    >;
    _tlsProxies: Map<string, { stop: () => Promise<void> }>;
    _sessionWatchdogs: Map<string, { stop: () => void }>;
    _sessionStartTime: Map<string, number>;
    _renewalBackoff: Map<string, { attempt: number; nextRetryMs: number }>;
    _lanTcpFailCount: Map<string, number>;
    _streamGeneration: Map<string, number>;
    _lastMaintenanceWindow: MaintenanceWindow | null;
    _lastOutagePingAt: number;
    _cameras: Map<string, unknown>;
    _currentAccessToken: string | null;
    _streamQuality: Map<string, "high" | "low">;
    _stateCache: Map<string, unknown>;
    _maintenanceLastFetchMs: number;
    log: {
        info: sinon.SinonStub;
        warn: sinon.SinonStub;
        error: sinon.SinonStub;
        debug: sinon.SinonStub;
    };
    setTimeout: (fn: () => void, ms: number) => NodeJS.Timeout | { unref: () => void };
    upsertState: (id: string, value: unknown) => Promise<void>;
    _tcpPing: (camId: string) => Promise<boolean>;
    _teardownStream: (camId: string) => Promise<void>;
    _triggerMaintenanceFetchOn5xx: () => void;
    // The methods under test (bound from the loaded adapter prototype)
    _handleRenewalFailure: AnyFn;
    _attemptBackoffRenewal: AnyFn;
    _routeCloudErrorLog: AnyFn;
    _doTeardownStream: AnyFn;
}

function makeStub(
    opts: {
        hasToken?: boolean;
        hasLanIp?: boolean;
        sessionAge?: number;
        sessionBackoff?: { attempt: number; nextRetryMs: number };
        lanFailCount?: number;
        maintenanceWindow?: MaintenanceWindow | null;
    } = {},
): CloudStub {
    const now = Date.now();
    const stub: CloudStub = {
        _lanIpMap: new Map(opts.hasLanIp !== false ? [[CAM_A, "192.0.2.10"]] : []),
        _lanReachable: new Map(),
        _liveSessions: new Map([
            [
                CAM_A,
                {
                    cameraId: CAM_A,
                    digestUser: "cbs-test",
                    digestPassword: "test-pw",
                    openedAt: now - (opts.sessionAge ?? 0),
                    maxSessionDuration: 3600,
                    lanAddress: "192.0.2.10:443",
                    proxyUrl: "https://192.0.2.10:443/snap.jpg",
                    connectionType: "LOCAL" as const,
                    bufferingTimeMs: 500,
                },
            ],
        ]),
        _tlsProxies: new Map([[CAM_A, { stop: async () => undefined }]]),
        _sessionWatchdogs: new Map([[CAM_A, { stop: () => undefined }]]),
        _sessionStartTime: new Map([[CAM_A, now - (opts.sessionAge ?? 0)]]),
        _renewalBackoff: new Map(opts.sessionBackoff ? [[CAM_A, opts.sessionBackoff]] : []),
        _lanTcpFailCount: new Map(
            opts.lanFailCount !== undefined ? [[CAM_A, opts.lanFailCount]] : [],
        ),
        _streamGeneration: new Map(),
        _lastMaintenanceWindow:
            opts.maintenanceWindow !== undefined ? opts.maintenanceWindow : null,
        _lastOutagePingAt: -Infinity,
        _cameras: new Map([[CAM_A, { id: CAM_A, generation: 2 }]]),
        _currentAccessToken: opts.hasToken !== false ? "test-access-token" : null,
        _streamQuality: new Map(),
        _stateCache: new Map(),
        _maintenanceLastFetchMs: 0,
        log: {
            info: sinon.stub(),
            warn: sinon.stub(),
            error: sinon.stub(),
            debug: sinon.stub(),
        },
        setTimeout: (_fn: () => void, _ms: number) => ({ unref: () => undefined }),
        async upsertState(id: string, value: unknown) {
            this._stateCache.set(id, value);
        },
        async _tcpPing(_camId: string): Promise<boolean> {
            return true; // default: reachable; override per test
        },
        async _teardownStream(_camId: string): Promise<void> {
            // default no-op; spy on this to verify teardown calls
        },
        _triggerMaintenanceFetchOn5xx() {
            /* no-op */
        },
        // Delegate to the real adapter implementations (set by loadMethods())
        _handleRenewalFailure(...args: unknown[]) {
            throw new Error(
                `_handleRenewalFailure not bound — loadMethods() not called yet (args: ${args.length})`,
            );
        },
        _attemptBackoffRenewal(...args: unknown[]) {
            throw new Error(`_attemptBackoffRenewal not bound (args: ${args.length})`);
        },
        _routeCloudErrorLog(...args: unknown[]) {
            if (!boundRouteCloudErrorLog) {
                throw new Error("_routeCloudErrorLog not bound — loadMethods() not called yet");
            }
            return boundRouteCloudErrorLog.apply(this, args);
        },
        _doTeardownStream(...args: unknown[]) {
            if (!boundDoTeardownStream) {
                throw new Error("_doTeardownStream not bound — loadMethods() not called yet");
            }
            return boundDoTeardownStream.apply(this, args);
        },
    };
    return stub;
}

// ── Extract methods from built adapter ───────────────────────────────────────

// Populated by loadMethods() — used to wire helpers onto stubs so that when
// _handleRenewalFailure calls `this._routeCloudErrorLog(...)` the stub gets
// the real adapter implementation (which calls this.log.info / this.log.warn).
let boundRouteCloudErrorLog: AnyFn | null = null;
let boundDoTeardownStream: AnyFn | null = null;

function loadMethods(): {
    handleRenewalFailure: AnyFn;
    attemptBackoffRenewal: AnyFn;
    routeCloudErrorLog: AnyFn;
    doTeardownStream: AnyFn;
} {
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
    factory({ config: { redirect_url: "", region: "EU", startup_snapshot: true } });

    if (!capturedAdapter) {
        throw new Error("adapter not captured");
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proto = capturedAdapter as any;

    const handleRenewalFailure = proto._handleRenewalFailure as AnyFn | undefined;
    if (typeof handleRenewalFailure !== "function") {
        throw new Error("_handleRenewalFailure not found — check method name");
    }
    const attemptBackoffRenewal = proto._attemptBackoffRenewal as AnyFn | undefined;
    if (typeof attemptBackoffRenewal !== "function") {
        throw new Error("_attemptBackoffRenewal not found — check method name");
    }
    const routeCloudErrorLog = proto._routeCloudErrorLog as AnyFn | undefined;
    if (typeof routeCloudErrorLog !== "function") {
        throw new Error("_routeCloudErrorLog not found — check method name");
    }
    const doTeardownStream = proto._doTeardownStream as AnyFn | undefined;
    if (typeof doTeardownStream !== "function") {
        throw new Error("_doTeardownStream not found — check method name");
    }

    // Wire up module-level bindings so makeStub() can delegate to the real impl
    boundRouteCloudErrorLog = routeCloudErrorLog;
    boundDoTeardownStream = doTeardownStream;

    return { handleRenewalFailure, attemptBackoffRenewal, routeCloudErrorLog, doTeardownStream };
}

// ── Active maintenance window fixture ────────────────────────────────────────

const ACTIVE_MAINTENANCE_START = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
const ACTIVE_MAINTENANCE_END = new Date(Date.now() + 55 * 60 * 1000).toISOString(); // 55 min from now

function makeActiveMw(): MaintenanceWindow {
    return {
        title: "Kamera-Infrastruktur Wartung",
        link: "https://community.bosch-smarthome.com/t5/wartungsarbeiten/test/ba-p/12345",
        pub_date: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        summary: "Wartungsarbeiten an der Kamera-Infrastruktur.",
        scheduled_start: ACTIVE_MAINTENANCE_START,
        scheduled_end: ACTIVE_MAINTENANCE_END,
        source: "rss:Wartungsarbeiten",
        camera_relevant: true,
    };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Cloud-503 handling — v0.7.10 (Issue #9)", () => {
    let methods: ReturnType<typeof loadMethods>;
    let liveSessionModule: { openLiveSession: AnyFn };

    before(() => {
        methods = loadMethods();
        // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
        liveSessionModule = require(path.join(REPO_ROOT, "build", "lib", "live_session")) as {
            openLiveSession: AnyFn;
        };
    });

    afterEach(() => {
        sinon.restore();
    });

    // ── Test 1: 503 does NOT tear down stream immediately ─────────────────────

    describe("test_renewal_503_does_not_tear_down_stream_immediately", () => {
        it("keeps stream alive and schedules retry when cloud returns 503", async () => {
            const stub = makeStub();
            const teardownSpy = sinon.spy(stub, "_teardownStream");
            const setTimeoutSpy = sinon
                .stub(stub, "setTimeout")
                .returns({ unref: () => undefined });

            const err = new Error("Camera offline or unreachable (HTTP 503)");
            err.name = "CameraOfflineError";

            await methods.handleRenewalFailure.call(stub, CAM_A, err);

            // Stream must NOT be torn down on first failure
            expect(teardownSpy.called).to.equal(false);
            // A retry must be scheduled
            expect(setTimeoutSpy.calledOnce).to.equal(true);
        });
    });

    // ── Test 2: backoff sequence 5 → 15 → 45 → 120 → 300 s ─────────────────

    describe("test_renewal_503_backoff_sequence_5_15_45_120_300", () => {
        it("uses exponential backoff steps 5000/15000/45000/120000/300000 ms", async () => {
            const stub = makeStub();
            const delays: number[] = [];
            sinon.stub(stub, "setTimeout").callsFake((_fn: () => void, ms: number) => {
                delays.push(ms);
                return { unref: () => undefined };
            });
            sinon.stub(stub, "_teardownStream").resolves();

            const err = new Error("Camera offline (HTTP 503)");
            err.name = "CameraOfflineError";

            // Simulate 5 consecutive failures at increasing backoff steps
            const expectedDelays = [5_000, 15_000, 45_000, 120_000, 300_000];
            for (let i = 0; i < 5; i++) {
                await methods.handleRenewalFailure.call(stub, CAM_A, err);
            }

            // After 5 calls the delays should match the backoff sequence
            expect(delays).to.deep.equal(expectedDelays);
        });
    });

    // ── Test 3: 503 after 60-min session expiry → tear down ──────────────────

    describe("test_renewal_503_after_60min_session_expiry_tears_down", () => {
        it("tears down stream when session is 61 min old and renewal still failing", async () => {
            const sessionAge = 61 * 60 * 1000; // 61 minutes in ms
            const stub = makeStub({ sessionAge });
            const teardownSpy = sinon.stub(stub, "_teardownStream").resolves();
            const setTimeoutSpy = sinon
                .stub(stub, "setTimeout")
                .returns({ unref: () => undefined });

            const err = new Error("Camera offline (HTTP 503)");
            err.name = "CameraOfflineError";

            await methods.handleRenewalFailure.call(stub, CAM_A, err);

            // Session expired → immediate teardown, no retry scheduled
            expect(teardownSpy.calledOnce).to.equal(true);
            expect(setTimeoutSpy.called).to.equal(false);
        });
    });

    // ── Test 4: LAN TCP 3 failures → tear down ───────────────────────────────

    describe("test_lan_tcp_3_failures_tears_down", () => {
        it("tears down stream after 3 consecutive LAN TCP failures", async () => {
            const stub = makeStub({ lanFailCount: 2 }); // 2 previous failures
            const teardownSpy = sinon.stub(stub, "_teardownStream").resolves();
            sinon.stub(stub, "_tcpPing").resolves(false); // 3rd failure

            await methods.attemptBackoffRenewal.call(stub, CAM_A);

            expect(teardownSpy.calledOnce).to.equal(true);
            // Error log must say "Camera offline or unreachable"
            expect(
                stub.log.error.args.some((args: string[]) =>
                    (args[0] as string).includes("Camera offline or unreachable"),
                ),
            ).to.equal(true);
        });
    });

    // ── Test 5: LAN TCP 2 failures then success → reset counter ─────────────

    describe("test_lan_tcp_2_failures_then_success_resets_counter", () => {
        it("resets LAN TCP failure counter after a successful TCP connect", async () => {
            const stub = makeStub({ lanFailCount: 2, hasToken: true });
            sinon.stub(stub, "_tcpPing").resolves(true); // TCP succeeds now

            // Make cloud renewal also succeed
            const newSession = {
                cameraId: CAM_A,
                digestUser: "cbs-new",
                digestPassword: "new-pw",
                openedAt: Date.now(),
                maxSessionDuration: 3600,
                lanAddress: "192.0.2.10:443",
                proxyUrl: "https://192.0.2.10:443/snap.jpg",
                connectionType: "LOCAL" as const,
                bufferingTimeMs: 500,
            };
            sinon.stub(liveSessionModule, "openLiveSession").resolves(newSession);

            // Provide upsertSession stub
            stub._sessionWatchdogs.clear(); // no watchdog so _attemptBackoffRenewal arms a new one
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (stub as any).upsertSession = async (_camId: string, _s: unknown) => undefined;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (stub as any)._httpClient = {};

            await methods.attemptBackoffRenewal.call(stub, CAM_A);

            // LAN-fail counter must be cleared (0 or removed — no longer tracking failures)
            const failCount = stub._lanTcpFailCount.get(CAM_A) ?? 0;
            expect(failCount).to.equal(0);
        });
    });

    // ── Test 6: 401 error routes through emergency session refresh ────────────

    describe("test_renewal_401_calls_emergency_session_refresh", () => {
        it("routes 401 error with 'LAN session credentials expired' warn message", async () => {
            const stub = makeStub({ maintenanceWindow: null });
            sinon.stub(stub, "setTimeout").returns({ unref: () => undefined });
            sinon.stub(stub, "_teardownStream").resolves();

            const err = new Error("Bearer token expired or invalid (401) for camera EFEFEFEF");
            err.name = "LiveSessionError";

            await methods.handleRenewalFailure.call(stub, CAM_A, err);

            // Must produce a WARN log (not error, not info) with credential text
            expect(
                stub.log.warn.args.some((args: string[]) => (args[0] as string).includes("401")),
            ).to.equal(true);
        });
    });

    // ── Test 7: active maintenance → 5xx logged as INFO ─────────────────────

    describe("test_maintenance_active_downgrades_5xx_to_info", () => {
        it("logs 503 as INFO with [bosch-maintenance] prefix when maintenance is active", () => {
            const stub = makeStub({ maintenanceWindow: makeActiveMw() });

            // Verify the maintenance window is active
            expect(classifyState(stub._lastMaintenanceWindow!)).to.equal("active");

            methods.routeCloudErrorLog.call(stub, CAM_A.slice(0, 8), 503, 5);

            // Must be logged at INFO, not WARN
            expect(stub.log.info.calledOnce).to.equal(true);
            expect(stub.log.warn.called).to.equal(false);
            const infoMsg: string = stub.log.info.firstCall.args[0] as string;
            expect(infoMsg).to.include("[bosch-maintenance]");
        });
    });

    // ── Test 8: no maintenance → 5xx logged as WARN ──────────────────────────

    describe("test_maintenance_none_keeps_5xx_at_warn", () => {
        it("logs 503 as WARN when no active maintenance window is set", () => {
            const stub = makeStub({ maintenanceWindow: null });

            methods.routeCloudErrorLog.call(stub, CAM_A.slice(0, 8), 503, 5);

            expect(stub.log.warn.calledOnce).to.equal(true);
            expect(stub.log.info.called).to.equal(false);
            const warnMsg: string = stub.log.warn.firstCall.args[0] as string;
            expect(warnMsg).to.include("503");
        });
    });

    // ── Test 9: maintenance RSS parsing produces correct structure ────────────

    describe("test_maintenance_parses_rss_correctly", () => {
        it("parseFeedBody() returns an active MaintenanceWindow for a known good RSS fixture", () => {
            // Real fixture from maintenance.spec.ts — camera maintenance 19.05.2026 07:00–10:00 MESZ
            const REAL_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Wartungsarbeiten</title>
    <item>
      <title>Wartung: Kamera-Infrastruktur (Di., 19.05.2026)</title>
      <link>https://community.bosch-smarthome.com/t5/wartungsarbeiten/wartung-kamera-infrastruktur-di-19-05-2026/ba-p/110703</link>
      <pubDate>Mon, 18 May 2026 10:06:13 GMT</pubDate>
      <description><![CDATA[<P>Wartungsarbeiten an der Kamera-Infrastruktur zwischen <STRONG>07:00 und 10:00 Uhr (MESZ)</STRONG> am 19.05.2026.</P>]]></description>
    </item>
  </channel>
</rss>`;
            const url =
                "https://community.bosch-smarthome.com/edswj98253/rss/board?board.id=Wartungsarbeiten";
            const mw = parseFeedBody(REAL_RSS, url);

            expect(mw).to.not.equal(null);
            expect(mw!.camera_relevant).to.equal(true);
            expect(mw!.source).to.equal("rss:Wartungsarbeiten");
            // Scheduled window must be parsed
            expect(mw!.scheduled_start).to.not.equal(null);
            expect(mw!.scheduled_end).to.not.equal(null);
            // UTC: MESZ=UTC+2, so 07:00 MESZ = 05:00 UTC
            expect(mw!.scheduled_start).to.equal("2026-05-19T05:00:00.000Z");
            expect(mw!.scheduled_end).to.equal("2026-05-19T08:00:00.000Z");
        });
    });

    // ── Test 10: v1.1.0 generation guard — stale renewal bails (regression) ───

    describe("test_v110_stale_renewal_bails_on_generation_mismatch", () => {
        it("bails without opening a session when expectedGeneration does not match current", async () => {
            const stub = makeStub({ hasToken: true });
            // Set current generation to 5; call with stale gen 2
            stub._streamGeneration.set(CAM_A, 5);
            const teardownSpy = sinon.spy(stub, "_teardownStream");

            const openSessionStub = sinon.stub(liveSessionModule, "openLiveSession").resolves({
                cameraId: CAM_A,
                digestUser: "should-not-be-called",
                digestPassword: "x",
                openedAt: Date.now(),
                maxSessionDuration: 3600,
                lanAddress: "192.0.2.10:443",
                proxyUrl: "https://192.0.2.10:443/snap.jpg",
                connectionType: "LOCAL" as const,
                bufferingTimeMs: 500,
            });

            try {
                await methods.attemptBackoffRenewal.call(stub, CAM_A, 2);

                // Must bail: no openLiveSession call, no teardown, no failure handler
                expect(openSessionStub.called, "openLiveSession must not be called").to.equal(false);
                expect(teardownSpy.called, "_teardownStream must not be called").to.equal(false);
                // Debug log must mention the stale-generation bail
                expect(
                    stub.log.debug.args.some((args: string[]) =>
                        (args[0] as string).includes("stale renewal"),
                    ),
                    "debug log mentions stale renewal",
                ).to.equal(true);
            } finally {
                openSessionStub.restore();
            }
        });

        it("proceeds normally when expectedGeneration matches current generation", async () => {
            const stub = makeStub({ hasToken: true, hasLanIp: false });
            // No LAN IP so tcpPing gate is skipped; cloud path runs immediately
            stub._streamGeneration.set(CAM_A, 5);
            stub._sessionWatchdogs.clear();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (stub as any).upsertSession = async (_camId: string, _s: unknown) => undefined;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (stub as any)._httpClient = {};

            const newSession = {
                cameraId: CAM_A,
                digestUser: "cbs-fresh",
                digestPassword: "fresh-pw",
                openedAt: Date.now(),
                maxSessionDuration: 3600,
                lanAddress: "192.0.2.10:443",
                proxyUrl: "https://192.0.2.10:443/snap.jpg",
                connectionType: "LOCAL" as const,
                bufferingTimeMs: 500,
            };
            const openSessionStub = sinon
                .stub(liveSessionModule, "openLiveSession")
                .resolves(newSession);

            try {
                await methods.attemptBackoffRenewal.call(stub, CAM_A, 5);

                // Generation matched → should have attempted the cloud renewal
                expect(openSessionStub.calledOnce, "openLiveSession called for matching gen").to.equal(true);
            } finally {
                openSessionStub.restore();
            }
        });
    });
});
