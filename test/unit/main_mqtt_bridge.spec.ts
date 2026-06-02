/**
 * v0.7.9 — MQTT Bridge unit tests.
 *
 * All tests load the compiled build output (build/lib/mqtt_bridge.js and
 * build/main.js) so require.cache injection can intercept the `mqtt` module
 * before the production code calls mqtt.connect().
 *
 * Covers:
 *  - mqtt_enabled=false → connect() is a no-op, no mqtt.connect() call
 *  - mqtt_enabled=true, no broker_host → warn log, no crash
 *  - mqtt_enabled=true, valid config → mqtt.connect() called, isConnected=true
 *  - publish() called after connect → mqtt client.publish() called with correct topic+JSON
 *  - publish() when not connected → no-op (no throw)
 *  - disconnect() → mqtt client.end() called, isConnected=false
 *  - audio_alarm event type maps to /audio sub-topic
 *  - person event type maps to /person sub-topic
 *  - motion event type maps to /motion sub-topic
 *  - Adapter onReady with mqtt_enabled=true → bridge.connect() called
 *  - Adapter onUnload → bridge.disconnect() called
 *  - Adapter onUnload with mqtt_enabled=false → bridge.disconnect() NOT called
 */

import { expect } from "chai";
import * as sinon from "sinon";
import * as path from "path";
import { EventEmitter } from "events";

import { stubAxiosSequence, restoreAxios } from "./helpers/axios-mock";

import type { MockDatabase } from "@iobroker/testing/build/tests/unit/mocks/mockDatabase";
import type { MockAdapter } from "@iobroker/testing/build/tests/unit/mocks/mockAdapter";

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const { MockDatabase: MockDatabaseCtor } =
    require("@iobroker/testing/build/tests/unit/mocks/mockDatabase") as {
        MockDatabase: new () => MockDatabase;
    };

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const { mockAdapterCore: mockAdapterCoreFn } =
    require("@iobroker/testing/build/tests/unit/mocks/mockAdapterCore") as {
        mockAdapterCore: (
            db: MockDatabase,
            opts?: { onAdapterCreated?: (a: MockAdapter) => void },
        ) => unknown;
    };

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MAIN_JS_PATH = path.join(REPO_ROOT, "build", "main.js");
const MQTT_BRIDGE_JS_PATH = path.join(REPO_ROOT, "build", "lib", "mqtt_bridge.js");
const ADAPTER_CORE_PATH = require.resolve("@iobroker/adapter-core");
const MQTT_MODULE_PATH = require.resolve("mqtt");

type TestAdapter = MockAdapter & {
    readyHandler?: () => Promise<void>;
    unloadHandler?: (cb: () => void) => void;
    stateChangeHandler?: ioBroker.StateChangeHandler;
};

const CAM_GEN2 = "EFEFEFEF-1111-2222-3333-444455556666";

const CAMERAS_GEN2_ONLY = [
    {
        id: CAM_GEN2,
        title: "Terrasse",
        hardwareVersion: "HOME_Eyes_Outdoor",
        firmwareVersion: "9.40.25",
        featureSupport: { light: true },
    },
];

function resolveBuildModule(name: string): string {
    return path.join(REPO_ROOT, "build", "lib", `${name}.js`);
}

/** Minimal logger stub */
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

/** Fake MqttClient that resolves connect asynchronously. */
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

