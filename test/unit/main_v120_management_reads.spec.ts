/**
 * v1.2.0 management-tier READ-only mirrors — unit tests.
 *
 * Methods under test (all in src/main.ts):
 *
 *   _pollManagementReads(token, cam)
 *     Dispatches the slow-tier management GETs. Gen-gates:
 *       motion_sensitive_areas / privacy_masks / rules → all cameras
 *       lighting_options                               → Gen1 only (generation < 2)
 *       shared_with_friends                            → Gen2 only (generation >= 2)
 *
 *   _pollCloudListDp(token, camId, endpoint, dpBase)
 *     GET /v11/video_inputs/{id}/{endpoint}; on a 2xx ARRAY response writes
 *     `{dpBase}_count` (length) + `{dpBase}` (raw JSON). Non-2xx (404/442/443/444)
 *     or non-array → no write. Network/5xx error → swallowed (no throw).
 *
 *   _pollLightingSchedule(token, camId)
 *     GET /lighting_options; on a 2xx OBJECT writes lighting_schedule_status
 *     (scheduleStatus) + lighting_schedule (raw JSON). 442 → no write.
 *
 * Object-creation gates are asserted too (Gen1 gets lighting_schedule_*,
 * Gen2 gets shared_with_friends_*).
 *
 * Harness mirrors main_v110_features.spec.ts (createAdapterWithMocks + boot via
 * build/main.js, captured-request axios stub matched by URL). CRITICAL: the
 * adapter's _httpClient is `axios.create()`d at field-init time during the
 * factory call, so axios.defaults.adapter MUST be installed BEFORE
 * createAdapterWithMocks — otherwise the client keeps the real HTTP adapter and
 * makes live network calls. All matchers are therefore set up front, per test.
 *
 * FAKE fixture IDs only (SECRETS_SCAN_GAP) — never real device cloud-IDs.
 */

import { expect } from "chai";
import * as sinon from "sinon";
import * as path from "path";
import axios, { type AxiosResponse, type InternalAxiosRequestConfig } from "axios";

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

type TestAdapter = MockAdapter & {
    readyHandler?: () => Promise<void>;
    unloadHandler?: (cb: () => void) => void;
    stateChangeHandler?: ioBroker.StateChangeHandler;
};

interface BoschCameraLike {
    id: string;
    generation: number;
}
type ManagementAdapter = {
    _cameras: Map<string, BoschCameraLike>;
    _pollManagementReads: (token: string, cam: BoschCameraLike) => Promise<void>;
};

// FAKE fixture IDs only — never real device cloud-IDs.
const CAM_GEN2 = "EFEFEFEF-1111-2222-3333-444455556666";
const CAM_GEN1 = "AABBCCDD-1111-2222-3333-444455556666";

const CAM_TERRASSE = {
    id: CAM_GEN2,
    title: "Terrasse",
    hardwareVersion: "HOME_Eyes_Outdoor",
    firmwareVersion: "9.40.25",
    featureSupport: { light: true },
};
const CAM_360 = {
    id: CAM_GEN1,
    title: "Wohnzimmer",
    hardwareVersion: "CAMERA_360",
    firmwareVersion: "7.91.56",
    featureSupport: { light: false },
};

// ── captured-request axios stub (URL match) ─────────────────────────────────

interface Matcher {
    match: string;
    method?: string;
    status?: number;
    data?: unknown;
}
let _savedAdapter: typeof axios.defaults.adapter;

function installAxios(matchers: Matcher[]): void {
    _savedAdapter = axios.defaults.adapter;
    axios.defaults.adapter = (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
        const url = config.url ?? "";
        const method = (config.method ?? "get").toLowerCase();
        const hit = matchers.find(
            (m) => url.includes(m.match) && (m.method === undefined || m.method === method),
        );
        const resp: Partial<AxiosResponse> = hit
            ? { status: hit.status ?? 200, data: hit.data ?? null }
            : { status: 404, data: null };
        return Promise.resolve({
            status: 200,
            statusText: "OK",
            headers: {},
            data: null,
            config,
            request: {},
            ...resp,
        } as AxiosResponse);
    };
}

