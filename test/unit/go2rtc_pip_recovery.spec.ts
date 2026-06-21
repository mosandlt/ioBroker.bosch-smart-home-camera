/**
 * Item: PiP-freeze-on-tab-switch recovery (parity HA v13.7.4/v13.7.5, 2026-06-19/2026-06-21).
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
 *   7. background Web Worker heartbeat (_startLiveStallWorker / parity HA v13.7.5)
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
        // onFrame callback stamps performance.now() on every presented frame.
        expect(SRC).to.match(/_boschLastFrameAt\s*=\s*performance\.now\(\)/);
        expect(SRC).to.contain("cancelVideoFrameCallback");
    });

    it("seeds _boschLastFrameAt as null (not performance.now()) at rVFC start", () => {
        // Prevents a false-positive recovery loop when a reconnect takes >10 s to
        // produce its first presented frame (parity HA v13.7.5 2026-06-21).
        // The initial seed must be null so the != null guard holds until a real frame.
        expect(SRC).to.match(/videoEl\._boschLastFrameAt\s*=\s*null;[\s\S]*?const onFrame/);
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

describe("Go2rtcStream — background Web Worker heartbeat (source pin, parity HA v13.7.5)", () => {
    it("declares _stallWorker field in the constructor", () => {
        // Field must be initialised so _stopLiveStallWorker never throws on null check.
        expect(SRC).to.match(/this\._stallWorker\s*=\s*null/);
    });

    it("has _startLiveStallWorker() that spawns a Blob Worker with 5 s tick", () => {
        expect(SRC).to.match(/_startLiveStallWorker\s*\(\s*\)/);
        // Worker source: tick every 5000 ms.
        expect(SRC).to.contain("setInterval(function(){postMessage(0);},5000)");
        expect(SRC).to.contain("new Worker(url)");
        expect(SRC).to.match(/this\._stallWorker\.onmessage\s*=.*_liveStallTickFromWorker/);
    });

    it("has _stopLiveStallWorker() that terminates the Worker", () => {
        expect(SRC).to.match(/_stopLiveStallWorker\s*\(\s*\)/);
        expect(SRC).to.contain('this._stallWorker.postMessage("stop")');
        expect(SRC).to.contain("this._stallWorker.terminate()");
    });

    it("has _liveStallTickFromWorker() that only acts when tab hidden + ownsPip + frameFrozen", () => {
        expect(SRC).to.match(/_liveStallTickFromWorker\s*\(\s*\)/);
        // Only visible-tab guard: exits early when visible.
        expect(SRC).to.contain('document.visibilityState !== "hidden"');
        // Only fires when this instance owns the PiP window.
        expect(SRC).to.contain("document.pictureInPictureElement !== videoEl");
        // Detects frame freeze via _boschLastFrameAt.
        expect(SRC).to.match(/frameFrozen[\s\S]*?_recover\("no presented frame >10s \(bg worker\)"\)/);
    });

    it("starts the Worker inside _startStallChecker", () => {
        // Worker must be started whenever the stall checker starts.
        expect(SRC).to.match(/_startStallChecker\s*\(videoEl\)\s*\{[\s\S]*?_startLiveStallWorker/);
    });

    it("stops the Worker inside _stopStallChecker", () => {
        // Worker must be stopped whenever the stall checker stops (covers all teardown paths).
        expect(SRC).to.match(/_stopStallChecker\s*\(\s*\)\s*\{[\s\S]*?_stopLiveStallWorker/);
    });
});
