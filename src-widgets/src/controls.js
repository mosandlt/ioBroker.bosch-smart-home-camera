// Declarative catalog of the camera's expanded controls, grouped into
// accordions. Availability is data-driven: the widget subscribes to every
// datapoint listed here via subscribeIfExists and renders a row ONLY when the
// underlying ioBroker state actually exists for the camera. That makes the
// Gen1/Gen2/indoor/outdoor gating automatic — no hard-coded model checks.
//
// Row kinds:
//   switch   — boolean writable → toggle
//   number   — numeric writable → slider (min/max/step/unit)
//   select   — string writable enum → dropdown (options: [{value,label}])
//   color    — RGB hex string writable → color picker
//   button   — write-true trigger
//   readonly — display only (diagnostics)
//
// `dp` is the per-camera state leaf (see research/iob-card-final-A-dp-catalog.md).
// `labelKey` is an i18n key resolved via Generic.t().
// `gate` (optional) = true → disabled while privacy mode is on.

export const ACCORDIONS = [
    {
        id: "notif",
        titleKey: "Notification types",
        rows: [
            { dp: "notify_movement", kind: "switch", labelKey: "Movement" },
            { dp: "notify_person", kind: "switch", labelKey: "Person detected" },
            { dp: "notify_audio", kind: "switch", labelKey: "Audio alarm" },
            { dp: "notify_trouble", kind: "switch", labelKey: "Trouble" },
            { dp: "notify_camera_alarm", kind: "switch", labelKey: "Camera alarm" },
            { dp: "notify_trouble_email", kind: "switch", labelKey: "Trouble (e-mail)" },
        ],
    },
    {
        id: "advanced",
        titleKey: "Advanced",
        rows: [
            { dp: "notifications_enabled", kind: "switch", labelKey: "Notifications" },
            { dp: "timestamp_overlay", kind: "switch", labelKey: "Timestamp overlay" },
            { dp: "autofollow_enabled", kind: "switch", labelKey: "Auto-follow", gate: true, pan: true },
            { dp: "motion_enabled", kind: "switch", labelKey: "Motion detection" },
            { dp: "record_sound", kind: "switch", labelKey: "Record sound" },
            {
                dp: "motion_sensitivity",
                kind: "select",
                labelKey: "Motion sensitivity",
                options: [
                    { value: "super_high", labelKey: "Very high" },
                    { value: "high", labelKey: "High" },
                    { value: "medium_high", labelKey: "Medium-high" },
                    { value: "medium_low", labelKey: "Medium-low" },
                    { value: "low", labelKey: "Low" },
                    { value: "off", labelKey: "Off" },
                ],
            },
        ],
    },
    {
        id: "gen2auto",
        titleKey: "Automation & Security",
        rows: [
            { dp: "motion_light_enabled", kind: "switch", labelKey: "Light on motion", gate: true },
            {
                dp: "motion_light_sensitivity",
                kind: "number",
                labelKey: "Motion-light sensitivity",
                min: 1,
                max: 5,
                step: 1,
            },
            { dp: "ambient_light_enabled", kind: "switch", labelKey: "Ambient light", gate: true },
            {
                dp: "darkness_threshold",
                kind: "number",
                labelKey: "Day/night threshold",
                min: 0,
                max: 100,
                step: 1,
                unit: "%",
            },
            {
                dp: "detection_mode",
                kind: "select",
                labelKey: "Detection mode",
                options: [
                    { value: "all_motions", labelKey: "All motion" },
                    { value: "only_humans", labelKey: "Humans only" },
                    { value: "zones", labelKey: "Zones" },
                ],
            },
            {
                dp: "intrusion_sensitivity",
                kind: "number",
                labelKey: "Intrusion sensitivity",
                min: 0,
                max: 7,
                step: 1,
            },
            {
                dp: "intrusion_distance",
                kind: "number",
                labelKey: "Intrusion distance",
                min: 1,
                max: 8,
                step: 1,
                unit: "m",
            },
            { dp: "alarm_arm", kind: "switch", labelKey: "Alarm armed", gate: true },
            { dp: "alarm_mode", kind: "switch", labelKey: "Alarm mode" },
            { dp: "pre_alarm", kind: "switch", labelKey: "Pre-alarm" },
            {
                dp: "siren_duration",
                kind: "number",
                labelKey: "Siren duration",
                min: 10,
                max: 300,
                step: 5,
                unit: "s",
            },
            {
                dp: "alarm_activation_delay",
                kind: "number",
                labelKey: "Alarm activation delay",
                min: 0,
                max: 600,
                step: 5,
                unit: "s",
            },
            {
                dp: "pre_alarm_delay",
                kind: "number",
                labelKey: "Pre-alarm delay",
                min: 0,
                max: 300,
                step: 5,
                unit: "s",
            },
            {
                dp: "power_led_brightness",
                kind: "number",
                labelKey: "Power-LED brightness",
                min: 0,
                max: 4,
                step: 1,
            },
        ],
    },
    {
        id: "gen2light",
        titleKey: "Light & Camera",
        rows: [
            { dp: "wallwasher_enabled", kind: "switch", labelKey: "Wallwasher", gate: true },
            {
                dp: "wallwasher_brightness",
                kind: "number",
                labelKey: "Wallwasher brightness",
                min: 0,
                max: 100,
                step: 1,
                unit: "%",
            },
            { dp: "wallwasher_color", kind: "color", labelKey: "Wallwasher color" },
            {
                dp: "front_light_intensity",
                kind: "number",
                labelKey: "Front light intensity",
                min: 0,
                max: 100,
                step: 1,
                unit: "%",
            },
            { dp: "status_led", kind: "switch", labelKey: "Status LED" },
            { dp: "intercom_enabled", kind: "switch", labelKey: "Intercom" },
            {
                dp: "microphone_level",
                kind: "number",
                labelKey: "Microphone level",
                min: 0,
                max: 100,
                step: 1,
                unit: "%",
            },
            {
                dp: "speaker_level",
                kind: "number",
                labelKey: "Speaker level",
                min: 0,
                max: 100,
                step: 1,
                unit: "%",
            },
            {
                dp: "lens_elevation",
                kind: "number",
                labelKey: "Lens elevation",
                min: 0.5,
                max: 5,
                step: 0.1,
                unit: "m",
            },
            { dp: "image_rotation_180", kind: "switch", labelKey: "Rotate image 180°" },
            {
                dp: "stream_quality",
                kind: "select",
                labelKey: "Stream quality",
                options: [
                    { value: "high", labelKey: "High" },
                    { value: "low", labelKey: "Low (bandwidth saver)" },
                ],
            },
        ],
    },
    {
        id: "diag",
        titleKey: "Diagnostics",
        rows: [
            { dp: "wifi_signal_pct", kind: "readonly", labelKey: "WiFi signal", unit: "%" },
            { dp: "wifi_ssid", kind: "readonly", labelKey: "WiFi SSID" },
            { dp: "firmware_version", kind: "readonly", labelKey: "Firmware" },
            { dp: "rcp_version", kind: "readonly", labelKey: "RCP version" },
            { dp: "unread_events_count", kind: "readonly", labelKey: "Unread events" },
            { dp: "last_motion_event_type", kind: "readonly", labelKey: "Last event type" },
            { dp: "maintenance_state", kind: "readonly", labelKey: "Maintenance" },
        ],
    },
    {
        id: "zones",
        titleKey: "Schedules & Zones",
        rows: [
            { dp: "motion_zones_count", kind: "readonly", labelKey: "Motion zones" },
            { dp: "privacy_masks_count", kind: "readonly", labelKey: "Privacy masks" },
            { dp: "rules_count", kind: "readonly", labelKey: "Rules" },
        ],
    },
    {
        id: "services",
        titleKey: "Services",
        rows: [
            { dp: "snapshot_trigger", kind: "button", labelKey: "Take snapshot", gate: true },
            { dp: "motion_trigger", kind: "button", labelKey: "Trigger motion" },
            { dp: "mark_all_read", kind: "button", labelKey: "Mark all read" },
        ],
    },
];

// All datapoint leaves referenced above — the widget subscribes to each via
// subscribeIfExists so rows render only when present on the camera.
export const ALL_CONTROL_DPS = ACCORDIONS.flatMap((a) => a.rows.map((r) => r.dp));
