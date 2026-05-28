/**
 * Additional unit tests for src/lib/rtsp_auth.ts — edge / error branches.
 *
 * The main happy-path and regression tests live in rtsp_auth.spec.ts.
 * This file adds targeted coverage for:
 *
 *   - injectAuthHeader: buffer without \r\n\r\n → returns request unchanged (line 360)
 *   - AUTH_RESPONDING + 401 with trailing data → trailing forwarded to client (line 252-254)
 *   - AUTH_RESPONDING + 200 with trailing data AND pending clientBuf → both replayed (lines 269-274)
 *   - AUTH_NEED: 401 with WWW-Authenticate but invalid Digest scheme → cannot compute, PASSTHROUGH (lines 182-228)
 *   - AUTH_NEED: 401 with NO WWW-Authenticate header → cannot compute, PASSTHROUGH (lines 215-229)
 *   - AUTH_NEED: non-401 status code while in AUTH_NEED → "other status" forward path (lines 279-284)
 *   - AUTH_RESPONDING: non-200/non-401 status → "other status" forward path (lines 279-284)
 *   - INJECTING mode: parseRequestStartLine returns null → falls back to forwarding raw (line 156-158)
 *   - PASSTHROUGH with extra data buffered after the first request
 */

import { expect } from "chai";
import { EventEmitter } from "node:events";

import {
    attachRtspAuthHandler,
    injectAuthHeader,
} from "../../src/lib/rtsp_auth";

// ── FakeSocket (mirrors rtsp_auth.spec.ts) ─────────────────────────────────────

class FakeSocket extends EventEmitter {
    public writes: Buffer[] = [];
    public destroyed = false;
    public ended = false;
    write(buf: Buffer | string): boolean {
        this.writes.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf, "utf-8"));
        return true;
    }
    destroy(): void {
        this.destroyed = true;
    }
    end(): void {
        this.ended = true;
    }
    text(): string {
        return Buffer.concat(this.writes).toString("utf-8");
    }
}

function attach(
    client: FakeSocket,
    remote: FakeSocket,
): { logs: string[] } {
    const logs: string[] = [];
    attachRtspAuthHandler({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        clientSocket: client as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        remoteSocket: remote as any,
        digestUser: "cbs-testuser",
        digestPassword: "testpass",
        log: (level, msg) => logs.push(`[${level}] ${msg}`),
        camLabel: "test-cam",
    });
    return { logs };
}

/** Drive the auth dance to INJECTING state, return socket pair. */
function reachInjecting(): { client: FakeSocket; remote: FakeSocket; logs: string[] } {
    const client = new FakeSocket();
    const remote = new FakeSocket();
    const { logs } = attach(client, remote);

    client.emit(
        "data",
        Buffer.from(
            "OPTIONS rtsp://192.0.2.10:5544/rtsp_tunnel?inst=1 RTSP/1.0\r\nCSeq: 1\r\n\r\n",
            "utf-8",
        ),
    );
    remote.emit(
        "data",
        Buffer.from(
            'RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: Digest realm="bosch", nonce="n0nce", qop="auth"\r\n\r\n',
            "utf-8",
        ),
    );
    remote.emit("data", Buffer.from("RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n", "utf-8"));
    return { client, remote, logs };
}

// ── injectAuthHeader edge ─────────────────────────────────────────────────────

describe("rtsp_auth — injectAuthHeader edge cases", () => {
    it("buffer without \\r\\n\\r\\n → returned unchanged (line 360 branch)", () => {
        // No header terminator → sep < 0 → guard returns request as-is
        const req = Buffer.from("DESCRIBE rtsp://x/y RTSP/1.0\r\nCSeq: 2", "utf-8");
        const out = injectAuthHeader(req, 'Digest username="u"');
        // Must be the exact same buffer (by value)
        expect(out.equals(req), "returned unchanged when no \\r\\n\\r\\n").to.equal(true);
    });
});

// ── AUTH_RESPONDING + 401 with trailing data ──────────────────────────────────

