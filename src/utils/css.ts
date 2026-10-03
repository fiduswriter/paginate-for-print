/**
 * Pure string-sanitizing helpers for values the engine re-emits into CSS.
 * These prepare text extracted from the DOM so it can be embedded safely in
 * stylesheet rules: quoted string literals (pseudo-element content, string-set
 * variables) and selectors handed to `querySelectorAll`.
 */

/**
 * Cleans a pseudo-element content string for embedding in a double-quoted CSS
 * string literal: trims characters of `trim` (default: `"`, `'`, space) from
 * both ends, escapes remaining quotes with a backslash, and converts line
 * feeds to the CSS escape `\00000A`. Returns undefined for null/undefined
 * input. `trim` is inserted verbatim into a RegExp character class, so
 * class-special characters (`^`, `-`, `]`, `\`) follow character-class rules;
 * an invalid class (e.g. a lone backslash) raises a `SyntaxError`.
 */
export function cleanPseudoContent(el: string | null, trim = "\"' "): string | undefined {
	if (el == null) {
		return undefined;
	}
	return el
		.replace(new RegExp("^[" + trim + "]+"), "")
		.replace(new RegExp("[" + trim + "]+$"), "")
		.replace(/["']/g, (quote) => "\\" + quote)
		.replace(/[\n]/g, () => "\\00000A");
}

/**
 * Removes the engine's non-standard footnote pseudo-element names
 * (`::footnote-call`, `::footnote-marker`) from a CSS selector string so it
 * can be used with `querySelectorAll`. Returns undefined for null/undefined
 * input.
 */
export function cleanSelector(el: string | null): string | undefined {
	if (el == null) {
		return undefined;
	}
	return el.replace(/::footnote-call/g, "").replace(/::footnote-marker/g, "");
}