/** Inject a fake mqtt.connect into require.cache before loading mqtt_bridge.js. */
function injectFakeMqttConnect(
    connectStub: sinon.SinonStub,
): void {
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

/** Load the real MqttBridge class from build output (re-injects on every call). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadMqttBridgeClass(): new (cfg: Record<string, unknown>, log: LogStub) => any {
    delete require.cache[MQTT_BRIDGE_JS_PATH];
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const mod = require(MQTT_BRIDGE_JS_PATH) as { MqttBridge: new (cfg: Record<string, unknown>, log: LogStub) => unknown };
    return mod.MqttBridge as new (cfg: Record<string, unknown>, log: LogStub) => unknown;
}

// ── Layer 1: MqttBridge unit tests (via build output) ───────────────────────

describe("MqttBridge — direct unit tests (v0.7.9)", () => {
    afterEach(() => {
        sinon.restore();
        restoreMqttModule();
        delete require.cache[MQTT_BRIDGE_JS_PATH];
    });

    // ── mqtt_enabled=false → no connect ────────────────────────────────────

    it("mqtt_enabled=false → connect() is no-op, mqtt.connect not called", async () => {
        const connectStub = sinon.stub();
        injectFakeMqttConnect(connectStub);
        const MqttBridge = loadMqttBridgeClass();
        const log = makeLogger();
        const bridge = new MqttBridge({ mqtt_enabled: false }, log);
        await bridge.connect();
        expect(connectStub.callCount).to.equal(0);
        expect(bridge.isConnected).to.equal(false);
    });

    // ── mqtt_enabled=true, no host → warn + no crash ─────────────────────

    it("mqtt_enabled=true, no broker_host → warn log, no crash, not connected", async () => {
        const connectStub = sinon.stub();
        injectFakeMqttConnect(connectStub);
        const MqttBridge = loadMqttBridgeClass();
        const log = makeLogger();
        const bridge = new MqttBridge({ mqtt_enabled: true, mqtt_broker_host: "" }, log);
        await bridge.connect();
        expect(connectStub.callCount).to.equal(0);
        expect(bridge.isConnected).to.equal(false);
        expect(log.warn.callCount).to.be.greaterThan(0);
    });

    // ── mqtt_enabled=true with valid config → connected ───────────────────

    it("mqtt_enabled=true with valid config → mqtt.connect called, isConnected=true", async () => {
        const fakeClient = makeFakeMqttClient();
        const connectStub = sinon.stub().callsFake(() => {
            setImmediate(() => fakeClient.emit("connect"));
            return fakeClient;
        });
        injectFakeMqttConnect(connectStub);
        const MqttBridge = loadMqttBridgeClass();
        const log = makeLogger();
        const bridge = new MqttBridge(
            { mqtt_enabled: true, mqtt_broker_host: "127.0.0.1", mqtt_broker_port: 1883 },
            log,
        );
        await bridge.connect();
        expect(connectStub.callCount).to.equal(1);
        expect(bridge.isConnected).to.equal(true);
    });

    // ── publish: motion event → <prefix>/<cam_id>/motion ─────────────────

    it("publish: motion event → <prefix>/<cam_id>/motion with correct JSON", async () => {
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
                mqtt_topic_prefix: "bosch/cameras",
            },
            log,
        );
        await bridge.connect();
        bridge.publish(CAM_GEN2, "Terrasse", "motion", "2026-05-20T10:00:00Z", "evt-001");
        expect(fakeClient.publish.callCount).to.equal(1);
        const [topic, payloadStr] = fakeClient.publish.firstCall.args as [string, string];
        expect(topic).to.equal(`bosch/cameras/${CAM_GEN2}/motion`);
        const payload = JSON.parse(payloadStr) as Record<string, unknown>;
        expect(payload.event_type).to.equal("motion");
        expect(payload.cam_name).to.equal("Terrasse");
        expect(payload.event_id).to.equal("evt-001");
        expect(payload.timestamp).to.equal("2026-05-20T10:00:00Z");
    });

    // ── publish: person event → <prefix>/<cam_id>/person ─────────────────

    it("publish: person event → <prefix>/<cam_id>/person", async () => {
        const fakeClient = makeFakeMqttClient();
        const connectStub = sinon.stub().callsFake(() => {
            setImmediate(() => fakeClient.emit("connect"));
            return fakeClient;
        });
        injectFakeMqttConnect(connectStub);
        const MqttBridge = loadMqttBridgeClass();
        const log = makeLogger();
        const bridge = new MqttBridge(
            { mqtt_enabled: true, mqtt_broker_host: "127.0.0.1", mqtt_topic_prefix: "test/cam" },
            log,
        );
        await bridge.connect();
        bridge.publish(CAM_GEN2, "Terrasse", "person", "2026-05-20T10:01:00Z", "");
        expect(fakeClient.publish.callCount).to.equal(1);
        const [topic] = fakeClient.publish.firstCall.args as [string];
        expect(topic).to.equal(`test/cam/${CAM_GEN2}/person`);
    });

    // ── publish: audio_alarm event → <prefix>/<cam_id>/audio ─────────────

    it("publish: audio_alarm event → <prefix>/<cam_id>/audio", async () => {
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
        bridge.publish(CAM_GEN2, "Terrasse", "audio_alarm", "2026-05-20T10:02:00Z", "evt-999");
        expect(fakeClient.publish.callCount).to.equal(1);
        const [topic, payloadStr] = fakeClient.publish.firstCall.args as [string, string];
        // audio_alarm → "audio" sub-topic
        expect(topic).to.equal(`bosch/cameras/${CAM_GEN2}/audio`);
        const payload = JSON.parse(payloadStr) as Record<string, unknown>;
        expect(payload.event_type).to.equal("audio_alarm");
    });

    // ── publish when not connected → no-op ───────────────────────────────

    it("publish when not connected → no publish call, no throw", () => {
        const connectStub = sinon.stub();
        injectFakeMqttConnect(connectStub);
        const MqttBridge = loadMqttBridgeClass();
        const log = makeLogger();
        const bridge = new MqttBridge({ mqtt_enabled: false }, log);
        expect(() => {
            bridge.publish(CAM_GEN2, "Terrasse", "motion", "2026-05-20T10:00:00Z", "");
        }).not.to.throw();
    });

    // ── disconnect → client.end() called ──────────────────────────────────

    it("disconnect → mqtt client.end() called, isConnected=false", async () => {
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
        expect(bridge.isConnected).to.equal(true);
        await bridge.disconnect();
        expect(fakeClient.end.callCount).to.equal(1);
        expect(bridge.isConnected).to.equal(false);
    });

    // ── disconnect when not connected → no-op ────────────────────────────

    it("disconnect when not connected → resolves without throw", async () => {
        const connectStub = sinon.stub();
        injectFakeMqttConnect(connectStub);
        const MqttBridge = loadMqttBridgeClass();
        const log = makeLogger();
        const bridge = new MqttBridge({ mqtt_enabled: false }, log);
        // Must not throw
        await bridge.disconnect();
        expect(true).to.equal(true);
    });
});

// ── Layer 2: Adapter integration tests ───────────────────────────────────────

describe("main adapter — MQTT Bridge integration (v0.7.9)", () => {
    let mqttBridgeConnectStub: sinon.SinonStub;
    let mqttBridgeDisconnectStub: sinon.SinonStub;

    /**
     * Inject a fake MqttBridge into the build cache so main.js sees it.
     */
    function injectFakeMqttBridge(): void {
        mqttBridgeConnectStub = sinon.stub().resolves();
        mqttBridgeDisconnectStub = sinon.stub().resolves();

        const FakeBridge = class {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
            constructor(_cfg: unknown, _log: unknown) {}
            connect = mqttBridgeConnectStub;
            disconnect = mqttBridgeDisconnectStub;
            get isConnected(): boolean {
                return true;
            }
        };

        delete require.cache[MQTT_BRIDGE_JS_PATH];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (require.cache as any)[MQTT_BRIDGE_JS_PATH] = {
            id: MQTT_BRIDGE_JS_PATH,
            filename: MQTT_BRIDGE_JS_PATH,
            loaded: true,
            parent: module,
            children: [],
            path: path.dirname(MQTT_BRIDGE_JS_PATH),
            paths: [],
            exports: { MqttBridge: FakeBridge },
        };
    }

    function createAdapterWithMocks(
        _cameras: unknown[],
        configOverrides: Record<string, unknown> = {},
    ): { db: MockDatabase; adapter: TestAdapter } {
        injectFakeMqttBridge();

        const db = new MockDatabaseCtor();
        let capturedAdapter: MockAdapter | null = null;

        const core = mockAdapterCoreFn(db, {
            onAdapterCreated: (a: MockAdapter) => {
                capturedAdapter = a;
            },
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (require.cache as any)[ADAPTER_CORE_PATH] = {
            id: ADAPTER_CORE_PATH,
            filename: ADAPTER_CORE_PATH,
            loaded: true,
            parent: module,
            children: [],
            path: path.dirname(ADAPTER_CORE_PATH),
            paths: [],
            exports: core,
        };

        // snapshot mock
        const snapshotPath = resolveBuildModule("snapshot");
        delete require.cache[snapshotPath];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (require.cache as any)[snapshotPath] = {
            id: snapshotPath,
            filename: snapshotPath,
            loaded: true,
            parent: module,
            children: [],
            path: path.dirname(snapshotPath),
            paths: [],
            exports: {
                fetchSnapshot: sinon.stub().resolves(Buffer.from("FAKEJPEG")),
                buildSnapshotUrl: (u: string) => `${u}/snap.jpg`,
            },
        };

        // live_session mock
        const fakeSession = {
            camId: CAM_GEN2,
            lanAddress: "192.168.1.149:443",
            proxyUrl: "rtsp://127.0.0.1:18010/rtsp_tunnel",
            maxSessionDuration: 3600,
            openedAt: Date.now(),
            digestUser: "u",
            digestPassword: "p",
        };
        const liveSessionPath = resolveBuildModule("live_session");
        delete require.cache[liveSessionPath];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (require.cache as any)[liveSessionPath] = {
            id: liveSessionPath,
            filename: liveSessionPath,
            loaded: true,
            parent: module,
            children: [],
            path: path.dirname(liveSessionPath),
            paths: [],
            exports: {
                openLiveSession: sinon.stub().resolves(fakeSession),
                closeLiveSession: sinon.stub().resolves(),
            },
        };

        // tls_proxy mock
        const tlsProxyPath = resolveBuildModule("tls_proxy");
        delete require.cache[tlsProxyPath];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (require.cache as any)[tlsProxyPath] = {
            id: tlsProxyPath,
            filename: tlsProxyPath,
            loaded: true,
            parent: module,
            children: [],
            path: path.dirname(tlsProxyPath),
            paths: [],
            exports: {
                startTlsProxy: sinon.stub().resolves({
                    port: 18010,
                    localRtspUrl: "rtsp://127.0.0.1:18010/rtsp_tunnel",
                    stop: sinon.stub().resolves(),
                }),
            },
        };

        // session_watchdog mock
        const watchdogPath = resolveBuildModule("session_watchdog");
        delete require.cache[watchdogPath];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (require.cache as any)[watchdogPath] = {
            id: watchdogPath,
            filename: watchdogPath,
            loaded: true,
            parent: module,
            children: [],
            path: path.dirname(watchdogPath),
            paths: [],
            exports: {
                SessionWatchdog: class {
                    start = sinon.stub();
                    stop = sinon.stub();
                    constructor(_o: unknown) {}
                },
            },
        };

        delete require.cache[MAIN_JS_PATH];
        // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
        const factory = require(MAIN_JS_PATH) as (opts: Record<string, unknown>) => MockAdapter;
        factory({ config: { redirect_url: "", region: "EU", ...configOverrides } });

        if (!capturedAdapter) throw new Error("adapter not captured");
        const adapter = capturedAdapter as TestAdapter;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any).setTimeout = (_fn: () => void, _ms: number) => null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any).clearTimeout = (_h: unknown) => undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any).setInterval = (_fn: () => void, _ms: number) => null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any).clearInterval = (_h: unknown) => undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any).terminate = () => undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any).writeFileAsync = sinon.stub().resolves();

        return { db, adapter };
    }

    async function bootWithTokens(db: MockDatabase, adapter: TestAdapter): Promise<void> {
        const futureExpiry = Date.now() + 200_000;
        db.publishState(`${adapter.namespace}.info.access_token`, { val: "stored.acc", ack: true });
        db.publishState(`${adapter.namespace}.info.refresh_token`, {
            val: "stored.ref",
            ack: true,
        });
        db.publishState(`${adapter.namespace}.info.token_expires_at`, {
            val: futureExpiry,
            ack: true,
        });
        await adapter.readyHandler!();
    }

    afterEach(() => {
        restoreAxios();
        sinon.restore();
        delete require.cache[resolveBuildModule("snapshot")];
        delete require.cache[resolveBuildModule("live_session")];
        delete require.cache[resolveBuildModule("tls_proxy")];
        delete require.cache[resolveBuildModule("session_watchdog")];
        delete require.cache[MQTT_BRIDGE_JS_PATH];
        delete require.cache[MAIN_JS_PATH];
    });

    // ── mqtt_enabled=false → bridge.connect never called ─────────────────

    it("mqtt_enabled=false → MqttBridge.connect() not called on onReady", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN2_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY, {
            mqtt_enabled: false,
        });
        await bootWithTokens(db, adapter);
        expect(mqttBridgeConnectStub.callCount).to.equal(0);
    });

    // ── mqtt_enabled=true → bridge.connect called ─────────────────────────

    it("mqtt_enabled=true → MqttBridge.connect() called on onReady", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN2_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY, {
            mqtt_enabled: true,
            mqtt_broker_host: "192.168.1.100",
            mqtt_broker_port: 1883,
        });
        await bootWithTokens(db, adapter);
        expect(mqttBridgeConnectStub.callCount).to.equal(1);
    });

    // ── onUnload → bridge.disconnect() called ────────────────────────────

    it("onUnload with mqtt_enabled=true → MqttBridge.disconnect() called", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN2_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY, {
            mqtt_enabled: true,
            mqtt_broker_host: "192.168.1.100",
        });
        await bootWithTokens(db, adapter);

        let callbackCalled = false;
        await new Promise<void>((resolve) => {
            adapter.unloadHandler!(() => {
                callbackCalled = true;
                resolve();
            });
        });

        expect(callbackCalled).to.equal(true);
        expect(mqttBridgeDisconnectStub.callCount).to.equal(1);
    });

    // ── onUnload with mqtt_enabled=false → no disconnect call ────────────

    it("onUnload with mqtt_enabled=false → MqttBridge.disconnect() NOT called", async () => {
        stubAxiosSequence([{ status: 200, data: CAMERAS_GEN2_ONLY }]);
        const { db, adapter } = createAdapterWithMocks(CAMERAS_GEN2_ONLY, {
            mqtt_enabled: false,
        });
        await bootWithTokens(db, adapter);

        let callbackCalled = false;
        await new Promise<void>((resolve) => {
            adapter.unloadHandler!(() => {
                callbackCalled = true;
                resolve();
            });
        });

        expect(callbackCalled).to.equal(true);
        expect(mqttBridgeDisconnectStub.callCount).to.equal(0);
    });
});
