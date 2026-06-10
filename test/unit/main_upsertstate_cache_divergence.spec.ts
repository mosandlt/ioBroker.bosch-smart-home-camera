/**
 * Regression test — upsertState must not desync its in-memory cache from
 * the actual ioBroker DB.
 *
 * Source: Sandbox-observed live during the v0.7.14 audit pass (2026-05-24).
 *   privacy_enabled stuck at True ack=True ts=16:10 UTC for 4+ hours
 *   while the state-poll loop kept logging "privacy ON → OFF" every 30 s.
 *
 * Root cause (pre-v0.7.15): upsertState set `_stateCache` BEFORE awaiting
 * setStateAsync. If the DB write failed/rejected for any reason, the cache
 * held the new value while the DB still held the old one. From then on
 * every subsequent upsertState call returned early via the cache short-
 * circuit ("cache already at target value") — but the DB was stuck on the
 * pre-fail value for the rest of the adapter's lifetime.
 *
 * Fix (v0.7.15): await setStateAsync FIRST, only update the cache after a
 * successful write. Failed write → cache stays at the old value → next
 * call retries the write.
 *
 * Pins:
 *   1. Successful write → cache updated, value matches.
 *   2. Throwing setStateAsync → cache NOT updated, next call retries.
 *   3. Second successful call after first throws → cache + DB both update.
 *   4. Cache-hit short-circuit still works for repeated identical writes.
 */

import { expect } from "chai";
import * as sinon from "sinon";
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
type AnyFn = (...args: any[]) => any;

function loadAdapter(): { adapter: MockAdapter; upsertState: AnyFn; cache: Map<string, unknown> } {
    const db = new MockDatabaseCtor();
    let capturedAdapter: MockAdapter | null = null;
    const core = mockAdapterCoreFn(db, {
        onAdapterCreated: (a) => {
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
    delete require.cache[MAIN_JS_PATH];
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const factory = require(MAIN_JS_PATH) as (opts: Record<string, unknown>) => MockAdapter;
    factory({ config: { redirect_url: "", region: "EU", startup_snapshot: true } });
    if (!capturedAdapter) throw new Error("adapter not captured");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proto = capturedAdapter as any;
    const upsertState = proto.upsertState as AnyFn | undefined;
    const cache = proto._stateCache as Map<string, unknown> | undefined;
    if (typeof upsertState !== "function" || !cache) {
        throw new Error("upsertState or _stateCache not found");
    }
    return { adapter: capturedAdapter, upsertState, cache };
}

describe("upsertState cache/DB divergence (sandbox-observed 2026-05-24)", () => {
    let env: ReturnType<typeof loadAdapter>;

    beforeEach(() => {
        env = loadAdapter();
    });
    afterEach(() => {
        sinon.restore();
    });

    it("successful write: cache + setStateAsync both updated", async () => {
        // The MockAdapter pre-stubs setStateAsync; replace by direct
        // property assignment (sinon.stub would reject a re-wrap).
        const setStateAsync = sinon.stub().resolves();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (env.adapter as any).setStateAsync = setStateAsync;
        await env.upsertState.call(env.adapter, "cam.x.privacy_enabled", false);
        expect(setStateAsync.calledOnce, "setStateAsync called once").to.equal(true);
        expect(env.cache.get("cam.x.privacy_enabled"), "cache reflects new value").to.equal(false);
    });

    it("throwing write: cache NOT updated, next call retries (v0.7.15 fix)", async () => {
        const setStateAsync = sinon.stub();
        setStateAsync.onFirstCall().rejects(new Error("db is down"));
        setStateAsync.onSecondCall().resolves();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (env.adapter as any).setStateAsync = setStateAsync;

        // Seed cache with the OLD value so the cache-hit short-circuit
        // is not what skips the write — the divergence comes from a
        // failed write later.
        env.cache.set("cam.x.privacy_enabled", true);

        // First call throws — cache MUST stay at the old value, not
        // optimistically jump to the new value.
        let firstErr: Error | undefined;
        try {
            await env.upsertState.call(env.adapter, "cam.x.privacy_enabled", false);
        } catch (e) {
            firstErr = e as Error;
        }
        expect(firstErr?.message, "first call rejects").to.equal("db is down");
        expect(
            env.cache.get("cam.x.privacy_enabled"),
            "cache stays at old value after failed write",
        ).to.equal(true);

        // Second call succeeds — now cache should update.
        await env.upsertState.call(env.adapter, "cam.x.privacy_enabled", false);
        expect(setStateAsync.callCount, "setStateAsync retried").to.equal(2);
        expect(
            env.cache.get("cam.x.privacy_enabled"),
            "cache updated only after successful write",
        ).to.equal(false);
    });

    it("repeated identical writes still short-circuit via cache", async () => {
        // The MockAdapter pre-stubs setStateAsync; replace by direct
        // property assignment (sinon.stub would reject a re-wrap).
        const setStateAsync = sinon.stub().resolves();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (env.adapter as any).setStateAsync = setStateAsync;

        await env.upsertState.call(env.adapter, "cam.x.online", true);
        await env.upsertState.call(env.adapter, "cam.x.online", true);
        await env.upsertState.call(env.adapter, "cam.x.online", true);

        expect(setStateAsync.callCount, "second/third writes skipped via cache").to.equal(1);
        expect(env.cache.get("cam.x.online")).to.equal(true);
    });

    it("recover after divergence: failed write keeps the door open for retry", async () => {
        const setStateAsync = sinon.stub();
        setStateAsync.onCall(0).rejects(new Error("transient"));
        setStateAsync.onCall(1).rejects(new Error("transient"));
        setStateAsync.onCall(2).resolves();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (env.adapter as any).setStateAsync = setStateAsync;

        env.cache.set("cam.x.lan_reachable", false);

        for (let i = 0; i < 2; i++) {
            try {
                await env.upsertState.call(env.adapter, "cam.x.lan_reachable", true);
            } catch {
                /* expected */
            }
            expect(
                env.cache.get("cam.x.lan_reachable"),
                `cache still at old value after fail ${i + 1}`,
            ).to.equal(false);
        }

        await env.upsertState.call(env.adapter, "cam.x.lan_reachable", true);
        expect(setStateAsync.callCount, "third attempt finally writes").to.equal(3);
        expect(env.cache.get("cam.x.lan_reachable"), "cache updated on success").to.equal(true);
    });
});
