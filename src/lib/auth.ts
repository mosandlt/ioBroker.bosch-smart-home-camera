/**
 * Bosch OAuth2 PKCE Authentication
 *
 * Port of the Python config_flow.py OAuth2 implementation to TypeScript.
 *
 * Flow overview (from Python reference):
 *   Issuer:       https://smarthome.authz.bosch.com/auth/realms/home_auth_provider
 *   Client ID:    oss_residential_app
 *   Client Secret: decoded from base64 "RjFqWnpzRzVOdHc3eDJWVmM4SjZxZ3NuaXNNT2ZhWmc="
 *   Scopes:       email offline_access profile openid
 *   Redirect URI: https://my.home-assistant.io/redirect/oauth (HA flow)
 *                 https://www.bosch.com/boschcam (manual/ioBroker flow)
 *
 * PKCE (RFC 7636):
 *   code_verifier  = crypto.randomBytes(64).toString('base64url')
 *   code_challenge = base64url(sha256(verifier))  [S256 method]
 *
 * Token exchange:
 *   POST {KEYCLOAK_BASE}/token
 *   body: client_id, client_secret, grant_type=authorization_code,
 *         code, redirect_uri, code_verifier
 *
 * Token refresh:
 *   POST {KEYCLOAK_BASE}/token
 *   body: client_id, client_secret, grant_type=refresh_token, refresh_token
 *
 * Error handling:
 *   HTTP 400/401 → RefreshTokenInvalidError (non-recoverable, need re-login)
 *   HTTP 5xx     → AuthServerOutageError (retry later, do NOT force re-login)
 */

import * as crypto from "node:crypto";
import * as https from "node:https";
import type { Duplex } from "node:stream";
import * as tls from "node:tls";
import axios, { type AxiosInstance } from "axios";

// ── Constants (from Python config_flow.py) ────────────────────────────────────

export const KEYCLOAK_BASE =
    "https://smarthome.authz.bosch.com" + "/auth/realms/home_auth_provider/protocol/openid-connect";

export const CLIENT_ID = "oss_residential_app";

/** Decoded from base64 — same value as Python config_flow.py CLIENT_SECRET */
export const CLIENT_SECRET = Buffer.from(
    "RjFqWnpzRzVOdHc3eDJWVmM4SjZxZ3NuaXNNT2ZhWmc=",
    "base64",
).toString("utf-8");

export const SCOPES = "email offline_access profile openid";

/**
 * Redirect URI for the ioBroker manual flow (user pastes redirect URL).
 * Same as REDIRECT_URI_MANUAL in Python config_flow.py.
 */
export const REDIRECT_URI = "https://www.bosch.com/boschcam";

export const CLOUD_API = "https://residential.cbs.boschsecurity.com";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Token response from Bosch Keycloak */
export interface TokenResult {
    /**
     *
     */
    access_token: string;
    /**
     *
     */
    refresh_token: string;
    /**
     *
     */
    expires_in: number; // seconds until access_token expires (~300)
    /**
     *
     */
    refresh_expires_in: number; // seconds until refresh_token expires
    /**
     *
     */
    token_type: string; // "Bearer"
    /**
     *
     */
    scope: string;
}

/** PKCE verifier + challenge pair */
export interface PkcePair {
    /**
     *
     */
    verifier: string;
    /**
     *
     */
    challenge: string;
}

// ── Error classes ─────────────────────────────────────────────────────────────

/**
 * Bosch Keycloak rejected the refresh token (HTTP 400/401, invalid_grant).
 * Non-recoverable — user must re-authenticate interactively.
 */
export class RefreshTokenInvalidError extends Error {
    /**
     * @param message human-readable error detail
     */
    constructor(message: string) {
        super(message);
        this.name = "RefreshTokenInvalidError";
    }
}

/**
 * Bosch Keycloak returned HTTP 5xx — server outage.
 * The token is likely still valid — retry after backoff, do NOT prompt re-login.
 */
