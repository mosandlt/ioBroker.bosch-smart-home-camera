import React from "react";
import ReactDOM from "react-dom";
import { IconButton, Tooltip } from "@mui/material";
import {
    Visibility,
    VisibilityOff,
    CameraAlt,
    Lightbulb,
    LightbulbOutlined,
    VideocamOff,
    FiberManualRecord,
    Close,
} from "@mui/icons-material";

import Generic from "./Generic";
import { Go2rtcStream } from "./lib/go2rtc";
import { formatLastEventLabel, shouldShowMaintBanner } from "./lib/event-label";

const FONT =
    '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

const styles = {
    grid: {
        width: "100%",
        height: "100%",
        display: "grid",
        gap: 12,
        padding: 4,
        boxSizing: "border-box",
        overflowY: "auto",
        fontFamily: FONT,
    },
    cell: {
        position: "relative",
        borderRadius: 14,
        overflow: "hidden",
        background: "#0b0b10",
        boxShadow: "0 4px 16px rgba(0,0,0,.4)",
        aspectRatio: "16 / 9",
        cursor: "pointer",
    },
    img: { width: "100%", height: "100%", objectFit: "cover", display: "block", background: "#000" },
    top: {
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "8px 10px",
        gap: 6,
        background: "linear-gradient(rgba(0,0,0,.55), rgba(0,0,0,0))",
        pointerEvents: "none",
    },
    name: { color: "#fff", fontSize: 14, fontWeight: 600, textShadow: "0 1px 3px rgba(0,0,0,.7)" },
    badges: { display: "flex", gap: 5, alignItems: "center" },
    badge: {
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        fontSize: 10,
        lineHeight: "14px",
        padding: "2px 7px",
        borderRadius: 999,
        fontWeight: 600,
        color: "#fff",
    },
    pill: {
        position: "absolute",
        bottom: 8,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        gap: 2,
        padding: "3px 5px",
        borderRadius: 999,
        background: "rgba(24,24,28,.55)",
        backdropFilter: "blur(18px) saturate(180%)",
        WebkitBackdropFilter: "blur(18px) saturate(180%)",
        border: "1px solid rgba(255,255,255,.14)",
    },
    pillBtn: { color: "#fff", width: 32, height: 32 },
    offline: {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        background: "radial-gradient(circle at 50% 40%, #1b1b24, #0b0b10)",
        color: "#6b6b78",
    },
    hint: { color: "#8a8a98", fontSize: 13, textAlign: "center", padding: 24, margin: "auto", fontFamily: FONT },
    overlay: {
        position: "fixed",
        inset: 0,
        zIndex: 99999,
        background: "rgba(0,0,0,.92)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        fontFamily: FONT,
    },
    overlayImg: { maxWidth: "96vw", maxHeight: "88vh", objectFit: "contain", borderRadius: 12 },
    overlayVideo: { maxWidth: "96vw", maxHeight: "88vh", objectFit: "contain", borderRadius: 12, background: "#000" },
    closeBtn: { position: "absolute", top: 14, right: 14, color: "#fff", background: "rgba(0,0,0,.5)", width: 46, height: 46 },
    // W4a: adapter-level maintenance banner (above the grid)
    maintBanner: {
        width: "100%",
        padding: "7px 36px 7px 12px",
        boxSizing: "border-box",
        fontSize: 12,
        fontWeight: 600,
        color: "#fff",
        background: "rgba(99,102,241,.92)",
        position: "relative",
        fontFamily: FONT,
        flexShrink: 0,
    },
    maintDismiss: {
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
        color: "#fff",
    },
};

class BoschOverview extends Generic {
    constructor(props) {
        super(props);
        this.state.cams = {}; // camId -> {name,online,privacy,motion,light,lightAvail,snapshotUrl,lastEventAt,lastEventType}
        this.state.order = []; // discovered camId order
        this.state.expanded = null; // camId in fullscreen
        // W4a: adapter-level maintenance
        this.state.maintState = "none"; // info.maintenance.state value
        this.state.maintTitle = ""; // info.maintenance.title value
        this.state.maintDismissed = null; // value the user session-dismissed
        this.state.expandStreamError = false; // W4c: go2rtc failed → fall back to snapshot
        this.instance = "0";
        this.subs = [];
        this.expandTimer = null;
        this._mounted = false;
        // W4c: live stream in expanded overlay
        this.videoRef = React.createRef();
        this.expandStream = null; // active Go2rtcStream instance for expanded overlay
    }

