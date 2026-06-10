/**
 * Tests for the request-saving options (poll_interval clamping).
 *
 * `poll_interval` (seconds) lets users trade state-update latency for fewer
 * Bosch cloud requests. The `_pollIntervalMs` getter clamps it to 30–3600 s and
 * falls back to the 60 s default for missing/invalid values, so a bad config can
 * never produce a 0 ms (busy-loop) or absurdly large timer.
 *
 * The getter is pulled off the adapter prototype and invoked against a `this`
 * stub carrying only `config` (same technique as
 * main_privacy_online_reconcile.spec.ts).
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

describe("request-saving — _pollIntervalMs clamping", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let getter: (this: unknown) => number;

    before(() => {
        const inst = loadAdapter();
        const proto = Object.getPrototypeOf(inst);
        const desc = Object.getOwnPropertyDescriptor(proto, "_pollIntervalMs");
        if (!desc || typeof desc.get !== "function") {
            throw new Error("_pollIntervalMs getter not found on prototype");
        }
        getter = desc.get as (this: unknown) => number;
    });

    function ms(poll_interval: unknown): number {
        return getter.call({ config: { poll_interval } });
    }

    it("undefined → 60 s default", () => {
        expect(ms(undefined)).to.equal(60_000);
    });

    it("missing config key → 60 s default", () => {
        expect(getter.call({ config: {} })).to.equal(60_000);
    });

    it("non-numeric string → 60 s default", () => {
        expect(ms("abc")).to.equal(60_000);
    });

    it("below minimum (29 s) → 60 s default", () => {
        expect(ms(29)).to.equal(60_000);
    });

    it("zero → 60 s default (never a 0 ms busy loop)", () => {
        expect(ms(0)).to.equal(60_000);
    });

    it("negative → 60 s default", () => {
        expect(ms(-100)).to.equal(60_000);
    });

    it("exactly minimum (30 s) → 30 000 ms", () => {
        expect(ms(30)).to.equal(30_000);
    });

    it("default (60 s) → 60 000 ms", () => {
        expect(ms(60)).to.equal(60_000);
    });

    it("doubled (120 s) → 120 000 ms", () => {
        expect(ms(120)).to.equal(120_000);
    });

    it("exactly maximum (3600 s) → 3 600 000 ms", () => {
        expect(ms(3600)).to.equal(3_600_000);
    });

    it("above maximum (5000 s) → clamped to 3 600 000 ms", () => {
        expect(ms(5000)).to.equal(3_600_000);
    });

    it("numeric string '120' → 120 000 ms (coerced)", () => {
        expect(ms("120")).to.equal(120_000);
    });
});
