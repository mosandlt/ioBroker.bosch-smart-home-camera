/**
 * web_stream.ts — continuous MJPEG frame streaming for the vis-2 widget.
 *
 * The vis-2 BoschCamera widget (mode "mjpeg") subscribes via
 * `socket.subscribeOnInstance(instance, "startCamera/<camId>", {width}, cb)`.
 * adapter-core routes that to the adapter's `uiClientSubscribe` handler; we
 * register the viewer here, spawn one shared FFmpeg per camera that pulls the
 * local RTSP proxy and muxes a 2-fps MJPEG stream, split the stdout into single
 * JPEG frames (SOI 0xFFD8 marker at chunk start) and push each frame as a
 * base64 string to every viewing client via `adapter.sendToUI`.
 *
 * Mirrors the proven contract of ioBroker.cameras (GenericRtspCamera) but uses
 * a raw `child_process.spawn` (no fluent-ffmpeg dependency) and is fully unit
 * testable via the injected `spawn` shim.
 *
 * NOTE: end-to-end frame delivery needs a running vis-2 + an active Bosch live
 * session (livestream_enabled=true so the TLS proxy listens). The frame parser,
 * viewer lifecycle and rate limiting are unit tested; live delivery must be
 * verified on a real vis-2 instance.
 */
import { spawn as nodeSpawn } from "node:child_process";
import type { Readable } from "node:stream";

/** Minimal child-process surface used here — keeps the spawn shim testable. */
export interface StreamProcLike {
    /** FFmpeg stdout — the MJPEG byte stream. */
    stdout: Readable | null;
    /** FFmpeg stderr — diagnostics only. */
    stderr: Readable | null;
    /**
     * Register a process lifecycle listener.
     *
     * @param event process event
     * @param listener handler
     */
    on(event: "error" | "close" | "exit", listener: (...args: unknown[]) => void): void;
    /**
     * Terminate the process.
     *
     * @param signal optional kill signal
     */
    kill(signal?: NodeJS.Signals): void;
}

export type StreamSpawnFn = (cmd: string, args: string[]) => StreamProcLike;

/** Replaceable spawn — overridden in unit tests. */
export let _streamSpawnFn: StreamSpawnFn = (cmd, args) =>
    nodeSpawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

/** Test seam: swap the spawn implementation. */
export function _setStreamSpawnFn(fn: StreamSpawnFn): void {
    _streamSpawnFn = fn;
}

/** Adapter-side hooks the stream manager needs (kept injectable for testing). */
export interface WebStreamDeps {
    /**
     * Resolve the local RTSP URL FFmpeg should read for a camera, or null if no
     * live session/proxy is active (then the subscription is rejected).
     *
     * @param camId camera cloud-ID
     */
    resolveUrl(camId: string): string | null;
    /**
     * Push a base64 JPEG frame to one UI client. Should resolve/reject like
     * `adapter.sendToUI`; a rejection containing "not registered" drops the
     * client.
     *
     * @param clientId UI client id from uiClientSubscribe
     * @param base64 base64-encoded JPEG frame
     */
    sendFrame(clientId: string, base64: string): Promise<void>;
    /** Logger (adapter.log subset). */
    log: {
        /** Debug-level log. */
        debug: (m: string) => void;
        /** Warn-level log. */
        warn: (m: string) => void;
        /** Info-level log. */
        info: (m: string) => void;
    };
    /** ffmpeg binary path; defaults to "ffmpeg" (OS PATH). */
    ffmpegPath?: string;
    /** Minimum gap between forwarded frames (ms). Default 300. */
    minFrameGapMs?: number;
}

interface CamStream {
    proc: StreamProcLike;
    buf: Buffer;
    lastSentTs: number;
    width: number;
    viewers: Set<string>;
}

const SOI0 = 0xff;
const SOI1 = 0xd8;

/** Manages per-camera FFmpeg MJPEG processes and their viewing UI clients. */
export class WebStreamManager {
    private readonly deps: WebStreamDeps;
    private readonly minGap: number;
    private readonly streams = new Map<string, CamStream>();

    /**
     * @param deps adapter-side hooks (URL resolver, frame sink, logger)
     */
    public constructor(deps: WebStreamDeps) {
        this.deps = deps;
        this.minGap = deps.minFrameGapMs ?? 300;
    }

    /** Number of cameras currently streaming (for tests/diagnostics). */
    public get activeCount(): number {
        return this.streams.size;
    }

