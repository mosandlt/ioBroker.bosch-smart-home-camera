/**
 * Unit tests for src/lib/mjpeg_snapshot.ts
 *
 * Tests the MJPEG inst=3 snapshot helper that spawns an FFmpeg subprocess
 * to capture one JPEG frame from Gen2 Bosch cameras via rtsps:// RTSP tunnel.
 *
 * Framework: Mocha + Chai
 * Mocking:   _spawnFn shim — the module exposes a mutable `_spawnFn` for tests
 *            because Node built-in `child_process.spawn` has a read-only property
 *            descriptor and cannot be stubbed via sinon on the namespace object.
 *
 * Source: ported from HA mjpeg_snapshot.py (asyncio → Node child_process.spawn)
 */

import { expect } from "chai";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { fetchMjpegSnapshot, MJPEG_INST } from "../../src/lib/mjpeg_snapshot";
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

// ── Fake ChildProcess builder ──────────────────────────────────────────────────

type SpawnFn = typeof mjpegMod._spawnFn;

function makeFakeSpawn(opts: {
    stdoutData?: Buffer | Buffer[];
    stderrData?: Buffer;
    exitCode?: number;
    delayMs?: number;
    errorEvent?: NodeJS.ErrnoException;
    onKill?: () => void;
}): SpawnFn {
    return () => {
        const { stdoutData, stderrData, exitCode = 0, delayMs = 10, errorEvent, onKill } = opts;

        const fakeProc = new EventEmitter() as unknown as ChildProcess;
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        Object.assign(fakeProc, {
            stdout,
            stderr,
            kill: (_sig?: string) => {
                onKill?.();
            },
        });

        setTimeout(() => {
            if (errorEvent) {
                fakeProc.emit("error", errorEvent);
                return;
            }
            const chunks = Array.isArray(stdoutData) ? stdoutData : stdoutData ? [stdoutData] : [];
            for (const chunk of chunks) stdout.emit("data", chunk);
            if (stderrData) stderr.emit("data", stderrData);
            fakeProc.emit("close", exitCode);
        }, delayMs);

        return fakeProc;
    };
}

// ── Save / restore ─────────────────────────────────────────────────────────────

let originalSpawnFn: SpawnFn;

beforeEach(() => {
    originalSpawnFn = mjpegMod._spawnFn;
});

afterEach(() => {
    mjpegMod._spawnFn = originalSpawnFn;
});

// ── Minimal valid JPEG ─────────────────────────────────────────────────────────

