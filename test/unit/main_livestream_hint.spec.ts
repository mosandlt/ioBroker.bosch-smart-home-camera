/**
 * Regression tests for the one-time livestream discoverability hint
 * (_logLivestreamHintIfAllOff), v1.2.5.
 *
 * Root cause it guards (forum #84538, vowill): livestream is opt-in and OFF by
 * default, so on a fresh install `stream_url` stays empty and a go2rtc/recorder
 * pointed at the not-yet-listening proxy port gets "connection refused". The
 * adapter must emit ONE actionable info line per start when no camera streams,
 * and stay silent the moment any camera has livestream enabled.
 *
 * Pin: all-off → logs (+ LAN reminder gated on rtsp_expose_to_lan);
 *      any-on → silent; no cameras → silent.
 */

import { expect } from "chai";
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

// ── Load the method from the adapter instance ─────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SyncMethod = (...args: any[]) => boolean;

function loadMethod(): SyncMethod {
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
    const method = (capturedAdapter as any)._logLivestreamHintIfAllOff as SyncMethod | undefined;
    if (typeof method !== "function") {
        throw new Error(
            "_logLivestreamHintIfAllOff not found on adapter prototype — check method name",
        );
    }
    return method;
}

// ── Stub ──────────────────────────────────────────────────────────────────────

interface CameraStub {
    id: string;
    name: string;
}

interface StubAdapter {
    _livestreamEnabled: Map<string, boolean>;
    config: { rtsp_expose_to_lan?: boolean };
    log: { info: (msg: string) => void };
    infos: string[];
}

const CAM_A = "EFEFEFEF-1111-2222-3333-444455556666";
const CAM_B = "20E020E0-2222-3333-4444-555566667777";

function makeStub(opts: { exposeLan?: boolean } = {}): StubAdapter {
    const stub: StubAdapter = {
        _livestreamEnabled: new Map<string, boolean>(),
        config: { rtsp_expose_to_lan: opts.exposeLan },
        infos: [],
        log: {
            info(msg: string): void {
                stub.infos.push(msg);
            },
        },
    };
    return stub;
}

function cams(...ids: string[]): CameraStub[] {
    return ids.map((id) => ({ id, name: id.slice(0, 4) }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("_logLivestreamHintIfAllOff (v1.2.5 — forum #84538)", () => {
    let method: SyncMethod;

    before(() => {
        method = loadMethod();
    });

    it("logs the hint when every camera has livestream OFF (default)", () => {
        const stub = makeStub();
        const logged = method.call(stub, cams(CAM_A, CAM_B));
        expect(logged).to.equal(true);
        expect(stub.infos).to.have.lengthOf(1);
        expect(stub.infos[0]).to.contain("livestream_enabled");
        expect(stub.infos[0]).to.contain("stream_url");
        expect(stub.infos[0]).to.contain("connection refused");
        // first camera id is named in the actionable example
        expect(stub.infos[0]).to.contain(CAM_A);
    });

    it("appends the LAN-expose reminder only when rtsp_expose_to_lan is off", () => {
        const stub = makeStub({ exposeLan: false });
        method.call(stub, cams(CAM_A));
        expect(stub.infos[0]).to.contain("Expose RTSP proxy to LAN");
    });

    it("omits the LAN-expose reminder when rtsp_expose_to_lan is already on", () => {
        const stub = makeStub({ exposeLan: true });
        const logged = method.call(stub, cams(CAM_A));
        expect(logged).to.equal(true);
        expect(stub.infos[0]).to.not.contain("Expose RTSP proxy to LAN");
    });

    it("stays silent when at least one camera streams", () => {
        const stub = makeStub();
        stub._livestreamEnabled.set(CAM_B, true);
        const logged = method.call(stub, cams(CAM_A, CAM_B));
        expect(logged).to.equal(false);
        expect(stub.infos).to.have.lengthOf(0);
    });

    it("stays silent when no cameras were discovered", () => {
        const stub = makeStub();
        const logged = method.call(stub, cams());
        expect(logged).to.equal(false);
        expect(stub.infos).to.have.lengthOf(0);
    });
});
