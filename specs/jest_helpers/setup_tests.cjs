const { toMatchImageSnapshot } = require("jest-image-snapshot");
const toMatchPDFSnapshot = require("./pdf_snapshot.cjs");
const { PDF_SNAPSHOTS_AVAILABLE } = require("./pdf_snapshot.cjs");

expect.extend({ toMatchImageSnapshot, toMatchPDFSnapshot });

// Suites declare PDF snapshot tests via this helper: they run where
// ghostscript4js is available (the Docker image) and skip elsewhere
// instead of failing 97 suites in environments without ghostscript.
global.it_snapshots = PDF_SNAPSHOTS_AVAILABLE ? it : it.skip;
