/**
 * Bosch Smart Home cloud maintenance / outage discovery.
 *
 * Bosch announces planned maintenance in the community board "Wartungsarbeiten"
 * and active incidents in "Statusmeldungen". Both boards expose RSS feeds; this
 * module fetches them, parses the latest items, and surfaces a single best-match
 * announcement so ioBroker state objects can show a specific reason when the
 * cloud returns 5xx.
 *
 * There is no machine-readable status API from Bosch — the iOS app reaches the
 * same conclusion by interpreting a 503 from /v11/video_inputs as maintenance.
 * The community RSS feeds are the only durable, public, structured channel.
 *
 * Failover layers:
 *   1. Try each known RSS feed URL in order; first 200 OK with parseable items wins.
 *   2. If every RSS URL fails (HTTP error, DNS, parse error), fall back to scraping
 *      the board's HTML landing page for embedded item metadata.
 *   3. If every fetch fails, return null — the caller keeps its previously cached
 *      value, so a transient outage of the community site does not destroy the
 *      status.
 *   4. Parsing tolerates RSS 2.0, Atom, and a minimal HTML extractor.
 *
 * Ported faithfully from the HA integration's maintenance.py.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

/** Boards Bosch uses for service status. Order = preference; first success wins. */
export const RSS_FEEDS: readonly string[] = [
    "https://community.bosch-smarthome.com/edswj98253/rss/board?board.id=Wartungsarbeiten",
    "https://community.bosch-smarthome.com/edswj98253/rss/board?board.id=Statusmeldungen",
];

export const HTML_FALLBACKS: readonly string[] = [
    "https://community.bosch-smarthome.com/t5/wartungsarbeiten/bg-p/Wartungsarbeiten",
    "https://community.bosch-smarthome.com/t5/statusmeldungen/bg-p/Statusmeldungen",
];

const BROWSER_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** Items older than MAX_AGE_MS are treated as historical context, never "scheduled". */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

// Date: 19.05.2026 / 19.5.2026 / 19. 5. 2026
const DATE_RE = /(\d{1,2})\.\s*(\d{1,2})\.\s*(20\d{2})/;

// Time range: "07:00 und 10:00 Uhr (MESZ)", "von 07:00 bis 10:00 Uhr", "07:00 – 10:00 Uhr"
const TIME_RANGE_RE =
    /(\d{1,2}):(\d{2})\s*(?:Uhr\s*)?(?:bis|und|–|-|—|to)\s*(\d{1,2}):(\d{2})\s*Uhr(?:\s*\(?(MESZ|MEZ|CEST|CET)\)?)?/i;

// Camera-relevant keywords (lower-case match against title + summary)
const CAMERA_KEYWORDS: readonly string[] = [
    "kamera",
    "kameras",
    "camera",
    "cameras",
    "video",
    "videos",
    "videostream",
    "stream",
    "cbs",
    "cloud",
    "backend",
    "infrastruktur",
];

// ── Types ─────────────────────────────────────────────────────────────────────

export type MaintenanceState =
    | "active"
    | "scheduled"
    | "past"
    | "recent"
    | "unknown"
    | "idle";

/** Parsed maintenance/incident announcement from a Bosch community feed. */
export interface MaintenanceWindow {
    title: string;
    link: string;
    /** ISO 8601 UTC string */
    pub_date: string;
    summary: string;
    /** ISO 8601 UTC string or null */
    scheduled_start: string | null;
    /** ISO 8601 UTC string or null */
    scheduled_end: string | null;
    source: string;
    camera_relevant: boolean;
}

// ── String helpers ────────────────────────────────────────────────────────────

/** Strip HTML tags and decode HTML entities. */
export function stripHtml(html: string): string {
    const noTags = html.replace(/<[^>]+>/g, " ");
    const decoded = noTags
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, " ");
    return decoded.replace(/\s+/g, " ").trim();
}

/** Return true if the combined title+summary contains a camera-relevant keyword. */
export function isCameraRelevant(title: string, summary: string): boolean {
    const haystack = `${title}\n${summary}`.toLowerCase();
    return CAMERA_KEYWORDS.some((kw) => haystack.includes(kw));
}

// ── Berlin timezone offset ────────────────────────────────────────────────────

/**
 * Determine the UTC offset (in minutes) for Europe/Berlin at a given date.
 * MESZ (CEST) = UTC+2 (late March to late October), MEZ (CET) = UTC+1 otherwise.
 *
 * Uses the ECMAScript Intl API to detect DST reliably without a TZ database dep.
 */
