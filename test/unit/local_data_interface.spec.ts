/**
 * Unit tests for src/lib/local_data_interface.ts
 *
 * Pins every status mapping, the firmware gate, password parsing and the
 * direct stream URL builder (fake values only).
 */

import { expect } from "chai";
import axios from "axios";

import {
    buildLocalStreamUrl,
    fetchLdiStatus,
    firmwareSupportsLdi,
    isLdiEligible,
    isSafeLanHost,
    isValidPassword,
    maskUrl,
    parseFirmware,
    passwordForCamera,
    stateFromResponse,
} from "../../src/lib/local_data_interface";
import { stubAxiosSequence, restoreAxios } from "./helpers/axios-mock";

const CAM = "11111111-2222-3333-4444-555555555555";

afterEach(() => restoreAxios());

describe("firmware gate", () => {
    const cases: Array<[unknown, boolean]> = [
        ["9.40.105", true],
        ["9.40.104", false],
        ["9.40.202", true],
        ["9.41.0", true],
        ["10.0.0", true],
        ["9.40", false],
        ["9.40.105.1", true],
        ["  9.40.105 ", true],
        [null, false],
        [undefined, false],
        [12345, false],
        ["", false],
        ["garbage", false],
        ["9.40.x", false],
        ["9..105", false],
        ["9.40.105-beta", false],
        ["9.40." + "9".repeat(400), false],
        ["٩.٤٠.١٠٥", false],
    ];
    for (const [input, expected] of cases) {
        it(`${JSON.stringify(input)?.slice(0, 30)} -> ${expected}`, () => {
            expect(firmwareSupportsLdi(input)).to.equal(expected);
        });
    }
    it("parseFirmware returns numeric tuple", () => {
        expect(parseFirmware("9.40.105")).to.deep.equal([9, 40, 105]);
        expect(parseFirmware("x")).to.equal(null);
    });
    it("Gen1 is never eligible, even with new firmware", () => {
        expect(isLdiEligible(1, "9.40.202")).to.equal(false);
        expect(isLdiEligible(2, "9.40.202")).to.equal(true);
        expect(isLdiEligible(2, "9.40.104")).to.equal(false);
        expect(isLdiEligible(2, null)).to.equal(false);
    });
});

describe("stateFromResponse", () => {
    it("200 + username -> active", () =>
        expect(stateFromResponse(200, { username: "localuser" })).to.equal("active"));
    it("200 + malformed body -> keep", () => {
        expect(stateFromResponse(200, {})).to.equal(null);
        expect(stateFromResponse(200, null)).to.equal(null);
        expect(stateFromResponse(200, "x")).to.equal(null);
        expect(stateFromResponse(200, { username: 5 })).to.equal(null);
    });
    it("404 -> inactive", () => expect(stateFromResponse(404, null)).to.equal("inactive"));
    it("449 -> unsupported", () => expect(stateFromResponse(449, null)).to.equal("unsupported"));
    it("anything else -> keep", () => {
        for (const s of [204, 400, 401, 403, 500, 503]) {
            expect(stateFromResponse(s, { username: "x" })).to.equal(null);
        }
    });
});

describe("fetchLdiStatus", () => {
    const client = () => axios.create();
    it("active", async () => {
        stubAxiosSequence([{ status: 200, data: { username: "localuser" } }]);
        expect(await fetchLdiStatus(client(), "tok", CAM)).to.equal("active");
    });
    it("inactive", async () => {
        stubAxiosSequence([{ status: 404, data: { error: "x" } }]);
        expect(await fetchLdiStatus(client(), "tok", CAM)).to.equal("inactive");
    });
    it("449", async () => {
        stubAxiosSequence([{ status: 449, data: null }]);
        expect(await fetchLdiStatus(client(), "tok", CAM)).to.equal("unsupported");
    });
    it("garbage body -> null", async () => {
        stubAxiosSequence([{ status: 200, data: "<html>" }]);
        expect(await fetchLdiStatus(client(), "tok", CAM)).to.equal(null);
    });
    it("server error -> null", async () => {
        stubAxiosSequence([{ status: 503, data: null }]);
        expect(await fetchLdiStatus(client(), "tok", CAM)).to.equal(null);
    });
    it("network error -> null", async () => {
        stubAxiosSequence([]);
        axios.defaults.adapter = () => Promise.reject(new Error("ECONNRESET"));
        expect(await fetchLdiStatus(client(), "tok", CAM)).to.equal(null);
    });
});

