import React from "react";
import ReactDOM from "react-dom";
import { IconButton, Tooltip, Switch, Slider, Select, MenuItem, Button } from "@mui/material";
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
    KeyboardDoubleArrowLeft,
    KeyboardDoubleArrowRight,
    VolumeOff,
    VolumeUp,
    NotificationsActive,
    NotificationsOff,
    Layers,
    Shield,
    Tune,
    PlayArrow,
    Close,
    PictureInPictureAlt,
} from "@mui/icons-material";

import Generic from "./Generic";
import { ACCORDIONS, ALL_CONTROL_DPS } from "./controls";
import { Go2rtcStream } from "./lib/go2rtc";
import { ZoomController } from "./lib/zoom";

// Picture-in-Picture is a browser-wide singleton — only ONE <video> can float
// at a time (document.pictureInPictureElement). While one camera is in PiP,
// every other card's PiP button is greyed/disabled; the active card lights up.
// This module-level registry broadcasts PiP ownership to all live instances.
const _boschPipCards = new Set(); // all mounted BoschCamera instances
let _boschPipActive = null;       // the instance currently in PiP, or null
function _boschPipSetActive(card) {
    _boschPipActive = card;
    for (const c of _boschPipCards) {
        try { c._reflectPipState(); } catch (_) { /* detached */ }
    }
}

const FONT =
    '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

const PRIVACY_COOLDOWN_MS = 5000;
const STREAM_COOLDOWN_MS = 5000;
const OPTIMISTIC_REVERT_MS = 8000;
const SNAP_VISIBLE_MS = 60000;
const SNAP_HIDDEN_MS = 1800000;
const VOL_KEY = "bosch_card_volume";

// ── theme palette ───────────────────────────────────────────────────────────
function palette(theme) {
    if (theme === "android") {
        return {
            pillBg: "rgba(32,33,36,.92)",
            pillBlur: "blur(2px)",
            pillRadius: 14,
            btnRadius: 10,
            accent: "rgba(138,180,248,.30)",
        };
    }
    // ios (default)
    return {
        pillBg: "rgba(24,24,28,.55)",
        pillBlur: "blur(20px) saturate(180%)",
        pillRadius: 999,
        btnRadius: 999,
        accent: "rgba(255,255,255,.18)",
    };
}

const styles = {
    container: {
        width: "100%",
        height: "100%",
        position: "relative",
        overflow: "hidden",
        // Flatten to one compositing layer so the rounded-corner clip is rasterised
        // once — without this the corners flicker over the hardware-composited
        // <video> on re-composite. 2026-06-15 (parity HA v13.5.17 #14).
        isolation: "isolate",
        background: "#0b0b10",
        borderRadius: 18,
        boxShadow: "0 6px 22px rgba(0,0,0,.45)",
        display: "flex",
        flexDirection: "column",
        fontFamily: FONT,
    },
    fullContainer: {
        position: "fixed",
        inset: 0,
        zIndex: 99999,
        background: "#000",
        display: "flex",
        flexDirection: "column",
        fontFamily: FONT,
    },
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
    imgWrapper: { position: "relative", flex: 1, minHeight: 0, display: "flex", overflow: "hidden" },
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
        zIndex: 6,
    },
    name: {
        fontSize: 15,
        fontWeight: 600,
        letterSpacing: 0.2,
        color: "#fff",
        textShadow: "0 1px 3px rgba(0,0,0,.7)",
    },
    badges: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" },
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
    pillBtn: { color: "#fff", width: 38, height: 38 },
    pillBtnActive: { color: "#fff", width: 38, height: 38 },
    pillBtnDisabled: { color: "#fff", width: 38, height: 38, opacity: 0.35 },
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
    // play gate
    playGate: {
        position: "absolute",
        inset: 0,
        zIndex: 11,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        background: "rgba(0,0,0,.30)",
        color: "#fff",
        cursor: "pointer",
        fontFamily: FONT,
    },
    playCircle: {
        width: 64,
        height: 64,
        borderRadius: "50%",
        background: "rgba(255,255,255,.18)",
        backdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
    },
    gateHint: { fontSize: 12, color: "#d0d0d8", textShadow: "0 1px 3px rgba(0,0,0,.7)" },
    // banners
    banner: {
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 7,
        padding: "5px 10px",
        fontSize: 11,
        fontWeight: 600,
        color: "#111",
        textAlign: "center",
        fontFamily: FONT,
    },
    hlsBanner: { background: "rgba(245,158,11,.92)", top: "auto", bottom: 58 },
    maintBanner: { background: "rgba(99,102,241,.92)", color: "#fff" },
    // settings backdrop + bottom sheet (toggle-opened)
    accBackdrop: {
        position: "absolute",
        inset: 0,
        zIndex: 13,
        background: "rgba(0,0,0,.35)",
    },
    accSheet: {
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        top: "32%",
        zIndex: 14,
        background: "rgba(14,14,20,.97)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        borderTopLeftRadius: 16,
        borderTopRightRadius: 16,
        boxShadow: "0 -8px 24px rgba(0,0,0,.5)",
        display: "flex",
        flexDirection: "column",
        fontFamily: FONT,
        overflow: "hidden",
    },
    accSheetHeader: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 14px",
        color: "#fff",
        fontSize: 14,
        fontWeight: 700,
        borderBottom: "1px solid rgba(255,255,255,.08)",
        flex: "0 0 auto",
    },
    accScroll: { overflowY: "auto", flex: "1 1 auto" },
    accHeader: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "9px 14px",
        color: "#d6d6e0",
        fontSize: 13,
        fontWeight: 600,
        cursor: "pointer",
        userSelect: "none",
        borderBottom: "1px solid rgba(255,255,255,.05)",
    },
    accBody: { padding: "4px 14px 10px" },
    row: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        minHeight: 36,
        color: "#c8c8d4",
        fontSize: 13,
    },
    rowLabel: { flex: "0 0 auto", maxWidth: "55%" },
    rowControl: { flex: "1 1 auto", display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8 },
    volPop: {
        position: "absolute",
        bottom: 54,
        left: "50%",
        transform: "translateX(-50%)",
        padding: "10px 8px",
        height: 110,
        borderRadius: 14,
        background: "rgba(24,24,28,.85)",
        backdropFilter: "blur(20px)",
        display: "flex",
        alignItems: "center",
        zIndex: 13,
    },
};

