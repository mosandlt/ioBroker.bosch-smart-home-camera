/**
 * Adapter wiring of the local data interface: status refresh gating, the
 * local-vs-cloud stream decision and that the password never reaches a log.
 * Methods are taken off the adapter prototype and run against a stub `this`.
 */

import { expect } from "chai";
import sinon from "sinon";
import * as path from "path";

import type { MockDatabase } from "@iobroker/testing/build/tests/unit/mocks/mockDatabase";
import type { MockAdapter } from "@iobroker/testing/build/tests/unit/mocks/mockAdapter";
import { stubAxiosSequence, restoreAxios } from "./helpers/axios-mock";

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
    factory({ config: { redirect_url: "", region: "EU", startup_snapshot: true } });
    if (!captured) {
        throw new Error("adapter not captured");
    }
    return captured;
}

const CAM = "11111111-2222-3333-4444-555555555555";
const PW = "test-pw";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let proto: any;
before(() => {
    proto = Object.getPrototypeOf(loadAdapter());
});
afterEach(() => restoreAxios());

interface StubOpts {
    state?: string;
    passwords?: string;
    ip?: string;
    generation?: number;
    firmware?: string;
    token?: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeStub(o: StubOpts = {}): any {
    const logs: string[] = [];
    const rec = (m: string): void => {
        logs.push(m);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s: any = {
        config: { local_data_passwords: o.passwords ?? "" },
        _ldiState: new Map(o.state ? [[CAM, o.state]] : []),
        _lanIpMap: new Map(o.ip ? [[CAM, o.ip]] : []),
        _cameras: new Map([
            [
                CAM,
                {
                    id: CAM,
                    generation: o.generation ?? 2,
                    firmwareVersion: o.firmware ?? "9.40.202",
                },
            ],
        ]),
        _livestreamEnabled: new Map(),
        _currentAccessToken: o.token === null ? null : "tok",
        _httpClient: require("axios").create(),
        _states: {} as Record<string, unknown>,
        upsertState: sinon.stub().callsFake(async (id: string, v: unknown) => {
            s._states[id] = v;
        }),
        _cancelSnapshotIdleTeardown: sinon.stub(),
        ensureLiveSession: sinon.stub().resolves({}),
        log: { info: rec, warn: rec, error: rec, debug: rec },
        logs,
    };
    for (const name of [
        "_localSource",
        "_refreshLdiStatus",
        "_publishLocalSource",
        "_publishStreamParts",
    ]) {
        s[name] = proto[name];
    }
    return s;
}

describe("_localSource", () => {
    const url = `rtsps://localuser:${PW}@10.0.0.5:9554/live`;
    it("active + password + LAN ip -> direct URL", () => {
        const s = makeStub({ state: "active", passwords: `${CAM}=${PW}`, ip: "10.0.0.5" });
        expect(proto._localSource.call(s, CAM)).to.deep.equal({ url });
    });
    it("active without password -> cloud path (null)", () => {
        const s = makeStub({ state: "active", ip: "10.0.0.5" });
        expect(proto._localSource.call(s, CAM)).to.equal(null);
    });
    for (const st of ["inactive", "unsupported", undefined]) {
        it(`${st} with password -> cloud path (null)`, () => {
            const s = makeStub({ state: st, passwords: `${CAM}=${PW}`, ip: "10.0.0.5" });
            expect(proto._localSource.call(s, CAM)).to.equal(null);
        });
    }
    it("active + password but no LAN ip -> fail closed (url null)", () => {
        const s = makeStub({ state: "active", passwords: `${CAM}=${PW}` });
        expect(proto._localSource.call(s, CAM)).to.deep.equal({ url: null });
    });
    it("active + password but public ip -> fail closed", () => {
        const s = makeStub({ state: "active", passwords: `${CAM}=${PW}`, ip: "8.8.8.8" });
        expect(proto._localSource.call(s, CAM)).to.deep.equal({ url: null });
    });
    it("malformed password -> cloud path", () => {
        const s = makeStub({ state: "active", passwords: `${CAM}=ä`, ip: "10.0.0.5" });
        expect(proto._localSource.call(s, CAM)).to.equal(null);
    });
});

describe("_refreshLdiStatus", () => {
    it("active response is stored and published", async () => {
        stubAxiosSequence([{ status: 200, data: { username: "localuser" } }]);
        const s = makeStub();
        await proto._refreshLdiStatus.call(s, s._cameras.get(CAM));
        expect(s._ldiState.get(CAM)).to.equal("active");
        expect(s._states[`cameras.${CAM}.local_data_interface`]).to.equal("active");
    });
    it("404 -> inactive, 449 -> unsupported", async () => {
        stubAxiosSequence([{ status: 404 }, { status: 449 }]);
        const s = makeStub({ state: "active" });
        await proto._refreshLdiStatus.call(s, s._cameras.get(CAM));
        expect(s._ldiState.get(CAM)).to.equal("inactive");
        await proto._refreshLdiStatus.call(s, s._cameras.get(CAM));
        expect(s._ldiState.get(CAM)).to.equal("unsupported");
    });
    it("garbage / 500 keeps the last value", async () => {
        stubAxiosSequence([{ status: 500 }, { status: 200, data: "x" }]);
        const s = makeStub({ state: "active" });
        await proto._refreshLdiStatus.call(s, s._cameras.get(CAM));
        await proto._refreshLdiStatus.call(s, s._cameras.get(CAM));
        expect(s._ldiState.get(CAM)).to.equal("active");
        expect(s.upsertState.called).to.equal(false);
    });
    it("firmware too old / null / Gen1 -> no request at all", async () => {
        for (const o of [{ firmware: "9.40.104" }, { firmware: "" }, { generation: 1 }]) {
            const s = makeStub(o);
            s._httpClient = { get: sinon.stub().rejects(new Error("must not be called")) };
            await proto._refreshLdiStatus.call(s, s._cameras.get(CAM));
            expect(s._httpClient.get.called, JSON.stringify(o)).to.equal(false);
            expect(s._ldiState.has(CAM)).to.equal(false);
        }
    });
    it("no token -> no request", async () => {
        const s = makeStub({ token: null });
        s._httpClient = { get: sinon.stub().rejects(new Error("must not be called")) };
        await proto._refreshLdiStatus.call(s, s._cameras.get(CAM));
        expect(s._httpClient.get.called).to.equal(false);
    });
});

describe("handleLivestreamToggle with the local data interface", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function toggleStub(o: StubOpts): any {
        const s = makeStub(o);
        s.handleLivestreamToggle = proto.handleLivestreamToggle;
        return s;
    }

    it("active + password: publishes the local URL, no cloud session, password never logged", async () => {
        stubAxiosSequence([{ status: 200, data: { username: "localuser" } }]);
        const s = toggleStub({ passwords: `${CAM}=${PW}`, ip: "10.0.0.5" });
        await s.handleLivestreamToggle(CAM, true);
        expect(s.ensureLiveSession.called).to.equal(false);
        expect(s._states[`cameras.${CAM}.stream_url`]).to.equal(
            `rtsps://localuser:${PW}@10.0.0.5:9554/live`,
        );
        expect(s._states[`cameras.${CAM}.stream_url_sub`]).to.equal("");
        expect(s._states[`cameras.${CAM}.stream_host`]).to.equal("10.0.0.5");
        expect(s._states[`cameras.${CAM}.stream_port`]).to.equal(9554);
        expect(s._states[`cameras.${CAM}.stream_path`]).to.equal("/live");
        expect(s.logs.join("\n")).to.not.contain(PW);
        expect(s.logs.join("\n")).to.contain("***@10.0.0.5");
    });

    it("active + password + unusable ip: fails closed, no cloud session, clear error", async () => {
        stubAxiosSequence([{ status: 200, data: { username: "localuser" } }]);
        const s = toggleStub({ passwords: `${CAM}=${PW}` });
        await s.handleLivestreamToggle(CAM, true);
        expect(s.ensureLiveSession.called).to.equal(false);
        expect(s._states[`cameras.${CAM}.stream_url`]).to.equal("");
        expect(s.logs.join("\n")).to.contain("not starting a cloud stream");
        expect(s.logs.join("\n")).to.not.contain(PW);
    });

    it("active without password: cloud path, with a settings hint", async () => {
        const s = toggleStub({ state: "active", ip: "10.0.0.5" });
        await s.handleLivestreamToggle(CAM, true);
        expect(s.ensureLiveSession.calledOnce).to.equal(true);
        expect(s.logs.join("\n")).to.contain("set the camera password");
    });

    it("inactive with password: cloud path, status re-checked once", async () => {
        stubAxiosSequence([{ status: 404 }]);
        const s = toggleStub({ passwords: `${CAM}=${PW}`, ip: "10.0.0.5" });
        await s.handleLivestreamToggle(CAM, true);
        expect(s.ensureLiveSession.calledOnce).to.equal(true);
        expect(s._ldiState.get(CAM)).to.equal("inactive");
    });

    it("no password configured: no status request, unchanged cloud path", async () => {
        const s = toggleStub({});
        s._httpClient = { get: sinon.stub().rejects(new Error("must not be called")) };
        await s.handleLivestreamToggle(CAM, true);
        expect(s._httpClient.get.called).to.equal(false);
        expect(s.ensureLiveSession.calledOnce).to.equal(true);
        expect(s.logs.join("\n")).to.not.contain("password");
    });

    it("network error while checking: keeps last status (active) and stays local", async () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const axios = require("axios");
        stubAxiosSequence([]);
        axios.defaults.adapter = () => Promise.reject(new Error("ECONNRESET"));
        const s = toggleStub({ state: "active", passwords: `${CAM}=${PW}`, ip: "10.0.0.5" });
        await s.handleLivestreamToggle(CAM, true);
        expect(s.ensureLiveSession.called).to.equal(false);
        expect(s._states[`cameras.${CAM}.stream_url`]).to.contain("9554/live");
    });
});

describe("ensureLiveSession guard", () => {
    it("refuses to open a cloud session while the local source is in use", async () => {
        const s = makeStub({ state: "active", passwords: `${CAM}=${PW}`, ip: "10.0.0.5" });
        let err: unknown;
        try {
            await proto.ensureLiveSession.call(s, CAM);
        } catch (e) {
            err = e;
        }
        expect(err).to.be.instanceOf(Error);
        expect((err as Error).message).to.contain("streams locally");
        expect((err as Error).message).to.not.contain(PW);
    });
});
