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
import * as os from "node:os";

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
export function parseCamId(urlPath: string): string | null {
    // Strip query/hash, leading slash.
    const path = urlPath.split(/[?#]/, 1)[0].replace(/^\/+/, "");
    if (!path) {
        return null;
    }
    const id = path.replace(/\.jpe?g$/i, "");
    // Camera ids are flat tokens (Bosch cloud UUIDs) — reject nested paths and
    // path-traversal attempts.
    if (!id || id.includes("/") || id.includes("..") || id.includes("\\")) {
        return null;
    }
    return id;
}

/** Best-effort first non-internal IPv4 address, for building reachable URLs. */
export function detectLanIp(): string {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const addr of ifaces[name] ?? []) {
            if (addr.family === "IPv4" && !addr.internal) {
                return addr.address;
            }
        }
    }
    return "127.0.0.1";
}

/** Build the snapshot URL a VIS widget / url.cam consumer should load. */
export function snapshotUrl(host: string, port: number, camId: string): string {
    return `http://${host}:${port}/${camId}.jpg`;
}

/**
 * Start the snapshot HTTP server. Resolves once it is listening (or rejects on
 * a listen error such as EADDRINUSE).
 */
export function startSnapshotServer(opts: SnapshotServerOptions): Promise<SnapshotServerHandle> {
    const { port, getSnapshot, log } = opts;
    const bindHost = opts.bindHost || "0.0.0.0";

    const server = http.createServer((req, res) => {
        // Only GET/HEAD make sense for a still image.
        if (req.method !== "GET" && req.method !== "HEAD") {
            res.writeHead(405, { Allow: "GET, HEAD" });
            res.end();
            return;
        }
        const camId = parseCamId(req.url || "/");
        if (!camId) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("not found");
            return;
        }
        const buf = getSnapshot(camId);
        if (!buf || buf.length === 0) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("no snapshot yet");
            return;
        }
        res.writeHead(200, {
            "Content-Type": "image/jpeg",
            "Content-Length": String(buf.length),
            // A still frame goes stale immediately — never let a browser cache it.
            "Cache-Control": "no-store, max-age=0",
            "Access-Control-Allow-Origin": "*",
        });
        if (req.method === "HEAD") {
            res.end();
        } else {
            res.end(buf);
        }
    });

    return new Promise((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException): void => {
            server.removeListener("error", onError);
            log.error(`snapshot server: failed to listen on ${bindHost}:${port} — ${err.message}`);
            reject(err);
        };
        server.once("error", onError);
        server.listen(port, bindHost, () => {
            server.removeListener("error", onError);
            // Persistent error listener for post-listen socket errors (e.g. a
            // client ECONNRESET mid-response). Without it Node re-throws as an
            // uncaughtException that would crash the whole adapter process.
            server.on("error", (err: NodeJS.ErrnoException) => {
                log.warn(`snapshot server socket error (ignored): ${err.message}`);
            });
            log.info(`snapshot server listening on ${bindHost}:${port}`);
            resolve({
                server,
                close: () =>
                    new Promise<void>((res) => {
                        // close() alone only stops accepting NEW connections; it
                        // resolves once all existing connections end. VIS image
                        // widgets hold keep-alive sockets open indefinitely, so
                        // without closeAllConnections() the unload callback would
                        // never fire and ioBroker would force-kill the adapter.
                        server.closeAllConnections();
                        server.close(() => res());
                    }),
            });
        });
    });
}
