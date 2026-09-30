/** Outcome of the attach attempt, for the one-line startup self-check. */
export interface EceWrapperStatus {
    /** True when `http_ece.decrypt` is wrapped (now or by an earlier call). */
    attached: boolean;
    /** Human-readable reason when `attached` is false. */
    reason?: string;
}
/** Property on the wrapper holding the untouched original (used by tests). */
export declare const ECE_ORIGINAL: unique symbol;
/**
 * Re-derive a header field from a value whose first `skipped` characters were
 * already removed by the library's blind slice.
 *
 * @param sliced Value as passed to `decrypt` (after the library's slice).
 * @param prefix Field prefix incl. "=", e.g. "dh=" or "salt=".
 * @returns The cleaned field value, or `undefined` if nothing better than the
 *   input could be derived.
 */
export declare function recoverEceField(sliced: unknown, prefix: string): string | undefined;
/**
 * Attach the wrapper to `http_ece.decrypt` (idempotent, never throws).
 *
 * @param target Optional module object to wrap (tests); defaults to the
 *   `http_ece` instance that `@aracna/fcm` itself resolves.
 * @param target.decrypt The `decrypt` function slot of that module object.
 * @returns attach status
 */
export declare function installFcmEceWrapper(target?: {
    decrypt?: unknown;
}): EceWrapperStatus;
/**
 * @returns the status of the module-level attach (installs on first call)
 */
export declare function getFcmEceWrapperStatus(): EceWrapperStatus;
//# sourceMappingURL=fcm_ece_wrapper.d.ts.map