    static getWidgetInfo() {
        return {
            id: "tplBoschOverview",
            visSet: "bosch-smart-home-camera",
            visSetLabel: "Bosch Camera",
            visSetColor: "#007bc1",
            visName: "Bosch Camera Overview",
            visWidgetLabel: "Bosch Camera Overview",
            visAttrs: [
                {
                    name: "common",
                    fields: [
                        { name: "instance", type: "number", label: "Adapter instance", default: 0 },
                        {
                            name: "columns",
                            type: "select",
                            label: "Columns",
                            default: "auto",
                            options: [
                                { value: "auto", label: "Auto" },
                                { value: "1", label: "1" },
                                { value: "2", label: "2" },
                                { value: "3", label: "3" },
                                { value: "4", label: "4" },
                            ],
                        },
                        { name: "minWidth", type: "number", label: "Min tile width (px)", default: 320, hidden: 'data.columns !== "auto"' },
                        { name: "hideOffline", type: "checkbox", label: "Hide offline cameras", default: false },
                        { name: "showControls", type: "checkbox", label: "Show per-tile controls", default: true },
                        // W4c: go2rtc config for expanded overlay live stream
                        {
                            name: "go2rtcUrl",
                            type: "text",
                            label: "go2rtc base URL (for expanded overlay)",
                            tooltip: "e.g. http://192.168.1.50:1984 — enables WebRTC/HLS in the click-to-expand overlay. Leave empty to keep snapshot-only.",
                            default: "",
                        },
                        {
                            name: "go2rtcSrc",
                            type: "text",
                            label: "go2rtc stream name override",
                            tooltip: "Optional fixed go2rtc source name used for ALL expanded cameras. Leave empty (recommended for multi-camera setups) to use each camera's own name.",
                            default: "",
                        },
                        { name: "noCard", type: "checkbox", label: "Without card" },
                        { name: "widgetTitle", type: "text", label: "Name", hidden: "!!data.noCard" },
                    ],
                },
            ],
            visDefaultStyle: { width: "100%", height: 480, position: "relative" },
            visPrev: "widgets/bosch-smart-home-camera/img/prev_bosch_overview.png",
        };
    }

    getWidgetInfo() {
        return BoschOverview.getWidgetInfo();
    }

    dp(camId, field) {
        return `bosch-smart-home-camera.${this.instance}.cameras.${camId}.${field}`;
    }

    dpInfo(field) {
        return `bosch-smart-home-camera.${this.instance}.${field}`;
    }

    async componentDidMount() {
        super.componentDidMount();
        this._mounted = true;
        await this.discover();
    }

    componentWillUnmount() {
        super.componentWillUnmount();
        this._mounted = false;
        // W4c: tear down any live stream on unmount
        this._stopExpandStream();
        this.teardown();
    }

    async onRxDataChanged() {
        this._stopExpandStream();
        this.teardown();
        await this.discover();
    }

    teardown() {
        if (this.expandTimer) {
            clearInterval(this.expandTimer);
            this.expandTimer = null;
        }
        for (const s of this.subs) {
            this.props.context.socket.unsubscribeState(s.id, s.cb);
        }
        this.subs = [];
    }

