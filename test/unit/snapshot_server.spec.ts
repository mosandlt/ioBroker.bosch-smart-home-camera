/**
 * Unit tests for the local HTTP snapshot server (src/lib/snapshot_server.ts).
 * Uses a real server on an OS-assigned ephemeral port (listen 0) + node http
 * client — no ioBroker runtime needed.
 */

import { expect } from "chai";
import * as http from "node:http";

import {
    parseCamId,
    snapshotUrl,
    detectLanIp,
    startSnapshotServer,
    type SnapshotServerHandle,
} from "../../src/lib/snapshot_server";

const silentLog = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

interface Res {
    status: number;
    contentType?: string;
    body: Buffer;
}

function request(port: number, path: string, method = "GET"): Promise<Res> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, path, method }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () =>
                resolve({
                    status: res.statusCode || 0,
                    contentType: res.headers["content-type"],
                    body: Buffer.concat(chunks),
                }),
            );
        });
        req.on("error", reject);
        req.end();
    });
}

describe("snapshot_server — parseCamId()", () => {
    it("accepts a bare id and a .jpg suffix", () => {
        expect(parseCamId("/abc-123")).to.equal("abc-123");
        expect(parseCamId("/abc-123.jpg")).to.equal("abc-123");
        expect(parseCamId("/abc-123.JPEG")).to.equal("abc-123");
    });
    it("strips a query string", () => {
        expect(parseCamId("/cam1.jpg?_ts=999")).to.equal("cam1");
    });
    it("rejects root, traversal and nested paths", () => {
        expect(parseCamId("/")).to.be.null;
        expect(parseCamId("/../etc/passwd")).to.be.null;
        expect(parseCamId("/a/b")).to.be.null;
        expect(parseCamId("/..")).to.be.null;
    });
});

describe("snapshot_server — snapshotUrl()", () => {
    it("builds the canonical url.cam endpoint", () => {
        expect(snapshotUrl("192.0.2.5", 8095, "cam1")).to.equal("http://192.0.2.5:8095/cam1.jpg");
    });
});

describe("snapshot_server — detectLanIp()", () => {
    it("returns a non-empty string (IPv4 or 127.0.0.1 fallback)", () => {
        expect(detectLanIp()).to.be.a("string").and.match(/^\d+\.\d+\.\d+\.\d+$/);
    });
});

describe("snapshot_server — HTTP behaviour", () => {
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    let handle: SnapshotServerHandle;
    let port: number;

    beforeEach(async () => {
        handle = await startSnapshotServer({
            port: 0, // OS picks a free port
            bindHost: "127.0.0.1",
            getSnapshot: (camId) => (camId === "cam1" ? JPEG : undefined),
            log: silentLog,
        });
        port = (handle.server.address() as { port: number }).port;
    });

    afterEach(async () => {
        await handle.close();
    });

    it("serves the cached JPEG with image/jpeg + no-store", async () => {
        const res = await request(port, "/cam1.jpg");
        expect(res.status).to.equal(200);
        expect(res.contentType).to.equal("image/jpeg");
        expect(res.body.equals(JPEG)).to.be.true;
    });

    it("also serves the bare id (no extension)", async () => {
        const res = await request(port, "/cam1");
        expect(res.status).to.equal(200);
        expect(res.body.equals(JPEG)).to.be.true;
    });

    it("404 when no snapshot is cached for that camera", async () => {
        const res = await request(port, "/unknown.jpg");
        expect(res.status).to.equal(404);
    });

    it("404 for root / traversal", async () => {
        expect((await request(port, "/")).status).to.equal(404);
        expect((await request(port, "/../secret")).status).to.equal(404);
    });

    it("405 for non-GET/HEAD methods", async () => {
        const res = await request(port, "/cam1.jpg", "POST");
        expect(res.status).to.equal(405);
    });

    it("HEAD returns headers but no body", async () => {
        const res = await request(port, "/cam1.jpg", "HEAD");
        expect(res.status).to.equal(200);
        expect(res.body.length).to.equal(0);
    });
});
