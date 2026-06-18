/**
 * Item: iOB-W2 — Per-camera volume/mute localStorage key includes cam id
 * Migration-concept: port HA v13.7.0 "per-camera volume/mute localStorage keys"
 *   (was a shared key → two cameras sharing one mute state).
 * Layer: widget (src-widgets/src — BoschCamera.jsx / lib/storage-keys.js)
 * Soll-Assertion: the key used for localStorage volume/mute for camera
 *   `11111111-2222-3333-4444-555555555555` differs from the key for camera
 *   `AABBCCDD-0011-2233-4455-667788990011` — no shared single-key collision.
 *
 * Fake IDs: `11111111-2222-3333-4444-555555555555`, `AABBCCDD-0011-2233-4455-667788990011`
 */

import { expect } from "chai";
// Import from the plain-JS helper (no JSX — importable via ts-node).
import { buildVolumeKey, buildMuteKey } from "../../src-widgets/src/lib/storage-keys.js";

const CAM_A = "11111111-2222-3333-4444-555555555555";
const CAM_B = "AABBCCDD-0011-2233-4455-667788990011";

describe("iOB-W2 — Per-camera volume/mute localStorage keys are distinct", () => {
    it("volume localStorage key for cam A differs from key for cam B", () => {
        const keyA = buildVolumeKey(CAM_A);
        const keyB = buildVolumeKey(CAM_B);
        expect(keyA).to.include(CAM_A);
        expect(keyB).to.include(CAM_B);
        expect(keyA).to.not.equal(keyB);
    });

    it("mute localStorage key for cam A differs from key for cam B", () => {
        const keyA = buildMuteKey(CAM_A);
        const keyB = buildMuteKey(CAM_B);
        expect(keyA).to.include(CAM_A);
        expect(keyB).to.include(CAM_B);
        expect(keyA).to.not.equal(keyB);
    });

    it("volume key equals bosch_card_volume_<camId>", () => {
        const key = buildVolumeKey(CAM_A);
        expect(key).to.equal(`bosch_card_volume_${CAM_A}`);
    });

    it("mute key equals bosch_card_mute_<camId>", () => {
        const key = buildMuteKey(CAM_A);
        expect(key).to.equal(`bosch_card_mute_${CAM_A}`);
    });

    it("fallback (null camId) returns a non-empty shared key without 'null' literal", () => {
        const key = buildVolumeKey(null);
        expect(key).to.be.a("string").and.to.have.length.greaterThan(0);
        expect(key).to.not.include("null");
    });
});