describe("rtsp_auth — AUTH_RESPONDING trailing-data paths", () => {
    it("401 with trailing bytes → trailing forwarded to client (line 252-254)", () => {
        const client = new FakeSocket();
        const remote = new FakeSocket();
        const { logs } = attach(client, remote);

        // Drive to AUTH_NEED
        client.emit(
            "data",
            Buffer.from("OPTIONS rtsp://x/y RTSP/1.0\r\nCSeq: 1\r\n\r\n", "utf-8"),
        );
        // Camera challenges
        remote.emit(
            "data",
            Buffer.from(
                'RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: Digest realm="b", nonce="n", qop="auth"\r\n\r\n',
                "utf-8",
            ),
        );
        // Now AUTH_RESPONDING — camera sends 401 again AND trailing bytes in one chunk
        const stale401 = Buffer.from(
            'RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\n\r\n',
            "utf-8",
        );
        const trailing = Buffer.from("EXTRA_TRAILING_BYTES", "utf-8");
        remote.emit("data", Buffer.concat([stale401, trailing]));

        // Client should see the 401 body
        expect(client.writes.length, "client received at least 1 write").to.be.greaterThan(0);
        const allClientText = client.text();
        expect(allClientText, "client sees 401 status").to.include("401 Unauthorized");
        // Trailing bytes forwarded to client as well
        expect(allClientText, "trailing bytes forwarded").to.include("EXTRA_TRAILING_BYTES");
        // Client socket ended
        expect(client.ended, "client.end() called on stale creds").to.equal(true);
        // Warn log emitted
        const warnLog = logs.find((l) => l.startsWith("[warn]") && /Digest/i.test(l));
        expect(warnLog, "warn log for stale creds").to.exist;
    });

    it("200 success with trailing bytes → trailing piped to client (lines 269-270)", () => {
        const client = new FakeSocket();
        const remote = new FakeSocket();
        attach(client, remote);

        // Drive to AUTH_NEED
        client.emit(
            "data",
            Buffer.from("OPTIONS rtsp://x/y RTSP/1.0\r\nCSeq: 1\r\n\r\n", "utf-8"),
        );
        // Camera challenges
        remote.emit(
            "data",
            Buffer.from(
                'RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: Digest realm="b", nonce="n2", qop="auth"\r\n\r\n',
                "utf-8",
            ),
        );
        // AUTH_RESPONDING: camera sends 200 OK + trailing bytes in same chunk
        const ok = Buffer.from("RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n", "utf-8");
        const trailing = Buffer.from("DESCRIBE_RESPONSE_HEADER", "utf-8");
        remote.emit("data", Buffer.concat([ok, trailing]));

        const allText = client.text();
        expect(allText, "client sees 200 OK").to.include("200 OK");
        expect(allText, "trailing bytes forwarded to client").to.include("DESCRIBE_RESPONSE_HEADER");
    });

    it("200 success with pending clientBuf → queued requests replayed via processClientBuffer (lines 273-274)", () => {
        const client = new FakeSocket();
        const remote = new FakeSocket();
        attach(client, remote);

        // Drive to AUTH_NEED
        client.emit(
            "data",
            Buffer.from("OPTIONS rtsp://x/y RTSP/1.0\r\nCSeq: 1\r\n\r\n", "utf-8"),
        );
        // Camera challenges — proxy is now in AUTH_NEED; subsequent client data is buffered
        remote.emit(
            "data",
            Buffer.from(
                'RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: Digest realm="b", nonce="n3", qop="auth"\r\n\r\n',
                "utf-8",
            ),
        );
        // Client sends DESCRIBE while auth dance is in flight (AUTH_RESPONDING) — gets buffered
        client.emit(
            "data",
            Buffer.from(
                "DESCRIBE rtsp://x/y RTSP/1.0\r\nCSeq: 2\r\nAccept: application/sdp\r\n\r\n",
                "utf-8",
            ),
        );
        const remoteWritesBefore = remote.writes.length;
        // Camera now sends 200 — proxy enters INJECTING and replays the buffered DESCRIBE
        remote.emit("data", Buffer.from("RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n", "utf-8"));

        // The buffered DESCRIBE must have been replayed with an Authorization header
        const newWrites = remote.writes.slice(remoteWritesBefore);
        const replayedText = newWrites.map((b) => b.toString("utf-8")).join("");
        expect(replayedText, "buffered DESCRIBE replayed after auth dance").to.include("DESCRIBE");
        expect(replayedText, "replayed request has Authorization header").to.match(
            /Authorization: Digest /,
        );
    });
});

