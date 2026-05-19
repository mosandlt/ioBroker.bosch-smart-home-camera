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
/** Boards Bosch uses for service status. Order = preference; first success wins. */
export declare const RSS_FEEDS: readonly string[];
export declare const HTML_FALLBACKS: readonly string[];
export type MaintenanceState = "active" | "scheduled" | "past" | "recent" | "unknown" | "idle";
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
/** Strip HTML tags and decode HTML entities. */
export declare function stripHtml(html: string): string;
/** Return true if the combined title+summary contains a camera-relevant keyword. */
export declare function isCameraRelevant(title: string, summary: string): boolean;
/**
 * Extract (start, end) ISO UTC strings from German announcement text.
 *
 * Strategy: find first DD.MM.YYYY date and first HH:MM–HH:MM range. If only
 * the time range is found, fall back to the pub_date's date. Returns (null,
 * null) if no time range is found.
 *
 * Mirrors Python's _parse_window() exactly.
 */
export declare function parseWindow(text: string, pubDateIso: string): [string | null, string | null];
/** RFC 822 and ISO 8601 parser, falling back to 'now' as ISO string. */
export declare function parsePubDate(raw: string): string;
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
export declare function classifyState(mw: MaintenanceWindow, nowMs?: number): MaintenanceState;
/**
 * Return true if candidate 'a' should win over 'b'.
 * Rank: active(0) > scheduled(1) > recent(2) > past(3) > unknown(4).
 * Tie-break: camera_relevant, then newer pub_date.
 */
export declare function prefers(a: MaintenanceWindow, b: MaintenanceWindow, nowMs?: number): boolean;
/** Extract the board name from an RSS or HTML URL for the `source` field. */
export declare function boardLabel(url: string): string;
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
export declare function itemsFromXml(xml: string): RssItem[];
/**
 * Parse an RSS/Atom feed body and return the best-match MaintenanceWindow.
 * Returns null if the body is unparseable or contains no items.
 */
export declare function parseFeedBody(body: string, sourceUrl: string): MaintenanceWindow | null;
/**
 * Extract a single best-match item from the rendered Khoros board page.
 * Mirrors Python's _parse_html_fallback() exactly.
 */
export declare function parseHtmlFallback(html: string, sourceUrl: string): MaintenanceWindow | null;
/** Result of a single HTTP fetch attempt: [statusCode, bodyText] or null on error. */
export type FetchResult = [number, string] | null;
/**
 * Fetch a single URL with a browser User-Agent and a timeout.
 * Returns null on network error, timeout, or non-200 status.
 *
 * Uses the global `fetch` (Node 18+ built-in), which matches the ASYNC_FIRST rule.
 */
export declare function fetchOne(url: string, timeoutMs?: number): Promise<FetchResult>;
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
export declare function fetchMaintenance(timeoutMs?: number): Promise<MaintenanceWindow | null>;
export {};
//# sourceMappingURL=maintenance.d.ts.map