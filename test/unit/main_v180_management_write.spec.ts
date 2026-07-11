/**
 * v1.8.0 — cloud-API WRITE for the management tier (motion zones, privacy
 * masks, automation rules, camera sharing/friends) + firmware install
 * trigger. Ported from HA services.py (set_motion_zones/set_privacy_masks/
 * create_rule/update_rule/delete_rule/share_camera/invite_friend/
 * remove_friend) and __init__.py async_install_firmware (v14.4.10) — same
 * /v11 endpoints, same field names, cross-verified against the Python CLI.
 *
 * This is the CLOUD write path only — the on-device RCP zone/mask editor
 * stays parked until Bosch's permanent local user (summer 2026).
 *
 * Methods under test (all in src/main.ts):
 *   _handleMotionZonesWrite / _handlePrivacyMasksWrite  — POST array body
 *   _handleRuleCreate / _handleRuleUpdate / _handleRuleDelete
 *   _handleCameraShare / _handleFriendInvite / _handleFriendRemove
 *   _pollFirmwareStatus / _handleFirmwareInstall
 *
 * Harness mirrors main_audio_detection.spec.ts (createAdapterWithMocks +
 * boot via build/main.js, captured-request axios stub matched by URL).
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
const CAM_GEN2 = "EFEFEFEF-1111-2222-3333-444455556666";
const CAM_GEN1 = "AABBCCDD-1111-2222-3333-444455556666";
const FRIEND_ID = "99887766-5544-3322-1100-aabbccddeeff";

const CAM_TERRASSE_GEN2 = {
    id: CAM_GEN2,
    title: "Terrasse",
    hardwareVersion: "HOME_Eyes_Outdoor",
    firmwareVersion: "9.40.104",
    featureSupport: { light: true, sound: true },
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

function lastReq(urlFragment: string, method: string): CapturedRequest | undefined {
    return [...captured]
        .reverse()
        .find((r) => r.method === method && r.url.includes(urlFragment));
}

function callsTo(urlFragment: string, method: string): CapturedRequest[] {
    return captured.filter((r) => r.method === method && r.url.includes(urlFragment));
}

function installBoot(cameras: unknown[], extra: Matcher[] = []): void {
    installAxios([
        ...extra,
        { match: "/v11/video_inputs", method: "get", status: 200, data: cameras },
    ]);
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

// ── DP object creation ───────────────────────────────────────────────────────

describe("v1.8.0 management-write DP gating", () => {
    it("all cameras: motion_zones_set/privacy_masks_set/rule_create/rule_update/rule_delete + firmware DPs exist", async () => {
        installBoot([CAM_360_GEN1]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        for (const dp of [
            "motion_zones_set",
            "privacy_masks_set",
            "rule_create",
            "rule_update",
            "rule_delete",
            "firmware_current_version",
            "firmware_latest_version",
            "firmware_update_available",
            "firmware_updating",
            "firmware_install",
        ]) {
            const obj = await adapter.getObjectAsync(`cameras.${CAM_GEN1}.${dp}`);
            expect(obj, `${dp} DP must exist`).to.exist;
        }
        const btn = await adapter.getObjectAsync(`cameras.${CAM_GEN1}.firmware_install`);
        expect(btn!.common.role).to.equal("button");
        expect(btn!.common.write).to.equal(true);
        expect(btn!.common.read).to.equal(false);
    });

    it("Gen2 only: camera_share/friend_invite/friend_remove exist for Gen2, NOT Gen1", async () => {
        installBoot([CAM_TERRASSE_GEN2, CAM_360_GEN1]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        for (const dp of ["camera_share", "friend_invite", "friend_remove"]) {
            expect(await adapter.getObjectAsync(`cameras.${CAM_GEN2}.${dp}`), `Gen2 ${dp}`).to
                .exist;
            expect(await adapter.getObjectAsync(`cameras.${CAM_GEN1}.${dp}`), `Gen1 ${dp}`).to.not
                .exist;
        }
    });
});

// ── motion_zones_set / privacy_masks_set ─────────────────────────────────────

describe("v1.8.0 motion_zones_set / privacy_masks_set write", () => {
    it("valid JSON array → POST motion_sensitive_areas, acked, mirrors motion_zones/_count", async () => {
        installBoot([CAM_TERRASSE_GEN2], [
            { match: "/motion_sensitive_areas", method: "post", status: 204 },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2}.motion_zones_set`;
        const zones = [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }];
        await writeState(adapter, id, JSON.stringify(zones));

        const post = lastReq("/motion_sensitive_areas", "post");
        expect(post, "POST issued").to.not.be.undefined;
        expect(post!.body).to.deep.equal(zones);
        expect(stateAck(db, adapter, id)).to.equal(true);
        expect(stateVal(db, adapter, `cameras.${CAM_GEN2}.motion_zones_count`)).to.equal(1);
        expect(stateVal(db, adapter, `cameras.${CAM_GEN2}.motion_zones`)).to.equal(
            JSON.stringify(zones),
        );
    });

    it("empty array [] clears all zones — POST with [], acked", async () => {
        installBoot([CAM_TERRASSE_GEN2], [
            { match: "/motion_sensitive_areas", method: "post", status: 204 },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2}.motion_zones_set`;
        await writeState(adapter, id, "[]");

        expect(lastReq("/motion_sensitive_areas", "post")!.body).to.deep.equal([]);
        expect(stateAck(db, adapter, id)).to.equal(true);
        expect(stateVal(db, adapter, `cameras.${CAM_GEN2}.motion_zones_count`)).to.equal(0);
    });

    it("invalid JSON → no POST, not acked", async () => {
        installBoot([CAM_TERRASSE_GEN2]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2}.motion_zones_set`;
        await writeState(adapter, id, "{not json");

        expect(callsTo("/motion_sensitive_areas", "post")).to.have.lengthOf(0);
        expect(stateAck(db, adapter, id)).to.not.equal(true);
    });

    it("out-of-range field (w=1.5) → rejected, no POST, not acked", async () => {
        installBoot([CAM_TERRASSE_GEN2]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2}.motion_zones_set`;
        await writeState(adapter, id, JSON.stringify([{ x: 0, y: 0, w: 1.5, h: 0.1 }]));

        expect(callsTo("/motion_sensitive_areas", "post")).to.have.lengthOf(0);
        expect(stateAck(db, adapter, id)).to.not.equal(true);
    });

    it("not an array (plain object) → rejected, no POST, not acked", async () => {
        installBoot([CAM_TERRASSE_GEN2]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2}.motion_zones_set`;
        await writeState(adapter, id, JSON.stringify({ x: 0.1 }));

        expect(callsTo("/motion_sensitive_areas", "post")).to.have.lengthOf(0);
        expect(stateAck(db, adapter, id)).to.not.equal(true);
    });

    it("HTTP 443 (privacy mode) → rejected, not acked", async () => {
        installBoot([CAM_TERRASSE_GEN2], [
            { match: "/motion_sensitive_areas", method: "post", status: 443 },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2}.motion_zones_set`;
        await writeState(adapter, id, JSON.stringify([{ x: 0, y: 0, w: 0.1, h: 0.1 }]));

        expect(stateAck(db, adapter, id)).to.not.equal(true);
    });

    it("privacy_masks_set: valid array → POST /privacy_masks, mirrors privacy_masks/_count", async () => {
        installBoot([CAM_TERRASSE_GEN2], [
            { match: "/privacy_masks", method: "post", status: 200 },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2}.privacy_masks_set`;
        const masks = [
            { x: 0, y: 0, w: 0.5, h: 0.5 },
            { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
        ];
        await writeState(adapter, id, JSON.stringify(masks));

        expect(lastReq("/privacy_masks", "post")!.body).to.deep.equal(masks);
        expect(stateAck(db, adapter, id)).to.equal(true);
        expect(stateVal(db, adapter, `cameras.${CAM_GEN2}.privacy_masks_count`)).to.equal(2);
    });
});

// ── rule_create / rule_update / rule_delete ──────────────────────────────────

describe("v1.8.0 rule_create / rule_update / rule_delete write", () => {
    it("rule_create: valid body → POST /rules with id:null + refreshes rules list", async () => {
        installBoot([CAM_TERRASSE_GEN2], [
            { match: "/rules", method: "post", status: 201 },
            { match: "/rules", method: "get", status: 200, data: [{ id: "r1" }] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2}.rule_create`;
        const req = {
            name: "Night watch",
            isActive: true,
            startTime: "22:00:00",
            endTime: "06:00:00",
            weekdays: [0, 1, 2, 3, 4, 5, 6],
        };
        await writeState(adapter, id, JSON.stringify(req));

        const post = lastReq("/rules", "post");
        expect(post!.body).to.deep.equal({ id: null, ...req });
        expect(stateAck(db, adapter, id)).to.equal(true);
    });

    it("rule_create: missing required field → rejected, no POST, not acked", async () => {
        installBoot([CAM_TERRASSE_GEN2]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2}.rule_create`;
        await writeState(adapter, id, JSON.stringify({ name: "Incomplete" }));

        expect(callsTo("/rules", "post")).to.have.lengthOf(0);
        expect(stateAck(db, adapter, id)).to.not.equal(true);
    });

    it("rule_create: invalid JSON → rejected, not acked", async () => {
        installBoot([CAM_TERRASSE_GEN2]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2}.rule_create`;
        await writeState(adapter, id, "not json");

        expect(stateAck(db, adapter, id)).to.not.equal(true);
    });

    it("rule_update: GETs list, merges changed fields onto matching rule, PUTs full body", async () => {
        installBoot([CAM_TERRASSE_GEN2], [
            {
                match: "/rules",
                method: "get",
                status: 200,
                data: [
                    {
                        id: "r1",
                        name: "Old name",
                        isActive: true,
                        startTime: "08:00:00",
                        endTime: "18:00:00",
                        weekdays: [1, 2, 3],
                    },
                ],
            },
            { match: "/rules/r1", method: "put", status: 200 },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2}.rule_update`;
        await writeState(adapter, id, JSON.stringify({ id: "r1", isActive: false }));

        const put = lastReq("/rules/r1", "put");
        expect(put, "PUT issued to /rules/r1").to.not.be.undefined;
        const body = put!.body as Record<string, unknown>;
        expect(body.isActive).to.equal(false, "changed field applied");
        expect(body.name).to.equal("Old name", "unrelated fields preserved from GET");
        expect(body.startTime).to.equal("08:00:00");
        expect(stateAck(db, adapter, id)).to.equal(true);
    });

    it("rule_update: unknown rule id → rejected, no PUT, not acked", async () => {
        installBoot([CAM_TERRASSE_GEN2], [
            { match: "/rules", method: "get", status: 200, data: [{ id: "r1" }] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2}.rule_update`;
        await writeState(adapter, id, JSON.stringify({ id: "does-not-exist", isActive: false }));

        expect(callsTo("/rules/does-not-exist", "put")).to.have.lengthOf(0);
        expect(stateAck(db, adapter, id)).to.not.equal(true);
    });

    it("rule_update: missing id field → rejected, no GET, not acked", async () => {
        installBoot([CAM_TERRASSE_GEN2]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2}.rule_update`;
        await writeState(adapter, id, JSON.stringify({ isActive: false }));

        expect(stateAck(db, adapter, id)).to.not.equal(true);
    });

    it("rule_delete: DELETE /rules/{id}, acked", async () => {
        installBoot([CAM_TERRASSE_GEN2], [
            { match: "/rules/r42", method: "delete", status: 204 },
            { match: "/rules", method: "get", status: 200, data: [] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2}.rule_delete`;
        await writeState(adapter, id, "r42");

        expect(callsTo("/rules/r42", "delete")).to.have.lengthOf(1);
        expect(stateAck(db, adapter, id)).to.equal(true);
    });

    it("rule_delete: empty string → rejected, no DELETE, not acked", async () => {
        installBoot([CAM_TERRASSE_GEN2]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2}.rule_delete`;
        await writeState(adapter, id, "");

        expect(callsTo("/rules", "delete")).to.have.lengthOf(0);
        expect(stateAck(db, adapter, id)).to.not.equal(true);
    });

    it("rule_delete: HTTP 404 (already gone) → not acked", async () => {
        installBoot([CAM_TERRASSE_GEN2], [
            { match: "/rules/gone", method: "delete", status: 404 },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2}.rule_delete`;
        await writeState(adapter, id, "gone");

        expect(stateAck(db, adapter, id)).to.not.equal(true);
    });
});

// ── camera_share / friend_invite / friend_remove ─────────────────────────────

describe("v1.8.0 camera_share / friend_invite / friend_remove write (Gen2 only)", () => {
    it("camera_share with days → PUT /friends/{id}/share with shareTime window", async () => {
        installBoot([CAM_TERRASSE_GEN2], [
            { match: `/friends/${FRIEND_ID}/share`, method: "put", status: 200 },
            { match: "/shared_with_friends", method: "get", status: 200, data: [] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2}.camera_share`;
        await writeState(adapter, id, JSON.stringify({ friendId: FRIEND_ID, days: 30 }));

        const put = lastReq(`/friends/${FRIEND_ID}/share`, "put");
        expect(put, "PUT issued").to.not.be.undefined;
        const body = put!.body as Array<Record<string, unknown>>;
        expect(body).to.have.lengthOf(1);
        expect(body[0].videoInputId).to.equal(CAM_GEN2);
        expect(body[0].shareTime).to.exist;
        expect(stateAck(db, adapter, id)).to.equal(true);
    });

    it("camera_share without days → PUT with no shareTime (indefinite)", async () => {
        installBoot([CAM_TERRASSE_GEN2], [
            { match: `/friends/${FRIEND_ID}/share`, method: "put", status: 200 },
            { match: "/shared_with_friends", method: "get", status: 200, data: [] },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2}.camera_share`;
        await writeState(adapter, id, JSON.stringify({ friendId: FRIEND_ID }));

        const body = lastReq(`/friends/${FRIEND_ID}/share`, "put")!.body as Array<
            Record<string, unknown>
        >;
        expect(body[0].shareTime).to.be.undefined;
        expect(stateAck(db, adapter, id)).to.equal(true);
    });

    it("camera_share: missing friendId → rejected, no PUT, not acked", async () => {
        installBoot([CAM_TERRASSE_GEN2]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2}.camera_share`;
        await writeState(adapter, id, JSON.stringify({ days: 30 }));

        expect(callsTo("/friends/", "put")).to.have.lengthOf(0);
        expect(stateAck(db, adapter, id)).to.not.equal(true);
    });

    it("camera_share: Gen1 camera → ignored (Gen2-only gate)", async () => {
        installBoot([CAM_360_GEN1]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN1}.camera_share`;
        await writeState(adapter, id, JSON.stringify({ friendId: FRIEND_ID }));

        expect(callsTo("/friends/", "put")).to.have.lengthOf(0);
        expect(stateAck(db, adapter, id)).to.not.equal(true);
    });

    // Bug-hunt round 1 finding: camera_share was the only sibling handler in
    // this diff missing an explicit privacy-mode (443) case.
    it("camera_share: HTTP 443 (privacy mode) → rejected, not acked", async () => {
        installBoot([CAM_TERRASSE_GEN2], [
            { match: `/friends/${FRIEND_ID}/share`, method: "put", status: 443 },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2}.camera_share`;
        await writeState(adapter, id, JSON.stringify({ friendId: FRIEND_ID }));

        expect(stateAck(db, adapter, id)).to.not.equal(true);
    });

    it("friend_invite: valid email → POST /v11/friends {invitationEmail,nickName}, acked", async () => {
        installBoot([CAM_TERRASSE_GEN2], [
            { match: "/v11/friends", method: "post", status: 201 },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2}.friend_invite`;
        await writeState(adapter, id, "friend@example.invalid");

        const post = lastReq("/v11/friends", "post");
        expect(post!.body).to.deep.equal({
            invitationEmail: "friend@example.invalid",
            nickName: "friend@example.invalid",
        });
        expect(stateAck(db, adapter, id)).to.equal(true);
    });

    it("friend_invite: not an email → rejected, no POST, not acked", async () => {
        installBoot([CAM_TERRASSE_GEN2]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2}.friend_invite`;
        await writeState(adapter, id, "not-an-email");

        expect(callsTo("/v11/friends", "post")).to.have.lengthOf(0);
        expect(stateAck(db, adapter, id)).to.not.equal(true);
    });

    it("friend_remove: DELETE /v11/friends/{id}, acked", async () => {
        installBoot([CAM_TERRASSE_GEN2], [
            { match: `/v11/friends/${FRIEND_ID}`, method: "delete", status: 200 },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2}.friend_remove`;
        await writeState(adapter, id, FRIEND_ID);

        expect(callsTo(`/v11/friends/${FRIEND_ID}`, "delete")).to.have.lengthOf(1);
        expect(stateAck(db, adapter, id)).to.equal(true);
    });

    it("friend_remove: HTTP 404 → not acked", async () => {
        installBoot([CAM_TERRASSE_GEN2], [
            { match: `/v11/friends/${FRIEND_ID}`, method: "delete", status: 404 },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2}.friend_remove`;
        await writeState(adapter, id, FRIEND_ID);

        expect(stateAck(db, adapter, id)).to.not.equal(true);
    });
});

// ── firmware status poll + install trigger ───────────────────────────────────

describe("v1.8.0 firmware status poll (_pollFirmwareStatus)", () => {
    it("200 {current,update,upToDate:false,updating:false} → mirrors all 4 DPs", async () => {
        installBoot([CAM_TERRASSE_GEN2], [
            {
                match: "/firmware",
                method: "get",
                status: 200,
                data: { current: "9.40.102", update: "9.40.104", upToDate: false, updating: false },
            },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollFirmwareStatus("stored.acc", CAM_GEN2);

        expect(stateVal(db, adapter, `cameras.${CAM_GEN2}.firmware_current_version`)).to.equal(
            "9.40.102",
        );
        expect(stateVal(db, adapter, `cameras.${CAM_GEN2}.firmware_latest_version`)).to.equal(
            "9.40.104",
        );
        expect(stateVal(db, adapter, `cameras.${CAM_GEN2}.firmware_update_available`)).to.equal(
            true,
        );
        expect(stateVal(db, adapter, `cameras.${CAM_GEN2}.firmware_updating`)).to.equal(false);
    });

    it("upToDate:true → firmware_update_available=false, latest mirrors current", async () => {
        installBoot([CAM_TERRASSE_GEN2], [
            {
                match: "/firmware",
                method: "get",
                status: 200,
                data: { current: "9.40.104", upToDate: true, updating: false },
            },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollFirmwareStatus("stored.acc", CAM_GEN2);

        expect(stateVal(db, adapter, `cameras.${CAM_GEN2}.firmware_update_available`)).to.equal(
            false,
        );
        expect(stateVal(db, adapter, `cameras.${CAM_GEN2}.firmware_latest_version`)).to.equal(
            "9.40.104",
        );
    });

    it("404 → no write, no throw", async () => {
        installBoot([CAM_TERRASSE_GEN2], [{ match: "/firmware", method: "get", status: 404 }]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollFirmwareStatus("stored.acc", CAM_GEN2);

        expect(stateVal(db, adapter, `cameras.${CAM_GEN2}.firmware_current_version`)).to.equal(
            undefined,
        );
    });

    it("network error → swallowed, no throw", async () => {
        installBoot([CAM_TERRASSE_GEN2]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // Override adapter to throw for this specific call.
        axios.defaults.adapter = () => Promise.reject(new Error("ECONNRESET"));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollFirmwareStatus("stored.acc", CAM_GEN2);
        void db;
    });
});

describe("v1.8.0 firmware_install write (button pattern, HA v14.4.10 guard parity)", () => {
    it("update available + not updating → PUT /firmware {id:target}, updating flips true, button resets false", async () => {
        installBoot([CAM_TERRASSE_GEN2], [
            {
                match: "/firmware",
                method: "get",
                status: 200,
                data: { current: "9.40.102", update: "9.40.104", upToDate: false, updating: false },
            },
            { match: "/firmware", method: "put", status: 200 },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollFirmwareStatus("stored.acc", CAM_GEN2);

        const id = `cameras.${CAM_GEN2}.firmware_install`;
        await writeState(adapter, id, true);

        const put = lastReq("/firmware", "put");
        expect(put, "PUT issued").to.not.be.undefined;
        expect(put!.body).to.deep.equal({ id: "9.40.104" });
        expect(stateVal(db, adapter, `cameras.${CAM_GEN2}.firmware_updating`)).to.equal(true);
        // Button pattern: DP itself resets to false + acked.
        expect(stateVal(db, adapter, id)).to.equal(false);
        expect(stateAck(db, adapter, id)).to.equal(true);
    });

    it("guard 1: already updating=true → no PUT fired", async () => {
        installBoot([CAM_TERRASSE_GEN2], [
            {
                match: "/firmware",
                method: "get",
                status: 200,
                data: { current: "9.40.102", update: "9.40.104", upToDate: false, updating: true },
            },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollFirmwareStatus("stored.acc", CAM_GEN2);

        const id = `cameras.${CAM_GEN2}.firmware_install`;
        await writeState(adapter, id, true);

        expect(callsTo("/firmware", "put")).to.have.lengthOf(0);
        void db;
    });

    it("guard 2: no update target cached → no PUT fired", async () => {
        installBoot([CAM_TERRASSE_GEN2], [
            {
                match: "/firmware",
                method: "get",
                status: 200,
                data: { current: "9.40.104", upToDate: true, updating: false },
            },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollFirmwareStatus("stored.acc", CAM_GEN2);

        const id = `cameras.${CAM_GEN2}.firmware_install`;
        await writeState(adapter, id, true);

        expect(callsTo("/firmware", "put")).to.have.lengthOf(0);
        void db;
    });

    it("no cache seeded at all (no prior poll) → no PUT fired, no throw", async () => {
        installBoot([CAM_TERRASSE_GEN2]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);

        const id = `cameras.${CAM_GEN2}.firmware_install`;
        await writeState(adapter, id, true);

        expect(callsTo("/firmware", "put")).to.have.lengthOf(0);
        void db;
    });

    it("writing false is a no-op (button pattern ignores falsy writes)", async () => {
        installBoot([CAM_TERRASSE_GEN2], [
            {
                match: "/firmware",
                method: "get",
                status: 200,
                data: { current: "9.40.102", update: "9.40.104", upToDate: false, updating: false },
            },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollFirmwareStatus("stored.acc", CAM_GEN2);

        await writeState(adapter, `cameras.${CAM_GEN2}.firmware_install`, false);

        expect(callsTo("/firmware", "put")).to.have.lengthOf(0);
        void db;
    });

    it("double-press race: two concurrent triggers → only ONE PUT fires (write-lock)", async () => {
        installBoot([CAM_TERRASSE_GEN2], [
            {
                match: "/firmware",
                method: "get",
                status: 200,
                data: { current: "9.40.102", update: "9.40.104", upToDate: false, updating: false },
            },
            { match: "/firmware", method: "put", status: 200 },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollFirmwareStatus("stored.acc", CAM_GEN2);

        const id = `cameras.${CAM_GEN2}.firmware_install`;
        await Promise.all([writeState(adapter, id, true), writeState(adapter, id, true)]);

        // Lock serializes: 2nd call sees updating=true (set by 1st) → guard 1 blocks it.
        expect(callsTo("/firmware", "put")).to.have.lengthOf(1);
        void db;
    });

    // Bug-hunt round 1 finding: PUT-rejected-by-cloud path had no test, and
    // the button used to reset+ack unconditionally even on failure. Both
    // fixed same round — this test pins both together.
    it("Bosch cloud rejects the PUT (HTTP 400) → button NOT reset/acked, firmware_updating stays false", async () => {
        installBoot([CAM_TERRASSE_GEN2], [
            {
                match: "/firmware",
                method: "get",
                status: 200,
                data: { current: "9.40.102", update: "9.40.104", upToDate: false, updating: false },
            },
            { match: "/firmware", method: "put", status: 400 },
        ]);
        const { db, adapter } = createAdapterWithMocks();
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollFirmwareStatus("stored.acc", CAM_GEN2);

        const id = `cameras.${CAM_GEN2}.firmware_install`;
        await writeState(adapter, id, true);

        expect(callsTo("/firmware", "put")).to.have.lengthOf(1, "PUT was attempted");
        expect(
            stateVal(db, adapter, `cameras.${CAM_GEN2}.firmware_updating`),
        ).to.not.equal(true, "must NOT optimistically flip updating on a rejected PUT");
        expect(
            stateAck(db, adapter, id),
            "button must NOT be acked on a failed install — failure must be DP-visible, not just logged",
        ).to.not.equal(true);
    });
});
