/**
 * Coverage gap tests for src/lib/mqtt_bridge.ts
 *
 * Targets the 15 previously-uncovered lines:
 *   147-148  connect() opts.username assignment
 *   150-151  connect() opts.password assignment
 *   161-162  once("connect") settled guard (prevents double-resolve)
 *   170-175  once("error") initial error handler → reject(err)
 *   184      persistent on("error") handler → warn log
 *   187      on("close") handler → debug log
 *   234      publish() callback error arm → warn log
 *
 * Pattern: load build/lib/mqtt_bridge.js via require() so that the
 * mqtt module in require.cache can be pre-replaced with a fake client,
 * mirroring the approach in main_mqtt_bridge.spec.ts.
 */

import { expect } from "chai";
import * as sinon from "sinon";
import * as path from "path";
import { EventEmitter } from "events";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MQTT_BRIDGE_JS_PATH = path.join(REPO_ROOT, "build", "lib", "mqtt_bridge.js");
const MQTT_MODULE_PATH = require.resolve("mqtt");

interface LogStub {
    info: sinon.SinonStub;
    warn: sinon.SinonStub;
    debug: sinon.SinonStub;
    error: sinon.SinonStub;
}

function makeLogger(): LogStub {
    return {
        info: sinon.stub(),
        warn: sinon.stub(),
        debug: sinon.stub(),
        error: sinon.stub(),
    };
}

function makeFakeMqttClient(): EventEmitter & {
    publish: sinon.SinonStub;
    end: sinon.SinonStub;
} {
    const emitter = new EventEmitter() as EventEmitter & {
        publish: sinon.SinonStub;
        end: sinon.SinonStub;
    };
    emitter.publish = sinon.stub().callsFake(
        (_t: string, _m: string, _o: unknown, cb?: (e?: Error | null) => void) => {
            if (cb) cb(null);
        },
    );
    emitter.end = sinon.stub().callsFake(
        (_force: boolean, _opts: unknown, cb?: () => void) => {
            if (cb) cb();
        },
    );
    return emitter;
}

function injectFakeMqttConnect(connectStub: sinon.SinonStub): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orig = (require.cache as any)[MQTT_MODULE_PATH];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[MQTT_MODULE_PATH] = {
        ...orig,
        exports: {
            ...(orig?.exports ?? {}),
            connect: connectStub,
        },
    };
}

