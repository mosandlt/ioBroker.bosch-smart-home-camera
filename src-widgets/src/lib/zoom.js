/**
 * zoom.js — Digital zoom/pan controller for fullscreen camera views.
 *
 * Pure ES-module, browser target Chrome 89+.
 * No dependencies, no React, no TypeScript.
 *
 * Usage:
 *   const zc = new ZoomController({ maxScale: 4, onChange: (s) => console.log(s) });
 *   zc.attach(wrapperEl, videoEl);
 *   zc.setEnabled(true);
 *   zc.detach();
 */

// Tags/classes that own their own pointer events — zoom must not intercept them.
const EXCLUDED_TAGS = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA"]);
const EXCLUDED_CLASSES = ["pill", "overlay", "pan", "ctrl"];

/**
 * Returns true if the element (or any ancestor up to the capture element)
 * belongs to a control that should not be intercepted by zoom/pan.
 *
 * @param {EventTarget} target
 * @param {Element} captureEl
 * @returns {boolean}
 */
function isExcluded(target, captureEl) {
    let el = target;
    while (el && el !== captureEl) {
        if (el.nodeType !== Node.ELEMENT_NODE) {
            el = el.parentNode;
            continue;
        }
        if (EXCLUDED_TAGS.has(el.tagName)) {
            return true;
        }
        const cls = el.className || "";
        // className may be an SVGAnimatedString on SVG elements
        const clsStr = typeof cls === "string" ? cls : cls.baseVal || "";
        if (EXCLUDED_CLASSES.some((c) => clsStr.includes(c))) {
            return true;
        }
        el = el.parentNode;
    }
    return false;
}

/**
 * Euclidean distance between two pointer positions stored in a Map.
 *
 * @param {Map<number, {x: number, y: number}>} pointers
 * @returns {number}
 */
