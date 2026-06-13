/**
 * Unit tests for src/lib/lazy_stream.ts — the always-on lazy front-door that
 * keeps the RTSP endpoint reachable even while no Bosch session is open
 * (forum #84538, Reiner). The "inner proxy" is faked with a plain TCP echo
 * server; resolveInner returns its port (or null) on demand.
 *
 * Test count: 11
 */

import * as net from "net";
import { expect } from "chai";

import { startLazyFrontDoor, type LazyFrontDoorHandle } from "../../src/lib/lazy_stream";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Start a plain-TCP echo server (reflects every byte). Returns server + port. */
function startTcpEchoServer(): Promise<{ server: net.Server; port: number }> {
    return new Promise((resolve, reject) => {
        const server = net.createServer((socket) => {
            socket.pipe(socket); // echo
        });
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as net.AddressInfo;
            resolve({ server, port: addr.port });
        });
    });
}

/** Connect, send payload, collect bytes for waitMs, then close. */
function tcpExchange(port: number, payload: Buffer, waitMs = 300): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
            sock.write(payload);
        });
        sock.on("data", (chunk: Buffer) => chunks.push(chunk));
        sock.on("error", reject);
        setTimeout(() => {
            sock.destroy();
            resolve(Buffer.concat(chunks));
        }, waitMs);
    });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("Lazy front-door (src/lib/lazy_stream.ts)", function () {
    this.timeout(10_000);

    let echoServer: net.Server;
    let echoPort: number;
    let handles: LazyFrontDoorHandle[] = [];

    before(async () => {
        const result = await startTcpEchoServer();
        echoServer = result.server;
        echoPort = result.port;
    });

    after((done) => {
        echoServer.close(done);
    });

    afterEach(async () => {
        for (const h of handles) {
            await h.stop().catch(() => undefined);
        }
        handles = [];
    });

    // ── Test 1 ──────────────────────────────────────────────────────────────
    it("binds a valid port immediately and exposes a localRtspUrl", async () => {
        const handle = await startLazyFrontDoor({
            cameraId: "TEST-CAM-1",
            resolveInner: () => Promise.resolve(echoPort),
        });
        handles.push(handle);

        expect(handle.port).to.be.a("number").greaterThan(0);
        expect(handle.localRtspUrl).to.equal(`rtsp://127.0.0.1:${handle.port}/rtsp_tunnel`);
        expect(handle.activeClientCount()).to.equal(0);
    });

    // ── Test 2 ──────────────────────────────────────────────────────────────
    it("listener is answerable BEFORE any inner session exists (no ECONNREFUSED)", async () => {
        // resolveInner only resolves after a delay — simulating a session that
        // is not yet open. The TCP connect must still succeed immediately.
        const handle = await startLazyFrontDoor({
            cameraId: "TEST-CAM-LAZY",
            resolveInner: async () => {
                await sleep(150);
                return echoPort;
            },
        });
        handles.push(handle);

        const connected = await new Promise<boolean>((resolve) => {
            const sock = net.createConnection({ host: "127.0.0.1", port: handle.port });
            sock.on("connect", () => {
                sock.destroy();
                resolve(true);
            });
            sock.on("error", () => resolve(false));
            setTimeout(() => resolve(false), 1500);
        });
        expect(connected).to.equal(true);
    });

    // ── Test 3 ──────────────────────────────────────────────────────────────
    it("resolveInner is NOT called at bind time — only on a client connection", async () => {
        let calls = 0;
        const handle = await startLazyFrontDoor({
            cameraId: "TEST-CAM-NOCALL",
            resolveInner: () => {
                calls++;
                return Promise.resolve(echoPort);
            },
        });
        handles.push(handle);

        await sleep(100);
        expect(calls).to.equal(0); // nobody connected yet

        await tcpExchange(handle.port, Buffer.from("X"), 200);
        expect(calls).to.equal(1);
    });

    // ── Test 4 ──────────────────────────────────────────────────────────────
    it("bytes flow: client → front-door → inner echo → back to client", async () => {
        const handle = await startLazyFrontDoor({
            cameraId: "TEST-CAM-FLOW",
            resolveInner: () => Promise.resolve(echoPort),
        });
        handles.push(handle);

        const received = await tcpExchange(
            handle.port,
            Buffer.from("RTSP/1.0 OPTIONS\r\n\r\n"),
            400,
        );
        expect(received.toString()).to.include("RTSP/1.0 OPTIONS");
    });

    // ── Test 5 ──────────────────────────────────────────────────────────────
    it("resolveInner returning null drops the client cleanly", async () => {
        const handle = await startLazyFrontDoor({
            cameraId: "TEST-CAM-NULL",
            resolveInner: () => Promise.resolve(null),
        });
        handles.push(handle);

        const closed = await new Promise<boolean>((resolve) => {
            const sock = net.createConnection({ host: "127.0.0.1", port: handle.port }, () => {
                sock.write(Buffer.from("DATA"));
            });
            sock.on("close", () => resolve(true));
            sock.on("error", () => resolve(true));
            setTimeout(() => resolve(false), 2000);
        });
        expect(closed).to.equal(true);
        // No client should remain counted after the drop.
        await sleep(50);
        expect(handle.activeClientCount()).to.equal(0);
    });

    // ── Test 6 ──────────────────────────────────────────────────────────────
    it("onActive fires on the first client, onIdle when the last disconnects", async () => {
        let active = 0;
        let idle = 0;
        const handle = await startLazyFrontDoor({
            cameraId: "TEST-CAM-CB",
            resolveInner: () => Promise.resolve(echoPort),
            onActive: () => active++,
            onIdle: () => idle++,
        });
        handles.push(handle);

        await tcpExchange(handle.port, Buffer.from("PING"), 200);
        await sleep(100);

        expect(active).to.equal(1);
        expect(idle).to.equal(1);
        expect(handle.activeClientCount()).to.equal(0);
    });

    // ── Test 7 ──────────────────────────────────────────────────────────────
    it("activeClientCount tracks concurrent clients", async () => {
        const handle = await startLazyFrontDoor({
            cameraId: "TEST-CAM-COUNT",
            resolveInner: () => Promise.resolve(echoPort),
        });
        handles.push(handle);

        const a = net.createConnection({ host: "127.0.0.1", port: handle.port });
        const b = net.createConnection({ host: "127.0.0.1", port: handle.port });
        await new Promise<void>((res) => a.on("connect", () => res()).on("error", () => res()));
        await new Promise<void>((res) => b.on("connect", () => res()).on("error", () => res()));
        await sleep(80);

        expect(handle.activeClientCount()).to.equal(2);

        a.destroy();
        b.destroy();
        await sleep(120);
        expect(handle.activeClientCount()).to.equal(0);
    });

    // ── Test 8 ──────────────────────────────────────────────────────────────
    it("onActive fires only once for overlapping clients (0→1, not per client)", async () => {
        let active = 0;
        let idle = 0;
        const handle = await startLazyFrontDoor({
            cameraId: "TEST-CAM-ONCE",
            resolveInner: () => Promise.resolve(echoPort),
            onActive: () => active++,
            onIdle: () => idle++,
        });
        handles.push(handle);

        const a = net.createConnection({ host: "127.0.0.1", port: handle.port });
        await new Promise<void>((res) => a.on("connect", () => res()).on("error", () => res()));
        const b = net.createConnection({ host: "127.0.0.1", port: handle.port });
        await new Promise<void>((res) => b.on("connect", () => res()).on("error", () => res()));
        await sleep(80);

        expect(active).to.equal(1); // both connections, single 0→1 transition
        expect(idle).to.equal(0);

        a.destroy();
        b.destroy();
        await sleep(120);
        expect(idle).to.equal(1); // single 1→0 transition
    });

    // ── Test 9 ──────────────────────────────────────────────────────────────
    it("multiple sequential clients each re-open the inner (lazy per connection)", async () => {
        let calls = 0;
        const handle = await startLazyFrontDoor({
            cameraId: "TEST-CAM-SEQ",
            resolveInner: () => {
                calls++;
                return Promise.resolve(echoPort);
            },
        });
        handles.push(handle);

        await tcpExchange(handle.port, Buffer.from("ONE"), 150);
        await tcpExchange(handle.port, Buffer.from("TWO"), 150);
        expect(calls).to.equal(2);
    });

    // ── Test 10 ─────────────────────────────────────────────────────────────
    it("stop() closes the listener — new connections are refused after stop", async () => {
        const handle = await startLazyFrontDoor({
            cameraId: "TEST-CAM-STOP",
            resolveInner: () => Promise.resolve(echoPort),
        });
        await handle.stop();

        await new Promise<void>((resolve, reject) => {
            const sock = net.createConnection({ host: "127.0.0.1", port: handle.port });
            sock.on("connect", () => {
                sock.destroy();
                reject(new Error("Expected connection to fail but it succeeded"));
            });
            sock.on("error", () => resolve());
            setTimeout(() => {
                sock.destroy();
                resolve();
            }, 2000);
        });
    });

    // ── Test 11 ─────────────────────────────────────────────────────────────
    it("urlHost overrides the host embedded in localRtspUrl", async () => {
        const handle = await startLazyFrontDoor({
            cameraId: "TEST-CAM-URLHOST",
            bindHost: "0.0.0.0",
            urlHost: "192.0.2.50",
            resolveInner: () => Promise.resolve(echoPort),
        });
        handles.push(handle);
        expect(handle.localRtspUrl).to.equal(`rtsp://192.0.2.50:${handle.port}/rtsp_tunnel`);
    });
});
