/**
 * Tests for the opt-in stream idle-reaper (request-saving).
 *
 * When enabled it turns off a livestream whose RTSP proxy has had zero clients
 * for `stream_idle_timeout` seconds, freeing the shared Bosch session. A stream
 * with a live client is never reaped; a stream the user did not enable is left
 * alone. `_streamIdleTimeoutMs` clamps the configured timeout to 30–3600 s.
 *
 * Methods are pulled off the adapter prototype/instance and invoked against a
 * hand-made `this` stub (same technique as main_privacy_online_reconcile.spec.ts).
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

describe("stream idle-reaper — _streamIdleTimeoutMs clamping", () => {
    let getter: (this: unknown) => number;
    before(() => {
        const proto = Object.getPrototypeOf(loadAdapter());
        const desc = Object.getOwnPropertyDescriptor(proto, "_streamIdleTimeoutMs");
        if (!desc || typeof desc.get !== "function") {
            throw new Error("_streamIdleTimeoutMs getter not found");
        }
        getter = desc.get as (this: unknown) => number;
    });
    const ms = (stream_idle_timeout: unknown): number => getter.call({ config: { stream_idle_timeout } });

    it("undefined → 180 s default", () => expect(ms(undefined)).to.equal(180_000));
    it("below minimum (10 s) → 180 s default", () => expect(ms(10)).to.equal(180_000));
    it("zero → 180 s default", () => expect(ms(0)).to.equal(180_000));
    it("minimum (30 s) → 30 000 ms", () => expect(ms(30)).to.equal(30_000));
    it("default (180 s) → 180 000 ms", () => expect(ms(180)).to.equal(180_000));
    it("above maximum (5000 s) → clamped to 3 600 000 ms", () => expect(ms(5000)).to.equal(3_600_000));
});

describe("stream idle-reaper — _streamReaperTick", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let tick: (...a: any[]) => Promise<void>;
    before(() => {
        tick = loadAdapter()._streamReaperTick;
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function stub(opts: { clients: number; enabled: boolean | null; idleSince?: number }): any {
        return {
            _tlsProxies: new Map([[CAM, { activeClientCount: () => opts.clients }]]),
            _streamIdleSince:
                opts.idleSince === undefined ? new Map<string, number>() : new Map([[CAM, opts.idleSince]]),
            _streamIdleTimeoutMs: 180_000,
            getStateAsync: sinon.stub().resolves(opts.enabled === null ? null : { val: opts.enabled }),
            setStateAsync: sinon.stub().resolves(undefined),
            log: { info: sinon.stub(), debug: sinon.stub() },
        };
    }

    function reapCall(s: { setStateAsync: sinon.SinonStub }): sinon.SinonSpyCall | undefined {
        return s.setStateAsync
            .getCalls()
            .find((c: sinon.SinonSpyCall) => String(c.args[0]).endsWith(".livestream_enabled"));
    }

    it("a watched stream (clients>0) is never reaped, idle clock reset", async () => {
        const s = stub({ clients: 2, enabled: true, idleSince: Date.now() - 999_999 });
        await tick.call(s);
        expect(reapCall(s), "no livestream write").to.equal(undefined);
        expect(s._streamIdleSince.has(CAM), "idle clock cleared").to.equal(false);
    });

    it("a stream the user did not enable is left alone", async () => {
        const s = stub({ clients: 0, enabled: false, idleSince: Date.now() - 999_999 });
        await tick.call(s);
        expect(reapCall(s)).to.equal(undefined);
        expect(s._streamIdleSince.has(CAM)).to.equal(false);
    });

    it("first zero-client tick arms the idle clock but does not reap", async () => {
        const s = stub({ clients: 0, enabled: true });
        await tick.call(s);
        expect(reapCall(s)).to.equal(undefined);
        expect(s._streamIdleSince.has(CAM), "idle clock armed").to.equal(true);
    });

    it("zero clients but within timeout → not reaped", async () => {
        const s = stub({ clients: 0, enabled: true, idleSince: Date.now() - 60_000 });
        await tick.call(s);
        expect(reapCall(s)).to.equal(undefined);
    });

    it("zero clients past timeout → livestream turned off (ack:false)", async () => {
        const s = stub({ clients: 0, enabled: true, idleSince: Date.now() - 200_000 });
        await tick.call(s);
        const call = reapCall(s);
        expect(call, "livestream_enabled written").to.not.equal(undefined);
        expect(call?.args[1], "set to false").to.equal(false);
        expect(call?.args[2], "ack:false → triggers teardown path").to.equal(false);
        expect(s._streamIdleSince.has(CAM), "idle clock cleared after reap").to.equal(false);
    });
});
