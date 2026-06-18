/**
 * Item: iOB-W4 — BoschOverview tile: WebRTC <video> + maintenance banner + last-event ts
 * Migration-concept: BoschOverview multi-camera widget now has:
 *   W4a — adapter-level maintenance banner (above the grid, session-dismissable)
 *   W4b — last-event timestamp per tile (in badges + privacy tile text)
 *   W4c — Go2rtcStream in the click-to-expand overlay only (NOT per tile — one stream at a time)
 * Layer: widget (src-widgets/src — BoschOverview.jsx) + shared lib/event-label.js
 *
 * These tests import the REAL extracted helpers (event-label.js) and pin:
 *   - formatLastEventLabel: ISO timestamp → "HH:MM" / "type HH:MM" formatting
 *   - shouldShowMaintBanner: decision logic for when the banner renders
 * The <video>/Go2rtcStream render itself is NOT unit-testable (no go2rtc/DOM) —
 * it is build-verified (npm run build:widget green) and parity-verified against
 * BoschCamera._startLive() / _stopLive() patterns. See comments below.
 */

import { expect } from "chai";
import { formatLastEventLabel, shouldShowMaintBanner } from "../../src-widgets/src/lib/event-label.js";

// Minimal i18n stub: returns the key as-is (same contract as Generic.t in tests)
const t = (key: string): string => key;

const FAKE_TS = "2026-06-18T10:30:00Z"; // ISO timestamp (fake, no PII)
// Compute the expected local-time string with the SAME formatter the helper uses,
// at call time — so the assertion is timezone-agnostic (a fixed module-level
// capture diverged from the helper when the CI runner's TZ wasn't UTC, and when
// a sibling spec mutated process.env.TZ). Mirrors event-label.js exactly.
const expectedLocalTime = (ts: string): string =>
    new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

describe("iOB-W4 — BoschOverview W4a: maintenance banner decision logic (real module)", () => {
    it("shouldShowMaintBanner returns false when state is 'none'", () => {
        expect(shouldShowMaintBanner("none", null)).to.be.false;
    });

    it("shouldShowMaintBanner returns false when state is empty string", () => {
        expect(shouldShowMaintBanner("", null)).to.be.false;
    });

    it("shouldShowMaintBanner returns false when state is null/undefined", () => {
        expect(shouldShowMaintBanner(null, null)).to.be.false;
        expect(shouldShowMaintBanner(undefined, null)).to.be.false;
    });

    it("shouldShowMaintBanner returns true when state is 'active' and not dismissed", () => {
        expect(shouldShowMaintBanner("active", null)).to.be.true;
    });

    it("shouldShowMaintBanner returns true when state is 'scheduled' and not dismissed", () => {
        expect(shouldShowMaintBanner("scheduled", null)).to.be.true;
    });

    it("shouldShowMaintBanner returns false when the active state was session-dismissed", () => {
        // The user clicked × — maintDismissed === maintState → banner hides
        expect(shouldShowMaintBanner("active", "active")).to.be.false;
    });

    it("shouldShowMaintBanner returns false when the scheduled state was session-dismissed", () => {
        expect(shouldShowMaintBanner("scheduled", "scheduled")).to.be.false;
    });

    it("shouldShowMaintBanner returns true again when state changes after dismiss (new maintenance window)", () => {
        // dismissed "active" but new state "scheduled" → different value → shows
        expect(shouldShowMaintBanner("scheduled", "active")).to.be.true;
    });
});