function berlinOffsetMinutes(year: number, month: number, day: number): number {
    try {
        // Create a UTC date at noon to avoid day-boundary edge cases
        const utcDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
        const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: "Europe/Berlin",
            hour: "numeric",
            hour12: false,
        });
        const parts = formatter.formatToParts(utcDate);
        const hourPart = parts.find((p) => p.type === "hour");
        const localHour = parseInt(hourPart?.value ?? "13", 10);
        // UTC noon → local hour; offset = localHour - 12
        return (localHour - 12) * 60;
    } catch {
        // Intl fallback: guess by month (summer = UTC+2, winter = UTC+1)
        if (month >= 4 && month <= 10) {
            return 120; // MESZ = UTC+2
        }
        return 60; // MEZ = UTC+1
    }
}

// ── Date/time parser ──────────────────────────────────────────────────────────

/**
 * Extract (start, end) ISO UTC strings from German announcement text.
 *
 * Strategy: find first DD.MM.YYYY date and first HH:MM–HH:MM range. If only
 * the time range is found, fall back to the pub_date's date. Returns (null,
 * null) if no time range is found.
 *
 * Mirrors Python's _parse_window() exactly.
 */
export function parseWindow(
    text: string,
    pubDateIso: string,
): [string | null, string | null] {
    const rangeM = TIME_RANGE_RE.exec(text);
    if (!rangeM) {
        return [null, null];
    }

    const dateM = DATE_RE.exec(text);
    let day: number;
    let mon: number;
    let year: number;

    if (dateM) {
        day = parseInt(dateM[1], 10);
        mon = parseInt(dateM[2], 10);
        year = parseInt(dateM[3], 10);
    } else {
        // Fall back to pub_date's date in Berlin time
        const pub = new Date(pubDateIso);
        const offsetMin = berlinOffsetMinutes(pub.getUTCFullYear(), pub.getUTCMonth() + 1, pub.getUTCDate());
        const localMs = pub.getTime() + offsetMin * 60_000;
        const localDate = new Date(localMs);
        day = localDate.getUTCDate();
        mon = localDate.getUTCMonth() + 1;
        year = localDate.getUTCFullYear();
    }

    const h1 = parseInt(rangeM[1], 10);
    const m1 = parseInt(rangeM[2], 10);
    const h2 = parseInt(rangeM[3], 10);
    const m2 = parseInt(rangeM[4], 10);

    // Validate ranges
    if (
        mon < 1 || mon > 12 ||
        day < 1 || day > 31 ||
        h1 > 23 || m1 > 59 ||
        h2 > 23 || m2 > 59
    ) {
        return [null, null];
    }

    const offsetMin = berlinOffsetMinutes(year, mon, day);

    // Build UTC ms from local components
    let startLocalMs: number;
    let endLocalMs: number;
    try {
        startLocalMs = Date.UTC(year, mon - 1, day, h1, m1, 0) - offsetMin * 60_000;
        endLocalMs = Date.UTC(year, mon - 1, day, h2, m2, 0) - offsetMin * 60_000;
    } catch {
        return [null, null];
    }

    // If end <= start, roll end forward one day (overnight window)
    if (endLocalMs <= startLocalMs) {
        endLocalMs += 24 * 60 * 60 * 1000;
    }

    return [
        new Date(startLocalMs).toISOString(),
        new Date(endLocalMs).toISOString(),
    ];
}

// ── Pub-date parser ───────────────────────────────────────────────────────────

/** RFC 822 and ISO 8601 parser, falling back to 'now' as ISO string. */
export function parsePubDate(raw: string): string {
    const trimmed = raw.trim();

    // ISO 8601: 2026-05-19T12:00:00Z or with offset
    if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
        const d = new Date(trimmed);
        if (!isNaN(d.getTime())) {
            return d.toISOString();
        }
    }

    // RFC 822: "Mon, 18 May 2026 10:06:13 GMT" or with numeric offset
    const d = new Date(trimmed);
    if (!isNaN(d.getTime())) {
        return d.toISOString();
    }

    return new Date().toISOString();
}

// ── State classifier ──────────────────────────────────────────────────────────

/**
 * Classify a MaintenanceWindow into one of:
 *   - active: now is inside [start, end]
 *   - scheduled: now is before start AND start is within MAX_AGE in the future
 *   - past: end is before now
 *   - recent: no parseable window but pub_date is within MAX_AGE
 *   - unknown: no window AND pub_date is old / unparseable
 *   - idle: sentinel value used when no window is present at all (returned by
 *           getMaintenanceState when mw is null)
 *
 * Mirrors Python's MaintenanceWindow.state() method exactly.
 */
