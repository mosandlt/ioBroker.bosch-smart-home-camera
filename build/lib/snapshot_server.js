"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseCamId = parseCamId;
exports.detectLanIp = detectLanIp;
exports.snapshotUrl = snapshotUrl;
exports.startSnapshotServer = startSnapshotServer;
const http = __importStar(require("node:http"));
const os = __importStar(require("node:os"));
/**
 * Parse the camera id out of a request path. Accepts `/<camId>` and
 * `/<camId>.jpg` (case-insensitive extension), ignores a trailing query string.
 * Returns null for "/" , "/favicon.ico" and anything containing a slash in the id.
 */
function parseCamId(urlPath) {
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
function detectLanIp() {
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
function snapshotUrl(host, port, camId) {
    return `http://${host}:${port}/${camId}.jpg`;
}
/**
 * Start the snapshot HTTP server. Resolves once it is listening (or rejects on
 * a listen error such as EADDRINUSE).
 */
function startSnapshotServer(opts) {
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
        }
        else {
            res.end(buf);
        }
    });
    return new Promise((resolve, reject) => {
        const onError = (err) => {
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
            server.on("error", (err) => {
                log.warn(`snapshot server socket error (ignored): ${err.message}`);
            });
            log.info(`snapshot server listening on ${bindHost}:${port}`);
            resolve({
                server,
                close: () => new Promise((res) => {
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
//# sourceMappingURL=snapshot_server.js.map