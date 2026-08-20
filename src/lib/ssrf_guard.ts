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

import * as dns from "node:dns";
import * as net from "node:net";

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
export async function validateAiEndpointUrl(urlStr: string): Promise<SsrfValidationResult> {
    let parsed: URL;
    try {
        parsed = new URL(urlStr);
    } catch {
        return { ok: false, reason: "not a valid URL" };
    }
    if (parsed.protocol !== "https:") {
        return { ok: false, reason: `scheme must be https:, got ${parsed.protocol}` };
    }
    const hostname = parsed.hostname;
    if (!hostname) {
        return { ok: false, reason: "URL has no hostname" };
    }

    // If the hostname is itself a literal IP, validate it directly —
    // dns.lookup() on a literal IP just returns it unchanged, but skipping
    // the DNS round-trip is both faster and avoids relying on resolver
    // behaviour for something we can check locally.
    if (net.isIP(hostname) !== 0) {
        if (isPrivateOrReservedAddress(hostname)) {
            return { ok: false, reason: `resolves to a private/reserved address: ${hostname}` };
        }
        return { ok: true };
    }

    let addresses: string[];
    try {
        const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
        addresses = records.map((r) => r.address);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: `DNS resolution failed: ${msg}` };
    }
    if (addresses.length === 0) {
        return { ok: false, reason: "DNS resolution returned no addresses" };
    }
    for (const addr of addresses) {
        if (isPrivateOrReservedAddress(addr)) {
            return {
                ok: false,
                reason: `hostname "${hostname}" resolves to a private/reserved address: ${addr}`,
            };
        }
    }
    return { ok: true };
}

/**
 * True when `addr` is a loopback / link-local / unspecified / private
 * (RFC 1918 / RFC 4193) IPv4 or IPv6 address — i.e. NOT safe to treat as a
 * genuine external endpoint.
 *
 * @param addr an IPv4 or IPv6 address string
 * @returns true if the address must be rejected
 */
export function isPrivateOrReservedAddress(addr: string): boolean {
    const family = net.isIP(addr);
    if (family === 4) {
        return isPrivateOrReservedIPv4(addr);
    }
    if (family === 6) {
        return isPrivateOrReservedIPv6(addr);
    }
    // Not a parseable IP at all — treat as unsafe (caller should already
    // have resolved hostnames to IPs before calling this).
    return true;
}

function isPrivateOrReservedIPv4(addr: string): boolean {
    const parts = addr.split(".").map((p) => Number.parseInt(p, 10));
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
        return true; // unparseable → treat as unsafe
    }
    const [a, b] = parts;
    if (a === 0) {
        return true;
    } // 0.0.0.0/8 — unspecified/"this network"
    if (a === 127) {
        return true;
    } // 127.0.0.0/8 — loopback
    if (a === 10) {
        return true;
    } // 10.0.0.0/8 — private
    if (a === 172 && b >= 16 && b <= 31) {
        return true;
    } // 172.16.0.0/12 — private
    if (a === 192 && b === 168) {
        return true;
    } // 192.168.0.0/16 — private
    if (a === 169 && b === 254) {
        return true;
    } // 169.254.0.0/16 — link-local (incl. cloud metadata 169.254.169.254)
    if (a === 100 && b >= 64 && b <= 127) {
        return true;
    } // 100.64.0.0/10 — carrier-grade NAT (RFC 6598)
    return false;
}

function isPrivateOrReservedIPv6(addr: string): boolean {
    const lower = addr.toLowerCase();
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — validate the embedded IPv4 address.
    const v4Mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (v4Mapped) {
        return isPrivateOrReservedIPv4(v4Mapped[1]);
    }
    if (lower === "::" || lower === "::0") {
        return true;
    } // unspecified
    if (lower === "::1") {
        return true;
    } // loopback
    if (
        lower.startsWith("fe8") ||
        lower.startsWith("fe9") ||
        lower.startsWith("fea") ||
        lower.startsWith("feb")
    ) {
        return true; // fe80::/10 — link-local
    }
    if (lower.startsWith("fc") || lower.startsWith("fd")) {
        return true; // fc00::/7 — unique local (private)
    }
    return false;
}
