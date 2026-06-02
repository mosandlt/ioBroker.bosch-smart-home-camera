"use strict";
/**
 * MJPEG inst=3 snapshot helper for Gen2 Bosch Smart Home Cameras.
 *
 * Gen2 cameras (HOME_Eyes_Outdoor, HOME_Eyes_Indoor) expose an undocumented
 * MJPEG stream on RTSP inst=3 (RTP/AVP 26). This module captures exactly one
 * JPEG frame from that stream via an FFmpeg subprocess.
 *
 * APPROACH: child_process.spawn("ffmpeg", ...)
 *   A pure-TypeScript RTSP+RTP+MJPEG client requires >500 LOC. Using spawn
 *   with FFmpeg achieves the same result in ~40 LOC. FFmpeg is typically
 *   available on ioBroker hosts (media processing dependency).
 *   Subprocess overhead is still faster than a cloud snap.jpg round-trip:
 *   ~150-300 ms vs. ~500-1500 ms via cloud.
 *
 * Auth: Digest credentials from PUT /v11/video_inputs/{id}/connection LOCAL.
 *   The rotating ~60 s TTL means snapshots must use recently-fetched creds.
 *
 * Reference: HA mjpeg_snapshot.py (ported from Python asyncio to Node spawn)
 *
 * TESTABILITY NOTE:
 *   Node built-in `child_process.spawn` has a read-only property descriptor and
 *   cannot be stubbed via sinon on the module namespace. We therefore expose
 *   `_spawnFn` as a mutable export so unit tests can replace it without
 *   touching the real `child_process` module object.
 *   Production code MUST NOT reassign `_spawnFn`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports._spawnFn = exports.MJPEG_INST = void 0;
exports.fetchMjpegSnapshot = fetchMjpegSnapshot;
const node_child_process_1 = require("node:child_process");
// ── Constants ──────────────────────────────────────────────────────────────────
/** RTSP stream instance for MJPEG on Gen2 cameras. */
exports.MJPEG_INST = 3;
/** Minimal sanity check: a valid JPEG starts with 0xFF 0xD8. */
const JPEG_MAGIC = Buffer.from([0xff, 0xd8]);
// ── Testability shim ───────────────────────────────────────────────────────────
/**
 * Mutable spawn reference. Tests replace this to inject a fake ChildProcess.
 * Production code uses the real Node `spawn`.
 *
 * @internal
 */
exports._spawnFn = node_child_process_1.spawn;
// ── Main export ────────────────────────────────────────────────────────────────
/**
 * Capture one JPEG frame from the Gen2 MJPEG stream (inst=3).
 *
 * Connects to `rtsps://{user}:{password}@{camHost}:{camPort}/rtsp_tunnel?inst=3`
 * via an FFmpeg subprocess, extracts exactly one frame, and returns it as a
 * JPEG Buffer.
 *
 * Guards:
 *   - Returns null (with debug log) when any required param is empty.
 *   - Returns null (with warning log) on timeout, non-zero exit code, empty
 *     output, or non-JPEG magic bytes.
 *   - Returns null (with error log) when ffmpeg binary is not found.
 *   - Kills the lingering process on timeout to prevent zombie accumulation.
 *
 * @param camHost    Camera LAN IP (e.g. "192.0.2.149")
 * @param camPort    Camera RTSP-over-TLS port (always 443 for Bosch cameras)
 * @param user       CBS username from PUT /connection (e.g. "cbs-XXXXXXXX")
 * @param password   Digest password from PUT /connection
 * @param log        ioBroker logger (or any object with .debug/.warn/.error)
 * @param log.debug
 * @param log.warn
 * @param log.error
 * @param timeoutMs  Maximum ms to wait for a frame. Default 8000 ms.
 * @returns JPEG bytes as Buffer on success; null otherwise.
 */
