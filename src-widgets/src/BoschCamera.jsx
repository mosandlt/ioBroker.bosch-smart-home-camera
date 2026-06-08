import React from "react";
import ReactDOM from "react-dom";
import { IconButton, Tooltip } from "@mui/material";
import {
    Fullscreen,
    FullscreenExit,
    VisibilityOff,
    Visibility,
    LightbulbOutlined,
    Lightbulb,
    VideocamOff,
    FiberManualRecord,
    PlayCircle,
    StopCircle,
    CameraAlt,
    ChevronLeft,
    ChevronRight,
    VolumeOff,
    VolumeUp,
    NotificationsActive,
    NotificationsOff,
} from "@mui/icons-material";

import Generic from "./Generic";

const FONT =
    '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

const styles = {
    container: {
        width: "100%",
        height: "100%",
        position: "relative",
        overflow: "hidden",
        background: "#0b0b10",
        borderRadius: 18,
        boxShadow: "0 6px 22px rgba(0,0,0,.45)",
        display: "flex",
        flexDirection: "column",
        fontFamily: FONT,
    },
    // Fullscreen portal overlay — rendered into document.body
    fullContainer: {
        position: "fixed",
        inset: 0,
        zIndex: 99999,
        background: "#000",
        display: "flex",
        flexDirection: "column",
        fontFamily: FONT,
    },
    // Placeholder shown in the widget slot while portal is open
    fullPlaceholder: {
        width: "100%",
        height: "100%",
        background: "#0b0b10",
        borderRadius: 18,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#6b6b78",
        fontFamily: FONT,
        fontSize: 13,
    },
    media: {
        width: "100%",
        height: "100%",
        objectFit: "cover",
        display: "block",
        background: "#000",
        flex: 1,
        minHeight: 0,
    },
    mediaFull: {
        width: "100%",
        flex: 1,
        minHeight: 0,
        objectFit: "contain",
        display: "block",
        background: "#000",
    },
    iframe: { width: "100%", height: "100%", border: 0, flex: 1, minHeight: 0 },
    iframeFull: { width: "100%", flex: 1, minHeight: 0, border: 0 },
    overlayTop: {
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 12px",
        gap: 6,
        background: "linear-gradient(rgba(0,0,0,.5), rgba(0,0,0,0))",
        pointerEvents: "none",
    },
    name: {
        fontSize: 15,
        fontWeight: 600,
        letterSpacing: 0.2,
        color: "#fff",
        textShadow: "0 1px 3px rgba(0,0,0,.7)",
    },
    badges: { display: "flex", gap: 6, alignItems: "center" },
    badge: {
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 11,
        lineHeight: "16px",
        padding: "3px 9px",
        borderRadius: 999,
        fontWeight: 600,
        color: "#fff",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
    },
    // iOS/Android-style frosted pill control bar
    pillBar: {
        position: "absolute",
        bottom: 12,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: "4px 6px",
        borderRadius: 999,
        background: "rgba(24,24,28,.55)",
        backdropFilter: "blur(20px) saturate(180%)",
        WebkitBackdropFilter: "blur(20px) saturate(180%)",
        border: "1px solid rgba(255,255,255,.14)",
        boxShadow: "0 4px 14px rgba(0,0,0,.4)",
        whiteSpace: "nowrap",
    },
    pillBtn: { color: "#fff", width: 38, height: 38 },
    pillBtnActive: { color: "#fff", width: 38, height: 38, background: "rgba(255,255,255,.18)" },
    pillBtnDisabled: { color: "#fff", width: 38, height: 38, opacity: 0.35 },
    // "fully offline" state (HA-style)
    offline: {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        background: "radial-gradient(circle at 50% 40%, #1b1b24, #0b0b10)",
        color: "#6b6b78",
        fontFamily: FONT,
    },
    offlineName: { fontSize: 15, fontWeight: 600, color: "#9a9aa8" },
    offlineLabel: {
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: 1,
        textTransform: "uppercase",
        color: "#6b6b78",
    },
    hint: { color: "#8a8a98", fontSize: 13, textAlign: "center", padding: 20, margin: "auto", fontFamily: FONT },
    // Fullscreen exit button (top-right corner)
    fullExitBtn: {
        position: "absolute",
        top: 12,
        right: 12,
        zIndex: 10,
        color: "#fff",
        background: "rgba(0,0,0,.5)",
        borderRadius: "50%",
        width: 44,
        height: 44,
    },
};

