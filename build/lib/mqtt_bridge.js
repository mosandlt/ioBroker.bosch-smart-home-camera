"use strict";
/**
 * MqttBridge — optional MQTT event publisher for the Bosch Smart Home Camera adapter.
 *
 * When `mqtt_enabled` is true the bridge connects to the configured broker and
 * publishes camera events (motion / person / audio_alarm) as JSON payloads:
 *
 *   <prefix>/<cam_id>/motion    { timestamp, cam_name, event_id, event_type }
 *   <prefix>/<cam_id>/person    { timestamp, cam_name, event_id, event_type }
 *   <prefix>/<cam_id>/audio     { timestamp, cam_name, event_id, event_type }
 *
 * The class is intentionally self-contained so it can be mocked / injected
 * in unit tests without loading the full adapter core.
 *
 * v0.7.9
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MqttBridge = void 0;
const mqtt = __importStar(require("mqtt"));
// ── MqttBridge class ───────────────────────────────────────────────────────────
/**
 * Optional MQTT bridge.  Call `connect()` on adapter ready, `publish()` on
 * every camera event, and `disconnect()` on adapter unload.
 */
class MqttBridge {
    _client = null;
    _config;
    _log;
    /** Default topic prefix when none is configured. */
    static DEFAULT_PREFIX = "bosch/cameras";
    /** Default broker port. */
    static DEFAULT_PORT = 1883;
    /**
     * @param config  Adapter config (only the mqtt_* fields are read)
     * @param log     Logger (adapter.log or a test stub)
     */
    constructor(config, log) {
        this._config = config;
        this._log = log;
    }
    /**
     * Connect to the MQTT broker if `mqtt_enabled` is true.
     * No-op (silent) when disabled.
     * Logs a warning — but does not throw — when the broker host is missing.
     *
     * @returns Promise that resolves once connected (or immediately when disabled).
     */
    async connect() {
        if (!this._config.mqtt_enabled) {
            return;
        }
        const host = this._config.mqtt_broker_host ?? "";
        if (!host) {
            this._log.warn("MQTT Bridge: mqtt_enabled=true but no broker host configured — skipping");
            return;
        }
        const port = this._config.mqtt_broker_port ?? MqttBridge.DEFAULT_PORT;
        const protocol = this._config.mqtt_tls ? "mqtts" : "mqtt";
        const url = `${protocol}://${host}:${port}`;
        const opts = {
            reconnectPeriod: 5000,
        };
        if (this._config.mqtt_username) {
            opts.username = this._config.mqtt_username;
        }
        if (this._config.mqtt_password) {
            opts.password = this._config.mqtt_password;
        }
        this._log.info(`MQTT Bridge: connecting to ${url}`);
        return new Promise((resolve, reject) => {
            const client = mqtt.connect(url, opts);
            let settled = false;
            client.once("connect", () => {
                if (settled) {
                    return;
                }
                settled = true;
                this._client = client;
                this._log.info(`MQTT Bridge: connected to ${url}`);
                resolve();
            });
            client.once("error", (err) => {
                if (settled) {
                    return;
                }
                settled = true;
                this._log.error(`MQTT Bridge: connection failed — ${err.message}`);
                reject(err);
            });
            // After the initial connect/error, wire up persistent error handler
            // so runtime MQTT errors are logged instead of crashing the process.
            client.on("connect", () => {
                this._log.debug("MQTT Bridge: reconnected");
            });
            client.on("error", (err) => {
                this._log.warn(`MQTT Bridge: error — ${err.message}`);
            });
            client.on("close", () => {
                this._log.debug("MQTT Bridge: connection closed");
            });
        });
    }
    /**
     * Publish a camera event to the appropriate MQTT topic.
     *
     * Topic mapping:
     *   motion      → <prefix>/<cam_id>/motion
     *   person      → <prefix>/<cam_id>/person
     *   audio_alarm → <prefix>/<cam_id>/audio
     *
     * No-op when MQTT is not connected.
     *
     * @param camId      Camera UUID
     * @param camName    Human-readable camera name
     * @param eventType  "motion" | "person" | "audio_alarm"
     * @param timestamp  ISO 8601 timestamp of the event
     * @param eventId    Unique event identifier (or empty string)
     */
    publish(camId, camName, eventType, timestamp, eventId) {
        if (!this._client) {
            return;
        }
        const prefix = this._config.mqtt_topic_prefix ?? MqttBridge.DEFAULT_PREFIX;
        const subtopic = MqttBridge.eventTypeToSubtopic(eventType);
        const topic = `${prefix}/${camId}/${subtopic}`;
        const payload = {
            timestamp,
            cam_name: camName,
            event_id: eventId,
            event_type: eventType,
        };
        const msg = JSON.stringify(payload);
        this._client.publish(topic, msg, { qos: 0, retain: false }, (err) => {
            if (err) {
                this._log.warn(`MQTT Bridge: publish to ${topic} failed — ${err.message}`);
            }
            else {
                this._log.debug(`MQTT Bridge: published to ${topic}`);
            }
        });
    }
    /**
     * Gracefully disconnect from the broker.
     * No-op when not connected.
     *
     * @returns Promise that resolves once the client is fully closed.
     */
    async disconnect() {
        if (!this._client) {
            return;
        }
        const client = this._client;
        this._client = null;
        return new Promise((resolve) => {
            client.end(false, {}, () => {
                this._log.info("MQTT Bridge: disconnected");
                resolve();
            });
        });
    }
    /**
     * Map Bosch event type → MQTT sub-topic.
     *
     * @param eventType
     */
    static eventTypeToSubtopic(eventType) {
        if (eventType === "audio_alarm") {
            return "audio";
        }
        // "motion" → "motion", "person" → "person", unknown → verbatim
        return eventType;
    }
    /** Exposed for tests only — check whether a client is wired up. */
    get isConnected() {
        return this._client !== null;
    }
}
exports.MqttBridge = MqttBridge;
//# sourceMappingURL=mqtt_bridge.js.map