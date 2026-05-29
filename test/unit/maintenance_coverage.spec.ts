/**
 * Coverage gap tests for src/lib/maintenance.ts
 *
 * Targets the 30 previously-uncovered lines:
 *   161-166  berlinOffsetMinutes() catch block (Intl fallback)
 *   220-221  parseWindow() invalid month/day/hour guard
 *   232-233  parseWindow() Date.UTC catch (unreachable — c8 ignore)
 *   339-340  prefers() pub_date tie-break (same rank + same camera_relevant)
 *   400-401  itemsFromXml() Atom entry without title → continue
 *   433-434  extractXmlTag() tag not found → return ""  (private; exercised via itemsFromXml)
 *   459-460  parseFeedBody() item without title → continue
 *   554-556  fetchOne() catch block (network error / abort)
 *   581-586  fetchMaintenance() RSS path: parseFeedBody non-null + early return
 *   590-591  fetchMaintenance() HTML fallback path: fetchOne null → continue
 *   599-602  fetchMaintenance() HTML fallback path: parseHtmlFallback non-null → best update
 */

import { expect } from "chai";
import * as sinon from "sinon";

import {
    parseWindow,
    parseFeedBody,
    parseHtmlFallback,
    classifyState,
    prefers,
    fetchMaintenance,
    fetchOne,
    boardLabel,
    type MaintenanceWindow,
} from "../../src/lib/maintenance";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeMw(overrides: Partial<MaintenanceWindow> = {}): MaintenanceWindow {
    return {
        title: "x",
        link: "x",
        pub_date: new Date("2026-05-19T00:00:00Z").toISOString(),
        summary: "x",
        scheduled_start: null,
        scheduled_end: null,
        source: "rss:x",
        camera_relevant: false,
        ...overrides,
    };
}

// ── Lines 161-166: berlinOffsetMinutes() Intl catch fallback ──────────────────
//
// berlinOffsetMinutes() is private, but we exercise it through parseWindow().
// We force the catch path by temporarily replacing Intl.DateTimeFormat with a
// throwing stub; parseWindow() still produces a valid result via the month-based
// fallback (UTC+2 for April–October, UTC+1 otherwise).

describe("maintenance_coverage — berlinOffsetMinutes() Intl catch fallback (lines 161-166)", () => {
    let origDateTimeFormat: typeof Intl.DateTimeFormat;

    beforeEach(() => {
        origDateTimeFormat = Intl.DateTimeFormat;
    });

    afterEach(() => {
        // Restore
        (Intl as unknown as Record<string, unknown>).DateTimeFormat = origDateTimeFormat;
    });

    it("summer month (May) uses UTC+2 fallback when Intl throws", () => {
        // Make Intl.DateTimeFormat throw on construction
        (Intl as unknown as Record<string, unknown>).DateTimeFormat = function () {
            throw new Error("Intl disabled");
        };
        const pub = new Date("2026-05-18T10:00:00Z").toISOString();
        // 07:00 – 10:00 on 19.05.2026 with UTC+2 fallback → UTC 05:00 – 08:00
        const [start, end] = parseWindow("Wartung am 19.05.2026 von 07:00 bis 10:00 Uhr (MESZ)", pub);
        expect(start).not.to.be.null;
        expect(end).not.to.be.null;
        expect(new Date(start!).getUTCHours()).to.equal(5); // 07:00 - 2h = 05:00
        expect(new Date(end!).getUTCHours()).to.equal(8);   // 10:00 - 2h = 08:00
    });

    it("winter month (January) uses UTC+1 fallback when Intl throws", () => {
        (Intl as unknown as Record<string, unknown>).DateTimeFormat = function () {
            throw new Error("Intl disabled");
        };
        const pub = new Date("2026-01-10T10:00:00Z").toISOString();
        // 03:00 – 05:00 on 15.01.2026 with UTC+1 fallback → UTC 02:00 – 04:00
        const [start, end] = parseWindow("Wartung am 15.01.2026 von 03:00 bis 05:00 Uhr (MEZ)", pub);
        expect(start).not.to.be.null;
        expect(end).not.to.be.null;
        expect(new Date(start!).getUTCHours()).to.equal(2); // 03:00 - 1h = 02:00
        expect(new Date(end!).getUTCHours()).to.equal(4);   // 05:00 - 1h = 04:00
    });
});

