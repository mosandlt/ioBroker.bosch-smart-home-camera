/**
 * v1.1.0 feature tests — covers the new HA-parity + ioBroker-native additions:
 *
 *  - notifications_enabled: write ON → PUT /enable_notifications
 *    {enabledNotificationsStatus:"FOLLOW_CAMERA_SCHEDULE"}; OFF → "ALWAYS_OFF"; ack
 *  - motion_enabled: write → PUT /motion full body {enabled, motionAlarmConfiguration}
 *    with the sensitivity preserved from the cache (no clobber); ack
 *  - motion_sensitivity: write super_high → PUT /motion {motionAlarmConfiguration:"SUPER_HIGH"}
 *    with enabled preserved; invalid value → ignored (no ack); 443 privacy → no ack
 *  - _pollMotionConfig: GET /motion 200 → mirrors motion_enabled + motion_sensitivity DPs
 *    and seeds _motionCache; 404/443 → no DP write
 *  - notifications read mirror: listing notificationsEnabledStatus → notifications_enabled DP
 *  - sendTo("snapshot"): resolve by name / id / sole-camera / ambiguous-missing; payload shape
 *  - _resolveCameraId: id, name (case-insensitive), empty→sole, unknown→null
 *
 * Harness mirrors main_audio_intrusion_wifi.spec.ts (createAdapterWithMocks +
 * boot via build/main.js). Axios is captured per-request so PUT bodies can be
 * asserted by URL instead of call order (immune to poll drift).
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
    messageHandler?: (obj: ioBroker.Message) => Promise<void> | void;
};

// FAKE fixture IDs only (SECRETS_SCAN_GAP) — never real device cloud-IDs.
const CAM_GEN2 = "EFEFEFEF-1111-2222-3333-444455556666";
const CAM_GEN1 = "AABBCCDD-1111-2222-3333-444455556666";

const CAM_TERRASSE = {
    id: CAM_GEN2,
    title: "Terrasse",
    hardwareVersion: "HOME_Eyes_Outdoor",
    firmwareVersion: "9.40.25",
    featureSupport: { light: true },
};
const CAM_INDOOR = {
    id: CAM_GEN1,
    title: "Indoor",
    hardwareVersion: "CAMERA_360",
    firmwareVersion: "7.91.56",
    featureSupport: { light: false },
};

// ── captured-request axios stub (URL match, records body) ───────────────────

interface CapturedRequest {
    url: string;
    method: string;
    body: unknown;
}
interface Matcher {
    match: string;
    method?: string;
    status?: number;
    data?: unknown;
}
let _savedAdapter: typeof axios.defaults.adapter;
const captured: CapturedRequest[] = [];

function installAxios(matchers: Matcher[]): void {
    captured.length = 0;
    _savedAdapter = axios.defaults.adapter;
    axios.defaults.adapter = (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
        const url = config.url ?? "";
        const method = (config.method ?? "get").toLowerCase();
        let body: unknown = config.data;
        if (typeof body === "string") {
            try {
                body = JSON.parse(body);
            } catch {
                /* leave as string */
            }
        }
        captured.push({ url, method, body });
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