    async discover() {
        this.instance = String(parseInt(this.state.rxData.instance, 10) || 0);
        const prefix = `bosch-smart-home-camera.${this.instance}.cameras.`;
        let camIds = [];
        try {
            const view = await this.props.context.socket.getObjectViewSystem("channel", prefix, `${prefix}香`);
            const ids = new Set();
            for (const id of Object.keys(view || {})) {
                const rest = id.slice(prefix.length);
                if (rest && rest.indexOf(".") === -1) ids.add(rest);
            }
            camIds = Array.from(ids);
        } catch {
            camIds = [];
        }
        if (!this._mounted) return; // unmounted while the object view was in flight
        this.setState({ order: camIds });

        // W4a: subscribe to adapter-level maintenance DPs (one banner for the whole overview)
        this._subInfo("info.maintenance.state", v => this._mounted && this.setState({ maintState: v || "none" }));
        this._subInfo("info.maintenance.title", v => this._mounted && this.setState({ maintTitle: v || "" }));

        for (const camId of camIds) {
            this._sub(camId, "name", v => this._patch(camId, { name: v || "" }));
            this._sub(camId, "online", v => this._patch(camId, { online: !!v }));
            this._sub(camId, "privacy_enabled", v => this._patch(camId, { privacy: !!v }));
            this._sub(camId, "motion_active", v => this._patch(camId, { motion: !!v }));
            this._sub(camId, "snapshot_url", v => this._patch(camId, { snapshotUrl: v || "" }));
            // W4b: last-event timestamp + type per camera
            this._sub(camId, "last_motion_at", v => this._patch(camId, { lastEventAt: v || "" }));
            this._sub(camId, "last_motion_event_type", v => this._patch(camId, { lastEventType: v || "" }));
            this._subIf(camId, "front_light_enabled", v => this._patch(camId, { light: !!v, lightAvail: true }));
        }
    }

    // Subscribe to an adapter-level (non-camera) DP.
    _subInfo(dpPath, apply) {
        const id = this.dpInfo(dpPath);
        const cb = (sid, state) => {
            if (state) apply(state.val);
        };
        this.props.context.socket
            .getState(id)
            .then(st => st && cb(id, st))
            .catch(() => {});
        this.props.context.socket.subscribeState(id, cb);
        this.subs.push({ id, cb });
    }

    _sub(camId, field, apply) {
        const id = this.dp(camId, field);
        const cb = (sid, state) => {
            if (state) apply(state.val);
        };
        this.props.context.socket
            .getState(id)
            .then(st => st && cb(id, st))
            .catch(() => {});
        this.props.context.socket.subscribeState(id, cb);
        this.subs.push({ id, cb });
    }

    _subIf(camId, field, apply) {
        const id = this.dp(camId, field);
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
    }

    _patch(camId, patch) {
        if (!this._mounted) return;
        // functional updater: many camera×field callbacks fire in one tick at
        // discovery — a plain spread of this.state would clobber sibling updates.
        this.setState(prev => ({
            cams: { ...prev.cams, [camId]: { ...(prev.cams[camId] || {}), ...patch } },
        }));
    }

    // sort: tier 0 = online & !privacy, tier 1 = online & privacy, tier 2 = offline; alphabetic within tier
    _sorted() {
        const cams = this.state.cams;
        let list = this.state.order.slice();
        if (this.state.rxData.hideOffline) {
            list = list.filter(id => cams[id] && cams[id].online);
        }
        const tier = id => {
            const c = cams[id] || {};
            if (c.online === false) return 2;
            return c.privacy ? 1 : 0;
        };
        return list.sort((a, b) => {
            const t = tier(a) - tier(b);
            if (t) return t;
            const na = (cams[a] && cams[a].name) || a;
            const nb = (cams[b] && cams[b].name) || b;
            return na.localeCompare(nb, "de");
        });
    }

    snapUrl(camId) {
        const c = this.state.cams[camId] || {};
        if (!c.snapshotUrl) return "";
        const sep = c.snapshotUrl.indexOf("?") === -1 ? "?" : "&";
        return `${c.snapshotUrl}${sep}t=${this._tick || ""}`;
    }

    togglePrivacy = (camId, e) => {
        e.stopPropagation();
        const c = this.state.cams[camId] || {};
        this.props.context.socket.setState(this.dp(camId, "privacy_enabled"), !c.privacy);
    };

    toggleLight = (camId, e) => {
        e.stopPropagation();
        const c = this.state.cams[camId] || {};
        if (!c.lightAvail || c.privacy) return;
        this.props.context.socket.setState(this.dp(camId, "front_light_enabled"), !c.light);
    };

    snapshot = (camId, e) => {
        e.stopPropagation();
        const c = this.state.cams[camId] || {};
        if (c.privacy) return;
        this.props.context.socket.setState(this.dp(camId, "snapshot_trigger"), true);
    };

