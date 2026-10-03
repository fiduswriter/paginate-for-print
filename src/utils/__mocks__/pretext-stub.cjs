// Test-environment stand-in for @chenglou/pretext (ships ESM-only).
// The predictor never runs under jsdom (no Intl.Segmenter/canvas), so the
// functions only need to exist at module-load time.
function unavailable() {
	throw new Error("pretext is not available in this environment");
}
module.exports = {
	prepare: unavailable,
	prepareWithSegments: unavailable,
	layout: unavailable,
	layoutWithLines: unavailable,
	layoutNextLine: unavailable,
	layoutNextLineRange: unavailable,
	materializeLineRange: unavailable,
	walkLineRanges: unavailable,
	measureLineStats: unavailable,
	measureNaturalWidth: unavailable,
	clearCache() {},
	setLocale() {},
};
