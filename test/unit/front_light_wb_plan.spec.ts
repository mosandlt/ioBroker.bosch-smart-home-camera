/**
 * Regression: Gen2 front-light whiteBalance writes are ignored by the camera
 * while the front group's brightness is 0 (found in the sibling HA
 * integration). planFrontLightWhiteBalance() must hold / restore brightness.
 */
import { expect } from "chai";
import { DEFAULT_LIGHTING_STATE, planFrontLightWhiteBalance, type LightingState } from "../../src/lib/alarm_light";

function withBrightness(b: number): LightingState {
    return {
        ...DEFAULT_LIGHTING_STATE,
        frontLightSettings: { ...DEFAULT_LIGHTING_STATE.frontLightSettings, brightness: b },
    };
}

describe("planFrontLightWhiteBalance()", () => {
    it("light on, brightness > 0: plain WB write, brightness untouched", () => {
        const plan = planFrontLightWhiteBalance(withBrightness(60), 0.5, true, 60);
        expect(plan.action).to.equal("write");
        if (plan.action !== "write") return;
        expect(plan.enableAfter).to.equal(false);
        expect(plan.body.frontLightSettings.brightness).to.equal(60);
        expect(plan.body.frontLightSettings.whiteBalance).to.equal(0.5);
        expect(plan.body.frontLightSettings.color).to.equal(null);
    });

    it("light off, brightness 0: hold (no write)", () => {
        expect(planFrontLightWhiteBalance(withBrightness(0), 0.5, false, 40).action).to.equal("hold");
    });

    it("light on but cached brightness 0: restore last non-zero brightness + enable", () => {
        const plan = planFrontLightWhiteBalance(withBrightness(0), -0.3, true, 40);
        expect(plan.action).to.equal("write");
        if (plan.action !== "write") return;
        expect(plan.enableAfter).to.equal(true);
        expect(plan.body.frontLightSettings.brightness).to.equal(40);
        expect(plan.body.frontLightSettings.whiteBalance).to.equal(-0.3);
        expect(plan.body.topLedLightSettings).to.deep.equal(DEFAULT_LIGHTING_STATE.topLedLightSettings);
    });

    it("light on, brightness 0, no history: falls back to 100", () => {
        const plan = planFrontLightWhiteBalance(withBrightness(0), 0, true, 0);
        expect(plan.action).to.equal("write");
        if (plan.action === "write") expect(plan.body.frontLightSettings.brightness).to.equal(100);
    });
});
