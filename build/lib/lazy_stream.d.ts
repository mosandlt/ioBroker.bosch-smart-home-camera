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
/**
 * Start an always-listening lazy front-door for one camera. The listener binds
 * immediately and stays bound; the Bosch session is opened on demand per the
 * `resolveInner` callback.
 *
 * @param options
 */
export declare function startLazyFrontDoor(options: LazyFrontDoorOptions): Promise<LazyFrontDoorHandle>;
//# sourceMappingURL=lazy_stream.d.ts.map