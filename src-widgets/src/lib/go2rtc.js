/**
 * go2rtc.js — native go2rtc live stream for vis-2 widgets.
 *
 * Replaces <iframe src=stream.html?mode=webrtc> with a real <video> element
 * so the widget owns audio toggle, volume, pause-guard and zoom.
 *
 * WebRTC first; automatic HLS fallback.
 *
 * go2rtc API used:
 *   WebRTC SDP exchange: POST {baseUrl}/api/webrtc?src=<name>
 *     body:     JSON { type: "offer", sdp: "..." }
 *     response: JSON { type: "answer", sdp: "..." }
 *   HLS:        GET  {baseUrl}/api/stream.m3u8?src=<name>
 */

// ---------------------------------------------------------------------------
// hls.js CDN pin (exact version + SRI)
// ---------------------------------------------------------------------------
const HLS_CDN_URL = "https://cdn.jsdelivr.net/npm/hls.js@1.6.16/dist/hls.min.js";
const HLS_SRI = "sha384-5E8B0pTlZZJMabWpC0fyYf6OUpe15jJij34BqBAh4NXoHAlLNOjCPRrwtOXOQFAn";

// Cached hls.js load promise — shared across all instances.
let _hlsLoadPromise = null;

// Shared AudioContext for synchronous unlock inside a user gesture.
let _sharedAudioCtx = null;

// ---------------------------------------------------------------------------
// isRemoteSession
// ---------------------------------------------------------------------------

/**
 * Returns true when this looks like a remote/VPN session.
 * Remote = the HA/vis-2 hostname is not a LAN address (192.168.x.x, 10.x.x.x,
 * 172.16-31.x.x, localhost, .local suffix).
 * Remote sessions get a shorter WebRTC ICE timeout (2500 ms) before HLS fallback.
 */
export function isRemoteSession() {
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1") {
        return false;
    }
    if (host.endsWith(".local")) {
        return false;
    }
    if (/^192\.168\./.test(host)) {
        return false;
    }
    if (/^10\./.test(host)) {
        return false;
    }
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// loadHlsJs
// ---------------------------------------------------------------------------

/**
 * Loads hls.js@1.6.16 from CDN on demand (cached across calls).
 * Resolves to the Hls class (window.Hls).
 *
 * @returns {Promise<any>}
 */
export function loadHlsJs() {
    if (_hlsLoadPromise) {
        return _hlsLoadPromise;
    }

    _hlsLoadPromise = new Promise((resolve, reject) => {
        if (window.Hls) {
            resolve(window.Hls);
            return;
        }
        const script = document.createElement("script");
        script.src = HLS_CDN_URL;
        script.integrity = HLS_SRI;
        script.crossOrigin = "anonymous";
        script.onload = () => {
            if (window.Hls) {
                resolve(window.Hls);
            } else {
                reject(new Error("hls.js loaded but window.Hls is undefined"));
            }
        };
        script.onerror = () => reject(new Error("Failed to load hls.js from CDN"));
        document.head.appendChild(script);
    });

    return _hlsLoadPromise;
}

// ---------------------------------------------------------------------------
// Go2rtcStream
// ---------------------------------------------------------------------------

/**
 * Native go2rtc live stream: WebRTC first, HLS fallback.
 *
 * opts: {
 *   baseUrl:  string   — go2rtc base URL, e.g. "http://192.168.2.4:1984"
 *   src:      string   — stream name, e.g. "bosch_terrasse"
 *   onPhase:  function(phase, transport)
 *               phase     ∈ 'connecting'|'live'|'idle'|'error'
 *               transport ∈ 'webrtc'|'hls'|null
 *   onError:  function(err)
 * }
 */