// ── Lines 220-221: parseWindow() validation guard ────────────────────────────
//
// A regex match can still yield an invalid month (e.g. 0 or 13) if the source
// text contains something like "0.0.2026".  The guard on line 219 catches that.

describe("maintenance_coverage — parseWindow() invalid date/time guard (lines 220-221)", () => {
    const pub = new Date("2026-05-18T10:00:00Z").toISOString();

    it("invalid month 0 → returns [null, null]", () => {
        // DATE_RE matches "0.0.2026" giving mon=0
        const [s, e] = parseWindow("Wartung am 0.0.2026 von 07:00 bis 10:00 Uhr", pub);
        expect(s).to.be.null;
        expect(e).to.be.null;
    });

    it("invalid month 13 → returns [null, null]", () => {
        const [s, e] = parseWindow("Wartung am 01.13.2026 von 07:00 bis 10:00 Uhr", pub);
        expect(s).to.be.null;
        expect(e).to.be.null;
    });

    it("invalid day 0 → returns [null, null]", () => {
        const [s, e] = parseWindow("Wartung am 0.5.2026 von 07:00 bis 10:00 Uhr", pub);
        expect(s).to.be.null;
        expect(e).to.be.null;
    });

    it("invalid hour 24 → returns [null, null]", () => {
        // TIME_RANGE_RE can match 24:00 which is > 23
        const [s, e] = parseWindow("Wartung am 19.05.2026 von 24:00 bis 25:00 Uhr", pub);
        expect(s).to.be.null;
        expect(e).to.be.null;
    });

    it("invalid minute 60 → returns [null, null]", () => {
        const [s, e] = parseWindow("Wartung am 19.05.2026 von 07:60 bis 10:60 Uhr", pub);
        expect(s).to.be.null;
        expect(e).to.be.null;
    });
});

// ── Lines 339-340: prefers() pub_date tie-break (same rank, same camera_relevant) ─

describe("maintenance_coverage — prefers() pub_date tie-break when rank and camera_relevant identical (lines 339-340)", () => {
    it("same rank (both recent) + same camera_relevant=false → newer pub_date wins", () => {
        const now = new Date("2026-05-19T12:00:00Z").getTime();
        // Both lack a scheduled window; pub_date < MAX_AGE → both "recent"
        const newer = makeMw({
            camera_relevant: false,
            pub_date: new Date("2026-05-19T10:00:00Z").toISOString(),
        });
        const older = makeMw({
            camera_relevant: false,
            pub_date: new Date("2026-05-18T10:00:00Z").toISOString(),
        });
        expect(classifyState(newer, now)).to.equal("recent");
        expect(classifyState(older, now)).to.equal("recent");
        expect(prefers(newer, older, now)).to.be.true;
        expect(prefers(older, newer, now)).to.be.false;
    });

    it("same rank (both recent) + same camera_relevant=true → newer pub_date wins", () => {
        const now = new Date("2026-05-19T12:00:00Z").getTime();
        const newer = makeMw({
            camera_relevant: true,
            pub_date: new Date("2026-05-19T11:00:00Z").toISOString(),
        });
        const older = makeMw({
            camera_relevant: true,
            pub_date: new Date("2026-05-17T11:00:00Z").toISOString(),
        });
        expect(prefers(newer, older, now)).to.be.true;
        expect(prefers(older, newer, now)).to.be.false;
    });
});

// ── Lines 400-401: itemsFromXml() Atom entry without title → continue ─────────
//
// Exercised via parseFeedBody which calls itemsFromXml internally.

describe("maintenance_coverage — Atom entry without title is skipped (lines 400-401)", () => {
    it("Atom feed with titleless entry followed by valid entry returns only valid entry", () => {
        const atom = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title></title>
    <link href="https://example/empty"/>
    <updated>2026-05-18T10:00:00Z</updated>
    <summary>No title here</summary>
  </entry>
  <entry>
    <title>Wartung Kamera am 20.05.2026 von 09:00 bis 10:00 Uhr (MESZ)</title>
    <link href="https://example/valid"/>
    <updated>2026-05-19T12:00:00Z</updated>
    <summary>Camera maintenance</summary>
  </entry>
</feed>`;
        const mw = parseFeedBody(atom, "https://x?board.id=Wartungsarbeiten");
        expect(mw).not.to.be.null;
        expect(mw!.title).to.include("Kamera");
        expect(mw!.link).to.equal("https://example/valid");
    });

    it("Atom feed with ONLY titleless entries returns null", () => {
        const atom = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <link href="https://example/x"/>
    <updated>2026-05-18T10:00:00Z</updated>
  </entry>
</feed>`;
        const mw = parseFeedBody(atom, "https://x?board.id=Wartungsarbeiten");
        expect(mw).to.be.null;
    });
});

