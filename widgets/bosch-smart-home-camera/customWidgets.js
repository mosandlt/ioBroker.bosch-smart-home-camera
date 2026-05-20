/**
 * Bosch Smart Home Camera — VIS-2 Widget (alpha, v0.1.0)
 *
 * Self-contained vanilla-JS bundle. Registered as a vis-2 widget set via
 * io-package.json → common.visWidgets.boschCameraSet.url.
 *
 * Widget: BoschCameraTile
 *   - Displays camera name + snapshot image (auto-refresh every 30 s)
 *   - Privacy toggle button (reads cameras.<id>.privacy_enabled,
 *     writes cameras.<id>.privacy_enabled)
 *   - Light toggle button (reads cameras.<id>.front_light_enabled,
 *     writes cameras.<id>.front_light_enabled; hidden when DP absent)
 *   - Motion indicator dot (cameras.<id>.motion_active)
 *   - Online/offline badge (cameras.<id>.online)
 *
 * Datapoints used (all under bosch-smart-home-camera.0.cameras.<camId>):
 *   READ:  name, online, snapshot_path (base64 via last_event_image fallback),
 *          last_event_image, privacy_enabled, front_light_enabled, motion_active
 *   WRITE: privacy_enabled (boolean toggle), front_light_enabled (boolean toggle)
 *
 * No external dependencies. Does NOT import React or any npm package.
 * Compatibility: VIS-2 >= 2.0. Falls back gracefully if vis global absent.
 */

