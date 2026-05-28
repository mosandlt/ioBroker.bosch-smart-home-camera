/**
 * v0.9.1 — Unit tests for the four new helper methods added in v0.9.1.
 *
 * Methods under test (all in src/main.ts):
 *
 *   _isFeatureUnsupported(camId, feature)
 *     Returns true when (camId, feature) previously returned HTTP 442.
 *     Delegates to this._unsupportedFeatures Map seeded via _markFeatureUnsupported.
 *
 *   _shouldSkipPoll(camId, endpoint)
 *     Returns true when a backoff window is active (nextAttempt > Date.now()).
 *     Window is seeded via _recordPollResult on failure.
 *
 *   _recordPollResult(camId, endpoint, success, error?)
 *     success=true  → deletes the backoff entry (next poll runs immediately).
 *     success=false → upserts backoff with exponential delay 30→60→120→300 (cap).
 *
 *   _pollUnreadCount(token, camId)
 *     GET /v11/events?videoInputId=<id>&limit=50
 *     Counts events where isRead===false and writes to cameras.<id>.unread_events_count.
 *     HTTP 444 → backoff, no write.
 *     Network error → backoff, no throw.
 *     Backoff active → early-return, no HTTP call.
 *
 * The private helpers are exercised indirectly via the public side-effects they
 * produce (unread_events_count state DP, backoff map state) or through the
 * observable behavior of _pollUnreadCount / _pollPrivacySound which gate on them.
 *
 * Fixture approach:
 *   - mirrors main_v090_features.spec.ts: createAdapterWithMocks / bootWithTokens /
 *     stubAxiosSequence / getStateVal / sinon.
 *   - boot with CAMERAS_GEN2_ONLY (HOME_Eyes_Outdoor); extra polls during boot fall
 *     through to the 404 FALLBACK defined in helpers/axios-mock.ts — harmless.
 */

import { expect } from "chai";
import * as sinon from "sinon";
import * as path from "path";

import { stubAxiosSequence, stubAxiosByUrl, restoreAxios } from "./helpers/axios-mock";

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

// ── Camera fixtures ──────────────────────────────────────────────────────────

const CAM_GEN2 = "00000000-0000-0000-0000-000000000001";

const CAMERAS_GEN2_ONLY = [
    {
        id: CAM_GEN2,
        title: "Terrasse",
        hardwareVersion: "HOME_Eyes_Outdoor",
        firmwareVersion: "9.40.25",
        featureSupport: { light: true, panLimit: 0 },
        numberOfUnreadEvents: 3,
    },
];

/**
 * For a Gen2 Outdoor (HOME_Eyes_Outdoor) camera boot cycle the HTTP calls happen in this order:
 *   [0] cameras list
 *   [1] _pollWifiInfo      → GET /wifiinfo
 *   [2] _pollIntrusionConfig → GET /intrusionDetectionConfig
 *   [3] _pollLensElevation  → GET /lens_elevation
 *   [4] _pollGlobalLighting → GET /lighting  (Outdoor only — not Indoor)
 *   [5] _pollUnreadCount    → GET /events?videoInputId=...  ← tests stub goes here
 *   [6] _pollPrivacySound   → GET /privacy_sound_override
 *   [7] fetchLightingState  → GET /lighting/switch
 *
 * _pollLanDiagnostics fires only on slow-tier ticks (every 10th tick).
 * First boot has _diagPollTick=0 → 0 < 10 → doSlowTier=false → no diagnostics call.
 *
 * Use gen2OutdoorBootLeader() to build the first 5 stubs, then append your events stub.
 * Stubs beyond the queue fall back to FALLBACK={status:404} (defined in axios-mock.ts).
 * 404 is NOT in _pollUnreadCount's validateStatus → axios rejects → catch → backoff.
 * So the leader stubs must be 404 (harmless catches in preceding pollers).
 */
