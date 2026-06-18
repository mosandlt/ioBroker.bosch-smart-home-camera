// W3: per-camera audio registry (plain JS so unit tests import it without JSX/DOM).
//
// Multiple widget tiles of the SAME camera mute each other (avoid echoing the
// identical audio stream); DIFFERENT cameras stay independent. Mirrors the HA
// card's `_boschAudioRegistry` Map<entity_id, Set<card>> — a flat all-instances
// Set would wrongly mute camera A when the user unmutes camera B.
//
// An instance must expose `camId` (string|null) and an `_autoMuteAudio()` method.

export const audioRegistry = new Map(); // camId → Set<instance>

/**
 * Register `instance` as the active audio source for its camera. Every OTHER
 * instance of the SAME camera is auto-muted. Returns true if any sibling was
 * muted (i.e. this was not the only/first audio source for that camera).
 * @param {{camId?: string|null, _autoMuteAudio: () => void, _audioRegisteredCamId?: string|null}} instance
 * @returns {boolean}
 */
export function registerAudio(instance) {
    const key = instance.camId || "";
    instance._audioRegisteredCamId = key;
    let group = audioRegistry.get(key);
    if (!group) {
        group = new Set();
        audioRegistry.set(key, group);
    }
    let mutedOthers = false;
    for (const other of group) {
        if (other !== instance) {
            try {
                other._autoMuteAudio();
            } catch (_) {
                /* detached instance */
            }
            mutedOthers = true;
        }
    }
    group.add(instance);
    return mutedOthers;
}

/**
 * Remove `instance` from its camera's audio group (on explicit mute / unmount).
 * Uses the camId captured at register time so a later camId change can't strand
 * the instance in the wrong group.
 * @param {{_audioRegisteredCamId?: string|null}} instance
 */
export function unregisterAudio(instance) {
    const key = instance._audioRegisteredCamId;
    if (key == null) {
        return;
    }
    const group = audioRegistry.get(key);
    if (group) {
        group.delete(instance);
        if (!group.size) {
            audioRegistry.delete(key);
        }
    }
    instance._audioRegisteredCamId = null;
}
