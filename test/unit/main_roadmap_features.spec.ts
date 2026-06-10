/**
 * v1.1.0 roadmap regression tests — covers 6 new features:
 *
 *  1. record_sound: write true/false → PUT /recording_options; _pollRecordingOptions GET mirror
 *  2. detection_mode: write with cache seed → PUT /intrusionDetectionConfig full-body merge;
 *     invalid value → no PUT; Gen1 cam → ignored
 *  3. per-type notifications: write notify_person → PUT /notifications full-body merge;
 *     _pollNotificationTypes mirrors all keys to notify_* DPs
 *  4. alarm_arm (Indoor cam): write true → PUT /intrusionSystem/arming {arm:true};
 *     non-Indoor (Gen2 Outdoor) → ignored; _pollAlarmStatus mirrors alarm_arm + alarm_state
 *  5. alarm_mode (Indoor): cache seed via _pollAlarmSettings; write true → PUT /alarm_settings {alarmMode:"ON"}
 *  6. pre_alarm (Indoor): same cache seed; write true → PUT /alarm_settings {preAlarmMode:"ON"}
 *
 * Harness is a verbatim copy of main_v110_features.spec.ts.
 * FAKE cloud-IDs only (SECRETS_SCAN_GAP) — never real device IDs.
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
const CAM_GEN2_ID = "EFEFEFEF-1111-2222-3333-444455556666";
const CAM_GEN2_INDOOR_ID = "CCCCDDDD-1111-2222-3333-444455556666";
const CAM_GEN1_ID = "AABBCCDD-1111-2222-3333-444455556666";

const CAM_TERRASSE = {
    id: CAM_GEN2_ID,
    title: "Terrasse",
    hardwareVersion: "HOME_Eyes_Outdoor",
    firmwareVersion: "9.40.25",
    featureSupport: { light: true },
};

const CAM_INNEN = {
    id: CAM_GEN2_INDOOR_ID,
    title: "Innen",
    hardwareVersion: "HOME_Eyes_Indoor",
    firmwareVersion: "9.40.25",
    featureSupport: { light: false },
};

const CAM_GEN1 = {
    id: CAM_GEN1_ID,
    title: "Kamera",
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
        camId: CAM_GEN2_ID,
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

// ── 1. record_sound ─────────────────────────────────────────────────────────

describe("roadmap record_sound", () => {
    it("write true → PUT /recording_options {recordSound:true}, acked", async () => {
        installAxios([
            // CRITICAL: specific sub-path before the broad /v11/video_inputs GET
            { match: "/recording_options", method: "get", status: 200, data: { recordSound: false } },
            { match: "/recording_options", method: "put", status: 204 },
            { match: "/v11/video_inputs", method: "get", status: 200, data: [CAM_TERRASSE] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2_ID}.record_sound`;
        await adapter.stateChangeHandler!(`${adapter.namespace}.${id}`, {
            val: true,
            ack: false,
            ts: Date.now(),
            lc: Date.now(),
            from: "user",
        });

        const put = lastPut("/recording_options");
        expect(put, "PUT /recording_options issued").to.not.be.undefined;
        expect((put!.body as Record<string, unknown>).recordSound).to.equal(true);
        expect(stateAck(db, adapter, id)).to.equal(true);
    });

    it("_pollRecordingOptions GET 200 {recordSound:false} → DP false", async () => {
        installAxios([
            { match: "/recording_options", method: "get", status: 200, data: { recordSound: false } },
            { match: "/recording_options", method: "put", status: 204 },
            { match: "/v11/video_inputs", method: "get", status: 200, data: [CAM_TERRASSE] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        await (adapter as unknown as { _pollRecordingOptions: (t: string, c: string) => Promise<void> })
            ._pollRecordingOptions("stored.acc", CAM_GEN2_ID);

        expect(stateVal(db, adapter, `cameras.${CAM_GEN2_ID}.record_sound`)).to.equal(false);
    });
});

// ── 2. detection_mode ───────────────────────────────────────────────────────

describe("roadmap detection_mode", () => {
    it("write only_humans → PUT /intrusionDetectionConfig {detectionMode:ONLY_HUMANS, sensitivity preserved}", async () => {
        installAxios([
            // specific intrusion path before broad /v11/video_inputs
            {
                match: "/intrusionDetectionConfig",
                method: "get",
                status: 200,
                data: { detectionMode: "ALL_MOTIONS", sensitivity: 3, distance: 5, enabled: true },
            },
            { match: "/intrusionDetectionConfig", method: "put", status: 204 },
            { match: "/v11/video_inputs", method: "get", status: 200, data: [CAM_TERRASSE] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // Seed the intrusion cache so the write has preserved data
        await (adapter as unknown as { _pollIntrusionConfig: (t: string, c: string) => Promise<void> })
            ._pollIntrusionConfig("stored.acc", CAM_GEN2_ID);

        const id = `cameras.${CAM_GEN2_ID}.detection_mode`;
        await adapter.stateChangeHandler!(`${adapter.namespace}.${id}`, {
            val: "only_humans",
            ack: false,
            ts: Date.now(),
            lc: Date.now(),
            from: "user",
        });

        const put = lastPut("/intrusionDetectionConfig");
        expect(put, "PUT /intrusionDetectionConfig issued").to.not.be.undefined;
        const body = put!.body as Record<string, unknown>;
        expect(body.detectionMode).to.equal("ONLY_HUMANS");
        expect(body.sensitivity, "sensitivity preserved from cache").to.equal(3);
        expect(stateAck(db, adapter, id)).to.equal(true);
    });

    it("invalid value 'xyz' → no PUT, no ack", async () => {
        installAxios([
            { match: "/v11/video_inputs", method: "get", status: 200, data: [CAM_TERRASSE] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2_ID}.detection_mode`;
        await adapter.stateChangeHandler!(`${adapter.namespace}.${id}`, {
            val: "xyz",
            ack: false,
            ts: Date.now(),
            lc: Date.now(),
            from: "user",
        });

        expect(lastPut("/intrusionDetectionConfig"), "no PUT for invalid value").to.be.undefined;
        expect(stateAck(db, adapter, id)).to.not.equal(true);
    });

    it("Gen1 cam → ignored (no PUT, no ack)", async () => {
        installAxios([
            { match: "/v11/video_inputs", method: "get", status: 200, data: [CAM_GEN1] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN1_ID}.detection_mode`;
        await adapter.stateChangeHandler!(`${adapter.namespace}.${id}`, {
            val: "only_humans",
            ack: false,
            ts: Date.now(),
            lc: Date.now(),
            from: "user",
        });

        expect(lastPut("/intrusionDetectionConfig"), "no PUT on Gen1").to.be.undefined;
        expect(stateAck(db, adapter, id)).to.not.equal(true);
    });
});

// ── 3. per-type notifications ────────────────────────────────────────────────

describe("roadmap per-type notifications", () => {
    it("write notify_person false → PUT /notifications {person:false, movement preserved}", async () => {
        installAxios([
            // specific /notifications sub-path before the broad cameras GET
            {
                match: "/notifications",
                method: "get",
                status: 200,
                data: {
                    movement: true,
                    person: true,
                    audio: true,
                    trouble: true,
                    cameraAlarm: true,
                    troubleEmail: true,
                },
            },
            { match: "/notifications", method: "put", status: 204 },
            { match: "/v11/video_inputs", method: "get", status: 200, data: [CAM_TERRASSE] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // Seed the notifications cache
        await (adapter as unknown as { _pollNotificationTypes: (t: string, c: string) => Promise<void> })
            ._pollNotificationTypes("stored.acc", CAM_GEN2_ID);

        const id = `cameras.${CAM_GEN2_ID}.notify_person`;
        await adapter.stateChangeHandler!(`${adapter.namespace}.${id}`, {
            val: false,
            ack: false,
            ts: Date.now(),
            lc: Date.now(),
            from: "user",
        });

        const put = lastPut("/notifications");
        expect(put, "PUT /notifications issued").to.not.be.undefined;
        const body = put!.body as Record<string, unknown>;
        expect(body.person).to.equal(false);
        expect(body.movement, "movement preserved from cache").to.equal(true);
        expect(stateAck(db, adapter, id)).to.equal(true);
    });

    it("_pollNotificationTypes mirrors notify_camera_alarm DP from cameraAlarm key", async () => {
        installAxios([
            {
                match: "/notifications",
                method: "get",
                status: 200,
                data: {
                    movement: true,
                    person: false,
                    audio: false,
                    trouble: false,
                    cameraAlarm: true,
                    troubleEmail: false,
                },
            },
            { match: "/notifications", method: "put", status: 204 },
            { match: "/v11/video_inputs", method: "get", status: 200, data: [CAM_TERRASSE] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        await (adapter as unknown as { _pollNotificationTypes: (t: string, c: string) => Promise<void> })
            ._pollNotificationTypes("stored.acc", CAM_GEN2_ID);

        expect(stateVal(db, adapter, `cameras.${CAM_GEN2_ID}.notify_camera_alarm`)).to.equal(true);
        expect(stateVal(db, adapter, `cameras.${CAM_GEN2_ID}.notify_person`)).to.equal(false);
    });
});

// ── 4. alarm_arm ────────────────────────────────────────────────────────────

describe("roadmap alarm_arm", () => {
    it("Indoor cam write true → PUT /intrusionSystem/arming {arm:true}, acked", async () => {
        installAxios([
            { match: "/intrusionSystem/arming", method: "put", status: 204 },
            {
                match: "/alarmStatus",
                method: "get",
                status: 200,
                data: { intrusionSystem: "DISARMED" },
            },
            {
                match: "/alarm_settings",
                method: "get",
                status: 200,
                data: {
                    alarmMode: "OFF",
                    preAlarmMode: "OFF",
                    alarmDelayInSeconds: 60,
                    alarmActivationDelaySeconds: 30,
                    preAlarmDelayInSeconds: 20,
                },
            },
            { match: "/v11/video_inputs", method: "get", status: 200, data: [CAM_INNEN] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2_INDOOR_ID}.alarm_arm`;
        await adapter.stateChangeHandler!(`${adapter.namespace}.${id}`, {
            val: true,
            ack: false,
            ts: Date.now(),
            lc: Date.now(),
            from: "user",
        });

        const put = lastPut("/intrusionSystem/arming");
        expect(put, "PUT /intrusionSystem/arming issued").to.not.be.undefined;
        expect((put!.body as Record<string, unknown>).arm).to.equal(true);
        expect(stateAck(db, adapter, id)).to.equal(true);
    });

    it("Gen2 Outdoor cam → ignored (no PUT, no ack)", async () => {
        installAxios([
            { match: "/v11/video_inputs", method: "get", status: 200, data: [CAM_TERRASSE] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2_ID}.alarm_arm`;
        await adapter.stateChangeHandler!(`${adapter.namespace}.${id}`, {
            val: true,
            ack: false,
            ts: Date.now(),
            lc: Date.now(),
            from: "user",
        });

        expect(lastPut("/intrusionSystem/arming"), "no PUT on Outdoor cam").to.be.undefined;
        expect(stateAck(db, adapter, id)).to.not.equal(true);
    });

    it("_pollAlarmStatus {intrusionSystem:ACTIVE} → alarm_arm=true + alarm_state=active", async () => {
        installAxios([
            {
                match: "/alarmStatus",
                method: "get",
                status: 200,
                data: { intrusionSystem: "ACTIVE" },
            },
            {
                match: "/alarm_settings",
                method: "get",
                status: 200,
                data: {
                    alarmMode: "OFF",
                    preAlarmMode: "OFF",
                    alarmDelayInSeconds: 60,
                    alarmActivationDelaySeconds: 30,
                    preAlarmDelayInSeconds: 20,
                },
            },
            { match: "/v11/video_inputs", method: "get", status: 200, data: [CAM_INNEN] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        await (adapter as unknown as { _pollAlarmStatus: (t: string, c: string) => Promise<void> })
            ._pollAlarmStatus("stored.acc", CAM_GEN2_INDOOR_ID);

        expect(stateVal(db, adapter, `cameras.${CAM_GEN2_INDOOR_ID}.alarm_arm`)).to.equal(true);
        expect(stateVal(db, adapter, `cameras.${CAM_GEN2_INDOOR_ID}.alarm_state`)).to.equal("active");
    });

    it("_pollAlarmStatus {intrusionSystem:DISARMED} → alarm_arm=false + alarm_state=disarmed", async () => {
        installAxios([
            {
                match: "/alarmStatus",
                method: "get",
                status: 200,
                data: { intrusionSystem: "DISARMED" },
            },
            {
                match: "/alarm_settings",
                method: "get",
                status: 200,
                data: {
                    alarmMode: "OFF",
                    preAlarmMode: "OFF",
                    alarmDelayInSeconds: 60,
                    alarmActivationDelaySeconds: 30,
                    preAlarmDelayInSeconds: 20,
                },
            },
            { match: "/v11/video_inputs", method: "get", status: 200, data: [CAM_INNEN] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        await (adapter as unknown as { _pollAlarmStatus: (t: string, c: string) => Promise<void> })
            ._pollAlarmStatus("stored.acc", CAM_GEN2_INDOOR_ID);

        expect(stateVal(db, adapter, `cameras.${CAM_GEN2_INDOOR_ID}.alarm_arm`)).to.equal(false);
        expect(stateVal(db, adapter, `cameras.${CAM_GEN2_INDOOR_ID}.alarm_state`)).to.equal(
            "disarmed",
        );
    });
});

// ── 5. alarm_mode ───────────────────────────────────────────────────────────

describe("roadmap alarm_mode", () => {
    it("Indoor: write true → PUT /alarm_settings {alarmMode:ON, alarmDelayInSeconds preserved}", async () => {
        installAxios([
            {
                match: "/alarm_settings",
                method: "get",
                status: 200,
                data: {
                    alarmMode: "OFF",
                    preAlarmMode: "OFF",
                    alarmDelayInSeconds: 60,
                    alarmActivationDelaySeconds: 30,
                    preAlarmDelayInSeconds: 20,
                },
            },
            { match: "/alarm_settings", method: "put", status: 204 },
            {
                match: "/alarmStatus",
                method: "get",
                status: 200,
                data: { intrusionSystem: "DISARMED" },
            },
            { match: "/v11/video_inputs", method: "get", status: 200, data: [CAM_INNEN] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // Seed alarm settings cache via poll
        await (adapter as unknown as { _pollAlarmSettings: (t: string, c: string) => Promise<void> })
            ._pollAlarmSettings("stored.acc", CAM_GEN2_INDOOR_ID);

        const id = `cameras.${CAM_GEN2_INDOOR_ID}.alarm_mode`;
        await adapter.stateChangeHandler!(`${adapter.namespace}.${id}`, {
            val: true,
            ack: false,
            ts: Date.now(),
            lc: Date.now(),
            from: "user",
        });

        const put = lastPut("/alarm_settings");
        expect(put, "PUT /alarm_settings issued").to.not.be.undefined;
        const body = put!.body as Record<string, unknown>;
        expect(body.alarmMode).to.equal("ON");
        expect(body.alarmDelayInSeconds, "alarmDelayInSeconds preserved").to.equal(60);
        expect(stateAck(db, adapter, id)).to.equal(true);
    });
});

// ── 6. pre_alarm ────────────────────────────────────────────────────────────

describe("roadmap pre_alarm", () => {
    it("Indoor: write true → PUT /alarm_settings {preAlarmMode:ON}, acked", async () => {
        installAxios([
            {
                match: "/alarm_settings",
                method: "get",
                status: 200,
                data: {
                    alarmMode: "OFF",
                    preAlarmMode: "OFF",
                    alarmDelayInSeconds: 60,
                    alarmActivationDelaySeconds: 30,
                    preAlarmDelayInSeconds: 20,
                },
            },
            { match: "/alarm_settings", method: "put", status: 204 },
            {
                match: "/alarmStatus",
                method: "get",
                status: 200,
                data: { intrusionSystem: "DISARMED" },
            },
            { match: "/v11/video_inputs", method: "get", status: 200, data: [CAM_INNEN] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // Seed alarm settings cache via poll
        await (adapter as unknown as { _pollAlarmSettings: (t: string, c: string) => Promise<void> })
            ._pollAlarmSettings("stored.acc", CAM_GEN2_INDOOR_ID);

        const id = `cameras.${CAM_GEN2_INDOOR_ID}.pre_alarm`;
        await adapter.stateChangeHandler!(`${adapter.namespace}.${id}`, {
            val: true,
            ack: false,
            ts: Date.now(),
            lc: Date.now(),
            from: "user",
        });

        const put = lastPut("/alarm_settings");
        expect(put, "PUT /alarm_settings issued").to.not.be.undefined;
        const body = put!.body as Record<string, unknown>;
        expect(body.preAlarmMode).to.equal("ON");
        expect(stateAck(db, adapter, id)).to.equal(true);
    });
});