// ── AUTH_NEED with unparseable / absent WWW-Authenticate ─────────────────────

describe("rtsp_auth — AUTH_NEED auth-failure paths", () => {
    it("401 with no WWW-Authenticate → cannot compute Digest → PASSTHROUGH (lines 215-229)", () => {
        const client = new FakeSocket();
        const remote = new FakeSocket();
        const { logs } = attach(client, remote);

        client.emit(
            "data",
            Buffer.from("OPTIONS rtsp://x/y RTSP/1.0\r\nCSeq: 1\r\n\r\n", "utf-8"),
        );
        // 401 with no WWW-Authenticate header
        remote.emit(
            "data",
            Buffer.from("RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\n\r\n", "utf-8"),
        );

        // Client must receive the forwarded 401
        expect(client.writes.length, "client sees the 401").to.be.greaterThan(0);
        expect(client.text(), "client sees 401 status line").to.include("401 Unauthorized");
        const warnLog = logs.find((l) => l.startsWith("[warn]"));
        expect(warnLog, "warn log emitted about cannot compute Digest").to.exist;
    });

    it("401 with invalid Digest challenge (no nonce) → cannot compute → PASSTHROUGH", () => {
        const client = new FakeSocket();
        const remote = new FakeSocket();
        const { logs } = attach(client, remote);

        client.emit(
            "data",
            Buffer.from("OPTIONS rtsp://x/y RTSP/1.0\r\nCSeq: 1\r\n\r\n", "utf-8"),
        );
        // Malformed: Digest header but missing nonce → parseDigestChallenge throws
        remote.emit(
            "data",
            Buffer.from(
                'RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: Digest realm="b"\r\n\r\n',
                "utf-8",
            ),
        );

        expect(client.writes.length, "client sees the 401").to.be.greaterThan(0);
        const warnLog = logs.find(
            (l) => l.startsWith("[warn]") && /parse|cannot/i.test(l),
        );
        expect(warnLog, "warn log emitted for parse failure or cannot compute").to.exist;
    });

    it("401 with clientBuf buffered → buffered data flushed to remote on PASSTHROUGH (lines 225-228)", () => {
        const client = new FakeSocket();
        const remote = new FakeSocket();
        attach(client, remote);

        // Client sends first request (no auth) — goes to AUTH_NEED
        client.emit(
            "data",
            Buffer.from("OPTIONS rtsp://x/y RTSP/1.0\r\nCSeq: 1\r\n\r\n", "utf-8"),
        );
        // Client sends a second request while in AUTH_NEED — buffered
        client.emit(
            "data",
            Buffer.from("DESCRIBE rtsp://x/y RTSP/1.0\r\nCSeq: 2\r\n\r\n", "utf-8"),
        );
        const remoteWritesBefore = remote.writes.length;
        // Camera sends 401 with no WWW-Authenticate → falls to PASSTHROUGH + flushes clientBuf
        remote.emit(
            "data",
            Buffer.from("RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\n\r\n", "utf-8"),
        );
        // The buffered DESCRIBE must be forwarded to remote
        const newText = remote.writes.slice(remoteWritesBefore).map((b) => b.toString("utf-8")).join("");
        expect(newText, "buffered DESCRIBE flushed to remote on PASSTHROUGH").to.include("DESCRIBE");
    });
});

// ── "Other status" during auth dance ─────────────────────────────────────────

