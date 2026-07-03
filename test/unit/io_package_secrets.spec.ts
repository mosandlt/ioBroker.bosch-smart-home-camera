/**
 * Regression guard for ioBroker.repositories#5983 manual review (2026-07-02):
 * `mqtt_password` was declared as a password-type field in admin/jsonConfig.json
 * ("Stored encrypted in the ioBroker object store") but `protectedNative`/
 * `encryptedNative` lived at the JSON root instead of nested under `common`,
 * so ioBroker never actually masked or encrypted it.
 *
 * Pins the fix: both arrays must exist under `common` (not the root) and
 * must list `mqtt_password`.
 */

import { expect } from "chai";
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const ioPackage = require(path.join(__dirname, "..", "..", "io-package.json")) as {
    common: { protectedNative?: string[]; encryptedNative?: string[] };
    protectedNative?: string[];
    encryptedNative?: string[];
};

describe("io-package.json secret protection", () => {
    it("test_mqtt_password_is_protected_under_common", () => {
        expect(ioPackage.common.protectedNative).to.be.an("array");
        expect(ioPackage.common.protectedNative).to.include("mqtt_password");
    });

    it("test_mqtt_password_is_encrypted_under_common", () => {
        expect(ioPackage.common.encryptedNative).to.be.an("array");
        expect(ioPackage.common.encryptedNative).to.include("mqtt_password");
    });

    it("test_no_stray_root_level_native_protection_arrays", () => {
        // Regression: these must NOT live at the JSON root — ioBroker only reads
        // them from common.*, a root-level copy is silently ignored.
        expect(ioPackage.protectedNative).to.equal(undefined);
        expect(ioPackage.encryptedNative).to.equal(undefined);
    });
});