describe("passwords", () => {
    it("valid / invalid format", () => {
        expect(isValidPassword("test-pw")).to.equal(true);
        for (const bad of ["", "a b", "a,b", "a;b", "a\nb", "ä", "x".repeat(129), null, 5]) {
            expect(isValidPassword(bad), String(bad)).to.equal(false);
        }
    });
    it("lookup by full id, case-insensitive, and 8-char prefix", () => {
        expect(passwordForCamera(`${CAM}=test-pw`, CAM)).to.equal("test-pw");
        expect(passwordForCamera(`${CAM.toUpperCase()}=test-pw`, CAM)).to.equal("test-pw");
        expect(passwordForCamera("11111111=test-pw", CAM)).to.equal("test-pw");
    });
    it("several entries", () => {
        const raw = `22222222=other, 11111111=test-pw;33333333=x`;
        expect(passwordForCamera(raw, CAM)).to.equal("test-pw");
    });
    it("no match / empty / malformed", () => {
        expect(passwordForCamera("22222222=pw", CAM)).to.equal(null);
        expect(passwordForCamera("", CAM)).to.equal(null);
        expect(passwordForCamera(undefined, CAM)).to.equal(null);
        expect(passwordForCamera("11111111", CAM)).to.equal(null);
        expect(passwordForCamera("=pw", CAM)).to.equal(null);
        expect(passwordForCamera("11111111=", CAM)).to.equal(null);
        expect(passwordForCamera("1111=pw", CAM)).to.equal(null);
    });
    it("password containing '=' keeps the remainder", () => {
        expect(passwordForCamera("11111111=a=b", CAM)).to.equal("a=b");
    });
});

describe("LAN host validation", () => {
    it("accepts private LAN addresses", () => {
        for (const h of ["10.0.0.5", "172.16.0.1", "172.31.255.1", "192.168.1.9", "fd12::1"]) {
            expect(isSafeLanHost(h), h).to.equal(true);
        }
    });
    it("rejects loopback, link-local, unspecified, public, garbage", () => {
        for (const h of [
            "127.0.0.1",
            "0.0.0.0",
            "169.254.1.1",
            "8.8.8.8",
            "172.32.0.1",
            "::1",
            "::",
            "fe80::1",
            "2001:db8::1",
            "cam.local",
            "",
            "10.0.0.5@evil.example",
            null,
            undefined,
        ]) {
            expect(isSafeLanHost(h), String(h)).to.equal(false);
        }
    });
});

describe("buildLocalStreamUrl / maskUrl", () => {
    it("builds rtsps URL with fixed user and port", () => {
        expect(buildLocalStreamUrl("10.0.0.5", "test-pw")).to.equal(
            "rtsps://localuser:test-pw@10.0.0.5:9554/live",
        );
    });
    it("url-quotes the password", () => {
        expect(buildLocalStreamUrl("10.0.0.5", "a@b/c:d#e")).to.equal(
            "rtsps://localuser:a%40b%2Fc%3Ad%23e@10.0.0.5:9554/live",
        );
    });
    it("brackets IPv6", () => {
        expect(buildLocalStreamUrl("fd12::1", "pw")).to.equal(
            "rtsps://localuser:pw@[fd12::1]:9554/live",
        );
    });
    it("unsafe host or bad password -> null", () => {
        expect(buildLocalStreamUrl("8.8.8.8", "pw")).to.equal(null);
        expect(buildLocalStreamUrl(undefined, "pw")).to.equal(null);
        expect(buildLocalStreamUrl("10.0.0.5", "a b")).to.equal(null);
        expect(buildLocalStreamUrl("10.0.0.5", "")).to.equal(null);
    });
    it("maskUrl hides the credentials", () => {
        const masked = maskUrl("rtsps://localuser:test-pw@10.0.0.5:9554/live");
        expect(masked).to.equal("rtsps://***@10.0.0.5:9554/live");
        expect(masked).to.not.contain("test-pw");
    });
});
