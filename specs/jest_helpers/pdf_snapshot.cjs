const { toMatchImageSnapshot } = require("jest-image-snapshot");
const path = require("path");
const fs = require("fs");
const { rimrafSync } = require("rimraf");
const { DEBUG } = require("./constants.cjs");

// ghostscript4js is an optional dependency with native build requirements
// (see README, "Specs"). Only needed by tests that compare PDF snapshots.
let gs = null;
try {
	gs = require("ghostscript4js");
} catch (e) {
	// not installed
}

/**
 * Whether PDF snapshot comparisons can run in this environment. When
 * false, suites declare their snapshot tests via the global
 * `it_snapshots` helper (installed by setup_tests.cjs), which skips
 * instead of failing.
 */
const PDF_SNAPSHOTS_AVAILABLE = !!gs;
module.exports.PDF_SNAPSHOTS_AVAILABLE = PDF_SNAPSHOTS_AVAILABLE;

function UUID() {
	var d = new Date().getTime();
	if (typeof performance !== "undefined" && typeof performance.now === "function"){
		d += performance.now(); //use high-precision timer if available
	}
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
		var r = (d + Math.random() * 16) % 16 | 0;
		d = Math.floor(d / 16);
		return (c === "x" ? (r & 0x3 | 0x8) : r).toString(16);
	});
}

function toMatchPDFSnapshot(received, page = 1) {
	if (!gs) {
		throw new Error(
			"PDF snapshot tests require the optional ghostscript4js package; " +
			"see README section 'Specs' for installation instructions."
		);
	}
	let pdfImage;
	let dirname = path.dirname(this.testPath);
	let basename = path.basename(this.testPath, ".spec.js");
	let uuid = UUID();

	let pdfPath = path.join(dirname, `./${basename}.pdf`);
	let imagePath = path.join(dirname, `./${uuid}-${page}.png`);

	fs.writeFileSync(pdfPath, received);

	// create image
	gs.executeSync(`-psconv -q -dBATCH -dNOPAUSE -dFirstPage=${page} -dLastPage=${page} -sDEVICE=pngalpha -o ${imagePath} -sDEVICE=pngalpha -r144 ${pdfPath}`);
	// load image
	pdfImage = fs.readFileSync(imagePath);
	// remove output
	if (!DEBUG) {
		rimrafSync(imagePath);
		// rimrafSync(pdfPath);
	}

	// PDF rasterization differs slightly between ghostscript / chromium
	// versions and host platforms (antialiasing, glyph hinting). A small
	// per-page tolerance keeps these environment-level differences from
	// failing the suite while still catching real layout regressions.
	const config = {
		failureThreshold: 0.01,
		failureThresholdType: "percent",
	};

	return toMatchImageSnapshot.apply(this, [pdfImage, config]);
}

// Attach the availability flag to the exported matcher: the assignment
// below replaces module.exports, so the flag must be set on the function
// itself for `const { PDF_SNAPSHOTS_AVAILABLE } = require(...)` to work.
toMatchPDFSnapshot.PDF_SNAPSHOTS_AVAILABLE = PDF_SNAPSHOTS_AVAILABLE;
module.exports = toMatchPDFSnapshot;