// ── Lines 433-434: extractXmlTag() tag not found → "" ─────────────────────────
//
// extractXmlTag is private. We exercise the "" return via parseFeedBody:
// an RSS item that is missing <link> and <pubDate> tags yields empty strings
// for those fields, exercising the not-found branch.

describe("maintenance_coverage — extractXmlTag() returns empty string when tag absent (lines 433-434)", () => {
    it("RSS item with missing link and pubDate fields is still parsed (empty strings used)", () => {
        const rss = `<rss version="2.0"><channel>
  <item>
    <title>Kamera-Wartung ohne Link</title>
    <description>Videostream gewartet</description>
  </item>
</channel></rss>`;
        const mw = parseFeedBody(rss, "https://x?board.id=Wartungsarbeiten");
        expect(mw).not.to.be.null;
        expect(mw!.title).to.equal("Kamera-Wartung ohne Link");
        expect(mw!.link).to.equal("");
    });
});

// ── Lines 459-460: parseFeedBody() item without raw.title → continue ──────────
//
// RSS items where the <title> tag is completely absent (extractXmlTag returns "").

describe("maintenance_coverage — parseFeedBody() skips items with empty title (lines 459-460)", () => {
    it("RSS item without <title> tag is skipped; subsequent valid item is returned", () => {
        const rss = `<rss version="2.0"><channel>
  <item>
    <description>No title item</description>
  </item>
  <item>
    <title>Kamera Infrastruktur Update</title>
    <pubDate>Mon, 18 May 2026 10:00:00 GMT</pubDate>
    <description>Videostream temporarily unavailable</description>
  </item>
</channel></rss>`;
        const mw = parseFeedBody(rss, "https://x?board.id=Statusmeldungen");
        expect(mw).not.to.be.null;
        expect(mw!.title).to.equal("Kamera Infrastruktur Update");
    });

    it("RSS feed with only untitled items returns null", () => {
        const rss = `<rss version="2.0"><channel>
  <item><description>No title at all</description></item>
</channel></rss>`;
        expect(parseFeedBody(rss, "https://x?board.id=x")).to.be.null;
    });
});

// ── Lines 554-556: fetchOne() catch block ─────────────────────────────────────
//
// fetchOne() catches network errors / abort signals and returns null.
// We stub the global fetch to throw.

describe("maintenance_coverage — fetchOne() catch path returns null (lines 554-556)", () => {
    let origFetch: typeof globalThis.fetch;

    beforeEach(() => {
        origFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = origFetch;
    });

    it("returns null when fetch throws a network error", async () => {
        globalThis.fetch = sinon.stub().rejects(new Error("ECONNREFUSED"));
        const result = await fetchOne("https://example.invalid/feed", 500);
        expect(result).to.be.null;
    });

    it("returns null when fetch is aborted (timeout)", async () => {
        // Simulate abort by having fetch reject with an AbortError
        const abortErr = new DOMException("The operation was aborted.", "AbortError");
        globalThis.fetch = sinon.stub().rejects(abortErr);
        const result = await fetchOne("https://example.invalid/feed", 100);
        expect(result).to.be.null;
    });

    it("returns null when HTTP status is non-200", async () => {
        globalThis.fetch = sinon.stub().resolves({
            status: 503,
            text: async () => "Service Unavailable",
        } as unknown as Response);
        const result = await fetchOne("https://example.invalid/feed", 1000);
        expect(result).to.be.null;
    });

    it("returns [200, body] on HTTP 200", async () => {
        globalThis.fetch = sinon.stub().resolves({
            status: 200,
            text: async () => "<rss/>",
        } as unknown as Response);
        const result = await fetchOne("https://example.invalid/feed", 1000);
        expect(result).not.to.be.null;
        expect(result![0]).to.equal(200);
        expect(result![1]).to.equal("<rss/>");
    });
});

// ── Lines 581-602: fetchMaintenance() RSS + HTML fallback paths ───────────────
//
// We stub the module-level fetchOne export via sinon on the imported namespace.