describe("rtsp_auth — non-401/200 status during auth dance", () => {
    it("AUTH_NEED receives 200 (no challenge) → forwarded to client, no auth dance started", () => {
        // If the camera accepts the first request without 401 (e.g. auth disabled),
        // the non-AUTH_NEED/AUTH_RESPONDING mode branch fires and forwards to client.
        // Actually: status != 401 in AUTH_NEED hits the bottom "other status" path.
        const client = new FakeSocket();
        const remote = new FakeSocket();
        attach(client, remote);

        client.emit(
            "data",
            Buffer.from("OPTIONS rtsp://x/y RTSP/1.0\r\nCSeq: 1\r\n\r\n", "utf-8"),
        );
        // Camera immediately responds 200 (no auth required for this request)
        remote.emit(
            "data",
            Buffer.from("RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n", "utf-8"),
        );

        // Client sees the 200 (forwarded via "other status" path, lines 279-284)
        expect(client.writes.length, "client sees 200 response").to.be.greaterThan(0);
        expect(client.text(), "client sees 200 OK").to.include("200 OK");
    });

    it("AUTH_NEED receives 200 with trailing bytes → trailing also forwarded (line 281-283)", () => {
        const client = new FakeSocket();
        const remote = new FakeSocket();
        attach(client, remote);

        client.emit(
            "data",
            Buffer.from("OPTIONS rtsp://x/y RTSP/1.0\r\nCSeq: 1\r\n\r\n", "utf-8"),
        );
        const ok = Buffer.from("RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n", "utf-8");
        const trailing = Buffer.from("EXTRA_BYTES", "utf-8");
        remote.emit("data", Buffer.concat([ok, trailing]));

        expect(client.text(), "client sees 200 + trailing").to.include("200 OK");
        expect(client.text(), "trailing bytes forwarded").to.include("EXTRA_BYTES");
    });

    it("AUTH_RESPONDING receives 503 (unexpected) → treated as success path, INJECTING entered", () => {
        // Any status other than 401 in AUTH_RESPONDING is treated as "success" (enters INJECTING).
        const client = new FakeSocket();
        const remote = new FakeSocket();
        attach(client, remote);

        // Drive to AUTH_RESPONDING
        client.emit(
            "data",
            Buffer.from("OPTIONS rtsp://x/y RTSP/1.0\r\nCSeq: 1\r\n\r\n", "utf-8"),
        );
        remote.emit(
            "data",
            Buffer.from(
                'RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: Digest realm="b", nonce="n", qop="auth"\r\n\r\n',
                "utf-8",
            ),
        );
        // Camera unexpectedly returns 503 instead of 200
        remote.emit(
            "data",
            Buffer.from("RTSP/1.0 503 Service Unavailable\r\nCSeq: 1\r\n\r\n", "utf-8"),
        );

        // Client sees the 503 (forwarded)
        expect(client.text(), "client sees 503").to.include("503");

        // Verify INJECTING mode entered: subsequent client request gets Authorization
        const writesBefore = remote.writes.length;
        client.emit(
            "data",
            Buffer.from(
                "DESCRIBE rtsp://x/y RTSP/1.0\r\nCSeq: 2\r\n\r\n",
                "utf-8",
            ),
        );
        const afterText = remote.writes.slice(writesBefore).map((b) => b.toString("utf-8")).join("");
        expect(afterText, "INJECTING mode: Authorization injected on next request").to.match(
            /Authorization: Digest /,
        );
    });
});

// ── INJECTING mode: fallback when parseRequestStartLine returns null ───────────

describe("rtsp_auth — INJECTING fallback paths", () => {
    it("unparseable first line in INJECTING mode → raw bytes forwarded unchanged", () => {
        const { client, remote } = reachInjecting();
        const writesBefore = remote.writes.length;

        // Send a garbage buffer that doesn't match the RTSP request line pattern
        const garbage = Buffer.from("GARBAGE_DATA\r\n\r\n", "utf-8");
        client.emit("data", garbage);

        // Must still be forwarded (just without injected auth)
        expect(remote.writes.length, "garbage forwarded").to.equal(writesBefore + 1);
        expect(
            remote.writes[remote.writes.length - 1].toString("utf-8"),
        ).to.include("GARBAGE_DATA");
    });

    it("INJECTING: multiple sequential requests each get Authorization injected", () => {
        const { client, remote } = reachInjecting();

        const requests = ["SETUP", "PLAY", "GET_PARAMETER"];
        for (const method of requests) {
            const writesBefore = remote.writes.length;
            client.emit(
                "data",
                Buffer.from(
                    `${method} rtsp://x/y RTSP/1.0\r\nCSeq: 3\r\n\r\n`,
                    "utf-8",
                ),
            );
            const sent = remote.writes.slice(writesBefore).map((b) => b.toString("utf-8")).join("");
            expect(sent, `${method} gets Authorization`).to.match(/Authorization: Digest /);
        }
    });
});

// ── Remaining branch coverage ─────────────────────────────────────────────────

