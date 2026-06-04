/**
 * Tests for offline-camera detection (forum #84538, v1.2.1).
 *
 * An OFFLINE camera can never serve a stream, so the adapter must NOT keep
 * retrying live sessions for it (each retry burns Bosch's shared 3-session
 * quota and produces 444 spam). Two pieces:
 *
 *   1. _resolveCameraStatus(camId) — session-less status probe mirroring HA's
 *      _check_status: LAN-TCP primary, cloud /ping + /commissioned fallback.
 *   2. _handleSessionLimitError(camId) — on a 444, confirm status; if OFFLINE,
 *      mark offline and STOP (no 60 s retry loop). If quota/online, retry.
 *
 * Methods are pulled off the real adapter prototype and invoked against a
 * hand-made `this` stub (same technique as main_camera_status_announce.spec.ts).
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
    factory({ config: { redirect_url: "", region: "EU" } });
    if (!captured) {
        throw new Error("adapter not captured");
    }
    return captured;
}

const CAM = "EFEFEFEF-1111-2222-3333-444455556666";

describe("offline detection — _resolveCameraStatus (#84538)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resolveStatus: (...a: any[]) => Promise<string>;

    before(() => {
        const adapter = loadAdapter();
        resolveStatus = adapter._resolveCameraStatus;
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function stub(opts: { tcp: boolean; token?: string | null; get?: sinon.SinonStub }): any {
        return {
            _currentAccessToken: opts.token === undefined ? "tok" : opts.token,
            _tcpPing: sinon.stub().resolves(opts.tcp),
            _httpClient: { get: opts.get ?? sinon.stub().resolves({ status: 404, data: null }) },
            log: { debug: () => undefined },
        };
    }

    it("LAN reachable → ONLINE without any cloud call", async () => {
        const get = sinon.stub().resolves({ status: 200, data: "ONLINE" });
        const s = stub({ tcp: true, get });
        expect(await resolveStatus.call(s, CAM)).to.equal("ONLINE");
        expect(get.called, "no cloud call when LAN reachable").to.equal(false);
    });

    it("cloud /ping body 'OFFLINE' → OFFLINE", async () => {
        const get = sinon.stub().resolves({ status: 200, data: "OFFLINE" });
        expect(await resolveStatus.call(stub({ tcp: false, get }), CAM)).to.equal("OFFLINE");
    });

    it("cloud /ping body 'ONLINE' (quoted) → ONLINE", async () => {
        const get = sinon.stub().resolves({ status: 200, data: '"ONLINE"' });
        expect(await resolveStatus.call(stub({ tcp: false, get }), CAM)).to.equal("ONLINE");
    });

    it("cloud /ping HTTP 444 → SESSION_LIMIT (not offline)", async () => {
        const get = sinon.stub().resolves({ status: 444, data: "" });
        expect(await resolveStatus.call(stub({ tcp: false, get }), CAM)).to.equal("SESSION_LIMIT");
    });

    it("cloud /ping body 'UPDATING_FIRMWARE' → UPDATING", async () => {
        const get = sinon.stub().resolves({ status: 200, data: "UPDATING_FIRMWARE" });
        expect(await resolveStatus.call(stub({ tcp: false, get }), CAM)).to.equal("UPDATING");
    });

    it("/ping inconclusive → /commissioned connected+commissioned → ONLINE", async () => {
        const get = sinon.stub();
        get.onFirstCall().resolves({ status: 404, data: null }); // /ping
        get.onSecondCall().resolves({ status: 200, data: { connected: true, commissioned: true } });
        expect(await resolveStatus.call(stub({ tcp: false, get }), CAM)).to.equal("ONLINE");
    });

    it("/ping inconclusive → /commissioned configured-but-not-connected → OFFLINE", async () => {
        const get = sinon.stub();
        get.onFirstCall().resolves({ status: 404, data: null });
        get.onSecondCall().resolves({ status: 200, data: { configured: true, connected: false } });
        expect(await resolveStatus.call(stub({ tcp: false, get }), CAM)).to.equal("OFFLINE");
    });

    it("no access token → UNKNOWN (no cloud call)", async () => {
        const get = sinon.stub().resolves({ status: 200, data: "ONLINE" });
        const s = stub({ tcp: false, token: null, get });
        expect(await resolveStatus.call(s, CAM)).to.equal("UNKNOWN");
        expect(get.called).to.equal(false);
    });
});

describe("offline detection — _handleSessionLimitError gate (#84538)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let handle: (...a: any[]) => Promise<void>;

    before(() => {
        handle = loadAdapter()._handleSessionLimitError;
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function stub(status: string): any {
        return {
            _resolveCameraStatus: sinon.stub().resolves(status),
            _sessionLimitHits: new Map<string, number[]>(),
            setTimeout: sinon.stub().returns(1),
            clearTimeout: sinon.stub(),
            setStateAsync: sinon.stub().resolves(undefined),
            upsertState: sinon.stub().resolves(undefined),
            _maybeannounceCameraStatus: sinon.stub().resolves(undefined),
            log: { warn: sinon.stub(), info: () => undefined, debug: () => undefined },
        };
    }

    it("OFFLINE → no retry scheduled, marks offline, clears hit, no WARN spam", async () => {
        const s = stub("OFFLINE");
        s._sessionLimitHits.set(CAM, [Date.now()]);
        await handle.call(s, CAM);
        expect(s.setTimeout.called, "no 60s retry for offline camera").to.equal(false);
        expect(s._sessionLimitHits.has(CAM), "session-limit hits cleared").to.equal(false);
        expect(s.log.warn.called, "no session-quota WARN for an offline camera").to.equal(false);
        // online flipped to false
        const onlineWrite = s.upsertState
            .getCalls()
            .find((c: sinon.SinonSpyCall) => String(c.args[0]).endsWith(".online"));
        expect(onlineWrite?.args[1], "online set to false").to.equal(false);
    });

    it("UPDATING → treated like offline, no retry", async () => {
        const s = stub("UPDATING");
        await handle.call(s, CAM);
        expect(s.setTimeout.called).to.equal(false);
    });

    it("SESSION_LIMIT (online, real quota) → retry IS scheduled + WARN logged", async () => {
        const s = stub("SESSION_LIMIT");
        await handle.call(s, CAM);
        expect(s.setTimeout.called, "quota hit arms a 60s retry").to.equal(true);
        expect(s.log.warn.called, "real quota hit warns the user").to.equal(true);
    });
});
