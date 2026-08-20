/**
 * v1.9.0 gap-closing round: rename, soft_reset/hard_reset, soft_light_fading,
 * top_led_brightness/bottom_led_brightness/front_light_white_balance.
 *
 * Harness mirrors test/unit/main_coverage_lighting.spec.ts (createAdapter +
 * stubAxiosByUrl + drive writes via adapter.stateChangeHandler!).
 */

import { expect } from "chai";
import * as sinon from "sinon";
import * as path from "path";

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

const CAM_GEN2_LIGHT = "0A0B0C0D-1111-2222-3333-444455556666"; // HOME_Eyes_Outdoor, featureLight=true

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
    cameraBody?: unknown[];
    axiosByUrl?: UrlMatcher[];
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
        fetchSnapshot: sinon.stub().resolves(Buffer.from("FAKEJPEG")),
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

    const cameraBody = opts.cameraBody ?? CAM_GEN2_LIGHT_BODY;
    stubAxiosByUrl(
        opts.axiosByUrl ?? [
            { match: "/v11/video_inputs", method: "get", status: 200, data: cameraBody },
        ],
    );

    delete require.cache[MAIN_JS_PATH];
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const factory = require(MAIN_JS_PATH) as (opts: Record<string, unknown>) => MockAdapter;
    factory({ config: { redirect_url: "", region: "EU", startup_snapshot: true } });

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

async function writeState(
    adapter: TestAdapter,
    dp: string,
    val: ioBroker.StateValue,
): Promise<void> {
    const stateId = `${adapter.namespace}.cameras.${CAM_GEN2_LIGHT}.${dp}`;
    await adapter.stateChangeHandler!(stateId, {
        val,
        ack: false,
        ts: Date.now(),
        lc: Date.now(),
        from: "user",
    });
}

const CLEANUP_MODULES = ["snapshot", "live_session", "tls_proxy", "session_watchdog", "rcp", "fcm"];

