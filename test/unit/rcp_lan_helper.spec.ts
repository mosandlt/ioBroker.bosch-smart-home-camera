/**
 * Unit tests for src/lib/rcp_lan_helper.ts
 *
 * Covers:
 *   - fetchRcpLan: null/missing credentials, non-200, <err>, <str>HEX</str>,
 *     raw-binary fallback, XML-starts-with-< returns null, network error catch
 *   - parseOnvifScopes: full happy path, ONVIF scope without slash (line 162),
 *     non-ONVIF scopes skipped, URL-encoded values decoded, catch path for
 *     malformed input (line 176)
 *   - formatRcpVersion: happy path, short buffer, exact 4-byte encoding
 *
 * Mocking strategy: mirrors digest.spec.ts — replace axios.defaults.adapter
 * with a fake adapter to drive digestRequest without real network I/O.
 */

import { expect } from "chai";
import axios from "axios";
import type {
    AxiosAdapter,
    InternalAxiosRequestConfig,
    AxiosPromise,
    AxiosResponseHeaders,
} from "axios";

import {
    fetchRcpLan,
    parseOnvifScopes,
    formatRcpVersion,
    type RcpLanCredentials,
} from "../../src/lib/rcp_lan_helper";

// ── Adapter helpers (mirrors digest.spec.ts pattern) ─────────────────────────

interface FakeResponseShape {
    status: number;
    headers: Record<string, string>;
    data: Buffer;
}

type FakeAdapterFn = (config: InternalAxiosRequestConfig) => AxiosPromise;

function makeAdapter(responses: FakeResponseShape[]): FakeAdapterFn {
    let callIndex = 0;
    return (config: InternalAxiosRequestConfig): AxiosPromise => {
        const resp = responses[Math.min(callIndex++, responses.length - 1)];
        return Promise.resolve({
            status: resp.status,
            statusText: String(resp.status),
            headers: resp.headers as unknown as AxiosResponseHeaders,
            config,
            data: resp.data,
            request: {},
        });
    };
}

async function withAdapter<T>(adapter: FakeAdapterFn, fn: () => Promise<T>): Promise<T> {
    const original = axios.defaults.adapter;
    axios.defaults.adapter = adapter as unknown as AxiosAdapter;
    try {
        return await fn();
    } finally {
        axios.defaults.adapter = original;
    }
}

/** Build a pair of [401-challenge, 200-body] responses for digestRequest flow. */
function makeRcpAdaptor(bodyBuf: Buffer, status = 200): FakeAdapterFn {
    // digestRequest sends the initial request first (unauthenticated).
    // Camera typically returns 401; digestRequest retries with Digest credentials.
    // We model the common Bosch case: 401 challenge → 200 body.
    const wwwAuth = 'Digest realm="cam", nonce="abcdef", qop="auth", algorithm=MD5';
    return makeAdapter([
        { status: 401, headers: { "www-authenticate": wwwAuth }, data: Buffer.from("") },
        { status, headers: {}, data: bodyBuf },
    ]);
}

const VALID_CREDS: RcpLanCredentials = {
    lanAddress: "192.0.2.10:443", // RFC 5737 TEST-NET (never a real LAN IP)
    digestUser: "cbs-12345678",
    digestPassword: "secret",
};

// ── fetchRcpLan ───────────────────────────────────────────────────────────────