    expand(camId) {
        // W4c: ALWAYS tear down any prior stream first — covers a same-camera
        // re-expand AND a camera switch. _stopExpandStream bumps the generation so
        // an in-flight _startExpandStream that lost the race aborts cleanly.
        this._stopExpandStream();
        this.setState({ expanded: camId, expandStreamError: false });
        // refresh the enlarged snapshot every 2s while open (fallback when no go2rtcUrl)
        this._tick = Date.now();
        if (this.expandTimer) clearInterval(this.expandTimer);
        this.expandTimer = setInterval(() => {
            this._tick = Date.now();
            this.forceUpdate();
        }, 2000);
        // W4c: start live stream if go2rtcUrl is configured
        const base = (this.state.rxData.go2rtcUrl || "").replace(/\/$/, "");
        if (base) {
            // defer one tick so the <video> ref is mounted in the portal
            setTimeout(() => this._startExpandStream(camId), 0);
        }
    }

    closeExpand = () => {
        if (this.expandTimer) {
            clearInterval(this.expandTimer);
            this.expandTimer = null;
        }
        // W4c: stop any live stream when overlay closes
        this._stopExpandStream();
        this.setState({ expanded: null });
    };

    // ── W4c: expand overlay stream lifecycle ─────────────────────────────────

    _stopExpandStream() {
        // Bump the generation so any in-flight _startExpandStream aborts and stops
        // its OWN local stream instead of orphaning it (rapid switch / re-expand).
        this._expandGen = (this._expandGen || 0) + 1;
        if (this.expandStream) {
            try {
                this.expandStream.stop();
            } catch {
                /* ignore */
            }
            this.expandStream = null;
        }
    }

    async _startExpandStream(camId) {
        if (!this._mounted) return;
        const base = (this.state.rxData.go2rtcUrl || "").replace(/\/$/, "");
        const c = this.state.cams[camId] || {};
        const srcPrefix = (this.state.rxData.go2rtcSrc || "").trim();
        const src = srcPrefix || c.name || camId;
        if (!base || !src) return;

        // Generation token: this start owns `gen`. Any _stopExpandStream() (close,
        // switch, unmount) or a newer _startExpandStream bumps _expandGen, so a
        // start that lost the race tears down ITS local stream rather than leaving
        // a second Go2rtcStream running (the camera allows only ~3 sessions).
        const gen = (this._expandGen = (this._expandGen || 0) + 1);
        const stream = new Go2rtcStream({
            baseUrl: base,
            src,
            onPhase: () => {},
            onError: () => this._mounted && this.setState({ expandStreamError: true }),
        });

        // Wait one tick for the portal <video> to mount.
        await new Promise(r => setTimeout(r, 0));
        const video = this.videoRef.current;
        if (gen !== this._expandGen || !this._mounted || this.state.expanded !== camId || !video) {
            try {
                stream.stop();
            } catch {
                /* ignore */
            }
            return;
        }
        this.expandStream = stream;
        try {
            await stream.start(video, { wantAudio: false, armed: false });
        } catch {
            try {
                stream.stop();
            } catch {
                /* ignore */
            }
            if (this.expandStream === stream) this.expandStream = null;
            if (this._mounted && gen === this._expandGen) this.setState({ expandStreamError: true });
            return;
        }
        // Won the start but a stop/switch happened while awaiting → tear ours down.
        if (gen !== this._expandGen || !this._mounted || this.state.expanded !== camId) {
            try {
                stream.stop();
            } catch {
                /* ignore */
            }
            if (this.expandStream === stream) this.expandStream = null;
        }
    }

    // ── W4a: maintenance banner ───────────────────────────────────────────────

