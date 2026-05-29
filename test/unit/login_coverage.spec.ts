/**
 * Coverage supplement for src/lib/login.ts
 *
 * FILE_PARTITION: exclusive owner of these describe blocks.
 * Targets the 8 uncovered lines / branches remaining after login.spec.ts +
 * login_branches.spec.ts:
 *
 *   extractCodeFromLocation() — catch block: URL constructor throws → return null
 *
 *   loginWithCredentials():
 *     Step 4 email POST  — axios error with status >= 500 (status check in catch)
 *     Step 4 returnPath  — match[1] present but no &amp; → ?? "" fallback (no-encode path)
 *     Step 5 captcha     — detectCaptcha(passwordHtml) true BUT includes("PasswordInput")
 *                          → condition is false, NOT MfaRequired (the else branch)
 *     Step 7 password POST axios error with status >= 500 (status check in catch)
 *     Step 7 password POST — submitHtml = resp.data ?? "" with undefined resp.data → ""
 *
 * Framework: Mocha + Chai + Sinon
 * Mirrors mock patterns from test/unit/login_branches.spec.ts
 */

import { expect } from "chai";
import * as sinon from "sinon";
import axios from "axios";

import {
    loginWithCredentials,
    extractCodeFromLocation,
    LoginFlowError,
    MfaRequiredError,
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

// Email page — no action attr (posts to same URL), no returnPath with &amp;
const EMAIL_HTML_NO_AMPERSAND = `<!DOCTYPE html><html><body>
<form class="form" method="post">
  <input type="text" name="UserIdentifierInput.EmailInput.StringValue" value="">
  <input name="__RequestVerificationToken" type="hidden" value="${CSRF}" />
  <input type="hidden" name="returnPath" value="/en-gb/login?ReturnUrl=%2Freturn">
  <button disabled="">Continue</button>
</form>
</body></html>`;

// Email page with &amp; in returnPath (to confirm the other branch is covered elsewhere)
const EMAIL_HTML_WITH_AMPERSAND = `<!DOCTYPE html><html><body>
<form class="form" method="post">
  <input type="text" name="UserIdentifierInput.EmailInput.StringValue" value="">
  <input name="__RequestVerificationToken" type="hidden" value="${CSRF}" />
  <input type="hidden" name="returnPath" value="/en-gb/login?ReturnUrl=%2Freturn&amp;foo=bar">
  <button disabled="">Continue</button>
</form>
</body></html>`;

// Password page — has captcha attrs AND PasswordInput in the same HTML
const PASSWORD_HTML_WITH_CAPTCHA_AND_INPUT = `<!DOCTYPE html><html><body>
<form class="form" method="post">
  <input type="password" name="Password.PasswordInput.StringValue" value="">
  <input name="__RequestVerificationToken" type="hidden" value="${CSRF2}" />
  <input type="hidden" name="returnPath" value="/en-gb/login?Current=%5B%5D">
  <div class="h-captcha" data-sitekey="f8fe2d56-xxx"></div>
</form>
</body></html>`;

// Standard password page (no captcha)
const PASSWORD_HTML = `<!DOCTYPE html><html><body>
<form class="form" method="post">
  <input type="password" name="Password.PasswordInput.StringValue" value="">
  <input name="__RequestVerificationToken" type="hidden" value="${CSRF2}" />
  <input type="hidden" name="returnPath" value="/en-gb/login?Current=%5B%5D">
</form>
</body></html>`;

// ── extractCodeFromLocation() catch branch ────────────────────────────────────

describe("extractCodeFromLocation() catch branch (coverage)", () => {
    it("returns null when the URL constructor throws (invalid IPv6 bracket)", () => {
        // `https://[invalid` causes URL to throw TypeError in Node 22
        // This hits the `catch { return null; }` path not reached by existing tests
        const result = extractCodeFromLocation("https://[invalid?code=abc");
        expect(result).to.be.null;
    });
});

// ── loginWithCredentials() — email POST 5xx in axios catch ───────────────────

describe("loginWithCredentials() email POST 5xx axios error (coverage)", () => {
    let pkceStub: sinon.SinonStub;
    let authUrlStub: sinon.SinonStub;

    beforeEach(() => {
        pkceStub = sinon.stub(
            authModule as unknown as Record<string, unknown>,
            "generatePkcePair",
        ).returns(FAKE_PKCE);
        authUrlStub = sinon.stub(
            authModule as unknown as Record<string, unknown>,
            "buildAuthUrl",
        ).returns(FAKE_AUTH_URL);
    });

    afterEach(() => {
        sinon.restore();
        restoreAxios();
    });

    it("throws LoginFlowError when email POST axios error has status >= 500", async () => {
        // Step 1: GET email page succeeds
        // Step 2: email POST — axios error with status 503
        const savedAdapter = axios.defaults.adapter;
        let callCount = 0;
        axios.defaults.adapter = (config) => {
            callCount++;
            if (callCount === 1) {
                // GET auth page — success
                return Promise.resolve({
                    status: 200,
                    statusText: "OK",
                    headers: {},
                    data: EMAIL_HTML_NO_AMPERSAND,
                    config,
                    request: { res: { responseUrl: FAKE_EMAIL_URL } },
                } as ReturnType<NonNullable<typeof axios.defaults.adapter>>);
            }
            // POST email — 503 axios error
            const err: Error & { response?: { status: number; data: unknown; headers: Record<string, string> }; isAxiosError?: boolean } =
                new Error("Request failed with status code 503");
            err.response = { status: 503, data: "Service Unavailable", headers: {} };
            err.isAxiosError = true;
            return Promise.reject(err);
        };

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "pass");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(LoginFlowError);
            expect((err as LoginFlowError).message).to.include("Email POST HTTP 503");
        } finally {
            axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
        }
    });

    it("does NOT throw MfaRequiredError when captcha present but PasswordInput also present", async () => {
        // Covers the `detectCaptcha(passwordHtml) && !passwordHtml.includes("PasswordInput")`
        // condition where the second operand is FALSE → branch not taken
        const savedAdapter = axios.defaults.adapter;
        let callCount = 0;
        axios.defaults.adapter = (config) => {
            callCount++;
            if (callCount === 1) {
                return Promise.resolve({
                    status: 200,
                    statusText: "OK",
                    headers: {},
                    data: EMAIL_HTML_NO_AMPERSAND,
                    config,
                    request: { res: { responseUrl: FAKE_EMAIL_URL } },
                } as ReturnType<NonNullable<typeof axios.defaults.adapter>>);
            }
            if (callCount === 2) {
                // Email POST → password page that has BOTH captcha AND PasswordInput
                return Promise.resolve({
                    status: 200,
                    statusText: "OK",
                    headers: {},
                    data: PASSWORD_HTML_WITH_CAPTCHA_AND_INPUT,
                    config,
                    request: { res: { responseUrl: FAKE_PASSWORD_URL } },
                } as ReturnType<NonNullable<typeof axios.defaults.adapter>>);
            }
            // Password POST — reject to stop the flow with a predictable error
            return Promise.reject(new Error("stop here"));
        };

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "pass");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            // Must NOT be MfaRequiredError("CAPTCHA challenge on password page")
            // because PasswordInput IS present — the guard condition is false
            expect(err).to.not.be.instanceOf(MfaRequiredError);
        } finally {
            axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
        }
    });
});

