// Test-environment stand-in for @chenglou/pretext/rich-inline (ships
// ESM-only). The estimator never runs under jsdom (no Intl.Segmenter/
// canvas), so the functions only need to exist at module-load time.
function unavailable() {
	throw new Error("pretext is not available in this environment");
}
module.exports = {
	prepareRichInline: unavailable,
	layoutNextRichInlineLineRange: unavailable,
	materializeRichInlineLineRange: unavailable,
	walkRichInlineLineRanges: unavailable,
	measureRichInlineStats: unavailable,
};
