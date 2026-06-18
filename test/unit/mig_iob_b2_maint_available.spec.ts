/**
 * Item: iOB-B2 — Stay available during cloud maintenance while locally streaming
 * Migration-concept: port HA 682bf6e to ioBroker.
 * Layer: adapter backend (main.ts — markCameraReachability)
 * Soll-Assertion: while a camera-relevant Bosch cloud maintenance window is
 *   ACTIVE and the camera is locally streaming, snapshot failures past
 *   OFFLINE_THRESHOLD must NOT flip `online` to false (the failures are the
 *   cloud outage, not the device). Without an active window OR without a local
 *   stream, the normal offline flip still happens.
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
    factory({ config: { redirect_url: "", region: "EU", startup_snapshot: true } });
    if (!captured) {
        throw new Error("adapter not captured");
    }
    return captured;
}

const CAM = "11111111-2222-3333-4444-555555555555";
const OFFLINE_THRESHOLD = 3;

describe("iOB-B2 — markCameraReachability: maintenance suppresses offline flip", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let markReach: (...a: any[]) => Promise<void>;

    before(() => {
        const adapter = loadAdapter();
        markReach = adapter.markCameraReachability;
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function stub(opts: { maintActive: boolean; streaming: boolean }): any {
        return {
            // one failure away from the threshold so the next failure flips it
            _snapshotFailCount: new Map<string, number>([[CAM, OFFLINE_THRESHOLD - 1]]),
            _sessionLimitHits: new Map<string, boolean>(),
            // iOB-B2 gates on an actually-open session (_liveSessions), not on
            // user intent (_livestreamEnabled) — so the stub models that map.
            _liveSessions: new Map<string, unknown>(opts.streaming ? [[CAM, {}]] : []),
            _isCameraMaintenanceActive: sinon.stub().returns(opts.maintActive),
            // privacy_enabled not true → reachability decrement proceeds normally
            getStateAsync: sinon.stub().resolves({ val: false }),
            setStateAsync: sinon.stub().resolves(),
            _maybeannounceCameraStatus: sinon.stub().resolves(),
            log: { debug: sinon.stub(), silly: sinon.stub() },
        };
    }

    function onlineFalseCall(setState: sinon.SinonStub): sinon.SinonSpyCall | undefined {
        return setState
            .getCalls()
            .find((c) => c.args[0] === `cameras.${CAM}.online` && c.args[1] === false);
    }

    it("active maintenance + local stream → keeps online (NO offline flip)", async () => {
        const s = stub({ maintActive: true, streaming: true });
        await markReach.call(s, CAM, false);
        expect(onlineFalseCall(s.setStateAsync), "online must NOT be set false").to.equal(undefined);
        expect(s._maybeannounceCameraStatus.called, "no offline announcement").to.equal(false);
    });

    it("active maintenance but NOT streaming → normal offline flip", async () => {
        const s = stub({ maintActive: true, streaming: false });
        await markReach.call(s, CAM, false);
        expect(onlineFalseCall(s.setStateAsync), "online flips to false").to.not.equal(undefined);
        expect(s._maybeannounceCameraStatus.calledWith(CAM, "offline")).to.equal(true);
    });

    it("local stream but NO active maintenance → normal offline flip", async () => {
        const s = stub({ maintActive: false, streaming: true });
        await markReach.call(s, CAM, false);
        expect(onlineFalseCall(s.setStateAsync), "online flips to false").to.not.equal(undefined);
        expect(s._maybeannounceCameraStatus.calledWith(CAM, "offline")).to.equal(true);
    });

    it("below threshold → no flip regardless (failure just counts up)", async () => {
        const s = stub({ maintActive: false, streaming: false });
        s._snapshotFailCount.set(CAM, 0); // first failure: 1 < 3
        await markReach.call(s, CAM, false);
        expect(onlineFalseCall(s.setStateAsync)).to.equal(undefined);
        expect(s._snapshotFailCount.get(CAM)).to.equal(1);
    });
});

describe("iOB-B2 — _isCameraMaintenanceActive", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let isActive: (...a: any[]) => boolean;

    before(() => {
        const adapter = loadAdapter();
        isActive = adapter._isCameraMaintenanceActive;
    });

    function window(opts: {
        relevant: boolean;
        startOffsetMs: number;
        endOffsetMs: number;
    }): unknown {
        const now = Date.now();
        return {
            title: "Cloud maintenance",
            link: "https://example.invalid/post/1",
            summary: "",
            source: "test",
            pub_date: new Date(now - 3600_000).toISOString(),
            scheduled_start: new Date(now + opts.startOffsetMs).toISOString(),
            scheduled_end: new Date(now + opts.endOffsetMs).toISOString(),
            camera_relevant: opts.relevant,
        };
    }

    it("null window → false", () => {
        expect(isActive.call({ _lastMaintenanceWindow: null })).to.equal(false);
    });

    it("active + camera_relevant → true", () => {
        const mw = window({ relevant: true, startOffsetMs: -3600_000, endOffsetMs: 3600_000 });
        expect(isActive.call({ _lastMaintenanceWindow: mw })).to.equal(true);
    });

    it("active but NOT camera_relevant → false", () => {
        const mw = window({ relevant: false, startOffsetMs: -3600_000, endOffsetMs: 3600_000 });
        expect(isActive.call({ _lastMaintenanceWindow: mw })).to.equal(false);
    });

    it("camera_relevant but window already past → false", () => {
        const mw = window({ relevant: true, startOffsetMs: -7200_000, endOffsetMs: -3600_000 });
        expect(isActive.call({ _lastMaintenanceWindow: mw })).to.equal(false);
    });

    it("camera_relevant but window still in the future (scheduled) → false", () => {
        const mw = window({ relevant: true, startOffsetMs: 600_000, endOffsetMs: 7200_000 });
        expect(isActive.call({ _lastMaintenanceWindow: mw })).to.equal(false);
    });
});
