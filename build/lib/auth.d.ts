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
import { type AxiosInstance } from "axios";
export declare const KEYCLOAK_BASE: string;
export declare const CLIENT_ID = "oss_residential_app";
/** Decoded from base64 — same value as Python config_flow.py CLIENT_SECRET */
export declare const CLIENT_SECRET: string;
export declare const SCOPES = "email offline_access profile openid";
/**
 * Redirect URI for the ioBroker manual flow (user pastes redirect URL).
 * Same as REDIRECT_URI_MANUAL in Python config_flow.py.
 */
export declare const REDIRECT_URI = "https://www.bosch.com/boschcam";
export declare const CLOUD_API = "https://residential.cbs.boschsecurity.com";
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
    expires_in: number;
    /**
     *
     */
    refresh_expires_in: number;
    /**
     *
     */
    token_type: string;
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
/**
 * Bosch Keycloak rejected the refresh token (HTTP 400/401, invalid_grant).
 * Non-recoverable — user must re-authenticate interactively.
 */
export declare class RefreshTokenInvalidError extends Error {
    /**
     * @param message human-readable error detail
     */
    constructor(message: string);
}
/**
 * Bosch Keycloak returned HTTP 5xx — server outage.
 * The token is likely still valid — retry after backoff, do NOT prompt re-login.
 */
export declare class AuthServerOutageError extends Error {
    /**
     * @param message human-readable error detail
     */
    constructor(message: string);
}
/**
 * Generate a PKCE code_verifier + code_challenge pair (S256 method).
 * Mirrors Python's _pkce_pair() in config_flow.py.
 *
 * @returns object with `verifier` (random 64-byte base64url) and `challenge` (SHA-256 of verifier, base64url)
 */
export declare function generatePkcePair(): PkcePair;
/**
 * Build the Bosch Keycloak authorization URL for the manual ioBroker flow.
 * User opens this URL in a browser, logs in, and pastes the redirect URL back.
 *
 * @param challenge  PKCE code_challenge (S256)
 * @param state      Random state string (CSRF protection)
 * @returns Full authorization URL string
 */
export declare function buildAuthUrl(challenge: string, state: string): string;
/**
 * Extract the authorization code from the redirect URL the user pastes.
 * Mirrors Python _extract_code() in config_flow.py.
 *
 * @param redirectUrl  Full redirect URL (e.g. "https://www.bosch.com/boschcam?code=xxx&state=yyy")
 * @returns The authorization code, or null if not found / error present
 */
export declare function extractCode(redirectUrl: string): string | null;
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
export declare function exchangeCode(httpClient: AxiosInstance, code: string, verifier: string): Promise<TokenResult | null>;
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
export declare function refreshAccessToken(httpClient: AxiosInstance, refreshToken: string): Promise<TokenResult | null>;
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
export declare function detectTokenClientId(bearerToken: string): string | null;
export declare const BOSCH_CLOUD_CA_PEM = "-----BEGIN CERTIFICATE-----\n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\nnvQ8Em1LhUA=\n-----END CERTIFICATE-----\n";
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
export declare function verifyCloudPeerCert(leafDer: Buffer | undefined, authorized: boolean, authorizationError: string | undefined, servername: string, pin?: crypto.X509Certificate, now?: number): Error | null;
/**
 * https.Agent for Bosch cloud calls. Defers Node's chain check and runs
 * {@link verifyCloudPeerCert} on every new TLS socket, destroying the socket
 * (which surfaces the reason to the caller) when the peer is not trusted.
 */
export declare class BoschCloudAgent extends https.Agent {
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
    constructor();
    /**
     * Open a TLS connection with Node's chain check deferred, then run
     * {@link verifyCloudPeerCert} on `secureConnect`. On rejection the socket is
     * destroyed with the reason so the failure surfaces to the HTTP caller.
     *
     * @param options  connection options provided by the HTTP agent
     * @param callback node-style `(err, socket)` invoked once the peer is verified
     * @returns the TLS socket (also yielded via `callback` on success)
     */
    createConnection(options: https.RequestOptions, callback?: (err: Error | null, stream: Duplex) => void): tls.TLSSocket;
}
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
export declare function createCloudHttpClient(): AxiosInstance;
/**
 * Create an Axios instance for LOCAL LAN camera calls (self-signed certs).
 *
 * TLS verification is intentionally disabled — local cameras use self-signed
 * certificates that no public CA or Bosch CA signs.
 *
 * @returns Axios instance with rejectUnauthorized:false (15 s timeout)
 */
export declare function createLocalHttpClient(): AxiosInstance;
/**
 * @deprecated Use createCloudHttpClient() for cloud calls or createLocalHttpClient()
 * for LAN camera calls. This shim exists only for backward-compat with existing call
 * sites that have not yet been split — it returns a SECURE cloud client.
 */
export declare function createHttpClient(): AxiosInstance;
export { crypto };
//# sourceMappingURL=auth.d.ts.map