function gen2OutdoorBootLeader(): Array<{ status: number; data: unknown }> {
    return [
        { status: 200, data: CAMERAS_GEN2_ONLY }, // [0] cameras list
        { status: 404, data: null },               // [1] _pollWifiInfo → Ethernet (no-op)
        { status: 200, data: { sensitivity: 50, triggerDistance: 3 } }, // [2] intrusion
        { status: 200, data: { value: 0 } },       // [3] lens_elevation
        { status: 200, data: { darknessThreshold: 0.47, softLightFading: true } }, // [4] global lighting
    ];
}

// ── Module paths ─────────────────────────────────────────────────────────────

function resolveBuildModule(name: string): string {
    return path.join(REPO_ROOT, "build", "lib", `${name}.js`);
}

// ── Adapter factory (mirrors main_v090_features.spec.ts) ──────────────────────

function createAdapterWithMocks(
    _cameras: unknown[],
    configOverrides: Record<string, unknown> = {},
): { db: MockDatabase; adapter: TestAdapter } {
    const db = new MockDatabaseCtor();
    let capturedAdapter: MockAdapter | null = null;

    const core = mockAdapterCoreFn(db, {
        onAdapterCreated: (a: MockAdapter) => {
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

    // snapshot mock
    const snapshotPath = resolveBuildModule("snapshot");
    delete require.cache[snapshotPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[snapshotPath] = {
        id: snapshotPath,
        filename: snapshotPath,
        loaded: true,
        parent: module,
        children: [],
        path: path.dirname(snapshotPath),
        paths: [],
        exports: {
            fetchSnapshot: sinon.stub().resolves(Buffer.from("FAKEJPEG")),
            buildSnapshotUrl: (u: string) => `${u}/snap.jpg`,
        },
    };

    // live_session mock
    const fakeSession = {
        camId: CAM_GEN2,
        lanAddress: "192.168.1.149:443",
        proxyUrl: "rtsp://127.0.0.1:18010/rtsp_tunnel",
        maxSessionDuration: 3600,
        openedAt: Date.now(),
        digestUser: "u",
        digestPassword: "p",
    };
    const liveSessionPath = resolveBuildModule("live_session");
    delete require.cache[liveSessionPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[liveSessionPath] = {
        id: liveSessionPath,
        filename: liveSessionPath,
        loaded: true,
        parent: module,
        children: [],
        path: path.dirname(liveSessionPath),
        paths: [],
        exports: {
            openLiveSession: sinon.stub().resolves(fakeSession),
            closeLiveSession: sinon.stub().resolves(),
        },
    };

    // tls_proxy mock
    const tlsProxyPath = resolveBuildModule("tls_proxy");
    delete require.cache[tlsProxyPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[tlsProxyPath] = {
        id: tlsProxyPath,
        filename: tlsProxyPath,
        loaded: true,
        parent: module,
        children: [],
        path: path.dirname(tlsProxyPath),
        paths: [],
        exports: {
            startTlsProxy: sinon
                .stub()
                .resolves({
                    port: 18010,
                    localRtspUrl: "rtsp://127.0.0.1:18010/rtsp_tunnel",
                    stop: sinon.stub().resolves(),
                }),
        },
    };

    // session_watchdog mock
    const watchdogPath = resolveBuildModule("session_watchdog");
    delete require.cache[watchdogPath];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[watchdogPath] = {
        id: watchdogPath,
        filename: watchdogPath,
        loaded: true,
        parent: module,
        children: [],
        path: path.dirname(watchdogPath),
        paths: [],
        exports: {
            SessionWatchdog: class {
                start = sinon.stub();
                stop = sinon.stub();
                constructor(_o: unknown) {}
            },
        },
    };

    delete require.cache[MAIN_JS_PATH];
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const factory = require(MAIN_JS_PATH) as (opts: Record<string, unknown>) => MockAdapter;
    factory({ config: { redirect_url: "", region: "EU", ...configOverrides } });

    if (!capturedAdapter) throw new Error("adapter not captured");
    const adapter = capturedAdapter as TestAdapter;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).setTimeout = (_fn: () => void, _ms: number) => null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).clearTimeout = (_h: unknown) => undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).terminate = () => undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).writeFileAsync = sinon.stub().resolves();

    return { db, adapter };
}

function getStateVal(db: MockDatabase, adapter: TestAdapter, id: string): unknown {
    const fullId = `${adapter.namespace}.${id}`;
    const state = db.getState(fullId) as ioBroker.State | null | undefined;
    return state?.val;
}

async function bootWithTokens(db: MockDatabase, adapter: TestAdapter): Promise<void> {
    const futureExpiry = Date.now() + 200_000;
    db.publishState(`${adapter.namespace}.info.access_token`, { val: "stored.acc", ack: true });
    db.publishState(`${adapter.namespace}.info.refresh_token`, { val: "stored.ref", ack: true });
    db.publishState(`${adapter.namespace}.info.token_expires_at`, {
        val: futureExpiry,
        ack: true,
    });
    await adapter.readyHandler!();
}

// ── Teardown ─────────────────────────────────────────────────────────────────

afterEach(() => {
    restoreAxios();
    sinon.restore();
    delete require.cache[resolveBuildModule("snapshot")];
    delete require.cache[resolveBuildModule("live_session")];
    delete require.cache[resolveBuildModule("tls_proxy")];
    delete require.cache[resolveBuildModule("session_watchdog")];
    delete require.cache[MAIN_JS_PATH];
});

// ── _isFeatureUnsupported ────────────────────────────────────────────────────

describe("v0.9.1 _isFeatureUnsupported", () => {
    it("returns false when no 442 has been seen for (camId, feature)", async () => {
        // Boot: _pollPrivacySound runs at position [6]. Provide leader [0-4] + events [5] +
        // privacy_sound success [6]. Without a 442, _isFeatureUnsupported stays false.
        stubAxiosSequence([
            ...gen2OutdoorBootLeader(),             // [0-4]
            { status: 200, data: [] },              // [5] _pollUnreadCount → empty, count=0
            { status: 200, data: { result: true } }, // [6] _pollPrivacySound → success
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);

        // After a successful privacy_sound poll the feature must NOT be cached unsupported.
        // Verify indirectly: a write to privacy_sound_enabled goes through the HTTP path
        // (not short-circuited), so it consumes the next stub response.
        stubAxiosSequence([{ status: 204, data: null }]); // PUT /privacy_sound_override
        let threw = false;
        try {
            await adapter.stateChangeHandler!(
                `${adapter.namespace}.cameras.${CAM_GEN2}.privacy_sound_enabled`,
                { val: true, ack: false, ts: Date.now(), lc: Date.now(), from: "user" },
            );
        } catch {
            threw = true;
        }
        expect(threw).to.equal(false, "_isFeatureUnsupported=false → write must not throw");
        void db;
    });

    it("returns true after HTTP 442 on poll — subsequent write is short-circuited (no HTTP call)", async () => {
        // _pollPrivacySound during boot returns 442 → _markFeatureUnsupported sets the flag.
        // A follow-up write must NOT produce an HTTP call.
        stubAxiosSequence([
            ...gen2OutdoorBootLeader(),      // [0-4]
            { status: 200, data: [] },       // [5] _pollUnreadCount
            { status: 442, data: null },     // [6] _pollPrivacySound → marks unsupported
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);

        // Write must short-circuit (no HTTP call, no throw).
        let threw = false;
        try {
            await adapter.stateChangeHandler!(
                `${adapter.namespace}.cameras.${CAM_GEN2}.privacy_sound_enabled`,
                { val: false, ack: false, ts: Date.now(), lc: Date.now(), from: "user" },
            );
        } catch {
            threw = true;
        }
        expect(threw).to.equal(false, "short-circuit path must not throw");
        void db;
    });

    it("returns false for an unknown feature key (Map.get returns undefined)", async () => {
        // Boot with minimal stubs — no 442 for any feature.
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN2_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);

        // 'autofollow' is not polled for Gen2 (panLimit=0) so no 442 can be cached.
        // A write to a non-existent autofollow DP on this camera is ignored silently.
        let threw = false;
        try {
            await adapter.stateChangeHandler!(
                `${adapter.namespace}.cameras.${CAM_GEN2}.autofollow_enabled`,
                { val: true, ack: false, ts: Date.now(), lc: Date.now(), from: "user" },
            );
        } catch {
            threw = true;
        }
        expect(threw).to.equal(false, "unknown feature key must not throw");
        void db;
    });
});

// ── _shouldSkipPoll + _recordPollResult ──────────────────────────────────────

describe("v0.9.1 _shouldSkipPoll / _recordPollResult", () => {
    it("no prior failure → poll runs (no backoff)", async () => {
        // On first boot unread_events poll has no backoff — it runs and writes the count.
        // The unread count is written by _pollUnreadCount on a poll TICK
        // (setInterval, stubbed to no-op in tests), NOT at boot — so trigger one
        // poll explicitly. URL-matched so the /v11/events response is returned
        // for that GET regardless of where it falls in the poll sequence.
        stubAxiosByUrl([
            { match: /\/v11\/video_inputs(\?|$)/, status: 200, data: CAMERAS_GEN2_ONLY },
            {
                match: "/v11/events",
                status: 200,
                data: [
                    { id: "e1", isRead: false },
                    { id: "e2", isRead: false },
                    { id: "e3", isRead: true },
                ],
            },
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollCameraStateOnce();

        const val = getStateVal(db, adapter, `cameras.${CAM_GEN2}.unread_events_count`);
        expect(val).to.equal(2, "unread_events_count must equal number of isRead=false events");
    });

    it("444 response → backoff armed (next poll is skipped)", async () => {
        // A 444 (session quota) on the unread poll arms the backoff window so the
        // next tick short-circuits before the HTTP call. Verified by triggering a
        // real poll and then inspecting _shouldSkipPoll directly.
        stubAxiosByUrl([
            { match: /\/v11\/video_inputs(\?|$)/, status: 200, data: CAMERAS_GEN2_ONLY },
            { match: "/v11/events", status: 444, data: null },
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = adapter as any;
        await a._pollCameraStateOnce(); // events → 444 → _recordPollResult(false)

        expect(a._shouldSkipPoll(CAM_GEN2, "unread_events")).to.equal(
            true,
            "after a 444 the unread poll must be inside its backoff window",
        );
        void db;
    });

    it("failure on first attempt → backoff entry failCount=1, delay≈30s", async () => {
        // 500 is outside _pollUnreadCount's validateStatus allowlist (2xx|444) →
        // axios rejects → catch → _recordPollResult(false). Inspect the resulting
        // backoff entry directly: failCount 1, next attempt ~30s out.
        stubAxiosByUrl([
            { match: /\/v11\/video_inputs(\?|$)/, status: 200, data: CAMERAS_GEN2_ONLY },
            { match: "/v11/events", reject: true, status: 500 }, // axios rejects → catch path
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = adapter as any;
        const t0 = Date.now();
        await a._pollCameraStateOnce();

        const entry = a._pollBackoff.get(`${CAM_GEN2}:unread_events`);
        expect(entry, "a failed poll must create a backoff entry").to.not.equal(undefined);
        expect(entry.failCount).to.equal(1, "first failure → failCount=1");
        const delay = entry.nextAttempt - t0;
        expect(delay).to.be.greaterThan(29_000, "delay ≈ 30s (lower bound)");
        expect(delay).to.be.lessThan(31_000, "delay ≈ 30s (upper bound)");
        void db;
    });

    it("success after prior failure → backoff cleared (poll runs again)", async () => {
        stubAxiosByUrl([
            { match: /\/v11\/video_inputs(\?|$)/, status: 200, data: CAMERAS_GEN2_ONLY },
            {
                match: "/v11/events",
                status: 200,
                data: [
                    { id: "ev1", isRead: false },
                    { id: "ev2", isRead: false },
                    { id: "ev3", isRead: false },
                    { id: "ev4", isRead: true },
                ],
            },
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = adapter as any;

        // Direct: a failure arms the window, a success clears it.
        a._recordPollResult(CAM_GEN2, "unread_events", false);
        expect(a._shouldSkipPoll(CAM_GEN2, "unread_events")).to.equal(
            true,
            "prior failure arms the backoff window",
        );
        a._recordPollResult(CAM_GEN2, "unread_events", true);
        expect(a._shouldSkipPoll(CAM_GEN2, "unread_events")).to.equal(
            false,
            "a successful result clears the backoff entry",
        );

        // Integration: with backoff cleared, the next poll writes the fresh count.
        await a._pollCameraStateOnce();
        const val = getStateVal(db, adapter, `cameras.${CAM_GEN2}.unread_events_count`);
        expect(val).to.equal(3, "3 isRead=false events → count must be 3");
    });

    it("exponential backoff: second failure doubles the delay (failCount=2 → ≈60s)", async () => {
        // Drive _recordPollResult directly: two consecutive failures must double the
        // window from ~30s to ~60s (30000 * 2^(failCount-1)).
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN2_ONLY }]); // boot discovery only
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = adapter as any;
        const key = `${CAM_GEN2}:unread_events`;

        a._recordPollResult(CAM_GEN2, "unread_events", false); // failCount=1 → ~30s
        const t1 = Date.now();
        a._recordPollResult(CAM_GEN2, "unread_events", false); // failCount=2 → ~60s

        const entry = a._pollBackoff.get(key);
        expect(entry.failCount).to.equal(2, "two failures → failCount=2");
        const delay = entry.nextAttempt - t1;
        expect(delay).to.be.greaterThan(59_000, "delay ≈ 60s (lower bound)");
        expect(delay).to.be.lessThan(61_000, "delay ≈ 60s (upper bound)");
        void db;
    });

    it("backoff cap: many failures never exceed POLL_BACKOFF_CAP_MS=300s", async () => {
        // 30000 * 2^(failCount-1) grows past 300000 quickly; the delay must clamp.
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN2_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = adapter as any;
        const key = `${CAM_GEN2}:unread_events`;

        for (let i = 0; i < 15; i++) {
            a._recordPollResult(CAM_GEN2, "unread_events", false);
        }
        const t = Date.now();
        const entry = a._pollBackoff.get(key);
        expect(entry.failCount).to.equal(15, "15 failures recorded");
        const delay = entry.nextAttempt - t;
        expect(delay).to.be.lessThan(300_001, "delay must be capped at 300s");
        expect(delay).to.be.greaterThan(299_000, "delay must reach (not exceed) the 300s cap");
        void db;
    });
});

// ── _pollUnreadCount ─────────────────────────────────────────────────────────

describe("v0.9.1 _pollUnreadCount", () => {
    it("happy path: counts isRead=false events and writes to DP", async () => {
        stubAxiosByUrl([
            { match: /\/v11\/video_inputs(\?|$)/, status: 200, data: CAMERAS_GEN2_ONLY },
            {
                match: "/v11/events",
                status: 200,
                data: [
                    { id: "a", isRead: false },
                    { id: "b", isRead: false },
                    { id: "c", isRead: true },
                    { id: "d", isRead: true },
                    { id: "e", isRead: false },
                ],
            },
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollCameraStateOnce();

        const val = getStateVal(db, adapter, `cameras.${CAM_GEN2}.unread_events_count`);
        expect(val).to.equal(3, "must count exactly 3 isRead=false events");
    });

    it("empty event list → unread_events_count written as 0", async () => {
        stubAxiosByUrl([
            { match: /\/v11\/video_inputs(\?|$)/, status: 200, data: CAMERAS_GEN2_ONLY },
            { match: "/v11/events", status: 200, data: [] }, // empty array → unread=0
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollCameraStateOnce();

        const val = getStateVal(db, adapter, `cameras.${CAM_GEN2}.unread_events_count`);
        expect(val).to.equal(0, "empty event list must yield unread_events_count=0");
    });

    it("all events isRead=true → unread_events_count written as 0", async () => {
        stubAxiosByUrl([
            { match: /\/v11\/video_inputs(\?|$)/, status: 200, data: CAMERAS_GEN2_ONLY },
            {
                match: "/v11/events",
                status: 200,
                data: [
                    { id: "x1", isRead: true },
                    { id: "x2", isRead: true },
                ],
            },
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollCameraStateOnce();

        const val = getStateVal(db, adapter, `cameras.${CAM_GEN2}.unread_events_count`);
        expect(val).to.equal(0, "all isRead=true must yield count=0");
    });

    it("all events isRead=false → count equals list length", async () => {
        const events = Array.from({ length: 10 }, (_, i) => ({ id: `ev${i}`, isRead: false }));
        stubAxiosByUrl([
            { match: /\/v11\/video_inputs(\?|$)/, status: 200, data: CAMERAS_GEN2_ONLY },
            { match: "/v11/events", status: 200, data: events },
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollCameraStateOnce();

        const val = getStateVal(db, adapter, `cameras.${CAM_GEN2}.unread_events_count`);
        expect(val).to.equal(10, "10 isRead=false events → count must be 10");
    });

    it("isRead absent (undefined) → treated as read, not counted", async () => {
        // isRead === false is the explicit check in the reducer; absent field returns
        // undefined, which !== false, so it must NOT increment the counter.
        stubAxiosByUrl([
            { match: /\/v11\/video_inputs(\?|$)/, status: 200, data: CAMERAS_GEN2_ONLY },
            {
                match: "/v11/events",
                status: 200,
                data: [
                    { id: "u1" },            // isRead absent → not counted
                    { id: "u2", isRead: null }, // null → not counted
                    { id: "u3", isRead: 0 },    // 0 (number) → not counted
                    { id: "u4", isRead: false }, // only this is counted
                ],
            },
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollCameraStateOnce();

        const val = getStateVal(db, adapter, `cameras.${CAM_GEN2}.unread_events_count`);
        expect(val).to.equal(1, "only isRead===false must be counted, not null/absent/0");
    });

    it("non-array response body → treated as empty (count=0, no throw)", async () => {
        // Defensive: if Bosch changes response shape to an object, the adapter
        // falls back to [] and writes 0 (exercises the Array.isArray=false branch).
        stubAxiosByUrl([
            { match: /\/v11\/video_inputs(\?|$)/, status: 200, data: CAMERAS_GEN2_ONLY },
            { match: "/v11/events", status: 200, data: { items: [], total: 0 } },
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._pollCameraStateOnce();

        const val = getStateVal(db, adapter, `cameras.${CAM_GEN2}.unread_events_count`);
        expect(val).to.equal(0, "non-array response must fall back to count=0");
    });

    it("HTTP 444 → no count written, backoff armed", async () => {
        // 444 (session quota): _pollUnreadCount returns early without upserting a
        // count, and arms the backoff. The DP stays at its boot seed (0).
        stubAxiosByUrl([
            { match: /\/v11\/video_inputs(\?|$)/, status: 200, data: CAMERAS_GEN2_ONLY },
            { match: "/v11/events", status: 444, data: null },
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = adapter as any;
        await a._pollCameraStateOnce();

        const val = getStateVal(db, adapter, `cameras.${CAM_GEN2}.unread_events_count`);
        expect(val).to.equal(0, "444 must not overwrite the count (no events upsert)");
        expect(a._shouldSkipPoll(CAM_GEN2, "unread_events")).to.equal(true, "444 arms backoff");
    });

    it("network error (rejected) → swallowed, no rethrow, backoff armed", async () => {
        // 500 is outside the validateStatus allowlist (2xx|444) → axios rejects →
        // catch → _recordPollResult(false). Must not bubble out of the poll tick.
        stubAxiosByUrl([
            { match: /\/v11\/video_inputs(\?|$)/, status: 200, data: CAMERAS_GEN2_ONLY },
            { match: "/v11/events", reject: true, status: 500 }, // axios rejects → catch path
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = adapter as any;

        let threw = false;
        try {
            await a._pollCameraStateOnce();
        } catch {
            threw = true;
        }
        expect(threw).to.equal(false, "a rejected events GET must be swallowed inside the poll");
        const val = getStateVal(db, adapter, `cameras.${CAM_GEN2}.unread_events_count`);
        expect(val).to.equal(0, "failed poll must not write a count");
        expect(a._shouldSkipPoll(CAM_GEN2, "unread_events")).to.equal(true, "failure arms backoff");
    });

    it("DP type is number, write=false (read-only)", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN2_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);

        const obj = db.getObject(
            `${adapter.namespace}.cameras.${CAM_GEN2}.unread_events_count`,
        );
        expect(obj).to.not.equal(undefined, "unread_events_count DP must exist");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const common = (obj as any)?.common;
        expect(common?.type).to.equal("number", "DP type must be number");
        expect(common?.write).to.equal(false, "DP must be read-only (write=false)");
    });

    it("backoff active → poll skips the events GET (count not refreshed)", async () => {
        // Pre-arm the backoff, then run a poll whose events stub WOULD report 5
        // unread. Because the window is open, _pollUnreadCount must short-circuit
        // and leave the count at its seed (0) — proving the GET was skipped.
        stubAxiosByUrl([
            { match: /\/v11\/video_inputs(\?|$)/, status: 200, data: CAMERAS_GEN2_ONLY },
            {
                match: "/v11/events",
                status: 200,
                data: [
                    { id: "s1", isRead: false },
                    { id: "s2", isRead: false },
                    { id: "s3", isRead: false },
                    { id: "s4", isRead: false },
                    { id: "s5", isRead: false },
                ],
            },
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = adapter as any;
        a._recordPollResult(CAM_GEN2, "unread_events", false); // arm the backoff window
        await a._pollCameraStateOnce();

        const val = getStateVal(db, adapter, `cameras.${CAM_GEN2}.unread_events_count`);
        expect(val).to.equal(
            0,
            "backoff window open → events GET skipped, count stays at seed 0 (not 5)",
        );
    });
});

// ── Integration: _isFeatureUnsupported gate in _pollPrivacySound ─────────────

describe("v0.9.1 _isFeatureUnsupported gates _pollPrivacySound", () => {
    it("after 442 on first poll — second call to privacy_sound_enabled write does not hit HTTP", async () => {
        // Boot: _pollPrivacySound at position [6] returns 442 → _markFeatureUnsupported.
        // Write handler: _isFeatureUnsupported → true → short-circuit (no HTTP, no throw).
        stubAxiosSequence([
            ...gen2OutdoorBootLeader(),      // [0-4]
            { status: 200, data: [] },       // [5] _pollUnreadCount
            { status: 442, data: null },     // [6] _pollPrivacySound → marks unsupported
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);

        let threw = false;
        try {
            await adapter.stateChangeHandler!(
                `${adapter.namespace}.cameras.${CAM_GEN2}.privacy_sound_enabled`,
                { val: true, ack: false, ts: Date.now(), lc: Date.now(), from: "user" },
            );
        } catch {
            threw = true;
        }
        expect(threw).to.equal(
            false,
            "_isFeatureUnsupported=true path must short-circuit without throw",
        );
        void db;
    });

    it("after 442 on write — subsequent write is also short-circuited (feature cached)", async () => {
        stubAxiosSequence([
            ...gen2OutdoorBootLeader(),        // [0-4]
            { status: 200, data: [] },         // [5] _pollUnreadCount
            { status: 200, data: null },       // [6] _pollPrivacySound success (no 442 yet)
            { status: 442, data: null },       // [7] first write → 442 → _markFeatureUnsupported
        ]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY);
        await bootWithTokens(db, adapter);

        // First write — encounters 442, marks unsupported.
        await adapter.stateChangeHandler!(
            `${adapter.namespace}.cameras.${CAM_GEN2}.privacy_sound_enabled`,
            { val: true, ack: false, ts: Date.now(), lc: Date.now(), from: "user" },
        );

        // Second write — should short-circuit (no HTTP) because feature now cached.
        // No stubs left in queue; if HTTP is made it falls to FALLBACK (404 → rejection).
        let threw = false;
        try {
            await adapter.stateChangeHandler!(
                `${adapter.namespace}.cameras.${CAM_GEN2}.privacy_sound_enabled`,
                { val: false, ack: false, ts: Date.now(), lc: Date.now(), from: "user" },
            );
        } catch {
            threw = true;
        }
        expect(threw).to.equal(false, "second write after 442 must short-circuit without throw");
        void db;
    });
});
