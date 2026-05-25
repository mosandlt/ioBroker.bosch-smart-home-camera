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
export declare function fetchRcpLan(creds: RcpLanCredentials | null | undefined, opcode: string): Promise<Buffer | null>;
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
export declare function parseOnvifScopes(raw: Buffer): OnvifScopes;
/**
 * Format a 4-byte RCP version buffer as "major.minor.patch.build".
 *
 * Port of HA: f"{raw_ver[0]}.{raw_ver[1]}.{raw_ver[2]}.{raw_ver[3]}"
 *
 * @param raw  4-byte buffer from fetchRcpLan(creds, "0xff00")
 * @returns    Version string e.g. "1.2.38.150", or null if buffer too short
 */
export declare function formatRcpVersion(raw: Buffer): string | null;
//# sourceMappingURL=rcp_lan_helper.d.ts.map