export class AuthServerOutageError extends Error {
    /**
     * @param message human-readable error detail
     */
    constructor(message: string) {
        super(message);
        this.name = "AuthServerOutageError";
    }
}

// ── PKCE helpers ──────────────────────────────────────────────────────────────

/**
 * Generate a PKCE code_verifier + code_challenge pair (S256 method).
 * Mirrors Python's _pkce_pair() in config_flow.py.
 *
 * @returns object with `verifier` (random 64-byte base64url) and `challenge` (SHA-256 of verifier, base64url)
 */
export function generatePkcePair(): PkcePair {
    const verifier = crypto.randomBytes(64).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
}

/**
 * Build the Bosch Keycloak authorization URL for the manual ioBroker flow.
 * User opens this URL in a browser, logs in, and pastes the redirect URL back.
 *
 * @param challenge  PKCE code_challenge (S256)
 * @param state      Random state string (CSRF protection)
 * @returns Full authorization URL string
 */
export function buildAuthUrl(challenge: string, state: string): string {
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: "code",
        scope: SCOPES,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
    });
    return `${KEYCLOAK_BASE}/auth?${params.toString()}`;
}

/**
 * Extract the authorization code from the redirect URL the user pastes.
 * Mirrors Python _extract_code() in config_flow.py.
 *
 * @param redirectUrl  Full redirect URL (e.g. "https://www.bosch.com/boschcam?code=xxx&state=yyy")
 * @returns The authorization code, or null if not found / error present
 */
export function extractCode(redirectUrl: string): string | null {
    try {
        // Handle both full URLs and bare query strings (user may paste either)
        const urlStr = redirectUrl.trim();
        const hasScheme = urlStr.startsWith("http://") || urlStr.startsWith("https://");
        const parsed = new URL(
            hasScheme ? urlStr : `https://placeholder.invalid/?${urlStr.replace(/^[^?]*\?/, "")}`,
        );
        if (parsed.searchParams.get("error")) {
            return null;
        }
        return parsed.searchParams.get("code");
    } catch {
        return null;
    }
}

// ── Token operations ──────────────────────────────────────────────────────────

/**
 * Exchange an authorization code for access + refresh tokens.
 *
 * Called after user completes the browser login and pastes the redirect URL.
 * Mirrors Python _exchange_code() in config_flow.py.
 *
 * @param httpClient  Axios instance (allows injection for testing)
 * @param code        Authorization code from redirect URL
 * @param verifier    PKCE code_verifier (generated at auth URL build time)
 * @returns TokenResult on success, null on transient error
 */
export async function exchangeCode(
    httpClient: AxiosInstance,
    code: string,
    verifier: string,
): Promise<TokenResult | null> {
    try {
        const params = new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type: "authorization_code",
            code,
            redirect_uri: REDIRECT_URI,
            code_verifier: verifier,
        });
        const resp = await httpClient.post<TokenResult>(
            `${KEYCLOAK_BASE}/token`,
            params.toString(),
            { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
        );
        return {
            access_token: resp.data.access_token,
            refresh_token: resp.data.refresh_token,
            expires_in: resp.data.expires_in,
            refresh_expires_in: resp.data.refresh_expires_in ?? 0,
            token_type: resp.data.token_type,
            scope: resp.data.scope,
        };
    } catch (err: unknown) {
        if (axios.isAxiosError(err)) {
            const status = err.response?.status;
            if (status !== undefined) {
                const body = JSON.stringify(err.response?.data ?? "");
                if (status === 400 || status === 401) {
                    throw new RefreshTokenInvalidError(`Keycloak HTTP ${status}: ${body}`);
                }
                if (status >= 500) {
                    throw new AuthServerOutageError(`Bosch Keycloak HTTP ${status}`);
                }
            }
            // Network/timeout error — transient, caller may retry
            return null;
        }
        throw err;
    }
}

