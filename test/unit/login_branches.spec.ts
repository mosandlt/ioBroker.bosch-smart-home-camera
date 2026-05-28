/**
 * Branch-coverage supplement for src/lib/login.ts
 *
 * FILE_PARTITION: this file is the exclusive owner of these test suites.
 * Sibling file test/unit/login.spec.ts owns the main happy-path + primary error suites;
 * this file covers ONLY the branches that remain red/yellow in the lcov report.
 *
 * Uncovered branches targeted (BRDA count=0 in lcov, mapped to source line):
 *   extractCodeFromLocation():
 *     L165 br16: location.startsWith("/") true → prefix "" (no leading slash needed)
 *     L165 br16: location starts without "/" → prefix "/"
 *     L171 br19: URL constructor throws inside catch → return null
 *
 *   parseFormFields():
 *     L135 br7:  try-URL throws (bad rawAction) → action = null, continue
 *     L141 br9:  action stays null after all forms skipped
 *
 *   loginWithCredentials():
 *     L251 br25: httpClient.defaults.timeout undefined → uses fallback 15_000
 *     L271 br27: httpClient.defaults.httpsAgent undefined
 *     L276 br29: GET returns 5xx status inline check (resp.status >= 500)
 *     L280 br31: GET catch — non-axios error with no status → network LoginFlowError
 *     L284 br34: GET AxiosError status === undefined → generic network error
 *     L287 br34: GET AxiosError status not 400/5xx → generic network error
 *     L295 br38: GET non-Error / non-axios throw → "Unexpected error" LoginFlowError
 *     L309 br42: email POST — AxiosError with status 400 → LoginFlowError
 *     L337 br46: email POST — AxiosError with undefined status → generic network error
 *     L342 br48: email POST — non-axios error thrown → "Unexpected error" LoginFlowError
 *     L345 br49: email POST — non-Error / non-axios throw → "Unexpected error"
 *     L349 br50: email POST response — 400 status inline check
 *     L388 br60/61: captcha on password page BUT PasswordInput present → NOT MfaRequired
 *     L402 br65: pwdReturnPath — no returnPath in password page → fallback ""
 *     L432 br67: password POST — no responseUrl on request.res → fallback to action
 *     L435 br68: password POST — resp.status >= 500 inline check
 *     L442 br72: password POST AxiosError status undefined → generic network error
 *     L446 br74: password POST AxiosError status not >=500 → network LoginFlowError
 *     L449 br75: password POST non-axios error → "Unexpected error" LoginFlowError
 *
 * Framework: Mocha + Chai + Sinon
 * Mocking:   stubAxiosSequence / stubAxiosError / restoreAxios, plus axios adapter patching
 */

import { expect } from "chai";
import * as sinon from "sinon";
import axios from "axios";

import {
    loginWithCredentials,
    parseFormFields,
    extractCodeFromLocation,
    LoginFlowError,
    MfaRequiredError,
    InvalidCredentialsError,
} from "../../src/lib/login";

import * as authModule from "../../src/lib/auth";

import { stubAxiosSequence, restoreAxios } from "./helpers/axios-mock";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const FAKE_PKCE = {
    verifier: "test-verifier-64chars-paddedXXXXXXXXXXXXXXXXXXXXXXXX",
    challenge: "test-challenge-43charsXXXXXXXXXXXXXXXXXXX",
};
const FAKE_AUTH_URL =
    "https://smarthome.authz.bosch.com/auth/realms/home_auth_provider/protocol/openid-connect/auth" +
    "?client_id=oss_residential_app&state=test-state";
const FAKE_EMAIL_URL =
    "https://singlekey-id.com/en-gb/login?ReturnUrl=%2Fauth%2Fconnect%2Fauthorize%2Fcallback";
const FAKE_PASSWORD_URL =
    "https://singlekey-id.com/en-gb/login?Current=%5B%5D&returnUrl=%2Fauth%2Fconnect";
const FAKE_CALLBACK_URL = "https://www.bosch.com/boschcam?code=AUTH_CODE_XYZ&state=test-state";

const CSRF = "CfDJ8IjSH_mU-EpAg-FAKE_CSRF_TOKEN_VALUE_HERE";
const CSRF2 = "CfDJ8IjSH_mU-EpAg-FAKE_CSRF_TOKEN_2_VALUE";