class BoschCamera extends Generic {
    constructor(props) {
        super(props);
        this.videoRef = React.createRef();
        this.canvasRef = React.createRef();
        this.state.full = false;
        this.state.cam = {
            name: "",
            online: false,
            privacy: false,
            light: false,
            lightAvail: false,
            livestream: false,
            livestreamAvail: false,
            siren: false,
            sirenAvail: false,
            privacySound: false,
            privacySoundAvail: false,
            panPosition: 0,
            panAvail: false,
            hardwareVersion: "",
            motion: false,
            snapshotUrl: "",
        };
        this.state.liveActive = false;
        this.camId = null;
        this.instance = "0";
        this.pollTimer = null;
        this.keepAliveTimer = null;
        this.loadingFrame = false;
        this.subs = [];
    }

    static getWidgetInfo() {
        return {
            id: "tplBoschCamera2",
            visSet: "bosch-smart-home-camera",
            visSetLabel: "Bosch Camera",
            visSetColor: "#007bc1",
            visName: "Bosch Camera",
            visWidgetLabel: "Bosch Camera",
            visAttrs: [
                {
                    name: "common",
                    fields: [
                        {
                            name: "cam_id_dp",
                            type: "id",
                            label: "Camera datapoint",
                            tooltip:
                                "Select bosch-smart-home-camera.0.cameras.<UUID>.name — the camera is auto-detected from the path.",
                        },
                        {
                            name: "mode",
                            type: "select",
                            label: "Stream mode",
                            default: "snapshot",
                            options: [
                                { value: "snapshot", label: "Snapshot (near-live)" },
                                { value: "mjpeg", label: "MJPEG (frames)" },
                                { value: "webrtc", label: "go2rtc WebRTC (audio)" },
                            ],
                        },
                        {
                            name: "pollingInterval",
                            type: "number",
                            label: "Polling interval",
                            tooltip: "milliseconds",
                            default: 1000,
                            hidden: 'data.mode !== "snapshot"',
                        },
                        {
                            name: "snapshotUrlOverride",
                            type: "text",
                            label: "Snapshot URL (override)",
                            tooltip:
                                "Leave empty to use the cameras snapshot_url datapoint (needs snapshot_http_port set in the adapter).",
                            hidden: 'data.mode !== "snapshot"',
                        },
                        {
                            name: "go2rtcUrl",
                            type: "text",
                            label: "go2rtc base URL",
                            tooltip: "e.g. http://192.168.1.50:1984",
                            default: "http://localhost:1984",
                            hidden: 'data.mode !== "webrtc"',
                        },
                        {
                            name: "go2rtcSrc",
                            type: "text",
                            label: "go2rtc stream name",
                            tooltip:
                                "The src name configured in go2rtc for this camera (defaults to the camera name).",
                            hidden: 'data.mode !== "webrtc"',
                        },
                        { name: "showControls", type: "checkbox", label: "Show controls", default: true },
                        { name: "showLight", type: "checkbox", label: "Show light button", default: true },
                        { name: "showSiren", type: "checkbox", label: "Show siren button", default: false },
                        { name: "noCard", type: "checkbox", label: "Without card" },
                        { name: "widgetTitle", type: "text", label: "Name", hidden: "!!data.noCard" },
                    ],
                },
            ],
            visDefaultStyle: { width: "100%", height: 220, position: "relative" },
            visPrev: "widgets/bosch-smart-home-camera/img/prev_bosch_camera.png",
        };
    }

    getWidgetInfo() {
        return BoschCamera.getWidgetInfo();
    }

