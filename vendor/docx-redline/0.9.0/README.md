# DOCX redline bundle

Published `@ansonlai/docx-redline-js` 0.9.0 standalone ESM bundle, downloaded
from https://cdn.jsdelivr.net/npm/@ansonlai/docx-redline-js@0.9.0/dist/docx-redline.bundle.js
and saved with an `.mjs` extension for Node ESM compatibility.

SHA-256: `2850ef9fb0d02be48b29591af762c7aca89ea9e6cc412e342cf77b5ffb307158`.

The browser and Node tests both load this file. Include this directory in static
deployments. Browsers have a same-version CDN fallback; Node deliberately fails
if the pinned local bundle is absent. The upstream MIT license is included.

When updating, download the published standalone bundle for the new version,
include its license, update `DOCX_REDLINE_VERSION` and version assertions, and
record the new checksum here. Run `node --test tests/*.test.mjs` and
`node tests/run-tests.mjs`.
