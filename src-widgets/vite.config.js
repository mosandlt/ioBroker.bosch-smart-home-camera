import react from "@vitejs/plugin-react";
import commonjs from "vite-plugin-commonjs";
import { federation } from "@module-federation/vite";
import { moduleFederationShared } from "@iobroker/types-vis-2/modulefederation.vis.config";
import { readFileSync } from "node:fs";

const pack = JSON.parse(readFileSync("./package.json").toString());
// Adapter version from the root package.json (e.g. 1.5.2) — shown in the banner.
const adapterPack = JSON.parse(readFileSync("../package.json").toString());

export default {
    plugins: [
        federation({
            manifest: true,
            name: "vis2BoschCameraWidgets",
            filename: "customWidgets.js",
            exposes: {
                "./BoschCamera": "./src/BoschCamera",
                "./BoschOverview": "./src/BoschOverview",
                "./translations": "./src/translations",
            },
            remotes: {},
            shared: moduleFederationShared(pack),
            dts: false,
        }),
        react(),
        commonjs(),
    ],
    define: {
        // Replaced at build time; tracks the root adapter version (../package.json).
        __WIDGET_VERSION__: JSON.stringify(adapterPack.version),
    },
    base: "./",
    build: {
        target: "chrome89",
        outDir: "./build",
        rollupOptions: {
            onwarn(warning, warn) {
                if (warning.code === "MODULE_LEVEL_DIRECTIVE") {
                    return;
                }
                warn(warning);
            },
        },
    },
};
