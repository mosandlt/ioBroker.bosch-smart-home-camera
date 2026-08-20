/**
 * SSRF guard for the user-configured AI Camera Analysis endpoint URL.
 *
 * `ai_analysis_endpoint_url` (adapter config) is POSTed a real snapshot of
 * the user's home plus (optionally) `ai_analysis_api_key` in cleartext
 * Authorization header — bug-hunt finding: with zero validation this could
 * be pointed at `http://` (credentials/image sent in the clear), or at a
 * private/loopback/link-local/metadata address (e.g. 169.254.169.254, the
 * well-known cloud-metadata SSRF target), turning a config mistake or a
 * compromised admin session into either a data leak or an internal-network
 * probe launched from the adapter host.
 *
 * Mirrors the sibling HA integration's `_is_safe_local_camera_host`-style
 * reasoning (`coordinator.py`) but INVERTED: that helper requires the
 * target to be a private LAN address (a physical camera); this one
 * requires the target to be a genuine PUBLIC address, since the AI
 * endpoint is expected to be an external third-party service.
 */
/**
 *
 */
export interface SsrfValidationResult {
    /**
     *
     */
    ok: boolean;
    /** Present only when ok === false — human-readable rejection reason. */
    reason?: string;
}
/**
 * Validate that `urlStr` is `https:` and that every address it resolves to
 * is a routable public address (not private/loopback/link-local/unspecified).
 *
 * @param urlStr candidate endpoint URL (as configured by the user)
 * @returns validation result; `ok:false` includes a `reason` for logging
 */
export declare function validateAiEndpointUrl(urlStr: string): Promise<SsrfValidationResult>;
/**
 * True when `addr` is a loopback / link-local / unspecified / private
 * (RFC 1918 / RFC 4193) IPv4 or IPv6 address — i.e. NOT safe to treat as a
 * genuine external endpoint.
 *
 * @param addr an IPv4 or IPv6 address string
 * @returns true if the address must be rejected
 */
export declare function isPrivateOrReservedAddress(addr: string): boolean;
//# sourceMappingURL=ssrf_guard.d.ts.map