    // ── helpers ──────────────────────────────────────────────────────────────
    static camIdFromDp(dpId) {
        if (!dpId) return null;
        const m = dpId.match(/cameras\.([^.]+)/);
        return m ? m[1] : null;
    }

    static instanceFromDp(dpId) {
        if (!dpId) return "0";
        const m = dpId.match(/bosch-smart-home-camera\.(\d+)\./);
        return m ? m[1] : "0";
    }

    dp(field) {
        return `bosch-smart-home-camera.${this.instance}.cameras.${this.camId}.${field}`;
    }

    // ── lifecycle ────────────────────────────────────────────────────────────
    async componentDidMount() {
        super.componentDidMount();
        await this.applyConfig();
    }

    componentWillUnmount() {
        super.componentWillUnmount();
        this.teardown();
    }

    async onRxDataChanged() {
        this.teardown();
        await this.applyConfig();
    }

    // Manages live MJPEG ↔ snapshot transitions when the livestream state changes.
    // Note: mode changes are handled via onRxDataChanged → teardown + applyConfig,
    // so here we only need to react to livestream toggle while mode stays "snapshot".
    componentDidUpdate(_prevProps, prevState) {
        const mode = this.state.rxData.mode || "snapshot";
        if (mode !== "snapshot") {
            // mjpeg and webrtc modes are set up entirely in applyConfig — nothing to do.
            return;
        }
        const isLive = this.state.cam.livestream;
        const wasLive = prevState.cam.livestream;

        if (isLive && !wasLive) {
            // Livestream just turned ON in snapshot mode → switch to MJPEG canvas
            if (this.pollTimer) {
                clearInterval(this.pollTimer);
                this.pollTimer = null;
            }
            this.setState({ liveActive: false });
            this.startMjpeg();
        } else if (!isLive && wasLive) {
            // Livestream just turned OFF in snapshot mode → back to snapshot polling
            this.stopMjpeg();
            this.setState({ liveActive: false });
            this.startSnapshotPolling();
        }
    }

