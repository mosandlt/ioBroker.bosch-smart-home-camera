/**
 * Regression tests for the @aracna/fcm "Invalid EC key" fix, now a runtime
 * wrapper around http_ece.decrypt (src/lib/fcm_ece_wrapper.ts).
 *
 * Drives the REAL FcmClient (loaded exactly like src/lib/fcm.ts loads it: CJS
 * require of "@aracna/fcm" -> index.cjs) with synthetic, FAKE-key ECE (aesgcm)
 * payloads in a DataMessageStanza, for both header layouts:
 *   - dh/salt extra segments after the field   ("dh=K;p256ecdsa=V", "salt=S;rs=4096")
 *   - dh/salt NOT the first segment            ("p256ecdsa=V;dh=K", "rs=4096;salt=S")
 */
import { expect } from "chai";
import * as crypto from "node:crypto";
import { createRequire } from "node:module";
import { Writer } from "protobufjs/minimal";
import { FcmClient, createFcmECDH, generateFcmAuthSecret } from "@aracna/fcm";
import {
    ECE_ORIGINAL,
    getFcmEceWrapperStatus,
    installFcmEceWrapper,
    recoverEceField,
} from "../../src/lib/fcm_ece_wrapper";
import "../../src/lib/fcm"; // attaches the wrapper, like production

const fcmRequire = createRequire(require.resolve("@aracna/fcm"));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const eceModule = fcmRequire("http_ece") as {
    decrypt: ((...a: unknown[]) => Buffer) & { [k: symbol]: unknown };
    encrypt: (data: Buffer, params: Record<string, unknown>) => Buffer;
};

const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");

interface Sample {
    recv: crypto.ECDH;
    auth: Uint8Array;
    ciphertext: Buffer;
    dh: string;
    salt: string;
}

function makeSample(plain: string): Sample {
    const recv = createFcmECDH();
    const auth = generateFcmAuthSecret();
    const sender = crypto.createECDH("prime256v1");
    sender.generateKeys();
    const salt = crypto.randomBytes(16);
    const ciphertext = eceModule.encrypt(Buffer.from(plain), {
        version: "aesgcm",
        dh: b64u(recv.getPublicKey()),
        privateKey: sender,
        salt: b64u(salt),
        authSecret: b64u(auth),
    });
    return { recv, auth, ciphertext, dh: b64u(sender.getPublicKey()), salt: b64u(salt) };
}

function stanza(appData: [string, string][], raw: Buffer): Buffer {
    const w = Writer.create();
    w.uint32((3 << 3) | 2).string("gcm.googleapis.com");
    w.uint32((5 << 3) | 2).string("cat");
    for (const [k, v] of appData) {
        const a = Writer.create().uint32(10).string(k).uint32(18).string(v).finish();
        w.uint32((7 << 3) | 2).bytes(a);
    }
    w.uint32((21 << 3) | 2).bytes(raw);
    return Buffer.from(w.finish());
}

function feed(s: Sample, cryptoKey: string, encryption: string): { data?: unknown; err?: string } {
    const client = new FcmClient({
        acg: { id: "1", securityToken: "2" },
        ece: {
            authSecret: Uint8Array.from(s.auth),
            privateKey: Uint8Array.from(s.recv.getPrivateKey()),
        },
    });
    const out: { data?: unknown; err?: string } = {};
    client.on("message-data", (d: unknown) => {
        out.data = d;
    });
    const c = client as unknown as {
        data: { value: Buffer; cursor: number; tag: number };
        onSocketDataBytes: () => void;
    };
    c.data.value = stanza(
        [
            ["crypto-key", cryptoKey],
            ["encryption", encryption],
        ],
        s.ciphertext,
    );
    c.data.cursor = 0;
    c.data.tag = 8;
    try {
        c.onSocketDataBytes();
    } catch (e) {
        out.err = e instanceof Error ? e.message : String(e);
    }
    return out;
}

