/**
 * Coverage gap tests for src/lib/rcp.ts
 *
 * Targets the lines/branches NOT hit by rcp.spec.ts:
 *
 *   Lines 345-357 — sendRcpCommand() Digest-auth path (auth param provided):
 *                     happy path: 200 response → parseRcpResponse
 *                     non-200 response → throws RcpNetworkError
 *   Lines 372-373 — catch block: RcpNetworkError re-throw
 *                   (an RcpNetworkError thrown by the auth block bubbles through
 *                   the outer catch without wrapping in another RcpNetworkError)
 *   Branch 367    — Buffer.isBuffer(resp.data) === false branch
 *                   (resp.data arrives as ArrayBuffer/Uint8Array, not Buffer)
 *   Branch 371    — axios.isAxiosError() branch in catch
 *   Branch 378    — status === undefined (network error, no response)
 *
 * The digestRequest helper in digest.ts calls axios internally, so we mock
 * axios.defaults.adapter to intercept its requests as well.
 *
 * Framework: Mocha + Chai
 */

import { expect } from "chai";
import axios from "axios";
import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from "axios";

import {
    sendRcpCommand,
    buildGetSnapshotFrame,
    buildSetPrivacyFrame,
    RcpError,
    RcpNetworkError,
} from "../../src/lib/rcp";

// ── Minimal RCP XML helpers ────────────────────────────────────────────────────

function makePayloadXml(hexPayload: string): Buffer {
    return Buffer.from(`<rcp version="1.00"><payload>${hexPayload}</payload></rcp>`, "ascii");
}

function makeErrXml(code: string): Buffer {
    return Buffer.from(`<rcp version="1.00"><err>${code}</err></rcp>`, "ascii");
}

// ── Adapter save/restore ───────────────────────────────────────────────────────

let _savedAdapter: AxiosAdapter | string | readonly (string | AxiosAdapter)[] | undefined;

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

function stubError(status: number | undefined, axiosError = true): void {
    _savedAdapter = axios.defaults.adapter;
    axios.defaults.adapter = (_config: InternalAxiosRequestConfig): Promise<never> => {
        const err: Error & {
            response?: { status: number; data: unknown; headers: Record<string, string> };
            isAxiosError?: boolean;
        } = new Error(
            status !== undefined
                ? `Request failed with status code ${status}`
                : "Network Error",
        );
        if (status !== undefined) {
            err.response = { status, data: null, headers: {} };
        }
        err.isAxiosError = axiosError;
        return Promise.reject(err);
    };
}

