"use strict";
/**
 * Lazy "front-door" RTSP listener for the Bosch Smart Home camera adapter.
 *
 * Problem (forum #84538, Reiner): the per-camera TLS proxy (tls_proxy.ts) only
 * binds its TCP port while a livestream session is open. An external recorder
 * such as iobroker.cameras polls the RTSP URL on its own schedule, so whenever
 * the livestream is off — the default, and the state after every adapter
 * restart, privacy-credential rotation or 60-minute session renewal — the port
 * is closed and the recorder gets "Connection refused".
 *
 * This module adds an always-listening, lightweight TCP front-door bound to a
 * stable (sticky) port. It owns no TLS and no Bosch session itself: on each
 * inbound client connection it calls `resolveInner()` — which lazily opens the
 * Bosch session and the inner TLS proxy on demand — then byte-pipes the client
 * to `127.0.0.1:<innerPort>`. The inner proxy keeps all its proven behaviour
 * (TLS to the camera, transparent RTSP Digest auth, circuit breaker).
 *
 * Because the front-door stays bound regardless of session state, the port is
 * always answerable → no more ECONNREFUSED. Because the Bosch session is opened
 * only while a client is actually connected (plus a short idle linger handled
 * by the caller via `onIdle`), the 3-shared-session budget is respected.
 *
 * HA equivalent: the Python proxy binds its socket before the upstream session
 * exists so the port is always answerable (`srv.listen()` runs before the
 * forwarder thread in tls_proxy.py). This module is the ioBroker analogue,
 * deliberately split into a front-door + the existing inner proxy so the proven
 * TLS data path in tls_proxy.ts is not touched.
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
exports.startLazyFrontDoor = startLazyFrontDoor;
const net = __importStar(require("node:net"));
// ── Constants ──────────────────────────────────────────────────────────────────
/** Max time to wait for the inner proxy TCP connect before dropping the client. */
const _INNER_CONNECT_TIMEOUT_MS = 10_000;
// ── Implementation ──────────────────────────────────────────────────────────────
/**
 * Start an always-listening lazy front-door for one camera. The listener binds
 * immediately and stays bound; the Bosch session is opened on demand per the
 * `resolveInner` callback.
 *
 * @param options
 */
function startLazyFrontDoor(options) {
    return new Promise((resolve, reject) => {
        const { cameraId, localPort = 0, bindHost = "127.0.0.1", urlHost, rtspPath = "/rtsp_tunnel", resolveInner, onActive, onIdle, } = options;
        const camLabel = cameraId.slice(0, 8);
        const log = options.log ?? (() => undefined);
        // Track all live sockets (client + inner) so stop() can destroy them.
        const activeSockets = new Set();
        let clientCount = 0;
        const server = net.createServer((clientSocket) => {
            clientSocket.setKeepAlive(true, 30_000);
            activeSockets.add(clientSocket);
            clientCount++;
            if (clientCount === 1) {
                // Never let a caller callback throwing kill the listener.
                try {
                    onActive?.();
                }
                catch (err) {
                    log("debug", `lazy front-door ${camLabel}: onActive threw — ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            log("debug", `lazy front-door ${camLabel}: client connected (${clientCount} active)`);
            let innerSocket = null;
            let closed = false;
            function teardown(reason) {
                if (closed) {
                    return;
                }
                closed = true;
                log("debug", `lazy front-door ${camLabel}: teardown — ${reason}`);
                if (!clientSocket.destroyed) {
                    clientSocket.destroy();
                }
                if (innerSocket && !innerSocket.destroyed) {
                    innerSocket.destroy();
                }
                activeSockets.delete(clientSocket);
                if (innerSocket) {
                    activeSockets.delete(innerSocket);
                }
                if (clientCount > 0) {
                    clientCount--;
                }
                if (clientCount === 0) {
                    try {
                        onIdle?.();
                    }
                    catch (err) {
                        log("debug", `lazy front-door ${camLabel}: onIdle threw — ${err instanceof Error ? err.message : String(err)}`);
                    }
                }
            }
            clientSocket.on("error", (err) => teardown(`client error: ${err.message}`));
            clientSocket.on("end", () => teardown("client end"));
            clientSocket.on("close", () => teardown("client close"));
            // Hold the client's RTSP bytes until the inner upstream is wired up
            // so nothing is lost while resolveInner() opens the Bosch session.
            clientSocket.pause();
            void resolveInner()
                .then((innerPort) => {
                if (closed) {
                    return;
                }
                if (innerPort === null || innerPort <= 0) {
                    log("debug", `lazy front-door ${camLabel}: no inner stream available — dropping client`);
                    teardown("no inner stream");
                    return;
                }
                const sock = net.connect(innerPort, "127.0.0.1");
                innerSocket = sock;
                activeSockets.add(sock);
                sock.setKeepAlive(true, 30_000);
                // Guard the connect phase with the socket's own idle timer
                // (not the global setTimeout) — a localhost connect to the
                // already-listening inner proxy succeeds or fails fast, this
                // only catches a pathological hang. Cleared once piping.
                sock.setTimeout(_INNER_CONNECT_TIMEOUT_MS);
                sock.on("timeout", () => {
                    if (!closed) {
                        log("warn", `lazy front-door ${camLabel}: inner connect timed out`);
                        teardown("inner connect timeout");
                    }
                });
                sock.on("connect", () => {
                    sock.setTimeout(0); // disable idle timer for the live pull
                    if (closed) {
                        sock.destroy();
                        return;
                    }
                    // Bidirectional byte-pipe client ↔ inner proxy. The inner
                    // proxy adds TLS + Digest auth toward the camera, so the
                    // RTSP byte stream is relayed verbatim in both directions.
                    clientSocket.pipe(sock);
                    sock.pipe(clientSocket);
                    clientSocket.resume();
                    log("debug", `lazy front-door ${camLabel}: piping client ↔ inner :${innerPort}`);
                });
                sock.on("error", (err) => teardown(`inner error: ${err.message}`));
                sock.on("end", () => teardown("inner end"));
                sock.on("close", () => teardown("inner close"));
            })
                .catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                log("debug", `lazy front-door ${camLabel}: resolveInner threw — ${msg}`);
                teardown(`resolveInner error: ${msg}`);
            });
        });
        server.on("error", (err) => {
            log("error", `lazy front-door ${camLabel}: server error — ${err.message}`);
            reject(err);
        });
        server.listen(localPort, bindHost, () => {
            const addr = server.address();
            const port = addr.port;
            const publicHost = urlHost && urlHost.length > 0
                ? urlHost
                : bindHost === "0.0.0.0"
                    ? "127.0.0.1"
                    : bindHost;
            const localRtspUrl = `rtsp://${publicHost}:${port}${rtspPath}`;
            log("info", `lazy front-door for ${camLabel} listening on ${bindHost}:${port} ` +
                `(always-on RTSP endpoint — Bosch session opens on demand)`);
            function stop() {
                return new Promise((res) => {
                    for (const sock of activeSockets) {
                        if (!sock.destroyed) {
                            sock.destroy();
                        }
                    }
                    activeSockets.clear();
                    clientCount = 0;
                    server.close(() => res());
                });
            }
            function activeClientCount() {
                return clientCount;
            }
            resolve({ port, bindHost, localRtspUrl, activeClientCount, stop });
        });
    });
}
//# sourceMappingURL=lazy_stream.js.map