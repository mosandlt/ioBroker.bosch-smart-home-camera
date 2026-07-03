/**
 * Tests for maintenance lifecycle notification hook (_maybeAnnounceMaintenanceState).
 *
 * Pin every transition path so the same window can never spam the user,
 * but a genuine state change (scheduled → active) gets one fresh notification.
 *
 * Mirror test names from HA tests/test_maintenance_announce.py for cross-repo
 * parity auditability.
 *
 * Reference: HA integration __init__.py _async_maybe_announce_maintenance
 *            HA tests/test_maintenance_announce.py
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

import type { MaintenanceWindow, MaintenanceState } from "../../src/lib/maintenance";

// ── Load the method from the adapter instance ─────────────────────────────────
// We instantiate a bare BoschSmartHomeCamera via the factory so the class is
// loaded, then extract the prototype method to call with our own stub as `this`.
// This avoids spinning up a full onReady() lifecycle.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMethod = (...args: any[]) => Promise<void>;

function loadMethod(): AnyMethod {
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

    // Extract the private method from the instance's prototype chain.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const method = (capturedAdapter as any)._maybeAnnounceMaintenanceState as AnyMethod | undefined;
    if (typeof method !== "function") {
        throw new Error(
            "_maybeAnnounceMaintenanceState not found on adapter prototype — check method name",
        );
    }
    return method;
}

// ── Stub adapter as `this` context ────────────────────────────────────────────

interface StubAdapter {
    _maintenanceNotifiedKey: [string, string] | null;
    _stateCache: Map<string, unknown>;
    _cameras: Map<string, unknown>;
    _lastCameraStatus: Record<string, string>;
    log: { info: (msg: string) => void; debug: (msg: string) => void };
    upsertState: (id: string, value: unknown) => Promise<void>;
    _lastNotificationPayload: string;
}

function makeStub(): StubAdapter {
    return {
        _maintenanceNotifiedKey: null,
        _stateCache: new Map(),
        _cameras: new Map(),
        _lastCameraStatus: {},
        log: { info: () => undefined, debug: () => undefined },
        _lastNotificationPayload: "",
        async upsertState(id: string, value: unknown): Promise<void> {
            if ((this as StubAdapter)._stateCache.get(id) === value) {
                return;
            }
            (this as StubAdapter)._stateCache.set(id, value);
            if (typeof value === "string" && id.endsWith("last_notification")) {
                (this as StubAdapter)._lastNotificationPayload = value;
            }
        },
    };
}

function makeMw(overrides: Partial<MaintenanceWindow> = {}): MaintenanceWindow {
    return {
        title: "Wartung Kamera-Infrastruktur",
        link: "https://example.com/mw1",
        pub_date: new Date().toISOString(),
        summary: "Window between 07:00 and 10:00 MESZ",
        scheduled_start: new Date(Date.now() + 3 * 3600_000).toISOString(),
        scheduled_end: new Date(Date.now() + 5 * 3600_000).toISOString(),
        source: "rss:Wartungsarbeiten",
        camera_relevant: true,
        ...overrides,
    };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("_maybeAnnounceMaintenanceState", () => {
    let rawMethod: AnyMethod;

    before(() => {
        rawMethod = loadMethod();
    });

    async function announce(
        stub: StubAdapter,
        mw: MaintenanceWindow,
        state: MaintenanceState,
    ): Promise<void> {
        await rawMethod.call(stub, mw, state);
    }

    it("test_announces_on_scheduled", async () => {
        const stub = makeStub();
        const mw = makeMw();
        await announce(stub, mw, "scheduled");
        expect(stub._maintenanceNotifiedKey).to.deep.equal([mw.link, "scheduled"]);
        expect(stub._lastNotificationPayload).to.not.equal("");
        const payload = JSON.parse(stub._lastNotificationPayload) as {
            title: string;
            state: string;
        };
        expect(payload.title).to.include("scheduled");
        expect(payload.state).to.equal("scheduled");
    });

    it("test_announces_again_on_scheduled_to_active", async () => {
        const stub = makeStub();
        const mw = makeMw();
        await announce(stub, mw, "scheduled");
        const firstPayload = stub._lastNotificationPayload;
        await announce(stub, mw, "active");
        const secondPayload = JSON.parse(stub._lastNotificationPayload) as { title: string };
        expect(stub._lastNotificationPayload).to.not.equal(firstPayload);
        expect(secondPayload.title).to.include("in progress");
        expect(stub._maintenanceNotifiedKey).to.deep.equal([mw.link, "active"]);
    });

    it("test_dedupes_duplicate_calls", async () => {
        const stub = makeStub();
        const mw = makeMw();
        await announce(stub, mw, "scheduled");
        const firstPayload = stub._lastNotificationPayload;
        await announce(stub, mw, "scheduled");
        expect(stub._lastNotificationPayload).to.equal(firstPayload);
    });

    it("test_active_to_past_announces_ended", async () => {
        const stub = makeStub();
        const mw = makeMw();
        await announce(stub, mw, "active");
        await announce(stub, mw, "past");
        const payload = JSON.parse(stub._lastNotificationPayload) as { title: string };
        expect(payload.title).to.include("ended");
        expect(stub._maintenanceNotifiedKey).to.deep.equal([mw.link, "past"]);
    });

    it("test_stale_past_window_does_not_announce", async () => {
        const stub = makeStub();
        const mw = makeMw();
        await announce(stub, mw, "past");
        // No notification fired for stale past
        expect(stub._lastNotificationPayload).to.equal("");
        // Dedupe key still recorded so follow-up ticks stay silent
        expect(stub._maintenanceNotifiedKey).to.deep.equal([mw.link, "past"]);
    });

    it("test_full_scheduled_active_past_lifecycle", async () => {
        const stub = makeStub();
        const link = "https://example.com/full-lifecycle";
        const mw = makeMw({ link });
        const titles: string[] = [];

        const origUpsert = stub.upsertState.bind(stub);
        stub.upsertState = async function (id: string, value: unknown): Promise<void> {
            await origUpsert(id, value);
            if (typeof value === "string" && id.endsWith("last_notification") && value !== "") {
                const p = JSON.parse(value) as { title: string };
                titles.push(p.title);
            }
        };

        await announce(stub, mw, "scheduled");
        await announce(stub, mw, "active");
        await announce(stub, mw, "past");

        expect(titles).to.have.length(3);
        expect(titles[0]).to.include("scheduled");
        expect(titles[1]).to.include("in progress");
        expect(titles[2]).to.include("ended");
    });

    it("test_silent_when_not_camera_relevant", async () => {
        const stub = makeStub();
        const mw = makeMw({ camera_relevant: false });
        await announce(stub, mw, "active");
        expect(stub._lastNotificationPayload).to.equal("");
        expect(stub._maintenanceNotifiedKey).to.be.null;
    });

    it("test_silent_for_non_actionable_states", async () => {
        const stub = makeStub();
        const mw = makeMw();
        for (const state of ["recent", "unknown", "idle"] as MaintenanceState[]) {
            await announce(stub, mw, state);
        }
        expect(stub._lastNotificationPayload).to.equal("");
        expect(stub._maintenanceNotifiedKey).to.be.null;
    });

    it("test_new_window_link_re_announces", async () => {
        const stub = makeStub();
        const mw1 = makeMw({ link: "https://example.com/a" });
        const mw2 = makeMw({ link: "https://example.com/b" });
        const announcements: string[] = [];

        const origUpsert = stub.upsertState.bind(stub);
        stub.upsertState = async function (id: string, value: unknown): Promise<void> {
            await origUpsert(id, value);
            if (typeof value === "string" && id.endsWith("last_notification") && value !== "") {
                announcements.push(value);
            }
        };

        await announce(stub, mw1, "scheduled");
        await announce(stub, mw2, "scheduled");
        expect(announcements).to.have.length(2);
    });

    it("test_notify_failure_is_swallowed", async () => {
        const stub = makeStub();
        stub.upsertState = async (_id: string, _value: unknown): Promise<void> => {
            throw new Error("DP write failed");
        };
        const mw = makeMw();
        // Must not throw — maintenance discovery loop must stay alive
        let threw = false;
        try {
            await announce(stub, mw, "active");
        } catch {
            threw = true;
        }
        expect(threw).to.be.false;
        expect(stub._maintenanceNotifiedKey).to.deep.equal([mw.link, "active"]);
    });
});
