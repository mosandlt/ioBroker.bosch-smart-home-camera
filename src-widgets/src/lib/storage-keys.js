// Per-camera localStorage key helpers (W2 fix).
// Extracted to a plain JS module so unit tests can import without JSX.
// Mirror: HA card `_cardVolKey()` / `_cardMuteKey()`.

// Shared fallback key (legacy — pre-W2).
export const VOL_KEY_SHARED = "bosch_card_volume";

// Per-camera volume localStorage key.
// Falls back to shared key when camId is null/undefined (init-time, camId not yet resolved).
// @param {string|null} camId
// @returns {string}
export function buildVolumeKey(camId) {
    return camId ? `bosch_card_volume_${camId}` : VOL_KEY_SHARED;
}

// Per-camera mute localStorage key.
// @param {string|null} camId
// @returns {string}
export function buildMuteKey(camId) {
    return camId ? `bosch_card_mute_${camId}` : "bosch_card_mute";
}
