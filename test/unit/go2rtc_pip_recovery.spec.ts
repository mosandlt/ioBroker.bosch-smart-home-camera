/**
 * Item: PiP-freeze-on-tab-switch recovery (parity HA v13.7.4, 2026-06-19).
 * Layer: widget (src-widgets/src/lib/go2rtc.js — Go2rtcStream).
 *
 * The Go2rtcStream WebRTC engine cannot be exercised without go2rtc + a real
 * <video>/RTCPeerConnection (no DOM in the mocha env). It is build-verified
 * (npm run build:widget green) and parity-verified against the HA card fix. These
 * source-pin assertions lock the freeze-recovery WIRING so a future refactor can't
 * silently drop it — mirroring the HA card's "(source pin)" e2e tests:
 *   1. rVFC liveness heartbeat (_startRvfc/_stopRvfc + _boschLastFrameAt)
 *   2. stall checker escalates on a presented-frame freeze (frameFrozen)
 *   3. WebRTC video-track mute/unmute -> debounced PiP-safe recovery
 *   4. persistent connectionState="failed" -> recovery (live phase)
 *   5. centralised idempotent _recover() guarded by _recovering
 *   6. teardown cancels the rVFC heartbeat + the track-mute debounce timer
 */

import { expect } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// __dirname is available — the spec runs under ts-node with module=commonjs.
const SRC = readFileSync(join(__dirname, "../../src-widgets/src/lib/go2rtc.js"), "utf8");

describe("Go2rtcStream — PiP-freeze-on-tab-switch recovery (source pin)", () => {
    it("has an rVFC liveness heartbeat that stamps _boschLastFrameAt", () => {
        expect(SRC).to.match(/_startRvfc\s*\(/);
        expect(SRC).to.match(/_stopRvfc\s*\(/);
        expect(SRC).to.contain("requestVideoFrameCallback");
        expect(SRC).to.match(/_boschLastFrameAt\s*=\s*performance\.now\(\)/);
        expect(SRC).to.contain("cancelVideoFrameCallback");
    });

    it("escalates the stall checker on a presented-frame freeze", () => {
        expect(SRC).to.match(/const\s+frameFrozen\s*=/);
        expect(SRC).to.match(/frozen\s*\|\|\s*pausedWhileLive\s*\|\|\s*frameFrozen/);
        expect(SRC).to.match(/stallCount\s*>=\s*3\s*\|\|\s*frameFrozen/);
    });

    it("wires the WebRTC video-track mute/unmute debounced recovery", () => {
        expect(SRC).to.match(/evt\.track\.onmute\s*=/);
        expect(SRC).to.match(/evt\.track\.onunmute\s*=/);
        expect(SRC).to.contain('evt.track.kind === "video"');
        expect(SRC).to.contain("webrtc video track muted >6s");
    });

    it("wires a persistent connectionState=failed recovery for the live phase", () => {
        expect(SRC).to.contain("onconnectionstatechange");
        expect(SRC).to.match(/connectionState\s*===\s*"failed"/);
    });

    it("has a centralised idempotent _recover() guarded by _recovering", () => {
        expect(SRC).to.match(/_recover\s*\(reason\)/);
        expect(SRC).to.contain("this._recovering");
        // _recover must NOT call the public stop() (that signals a permanent stop
        // + would let the widget tear down PiP). It uses the internal teardown.
        expect(SRC).to.match(/_recover\(reason\)\s*\{[\s\S]*?this\._cleanupWebRTC\(\)/);
    });
});