export class Go2rtcStream {
    /**
     *
     */
    constructor(opts) {
        this._baseUrl = (opts.baseUrl || "").replace(/\/$/, "");
        this._src = opts.src || "";
        this._onPhase = opts.onPhase || (() => {});
        this._onError = opts.onError || (() => {});

        this._transport = null;

        this._pc = null; // RTCPeerConnection
        this._hls = null; // Hls instance
        this._videoEl = null;
        this._stopping = false;
        this._live = false;

        // Bound listener references for clean removal.
        this._onPlaying = this._handlePlaying.bind(this);
        this._onPause = this._handlePause.bind(this);
        this._iceTimer = null;
        this._hlsKeepalive = null;
        this._stallChecker = null;
        // PiP-freeze-on-tab-switch recovery (parity HA v13.7.4 2026-06-19).
        this._trackMuteTimer = null; // debounce for WebRTC video-track `mute`
        this._rvfcHandle = null; // requestVideoFrameCallback handle
        this._recovering = false; // true during an idempotent PiP-safe reconnect
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /**
     * Attach to a <video> element and start the stream.
     *
     * @param {HTMLVideoElement} videoEl
     * @param {{ wantAudio: boolean, armed: boolean }} options
     */
    async start(videoEl, { wantAudio = false, armed = false } = {}) {
        this._stopping = false;
        this._videoEl = videoEl;

        // On an auto-reconnect there is no fresh user gesture, but the shared
        // AudioContext unlocked by the ORIGINAL gesture is still running — so we can
        // still bring sound back (mirrors HA preserving the unmute intent across a
        // reconnect). Treat a running shared context as "armed". 2026-06-15 (#1).
        const effectivelyArmed =
            armed || !!(wantAudio && _sharedAudioCtx && _sharedAudioCtx.state === "running");

        // Always start muted unless audio is wanted AND the audio context is
        // unlocked (fresh gesture or still-running shared context).
        videoEl.muted = !(wantAudio && effectivelyArmed);

        this._onPhase("connecting", null);

        const webrtcTimeout = isRemoteSession() ? 2500 : 5000;

        try {
            await this._startWebRTC(videoEl, wantAudio, effectivelyArmed, webrtcTimeout);
        } catch (webrtcErr) {
            if (this._stopping) {
                return;
            }
            console.warn("[go2rtc] WebRTC failed, falling back to HLS:", webrtcErr.message);
            this._cleanupWebRTC();
            try {
                await this._startHLS(videoEl, wantAudio, effectivelyArmed);
            } catch (hlsErr) {
                if (this._stopping) {
                    return;
                }
                this._onPhase("error", null);
                this._onError(hlsErr);
            }
        }
    }

    /**
     * Stop the stream: close RTCPeerConnection / destroy Hls, detach listeners,
     * clear timers. Safe to call multiple times.
     */
    stop() {
        this._stopping = true;
        this._live = false;
        this._detachVideoListeners();
        this._cleanupWebRTC();
        this._cleanupHLS();
        if (this._videoEl) {
            this._videoEl.srcObject = null;
            this._videoEl.src = "";
            this._videoEl.load();
        }
        this._transport = null;
        this._onPhase("idle", null);
    }

    /** Returns true if the stream is currently playing. */
    isLive() {
        return this._live;
    }

    /** Current transport: 'webrtc' | 'hls' | null */
    get transport() {
        return this._transport;
    }

    /**
     * Call SYNCHRONOUSLY inside a user gesture to satisfy Chrome autoplay policy.
     * Creates / reuses a shared AudioContext and calls ctx.resume().
     */
    static armAudioUnlock() {
        // If the context is in "interrupted" state (Android doze / OS audio session
        // stolen), it cannot be resumed — null it out so the next gesture creates a
        // fresh one. 2026-06-15 fix (Android #2).
        if (_sharedAudioCtx && _sharedAudioCtx.state === "interrupted") {
            try { _sharedAudioCtx.close(); } catch (_) {}
            _sharedAudioCtx = null;
        }
        if (!_sharedAudioCtx) {
            try {
                _sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
            } catch (e) {
                console.warn("[go2rtc] AudioContext creation failed:", e);
                return;
            }
        }
        // resume() must be called in a synchronous user-gesture stack frame.
        // Log a warning (non-fatal) if the context remains suspended after resume —
        // this can happen on Android when the gesture budget is exhausted.
        _sharedAudioCtx.resume().then(() => {
            if (_sharedAudioCtx && _sharedAudioCtx.state !== "running") {
                console.warn("[go2rtc] AudioContext resume did not reach 'running'; state:", _sharedAudioCtx.state);
                // Null out so the NEXT gesture gets a fresh context.
                try { _sharedAudioCtx.close(); } catch (_) {}
                _sharedAudioCtx = null;
            }
        }).catch(() => {});
    }

    // -----------------------------------------------------------------------
    // WebRTC internals
    // -----------------------------------------------------------------------

    /**
     *
     */
    async _startWebRTC(videoEl, wantAudio, armed, timeoutMs) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const settle = (fn, val) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                fn(val);
            };

