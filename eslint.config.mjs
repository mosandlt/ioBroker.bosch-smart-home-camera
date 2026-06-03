import config from "@iobroker/eslint-config";

export default [
    ...config,
    {
        // Build output and generated assets are not linted
        ignores: [
            "build/**",
            "admin/build/**",
            "admin/words.js",
            "node_modules/**",
            "coverage/**",
            "test/**",
            // User copy-paste automation snippets for the ioBroker javascript
            // adapter — they rely on its runtime globals (on/getState/setState)
            // and are not part of the adapter's linted TS source.
            "docs/examples/**",
            ".eslintrc.json",
        ],
    },
    {
        // JSDoc enforcement is off for internal handlers — parameter names are
        // self-explanatory (httpClient, token, cameraId, message) and adding
        // boilerplate text on every helper does not improve readability. Public
        // /src/lib API surfaces still document via richer JSDoc where it adds
        // value, but the rule plugin does not block lint output for missing
        // descriptions / returns / throws-types.
        rules: {
            "jsdoc/no-blank-blocks": "off",
            "jsdoc/require-param": "off",
            "jsdoc/require-param-description": "off",
            "jsdoc/require-param-type": "off",
            "jsdoc/require-returns": "off",
            "jsdoc/require-returns-description": "off",
            "jsdoc/require-returns-type": "off",
            "jsdoc/require-throws": "off",
            "jsdoc/require-throws-type": "off",
            "jsdoc/escape-inline-tags": "off",
        },
    },
];
