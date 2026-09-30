/**
 * Coverage for the vis-2 web-stream subscription handlers, persistent front-door
 * idle timers and IPv6 SSRF classification. Methods run against a stub `this`.
 */

import { expect } from "chai";
import sinon from "sinon";
import * as path from "path";

import type { MockDatabase } from "@iobroker/testing/build/tests/unit/mocks/mockDatabase";
import type { MockAdapter } from "@iobroker/testing/build/tests/unit/mocks/mockAdapter";
import { isPrivateOrReservedAddress } from "../../src/lib/ssrf_guard";

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
let capturedOpts: any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadAdapter(): any {
    const db = new MockDatabaseCtor();
    let captured: MockAdapter | null = null;
    const core = mockAdapterCoreFn(db, {
        onAdapterCreated: (a) => {
            captured = a;
        },
    });
    const Base = (core as { Adapter: new (x: unknown) => object }).Adapter;
    const Wrapped = function (this: unknown, o: Record<string, unknown>) {
        capturedOpts = o;
        return Reflect.construct(Base, [o], new.target);
    } as unknown as { prototype: object };
    Wrapped.prototype = Base.prototype;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[ADAPTER_CORE_PATH] = {
        id: ADAPTER_CORE_PATH,
        filename: ADAPTER_CORE_PATH,
        loaded: true,
        parent: module,
        children: [],
        path: path.dirname(ADAPTER_CORE_PATH),
        paths: [],
        exports: {
            ...(core as object),
            Adapter: Wrapped,
        },
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


// eslint-disable-next-line @typescript-eslint/no-explicit-any
let proto: any;
before(() => {
    proto = Object.getPrototypeOf(loadAdapter());
});

const CAM = "11111111-2222-3333-4444-555555555555";

describe("web-stream subscription handlers", () => {
    it("constructor wires uiClientSubscribe/uiClientUnsubscribe to the handlers", () => {
        const a = loadAdapter();
        const sub = sinon.stub(a, "onUiClientSubscribe").returns({ accepted: true });
        const unsub = sinon.stub(a, "onUiClientUnsubscribe");
        const info = { clientId: "c" };
        expect(capturedOpts.uiClientSubscribe(info)).to.deep.equal({ accepted: true });
        capturedOpts.uiClientUnsubscribe(info);
        expect(sub.calledOnceWithExactly(info)).to.equal(true);
        expect(unsub.calledOnceWithExactly(info)).to.equal(true);
    });

    function ctx(proxy: boolean, addViewer = true) {
        const self = {
            _tlsProxies: new Map(proxy ? [[CAM, { localRtspUrl: "rtsp://127.0.0.1:1/x" }]] : []),
            _webStream: { addViewer: sinon.stub().returns(addViewer), removeViewer: sinon.stub() },
            _resolveWebStreamUrl(id: string) {
                return proto._resolveWebStreamUrl.call(self, id);
            },
        };
        return self;
    }
    const msg = (type?: unknown, data?: unknown) => ({
        clientId: "c1",
        message: { message: { type, data } },
    });

    it("resolves the local RTSP url only when a proxy exists", () => {
        expect(ctx(true)._resolveWebStreamUrl(CAM)).to.equal("rtsp://127.0.0.1:1/x?inst=1");
        expect(ctx(false)._resolveWebStreamUrl(CAM)).to.equal(null);
    });

    it("rejects unknown subscription types", () => {
        const r = proto.onUiClientSubscribe.call(ctx(true), msg("other/x"));
        expect(r.accepted).to.equal(false);
        expect(proto.onUiClientSubscribe.call(ctx(true), { clientId: "c" }).accepted).to.equal(false);
    });

    it("rejects when no live stream is active", () => {
        const r = proto.onUiClientSubscribe.call(ctx(false), msg(`startCamera/${CAM}`));
        expect(r.accepted).to.equal(false);
        expect(r.error).to.contain("livestream_enabled");
    });

    it("rejects when the stream cannot start", () => {
        const r = proto.onUiClientSubscribe.call(ctx(true, false), msg(`startCamera/${CAM}`));
        expect(r).to.deep.equal({ accepted: false, error: "Could not start stream" });
    });

    it("accepts a viewer and passes the requested width", () => {
        const self = ctx(true);
        const r = proto.onUiClientSubscribe.call(self, msg(`startCamera/${CAM}`, { width: 320 }));
        expect(r).to.deep.equal({ accepted: true, heartbeat: 60000 });
        expect(self._webStream.addViewer.calledWith("c1", CAM, 320)).to.equal(true);
    });

    it("unsubscribe without body drops the viewer from every camera", () => {
        const self = ctx(true);
        proto.onUiClientUnsubscribe.call(self, { clientId: "c1" });
        expect(self._webStream.removeViewer.calledOnceWithExactly("c1")).to.equal(true);
    });

    it("unsubscribe with typed body drops only the named cameras", () => {
        const self = ctx(true);
        proto.onUiClientUnsubscribe.call(self, msg([`startCamera/${CAM}`, "bogus", ""]));
        expect(self._webStream.removeViewer.calledOnceWithExactly("c1", CAM)).to.equal(true);
        const s2 = ctx(true);
        proto.onUiClientUnsubscribe.call(s2, msg(`startCamera/${CAM}`));
        expect(s2._webStream.removeViewer.calledOnceWithExactly("c1", CAM)).to.equal(true);
    });
});

describe("persistent front-door idle timer", () => {
    function ctx(opts: { unloading?: boolean; door?: boolean } = {}) {
        const self = {
            _isUnloading: !!opts.unloading,
            _lazyFrontDoors: new Map(opts.door === false ? [] : [[CAM, {}]]),
            _frontDoorIdleTimers: new Map<string, unknown>(),
            _persistentIdleTimeoutMs: 10,
            log: { debug: sinon.stub() },
            setTimeout: sinon.stub().callsFake(() => "timer"),
            clearTimeout: sinon.stub(),
            _reapPersistentIdle: sinon.stub().resolves(),
            _cancelFrontDoorIdle(id: string) {
                return proto._cancelFrontDoorIdle.call(self, id);
            },
        };
        return self;
    }

    it("does nothing while unloading or without a front door", () => {
        const a = ctx({ unloading: true });
        proto._armFrontDoorIdle.call(a, CAM);
        const b = ctx({ door: false });
        proto._armFrontDoorIdle.call(b, CAM);
        expect(a.setTimeout.called).to.equal(false);
        expect(b.setTimeout.called).to.equal(false);
    });

    it("arms a timer, re-arming cancels the previous one", () => {
        const self = ctx();
        proto._armFrontDoorIdle.call(self, CAM);
        expect(self._frontDoorIdleTimers.get(CAM)).to.equal("timer");
        proto._armFrontDoorIdle.call(self, CAM);
        expect(self.clearTimeout.calledOnceWithExactly("timer")).to.equal(true);
    });

    it("timer callback clears itself and reaps, swallowing reap errors", async () => {
        const self = ctx();
        self._reapPersistentIdle.rejects(new Error("boom"));
        proto._armFrontDoorIdle.call(self, CAM);
        self.setTimeout.firstCall.args[0]();
        await new Promise((r) => setImmediate(r));
        expect(self._frontDoorIdleTimers.has(CAM)).to.equal(false);
        expect(self.log.debug.calledOnce).to.equal(true);
    });

    it("cancel is a no-op without a pending timer", () => {
        const self = ctx();
        proto._cancelFrontDoorIdle.call(self, CAM);
        expect(self.clearTimeout.called).to.equal(false);
    });
});

describe("isPrivateOrReservedAddress IPv6", () => {
    for (const addr of ["::", "::1", "fe80::1", "febf::1", "fc00::1", "fd12::1", "::ffff:10.0.0.1"]) {
        it(`rejects ${addr}`, () => expect(isPrivateOrReservedAddress(addr)).to.equal(true));
    }
    for (const addr of ["2606:4700::1111", "::ffff:8.8.8.8"]) {
        it(`allows ${addr}`, () => expect(isPrivateOrReservedAddress(addr)).to.equal(false));
    }
    it("rejects non-IP input", () => expect(isPrivateOrReservedAddress("nope")).to.equal(true));
});

describe("persistent endpoint front-door callbacks", () => {
    it("wires log/resolveInner/onActive/onIdle into the lazy front door", async () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const net = require("net") as typeof import("net");
        const log = { info: sinon.stub(), warn: sinon.stub(), debug: sinon.stub(), error: sinon.stub() };
        const self = {
            config: { stream_persistent_endpoint: true },
            log,
            _lazyFrontDoors: new Map<string, { port: number; localRtspUrl: string; stop(): Promise<void> }>(),
            _stickyProxyPort: new Map<string, number>(),
            _rtspBindConfig: () => ({ bindHost: "127.0.0.1", urlHost: "127.0.0.1" }),
            _localSource: () => null,
            getStateAsync: sinon.stub().resolves(null),
            setObjectNotExistsAsync: sinon.stub().resolves(),
            upsertState: sinon.stub().resolves(),
            _maxSessionDurationParam: () => 3600,
            _publishStreamParts: sinon.stub().resolves(),
            _resolvePersistentInner: sinon.stub().resolves(null),
            _cancelFrontDoorIdle: sinon.stub(),
            _armFrontDoorIdle: sinon.stub(),
        };
        await proto._startPersistentEndpoints.call(self, [{ id: CAM }]);
        const door = self._lazyFrontDoors.get(CAM);
        expect(door, "front door bound").to.not.equal(undefined);
        try {
            await new Promise<void>((resolve) => {
                const sock = net.connect(door!.port, "127.0.0.1");
                sock.on("error", () => undefined);
                sock.on("close", () => resolve());
            });
            await new Promise((r) => setTimeout(r, 50));
            expect(self._resolvePersistentInner.calledWith(CAM)).to.equal(true);
            expect(self._cancelFrontDoorIdle.calledWith(CAM)).to.equal(true);
            expect(self._armFrontDoorIdle.calledWith(CAM)).to.equal(true);
        } finally {
            await door!.stop();
        }
    });
});