function resolveBuildModule(name: string): string {
    return path.join(REPO_ROOT, "build", "lib", `${name}.js`);
}

function createAdapterWithMocks(): { db: MockDatabase; adapter: TestAdapter } {
    const db = new MockDatabaseCtor();
    let capturedAdapter: MockAdapter | null = null;

    const core = mockAdapterCoreFn(db, {
        onAdapterCreated: (a: MockAdapter) => {
            capturedAdapter = a;
        },
    });
    const inject = (p: string, exports: unknown): void => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (require.cache as any)[p] = {
            id: p,
            filename: p,
            loaded: true,
            parent: module,
            children: [],
            path: path.dirname(p),
            paths: [],
            exports,
        };
    };

    inject(ADAPTER_CORE_PATH, core);
    delete require.cache[resolveBuildModule("snapshot")];
    inject(resolveBuildModule("snapshot"), {
        fetchSnapshot: sinon.stub().resolves(Buffer.from("FAKEJPEG")),
        buildSnapshotUrl: (u: string) => `${u}/snap.jpg`,
    });
    const fakeSession = {
        camId: CAM_GEN2,
        lanAddress: "192.168.1.149:443",
        proxyUrl: "rtsp://127.0.0.1:18010/rtsp_tunnel",
        maxSessionDuration: 3600,
        openedAt: Date.now(),
        digestUser: "u",
        digestPassword: "p",
    };
    delete require.cache[resolveBuildModule("live_session")];
    inject(resolveBuildModule("live_session"), {
        openLiveSession: sinon.stub().resolves(fakeSession),
        closeLiveSession: sinon.stub().resolves(),
    });
    delete require.cache[resolveBuildModule("tls_proxy")];
    inject(resolveBuildModule("tls_proxy"), {
        startTlsProxy: sinon.stub().resolves({
            port: 18010,
            localRtspUrl: "rtsp://127.0.0.1:18010/rtsp_tunnel",
            stop: sinon.stub().resolves(),
        }),
    });
    delete require.cache[resolveBuildModule("session_watchdog")];
    inject(resolveBuildModule("session_watchdog"), {
        SessionWatchdog: class {
            start = sinon.stub();
            stop = sinon.stub();
            constructor(_o: unknown) {}
        },
    });

    delete require.cache[MAIN_JS_PATH];
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const factory = require(MAIN_JS_PATH) as (opts: Record<string, unknown>) => MockAdapter;
    factory({ config: { redirect_url: "", region: "EU", startup_snapshot: true } });

    if (!capturedAdapter) throw new Error("adapter not captured");
    const adapter = capturedAdapter as TestAdapter;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = adapter as any;
    a.setTimeout = (_fn: () => void, _ms: number) => null;
    a.clearTimeout = (_h: unknown) => undefined;
    a.setInterval = (_fn: () => void, _ms: number) => null;
    a.clearInterval = (_h: unknown) => undefined;
    a.terminate = () => undefined;
    a.writeFileAsync = sinon.stub().resolves();
    return { db, adapter };
}

/**
 * Install axios stubs (matchers + a trailing /v11/video_inputs list matcher),
 * create the adapter and boot it. installAxios runs FIRST so the _httpClient
 * created at field-init uses the stub. Returns the booted adapter with its
 * camera objects created and _cameras map populated.
 */
async function bootedAdapter(
    cameras: unknown[],
    extra: Matcher[],
): Promise<{ db: MockDatabase; adapter: TestAdapter }> {
    installAxios([
        ...extra,
        // list matcher LAST — every per-cam endpoint URL also contains
        // "/v11/video_inputs", so the specific matchers must win first.
        { match: "/v11/video_inputs", method: "get", status: 200, data: cameras },
    ]);
    const { db, adapter } = createAdapterWithMocks();
    db.publishState(`${adapter.namespace}.info.access_token`, { val: "stored.acc", ack: true });
    db.publishState(`${adapter.namespace}.info.refresh_token`, { val: "stored.ref", ack: true });
    db.publishState(`${adapter.namespace}.info.token_expires_at`, {
        val: Date.now() + 200_000,
        ack: true,
    });
    await adapter.readyHandler!();
    return { db, adapter };
}

