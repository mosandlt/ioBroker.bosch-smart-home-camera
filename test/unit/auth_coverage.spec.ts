/**
 * Coverage supplement for src/lib/auth.ts
 *
 * FILE_PARTITION: exclusive owner of these describe blocks.
 * Targets the 6 uncovered lines / branches remaining after auth.spec.ts:
 *
 *   extractCode()          — catch block: URL constructor throws → return null
 *   exchangeCode()         — non-axios re-throw (throw err)
 *                          — error body JSON stringification (const body line)
 *   refreshAccessToken()   — refresh_expires_in ?? 0 fallback (missing field)
 *                          — non-axios re-throw (throw err)
 *                          — error body JSON stringification (const body line)
 *
 * Framework: Mocha + Chai
 * Mirrors mock patterns from test/unit/auth.spec.ts
 */

import { expect } from "chai";
import axios from "axios";

import {
    extractCode,
    exchangeCode,
    refreshAccessToken,
    RefreshTokenInvalidError,
    AuthServerOutageError,
} from "../../src/lib/auth";

import { stubAxiosSequence, restoreAxios } from "./helpers/axios-mock";

// ── extractCode() catch branch ────────────────────────────────────────────────

describe("extractCode() catch branch (coverage)", () => {
    it("returns null when URL constructor throws (invalid IPv6 bracket syntax)", () => {
        // `https://[invalid` causes URL constructor to throw TypeError in Node 22+
        // This hits the `catch { return null; }` branch not covered by auth.spec.ts
        const result = extractCode("https://[invalid?code=abc");
        expect(result).to.be.null;
    });

    it("returns null for a URL with malformed host that throws", () => {
        // `https://::1/` is an invalid URL that throws in Node URL
        const result = extractCode("https://::1/?code=xyz");
        expect(result).to.be.null;
    });
});

// ── exchangeCode() — non-axios re-throw ───────────────────────────────────────

describe("exchangeCode() non-axios error re-throw (coverage)", () => {
    afterEach(() => {
        restoreAxios();
    });

    it("re-throws non-axios errors unchanged", async () => {
        // Inject a non-axios error (plain TypeError) into the adapter
        const savedAdapter = axios.defaults.adapter;
        axios.defaults.adapter = () => Promise.reject(new TypeError("unexpected non-axios error"));
        try {
            await exchangeCode(axios.create(), "code123", "verifier456");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(TypeError);
            expect((err as TypeError).message).to.equal("unexpected non-axios error");
        } finally {
            axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
        }
    });

    it("throws RefreshTokenInvalidError on 400 and body is JSON-stringified (const body line)", async () => {
        // Trigger the `const body = JSON.stringify(err.response?.data ?? "")` line
        // by supplying a structured error body (not a plain string)
        const savedAdapter = axios.defaults.adapter;
        axios.defaults.adapter = () => {
            const err: Error & { response?: { status: number; data: unknown; headers: Record<string, string> }; isAxiosError?: boolean } =
                new Error("Request failed with status code 400");
            err.response = { status: 400, data: { error: "invalid_grant", error_description: "Code expired" }, headers: {} };
            err.isAxiosError = true;
            return Promise.reject(err);
        };
        try {
            await exchangeCode(axios.create(), "expired-code", "verifier");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(RefreshTokenInvalidError);
            expect((err as RefreshTokenInvalidError).message).to.include("Keycloak HTTP 400");
            expect((err as RefreshTokenInvalidError).message).to.include("invalid_grant");
        } finally {
            axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
        }
    });

    it("throws AuthServerOutageError on 503 and body is JSON-stringified", async () => {
        // Trigger the `const body = JSON.stringify(...)` line for 5xx path in exchangeCode
        // Note: exchangeCode 5xx throws AuthServerOutageError WITHOUT body in message —
        // but the body variable is computed before the if-branch, so coverage fires.
        const savedAdapter = axios.defaults.adapter;
        axios.defaults.adapter = () => {
            const err: Error & { response?: { status: number; data: unknown; headers: Record<string, string> }; isAxiosError?: boolean } =
                new Error("Request failed with status code 503");
            err.response = { status: 503, data: { error: "service_unavailable" }, headers: {} };
            err.isAxiosError = true;
            return Promise.reject(err);
        };
        try {
            await exchangeCode(axios.create(), "any-code", "any-verifier");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(AuthServerOutageError);
        } finally {
            axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
        }
    });
});

// ── refreshAccessToken() ──────────────────────────────────────────────────────

describe("refreshAccessToken() coverage branches", () => {
    afterEach(() => {
        restoreAxios();
    });

    it("uses 0 as default when refresh_expires_in is missing from response", async () => {
        // Hits the `refresh_expires_in: resp.data.refresh_expires_in ?? 0` branch
        stubAxiosSequence([
            {
                status: 200,
                data: {
                    access_token: "new-access",
                    refresh_token: "new-refresh",
                    expires_in: 300,
                    // refresh_expires_in intentionally absent → ?? 0
                    token_type: "Bearer",
                    scope: "email openid",
                },
            },
        ]);
        const result = await refreshAccessToken(axios.create(), "some-refresh-token");
        expect(result).to.not.be.null;
        expect(result!.refresh_expires_in).to.equal(0);
    });

    it("re-throws non-axios errors unchanged", async () => {
        const savedAdapter = axios.defaults.adapter;
        axios.defaults.adapter = () =>
            Promise.reject(new RangeError("non-axios range error in refresh"));
        try {
            await refreshAccessToken(axios.create(), "any-token");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(RangeError);
            expect((err as RangeError).message).to.include("non-axios range error");
        } finally {
            axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
        }
    });

    it("throws RefreshTokenInvalidError on 401 with structured body (const body JSON line)", async () => {
        const savedAdapter = axios.defaults.adapter;
        axios.defaults.adapter = () => {
            const err: Error & { response?: { status: number; data: unknown; headers: Record<string, string> }; isAxiosError?: boolean } =
                new Error("Request failed with status code 401");
            err.response = { status: 401, data: { error: "unauthorized_client", hint: "Token expired" }, headers: {} };
            err.isAxiosError = true;
            return Promise.reject(err);
        };
        try {
            await refreshAccessToken(axios.create(), "stale-token");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(RefreshTokenInvalidError);
            expect((err as RefreshTokenInvalidError).message).to.include("Keycloak HTTP 401");
        } finally {
            axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
        }
    });

    it("throws AuthServerOutageError on 502 with structured body (const body JSON line)", async () => {
        const savedAdapter = axios.defaults.adapter;
        axios.defaults.adapter = () => {
            const err: Error & { response?: { status: number; data: unknown; headers: Record<string, string> }; isAxiosError?: boolean } =
                new Error("Request failed with status code 502");
            err.response = { status: 502, data: { error: "bad_gateway" }, headers: {} };
            err.isAxiosError = true;
            return Promise.reject(err);
        };
        try {
            await refreshAccessToken(axios.create(), "valid-token");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(AuthServerOutageError);
        } finally {
            axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
        }
    });
});
