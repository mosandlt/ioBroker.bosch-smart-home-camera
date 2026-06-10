/**
 * Regression test — snapshot must NOT arm an idle teardown when the livestream
 * is enabled by the time the snapshot finishes.
 *
 * Bug (live sandbox 2026-06-07, an outdoor camera): the startup/auto snapshot
 * captured `_livestreamEnabled` BEFORE its await; if the user enabled the
 * livestream mid-snapshot, the eager _cancelSnapshotIdleTeardown ran before the
 * timer was armed, then `finally` armed it anyway using the stale `false` → the
 * timer fired ~60 s later (SNAPSHOT_SESSION_IDLE_MS) and tore down the
 * just-started TLS proxy ("server socket closed"), so VLC/ffmpeg/MJPEG got
 * "connection refused".
 *
 * Fix: handleSnapshotTrigger re-reads `_livestreamEnabled` in `finally`.
 *
 * Pins:
 *   1. livestream ON at finally-time  → idle teardown NOT armed
 *   2. livestream OFF at finally-time → idle teardown armed (unchanged)
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

const CAM = "EFEFEFEF-1111-2222-3333-444455556666";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

function loadMethod(): AnyFn {
    const db = new MockDatabaseCtor();
    let captured: MockAdapter | null = null;
    const core = mockAdapterCoreFn(db, { onAdapterCreated: (a) => (captured = a) });
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
    const fn = (captured as any).handleSnapshotTrigger as AnyFn | undefined;
    if (typeof fn !== "function") throw new Error("handleSnapshotTrigger not found");
    return fn;
}

function makeStub(livestreamOn: boolean): Record<string, unknown> {
    const liveMap = new Map<string, boolean>();
    if (livestreamOn) liveMap.set(CAM, true);
    return {
        namespace: "bosch-smart-home-camera.0",
        _cameras: new Map([[CAM, { generation: 1 }]]),
        _lanReachable: new Map(),
        _lanIpMap: new Map(),
        _latestSnapshots: new Map(),
        _livestreamEnabled: liveMap,
        _mjpegFailCount: new Map(),
        config: { use_mjpeg_snapshot: false },
        ensureLiveSession: sinon.stub().resolves({
            proxyUrl: "rtsp://127.0.0.1:65000/rtsp_tunnel",
            digestUser: "u",
            digestPassword: "p",
            lanAddress: "192.168.1.1:443",
        }),
        getStateAsync: sinon.stub().resolves({ val: false }),
        _fetchSnapJpgWithRetry: sinon.stub().resolves(Buffer.from("JPEGDATA")),
        writeFileAsync: sinon.stub().resolves(),
        setStateAsync: sinon.stub().resolves(),
        markCameraReachability: sinon.stub().resolves(),
        _armSnapshotIdleTeardown: sinon.stub(),
        log: { debug: sinon.stub(), warn: sinon.stub(), info: sinon.stub() },
    };
}

describe("snapshot idle-teardown race (proxy ~60s close)", () => {
    let handleSnapshotTrigger: AnyFn;
    before(() => {
        handleSnapshotTrigger = loadMethod();
    });

    it("livestream ON at finally-time → idle teardown NOT armed (proxy stays up)", async () => {
        const stub = makeStub(true);
        await handleSnapshotTrigger.call(stub, CAM, {});
        expect((stub._armSnapshotIdleTeardown as sinon.SinonStub).called).to.equal(false);
    });

    it("livestream OFF at finally-time → idle teardown armed (unchanged)", async () => {
        const stub = makeStub(false);
        await handleSnapshotTrigger.call(stub, CAM, {});
        expect((stub._armSnapshotIdleTeardown as sinon.SinonStub).calledOnce).to.equal(true);
    });
});