function stateVal(db: MockDatabase, adapter: TestAdapter, id: string): unknown {
    return (db.getState(`${adapter.namespace}.${id}`) as ioBroker.State | null)?.val;
}

async function objExists(adapter: TestAdapter, id: string): Promise<boolean> {
    const o = await adapter.getObjectAsync(id);
    return o != null;
}

async function pollManagement(adapter: TestAdapter, camId: string): Promise<void> {
    const a = adapter as unknown as ManagementAdapter;
    const cam = a._cameras.get(camId);
    if (!cam) throw new Error(`camera ${camId} not in cache after boot`);
    await a._pollManagementReads("stored.acc", cam);
}

afterEach(() => {
    if (_savedAdapter !== undefined) {
        axios.defaults.adapter = _savedAdapter;
    }
    sinon.restore();
    ["snapshot", "live_session", "tls_proxy", "session_watchdog"].forEach((m) =>
        delete require.cache[resolveBuildModule(m)],
    );
    delete require.cache[MAIN_JS_PATH];
});

// ── object creation gates ───────────────────────────────────────────────────

describe("v1.2.0 management DP object creation", () => {
    it("creates count + json DPs for all cameras (Gen2)", async () => {
        const { adapter } = await bootedAdapter([CAM_TERRASSE], []);
        for (const dp of [
            "motion_zones_count",
            "motion_zones",
            "privacy_masks_count",
            "privacy_masks",
            "rules_count",
            "rules",
        ]) {
            expect(await objExists(adapter, `cameras.${CAM_GEN2}.${dp}`), dp).to.equal(true);
        }
    });

    it("Gen2 gets shared_with_friends_* but NOT lighting_schedule_*", async () => {
        const { adapter } = await bootedAdapter([CAM_TERRASSE], []);
        expect(await objExists(adapter, `cameras.${CAM_GEN2}.shared_with_friends_count`)).to.equal(
            true,
        );
        expect(await objExists(adapter, `cameras.${CAM_GEN2}.shared_with_friends`)).to.equal(true);
        expect(await objExists(adapter, `cameras.${CAM_GEN2}.lighting_schedule_status`)).to.equal(
            false,
        );
    });

    it("Gen1 gets lighting_schedule_* but NOT shared_with_friends_*", async () => {
        const { adapter } = await bootedAdapter([CAM_360], []);
        expect(await objExists(adapter, `cameras.${CAM_GEN1}.lighting_schedule_status`)).to.equal(
            true,
        );
        expect(await objExists(adapter, `cameras.${CAM_GEN1}.lighting_schedule`)).to.equal(true);
        expect(await objExists(adapter, `cameras.${CAM_GEN1}.shared_with_friends_count`)).to.equal(
            false,
        );
    });
});

// ── rules / zones / privacy masks (array endpoints) ─────────────────────────