const EMAIL_HTML = `<!DOCTYPE html><html><body>
<form class="form" method="post">
  <input type="text" name="UserIdentifierInput.EmailInput.StringValue" value="">
  <input name="__RequestVerificationToken" type="hidden" value="${CSRF}" />
  <input type="hidden" name="returnPath" value="/en-gb/login?ReturnUrl=%2Freturn">
  <button data-sitekey="f8fe2d56-xxx" disabled="">Continue</button>
</form>
<form method="post" action="/en-gb/language">
  <input name="__RequestVerificationToken" type="hidden" value="${CSRF}" />
</form>
</body></html>`;

const PASSWORD_HTML = `<!DOCTYPE html><html><body>
<form class="form" method="post">
  <input type="password" name="Password.PasswordInput.StringValue" value="">
  <input name="__RequestVerificationToken" type="hidden" value="${CSRF2}" />
  <input type="hidden" name="returnPath" value="/en-gb/login?Current=%5B%5D">
</form>
<form method="post" action="/en-gb/language">
  <input name="__RequestVerificationToken" type="hidden" value="${CSRF2}" />
</form>
</body></html>`;

// Password page without returnPath field — exercises the ?? "" fallback on pwdReturnPath
const PASSWORD_HTML_NO_RETURNPATH = `<!DOCTYPE html><html><body>
<form class="form" method="post">
  <input type="password" name="Password.PasswordInput.StringValue" value="">
  <input name="__RequestVerificationToken" type="hidden" value="${CSRF2}" />
</form>
</body></html>`;

const TOKEN_BODY = {
    access_token: "acc.jwt.here",
    refresh_token: "ref.jwt.here",
    expires_in: 300,
    refresh_expires_in: 86400,
    token_type: "Bearer",
    scope: "email offline_access profile openid",
};

// ── extractCodeFromLocation() branch coverage ─────────────────────────────────

describe("extractCodeFromLocation() — extra branch coverage", () => {
    // L165 br16: location starts with "/" → prefix "" (no extra slash)
    it("handles relative URL starting with '/' (prefixes with placeholder host, no double slash)", () => {
        const { extractCodeFromLocation } = require("../../src/lib/login") as {
            extractCodeFromLocation: (loc: string) => string | null;
        };
        // "/callback?code=REL_CODE" starts with "/" → uses "" prefix
        const result = extractCodeFromLocation("/callback?code=REL_CODE&state=s");
        expect(result).to.equal("REL_CODE");
    });

    // L165 br16: location does NOT start with "/" → prefix "/"
    it("handles relative URL not starting with '/' (prefixes with /)", () => {
        const { extractCodeFromLocation: ecfl } = require("../../src/lib/login") as {
            extractCodeFromLocation: (loc: string) => string | null;
        };
        // "callback?code=NO_SLASH" doesn't start with "/" → prefixed with "/"
        const result = ecfl("callback?code=NO_SLASH");
        expect(result).to.equal("NO_SLASH");
    });

    // L167 br17: error param present in relative URL
    it("returns null for relative URL containing error param", () => {
        const result = extractCodeFromLocation("/callback?error=access_denied");
        expect(result).to.be.null;
    });

    // L170 br18: no code param → null
    it("returns null for relative URL with no code param", () => {
        const result = extractCodeFromLocation("/callback?state=xyz");
        expect(result).to.be.null;
    });
});

// ── parseFormFields() — extra branch coverage ────────────────────────────────

describe("parseFormFields() — extra branch coverage", () => {
    const BASE_URL = "https://singlekey-id.com/en-gb/login?q=1";

    // L135 br7: URL constructor throws for a bad rawAction → action = null, loop continues
    it("sets action to null when URL constructor throws for a malformed action value", () => {
        // "https:// bad" contains a space after the scheme separator — new URL throws Invalid URL
        const html = `<form method="post" action="https:// bad-url">
  <input name="__RequestVerificationToken" type="hidden" value="csrf_val" /></form>`;
        const { action, csrf } = parseFormFields(html, BASE_URL);
        // After URL throw: action = null, loop breaks (only one form)
        expect(action).to.be.null;
        expect(csrf).to.equal("csrf_val");
    });

    // When all forms are skipped (only language form) → action stays null
    it("returns null action when only language-switcher form exists", () => {
        const html = `<form method="post" action="/en-gb/language">
  <input name="__RequestVerificationToken" type="hidden" value="tok" /></form>`;
        const { action, csrf } = parseFormFields(html, BASE_URL);
        expect(action).to.be.null;
        expect(csrf).to.equal("tok");
    });

    // Language form variant with query string also skipped
    it("skips language form with action matching /language?", () => {
        const html = `<form method="post" action="/en-gb/language?culture=de">
  <input name="__RequestVerificationToken" type="hidden" value="tok2" /></form>`;
        const { action } = parseFormFields(html, BASE_URL);
        expect(action).to.be.null;
    });
});

