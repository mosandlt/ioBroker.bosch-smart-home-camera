/**
 * RCP LAN helper — read an RCP value directly from the camera's LAN HTTPS endpoint.
 *
 * Port of HA _fetch_rcp_lan() + _parse_onvif_scopes() + RCP-version parser.
 *
 * Auth: CBS Digest credentials (cbs-XXXXXXXX user / rotating password) from the
 * cached LiveSession — identical to the Digest auth used for snap.jpg / local RCP writes.
 *
 * TLS: camera uses a self-signed certificate; rejectUnauthorized=false (same as snapshot.ts).
 *
 * Usage:
 *   const buf = await fetchRcpLan({ lanAddress: "192.168.1.149:443", digestUser: "cbs-123", digestPassword: "secret" }, "0x0a98");
 *   if (buf) { const scopes = parseOnvifScopes(buf); }
 *
 *   const verBuf = await fetchRcpLan(sess, "0xff00");
 *   if (verBuf && verBuf.length >= 4) console.log(formatRcpVersion(verBuf));
 */

import { digestRequest } from "./digest";

// ── Types ──────────────────────────────────────────────────────────────────────

/** Minimal credential shape accepted by fetchRcpLan (subset of LiveSession). */
export interface RcpLanCredentials {
    /** LAN address string, e.g. "192.168.1.149:443". */
    lanAddress: string;
    /** CBS Digest username, e.g. "cbs-57355237". */
    digestUser: string;
    /** CBS Digest password. */
    digestPassword: string;
}

/** Parsed ONVIF scopes from RCP 0x0a98. */
export interface OnvifScopes {
    /** Raw scope strings from TLV payload. */
    raw_scopes: string[];
    /** Human-readable device name, e.g. "Bosch Smart Home Camera". */
    name: string;
    /** Hardware model string, e.g. "HOME_Eyes_Outdoor". */
    hardware: string;
    /** ONVIF profile names, e.g. ["Streaming"]. */
    profiles: string[];
    /** True if camera responded to 0x0a98 (ONVIF is supported). */
    supported: boolean;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch an RCP value directly from the camera's LAN HTTPS /rcp.xml endpoint.
 *
 * Uses two-step Digest auth (RFC 7616) via the CBS rotating credentials from
 * an active LiveSession. Self-signed cert accepted (rejectUnauthorized=false).
 *
 * Returns the decoded payload bytes on success, null on any error:
 *   - no LAN address / no credentials
 *   - network error or timeout
 *   - HTTP non-200
 *   - RCP-level <err> response
 *   - empty or unrecognised XML response
 *
 * @param creds  LiveSession credentials (lanAddress + digestUser + digestPassword)
 * @param opcode Hex opcode string, e.g. "0x0a98"
 * @returns      Decoded payload bytes, or null on any error
 */
export async function fetchRcpLan(
    creds: RcpLanCredentials | null | undefined,
    opcode: string,
): Promise<Buffer | null> {
    if (!creds?.lanAddress || !creds.digestUser || !creds.digestPassword) {
        return null;
    }

    const [host] = creds.lanAddress.split(":");
    if (!host) {
        return null;
    }

    const baseUrl = `https://${creds.lanAddress}/rcp.xml`;
    const qs = new URLSearchParams({
        command: opcode,
        direction: "READ",
        type: "P_OCTET",
        num: "1",
    });
    const url = `${baseUrl}?${qs.toString()}`;

    try {
        const resp = await digestRequest(url, creds.digestUser, creds.digestPassword, {
            method: "GET",
            timeout: 8_000,
            rejectUnauthorized: false,
        });

        if (resp.status !== 200) {
            return null;
        }

        const raw = resp.data;

        // RCP-level error <err>
        if (raw.indexOf(Buffer.from("<err>")) !== -1) {
            return null;
        }

        // Extract hex payload from <str>HEXDATA</str>
        const text = raw.toString("ascii");
        const strMatch = text.match(/<str>([0-9a-fA-F]+)<\/str>/i);
        if (strMatch?.[1]) {
            return Buffer.from(strMatch[1], "hex");
        }

        // Fallback: raw binary (non-XML, e.g. old firmware responses)
        if (raw.length > 0 && raw[0] !== 0x3c /* '<' */) {
            return raw;
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Parse ONVIF scope TLV payload from RCP 0x0a98 (ASCII, ~720 bytes).
 *
 * The payload is a series of null-terminated ASCII strings, each may be an
 * ONVIF scope URI: onvif://www.onvif.org/name/Bosch%20Smart%20Home%20Camera
 *
 * Port of HA _parse_onvif_scopes().
 *
 * @param raw  Decoded payload bytes from fetchRcpLan(creds, "0x0a98")
 * @returns    Parsed OnvifScopes
 */
export function parseOnvifScopes(raw: Buffer): OnvifScopes {
    const result: OnvifScopes = {
        supported: true,
        raw_scopes: [],
        name: "",
        hardware: "",
        profiles: [],
    };

    try {
        const text = raw.toString("ascii");
        // Split on null bytes, newlines, carriage returns, or whitespace runs
        const scopes = text
            // eslint-disable-next-line no-control-regex
            .split(/[\x00\n\r]+/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0);

        result.raw_scopes = scopes;

        for (const scope of scopes) {
            if (!scope.startsWith("onvif://www.onvif.org/")) {
                continue;
            }
            const path = scope.slice("onvif://www.onvif.org/".length);
            const slashIdx = path.indexOf("/");
            if (slashIdx === -1) {
                continue;
            }
            const key = path.slice(0, slashIdx);
            const val = decodeURIComponent(path.slice(slashIdx + 1)).replace(/\+/g, " ");

            if (key === "name") {
                result.name = val;
            } else if (key === "hardware") {
                result.hardware = val;
            } else if (key === "Profile") {
                result.profiles.push(val);
            }
        }
    } catch {
        // Defensive — keep empty-but-supported result
    }

    return result;
}

/**
 * Format a 4-byte RCP version buffer as "major.minor.patch.build".
 *
 * Port of HA: f"{raw_ver[0]}.{raw_ver[1]}.{raw_ver[2]}.{raw_ver[3]}"
 *
 * @param raw  4-byte buffer from fetchRcpLan(creds, "0xff00")
 * @returns    Version string e.g. "1.2.38.150", or null if buffer too short
 */
export function formatRcpVersion(raw: Buffer): string | null {
    if (raw.length < 4) {
        return null;
    }
    return `${raw[0]}.${raw[1]}.${raw[2]}.${raw[3]}`;
}
