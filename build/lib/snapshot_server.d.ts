/**
 * Bosch Smart Home Camera — local HTTP snapshot server.
 *
 * Serves the latest cached JPEG per camera over plain HTTP on the LAN, so an
 * ioBroker VIS image widget (or any browser / type-detector consumer) can load
 * `http://<host>:<port>/<camId>.jpg` with a simple refresh loop — no token, no
 * CORS dance, no web-adapter file-store path coupling.
 *
 * This mirrors the approach used by other ioBroker camera adapters (e.g. onvif)
 * and unlocks the `url.cam` state role: a state holding this URL is recognised
 * by the ioBroker type-detector as a camera and rendered by VIS camera widgets.
 *
 * Security: LAN-only, no authentication (the JPEG is a single still frame, not
 * the live RTSP stream). Bind to a specific interface via `bindHost` if needed;
 * default binds all interfaces so VIS on another host can reach it.
 *
 * Lifecycle: created in main.onReady (only when snapshot_http_port > 0), closed
 * in main.onUnload. The buffer lookup is a callback into the adapter's in-memory
 * map, so no snapshot data is duplicated here.
 */
import * as http from "node:http";
/** Minimal logger shape (a subset of ioBroker.Logger) the server needs. */
export interface SnapshotServerLog {
    /** Verbose diagnostics. */
    debug: (msg: string) => void;
    /** Lifecycle info (listening / closed). */
    info: (msg: string) => void;
    /** Recoverable problems (bind failure → feature disabled). */
    warn: (msg: string) => void;
    /** Errors. */
    error: (msg: string) => void;
}
/** Construction options for {@link startSnapshotServer}. */
export interface SnapshotServerOptions {
    /** TCP port to listen on (caller guarantees > 0). */
    port: number;
    /** Interface to bind. Default "0.0.0.0" (all interfaces). */
    bindHost?: string;
    /**
     * Returns the latest JPEG for a camera id, or undefined if none cached yet.
     * Called per request — the adapter keeps the buffers, this server only reads.
     */
    getSnapshot: (camId: string) => Buffer | undefined;
    /** Logger sink. */
    log: SnapshotServerLog;
}
/** Running snapshot server, returned by {@link startSnapshotServer}. */
export interface SnapshotServerHandle {
    /** Underlying server (exposed for tests). */
    server: http.Server;
    /** Stop listening and free the port. */
    close: () => Promise<void>;
}
/**
 * Parse the camera id out of a request path. Accepts `/<camId>` and
 * `/<camId>.jpg` (case-insensitive extension), ignores a trailing query string.
 * Returns null for "/" , "/favicon.ico" and anything containing a slash in the id.
 */
export declare function parseCamId(urlPath: string): string | null;
/** Best-effort first non-internal IPv4 address, for building reachable URLs. */
export declare function detectLanIp(): string;
/** Build the snapshot URL a VIS widget / url.cam consumer should load. */
export declare function snapshotUrl(host: string, port: number, camId: string): string;
/**
 * Start the snapshot HTTP server. Resolves once it is listening (or rejects on
 * a listen error such as EADDRINUSE).
 */
export declare function startSnapshotServer(opts: SnapshotServerOptions): Promise<SnapshotServerHandle>;
//# sourceMappingURL=snapshot_server.d.ts.map