/**
 * Silently refresh an access token using a saved refresh_token.
 *
 * Mirrors Python _do_refresh() in config_flow.py.
 * Throws RefreshTokenInvalidError on 400/401 (user must re-login).
 * Throws AuthServerOutageError on 5xx (retry later).
 *
 * @param httpClient     Axios instance
 * @param refreshToken   Saved refresh_token from previous login
 * @returns New TokenResult on success, null on transient network error
 */
export async function refreshAccessToken(
    httpClient: AxiosInstance,
    refreshToken: string,
): Promise<TokenResult | null> {
    try {
        const params = new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
        });
        const resp = await httpClient.post<TokenResult>(
            `${KEYCLOAK_BASE}/token`,
            params.toString(),
            { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
        );
        return {
            access_token: resp.data.access_token,
            refresh_token: resp.data.refresh_token,
            expires_in: resp.data.expires_in,
            refresh_expires_in: resp.data.refresh_expires_in ?? 0,
            token_type: resp.data.token_type,
            scope: resp.data.scope,
        };
    } catch (err: unknown) {
        if (axios.isAxiosError(err)) {
            const status = err.response?.status;
            if (status !== undefined) {
                const body = JSON.stringify(err.response?.data ?? "");
                // 400/401 → non-recoverable, token is invalid → user must re-login
                if (status === 400 || status === 401) {
                    throw new RefreshTokenInvalidError(`Keycloak HTTP ${status}: ${body}`);
                }
                // 5xx → Bosch server outage → token still valid, retry later
                if (status >= 500) {
                    throw new AuthServerOutageError(`Bosch Keycloak HTTP ${status}`);
                }
            }
            // Network/timeout error — transient, caller may retry
            return null;
        }
        throw err;
    }
}

/**
 * Parse a Bosch Keycloak JWT and return the `azp` (authorized party) claim.
 * Used to detect whether the stored token uses the legacy "residential_app"
 * client or the new OSS client "oss_residential_app".
 *
 * Mirrors Python _detect_token_client_id() in config_flow.py.
 *
 * @param bearerToken  Raw JWT access_token string
 * @returns Client ID string (e.g. "oss_residential_app") or null if unparseable
 */
export function detectTokenClientId(bearerToken: string): string | null {
    if (!bearerToken) {
        return null;
    }
    try {
        const parts = bearerToken.split(".");
        if (parts.length < 2) {
            return null;
        }
        // Pad base64url to a multiple of 4 for Buffer.from
        const padded = parts[1] + "=".repeat((4 - (parts[1].length % 4)) % 4);
        const payload = JSON.parse(Buffer.from(padded, "base64url").toString("utf-8")) as Record<
            string,
            unknown
        >;
        const azp = payload.azp;
        if (typeof azp === "string") {
            return azp;
        }
        if (typeof azp === "number" || typeof azp === "boolean") {
            return String(azp);
        }
        return null;
    } catch {
        return null;
    }
}

// ── Bosch private CA (Video CA 2A — Bosch ST Root CA → Video CA 2A) ─────────
//
// residential.cbs.boschsecurity.com and proxy-*.live.cbs.boschsecurity.com
// are signed by Bosch's PRIVATE PKI, absent from public trust stores.
// The PEM below is verbatim from the HA integration (cloud_ssl.py).
// Embedded as a TS const to avoid build/packaging path issues.
//
// Security note: setting `ca` in https.Agent DROPS the built-in Node system
// roots — we MUST spread `tls.rootCertificates` so that OAuth (Let's Encrypt
// on smarthome.authz.bosch.com) and other public endpoints still validate.
export const BOSCH_CLOUD_CA_PEM = `-----BEGIN CERTIFICATE-----
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
nvQ8Em1LhUA=
-----END CERTIFICATE-----
`;

// ── Cloud TLS verification (emulated PARTIAL_CHAIN) ────────────────────────────

// The pinned Bosch intermediate parsed once for repeated signature checks.
const BOSCH_CLOUD_PIN = new crypto.X509Certificate(BOSCH_CLOUD_CA_PEM);

