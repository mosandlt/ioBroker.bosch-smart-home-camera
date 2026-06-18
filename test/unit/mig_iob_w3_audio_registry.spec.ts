/**
 * Item: iOB-W3 — Multi-instance audio registry: a second tile of the SAME camera
 * auto-mutes the first; DIFFERENT cameras stay independent (HA parity).
 * Migration-concept: port HA card `_boschAudioRegistry` (Map<entity_id, Set>).
 * Layer: widget (src-widgets/src/lib/audio-registry.js — extracted plain JS).
 *
 * These tests import the REAL registry module (not a re-implementation), so a
 * regression in the production register/unregister logic is actually caught.
 */

import { expect } from "chai";
// Real production module (plain JS, importable via ts-node — same as storage-keys).
import {
    audioRegistry,
    registerAudio,
    unregisterAudio,
} from "../../src-widgets/src/lib/audio-registry.js";

interface Stub {
    camId: string | null;
    audioOn: boolean;
    muteCalls: number;
    _audioRegisteredCamId?: string | null;
    _autoMuteAudio(): void;
}

const CAM_A = "11111111-2222-3333-4444-555555555555";
const CAM_B = "aabbccdd-0011-2233-4455-667788990011";

function makeStub(camId: string | null): Stub {
    return {
        camId,
        audioOn: false,
        muteCalls: 0,
        _audioRegisteredCamId: null,
        // Mirrors the real widget _autoMuteAudio: silence + deregister.
        _autoMuteAudio() {
            if (!this.audioOn) {
                return;
            }
            this.audioOn = false;
            this.muteCalls++;
            unregisterAudio(this);
        },
    };
}

describe("iOB-W3 — Audio registry (real module)", () => {
    beforeEach(() => audioRegistry.clear());

    it("single instance starting audio mutes nobody (no-op)", () => {
        const a = makeStub(CAM_A);
        a.audioOn = true;
        expect(registerAudio(a)).to.equal(false);
        expect(a.muteCalls).to.equal(0);
    });

    it("second tile of the SAME camera mutes the first; the new source stays on", () => {
        const a = makeStub(CAM_A);
        const b = makeStub(CAM_A);
        a.audioOn = true;
        registerAudio(a);
        b.audioOn = true;
        expect(registerAudio(b)).to.equal(true);
        expect(a.muteCalls).to.equal(1);
        expect(a.audioOn).to.equal(false);
        expect(b.muteCalls).to.equal(0);
        expect(b.audioOn).to.equal(true);
    });

    it("DIFFERENT cameras are independent — unmuting B does NOT mute A (HA parity)", () => {
        const a = makeStub(CAM_A);
        const b = makeStub(CAM_B);
        a.audioOn = true;
        registerAudio(a);
        b.audioOn = true;
        expect(registerAudio(b)).to.equal(false, "different camera → no sibling to mute");
        expect(a.muteCalls).to.equal(0, "camera A must keep playing");
        expect(a.audioOn).to.equal(true);
        expect(b.audioOn).to.equal(true);
    });

    it("unregister removes the instance and prunes the empty camera group", () => {
        const a = makeStub(CAM_A);
        a.audioOn = true;
        registerAudio(a);
        expect(audioRegistry.get(CAM_A)?.size).to.equal(1);
        unregisterAudio(a);
        expect(audioRegistry.has(CAM_A)).to.equal(false);
    });

    it("unregister targets the group captured at register time (survives a camId change)", () => {
        const a = makeStub(CAM_A);
        a.audioOn = true;
        registerAudio(a);
        a.camId = CAM_B; // widget reconfigured AFTER registering
        unregisterAudio(a);
        expect(audioRegistry.has(CAM_A), "still removed from its original group").to.equal(false);
    });

    it("after the first tile stops, a later same-camera tile mutes nobody", () => {
        const a = makeStub(CAM_A);
        const b = makeStub(CAM_A);
        a.audioOn = true;
        registerAudio(a);
        unregisterAudio(a); // explicit mute / unmount
        b.audioOn = true;
        expect(registerAudio(b)).to.equal(false);
        expect(a.muteCalls).to.equal(0);
    });

    it("null camId instances share the shared-key group consistently", () => {
        const a = makeStub(null);
        const b = makeStub(null);
        a.audioOn = true;
        registerAudio(a);
        b.audioOn = true;
        expect(registerAudio(b)).to.equal(true, "null-camId instances coalesce into one group");
        expect(a.muteCalls).to.equal(1);
    });
});