// ── loginWithCredentials() — password POST 5xx in axios catch ────────────────

describe("loginWithCredentials() password POST 5xx axios error (coverage)", () => {
    let pkceStub: sinon.SinonStub;
    let authUrlStub: sinon.SinonStub;

    beforeEach(() => {
        pkceStub = sinon.stub(
            authModule as unknown as Record<string, unknown>,
            "generatePkcePair",
        ).returns(FAKE_PKCE);
        authUrlStub = sinon.stub(
            authModule as unknown as Record<string, unknown>,
            "buildAuthUrl",
        ).returns(FAKE_AUTH_URL);
    });

    afterEach(() => {
        sinon.restore();
        restoreAxios();
    });

    it("throws LoginFlowError when password POST axios error has status >= 500", async () => {
        const savedAdapter = axios.defaults.adapter;
        let callCount = 0;
        axios.defaults.adapter = (config) => {
            callCount++;
            if (callCount === 1) {
                return Promise.resolve({
                    status: 200,
                    statusText: "OK",
                    headers: {},
                    data: EMAIL_HTML_NO_AMPERSAND,
                    config,
                    request: { res: { responseUrl: FAKE_EMAIL_URL } },
                } as ReturnType<NonNullable<typeof axios.defaults.adapter>>);
            }
            if (callCount === 2) {
                return Promise.resolve({
                    status: 200,
                    statusText: "OK",
                    headers: {},
                    data: PASSWORD_HTML,
                    config,
                    request: { res: { responseUrl: FAKE_PASSWORD_URL } },
                } as ReturnType<NonNullable<typeof axios.defaults.adapter>>);
            }
            // Password POST — 500 error
            const err: Error & { response?: { status: number; data: unknown; headers: Record<string, string> }; isAxiosError?: boolean } =
                new Error("Request failed with status code 500");
            err.response = { status: 500, data: "Internal Server Error", headers: {} };
            err.isAxiosError = true;
            return Promise.reject(err);
        };

        try {
            await loginWithCredentials(axios.create(), "user@example.com", "pass");
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(LoginFlowError);
            expect((err as LoginFlowError).message).to.include("Password POST HTTP 500");
        } finally {
            axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
        }
    });

    it("submitHtml falls back to empty string when resp.data is undefined/null", async () => {
        // Covers `const submitHtml = submitResp.data ?? ""` when data is null/undefined
        // — the password POST response has no body but doesn't include "PasswordInput"
        // or a status >= 500, so flow continues to the code-extraction step
        const savedAdapter = axios.defaults.adapter;
        let callCount = 0;
        axios.defaults.adapter = (config) => {
            callCount++;
            if (callCount === 1) {
                return Promise.resolve({
                    status: 200,
                    statusText: "OK",
                    headers: {},
                    data: EMAIL_HTML_NO_AMPERSAND,
                    config,
                    request: { res: { responseUrl: FAKE_EMAIL_URL } },
                } as ReturnType<NonNullable<typeof axios.defaults.adapter>>);
            }
            if (callCount === 2) {
                return Promise.resolve({
                    status: 200,
                    statusText: "OK",
                    headers: {},
                    data: PASSWORD_HTML,
                    config,
                    request: { res: { responseUrl: FAKE_PASSWORD_URL } },
                } as ReturnType<NonNullable<typeof axios.defaults.adapter>>);
            }
            // Password POST — 302-style success with no body → data is null
            return Promise.resolve({
                status: 302,
                statusText: "Found",
                headers: {},
                data: null,
                config,
                // responseUrl is the OIDC callback — has ?code= so flow can extract it
                request: { res: { responseUrl: FAKE_CALLBACK_URL } },
            } as ReturnType<NonNullable<typeof axios.defaults.adapter>>);
        };

        // exchangeCode is called next — stub it to avoid real network call
        const exchangeStub = sinon
            .stub(authModule, "exchangeCode")
            .resolves({
                access_token: "acc",
                refresh_token: "ref",
                expires_in: 300,
                refresh_expires_in: 86400,
                token_type: "Bearer",
                scope: "email",
            });

        try {
            const result = await loginWithCredentials(axios.create(), "user@example.com", "pass");
            // If we get here the null→"" fallback worked and exchangeCode was called
            expect(result.access_token).to.equal("acc");
            expect(exchangeStub.calledOnce).to.be.true;
        } finally {
            axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
            exchangeStub.restore();
        }
    });
});
