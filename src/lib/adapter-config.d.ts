// Augment the ioBroker AdapterConfig type with adapter-specific settings
// populated from admin/jsonConfig.json

declare global {
    namespace ioBroker {
        interface AdapterConfig {
            /**
             * One-time-use OIDC redirect URL pasted by the user after browser login.
             * Format: "https://www.bosch.com/boschcam?code=XXX&state=YYY"
             * Cleared by the adapter after successful token exchange.
             */
            redirect_url: string;
            /** Cloud region: "EU" | "US" */
            region: string;
            /**
             * Expose the per-camera TLS proxy to the LAN (bind 0.0.0.0).
             * Default false — proxy listens on 127.0.0.1 only.
             * Enable when an external recorder (BlueIris, Frigate, etc.)
             * on a separate host needs to pull the stream. Forum #84538.
             */
            rtsp_expose_to_lan?: boolean;
            /**
             * Hostname / IP that the published `stream_url` should use when
             * `rtsp_expose_to_lan` is on. Typically the ioBroker host's LAN
             * IP, e.g. "192.168.1.50". Empty / unset → falls back to
             * "127.0.0.1".
             */
            rtsp_external_host?: string;
            /**
             * v0.5.3: when true (default), every motion / person / audio_alarm
             * event (via FCM push or polling fallback) auto-fetches a fresh
             * snapshot and writes a base64 copy into
             * `cameras.<id>.last_event_image` for direct
             * Telegram/Signal/Matrix push consumption.
             */
            auto_snapshot_on_motion?: boolean;
            /**
             * v0.7.7: how long (in seconds) `cameras.<id>.motion_active` stays
             * true after the last motion event before auto-clearing.
             * Range 10–300 s. Default 90 s (matches HA EVENT_ACTIVE_WINDOW).
             */
            motion_active_window?: number;
            // ── v0.7.9 MQTT Bridge ───────────────────────────────────────────
            /** Enable the MQTT event bridge. Default false. */
            mqtt_enabled?: boolean;
            /** MQTT broker hostname or IP. Required when mqtt_enabled=true. */
            mqtt_broker_host?: string;
            /** MQTT broker port. Range 1–65535. Default 1883. */
            mqtt_broker_port?: number;
            /** MQTT username (optional). */
            mqtt_username?: string;
            /** MQTT password (optional, stored encrypted). */
            mqtt_password?: string;
            /** Topic prefix for published events. Default "bosch/cameras". */
            mqtt_topic_prefix?: string;
            /** Use TLS (mqtts://) for the broker connection. Default false. */
            mqtt_tls?: boolean;
            /**
             * v0.7.16: when true (default), snapshot fetches on Gen2 cameras
             * with LAN reachability + cached Digest creds use the fast MJPEG
             * inst=3 RTSP path (~150-300 ms) instead of cloud snap.jpg
             * (~500-1500 ms). Falls back to snap.jpg on any FFmpeg error.
             */
            use_mjpeg_snapshot?: boolean;
            /**
             * v1.1.0: TCP port for the local HTTP snapshot server. When > 0 the
             * adapter serves the latest JPEG per camera at
             * `http://<host>:<port>/<camId>.jpg` (LAN, no auth) and publishes a
             * `cameras.<id>.snapshot_url` state with role `url.cam` so the
             * ioBroker type-detector + VIS camera widgets recognise it. 0 = off.
             */
            snapshot_http_port?: number;
            /**
             * Request-saving option: when true, fetch a real snapshot per camera at adapter
             * start (opens one of the 3 shared Bosch sessions each). Default
             * false (request-saving) → `online` is resolved session-lessly via
             * `_reconcileOnlineViaCloud` (LAN-TCP → /ping → /commissioned).
             */
            startup_snapshot?: boolean;
            /**
             * Request-saving option: base cloud poll interval in seconds for camera state +
             * event polling. Higher = fewer Bosch cloud requests at the cost of
             * later state updates. Clamped 30–3600 s; missing/invalid → 60 s
             * (unchanged default behaviour).
             */
            poll_interval?: number;
            /**
             * Request-saving option (opt-in, experimental, default off): tear
             * down an enabled livestream once no downstream client (go2rtc /
             * recorder / VLC) has been pulling the RTSP proxy for
             * {@link stream_idle_timeout} seconds, freeing the Bosch session.
             * Consumer presence is read from the proxy's live client-connection
             * count, so it never reaps a stream someone is actually watching.
             */
            stream_idle_reaper?: boolean;
            /**
             * Seconds with zero proxy clients before the idle reaper tears a
             * livestream down. Clamped 30–3600 s; default 180 s. Only used when
             * {@link stream_idle_reaper} is on.
             */
            stream_idle_timeout?: number;
            /**
             * Override the RTSP `maxSessionDuration` (seconds) written into the
             * published stream URL. The camera defaults to 3600 s; a continuous
             * go2rtc/recorder pull can time out at that boundary before the
             * watchdog's renewed session takes over. Raise it (e.g. 5000) to run
             * longer between renewals. Clamped 600–21600 s; 0/unset keeps the
             * camera-reported value. Forum #84538.
             */
            stream_max_session_duration?: number;
            /**
             * Request-saving option (default on): poll the rarely-changing
             * diagnostic cloud reads (zones, light config, alarm settings,
             * ONVIF/RCP, feature flags). Turn off to stop them entirely.
             */
            enable_diagnostics_polling?: boolean;
            /**
             * Request-saving option: slow diagnostic tier cadence in seconds
             * (how often the diagnostics above are polled). Clamped 60–7200 s;
             * default 300 s. The effective tick count is poll_interval_slow /
             * poll_interval.
             */
            poll_interval_slow?: number;
        }
    }
}

export {};