const VALID_JPEG = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from("FAKEJPEGDATA"),
]);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("fetchMjpegSnapshot()", () => {
    // ── Guard: missing params ──────────────────────────────────────────────────

    it("(1) missing camHost → returns null + debug log, no spawn", async () => {
        let spawnCalled = false;
        mjpegMod._spawnFn = (..._args) => {
            spawnCalled = true;
            return makeFakeSpawn({ stdoutData: VALID_JPEG })();
        };

        const { log, capture } = makeLog();
        const result = await fetchMjpegSnapshot("", 443, "user", "pass", log);

        expect(result).to.be.null;
        expect(spawnCalled).to.be.false;
        expect(capture.debugLines.join(" ")).to.match(/missing required params/i);
    });

    it("(2) missing user → returns null + debug log, no spawn", async () => {
        let spawnCalled = false;
        mjpegMod._spawnFn = (..._args) => {
            spawnCalled = true;
            return makeFakeSpawn({ stdoutData: VALID_JPEG })();
        };

        const { log, capture } = makeLog();
        const result = await fetchMjpegSnapshot("192.0.2.1", 443, "", "pass", log);

        expect(result).to.be.null;
        expect(spawnCalled).to.be.false;
        expect(capture.debugLines.join(" ")).to.match(/missing required params/i);
    });

    it("(3) missing password → returns null + debug log, no spawn", async () => {
        let spawnCalled = false;
        mjpegMod._spawnFn = (..._args) => {
            spawnCalled = true;
            return makeFakeSpawn({ stdoutData: VALID_JPEG })();
        };

        const { log, capture } = makeLog();
        const result = await fetchMjpegSnapshot("192.0.2.1", 443, "cbs-user", "", log);

        expect(result).to.be.null;
        expect(spawnCalled).to.be.false;
        expect(capture.debugLines.join(" ")).to.match(/missing required params/i);
    });

    // ── Happy path ─────────────────────────────────────────────────────────────

    it("(4) FFmpeg exits 0 + JPEG bytes → returns Buffer with JPEG magic", async () => {
        const capturedArgs: string[][] = [];
        mjpegMod._spawnFn = (_cmd, args) => {
            capturedArgs.push([...args]);
            return makeFakeSpawn({ stdoutData: VALID_JPEG })();
        };

        const { log } = makeLog();
        const result = await fetchMjpegSnapshot("192.0.2.5", 443, "cbs-abc", "secret", log);

        expect(result).to.not.be.null;
        expect(Buffer.isBuffer(result)).to.be.true;
        expect(result!.slice(0, 2)).to.deep.equal(Buffer.from([0xff, 0xd8]));
        expect(result!).to.deep.equal(VALID_JPEG);

        // Verify RTSP URL structure passed to spawn
        const spawnArgs = capturedArgs[0];
        const iIdx = spawnArgs.indexOf("-i");
        expect(iIdx).to.be.greaterThan(-1);
        const rtspUrl = spawnArgs[iIdx + 1];
        expect(rtspUrl).to.include("rtsps://");
        expect(rtspUrl).to.include("cbs-abc");
        expect(rtspUrl).to.include("192.0.2.5");
        expect(rtspUrl).to.include(`?inst=${MJPEG_INST}`);
    });

    // Regression (dev-sandbox smoke loop 2026-06-02): Bosch cbs Digest passwords
    // contain reserved characters (e.g. "@", ":", "/"). Unescaped, an "@" splits
    // the rtsps:// userinfo wrong and ffmpeg reported "Port missing in uri" — the
    // MJPEG fast path failed for a Gen2 indoor cam. user + password must be
    // percent-encoded (parity with HA mjpeg_snapshot.py quote(..., safe="")).
    it("(4b) reserved chars in user/password are percent-encoded → port preserved", async () => {
        const capturedArgs: string[][] = [];
        mjpegMod._spawnFn = (_cmd, args) => {
            capturedArgs.push([...args]);
            return makeFakeSpawn({ stdoutData: VALID_JPEG })();
        };

        const { log } = makeLog();
        const result = await fetchMjpegSnapshot(
            "192.0.2.5",
            443,
            "cbs-a@b",
            "p@ss:w/rd",
            log,
        );

        expect(result).to.not.be.null;
        const spawnArgs = capturedArgs[0];
        const rtspUrl = spawnArgs[spawnArgs.indexOf("-i") + 1];
        // The raw reserved chars must NOT appear in the authority — they are encoded.
        expect(rtspUrl).to.equal(
            `rtsps://cbs-a%40b:p%40ss%3Aw%2Frd@192.0.2.5:443/rtsp_tunnel?inst=${MJPEG_INST}`,
        );
        // The host:port authority is intact (the bug swallowed the ":443").
        expect(rtspUrl).to.include("@192.0.2.5:443/rtsp_tunnel");
    });

    // ── Non-zero exit code ─────────────────────────────────────────────────────

    it("(5) FFmpeg exits with non-zero code → returns null + warning log", async () => {
        mjpegMod._spawnFn = makeFakeSpawn({
            exitCode: 1,
            stderrData: Buffer.from("Input/output error"),
        });

        const { log, capture } = makeLog();
        const result = await fetchMjpegSnapshot("192.0.2.1", 443, "cbs-user", "pass", log);

        expect(result).to.be.null;
        // v1.2.2: soft failure (caller falls back to snap.jpg) → logged at debug, not warn.
        expect(capture.debugLines.join(" ")).to.match(/exited with code 1/i);
        expect(capture.warnLines.join(" "), "no warn-level noise for soft failure").to.equal("");
    });

    // Security (2026-06-02): ffmpeg echoes the full input URL incl. Digest
    // credentials in its stderr. The warning log must REDACT the userinfo so the
    // camera's local-session password never lands in the ioBroker log.
    it("(5b) credentials in ffmpeg stderr are redacted from the warning log", async () => {
        mjpegMod._spawnFn = makeFakeSpawn({
            exitCode: 234,
            stderrData: Buffer.from(
                "Error opening input file rtsps://cbs-00000000:fakeSecret@192.0.2.9:443/rtsp_tunnel",
            ),
        });

        const { log, capture } = makeLog();
        const result = await fetchMjpegSnapshot("192.0.2.9", 443, "cbs-00000000", "fakeSecret", log);

        expect(result).to.be.null;
        // v1.2.2: soft FFmpeg failure is logged at debug now (caller has a fallback);
        // redaction must still hold so the password never lands in any log line.
        const joined = [...capture.debugLines, ...capture.warnLines].join(" ");
        expect(joined, "password must not appear in the log").to.not.include("fakeSecret");
        expect(joined, "userinfo is redacted to ***").to.include("rtsps://***@192.0.2.9:443");
    });

    // ── Empty stdout ───────────────────────────────────────────────────────────

    it("(6) FFmpeg exits 0 but empty stdout → returns null + warning log", async () => {
        mjpegMod._spawnFn = makeFakeSpawn({ stdoutData: Buffer.alloc(0), exitCode: 0 });

        const { log, capture } = makeLog();
        const result = await fetchMjpegSnapshot("192.0.2.1", 443, "cbs-user", "pass", log);

        expect(result).to.be.null;
        expect(capture.debugLines.join(" ")).to.match(/empty output/i);
    });

    // ── Non-JPEG magic bytes ───────────────────────────────────────────────────

    it("(7) FFmpeg exits 0 but output lacks JPEG magic → returns null + warning log", async () => {
        const notJpeg = Buffer.from("PNG\x89PNG\r\n\x1a\n");
        mjpegMod._spawnFn = makeFakeSpawn({ stdoutData: notJpeg, exitCode: 0 });

        const { log, capture } = makeLog();
        const result = await fetchMjpegSnapshot("192.0.2.1", 443, "cbs-user", "pass", log);

        expect(result).to.be.null;
        expect(capture.debugLines.join(" ")).to.match(/JPEG magic/i);
    });

    // ── Timeout ───────────────────────────────────────────────────────────────

    it("(8) FFmpeg hangs beyond timeoutMs → returns null + warning log + kill called", async () => {
        let killCalled = false;
        mjpegMod._spawnFn = makeFakeSpawn({
            stdoutData: VALID_JPEG,
            delayMs: 5000,
            onKill: () => { killCalled = true; },
        });

        const { log, capture } = makeLog();
        const result = await fetchMjpegSnapshot("192.0.2.1", 443, "cbs-user", "pass", log, 50);

        expect(result).to.be.null;
        expect(killCalled).to.be.true;
        expect(capture.warnLines.join(" ")).to.match(/timeout/i);
    });

    // ── ffmpeg not found ───────────────────────────────────────────────────────

    it("(9) ffmpeg binary not found (ENOENT from error event) → returns null + error log", async () => {
        const enoent = Object.assign(new Error("spawn ffmpeg ENOENT"), {
            code: "ENOENT",
        }) as NodeJS.ErrnoException;
        mjpegMod._spawnFn = makeFakeSpawn({ errorEvent: enoent });

        const { log, capture } = makeLog();
        const result = await fetchMjpegSnapshot("192.0.2.1", 443, "cbs-user", "pass", log);

        expect(result).to.be.null;
        expect(capture.errorLines.join(" ")).to.match(/ffmpeg not found/i);
    });

    // ── RTSP URL format ────────────────────────────────────────────────────────

    it("(10) verifies RTSP URL structure — port + inst + user/pass embedded", async () => {
        const capturedArgs: string[][] = [];
        mjpegMod._spawnFn = (_cmd, args) => {
            capturedArgs.push([...args]);
            return makeFakeSpawn({ stdoutData: VALID_JPEG })();
        };

        const { log } = makeLog();
        await fetchMjpegSnapshot("10.0.0.1", 443, "cbs-test", "mypassword", log);

        const spawnArgs = capturedArgs[0];
        const iIdx = spawnArgs.indexOf("-i");
        const url = spawnArgs[iIdx + 1];
        expect(url).to.equal(
            `rtsps://cbs-test:mypassword@10.0.0.1:443/rtsp_tunnel?inst=${MJPEG_INST}`,
        );
    });

    // ── Large JPEG (multi-chunk stdout) ───────────────────────────────────────

    it("(11) large JPEG buffer (multi-chunk stdout) → concatenated correctly", async () => {
        const chunk1 = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
        const chunk2 = Buffer.alloc(10_000, 0xab);
        mjpegMod._spawnFn = makeFakeSpawn({ stdoutData: [chunk1, chunk2] });

        const { log } = makeLog();
        const result = await fetchMjpegSnapshot("192.0.2.1", 443, "cbs-user", "pass", log);

        expect(result).to.not.be.null;
        expect(result!.length).to.equal(chunk1.length + chunk2.length);
        expect(result!.slice(0, 2)).to.deep.equal(Buffer.from([0xff, 0xd8]));
    });
});

// ── MJPEG_INST constant ────────────────────────────────────────────────────────

describe("MJPEG_INST constant", () => {
    it("(12) MJPEG_INST === 3 (RTSP stream instance for Gen2 MJPEG)", () => {
        expect(MJPEG_INST).to.equal(3);
    });
});
