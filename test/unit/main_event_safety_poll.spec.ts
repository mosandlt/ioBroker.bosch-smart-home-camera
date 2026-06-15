/**
 * Tests for the always-on event-poll safety net (forum #84538, Reiner).
 *
 * @aracna/fcm does not surface a raw TCP socket death — isHealthy() stays true,
 * no "disconnect" fires — so motion (last_motion_at / last_event_image_at) could
 * silently freeze forever. The old code only started event polling on an FCM
 * START failure. Now, like HA, the event poll is ALWAYS armed and decides per
 * tick whether to fetch: every tick while FCM is down (fast recovery), every
 * FCM_SAFETY_POLL_MS (5 min) while FCM looks healthy (silent-death insurance).
 *
 * `_eventSafetyPollDue(now)` is the pure decision; it is pulled off the adapter
 * instance and invoked against a `this` stub.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadAdapter(): any {
    const db = new MockDatabaseCtor();
    let captured: MockAdapter | null = null;
    const core = mockAdapterCoreFn(db, { onAdapterCreated: (a) => (captured = a) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[ADAPTER_CORE_PATH] = {
        id: ADAPTER_CORE_PATH, filename: ADAPTER_CORE_PATH, loaded: true,
        parent: module, children: [], path: path.dirname(ADAPTER_CORE_PATH), paths: [], exports: core,
    };
    delete require.cache[MAIN_JS_PATH];
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const factory = require(MAIN_JS_PATH) as (opts: Record<string, unknown>) => MockAdapter;
    factory({ config: { redirect_url: "", region: "EU", startup_snapshot: true } });
    if (!captured) throw new Error("adapter not captured");
    return captured;
}

const NOW = 1_000_000_000_000;
const SAFETY_MS = 300_000;

describe("event-poll safety net — _eventSafetyPollDue", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let due: (...a: any[]) => boolean;
    before(() => {
        due = loadAdapter()._eventSafetyPollDue;
    });

    it("FCM down → poll every tick (true regardless of last fetch)", () => {
        expect(due.call({ _fcmHealthy: false, _lastEventFetchAt: NOW - 1 }, NOW)).to.equal(true);
    });

    it("FCM down + never fetched (0 legacy sentinel) → true", () => {
        expect(due.call({ _fcmHealthy: false, _lastEventFetchAt: 0 }, NOW)).to.equal(true);
    });

    it("FCM down + never fetched (-Infinity sentinel, SENTINEL_RULE) → true", () => {
        // BUG-1 regression: _lastEventFetchAt was 0 (epoch), now -Infinity.
        // Date.now() - (-Infinity) = Infinity ≥ FCM_SAFETY_POLL_MS → due.
        expect(due.call({ _fcmHealthy: false, _lastEventFetchAt: -Infinity }, NOW)).to.equal(true);
    });

    it("FCM healthy + fetched just now → skip (false)", () => {
        expect(due.call({ _fcmHealthy: true, _lastEventFetchAt: NOW - 1_000 }, NOW)).to.equal(false);
    });

    it("FCM healthy + fetched 100 s ago (< 5 min) → skip", () => {
        expect(due.call({ _fcmHealthy: true, _lastEventFetchAt: NOW - 100_000 }, NOW)).to.equal(false);
    });

    it("FCM healthy but no push for exactly 5 min → safety poll fires (true)", () => {
        expect(due.call({ _fcmHealthy: true, _lastEventFetchAt: NOW - SAFETY_MS }, NOW)).to.equal(true);
    });

    it("FCM healthy but silently dead (no push for 10 min) → safety poll fires", () => {
        expect(due.call({ _fcmHealthy: true, _lastEventFetchAt: NOW - 600_000 }, NOW)).to.equal(true);
    });

    it("FCM healthy + never fetched (0 legacy) → true (first tick after boot)", () => {
        expect(due.call({ _fcmHealthy: true, _lastEventFetchAt: 0 }, NOW)).to.equal(true);
    });

    it("FCM healthy + never fetched (-Infinity sentinel) → true (first tick after boot)", () => {
        // SENTINEL_RULE: -Infinity is the canonical 'never fetched' value.
        // Infinity ≥ FCM_SAFETY_POLL_MS → first healthy tick fetches events once.
        expect(due.call({ _fcmHealthy: true, _lastEventFetchAt: -Infinity }, NOW)).to.equal(true);
    });
});