describe("maintenance_coverage — fetchMaintenance() full path coverage (lines 581-602)", () => {
    const RSS_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title>Kamera-Wartung 19.05.2026</title>
    <link>https://community.bosch-smarthome.com/t5/wartungsarbeiten/foo/ba-p/110703</link>
    <pubDate>Mon, 18 May 2026 10:06:13 GMT</pubDate>
    <description>Videostream von 07:00 bis 10:00 Uhr (MESZ)</description>
  </item>
</channel></rss>`;

    const HTML_BODY = `<html>
<head><meta name="description" content="Wartung Kamera am 19.05.2026 von 07:00 bis 10:00 Uhr (MESZ)"></head>
<body><a href="/t5/wartungsarbeiten/foo/ba-p/110703">Wartung Kamera</a></body>
</html>`;

    let origFetch: typeof globalThis.fetch;

    beforeEach(() => {
        origFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = origFetch;
    });

    it("RSS feed succeeds → returns parsed result immediately (lines 581-591)", async () => {
        // First RSS URL returns a valid feed; fetchMaintenance should return early.
        const stub = sinon.stub();
        // RSS_FEEDS[0] → success, all others → null
        stub.onFirstCall().resolves({
            status: 200,
            text: async () => RSS_BODY,
        } as unknown as Response);
        stub.resolves({
            status: 503,
            text: async () => "",
        } as unknown as Response);
        globalThis.fetch = stub;

        const mw = await fetchMaintenance(100);
        expect(mw).not.to.be.null;
        expect(mw!.camera_relevant).to.be.true;
        expect(mw!.source).to.match(/^rss:/);
    });

    it("all RSS feeds fail → HTML fallback first URL null → continue (lines 590-591)", async () => {
        // Both RSS calls fail (non-200); HTML_FALLBACKS[0] returns null (503),
        // HTML_FALLBACKS[1] returns a valid HTML page.
        const stub = sinon.stub();
        // Call order: RSS[0], RSS[1], HTML[0], HTML[1]
        stub.onCall(0).resolves({ status: 503, text: async () => "" } as unknown as Response); // RSS[0] fail
        stub.onCall(1).resolves({ status: 503, text: async () => "" } as unknown as Response); // RSS[1] fail
        stub.onCall(2).resolves({ status: 503, text: async () => "" } as unknown as Response); // HTML[0] fail (→ continue on 590-591)
        stub.onCall(3).resolves({
            status: 200,
            text: async () => HTML_BODY,
        } as unknown as Response); // HTML[1] success (→ lines 599-602)
        globalThis.fetch = stub;

        const mw = await fetchMaintenance(100);
        expect(mw).not.to.be.null;
        expect(mw!.source).to.match(/^html:/);
    });

    it("all RSS fail, HTML fallback first URL valid → best is updated (lines 599-602)", async () => {
        // Both RSS fail; HTML[0] succeeds, HTML[1] also succeeds but loses on prefers()
        const stub = sinon.stub();
        stub.onCall(0).resolves({ status: 503, text: async () => "" } as unknown as Response);
        stub.onCall(1).resolves({ status: 503, text: async () => "" } as unknown as Response);
        stub.onCall(2).resolves({
            status: 200,
            text: async () => HTML_BODY,
        } as unknown as Response);
        // HTML[1] also valid but will lose to HTML[0] in prefers() (same rank — prefers() returns true for newer)
        stub.onCall(3).resolves({
            status: 200,
            text: async () => HTML_BODY,
        } as unknown as Response);
        globalThis.fetch = stub;

        const mw = await fetchMaintenance(100);
        expect(mw).not.to.be.null;
        expect(mw!.source).to.match(/^html:/);
    });

    it("all sources fail → returns null", async () => {
        globalThis.fetch = sinon.stub().resolves({
            status: 503,
            text: async () => "",
        } as unknown as Response);

        const mw = await fetchMaintenance(100);
        expect(mw).to.be.null;
    });
});

// ── boardLabel() unknown URL → "unknown" ──────────────────────────────────────
// (Incidentally exercises the final return of boardLabel, already covered but
//  added for completeness.)

describe("maintenance_coverage — boardLabel() with unknown URL pattern", () => {
    it("URL with no board.id= and no /bg-p/ returns 'unknown'", () => {
        expect(boardLabel("https://example.com/some/other/path")).to.equal("unknown");
    });
});