            // Timeout guard.
            const timer = setTimeout(
                () => settle(reject, new Error(`WebRTC ICE timeout after ${timeoutMs} ms`)),
                timeoutMs,
            );

            let pc;
            try {
                pc = new RTCPeerConnection({
                    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
                });
                this._pc = pc;
            } catch (e) {
                return settle(reject, e);
            }

            // recvonly transceivers — one per media type.
            pc.addTransceiver("video", { direction: "recvonly" });
            pc.addTransceiver("audio", { direction: "recvonly" });

            // Deliver media to the video element. go2rtc sends audio and video as
            // SEPARATE track events — accumulate them into ONE MediaStream instead
            // of re-assigning srcObject on every ontrack (the second assignment
            // caused a brief flash/glitch). 2026-06-15 (parity HA v13.5.17 #13).
            const remoteStream = new MediaStream();
            pc.ontrack = (evt) => {
                if (this._stopping) {
                    return;
                }
                remoteStream.addTrack(evt.track);
                if (videoEl.srcObject !== remoteStream) {
                    videoEl.srcObject = remoteStream;
                    this._startRvfc(videoEl);
                }
                // Video-track liveness (PiP-freeze fix, parity HA v13.7.4). When
                // go2rtc stops delivering media (background-tab WebSocket i/o
                // timeout) Chrome fires `mute` on the remote track — an EVENT, so
                // it arrives even while the tab is hidden and the stall-checker
                // setInterval is throttled to ~1x/min. Debounce 6s (a transient
                // keyframe gap mutes briefly then unmutes) then recover if still
                // muted. This brings a frozen PiP window back without a tab switch.
                if (evt.track.kind === "video") {
                    evt.track.onunmute = () => {
                        if (this._trackMuteTimer) {
                            clearTimeout(this._trackMuteTimer);
                            this._trackMuteTimer = null;
                        }
                    };
                    evt.track.onmute = () => {
                        if (this._stopping || !this._live) {
                            return;
                        }
                        if (this._trackMuteTimer) {
                            clearTimeout(this._trackMuteTimer);
                        }
                        this._trackMuteTimer = setTimeout(() => {
                            this._trackMuteTimer = null;
                            if (evt.track.muted && this._live && !this._stopping) {
                                this._recover("webrtc video track muted >6s");
                            }
                        }, 6000);
                    };
                }
            };

            // Fast-fail on ICE failure. Only "failed" is terminal — "disconnected"
            // is transient (a brief LAN/Wi-Fi blip, common on Firefox during ICE
            // gathering) and usually recovers; treating it as fatal forced a
            // premature HLS fallback. The outer timeout still bounds a stuck
            // connect. 2026-06-15 (parity HA v13.5.17 #12).
            pc.oniceconnectionstatechange = () => {
                if (pc.iceConnectionState === "failed") {
                    settle(reject, new Error("ICE state: failed"));
                }
            };

            // Live-phase transport-failure recovery (parity HA v13.7.4). The
            // listener above only settles the INITIAL connect; once the stream is
            // live a `failed` aggregate connection state means the transport died
            // (e.g. NAT rebinding after the tab slept) — recover PiP-safely.
            // `disconnected` is transient and left to the track-mute debounce.
            pc.onconnectionstatechange = () => {
                if (this._pc !== pc || !this._live || this._stopping) {
                    return;
                }
                if (pc.connectionState === "failed") {
                    this._recover('webrtc connectionState "failed"');
                }
            };

