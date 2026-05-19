/**
 * Telegram Bot Snapshot Command
 * ==============================
 * Subscribes to inbound Telegram messages. If the user sends `/snap` or
 * `/snap <cameraName>`, a fresh snapshot is requested from the matching
 * Bosch camera and the image file path is sent back as a photo.
 *
 * Commands:
 *   /snap              — snapshot from the first available camera
 *   /snap Terrasse     — snapshot from camera whose name matches "Terrasse"
 *                        (case-insensitive, partial match)
 *
 * If the camera name is not found, the bot replies with a list of all
 * available camera names.
 *
 * Requirements:
 *   - iobroker.telegram adapter installed and configured
 *     (npm: iobroker.telegram, https://github.com/iobroker-community-adapters/ioBroker.telegram)
 *   - Telegram adapter instance: telegram.0 (adjust below if different)
 *
 * Setup:
 *   1. Set TELEGRAM_INSTANCE to your telegram adapter instance if not .0.
 *   2. The script resolves camera names at runtime — no IDs to hardcode.
 *   3. Save + Run.
 */
'use strict';

const TELEGRAM_INSTANCE = 'telegram.0';
const SNAPSHOT_GRACE_MS = 2000;

on({ id: `${TELEGRAM_INSTANCE}.communicate.request`, change: 'any' }, (obj) => {
    const raw = obj.state && obj.state.val;
    if (!raw) return;

    // Telegram adapter sets val as JSON string: { message: { text, from: { id } } }
    let parsed;
    try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (_) {
        return;
    }

    const text = (parsed.message && parsed.message.text) || '';
    const chatId = parsed.message && parsed.message.from && parsed.message.from.id;
    if (!text.startsWith('/snap')) return;

    const arg = text.replace('/snap', '').trim().toLowerCase();

    // Collect all camera roots and names
    const cameras = [];
    $('state[id=bosch-smart-home-camera.0.cameras.*.name]').each((nameId) => {
        const nameState = getState(nameId);
        if (!nameState) return;
        const camRoot = nameId.slice(0, nameId.lastIndexOf('.'));
        cameras.push({ root: camRoot, name: String(nameState.val) });
    });

    if (cameras.length === 0) {
        sendTo(TELEGRAM_INSTANCE, { text: 'Keine Bosch-Kamera gefunden.', user: chatId });
        return;
    }

    let cam;
    if (arg === '') {
        cam = cameras[0];
    } else {
        cam = cameras.find((c) => c.name.toLowerCase().includes(arg));
    }

    if (!cam) {
        const names = cameras.map((c) => c.name).join(', ');
        sendTo(TELEGRAM_INSTANCE, {
            text: `Kamera "${arg}" nicht gefunden. Verfügbar: ${names}`,
            user: chatId,
        });
        return;
    }

    log(`Telegram /snap → ${cam.name}`, 'info');
    setState(`${cam.root}.snapshot_trigger`, true, false);

    setTimeout(() => {
        const pathState = getState(`${cam.root}.snapshot_path`);
        if (!pathState || !pathState.val) {
            sendTo(TELEGRAM_INSTANCE, { text: `Snapshot für ${cam.name} nicht verfügbar.`, user: chatId });
            return;
        }
        sendTo(TELEGRAM_INSTANCE, { text: pathState.val, type: 'photo', user: chatId });
    }, SNAPSHOT_GRACE_MS);
});
