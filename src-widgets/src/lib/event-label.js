// W4b: last-event label formatter — extracted from BoschCamera._lastEventLabel()
// so both BoschCamera and BoschOverview share the identical formatting logic.
// Mirror: HA card _lastEventLabel() in bosch-camera-card.js.
//
// @param {string|null|undefined} lastEventAt  — ISO-8601 timestamp (or empty)
// @param {string|null|undefined} lastEventType — event type key (or empty)
// @param {(key: string) => string} t           — i18n translate function (Generic.t)
// @returns {string}
export function formatLastEventLabel(lastEventAt, lastEventType, t) {
    if (!lastEventAt) return "";
    try {
        const d = new Date(lastEventAt);
        if (isNaN(d.getTime())) return ""; // never surface "Invalid Date" in the UI
        const timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const type = lastEventType ? `${t(lastEventType)} ` : "";
        return `${type}${timeStr}`;
    } catch {
        return "";
    }
}

// Returns true when an instance-level maintenance state warrants showing a banner
// (state is non-empty, not "none", and not dismissed).
// @param {string|null|undefined} maintState
// @param {string|null|undefined} dismissedValue — value the user dismissed (from component state)
// @returns {boolean}
export function shouldShowMaintBanner(maintState, dismissedValue) {
    if (!maintState || maintState === "none") return false;
    if (dismissedValue === maintState) return false;
    return true;
}
