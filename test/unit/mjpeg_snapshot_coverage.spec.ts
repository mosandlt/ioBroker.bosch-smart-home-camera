/**
 * Coverage gap tests for src/lib/mjpeg_snapshot.ts
 *
 * Targets the lines/branches NOT hit by mjpeg_snapshot.spec.ts:
 *
 *   Line 112-113  — settle() guard: second call while already settled is a no-op
 *   Line 126-127  — killProc() catch: proc.kill() throws (race: process already exited)
 *   Line 150-158  — synchronous throw from _spawnFn:
 *                     ENOENT (line 152 log.error branch)
 *                     other OS error (line 154 log.warn branch)
 *   Line 170-171  — proc "error" event with non-ENOENT code (log.warn branch)
 *   Line 217-218  — timeout fires but settle() was already called (timeout guard no-op)
 *
 * Framework: Mocha + Chai
 * Mocking:   _spawnFn shim (see mjpeg_snapshot.ts TESTABILITY NOTE)
 */

import { expect } from "chai";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { fetchMjpegSnapshot } from "../../src/lib/mjpeg_snapshot";
import * as mjpegMod from "../../src/lib/mjpeg_snapshot";

// ── Logger stub ────────────────────────────────────────────────────────────────

interface LogCapture {
    debugLines: string[];
    warnLines: string[];
    errorLines: string[];
}

function makeLog(): { log: Parameters<typeof fetchMjpegSnapshot>[4]; capture: LogCapture } {
    const capture: LogCapture = { debugLines: [], warnLines: [], errorLines: [] };
    const log = {
        debug: (msg: string) => capture.debugLines.push(msg),
        warn: (msg: string) => capture.warnLines.push(msg),
        error: (msg: string) => capture.errorLines.push(msg),
    };
    return { log, capture };
}

// ── Fake ChildProcess builder (mirrors sibling spec) ──────────────────────────

type SpawnFn = typeof mjpegMod._spawnFn;

function makeFakeSpawn(opts: {
    stdoutData?: Buffer;
    stderrData?: Buffer;
    exitCode?: number;
    delayMs?: number;
    errorEvent?: NodeJS.ErrnoException;
    onKill?: () => void;
    killThrows?: boolean;
}): SpawnFn {
    return () => {
        const {
            stdoutData,
            stderrData,
            exitCode = 0,
            delayMs = 10,
            errorEvent,
            onKill,
            killThrows = false,
        } = opts;

        const fakeProc = new EventEmitter() as unknown as ChildProcess;
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        Object.assign(fakeProc, {
            stdout,
            stderr,
            kill: (_sig?: string) => {
                onKill?.();
                if (killThrows) {
                    throw new Error("process already exited");
                }
            },
        });

        setTimeout(() => {
            if (errorEvent) {
                fakeProc.emit("error", errorEvent);
                return;
            }
            if (stdoutData && stdoutData.length > 0) stdout.emit("data", stdoutData);
            if (stderrData) stderr.emit("data", stderrData);
            fakeProc.emit("close", exitCode);
        }, delayMs);

        return fakeProc;
    };
}

// ── Minimal valid JPEG ─────────────────────────────────────────────────────────

const VALID_JPEG = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from("FAKEJPEGDATA"),
]);

// ── Save / restore ─────────────────────────────────────────────────────────────

let originalSpawnFn: SpawnFn;

beforeEach(() => {
    originalSpawnFn = mjpegMod._spawnFn;
});