describe("fetchRcpLan()", () => {
    it("(F1) null creds → returns null without network call", async () => {
        const result = await fetchRcpLan(null, "0x0a98");
        expect(result).to.equal(null);
    });

    it("(F2) undefined creds → returns null", async () => {
        const result = await fetchRcpLan(undefined, "0x0a98");
        expect(result).to.equal(null);
    });

    it("(F3) empty lanAddress → returns null", async () => {
        const result = await fetchRcpLan(
            { lanAddress: "", digestUser: "u", digestPassword: "p" },
            "0x0a98",
        );
        expect(result).to.equal(null);
    });

    it("(F4) missing digestUser → returns null", async () => {
        const result = await fetchRcpLan(
            { lanAddress: "192.168.1.1:443", digestUser: "", digestPassword: "p" },
            "0x0a98",
        );
        expect(result).to.equal(null);
    });

    it("(F5) missing digestPassword → returns null", async () => {
        const result = await fetchRcpLan(
            { lanAddress: "192.168.1.1:443", digestUser: "u", digestPassword: "" },
            "0x0a98",
        );
        expect(result).to.equal(null);
    });

    it("(F6) non-200 final HTTP status → returns null", async () => {
        const wwwAuth = 'Digest realm="cam", nonce="abc", qop="auth", algorithm=MD5';
        const adapter = makeAdapter([
            { status: 401, headers: { "www-authenticate": wwwAuth }, data: Buffer.from("") },
            { status: 403, headers: {}, data: Buffer.from("Forbidden") },
        ]);
        const result = await withAdapter(adapter, () => fetchRcpLan(VALID_CREDS, "0x0a98"));
        expect(result).to.equal(null);
    });

    it("(F7) RCP-level <err> in response body → returns null", async () => {
        const body = Buffer.from('<?xml version="1.0"?><rcp><err>ERROR_ACCESS_DENIED</err></rcp>');
        const result = await withAdapter(makeRcpAdaptor(body), () =>
            fetchRcpLan(VALID_CREDS, "0x0a98"),
        );
        expect(result).to.equal(null);
    });

    it("(F8) happy path: <str>HEX</str> response → decoded bytes returned", async () => {
        // A realistic RCP 0xff00 version response: 4 bytes → 1.2.38.150
        const hexPayload = "0102" + "2696"; // 0x01 0x02 0x26 0x96
        const body = Buffer.from(`<rcp><str>${hexPayload}</str></rcp>`);
        const result = await withAdapter(makeRcpAdaptor(body), () =>
            fetchRcpLan(VALID_CREDS, "0xff00"),
        );
        expect(result).to.not.equal(null);
        expect(result!.length).to.equal(4);
        expect(result![0]).to.equal(0x01);
        expect(result![1]).to.equal(0x02);
        expect(result![2]).to.equal(0x26);
        expect(result![3]).to.equal(0x96);
    });

    it("(F9) raw binary fallback: body doesn't start with '<' and has no <str> → returned as-is", async () => {
        // Non-XML response: raw bytes that don't start with 0x3c ('<')
        const rawBytes = Buffer.from([0x01, 0x02, 0x26, 0x96]);
        const result = await withAdapter(makeRcpAdaptor(rawBytes), () =>
            fetchRcpLan(VALID_CREDS, "0xff00"),
        );
        expect(result).to.not.equal(null);
        expect(result!.equals(rawBytes)).to.equal(true);
    });

    it("(F10) XML body starting with '<' but no <str> match → returns null", async () => {
        // e.g. an unknown XML tag that isn't <str>
        const body = Buffer.from("<rcp><data>42</data></rcp>");
        const result = await withAdapter(makeRcpAdaptor(body), () =>
            fetchRcpLan(VALID_CREDS, "0x0a98"),
        );
        expect(result).to.equal(null);
    });

    it("(F11) empty body not starting with '<' → returns null (raw.length === 0 branch)", async () => {
        const body = Buffer.alloc(0);
        const result = await withAdapter(makeRcpAdaptor(body), () =>
            fetchRcpLan(VALID_CREDS, "0x0a98"),
        );
        expect(result).to.equal(null);
    });

    it("(F12) network error thrown by digestRequest → returns null (catch branch)", async () => {
        const original = axios.defaults.adapter;
        axios.defaults.adapter = (() =>
            Promise.reject(new Error("ECONNREFUSED"))) as unknown as AxiosAdapter;
        try {
            const result = await fetchRcpLan(VALID_CREDS, "0x0a98");
            expect(result).to.equal(null);
        } finally {
            axios.defaults.adapter = original;
        }
    });

    it("(F13) <str> tag with mixed-case hex is decoded correctly", async () => {
        // Verify case-insensitive hex match works: /[0-9a-fA-F]+/i
        const hexPayload = "DEADBEEF";
        const body = Buffer.from(`<rcp><str>${hexPayload}</str></rcp>`);
        const result = await withAdapter(makeRcpAdaptor(body), () =>
            fetchRcpLan(VALID_CREDS, "0xff00"),
        );
        expect(result).to.not.equal(null);
        expect(result![0]).to.equal(0xde);
        expect(result![1]).to.equal(0xad);
        expect(result![2]).to.equal(0xbe);
        expect(result![3]).to.equal(0xef);
    });
});

// ── parseOnvifScopes ──────────────────────────────────────────────────────────

