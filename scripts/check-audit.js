"use strict";
// Runtime-dependency audit gate: same as `npm audit --omit=dev`, except for the
// advisories listed below. Every other advisory still fails the gate.
const { spawnSync } = require("node:child_process");

// GHSA-86w9-cpqp-85rv (node-forge, RSA PKCS#1 v1.5 signature verification):
// transitive via @iobroker/adapter-core -> js-controller-common-db; no patched
// node-forge release exists yet and the adapter verifies no RSA signatures.
// Remove this entry once adapter-core ships a fixed node-forge.
const ALLOWED = new Set(["GHSA-86w9-cpqp-85rv"]);

const res = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
    encoding: "utf8",
    shell: process.platform === "win32",
});
let report;
try {
    report = JSON.parse(res.stdout);
} catch {
    console.error("audit gate: could not parse `npm audit` output");
    console.error(res.stdout || res.stderr);
    process.exit(2);
}
if (report.error) {
    console.error("audit gate: npm audit failed:", report.error.summary || report.error);
    process.exit(2);
}

const blocking = new Map();
for (const [name, vuln] of Object.entries(report.vulnerabilities || {})) {
    for (const via of vuln.via) {
        if (typeof via === "string") {
            continue; // reference to another vulnerable package, covered by its own entry
        }
        const id = (via.url || "").split("/").pop();
        if (!ALLOWED.has(id)) {
            blocking.set(`${name}: ${via.title} (${via.url})`, via.severity);
        }
    }
}
const allowed = [...ALLOWED].filter((id) => JSON.stringify(report).includes(id));
if (allowed.length) {
    console.log(`audit gate: allow-listed advisories present: ${allowed.join(", ")}`);
}
if (blocking.size) {
    console.error("audit gate: blocking advisories:");
    for (const [k, sev] of blocking) {
        console.error(`  [${sev}] ${k}`);
    }
    process.exit(1);
}
console.log("audit gate: OK (no non-allow-listed runtime advisories)");