function pinchDistance(pointers) {
    const [a, b] = pointers.values();
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Midpoint between two pointer positions.
 *
 * @param {Map<number, {x: number, y: number}>} pointers
 * @returns {{x: number, y: number}}
 */
function pinchMidpoint(pointers) {
    const [a, b] = pointers.values();
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 *
 */
export class ZoomController {
    /**
     * @param {object} opts
     * @param {number} [opts.maxScale]
     * @param {Function} [opts.onChange]  — called with current scale after every change
     */
    constructor(opts = {}) {
        this._maxScale = opts.maxScale ?? 4;
        this._onChange = opts.onChange ?? null;

        // Transform state
        this._scale = 1;
        this._tx = 0;
        this._ty = 0;

        // Pinch / double-tap tracking
        this._prevDist = -1;
        this._lastTap = 0;

        // Active pointers for pinch detection: Map<pointerId, {x, y}>
        this._pointers = new Map();

        // DOM references (set in attach)
        this._captureEl = null;
        this._targetEl = null;

        // Enabled flag
        this._enabled = false;

        // Bound listener references stored for precise removal
        this._listeners = [];
    }

    // ─── Public API ────────────────────────────────────────────────────────────

    /** Current scale value. */
    get scale() {
        return this._scale;
    }

    /**
     * Attach listeners.
     * captureEl — element that receives pointer/wheel events.
     * targetEl  — element that receives CSS transform.
     *
     * @param {Element} captureEl
     * @param {Element} targetEl
     */
    attach(captureEl, targetEl) {
        if (this._captureEl) {
            this.detach();
        }

        this._captureEl = captureEl;
        this._targetEl = targetEl;

        this._addListener(captureEl, "pointerdown", this._onPointerDown.bind(this));
        this._addListener(captureEl, "pointermove", this._onPointerMove.bind(this));
        this._addListener(captureEl, "pointerup", this._onPointerUp.bind(this));
        this._addListener(captureEl, "pointercancel", this._onPointerUp.bind(this));
        this._addListener(captureEl, "wheel", this._onWheel.bind(this), { passive: false });
    }

    /**
     * Enable or disable zoom/pan interaction.
     * When disabled, any active transform is reset and listeners become inert.
     *
     * @param {boolean} enabled
     */
    setEnabled(enabled) {
        this._enabled = enabled;
        if (!enabled) {
            this._pointers.clear();
            this._prevDist = -1;
            this.reset();
        }
    }

    /**
     * Reset scale and pan to identity; applies transform immediately.
     */
    reset() {
        this._scale = 1;
        this._tx = 0;
        this._ty = 0;
        this._applyTransform();
    }

    /**
     * Remove all listeners and reset transform.
     */
    detach() {
        for (const { el, type, fn, opts } of this._listeners) {
            el.removeEventListener(type, fn, opts);
        }
        this._listeners = [];

        this.reset();

        this._captureEl = null;
        this._targetEl = null;
        this._pointers.clear();
        this._prevDist = -1;
    }

    // ─── Internal helpers ──────────────────────────────────────────────────────

    /**
     * Register a listener and remember it for detach().
     *
     * @param {Element} el
     * @param {string} type
     * @param {Function} fn
     * @param {object} [opts]
     */
    _addListener(el, type, fn, opts) {
        el.addEventListener(type, fn, opts);
        this._listeners.push({ el, type, fn, opts });
    }

    /**
     * Apply current state as a CSS transform.
     */
    _applyTransform() {
        if (!this._targetEl) {
            return;
        }
        this._targetEl.style.transformOrigin = "center center";
        this._targetEl.style.transform = `translate(${this._tx}px, ${this._ty}px) scale(${this._scale})`;
        if (this._onChange) {
            this._onChange(this._scale);
        }
    }

    /**
     * Clamp tx/ty so the view never pans outside the visible area.
     *
     * @param {DOMRect} rect — bounding rect of captureEl
     */
    _clampPan(rect) {
        const maxTx = ((this._scale - 1) * rect.width) / 2;
        const maxTy = ((this._scale - 1) * rect.height) / 2;
        this._tx = Math.max(-maxTx, Math.min(maxTx, this._tx));
        this._ty = Math.max(-maxTy, Math.min(maxTy, this._ty));
    }

    /**
     * Zoom to newScale anchored at a point expressed in captureEl client coordinates.
     * Adjusts tx/ty so the anchor point stays visually fixed.
     *
     * @param {number} newScale
     * @param {{x: number, y: number}} anchor — client-space coordinates
     */
    _zoomAt(newScale, anchor) {
        if (!this._captureEl) {
            return;
        }
        const rect = this._captureEl.getBoundingClientRect();

        // Convert anchor from client coords to element-local coords (centred at 0,0)
        const localX = anchor.x - rect.left - rect.width / 2;
        const localY = anchor.y - rect.top - rect.height / 2;

        // Adjust translation so the point under the anchor stays fixed
        // After: tx' + localX * newScale == tx + localX * scale
        //   =>   tx' = tx + localX * (scale - newScale)
        this._tx += localX * (this._scale - newScale);
        this._ty += localY * (this._scale - newScale);

        this._scale = newScale;
        this._clampPan(rect);
        this._applyTransform();
    }

    // ─── Pointer event handlers ────────────────────────────────────────────────

    /** @param {PointerEvent} e */
    _onPointerDown(e) {
        if (!this._enabled) {
            return;
        }
        if (isExcluded(e.target, this._captureEl)) {
            return;
        }

        this._captureEl.setPointerCapture(e.pointerId);
        this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (this._pointers.size === 2) {
            // Begin pinch — record initial distance
            this._prevDist = pinchDistance(this._pointers);
        }

        if (this._pointers.size === 1) {
            // Detect double-tap for keyboard-free zoom toggle
            const now = Date.now();
            if (now - this._lastTap < 300) {
                // Double-tap
                e.preventDefault();
                if (this._scale > 1) {
                    this.reset();
                } else {
                    const anchor = { x: e.clientX, y: e.clientY };
                    const target = Math.min(2, this._maxScale);
                    this._zoomAt(target, anchor);
                }
                this._lastTap = 0; // prevent triple-tap triggering again
            } else {
                this._lastTap = now;
            }
        }
    }

    /** @param {PointerEvent} e */
    _onPointerMove(e) {
        if (!this._enabled) {
            return;
        }
        if (!this._pointers.has(e.pointerId)) {
            return;
        }

        const prev = this._pointers.get(e.pointerId);
        const dx = e.clientX - prev.x;
        const dy = e.clientY - prev.y;

        // Update stored position
        this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (this._pointers.size === 2) {
            // Pinch-to-zoom
            const newDist = pinchDistance(this._pointers);
            if (this._prevDist > 0) {
                const ratio = newDist / this._prevDist;
                const newScale = Math.max(1, Math.min(this._maxScale, this._scale * ratio));
                const mid = pinchMidpoint(this._pointers);
                this._zoomAt(newScale, mid);
            }
            this._prevDist = newDist;
        } else if (this._pointers.size === 1 && this._scale > 1) {
            // Pan (only when zoomed in)
            const rect = this._captureEl.getBoundingClientRect();
            this._tx += dx;
            this._ty += dy;
            this._clampPan(rect);
            this._applyTransform();
        }
    }

    /** @param {PointerEvent} e */
    _onPointerUp(e) {
        if (!this._enabled) {
            this._pointers.clear();
            return;
        }
        this._pointers.delete(e.pointerId);

        if (this._pointers.size < 2) {
            this._prevDist = -1;
        }
    }

    // ─── Wheel handler ─────────────────────────────────────────────────────────

    /** @param {WheelEvent} e */
    _onWheel(e) {
        if (!this._enabled) {
            return;
        }
        if (isExcluded(e.target, this._captureEl)) {
            return;
        }

        e.preventDefault();

        const factor = e.deltaY < 0 ? 1.15 : 0.87;
        const newScale = Math.max(1, Math.min(this._maxScale, this._scale * factor));
        const anchor = { x: e.clientX, y: e.clientY };
        this._zoomAt(newScale, anchor);
    }
}
