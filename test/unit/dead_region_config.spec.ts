/**
 * Regression guard for ioBroker.repositories#5983 manual review (2026-07-02):
 * admin/jsonConfig.json exposed an EU/US "region" dropdown and io-package.json
 * defaulted native.region to "EU", but no source file ever read
 * `this.config.region` — CLOUD_API was (and still is) hardcoded in auth.ts.
 * The setting had no effect and misled US-region users.
 *
 * Fix: removed the dead option entirely (admin/jsonConfig.json, io-package.json
 * native, adapter-config.d.ts type, orphaned i18n keys) rather than wiring up
 * an unrequested feature. Pins that it stays gone.
 */

import { expect } from "chai";
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const ioPackage = require(path.join(__dirname, "..", "..", "io-package.json")) as {
    native: Record<string, unknown>;
};

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const jsonConfig: unknown = require(path.join(__dirname, "..", "..", "admin", "jsonConfig.json"));

describe("dead region config option removal", () => {
    it("test_io_package_native_has_no_region_default", () => {
        expect(ioPackage.native).to.not.have.property("region");
    });

    it("test_json_config_has_no_region_field_anywhere", () => {
        // No tab/panel should declare a "region" jsonConfig item — search the
        // whole tree rather than assuming which tab it lived under.
        expect(JSON.stringify(jsonConfig)).to.not.include('"region"');
    });
});
