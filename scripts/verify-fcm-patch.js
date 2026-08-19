#!/usr/bin/env node
/**
 * Fails loudly if the @aracna/fcm crypto-key/encryption header-parsing patch
 * (patches/@aracna+fcm+1.0.33.patch) did not apply, or applied only partially,
 * to node_modules.
 *
 * Background: @aracna/fcm's FcmClient (both published npm versions through
 * 1.0.33 and the upstream GitHub source, confirmed 2026-08-19) extracts the
 * WebPush `dh`/`salt` ECE parameters via a naive `header.value.slice(3)` /
 * `.slice(5)`, assuming the header is ALWAYS exactly "dh=<key>"/"salt=<value>"
 * with nothing else. RFC 8291-legal multi-segment headers (e.g.
 * "dh=<key>; p256ecdsa=<vapid>") or a different segment order silently corrupt
 * the extracted key bytes — surfacing as "Invalid EC key" decrypt failures or
 * dropped push messages (same bug class already fixed in the sibling HA
 * integration's Python FCM library). patches/@aracna+fcm+1.0.33.patch replaces
 * both call sites with a segment-scanning extraction (see
 * src/lib/fcm.ts::extractEceHeaderField for the equivalent, unit-tested logic).
 *
 * `npx patch-package` already fails the install (non-zero exit) if a patch
 * cannot be applied at all. This script is a second, more specific guard: it
 * checks the patch actually landed in the shape we expect, so a future
 * @aracna/fcm bump that changes the minified file just enough for the patch to
 * still *apply* (e.g. only whitespace/ordering differs) but leaves the buggy
 * .slice(3)/.slice(5) calls in a NEW, unpatched location can't silently ship.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const TARGET = path.join(
    __dirname,
    "..",
    "node_modules",
    "@aracna",
    "fcm",
    "classes",
    "fcm-client.js",
);
const MARKER = "__boschFcmEceField";
const EXPECTED_MARKER_COUNT = 5; // 1 function definition + 4 call sites (dh/salt × 2 decode paths)

function fail(message) {
    console.error(`[verify-fcm-patch] FATAL: ${message}`);
    process.exit(1);
}

let content;
try {
    content = fs.readFileSync(TARGET, "utf8");
} catch (err) {
    fail(
        `could not read ${TARGET}: ${err instanceof Error ? err.message : String(err)}. ` +
            "Is @aracna/fcm installed? Run 'npm install' first.",
    );
    return;
}

const markerCount = content.split(MARKER).length - 1;
const stillHasBuggySlices = /\.value\.slice\(3\)|\.value\.slice\(5\)/.test(content);

if (markerCount < EXPECTED_MARKER_COUNT || stillHasBuggySlices) {
    fail(
        `@aracna/fcm crypto-key/encryption header patch is MISSING or INCOMPLETE ` +
            `(found ${markerCount}/${EXPECTED_MARKER_COUNT} expected "${MARKER}" occurrences` +
            `${stillHasBuggySlices ? ", and at least one unpatched .value.slice(3)/.slice(5) call site remains" : ""}).\n` +
            "This means multi-segment WebPush headers (e.g. \"dh=<key>; p256ecdsa=<vapid>\") " +
            "will be parsed with the raw upstream slice-based bug again, silently corrupting " +
            "decrypted FCM push payloads (\"Invalid EC key\" errors / dropped messages).\n" +
            "This usually means @aracna/fcm was bumped to a version whose minified " +
            "fcm-client.js no longer matches patches/@aracna+fcm+1.0.33.patch (patch-package " +
            "applied SOMETHING but not the expected fix).\n" +
            "Fix: re-derive the patch against the new version (see " +
            "src/lib/fcm.ts::extractEceHeaderField for the reference logic) and re-run " +
            "'npx patch-package @aracna/fcm'.",
    );
} else {
    console.log(
        `[verify-fcm-patch] OK — @aracna/fcm crypto-key/encryption header patch applied ` +
            `(${markerCount}/${EXPECTED_MARKER_COUNT} markers found, no unpatched slice() call sites).`,
    );
}
