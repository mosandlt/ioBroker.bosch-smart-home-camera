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
import type { AxiosInstance } from "axios";
/** Raw response from GET /v11/feature_flags */
export type FeatureFlagsRaw = Record<string, boolean>;
/** Result parsed into display strings. */
export interface FeatureFlagsResult {
    /**
     * Comma-separated list of enabled flag names, e.g. "APP_RATING, IOT_THINGS_INTEGRATION".
     * Empty string when no flags are enabled.
     */
    display: string;
    /** Original raw JSON string for storage as feature_flags_raw DP. */
    raw: string;
}
/**
 * Fetch /v11/feature_flags and return a parsed result.
 *
 * @param httpClient  Shared Axios instance
 * @param accessToken Bearer token
 * @returns           FeatureFlagsResult on success, null on any error
 */
export declare function fetchFeatureFlags(httpClient: AxiosInstance, accessToken: string): Promise<FeatureFlagsResult | null>;
//# sourceMappingURL=cloud_feature_flags.d.ts.map