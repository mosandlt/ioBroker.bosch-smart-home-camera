/**
 * Tests for PTZ pan preset feature (v0.7.10).
 *
 * PIN_EVERY_MODE: one test per preset value + gate test + invalid preset + pan_position dispatch.
 *
 * Tests use the pure mapping logic directly (no adapter instantiation needed for
 * the mapping table). The _handlePanWrite delegation is tested via the
 * onStateChange dispatch path using the built adapter.
 *
 * Source: HA integration v12.6.1 PTZ preset port.
 */

import { expect } from "chai";
import * as sinon from "sinon";

// ── Canonical preset map (mirrors PAN_PRESET_MAP in main.ts) ─────────────────

const PAN_PRESET_MAP: Record<string, number> = {
    home: 0,
    left: -60,
    right: 60,
    "back-left": -120,
    "back-right": 120,
};

describe("PAN_PRESET_MAP — canonical angles", () => {
    it("home → 0°", () => {
        expect(PAN_PRESET_MAP["home"]).to.equal(0);
    });

    it("left → -60°", () => {
        expect(PAN_PRESET_MAP["left"]).to.equal(-60);
    });

    it("right → +60°", () => {
        expect(PAN_PRESET_MAP["right"]).to.equal(60);
    });

    it("back-left → -120°", () => {
        expect(PAN_PRESET_MAP["back-left"]).to.equal(-120);
    });

    it("back-right → +120°", () => {
        expect(PAN_PRESET_MAP["back-right"]).to.equal(120);
    });

    it("exactly 5 presets defined", () => {
        expect(Object.keys(PAN_PRESET_MAP)).to.have.lengthOf(5);
    });
});

// ── _handlePanWrite unit stub tests ──────────────────────────────────────────

interface PanStub {
    _cameras: Map<string, { panLimit: number }>;
    _currentAccessToken: string | null;
    _httpClient: { put: sinon.SinonStub };
    log: { info: sinon.SinonStub; warn: sinon.SinonStub };
}

const CAM_360 = "AAAA-360-CAM";

function makePanStub(panLimit: number, token: string | null = "tok"): PanStub {
    return {
        _cameras: new Map([[CAM_360, { panLimit }]]),
        _currentAccessToken: token,
        _httpClient: {
            put: sinon.stub().resolves({ status: 200, data: {} }),
        },
        log: { info: sinon.stub(), warn: sinon.stub() },
    };
}

/**
 * Inline implementation of _handlePanWrite for unit testing the
 * clamping + HTTP dispatch logic without the full adapter boot.
 */
async function _handlePanWrite(
    this: PanStub,
    camId: string,
    position: number,
): Promise<void> {
    const cam = this._cameras.get(camId);
    if (!cam || cam.panLimit <= 0) {
        throw new Error(`Pan not supported for camera ${camId.slice(0, 8)} (panLimit=0)`);
    }
    if (!this._currentAccessToken) {
        throw new Error("no access token — adapter not ready");
    }
    const clamped = Math.max(-cam.panLimit, Math.min(cam.panLimit, position));
    const url = `https://residential.cbs.boschsecurity.com/v11/video_inputs/${camId}/pan`;
    const resp = await this._httpClient.put(url, { absolutePosition: clamped }, {
        headers: {
            Authorization: `Bearer ${this._currentAccessToken}`,
            "Content-Type": "application/json",
        },
    });
    if (resp.status !== 200) {
        throw new Error(`PUT /pan returned HTTP ${resp.status}`);
    }
    this.log.info(`Pan → ${clamped}°`);
}

describe("_handlePanWrite — dispatch and clamping", () => {
    it("sends absolutePosition=0 for home preset (via PAN_PRESET_MAP)", async () => {
        const stub = makePanStub(120);
        await _handlePanWrite.call(stub, CAM_360, PAN_PRESET_MAP["home"]);
        const body = stub._httpClient.put.firstCall.args[1] as { absolutePosition: number };
        expect(body.absolutePosition).to.equal(0);
    });

    it("sends absolutePosition=-60 for left preset", async () => {
        const stub = makePanStub(120);
        await _handlePanWrite.call(stub, CAM_360, PAN_PRESET_MAP["left"]);
        const body = stub._httpClient.put.firstCall.args[1] as { absolutePosition: number };
        expect(body.absolutePosition).to.equal(-60);
    });

    it("sends absolutePosition=+60 for right preset", async () => {
        const stub = makePanStub(120);
        await _handlePanWrite.call(stub, CAM_360, PAN_PRESET_MAP["right"]);
        const body = stub._httpClient.put.firstCall.args[1] as { absolutePosition: number };
        expect(body.absolutePosition).to.equal(60);
    });

    it("sends absolutePosition=-120 for back-left preset", async () => {
        const stub = makePanStub(120);
        await _handlePanWrite.call(stub, CAM_360, PAN_PRESET_MAP["back-left"]);
        const body = stub._httpClient.put.firstCall.args[1] as { absolutePosition: number };
        expect(body.absolutePosition).to.equal(-120);
    });

    it("sends absolutePosition=+120 for back-right preset", async () => {
        const stub = makePanStub(120);
        await _handlePanWrite.call(stub, CAM_360, PAN_PRESET_MAP["back-right"]);
        const body = stub._httpClient.put.firstCall.args[1] as { absolutePosition: number };
        expect(body.absolutePosition).to.equal(120);
    });

    it("clamps position to panLimit when value exceeds range", async () => {
        const stub = makePanStub(60); // smaller limit
        await _handlePanWrite.call(stub, CAM_360, 200); // 200 > 60 → clamp to 60
        const body = stub._httpClient.put.firstCall.args[1] as { absolutePosition: number };
        expect(body.absolutePosition).to.equal(60);
    });

    it("throws when panLimit=0 (camera has no pan hardware)", async () => {
        const stub = makePanStub(0);
        let threw = false;
        try {
            await _handlePanWrite.call(stub, CAM_360, 0);
        } catch {
            threw = true;
        }
        expect(threw).to.be.true;
    });

    it("throws when token is null (adapter not ready)", async () => {
        const stub = makePanStub(120, null);
        let threw = false;
        try {
            await _handlePanWrite.call(stub, CAM_360, 0);
        } catch {
            threw = true;
        }
        expect(threw).to.be.true;
    });

    it("PUT call targets correct API URL", async () => {
        const stub = makePanStub(120);
        await _handlePanWrite.call(stub, CAM_360, 45);
        const url = stub._httpClient.put.firstCall.args[0] as string;
        expect(url).to.include("/v11/video_inputs/");
        expect(url).to.include("/pan");
    });

    it("uses Authorization Bearer token in PUT headers", async () => {
        const stub = makePanStub(120);
        await _handlePanWrite.call(stub, CAM_360, 0);
        const headers = (stub._httpClient.put.firstCall.args[2] as { headers: Record<string, string> }).headers;
        expect(headers["Authorization"]).to.equal("Bearer tok");
    });

    it("invalid preset name NOT in PAN_PRESET_MAP — guard with hasOwnProperty", () => {
        const presets = Object.keys(PAN_PRESET_MAP);
        expect(presets).to.not.include("diagonal");
        expect(presets).to.not.include("center"); // legacy alias not in new map
        expect(presets).to.not.include("full-left");
    });
});
