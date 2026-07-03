/**
 * v1.7.x — glass-break + smoke/fire-alarm sound detection (Gen2 Audio-Plus
 * only, featureSupport.sound). Ported from HA v14.2.0
 * BoschGlassBreakDetectionSwitch / BoschFireAlarmDetectionSwitch.
 *
 * Endpoint: GET/PUT /v11/video_inputs/{id}/audioDetectionConfig
 * Body: {detectGlassBreak: bool, detectFireAlarm: bool} — Bosch requires the
 * FULL body on every PUT (a partial PUT silently resets the omitted field).
 *
 * Methods under test (all in src/main.ts):
 *   ensureCameraObjects()          — DP creation gated on Gen2 + featureSound
 *   _pollAudioDetectionConfig()    — GET → mirror DPs + seed _audioDetectionCache
 *   _handleAudioDetectionWrite()   — GET(cache miss)/reuse(cache hit) → merge
 *                                    ONE field → PUT full body. Serialized per
 *                                    camera via _withCameraLock +
 *                                    _audioDetectionLocks so a concurrent write
 *                                    to the OTHER field can't clobber this one
 *                                    with a stale snapshot (HA v14.2.0
 *                                    bug-hunt lesson: per-camera lock +
 *                                    merge-only-own-key).
 *
 * Harness mirrors main_v110_features.spec.ts (createAdapterWithMocks + boot via
 * build/main.js, captured-request axios stub matched by URL).
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

// FAKE fixture IDs only — never real device cloud-IDs.
const CAM_GEN2_SOUND = "EFEFEFEF-1111-2222-3333-444455556666";
const CAM_GEN2_NOSOUND = "20E020E0-0000-0000-0000-000000000001";
const CAM_GEN1 = "AABBCCDD-1111-2222-3333-444455556666";

const CAM_TERRASSE_SOUND = {
    id: CAM_GEN2_SOUND,
    title: "Terrasse",
    hardwareVersion: "HOME_Eyes_Outdoor",
    firmwareVersion: "9.40.25",
    featureSupport: { light: true, sound: true },
};
const CAM_INDOOR_NOSOUND = {
    id: CAM_GEN2_NOSOUND,
    title: "Indoor II",
    hardwareVersion: "HOME_Eyes_Indoor",
    firmwareVersion: "9.40.25",
    featureSupport: { light: false, sound: false },
};
const CAM_360_GEN1 = {
    id: CAM_GEN1,
    title: "Wohnzimmer",
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

/**
 * Install axios stubs for a boot + extra per-camera endpoint matchers. The
 * `/v11/video_inputs` list matcher is appended LAST — every per-camera
 * endpoint URL (e.g. `/v11/video_inputs/{id}/audioDetectionConfig`) also
 * CONTAINS the "/v11/video_inputs" substring, so a generic matcher placed
 * first would shadow the more specific one (see main_v120_management_reads
 * .spec.ts). `matchers.find()` returns the first hit, so specific matchers
 * must always win.
 */
function installBoot(cameras: unknown[], extra: Matcher[] = []): void {
    installAxios([
        ...extra,
        { match: "/v11/video_inputs", method: "get", status: 200, data: cameras },
    ]);
}