const LAYOUTS: [string, (s: Sample) => [string, string]][] = [
    ["plain", s => [`dh=${s.dh}`, `salt=${s.salt}`]],
    ["extra trailing segments", s => [`dh=${s.dh};p256ecdsa=FAKEVAPID`, `salt=${s.salt};rs=4096`]],
    ["reordered segments", s => [`p256ecdsa=FAKEVAPID;dh=${s.dh}`, `rs=4096;salt=${s.salt}`]],
    ["comma, spaces, quotes", s => [`keyid=x, dh="${s.dh}"`, `rs=4096 ; salt=${s.salt}`]],
];

describe("@aracna/fcm runtime wrapper (http_ece.decrypt)", () => {
    const wrapper = eceModule.decrypt;

    it("the adapter loads @aracna/fcm through index.cjs (the CJS bundle)", () => {
        expect(require.resolve("@aracna/fcm")).to.match(/index\.cjs$/);
    });

    it("attaches at import and reports attached", () => {
        expect(getFcmEceWrapperStatus().attached).to.equal(true);
        expect(wrapper[ECE_ORIGINAL]).to.be.a("function");
    });

    it("is idempotent (second install does not double-wrap)", () => {
        installFcmEceWrapper();
        expect(eceModule.decrypt).to.equal(wrapper);
        expect(installFcmEceWrapper({ decrypt: wrapper }).attached).to.equal(true);
    });

    for (const [name, headers] of LAYOUTS) {
        describe(`layout: ${name}`, () => {
            it("WITH wrapper: message decrypts", () => {
                const s = makeSample(JSON.stringify({ hello: name }));
                const [ck, en] = headers(s);
                const r = feed(s, ck, en);
                expect(r.err).to.equal(undefined);
                expect(r.data).to.deep.equal({ hello: name });
            });

            if (name !== "plain") {
                it("WITHOUT wrapper (original library): fails - proves the bug", () => {
                    const original = wrapper[ECE_ORIGINAL] as typeof eceModule.decrypt;
                    eceModule.decrypt = original;
                    try {
                        const s = makeSample("{}");
                        const [ck, en] = headers(s);
                        const r = feed(s, ck, en);
                        expect(r.data).to.equal(undefined);
                        expect(r.err).to.be.a("string");
                    } finally {
                        eceModule.decrypt = wrapper;
                    }
                });
            }
        });
    }

    it("garbage headers do not crash the wrapper: original error is rethrown", () => {
        const s = makeSample("{}");
        for (const [ck, en] of [
            ["", ""],
            [";;;", ",,,"],
            ["dh=", "salt="],
            ["\u0000\u0001", "%%%"],
        ]) {
            const r = feed(s, ck, en);
            expect(r.data).to.equal(undefined);
            expect(r.err).to.be.a("string");
        }
    });

    it("non-object params / missing fields are passed through untouched", () => {
        expect(() => eceModule.decrypt(Buffer.alloc(0), undefined as never)).to.throw();
        expect(() => eceModule.decrypt(Buffer.alloc(0), {})).to.throw();
    });

    it("reports not attached (no throw) when decrypt is missing or read-only", () => {
        expect(installFcmEceWrapper({}).attached).to.equal(false);
        const frozen = Object.freeze({ decrypt: () => Buffer.alloc(0) });
        const r = installFcmEceWrapper(frozen);
        expect(r.attached).to.equal(false);
        expect(r.reason).to.be.a("string");
    });
});

describe("recoverEceField()", () => {
    it("first segment: drops trailing segments", () => {
        expect(recoverEceField("KEY;p256ecdsa=V", "dh=")).to.equal("KEY");
    });
    it("later segment: finds it by name, case-insensitive", () => {
        expect(recoverEceField("56ecdsa=V;DH=KEY", "dh=")).to.equal("KEY");
    });
    it("strips quotes and whitespace", () => {
        expect(recoverEceField(' "KEY" ', "dh=")).to.equal("KEY");
    });
    it("non-string input yields undefined", () => {
        expect(recoverEceField(undefined, "dh=")).to.equal(undefined);
        expect(recoverEceField(42, "dh=")).to.equal(undefined);
    });
});
