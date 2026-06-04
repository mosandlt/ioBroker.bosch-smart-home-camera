/**
 * Global unit-test guard: never let the REAL FcmListener touch the network.
 *
 * The adapter's FcmListener (build/lib/fcm.js) talks to Google FCM via
 * @aracna/fcm over real sockets. Most main_*.spec.ts files call readyHandler()
 * which constructs and start()s a real FcmListener. Before v1.2.1 that
 * registration failed fast (HTTP 401, default-VAPID bug) so tests never noticed.
 * v1.2.1 fixes the 401 — registration now SUCCEEDS and opens a real MTalk TLS
 * socket, which (a) leaks an open handle and (b) shifts async timing enough to
 * flake every readyHandler-based poll/handler test ("expected undefined").
 *
 * Fix: patch Module._load so any require of build/lib/fcm.js returns a no-network
 * stub whose start() rejects (reproducing the pre-fix "FCM unavailable → polling
 * fallback" path the suite was written against). Files that inject their OWN fcm
 * mock into require.cache (main_fcm_reconnect, main_coverage_fcm_pan) still win,
 * because the cache is consulted first. fcm.spec.ts / fcm_coverage.spec.ts import
 * from src/ (ts-node), not build/, so they are unaffected.
 */

const Module = require("module");
const path = require("path");
const { EventEmitter } = require("events");

const FCM_PATH = path.resolve(__dirname, "..", "..", "..", "build", "lib", "fcm.js");

class FcmListener extends EventEmitter {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor() {
        super();
    }
    updateBearerToken() {}
    async start() {
        // No-op success: registration "succeeds" without any network I/O or
        // sockets. readyHandler kicks off fire-and-forget startup snapshots
        // (Step 4b) BEFORE awaiting start() (Step 5); the real FcmListener took
        // network time here, which incidentally let those snapshots settle
        // before readyHandler returned. Yield a macrotask tick to preserve that
        // ordering so timing-sensitive stream/watchdog tests stay deterministic.
        await new Promise((resolve) => setImmediate(resolve));
    }
    async stop() {}
    getFcmToken() {
        return null;
    }
    isHealthy() {
        return false;
    }
}

class FcmCbsRegistrationError extends Error {
    constructor(httpStatus, message) {
        super(message);
        this.httpStatus = httpStatus;
        this.name = "FcmCbsRegistrationError";
    }
}

class FcmRegistrationError extends Error {
    constructor(message, cause) {
        super(message);
        this.cause = cause;
        this.name = "FcmRegistrationError";
    }
}

const STUB = { FcmListener, FcmCbsRegistrationError, FcmRegistrationError };

// Idempotent: this file is loaded both as a mocharc `require` (before specs) and
// again by the `test/**/*.js` spec glob — patch Module._load only once.
if (Module._load.__fcmPatched) {
    module.exports = STUB;
    return;
}

const origLoad = Module._load;
function patchedLoad(request, parent, isMain) {
    let resolved = null;
    try {
        resolved = Module._resolveFilename(request, parent, isMain);
    } catch {
        resolved = null;
    }
    if (resolved === FCM_PATH) {
        // A per-file require.cache injection (CapturingFcm etc.) takes priority.
        const cached = require.cache[FCM_PATH];
        if (cached && cached.exports) {
            return cached.exports;
        }
        return STUB;
    }
    return origLoad.apply(this, arguments);
}
Module._load = patchedLoad;
Module._load.__fcmPatched = true;
module.exports = STUB;