    renderMaintBanner() {
        if (!shouldShowMaintBanner(this.state.maintState, this.state.maintDismissed)) return null;
        const m = this.state.maintState;
        // Use title if available, otherwise fall back to generic text (mirrors BoschCamera pattern)
        const txt = this.state.maintTitle
            ? this.state.maintTitle
            : m === "active"
            ? Generic.t("Bosch cloud maintenance active")
            : Generic.t("Bosch cloud maintenance scheduled");
        return (
            <div style={styles.maintBanner} className="maintenance-banner">
                {txt}
                <span
                    role="button"
                    aria-label={Generic.t("Dismiss")}
                    title={Generic.t("Dismiss")}
                    onClick={() => this.setState({ maintDismissed: m })}
                    style={styles.maintDismiss}
                >
                    ×
                </span>
            </div>
        );
    }

    renderCell(camId) {
        const c = this.state.cams[camId] || {};
        const showControls = this.state.rxData.showControls !== false;
        const offline = c.online === false;

        // W4b: last-event label for privacy tiles
        const lastEvtLabel = formatLastEventLabel(c.lastEventAt, c.lastEventType, k => Generic.t(k));

        return (
            <div key={camId} style={styles.cell} onClick={() => this.expand(camId)}>
                {offline ? (
                    <div style={styles.offline}>
                        <VideocamOff style={{ fontSize: 38, opacity: 0.7 }} />
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#9a9aa8" }}>{c.name || ""}</div>
                        <div style={{ fontSize: 11, letterSpacing: 1, textTransform: "uppercase" }}>{Generic.t("Offline")}</div>
                    </div>
                ) : c.privacy ? (
                    <div style={{ ...styles.offline, background: "radial-gradient(circle at 50% 40%, #20203a, #0b0b10)" }}>
                        <VisibilityOff style={{ fontSize: 38, color: "#8a8ad0", opacity: 0.85 }} />
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#9a9aa8" }}>{c.name || ""}</div>
                        <div style={{ fontSize: 11, letterSpacing: 1, textTransform: "uppercase", color: "#8a8ad0" }}>{Generic.t("Privacy mode")}</div>
                        {/* W4b: last-event timestamp on privacy tile */}
                        {lastEvtLabel ? (
                            <div className="privacy-badge" style={{ fontSize: 11, fontWeight: 500, color: "rgba(138,138,208,.8)" }}>
                                {Generic.t("Last event")}: {lastEvtLabel}
                            </div>
                        ) : null}
                    </div>
                ) : c.snapshotUrl ? (
                    <img style={styles.img} src={this.snapUrl(camId)} alt={c.name || ""} />
                ) : (
                    <div style={styles.offline}>
                        <CameraAlt style={{ fontSize: 34, opacity: 0.5 }} />
                    </div>
                )}

                <div style={styles.top}>
                    <span style={styles.name}>{c.name || ""}</span>
                    <span style={styles.badges}>
                        {c.privacy ? null : c.online === true ? (
                            <span style={{ ...styles.badge, background: "rgba(34,197,94,.85)" }}>
                                <FiberManualRecord style={{ fontSize: 8 }} />
                                {Generic.t("Online")}
                            </span>
                        ) : c.online === false ? (
                            <span style={{ ...styles.badge, background: "rgba(239,68,68,.85)" }}>
                                <FiberManualRecord style={{ fontSize: 8 }} />
                                {Generic.t("Offline")}
                            </span>
                        ) : null}
                        {c.motion ? <span style={{ ...styles.badge, background: "rgba(245,158,11,.9)" }}>{Generic.t("Motion")}</span> : null}
                        {c.privacy ? <span style={{ ...styles.badge, background: "rgba(99,102,241,.9)" }}>{Generic.t("Privacy")}</span> : null}
                        {/* W4b: last-event badge on non-privacy online tiles */}
                        {!c.privacy && lastEvtLabel ? (
                            <span className="last-event-badge" style={{ ...styles.badge, background: "rgba(60,60,67,.75)" }}>
                                {lastEvtLabel}
                            </span>
                        ) : null}
                    </span>
                </div>

                {showControls && !offline ? (
                    <div style={styles.pill} onClick={e => e.stopPropagation()}>
                        <Tooltip title={Generic.t("Privacy")}>
                            <IconButton size="small" sx={styles.pillBtn} onClick={e => this.togglePrivacy(camId, e)}>
                                {c.privacy ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
                            </IconButton>
                        </Tooltip>
                        {c.lightAvail ? (
                            <Tooltip title={Generic.t("Light")}>
                                <span>
                                    <IconButton size="small" sx={{ ...styles.pillBtn, opacity: c.privacy ? 0.35 : 1 }} disabled={c.privacy} onClick={e => this.toggleLight(camId, e)}>
                                        {c.light ? <Lightbulb fontSize="small" /> : <LightbulbOutlined fontSize="small" />}
                                    </IconButton>
                                </span>
                            </Tooltip>
                        ) : null}
                        <Tooltip title={Generic.t("Snapshot")}>
                            <span>
                                <IconButton size="small" sx={{ ...styles.pillBtn, opacity: c.privacy ? 0.35 : 1 }} disabled={c.privacy} onClick={e => this.snapshot(camId, e)}>
                                    <CameraAlt fontSize="small" />
                                </IconButton>
                            </span>
                        </Tooltip>
                    </div>
                ) : null}
            </div>
        );
    }

    renderExpanded() {
        const camId = this.state.expanded;
        if (!camId) return null;
        const c = this.state.cams[camId] || {};
        const hasGo2rtc = !!(this.state.rxData.go2rtcUrl || "").trim();

        const overlay = (
            <div style={styles.overlay} onClick={this.closeExpand}>
                {/* W4c: WebRTC/HLS <video> when go2rtc is configured AND healthy; on a
                    stream error fall back to the snapshot <img> (no black overlay). */}
                {hasGo2rtc && !this.state.expandStreamError ? (
                    <video
                        ref={this.videoRef}
                        style={styles.overlayVideo}
                        autoPlay
                        playsInline
                        muted
                        onClick={e => e.stopPropagation()}
                    />
                ) : c.snapshotUrl ? (
                    <img style={styles.overlayImg} src={this.snapUrl(camId)} alt={c.name || ""} onClick={e => e.stopPropagation()} />
                ) : (
                    <div style={{ color: "#9a9aa8" }}>{Generic.t("No snapshot URL — set snapshot_http_port in the adapter")}</div>
                )}
                <div style={{ color: "#fff", marginTop: 12, fontSize: 16, fontWeight: 600 }}>{c.name || ""}</div>
                <Tooltip title={Generic.t("Close")}>
                    <IconButton sx={styles.closeBtn} onClick={this.closeExpand}>
                        <Close />
                    </IconButton>
                </Tooltip>
            </div>
        );
        return ReactDOM.createPortal(overlay, document.body);
    }

    renderWidgetBody(props) {
        super.renderWidgetBody(props);

        const sorted = this._sorted();
        const cols = this.state.rxData.columns || "auto";
        const minW = parseInt(this.state.rxData.minWidth, 10) || 320;
        const gridTemplate =
            cols === "auto"
                ? `repeat(auto-fill, minmax(min(${minW}px, 100%), 1fr))`
                : `repeat(${cols}, minmax(0, 1fr))`;

        // W4a: banner sits ABOVE the grid (wrapper flex column)
        const banner = this.renderMaintBanner();

        let content;
        if (!sorted.length) {
            content = (
                <>
                    {banner}
                    <div style={styles.hint}>{Generic.t("No Bosch cameras found for this instance")}</div>
                </>
            );
        } else if (banner) {
            // Banner present → flex-column wrapper so the banner sits above the grid.
            content = (
                <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", boxSizing: "border-box" }}>
                    {banner}
                    <div style={{ ...styles.grid, gridTemplateColumns: gridTemplate, flex: "1 1 auto", minHeight: 0 }}>
                        {sorted.map(id => this.renderCell(id))}
                        {this.renderExpanded()}
                    </div>
                </div>
            );
        } else {
            // No active maintenance → original markup unchanged (no layout shift).
            content = (
                <div style={{ ...styles.grid, gridTemplateColumns: gridTemplate }}>
                    {sorted.map(id => this.renderCell(id))}
                    {this.renderExpanded()}
                </div>
            );
        }

        if (this.state.rxData.noCard || props.widget.usedInWidget) return content;
        return this.wrapContent(content, null, { boxSizing: "border-box", height: "100%", padding: 4 });
    }
}

export default BoschOverview;