function restoreAdapter(): void {
    if (_savedAdapter !== undefined) {
        axios.defaults.adapter = _savedAdapter as AxiosAdapter;
        _savedAdapter = undefined;
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("sendRcpCommand() — coverage gaps", () => {
    afterEach(() => restoreAdapter());

    // ── Digest auth happy path (lines 345-357) ─────────────────────────────
    // The digestRequest helper does TWO axios calls (initial unauthenticated,
    // then authenticated). Provide two responses: 401 challenge + 200 payload.

    it("(R1) auth path: Digest 401→200 → parses RCP payload", async () => {
        const responseXml = makePayloadXml("00010000");

        // Sequence:
        //   call 1: initial unauthenticated → 401 with WWW-Authenticate
        //   call 2: retry with Authorization → 200 + XML
        stubSequence([
            {
                status: 401,
                data: Buffer.from(""),
                headers: {
                    "www-authenticate":
                        'Digest realm="cam", nonce="abc123", algorithm=MD5, qop="auth"',
                } as unknown as AxiosResponse["headers"],
            },
            {
                status: 200,
                data: responseXml,
                headers: {} as AxiosResponse["headers"],
            },
        ]);

        const params = buildSetPrivacyFrame(true);
        const result = await sendRcpCommand(
            axios as unknown as Parameters<typeof sendRcpCommand>[0],
            "https://192.0.2.10/rcp.xml",
            params,
            5000,
            { user: "cbs-test", password: "secret" },
        );

        expect(result.payload.length).to.equal(4);
        expect(result.payload[1]).to.equal(0x01); // privacy ON
    });

    // ── Digest auth path: non-200 from second request (lines 351-356) ────────
    // digestRequest returns 403 → sendRcpCommand must throw RcpNetworkError.

    it("(R2) auth path: Digest 401→403 → throws RcpNetworkError(403)", async () => {
        stubSequence([
            {
                status: 401,
                data: Buffer.from(""),
                headers: {
                    "www-authenticate": 'Digest realm="cam", nonce="nnn", algorithm=MD5',
                } as unknown as AxiosResponse["headers"],
            },
            {
                status: 403,
                data: Buffer.from("Forbidden"),
                headers: {} as AxiosResponse["headers"],
            },
        ]);

        const params = buildGetSnapshotFrame();
        try {
            await sendRcpCommand(
                axios as unknown as Parameters<typeof sendRcpCommand>[0],
                "https://192.0.2.10/rcp.xml",
                params,
                5000,
                { user: "cbs-test", password: "secret" },
            );
            expect.fail("should have thrown");
        } catch (err) {
            expect(err).to.be.instanceOf(RcpNetworkError);
            expect((err as RcpNetworkError).status).to.equal(403);
            expect((err as RcpNetworkError).message).to.match(/digest auth/i);
        }
    });

    // ── RcpNetworkError re-throw in catch (lines 371-373) ─────────────────────
    // The inner auth block can throw RcpNetworkError (status 403 above) which
    // bubbles into the outer catch. The catch MUST re-throw it unchanged —
    // NOT wrap it in another RcpNetworkError. Validate the instance identity.

    it("(R3) RcpNetworkError from auth block passes through catch unchanged", async () => {
        stubSequence([
            {
                status: 401,
                data: Buffer.from(""),
                headers: {
                    "www-authenticate": 'Digest realm="cam", nonce="xyz", algorithm=MD5',
                } as unknown as AxiosResponse["headers"],
            },
            { status: 503, data: Buffer.from(""), headers: {} as AxiosResponse["headers"] },
        ]);

        const params = buildGetSnapshotFrame();
        let thrown: unknown;
        try {
            await sendRcpCommand(
                axios as unknown as Parameters<typeof sendRcpCommand>[0],
                "https://192.0.2.10/rcp.xml",
                params,
                5000,
                { user: "cbs-test", password: "secret" },
            );
        } catch (e) {
            thrown = e;
        }
        expect(thrown).to.be.instanceOf(RcpNetworkError);
        // It must still be the same error with status 503 — not wrapped
        expect((thrown as RcpNetworkError).status).to.equal(503);
    });

    // ── resp.data is ArrayBuffer/Uint8Array, not a Buffer (branch at line 367) ─
    // When axios responds with ArrayBuffer (e.g. from JSDOM or Node 22 fetch),
    // Buffer.isBuffer() returns false → Buffer.from(resp.data) code path is taken.

    it("(R4) REMOTE path: resp.data as Uint8Array (not Buffer) → still parsed correctly", async () => {
        const xmlText = `<rcp version="1.00"><payload>deadbeef</payload></rcp>`;
        // Uint8Array is NOT a Buffer, but Buffer.from() accepts it
        const uint8Data = new Uint8Array(Buffer.from(xmlText, "ascii"));

        stubSequence([{ status: 200, data: uint8Data }]);

        const params = buildGetSnapshotFrame();
        const result = await sendRcpCommand(
            axios as unknown as Parameters<typeof sendRcpCommand>[0],
            "https://192.0.2.10/rcp.xml",
            params,
        );

        expect(result.payload.toString("hex")).to.equal("deadbeef");
    });

    // ── axios.isAxiosError() catch branch with status (branch at line 374) ────
    // An AxiosError with a response wraps to RcpNetworkError(status, ...).
    // This is the non-auth (remote) path.

    it("(R5) REMOTE path: AxiosError with status 502 → RcpNetworkError(502)", async () => {
        stubError(502);

        const params = buildGetSnapshotFrame();
        try {
            await sendRcpCommand(
                axios as unknown as Parameters<typeof sendRcpCommand>[0],
                "https://192.0.2.10/rcp.xml",
                params,
            );
            expect.fail("should have thrown");
        } catch (err) {
            expect(err).to.be.instanceOf(RcpNetworkError);
            expect((err as RcpNetworkError).status).to.equal(502);
        }
    });

    // ── axios.isAxiosError() — status undefined (network error, branch 378) ──
    // When the request fails at the TCP level there is no response.status.
    // The message should contain "network error".

    it("(R6) REMOTE path: AxiosError with no response (network error) → RcpNetworkError(undefined)", async () => {
        stubError(undefined);

        const params = buildGetSnapshotFrame();
        try {
            await sendRcpCommand(
                axios as unknown as Parameters<typeof sendRcpCommand>[0],
                "https://192.0.2.10/rcp.xml",
                params,
            );
            expect.fail("should have thrown");
        } catch (err) {
            expect(err).to.be.instanceOf(RcpNetworkError);
            expect((err as RcpNetworkError).status).to.be.undefined;
            expect((err as RcpNetworkError).message).to.match(/network error/i);
        }
    });

    // ── Non-Axios, non-RcpNetworkError thrown from REMOTE path (last throw) ──
    // An RcpError thrown by parseRcpResponse must re-throw unchanged (not wrapped).

    it("(R7) REMOTE path: RcpError from parseRcpResponse re-thrown unchanged", async () => {
        const errXml = makeErrXml("0x60");
        stubSequence([{ status: 200, data: errXml }]);

        const params = buildGetSnapshotFrame();
        try {
            await sendRcpCommand(
                axios as unknown as Parameters<typeof sendRcpCommand>[0],
                "https://192.0.2.10/rcp.xml",
                params,
            );
            expect.fail("should have thrown");
        } catch (err) {
            expect(err).to.be.instanceOf(RcpError);
            expect((err as RcpError).code).to.equal("0x60");
        }
    });
});
