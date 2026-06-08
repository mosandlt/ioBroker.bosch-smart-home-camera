/**
 * Unit tests for the vis-2 widget MJPEG streamer (src/lib/web_stream.ts).
 *
 * Verifies (with an injected spawn shim — no real FFmpeg):
 *   - subscription rejected when no live URL is available
 *   - one shared FFmpeg per camera across multiple viewers
 *   - SOI (0xFFD8) marker frame splitting → base64 frame push
 *   - rate limiting between frames
 *   - viewer lifecycle: last viewer leaving kills FFmpeg; remove-from-all
 *   - "not registered" send rejection drops the viewer
 *   - stopAll kills processes
 */
import { expect } from "chai";
import { EventEmitter } from "node:events";

import {
    WebStreamManager,
    _setStreamSpawnFn,
    type WebStreamDeps,
    type StreamProcLike,
} from "../../src/lib/web_stream";

class FakeProc extends EventEmitter implements StreamProcLike {
    public stdout = new EventEmitter() as unknown as NodeJS.ReadableStream & EventEmitter;
    public stderr = new EventEmitter() as unknown as NodeJS.ReadableStream & EventEmitter;
    public killed = false;
    public killArgs: (string | undefined)[] = [];
    public kill(signal?: NodeJS.Signals): void {
        this.killed = true;
        this.killArgs.push(signal);
    }
}

const SOI = Buffer.from([0xff, 0xd8]);
function jpeg(payload: string): Buffer {
    return Buffer.concat([SOI, Buffer.from(payload, "utf8")]);
}

const noopLog = { debug: () => {}, warn: () => {}, info: () => {} };

interface Sent {
    clientId: string;
    base64: string;
}

function makeManager(opts: {
    url?: string | null;
    minGap?: number;
    sendImpl?: (clientId: string, base64: string) => Promise<void>;
}): { mgr: WebStreamManager; procs: FakeProc[]; sent: Sent[] } {
    const procs: FakeProc[] = [];
    _setStreamSpawnFn(() => {
        const p = new FakeProc();
        procs.push(p);
        return p;
    });
    const sent: Sent[] = [];
    const deps: WebStreamDeps = {
        resolveUrl: () =>
            opts.url === undefined ? "rtsp://127.0.0.1:9000/rtsp_tunnel?inst=1" : opts.url,
        sendFrame:
            opts.sendImpl ??
            ((clientId, base64) => {
                sent.push({ clientId, base64 });
                return Promise.resolve();
            }),
        log: noopLog,
        minFrameGapMs: opts.minGap ?? 0,
    };
    return { mgr: new WebStreamManager(deps), procs, sent };
}