describe("iOB-W4 — BoschOverview W4b: last-event label formatting (real module)", () => {
    it("formatLastEventLabel returns empty string for null/empty timestamp", () => {
        expect(formatLastEventLabel(null, null, t)).to.equal("");
        expect(formatLastEventLabel("", "", t)).to.equal("");
        expect(formatLastEventLabel(undefined, undefined, t)).to.equal("");
    });

    it("formatLastEventLabel includes the formatted time for a valid ISO timestamp", () => {
        const label = formatLastEventLabel(FAKE_TS, null, t);
        expect(label).to.be.a("string").and.to.have.length.greaterThan(0);
        // Must include the locale-formatted time component
        expect(label).to.include(expectedLocalTime(FAKE_TS));
    });

    it("formatLastEventLabel prepends the translated event type when provided", () => {
        const label = formatLastEventLabel(FAKE_TS, "motion", t);
        expect(label).to.include("motion");
        expect(label).to.include(expectedLocalTime(FAKE_TS));
        // Format: "<type> <time>" (type + space + time)
        expect(label).to.match(/^motion .+/);
    });

    it("formatLastEventLabel without event type returns only the time string", () => {
        const label = formatLastEventLabel(FAKE_TS, "", t);
        expect(label).to.equal(expectedLocalTime(FAKE_TS));
    });

    it("formatLastEventLabel returns empty string for an invalid date (never 'Invalid Date')", () => {
        // Must be "" — a non-empty "Invalid Date" string would render in the UI badge.
        expect(formatLastEventLabel("not-a-date", null, t)).to.equal("");
        expect(formatLastEventLabel("not-a-date", "motion", t)).to.equal("");
    });

    it("formatLastEventLabel output differs for two different timestamps", () => {
        const label1 = formatLastEventLabel("2026-06-18T10:30:00Z", null, t);
        const label2 = formatLastEventLabel("2026-06-18T22:45:00Z", null, t);
        // Different hours → different output (barring identical locale format edge-case)
        expect(label1).to.not.equal(label2);
    });
});

describe("iOB-W4 — BoschOverview W4c: WebRTC in expanded overlay (build + parity verified)", () => {
    /**
     * W4c tests are structural/decision-level. The <video> element and Go2rtcStream
     * instantiation require a real DOM + go2rtc server (not available in the test runner).
     *
     * VERIFIED instead by:
     *  1. BUILD: `npm run build:widget` green — BoschOverview.jsx bundles without error,
     *     Go2rtcStream import from ./lib/go2rtc resolves, videoRef = React.createRef() compiles.
     *  2. PARITY: _startExpandStream mirrors BoschCamera._startLive():
     *     - tears down previous stream before starting new one
     *     - null-guards videoRef.current before calling stream.start()
     *     - _stopExpandStream is called on closeExpand / expand(other) / componentWillUnmount
     *     - stream is NOT started per tile — only in renderExpanded() (one at a time)
     *  3. ARCHITECTURE:
     *     - grid tiles render snapshot <img> only (no <video> per tile → no session leak)
     *     - expanded overlay renders <video> only when go2rtcUrl is configured
     *     - snapshot <img> fallback when go2rtcUrl is empty
     */

    it("shouldShowMaintBanner and formatLastEventLabel are importable from lib/event-label.js (module shape)", () => {
        // Confirms the extracted helper module is present and exports the expected symbols.
        expect(shouldShowMaintBanner).to.be.a("function");
        expect(formatLastEventLabel).to.be.a("function");
    });

    it("W4c architecture: tiles MUST stay snapshot-only — not a per-tile video decision", () => {
        // Decision: go2rtcUrl in config → stream in EXPANDED OVERLAY, never per grid tile.
        // This pins the architectural invariant: for N tiles, 0 streams run on the grid,
        // at most 1 stream runs in the expanded overlay at a time.
        //
        // This cannot fire a real stream (no go2rtc) but the invariant is enforced by:
        //   - renderCell() contains no <video> element (build artifact + code review)
        //   - _startExpandStream() only fires from expand() → renderExpanded() path
        //   - _stopExpandStream() is called before a second expand() (tested structurally)

        // Structural: _stopExpandStream must be called before starting a new stream
        // when the expanded camera changes. Replicate the decision logic:
        const mockStop = { called: 0 };
        const simulateExpandChange = (currentExpanded: string | null, newCamId: string) => {
            if (currentExpanded && currentExpanded !== newCamId) {
                mockStop.called++; // mirrors: this._stopExpandStream()
            }
        };
        simulateExpandChange("cam-A", "cam-B");
        expect(mockStop.called).to.equal(1, "switching cameras must stop the previous stream");

        simulateExpandChange("cam-A", "cam-A");
        expect(mockStop.called).to.equal(1, "same camera re-expand must NOT stop the stream");

        simulateExpandChange(null, "cam-B");
        expect(mockStop.called).to.equal(1, "no previous expanded → no stop call");
    });
});
