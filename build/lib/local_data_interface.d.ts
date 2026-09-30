/**
 * Local data interface: read-only cloud status plus the direct local stream URL.
 *
 * Status (per camera, GET):
 *   200 {"username": string} -> active
 *   404                      -> inactive (normal "off" state)
 *   449                      -> unsupported firmware
 * Any other status, network error or malformed body keeps the last value.
 * Only Gen2 cameras on firmware >= LDI_MIN_FIRMWARE are queried.
 */
import type { AxiosInstance } from "axios";
/** Status published to `cameras.<id>.local_data_interface`. */
export type LdiState = "active" | "inactive" | "unsupported" | "unknown";
/**
 * Parse a dotted numeric firmware string.
 *
 * @param version raw firmware value
 * @returns numeric tuple, or null for anything that is not dotted digits
 */
export declare function parseFirmware(version: unknown): number[] | null;
/**
 * True when the firmware is at or above the interface gate.
 *
 * @param version raw firmware value
 */
export declare function firmwareSupportsLdi(version: unknown): boolean;
/**
 * Whether a camera may be asked for the interface status (Gen2 + new firmware).
 *
 * @param generation camera generation
 * @param firmwareVersion raw firmware value
 */
export declare function isLdiEligible(generation: number, firmwareVersion: unknown): boolean;
/**
 * Map an HTTP result to a status, or null to keep the last value.
 *
 * @param status HTTP status
 * @param body parsed response body
 */
export declare function stateFromResponse(status: number, body: unknown): LdiState | null;
/**
 * GET the interface status of one camera.
 *
 * @param httpClient shared Axios instance
 * @param accessToken bearer token
 * @param camId camera cloud ID
 * @returns new status, or null to keep the previous one
 */
export declare function fetchLdiStatus(httpClient: AxiosInstance, accessToken: string, camId: string): Promise<LdiState | null>;
/**
 * Passwords are embedded in a URL userinfo part: printable ASCII only, no
 * whitespace or list separators.
 *
 * @param pw candidate password
 */
export declare function isValidPassword(pw: unknown): pw is string;
/**
 * Look up one camera's password in the `local_data_passwords` config value,
 * formatted as `<cameraId or 8-char prefix>=<password>` entries separated by
 * whitespace, commas or semicolons.
 *
 * @param raw the config string
 * @param camId camera cloud ID
 * @returns password, or null when absent or malformed
 */
export declare function passwordForCamera(raw: unknown, camId: string): string | null;
/**
 * Accept only private-range unicast IPv4/IPv6 LAN addresses.
 *
 * @param host candidate camera address
 */
export declare function isSafeLanHost(host: unknown): host is string;
/**
 * Build the direct local stream URL (video only).
 *
 * @param host validated LAN address
 * @param password camera password
 * @returns URL, or null when host or password are not acceptable
 */
export declare function buildLocalStreamUrl(host: unknown, password: unknown): string | null;
/**
 * Hide the userinfo part of a URL for display.
 *
 * @param url URL that may carry credentials
 */
export declare function maskUrl(url: string): string;
//# sourceMappingURL=local_data_interface.d.ts.map