class BoschCamera extends Generic {
    constructor(props) {
        super(props);
        this.videoRef = React.createRef();
        this.canvasRef = React.createRef();
        this.wrapRef = React.createRef();
        this.state.full = false;
        this.state.pip = false; // true while this instance's <video> is in PiP
        this.state.pipBlocked = false; // true when another instance owns PiP
        this.state.cam = {
            name: "",
            online: null,
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
            panLimit: 120,
            hardwareVersion: "",
            motion: false,
            snapshotUrl: "",
            maintenance: "none",
            lastEventAt: "",
            lastEventType: "",
            motionZones: "",
            privacyMasks: "",
        };
        this.state.liveActive = false; // mjpeg canvas first frame received
        this.state.frameLoaded = false; // snapshot <img> has loaded ≥1 good frame
        this.state.streamPhase = "idle"; // idle|gate|connecting|live|stopping
        this.state.maintDismissed = null; // maintenance value the user × -dismissed this session
        this.state.transport = null; // webrtc|hls|null
        this.state.uptime = "";
        this.state.audioOn = false;
        this.state.volume = this._readStoredVolume();
        this.state.showVol = false;
        this.state.privacyCdUntil = 0;
        this.state.streamCdUntil = 0;
        this.state.cdTick = 0;
        this.state.optimistic = {}; // leaf -> value
        this.state.ctl = {}; // leaf -> current value
        this.state.avail = {}; // leaf -> true
        this.state.openAcc = {}; // accordion id -> bool
        this.state.showZones = false;
        this.state.showMasks = false;
        this.state.menuOpen = false; // minimal layout overflow

        this.camId = null;
        this.instance = "0";
        this.pollTimer = null;
        this.keepAliveTimer = null;
        this.uptimeTimer = null;
        this.cdTimer = null;
        this.optTimers = {};
        this.loadingFrame = false;
        this.subs = [];
        this.stream = null; // Go2rtcStream
        this.streamStartedAt = 0;
        this._mounted = false; // guards setState after async resolves post-unmount
        this.zoom = new ZoomController({ maxScale: 4 });
        this._onVisibility = this._onVisibility.bind(this);
        this._onPageHide = this._onPageHide.bind(this);
        this._onPageShow = this._onPageShow.bind(this);
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
                                { value: "webrtc", label: "go2rtc live (audio)" },
                            ],
                        },
                        {
                            name: "theme",
                            type: "select",
                            label: "Theme",
                            default: "auto",
                            options: [
                                { value: "auto", label: "Auto" },
                                { value: "ios", label: "iOS (glass)" },
                                { value: "android", label: "Android (material)" },
                            ],
                        },
                        {
                            name: "layout",
                            type: "select",
                            label: "Layout",
                            default: "normal",
                            options: [
                                { value: "normal", label: "Normal" },
                                { value: "minimal", label: "Minimal (controls behind menu)" },
                                { value: "compact", label: "Compact (video only)" },
                            ],
                        },
                        {
                            name: "autoPlay",
                            type: "select",
                            label: "Auto-play live",
                            default: "lan",
                            options: [
                                { value: "lan", label: "On LAN only" },
                                { value: "always", label: "Always" },
                                { value: "never", label: "Never (tap to play)" },
                            ],
                            hidden: 'data.mode === "snapshot"',
                        },
                        {
                            name: "pollingInterval",
                            type: "number",
                            label: "Polling interval",
                            tooltip: "milliseconds (visible). Throttled to 30 min when the tab is hidden.",
                            default: 1000,
                            hidden: 'data.mode !== "snapshot"',
                        },
                        {
                            name: "indoorAutoRefresh",
                            type: "checkbox",
                            label: "Auto-refresh indoor snapshot",
                            tooltip:
                                "OFF (default): the snapshot updates on motion only. ON: indoor cameras pull a fresh snapshot while this tile is visible (360° every 5 s, Gen2 indoor every 10 s) so a panning/busy scene stays current — but this repeatedly opens one of the 3 shared Bosch sessions. Outdoor cameras are never auto-refreshed.",
                            default: false,
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
                        { name: "showAudio", type: "checkbox", label: "Show audio button", default: true, hidden: 'data.mode !== "webrtc"' },
                        { name: "showAdvanced", type: "checkbox", label: "Show advanced controls", default: true },
                        {
                            name: "panOverlay",
                            type: "select",
                            label: "Pan arrows on video",
                            default: "auto",
                            options: [
                                { value: "auto", label: "Auto" },
                                { value: "always", label: "Always" },
                                { value: "never", label: "Never" },
                            ],
                        },
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

    _readStoredVolume() {
        try {
            const v = parseFloat(window.localStorage.getItem(VOL_KEY));
            return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.7;
        } catch {
            return 0.7;
        }
    }

    theme() {
        const t = this.state.rxData.theme || "auto";
        if (t === "auto") return /android/i.test(navigator.userAgent) ? "android" : "ios";
        return t;
    }

    isLan() {
        const h = window.location.hostname;
        return (
            h === "localhost" ||
            h === "127.0.0.1" ||
            h === "::1" ||
            /\.local$/.test(h) ||
            /\.fritz\.box$/.test(h) ||
            /\.lan$/.test(h) ||
            /^192\.168\./.test(h) ||
            /^10\./.test(h) ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
            /^fe80:/i.test(h)
        );
    }

    // ── lifecycle ────────────────────────────────────────────────────────────
    async componentDidMount() {
        super.componentDidMount();
        this._mounted = true;
        _boschPipCards.add(this); // join the cross-card single-PiP greying group
        document.addEventListener("visibilitychange", this._onVisibility);
        window.addEventListener("pagehide", this._onPageHide);
        window.addEventListener("pageshow", this._onPageShow);
        await this.applyConfig();
    }

    componentWillUnmount() {
        super.componentWillUnmount();
        this._mounted = false;
        // Leave the PiP greying group; if we owned PiP, release so remaining
        // cards re-enable their PiP buttons.
        _boschPipCards.delete(this);
        if (_boschPipActive === this) _boschPipSetActive(null);
        document.removeEventListener("visibilitychange", this._onVisibility);
        window.removeEventListener("pagehide", this._onPageHide);
        window.removeEventListener("pageshow", this._onPageShow);
        this.teardown();
    }

    async onRxDataChanged() {
        this.teardown();
        await this.applyConfig();
    }

    componentDidUpdate(_prevProps, prevState) {
        const mode = this.state.rxData.mode || "snapshot";
        // Toggle zoom only in fullscreen
        if (this.state.full !== prevState.full) {
            this.zoom.setEnabled(!!this.state.full);
            if (this.state.full) {
                // attach to freshly-mounted fullscreen media on next tick
                setTimeout(() => this._attachZoom(), 0);
            }
        }
        if (mode !== "snapshot") {
            return;
        }
        // privacy reveal: forget the previous frame and pull a fresh one at once
        // so the freshly-mounted <img> shows the loading veil, not a broken glyph.
        if (prevState.cam.privacy && !this.state.cam.privacy) {
            if (this.state.frameLoaded) this.setState({ frameLoaded: false });
            this.updateSnapshot();
        } else if (!prevState.cam.privacy && this.state.cam.privacy) {
            if (this.state.frameLoaded) this.setState({ frameLoaded: false });
        }
        // indoor auto-refresh interval depends on privacy / livestream / model —
        // re-arm whenever any of them changes.
        if (
            prevState.cam.privacy !== this.state.cam.privacy ||
            prevState.cam.livestream !== this.state.cam.livestream ||
            prevState.cam.hardwareVersion !== this.state.cam.hardwareVersion
        ) {
            this._armSnapshotRefresh();
        }
        const isLive = this.state.cam.livestream;
        const wasLive = prevState.cam.livestream;
        if (isLive && !wasLive) {
            if (this.pollTimer) {
                clearInterval(this.pollTimer);
                this.pollTimer = null;
            }
            this.setState({ liveActive: false });
            this.startMjpeg();
        } else if (!isLive && wasLive) {
            this.stopMjpeg();
            this.setState({ liveActive: false });
            this.startSnapshotPolling();
        }
    }

    _attachZoom() {
        const target = this.videoRef.current;
        const wrap = this.wrapRef.current;
        if (target && wrap) {
            this.zoom.attach(wrap, target);
            this.zoom.setEnabled(!!this.state.full);
        }
    }

    teardown() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.snapRefreshTimer) {
            clearInterval(this.snapRefreshTimer);
            this.snapRefreshTimer = null;
        }
        if (this.uptimeTimer) {
            clearInterval(this.uptimeTimer);
            this.uptimeTimer = null;
        }
        if (this.cdTimer) {
            clearInterval(this.cdTimer);
            this.cdTimer = null;
        }
        this.stopMjpeg();
        this._stopLive(true);
        this.zoom.detach();
        for (const s of this.subs) {
            this.props.context.socket.unsubscribeState(s.id, s.cb);
        }
        this.subs = [];
        for (const k of Object.keys(this.optTimers)) {
            clearTimeout(this.optTimers[k]);
        }
        this.optTimers = {};
    }

    async applyConfig() {
        const rawDp = this.state.rxData.cam_id_dp || "";
        this.camId = BoschCamera.camIdFromDp(rawDp);
        this.instance = BoschCamera.instanceFromDp(rawDp);
        if (!this.camId) {
            return;
        }

        const subscribe = (field, apply) => {
            const id = this.dp(field);
            const cb = (sid, state) => {
                if (state) apply(state.val);
            };
            this.props.context.socket
                .getState(id)
                .then(st => st && cb(id, st))
                .catch(() => {});
            this.props.context.socket.subscribeState(id, cb);
            this.subs.push({ id, cb });
        };

        const subscribeIfExists = (field, apply) => {
            const id = this.dp(field);
            const cb = (sid, state) => {
                if (state) apply(state.val);
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
        subscribe("maintenance_state", v => this.setCam({ maintenance: v || "none" }));
        subscribe("last_motion_at", v => this.setCam({ lastEventAt: v || "" }));
        subscribe("last_motion_event_type", v => this.setCam({ lastEventType: v || "" }));
        subscribeIfExists("motion_zones", v => this.setCam({ motionZones: v || "" }));
        subscribeIfExists("privacy_masks", v => this.setCam({ privacyMasks: v || "" }));

        subscribeIfExists("front_light_enabled", v => this.setCam({ light: !!v, lightAvail: true }));
        subscribeIfExists("livestream_enabled", v => this.setCam({ livestream: !!v, livestreamAvail: true }));
        subscribeIfExists("siren_active", v => this.setCam({ siren: !!v, sirenAvail: true }));
        subscribeIfExists("privacy_sound_enabled", v => this.setCam({ privacySound: !!v, privacySoundAvail: true }));
        subscribeIfExists("pan_position", v => this.setCam({ panPosition: parseFloat(v) || 0, panAvail: true }));
        subscribeIfExists("hardware_version", v => this.setCam({ hardwareVersion: v || "" }));

        // expanded controls: subscribe-if-exists for every catalogued DP
        for (const leaf of ALL_CONTROL_DPS) {
            subscribeIfExists(leaf, v => this._setCtl(leaf, v));
        }

        const mode = this.state.rxData.mode || "snapshot";
        if (mode === "mjpeg") {
            // mjpeg shows only once livestream is active or the gate is tapped
            if (this._shouldAutoPlay()) {
                this.startMjpeg();
            } else {
                this.setState({ streamPhase: "gate" });
            }
        } else if (mode === "snapshot") {
            this.startSnapshotPolling();
        } else if (mode === "webrtc") {
            if (this._shouldAutoPlay()) {
                this._startLive();
            } else {
                this.setState({ streamPhase: "gate" });
            }
        }
    }

    // Functional updater — MANY subscription callbacks fire in the same tick at
    // subscribe time; without the functional form they read a stale this.state
    // and clobber each other (e.g. online:false lost behind snapshot_url).
    setCam(patch) {
        if (!this._mounted) return;
        this.setState(prev => ({ cam: { ...prev.cam, ...patch } }));
    }

    // store both the value and "available" flag, and clear optimistic when the
    // real value confirms the optimistic one.
    _setCtl(leaf, val) {
        if (!this._mounted) return;
        this.setState(prev => {
            const opt = prev.optimistic;
            const patch = {
                ctl: { ...prev.ctl, [leaf]: val },
                avail: { ...prev.avail, [leaf]: true },
            };
            if (Object.prototype.hasOwnProperty.call(opt, leaf) && opt[leaf] === val) {
                const next = { ...opt };
                delete next[leaf];
                patch.optimistic = next;
                if (this.optTimers[leaf]) {
                    clearTimeout(this.optTimers[leaf]);
                    delete this.optTimers[leaf];
                }
            }
            return patch;
        });
    }

    // optimistic write — flip UI instantly, auto-revert after timeout if no
    // confirmation arrives.
    _writeOptimistic(leaf, val) {
        this.setState(prev => ({ optimistic: { ...prev.optimistic, [leaf]: val } }));
        if (this.optTimers[leaf]) clearTimeout(this.optTimers[leaf]);
        this.optTimers[leaf] = setTimeout(() => {
            this.setState(prev => {
                const next = { ...prev.optimistic };
                delete next[leaf];
                return { optimistic: next };
            });
            delete this.optTimers[leaf];
        }, OPTIMISTIC_REVERT_MS);
        this.props.context.socket.setState(this.dp(leaf), val);
    }

    _ctlVal(leaf) {
        const opt = this.state.optimistic;
        if (Object.prototype.hasOwnProperty.call(opt, leaf)) return opt[leaf];
        return this.state.ctl[leaf];
    }

    // ── snapshot (page-visibility aware) ─────────────────────────────────────
    snapshotBaseUrl() {
        return this.state.rxData.snapshotUrlOverride || this.state.cam.snapshotUrl || "";
    }

    updateSnapshot = () => {
        const base = this.snapshotBaseUrl();
        if (!base || this.loadingFrame || !this.videoRef.current) return;
        this.loadingFrame = true;
        const sep = base.indexOf("?") === -1 ? "?" : "&";
        const img = this.videoRef.current;
        img.onload = () => {
            this.loadingFrame = false;
            // first good frame → drop the loading veil that hides the empty/
            // broken <img> right after privacy turns off ("Bild nicht verfügbar").
            if (this._mounted && !this.state.frameLoaded) this.setState({ frameLoaded: true });
        };
        img.onerror = () => {
            this.loadingFrame = false;
            // keep the veil up (frameLoaded stays false) so the browser's broken-
            // image glyph never shows; the next poll tick retries.
        };
        img.src = `${base}${sep}t=${Date.now()}`;
    };

    _snapshotIntervalMs() {
        if (document.visibilityState === "hidden") return SNAP_HIDDEN_MS;
        return parseInt(this.state.rxData.pollingInterval, 10) || 1000;
    }

    startSnapshotPolling() {
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.updateSnapshot();
        this.pollTimer = setInterval(this.updateSnapshot, this._snapshotIntervalMs());
        this._armSnapshotRefresh();
    }

    // Indoor cameras' cached JPEG only refreshes on motion/snapshot_trigger — the
    // backend has no continuous capture loop. The picture therefore freezes between
    // motion events even though the <img> polls every second. For indoor models we
    // pulse snapshot_trigger so the moving scene (Gen1 360 pans; Gen2 captures room
    // motion) keeps current: Gen1 360 every 5 s, Gen2 indoor every 10 s. Outdoor
    // models return 0 → never auto-triggered (keeps the Bosch 3-session budget free).
    _snapshotRefreshMs() {
        const hw = (this.state.cam.hardwareVersion || "").toUpperCase();
        if (hw === "INDOOR" || hw === "CAMERA_360") return 5000; // Gen1 360 (pans)
        if (hw.includes("INDOOR")) return 10000; // Gen2 indoor (HOME_EYES_INDOOR)
        return 0; // outdoor → no auto-refresh
    }

    // (Re)arm the indoor snapshot-trigger pulse. Only while the tile is in snapshot
    // mode, visible, not in privacy, and not livestreaming — so it never burns a
    // Bosch session for a camera nobody is looking at.
    _armSnapshotRefresh() {
        if (this.snapRefreshTimer) {
            clearInterval(this.snapRefreshTimer);
            this.snapRefreshTimer = null;
        }
        // Opt-in only (default off): pulsing snapshot_trigger repeatedly opens a
        // Bosch session, so leave it to the user via the "Auto-refresh indoor
        // snapshot" widget option. Without it the tile updates on motion only.
        if (!this.state.rxData.indoorAutoRefresh) return;
        const mode = this.state.rxData.mode || "snapshot";
        const ms = this._snapshotRefreshMs();
        if (!ms || mode !== "snapshot") return;
        const blocked = () =>
            document.visibilityState === "hidden" || this.state.cam.privacy || this.state.cam.livestream;
        if (blocked()) return;
        this.snapRefreshTimer = setInterval(() => {
            if (blocked() || !this._mounted) return;
            this.props.context.socket.setState(this.dp("snapshot_trigger"), true);
        }, ms);
    }

    // Restart a torn-down live (webrtc) stream when the page returns to the
    // foreground / is restored from bfcache. Guards mirror _startLive's gate so it
    // never auto-starts a stream the user/privacy stopped. 2026-06-15 (parity HA #7/#8).
    _resumeLiveIfNeeded() {
        const mode = this.state.rxData.mode || "snapshot";
        if (mode !== "webrtc" || !this._mounted) return;
        if (this.state.cam.privacy) return;
        if (this.state.streamPhase !== "idle") return;
        if (!this._shouldAutoPlay()) return;
        this._startLive();
    }

    _onPageShow(e) {
        // bfcache restore: _onPageHide tore the stream down and nothing restarted
        // it. Re-evaluate. 2026-06-15 (parity HA v13.5.17 #7).
        if (e && e.persisted) this._resumeLiveIfNeeded();
    }

    _onVisibility() {
        const mode = this.state.rxData.mode || "snapshot";
        // webrtc: restart a torn-down live stream on return to foreground (the
        // snapshot polling below only applies to snapshot mode). 2026-06-15 (#8).
        if (mode === "webrtc") {
            if (document.visibilityState === "visible") this._resumeLiveIfNeeded();
            return;
        }
        if (mode !== "snapshot" || this.state.cam.livestream) return;
        // restart timer with the appropriate interval; refresh soon when visible
        if (this.pollTimer) clearInterval(this.pollTimer);
        if (document.visibilityState === "visible") {
            setTimeout(this.updateSnapshot, 500);
        }
        this.pollTimer = setInterval(this.updateSnapshot, this._snapshotIntervalMs());
        // pause the indoor snapshot pulse while hidden, resume it when visible
        this._armSnapshotRefresh();
    }

    _onPageHide() {
        // free go2rtc slot on iOS WKWebView reload (disconnectedCallback may not fire)
        this._stopLive(true);
    }

    // ── mjpeg (canvas) ───────────────────────────────────────────────────────
    onFrame = data => {
        if (!data || (typeof data === "object" && (data.accepted || data.error))) return;
        const canvas = this.canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        const img = new Image();
        img.onload = () => {
            canvas.width = img.width;
            canvas.height = img.height;
            ctx.drawImage(img, 0, 0, img.width, img.height);
            if (!this.state.liveActive) this.setState({ liveActive: true });
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

    // ── go2rtc native live stream ────────────────────────────────────────────
    _shouldAutoPlay() {
        const ap = this.state.rxData.autoPlay || "lan";
        if (ap === "always") return true;
        if (ap === "never") return false;
        return this.isLan();
    }

    async _startLive() {
        const mode = this.state.rxData.mode || "snapshot";
        if (mode !== "webrtc") {
            // live for snapshot/mjpeg modes = turn on backend livestream
            if (this.state.cam.privacy) return;
            this._writeOptimistic("livestream_enabled", true);
            return;
        }
        // webrtc native go2rtc
        Go2rtcStream.armAudioUnlock(); // synchronous in gesture
        const base = (this.state.rxData.go2rtcUrl || "").replace(/\/$/, "");
        const src = this.state.rxData.go2rtcSrc || this.state.cam.name;
        if (!base || !src) {
            this.setState({ streamPhase: "idle" });
            return;
        }
        // a previous stream may still be live/connecting (e.g. autoPlay re-fires
        // on reconfig) — tear it down so its onPhase callback can't orphan-set
        // state onto the replacement.
        if (this.stream) {
            try {
                this.stream.stop();
            } catch {
                /* ignore */
            }
            this.stream = null;
        }
        // ensure the camera RTSP proxy is alive for go2rtc to consume
        if (!this.state.cam.privacy && this.state.cam.livestreamAvail && !this.state.cam.livestream) {
            this.props.context.socket.setState(this.dp("livestream_enabled"), true);
        }
        this.setState({ streamPhase: "connecting", transport: null });
        this.stream = new Go2rtcStream({
            baseUrl: base,
            src,
            onPhase: (phase, transport) => this._onStreamPhase(phase, transport),
            onError: () => this.setState({ streamPhase: "idle", transport: null }),
        });
        // wait for the <video> to exist
        await new Promise(r => setTimeout(r, 0));
        const video = this.videoRef.current;
        if (!video) {
            this.setState({ streamPhase: "idle" });
            return;
        }
        // PiP event listeners: detach before re-registering to avoid listener
        // accumulation when _startLive is called without a preceding _stopLive
        // (e.g., config changes, bfcache restore). 2026-06-15 fix (Chromium #1).
        video.removeEventListener("enterpictureinpicture", this._onEnterPip);
        video.removeEventListener("leavepictureinpicture", this._onLeavePip);
        video.removeEventListener("webkitpresentationmodechanged", this._onWebkitPresentationModeChanged);
        video.addEventListener("enterpictureinpicture", this._onEnterPip);
        video.addEventListener("leavepictureinpicture", this._onLeavePip);
        // iOS Safari: webkitpresentationmodechanged fires when entering/leaving PiP
        // via webkitSetPresentationMode. Mirror the W3C PiP state into _reflectPipState.
        video.addEventListener("webkitpresentationmodechanged", this._onWebkitPresentationModeChanged);
        try {
            await this.stream.start(video, { wantAudio: this.state.audioOn, armed: true });
        } catch {
            this.setState({ streamPhase: "idle", transport: null });
        }
    }

    _onEnterPip = () => _boschPipSetActive(this);
    _onLeavePip = () => {
        if (_boschPipActive === this) _boschPipSetActive(null);
    };

    _onWebkitPresentationModeChanged = (e) => {
        const video = e.target || this.videoRef.current;
        if (!video) return;
        if (video.webkitPresentationMode === "picture-in-picture") {
            _boschPipSetActive(this);
        } else if (_boschPipActive === this) {
            _boschPipSetActive(null);
        }
    };

    _onStreamPhase(phase, transport) {
        if (!this._mounted) return;
        if (phase === "live") {
            if (!this.streamStartedAt) {
                this.streamStartedAt = Date.now();
                this._startUptime();
            }
            this.setState({ streamPhase: "live", transport: transport || this.state.transport });
            setTimeout(() => this._attachZoom(), 0);
        } else if (phase === "connecting") {
            this.setState({ streamPhase: "connecting", transport });
        } else if (phase === "idle" || phase === "error") {
            this.setState({ streamPhase: "idle", transport: null });
        }
    }

    _startUptime() {
        if (this.uptimeTimer) clearInterval(this.uptimeTimer);
        const tick = () => {
            const s = Math.floor((Date.now() - this.streamStartedAt) / 1000);
            const mm = String(Math.floor(s / 60)).padStart(2, "0");
            const ss = String(s % 60).padStart(2, "0");
            this.setState({ uptime: `${mm}:${ss}` });
        };
        tick();
        this.uptimeTimer = setInterval(tick, 1000);
    }

    _stopLive(silent) {
        if (this.uptimeTimer) {
            clearInterval(this.uptimeTimer);
            this.uptimeTimer = null;
        }
        this.streamStartedAt = 0;
        // Exit PiP on true stop (user tap / privacy / teardown).
        // go2rtc reconnects (session rotation, 60-min limit) are handled internally
        // by Go2rtcStream without calling _stopLive — the same <video> node gets a
        // new srcObject, so the PiP window survives reconnects automatically.
        if (document.pictureInPictureElement === this.videoRef.current) {
            document.exitPictureInPicture().catch(() => {});
        }
        const video = this.videoRef.current;
        // iOS Safari: webkitSetPresentationMode path — document.pictureInPictureElement
        // is always falsy on iOS, so the W3C exit above never fires. Exit webkit PiP
        // explicitly on stream stop to avoid a frozen floating window. 2026-06-15 fix.
        if (video && typeof video.webkitSetPresentationMode === "function" &&
            video.webkitPresentationMode === "picture-in-picture") {
            try { video.webkitSetPresentationMode("inline"); } catch (_) {}
        }
        if (video) {
            video.removeEventListener("enterpictureinpicture", this._onEnterPip);
            video.removeEventListener("leavepictureinpicture", this._onLeavePip);
            video.removeEventListener("webkitpresentationmodechanged", this._onWebkitPresentationModeChanged);
        }
        if (this.stream) {
            try {
                this.stream.stop();
            } catch {
                /* ignore */
            }
            this.stream = null;
        }
        const mode = this.state.rxData.mode || "snapshot";
        if (!silent && mode === "webrtc" && this.state.cam.livestreamAvail && this.state.cam.livestream) {
            this.props.context.socket.setState(this.dp("livestream_enabled"), false);
        }
        // Reset the UI phase even on a SILENT stop (pagehide/bfcache teardown): the
        // pageshow recovery (_resumeLiveIfNeeded, guarded on streamPhase==="idle")
        // and the audio/PiP button visibility both depend on it. Only the iobroker
        // write above is skipped when silent. _mounted-guarded so a teardown stop
        // (componentWillUnmount) can't setState on an unmounted component.
        // 2026-06-15 (parity HA #7 — fixes silent-stop leaving phase stuck "live").
        if (this._mounted) {
            this.setState({ streamPhase: "idle", transport: null, uptime: "" });
        }
    }

    // ── primary controls ─────────────────────────────────────────────────────
    _privacyCd() {
        return Math.max(0, Math.ceil((this.state.privacyCdUntil - Date.now()) / 1000));
    }

    _streamCd() {
        return Math.max(0, Math.ceil((this.state.streamCdUntil - Date.now()) / 1000));
    }

    _armCdTimer() {
        if (this.cdTimer) return;
        this.cdTimer = setInterval(() => {
            if (this._privacyCd() <= 0 && this._streamCd() <= 0) {
                clearInterval(this.cdTimer);
                this.cdTimer = null;
            }
            this.setState(prev => ({ cdTick: prev.cdTick + 1 }));
        }, 1000);
    }

    togglePrivacy = () => {
        if (!this.camId || this._privacyCd() > 0) return;
        this.setState({ privacyCdUntil: Date.now() + PRIVACY_COOLDOWN_MS });
        this._armCdTimer();
        this._writeOptimistic("privacy_enabled", !this.state.cam.privacy);
    };

    toggleLight = () => {
        if (!this.camId || !this.state.cam.lightAvail || this.state.cam.privacy) return;
        this._writeOptimistic("front_light_enabled", !this.state.cam.light);
    };

    toggleLivestream = () => {
        if (!this.camId || this._streamCd() > 0) return;
        const mode = this.state.rxData.mode || "snapshot";
        this.setState({ streamCdUntil: Date.now() + STREAM_COOLDOWN_MS });
        this._armCdTimer();
        if (mode === "webrtc") {
            if (this.state.streamPhase === "live" || this.state.streamPhase === "connecting") {
                this._stopLive(false);
            } else {
                this._startLive();
            }
            return;
        }
        if (!this.state.cam.livestreamAvail || this.state.cam.privacy) return;
        this._writeOptimistic("livestream_enabled", !this.state.cam.livestream);
    };

    triggerSnapshot = () => {
        if (!this.camId || this.state.cam.privacy) return;
        this.props.context.socket.setState(this.dp("snapshot_trigger"), true);
    };

    toggleSiren = () => {
        if (!this.camId || !this.state.cam.sirenAvail || this.state.cam.privacy) return;
        this._writeOptimistic("siren_active", !this.state.cam.siren);
    };

    togglePrivacySound = () => {
        if (!this.camId || !this.state.cam.privacySoundAvail || this.state.cam.privacy) return;
        this._writeOptimistic("privacy_sound_enabled", !this.state.cam.privacySound);
    };

    panTo = next => {
        if (!this.camId || !this.state.cam.panAvail || this.state.cam.privacy) return;
        const lim = this.state.cam.panLimit || 120;
        this.props.context.socket.setState(this.dp("pan_position"), Math.max(-lim, Math.min(lim, next)));
        setTimeout(() => {
            if (!this.state.cam.privacy) this.props.context.socket.setState(this.dp("snapshot_trigger"), true);
        }, 2000);
    };

    toggleFull = () => {
        // Can't be in PiP and CSS-fullscreen at once — exit PiP first.
        // fire-and-forget keeps the gesture synchronous for the state update.
        if (document.pictureInPictureElement) {
            document.exitPictureInPicture().catch(() => {});
        }
        this.setState({ full: !this.state.full });
    };

    // ── Picture-in-Picture ───────────────────────────────────────────────────
    togglePip = () => {
        // Already floating → same button closes PiP (toggle, like fullscreen).
        if (document.pictureInPictureElement) {
            document.exitPictureInPicture().catch(() => {});
            return;
        }
        const video = this.videoRef.current;
        if (!video) return;

        // iOS Safari: document.pictureInPictureEnabled is false but
        // video.webkitSetPresentationMode is available on Safari 15+/iPadOS.
        if (!document.pictureInPictureEnabled && typeof video.webkitSetPresentationMode === "function") {
            const next = video.webkitPresentationMode === "picture-in-picture" ? "inline" : "picture-in-picture";
            try { video.webkitSetPresentationMode(next); } catch (_) {}
            return;
        }

        if (!document.pictureInPictureEnabled || video.disablePictureInPicture) {
            return; // browser/element can't do PiP (iOS Safari without webkit API, old Firefox)
        }
        // Needs at least metadata; a just-started WebRTC stream may not be ready.
        if (video.readyState < 1 /* HAVE_METADATA */) {
            return; // start the live stream first, then tap PiP
        }
        // Label the PiP window with the camera name — Chrome otherwise shows the
        // page origin. MUST be synchronous in the click gesture (before await).
        this._setPipMetadata();
        // requestPictureInPicture MUST be called synchronously inside the click
        // handler (no await before it) — otherwise browsers throw NotAllowedError.
        video.requestPictureInPicture().catch(() => {
            // gesture lost / NotAllowedError — silent, user can tap again
        });
    };

    _reflectPipState() {
        if (!this._mounted) return;
        const mine = _boschPipActive === this;
        const blocked = _boschPipActive !== null && !mine;
        this.setState({ pip: mine, pipBlocked: blocked });
    }

    _setPipMetadata() {
        if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
        try {
            const name = this.state.cam.name || "Bosch Kamera";
            navigator.mediaSession.metadata = new MediaMetadata({
                title: name,
                artist: "Bosch Smart Home",
            });
        } catch (_) { /* MediaMetadata constructor unavailable */ }
    }

    toggleAudio = () => {
        const next = !this.state.audioOn;
        this.setState({ audioOn: next });
        const v = this.videoRef.current;
        if (v) {
            if (next) {
                Go2rtcStream.armAudioUnlock();
                v.muted = false;
                v.volume = this.state.volume;
                if (v.paused) v.play().catch(() => {});
                // Chrome may silently re-mute within ~2s if activation budget is
                // exhausted. Re-check after a tick and force-replay if it did.
                // 2026-06-15 fix (Chromium #2).
                setTimeout(() => {
                    if (this.state.audioOn && v.muted) {
                        v.muted = false;
                        v.play().catch(() => { v.muted = true; });
                    }
                }, 200);
            } else {
                v.muted = true;
            }
        }
    };

    setVolume = val => {
        const vol = Math.min(1, Math.max(0, val));
        this.setState({ volume: vol });
        try {
            window.localStorage.setItem(VOL_KEY, String(vol));
        } catch {
            /* ignore */
        }
        const v = this.videoRef.current;
        if (v) v.volume = vol;
    };

    // ── render: media ────────────────────────────────────────────────────────
    renderMedia(isFull) {
        const mode = this.state.rxData.mode || "snapshot";
        const mediaStyle = isFull ? styles.mediaFull : styles.media;

        if (mode === "webrtc") {
            const base = (this.state.rxData.go2rtcUrl || "").replace(/\/$/, "");
            const src = this.state.rxData.go2rtcSrc || this.state.cam.name;
            if (!base || !src) {
                return <div style={styles.hint}>{Generic.t("Set go2rtc base URL and stream name")}</div>;
            }
            const rot = this._ctlVal("image_rotation_180") ? " rotate(180deg)" : "";
            return (
                <div ref={this.wrapRef} style={styles.imgWrapper}>
                    <video
                        ref={this.videoRef}
                        style={{ ...mediaStyle, transform: rot.trim() || undefined }}
                        playsInline
                        autoPlay
                        muted
                    />
                    {this.renderStreamOverlay()}
                </div>
            );
        }

        const showCanvas = mode === "mjpeg" || (mode === "snapshot" && this.state.cam.livestream);
        if (showCanvas) {
            // mjpeg with a tap-to-play gate (autoPlay off): show the play gate
            // instead of a perpetual "Connecting…" until the user taps.
            const gated = mode === "mjpeg" && this.state.streamPhase === "gate" && !this.state.liveActive;
            return (
                <div ref={this.wrapRef} style={{ position: "relative", ...mediaStyle, display: "flex" }}>
                    <canvas ref={this.canvasRef} style={{ ...mediaStyle, position: "absolute", inset: 0 }} />
                    {gated ? (
                        this.renderPlayGate()
                    ) : !this.state.liveActive ? (
                        <div style={this._connectingOverlayStyle()}>{Generic.t("Connecting…")}</div>
                    ) : null}
                </div>
            );
        }

        if (!this.snapshotBaseUrl()) {
            return <div style={styles.hint}>{Generic.t("No snapshot URL — set snapshot_http_port in the adapter")}</div>;
        }
        return (
            <div ref={this.wrapRef} style={styles.imgWrapper}>
                <img ref={this.videoRef} style={mediaStyle} alt={this.state.cam.name || ""} />
                {!this.state.frameLoaded ? (
                    <div style={this._connectingOverlayStyle()}>{Generic.t("Connecting…")}</div>
                ) : null}
                {this.renderOverlaysSvg()}
            </div>
        );
    }

    _connectingOverlayStyle() {
        return {
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
        };
    }

    renderStreamOverlay() {
        const phase = this.state.streamPhase;
        if (phase === "gate" || phase === "idle") {
            return this.renderPlayGate();
        }
        if (phase === "connecting") {
            return <div style={this._connectingOverlayStyle()}>{Generic.t("Connecting…")}</div>;
        }
        return this.renderOverlaysSvg();
    }

    _startFromGate = () => {
        const mode = this.state.rxData.mode || "snapshot";
        if (mode === "mjpeg") {
            this.setState({ streamPhase: "connecting", liveActive: false });
            this.startMjpeg();
        } else {
            this.setState({ streamPhase: "connecting" });
            this._startLive();
        }
    };

    renderPlayGate() {
        const hint = this.isLan() ? "Tap to start live view" : "Tap to start (remote — higher latency)";
        return (
            <div style={styles.playGate} onPointerUp={this._startFromGate}>
                <div style={styles.playCircle}>
                    <PlayArrow style={{ fontSize: 38, color: "#fff" }} />
                </div>
                <div style={styles.gateHint}>{Generic.t(hint)}</div>
            </div>
        );
    }

    // motion-zone / privacy-mask SVG overlays (normalised 0..1 rects)
    renderOverlaysSvg() {
        const out = [];
        if (this.state.showZones && this.state.cam.motionZones) {
            out.push(...this._rects(this.state.cam.motionZones, "rgba(245,158,11,.85)", "zone"));
        }
        if (this.state.showMasks && this.state.cam.privacyMasks) {
            out.push(...this._rects(this.state.cam.privacyMasks, "rgba(0,0,0,.85)", "mask"));
        }
        if (!out.length) return null;
        return (
            <svg
                viewBox="0 0 1 1"
                preserveAspectRatio="none"
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 5 }}
            >
                {out}
            </svg>
        );
    }

    _rects(json, stroke, kind) {
        let arr;
        try {
            arr = JSON.parse(json);
        } catch {
            return [];
        }
        if (!Array.isArray(arr)) return [];
        return arr.map((r, i) => {
            // normalise: accept 0..1 or 0..100/0..1000 by clamping with a heuristic
            let { x, y, w, h } = r;
            const scale = Math.max(x, y, w, h) > 1.5 ? (Math.max(x, y, w, h) > 100 ? 1000 : 100) : 1;
            x /= scale;
            y /= scale;
            w /= scale;
            h /= scale;
            return (
                <rect
                    key={`${kind}-${i}`}
                    x={x}
                    y={y}
                    width={w}
                    height={h}
                    fill={kind === "mask" ? stroke : "rgba(245,158,11,.18)"}
                    stroke={stroke}
                    strokeWidth="0.004"
                />
            );
        });
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

    // ── render: badges ───────────────────────────────────────────────────────
    renderBadges() {
        const c = this.state.cam;
        const phase = this.state.streamPhase;
        const out = [];
        if (phase === "connecting") {
            out.push(
                <span key="conn" style={{ ...styles.badge, background: "rgba(245,158,11,.9)" }}>
                    {Generic.t("Connecting…")}
                </span>,
            );
        } else if (phase === "live" && this.state.uptime) {
            // an ACTUAL live stream is running → "Live" + uptime
            out.push(
                <span key="up" style={{ ...styles.badge, background: "rgba(10,132,255,.9)" }}>
                    <FiberManualRecord style={{ fontSize: 9 }} />
                    {`${Generic.t("Live")} ${this.state.uptime}`}
                </span>,
            );
        } else if (c.privacy) {
            // privacy implies the camera is present — never show offline here.
            // (the dedicated privacy badge is appended below.)
        } else if (c.online === true) {
            // reachable but NOT streaming — "Online", not "Live"
            out.push(
                <span key="onoff" style={{ ...styles.badge, background: "rgba(34,197,94,.85)" }}>
                    <FiberManualRecord style={{ fontSize: 9 }} />
                    {Generic.t("Online")}
                </span>,
            );
        } else if (c.online === false) {
            out.push(
                <span key="onoff" style={{ ...styles.badge, background: "rgba(239,68,68,.85)" }}>
                    <FiberManualRecord style={{ fontSize: 9 }} />
                    {Generic.t("Offline")}
                </span>,
            );
        }
        // online === null (unknown): show nothing until the value loads
        if (c.motion) {
            out.push(
                <span key="motion" style={{ ...styles.badge, background: "rgba(245,158,11,.9)" }}>
                    {Generic.t("Motion")}
                </span>,
            );
        }
        if (c.privacy) {
            out.push(
                <span key="priv" style={{ ...styles.badge, background: "rgba(99,102,241,.9)" }}>
                    {Generic.t("Privacy")}
                </span>,
            );
        }
        if (c.lastEventAt && this.state.rxData.layout !== "compact") {
            out.push(
                <span key="last" style={{ ...styles.badge, background: "rgba(60,60,67,.75)" }}>
                    {this._lastEventLabel()}
                </span>,
            );
        }
        return <span style={styles.badges}>{out}</span>;
    }

    _lastEventLabel() {
        const t = this.state.cam.lastEventAt;
        if (!t) return "";
        try {
            const d = new Date(t);
            const timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            const type = this.state.cam.lastEventType ? `${Generic.t(this.state.cam.lastEventType)} ` : "";
            return `${type}${timeStr}`;
        } catch {
            return "";
        }
    }

    // ── render: pill bar ─────────────────────────────────────────────────────
    _pillSx(active, disabled, pal) {
        const base = { color: "#fff", width: 38, height: 38, borderRadius: pal.btnRadius };
        if (disabled) return { ...base, opacity: 0.35 };
        if (active) return { ...base, background: pal.accent };
        return base;
    }

    renderControls(isFull) {
        if (!this.state.rxData.showControls || this.state.rxData.layout === "compact") return null;
        const c = this.state.cam;
        const gated = c.privacy;
        const pal = palette(this.theme());
        const mode = this.state.rxData.mode || "snapshot";
        const live = mode === "webrtc" ? this.state.streamPhase === "live" || this.state.streamPhase === "connecting" : c.livestream;
        const pcd = this._privacyCd();
        const scd = this._streamCd();
        const pillBarStyle = {
            position: "absolute",
            bottom: 12,
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            alignItems: "center",
            gap: 2,
            padding: "4px 6px",
            borderRadius: pal.pillRadius,
            background: pal.pillBg,
            backdropFilter: pal.pillBlur,
            WebkitBackdropFilter: pal.pillBlur,
            border: "1px solid rgba(255,255,255,.14)",
            boxShadow: "0 4px 14px rgba(0,0,0,.4)",
            whiteSpace: "nowrap",
            overflowX: "auto",
            zIndex: 12,
        };

        // Audio is stream-contextual — show it only while a live stream is playing
        // (appears with the stop button, hidden over an idle/snapshot tile) rather
        // than greyed out. 2026-06-15 (parity HA v13.5.17 #15).
        const showAudio =
            mode === "webrtc" && this.state.rxData.showAudio !== false && this.state.streamPhase === "live";
        const hasZones = !!c.motionZones;
        const hasMasks = !!c.privacyMasks;

        return (
            <div style={pillBarStyle} className="ap-pill-bar">
                <Tooltip title={pcd > 0 ? `${Generic.t("Privacy")} (${pcd}s)` : Generic.t("Privacy")}>
                    <IconButton size="small" sx={this._pillSx(c.privacy, pcd > 0, pal)} onClick={this.togglePrivacy}>
                        {c.privacy ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
                    </IconButton>
                </Tooltip>

                {c.livestreamAvail || mode === "webrtc" ? (
                    <Tooltip
                        title={
                            scd > 0
                                ? `${Generic.t("Livestream")} (${scd}s)`
                                : Generic.t(gated ? "Livestream disabled (privacy on)" : live ? "Stop Livestream" : "Start Livestream")
                        }
                    >
                        <span>
                            <IconButton
                                size="small"
                                sx={this._pillSx(live, (gated && mode !== "webrtc") || scd > 0, pal)}
                                onClick={this.toggleLivestream}
                                disabled={(gated && mode !== "webrtc") || scd > 0}
                            >
                                {live ? <StopCircle fontSize="small" /> : <PlayCircle fontSize="small" />}
                            </IconButton>
                        </span>
                    </Tooltip>
                ) : null}

                {showAudio ? (
                    <span style={{ position: "relative", display: "inline-flex" }}
                        onMouseEnter={() => this.setState({ showVol: true })}
                        onMouseLeave={() => this.setState({ showVol: false })}
                    >
                        <Tooltip title={Generic.t(this.state.audioOn ? "Mute" : "Sound")}>
                            <IconButton size="small" sx={this._pillSx(this.state.audioOn, false, pal)} onClick={() => {
                                // Capture next state BEFORE toggleAudio() to avoid reading
                                // stale this.state.audioOn (React setState is async). 2026-06-15 fix.
                                const next = !this.state.audioOn;
                                this.toggleAudio();
                                // On touch devices, toggle the volume popup on audio-button tap.
                                // (mouseenter/leave don't fire on touch.) 2026-06-15 fix (Android #1).
                                if (next) {
                                    this.setState(prev => ({ showVol: !prev.showVol }));
                                } else {
                                    this.setState({ showVol: false });
                                }
                            }}>
                                {this.state.audioOn ? <VolumeUp fontSize="small" /> : <VolumeOff fontSize="small" />}
                            </IconButton>
                        </Tooltip>
                        {this.state.showVol && this.state.audioOn ? (
                            <div style={styles.volPop} className="ap-vol-pop">
                                <Slider
                                    orientation="vertical"
                                    size="small"
                                    value={this.state.volume}
                                    min={0}
                                    max={1}
                                    step={0.05}
                                    onChange={(_e, v) => this.setVolume(v)}
                                    sx={{ color: "#fff", height: 90 }}
                                />
                            </div>
                        ) : null}
                    </span>
                ) : null}

                {c.lightAvail && this.state.rxData.showLight !== false ? (
                    <Tooltip title={Generic.t(gated ? "Light disabled (privacy on)" : "Light")}>
                        <span>
                            <IconButton size="small" sx={this._pillSx(c.light, gated, pal)} onClick={this.toggleLight} disabled={gated}>
                                {c.light ? <Lightbulb fontSize="small" /> : <LightbulbOutlined fontSize="small" />}
                            </IconButton>
                        </span>
                    </Tooltip>
                ) : null}

                <Tooltip title={Generic.t(gated ? "Snapshot disabled (privacy on)" : "Snapshot")}>
                    <span>
                        <IconButton size="small" sx={this._pillSx(false, gated, pal)} onClick={this.triggerSnapshot} disabled={gated}>
                            <CameraAlt fontSize="small" />
                        </IconButton>
                    </span>
                </Tooltip>

                {c.panAvail && this._isPanCam() ? this._panButtons(gated, pal) : null}

                {hasZones ? (
                    <Tooltip title={Generic.t("Motion zones")}>
                        <IconButton
                            size="small"
                            sx={this._pillSx(this.state.showZones, false, pal)}
                            onClick={() => this.setState({ showZones: !this.state.showZones })}
                        >
                            <Layers fontSize="small" />
                        </IconButton>
                    </Tooltip>
                ) : null}

                {hasMasks ? (
                    <Tooltip title={Generic.t("Privacy masks")}>
                        <IconButton
                            size="small"
                            sx={this._pillSx(this.state.showMasks, false, pal)}
                            onClick={() => this.setState({ showMasks: !this.state.showMasks })}
                        >
                            <Shield fontSize="small" />
                        </IconButton>
                    </Tooltip>
                ) : null}

                {c.privacySoundAvail ? (
                    <Tooltip title={Generic.t(gated ? "Privacy sound disabled (privacy on)" : "Privacy sound")}>
                        <span>
                            <IconButton size="small" sx={this._pillSx(c.privacySound, gated, pal)} onClick={this.togglePrivacySound} disabled={gated}>
                                {c.privacySound ? <VolumeUp fontSize="small" /> : <VolumeOff fontSize="small" />}
                            </IconButton>
                        </span>
                    </Tooltip>
                ) : null}

                {c.sirenAvail && this.state.rxData.showSiren ? (
                    <Tooltip title={Generic.t(gated ? "Siren disabled (privacy on)" : c.siren ? "Deactivate siren" : "Trigger siren")}>
                        <span>
                            <IconButton size="small" sx={this._pillSx(c.siren, gated, pal)} onClick={this.toggleSiren} disabled={gated}>
                                {c.siren ? <NotificationsOff fontSize="small" /> : <NotificationsActive fontSize="small" />}
                            </IconButton>
                        </span>
                    </Tooltip>
                ) : null}

                {this.state.rxData.showAdvanced !== false && this._hasAccordionRows() ? (
                    <Tooltip title={Generic.t("Settings")}>
                        <IconButton size="small" sx={this._pillSx(this.state.menuOpen, false, pal)} onClick={() => this.setState({ menuOpen: !this.state.menuOpen })}>
                            <Tune fontSize="small" />
                        </IconButton>
                    </Tooltip>
                ) : null}

                {/* PiP button — hidden where the browser API is unavailable (iOS WebView,
                    old Firefox) AND while no live stream is playing (you can't float a
                    snapshot — appears on stream start). 2026-06-15 (parity HA #15). */}
                {(document.pictureInPictureEnabled || (typeof HTMLVideoElement !== "undefined" && typeof HTMLVideoElement.prototype.webkitSetPresentationMode === "function")) && mode === "webrtc" && this.state.streamPhase === "live" ? (
                    <Tooltip
                        title={
                            this.state.pipBlocked
                                ? Generic.t("Picture-in-picture active for another camera")
                                : Generic.t("Picture-in-picture")
                        }
                    >
                        <span>
                            <IconButton
                                size="small"
                                sx={this._pillSx(this.state.pip, this.state.pipBlocked, pal)}
                                onClick={this.togglePip}
                                disabled={this.state.pipBlocked}
                            >
                                <PictureInPictureAlt fontSize="small" />
                            </IconButton>
                        </span>
                    </Tooltip>
                ) : null}

                <Tooltip title={Generic.t(isFull ? "Exit fullscreen" : "Fullscreen")}>
                    <IconButton size="small" sx={this._pillSx(false, false, pal)} onClick={this.toggleFull}>
                        {isFull ? <FullscreenExit fontSize="small" /> : <Fullscreen fontSize="small" />}
                    </IconButton>
                </Tooltip>
            </div>
        );
    }

    _panButtons(gated, pal) {
        const c = this.state.cam;
        const lim = c.panLimit || 120;
        const atMin = c.panPosition <= -lim;
        const atMax = c.panPosition >= lim;
        return (
            <>
                <Tooltip title={Generic.t("Pan far left")}>
                    <span>
                        <IconButton size="small" sx={this._pillSx(false, gated || atMin, pal)} onClick={() => this.panTo(-lim)} disabled={gated || atMin}>
                            <KeyboardDoubleArrowLeft fontSize="small" />
                        </IconButton>
                    </span>
                </Tooltip>
                <Tooltip title={Generic.t(gated ? "Pan disabled (privacy on)" : "Pan left")}>
                    <span>
                        <IconButton size="small" sx={this._pillSx(false, gated || atMin, pal)} onClick={() => this.panTo(c.panPosition - 30)} disabled={gated || atMin}>
                            <ChevronLeft fontSize="small" />
                        </IconButton>
                    </span>
                </Tooltip>
                <Tooltip title={Generic.t(gated ? "Pan disabled (privacy on)" : "Pan right")}>
                    <span>
                        <IconButton size="small" sx={this._pillSx(false, gated || atMax, pal)} onClick={() => this.panTo(c.panPosition + 30)} disabled={gated || atMax}>
                            <ChevronRight fontSize="small" />
                        </IconButton>
                    </span>
                </Tooltip>
                <Tooltip title={Generic.t("Pan far right")}>
                    <span>
                        <IconButton size="small" sx={this._pillSx(false, gated || atMax, pal)} onClick={() => this.panTo(lim)} disabled={gated || atMax}>
                            <KeyboardDoubleArrowRight fontSize="small" />
                        </IconButton>
                    </span>
                </Tooltip>
            </>
        );
    }

    // ── render: accordions (expanded controls) ───────────────────────────────
    // Gen1 360° indoor is the only camera that can pan/auto-follow. Older adapter
    // versions created pan_position/autofollow for all cameras, so those DPs can
    // linger as orphans on other models → gate by hardware_version, not just DP
    // existence.
    _isPanCam() {
        const hw = this.state.cam.hardwareVersion;
        return hw === "INDOOR" || hw === "CAMERA_360";
    }

    _availableRows(group) {
        const isPan = this._isPanCam();
        return group.rows.filter(r => this.state.avail[r.dp] && !(r.pan && !isPan));
    }

    _hasAccordionRows() {
        if (this.state.rxData.layout === "compact") return false;
        return ACCORDIONS.some(g => this._availableRows(g).length);
    }

    // Settings live in a toggle-opened bottom sheet (the gear button) so they
    // never overlap the video/pill-bar by default.
    renderAccordions() {
        if (!this.state.menuOpen) return null;
        if (this.state.rxData.showAdvanced === false || this.state.rxData.layout === "compact") return null;
        const groups = ACCORDIONS.map(g => ({ g, rows: this._availableRows(g) })).filter(x => x.rows.length);
        if (!groups.length) return null;
        return (
            <>
                <div style={styles.accBackdrop} onClick={() => this.setState({ menuOpen: false })} />
                <div style={styles.accSheet}>
                    <div style={styles.accSheetHeader}>
                        <span>{Generic.t("Settings")}</span>
                        <IconButton size="small" sx={{ color: "#fff" }} onClick={() => this.setState({ menuOpen: false })}>
                            <Close fontSize="small" />
                        </IconButton>
                    </div>
                    <div style={styles.accScroll}>
                        {groups.map(({ g, rows }) => {
                            const open = !!this.state.openAcc[g.id];
                            return (
                                <div key={g.id}>
                                    <div style={styles.accHeader} onClick={() => this.setState({ openAcc: { ...this.state.openAcc, [g.id]: !open } })}>
                                        <span>{Generic.t(g.titleKey)}</span>
                                        <span style={{ opacity: 0.6 }}>{open ? "▾" : "▸"}</span>
                                    </div>
                                    {open ? <div style={styles.accBody}>{rows.map(r => this._renderRow(r))}</div> : null}
                                </div>
                            );
                        })}
                    </div>
                </div>
            </>
        );
    }

    _renderRow(r) {
        const gated = r.gate && this.state.cam.privacy;
        const val = this._ctlVal(r.dp);
        let control = null;
        if (r.kind === "switch") {
            control = (
                <Switch
                    size="small"
                    checked={!!val}
                    disabled={gated}
                    onChange={() => this._writeOptimistic(r.dp, !val)}
                />
            );
        } else if (r.kind === "number") {
            control = (
                <>
                    <Slider
                        size="small"
                        value={typeof val === "number" ? val : r.min}
                        min={r.min}
                        max={r.max}
                        step={r.step}
                        disabled={gated}
                        onChange={(_e, v) => this.setState({ ctl: { ...this.state.ctl, [r.dp]: v } })}
                        onChangeCommitted={(_e, v) => this._writeOptimistic(r.dp, v)}
                        sx={{ width: 120, color: "#8ab4f8" }}
                    />
                    <span style={{ minWidth: 38, textAlign: "right" }}>
                        {typeof val === "number" ? `${val}${r.unit || ""}` : "—"}
                    </span>
                </>
            );
        } else if (r.kind === "select") {
            control = (
                <Select
                    size="small"
                    value={val ?? ""}
                    disabled={gated}
                    onChange={e => this._writeOptimistic(r.dp, e.target.value)}
                    sx={{ color: "#fff", fontSize: 12, ".MuiOutlinedInput-notchedOutline": { borderColor: "rgba(255,255,255,.2)" } }}
                >
                    {r.options.map(o => (
                        <MenuItem key={o.value} value={o.value}>
                            {Generic.t(o.labelKey)}
                        </MenuItem>
                    ))}
                </Select>
            );
        } else if (r.kind === "color") {
            control = (
                <input
                    type="color"
                    value={val && /^#/.test(val) ? val : "#ffffff"}
                    disabled={gated}
                    onChange={e => this._writeOptimistic(r.dp, e.target.value)}
                    style={{ width: 36, height: 24, background: "none", border: "none" }}
                />
            );
        } else if (r.kind === "button") {
            control = (
                <Button
                    size="small"
                    variant="outlined"
                    disabled={gated}
                    onClick={() => this.props.context.socket.setState(this.dp(r.dp), true)}
                    sx={{ color: "#fff", borderColor: "rgba(255,255,255,.25)", fontSize: 11 }}
                >
                    {Generic.t("Run")}
                </Button>
            );
        } else {
            // readonly
            control = <span style={{ opacity: 0.85 }}>{val === undefined || val === null || val === "" ? "—" : `${val}${r.unit || ""}`}</span>;
        }
        return (
            <div style={styles.row} key={r.dp}>
                <span style={styles.rowLabel}>{Generic.t(r.labelKey)}</span>
                <span style={styles.rowControl}>{control}</span>
            </div>
        );
    }

    renderMaintenanceBanner() {
        const m = this.state.cam.maintenance;
        if (!m || m === "none") return null;
        // × dismiss for this browser session (ioBroker's maintenance state carries
        // no window/title, so a persistent per-window key isn't possible — a reload
        // or a state change re-shows it). 2026-06-15 (parity HA v13.5.17 #16).
        if (this.state.maintDismissed === m) return null;
        const txt = m === "active" ? "Bosch cloud maintenance active" : "Bosch cloud maintenance scheduled";
        return (
            <div style={{ ...styles.banner, ...styles.maintBanner, position: "relative", paddingRight: 34 }}>
                {Generic.t(txt)}
                <span
                    role="button"
                    aria-label={Generic.t("Dismiss")}
                    title={Generic.t("Dismiss")}
                    onClick={() => this.setState({ maintDismissed: m })}
                    style={{
                        position: "absolute",
                        top: "50%",
                        right: 8,
                        transform: "translateY(-50%)",
                        width: 24,
                        height: 24,
                        lineHeight: "24px",
                        textAlign: "center",
                        borderRadius: "50%",
                        background: "rgba(0,0,0,.18)",
                        cursor: "pointer",
                        fontSize: 16,
                        touchAction: "manipulation",
                    }}
                >
                    ×
                </span>
            </div>
        );
    }

    renderHlsBanner() {
        if (this.state.transport !== "hls" || this.state.streamPhase !== "live") return null;
        return <div style={{ ...styles.banner, ...styles.hlsBanner }}>{Generic.t("HLS mode · higher latency")}</div>;
    }

    // ── render: composition ──────────────────────────────────────────────────
    // dark privacy placeholder shown when privacy mode is on (the live image is
    // black/unavailable in privacy). Controls stay visible so privacy can be
    // toggled back off.
    renderPrivacy(isFull) {
        const mediaStyle = isFull ? styles.mediaFull : styles.media;
        // Show the last-event timestamp so the frozen tile is clearly identified as
        // stale (ioBroker has no live-snapshot timestamp source, so "last event" is
        // the closest available — the HA snapshot-default needs a snapshot clock the
        // widget doesn't track). 2026-06-15 (parity HA v13.5.17 #17).
        const lastEvt = this._lastEventLabel();
        return (
            <div style={{ ...mediaStyle, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, background: "radial-gradient(circle at 50% 40%, #20203a, #0b0b10)" }}>
                <VisibilityOff style={{ fontSize: 46, color: "#8a8ad0", opacity: 0.85 }} />
                <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase", color: "#8a8ad0" }}>
                    {Generic.t("Privacy mode")}
                </div>
                {lastEvt ? (
                    <div style={{ fontSize: 11, fontWeight: 500, color: "rgba(138,138,208,.8)" }}>
                        {Generic.t("Last event")}: {lastEvt}
                    </div>
                ) : null}
            </div>
        );
    }

    renderCameraContent(isFull) {
        const c = this.state.cam;
        // online is cloud-reconciled (true for a reachable privacy camera, false
        // for a genuinely offline one) → offline screen only when truly offline;
        // a reachable privacy camera falls through to the privacy placeholder.
        const offline = c.online === false;
        const containerStyle = isFull ? styles.fullContainer : styles.container;
        return (
            <div style={containerStyle}>
                {offline ? (
                    this.renderOffline()
                ) : (
                    <>
                        {this.renderMaintenanceBanner()}
                        {c.privacy ? this.renderPrivacy(isFull) : this.renderMedia(isFull)}
                        {this.renderHlsBanner()}
                        <div style={styles.overlayTop}>
                            <span style={styles.name}>{this.state.cam.name || ""}</span>
                            {this.renderBadges()}
                        </div>
                        {this.renderControls(isFull)}
                        {this.renderAccordions()}
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
            const portal = ReactDOM.createPortal(this.renderCameraContent(true), document.body);
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
            if (this.state.rxData.noCard || props.widget.usedInWidget) return content;
            return this.wrapContent(content, null, { boxSizing: "border-box", height: "100%", padding: 0 });
        }

        const content = this.renderCameraContent(false);
        if (this.state.rxData.noCard || props.widget.usedInWidget) return content;
        return this.wrapContent(content, null, { boxSizing: "border-box", height: "100%", padding: 0 });
    }
}

export default BoschCamera;
