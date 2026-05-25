"use strict";
/**
 * Bosch Cloud Feature Flags — GET /v11/feature_flags
 *
 * Account-level endpoint (no camera ID). Returns a flat JSON object with
 * boolean feature flags, e.g.:
 *   { "APP_RATING": true, "IOT_THINGS_INTEGRATION": true }
 *
 * The value never changes mid-session; polling at 300 s (slow-tier) is sufficient.
 * Returns null on any error so callers keep the last known value.
 *
 * Port of HA coordinator._feature_flags fetch in _async_update_data().
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchFeatureFlags = fetchFeatureFlags;
const auth_1 = require("./auth");
// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Fetch /v11/feature_flags and return a parsed result.
 *
 * @param httpClient  Shared Axios instance
 * @param accessToken Bearer token
 * @returns           FeatureFlagsResult on success, null on any error
 */
async function fetchFeatureFlags(httpClient, accessToken) {
    const url = `${auth_1.CLOUD_API}/v11/feature_flags`;
    const headers = { Authorization: `Bearer ${accessToken}` };
    try {
        const resp = await httpClient.get(url, {
            headers,
            validateStatus: (s) => s === 200,
            timeout: 8_000,
        });
        const data = resp.data;
        if (!data || typeof data !== "object" || Array.isArray(data)) {
            return null;
        }
        // Enabled flags only → sorted comma-separated list
        const enabled = Object.entries(data)
            .filter(([, v]) => v === true)
            .map(([k]) => k)
            .sort();
        return {
            display: enabled.join(", "),
            raw: JSON.stringify(data),
        };
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=cloud_feature_flags.js.map