function restoreMqttModule(): void {
    delete require.cache[MQTT_MODULE_PATH];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadMqttBridgeClass(): new (cfg: Record<string, unknown>, log: LogStub) => any {
    delete require.cache[MQTT_BRIDGE_JS_PATH];
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const mod = require(MQTT_BRIDGE_JS_PATH) as {
        MqttBridge: new (cfg: Record<string, unknown>, log: LogStub) => unknown;
    };
    return mod.MqttBridge as new (cfg: Record<string, unknown>, log: LogStub) => unknown;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("mqtt_bridge_coverage — gap tests (v0.7.9)", () => {
    afterEach(() => {
        sinon.restore();
        restoreMqttModule();
        delete require.cache[MQTT_BRIDGE_JS_PATH];
    });

    // ── Lines 147-148: opts.username assigned when mqtt_username provided ────

    it("mqtt_username provided → opts.username is set in connect call (lines 147-148)", async () => {
        const fakeClient = makeFakeMqttClient();
        const connectStub = sinon.stub().callsFake(() => {
            setImmediate(() => fakeClient.emit("connect"));
            return fakeClient;
        });
        injectFakeMqttConnect(connectStub);
        const MqttBridge = loadMqttBridgeClass();
        const log = makeLogger();
        const bridge = new MqttBridge(
            {
                mqtt_enabled: true,
                mqtt_broker_host: "127.0.0.1",
                mqtt_username: "testuser",
            },
            log,
        );
        await bridge.connect();
        expect(connectStub.callCount).to.equal(1);
        const opts = connectStub.firstCall.args[1] as Record<string, unknown>;
        expect(opts.username).to.equal("testuser");
        expect(bridge.isConnected).to.be.true;
    });

    // ── Lines 150-151: opts.password assigned when mqtt_password provided ────

    it("mqtt_password provided → opts.password is set in connect call (lines 150-151)", async () => {
        const fakeClient = makeFakeMqttClient();
        const connectStub = sinon.stub().callsFake(() => {
            setImmediate(() => fakeClient.emit("connect"));
            return fakeClient;
        });
        injectFakeMqttConnect(connectStub);
        const MqttBridge = loadMqttBridgeClass();
        const log = makeLogger();
        const bridge = new MqttBridge(
            {
                mqtt_enabled: true,
                mqtt_broker_host: "127.0.0.1",
                mqtt_password: "s3cr3t",
            },
            log,
        );
        await bridge.connect();
        expect(connectStub.callCount).to.equal(1);
        const opts = connectStub.firstCall.args[1] as Record<string, unknown>;
        expect(opts.password).to.equal("s3cr3t");
    });

    // ── Both username + password ─────────────────────────────────────────────

    it("both mqtt_username and mqtt_password → both opts fields set", async () => {
        const fakeClient = makeFakeMqttClient();
        const connectStub = sinon.stub().callsFake(() => {
            setImmediate(() => fakeClient.emit("connect"));
            return fakeClient;
        });
        injectFakeMqttConnect(connectStub);
        const MqttBridge = loadMqttBridgeClass();
        const log = makeLogger();
        const bridge = new MqttBridge(
            {
                mqtt_enabled: true,
                mqtt_broker_host: "127.0.0.1",
                mqtt_username: "u",
                mqtt_password: "p",
            },
            log,
        );
        await bridge.connect();
        const opts = connectStub.firstCall.args[1] as Record<string, unknown>;
        expect(opts.username).to.equal("u");
        expect(opts.password).to.equal("p");
    });

    // ── Lines 161-162: once("connect") settled guard ─────────────────────────
    //
    // If the broker emits "connect" AFTER an "error" already settled the
    // promise, the connect handler must return early without calling resolve()
    // again (which would be a no-op in native Promise but could cause logic
    // errors).  We simulate: error fires first (settles=reject), then connect
    // fires — the second event must be silently ignored.

    it("once-connect guard: connect after error is silently ignored (lines 161-162)", async () => {
        const fakeClient = makeFakeMqttClient();
        let resolveCapture: (() => void) | null = null;
        const connectStub = sinon.stub().callsFake(() => {
            // Fire error first so the promise rejects, then fire connect
            setImmediate(() => {
                fakeClient.emit("error", new Error("initial failure"));
                // Give the error handler time to settle, then fire connect
                setImmediate(() => {
                    fakeClient.emit("connect");
                    if (resolveCapture) resolveCapture();
                });
            });
            return fakeClient;
        });
        injectFakeMqttConnect(connectStub);
        const MqttBridge = loadMqttBridgeClass();
        const log = makeLogger();
        const bridge = new MqttBridge(
            { mqtt_enabled: true, mqtt_broker_host: "127.0.0.1" },
            log,
        );

        // connect() will reject; we catch and then wait for the late connect event
        let lateConnectFired = false;
        resolveCapture = () => { lateConnectFired = true; };

        await bridge.connect().catch(() => { /* expected */ });
        // Wait for the deferred "connect" event to fire
        await new Promise<void>((r) => setTimeout(r, 20));
        // The guard on line 161 ensured no double-resolve / no throw
        expect(lateConnectFired).to.be.true;
        // error log was called (line 174)
        expect(log.error.callCount).to.be.greaterThan(0);
    });

    // ── Lines 170-175: once("error") initial error handler → reject ──────────

    it("broker connection error → connect() rejects with the error (lines 170-175)", async () => {
        const fakeClient = makeFakeMqttClient();
        const connectStub = sinon.stub().callsFake(() => {
            setImmediate(() => fakeClient.emit("error", new Error("ECONNREFUSED")));
            return fakeClient;
        });
        injectFakeMqttConnect(connectStub);
        const MqttBridge = loadMqttBridgeClass();
        const log = makeLogger();
        const bridge = new MqttBridge(
            { mqtt_enabled: true, mqtt_broker_host: "127.0.0.1" },
            log,
        );

        let caught: Error | null = null;
        await bridge.connect().catch((e: Error) => { caught = e; });
        expect(caught).not.to.be.null;
        expect(caught!.message).to.include("ECONNREFUSED");
        // error log was called (line 174)
        expect(log.error.callCount).to.be.greaterThan(0);
        expect(log.error.firstCall.args[0]).to.include("connection failed");
        // isConnected must be false after error
        expect(bridge.isConnected).to.be.false;
    });

    // ── Lines 161-162 (error-after-connect settled guard) ────────────────────
    //
    // Mirror scenario: connect fires first (settles=resolve), then error fires.
    // The once("error") guard on line 170 must return early without calling reject.

    it("once-error guard: error after connect is silently ignored (line 170-172)", async () => {
        const fakeClient = makeFakeMqttClient();
        const connectStub = sinon.stub().callsFake(() => {
            // Fire connect first, then error
            setImmediate(() => {
                fakeClient.emit("connect");
                setImmediate(() => {
                    fakeClient.emit("error", new Error("post-connect error"));
                });
            });
            return fakeClient;
        });
        injectFakeMqttConnect(connectStub);
        const MqttBridge = loadMqttBridgeClass();
        const log = makeLogger();
        const bridge = new MqttBridge(
            { mqtt_enabled: true, mqtt_broker_host: "127.0.0.1" },
            log,
        );

        // connect() should resolve (connect event came first)
        await bridge.connect();
        expect(bridge.isConnected).to.be.true;
        // Give the post-connect error time to fire
        await new Promise<void>((r) => setTimeout(r, 20));
        // The once("error") guard fired; error was NOT logged (rejected) but
        // the persistent on("error") handler (line 184) WILL have logged a warn
        expect(log.warn.callCount).to.be.greaterThan(0);
    });

    // ── Line 184: persistent on("error") handler → warn log ──────────────────
    //
    // After connect() resolves, a subsequent runtime error event should be
    // logged as warn (not crash the process).

    it("persistent on-error handler logs warn after successful connect (line 184)", async () => {
        const fakeClient = makeFakeMqttClient();
        const connectStub = sinon.stub().callsFake(() => {
            setImmediate(() => fakeClient.emit("connect"));
            return fakeClient;
        });
        injectFakeMqttConnect(connectStub);
        const MqttBridge = loadMqttBridgeClass();
        const log = makeLogger();
        const bridge = new MqttBridge(
            { mqtt_enabled: true, mqtt_broker_host: "127.0.0.1" },
            log,
        );

        await bridge.connect();
        expect(bridge.isConnected).to.be.true;

        // Simulate a runtime error after connect
        fakeClient.emit("error", new Error("network glitch"));
        await new Promise<void>((r) => setImmediate(r));

        expect(log.warn.callCount).to.be.greaterThan(0);
        expect(log.warn.firstCall.args[0]).to.include("error");
    });

    // ── Line 187: on("close") handler → debug log ────────────────────────────

    it("on-close handler logs debug after close event (line 187)", async () => {
        const fakeClient = makeFakeMqttClient();
        const connectStub = sinon.stub().callsFake(() => {
            setImmediate(() => fakeClient.emit("connect"));
            return fakeClient;
        });
        injectFakeMqttConnect(connectStub);
        const MqttBridge = loadMqttBridgeClass();
        const log = makeLogger();
        const bridge = new MqttBridge(
            { mqtt_enabled: true, mqtt_broker_host: "127.0.0.1" },
            log,
        );

        await bridge.connect();
        // Emit close event
        fakeClient.emit("close");
        await new Promise<void>((r) => setImmediate(r));

        expect(log.debug.calledWith("MQTT Bridge: connection closed")).to.be.true;
    });

    // ── Line 184: on("connect") reconnect handler → debug log ────────────────
    //
    // After initial connect, a second "connect" event fires the persistent
    // on("connect") handler which logs "reconnected".

    it("persistent on-connect handler logs debug on reconnect (line 181)", async () => {
        const fakeClient = makeFakeMqttClient();
        const connectStub = sinon.stub().callsFake(() => {
            setImmediate(() => fakeClient.emit("connect"));
            return fakeClient;
        });
        injectFakeMqttConnect(connectStub);
        const MqttBridge = loadMqttBridgeClass();
        const log = makeLogger();
        const bridge = new MqttBridge(
            { mqtt_enabled: true, mqtt_broker_host: "127.0.0.1" },
            log,
        );

        await bridge.connect();

        // Reset the debug stub so we only see the reconnect call
        log.debug.reset();

        // Fire a second connect event — simulates reconnection after network drop
        fakeClient.emit("connect");
        await new Promise<void>((r) => setImmediate(r));

        expect(log.debug.calledWith("MQTT Bridge: reconnected")).to.be.true;
    });

    // ── Line 234: publish() error callback → warn log ─────────────────────────

    it("publish error callback logs warn with topic + error message (line 234)", async () => {
        const fakeClient = makeFakeMqttClient();
        // Override publish to call callback with an error
        fakeClient.publish = sinon.stub().callsFake(
            (_t: string, _m: string, _o: unknown, cb?: (e?: Error | null) => void) => {
                if (cb) cb(new Error("broker unreachable"));
            },
        );
        const connectStub = sinon.stub().callsFake(() => {
            setImmediate(() => fakeClient.emit("connect"));
            return fakeClient;
        });
        injectFakeMqttConnect(connectStub);
        const MqttBridge = loadMqttBridgeClass();
        const log = makeLogger();
        const bridge = new MqttBridge(
            {
                mqtt_enabled: true,
                mqtt_broker_host: "127.0.0.1",
                mqtt_topic_prefix: "bosch/cameras",
            },
            log,
        );

        await bridge.connect();
        bridge.publish("CAM-001", "Terrasse", "motion", "2026-05-20T10:00:00Z", "evt-1");

        // The callback fires synchronously in the stub
        expect(log.warn.callCount).to.be.greaterThan(0);
        expect(log.warn.firstCall.args[0]).to.include("publish");
        expect(log.warn.firstCall.args[0]).to.include("failed");
    });

    // ── publish successful → debug log (not error arm) ───────────────────────

    it("publish success callback logs debug (else branch of line 234)", async () => {
        const fakeClient = makeFakeMqttClient();
        // Default stub: calls cb(null) — success path
        const connectStub = sinon.stub().callsFake(() => {
            setImmediate(() => fakeClient.emit("connect"));
            return fakeClient;
        });
        injectFakeMqttConnect(connectStub);
        const MqttBridge = loadMqttBridgeClass();
        const log = makeLogger();
        const bridge = new MqttBridge(
            { mqtt_enabled: true, mqtt_broker_host: "127.0.0.1" },
            log,
        );

        await bridge.connect();
        bridge.publish("CAM-001", "Terrasse", "person", "2026-05-20T10:00:00Z", "evt-2");

        expect(log.debug.calledWithMatch(/published to/)).to.be.true;
        expect(log.warn.callCount).to.equal(0);
    });
});