afterEach(() => {
    mjpegMod._spawnFn = originalSpawnFn;
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("fetchMjpegSnapshot() — coverage gaps", () => {
    // ── settle() guard: second call is no-op (lines 112-113) ──────────────────
    // The guard is exercised when the timeout fires after close has already settled.
    // We force this by using a very short timeout that fires slightly AFTER the close
    // event resolves the promise, then checking that the first settled result wins.

    it("(C1) settle() called twice (close then timeout race) — first wins, no double-resolve", async () => {
        // FFmpeg returns a valid JPEG almost immediately (5 ms)
        // Timeout is set to 8 ms — timeout fires AFTER close, but settle() guard
        // prevents double-resolution. If guard were missing, the resolved value
        // might change or an exception would surface.
        mjpegMod._spawnFn = makeFakeSpawn({
            stdoutData: VALID_JPEG,
            exitCode: 0,
            delayMs: 5,
        });

        const { log } = makeLog();
        // Short timeout (8 ms) so both close (~5 ms) and timeout (~8 ms) events fire
        const result = await fetchMjpegSnapshot("192.0.2.1", 443, "cbs-user", "pass", log, 8);
        // First settler was the close event → valid JPEG
        expect(result).to.not.be.null;
        expect(result![0]).to.equal(0xff);
        expect(result![1]).to.equal(0xd8);
    });

    // ── killProc() catch branch: proc.kill() throws (lines 126-127) ───────────
    // Happens when timeout fires but the OS process already exited between the
    // timeout check and the kill() call. The catch swallows the error silently.

    it("(C2) killProc() throws on kill (process already exited) — swallowed, returns null", async () => {
        let killAttempted = false;
        mjpegMod._spawnFn = makeFakeSpawn({
            stdoutData: VALID_JPEG,
            exitCode: 0,
            delayMs: 5000, // never fires within timeout
            killThrows: true,
            onKill: () => {
                killAttempted = true;
            },
        });

        const { log, capture } = makeLog();
        // 20 ms timeout — process hangs, kill() throws; must not propagate
        const result = await fetchMjpegSnapshot("192.0.2.1", 443, "cbs-user", "pass", log, 20);
        expect(result).to.be.null;
        expect(killAttempted).to.be.true;
        // The timeout warn must still fire even when kill throws
        expect(capture.warnLines.join(" ")).to.match(/timeout/i);
    });

    // ── Synchronous spawn throw — ENOENT (lines 150-152) ──────────────────────
    // When the OS cannot find the ffmpeg binary, spawn() itself throws synchronously
    // with code ENOENT. The try-catch in fetchMjpegSnapshot must call log.error.

    it("(C3) _spawnFn throws synchronously with ENOENT → null + log.error", async () => {
        const enoentErr = Object.assign(new Error("spawn ffmpeg ENOENT"), {
            code: "ENOENT",
        }) as NodeJS.ErrnoException;

        mjpegMod._spawnFn = () => {
            throw enoentErr;
        };

        const { log, capture } = makeLog();
        const result = await fetchMjpegSnapshot("192.0.2.1", 443, "cbs-user", "pass", log);

        expect(result).to.be.null;
        expect(capture.errorLines.join(" ")).to.match(/ffmpeg not found/i);
        expect(capture.warnLines.length).to.equal(0);
    });

    // ── Synchronous spawn throw — other OS error (lines 153-155) ─────────────
    // A non-ENOENT spawn error (e.g. EPERM, ENOMEM) must go to log.warn instead.

    it("(C4) _spawnFn throws synchronously with EPERM (non-ENOENT) → null + log.warn", async () => {
        const epermErr = Object.assign(new Error("spawn ffmpeg EPERM"), {
            code: "EPERM",
        }) as NodeJS.ErrnoException;

        mjpegMod._spawnFn = () => {
            throw epermErr;
        };

        const { log, capture } = makeLog();
        const result = await fetchMjpegSnapshot("192.0.2.1", 443, "cbs-user", "pass", log);

        expect(result).to.be.null;
        expect(capture.warnLines.join(" ")).to.match(/OS error spawning ffmpeg/i);
        expect(capture.errorLines.length).to.equal(0);
    });

    // ── Synchronous spawn throw — non-Error value (line 150 String() branch) ──
    // The message coercion `String(spawnErr)` is the else branch when the thrown
    // value is not an Error instance. Use a plain string throw.

    it("(C5) _spawnFn throws a non-Error string → null + log.warn (String coercion)", async () => {
        mjpegMod._spawnFn = () => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw "some unexpected throw";
        };

        const { log, capture } = makeLog();
        const result = await fetchMjpegSnapshot("192.0.2.1", 443, "cbs-user", "pass", log);

        expect(result).to.be.null;
        // code === undefined → non-ENOENT branch → log.warn
        expect(capture.warnLines.join(" ")).to.match(/OS error spawning ffmpeg/i);
    });

    // ── proc "error" event — non-ENOENT code (lines 170-171) ─────────────────
    // The "error" event handler distinguishes ENOENT (log.error) from other
    // codes (log.warn). Test 9 in the sibling spec covers the ENOENT path;
    // here we cover the warn branch via a non-ENOENT error code.

    it("(C6) proc 'error' event with ECONNRESET → null + log.warn", async () => {
        const connErr = Object.assign(new Error("connection reset"), {
            code: "ECONNRESET",
        }) as NodeJS.ErrnoException;
        mjpegMod._spawnFn = makeFakeSpawn({ errorEvent: connErr });

        const { log, capture } = makeLog();
        const result = await fetchMjpegSnapshot("192.0.2.1", 443, "cbs-user", "pass", log);

        expect(result).to.be.null;
        expect(capture.warnLines.join(" ")).to.match(/OS error from ffmpeg process/i);
        expect(capture.errorLines.length).to.equal(0);
    });

    // ── Timeout fires when already settled (lines 217-218) ────────────────────
    // When the timeout watchdog fires after "close" has already settled the
    // promise, `if (settled) return` on line 217-218 exits early.
    // Verify: no second warn fires, and the result is what the close event set.

    it("(C7) timeout fires after close already settled — guard no-op, no spurious warn", async () => {
        // close fires at 5 ms with a valid JPEG; timeout at 50 ms
        // After the promise resolves, the remaining setTimeout callback fires the
        // timeout branch which must hit `if (settled) return` and do nothing.
        mjpegMod._spawnFn = makeFakeSpawn({
            stdoutData: VALID_JPEG,
            exitCode: 0,
            delayMs: 5,
        });

        const { log, capture } = makeLog();
        const result = await fetchMjpegSnapshot("192.0.2.1", 443, "cbs-user", "pass", log, 50);

        // Let the dangling timeout fire
        await new Promise((r) => setTimeout(r, 60));

        expect(result).to.not.be.null;
        // Timeout warn must NOT appear — guard caught it
        expect(capture.warnLines.filter((l) => /timeout/i.test(l))).to.have.length(0);
    });
});