describe("web_stream — MJPEG widget streamer", () => {
    afterEach(() => {
        // restore real spawn by setting a harmless stub (avoid leaking the shim)
        _setStreamSpawnFn((() => {
            throw new Error("spawn not stubbed");
        }) as never);
    });

    it("rejects a viewer when no live URL is available", () => {
        const { mgr, procs } = makeManager({ url: null });
        const ok = mgr.addViewer("c1", "CAM1", 0);
        expect(ok).to.equal(false);
        expect(procs.length).to.equal(0);
        expect(mgr.activeCount).to.equal(0);
    });

    it("starts one shared FFmpeg per camera for multiple viewers", () => {
        const { mgr, procs } = makeManager({});
        expect(mgr.addViewer("c1", "CAM1", 640)).to.equal(true);
        expect(mgr.addViewer("c2", "CAM1", 640)).to.equal(true);
        expect(procs.length).to.equal(1);
        expect(mgr.activeCount).to.equal(1);
    });

    it("splits SOI-delimited chunks and pushes base64 frames to all viewers", () => {
        const { mgr, procs, sent } = makeManager({ minGap: 0 });
        mgr.addViewer("c1", "CAM1", 0);
        mgr.addViewer("c2", "CAM1", 0);
        const p = procs[0];
        // frame A buffered; frame B's SOI flushes frame A
        p.stdout.emit("data", jpeg("AAA"));
        p.stdout.emit("data", jpeg("BBB"));
        // one frame (A) emitted to both clients
        expect(sent.length).to.equal(2);
        expect(sent.map((s) => s.clientId).sort()).to.deep.equal(["c1", "c2"]);
        const decoded = Buffer.from(sent[0].base64, "base64");
        expect(decoded.equals(jpeg("AAA"))).to.equal(true);
    });

    it("emits successive frames as new SOI chunks arrive", () => {
        const { mgr, procs, sent } = makeManager({ minGap: 0 });
        mgr.addViewer("c1", "CAM1", 0);
        const p = procs[0];
        p.stdout.emit("data", jpeg("A")); // buffered
        p.stdout.emit("data", jpeg("B")); // flush A
        p.stdout.emit("data", jpeg("C")); // flush B
        expect(sent.length).to.equal(2);
        expect(Buffer.from(sent[1].base64, "base64").equals(jpeg("B"))).to.equal(true);
    });

    it("concatenates non-SOI continuation chunks into one frame", () => {
        const { mgr, procs, sent } = makeManager({ minGap: 0 });
        mgr.addViewer("c1", "CAM1", 0);
        const p = procs[0];
        p.stdout.emit("data", jpeg("XX")); // start frame
        p.stdout.emit("data", Buffer.from("YY", "utf8")); // continuation (no SOI)
        p.stdout.emit("data", jpeg("Z")); // flush XX+YY
        expect(sent.length).to.equal(1);
        const raw = Buffer.from(sent[0].base64, "base64");
        expect(raw.slice(2).toString()).to.equal("XXYY");
    });

    it("rate-limits frames within minFrameGapMs", () => {
        const { mgr, procs, sent } = makeManager({ minGap: 100000 });
        mgr.addViewer("c1", "CAM1", 0);
        const p = procs[0];
        p.stdout.emit("data", jpeg("A"));
        p.stdout.emit("data", jpeg("B")); // would flush A, but first frame allowed
        p.stdout.emit("data", jpeg("C")); // flush B suppressed by rate limit
        expect(sent.length).to.equal(1); // only the first frame got through
    });

    it("kills FFmpeg when the last viewer of a camera leaves", () => {
        const { mgr, procs } = makeManager({});
        mgr.addViewer("c1", "CAM1", 0);
        mgr.addViewer("c2", "CAM1", 0);
        mgr.removeViewer("c1", "CAM1");
        expect(procs[0].killed).to.equal(false); // c2 still watching
        expect(mgr.activeCount).to.equal(1);
        mgr.removeViewer("c2", "CAM1");
        expect(procs[0].killed).to.equal(true);
        expect(mgr.activeCount).to.equal(0);
    });

    it("removeViewer without camId drops the client from every camera", () => {
        const { mgr, procs } = makeManager({});
        mgr.addViewer("c1", "CAM1", 0);
        mgr.addViewer("c1", "CAM2", 0);
        expect(mgr.activeCount).to.equal(2);
        mgr.removeViewer("c1");
        expect(mgr.activeCount).to.equal(0);
        expect(procs.every((p) => p.killed)).to.equal(true);
    });

    it("drops a viewer when sendToUI reports 'not registered'", () => {
        const { mgr, procs } = makeManager({
            minGap: 0,
            sendImpl: () => Promise.reject(new Error("client not registered")),
        });
        mgr.addViewer("c1", "CAM1", 0);
        const p = procs[0];
        p.stdout.emit("data", jpeg("A"));
        p.stdout.emit("data", jpeg("B")); // triggers send → rejection → drop c1
        // allow the rejection microtask to run
        return Promise.resolve().then(() => {
            expect(mgr.activeCount).to.equal(0);
            expect(p.killed).to.equal(true);
        });
    });

    it("stopAll kills all processes and clears state", () => {
        const { mgr, procs } = makeManager({});
        mgr.addViewer("c1", "CAM1", 0);
        mgr.addViewer("c2", "CAM2", 0);
        mgr.stopAll();
        expect(procs.length).to.equal(2);
        expect(procs.every((p) => p.killed)).to.equal(true);
        expect(mgr.activeCount).to.equal(0);
    });
});
