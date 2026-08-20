/**
 * v1.9.0: AI Camera Analysis slice — cameras.<id>.ai_analyze trigger POSTs
 * the latest snapshot to adapter.config.ai_analysis_endpoint_url and writes
 * ai_description/ai_score/ai_last_analysis from the JSON response.
 *
 * Harness mirrors main_control_v190.spec.ts / main_coverage_lighting.spec.ts.
 */

import { expect } from "chai";
import * as sinon from "sinon";
import * as path from "path";
import axios, { type AxiosAdapter, type InternalAxiosRequestConfig } from "axios";

import { stubAxiosByUrl, restoreAxios, type UrlMatcher } from "./helpers/axios-mock";

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

const CAM_GEN2_LIGHT = "0A0B0C0D-1111-2222-3333-444455556666";

const CAM_GEN2_LIGHT_BODY = [
    {
        id: CAM_GEN2_LIGHT,
        title: "Terrasse",
        hardwareVersion: "HOME_Eyes_Outdoor",
        firmwareVersion: "9.40.25",
        featureSupport: { light: true },
    },
];

function resolveBuildModule(name: string): string {
    return path.join(REPO_ROOT, "build", "lib", `${name}.js`);
}

function injectModuleEntry(resolvedPath: string, exports: object): void {
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

interface MakeAdapterOpts {
    axiosByUrl?: UrlMatcher[];
    config?: Record<string, unknown>;
    fetchSnapshotStub?: sinon.SinonStub;
    /**
     * Bug-hunt finding (CRITICAL, SSRF guard): `_handleAiAnalyzeTrigger`
     * calls the REAL `validateAiEndpointUrl` (real DNS resolution) before
     * every POST. The fixtures below use `.invalid` hostnames (RFC 2606 —
     * guaranteed never to resolve), so every test must mock ssrf_guard the
     * same way every other lib dependency here is mocked, unless it's
     * specifically exercising the SSRF guard itself (see the dedicated
     * describe block at the bottom of this file, which does NOT use this
     * default and lets the real guard run).
     */
    ssrfGuardStub?: sinon.SinonStub;
    /**
     * Skip mocking ssrf_guard entirely so `build/lib/ssrf_guard.js`'s REAL
     * `validateAiEndpointUrl` runs. Only safe with fixture URLs that never
     * trigger a real DNS lookup (literal IPs, or a non-https scheme that's
     * rejected before DNS is ever attempted) — see ssrf_guard.ts.
     */
    useRealSsrfGuard?: boolean;
}

function makeAdapter(opts: MakeAdapterOpts = {}): { db: MockDatabase; adapter: TestAdapter } {
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

    const snapshotPath = resolveBuildModule("snapshot");
    delete require.cache[snapshotPath];
    injectModuleEntry(snapshotPath, {
        fetchSnapshot: opts.fetchSnapshotStub ?? sinon.stub().resolves(Buffer.from("FAKEJPEG")),
        buildSnapshotUrl: (u: string) => `${u}/snap.jpg`,
        SnapshotError: class extends Error {},
    });

    const fakeSession = {
        camId: CAM_GEN2_LIGHT,
        lanAddress: "192.0.2.149:443",
        proxyUrl: "rtsp://127.0.0.1:18050/rtsp_tunnel",
        maxSessionDuration: 3600,
        openedAt: Date.now(),
        digestUser: "cbs-user",
        digestPassword: "cbs-pass",
    };
    const liveSessionPath = resolveBuildModule("live_session");
    delete require.cache[liveSessionPath];
    class LiveSessionError extends Error {}
    class CameraOfflineError extends Error {}
    class SessionLimitError extends Error {}
    injectModuleEntry(liveSessionPath, {
        openLiveSession: sinon.stub().resolves(fakeSession),
        closeLiveSession: sinon.stub().resolves(),
        LiveSessionError,
        CameraOfflineError,
        SessionLimitError,
    });

    const tlsProxyPath = resolveBuildModule("tls_proxy");
    delete require.cache[tlsProxyPath];
    injectModuleEntry(tlsProxyPath, {
        startTlsProxy: sinon.stub().resolves({
            port: 18050,
            localRtspUrl: "rtsp://127.0.0.1:18050/rtsp_tunnel",
            stop: sinon.stub().resolves(),
        }),
    });

    const watchdogPath = resolveBuildModule("session_watchdog");
    delete require.cache[watchdogPath];
    injectModuleEntry(watchdogPath, {
        SessionWatchdog: class {
            start = sinon.stub();
            stop = sinon.stub();
            constructor(_o: unknown) {}
        },
    });

    const rcpPath = resolveBuildModule("rcp");
    const realRcp = require(rcpPath) as object;
    injectModuleEntry(rcpPath, {
        ...realRcp,
        sendRcpCommand: sinon.stub().resolves({ payload: Buffer.alloc(0) }),
    });

    const ssrfGuardPath = resolveBuildModule("ssrf_guard");
    delete require.cache[ssrfGuardPath];
    if (!opts.useRealSsrfGuard) {
        injectModuleEntry(ssrfGuardPath, {
            validateAiEndpointUrl: opts.ssrfGuardStub ?? sinon.stub().resolves({ ok: true }),
        });
    }
    // else: leave require.cache alone — main.js's `require("./lib/ssrf_guard")`
    // resolves the REAL compiled module normally.

    const fcmPath = resolveBuildModule("fcm");
    delete require.cache[fcmPath];
    class FakeFcmCbsRegistrationError extends Error {
        constructor() {
            super("CBS registration rejected");
            this.name = "FcmCbsRegistrationError";
        }
    }
    const { EventEmitter } = require("events") as typeof import("events");
    class FakeFcmListener extends EventEmitter {
        start = sinon.stub().rejects(new FakeFcmCbsRegistrationError());
        stop = sinon.stub().resolves();
    }
    injectModuleEntry(fcmPath, {
        FcmListener: FakeFcmListener,
        FcmCbsRegistrationError: FakeFcmCbsRegistrationError,
        CLOUD_API: "https://residential.cbs.boschsecurity.com",
        FCM_SENDER_ID: "000000000000",
    });

    stubAxiosByUrl(
        opts.axiosByUrl ?? [
            { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
        ],
    );

    delete require.cache[MAIN_JS_PATH];
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const factory = require(MAIN_JS_PATH) as (opts: Record<string, unknown>) => MockAdapter;
    factory({
        config: {
            redirect_url: "",
            region: "EU",
            startup_snapshot: true,
            ai_analysis_enabled: true,
            ai_analysis_endpoint_url: "https://ai.example.invalid/analyze",
            ai_analysis_api_key: "test-key",
            ...opts.config,
        },
    });

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

    return { db, adapter };
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

function getStateVal(db: MockDatabase, adapter: TestAdapter, id: string): unknown {
    const fullId = `${adapter.namespace}.${id}`;
    const state = db.getState(fullId);
    return (state as ioBroker.State | null | undefined)?.val;
}

async function triggerAnalyze(adapter: TestAdapter): Promise<void> {
    const stateId = `${adapter.namespace}.cameras.${CAM_GEN2_LIGHT}.ai_analyze`;
    await adapter.stateChangeHandler!(stateId, {
        val: true,
        ack: false,
        ts: Date.now(),
        lc: Date.now(),
        from: "user",
    });
}

const CLEANUP_MODULES = [
    "snapshot",
    "live_session",
    "tls_proxy",
    "session_watchdog",
    "rcp",
    "fcm",
    "ssrf_guard",
];

describe("v1.9.0: AI Camera Analysis (ai_analyze trigger)", function () {
    this.timeout(15_000);

    afterEach(() => {
        restoreAxios();
        sinon.restore();
        for (const m of CLEANUP_MODULES) delete require.cache[resolveBuildModule(m)];
        delete require.cache[MAIN_JS_PATH];
    });

    it("happy path: endpoint returns {description, score} → both DPs written, trigger resets", async () => {
        const { db, adapter } = makeAdapter({
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
                {
                    match: "ai.example.invalid/analyze",
                    method: "post",
                    status: 200,
                    data: { description: "Person walking near the door.", score: 7 },
                },
            ],
        });
        await bootWithTokens(db, adapter);

        await triggerAnalyze(adapter);

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.ai_description`)).to.equal(
            "Person walking near the door.",
        );
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.ai_score`)).to.equal(7);
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.ai_last_analysis`)).to.be.a(
            "number",
        );
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.ai_last_analysis`)).to.be.greaterThan(
            0,
        );
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.ai_analyze`)).to.equal(false);
    });

    it("score out of 1-10 range gets clamped", async () => {
        const { db, adapter } = makeAdapter({
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
                {
                    match: "ai.example.invalid/analyze",
                    method: "post",
                    status: 200,
                    data: { description: "Nothing unusual.", score: 55 },
                },
            ],
        });
        await bootWithTokens(db, adapter);

        await triggerAnalyze(adapter);

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.ai_score`)).to.equal(10);
    });

    it("disabled in config → no POST fired, DPs untouched", async () => {
        const { db, adapter } = makeAdapter({
            config: { ai_analysis_enabled: false },
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
            ],
        });
        await bootWithTokens(db, adapter);

        await triggerAnalyze(adapter);

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.ai_description`)).to.be.undefined;
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.ai_score`)).to.be.undefined;
    });

    it("no endpoint URL configured → no POST fired, DPs untouched", async () => {
        const { db, adapter } = makeAdapter({
            config: { ai_analysis_endpoint_url: "" },
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
            ],
        });
        await bootWithTokens(db, adapter);

        await triggerAnalyze(adapter);

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.ai_description`)).to.be.undefined;
    });

    it("endpoint returns HTTP 500 → DPs untouched, trigger still resets, no throw", async () => {
        const { db, adapter } = makeAdapter({
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
                {
                    match: "ai.example.invalid/analyze",
                    method: "post",
                    status: 500,
                    data: { error: "internal" },
                },
            ],
        });
        await bootWithTokens(db, adapter);

        await triggerAnalyze(adapter);

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.ai_description`)).to.be.undefined;
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.ai_analyze`)).to.equal(false);
    });

    it("snapshot fetch failure → aborts gracefully, no throw, no POST", async () => {
        const { db, adapter } = makeAdapter({
            fetchSnapshotStub: sinon.stub().rejects(new Error("camera offline")),
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
                {
                    match: "ai.example.invalid/analyze",
                    method: "post",
                    status: 200,
                    data: { description: "should not be reached", score: 5 },
                },
            ],
        });
        await bootWithTokens(db, adapter);

        await triggerAnalyze(adapter);

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.ai_description`)).to.be.undefined;
    });

    it("non-finite score in the response writes ai_score=1 (documented minimum), not 0 (below the DP's own min:1)", async () => {
        const { db, adapter } = makeAdapter({
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
                {
                    match: "ai.example.invalid/analyze",
                    method: "post",
                    status: 200,
                    // No numeric score at all → scoreRaw is NaN → fallback path.
                    data: { description: "Unparseable score." },
                },
            ],
        });
        await bootWithTokens(db, adapter);

        await triggerAnalyze(adapter);

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.ai_score`)).to.equal(1);
    });

    // ── Bug-hunt regression: item 10 (existence check) ───────────────────────

    it("unknown camera → ignored, no snapshot fetch, no POST, no throw", async () => {
        const UNKNOWN_CAM = "FFFFFFFF-9999-8888-7777-666655554444";
        const { db, adapter } = makeAdapter({
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
                {
                    match: "ai.example.invalid/analyze",
                    method: "post",
                    status: 200,
                    data: { description: "should never be reached", score: 5 },
                },
            ],
        });
        await bootWithTokens(db, adapter);

        const stateId = `${adapter.namespace}.cameras.${UNKNOWN_CAM}.ai_analyze`;
        await adapter.stateChangeHandler!(stateId, {
            val: true,
            ack: false,
            ts: Date.now(),
            lc: Date.now(),
            from: "user",
        });

        expect(getStateVal(db, adapter, `cameras.${UNKNOWN_CAM}.ai_description`)).to.be.undefined;
        expect(getStateVal(db, adapter, "info.connection")).to.equal(true);
    });

    // ── Bug-hunt regression: item 9 (reset-to-false must survive a throw) ───

    it("ssrf_guard throwing (not just rejecting) → ai_analyze still resets to false, no unhandled rejection", async () => {
        const { db, adapter } = makeAdapter({
            ssrfGuardStub: sinon.stub().rejects(new Error("boom — unexpected guard failure")),
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
                {
                    match: "ai.example.invalid/analyze",
                    method: "post",
                    status: 200,
                    data: { description: "should never be reached", score: 5 },
                },
            ],
        });
        await bootWithTokens(db, adapter);

        await triggerAnalyze(adapter);

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.ai_analyze`)).to.equal(false);
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.ai_description`)).to.be.undefined;
    });

    // ── Bug-hunt regression: item 12 (in-flight coalescing) ──────────────────

    it("two concurrent triggers for the same camera coalesce onto ONE POST", async () => {
        const { db, adapter } = makeAdapter({
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
                {
                    match: "ai.example.invalid/analyze",
                    method: "post",
                    status: 200,
                    data: { description: "Person walking near the door.", score: 7 },
                },
            ],
        });
        await bootWithTokens(db, adapter);

        let postCount = 0;
        const wrapped = axios.defaults.adapter as AxiosAdapter;
        axios.defaults.adapter = ((config: InternalAxiosRequestConfig) => {
            if (
                String(config.url).includes("ai.example.invalid") &&
                (config.method ?? "get").toLowerCase() === "post"
            ) {
                postCount++;
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (wrapped as any)(config);
        }) as AxiosAdapter;

        await Promise.all([triggerAnalyze(adapter), triggerAnalyze(adapter)]);

        expect(postCount).to.equal(1);
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.ai_description`)).to.equal(
            "Person walking near the door.",
        );
    });

    // ── Bug-hunt regression: item 1 (SSRF guard: maxRedirects:0) ─────────────

    it("POST sets maxRedirects:0 — a validated https URL must not be followed through a redirect", async () => {
        const { db, adapter } = makeAdapter({
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
                {
                    match: "ai.example.invalid/analyze",
                    method: "post",
                    status: 200,
                    data: { description: "x", score: 5 },
                },
            ],
        });
        await bootWithTokens(db, adapter);

        let capturedMaxRedirects: number | undefined;
        const wrapped = axios.defaults.adapter as AxiosAdapter;
        axios.defaults.adapter = ((config: InternalAxiosRequestConfig) => {
            if (String(config.url).includes("ai.example.invalid")) {
                capturedMaxRedirects = config.maxRedirects;
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (wrapped as any)(config);
        }) as AxiosAdapter;

        await triggerAnalyze(adapter);

        expect(capturedMaxRedirects).to.equal(0);
    });
});