            // SDP exchange runs in an async IIFE so the Promise executor itself
            // stays synchronous (no-async-promise-executor).
            (async () => {
                try {
                    const offer = await pc.createOffer();
                    await pc.setLocalDescription(offer);

                    // Wait for ICE gathering to finish (or trickle if already complete).
                    await this._waitIceGathering(pc);
                    if (this._stopping) {
                        settle(reject, new Error("stopped"));
                        return;
                    }

                    const localDesc = pc.localDescription;
                    const resp = await fetch(
                        `${this._baseUrl}/api/webrtc?src=${encodeURIComponent(this._src)}`,
                        {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ type: localDesc.type, sdp: localDesc.sdp }),
                        },
                    );
                    if (!resp.ok) {
                        throw new Error(`go2rtc WebRTC HTTP ${resp.status}`);
                    }
                    const answer = await resp.json();
                    await pc.setRemoteDescription(new RTCSessionDescription(answer));
                } catch (e) {
                    settle(reject, e);
                    return;
                }

                // Attach video listeners — playing resolves the promise.
                this._transport = "webrtc";
                this._attachVideoListeners(videoEl, wantAudio, armed, () => settle(resolve));
            })();
        });
    }

    /** Wait until ICE gathering is complete (max 4 s to avoid hanging). */
    _waitIceGathering(pc) {
        return new Promise((resolve) => {
            if (pc.iceGatheringState === "complete") {
                resolve();
                return;
            }
            const onStateChange = () => {
                if (pc.iceGatheringState === "complete") {
                    pc.onicegatheringstatechange = null;
                    resolve();
                }
            };
            pc.onicegatheringstatechange = onStateChange;
            // Safety timeout: proceed even if gathering stalls.
            setTimeout(() => {
                pc.onicegatheringstatechange = null;
                resolve();
            }, 4000);
        });
    }

    /**
     *
     */
    _cleanupWebRTC() {
        clearTimeout(this._iceTimer);
        if (this._pc) {
            try {
                this._pc.close();
            } catch {
                /* ignore */
            }
            this._pc = null;
        }
    }

    // -----------------------------------------------------------------------
    // HLS internals
    // -----------------------------------------------------------------------

    /**
     *
     */
    async _startHLS(videoEl, wantAudio, armed) {
        this._transport = "hls";
        const hlsUrl = `${this._baseUrl}/api/stream.m3u8?src=${encodeURIComponent(this._src)}`;

        // hls.js path (all non-Safari browsers).
        let HlsClass = null;
        try {
            HlsClass = await loadHlsJs();
        } catch {
            /* ignore */
        }

        if (HlsClass && HlsClass.isSupported()) {
            const hls = new HlsClass({
                lowLatencyMode: true,
                liveSyncDurationCount: 4,
                liveMaxLatencyDurationCount: 8,
                maxBufferLength: 14,
                maxMaxBufferLength: 22,
            });
            this._hls = hls;

            hls.on(HlsClass.Events.ERROR, (_evt, data) => {
                if (this._stopping) {
                    return;
                }
                if (data.fatal) {
                    this._onError(new Error(`hls.js fatal error: ${data.type} / ${data.details}`));
                }
            });

            hls.loadSource(hlsUrl);
            hls.attachMedia(videoEl);

            // Keepalive: restart load every 20 s to prevent buffer stall.
            this._hlsKeepalive = setInterval(() => {
                if (!this._stopping && this._hls) {
                    try {
                        this._hls.startLoad(-1);
                    } catch {
                        /* ignore */
                    }
                }
            }, 20000);

            this._attachVideoListeners(videoEl, wantAudio, armed, () => {});
            return;
        }

        // Native HLS path (Safari / iOS).
        if (videoEl.canPlayType("application/vnd.apple.mpegurl")) {
            videoEl.src = hlsUrl;
            this._attachVideoListeners(videoEl, wantAudio, armed, () => {});
            videoEl.load();
            try {
                await videoEl.play();
            } catch {
                // Autoplay rejected — will retry muted in pause-guard.
                videoEl.muted = true;
                try {
                    await videoEl.play();
                } catch {
                    /* ignore */
                }
            }
            return;
        }

        throw new Error("HLS not supported in this browser");
    }

    /**
     *
     */
    _cleanupHLS() {
        clearInterval(this._hlsKeepalive);
        this._hlsKeepalive = null;
        if (this._hls) {
            try {
                this._hls.destroy();
            } catch {
                /* ignore */
            }
            this._hls = null;
        }
    }

    // -----------------------------------------------------------------------
    // Shared video event listeners
    // -----------------------------------------------------------------------

    /**
     *
     */
    _attachVideoListeners(videoEl, wantAudio, armed, onFirstPlaying) {
        // Remove any listeners + stall checker from a prior attach: a WebRTC→HLS
        // fallback reuses the SAME <video> without a stop() in between, so without
        // this the old 'playing'/'pause' closures leak and accumulate across
        // reconnects (removeEventListener later only sees the newest ref).
        // 2026-06-15 (parity HA v13.5.17 #9).
        this._detachVideoListeners();
        let firstPlay = true;

        this._onPlaying = () => {
            if (this._stopping) {
                return;
            }
            this._live = true;
            this._onPhase("live", this._transport);

            if (firstPlay) {
                firstPlay = false;
                onFirstPlaying();

                // Unmute on first 'playing' if audio is wanted and context was armed.
                if (armed && wantAudio) {
                    videoEl.muted = false;
                    if (videoEl.paused) {
                        videoEl.play().catch(() => {
                            videoEl.muted = true;
                            videoEl.play().catch(() => {});
                        });
                    }
                }
            }
        };

        this._onPause = this._handlePause.bind(this);

        videoEl.addEventListener("playing", this._onPlaying);
        videoEl.addEventListener("pause", this._onPause);
        this._startStallChecker(videoEl);
    }

    /**
     *
     */
    _detachVideoListeners() {
        this._stopStallChecker();
        this._stopRvfc(this._videoEl);
        if (this._trackMuteTimer) {
            clearTimeout(this._trackMuteTimer);
            this._trackMuteTimer = null;
        }
        if (this._videoEl) {
            this._videoEl.removeEventListener("playing", this._onPlaying);
            this._videoEl.removeEventListener("pause", this._onPause);
        }
    }

    /**
     * Stall-checker: the browser can pause a live <video> WITHOUT firing 'pause'
     * (background-tab throttle / Chrome 145 muted-background-pause / OS doze) — the
     * pause-guard never sees it. Poll and nudge it back. Self-heal only (no
     * reconnect escalation) to avoid loops; go2rtc owns ICE reconnect.
     * 2026-06-15 (parity HA v13.5.17 #11).
     */
    _startStallChecker(videoEl) {
        this._stopStallChecker();
        let lastTime = 0;
        let stallCount = 0;
        this._stallChecker = setInterval(() => {
            if (this._stopping || !this._live || !videoEl) {
                this._stopStallChecker();
                return;
            }
            // Presented-frame freeze (rVFC, parity HA v13.7.4): _boschLastFrameAt
            // comes from requestVideoFrameCallback, which keeps firing for a PiP
            // window in a hidden tab and STOPS the instant frames freeze — a
            // reliable, un-throttled freeze signal that currentTime polling (also
            // throttled in a hidden tab) cannot give.
            const frameFrozen =
                videoEl._boschLastFrameAt != null &&
                performance.now() - videoEl._boschLastFrameAt > 10000;
            const frozen = videoEl.currentTime === lastTime;
            const pausedWhileLive = videoEl.paused;
            if (frozen || pausedWhileLive || frameFrozen) {
                if (videoEl.paused) {
                    videoEl.play().catch(() => {});
                }
                stallCount++;
                // A presented-frame freeze is already a hard signal — escalate
                // immediately instead of waiting out 3 polls a hidden tab stretches
                // to minutes. (No iOS guard here: the vis-2 widget is desktop-vis.)
                if (stallCount >= 3 || frameFrozen) {
                    stallCount = 0;
                    this._recover(frameFrozen ? "no presented frame >10s" : "stall checker ~15s");
                }
            } else {
                stallCount = 0;
            }
            lastTime = videoEl.currentTime;
        }, 5000);
    }

    /**
     *
     */
    _stopStallChecker() {
        if (this._stallChecker) {
            clearInterval(this._stallChecker);
            this._stallChecker = null;
        }
    }

    /**
     * rVFC liveness heartbeat: stamp _boschLastFrameAt on every PRESENTED frame.
     * Re-arms itself while live; cancelled in _detachVideoListeners. The stall
     * checker reads the timestamp to catch a freeze even in a hidden-tab PiP.
     * 2026-06-19 (PiP-freeze fix, parity HA v13.7.4).
     */
    _startRvfc(videoEl) {
        if (typeof videoEl.requestVideoFrameCallback !== "function") {
            return;
        }
        this._stopRvfc(videoEl);
        videoEl._boschLastFrameAt = performance.now();
        const onFrame = () => {
            videoEl._boschLastFrameAt = performance.now();
            if (this._live && !this._stopping && videoEl.srcObject) {
                this._rvfcHandle = videoEl.requestVideoFrameCallback(onFrame);
            } else {
                this._rvfcHandle = null;
            }
        };
        this._rvfcHandle = videoEl.requestVideoFrameCallback(onFrame);
    }

    /**
     *
     */
    _stopRvfc(videoEl) {
        const el = videoEl || this._videoEl;
        if (this._rvfcHandle != null && el && typeof el.cancelVideoFrameCallback === "function") {
            try {
                el.cancelVideoFrameCallback(this._rvfcHandle);
            } catch {
                /* ignore */
            }
        }
        this._rvfcHandle = null;
        if (el) {
            el._boschLastFrameAt = null;
        }
    }

    /**
     * Idempotent, PiP-safe live-stream recovery. Called by the stall checker AND
     * by the WebRTC track-`mute` / connection-`failed` handlers, which fire even
     * while the tab is hidden (events, not throttled timers). Tears the dead
     * WebRTC/HLS transport down but keeps the SAME <video> element (so any PiP
     * window bound to it survives) and re-starts on it after a short delay — the
     * fresh srcObject flows back into the floating window with no user gesture.
     * Guarded by _recovering so the event path and the stall checker can't
     * double-reconnect. 2026-06-19 (PiP-freeze fix, parity HA v13.7.4).
     */
    _recover(reason) {
        if (this._stopping || this._recovering || !this._live || !this._videoEl) {
            return;
        }
        console.warn(`[go2rtc] live recovery (${reason})`);
        this._recovering = true;
        const videoEl = this._videoEl;
        const wantAudio = !videoEl.muted; // preserve the user's audio intent
        // Internal teardown — NOT the public stop() (which would set _stopping and
        // signal a permanent stop to the widget). Keep the <video> + its PiP window.
        this._detachVideoListeners();
        this._cleanupWebRTC();
        this._cleanupHLS();
        if (this._trackMuteTimer) {
            clearTimeout(this._trackMuteTimer);
            this._trackMuteTimer = null;
        }
        this._live = false;
        setTimeout(() => {
            this._recovering = false;
            if (this._stopping || !this._videoEl) {
                return;
            }
            this.start(videoEl, { wantAudio, armed: false }).catch(() => {});
        }, 2000);
    }

    /**
     * Pause-guard: on unexpected pause, keep the stream alive.
     * NEVER sets muted=false here (Chrome would re-mute and possibly freeze).
     */
    _handlePause() {
        if (this._stopping) {
            return;
        }
        const video = this._videoEl;
        if (!video) {
            return;
        }

        if (!video.muted) {
            // Try to resume with audio; if rejected, mute and retry.
            video.play().catch(() => {
                video.muted = true;
                video.play().catch(() => {});
            });
        } else {
            // Already muted — just resume.
            video.play().catch(() => {});
        }
    }

    /**
     *
     */
    _handlePlaying() {
        // Bound version reassigned per start() call — handled in _attachVideoListeners.
    }
}
