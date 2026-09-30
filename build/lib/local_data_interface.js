"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseFirmware = parseFirmware;
exports.firmwareSupportsLdi = firmwareSupportsLdi;
exports.isLdiEligible = isLdiEligible;
exports.stateFromResponse = stateFromResponse;
exports.fetchLdiStatus = fetchLdiStatus;
exports.isValidPassword = isValidPassword;
exports.passwordForCamera = passwordForCamera;
exports.isSafeLanHost = isSafeLanHost;
exports.buildLocalStreamUrl = buildLocalStreamUrl;
exports.maskUrl = maskUrl;
const net = __importStar(require("node:net"));
const auth_1 = require("./auth");
const LDI_ENDPOINT = "onvif_user";
const LDI_MIN_FIRMWARE = [9, 40, 105];
const LDI_USERNAME = "localuser";
const LDI_PORT = 9554;
/**
 * Parse a dotted numeric firmware string.
 *
 * @param version raw firmware value
 * @returns numeric tuple, or null for anything that is not dotted digits
 */
function parseFirmware(version) {
    if (typeof version !== "string") {
        return null;
    }
    const parts = version.trim().split(".");
    // Length cap keeps absurd digit strings from becoming huge/Infinity numbers.
    if (!parts.every((p) => /^[0-9]{1,9}$/.test(p))) {
        return null;
    }
    return parts.map((p) => parseInt(p, 10));
}
/**
 * True when the firmware is at or above the interface gate.
 *
 * @param version raw firmware value
 */
function firmwareSupportsLdi(version) {
    const parsed = parseFirmware(version);
    if (!parsed) {
        return false;
    }
    const len = Math.max(parsed.length, LDI_MIN_FIRMWARE.length);
    for (let i = 0; i < len; i++) {
        const a = parsed[i] ?? 0;
        const b = LDI_MIN_FIRMWARE[i] ?? 0;
        if (a !== b) {
            return a > b;
        }
    }
    return true;
}
/**
 * Whether a camera may be asked for the interface status (Gen2 + new firmware).
 *
 * @param generation camera generation
 * @param firmwareVersion raw firmware value
 */
function isLdiEligible(generation, firmwareVersion) {
    return generation >= 2 && firmwareSupportsLdi(firmwareVersion);
}
/**
 * Map an HTTP result to a status, or null to keep the last value.
 *
 * @param status HTTP status
 * @param body parsed response body
 */
function stateFromResponse(status, body) {
    if (status === 200) {
        const name = body?.username;
        return typeof name === "string" ? "active" : null;
    }
    if (status === 404) {
        return "inactive";
    }
    if (status === 449) {
        return "unsupported";
    }
    return null;
}
/**
 * GET the interface status of one camera.
 *
 * @param httpClient shared Axios instance
 * @param accessToken bearer token
 * @param camId camera cloud ID
 * @returns new status, or null to keep the previous one
 */
async function fetchLdiStatus(httpClient, accessToken, camId) {
    try {
        const resp = await httpClient.get(`${auth_1.CLOUD_API}/v11/video_inputs/${camId}/${LDI_ENDPOINT}`, {
            headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
            validateStatus: () => true,
            timeout: 8_000,
        });
        return stateFromResponse(resp.status, resp.data);
    }
    catch {
        return null;
    }
}
/**
 * Passwords are embedded in a URL userinfo part: printable ASCII only, no
 * whitespace or list separators.
 *
 * @param pw candidate password
 */
function isValidPassword(pw) {
    return typeof pw === "string" && /^[\x21-\x7e]{1,128}$/.test(pw) && !/[,;]/.test(pw);
}
/**
 * Look up one camera's password in the `local_data_passwords` config value,
 * formatted as `<cameraId or 8-char prefix>=<password>` entries separated by
 * whitespace, commas or semicolons.
 *
 * @param raw the config string
 * @param camId camera cloud ID
 * @returns password, or null when absent or malformed
 */
function passwordForCamera(raw, camId) {
    if (typeof raw !== "string" || !raw) {
        return null;
    }
    const id = camId.toLowerCase();
    for (const entry of raw.split(/[\s,;]+/)) {
        const eq = entry.indexOf("=");
        if (eq < 1) {
            continue;
        }
        const key = entry.slice(0, eq).toLowerCase();
        const matches = key === id || (key.length === 8 && id.startsWith(key));
        if (matches) {
            const pw = entry.slice(eq + 1);
            return isValidPassword(pw) ? pw : null;
        }
    }
    return null;
}
/**
 * Accept only private-range unicast IPv4/IPv6 LAN addresses.
 *
 * @param host candidate camera address
 */
function isSafeLanHost(host) {
    if (typeof host !== "string") {
        return false;
    }
    const family = net.isIP(host);
    if (family === 4) {
        const [a, b] = host.split(".").map(Number);
        if (a === 127 || a === 0 || (a === 169 && b === 254)) {
            return false;
        }
        return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    }
    if (family === 6) {
        // Unique-local only; loopback, unspecified and link-local are excluded.
        return /^f[cd][0-9a-f]{2}:/i.test(host);
    }
    return false;
}
/**
 * Build the direct local stream URL (video only).
 *
 * @param host validated LAN address
 * @param password camera password
 * @returns URL, or null when host or password are not acceptable
 */
function buildLocalStreamUrl(host, password) {
    if (!isSafeLanHost(host) || !isValidPassword(password)) {
        return null;
    }
    const h = net.isIP(host) === 6 ? `[${host}]` : host;
    return `rtsps://${LDI_USERNAME}:${encodeURIComponent(password)}@${h}:${LDI_PORT}/live`;
}
/**
 * Hide the userinfo part of a URL for display.
 *
 * @param url URL that may carry credentials
 */
function maskUrl(url) {
    return url.replace(/\/\/[^/@]*@/, "//***@");
}
//# sourceMappingURL=local_data_interface.js.map