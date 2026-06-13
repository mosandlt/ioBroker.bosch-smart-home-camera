/**
 * Tests for the always-on persistent RTSP endpoint (forum #84538, v1.5.4+).
 *
 * Covers the guards that are easy to get wrong:
 *   - _persistentIdleTimeoutMs clamping (10–3600 s, default 60 s)
 *   - _reapPersistentIdle: never releases a session while a client is connected,
 *     while the user explicitly enabled the livestream, or when nothing is open
 *   - _resolvePersistentInner coalesces simultaneous connects onto one session
 *   - _logLivestreamHintIfAllOff is suppressed while the endpoint is on (default)
 *
 * Methods are pulled off the adapter prototype/instance and invoked against a
 * hand-made `this` stub (same technique as main_stream_idle_reaper.spec.ts).
 */

import { expect } from "chai";
import sinon from "sinon";
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadAdapter(): any {
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
    if (!captured) {
        throw new Error("adapter not captured");
    }
    return captured;
}

const CAM = "EFEFEFEF-1111-2222-3333-444455556666";

// ── _persistentIdleTimeoutMs clamping ────────────────────────────────────────
describe("persistent endpoint — _persistentIdleTimeoutMs clamping", () => {
    let getter: (this: unknown) => number;
    before(() => {
        const proto = Object.getPrototypeOf(loadAdapter());
        const desc = Object.getOwnPropertyDescriptor(proto, "_persistentIdleTimeoutMs");
        if (!desc || typeof desc.get !== "function") {
            throw new Error("_persistentIdleTimeoutMs getter not found");
        }
        getter = desc.get as (this: unknown) => number;
    });
    const ms = (v: unknown): number =>
        getter.call({ config: { stream_persistent_idle_timeout: v } });

    it("undefined → 60 s default", () => expect(ms(undefined)).to.equal(60_000));
    it("below minimum (5 s) → 60 s default", () => expect(ms(5)).to.equal(60_000));
    it("minimum (10 s) → 10 000 ms", () => expect(ms(10)).to.equal(10_000));
    it("default (60 s) → 60 000 ms", () => expect(ms(60)).to.equal(60_000));
    it("above maximum (9999 s) → clamped to 3 600 000 ms", () =>
        expect(ms(9999)).to.equal(3_600_000));
});

// ── _reapPersistentIdle ──────────────────────────────────────────────────────
describe("persistent endpoint — _reapPersistentIdle", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let reap: (...a: any[]) => Promise<void>;
    before(() => {
        reap = loadAdapter()._reapPersistentIdle;
    });

    function stub(opts: {
        hasDoor?: boolean;
        clients?: number;
        enabled?: boolean | null;
        hasSession?: boolean;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }): any {
        const door = { activeClientCount: () => opts.clients ?? 0 };
        return {
            _lazyFrontDoors:
                opts.hasDoor === false ? new Map() : new Map([[CAM, door]]),
            _liveSessions: opts.hasSession ? new Map([[CAM, {}]]) : new Map(),
            _persistentIdleTimeoutMs: 60_000,
            getStateAsync: sinon
                .stub()
                .resolves(opts.enabled === null || opts.enabled === undefined ? null : { val: opts.enabled }),
            _teardownStream: sinon.stub().resolves(undefined),
            log: { debug: sinon.stub() },
        };
    }

    it("no front-door for the camera → nothing happens", async () => {
        const s = stub({ hasDoor: false, hasSession: true });
        await reap.call(s, CAM);
        expect(s._teardownStream.called).to.equal(false);
    });

    it("a client is still connected → session NOT released", async () => {
        const s = stub({ clients: 1, enabled: false, hasSession: true });
        await reap.call(s, CAM);
        expect(s._teardownStream.called).to.equal(false);
    });

    it("user explicitly enabled the livestream → session NOT released", async () => {
        const s = stub({ clients: 0, enabled: true, hasSession: true });
        await reap.call(s, CAM);
        expect(s._teardownStream.called).to.equal(false);
    });

    it("no open Bosch session → nothing to release", async () => {
        const s = stub({ clients: 0, enabled: false, hasSession: false });
        await reap.call(s, CAM);
        expect(s._teardownStream.called).to.equal(false);
    });

    it("idle + livestream off + session open → session released (front-door stays)", async () => {
        const s = stub({ clients: 0, enabled: false, hasSession: true });
        await reap.call(s, CAM);
        expect(s._teardownStream.calledOnceWith(CAM)).to.equal(true);
    });
});

// ── _resolvePersistentInner coalescing ───────────────────────────────────────
describe("persistent endpoint — _resolvePersistentInner coalesces concurrent connects", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resolveInner: (...a: any[]) => Promise<number | null>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let openInner: (...a: any[]) => Promise<number | null>;
    before(() => {
        const a = loadAdapter();
        resolveInner = a._resolvePersistentInner;
        openInner = a._openPersistentInner;
    });

    it("two simultaneous connects share ONE ensureLiveSession", async () => {
        const ensure = sinon.stub().callsFake(
            () => new Promise((r) => setTimeout(r, 20)),
        );
        const s = {
            _cancelFrontDoorIdle: sinon.stub(),
            _persistentInflight: new Map<string, Promise<number | null>>(),
            _openPersistentInner: openInner,
            ensureLiveSession: ensure,
            _tlsProxies: new Map([[CAM, { port: 54321 }]]),
            log: { debug: sinon.stub() },
        };
        const [a, b] = await Promise.all([resolveInner.call(s, CAM), resolveInner.call(s, CAM)]);
        expect(ensure.callCount, "ensureLiveSession opened once for both").to.equal(1);
        expect(a).to.equal(54321);
        expect(b).to.equal(54321);
        expect(s._persistentInflight.size, "in-flight entry cleared after").to.equal(0);
    });

    it("returns null when the session can't be opened", async () => {
        const s = {
            _cancelFrontDoorIdle: sinon.stub(),
            _persistentInflight: new Map<string, Promise<number | null>>(),
            _openPersistentInner: openInner,
            ensureLiveSession: sinon.stub().rejects(new Error("offline")),
            _tlsProxies: new Map(),
            log: { debug: sinon.stub() },
        };
        expect(await resolveInner.call(s, CAM)).to.equal(null);
    });
});

// ── _logLivestreamHintIfAllOff — opt-in (default off) suppression ────────────
describe("persistent endpoint — startup hint suppressed only when endpoint is on", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let hint: (...a: any[]) => boolean;
    before(() => {
        hint = loadAdapter()._logLivestreamHintIfAllOff;
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function stub(persistent: unknown): any {
        return {
            config: { stream_persistent_endpoint: persistent, rtsp_expose_to_lan: true },
            _livestreamEnabled: new Map(),
            log: { info: sinon.stub() },
        };
    }
    const cams = [{ id: CAM }];

    it("endpoint unset (opt-in default off) + all streams off → hint IS logged", () => {
        const s = stub(undefined);
        expect(hint.call(s, cams)).to.equal(true);
        expect(s.log.info.calledOnce).to.equal(true);
    });

    it("endpoint explicitly on → hint suppressed (endpoint always reachable)", () => {
        const s = stub(true);
        expect(hint.call(s, cams)).to.equal(false);
        expect(s.log.info.called).to.equal(false);
    });

    it("endpoint explicitly off + all streams off → hint IS logged", () => {
        const s = stub(false);
        expect(hint.call(s, cams)).to.equal(true);
        expect(s.log.info.calledOnce).to.equal(true);
    });
});
