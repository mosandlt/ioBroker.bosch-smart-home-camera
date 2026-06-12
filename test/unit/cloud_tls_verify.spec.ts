/**
 * Regression tests for the Bosch CLOUD TLS verification — forum #84538.
 *
 * Bug (shipped v1.5.1, reported by Reiner on 2026-06-12 with v1.5.2):
 *   The CWE-295 fix pinned ONLY the Bosch intermediate "Video CA 2A" in
 *   `https.Agent({ ca: [...rootCertificates, BOSCH_CLOUD_CA_PEM] })`. Node has
 *   no equivalent of OpenSSL's PARTIAL_CHAIN flag (nodejs/node#36453), so it
 *   could not anchor the chain at the intermediate and every cloud handshake
 *   failed with `UNABLE_TO_GET_ISSUER_CERT` ("unable to get issuer certificate").
 *   The adapter then could not complete camera discovery on startup:
 *     "Camera discovery failed on startup (Cameras API network error: unable to
 *      get issuer certificate) … No persisted camera state found — cannot start"
 *
 * Fix: `verifyCloudPeerCert()` emulates the HA/Python ssl context
 *   (system roots ∪ Video CA 2A, VERIFY_X509_PARTIAL_CHAIN): accept a peer iff
 *   hostname + validity are good AND (chain valid to a system root OR leaf
 *   signed by the pinned Bosch intermediate). These tests pin every branch with
 *   synthetic fixtures (a stand-in "Test Pin CA", a leaf it signed, and an
 *   unrelated self-signed cert) and assert the shipped pin's identity.
 *
 * Framework: Mocha + Chai.
 */

import { expect } from "chai";
import * as crypto from "crypto";

import {
    verifyCloudPeerCert,
    BoschCloudAgent,
    BOSCH_CLOUD_CA_PEM,
    createCloudHttpClient,
} from "../../src/lib/auth";

