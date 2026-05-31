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
import { type ChildProcess, type SpawnOptionsWithoutStdio } from "node:child_process";
/** RTSP stream instance for MJPEG on Gen2 cameras. */
export declare const MJPEG_INST = 3;
/**
 * Mutable spawn reference. Tests replace this to inject a fake ChildProcess.
 * Production code uses the real Node `spawn`.
 *
 * @internal
 */
export declare const _spawnFn: (command: string, args: string[], options?: SpawnOptionsWithoutStdio) => ChildProcess;
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
 * @param camHost    Camera LAN IP (e.g. "192.168.20.149")
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
export declare function fetchMjpegSnapshot(camHost: string, camPort: number, user: string, password: string, log: {
    debug: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
}, timeoutMs?: number, timers?: {
    set: (cb: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
}): Promise<Buffer | null>;
//# sourceMappingURL=mjpeg_snapshot.d.ts.map