function lastPut(urlFragment: string): CapturedRequest | undefined {
    return [...captured].reverse().find((r) => r.method === "put" && r.url.includes(urlFragment));
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

async function bootWithTokens(db: MockDatabase, adapter: TestAdapter): Promise<void> {
    db.publishState(`${adapter.namespace}.info.access_token`, { val: "stored.acc", ack: true });
    db.publishState(`${adapter.namespace}.info.refresh_token`, { val: "stored.ref", ack: true });
    db.publishState(`${adapter.namespace}.info.token_expires_at`, {
        val: Date.now() + 200_000,
        ack: true,
    });
    await adapter.readyHandler!();
}

function stateVal(db: MockDatabase, adapter: TestAdapter, id: string): unknown {
    return (db.getState(`${adapter.namespace}.${id}`) as ioBroker.State | null)?.val;
}
function stateAck(db: MockDatabase, adapter: TestAdapter, id: string): boolean | undefined {
    return (db.getState(`${adapter.namespace}.${id}`) as ioBroker.State | null)?.ack;
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

// ── notifications_enabled write ─────────────────────────────────────────────

describe("v1.1.0 notifications_enabled write", () => {
    it("ON → PUT /enable_notifications {FOLLOW_CAMERA_SCHEDULE}, acked", async () => {
        installAxios([
            { match: "/v11/video_inputs", method: "get", status: 200, data: [CAM_TERRASSE] },
            { match: "/enable_notifications", method: "put", status: 204 },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2}.notifications_enabled`;
        await adapter.stateChangeHandler!(`${adapter.namespace}.${id}`, {
            val: true,
            ack: false,
            ts: Date.now(),
            lc: Date.now(),
            from: "user",
        });

        const put = lastPut("/enable_notifications");
        expect(put, "PUT was issued").to.not.be.undefined;
        expect((put!.body as Record<string, unknown>).enabledNotificationsStatus).to.equal(
            "FOLLOW_CAMERA_SCHEDULE",
        );
        expect(stateAck(db, adapter, id)).to.equal(true);
    });

    it("OFF → PUT {ALWAYS_OFF}, acked", async () => {
        installAxios([
            { match: "/v11/video_inputs", method: "get", status: 200, data: [CAM_TERRASSE] },
            { match: "/enable_notifications", method: "put", status: 204 },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2}.notifications_enabled`;
        await adapter.stateChangeHandler!(`${adapter.namespace}.${id}`, {
            val: false,
            ack: false,
            ts: Date.now(),
            lc: Date.now(),
            from: "user",
        });
        expect((lastPut("/enable_notifications")!.body as Record<string, unknown>)
            .enabledNotificationsStatus).to.equal("ALWAYS_OFF");
        expect(stateAck(db, adapter, id)).to.equal(true);
    });
});

// ── motion_enabled + motion_sensitivity write (shared /motion full body) ─────

describe("v1.1.0 motion write (full-body merge)", () => {
    it("motion_enabled=false preserves cached sensitivity in the PUT body", async () => {
        installAxios([
            // /motion BEFORE /v11/video_inputs: the GET /motion URL also contains
            // "/v11/video_inputs/{id}/motion", and first-match-wins — so the more
            // specific path must come first (helper contract).
            {
                match: "/motion",
                method: "get",
                status: 200,
                data: { enabled: true, motionAlarmConfiguration: "HIGH" },
            },
            { match: "/motion", method: "put", status: 204 },
            { match: "/v11/video_inputs", method: "get", status: 200, data: [CAM_TERRASSE] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // seed cache via the read path
        await (adapter as unknown as { _pollMotionConfig: (t: string, c: string) => Promise<void> })
            ._pollMotionConfig("stored.acc", CAM_GEN2);

        const id = `cameras.${CAM_GEN2}.motion_enabled`;
        await adapter.stateChangeHandler!(`${adapter.namespace}.${id}`, {
            val: false,
            ack: false,
            ts: Date.now(),
            lc: Date.now(),
            from: "user",
        });

        const put = lastPut("/motion");
        expect(put, "PUT /motion issued").to.not.be.undefined;
        const body = put!.body as Record<string, unknown>;
        expect(body.enabled).to.equal(false);
        expect(body.motionAlarmConfiguration, "sensitivity preserved").to.equal("HIGH");
        expect(stateAck(db, adapter, id)).to.equal(true);
    });

    it("motion_sensitivity=super_high → PUT {SUPER_HIGH}, enabled preserved", async () => {
        installAxios([
            {
                match: "/motion",
                method: "get",
                status: 200,
                data: { enabled: true, motionAlarmConfiguration: "LOW" },
            },
            { match: "/motion", method: "put", status: 204 },
            { match: "/v11/video_inputs", method: "get", status: 200, data: [CAM_TERRASSE] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        await (adapter as unknown as { _pollMotionConfig: (t: string, c: string) => Promise<void> })
            ._pollMotionConfig("stored.acc", CAM_GEN2);

        const id = `cameras.${CAM_GEN2}.motion_sensitivity`;
        await adapter.stateChangeHandler!(`${adapter.namespace}.${id}`, {
            val: "super_high",
            ack: false,
            ts: Date.now(),
            lc: Date.now(),
            from: "user",
        });
        const body = lastPut("/motion")!.body as Record<string, unknown>;
        expect(body.motionAlarmConfiguration).to.equal("SUPER_HIGH");
        expect(body.enabled, "enabled preserved").to.equal(true);
        expect(stateAck(db, adapter, id)).to.equal(true);
    });

    it("invalid motion_sensitivity value → ignored, no PUT, no ack", async () => {
        installAxios([
            { match: "/v11/video_inputs", method: "get", status: 200, data: [CAM_TERRASSE] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2}.motion_sensitivity`;
        await adapter.stateChangeHandler!(`${adapter.namespace}.${id}`, {
            val: "ludicrous",
            ack: false,
            ts: Date.now(),
            lc: Date.now(),
            from: "user",
        });
        expect(lastPut("/motion"), "no PUT for invalid value").to.be.undefined;
        expect(stateAck(db, adapter, id)).to.not.equal(true);
    });

    it("443 privacy on GET (no cache) → write skipped, no ack", async () => {
        installAxios([
            { match: "/motion", method: "get", status: 443 },
            { match: "/v11/video_inputs", method: "get", status: 200, data: [CAM_TERRASSE] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2}.motion_enabled`;
        await adapter.stateChangeHandler!(`${adapter.namespace}.${id}`, {
            val: false,
            ack: false,
            ts: Date.now(),
            lc: Date.now(),
            from: "user",
        });
        expect(lastPut("/motion"), "no PUT under privacy").to.be.undefined;
        expect(stateAck(db, adapter, id)).to.not.equal(true);
    });
});

// ── _pollMotionConfig read mirror ───────────────────────────────────────────

describe("v1.1.0 _pollMotionConfig", () => {
    it("200 → mirrors motion_enabled + motion_sensitivity DPs", async () => {
        installAxios([
            {
                match: "/motion",
                method: "get",
                status: 200,
                data: { enabled: false, motionAlarmConfiguration: "MEDIUM_LOW" },
            },
            { match: "/v11/video_inputs", method: "get", status: 200, data: [CAM_TERRASSE] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        await (adapter as unknown as { _pollMotionConfig: (t: string, c: string) => Promise<void> })
            ._pollMotionConfig("stored.acc", CAM_GEN2);

        expect(stateVal(db, adapter, `cameras.${CAM_GEN2}.motion_enabled`)).to.equal(false);
        expect(stateVal(db, adapter, `cameras.${CAM_GEN2}.motion_sensitivity`)).to.equal(
            "medium_low",
        );
    });

    it("404 → no DP write (keeps default)", async () => {
        installAxios([
            { match: "/v11/video_inputs", method: "get", status: 200, data: [CAM_TERRASSE] },
            { match: "/motion", method: "get", status: 404 },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        await (adapter as unknown as { _pollMotionConfig: (t: string, c: string) => Promise<void> })
            ._pollMotionConfig("stored.acc", CAM_GEN2);
        // default def is "high"; 404 must not overwrite to anything else
        expect(stateVal(db, adapter, `cameras.${CAM_GEN2}.motion_sensitivity`)).to.not.equal(
            "medium_low",
        );
    });
});

// ── sendTo("snapshot") + _resolveCameraId ───────────────────────────────────

describe("v1.1.0 sendTo snapshot + _resolveCameraId", () => {
    it("_resolveCameraId: id, name (case-insensitive), empty→sole, unknown→null", async () => {
        installAxios([
            { match: "/v11/video_inputs", method: "get", status: 200, data: [CAM_TERRASSE] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        const resolve = (adapter as unknown as { _resolveCameraId: (r: string) => string | null })
            ._resolveCameraId.bind(adapter);
        expect(resolve(CAM_GEN2)).to.equal(CAM_GEN2);
        expect(resolve("terrasse")).to.equal(CAM_GEN2);
        expect(resolve(""), "sole camera").to.equal(CAM_GEN2);
        expect(resolve("nope")).to.be.null;
        void db;
    });

    it("ambiguous empty with 2 cameras → null", async () => {
        installAxios([
            {
                match: "/v11/video_inputs",
                method: "get",
                status: 200,
                data: [CAM_TERRASSE, CAM_INDOOR],
            },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        const resolve = (adapter as unknown as { _resolveCameraId: (r: string) => string | null })
            ._resolveCameraId.bind(adapter);
        expect(resolve("")).to.be.null;
        void db;
    });

    it("sendTo snapshot returns base64 + dataUrl for a cached frame", async () => {
        installAxios([
            { match: "/v11/video_inputs", method: "get", status: 200, data: [CAM_TERRASSE] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // isolate the reply logic from the live snapshot fetch
        const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any).handleSnapshotTrigger = sinon.stub().resolves();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any)._latestSnapshots.set(CAM_GEN2, buf);

        let replied: Record<string, unknown> | undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any).sendTo = (
            _from: string,
            _cmd: string,
            payload: Record<string, unknown>,
        ) => {
            replied = payload;
        };
        await adapter.messageHandler!({
            command: "snapshot",
            message: { name: "Terrasse" },
            from: "system.adapter.admin.0",
            callback: { id: 1 },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);

        expect(replied, "callback fired").to.not.be.undefined;
        expect(replied!.error, "no error").to.be.undefined;
        expect(replied!.mimeType).to.equal("image/jpeg");
        expect(replied!.base64).to.equal(buf.toString("base64"));
        expect(String(replied!.dataUrl)).to.match(/^data:image\/jpeg;base64,/);
        expect(replied!.camId).to.equal(CAM_GEN2);
        void db;
    });

    it("sendTo snapshot unknown camera → error payload, no fetch", async () => {
        installAxios([
            { match: "/v11/video_inputs", method: "get", status: 200, data: [CAM_TERRASSE] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const trigger = ((adapter as any).handleSnapshotTrigger = sinon.stub().resolves());
        let replied: Record<string, unknown> | undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any).sendTo = (_f: string, _c: string, payload: Record<string, unknown>) => {
            replied = payload;
        };
        await adapter.messageHandler!({
            command: "snapshot",
            message: { camId: "DOES-NOT-EXIST" },
            from: "system.adapter.admin.0",
            callback: { id: 2 },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        expect(replied!.error, "error returned").to.be.a("string");
        expect(trigger.called, "no snapshot fetch attempted").to.equal(false);
        void db;
    });
});

// ── notifications read mirror (listing → DP) ────────────────────────────────

describe("v1.1.0 notifications read mirror", () => {
    it("ALWAYS_OFF listing field → notifications_enabled=false", async () => {
        installAxios([
            {
                match: "/v11/video_inputs",
                method: "get",
                status: 200,
                data: [{ ...CAM_TERRASSE, notificationsEnabledStatus: "ALWAYS_OFF" }],
            },
            { match: "/motion", method: "get", status: 404 },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // drive a single poll tick to mirror the listing field
        await (
            adapter as unknown as { _pollCameraStateOnce: () => Promise<void> }
        )._pollCameraStateOnce();
        expect(stateVal(db, adapter, `cameras.${CAM_GEN2}.notifications_enabled`)).to.equal(false);
    });
});