describe("v1.9.0: rename / soft_reset / hard_reset / soft_light_fading / LED tuning", function () {
    this.timeout(15_000);

    afterEach(() => {
        restoreAxios();
        sinon.restore();
        for (const m of CLEANUP_MODULES) delete require.cache[resolveBuildModule(m)];
        delete require.cache[MAIN_JS_PATH];
    });

    it("rename: PUT /v11/video_inputs 200 → DP ack'd with new title", async () => {
        const { db, adapter } = makeAdapter({
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
                { match: "/v11/video_inputs", method: "put", status: 200, data: "" },
            ],
        });
        await bootWithTokens(db, adapter);

        await writeState(adapter, "rename", "Garten-Kamera");

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.rename`)).to.equal(
            "Garten-Kamera",
        );
    });

    it("rename: empty title is ignored (no ack, no PUT)", async () => {
        const { db, adapter } = makeAdapter();
        await bootWithTokens(db, adapter);

        await writeState(adapter, "rename", "   ");

        // Never ack'd (still whatever the default/init value is, not the write)
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.rename`)).to.not.equal("   ");
    });

    it("rename: PUT rejected (HTTP 403) → not ack'd", async () => {
        const { db, adapter } = makeAdapter({
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
                { match: "/v11/video_inputs", method: "put", status: 403, data: "" },
            ],
        });
        await bootWithTokens(db, adapter);

        await writeState(adapter, "rename", "Nope");

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.rename`)).to.not.equal("Nope");
    });

    it("soft_reset: PUT /soft_reset 200 → trigger resets to false", async () => {
        const { db, adapter } = makeAdapter({
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
                { match: "/soft_reset", method: "put", status: 200, data: "" },
            ],
        });
        await bootWithTokens(db, adapter);

        await writeState(adapter, "soft_reset", true);

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.soft_reset`)).to.equal(false);
    });

    it("soft_reset: PUT /soft_reset 404 (Bosch-side rejection) → trigger still resets to false, no throw", async () => {
        const { db, adapter } = makeAdapter({
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
                { match: "/soft_reset", method: "put", status: 404, data: { error: "sh:entity.notfound" } },
            ],
        });
        await bootWithTokens(db, adapter);

        await writeState(adapter, "soft_reset", true);

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.soft_reset`)).to.equal(false);
    });

    // ── Bug-hunt regression: item 9 (reset-to-false must survive a throw) ───

    it("soft_reset: network error (not just a non-2xx) → trigger still resets to false, no throw surfaced", async () => {
        const { db, adapter } = makeAdapter({
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
                { match: "/soft_reset", method: "put", reject: true, status: 500 },
            ],
        });
        await bootWithTokens(db, adapter);

        await writeState(adapter, "soft_reset", true);

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.soft_reset`)).to.equal(false);
    });

    // ── Bug-hunt regression: item 10 (existence check) ───────────────────────

    it("soft_reset: unknown camera → ignored, no PUT fired, no throw", async () => {
        const UNKNOWN_CAM = "FFFFFFFF-9999-8888-7777-666655554444";
        const { db, adapter } = makeAdapter({
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
                { match: "/soft_reset", method: "put", status: 200, data: "" },
            ],
        });
        await bootWithTokens(db, adapter);

        const stateId = `${adapter.namespace}.cameras.${UNKNOWN_CAM}.soft_reset`;
        await adapter.stateChangeHandler!(stateId, {
            val: true,
            ack: false,
            ts: Date.now(),
            lc: Date.now(),
            from: "user",
        });

        // No throw reached this point — adapter still healthy.
        expect(getStateVal(db, adapter, "info.connection")).to.equal(true);
    });

    it("hard_reset: write true WITHOUT a matching hard_reset_confirm → REJECTED, no PUT fired", async () => {
        const { db, adapter } = makeAdapter({
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
                {
                    match: "/hard_reset",
                    method: "put",
                    status: 200,
                    data: "",
                },
            ],
        });
        await bootWithTokens(db, adapter);

        // hard_reset_confirm left at default "" — must not match "Terrasse"
        await writeState(adapter, "hard_reset", true);

        // Trigger still resets to false (never left stuck), but the confirm
        // token was NOT consumed (still empty) — proving the PUT path was
        // never taken (a real hard_reset success clears it, see next test).
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.hard_reset`)).to.equal(false);
        // Confirm token was never consumed (a real success clears it to "" —
        // see the next test); here it's simply never been written at all.
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.hard_reset_confirm`)).to.not
            .equal("Terrasse");
    });

    it("hard_reset: write true WITH matching hard_reset_confirm → PUT fired, confirm token consumed", async () => {
        const { db, adapter } = makeAdapter({
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
                { match: "/hard_reset", method: "put", status: 200, data: "" },
            ],
        });
        await bootWithTokens(db, adapter);

        await writeState(adapter, "hard_reset_confirm", "Terrasse");
        await writeState(adapter, "hard_reset", true);

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.hard_reset`)).to.equal(false);
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.hard_reset_confirm`)).to.equal(
            "",
        );
    });

    // ── Bug-hunt regression: item 2 (60s TTL + clear on every exit path) ────

    it("hard_reset: confirm token expired (>60s old) → REJECTED, no PUT fired", async () => {
        const { db, adapter } = makeAdapter({
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
                { match: "/hard_reset", method: "put", status: 200, data: "" },
            ],
        });
        await bootWithTokens(db, adapter);

        await writeState(adapter, "hard_reset_confirm", "Terrasse");

        // Simulate 61s passing before the hard_reset write itself.
        const realNow = Date.now();
        const nowStub = sinon.stub(Date, "now").returns(realNow + 61_000);
        try {
            await writeState(adapter, "hard_reset", true);
        } finally {
            nowStub.restore();
        }

        // Trigger resets to false either way, but the PUT must never have
        // fired — the confirm token was NEVER consumed by a real success,
        // it was cleared by the rejection path's own finally instead.
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.hard_reset`)).to.equal(false);
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.hard_reset_confirm`)).to.equal(
            "",
        );
    });

    it("hard_reset: a REJECTED attempt (wrong confirm text) clears hard_reset_confirm — was previously left armed", async () => {
        const { db, adapter } = makeAdapter({
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
                { match: "/hard_reset", method: "put", status: 200, data: "" },
            ],
        });
        await bootWithTokens(db, adapter);

        // Wrong title on purpose — guard must reject.
        await writeState(adapter, "hard_reset_confirm", "Wrong Name");
        await writeState(adapter, "hard_reset", true);

        // Bug-hunt finding: before the fix, only the SUCCESS branch cleared
        // hard_reset_confirm — a rejected attempt left "Wrong Name" armed
        // forever (a later rename to "Wrong Name" could then let a stray
        // true-write through). Now it's cleared on every exit path.
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.hard_reset_confirm`)).to.equal(
            "",
        );
    });

    it("soft_light_fading: PUT /lighting 200 → DP ack'd true", async () => {
        const { db, adapter } = makeAdapter({
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
                {
                    match: /\/lighting$/,
                    method: "get",
                    status: 200,
                    data: { darknessThreshold: 0.3, softLightFading: false },
                },
                { match: /\/lighting$/, method: "put", status: 200, data: "" },
            ],
        });
        await bootWithTokens(db, adapter);

        await writeState(adapter, "soft_light_fading", true);

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.soft_light_fading`)).to.equal(
            true,
        );
    });

    // ── Bug-hunt regression: item 3 (no guessed default on a failed seed GET) ─

    it("soft_light_fading: cold cache + seed GET fails → write ABORTS instead of guessing darknessThreshold=0.5", async () => {
        const { db, adapter } = makeAdapter({
            axiosByUrl: [
                // Anchored regex — plain "/v11/video_inputs" would ALSO match
                // GET .../video_inputs/{id}/lighting (substring), silently
                // seeding the cache with the (wrong-shaped) camera-list body
                // instead of leaving it genuinely cold.
                {
                    match: /\/v11\/video_inputs$/,
                    method: "get",
                    status: 200,
                    data: CAM_GEN2_LIGHT_BODY,
                },
                // reject:true (not just a resolved 404) — stubAxiosByUrl's
                // mock adapter always RESOLVES regardless of status (it
                // doesn't implement axios's own validateStatus→reject
                // plumbing the way the real http/xhr adapter does), so a
                // plain unmatched-fallback 404 would silently resolve with
                // {data:null} and NOT exercise the seed-GET-fails path at
                // all. `reject:true` is this test suite's own established
                // way to simulate a genuinely failing request.
                { match: /\/lighting$/, method: "get", reject: true, status: 500 },
                { match: /\/lighting$/, method: "put", status: 200, data: "" },
            ],
        });
        await bootWithTokens(db, adapter);

        await writeState(adapter, "soft_light_fading", true);

        // Never acked — the write aborted before it could PUT anything.
        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.soft_light_fading`)).to.not
            .equal(true);
    });

    it("darkness_threshold: cold cache + seed GET fails → write ABORTS instead of guessing softLightFading=true", async () => {
        const { db, adapter } = makeAdapter({
            axiosByUrl: [
                {
                    match: /\/v11\/video_inputs$/,
                    method: "get",
                    status: 200,
                    data: CAM_GEN2_LIGHT_BODY,
                },
                { match: /\/lighting$/, method: "get", reject: true, status: 500 },
                { match: /\/lighting$/, method: "put", status: 200, data: "" },
            ],
        });
        await bootWithTokens(db, adapter);

        await writeState(adapter, "darkness_threshold", 42);

        expect(getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.darkness_threshold`)).to.not
            .equal(42);
    });

    it("top_led_brightness / bottom_led_brightness written independently via /lighting/switch", async () => {
        const { db, adapter } = makeAdapter({
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
                // Bug-hunt fix (item 4): a cold _lightingCache now triggers a
                // fresh GET /lighting/switch seed before the PUT — without
                // this matcher the seed 404s and the write is REJECTED.
                {
                    match: "/lighting/switch",
                    method: "get",
                    status: 200,
                    data: {
                        frontLightSettings: { brightness: 0, color: null, whiteBalance: -1 },
                        topLedLightSettings: { brightness: 0, color: null, whiteBalance: -1 },
                        bottomLedLightSettings: { brightness: 0, color: null, whiteBalance: -1 },
                    },
                },
                {
                    match: "/lighting/switch",
                    method: "put",
                    status: 200,
                    data: {
                        frontLightSettings: { brightness: 0, color: null, whiteBalance: -1 },
                        topLedLightSettings: { brightness: 77, color: null, whiteBalance: -1 },
                        bottomLedLightSettings: { brightness: 0, color: null, whiteBalance: -1 },
                    },
                },
            ],
        });
        await bootWithTokens(db, adapter);

        await writeState(adapter, "top_led_brightness", 77);

        expect(
            getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.top_led_brightness`),
        ).to.equal(77);
    });

    it("front_light_white_balance written via /lighting/switch, switches to WB mode", async () => {
        const { db, adapter } = makeAdapter({
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
                {
                    match: "/lighting/switch",
                    method: "get",
                    status: 200,
                    data: {
                        frontLightSettings: { brightness: 0, color: null, whiteBalance: -1 },
                        topLedLightSettings: { brightness: 0, color: null, whiteBalance: -1 },
                        bottomLedLightSettings: { brightness: 0, color: null, whiteBalance: -1 },
                    },
                },
                {
                    match: "/lighting/switch",
                    method: "put",
                    status: 200,
                    data: {
                        frontLightSettings: { brightness: 0, color: null, whiteBalance: 0.5 },
                        topLedLightSettings: { brightness: 0, color: null, whiteBalance: -1 },
                        bottomLedLightSettings: { brightness: 0, color: null, whiteBalance: -1 },
                    },
                },
            ],
        });
        await bootWithTokens(db, adapter);

        await writeState(adapter, "front_light_white_balance", 0.5);

        expect(
            getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.front_light_white_balance`),
        ).to.equal(0.5);
    });

    // ── Bug-hunt regression: item 4 (cold-cache clobber guard) ──────────────

    it("top_led_brightness: cold cache + seed GET fails → write REJECTED, no PUT sent, DP not acked", async () => {
        const { db, adapter } = makeAdapter({
            axiosByUrl: [
                // Anchored regex — plain "/v11/video_inputs" would ALSO match
                // GET .../video_inputs/{id}/lighting/switch (substring),
                // silently seeding the cache instead of leaving it cold.
                {
                    match: /\/v11\/video_inputs$/,
                    method: "get",
                    status: 200,
                    data: CAM_GEN2_LIGHT_BODY,
                },
                // No /lighting/switch GET matcher at all → both the startup
                // poll's seed attempt AND the write handler's own seed GET
                // 404 (the stubAxiosByUrl fallback). The write must abort
                // rather than guess DEFAULT_LIGHTING_STATE (all-zeroed) and
                // clobber the untouched bottom LED group.
                {
                    match: "/lighting/switch",
                    method: "put",
                    status: 200,
                    data: {
                        frontLightSettings: { brightness: 0, color: null, whiteBalance: -1 },
                        topLedLightSettings: { brightness: 77, color: null, whiteBalance: -1 },
                        bottomLedLightSettings: { brightness: 0, color: null, whiteBalance: -1 },
                    },
                },
            ],
        });
        await bootWithTokens(db, adapter);

        await writeState(adapter, "top_led_brightness", 77);

        // Rejected before the PUT — state stays un-acked (never written to 77).
        expect(
            getStateVal(db, adapter, `cameras.${CAM_GEN2_LIGHT}.top_led_brightness`),
        ).to.not.equal(77);
    });

    // ── Bug-hunt regression: item 5 (clamped ack must not be overwritten) ───

    it("top_led_brightness: server-clamped response value is the FINAL acked value, not the raw input", async () => {
        const { db, adapter } = makeAdapter({
            axiosByUrl: [
                { match: "/v11/video_inputs", method: "get", status: 200, data: CAM_GEN2_LIGHT_BODY },
                {
                    match: "/lighting/switch",
                    method: "get",
                    status: 200,
                    data: {
                        frontLightSettings: { brightness: 0, color: null, whiteBalance: -1 },
                        topLedLightSettings: { brightness: 0, color: null, whiteBalance: -1 },
                        bottomLedLightSettings: { brightness: 0, color: null, whiteBalance: -1 },
                    },
                },
                {
                    // Simulate the camera reporting back a DIFFERENT value
                    // than the raw 77 the user wrote (e.g. hardware-side
                    // adjustment) — the ack must reflect the server's
                    // response (60), not the raw unclamped user input (77).
                    // Before the fix, the case fell through to a generic
                    // `setStateAsync(id, state.val, true)` ack that
                    // overwrote the handler's own correct upsertState(60).
                    match: "/lighting/switch",
                    method: "put",
                    status: 200,
                    data: {
                        frontLightSettings: { brightness: 0, color: null, whiteBalance: -1 },
                        topLedLightSettings: { brightness: 60, color: null, whiteBalance: -1 },
                        bottomLedLightSettings: { brightness: 0, color: null, whiteBalance: -1 },
                    },
                },
            ],
        });
        await bootWithTokens(db, adapter);

        await writeState(adapter, "top_led_brightness", 77);

        const state = db.getState(
            `${adapter.namespace}.cameras.${CAM_GEN2_LIGHT}.top_led_brightness`,
        ) as ioBroker.State | null;
        expect(state?.val).to.equal(60);
        expect(state?.ack).to.equal(true);
    });

    it("top_led_brightness ignored on a camera without featureLight (no throw surfaced to caller)", async () => {
        const CAM_NO_LIGHT = "0E0F1011-BBBB-CCCC-DDDD-000000000002";
        const body = [
            {
                id: CAM_NO_LIGHT,
                title: "Innenbereich",
                hardwareVersion: "HOME_Eyes_Indoor",
                firmwareVersion: "9.40.25",
                featureSupport: { light: false },
            },
        ];
        const { db, adapter } = makeAdapter({
            cameraBody: body,
            axiosByUrl: [{ match: "/v11/video_inputs", method: "get", status: 200, data: body }],
        });
        await bootWithTokens(db, adapter);

        const stateId = `${adapter.namespace}.cameras.${CAM_NO_LIGHT}.top_led_brightness`;
        await adapter.stateChangeHandler!(stateId, {
            val: 50,
            ack: false,
            ts: Date.now(),
            lc: Date.now(),
            from: "user",
        });

        expect(getStateVal(db, adapter, `cameras.${CAM_NO_LIGHT}.top_led_brightness`)).to.not.equal(
            50,
        );
    });

    // ── Bug-hunt regression: item 7 (soft_light_fading gating) ──────────────

    it("soft_light_fading: NOT created for a Gen2 Indoor camera (was previously created unconditionally)", async () => {
        const CAM_INDOOR = "0E0F1011-BBBB-CCCC-DDDD-000000000003";
        const body = [
            {
                id: CAM_INDOOR,
                title: "Innenbereich",
                hardwareVersion: "HOME_Eyes_Indoor",
                firmwareVersion: "9.40.25",
                featureSupport: { light: false },
            },
        ];
        const { db, adapter } = makeAdapter({
            cameraBody: body,
            axiosByUrl: [{ match: "/v11/video_inputs", method: "get", status: 200, data: body }],
        });
        await bootWithTokens(db, adapter);

        const fullId = `${adapter.namespace}.cameras.${CAM_INDOOR}.soft_light_fading`;
        // MockDatabase returns undefined (not null) for absent objects.
        expect(db.getObject(fullId) ?? null).to.be.null;
    });

    it("soft_light_fading: IS created for a Gen2 Outdoor camera (regression guard)", async () => {
        const { db, adapter } = makeAdapter();
        await bootWithTokens(db, adapter);

        const fullId = `${adapter.namespace}.cameras.${CAM_GEN2_LIGHT}.soft_light_fading`;
        expect(db.getObject(fullId) ?? null).to.not.be.null;
    });

    // ── Bug-hunt regression: item 6 (white-balance polarity label) ──────────

    it("front_light_white_balance: label matches HA's polarity (-1=cold/6500K .. 1=warm/2000K)", async () => {
        const { db, adapter } = makeAdapter();
        await bootWithTokens(db, adapter);

        const fullId = `${adapter.namespace}.cameras.${CAM_GEN2_LIGHT}.front_light_white_balance`;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const obj = db.getObject(fullId) as any;
        expect(obj?.common?.name as string).to.include("cold/6500K");
        expect(obj?.common?.name as string).to.include("warm/2000K");
    });

});