    teardown() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        this.stopMjpeg();
        for (const s of this.subs) {
            this.props.context.socket.unsubscribeState(s.id, s.cb);
        }
        this.subs = [];
    }

    async applyConfig() {
        const rawDp = this.state.rxData.cam_id_dp || "";
        this.camId = BoschCamera.camIdFromDp(rawDp);
        this.instance = BoschCamera.instanceFromDp(rawDp);
        if (!this.camId) {
            return;
        }

        // subscribe(field, apply) — registers a state subscription and reads the
        // current value immediately. Returns the id subscribed.
        const subscribe = (field, apply) => {
            const id = this.dp(field);
            const cb = (sid, state) => {
                if (state) {
                    apply(state.val);
                }
            };
            this.props.context.socket
                .getState(id)
                .then(st => st && cb(id, st))
                .catch(() => {});
            this.props.context.socket.subscribeState(id, cb);
            this.subs.push({ id, cb });
        };

        // subscribeIfExists — subscribes only when the state exists in ioBroker;
        // sets an "Avail" flag on first successful read so buttons are shown only
        // for states that actually exist on this camera model.
        const subscribeIfExists = (field, apply) => {
            const id = this.dp(field);
            const cb = (sid, state) => {
                if (state) {
                    apply(state.val);
                }
            };
            this.props.context.socket
                .getState(id)
                .then(st => {
                    if (st !== null && st !== undefined) {
                        apply(st.val);
                        this.props.context.socket.subscribeState(id, cb);
                        this.subs.push({ id, cb });
                    }
                })
                .catch(() => {});
        };

        subscribe("name", v => this.setCam({ name: v || "" }));
        subscribe("online", v => this.setCam({ online: !!v }));
        subscribe("privacy_enabled", v => this.setCam({ privacy: !!v }));
        subscribe("motion_active", v => this.setCam({ motion: !!v }));
        subscribe("snapshot_url", v => this.setCam({ snapshotUrl: v || "" }));

        subscribeIfExists("front_light_enabled", v => this.setCam({ light: !!v, lightAvail: true }));
        subscribeIfExists("livestream_enabled", v => this.setCam({ livestream: !!v, livestreamAvail: true }));
        subscribeIfExists("siren_active", v => this.setCam({ siren: !!v, sirenAvail: true }));
        subscribeIfExists("privacy_sound_enabled", v => this.setCam({ privacySound: !!v, privacySoundAvail: true }));
        subscribeIfExists("pan_position", v => this.setCam({ panPosition: parseFloat(v) || 0, panAvail: true }));
        subscribeIfExists("hardware_version", v => this.setCam({ hardwareVersion: v || "" }));

        const mode = this.state.rxData.mode || "snapshot";
        if (mode === "mjpeg") {
            this.startMjpeg();
        } else if (mode === "snapshot") {
            this.startSnapshotPolling();
        }
    }

    setCam(patch) {
        this.setState({ cam: { ...this.state.cam, ...patch } });
    }

    // ── snapshot (near-live) ─────────────────────────────────────────────────
    snapshotBaseUrl() {
        return this.state.rxData.snapshotUrlOverride || this.state.cam.snapshotUrl || "";
    }

    updateSnapshot = () => {
        const base = this.snapshotBaseUrl();
        if (!base || this.loadingFrame || !this.videoRef.current) {
            return;
        }
        this.loadingFrame = true;
        const sep = base.indexOf("?") === -1 ? "?" : "&";
        const img = this.videoRef.current;
        img.onload = () => {
            this.loadingFrame = false;
        };
        img.onerror = () => {
            this.loadingFrame = false;
        };
        img.src = `${base}${sep}t=${Date.now()}`;
    };

    startSnapshotPolling() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
        }
        const ms = parseInt(this.state.rxData.pollingInterval, 10) || 1000;
        this.updateSnapshot();
        this.pollTimer = setInterval(this.updateSnapshot, ms);
    }

    // ── mjpeg (base64 frames over instance messages) ─────────────────────────
    onFrame = data => {
        if (!data || (typeof data === "object" && (data.accepted || data.error))) {
            return;
        }
        const canvas = this.canvasRef.current;
        if (!canvas) {
            return;
        }
        const ctx = canvas.getContext("2d");
        const img = new Image();
        img.onload = () => {
            canvas.width = img.width;
            canvas.height = img.height;
            ctx.drawImage(img, 0, 0, img.width, img.height);
            if (!this.state.liveActive) {
                this.setState({ liveActive: true });
            }
        };
        img.src = `data:image/jpeg;base64,${data}`;
    };

    startMjpeg() {
        const inst = `bosch-smart-home-camera.${this.instance}`;
        const sub = () =>
            this.props.context.socket
                .subscribeOnInstance(inst, `startCamera/${this.camId}`, { width: this.videoWidth() }, this.onFrame)
                .catch(() => {});
        sub();
        this.keepAliveTimer = setInterval(sub, 14000);
    }

    stopMjpeg() {
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
        if (this.camId) {
            const inst = `bosch-smart-home-camera.${this.instance}`;
            this.props.context.socket
                .unsubscribeFromInstance(inst, `startCamera/${this.camId}`, this.onFrame)
                .catch(() => {});
        }
    }

    videoWidth() {
        return (
            (this.videoRef.current && this.videoRef.current.parentElement
                ? this.videoRef.current.parentElement.clientWidth
                : 0) || 640
        );
    }

    // ── controls ─────────────────────────────────────────────────────────────
    togglePrivacy = () => {
        if (!this.camId) return;
        this.props.context.socket.setState(this.dp("privacy_enabled"), !this.state.cam.privacy);
    };

    toggleLight = () => {
        if (!this.camId || !this.state.cam.lightAvail) return;
        this.props.context.socket.setState(this.dp("front_light_enabled"), !this.state.cam.light);
    };

    toggleLivestream = () => {
        if (!this.camId || !this.state.cam.livestreamAvail) return;
        this.props.context.socket.setState(this.dp("livestream_enabled"), !this.state.cam.livestream);
    };

    triggerSnapshot = () => {
        if (!this.camId || this.state.cam.privacy) return;
        this.props.context.socket.setState(this.dp("snapshot_trigger"), true);
    };

    toggleSiren = () => {
        if (!this.camId || !this.state.cam.sirenAvail || this.state.cam.privacy) return;
        this.props.context.socket.setState(this.dp("siren_active"), !this.state.cam.siren);
    };

    panLeft = () => {
        if (!this.camId || !this.state.cam.panAvail || this.state.cam.privacy) return;
        const next = Math.max(0, (this.state.cam.panPosition || 0) - 30);
        this.props.context.socket.setState(this.dp("pan_position"), next);
    };

    panRight = () => {
        if (!this.camId || !this.state.cam.panAvail || this.state.cam.privacy) return;
        const next = Math.min(360, (this.state.cam.panPosition || 0) + 30);
        this.props.context.socket.setState(this.dp("pan_position"), next);
    };

    toggleFull = () => this.setState({ full: !this.state.full });

    // ── render ───────────────────────────────────────────────────────────────
    // renderMedia renders exactly ONE instance of videoRef / canvasRef.
    // When fullscreen is active the portal renders it; the normal slot shows
    // only a placeholder. This ensures videoRef exists exactly once.
    renderMedia(isFull) {
        const mode = this.state.rxData.mode || "snapshot";
        const mediaStyle = isFull ? styles.mediaFull : styles.media;
        const iframeStyle = isFull ? styles.iframeFull : styles.iframe;

        if (mode === "webrtc") {
            const base = (this.state.rxData.go2rtcUrl || "").replace(/\/$/, "");
            const src = this.state.rxData.go2rtcSrc || this.state.cam.name;
            if (!base || !src) {
                return <div style={styles.hint}>{Generic.t("Set go2rtc base URL and stream name")}</div>;
            }
            const url = `${base}/stream.html?src=${encodeURIComponent(src)}&mode=webrtc`;
            return <iframe title="go2rtc" src={url} style={iframeStyle} allow="autoplay; fullscreen" allowFullScreen />;
        }

        // Canvas branch: dedicated mjpeg mode OR snapshot mode with livestream active
        const showCanvas = mode === "mjpeg" || (mode === "snapshot" && this.state.cam.livestream);
        if (showCanvas) {
            return (
                <div style={{ position: "relative", ...mediaStyle, display: "flex" }}>
                    <canvas ref={this.canvasRef} style={{ ...mediaStyle, position: "absolute", inset: 0 }} />
                    {!this.state.liveActive ? (
                        <div style={{
                            position: "absolute",
                            inset: 0,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            background: "rgba(11,11,16,.7)",
                            color: "#9a9aa8",
                            fontSize: 13,
                            fontFamily: FONT,
                            pointerEvents: "none",
                        }}>
                            {Generic.t("Connecting…")}
                        </div>
                    ) : null}
                </div>
            );
        }

        // Snapshot (static img) branch
        if (!this.snapshotBaseUrl()) {
            return <div style={styles.hint}>{Generic.t("No snapshot URL — set snapshot_http_port in the adapter")}</div>;
        }
        return <img ref={this.videoRef} style={mediaStyle} alt={this.state.cam.name || ""} />;
    }

    renderOffline() {
        return (
            <div style={styles.offline}>
                <VideocamOff style={{ fontSize: 46, opacity: 0.7 }} />
                <div style={styles.offlineName}>{this.state.cam.name || ""}</div>
                <div style={styles.offlineLabel}>{Generic.t("Offline")}</div>
            </div>
        );
    }

    renderBadges() {
        const c = this.state.cam;
        return (
            <span style={styles.badges}>
                <span style={{ ...styles.badge, background: c.online ? "rgba(34,197,94,.85)" : "rgba(239,68,68,.85)" }}>
                    <FiberManualRecord style={{ fontSize: 9 }} />
                    {Generic.t(c.online ? "Live" : "Offline")}
                </span>
                {c.motion ? (
                    <span style={{ ...styles.badge, background: "rgba(245,158,11,.9)" }}>{Generic.t("Motion")}</span>
                ) : null}
                {c.privacy ? (
                    <span style={{ ...styles.badge, background: "rgba(99,102,241,.9)" }}>{Generic.t("Privacy")}</span>
                ) : null}
            </span>
        );
    }

    // pillBtn helper: returns sx style based on active/disabled state
    _pillSx(active, disabled) {
        if (disabled) return styles.pillBtnDisabled;
        if (active) return styles.pillBtnActive;
        return styles.pillBtn;
    }

    renderControls(isFull) {
        if (!this.state.rxData.showControls) {
            return null;
        }
        const c = this.state.cam;
        // Privacy ON gates: livestream, light, snapshot, pan, siren
        const gated = c.privacy;

        return (
            <div style={styles.pillBar}>
                {/* Privacy — always enabled */}
                <Tooltip title={Generic.t("Privacy")}>
                    <IconButton
                        size="small"
                        sx={this._pillSx(c.privacy, false)}
                        onClick={this.togglePrivacy}
                    >
                        {c.privacy ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
                    </IconButton>
                </Tooltip>

                {/* Livestream — gated by privacy, only shown when avail */}
                {c.livestreamAvail ? (
                    <Tooltip title={Generic.t(gated ? "Livestream disabled (privacy on)" : c.livestream ? "Stop Livestream" : "Start Livestream")}>
                        <span>
                            <IconButton
                                size="small"
                                sx={this._pillSx(c.livestream, gated)}
                                onClick={this.toggleLivestream}
                                disabled={gated}
                            >
                                {c.livestream ? <StopCircle fontSize="small" /> : <PlayCircle fontSize="small" />}
                            </IconButton>
                        </span>
                    </Tooltip>
                ) : null}

                {/* Light — gated by privacy, only shown when avail */}
                {c.lightAvail && this.state.rxData.showLight !== false ? (
                    <Tooltip title={Generic.t(gated ? "Light disabled (privacy on)" : "Light")}>
                        <span>
                            <IconButton
                                size="small"
                                sx={this._pillSx(c.light, gated)}
                                onClick={this.toggleLight}
                                disabled={gated}
                            >
                                {c.light ? <Lightbulb fontSize="small" /> : <LightbulbOutlined fontSize="small" />}
                            </IconButton>
                        </span>
                    </Tooltip>
                ) : null}

                {/* Snapshot trigger — gated by privacy */}
                <Tooltip title={Generic.t(gated ? "Snapshot disabled (privacy on)" : "Snapshot")}>
                    <span>
                        <IconButton
                            size="small"
                            sx={this._pillSx(false, gated)}
                            onClick={this.triggerSnapshot}
                            disabled={gated}
                        >
                            <CameraAlt fontSize="small" />
                        </IconButton>
                    </span>
                </Tooltip>

                {/* Pan left — only on Gen1 360° Indoor (hardware_version === "INDOOR"), gated by privacy */}
                {c.hardwareVersion === "INDOOR" ? (
                    <Tooltip title={Generic.t(gated ? "Pan disabled (privacy on)" : "Pan left")}>
                        <span>
                            <IconButton
                                size="small"
                                sx={this._pillSx(false, gated || c.panPosition <= 0)}
                                onClick={this.panLeft}
                                disabled={gated || c.panPosition <= 0}
                            >
                                <ChevronLeft fontSize="small" />
                            </IconButton>
                        </span>
                    </Tooltip>
                ) : null}

                {/* Pan right — only on Gen1 360° Indoor (hardware_version === "INDOOR"), gated by privacy */}
                {c.hardwareVersion === "INDOOR" ? (
                    <Tooltip title={Generic.t(gated ? "Pan disabled (privacy on)" : "Pan right")}>
                        <span>
                            <IconButton
                                size="small"
                                sx={this._pillSx(false, gated || c.panPosition >= 360)}
                                onClick={this.panRight}
                                disabled={gated || c.panPosition >= 360}
                            >
                                <ChevronRight fontSize="small" />
                            </IconButton>
                        </span>
                    </Tooltip>
                ) : null}

                {/* Privacy sound — gated by privacy, only shown when avail */}
                {c.privacySoundAvail ? (
                    <Tooltip title={Generic.t(gated ? "Privacy sound disabled (privacy on)" : "Privacy sound")}>
                        <span>
                            <IconButton
                                size="small"
                                sx={this._pillSx(c.privacySound, gated)}
                                onClick={() => {
                                    if (!this.camId || !c.privacySoundAvail || gated) return;
                                    this.props.context.socket.setState(this.dp("privacy_sound_enabled"), !c.privacySound);
                                }}
                                disabled={gated}
                            >
                                {c.privacySound ? <VolumeUp fontSize="small" /> : <VolumeOff fontSize="small" />}
                            </IconButton>
                        </span>
                    </Tooltip>
                ) : null}

                {/* Siren — gated by privacy, optional (showSiren setting), only shown when avail */}
                {c.sirenAvail && this.state.rxData.showSiren ? (
                    <Tooltip title={Generic.t(gated ? "Siren disabled (privacy on)" : c.siren ? "Deactivate siren" : "Trigger siren")}>
                        <span>
                            <IconButton
                                size="small"
                                sx={this._pillSx(c.siren, gated)}
                                onClick={this.toggleSiren}
                                disabled={gated}
                            >
                                {c.siren ? <NotificationsOff fontSize="small" /> : <NotificationsActive fontSize="small" />}
                            </IconButton>
                        </span>
                    </Tooltip>
                ) : null}

                {/* Fullscreen — always enabled */}
                <Tooltip title={Generic.t(isFull ? "Exit fullscreen" : "Fullscreen")}>
                    <IconButton size="small" sx={styles.pillBtn} onClick={this.toggleFull}>
                        {isFull ? <FullscreenExit fontSize="small" /> : <Fullscreen fontSize="small" />}
                    </IconButton>
                </Tooltip>
            </div>
        );
    }

    // renderCameraContent renders the full camera UI (offline or live) for
    // either the inline slot or the fullscreen portal.
    renderCameraContent(isFull) {
        const offline = this.state.cam.online === false;
        const containerStyle = isFull ? styles.fullContainer : styles.container;
        return (
            <div style={containerStyle}>
                {offline ? (
                    this.renderOffline()
                ) : (
                    <>
                        {this.renderMedia(isFull)}
                        <div style={styles.overlayTop}>
                            <span style={styles.name}>{this.state.cam.name || ""}</span>
                            {this.renderBadges()}
                        </div>
                        {this.renderControls(isFull)}
                    </>
                )}
                {isFull ? (
                    <Tooltip title={Generic.t("Exit fullscreen")}>
                        <IconButton sx={styles.fullExitBtn} onClick={this.toggleFull}>
                            <FullscreenExit />
                        </IconButton>
                    </Tooltip>
                ) : null}
            </div>
        );
    }

    renderWidgetBody(props) {
        super.renderWidgetBody(props);

        if (!this.camId) {
            return <div style={styles.hint}>{Generic.t("Select a camera datapoint")}</div>;
        }

        if (this.state.full) {
            // Fullscreen: portal renders the full camera UI (with media refs)
            // into document.body; inline slot shows a placeholder only.
            const portal = ReactDOM.createPortal(
                this.renderCameraContent(true),
                document.body,
            );
            const placeholder = (
                <div style={styles.fullPlaceholder}>
                    <span>{this.state.cam.name || Generic.t("Camera")}</span>
                </div>
            );
            const content = (
                <>
                    {placeholder}
                    {portal}
                </>
            );
            if (this.state.rxData.noCard || props.widget.usedInWidget) {
                return content;
            }
            return this.wrapContent(content, null, { boxSizing: "border-box", height: "100%", padding: 0 });
        }

        // Normal (non-fullscreen) rendering
        const content = this.renderCameraContent(false);
        if (this.state.rxData.noCard || props.widget.usedInWidget) {
            return content;
        }
        return this.wrapContent(content, null, { boxSizing: "border-box", height: "100%", padding: 0 });
    }
}

export default BoschCamera;