export function classifyState(
    mw: MaintenanceWindow,
    nowMs?: number,
): MaintenanceState {
    const now = nowMs ?? Date.now();

    if (mw.scheduled_start !== null && mw.scheduled_end !== null) {
        const startMs = new Date(mw.scheduled_start).getTime();
        const endMs = new Date(mw.scheduled_end).getTime();

        if (now < startMs) {
            return startMs - now <= MAX_AGE_MS ? "scheduled" : "unknown";
        }
        if (now > endMs) {
            return "past";
        }
        return "active";
    }

    const pubMs = new Date(mw.pub_date).getTime();
    if (now - pubMs <= MAX_AGE_MS) {
        return "recent";
    }
    return "unknown";
}

// ── Priority comparison ───────────────────────────────────────────────────────

/**
 * Return true if candidate 'a' should win over 'b'.
 * Rank: active(0) > scheduled(1) > recent(2) > past(3) > unknown(4).
 * Tie-break: camera_relevant, then newer pub_date.
 */
export function prefers(
    a: MaintenanceWindow,
    b: MaintenanceWindow,
    nowMs?: number,
): boolean {
    const rank: Record<MaintenanceState, number> = {
        active: 0,
        scheduled: 1,
        recent: 2,
        past: 3,
        unknown: 4,
        idle: 5,
    };
    const sa = classifyState(a, nowMs);
    const sb = classifyState(b, nowMs);

    if (rank[sa] !== rank[sb]) {
        return rank[sa] < rank[sb];
    }
    if (a.camera_relevant !== b.camera_relevant) {
        return a.camera_relevant;
    }
    return new Date(a.pub_date).getTime() > new Date(b.pub_date).getTime();
}

// ── Board label extraction ────────────────────────────────────────────────────

/** Extract the board name from an RSS or HTML URL for the `source` field. */
export function boardLabel(url: string): string {
    const rssM = /board\.id=([^&]+)/.exec(url);
    if (rssM) return rssM[1];
    const htmlM = /\/bg-p\/([^/?#]+)/.exec(url);
    if (htmlM) return htmlM[1];
    return "unknown";
}

// ── RSS item extractor ────────────────────────────────────────────────────────

interface RssItem {
    title: string;
    link: string;
    pub: string;
    desc: string;
}

/**
 * Extract items from RSS 2.0 or Atom XML text using regex-based extraction.
 * Mirrors Python's _items_from_rss() for both RSS 2.0 and Atom.
 */
export function itemsFromXml(xml: string): RssItem[] {
    const items: RssItem[] = [];

    // ── RSS 2.0: <item>...</item> blocks ─────────────────────────────────────
    const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
    let itemMatch: RegExpExecArray | null;
    while ((itemMatch = itemRe.exec(xml)) !== null) {
        const block = itemMatch[1];
        const title = extractXmlTag(block, "title");
        const link = extractXmlTag(block, "link");
        const pub = extractXmlTag(block, "pubDate");
        const desc = extractXmlTag(block, "description");
        if (title) {
            items.push({ title, link, pub, desc });
        }
    }

    // ── Atom: <entry>...</entry> blocks ──────────────────────────────────────
    const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
    let entryMatch: RegExpExecArray | null;
    while ((entryMatch = entryRe.exec(xml)) !== null) {
        const block = entryMatch[1];
        const title = extractXmlTag(block, "title");
        if (!title) continue;

        // Atom link: <link href="..." />
        const linkM = /<link\b[^>]*href="([^"]+)"/.exec(block);
        const link = linkM ? linkM[1] : "";

        // Atom dates: prefer <updated> then <published>
        const pub =
            extractXmlTag(block, "updated") ||
            extractXmlTag(block, "published") ||
            "";

        // Atom content: <summary> or <content>
        const desc =
            extractXmlTag(block, "summary") ||
            extractXmlTag(block, "content") ||
            "";

        items.push({ title, link, pub, desc });
    }

    return items;
}

/**
 * Extract text content of a tag from an XML fragment.
 * Handles CDATA sections and strips surrounding whitespace.
 */
function extractXmlTag(xml: string, tag: string): string {
    const re = new RegExp(
        `<${tag}\\b[^>]*>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))\\s*<\/${tag}>`,
        "i",
    );
    const m = re.exec(xml);
    if (!m) return "";
    return (m[1] ?? m[2] ?? "").trim();
}

// ── Feed body parser ──────────────────────────────────────────────────────────

/**
 * Parse an RSS/Atom feed body and return the best-match MaintenanceWindow.
 * Returns null if the body is unparseable or contains no items.
 */