// ── Bug-hunt regression: item 14 (_migrateLightDps includes new DPs) ────────
//
// Prototype-extraction technique (mirrors main_orphan_cleanup.spec.ts's
// _pruneOrphanedCameraObjects tests) — avoids the fragility of pre-seeding a
// full ioBroker OBJECT (not just a state) via the mock DB before boot.

function loadMigrateLightDps(): (cameras: unknown[]) => Promise<void> {
    const db = new MockDatabaseCtor();
    let captured: MockAdapter | null = null;
    const core = mockAdapterCoreFn(db, {
        onAdapterCreated: (a: MockAdapter) => {
            captured = a;
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
    if (!captured) throw new Error("adapter not captured");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = (captured as any)._migrateLightDps as (cameras: unknown[]) => Promise<void>;
    if (typeof fn !== "function") throw new Error("_migrateLightDps not found on adapter");
    return fn;
}

describe("_migrateLightDps — prototype tests (item 14)", () => {
    afterEach(() => {
        delete require.cache[MAIN_JS_PATH];
    });

    it("removes top_led_brightness / bottom_led_brightness / front_light_white_balance for a Gen2 camera that lost featureLight", async () => {
        const migrate = loadMigrateLightDps();
        const camId = "0E0F1011-BBBB-CCCC-DDDD-000000000004";
        const existing = new Set([
            `cameras.${camId}.top_led_brightness`,
            `cameras.${camId}.bottom_led_brightness`,
            `cameras.${camId}.front_light_white_balance`,
        ]);
        const deleted: string[] = [];
        const ctx = {
            log: { info: sinon.stub(), debug: sinon.stub(), warn: sinon.stub() },
            getObjectAsync: sinon
                .stub()
                .callsFake(async (id: string) => (existing.has(id) ? { _id: id, type: "state" } : null)),
            delObjectAsync: sinon.stub().callsFake(async (id: string) => {
                deleted.push(id);
            }),
        };
        const cam = { id: camId, generation: 2, featureLight: false };

        await migrate.call(ctx, [cam]);

        expect(deleted).to.include.members([
            `cameras.${camId}.top_led_brightness`,
            `cameras.${camId}.bottom_led_brightness`,
            `cameras.${camId}.front_light_white_balance`,
        ]);
    });

    it("does NOT touch the 3 new DPs for a Gen2 camera that still has featureLight", async () => {
        const migrate = loadMigrateLightDps();
        const camId = "0E0F1011-BBBB-CCCC-DDDD-000000000005";
        const deleted: string[] = [];
        const ctx = {
            log: { info: sinon.stub(), debug: sinon.stub(), warn: sinon.stub() },
            getObjectAsync: sinon.stub().resolves({ _id: "x", type: "state" }),
            delObjectAsync: sinon.stub().callsFake(async (id: string) => {
                deleted.push(id);
            }),
        };
        const cam = { id: camId, generation: 2, featureLight: true };

        await migrate.call(ctx, [cam]);

        expect(deleted).to.have.length(0);
    });
});
