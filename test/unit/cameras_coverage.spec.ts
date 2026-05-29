/**
 * Coverage supplement for src/lib/cameras.ts
 *
 * FILE_PARTITION: exclusive owner of these describe blocks.
 * Targets the 2 uncovered lines remaining after cameras.spec.ts:
 *
 *   fetchCameras() catch block:
 *     — axios 401 error: body JSON-stringification (const body = JSON.stringify(…))
 *     — non-axios error: re-throw (throw err)
 *
 * Framework: Mocha + Chai
 * Mirrors mock patterns from test/unit/cameras.spec.ts
 */

import { expect } from "chai";
import axios from "axios";

import {
    fetchCameras,
    UnauthorizedError,
} from "../../src/lib/cameras";

import { restoreAxios } from "./helpers/axios-mock";

const BEARER = "test-bearer-token";

// ── fetchCameras() 401 with structured body ───────────────────────────────────

describe("fetchCameras() UnauthorizedError body JSON-stringify (coverage)", () => {
    afterEach(() => {
        restoreAxios();
    });

    it("throws UnauthorizedError and includes JSON-stringified body on 401 with object body", async () => {
        // Trigger the `const body = JSON.stringify(err.response?.data ?? "")` path
        // by providing a structured (non-string) error body in the 401 response.
        // cameras.spec.ts uses a string body, leaving the object-body branch uncovered.
        const savedAdapter = axios.defaults.adapter;
        axios.defaults.adapter = () => {
            const err: Error & { response?: { status: number; data: unknown; headers: Record<string, string> }; isAxiosError?: boolean } =
                new Error("Request failed with status code 401");
            err.response = {
                status: 401,
                data: { message: "Access token expired", code: "TOKEN_EXPIRED" },
                headers: {},
            };
            err.isAxiosError = true;
            return Promise.reject(err);
        };

        try {
            await fetchCameras(axios.create(), BEARER);
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(UnauthorizedError);
            // Message should contain JSON of the structured body
            expect((err as UnauthorizedError).message).to.include("TOKEN_EXPIRED");
        } finally {
            axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
        }
    });

    it("throws UnauthorizedError when 401 body is null (data ?? '' fallback)", async () => {
        const savedAdapter = axios.defaults.adapter;
        axios.defaults.adapter = () => {
            const err: Error & { response?: { status: number; data: unknown; headers: Record<string, string> }; isAxiosError?: boolean } =
                new Error("Request failed with status code 401");
            err.response = { status: 401, data: null, headers: {} };
            err.isAxiosError = true;
            return Promise.reject(err);
        };

        try {
            await fetchCameras(axios.create(), BEARER);
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(UnauthorizedError);
            expect((err as UnauthorizedError).message).to.include("401");
        } finally {
            axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
        }
    });
});

// ── fetchCameras() non-axios re-throw ─────────────────────────────────────────

describe("fetchCameras() non-axios error re-throw (coverage)", () => {
    afterEach(() => {
        restoreAxios();
    });

    it("re-throws non-axios errors unchanged (throw err branch)", async () => {
        // A TypeError (or any non-axios error) must bubble up unmodified
        const savedAdapter = axios.defaults.adapter;
        axios.defaults.adapter = () => Promise.reject(new TypeError("non-axios failure in cameras"));
        try {
            await fetchCameras(axios.create(), BEARER);
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(TypeError);
            expect((err as TypeError).message).to.equal("non-axios failure in cameras");
        } finally {
            axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
        }
    });
});