describe("v1.2.0 _pollCloudListDp array mirrors", () => {
    it("rules: 2-rule array → rules_count=2 + rules JSON", async () => {
        const rules = [
            {
                id: "r1",
                name: "Night",
                isActive: true,
                startTime: "22:00:00",
                endTime: "06:00:00",
                weekdays: [0, 1, 2],
            },
            {
                id: "r2",
                name: "Day",
                isActive: false,
                startTime: "08:00:00",
                endTime: "20:00:00",
                weekdays: [5, 6],
            },
        ];
        const { db, adapter } = await bootedAdapter([CAM_TERRASSE], [
            { match: "/rules", method: "get", status: 200, data: rules },
        ]);
        await pollManagement(adapter, CAM_GEN2);
        expect(stateVal(db, adapter, `cameras.${CAM_GEN2}.rules_count`)).to.equal(2);
        expect(
            JSON.parse(stateVal(db, adapter, `cameras.${CAM_GEN2}.rules`) as string),
        ).to.deep.equal(rules);
    });

    it("motion zones: 3-zone array → motion_zones_count=3 + JSON", async () => {
        const zones = [
            { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
            { x: 0.5, y: 0.5, w: 0.1, h: 0.1 },
            { x: 0.0, y: 0.0, w: 1.0, h: 1.0 },
        ];
        const { db, adapter } = await bootedAdapter([CAM_TERRASSE], [
            { match: "/motion_sensitive_areas", method: "get", status: 200, data: zones },
        ]);
        await pollManagement(adapter, CAM_GEN2);
        expect(stateVal(db, adapter, `cameras.${CAM_GEN2}.motion_zones_count`)).to.equal(3);
        expect(
            JSON.parse(stateVal(db, adapter, `cameras.${CAM_GEN2}.motion_zones`) as string),
        ).to.deep.equal(zones);
    });

    it("privacy masks: empty array → count 0 + '[]'", async () => {
        const { db, adapter } = await bootedAdapter([CAM_TERRASSE], [
            { match: "/privacy_masks", method: "get", status: 200, data: [] },
        ]);
        await pollManagement(adapter, CAM_GEN2);
        expect(stateVal(db, adapter, `cameras.${CAM_GEN2}.privacy_masks_count`)).to.equal(0);
        expect(stateVal(db, adapter, `cameras.${CAM_GEN2}.privacy_masks`)).to.equal("[]");
    });

    it("443 (privacy mode) → no write (count stays unset)", async () => {
        const { db, adapter } = await bootedAdapter([CAM_TERRASSE], [
            { match: "/motion_sensitive_areas", method: "get", status: 443, data: null },
        ]);
        await pollManagement(adapter, CAM_GEN2);
        expect(stateVal(db, adapter, `cameras.${CAM_GEN2}.motion_zones_count`)).to.equal(undefined);
    });

    it("404 → no write", async () => {
        const { db, adapter } = await bootedAdapter([CAM_TERRASSE], [
            { match: "/rules", method: "get", status: 404, data: null },
        ]);
        await pollManagement(adapter, CAM_GEN2);
        expect(stateVal(db, adapter, `cameras.${CAM_GEN2}.rules_count`)).to.equal(undefined);
    });

    it("2xx but non-array body → no write", async () => {
        const { db, adapter } = await bootedAdapter([CAM_TERRASSE], [
            { match: "/rules", method: "get", status: 200, data: { unexpected: "object" } },
        ]);
        await pollManagement(adapter, CAM_GEN2);
        expect(stateVal(db, adapter, `cameras.${CAM_GEN2}.rules_count`)).to.equal(undefined);
    });

    it("HTTP 500 (outside validateStatus) → swallowed, no throw, no write", async () => {
        const { db, adapter } = await bootedAdapter([CAM_TERRASSE], [
            { match: "/rules", method: "get", status: 500, data: null },
        ]);
        let threw = false;
        try {
            await pollManagement(adapter, CAM_GEN2);
        } catch {
            threw = true;
        }
        expect(threw, "network/5xx error must be swallowed").to.equal(false);
        expect(stateVal(db, adapter, `cameras.${CAM_GEN2}.rules_count`)).to.equal(undefined);
    });
});

// ── shared_with_friends (Gen2 only) ─────────────────────────────────────────

describe("v1.2.0 shared_with_friends gating", () => {
    it("Gen2: friends array → shared_with_friends_count + JSON", async () => {
        const friends = [
            { id: "f1", nickName: "Alice", email: "a@example.com", status: "ACCEPTED" },
            {
                id: "f2",
                nickName: "Bob",
                invitationEmail: "b@example.com",
                invitationStatus: "PENDING",
            },
        ];
        const { db, adapter } = await bootedAdapter([CAM_TERRASSE], [
            { match: "/shared_with_friends", method: "get", status: 200, data: friends },
        ]);
        await pollManagement(adapter, CAM_GEN2);
        expect(stateVal(db, adapter, `cameras.${CAM_GEN2}.shared_with_friends_count`)).to.equal(2);
        expect(
            JSON.parse(stateVal(db, adapter, `cameras.${CAM_GEN2}.shared_with_friends`) as string),
        ).to.deep.equal(friends);
    });

    it("Gen1: shared_with_friends endpoint is NOT polled (gen gate)", async () => {
        // Stub would return data IF it were called — but the gen<2 gate skips it.
        const { db, adapter } = await bootedAdapter([CAM_360], [
            { match: "/shared_with_friends", method: "get", status: 200, data: [{ id: "x" }] },
        ]);
        await pollManagement(adapter, CAM_GEN1);
        expect(stateVal(db, adapter, `cameras.${CAM_GEN1}.shared_with_friends_count`)).to.equal(
            undefined,
        );
    });
});

// ── lighting_options (Gen1 only) ────────────────────────────────────────────

describe("v1.2.0 lighting_options (Gen1 floodlight schedule)", () => {
    it("Gen1: 200 object → lighting_schedule_status + raw JSON", async () => {
        const opts = {
            scheduleStatus: "SCHEDULE",
            generalLightOnTime: "20:00",
            generalLightOffTime: "06:00",
            darknessThreshold: 0.4,
            lightOnMotion: true,
        };
        const { db, adapter } = await bootedAdapter([CAM_360], [
            { match: "/lighting_options", method: "get", status: 200, data: opts },
        ]);
        await pollManagement(adapter, CAM_GEN1);
        expect(stateVal(db, adapter, `cameras.${CAM_GEN1}.lighting_schedule_status`)).to.equal(
            "SCHEDULE",
        );
        expect(
            JSON.parse(stateVal(db, adapter, `cameras.${CAM_GEN1}.lighting_schedule`) as string),
        ).to.deep.equal(opts);
    });

    it("Gen1: scheduleStatus missing → status mirrored as empty string", async () => {
        const { db, adapter } = await bootedAdapter([CAM_360], [
            {
                match: "/lighting_options",
                method: "get",
                status: 200,
                data: { darknessThreshold: 0.4 },
            },
        ]);
        await pollManagement(adapter, CAM_GEN1);
        expect(stateVal(db, adapter, `cameras.${CAM_GEN1}.lighting_schedule_status`)).to.equal("");
    });

    it("Gen1: 442 (unsupported model) → no write", async () => {
        const { db, adapter } = await bootedAdapter([CAM_360], [
            { match: "/lighting_options", method: "get", status: 442, data: null },
        ]);
        await pollManagement(adapter, CAM_GEN1);
        expect(stateVal(db, adapter, `cameras.${CAM_GEN1}.lighting_schedule_status`)).to.equal(
            undefined,
        );
    });

    it("Gen1: 200 but array body (not object) → no write", async () => {
        const { db, adapter } = await bootedAdapter([CAM_360], [
            { match: "/lighting_options", method: "get", status: 200, data: [1, 2, 3] },
        ]);
        await pollManagement(adapter, CAM_GEN1);
        expect(stateVal(db, adapter, `cameras.${CAM_GEN1}.lighting_schedule_status`)).to.equal(
            undefined,
        );
    });

    it("Gen2: lighting_options endpoint is NOT polled (gen gate)", async () => {
        const { db, adapter } = await bootedAdapter([CAM_TERRASSE], [
            {
                match: "/lighting_options",
                method: "get",
                status: 200,
                data: { scheduleStatus: "X" },
            },
        ]);
        await pollManagement(adapter, CAM_GEN2);
        // DP not even created for Gen2 → stays undefined.
        expect(stateVal(db, adapter, `cameras.${CAM_GEN2}.lighting_schedule_status`)).to.equal(
            undefined,
        );
    });
});
