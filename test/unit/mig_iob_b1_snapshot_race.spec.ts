/**
 * Item: iOB-B1 — Snapshot in-flight coalescing
 * Migration-concept: port HA camera.py `_refresh_inflight` bool guard to ioBroker.
 * Layer: adapter backend (main.ts)
 * Soll-Assertion: two concurrent snapshot-refresh calls for the SAME camera
 *   coalesce into exactly ONE _doSnapshotTrigger (→ one ensureLiveSession / fetch),
 *   not two parallel Bosch sessions; the second caller awaits the first's result.
 *   A coalesced motion-event caller still gets its base64 published from the
 *   leader's frame (no second fetch).
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

/** A manually-resolvable promise. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe("iOB-B1 — Snapshot-race: concurrent refreshes coalesce", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let handleSnapshotTrigger: (...a: any[]) => Promise<void>;

    before(() => {
        const adapter = loadAdapter();
        handleSnapshotTrigger = adapter.handleSnapshotTrigger;
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function stub(doTrigger: sinon.SinonStub, publish: sinon.SinonStub): any {
        return {
            _snapshotInflight: new Map<string, Promise<void>>(),
            _latestSnapshots: new Map<string, Buffer>(),
            _doSnapshotTrigger: doTrigger,
            _publishMotionEventImage: publish,
        };
    }

    it("two concurrent triggers for the same camera run _doSnapshotTrigger exactly once", async () => {
        const d = deferred();
        const doTrigger = sinon.stub().returns(d.promise);
        const publish = sinon.stub().resolves();
        const s = stub(doTrigger, publish);

        // Fire two concurrent triggers WITHOUT awaiting the first.
        const p1 = handleSnapshotTrigger.call(s, CAM);
        const p2 = handleSnapshotTrigger.call(s, CAM);

        // While in flight, only the leader has started the real fetch.
        expect(doTrigger.callCount, "only one ensureLiveSession/fetch in flight").to.equal(1);

        d.resolve();
        await Promise.all([p1, p2]);

        // Still exactly one — the joiner never started its own fetch.
        expect(doTrigger.callCount).to.equal(1);
        // Map cleared after completion, so a later trigger starts a fresh fetch.
        expect(s._snapshotInflight.has(CAM)).to.equal(false);

        await handleSnapshotTrigger.call(s, CAM);
        expect(doTrigger.callCount, "a later trigger starts a new fetch").to.equal(2);
    });

    it("a coalesced motion-event caller publishes base64 from the leader's frame (no 2nd fetch)", async () => {
        const d = deferred();
        const doTrigger = sinon.stub().returns(d.promise);
        const publish = sinon.stub().resolves();
        const s = stub(doTrigger, publish);
        const frame = Buffer.from("fake-jpeg-bytes");

        // Leader = plain snapshot (no motion flag).
        const leader = handleSnapshotTrigger.call(s, CAM);
        // Joiner = motion event; it must NOT start a second fetch.
        const joiner = handleSnapshotTrigger.call(s, CAM, { asMotionEvent: true });

        expect(doTrigger.callCount, "joiner did not start a second fetch").to.equal(1);

        // Leader populated the latest-frame cache before resolving.
        s._latestSnapshots.set(CAM, frame);
        d.resolve();
        await Promise.all([leader, joiner]);

        expect(publish.calledOnce, "motion base64 published once").to.equal(true);
        expect(publish.firstCall.args[0]).to.equal(CAM);
        expect(publish.firstCall.args[1]).to.equal(frame);
    });

    it("a rejected leader still clears the in-flight map", async () => {
        const d = deferred();
        const doTrigger = sinon.stub().returns(d.promise);
        const s = stub(doTrigger, sinon.stub().resolves());

        const p = handleSnapshotTrigger.call(s, CAM);
        d.reject(new Error("fetch failed"));
        let threw = false;
        try {
            await p;
        } catch {
            threw = true;
        }
        expect(threw).to.equal(true);
        expect(s._snapshotInflight.has(CAM), "map cleared even on failure").to.equal(false);
    });
});
