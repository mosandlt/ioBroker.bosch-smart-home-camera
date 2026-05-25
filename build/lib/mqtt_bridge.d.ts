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
/** Subset of AdapterConfig that MqttBridge needs. */
export interface MqttBridgeConfig {
    /**
     *
     */
    mqtt_enabled?: boolean;
    /**
     *
     */
    mqtt_broker_host?: string;
    /**
     *
     */
    mqtt_broker_port?: number;
    /**
     *
     */
    mqtt_username?: string;
    /**
     *
     */
    mqtt_password?: string;
    /**
     *
     */
    mqtt_topic_prefix?: string;
    /**
     *
     */
    mqtt_tls?: boolean;
}
/** Payload published on every camera event. */
export interface MqttEventPayload {
    /**
     *
     */
    timestamp: string;
    /**
     *
     */
    cam_name: string;
    /**
     *
     */
    event_id: string;
    /**
     *
     */
    event_type: string;
}
/** Minimal logger interface — matches ioBroker adapter.log. */
export interface MqttLogger {
    /**
     *
     */
    info(msg: string): void;
    /**
     *
     */
    warn(msg: string): void;
    /**
     *
     */
    debug(msg: string): void;
    /**
     *
     */
    error(msg: string): void;
}
/**
 * Optional MQTT bridge.  Call `connect()` on adapter ready, `publish()` on
 * every camera event, and `disconnect()` on adapter unload.
 */
export declare class MqttBridge {
    private _client;
    private readonly _config;
    private readonly _log;
    /** Default topic prefix when none is configured. */
    private static readonly DEFAULT_PREFIX;
    /** Default broker port. */
    private static readonly DEFAULT_PORT;
    /**
     * @param config  Adapter config (only the mqtt_* fields are read)
     * @param log     Logger (adapter.log or a test stub)
     */
    constructor(config: MqttBridgeConfig, log: MqttLogger);
    /**
     * Connect to the MQTT broker if `mqtt_enabled` is true.
     * No-op (silent) when disabled.
     * Logs a warning — but does not throw — when the broker host is missing.
     *
     * @returns Promise that resolves once connected (or immediately when disabled).
     */
    connect(): Promise<void>;
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
    publish(camId: string, camName: string, eventType: string, timestamp: string, eventId: string): void;
    /**
     * Gracefully disconnect from the broker.
     * No-op when not connected.
     *
     * @returns Promise that resolves once the client is fully closed.
     */
    disconnect(): Promise<void>;
    /**
     * Map Bosch event type → MQTT sub-topic.
     *
     * @param eventType
     */
    private static eventTypeToSubtopic;
    /** Exposed for tests only — check whether a client is wired up. */
    get isConnected(): boolean;
}
//# sourceMappingURL=mqtt_bridge.d.ts.map