/**
 * Tests for _pruneOrphanedCameraObjects (v1.5.1) and coverage gaps:
 *   _putLightingMerge / _handleMotionLightWrite / _handleAmbientLightWrite
 *   _handleIntercomWrite
 *
 * Strategy for orphan tests: use the direct prototype-extraction technique
 * (load adapter prototype once, call method with a hand-made `this` stub).
 * Strategy for lighting/intercom: boot the real adapter via build/main.js with
 * a MockDatabase, inject objects, and drive writes via stateChangeHandler —
 * same pattern as main_coverage_lighting.spec.ts.
 *
 * FAKE fixture IDs only (SECRETS_SCAN_GAP) — never real device cloud-IDs.
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

// ── FAKE camera IDs ────────────────────────────────────────────────────────────
// FAKE only — never real device cloud-IDs (SECRETS_SCAN_GAP rule)

const CAM_LIVE = "EFEFEFEF-1111-2222-3333-444455556666";   // still in account
const CAM_ORPHAN = "00112233-AAAA-BBBB-CCCC-DDDDEEEEFFFF"; // removed from account
const CAM_GEN2 = "0A0B0C0D-1111-2222-3333-444455556666";   // for lighting/intercom tests

// ── helpers ───────────────────────────────────────────────────────────────────

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

function resolveBuildModule(name: string): string {
    return path.join(REPO_ROOT, "build", "lib", `${name}.js`);
}

/** Load the adapter module and extract one prototype method by name. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadAdapterMethod(name: string): (...args: any[]) => Promise<unknown> {
    const db = new MockDatabaseCtor();
    let captured: MockAdapter | null = null;
    const core = mockAdapterCoreFn(db, {
        onAdapterCreated: (a) => {
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
    const fn = (captured as any)[name] as (...args: any[]) => Promise<unknown>;
    if (typeof fn !== "function") throw new Error(`${name} not found on adapter`);
    return fn;
}

// ── Full-boot factory for lighting/intercom integration tests ─────────────────

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

    injectModule(resolveBuildModule("snapshot"), {
        fetchSnapshot: sinon.stub().resolves(Buffer.from([0xff, 0xd8, 0xff])),
        buildSnapshotUrl: (u: string): string => `${u}/snap.jpg`,
        SnapshotError: class extends Error {},
    });
    injectModule(resolveBuildModule("live_session"), {
        openLiveSession: sinon.stub().resolves(undefined),
        closeLiveSession: sinon.stub().resolves(undefined),
        LiveSessionError: class extends Error {},
        CameraOfflineError: class extends Error {},
        SessionLimitError: class extends Error {},
    });
    injectModule(resolveBuildModule("tls_proxy"), {
        startTlsProxy: sinon.stub().resolves({
            port: 18050,
            localRtspUrl: "rtsp://127.0.0.1:18050/rtsp_tunnel",
            stop: sinon.stub().resolves(),
        }),
    });
    injectModule(resolveBuildModule("session_watchdog"), {
        SessionWatchdog: class {
            start = sinon.stub();
            stop = sinon.stub();
            constructor(_o: unknown) {}
        },
    });
    const realRcp = require(resolveBuildModule("rcp")) as object;
    injectModule(resolveBuildModule("rcp"), {
        ...realRcp,
        sendRcpCommand: sinon.stub().resolves({ payload: Buffer.alloc(0) }),
    });

    const { EventEmitter } = require("events") as typeof import("events");
    class FakeFcmCbsRegistrationError extends Error {
        constructor() {
            super("CBS registration rejected");
            this.name = "FcmCbsRegistrationError";
        }
    }
    class FakeFcmListener extends EventEmitter {
        start = sinon.stub().rejects(new FakeFcmCbsRegistrationError());
        stop = sinon.stub().resolves();
    }
    injectModule(resolveBuildModule("fcm"), {
        FcmListener: FakeFcmListener,
        FcmCbsRegistrationError: FakeFcmCbsRegistrationError,
        CLOUD_API: "https://residential.cbs.boschsecurity.com",
        FCM_SENDER_ID: "000000000000",
    });

    const cameras = opts.cameraBody ?? [
        {
            id: CAM_GEN2,
            title: "Terrasse",
            hardwareVersion: "HOME_Eyes_Outdoor",
            firmwareVersion: "9.40.25",
            featureSupport: { light: true },
        },
    ];

    stubAxiosByUrl([
        ...(opts.axiosByUrl ?? []),
        { match: "/v11/video_inputs", method: "get", status: 200, data: cameras },
    ]);

    delete require.cache[MAIN_JS_PATH];
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const factory = require(MAIN_JS_PATH) as (opts: Record<string, unknown>) => MockAdapter;
    factory({ config: { redirect_url: "", region: "EU", startup_snapshot: true } });

    if (!capturedAdapter) throw new Error("adapter not captured");
    const adapter = capturedAdapter as TestAdapter;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = adapter as any;
    a.setTimeout = (_fn: () => void, _ms: number) => ({ __mockTimer: true });
    a.clearTimeout = (_h: unknown): void => undefined;
    a.setInterval = (_fn: () => void, _ms: number) => null;
    a.clearInterval = (_h: unknown): void => undefined;
    a.terminate = (): void => undefined;
    a.writeFileAsync = sinon.stub().resolves();
    a.delObjectAsync = (id: string): Promise<void> =>
        new Promise<void>((resolve) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (adapter as any).delObject(id, () => resolve());
        });

    return { db, adapter };
}

async function bootWithTokens(db: MockDatabase, adapter: TestAdapter): Promise<void> {
    db.publishState(`${adapter.namespace}.info.access_token`, { val: "tok.acc", ack: true });
    db.publishState(`${adapter.namespace}.info.refresh_token`, { val: "tok.ref", ack: true });
    db.publishState(`${adapter.namespace}.info.token_expires_at`, {
        val: Date.now() + 200_000,
        ack: true,
    });
    await adapter.readyHandler!();
}

// ── teardown ──────────────────────────────────────────────────────────────────

afterEach(() => {
    restoreAxios();
    sinon.restore();
    delete require.cache[MAIN_JS_PATH];
    for (const name of [
        "snapshot", "live_session", "tls_proxy", "session_watchdog", "fcm", "rcp",
    ]) {
        delete require.cache[resolveBuildModule(name)];
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TASK 1: _pruneOrphanedCameraObjects
// ═══════════════════════════════════════════════════════════════════════════════

describe("_pruneOrphanedCameraObjects — prototype tests", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let prune: (...args: any[]) => Promise<void>;

    before(() => {
        prune = loadAdapterMethod("_pruneOrphanedCameraObjects") as (
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...args: any[]
        ) => Promise<void>;
    });

    // ── safety guard: empty live set ─────────────────────────────────────────

    it("empty liveIds → skips prune + emits warn (safety guard)", async () => {
        const warned: string[] = [];
        const ctx = {
            log: {
                warn: (m: string) => { warned.push(m); },
                debug: sinon.stub(),
                info: sinon.stub(),
            },
            getAdapterObjectsAsync: sinon.stub().resolves({}),
            delObjectAsync: sinon.stub().resolves(),
        };
        await prune.call(ctx, new Set<string>());
        expect(warned.some((w) => w.includes("safety guard")), "safety guard warning").to.equal(true);
        expect(ctx.delObjectAsync.called, "must not delete anything").to.equal(false);
    });

    // ── no orphans: all channels in live set ─────────────────────────────────

    it("all existing channels are live → no deletions", async () => {
        const ns = "bosch-smart-home-camera.0";
        const objs: Record<string, { type: string }> = {
            [`${ns}.cameras.${CAM_LIVE}`]: { type: "channel" },
            [`${ns}.cameras.${CAM_LIVE}.online`]: { type: "state" },
        };
        const del = sinon.stub().resolves();
        const infos: string[] = [];
        const ctx = {
            log: { warn: sinon.stub(), debug: sinon.stub(), info: (m: string) => { infos.push(m); } },
            getAdapterObjectsAsync: sinon.stub().resolves(objs),
            delObjectAsync: del,
        };
        await prune.call(ctx, new Set([CAM_LIVE]));
        expect(del.called, "no deletions").to.equal(false);
        expect(infos.some((m) => m.includes("no orphaned")), "no-orphan debug logged").to.equal(false);
        // Should reach the "debug: no orphaned" path (not info)
    });

    // ── one orphan subtree deleted ────────────────────────────────────────────

    it("orphan channel + states → full subtree deleted, live camera untouched", async () => {
        const ns = "bosch-smart-home-camera.0";
        const objs: Record<string, { type: string }> = {
            // orphaned camera
            [`${ns}.cameras.${CAM_ORPHAN}`]: { type: "channel" },
            [`${ns}.cameras.${CAM_ORPHAN}.online`]: { type: "state" },
            [`${ns}.cameras.${CAM_ORPHAN}.name`]: { type: "state" },
            // live camera — must NOT be deleted
            [`${ns}.cameras.${CAM_LIVE}`]: { type: "channel" },
            [`${ns}.cameras.${CAM_LIVE}.online`]: { type: "state" },
        };
        const deleted: string[] = [];
        const del = sinon.stub().callsFake((id: string) => {
            deleted.push(id);
            return Promise.resolve();
        });
        const infos: string[] = [];
        const ctx = {
            log: {
                warn: sinon.stub(),
                debug: sinon.stub(),
                info: (m: string) => { infos.push(m); },
            },
            getAdapterObjectsAsync: sinon.stub().resolves(objs),
            delObjectAsync: del,
        };
        await prune.call(ctx, new Set([CAM_LIVE]));

        // The orphan channel and its two child states should be deleted
        expect(deleted).to.include(`cameras.${CAM_ORPHAN}`);
        expect(deleted).to.include(`cameras.${CAM_ORPHAN}.online`);
        expect(deleted).to.include(`cameras.${CAM_ORPHAN}.name`);
        // The live camera must NOT be deleted
        expect(deleted.some((d) => d.includes(CAM_LIVE)), "live camera not touched").to.equal(false);
        // Log confirms one orphan subtree pruned
        expect(infos.some((m) => m.includes("Pruned orphaned camera subtree")), "prune logged").to.equal(true);
        expect(infos.some((m) => m.includes("removed 1 orphaned camera subtree")), "summary logged").to.equal(true);
    });

    // ── multiple orphans ──────────────────────────────────────────────────────

    it("two orphan subtrees → both deleted, summary mentions 2", async () => {
        const ORPHAN_2 = "FFFFFFFF-0000-1111-2222-333344445555";
        const ns = "bosch-smart-home-camera.0";
        const objs: Record<string, { type: string }> = {
            [`${ns}.cameras.${CAM_ORPHAN}`]: { type: "channel" },
            [`${ns}.cameras.${CAM_ORPHAN}.online`]: { type: "state" },
            [`${ns}.cameras.${ORPHAN_2}`]: { type: "channel" },
            [`${ns}.cameras.${ORPHAN_2}.online`]: { type: "state" },
        };
        const deleted: string[] = [];
        const ctx = {
            log: { warn: sinon.stub(), debug: sinon.stub(), info: (m: string) => { deleted.push("log:" + m); } },
            getAdapterObjectsAsync: sinon.stub().resolves(objs),
            delObjectAsync: (id: string) => { deleted.push(id); return Promise.resolve(); },
        };
        // No live cameras — both orphans
        await prune.call(ctx, new Set([CAM_LIVE]));
        expect(deleted.some((d) => d.includes("removed 2 orphaned")), "summary mentions 2").to.equal(true);
    });

    // ── getAdapterObjectsAsync throws → warn, no re-throw ────────────────────

    it("getAdapterObjectsAsync throws → warn logged, function resolves (non-fatal)", async () => {
        const warned: string[] = [];
        const ctx = {
            log: {
                warn: (m: string) => { warned.push(m); },
                debug: sinon.stub(),
                info: sinon.stub(),
            },
            getAdapterObjectsAsync: sinon.stub().rejects(new Error("DB unavailable")),
            delObjectAsync: sinon.stub().resolves(),
        };
        // Must not throw — use explicit try/catch (chai-as-promised not loaded)
        let threw = false;
        try {
            await prune.call(ctx, new Set([CAM_LIVE]));
        } catch {
            threw = true;
        }
        expect(threw, "must not throw").to.equal(false);
        expect(warned.some((w) => w.includes("_pruneOrphanedCameraObjects failed")), "error logged").to.equal(true);
    });

    // ── delObjectAsync throws for one child → swallowed, rest continues ───────

    it("delObjectAsync throws for one child → error swallowed, prune continues", async () => {
        const ns = "bosch-smart-home-camera.0";
        const objs: Record<string, { type: string }> = {
            [`${ns}.cameras.${CAM_ORPHAN}`]: { type: "channel" },
            [`${ns}.cameras.${CAM_ORPHAN}.online`]: { type: "state" },
            [`${ns}.cameras.${CAM_ORPHAN}.name`]: { type: "state" },
        };
        let callCount = 0;
        const ctx = {
            log: { warn: sinon.stub(), debug: sinon.stub(), info: sinon.stub() },
            getAdapterObjectsAsync: sinon.stub().resolves(objs),
            delObjectAsync: () => {
                callCount++;
                if (callCount === 1) return Promise.reject(new Error("delete failed"));
                return Promise.resolve();
            },
        };
        // Must not throw — use explicit try/catch (chai-as-promised not loaded)
        let threw = false;
        try {
            await prune.call(ctx, new Set([CAM_LIVE]));
        } catch {
            threw = true;
        }
        expect(threw, "must not throw").to.equal(false);
        // Despite the first delete failing, remaining deletes were attempted
        expect(callCount).to.be.greaterThan(1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TASK 1 (boot-level): orphan cleanup integrated in onReady
// ═══════════════════════════════════════════════════════════════════════════════

describe("_pruneOrphanedCameraObjects — boot integration via full adapter", () => {
    it("orphaned camera channel deleted on boot when NOT in live list", async () => {
        const { db, adapter } = makeAdapter({
            cameraBody: [
                {
                    id: CAM_GEN2,
                    title: "Terrasse",
                    hardwareVersion: "HOME_Eyes_Outdoor",
                    firmwareVersion: "9.40.25",
                    featureSupport: { light: true },
                },
            ],
        });

        // Pre-publish an orphan camera channel + child state in the DB
        const orphanChannelId = `${adapter.namespace}.cameras.${CAM_ORPHAN}`;
        const orphanStateId = `${adapter.namespace}.cameras.${CAM_ORPHAN}.online`;
        db.publishObject({
            _id: orphanChannelId,
            type: "channel",
            common: { name: "old camera" },
            native: {},
        });
        db.publishObject({
            _id: orphanStateId,
            type: "state",
            common: { role: "info.status", name: "online", type: "boolean", read: true, write: false },
            native: {},
        });

        expect(db.getObject(orphanChannelId), "orphan channel exists before boot").to.not.be.null;

        await bootWithTokens(db, adapter);

        // After boot the orphan channel should be gone (deleted by _pruneOrphanedCameraObjects)
        expect(
            db.getObject(orphanChannelId) ?? null,
            "orphan channel deleted after boot",
        ).to.be.null;
    });

    it("live camera channel is preserved on boot", async () => {
        const { db, adapter } = makeAdapter({
            cameraBody: [
                {
                    id: CAM_GEN2,
                    title: "Terrasse",
                    hardwareVersion: "HOME_Eyes_Outdoor",
                    firmwareVersion: "9.40.25",
                    featureSupport: { light: true },
                },
            ],
        });

        await bootWithTokens(db, adapter);

        // The live camera channel should have been created by ensureCameraObjects
        const liveChannelId = `${adapter.namespace}.cameras.${CAM_GEN2}`;
        expect(db.getObject(liveChannelId), "live camera channel exists after boot").to.not.be.null;
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TASK 2: Coverage gaps — _putLightingMerge / _handleMotionLightWrite /
//          _handleAmbientLightWrite / _handleIntercomWrite
// ═══════════════════════════════════════════════════════════════════════════════

describe("_putLightingMerge — direct prototype tests", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let putMerge: (...args: any[]) => Promise<boolean>;

    before(() => {
        putMerge = loadAdapterMethod("_putLightingMerge") as (
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...args: any[]
        ) => Promise<boolean>;
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function makeCtx(getStatus: number, putStatus: number, cached?: Record<string, unknown>): any {
        const cache = new Map<string, Record<string, unknown>>();
        if (cached) cache.set(CAM_GEN2, cached);
        return {
            _currentAccessToken: "fake-token",
            _motionLightCache: cache,
            log: { warn: sinon.stub(), info: sinon.stub(), debug: sinon.stub() },
            _httpClient: {
                get: sinon.stub().resolves({ status: getStatus, data: { existing: true } }),
                put: sinon.stub().resolves({ status: putStatus, data: null }),
            },
        };
    }

    it("cache miss — GET then PUT 200 → returns true, caches merged body", async () => {
        const ctx = makeCtx(200, 200);
        const result = await putMerge.call(ctx, CAM_GEN2, "motion", ctx._motionLightCache, { lightOnMotionEnabled: true });
        expect(result, "returns true on success").to.equal(true);
        // body was cached after PUT
        expect(ctx._motionLightCache.has(CAM_GEN2), "body cached").to.equal(true);
    });

    it("cache hit — skips GET, uses cached body + PUT 200 → returns true", async () => {
        const cached = { lightOnMotionEnabled: false, motionLightSensitivity: 3 };
        const ctx = makeCtx(200, 200, cached);
        const result = await putMerge.call(ctx, CAM_GEN2, "motion", ctx._motionLightCache, { lightOnMotionEnabled: true });
        expect(result, "returns true").to.equal(true);
        expect(ctx._httpClient.get.called, "GET not called when cached").to.equal(false);
    });

    it("GET returns 443 (privacy) → returns false, no PUT", async () => {
        const ctx = makeCtx(443, 200);
        const result = await putMerge.call(ctx, CAM_GEN2, "motion", ctx._motionLightCache, { lightOnMotionEnabled: true });
        expect(result, "returns false on GET 443").to.equal(false);
        expect(ctx._httpClient.put.called, "PUT not called").to.equal(false);
    });

    it("PUT returns 443 (privacy) → returns false", async () => {
        const ctx = makeCtx(200, 443);
        const result = await putMerge.call(ctx, CAM_GEN2, "motion", ctx._motionLightCache, { lightOnMotionEnabled: true });
        expect(result, "returns false on PUT 443").to.equal(false);
    });

    it("no access token → throws", async () => {
        const ctx = makeCtx(200, 200);
        ctx._currentAccessToken = undefined;
        // use try/catch — chai-as-promised not loaded in this harness
        let errMsg = "";
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await putMerge.call(ctx, CAM_GEN2, "motion", ctx._motionLightCache, {} as any);
        } catch (e: unknown) {
            errMsg = e instanceof Error ? e.message : String(e);
        }
        expect(errMsg).to.include("no access token");
    });
});

describe("_handleMotionLightWrite — direct prototype tests", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let handleMotion: (...args: any[]) => Promise<boolean>;

    before(() => {
        handleMotion = loadAdapterMethod("_handleMotionLightWrite") as (
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...args: any[]
        ) => Promise<boolean>;
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function motionCtx(): any {
        return {
            _currentAccessToken: "tok",
            _motionLightCache: new Map<string, Record<string, unknown>>(),
            log: { warn: sinon.stub(), info: sinon.stub(), debug: sinon.stub() },
            _httpClient: {
                get: sinon.stub().resolves({ status: 200, data: {} }),
                put: sinon.stub().resolves({ status: 200, data: null }),
            },
            _putLightingMerge: sinon.stub().resolves(true),
        };
    }

    it("enabled=true delta → calls _putLightingMerge with lightOnMotionEnabled:true", async () => {
        const ctx = motionCtx();
        ctx._handleMotionLightWrite = handleMotion;
        const result = await handleMotion.call(ctx, CAM_GEN2, { enabled: true });
        expect(result).to.equal(true);
        const [, sub, , body] = ctx._putLightingMerge.firstCall.args as [string, string, unknown, Record<string, unknown>];
        expect(sub, "sub-endpoint").to.equal("motion");
        expect(body.lightOnMotionEnabled, "enabled flag mapped").to.equal(true);
    });

    it("sensitivity=3 delta → body has motionLightSensitivity:3", async () => {
        const ctx = motionCtx();
        await handleMotion.call(ctx, CAM_GEN2, { sensitivity: 3 });
        const [, , , body] = ctx._putLightingMerge.firstCall.args as [string, string, unknown, Record<string, unknown>];
        expect(body.motionLightSensitivity, "sensitivity mapped").to.equal(3);
        expect(Object.prototype.hasOwnProperty.call(body, "lightOnMotionEnabled"), "enabled not in body").to.equal(false);
    });

    it("sensitivity clamped: 0 → 1, 6 → 5", async () => {
        const ctx = motionCtx();
        await handleMotion.call(ctx, CAM_GEN2, { sensitivity: 0 });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body0 = ctx._putLightingMerge.getCall(0).args[3] as any;
        expect(body0.motionLightSensitivity).to.equal(1);

        ctx._putLightingMerge.resetHistory();
        await handleMotion.call(ctx, CAM_GEN2, { sensitivity: 99 });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body99 = ctx._putLightingMerge.getCall(0).args[3] as any;
        expect(body99.motionLightSensitivity).to.equal(5);
    });
});

describe("_handleAmbientLightWrite — direct prototype tests", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let handleAmbient: (...args: any[]) => Promise<boolean>;

    before(() => {
        handleAmbient = loadAdapterMethod("_handleAmbientLightWrite") as (
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...args: any[]
        ) => Promise<boolean>;
    });

    it("on=true → calls _putLightingMerge with ambientLightEnabled:true", async () => {
        const putMerge = sinon.stub().resolves(true);
        const ctx = {
            _currentAccessToken: "tok",
            _ambientLightCache: new Map<string, Record<string, unknown>>(),
            log: { warn: sinon.stub(), info: sinon.stub() },
            _httpClient: {
                get: sinon.stub().resolves({ status: 200, data: {} }),
                put: sinon.stub().resolves({ status: 200, data: null }),
            },
            _putLightingMerge: putMerge,
        };
        const result = await handleAmbient.call(ctx, CAM_GEN2, true);
        expect(result).to.equal(true);
        const [, sub, , body] = putMerge.firstCall.args as [string, string, unknown, Record<string, unknown>];
        expect(sub).to.equal("ambient");
        expect(body.ambientLightEnabled).to.equal(true);
    });

    it("on=false → ambientLightEnabled:false", async () => {
        const putMerge = sinon.stub().resolves(true);
        const ctx = {
            _currentAccessToken: "tok",
            _ambientLightCache: new Map<string, Record<string, unknown>>(),
            log: { warn: sinon.stub(), info: sinon.stub() },
            _httpClient: {
                get: sinon.stub().resolves({ status: 200, data: {} }),
                put: sinon.stub().resolves({ status: 200, data: null }),
            },
            _putLightingMerge: putMerge,
        };
        await handleAmbient.call(ctx, CAM_GEN2, false);
        const [, , , body] = putMerge.firstCall.args as [string, string, unknown, Record<string, unknown>];
        expect(body.ambientLightEnabled).to.equal(false);
    });
});

describe("_handleIntercomWrite — direct prototype tests", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let handleIntercom: (...args: any[]) => Promise<void>;

    before(() => {
        handleIntercom = loadAdapterMethod("_handleIntercomWrite") as (
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...args: any[]
        ) => Promise<void>;
    });

    it("on=true, no cache → GET then PUT with audioEnabled:true", async () => {
        const getStub = sinon.stub().resolves({ status: 200, data: { audioEnabled: false } });
        const putStub = sinon.stub().resolves({ status: 200 });
        const cache = new Map<string, Record<string, unknown>>();
        const ctx = {
            _currentAccessToken: "tok",
            _audioCache: cache,
            log: { info: sinon.stub(), debug: sinon.stub() },
            _httpClient: { get: getStub, put: putStub },
        };
        await handleIntercom.call(ctx, CAM_GEN2, true);
        expect(getStub.called, "GET called (no cache)").to.equal(true);
        const putBody = putStub.firstCall.args[1] as Record<string, unknown>;
        expect(putBody.audioEnabled, "audioEnabled set").to.equal(true);
        expect(cache.has(CAM_GEN2), "body cached").to.equal(true);
    });

    it("on=false, cache hit → no GET, PUT with audioEnabled:false", async () => {
        const getStub = sinon.stub().resolves({ status: 200, data: {} });
        const putStub = sinon.stub().resolves({ status: 200 });
        const cache = new Map<string, Record<string, unknown>>();
        cache.set(CAM_GEN2, { audioEnabled: true });
        const ctx = {
            _currentAccessToken: "tok",
            _audioCache: cache,
            log: { info: sinon.stub(), debug: sinon.stub() },
            _httpClient: { get: getStub, put: putStub },
        };
        await handleIntercom.call(ctx, CAM_GEN2, false);
        expect(getStub.called, "GET not called (cached)").to.equal(false);
        const putBody = putStub.firstCall.args[1] as Record<string, unknown>;
        expect(putBody.audioEnabled).to.equal(false);
    });

    it("no access token → throws", async () => {
        const ctx = {
            _currentAccessToken: undefined,
            _audioCache: new Map<string, Record<string, unknown>>(),
            log: { info: sinon.stub() },
            _httpClient: { get: sinon.stub(), put: sinon.stub() },
        };
        // use try/catch — chai-as-promised not loaded
        let errMsg = "";
        try {
            await handleIntercom.call(ctx, CAM_GEN2, true);
        } catch (e: unknown) {
            errMsg = e instanceof Error ? e.message : String(e);
        }
        expect(errMsg).to.include("no access token");
    });
});