export function parseFeedBody(body: string, sourceUrl: string): MaintenanceWindow | null {
    // Basic XML sanity check — must contain at least one tag
    if (!/<[a-zA-Z]/.test(body)) {
        return null;
    }

    const items = itemsFromXml(body);
    const label = boardLabel(sourceUrl);
    let best: MaintenanceWindow | null = null;

    for (const raw of items) {
        if (!raw.title) continue;

        const pub_date = parsePubDate(raw.pub);
        const summary = stripHtml(raw.desc).slice(0, 500);
        const [scheduled_start, scheduled_end] = parseWindow(
            `${raw.title} ${summary}`,
            pub_date,
        );
        const camera_relevant = isCameraRelevant(raw.title, summary);

        const candidate: MaintenanceWindow = {
            title: raw.title,
            link: raw.link,
            pub_date,
            summary,
            scheduled_start,
            scheduled_end,
            source: `rss:${label}`,
            camera_relevant,
        };

        if (best === null || prefers(candidate, best)) {
            best = candidate;
        }
    }

    return best;
}

// ── HTML fallback parser ──────────────────────────────────────────────────────

/**
 * Extract a single best-match item from the rendered Khoros board page.
 * Mirrors Python's _parse_html_fallback() exactly.
 */
export function parseHtmlFallback(html: string, sourceUrl: string): MaintenanceWindow | null {
    // Find the first item link: /t5/<board>/<slug>/ba-p/<id>
    const linkRe = /href="(\/t5\/[^"]+\/ba-p\/\d+)"[^>]*>\s*([^<]{6,200})<\/a>/;
    const linkM = linkRe.exec(html);
    if (!linkM) {
        return null;
    }

    const href = "https://community.bosch-smarthome.com" + linkM[1];
    const title = stripHtml(linkM[2]);

    // Meta description for summary
    const descM = /<meta\s+name="description"\s+content="([^"]{20,500})"/i.exec(html);
    const summary = descM ? stripHtml(descM[1]) : "";

    const pub_date = new Date().toISOString();
    const [scheduled_start, scheduled_end] = parseWindow(
        `${title} ${summary}`,
        pub_date,
    );

    return {
        title,
        link: href,
        pub_date,
        summary: summary.slice(0, 500),
        scheduled_start,
        scheduled_end,
        source: `html:${boardLabel(sourceUrl)}`,
        camera_relevant: isCameraRelevant(title, summary),
    };
}

// ── HTTP fetch helper ─────────────────────────────────────────────────────────

/** Result of a single HTTP fetch attempt: [statusCode, bodyText] or null on error. */
export type FetchResult = [number, string] | null;

/**
 * Fetch a single URL with a browser User-Agent and a timeout.
 * Returns null on network error, timeout, or non-200 status.
 *
 * Uses the global `fetch` (Node 18+ built-in), which matches the ASYNC_FIRST rule.
 */
export async function fetchOne(
    url: string,
    timeoutMs: number = 8_000,
): Promise<FetchResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetch(url, {
            signal: controller.signal,
            headers: { "User-Agent": BROWSER_UA },
        });
        clearTimeout(timer);
        if (resp.status !== 200) {
            return null;
        }
        const text = await resp.text();
        return [resp.status, text];
    } catch {
        clearTimeout(timer);
        return null;
    }
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Fetch and parse the best-match maintenance/incident announcement.
 *
 * Returns null only when ALL primary and fallback sources fail — the caller
 * keeps the last cached value rather than flipping state on a transient miss
 * of the community site.
 *
 * Mirrors Python's async_fetch_maintenance() exactly.
 *
 * @param timeoutMs  Per-URL fetch timeout in milliseconds (default 8 000)
 */
export async function fetchMaintenance(
    timeoutMs: number = 8_000,
): Promise<MaintenanceWindow | null> {
    let best: MaintenanceWindow | null = null;

    // ── Primary: RSS feeds ───────────────────────────────────────────────────
    for (const url of RSS_FEEDS) {
        const got = await fetchOne(url, timeoutMs);
        if (got === null) continue;
        const parsed = parseFeedBody(got[1], url);
        if (parsed !== null && (best === null || prefers(parsed, best))) {
            best = parsed;
        }
    }

    if (best !== null) {
        return best;
    }

    // ── Fallback: HTML board pages ───────────────────────────────────────────
    for (const url of HTML_FALLBACKS) {
        const got = await fetchOne(url, timeoutMs);
        if (got === null) continue;
        const parsed = parseHtmlFallback(got[1], url);
        if (parsed !== null && (best === null || prefers(parsed, best))) {
            best = parsed;
        }
    }

    return best;
}
