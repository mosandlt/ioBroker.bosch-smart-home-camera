import react from "@vitejs/plugin-react";
import commonjs from "vite-plugin-commonjs";
import { federation } from "@module-federation/vite";
import { moduleFederationShared } from "@iobroker/types-vis-2/modulefederation.vis.config";
import { readFileSync } from "node:fs";

const pack = JSON.parse(readFileSync("./package.json").toString());

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
