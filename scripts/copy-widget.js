/**
 * Copy the built vis-2 widget bundle from src-widgets/build into
 * widgets/bosch-smart-home-camera so it ships with the adapter.
 *
 * Run after `npm --prefix src-widgets run build` (see root script
 * `build:widget`). Vite + @module-federation/vite emits customWidgets.js +
 * assets/ + a manifest into build/. Pure Node, no external deps.
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const BUILD = path.join(ROOT, "src-widgets", "build");
const SRC_I18N = path.join(ROOT, "src-widgets", "src", "i18n");
const DEST = path.join(ROOT, "widgets", "bosch-smart-home-camera");

function copyDir(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const s = path.join(from, entry.name);
        const d = path.join(to, entry.name);
        if (entry.isDirectory()) {
            copyDir(s, d);
        } else {
            fs.copyFileSync(s, d);
        }
    }
}

if (!fs.existsSync(path.join(BUILD, "customWidgets.js"))) {
    console.error("copy-widget: src-widgets/build/customWidgets.js missing — run the widget build first");
    process.exit(1);
}

// wipe the previous bundle entirely, then mirror the fresh build output
if (fs.existsSync(DEST)) {
    fs.rmSync(DEST, { recursive: true, force: true });
}
copyDir(BUILD, DEST);

// ship the source-of-truth i18n alongside (io-package i18n)
fs.mkdirSync(path.join(DEST, "i18n"), { recursive: true });
for (const f of fs.readdirSync(SRC_I18N)) {
    if (f.endsWith(".json")) {
        fs.copyFileSync(path.join(SRC_I18N, f), path.join(DEST, "i18n", f));
    }
}

console.log("copy-widget: widget bundle copied to widgets/bosch-smart-home-camera");
