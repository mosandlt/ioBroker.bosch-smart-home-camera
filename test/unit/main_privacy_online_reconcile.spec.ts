/**
 * Tests for cloud-based online reconciliation of privacy-mode cameras (v1.3.x).
 *
 * A privacy-mode camera refuses snapshots, so the snapshot reachability path can
 * never confirm its `online` state. When the adapter host is not on the camera
 * LAN, that left `online` stuck at its last value — a LIVE privacy camera looked
 * "offline". The fix: markCameraReachability()'s privacy branch reconciles the
 * `online` DP from the cloud (_resolveCameraStatus), throttled.
 *
 * Methods are pulled off the real adapter prototype and invoked against a
 * hand-made `this` stub (same technique as main_offline_detection.spec.ts).
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
    factory({ config: { redirect_url: "", region: "EU" } });
    if (!captured) {
        throw new Error("adapter not captured");
    }
    return captured;
}

const CAM = "EFEFEFEF-1111-2222-3333-444455556666";

describe("privacy online reconcile — _reconcileOnlineViaCloud (v1.3.x)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let reconcile: (...a: any[]) => Promise<void>;

    before(() => {
        reconcile = loadAdapter()._reconcileOnlineViaCloud;
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function stub(status: string, currentOnline: boolean | null): any {
        return {
            _lastCloudReconcile: new Map<string, number>(),
            _snapshotFailCount: new Map<string, number>(),
            _resolveCameraStatus: sinon.stub().resolves(status),
            getStateAsync: sinon
                .stub()
                .resolves(currentOnline === null ? null : { val: currentOnline }),
            setStateAsync: sinon.stub().resolves(undefined),
            _maybeannounceCameraStatus: sinon.stub().resolves(undefined),
        };
    }

    function onlineWrite(s: { setStateAsync: sinon.SinonStub }): sinon.SinonSpyCall | undefined {
        return s.setStateAsync
            .getCalls()
            .find((c: sinon.SinonSpyCall) => String(c.args[0]).endsWith(".online"));
    }

    it("cloud ONLINE while DP is false → online set true + announce + failcount cleared", async () => {
        const s = stub("ONLINE", false);
        s._snapshotFailCount.set(CAM, 5);
        await reconcile.call(s, CAM);
        expect(onlineWrite(s)?.args[1], "online flipped to true").to.equal(true);
        expect(s._maybeannounceCameraStatus.calledWith(CAM, "online")).to.equal(true);
        expect(s._snapshotFailCount.has(CAM), "snapshot fail count cleared").to.equal(false);
    });

    it("cloud OFFLINE while DP is true → online set false + announce", async () => {
        const s = stub("OFFLINE", true);
        await reconcile.call(s, CAM);
        expect(onlineWrite(s)?.args[1], "online flipped to false").to.equal(false);
        expect(s._maybeannounceCameraStatus.calledWith(CAM, "offline")).to.equal(true);
    });

    it("cloud ONLINE while DP already true → no write, no announce (idempotent)", async () => {
        const s = stub("ONLINE", true);
        await reconcile.call(s, CAM);
        expect(onlineWrite(s), "no redundant online write").to.equal(undefined);
        expect(s._maybeannounceCameraStatus.called).to.equal(false);
    });

    it("cloud UNKNOWN → leaves online unchanged (no write)", async () => {
        const s = stub("UNKNOWN", false);
        await reconcile.call(s, CAM);
        expect(onlineWrite(s), "UNKNOWN must not touch online").to.equal(undefined);
    });

    it("cloud SESSION_LIMIT → leaves online unchanged (no write)", async () => {
        const s = stub("SESSION_LIMIT", true);
        await reconcile.call(s, CAM);
        expect(onlineWrite(s), "SESSION_LIMIT must not touch online").to.equal(undefined);
    });

    it("throttled: a recent reconcile skips the cloud round-trip entirely", async () => {
        const s = stub("ONLINE", false);
        s._lastCloudReconcile.set(CAM, Date.now()); // just reconciled
        await reconcile.call(s, CAM);
        expect(s._resolveCameraStatus.called, "no cloud call within throttle window").to.equal(false);
        expect(onlineWrite(s), "no online write while throttled").to.equal(undefined);
    });
});

describe("privacy online reconcile — markCameraReachability privacy branch (v1.3.x)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mark: (...a: any[]) => Promise<void>;

    before(() => {
        mark = loadAdapter().markCameraReachability;
    });

    it("privacy ON + unreachable → reconciles via cloud, does NOT decrement fail count", async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const s: any = {
            _snapshotFailCount: new Map<string, number>(),
            _sessionLimitHits: new Map<string, number[]>(),
            getStateAsync: sinon.stub().resolves({ val: true }), // privacy_enabled = true
            setStateAsync: sinon.stub().resolves(undefined),
            _reconcileOnlineViaCloud: sinon.stub().resolves(undefined),
            _maybeannounceCameraStatus: sinon.stub().resolves(undefined),
            log: { debug: sinon.stub() },
        };
        await mark.call(s, CAM, false);
        expect(s._reconcileOnlineViaCloud.calledWith(CAM), "cloud reconcile invoked").to.equal(true);
        expect(s._snapshotFailCount.has(CAM), "fail count NOT incremented in privacy").to.equal(false);
        const wroteOfflineFalse = s.setStateAsync
            .getCalls()
            .some((c: sinon.SinonSpyCall) => String(c.args[0]).endsWith(".online") && c.args[1] === false);
        expect(wroteOfflineFalse, "privacy branch must not directly set online=false").to.equal(false);
    });
});