/**
 * Verify a peer leaf certificate for a Bosch CLOUD endpoint.
 *
 * Faithful Node emulation of the HA/Python `ssl` context — system roots ∪
 * "Video CA 2A" intermediate, with `VERIFY_X509_PARTIAL_CHAIN`.
 *
 * Node's TLS stack has NO equivalent of OpenSSL's PARTIAL_CHAIN flag
 * (nodejs/node#36453): putting only the *intermediate* "Video CA 2A" in `ca`
 * makes every handshake fail with `UNABLE_TO_GET_ISSUER_CERT`, because Node
 * keeps looking for the self-signed root "Bosch ST Root CA" which the server
 * never sends and which is absent from every public store. That regression
 * (shipped in v1.5.1) prevented the adapter from completing cloud discovery on
 * startup — see forum #84538.
 *
 * We therefore connect with verification deferred (`rejectUnauthorized:false`)
 * and validate the peer ourselves. A peer is trusted iff the hostname matches
 * and the validity window is current AND either:
 *   - the chain validated to a trusted system root (OAuth host
 *     smarthome.authz.bosch.com is Let's Encrypt), OR
 *   - the leaf was signed by the pinned Bosch intermediate (private Bosch PKI:
 *     residential.cbs.boschsecurity.com, proxy-*.live.cbs.boschsecurity.com).
 *
 * This keeps the CWE-295 protection: a MITM presenting a public-CA cert it does
 * not own, a self-signed cert, an expired cert or a hostname mismatch is
 * rejected — only a leaf genuinely signed by Bosch's private key is accepted on
 * the partial-chain path.
 *
 * @param leafDer            DER bytes of the peer leaf certificate (`undefined` → reject)
 * @param authorized         Node's `socket.authorized` (chain valid to a system root)
 * @param authorizationError Node's `socket.authorizationError` (for diagnostics)
 * @param servername         hostname the request targeted (checked against the cert SAN)
 * @param pin                pinned intermediate (injectable for tests)
 * @param now                current epoch ms (injectable for tests)
 * @returns `null` when trusted, otherwise an `Error` describing why it was rejected
 */
export function verifyCloudPeerCert(
    leafDer: Buffer | undefined,
    authorized: boolean,
    authorizationError: string | undefined,
    servername: string,
    pin: crypto.X509Certificate = BOSCH_CLOUD_PIN,
    now: number = Date.now(),
): Error | null {
    if (!leafDer) {
        return new Error("BOSCH_TLS: no peer certificate presented");
    }
    const leaf = new crypto.X509Certificate(leafDer);
    if (leaf.checkHost(servername) === undefined) {
        return new Error(`BOSCH_TLS: hostname '${servername}' not covered by server certificate`);
    }
    if (now < Date.parse(leaf.validFrom) || now > Date.parse(leaf.validTo)) {
        return new Error("BOSCH_TLS: server certificate is outside its validity window");
    }
    if (authorized) {
        // chain validated against a trusted system root (Let's Encrypt OAuth host, …)
        return null;
    }
    if (leaf.verify(pin.publicKey)) {
        // private Bosch PKI: leaf signed by the pinned "Video CA 2A" intermediate
        return null;
    }
    return new Error(
        `BOSCH_TLS: server certificate not trusted (${authorizationError ?? "no chain"}) and not issued by the pinned Bosch CA`,
    );
}

/**
 * https.Agent for Bosch cloud calls. Defers Node's chain check and runs
 * {@link verifyCloudPeerCert} on every new TLS socket, destroying the socket
 * (which surfaces the reason to the caller) when the peer is not trusted.
 */
