/**
 * Unit tests for src/lib/cloud_feature_flags.ts
 *
 * Focus: branch coverage for the uncovered 75% (3/4 branches missed).
 *
 * Uncovered branches in the stale HTML report (BRDA with count=0):
 *   Line 42  branch 0: outer try block — already covered (happy path runs it)
 *   Line 57  branch 1: data guard true-side  → !data           → return null
 *   Line 57  branch 2: data guard true-side  → Array.isArray   → return null
 *   Line 60  branch 3: filter predicate false-side (v !== true) → flag excluded
 *   validateStatus lambda (FN line 52) — never invoked via existing tests
 *   catch block (line 71-73) — never triggered
 *
 * Framework: Mocha + Chai + Sinon
 * Mocking:   stubAxiosSequence / stubAxiosError / restoreAxios (helpers/axios-mock.ts)
 */

import { expect } from "chai";
import axios from "axios";

import { fetchFeatureFlags } from "../../src/lib/cloud_feature_flags";
import { stubAxiosSequence, stubAxiosError, restoreAxios } from "./helpers/axios-mock";

// ── helpers ───────────────────────────────────────────────────────────────────

const FAKE_TOKEN = "Bearer.access.token.xyz";

function makeClient() {
    return axios.create({ timeout: 5_000 });
}

afterEach(() => {
    restoreAxios();
});

// ── fetchFeatureFlags() — branch coverage ─────────────────────────────────────

describe("fetchFeatureFlags() — branch coverage", () => {
    // ── B1: happy path (validates the function is callable + returns result) ──

    it("returns FeatureFlagsResult with enabled flags sorted", async () => {
        stubAxiosSequence([
            {
                status: 200,
                data: { APP_RATING: true, IOT_THINGS: true, BETA_FEATURE: false },
            },
        ]);

        const result = await fetchFeatureFlags(makeClient(), FAKE_TOKEN);

        expect(result).to.not.be.null;
        expect(result!.display).to.equal("APP_RATING, IOT_THINGS");
        expect(result!.raw).to.include('"APP_RATING"');
        expect(result!.raw).to.include('"BETA_FEATURE"');
    });

    // ── B2: filter false-side — flags where v !== true are excluded ───────────

    it("excludes flags with value false from display string", async () => {
        stubAxiosSequence([
            {
                status: 200,
                data: { DISABLED_A: false, DISABLED_B: false, ACTIVE: true },
            },
        ]);

        const result = await fetchFeatureFlags(makeClient(), FAKE_TOKEN);

        expect(result).to.not.be.null;
        expect(result!.display).to.equal("ACTIVE");
    });

    // ── B3: all flags disabled → display is empty string ─────────────────────

    it("returns empty display string when all flags are false", async () => {
        stubAxiosSequence([{ status: 200, data: { FLAG_X: false, FLAG_Y: false } }]);

        const result = await fetchFeatureFlags(makeClient(), FAKE_TOKEN);

        expect(result).to.not.be.null;
        expect(result!.display).to.equal("");
        expect(result!.raw).to.include("FLAG_X");
    });

    // ── B4: empty flags object → display is empty string ─────────────────────

    it("returns empty display string when flags object is empty", async () => {
        stubAxiosSequence([{ status: 200, data: {} }]);

        const result = await fetchFeatureFlags(makeClient(), FAKE_TOKEN);

        expect(result).to.not.be.null;
        expect(result!.display).to.equal("");
        expect(result!.raw).to.equal("{}");
    });

    // ── B5: data guard true-side — null response data → return null ───────────
    // Covers branch 1 (line 57): !data evaluates to true

    it("returns null when response data is null", async () => {
        stubAxiosSequence([{ status: 200, data: null }]);

        const result = await fetchFeatureFlags(makeClient(), FAKE_TOKEN);

        expect(result).to.be.null;
    });

    // ── B6: data guard true-side — array response → return null ──────────────
    // Covers branch 2 (line 57): Array.isArray(data) evaluates to true

    it("returns null when response data is an array (malformed response)", async () => {
        stubAxiosSequence([{ status: 200, data: ["FLAG_A", "FLAG_B"] as unknown as Record<string, boolean> }]);

        const result = await fetchFeatureFlags(makeClient(), FAKE_TOKEN);

        expect(result).to.be.null;
    });

    // ── B7: data guard true-side — non-object primitive → return null ─────────
    // Covers branch 1 alt: typeof data !== "object" for a string

    it("returns null when response data is a string (non-object primitive)", async () => {
        stubAxiosSequence([{ status: 200, data: "not-an-object" as unknown as Record<string, boolean> }]);

        const result = await fetchFeatureFlags(makeClient(), FAKE_TOKEN);

        expect(result).to.be.null;
    });

    // ── B8: data guard true-side — number primitive → return null ────────────

    it("returns null when response data is a number", async () => {
        stubAxiosSequence([{ status: 200, data: 42 as unknown as Record<string, boolean> }]);

        const result = await fetchFeatureFlags(makeClient(), FAKE_TOKEN);

        expect(result).to.be.null;
    });

    // ── B9: catch block — network error → return null ─────────────────────────
    // Covers the catch {} at line 71-73

    it("returns null on network error (axios rejection)", async () => {
        stubAxiosError(503, "Service Unavailable");

        const result = await fetchFeatureFlags(makeClient(), FAKE_TOKEN);

        expect(result).to.be.null;
    });

    // ── B10: catch block — non-200 status rejected by validateStatus → null ───
    // validateStatus: (s) => s === 200 means any non-200 makes axios throw.
    // This exercises both the validateStatus lambda AND the catch path.

    it("returns null on 401 (validateStatus rejects it → catch returns null)", async () => {
        stubAxiosError(401, "Unauthorized");

        const result = await fetchFeatureFlags(makeClient(), FAKE_TOKEN);

        expect(result).to.be.null;
    });

    it("returns null on 404 (validateStatus rejects it → catch returns null)", async () => {
        stubAxiosError(404, "Not Found");

        const result = await fetchFeatureFlags(makeClient(), FAKE_TOKEN);

        expect(result).to.be.null;
    });

    // ── B11: validateStatus called with 200 → accepted (truthy) ──────────────
    // Calling with status=200 should NOT throw; result must be non-null.

    it("accepts 200 response and returns non-null result", async () => {
        stubAxiosSequence([{ status: 200, data: { OK_FLAG: true } }]);

        const result = await fetchFeatureFlags(makeClient(), FAKE_TOKEN);

        expect(result).to.not.be.null;
        expect(result!.display).to.equal("OK_FLAG");
    });

    // ── B12: non-boolean flag values (truthy objects) treated as non-true ─────
    // Covers filter false-side for non-boolean truthy values

    it("excludes flags with non-boolean truthy values (only strict true accepted)", async () => {
        stubAxiosSequence([
            {
                status: 200,
                data: {
                    TRUTHY_STRING: "yes" as unknown as boolean,
                    TRUTHY_NUMBER: 1 as unknown as boolean,
                    REAL_TRUE: true,
                },
            },
        ]);

        const result = await fetchFeatureFlags(makeClient(), FAKE_TOKEN);

        expect(result).to.not.be.null;
        expect(result!.display).to.equal("REAL_TRUE");
    });
});
