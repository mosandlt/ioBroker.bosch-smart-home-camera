/**
 * Shared axios mock helpers for unit tests.
 *
 * Uses axios.defaults.adapter (the officially supported mock point for axios v1.x)
 * so stubs intercept both `axios(config)` and `axios.request(config)` call forms.
 */

import axios, {
    type AxiosResponse,
    type AxiosAdapter,
    type InternalAxiosRequestConfig,
} from "axios";

let _savedAdapter: AxiosAdapter | string | readonly (string | AxiosAdapter)[] | undefined;

/**
 * Creates an axios adapter stub that responds with the given sequence of
 * responses. Each call to axios returns the next response in order.
 * Call `restoreAxios()` in afterEach.
 */
export function stubAxiosSequence(responses: Array<Partial<AxiosResponse>>): void {
    _savedAdapter = axios.defaults.adapter;
    let callIndex = 0;
    // 2026-05-25: when the explicit response queue is exhausted, default
    // to a `404 null` response instead of rejecting. This lets new polls
    // added in future agent passes (F4/F6/F13, Tier-2 number numbers,
    // 444 handling, etc.) coexist with older tests that only configured
    // responses for the original endpoint set — the new polls then get
    // a harmless "not found" and the test's actual assertions stay valid.
    const FALLBACK: Partial<AxiosResponse> = { status: 404, data: null };
    axios.defaults.adapter = (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
        const resp = responses[callIndex++] ?? FALLBACK;
        return Promise.resolve({
            status: 200,
            statusText: "OK",
            headers: {},
            data: null,
            config,
            request: {},
            ...resp,
        } as AxiosResponse);
    };
}

/**
 * A single URL→response rule for {@link stubAxiosByUrl}.
 * `match` is tested against the request URL (substring for strings, `.test()`
 * for RegExp). `method` (optional, case-insensitive) further narrows the rule.
 */
export interface UrlMatcher {
    match: string | RegExp;
    method?: string;
    status?: number;
    data?: unknown;
    headers?: Record<string, string | string[]>;
    /**
     * When true, the call REJECTS with an AxiosError carrying `response.status`
     * (default 500) instead of resolving. Use this to exercise a helper's catch
     * path — the mock otherwise resolves every response regardless of status, so
     * a plain `status: 500` would be seen as a (malformed) success, not an error.
     */
    reject?: boolean;
}

/**
 * Creates an axios adapter stub that resolves each call based on its URL
 * (and optionally HTTP method) instead of call ORDER.
 *
 * Why this exists: the per-camera state poll grows new endpoints every release
 * (v0.7.7 wifiinfo, v0.7.14 intrusion, v0.8.0 lens/global-lighting, v0.9.1
 * unread-events/privacy-sound …). Tests built on the positional
 * {@link stubAxiosSequence} break each time a poll is inserted upstream because
 * the response they care about gets consumed by the wrong call. URL matching is
 * immune to that drift — the lighting/switch response is returned for the
 * lighting/switch GET no matter how many other polls run first.
 *
 * Matchers are evaluated in order; the FIRST match wins. List specific paths
 * before general ones (e.g. `/lighting/switch` before `/lighting`). Unmatched
 * requests get `fallback` (default `404 null`), mirroring stubAxiosSequence's
 * exhausted-queue behaviour so unrelated best-effort polls stay harmless.
 *
 * Call `restoreAxios()` in afterEach.
 */
export function stubAxiosByUrl(
    matchers: UrlMatcher[],
    fallback: Partial<AxiosResponse> = { status: 404, data: null },
): void {
    _savedAdapter = axios.defaults.adapter;
    axios.defaults.adapter = (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
        const url = config.url ?? "";
        const method = (config.method ?? "get").toLowerCase();
        const hit = matchers.find((m) => {
            const urlOk =
                typeof m.match === "string" ? url.includes(m.match) : m.match.test(url);
            const methodOk = m.method === undefined || m.method.toLowerCase() === method;
            return urlOk && methodOk;
        });
        if (hit?.reject) {
            const status = hit.status ?? 500;
            const error: Error & {
                response?: { status: number; data: unknown; headers: Record<string, string> };
                isAxiosError?: boolean;
            } = new Error(`Request failed with status code ${status}`);
            error.response = { status, data: hit.data ?? null, headers: {} };
            error.isAxiosError = true;
            return Promise.reject(error);
        }
        const resp: Partial<AxiosResponse> = hit
            ? {
                  status: hit.status ?? 200,
                  data: hit.data,
                  headers: (hit.headers ?? {}) as AxiosResponse["headers"],
              }
            : fallback;
        return Promise.resolve({
            status: 200,
            statusText: "OK",
            headers: {},
            data: null,
            config,
            request: {},
            ...resp,
        } as AxiosResponse);
    };
}

/**
 * Creates an axios adapter stub that rejects every call with an HTTP error.
 * Call `restoreAxios()` in afterEach.
 */
export function stubAxiosError(status: number, body?: unknown): void {
    _savedAdapter = axios.defaults.adapter;
    axios.defaults.adapter = (_config: InternalAxiosRequestConfig): Promise<never> => {
        const error: Error & {
            response?: { status: number; data: unknown; headers: Record<string, string> };
            isAxiosError?: boolean;
        } = new Error(`Request failed with status code ${status}`);
        error.response = { status, data: body ?? null, headers: {} };
        error.isAxiosError = true;
        return Promise.reject(error);
    };
}

/**
 * Restores the original axios adapter. Call in afterEach.
 */
export function restoreAxios(): void {
    if (_savedAdapter !== undefined) {
        axios.defaults.adapter = _savedAdapter as AxiosAdapter;
        _savedAdapter = undefined;
    }
}
