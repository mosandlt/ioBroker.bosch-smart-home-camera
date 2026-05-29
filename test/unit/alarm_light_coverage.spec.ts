/**
 * Coverage gap tests for src/lib/alarm_light.ts
 *
 * Targets the lines/branches NOT hit by alarm_light.spec.ts:
 *
 *   Lines 99-100   — setPanicAlarm() catch: axios throws → returns false
 *   Lines 133-134  — fetchLightingState() catch: axios throws → returns null
 *   Lines 180-181  — putLightingState() catch: axios throws → returns null
 *   Branch 208     — normaliseGroup() whiteBalance null when valid color present
 *                    (color is valid → whiteBalance should be null, not -1.0)
 *
 * Framework: Mocha + Chai
 * Mocking:   axios.defaults.adapter (mirrors alarm_light.spec.ts pattern)
 */

import { expect } from "chai";
import axios, { type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";

import {
    setPanicAlarm,
    fetchLightingState,
    putLightingState,
    normaliseLightingState,
    DEFAULT_LIGHTING_STATE,
} from "../../src/lib/alarm_light";

const CAM_ID = "0A0B0C0D-1111-2222-3333-444455556666";
const TOKEN = "test-token";

// ── Adapter helpers ────────────────────────────────────────────────────────────

let _savedAdapter: AxiosAdapter | string | readonly (string | AxiosAdapter)[] | undefined;

/** Make axios throw a network-level error (no response object). */
function stubNetworkThrow(): void {
    _savedAdapter = axios.defaults.adapter;
    axios.defaults.adapter = (_config: InternalAxiosRequestConfig): Promise<never> => {
        const err = new Error("Network Error");
        // No .response, no .isAxiosError — raw throw
        return Promise.reject(err);
    };
}

function restoreAdapter(): void {
    if (_savedAdapter !== undefined) {
        axios.defaults.adapter = _savedAdapter as AxiosAdapter;
        _savedAdapter = undefined;
    }
}

function stubSequence(responses: Array<Partial<AxiosResponse>>): void {
    _savedAdapter = axios.defaults.adapter;
    let idx = 0;
    axios.defaults.adapter = (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
        const r = responses[idx++] ?? { status: 404, data: null };
        return Promise.resolve({
            status: 200,
            statusText: "OK",
            headers: {},
            data: null,
            config,
            request: {},
            ...r,
        } as AxiosResponse);
    };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("setPanicAlarm() — coverage gaps", () => {
    afterEach(() => restoreAdapter());

    // Lines 99-100: catch block when axios throws (no response at all)
    it("(A1) network throw → returns false (catch branch)", async () => {
        stubNetworkThrow();
        const ok = await setPanicAlarm(axios.create(), TOKEN, CAM_ID, true);
        expect(ok).to.equal(false);
    });

    // Status 201 is also a success path (line 97 — OR chain)
    it("(A2) HTTP 201 → returns true", async () => {
        stubSequence([{ status: 201, data: null }]);
        const ok = await setPanicAlarm(axios.create(), TOKEN, CAM_ID, true);
        expect(ok).to.equal(true);
    });

    // Status 200 success
    it("(A3) HTTP 200 → returns true", async () => {
        stubSequence([{ status: 200, data: null }]);
        const ok = await setPanicAlarm(axios.create(), TOKEN, CAM_ID, false);
        expect(ok).to.equal(true);
    });
});

describe("fetchLightingState() — coverage gaps", () => {
    afterEach(() => restoreAdapter());

    // Lines 133-134: catch block when axios throws (no response at all)
    it("(A4) network throw → returns null (catch branch)", async () => {
        stubNetworkThrow();
        const ls = await fetchLightingState(axios.create(), TOKEN, CAM_ID);
        expect(ls).to.be.null;
    });

    // Branch: resp.data is null (object check fails → null branch)
    it("(A5) HTTP 200 but resp.data is null → returns null (data guard)", async () => {
        stubSequence([{ status: 200, data: null }]);
        const ls = await fetchLightingState(axios.create(), TOKEN, CAM_ID);
        expect(ls).to.be.null;
    });
});

describe("putLightingState() — coverage gaps", () => {
    afterEach(() => restoreAdapter());

    // Lines 180-181: catch block when axios throws
    it("(A6) network throw → returns null (catch branch)", async () => {
        stubNetworkThrow();
        const ls = await putLightingState(axios.create(), TOKEN, CAM_ID, DEFAULT_LIGHTING_STATE);
        expect(ls).to.be.null;
    });
});

describe("normaliseLightingState() — coverage gaps", () => {
    // Branch at line 208: when color is valid, whiteBalance should be set to null
    // (not the fallback -1.0). This tests the `color !== null ? null : -1.0` branch.

    it("(A7) valid color → whiteBalance forced to null (color and whiteBalance mutually exclusive)", () => {
        const ls = normaliseLightingState({
            topLedLightSettings: {
                brightness: 50,
                color: "#FF0000",
                // NOTE: whiteBalance is not provided (undefined) but color is valid
                // → normaliseGroup should set whiteBalance = null (RGB mode)
                whiteBalance: undefined,
            },
        });
        expect(ls.topLedLightSettings.color).to.equal("#FF0000");
        // When color is non-null, whiteBalance must be null (RGB mode)
        expect(ls.topLedLightSettings.whiteBalance).to.be.null;
    });

    it("(A8) valid color WITH finite whiteBalance → BOTH preserved (normaliseGroup allows it)", () => {
        // The Bosch API sometimes sends both a valid color and a whiteBalance number.
        // normaliseGroup preserves both when whiteBalance is finite — it only forces
        // whiteBalance=null via the ternary when whiteBalance is NOT a finite number
        // AND color is non-null. This documents that behaviour.
        const ls = normaliseLightingState({
            frontLightSettings: {
                brightness: 80,
                color: "aabbcc", // without # prefix
                whiteBalance: 0.5, // finite → clamp(0.5, -1, 1) = 0.5 is kept
            },
        });
        expect(ls.frontLightSettings.color).to.equal("#AABBCC");
        // whiteBalance is finite, so the ternary takes clamp path, NOT the null branch
        expect(ls.frontLightSettings.whiteBalance).to.equal(0.5);
    });

    it("(A9) null color AND null whiteBalance → whiteBalance falls back to -1.0 (warm white default)", () => {
        const ls = normaliseLightingState({
            bottomLedLightSettings: {
                brightness: 20,
                color: null,
                whiteBalance: null, // invalid in white-balance mode → fallback to -1.0
            },
        });
        expect(ls.bottomLedLightSettings.color).to.be.null;
        // color is null → whiteBalance fallback = -1.0
        expect(ls.bottomLedLightSettings.whiteBalance).to.equal(-1.0);
    });

    it("(A10) brightness NaN → defaults to 0", () => {
        const ls = normaliseLightingState({
            topLedLightSettings: { brightness: NaN, color: null, whiteBalance: 0 },
        });
        expect(ls.topLedLightSettings.brightness).to.equal(0);
    });

    it("(A11) whiteBalance Infinity → defaults to -1.0 (color=null fallback)", () => {
        const ls = normaliseLightingState({
            topLedLightSettings: { brightness: 50, color: null, whiteBalance: Infinity },
        });
        // Infinity is not finite → falls into the `color === null ? -1.0 : null` ternary
        expect(ls.topLedLightSettings.whiteBalance).to.equal(-1.0);
    });

    it("(A12) whiteBalance Infinity with valid color → null (color branch of ternary)", () => {
        const ls = normaliseLightingState({
            topLedLightSettings: { brightness: 50, color: "#123456", whiteBalance: Infinity },
        });
        // color is non-null, so even though whiteBalance is non-finite, it resolves to null
        expect(ls.topLedLightSettings.whiteBalance).to.be.null;
        expect(ls.topLedLightSettings.color).to.equal("#123456");
    });
});
