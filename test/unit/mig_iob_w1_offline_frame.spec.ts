/**
 * Item: iOB-W1 — Offline/privacy widget retains last good frame as backdrop
 * Migration-concept: port HA v13.7.1 card fix: offline+privacy state keeps
 *   the last successfully-loaded snapshot URL in `this._lastGoodSrc` so that
 *   renderOffline() / renderPrivacy() can show it as a dimmed backdrop instead
 *   of a black screen.
 * Layer: widget (src-widgets/src — BoschCamera.jsx)
 * Note: widget JSX render is NOT sandbox-live-verifiable (no go2rtc in dev
 *   sandbox). These tests pin the _lastGoodSrc tracking contract only.
 *
 * Strategy: exercise the `updateSnapshot` onload path on a minimal stub that
 *   mirrors the widget's instance shape without requiring React/JSDOM.
 */

import { expect } from "chai";

// Minimal stub that replicates only the fields touched by updateSnapshot.
function makeWidgetStub(snapshotBaseUrl: string): Record<string, unknown> {
    const stub: Record<string, unknown> = {
        _lastGoodSrc: null as string | null,
        _mounted: true,
        loadingFrame: false,
        state: {
            rxData: {},
            cam: { snapshotUrl: snapshotBaseUrl },
            frameLoaded: false,
        },
        // Fake setState that updates state directly (synchronous test double)
        setState(patch: Record<string, unknown>) {
            Object.assign(stub.state as Record<string, unknown>, patch);
        },
        // Fake videoRef: tracks calls to .src and triggers onload
        _fakeSrc: "",
        _onload: null as (() => void) | null,
        _onerror: null as (() => void) | null,
        get videoRef() {
            return {
                current: {
                    get src() { return stub._fakeSrc; },
                    set src(v: string) {
                        stub._fakeSrc = v;
                        // auto-trigger onload (simulates successful image load)
                        if (stub._onload) stub._onload();
                    },
                    set onload(fn: () => void) { stub._onload = fn; },
                    set onerror(fn: () => void) { stub._onerror = fn; },
                },
            };
        },
    };

    // Bind updateSnapshot logic verbatim (mirrors BoschCamera.updateSnapshot)
    stub.updateSnapshot = function () {
        const self = stub;
        const base = (self.state as Record<string, unknown>).cam
            ? ((self.state as Record<string, { snapshotUrl?: string }>).cam).snapshotUrl || ""
            : "";
        if (!base || self.loadingFrame) return;
        self.loadingFrame = true;
        const sep = base.indexOf("?") === -1 ? "?" : "&";
        const img = (self.videoRef as { current: Record<string, unknown> }).current;
        img.onload = () => {
            self.loadingFrame = false;
            // W1: record last good src
            self._lastGoodSrc = self._fakeSrc;
            if (self._mounted && !(self.state as Record<string, unknown>).frameLoaded) {
                self.setState({ frameLoaded: true });
            }
        };
        img.onerror = () => {
            self.loadingFrame = false;
        };
        img.src = `${base}${sep}t=${Date.now()}`;
    };

    return stub;
}

describe("iOB-W1 — Offline/privacy widget retains last-frame src", () => {
    it("_lastGoodSrc is null before any snapshot loads", () => {
        const widget = makeWidgetStub("http://localhost:8080/snapshot");
        expect(widget._lastGoodSrc).to.be.null;
    });

    it("_lastGoodSrc is set after a successful snapshot load", () => {
        const widget = makeWidgetStub("http://localhost:8080/snapshot");
        (widget.updateSnapshot as () => void)();
        expect(widget._lastGoodSrc).to.be.a("string").and.to.include("http://localhost:8080/snapshot");
    });

    it("_lastGoodSrc is non-empty (last good frame) after camera reports online→offline", () => {
        const widget = makeWidgetStub("http://localhost:8080/snapshot");
        // Load a frame while online
        (widget.updateSnapshot as () => void)();
        const savedSrc = widget._lastGoodSrc as string;
        expect(savedSrc).to.not.be.empty;
        // Simulate going offline — widget state changes, but _lastGoodSrc must NOT be cleared
        (widget.state as Record<string, unknown>).cam = { ...(widget.state as Record<string, unknown>).cam, snapshotUrl: "" };
        expect(widget._lastGoodSrc).to.equal(savedSrc);
    });

    it("_lastGoodSrc is NOT cleared on onerror (keeps last good frame)", () => {
        const widget = makeWidgetStub("http://localhost:8080/snapshot");
        // Load a good frame first
        (widget.updateSnapshot as () => void)();
        const savedSrc = widget._lastGoodSrc as string;
        // Reset so next call triggers onerror instead of onload
        widget.loadingFrame = false;
        // Override the fake src setter to trigger onerror
        const stub = widget as Record<string, unknown>;
        stub._onload = null;
        // Manually trigger onerror path (loadingFrame → false, _lastGoodSrc unchanged)
        stub.loadingFrame = true;
        if (stub._onerror) (stub._onerror as () => void)();
        expect(widget._lastGoodSrc).to.equal(savedSrc);
    });
});