describe("parseOnvifScopes()", () => {
    it("(S1) full ONVIF payload: name + hardware + profile extracted", () => {
        const payload = [
            "onvif://www.onvif.org/name/Bosch%20Smart%20Home%20Camera",
            "onvif://www.onvif.org/hardware/HOME_Eyes_Outdoor",
            "onvif://www.onvif.org/Profile/Streaming",
            "onvif://www.onvif.org/Profile/G",
        ].join("\x00");

        const result = parseOnvifScopes(Buffer.from(payload, "ascii"));

        expect(result.supported).to.equal(true);
        expect(result.name).to.equal("Bosch Smart Home Camera");
        expect(result.hardware).to.equal("HOME_Eyes_Outdoor");
        expect(result.profiles).to.deep.equal(["Streaming", "G"]);
        expect(result.raw_scopes.length).to.equal(4);
    });

    it("(S2) non-ONVIF scope lines are skipped", () => {
        const payload = [
            "onvif://www.onvif.org/name/TestCam",
            "http://other.example.com/scope",
            "not-a-scope-at-all",
        ].join("\x00");

        const result = parseOnvifScopes(Buffer.from(payload, "ascii"));

        expect(result.name).to.equal("TestCam");
        expect(result.hardware).to.equal("");
        expect(result.profiles).to.deep.equal([]);
    });

    it("(S3) ONVIF scope with no slash after prefix is skipped (line 162 branch)", () => {
        // "onvif://www.onvif.org/" followed by a key with NO slash → slashIdx === -1 → continue
        const payload = [
            "onvif://www.onvif.org/namewithoutvalue", // no trailing slash
            "onvif://www.onvif.org/hardware/CAMERA_360",
        ].join("\x00");

        const result = parseOnvifScopes(Buffer.from(payload, "ascii"));

        // The slash-less scope must be silently skipped
        expect(result.name).to.equal("");
        // The valid hardware line must still be parsed
        expect(result.hardware).to.equal("CAMERA_360");
    });

    it("(S4) unknown key (not name/hardware/Profile) is ignored without error", () => {
        const payload = [
            "onvif://www.onvif.org/type/Network_Video_Transmitter",
            "onvif://www.onvif.org/hardware/CAMERA_EYES",
        ].join("\x00");

        const result = parseOnvifScopes(Buffer.from(payload, "ascii"));

        expect(result.hardware).to.equal("CAMERA_EYES");
        expect(result.name).to.equal("");
    });

    it("(S5) URL-encoded + URL name is decoded correctly (with + sign)", () => {
        // decodeURIComponent + .replace(/\+/g, ' ')
        const payload = "onvif://www.onvif.org/name/Bosch+Smart+Home+Camera";
        const result = parseOnvifScopes(Buffer.from(payload, "ascii"));
        expect(result.name).to.equal("Bosch Smart Home Camera");
    });

    it("(S6) percent-encoded name decoded correctly", () => {
        const payload = "onvif://www.onvif.org/name/Bosch%20Smart%20Home%20Camera%20360";
        const result = parseOnvifScopes(Buffer.from(payload, "ascii"));
        expect(result.name).to.equal("Bosch Smart Home Camera 360");
    });

    it("(S7) newline-separated scopes (not only null bytes)", () => {
        const payload =
            "onvif://www.onvif.org/name/Cam1\nonvif://www.onvif.org/hardware/CAM_H1\r\n";
        const result = parseOnvifScopes(Buffer.from(payload, "ascii"));
        expect(result.name).to.equal("Cam1");
        expect(result.hardware).to.equal("CAM_H1");
    });

    it("(S8) empty buffer → supported:true with empty fields (no crash)", () => {
        const result = parseOnvifScopes(Buffer.alloc(0));
        expect(result.supported).to.equal(true);
        expect(result.name).to.equal("");
        expect(result.hardware).to.equal("");
        expect(result.profiles).to.deep.equal([]);
    });

    it("(S9) malformed input that causes decodeURIComponent to throw → catch path, still returns partial result", () => {
        // Inject a scope with invalid URI encoding to trigger decodeURIComponent throw (line 176 catch)
        // We force the exception by passing a Buffer whose .toString() implementation throws.
        // Simpler approach: malformed percent-encoding in the ONVIF scope.
        // '%E0%80' is an overlong/invalid UTF-8 sequence that decodeURIComponent rejects.
        const payload = "onvif://www.onvif.org/name/%E0%80";
        // Node's decodeURIComponent throws URIError for this sequence.
        const result = parseOnvifScopes(Buffer.from(payload, "ascii"));
        // The catch block must swallow the error; result.supported stays true
        expect(result.supported).to.equal(true);
        // name may or may not be set depending on whether the throw happened; either way no crash
    });
});

// ── formatRcpVersion ──────────────────────────────────────────────────────────

describe("formatRcpVersion()", () => {
    it("(V1) 4-byte buffer → dotted version string", () => {
        const buf = Buffer.from([1, 2, 38, 150]);
        expect(formatRcpVersion(buf)).to.equal("1.2.38.150");
    });

    it("(V2) exactly 4 bytes → all four octets formatted", () => {
        const buf = Buffer.from([9, 40, 102, 0]);
        expect(formatRcpVersion(buf)).to.equal("9.40.102.0");
    });

    it("(V3) longer buffer (> 4 bytes) → first 4 octets only", () => {
        const buf = Buffer.from([7, 91, 56, 0, 255, 255]);
        expect(formatRcpVersion(buf)).to.equal("7.91.56.0");
    });

    it("(V4) 3-byte buffer (too short) → returns null", () => {
        const buf = Buffer.from([1, 2, 3]);
        expect(formatRcpVersion(buf)).to.equal(null);
    });

    it("(V5) empty buffer → returns null", () => {
        expect(formatRcpVersion(Buffer.alloc(0))).to.equal(null);
    });

    it("(V6) all-zero bytes → '0.0.0.0'", () => {
        expect(formatRcpVersion(Buffer.from([0, 0, 0, 0]))).to.equal("0.0.0.0");
    });

    it("(V7) max-value bytes → '255.255.255.255'", () => {
        expect(formatRcpVersion(Buffer.from([255, 255, 255, 255]))).to.equal(
            "255.255.255.255",
        );
    });
});