async function fetchMjpegSnapshot(camHost, camPort, user, password, log, timeoutMs = 8000, timers = { set: globalThis.setTimeout, clear: (h) => clearTimeout(h) }) {
    if (!camHost || !user || !password) {
        log.debug("fetchMjpegSnapshot: missing required params — skipping");
        return null;
    }
    // URL-encode user + password — Bosch cbs Digest passwords contain reserved
    // characters (e.g. "@", ":", "/") that otherwise break the rtsps:// authority
    // parsing and make ffmpeg report "Port missing in uri" (the port is swallowed
    // when an unescaped "@" splits the userinfo wrong). Parity with the HA Python
    // mjpeg_snapshot.py (quote(..., safe="")). Found via dev-sandbox smoke loop
    // 2026-06-02 on a Gen2 indoor camera whose Digest password contained "?".
    const safeUser = encodeURIComponent(user);
    const safePass = encodeURIComponent(password);
    const rtspUrl = `rtsps://${safeUser}:${safePass}@${camHost}:${camPort}` + `/rtsp_tunnel?inst=${exports.MJPEG_INST}`;
    const t0 = Date.now();
    let proc = null;
    return new Promise((resolve) => {
        let settled = false;
        let timeoutHandle = null;
        function settle(result) {
            if (settled) {
                return;
            }
            settled = true;
            if (timeoutHandle !== null) {
                timers.clear(timeoutHandle);
            }
            resolve(result);
        }
        function killProc() {
            if (proc !== null) {
                try {
                    proc.kill("SIGKILL");
                }
                catch {
                    // race: process already exited
                }
            }
        }
        try {
            proc = (0, exports._spawnFn)("ffmpeg", [
                "-loglevel",
                "error",
                "-rtsp_flags",
                "prefer_tcp",
                "-allowed_media_types",
                "video",
                "-i",
                rtspUrl,
                "-vframes",
                "1",
                "-c:v",
                "copy",
                "-f",
                "image2pipe",
                "-",
            ]);
        }
        catch (spawnErr) {
            const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
            if (spawnErr.code === "ENOENT") {
                log.error("fetchMjpegSnapshot: ffmpeg not found — cannot capture MJPEG snapshot");
            }
            else {
                log.warn(`fetchMjpegSnapshot: OS error spawning ffmpeg: ${msg}`);
            }
            settle(null);
            return;
        }
        const stdoutChunks = [];
        const stderrChunks = [];
        proc.stdout?.on("data", (chunk) => stdoutChunks.push(chunk));
        proc.stderr?.on("data", (chunk) => stderrChunks.push(chunk));
        proc.on("error", (err) => {
            if (err.code === "ENOENT") {
                log.error("fetchMjpegSnapshot: ffmpeg not found — cannot capture MJPEG snapshot");
            }
            else {
                log.warn(`fetchMjpegSnapshot: OS error from ffmpeg process: ${err.message}`);
            }
            settle(null);
        });
        proc.on("close", (code) => {
            const elapsedMs = Date.now() - t0;
            if (settled) {
                return;
            } // timeout already fired
            if (code !== 0) {
                // Redact Digest credentials before logging: ffmpeg echoes the full
                // input URL (rtsps://user:password@host:port/…) in its stderr, which
                // would leak the camera's local-session password into the ioBroker
                // log. Replace any URL userinfo with "***". (2026-06-02)
                const stderrText = (Buffer.concat(stderrChunks).toString("utf8", 0, 200) || "(no stderr)").replace(/(rtsps?:\/\/)[^@\s/]+@/gi, "$1***@");
                log.warn(`fetchMjpegSnapshot: FFmpeg exited with code ${code} for ${camHost} — ${stderrText}`);
                settle(null);
                return;
            }
            const out = Buffer.concat(stdoutChunks);
            if (out.length === 0) {
                log.warn(`fetchMjpegSnapshot: FFmpeg returned empty output for ${camHost}`);
                settle(null);
                return;
            }
            // Sanity-check: output must start with JPEG magic bytes 0xFF 0xD8
            if (out[0] !== JPEG_MAGIC[0] || out[1] !== JPEG_MAGIC[1]) {
                log.warn(`fetchMjpegSnapshot: output does not start with JPEG magic ` +
                    `(got ${out.slice(0, 4).toString("hex")}) for ${camHost} — discarding`);
                settle(null);
                return;
            }
            log.debug(`fetchMjpegSnapshot: ${out.length} bytes in ${elapsedMs} ms for ${camHost}`);
            settle(out);
        });
        // Arm timeout watchdog
        timeoutHandle = timers.set(() => {
            if (settled) {
                return;
            }
            const elapsedMs = Date.now() - t0;
            log.warn(`fetchMjpegSnapshot: timeout after ${elapsedMs} ms for ${camHost}`);
            killProc();
            settle(null);
        }, timeoutMs);
    });
}
//# sourceMappingURL=mjpeg_snapshot.js.map