/**
 * Tests for per-camera online/offline notification hook (_maybeannounceCameraStatus).
 *
 * Pin every transition path so the user gets a notification on a real
 * availability change, but never on the first observation after adapter start
 * and never on a transient `unknown` flap.
 *
 * Mirror test names from HA tests/test_camera_status_announce.py for cross-repo
 * parity auditability.
 *
 * Reference: HA integration __init__.py _async_maybe_announce_camera_status
 *            HA tests/test_camera_status_announce.py
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
    factory({ config: { redirect_url: "", region: "EU" } });

    if (!capturedAdapter) {
        throw new Error("adapter not captured");
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const method = (capturedAdapter as any)._maybeannounceCameraStatus as AnyMethod | undefined;
    if (typeof method !== "function") {
        throw new Error(
            "_maybeannounceCameraStatus not found on adapter prototype — check method name",
        );
    }
    return method;
}

// ── Camera stub type ──────────────────────────────────────────────────────────

interface BoschCameraStub {
    id: string;
    name: string;
}

interface StubAdapter {
    _lastCameraStatus: Record<string, string>;
    _stateCache: Map<string, unknown>;
    _cameras: Map<string, BoschCameraStub>;
    _maintenanceNotifiedKey: [string, string] | null;
    log: { info: (msg: string) => void; debug: (msg: string) => void };
    upsertState: (id: string, value: unknown) => Promise<void>;
    _lastNotifications: string[];
}

function makeStub(): StubAdapter {
    return {
        _lastCameraStatus: {},
        _stateCache: new Map(),
        _cameras: new Map(),
        _maintenanceNotifiedKey: null,
        log: { info: () => undefined, debug: () => undefined },
        _lastNotifications: [],
        async upsertState(id: string, value: unknown): Promise<void> {
            if ((this as StubAdapter)._stateCache.get(id) === value) {
                return;
            }
            (this as StubAdapter)._stateCache.set(id, value);
            if (
                typeof value === "string" &&
                id.endsWith("last_status_notification") &&
                value !== ""
            ) {
                (this as StubAdapter)._lastNotifications.push(value);
            }
        },
    };
}

const CAM_A = "EF791764-A48D-4F00-9B32-EF04BEB0DDA0";
const CAM_B = "20E053B5-BE64-4E45-A2CA-BBDC20F5C351";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("_maybeannounceCameraStatus", () => {
    let rawMethod: AnyMethod;

    before(() => {
        rawMethod = loadMethod();
    });

    async function announce(stub: StubAdapter, camId: string, status: string): Promise<void> {
        await rawMethod.call(stub, camId, status);
    }

    it("test_first_observation_is_silent", async () => {
        const stub = makeStub();
        stub._cameras.set(CAM_A, { id: CAM_A, name: "Terrasse" });
        await announce(stub, CAM_A, "online");
        expect(stub._lastNotifications).to.have.length(0);
        expect(stub._lastCameraStatus[CAM_A]).to.equal("online");
    });

    it("test_no_change_is_silent", async () => {
        const stub = makeStub();
        stub._cameras.set(CAM_A, { id: CAM_A, name: "Terrasse" });
        stub._lastCameraStatus[CAM_A] = "online";
        await announce(stub, CAM_A, "online");
        expect(stub._lastNotifications).to.have.length(0);
    });

    it("test_online_to_offline_announces", async () => {
        const stub = makeStub();
        stub._cameras.set(CAM_A, { id: CAM_A, name: "Terrasse" });
        stub._lastCameraStatus[CAM_A] = "online";
        await announce(stub, CAM_A, "offline");
        expect(stub._lastNotifications).to.have.length(1);
        const payload = JSON.parse(stub._lastNotifications[0]) as {
            title: string;
            status: string;
        };
        expect(payload.title).to.include("offline");
        expect(payload.title).to.include("Terrasse");
        expect(payload.status).to.equal("offline");
        expect(stub._lastCameraStatus[CAM_A]).to.equal("offline");
    });

    it("test_offline_to_online_announces_recovery", async () => {
        const stub = makeStub();
        stub._cameras.set(CAM_A, { id: CAM_A, name: "Terrasse" });
        stub._lastCameraStatus[CAM_A] = "offline";
        await announce(stub, CAM_A, "online");
        expect(stub._lastNotifications).to.have.length(1);
        const payload = JSON.parse(stub._lastNotifications[0]) as { title: string };
        const titleLower = payload.title.toLowerCase();
        expect(titleLower.includes("online") || titleLower.includes("wieder")).to.be.true;
    });

    it("test_unknown_transitions_are_silent", async () => {
        const stub = makeStub();
        stub._cameras.set(CAM_A, { id: CAM_A, name: "Terrasse" });
        stub._lastCameraStatus[CAM_A] = "online";
        // online → unknown: silent, state recorded
        await announce(stub, CAM_A, "unknown");
        expect(stub._lastNotifications).to.have.length(0);
        expect(stub._lastCameraStatus[CAM_A]).to.equal("unknown");
        // unknown → online: also silent (metadata recovery, not real availability change)
        await announce(stub, CAM_A, "online");
        expect(stub._lastNotifications).to.have.length(0);
    });

    it("test_per_camera_state_is_isolated", async () => {
        const stub = makeStub();
        stub._cameras.set(CAM_A, { id: CAM_A, name: "Terrasse" });
        stub._cameras.set(CAM_B, { id: CAM_B, name: "Innenbereich" });
        stub._lastCameraStatus[CAM_A] = "online";
        stub._lastCameraStatus[CAM_B] = "online";
        await announce(stub, CAM_A, "offline");
        await announce(stub, CAM_B, "offline");
        expect(stub._lastNotifications).to.have.length(2);
        const titles = stub._lastNotifications.map(
            (p) => (JSON.parse(p) as { title: string }).title,
        );
        expect(titles.some((t) => t.includes("Terrasse"))).to.be.true;
        expect(titles.some((t) => t.includes("Innenbereich"))).to.be.true;
    });

    it("test_cam_name_fallback_to_id_prefix_when_no_title", async () => {
        const stub = makeStub();
        // Camera NOT in _cameras map → fallback to camId.slice(0, 8)
        stub._lastCameraStatus[CAM_A] = "online";
        await announce(stub, CAM_A, "offline");
        expect(stub._lastNotifications).to.have.length(1);
        const payload = JSON.parse(stub._lastNotifications[0]) as { title: string };
        expect(payload.title).to.include(CAM_A.slice(0, 8));
    });

    it("test_notify_failure_is_swallowed", async () => {
        const stub = makeStub();
        stub._cameras.set(CAM_A, { id: CAM_A, name: "Terrasse" });
        stub._lastCameraStatus[CAM_A] = "online";
        stub.upsertState = async (_id: string, _value: unknown): Promise<void> => {
            throw new Error("DP write failed");
        };
        // Must not throw — reachability tracking must stay alive
        let threw = false;
        try {
            await announce(stub, CAM_A, "offline");
        } catch {
            threw = true;
        }
        expect(threw).to.be.false;
        // State still updated even if DP write fails
        expect(stub._lastCameraStatus[CAM_A]).to.equal("offline");
    });
});