    /**
     * Register a viewer for a camera, starting FFmpeg on the first viewer.
     * Returns false if no live URL is available (caller rejects the subscribe).
     *
     * @param clientId UI client id
     * @param camId camera cloud-ID
     * @param width desired scale width (0 = native)
     */
    public addViewer(clientId: string, camId: string, width: number): boolean {
        let s = this.streams.get(camId);
        if (s) {
            s.viewers.add(clientId);
            return true;
        }
        const url = this.deps.resolveUrl(camId);
        if (!url) {
            return false;
        }
        const proc = this.spawnFfmpeg(url, width);
        s = { proc, buf: Buffer.alloc(0), lastSentTs: 0, width, viewers: new Set([clientId]) };
        this.streams.set(camId, s);
        this.wire(camId, s);
        this.deps.log.debug(
            `web_stream: started MJPEG for ${camId.slice(0, 8)} (viewer ${clientId})`,
        );
        return true;
    }

    /**
     * Drop a viewer from a camera (or all cameras if camId omitted); stops
     * FFmpeg when the last viewer of a camera leaves.
     *
     * @param clientId UI client id
     * @param camId optional camera cloud-ID; omit to remove from every camera
     */
    public removeViewer(clientId: string, camId?: string): void {
        if (camId) {
            this.dropFrom(camId, clientId);
            return;
        }
        for (const id of [...this.streams.keys()]) {
            this.dropFrom(id, clientId);
        }
    }

    /** Stop every FFmpeg process (adapter unload). */
    public stopAll(): void {
        for (const [, s] of this.streams) {
            this.killProc(s);
        }
        this.streams.clear();
    }

    private dropFrom(camId: string, clientId: string): void {
        const s = this.streams.get(camId);
        if (!s) {
            return;
        }
        s.viewers.delete(clientId);
        if (s.viewers.size === 0) {
            this.killProc(s);
            this.streams.delete(camId);
            this.deps.log.debug(`web_stream: stopped MJPEG for ${camId.slice(0, 8)} (no viewers)`);
        }
    }

    private killProc(s: CamStream): void {
        try {
            s.proc.kill("SIGKILL");
        } catch {
            /* already gone */
        }
    }

    private spawnFfmpeg(url: string, width: number): StreamProcLike {
        const args = [
            "-loglevel",
            "error",
            "-rtsp_transport",
            "tcp",
            "-i",
            url,
            "-an",
            "-f",
            "mjpeg",
            "-r",
            "2",
            "-q:v",
            "5",
        ];
        if (width > 0) {
            args.push("-vf", `scale=${width}:-2`);
        }
        args.push("pipe:1");
        return _streamSpawnFn(this.deps.ffmpegPath || "ffmpeg", args);
    }

    private wire(camId: string, s: CamStream): void {
        s.proc.stdout?.on("data", (chunk: Buffer) => this.onData(camId, s, chunk));
        s.proc.stderr?.on("data", (d: Buffer) =>
            this.deps.log.debug(`web_stream ffmpeg[${camId.slice(0, 8)}]: ${d.toString().trim()}`),
        );
        s.proc.on("error", (err: unknown) => {
            this.deps.log.warn(`web_stream ffmpeg error ${camId.slice(0, 8)}: ${String(err)}`);
            this.streams.delete(camId);
        });
        s.proc.on("close", () => {
            this.streams.delete(camId);
        });
    }

    private onData(camId: string, s: CamStream, chunk: Buffer): void {
        // FFmpeg's mjpeg muxer emits each frame starting with SOI (0xFFD8).
        // A chunk that begins with SOI means the previously accumulated buffer
        // is a complete frame.
        if (chunk.length >= 2 && chunk[0] === SOI0 && chunk[1] === SOI1) {
            if (s.buf.length > 2) {
                this.emitFrame(camId, s);
            }
            s.buf = Buffer.from(chunk);
        } else {
            s.buf = s.buf.length ? Buffer.concat([s.buf, chunk]) : Buffer.from(chunk);
        }
    }

    private emitFrame(camId: string, s: CamStream): void {
        const now = Date.now();
        if (now - s.lastSentTs < this.minGap) {
            return; // rate limit
        }
        s.lastSentTs = now;
        const frame = s.buf.toString("base64");
        for (const clientId of [...s.viewers]) {
            this.deps.sendFrame(clientId, frame).catch((e: unknown) => {
                if (String(e).includes("not registered")) {
                    this.dropFrom(camId, clientId);
                } else {
                    this.deps.log.debug(`web_stream sendToUI failed: ${String(e)}`);
                }
            });
        }
    }
}