// ── Bug-hunt regression: item 1 CRITICAL (SSRF / credential-leak guard) ─────
//
// Uses the REAL validateAiEndpointUrl (no ssrf_guard mock) — every URL below
// is either a non-https scheme or a literal IP, so no real DNS lookup is
// ever performed (see ssrf_guard.ts: literal IPs are validated locally).

describe("v1.9.0: ai_analyze — SSRF guard (item 1, real validateAiEndpointUrl)", function () {
    this.timeout(15_000);

    afterEach(() => {
        restoreAxios();
        sinon.restore();
        for (const m of CLEANUP_MODULES) {
            delete require.cache[resolveBuildModule(m)];
        }
        delete require.cache[MAIN_JS_PATH];
    });

    it("http:// endpoint (not https) → REJECTED, no POST fired, no DPs written", async () => {
        const { db, adapter } = makeAdapter({
            useRealSsrfGuard: true,
            config: { ai_analysis_endpoint_url: "http://ai.example.invalid/analyze" },
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
                {
                    match: "ai.example.invalid/analyze",
                    method: "post",
                    status: 200,
                    data: { description: "should never be reached", score: 5 },
                },
            ],
        });
        await bootWithTokens(db, adapter);

        await triggerAnalyze(adapter);

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.ai_description`)).to.be
            .undefined;
    });

    it("private-IP literal endpoint (192.168.x.x) → REJECTED, no POST fired", async () => {
        const { db, adapter } = makeAdapter({
            useRealSsrfGuard: true,
            config: { ai_analysis_endpoint_url: "https://192.168.1.50/analyze" },
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
                { match: "192.168.1.50/analyze", method: "post", status: 200, data: { description: "should never be reached", score: 5 } },
            ],
        });
        await bootWithTokens(db, adapter);

        await triggerAnalyze(adapter);

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.ai_description`)).to.be
            .undefined;
    });

    it("cloud-metadata literal endpoint (169.254.169.254) → REJECTED, no POST fired", async () => {
        const { db, adapter } = makeAdapter({
            useRealSsrfGuard: true,
            config: { ai_analysis_endpoint_url: "https://169.254.169.254/analyze" },
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
                { match: "169.254.169.254/analyze", method: "post", status: 200, data: { description: "should never be reached", score: 5 } },
            ],
        });
        await bootWithTokens(db, adapter);

        await triggerAnalyze(adapter);

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.ai_description`)).to.be
            .undefined;
    });

    it("loopback literal endpoint (127.0.0.1) → REJECTED, no POST fired", async () => {
        const { db, adapter } = makeAdapter({
            useRealSsrfGuard: true,
            config: { ai_analysis_endpoint_url: "https://127.0.0.1/analyze" },
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
                { match: "127.0.0.1/analyze", method: "post", status: 200, data: { description: "should never be reached", score: 5 } },
            ],
        });
        await bootWithTokens(db, adapter);

        await triggerAnalyze(adapter);

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.ai_description`)).to.be
            .undefined;
    });

    it("public https literal-IP endpoint → validation PASSES, POST fires", async () => {
        // 203.0.113.0/24 is TEST-NET-3 (RFC 5737) — reserved for documentation,
        // globally routable address space, NOT private/loopback/link-local.
        const { db, adapter } = makeAdapter({
            useRealSsrfGuard: true,
            config: { ai_analysis_endpoint_url: "https://203.0.113.10/analyze" },
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
                {
                    match: "203.0.113.10/analyze",
                    method: "post",
                    status: 200,
                    data: { description: "Person walking near the door.", score: 7 },
                },
            ],
        });
        await bootWithTokens(db, adapter);

        await triggerAnalyze(adapter);

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.ai_description`)).to.equal(
            "Person walking near the door.",
        );
    });
});
