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

import * as net from "node:net";

// ── Public types ──────────────────────────────────────────────────────────────

/** Handle returned by startLazyFrontDoor(). */
export interface LazyFrontDoorHandle {
    /** Stable local port the front-door is listening on. */
    port: number;
    /** Host the front-door is bound to ("127.0.0.1" or "0.0.0.0"). */
    bindHost: string;
    /** Plain-RTSP URL clients should connect to (sans credentials). */
    localRtspUrl: string;
    /** Number of currently-connected downstream clients. */
    activeClientCount(): number;
    /** Stop the front-door (close listener + all in-flight connections). */
    stop(): Promise<void>;
}

/** Options for startLazyFrontDoor(). */
export interface LazyFrontDoorOptions {
    /** Camera ID for log labelling. */
    cameraId: string;
    /** Bound local port (0 = pick a free port, returned in handle.port). */
    localPort?: number;
    /** Host to bind to. Default "127.0.0.1". "0.0.0.0" exposes to the LAN. */
    bindHost?: string;
    /**
     * Host embedded in the returned `localRtspUrl`. Defaults to `bindHost`
     * (but never the unroutable "0.0.0.0" — falls back to "127.0.0.1").
     */
    urlHost?: string;
    /** RTSP path segment for the URL (default "/rtsp_tunnel"). */
    rtspPath?: string;
    /** Logger. Pass the adapter's this.log.{debug,info,warn,error}. No-op default. */
    log?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
    /**
     * Lazily ensure the Bosch session + inner TLS proxy are up, and return the
     * inner proxy's local TCP port (on 127.0.0.1) to pipe the client to. Return
     * `null` if the camera is currently unreachable / the session can't be
     * opened — the front-door then drops the client cleanly so the recorder
     * retries later (it never holds the connection open against a dead camera).
     */
    resolveInner: () => Promise<number | null>;
    /** Called when the active client count rises 0 → 1 (cancel any idle linger). */
    onActive?: () => void;
    /** Called when the active client count drops to 0 (start the idle linger). */
    onIdle?: () => void;
}

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
export function startLazyFrontDoor(options: LazyFrontDoorOptions): Promise<LazyFrontDoorHandle> {
    return new Promise((resolve, reject) => {
        const {
            cameraId,
            localPort = 0,
            bindHost = "127.0.0.1",
            urlHost,
            rtspPath = "/rtsp_tunnel",
            resolveInner,
            onActive,
            onIdle,
        } = options;

        const camLabel = cameraId.slice(0, 8);
        const log = options.log ?? (() => undefined);

        // Track all live sockets (client + inner) so stop() can destroy them.
        const activeSockets = new Set<net.Socket>();
        let clientCount = 0;

        const server = net.createServer((clientSocket: net.Socket) => {
            clientSocket.setKeepAlive(true, 30_000);
            activeSockets.add(clientSocket);
            clientCount++;
            if (clientCount === 1) {
                // Never let a caller callback throwing kill the listener.
                try {
                    onActive?.();
                } catch (err) {
                    log(
                        "debug",
                        `lazy front-door ${camLabel}: onActive threw — ${err instanceof Error ? err.message : String(err)}`,
                    );
                }
            }
            log("debug", `lazy front-door ${camLabel}: client connected (${clientCount} active)`);

            let innerSocket: net.Socket | null = null;
            let closed = false;

            function teardown(reason: string): void {
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
                    } catch (err) {
                        log(
                            "debug",
                            `lazy front-door ${camLabel}: onIdle threw — ${err instanceof Error ? err.message : String(err)}`,
                        );
                    }
                }
            }

            clientSocket.on("error", (err: Error) => teardown(`client error: ${err.message}`));
            clientSocket.on("end", () => teardown("client end"));
            clientSocket.on("close", () => teardown("client close"));

            // Hold the client's RTSP bytes until the inner upstream is wired up
            // so nothing is lost while resolveInner() opens the Bosch session.
            clientSocket.pause();

            void resolveInner()
                .then((innerPort: number | null) => {
                    if (closed) {
                        return;
                    }
                    if (innerPort === null || innerPort <= 0) {
                        log(
                            "debug",
                            `lazy front-door ${camLabel}: no inner stream available — dropping client`,
                        );
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
                        log(
                            "debug",
                            `lazy front-door ${camLabel}: piping client ↔ inner :${innerPort}`,
                        );
                    });
                    sock.on("error", (err: Error) => teardown(`inner error: ${err.message}`));
                    sock.on("end", () => teardown("inner end"));
                    sock.on("close", () => teardown("inner close"));
                })
                .catch((err: unknown) => {
                    const msg = err instanceof Error ? err.message : String(err);
                    log("debug", `lazy front-door ${camLabel}: resolveInner threw — ${msg}`);
                    teardown(`resolveInner error: ${msg}`);
                });
        });

        server.on("error", (err: Error) => {
            log("error", `lazy front-door ${camLabel}: server error — ${err.message}`);
            reject(err);
        });

        server.listen(localPort, bindHost, () => {
            const addr = server.address() as net.AddressInfo;
            const port = addr.port;
            const publicHost =
                urlHost && urlHost.length > 0
                    ? urlHost
                    : bindHost === "0.0.0.0"
                      ? "127.0.0.1"
                      : bindHost;
            const localRtspUrl = `rtsp://${publicHost}:${port}${rtspPath}`;

            log(
                "info",
                `lazy front-door for ${camLabel} listening on ${bindHost}:${port} ` +
                    `(always-on RTSP endpoint — Bosch session opens on demand)`,
            );

            function stop(): Promise<void> {
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

            function activeClientCount(): number {
                return clientCount;
            }

            resolve({ port, bindHost, localRtspUrl, activeClientCount, stop });
        });
    });
}
