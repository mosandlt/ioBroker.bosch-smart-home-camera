'use strict';
const path = require('node:path');
const { tests } = require('@iobroker/testing');

// Adapter starts without credentials — exits with code 11 (not configured) or
// stays alive in "awaiting login" mode. Both are valid startup outcomes.
tests.integration(path.join(__dirname, '..'), {
    allowedExitCodes: [11],
});
