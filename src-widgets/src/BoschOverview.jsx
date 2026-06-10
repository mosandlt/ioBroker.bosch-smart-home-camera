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
    closeBtn: { position: "absolute", top: 14, right: 14, color: "#fff", background: "rgba(0,0,0,.5)", width: 46, height: 46 },
};

class BoschOverview extends Generic {
    constructor(props) {
        super(props);
        this.state.cams = {}; // camId -> {name,online,privacy,motion,light,lightAvail,snapshotUrl}
        this.state.order = []; // discovered camId order
        this.state.expanded = null; // camId in fullscreen
        this.instance = "0";
        this.subs = [];
        this.expandTimer = null;
        this._mounted = false;
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

    async componentDidMount() {
        super.componentDidMount();
        this._mounted = true;
        await this.discover();
    }

    componentWillUnmount() {
        super.componentWillUnmount();
        this._mounted = false;
        this.teardown();
    }

    async onRxDataChanged() {
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
            const view = await this.props.context.socket.getObjectViewSystem("channel", prefix, `${prefix}\u9999`);
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
        for (const camId of camIds) {
            this._sub(camId, "name", v => this._patch(camId, { name: v || "" }));
            this._sub(camId, "online", v => this._patch(camId, { online: !!v }));
            this._sub(camId, "privacy_enabled", v => this._patch(camId, { privacy: !!v }));
            this._sub(camId, "motion_active", v => this._patch(camId, { motion: !!v }));
            this._sub(camId, "snapshot_url", v => this._patch(camId, { snapshotUrl: v || "" }));
            this._subIf(camId, "front_light_enabled", v => this._patch(camId, { light: !!v, lightAvail: true }));
        }
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
        this.setState({ expanded: camId });
        // refresh the enlarged snapshot every 2s while open
        this._tick = Date.now();
        if (this.expandTimer) clearInterval(this.expandTimer);
        this.expandTimer = setInterval(() => {
            this._tick = Date.now();
            this.forceUpdate();
        }, 2000);
    }

    closeExpand = () => {
        if (this.expandTimer) {
            clearInterval(this.expandTimer);
            this.expandTimer = null;
        }
        this.setState({ expanded: null });
    };

    renderCell(camId) {
        const c = this.state.cams[camId] || {};
        const showControls = this.state.rxData.showControls !== false;
        const offline = c.online === false;
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
        const overlay = (
            <div style={styles.overlay} onClick={this.closeExpand}>
                {c.snapshotUrl ? (
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

        let content;
        if (!sorted.length) {
            content = <div style={styles.hint}>{Generic.t("No Bosch cameras found for this instance")}</div>;
        } else {
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
