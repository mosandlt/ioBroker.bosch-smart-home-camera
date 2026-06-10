/**
 * Tests for the single-key PUT write-handlers (v1.1.0): status-LED, timestamp
 * overlay and power-LED brightness, plus the shared `_putSingleKey` helper.
 *
 * Methods are pulled off the real adapter prototype and invoked against a
 * hand-made `this` stub (same technique as main_offline_detection.spec.ts).
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

describe("single-key write handlers — _putSingleKey (v1.1.0)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let adapter: any;

    before(() => {
        adapter = loadAdapter();
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function stub(putStatus: number): any {
        return {
            _currentAccessToken: "tok",
            _httpClient: { put: sinon.stub().resolves({ status: putStatus }) },
            log: { info: sinon.stub(), warn: sinon.stub(), debug: sinon.stub() },
            // the delegators call this._putSingleKey — wire the real helper so the
            // shared PUT path is exercised against our stubbed httpClient.
            _putSingleKey: adapter._putSingleKey,
        };
    }

    it("status_led ON → PUT /ledlights {state:'ON'} → true", async () => {
        const s = stub(200);
        const ok = await adapter._handleStatusLedWrite.call(s, CAM, true);
        expect(ok).to.equal(true);
        const [url, body] = s._httpClient.put.firstCall.args;
        expect(String(url)).to.match(/\/ledlights$/);
        expect(body).to.deep.equal({ state: "ON" });
    });

    it("status_led OFF → PUT {state:'OFF'}", async () => {
        const s = stub(200);
        await adapter._handleStatusLedWrite.call(s, CAM, false);
        expect(s._httpClient.put.firstCall.args[1]).to.deep.equal({ state: "OFF" });
    });

    it("timestamp overlay → PUT /timestamp {result:bool}", async () => {
        const s = stub(200);
        const ok = await adapter._handleTimestampWrite.call(s, CAM, true);
        expect(ok).to.equal(true);
        const [url, body] = s._httpClient.put.firstCall.args;
        expect(String(url)).to.match(/\/timestamp$/);
        expect(body).to.deep.equal({ result: true });
    });

    it("power-LED brightness clamps out-of-range value to 0..4", async () => {
        const s = stub(200);
        await adapter._handlePowerLedBrightnessWrite.call(s, CAM, 9);
        const [url, body] = s._httpClient.put.firstCall.args;
        expect(String(url)).to.match(/\/iconLedBrightness$/);
        expect(body).to.deep.equal({ value: 4 });
    });

    it("HTTP 443 (privacy) → returns false, logs a privacy warning", async () => {
        const s = stub(443);
        const ok = await adapter._handleStatusLedWrite.call(s, CAM, true);
        expect(ok).to.equal(false);
        expect(s.log.warn.called, "privacy 443 warns").to.equal(true);
    });

    it("no access token → throws (adapter not ready)", async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const s: any = { _currentAccessToken: null, _httpClient: { put: sinon.stub() }, log: { info: sinon.stub(), warn: sinon.stub() }, _putSingleKey: adapter._putSingleKey };
        let threw = false;
        try {
            await adapter._handleTimestampWrite.call(s, CAM, true);
        } catch {
            threw = true;
        }
        expect(threw).to.equal(true);
        expect(s._httpClient.put.called, "no PUT without a token").to.equal(false);
    });
});