// ── Synthetic fixtures (FAKE test certificates — never real device values) ─────
// "Test Pin CA" — stand-in for the pinned Bosch intermediate.
const PIN_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIDHzCCAgegAwIBAgIUf7WHULbZwAlSrxsqpYh5dQmK+fowDQYJKoZIhvcNAQEL
BQAwFjEUMBIGA1UEAwwLVGVzdCBQaW4gQ0EwIBcNMjYwNjEyMTg0MDE5WhgPMjA1
OTA0MjAxODQwMTlaMBYxFDASBgNVBAMMC1Rlc3QgUGluIENBMIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnt2tRrBlJEXqshLzqQFj8qbQ+z0/k7MAofum
9vpB82IP+gvYHNVyG2LVxLkVlxQRq1ldo6GPATJJp4Y2bgRJdASZjbPiHEOV2TZc
xcEs0l9JdXf5XFR0O+txFR03Rm0CbiaU8JfJV26X4MDIGxCJ+ZUdJ5OS5WxS81ls
w+0rvn0UrcmFN8c+tH9UWOYXLBY05vb99pyS/D6MAFBRGF9EL1wF8CLCuDI5i7fF
XrrnxFSN+YNaWEL0HlD8+k0y4fl53NP4a7AUkogQ+/t8ORCdn5co/wpVhlX1cPIy
oNXhHt3SqRg3wUrgBYTkbV3GDHBa6z00T5RzU46SOOKpE4WSPwIDAQABo2MwYTAd
BgNVHQ4EFgQUwKYkW7tbJBRYFzwYwZEBegi1FU4wHwYDVR0jBBgwFoAUwKYkW7tb
JBRYFzwYwZEBegi1FU4wDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAgQw
DQYJKoZIhvcNAQELBQADggEBAG7JRYEieITcqz9tRxfnvDdh8gqEy2D+7pgk6692
aFXDI3CLZw56HorJTFPQrMzvg7BdXuEe8t8ZN1V7a6eMnIC7qfPVwRCCgXaJZs4Z
DS7MTIOVgXckb+lQSPvbq6hRwIAu38HA6ReciJLyaq5Ff3FG5D9wSIrZwwVc/OfR
BQmsYj5/9kDDqQYlgQXW8qbOWspvTZ4Nl1pgx1B7VjxkZFtLa0Rinq3KgSu4oGgP
GvU4fxXX3hnwxkImTq7K6pkW9KUVu3rJ9qjR9TD+fkbD2mQswbNVOJ0Tk0Htqtme
V04QMdNTX7Xyo4k39cfEaxZHvh1BBQ97OptP6aZ2nrtUnqM=
-----END CERTIFICATE-----`;

// Leaf signed by "Test Pin CA", SAN=test.bosch.example, valid 2025-01-01..2027-01-01.
const LEAF_SIGNED_PEM = `-----BEGIN CERTIFICATE-----
MIIDIjCCAgqgAwIBAgIUARYkvQp0O54Bf46h36FFDkfi5DYwDQYJKoZIhvcNAQEL
BQAwFjEUMBIGA1UEAwwLVGVzdCBQaW4gQ0EwHhcNMjUwMTAxMDAwMDAwWhcNMjcw
MTAxMDAwMDAwWjAdMRswGQYDVQQDDBJ0ZXN0LmJvc2NoLmV4YW1wbGUwggEiMA0G
CSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDtnu2fpACW0LboJREeLdq1T9KuRCWk
UdZ3D9OP+pt5yBawDXWnVEsggEAzpLMKpkYEE6MHdx/6omJb97DABXbdUeQiQxFT
iBIDbLc7gK26jQN97X8WcLiPNLX9BpJ+RAgT4AWM4atECyh/jUIOpBa4TMCewr0P
lzumfYGNbXs1lh7Yc5USZDTdkMhXl7BiE3bbVAeHFUlHdGHyYUN7PtAKQKa3Oane
yy8/9S98P+NpaFussw3Rol2crSDE1FhPundRAU/mdggNGbFY6gwvvIBSQrzlBJs2
rwi4yw4FNPFpkX1gGXm1zPANsavsAzPQ03zoFhUCN7qZB2enXmDYEGc3AgMBAAGj
YTBfMB0GA1UdEQQWMBSCEnRlc3QuYm9zY2guZXhhbXBsZTAdBgNVHQ4EFgQU4pbU
Up0vbqkBRHLUb6s2pITOre4wHwYDVR0jBBgwFoAUwKYkW7tbJBRYFzwYwZEBegi1
FU4wDQYJKoZIhvcNAQELBQADggEBACJKPqKzHjHRMZrDsZnctMl64TbK7LFOXFwG
GZpMNXBal6ptRIauQwScnfRascwOdT82uqEXipaDx3jfBYVh5Hm1RfFrndj2MjVj
Mw+rZhFymMTP11z4j65lWxelefTmbLCU6XthfoJ3Zi4tNQEnUGVsM9HB+JxpSU57
T/e3Z+f4vezwUB0Hf44xe2p02fyUIBiYpMTbMvYZRJERkVCGJdMMTjD60UkoDF+8
vL6X5zVJywProjpfe98EczLtD4EvH21WjPFv6MeyDyfd5ssn8iIsX/zZcP35OaDx
nMd25JglMR8beXRwXW0HONtFQ34iuZIk0WNYGe2iq5A8x4T0+90=
-----END CERTIFICATE-----`;

// Unrelated self-signed cert, SAN=other.example — NOT signed by "Test Pin CA".
const OTHER_PEM = `-----BEGIN CERTIFICATE-----
MIIDLTCCAhWgAwIBAgIUb5mmf5E6ARKTqx6EUt++FofMQWAwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNb3RoZXIuZXhhbXBsZTAgFw0yNjA2MTIxODQwMjBaGA8y
MDU5MDQyMDE4NDAyMFowGDEWMBQGA1UEAwwNb3RoZXIuZXhhbXBsZTCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBAMD+6O0YEOIbzO9K4cSW1npBi0oKNArw
rQThbsiCpMUfsHtIYZ47iL482lvC4bsoKYbb1NsjYn59UOLy0BCYg1mV87BxrjgM
wHdH1JQUXDXCbE18i9hkT4dwiELlAp4S5yjxGKyrclnsos1lhBY6tAYcoNKjL1f+
BjY7zV4f7VxJDKeRtsi+cKpNbBMNUooCTs5KQ2T21ucBG6ixGIJLKBusjk7Hm+b3
0ECbdMvS5op+ixg810dmLm4NEFSmEhbqmklhLp9vJMkbId7HZV1v5/ej9mOfp4Te
014VKJCdcl76PRKEVwt24KhpYEo3gf8g4X4LbiSJgn49cxyQUlSEH2MCAwEAAaNt
MGswHQYDVR0OBBYEFN8/QcRmgk/EsAWytcI7gDvl6nKcMB8GA1UdIwQYMBaAFN8/
QcRmgk/EsAWytcI7gDvl6nKcMA8GA1UdEwEB/wQFMAMBAf8wGAYDVR0RBBEwD4IN
b3RoZXIuZXhhbXBsZTANBgkqhkiG9w0BAQsFAAOCAQEAnv9bjbBt8gqkaSzUwj7+
pjdyvgmYPcmCPVB+roToNCVJqw8WJJ7ybAWhOTfaxjn0eEQ5Xu42SCO5VXynTRqu
eCnbPlmLkAEmB7loPUkIlTvL+TJprsZIwJA4I2kPviWO5vHvAm5CaoKhrSHmckqK
6KnUOEHK7rrKcvqpt8utvoTOx8Z2NxeU92CKA/xEyRs0uv5Cv6asS8+hu9KRxshG
xNNarAyD+Gw3p/OBAzdDHu5wktZ1OLLhL1cMwod+SAMwxmsekqo9gtgjyYkIdhe5
K1OFZ55bXq8U1wz29mLXLHR2WY77l6LjQIjH2/teGMyOQGo1LBAXSAvlQD6ospog
Bg==
-----END CERTIFICATE-----`;

const PIN = new crypto.X509Certificate(PIN_CA_PEM);
const LEAF_DER = new crypto.X509Certificate(LEAF_SIGNED_PEM).raw;
const OTHER_DER = new crypto.X509Certificate(OTHER_PEM).raw;

const NOW_VALID = Date.parse("2026-09-01T00:00:00Z"); // within both fixture windows
const NOW_EXPIRED = Date.parse("2028-01-01T00:00:00Z"); // after notAfter
const NOW_TOO_EARLY = Date.parse("2024-01-01T00:00:00Z"); // before notBefore
const HOST = "test.bosch.example";

describe("verifyCloudPeerCert — Bosch cloud TLS (forum #84538 regression)", () => {
    it("ACCEPTS a leaf signed by the pinned intermediate (partial-chain path, the #84538 fix)", () => {
        // authorized=false simulates Node's UNABLE_TO_GET_ISSUER_CERT for the private Bosch PKI
        const result = verifyCloudPeerCert(
            LEAF_DER,
            false,
            "UNABLE_TO_GET_ISSUER_CERT",
            HOST,
            PIN,
            NOW_VALID,
        );
        expect(result).to.equal(null);
    });

    it("ACCEPTS any leaf whose chain validated to a trusted system root (OAuth / Let's Encrypt path)", () => {
        // authorized=true + hostname match → trusted regardless of the pin (e.g. smarthome.authz.bosch.com)
        const result = verifyCloudPeerCert(
            OTHER_DER,
            true,
            undefined,
            "other.example",
            PIN,
            NOW_VALID,
        );
        expect(result).to.equal(null);
    });

    it("REJECTS a MITM cert not signed by the pin and not chaining to a system root", () => {
        const result = verifyCloudPeerCert(
            OTHER_DER,
            false,
            "SELF_SIGNED_CERT_IN_CHAIN",
            "other.example",
            PIN,
            NOW_VALID,
        );
        expect(result).to.be.instanceOf(Error);
        expect(result?.message).to.contain("not trusted");
        expect(result?.message).to.contain("SELF_SIGNED_CERT_IN_CHAIN");
    });

    it("REJECTS a hostname mismatch even on the pinned path", () => {
        const result = verifyCloudPeerCert(
            LEAF_DER,
            false,
            undefined,
            "evil.example",
            PIN,
            NOW_VALID,
        );
        expect(result).to.be.instanceOf(Error);
        expect(result?.message).to.contain("hostname");
    });

    it("REJECTS a hostname mismatch even when the chain is system-root trusted", () => {
        const result = verifyCloudPeerCert(
            LEAF_DER,
            true,
            undefined,
            "evil.example",
            PIN,
            NOW_VALID,
        );
        expect(result).to.be.instanceOf(Error);
        expect(result?.message).to.contain("hostname");
    });

    it("REJECTS an expired certificate (now after notAfter)", () => {
        const result = verifyCloudPeerCert(LEAF_DER, false, undefined, HOST, PIN, NOW_EXPIRED);
        expect(result).to.be.instanceOf(Error);
        expect(result?.message).to.contain("validity window");
    });

    it("REJECTS a not-yet-valid certificate (now before notBefore)", () => {
        const result = verifyCloudPeerCert(LEAF_DER, false, undefined, HOST, PIN, NOW_TOO_EARLY);
        expect(result).to.be.instanceOf(Error);
        expect(result?.message).to.contain("validity window");
    });

    it("REJECTS when no peer certificate is presented", () => {
        const result = verifyCloudPeerCert(undefined, true, undefined, HOST, PIN, NOW_VALID);
        expect(result).to.be.instanceOf(Error);
        expect(result?.message).to.contain("no peer certificate");
    });

    it("default pin is the genuine Bosch 'Video CA 2A' intermediate (guards against cert swap)", () => {
        const shipped = new crypto.X509Certificate(BOSCH_CLOUD_CA_PEM);
        expect(shipped.subject).to.contain("Video CA 2A");
        expect(shipped.issuer).to.contain("Bosch ST Root CA");
        // SHA-256 fingerprint pinned in CLAUDE.md / GHSA-6qh5-x5m5-vj6v
        expect(shipped.fingerprint256).to.equal(
            "9F:6A:CB:6D:79:38:60:A3:B1:B4:37:EA:D3:A7:D5:A6:28:D0:28:8E:24:41:52:A5:E9:C9:6B:36:51:D6:01:D1",
        );
    });
});

describe("BoschCloudAgent wiring", () => {
    it("createCloudHttpClient() uses a BoschCloudAgent (not a plain https.Agent)", () => {
        const client = createCloudHttpClient();
        expect(client.defaults.httpsAgent).to.be.instanceOf(BoschCloudAgent);
    });
});