function callsTo(urlFragment: string, method: string): CapturedRequest[] {
    return captured.filter((r) => r.method === method && r.url.includes(urlFragment));
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
        camId: CAM_GEN2_SOUND,
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

async function writeState(adapter: TestAdapter, id: string, val: unknown): Promise<void> {
    await adapter.stateChangeHandler!(`${adapter.namespace}.${id}`, {
        val,
        ack: false,
        ts: Date.now(),
        lc: Date.now(),
        from: "user",
    });
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

// ── DP object creation gating ────────────────────────────────────────────────

describe("v1.7.x glass_break_detection / fire_alarm_detection DP gating", () => {
    it("Gen2 + featureSupport.sound=true → both DPs created", async () => {
        installBoot([CAM_TERRASSE_SOUND]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const gb = await adapter.getObjectAsync(`cameras.${CAM_GEN2_SOUND}.glass_break_detection`);
        const fa = await adapter.getObjectAsync(`cameras.${CAM_GEN2_SOUND}.fire_alarm_detection`);
        expect(gb, "glass_break_detection DP must exist").to.exist;
        expect(fa, "fire_alarm_detection DP must exist").to.exist;
        expect(gb!.common.role).to.equal("switch");
        expect(gb!.common.type).to.equal("boolean");
        expect(gb!.common.read).to.equal(true);
        expect(gb!.common.write).to.equal(true);
    });

    it("Gen2 + featureSupport.sound=false → neither DP created", async () => {
        installBoot([CAM_INDOOR_NOSOUND]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const gb = await adapter.getObjectAsync(`cameras.${CAM_GEN2_NOSOUND}.glass_break_detection`);
        const fa = await adapter.getObjectAsync(`cameras.${CAM_GEN2_NOSOUND}.fire_alarm_detection`);
        expect(gb, "glass_break_detection DP must NOT exist").to.not.exist;
        expect(fa, "fire_alarm_detection DP must NOT exist").to.not.exist;
    });

    it("Gen1 (even with featureSupport.sound=true) → neither DP created (Gen2-only gate)", async () => {
        installBoot([{ ...CAM_360_GEN1, featureSupport: { sound: true } }]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const gb = await adapter.getObjectAsync(`cameras.${CAM_GEN1}.glass_break_detection`);
        const fa = await adapter.getObjectAsync(`cameras.${CAM_GEN1}.fire_alarm_detection`);
        expect(gb).to.not.exist;
        expect(fa).to.not.exist;
    });
});

// ── GET-mirror poll (_pollAudioDetectionConfig) ─────────────────────────────

describe("v1.7.x _pollAudioDetectionConfig GET-mirror", () => {
    it("200 {detectGlassBreak:true, detectFireAlarm:false} → mirrors both DPs", async () => {
        installBoot([CAM_TERRASSE_SOUND], [
            {
                match: "/audioDetectionConfig",
                method: "get",
                status: 200,
                data: { detectGlassBreak: true, detectFireAlarm: false },
            },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollAudioDetectionConfig("stored.acc", CAM_GEN2_SOUND);

        expect(stateVal(db, adapter, `cameras.${CAM_GEN2_SOUND}.glass_break_detection`)).to.equal(
            true,
        );
        expect(stateVal(db, adapter, `cameras.${CAM_GEN2_SOUND}.fire_alarm_detection`)).to.equal(
            false,
        );
    });

    it("404 → no write, no throw (DP keeps whatever the mock DB already had — undefined here)", async () => {
        installBoot([CAM_TERRASSE_SOUND], [
            { match: "/audioDetectionConfig", method: "get", status: 404 },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollAudioDetectionConfig("stored.acc", CAM_GEN2_SOUND);

        // The mock DB does not materialise `common.def` as an actual state on
        // object creation (only a real setState/upsertState call does) — a
        // 404 must be a pure no-op, so the state stays unset.
        expect(
            stateVal(db, adapter, `cameras.${CAM_GEN2_SOUND}.glass_break_detection`),
        ).to.equal(undefined);
    });

    it("443 (privacy mode) → no write, no throw", async () => {
        installBoot([CAM_TERRASSE_SOUND], [
            { match: "/audioDetectionConfig", method: "get", status: 443 },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollAudioDetectionConfig("stored.acc", CAM_GEN2_SOUND);

        expect(
            stateVal(db, adapter, `cameras.${CAM_GEN2_SOUND}.glass_break_detection`),
        ).to.equal(undefined);
        void db;
    });
});

// ── PUT-body write handler (glass_break_detection / fire_alarm_detection) ───

describe("v1.7.x glass_break_detection / fire_alarm_detection write (full-body merge)", () => {
    it("glass_break_detection ON (cache miss) → GET then PUT BOTH fields, preserving unrelated keys", async () => {
        installBoot([CAM_TERRASSE_SOUND], [
            {
                match: "/audioDetectionConfig",
                method: "get",
                status: 200,
                data: { detectGlassBreak: false, detectFireAlarm: true, someOtherField: "keep-me" },
            },
            { match: "/audioDetectionConfig", method: "put", status: 204 },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2_SOUND}.glass_break_detection`;
        await writeState(adapter, id, true);

        const put = lastPut("/audioDetectionConfig");
        expect(put, "PUT was issued").to.not.be.undefined;
        const body = put!.body as Record<string, unknown>;
        expect(body.detectGlassBreak).to.equal(true, "own field must be the NEW value");
        expect(body.detectFireAlarm).to.equal(true, "other field must be PRESERVED from GET");
        expect(body.someOtherField).to.equal("keep-me", "unrelated fields must be preserved");
        expect(stateAck(db, adapter, id)).to.equal(true);
    });

    it("fire_alarm_detection OFF (cache miss) → PUT preserves detectGlassBreak from GET", async () => {
        installBoot([CAM_TERRASSE_SOUND], [
            {
                match: "/audioDetectionConfig",
                method: "get",
                status: 200,
                data: { detectGlassBreak: true, detectFireAlarm: true },
            },
            { match: "/audioDetectionConfig", method: "put", status: 204 },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2_SOUND}.fire_alarm_detection`;
        await writeState(adapter, id, false);

        const body = lastPut("/audioDetectionConfig")!.body as Record<string, unknown>;
        expect(body.detectFireAlarm).to.equal(false);
        expect(body.detectGlassBreak).to.equal(true, "must NOT clobber the other field");
        expect(stateAck(db, adapter, id)).to.equal(true);
    });

    it("second write after a first success reuses the cache — no second GET", async () => {
        installBoot([CAM_TERRASSE_SOUND], [
            {
                match: "/audioDetectionConfig",
                method: "get",
                status: 200,
                data: { detectGlassBreak: false, detectFireAlarm: false },
            },
            { match: "/audioDetectionConfig", method: "put", status: 204 },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        await writeState(adapter, `cameras.${CAM_GEN2_SOUND}.glass_break_detection`, true);
        await writeState(adapter, `cameras.${CAM_GEN2_SOUND}.fire_alarm_detection`, true);

        expect(callsTo("/audioDetectionConfig", "get")).to.have.lengthOf(
            1,
            "only the FIRST write should GET — the second must reuse the cache",
        );
        const finalPut = lastPut("/audioDetectionConfig")!.body as Record<string, unknown>;
        expect(finalPut.detectGlassBreak).to.equal(true, "first write's field must survive");
        expect(finalPut.detectFireAlarm).to.equal(true, "second write's own field");
        void db;
    });

    it("Gen1: write ignored — no HTTP call, not acked", async () => {
        installBoot([CAM_360_GEN1]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN1}.glass_break_detection`;
        await writeState(adapter, id, true);

        expect(callsTo("/audioDetectionConfig", "get")).to.have.lengthOf(0);
        expect(callsTo("/audioDetectionConfig", "put")).to.have.lengthOf(0);
        expect(stateAck(db, adapter, id)).to.not.equal(true);
    });

    it("Gen2 without featureSupport.sound: write ignored — no HTTP call, not acked", async () => {
        installBoot([CAM_INDOOR_NOSOUND]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        // DP was never created (gated on featureSound), so simulate an
        // external/legacy state write straight at the handler.
        const id = `cameras.${CAM_GEN2_NOSOUND}.glass_break_detection`;
        await writeState(adapter, id, true);

        expect(callsTo("/audioDetectionConfig", "put")).to.have.lengthOf(0);
        expect(stateAck(db, adapter, id)).to.not.equal(true);
    });
});

// ── privacy-mode (HTTP 443) rejection ───────────────────────────────────────

describe("v1.7.x audio-detection write rejected in privacy mode (443)", () => {
    it("GET-time 443 (cache miss) → write skipped, not acked, no PUT issued", async () => {
        installBoot([CAM_TERRASSE_SOUND], [
            { match: "/audioDetectionConfig", method: "get", status: 443 },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2_SOUND}.glass_break_detection`;
        await writeState(adapter, id, true);

        expect(callsTo("/audioDetectionConfig", "put")).to.have.lengthOf(
            0,
            "must not attempt PUT after a 443 GET",
        );
        expect(stateAck(db, adapter, id)).to.not.equal(true);
    });

    it("PUT-time 443 (cache pre-seeded, privacy turned on mid-session) → not acked", async () => {
        installBoot([CAM_TERRASSE_SOUND], [
            {
                match: "/audioDetectionConfig",
                method: "get",
                status: 200,
                data: { detectGlassBreak: false, detectFireAlarm: false },
            },
            { match: "/audioDetectionConfig", method: "put", status: 443 },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2_SOUND}.fire_alarm_detection`;
        await writeState(adapter, id, true);

        expect(stateAck(db, adapter, id)).to.not.equal(
            true,
            "443 on PUT must not ack the optimistic write",
        );
    });
});

// ── concurrent-write lock / merge-only-own-field ────────────────────────────
// Regression test for the HA v14.2.0 bug-hunt lesson: two independent DPs
// (glass_break_detection + fire_alarm_detection) sharing ONE cache-backed
// endpoint MUST serialize their GET→merge→PUT via a per-camera lock, or a
// concurrent toggle of field B (built from a stale snapshot taken before
// field A's write completed) clobbers field A back to its old value.

describe("v1.7.x concurrent glass_break_detection + fire_alarm_detection toggle (lock/merge)", () => {
    it("both fields toggled ON near-simultaneously → BOTH end up true (no lost update)", async () => {
        installBoot([CAM_TERRASSE_SOUND], [
            {
                match: "/audioDetectionConfig",
                method: "get",
                status: 200,
                data: { detectGlassBreak: false, detectFireAlarm: false },
            },
            { match: "/audioDetectionConfig", method: "put", status: 204 },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const gbId = `cameras.${CAM_GEN2_SOUND}.glass_break_detection`;
        const faId = `cameras.${CAM_GEN2_SOUND}.fire_alarm_detection`;

        // Fire BOTH writes without awaiting the first — this is the race
        // window: without a per-camera lock, both handlers would read the
        // SAME empty cache concurrently and the later PUT would win with a
        // body missing the earlier write's field.
        await Promise.all([writeState(adapter, gbId, true), writeState(adapter, faId, true)]);

        // The lock must have serialized the two GET→merge→PUT cycles onto
        // the SAME cache lineage: exactly one GET (the second write reuses
        // the cache seeded by the first), and the final PUT body carries
        // BOTH fields as true.
        expect(callsTo("/audioDetectionConfig", "get")).to.have.lengthOf(
            1,
            "lock must force the second write to reuse the first write's cache, not re-GET",
        );
        const finalPut = lastPut("/audioDetectionConfig")!.body as Record<string, unknown>;
        expect(finalPut.detectGlassBreak).to.equal(
            true,
            "glass-break write must survive the concurrent fire-alarm write",
        );
        expect(finalPut.detectFireAlarm).to.equal(true);

        // Both DPs must be acked true — neither write silently lost.
        expect(stateAck(db, adapter, gbId)).to.equal(true);
        expect(stateAck(db, adapter, faId)).to.equal(true);
        expect(stateVal(db, adapter, gbId)).to.equal(true);
        expect(stateVal(db, adapter, faId)).to.equal(true);
    });

    it("toggle glass_break ON then (concurrently) fire_alarm OFF → glass_break stays true", async () => {
        installBoot([CAM_TERRASSE_SOUND], [
            {
                match: "/audioDetectionConfig",
                method: "get",
                status: 200,
                data: { detectGlassBreak: false, detectFireAlarm: true },
            },
            { match: "/audioDetectionConfig", method: "put", status: 204 },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const gbId = `cameras.${CAM_GEN2_SOUND}.glass_break_detection`;
        const faId = `cameras.${CAM_GEN2_SOUND}.fire_alarm_detection`;

        await Promise.all([writeState(adapter, gbId, true), writeState(adapter, faId, false)]);

        const finalPut = lastPut("/audioDetectionConfig")!.body as Record<string, unknown>;
        expect(finalPut.detectGlassBreak).to.equal(true);
        expect(finalPut.detectFireAlarm).to.equal(false);
        expect(stateVal(db, adapter, gbId)).to.equal(true);
        expect(stateVal(db, adapter, faId)).to.equal(false);
    });
});
