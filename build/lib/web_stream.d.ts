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
export declare let _streamSpawnFn: StreamSpawnFn;
/** Test seam: swap the spawn implementation. */
export declare function _setStreamSpawnFn(fn: StreamSpawnFn): void;
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
/** Manages per-camera FFmpeg MJPEG processes and their viewing UI clients. */
export declare class WebStreamManager {
    private readonly deps;
    private readonly minGap;
    private readonly streams;
    /**
     * @param deps adapter-side hooks (URL resolver, frame sink, logger)
     */
    constructor(deps: WebStreamDeps);
    /** Number of cameras currently streaming (for tests/diagnostics). */
    get activeCount(): number;
    /**
     * Register a viewer for a camera, starting FFmpeg on the first viewer.
     * Returns false if no live URL is available (caller rejects the subscribe).
     *
     * @param clientId UI client id
     * @param camId camera cloud-ID
     * @param width desired scale width (0 = native)
     */
    addViewer(clientId: string, camId: string, width: number): boolean;
    /**
     * Drop a viewer from a camera (or all cameras if camId omitted); stops
     * FFmpeg when the last viewer of a camera leaves.
     *
     * @param clientId UI client id
     * @param camId optional camera cloud-ID; omit to remove from every camera
     */
    removeViewer(clientId: string, camId?: string): void;
    /** Stop every FFmpeg process (adapter unload). */
    stopAll(): void;
    private dropFrom;
    private killProc;
    private spawnFfmpeg;
    private wire;
    private onData;
    private emitFrame;
}
//# sourceMappingURL=web_stream.d.ts.map