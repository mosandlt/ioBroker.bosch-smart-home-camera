/**
 * Regression guard for ioBroker.repositories#5983 manual review (2026-07-02):
 * the review flagged `mqtt_password` as missing from `protectedNative`/
 * `encryptedNative`. It was actually already present at the io-package.json
 * root (the correct, schema-valid location — `@iobroker/repochecker`'s E1105
 * check rejects these arrays if nested under `common`). A first attempt at
 * this fix moved them under `common`, which passed the reviewer's literal
 * wording but failed the real repochecker schema validation; reverted.
 *
 * Pins the correct state: both arrays live at the JSON root and list
 * `mqtt_password`.
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
    it("test_mqtt_password_is_protected_at_root", () => {
        expect(ioPackage.protectedNative).to.be.an("array");
        expect(ioPackage.protectedNative).to.include("mqtt_password");
    });

    it("test_mqtt_password_is_encrypted_at_root", () => {
        expect(ioPackage.encryptedNative).to.be.an("array");
        expect(ioPackage.encryptedNative).to.include("mqtt_password");
    });

    it("test_no_stray_common_level_native_protection_arrays", () => {
        // Regression: @iobroker/repochecker E1105 rejects these arrays if
        // nested under common — they must stay at the JSON root.
        expect(ioPackage.common.protectedNative).to.equal(undefined);
        expect(ioPackage.common.encryptedNative).to.equal(undefined);
    });
});