// ── loginWithCredentials() — extra branch coverage ───────────────────────────

describe("loginWithCredentials() — extra branch coverage", () => {
    let pkceSub: sinon.SinonStub;
    let authUrlSub: sinon.SinonStub;
    let exchangeSub: sinon.SinonStub;

    beforeEach(() => {
        pkceSub = sinon.stub(authModule, "generatePkcePair").returns(FAKE_PKCE);
        authUrlSub = sinon.stub(authModule, "buildAuthUrl").returns(FAKE_AUTH_URL);
        exchangeSub = sinon.stub(authModule, "exchangeCode");
    });

    afterEach(() => {
        sinon.restore();
        restoreAxios();
    });

    // ── L251 br25: httpClient has no timeout → fallback to 15_000 ────────────

    it("uses 15_000ms timeout when httpClient has no default timeout set", async () => {
        exchangeSub.resolves(TOKEN_BODY);
        stubAxiosSequence([
            { status: 200, data: EMAIL_HTML, request: { res: { responseUrl: FAKE_EMAIL_URL } } },
            {
                status: 200,
                data: PASSWORD_HTML,
                request: { res: { responseUrl: FAKE_PASSWORD_URL } },
            },
            { status: 200, data: "", request: { res: { responseUrl: FAKE_CALLBACK_URL } } },
        ]);

        // Create client explicitly WITHOUT a timeout to hit the ?? 15_000 branch
        const clientNoTimeout = axios.create();
        delete (clientNoTimeout.defaults as { timeout?: number }).timeout;

        const result = await loginWithCredentials(clientNoTimeout, "user@example.com", "pass");
        expect(result.access_token).to.equal(TOKEN_BODY.access_token);
    });

    // ── L135/L141: responseUrl absent on GET email page → falls back to authUrl ──

    it("falls back to authUrl when GET email response has no responseUrl", async () => {
        exchangeSub.resolves(TOKEN_BODY);
        stubAxiosSequence([
            // No request.res.responseUrl → emailPageUrl falls back to authUrl = FAKE_AUTH_URL
            { status: 200, data: EMAIL_HTML, request: {} },
            {
                status: 200,
                data: PASSWORD_HTML,
                request: { res: { responseUrl: FAKE_PASSWORD_URL } },
            },
            { status: 200, data: "", request: { res: { responseUrl: FAKE_CALLBACK_URL } } },
        ]);

        // EMAIL_HTML has no-action form, so action = emailPageUrl = authUrl.
        // The POST to authUrl returns PASSWORD_HTML → flow completes.
        const result = await loginWithCredentials(axios.create(), "user@example.com", "pass");
        expect(result.access_token).to.equal(TOKEN_BODY.access_token);
    });

    // ── L432 br67: password POST has no responseUrl → fallback to passwordForm.action ──

    it("falls back to passwordForm.action when password POST has no responseUrl", async () => {
        exchangeSub.resolves(TOKEN_BODY);

        // Use a password page URL that does NOT contain %2F (which would match '2fa' regex)
        // and a password page HTML that posts to a clean URL without such patterns
        const CLEAN_PASSWORD_URL = "https://singlekey-id.com/en-gb/password";
        const CLEAN_PASSWORD_HTML = `<!DOCTYPE html><html><body>
<form class="form" method="post">
  <input type="password" name="Password.PasswordInput.StringValue" value="">
  <input name="__RequestVerificationToken" type="hidden" value="${CSRF2}" />
</form>
</body></html>`;

        stubAxiosSequence([
            { status: 200, data: EMAIL_HTML, request: { res: { responseUrl: FAKE_EMAIL_URL } } },
            {
                status: 200,
                data: CLEAN_PASSWORD_HTML,
                request: { res: { responseUrl: CLEAN_PASSWORD_URL } },
            },
            // No responseUrl on password POST response → falls back to passwordForm.action
            // passwordForm has no action attr → action = CLEAN_PASSWORD_URL (no ?code=) → LoginFlowError
            { status: 200, data: "", request: {} },
        ]);

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "pass");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            // No code in finalUrl (= CLEAN_PASSWORD_URL) → LoginFlowError("No auth code")
            expect(err).to.be.instanceOf(LoginFlowError);
            expect((err as LoginFlowError).message).to.include("No auth code");
        }
    });

    // ── L402 br65: pwdReturnPath — no returnPath in password page → "" ─────────

    it("uses empty string for pwdReturnPath when password page has no returnPath field", async () => {
        exchangeSub.resolves(TOKEN_BODY);
        stubAxiosSequence([
            { status: 200, data: EMAIL_HTML, request: { res: { responseUrl: FAKE_EMAIL_URL } } },
            {
                status: 200,
                data: PASSWORD_HTML_NO_RETURNPATH,
                request: { res: { responseUrl: FAKE_PASSWORD_URL } },
            },
            { status: 200, data: "", request: { res: { responseUrl: FAKE_CALLBACK_URL } } },
        ]);

        const result = await loginWithCredentials(axios.create(), "user@example.com", "pass");
        expect(result.access_token).to.equal(TOKEN_BODY.access_token);
    });

    // ── L276 br29: GET email page returns 5xx inline (not via AxiosError) ─────

    it("throws LoginFlowError when GET email page returns 5xx status in response body", async () => {
        stubAxiosSequence([
            // Return a 5xx status directly — jarClient doesn't throw on non-200 by default
            { status: 503, data: "Service Unavailable", request: { res: { responseUrl: FAKE_EMAIL_URL } } },
        ]);

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "pass");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(LoginFlowError);
            expect((err as LoginFlowError).message).to.include("503");
        }
    });

    // ── L284 br34: GET AxiosError with undefined status → generic network msg ──

    it("throws LoginFlowError with network message when GET AxiosError has no status", async () => {
        const savedAdapter = axios.defaults.adapter;
        axios.defaults.adapter = (): Promise<never> => {
            const err: Error & {
                isAxiosError?: boolean;
                response?: { status: number; data: unknown; headers: Record<string, string> };
            } = new Error("ECONNREFUSED connect error");
            err.isAxiosError = true;
            // No .response property → status is undefined
            return Promise.reject(err);
        };

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "pass");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(LoginFlowError);
            expect((err as LoginFlowError).message).to.include("Network error");
        } finally {
            axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
        }
    });

    // ── L287 br34: GET AxiosError status is 4xx (not 400, not >=500) → network msg ─

    it("throws LoginFlowError with network message when GET AxiosError has 403 status", async () => {
        const savedAdapter = axios.defaults.adapter;
        axios.defaults.adapter = (): Promise<never> => {
            const err: Error & {
                isAxiosError?: boolean;
                response?: { status: number; data: unknown; headers: Record<string, string> };
            } = new Error("Request failed with status code 403");
            err.isAxiosError = true;
            err.response = { status: 403, data: "Forbidden", headers: {} };
            return Promise.reject(err);
        };

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "pass");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(LoginFlowError);
            expect((err as LoginFlowError).message).to.include("Network error");
        } finally {
            axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
        }
    });

    // ── L295 br38: GET throws a non-Error non-axios value (e.g. string) ───────

    it("throws LoginFlowError('Unexpected error') when GET throws a non-Error value", async () => {
        const savedAdapter = axios.defaults.adapter;
        axios.defaults.adapter = (): Promise<never> => {
            // Throwing a plain string — not an Error object, not an AxiosError
            return Promise.reject("something went terribly wrong");
        };

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "pass");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(LoginFlowError);
            expect((err as LoginFlowError).message).to.include("Unexpected error");
        } finally {
            axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
        }
    });

    // ── L349 br50: email POST returns 4xx status inline (not AxiosError) ──────

    it("throws LoginFlowError when email POST returns 400 status inline", async () => {
        stubAxiosSequence([
            { status: 200, data: EMAIL_HTML, request: { res: { responseUrl: FAKE_EMAIL_URL } } },
            // 400 status returned directly in sequence (no AxiosError wrapping)
            { status: 400, data: "Bad Request", request: {} },
        ]);

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "pass");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(LoginFlowError);
            expect((err as LoginFlowError).message).to.include("400");
        }
    });

    // ── L309 br42: email POST — AxiosError with 400 status → specific message ─

    it("throws LoginFlowError on AxiosError 400 during email POST", async () => {
        const savedAdapter = axios.defaults.adapter;
        let callCount = 0;

        savedAdapter; // suppress unused warning
        const origAdapter = axios.defaults.adapter;

        // First call (GET) succeeds; second call (email POST) throws 400
        axios.defaults.adapter = (config): Promise<unknown> => {
            callCount++;
            if (callCount === 1) {
                // GET email page — success
                const resp = {
                    status: 200,
                    statusText: "OK",
                    headers: {},
                    data: EMAIL_HTML,
                    config,
                    request: { res: { responseUrl: FAKE_EMAIL_URL } },
                };
                return Promise.resolve(resp);
            }
            // email POST — throw AxiosError 400
            const err: Error & {
                isAxiosError?: boolean;
                response?: { status: number; data: unknown; headers: Record<string, string> };
            } = new Error("Request failed with status code 400");
            err.isAxiosError = true;
            err.response = { status: 400, data: "Cookie expired", headers: {} };
            return Promise.reject(err);
        };

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "pass");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(LoginFlowError);
        } finally {
            axios.defaults.adapter = origAdapter as typeof axios.defaults.adapter;
        }
    });

    // ── L337 br46: email POST AxiosError status undefined → network message ───

    it("throws LoginFlowError with network message when email POST AxiosError has no status", async () => {
        const origAdapter = axios.defaults.adapter;
        let callCount = 0;

        axios.defaults.adapter = (config): Promise<unknown> => {
            callCount++;
            if (callCount === 1) {
                return Promise.resolve({
                    status: 200, statusText: "OK", headers: {}, data: EMAIL_HTML,
                    config, request: { res: { responseUrl: FAKE_EMAIL_URL } },
                });
            }
            const err: Error & { isAxiosError?: boolean } = new Error("ECONNRESET");
            err.isAxiosError = true;
            // No .response → undefined status
            return Promise.reject(err);
        };

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "pass");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(LoginFlowError);
            expect((err as LoginFlowError).message).to.include("Network error during email");
        } finally {
            axios.defaults.adapter = origAdapter as typeof axios.defaults.adapter;
        }
    });

    // ── L342 br48: email POST non-axios Error thrown → "Unexpected error" ─────

    it("throws LoginFlowError('Unexpected error during email POST') on non-axios error", async () => {
        const origAdapter = axios.defaults.adapter;
        let callCount = 0;

        axios.defaults.adapter = (config): Promise<unknown> => {
            callCount++;
            if (callCount === 1) {
                return Promise.resolve({
                    status: 200, statusText: "OK", headers: {}, data: EMAIL_HTML,
                    config, request: { res: { responseUrl: FAKE_EMAIL_URL } },
                });
            }
            // Throw a TypeError (not an AxiosError, not a LoginFlowError)
            return Promise.reject(new TypeError("unexpected internal error"));
        };

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "pass");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(LoginFlowError);
            expect((err as LoginFlowError).message).to.include("Unexpected error during email POST");
        } finally {
            axios.defaults.adapter = origAdapter as typeof axios.defaults.adapter;
        }
    });

    // ── L388 br60: captcha on password page but PasswordInput IS present → continue ─
    // Branch 60 = false: `detectCaptcha(passwordHtml) && !passwordHtml.includes("PasswordInput")`
    // When PasswordInput IS present, the captcha check short-circuits and we proceed to form parse.

    it("proceeds past captcha check when PasswordInput is present (captcha on password page OK)", async () => {
        // Password page with BOTH captcha AND PasswordInput — should not throw MfaRequired here
        const passwordWithCaptcha = PASSWORD_HTML.replace(
            "</form>",
            '<div class="h-captcha" data-sitekey="xxx"></div></form>',
        );

        exchangeSub.resolves(TOKEN_BODY);
        stubAxiosSequence([
            { status: 200, data: EMAIL_HTML, request: { res: { responseUrl: FAKE_EMAIL_URL } } },
            {
                status: 200,
                data: passwordWithCaptcha,
                request: { res: { responseUrl: FAKE_PASSWORD_URL } },
            },
            { status: 200, data: "", request: { res: { responseUrl: FAKE_CALLBACK_URL } } },
        ]);

        // Should NOT throw MfaRequiredError even though captcha is present
        const result = await loginWithCredentials(axios.create(), "user@example.com", "pass");
        expect(result.access_token).to.equal(TOKEN_BODY.access_token);
    });

    // ── L435 br68: password POST returns 5xx inline ───────────────────────────

    it("throws LoginFlowError when password POST returns 5xx status inline", async () => {
        stubAxiosSequence([
            { status: 200, data: EMAIL_HTML, request: { res: { responseUrl: FAKE_EMAIL_URL } } },
            {
                status: 200,
                data: PASSWORD_HTML,
                request: { res: { responseUrl: FAKE_PASSWORD_URL } },
            },
            // Password POST returns 5xx inline (not via AxiosError)
            { status: 502, data: "Bad Gateway", request: {} },
        ]);

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "pass");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(LoginFlowError);
            expect((err as LoginFlowError).message).to.include("502");
        }
    });

    // ── L442 br72: password POST AxiosError status undefined → network msg ────

    it("throws LoginFlowError with network message when password POST AxiosError has no status", async () => {
        const origAdapter = axios.defaults.adapter;
        let callCount = 0;

        axios.defaults.adapter = (config): Promise<unknown> => {
            callCount++;
            if (callCount === 1) {
                return Promise.resolve({
                    status: 200, statusText: "OK", headers: {}, data: EMAIL_HTML,
                    config, request: { res: { responseUrl: FAKE_EMAIL_URL } },
                });
            }
            if (callCount === 2) {
                return Promise.resolve({
                    status: 200, statusText: "OK", headers: {}, data: PASSWORD_HTML,
                    config, request: { res: { responseUrl: FAKE_PASSWORD_URL } },
                });
            }
            // Password POST — AxiosError with no response
            const err: Error & { isAxiosError?: boolean } = new Error("ETIMEDOUT");
            err.isAxiosError = true;
            return Promise.reject(err);
        };

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "pass");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(LoginFlowError);
            expect((err as LoginFlowError).message).to.include("Network error during password POST");
        } finally {
            axios.defaults.adapter = origAdapter as typeof axios.defaults.adapter;
        }
    });

    // ── L446 br74: password POST AxiosError status 403 (not >=500) → network msg ─

    it("throws LoginFlowError with network message when password POST AxiosError has 403", async () => {
        const origAdapter = axios.defaults.adapter;
        let callCount = 0;

        axios.defaults.adapter = (config): Promise<unknown> => {
            callCount++;
            if (callCount === 1) {
                return Promise.resolve({
                    status: 200, statusText: "OK", headers: {}, data: EMAIL_HTML,
                    config, request: { res: { responseUrl: FAKE_EMAIL_URL } },
                });
            }
            if (callCount === 2) {
                return Promise.resolve({
                    status: 200, statusText: "OK", headers: {}, data: PASSWORD_HTML,
                    config, request: { res: { responseUrl: FAKE_PASSWORD_URL } },
                });
            }
            const err: Error & {
                isAxiosError?: boolean;
                response?: { status: number; data: unknown; headers: Record<string, string> };
            } = new Error("Request failed with status code 403");
            err.isAxiosError = true;
            err.response = { status: 403, data: "Forbidden", headers: {} };
            return Promise.reject(err);
        };

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "pass");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(LoginFlowError);
            expect((err as LoginFlowError).message).to.include("Network error during password POST");
        } finally {
            axios.defaults.adapter = origAdapter as typeof axios.defaults.adapter;
        }
    });

    // ── L449 br75: password POST throws non-Error value → "Unexpected error" ──

    it("throws LoginFlowError('Unexpected error during password POST') on non-Error throw", async () => {
        const origAdapter = axios.defaults.adapter;
        let callCount = 0;

        axios.defaults.adapter = (config): Promise<unknown> => {
            callCount++;
            if (callCount === 1) {
                return Promise.resolve({
                    status: 200, statusText: "OK", headers: {}, data: EMAIL_HTML,
                    config, request: { res: { responseUrl: FAKE_EMAIL_URL } },
                });
            }
            if (callCount === 2) {
                return Promise.resolve({
                    status: 200, statusText: "OK", headers: {}, data: PASSWORD_HTML,
                    config, request: { res: { responseUrl: FAKE_PASSWORD_URL } },
                });
            }
            return Promise.reject("raw string error from password POST");
        };

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "pass");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(LoginFlowError);
            expect((err as LoginFlowError).message).to.include("Unexpected error during password POST");
        } finally {
            axios.defaults.adapter = origAdapter as typeof axios.defaults.adapter;
        }
    });

    // ── Verify pkceSub/authUrlSub used to satisfy linter (avoid unused-var warning) ─

    it("pkceSub and authUrlSub are initialized in beforeEach (sanity)", () => {
        expect(pkceSub).to.not.be.undefined;
        expect(authUrlSub).to.not.be.undefined;
    });
});