/* global vis */
(function () {
    "use strict";

    // ── widget descriptor ──────────────────────────────────────────────────────
    var widgetId = "tplBoschCameraTile";
    var widgetSet = "bosch-smart-home-camera";

    var widgetInfo = {
        id: widgetId,
        visSet: widgetSet,
        visSetLabel: "bosch_camera_widget_set_label",
        visSetColor: "#007bc1",
        visName: "Bosch Camera Tile",
        visAttrs: [
            {
                name: "common",
                fields: [
                    {
                        name: "cam_id_dp",
                        label: "Camera ID datapoint",
                        type: "id",
                        tooltip:
                            "Select bosch-smart-home-camera.0.cameras.<UUID>.name — the UUID is auto-extracted from the path.",
                    },
                    {
                        name: "show_light_btn",
                        label: "Show light button",
                        type: "checkbox",
                        default: true,
                    },
                    {
                        name: "refresh_interval",
                        label: "Snapshot refresh (seconds)",
                        type: "number",
                        default: 30,
                        min: 5,
                        max: 300,
                    },
                    {
                        name: "tile_width",
                        label: "Tile width (px, 0 = 100%)",
                        type: "number",
                        default: 320,
                        min: 0,
                    },
                ],
            },
        ],
        visPrev:
            "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMjAgMjAwIj48cmVjdCB3aWR0aD0iMzIwIiBoZWlnaHQ9IjIwMCIgZmlsbD0iIzFhMWEyZSIvPjxjaXJjbGUgY3g9IjE2MCIgY3k9Ijg1IiByPSIzNSIgZmlsbD0iIzAwN2JjMSIvPjxwb2x5Z29uIHBvaW50cz0iMTQ1LDcwIDE3NSw4NSAxNDUsMTAwIiBmaWxsPSIjZmZmIi8+PHRleHQgeD0iMTYwIiB5PSIxNDUiIGZvbnQtZmFtaWx5PSJzYW5zLXNlcmlmIiBmb250LXNpemU9IjE0IiBmaWxsPSIjY2NjIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj5Cb3NjaCBDYW1lcmEgVGlsZTwvdGV4dD48cmVjdCB4PSI2MCIgeT0iMTYwIiB3aWR0aD0iODAiIGhlaWdodD0iMjQiIHJ4PSI0IiBmaWxsPSIjMDA3YmMxIi8+PHRleHQgeD0iMTAwIiB5PSIxNzciIGZvbnQtZmFtaWx5PSJzYW5zLXNlcmlmIiBmb250LXNpemU9IjExIiBmaWxsPSIjZmZmIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj5Qcml2YWN5PC90ZXh0PjxyZWN0IHg9IjE4MCIgeT0iMTYwIiB3aWR0aD0iODAiIGhlaWdodD0iMjQiIHJ4PSI0IiBmaWxsPSIjZjU5ZTBiIi8+PHRleHQgeD0iMjIwIiB5PSIxNzciIGZvbnQtZmFtaWx5PSJzYW5zLXNlcmlmIiBmb250LXNpemU9IjExIiBmaWxsPSIjZmZmIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj5MaWdodDwvdGV4dD48L3N2Zz4=",
    };

    // ── CSS injected once ──────────────────────────────────────────────────────
    var CSS = [
        ".bosch-camera-tile {",
        "  display: inline-flex; flex-direction: column;",
        "  background: #1a1a2e; border-radius: 8px; overflow: hidden;",
        "  font-family: sans-serif; color: #eee; box-shadow: 0 2px 8px rgba(0,0,0,.5);",
        "  position: relative;",
        "}",
        ".bosch-camera-tile__header {",
        "  display: flex; align-items: center; justify-content: space-between;",
        "  padding: 6px 10px; background: rgba(0,0,0,.4);",
        "}",
        ".bosch-camera-tile__name { font-size: 13px; font-weight: 600; }",
        ".bosch-camera-tile__badges { display: flex; gap: 4px; align-items: center; }",
        ".bosch-camera-tile__badge {",
        "  font-size: 10px; padding: 2px 6px; border-radius: 10px; font-weight: 600;",
        "}",
        ".bosch-camera-tile__badge--online  { background: #22c55e; color: #fff; }",
        ".bosch-camera-tile__badge--offline { background: #ef4444; color: #fff; }",
        ".bosch-camera-tile__badge--motion  { background: #f59e0b; color: #fff; }",
        ".bosch-camera-tile__badge--privacy { background: #6366f1; color: #fff; }",
        ".bosch-camera-tile__snap {",
        "  width: 100%; aspect-ratio: 16/9; object-fit: cover; display: block;",
        "  background: #000; min-height: 80px;",
        "}",
        ".bosch-camera-tile__snap--placeholder {",
        "  width: 100%; aspect-ratio: 16/9; background: #0f0f23;",
        "  display: flex; align-items: center; justify-content: center;",
        "  color: #555; font-size: 12px;",
        "}",
        ".bosch-camera-tile__controls {",
        "  display: flex; gap: 6px; padding: 6px 10px; background: rgba(0,0,0,.3);",
        "}",
        ".bosch-camera-tile__btn {",
        "  flex: 1; padding: 5px 8px; border: none; border-radius: 4px;",
        "  font-size: 12px; font-weight: 600; cursor: pointer; transition: opacity .15s;",
        "}",
        ".bosch-camera-tile__btn:hover { opacity: .85; }",
        ".bosch-camera-tile__btn:active { opacity: .65; }",
        ".bosch-camera-tile__btn--privacy-off { background: #007bc1; color: #fff; }",
        ".bosch-camera-tile__btn--privacy-on  { background: #6366f1; color: #fff; }",
        ".bosch-camera-tile__btn--light-off   { background: #374151; color: #9ca3af; }",
        ".bosch-camera-tile__btn--light-on    { background: #f59e0b; color: #fff; }",
    ].join("\n");

    function injectCSS() {
        if (document.getElementById("bosch-camera-tile-css")) return;
        var s = document.createElement("style");
        s.id = "bosch-camera-tile-css";
        s.textContent = CSS;
        document.head.appendChild(s);
    }

    // ── extract camId from a DP path like "bosch-smart-home-camera.0.cameras.UUID.name" ──
    function camIdFromDp(dp) {
        if (!dp) return null;
        // accept full path "bosch-smart-home-camera.0.cameras.<UUID>.<field>"
        // or short path "cameras.<UUID>.<field>"
        var m = dp.match(/cameras\.([^.]+)/);
        return m ? m[1] : null;
    }

    // ── derive instance from DP path ─────────────────────────────────────────
    function instanceFromDp(dp) {
        if (!dp) return "0";
        var m = dp.match(/bosch-smart-home-camera\.(\d+)\./);
        return m ? m[1] : "0";
    }

    // ── build canonical DP path ───────────────────────────────────────────────
    function dp(instance, camId, field) {
        return (
            "bosch-smart-home-camera." + instance + ".cameras." + camId + "." + field
        );
    }

    // ── Widget class ──────────────────────────────────────────────────────────
    function BoschCameraTileWidget() {
        this._el = null;
        this._timer = null;
        this._camId = null;
        this._instance = "0";
        this._subscriptions = [];
        this._states = {
            name: "",
            online: false,
            privacy: false,
            light: false,
            motion: false,
            lastImage: "",
        };
    }

    BoschCameraTileWidget.prototype.init = function (widgetData, el) {
        this._el = el;
        var rawDp = widgetData.cam_id_dp || "";
        this._camId = camIdFromDp(rawDp);
        this._instance = instanceFromDp(rawDp);
        this._showLight =
            widgetData.show_light_btn !== undefined
                ? widgetData.show_light_btn
                : true;
        this._refreshInterval = Math.max(
            5,
            parseInt(widgetData.refresh_interval, 10) || 30
        );
        var width =
            parseInt(widgetData.tile_width, 10) || 320;
        if (width > 0) {
            el.style.width = width + "px";
        } else {
            el.style.width = "100%";
        }

        injectCSS();
        this._render();

        if (!this._camId) return; // no cam configured yet

        var self = this;
        var subs = [
            ["name", function (id, state) { if (state) { self._states.name = state.val || ""; self._updateName(); } }],
            ["online", function (id, state) { if (state) { self._states.online = !!state.val; self._updateBadges(); } }],
            ["privacy_enabled", function (id, state) { if (state) { self._states.privacy = !!state.val; self._updateBadges(); self._updateButtons(); } }],
            ["front_light_enabled", function (id, state) { if (state) { self._states.light = !!state.val; self._updateButtons(); } }],
            ["motion_active", function (id, state) { if (state) { self._states.motion = !!state.val; self._updateBadges(); } }],
            ["last_event_image", function (id, state) { if (state && state.val) { self._states.lastImage = state.val; self._updateSnapshot(); } }],
        ];

        for (var i = 0; i < subs.length; i++) {
            var dpPath = dp(this._instance, this._camId, subs[i][0]);
            var handler = subs[i][1];
            if (window.vis && vis.conn) {
                vis.conn.getStates(
                    [dpPath],
                    (function (h) {
                        return function (err, states) {
                            if (!err && states) {
                                for (var k in states) {
                                    h(k, states[k]);
                                }
                            }
                        };
                    })(handler)
                );
                vis.conn.subscribe(dpPath, handler);
                this._subscriptions.push({ id: dpPath, handler: handler });
            }
        }

        // Periodic snapshot trigger (writes snapshot_trigger = true)
        this._startSnapshotTimer();
    };

    BoschCameraTileWidget.prototype._startSnapshotTimer = function () {
        var self = this;
        if (this._timer) clearInterval(this._timer);
        this._timer = setInterval(function () {
            if (!window.vis || !vis.conn || !self._camId) return;
            var trigDp = dp(self._instance, self._camId, "snapshot_trigger");
            vis.conn.setState(trigDp, true, function () {});
        }, this._refreshInterval * 1000);
    };

    BoschCameraTileWidget.prototype._render = function () {
        var el = this._el;
        el.innerHTML = "";
        var tile = document.createElement("div");
        tile.className = "bosch-camera-tile";

        // header
        var header = document.createElement("div");
        header.className = "bosch-camera-tile__header";
        var nameEl = document.createElement("span");
        nameEl.className = "bosch-camera-tile__name";
        nameEl.textContent = this._states.name || (this._camId ? this._camId.slice(0, 8) : "Bosch Camera");
        header.appendChild(nameEl);
        var badges = document.createElement("span");
        badges.className = "bosch-camera-tile__badges";
        header.appendChild(badges);
        tile.appendChild(header);

        // snapshot area
        var snapWrap = document.createElement("div");
        snapWrap.style.position = "relative";
        if (this._states.lastImage) {
            var img = document.createElement("img");
            img.className = "bosch-camera-tile__snap";
            img.alt = "Camera snapshot";
            img.src = "data:image/jpeg;base64," + this._states.lastImage;
            snapWrap.appendChild(img);
        } else {
            var placeholder = document.createElement("div");
            placeholder.className = "bosch-camera-tile__snap--placeholder";
            placeholder.textContent = this._camId ? "Waiting for snapshot…" : "Select a camera datapoint";
            snapWrap.appendChild(placeholder);
        }
        tile.appendChild(snapWrap);

        // controls
        var controls = document.createElement("div");
        controls.className = "bosch-camera-tile__controls";

        var privBtn = document.createElement("button");
        privBtn.className =
            "bosch-camera-tile__btn " +
            (this._states.privacy
                ? "bosch-camera-tile__btn--privacy-on"
                : "bosch-camera-tile__btn--privacy-off");
        privBtn.textContent = this._states.privacy ? "Privacy ON" : "Privacy OFF";
        var self = this;
        privBtn.addEventListener("click", function () {
            if (!self._camId || !window.vis || !vis.conn) return;
            var newVal = !self._states.privacy;
            vis.conn.setState(
                dp(self._instance, self._camId, "privacy_enabled"),
                newVal,
                function () {}
            );
        });
        controls.appendChild(privBtn);

        if (this._showLight) {
            var lightBtn = document.createElement("button");
            lightBtn.className =
                "bosch-camera-tile__btn " +
                (this._states.light
                    ? "bosch-camera-tile__btn--light-on"
                    : "bosch-camera-tile__btn--light-off");
            lightBtn.textContent = this._states.light ? "Light ON" : "Light OFF";
            lightBtn.addEventListener("click", function () {
                if (!self._camId || !window.vis || !vis.conn) return;
                var newVal = !self._states.light;
                vis.conn.setState(
                    dp(self._instance, self._camId, "front_light_enabled"),
                    newVal,
                    function () {}
                );
            });
            controls.appendChild(lightBtn);
        }

        tile.appendChild(controls);
        el.appendChild(tile);

        // store refs for incremental updates
        this._nameEl = nameEl;
        this._badges = badges;
        this._snapWrap = snapWrap;
        this._privBtn = privBtn;
        this._lightBtn = this._showLight ? lightBtn : null;
        this._controls = controls;
    };

    BoschCameraTileWidget.prototype._updateName = function () {
        if (this._nameEl) {
            this._nameEl.textContent = this._states.name || this._camId.slice(0, 8);
        }
    };

    BoschCameraTileWidget.prototype._updateBadges = function () {
        if (!this._badges) return;
        var html = "";
        html +=
            '<span class="bosch-camera-tile__badge ' +
            (this._states.online
                ? "bosch-camera-tile__badge--online"
                : "bosch-camera-tile__badge--offline") +
            '">' +
            (this._states.online ? "Online" : "Offline") +
            "</span>";
        if (this._states.motion) {
            html +=
                '<span class="bosch-camera-tile__badge bosch-camera-tile__badge--motion">Motion</span>';
        }
        if (this._states.privacy) {
            html +=
                '<span class="bosch-camera-tile__badge bosch-camera-tile__badge--privacy">Privacy</span>';
        }
        this._badges.innerHTML = html;
    };

    BoschCameraTileWidget.prototype._updateSnapshot = function () {
        if (!this._snapWrap) return;
        var existing = this._snapWrap.querySelector("img.bosch-camera-tile__snap");
        if (existing) {
            existing.src = "data:image/jpeg;base64," + this._states.lastImage;
        } else {
            this._snapWrap.innerHTML = "";
            var img = document.createElement("img");
            img.className = "bosch-camera-tile__snap";
            img.alt = "Camera snapshot";
            img.src = "data:image/jpeg;base64," + this._states.lastImage;
            this._snapWrap.appendChild(img);
        }
    };

    BoschCameraTileWidget.prototype._updateButtons = function () {
        if (this._privBtn) {
            this._privBtn.className =
                "bosch-camera-tile__btn " +
                (this._states.privacy
                    ? "bosch-camera-tile__btn--privacy-on"
                    : "bosch-camera-tile__btn--privacy-off");
            this._privBtn.textContent = this._states.privacy
                ? "Privacy ON"
                : "Privacy OFF";
        }
        if (this._lightBtn) {
            this._lightBtn.className =
                "bosch-camera-tile__btn " +
                (this._states.light
                    ? "bosch-camera-tile__btn--light-on"
                    : "bosch-camera-tile__btn--light-off");
            this._lightBtn.textContent = this._states.light
                ? "Light ON"
                : "Light OFF";
        }
    };

    BoschCameraTileWidget.prototype.destroy = function () {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        if (window.vis && vis.conn && this._subscriptions.length) {
            for (var i = 0; i < this._subscriptions.length; i++) {
                vis.conn.unsubscribe(
                    this._subscriptions[i].id,
                    this._subscriptions[i].handler
                );
            }
        }
        this._subscriptions = [];
    };

    // ── VIS-2 registration ────────────────────────────────────────────────────
    // VIS-2 loads this file and expects either:
    //   a) window.__vis2_widgets (array of {info, component}) for React-based widgets
    //   b) window.vis && vis.addWidget() for classic vis-1 style
    // We expose both so the file works under VIS-2's "url" loading mechanism.

    // Classic registration (vis-1 compatibility shim within VIS-2)
    if (typeof window !== "undefined") {
        window.__boschCameraWidgets = window.__boschCameraWidgets || [];
        window.__boschCameraWidgets.push({
            info: widgetInfo,
            factory: BoschCameraTileWidget,
        });
    }

    // VIS-2 module export — if VIS-2 calls this file as an ES module or
    // inspects window.__vis2WidgetSets, register there too.
    if (typeof window !== "undefined") {
        window.__vis2WidgetSets = window.__vis2WidgetSets || {};
        window.__vis2WidgetSets[widgetSet] = window.__vis2WidgetSets[widgetSet] || {
            name: widgetSet,
            widgets: [],
        };
        window.__vis2WidgetSets[widgetSet].widgets.push({
            id: widgetId,
            info: widgetInfo,
            factory: BoschCameraTileWidget,
        });
    }
})();