describe("rtsp_auth — remaining branch coverage", () => {
    it("remote data arrives in fragments during AUTH_NEED → buffered until full response (lines 167-168)", async () => {
        const client = new FakeSocket();
        const remote = new FakeSocket();
        attach(client, remote);

        client.emit(
            "data",
            Buffer.from("OPTIONS rtsp://x/y RTSP/1.0\r\nCSeq: 1\r\n\r\n", "utf-8"),
        );

        // Fragment 1: incomplete — no \r\n\r\n yet; findRtspMessageEnd returns -1
        const fragment1 = Buffer.from("RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\n", "utf-8");
        remote.emit("data", fragment1);
        // Client must NOT have received anything yet (still buffering)
        expect(client.writes.length, "no output while response is incomplete").to.equal(0);

        // Fragment 2: completes the response (adds WWW-Authenticate + \r\n\r\n)
        const fragment2 = Buffer.from(
            'WWW-Authenticate: Digest realm="b", nonce="n", qop="auth"\r\n\r\n',
            "utf-8",
        );
        remote.emit("data", fragment2);
        // Now the full response is assembled — auth dance proceeds (401 swallowed, retry sent)
        expect(remote.writes.length, "authed retry sent after reassembly").to.equal(2);
        expect(client.writes.length, "401 still swallowed from client").to.equal(0);
    });

    it("AUTH_NEED 401 with trailing bytes in same chunk → setImmediate path triggers (lines 207-211)", (done) => {
        const client = new FakeSocket();
        const remote = new FakeSocket();
        attach(client, remote);

        client.emit(
            "data",
            Buffer.from("OPTIONS rtsp://x/y RTSP/1.0\r\nCSeq: 1\r\n\r\n", "utf-8"),
        );

        // Camera sends the 401 challenge AND the beginning of the 200 response in one chunk.
        // This triggers the trailing-data path with setImmediate() re-emission.
        const challenge401 = Buffer.from(
            'RTSP/1.0 401 Unauthorized\r\nWWW-Authenticate: Digest realm="b", nonce="nT", qop="auth"\r\n\r\n',
            "utf-8",
        );
        // Trailing: a partial 200 response that will be reassembled after setImmediate
        const trailing200 = Buffer.from("RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n", "utf-8");
        remote.emit("data", Buffer.concat([challenge401, trailing200]));

        // The setImmediate fires asynchronously; verify state after it resolves
        setImmediate(() => {
            // By this point the re-emitted empty chunk has been processed:
            // the 200 in the trailing buf should have pushed the proxy to INJECTING
            // Client should now see the 200
            expect(client.writes.length, "client sees 200 after setImmediate replay").to.be.greaterThan(0);
            expect(client.text(), "client received 200 OK").to.include("200 OK");
            done();
        });
    });

    it("cannot-compute PASSTHROUGH: trailing bytes in 401 forwarded to client (lines 223-224)", () => {
        const client = new FakeSocket();
        const remote = new FakeSocket();
        attach(client, remote);

        client.emit(
            "data",
            Buffer.from("OPTIONS rtsp://x/y RTSP/1.0\r\nCSeq: 1\r\n\r\n", "utf-8"),
        );
        // 401 with no WWW-Authenticate + trailing bytes
        const no401 = Buffer.from("RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\n\r\n", "utf-8");
        const trailingExtra = Buffer.from("DESCRIBE rtsp://x/y RTSP/1.0\r\nCSeq: 2\r\n\r\n", "utf-8");
        remote.emit("data", Buffer.concat([no401, trailingExtra]));

        // Client sees both the 401 and the trailing bytes
        const text = client.text();
        expect(text, "client sees 401").to.include("401 Unauthorized");
        expect(text, "trailing bytes also forwarded to client").to.include("DESCRIBE");
    });

    it("rcp_lan_helper: lanAddress without colon → host is empty → returns null (line 76-77)", async () => {
        // "192.168.1.149" without ":PORT" — split(":")[0] === "192.168.1.149" which is truthy.
        // The guard at line 74-77 fires when host is falsy (empty string).
        // We force that by passing just ":" as the lanAddress so split(":") gives ["", ""].
        const { fetchRcpLan: rcpFetch } = await import("../../src/lib/rcp_lan_helper");
        const result = await rcpFetch(
            { lanAddress: ":443", digestUser: "u", digestPassword: "p" },
            "0x0a98",
        );
        expect(result).to.equal(null);
    });
});
