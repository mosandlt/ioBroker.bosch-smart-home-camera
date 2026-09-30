/**
 * Runtime wrapper for the `@aracna/fcm` "Invalid EC key" bug.
 *
 * `@aracna/fcm` (1.0.33, latest) decrypts incoming push messages with
 * `http_ece.decrypt({ dh: header.slice(3), salt: header.slice(5), ... })`, where
 * the headers are the `crypto-key` / `encryption` entries of the push's
 * `app_data`. The blind slice assumes the value is exactly `dh=<key>` /
 * `salt=<value>`. Headers that carry further segments (`dh=<key>;p256ecdsa=...`)
 * or a different segment order make `dh` / `salt` garbage and the decrypt throws
 * ("Invalid EC key" / "The salt parameter must be 16 bytes").
 *
 * The library keeps no override point, but it calls `decrypt` through the live
 * `http_ece` module object (`require("http_ece").decrypt` at call time). This
 * module wraps that function: the original is always tried first (so working
 * pushes behave exactly as before); only when it throws are `dh` / `salt`
 * re-derived by NAME from the already-sliced values and the call is retried.
 * If the retry cannot help, the original error is rethrown unchanged.
 *
 * Limits: the wrapper only sees the value after the library sliced off its first
 * 3 / 5 characters. It recovers the field when it was the first segment
 * (`dh=K;x=y`) or any later segment (`x=y;dh=K`), with quoting / whitespace /
 * `;`- or `,`-separators. It cannot recover a header the library failed to find
 * at all (the `app_data` key is matched case-sensitively as `crypto-key` /
 * `encryption` inside the library, so a differently-cased key name arrives as
 * `undefined`), nor a field whose name is shorter than the sliced prefix.
 */
import { createRequire } from "node:module";

/** Outcome of the attach attempt, for the one-line startup self-check. */
export interface EceWrapperStatus {
    /** True when `http_ece.decrypt` is wrapped (now or by an earlier call). */
    attached: boolean;
    /** Human-readable reason when `attached` is false. */
    reason?: string;
}

type DecryptFn = (buffer: Buffer, params: Record<string, unknown>) => Buffer;

const WRAPPED = Symbol.for("bosch-smart-home-camera.eceWrapped");
/** Property on the wrapper holding the untouched original (used by tests). */
export const ECE_ORIGINAL = Symbol.for("bosch-smart-home-camera.eceOriginal");

let status: EceWrapperStatus | null = null;

/**
 * Re-derive a header field from a value whose first `skipped` characters were
 * already removed by the library's blind slice.
 *
 * @param sliced Value as passed to `decrypt` (after the library's slice).
 * @param prefix Field prefix incl. "=", e.g. "dh=" or "salt=".
 * @returns The cleaned field value, or `undefined` if nothing better than the
 *   input could be derived.
 */
export function recoverEceField(sliced: unknown, prefix: string): string | undefined {
    if (typeof sliced !== "string") {
        return undefined;
    }
    const clean = (s: string): string =>
        s
            .trim()
            .replace(/^"(.*)"$/, "$1")
            .trim();
    const segments = sliced.split(/[;,]/);
    // Field was a later segment: match it by name (first segment lost its head).
    for (let i = 1; i < segments.length; i++) {
        const seg = segments[i].trim();
        if (seg.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()) {
            return clean(seg.slice(prefix.length));
        }
    }
    // Field was the first segment: its prefix is already gone, drop the rest.
    return clean(segments[0]);
}

/**
 * Attach the wrapper to `http_ece.decrypt` (idempotent, never throws).
 *
 * @param target Optional module object to wrap (tests); defaults to the
 *   `http_ece` instance that `@aracna/fcm` itself resolves.
 * @param target.decrypt The `decrypt` function slot of that module object.
 * @returns attach status
 */
export function installFcmEceWrapper(target?: { decrypt?: unknown }): EceWrapperStatus {
    if (!target && status) {
        return status;
    }
    const result = ((): EceWrapperStatus => {
        try {
            let mod = target;
            if (!mod) {
                const fcmEntry = require.resolve("@aracna/fcm");
                mod = createRequire(fcmEntry)("http_ece") as { decrypt?: unknown };
            }
            const original = mod.decrypt;
            if (typeof original !== "function") {
                return { attached: false, reason: "http_ece.decrypt not found" };
            }
            if ((original as unknown as Record<symbol, unknown>)[WRAPPED]) {
                return { attached: true };
            }
            const wrapped: DecryptFn = function (this: unknown, buffer, params) {
                try {
                    return (original as DecryptFn).call(this, buffer, params);
                } catch (firstErr) {
                    if (!params || typeof params !== "object") {
                        throw firstErr;
                    }
                    const dh = recoverEceField(params.dh, "dh=");
                    const salt = recoverEceField(params.salt, "salt=");
                    if (dh === params.dh && salt === params.salt) {
                        throw firstErr;
                    }
                    try {
                        return (original as DecryptFn).call(this, buffer, {
                            ...params,
                            dh: dh ?? params.dh,
                            salt: salt ?? params.salt,
                        });
                    } catch {
                        throw firstErr;
                    }
                }
            };
            Object.defineProperty(wrapped, WRAPPED, { value: true });
            Object.defineProperty(wrapped, ECE_ORIGINAL, { value: original });
            try {
                mod.decrypt = wrapped;
            } catch {
                /* read-only export, verified below */
            }
            if (mod.decrypt !== wrapped) {
                return { attached: false, reason: "http_ece.decrypt is read-only" };
            }
            return { attached: true };
        } catch (err) {
            return { attached: false, reason: err instanceof Error ? err.message : String(err) };
        }
    })();
    if (!target) {
        status = result;
    }
    return result;
}

/**
 * @returns the status of the module-level attach (installs on first call)
 */
export function getFcmEceWrapperStatus(): EceWrapperStatus {
    return installFcmEceWrapper();
}