export class BoschCloudAgent extends https.Agent {
    /**
     * Cross-version fix (2026-07-13, ported from HA integration's aiohttp
     * session-pooling hardening): the previous default (no options passed to
     * `super()`) left `keepAlive` at Node's https.Agent default of `false`, so
     * even though `_httpClient` (main.ts) is a singleton reused across every
     * cloud API call, the underlying TCP+TLS connection to
     * residential.cbs.boschsecurity.com was still torn down and rebuilt on
     * every single request (polling ticks, heartbeats, writes). Enabling
     * keepAlive lets Node reuse the pinned-TLS socket across requests.
     */
    public constructor() {
        super({ keepAlive: true, keepAliveMsecs: 10_000, maxSockets: 8 });
    }

    /**
     * Open a TLS connection with Node's chain check deferred, then run
     * {@link verifyCloudPeerCert} on `secureConnect`. On rejection the socket is
     * destroyed with the reason so the failure surfaces to the HTTP caller.
     *
     * @param options  connection options provided by the HTTP agent
     * @param callback node-style `(err, socket)` invoked once the peer is verified
     * @returns the TLS socket (also yielded via `callback` on success)
     */
    public override createConnection(
        options: https.RequestOptions,
        callback?: (err: Error | null, stream: Duplex) => void,
    ): tls.TLSSocket {
        const connectOptions = options as tls.ConnectionOptions & { host?: string };
        const servername = connectOptions.servername ?? connectOptions.host ?? "";
        const socket = tls.connect({
            ...connectOptions,
            servername,
            rejectUnauthorized: false,
            ca: [...tls.rootCertificates, BOSCH_CLOUD_CA_PEM],
        });
        let settled = false;
        const settle = (err: Error | null, sock?: tls.TLSSocket): void => {
            if (settled) {
                return;
            }
            settled = true;
            if (sock) {
                callback?.(err, sock);
            } else {
                callback?.(err, socket);
            }
        };
        socket.once("secureConnect", () => {
            const peerError = verifyCloudPeerCert(
                socket.getPeerCertificate(true).raw,
                socket.authorized,
                socket.authorizationError ? `${socket.authorizationError}` : undefined,
                servername,
            );
            if (peerError) {
                socket.destroy(peerError);
            } else {
                settle(null, socket);
            }
        });
        socket.once("error", (err: Error) => settle(err));
        return socket;
    }
}

// ── HTTP client factories ─────────────────────────────────────────────────────

/**
 * Create an Axios instance for Bosch CLOUD API calls with proper TLS verification.
 *
 * Fixes CWE-295 for all cloud endpoints while still working on Node (which lacks
 * OpenSSL's PARTIAL_CHAIN). See {@link verifyCloudPeerCert} / {@link BoschCloudAgent}:
 *   - residential.cbs.boschsecurity.com  (CLOUD_API, /v11/*, live sessions)
 *   - proxy-*.live.cbs.boschsecurity.com (RCP REMOTE)
 *   - smarthome.authz.bosch.com          (KEYCLOAK_BASE, Let's Encrypt — system roots)
 *
 * @returns Axios instance with secure TLS (15 s timeout)
 */
export function createCloudHttpClient(): AxiosInstance {
    return axios.create({
        timeout: 15_000,
        httpsAgent: new BoschCloudAgent(),
    });
}

/**
 * Create an Axios instance for LOCAL LAN camera calls (self-signed certs).
 *
 * TLS verification is intentionally disabled — local cameras use self-signed
 * certificates that no public CA or Bosch CA signs.
 *
 * @returns Axios instance with rejectUnauthorized:false (15 s timeout)
 */
export function createLocalHttpClient(): AxiosInstance {
    return axios.create({
        timeout: 15_000,
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });
}

/**
 * @deprecated Use createCloudHttpClient() for cloud calls or createLocalHttpClient()
 * for LAN camera calls. This shim exists only for backward-compat with existing call
 * sites that have not yet been split — it returns a SECURE cloud client.
 */
export function createHttpClient(): AxiosInstance {
    return createCloudHttpClient();
}

// Re-export crypto for tests (avoids direct crypto import in test files)
export { crypto };
