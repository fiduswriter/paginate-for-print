/**
 * Table of named page sizes for the `size` descriptor of at-page rules.
 *
 * Covers the `<page-size>` production of the CSS Paged Media Module Level 3
 * `size` property (https://www.w3.org/TR/css3-page/#page-size-prop): a
 * stylesheet may write `size: A4` (optionally followed by `landscape` or
 * `portrait`) instead of explicit dimensions, and the at-page handler
 * (`src/modules/paged-media/atpage.ts`) resolves such a keyword against this
 * table.
 *
 * The module is pure data: no functions, no unit conversion, no DOM access,
 * no import-time side effects, no mutable state. Dimensions are kept in their
 * original CSS unit (millimetres for the ISO A/B series, inches for the North
 * American formats) and handed out by reference; physical-unit resolution is
 * left to the browser's CSS engine at layout time. Every entry is a fixed
 * portrait width/height pair, so `width.value < height.value` throughout.
 *
 * Lookup is by exact, case-sensitive property access: `A4` and `letter` exist,
 * `a4` and `Letter` do not. The ISO B series is present only for B4 and B5,
 * the two sizes usable as page-size keywords in common practice.
 */

/**
 * One CSS dimension token exactly as authored: the numeric magnitude (which
 * may be fractional, e.g. `8.5`) plus the unit string (`"mm"`, `"in"`, ...).
 * No validation, rounding, normalization or conversion is applied to it
 * anywhere in this module.
 */
export interface Dimension {
	value: number;
	unit: string;
}

/**
 * A named format's fixed page dimensions in portrait orientation.
 */
export interface NamedPageSize {
	width: Dimension;
	height: Dimension;
}

/**
 * The named page size table, keyed by case-sensitive page-size keyword.
 * Consumed only by the at-page handler's `size` declaration parser; the
 * stored Dimension objects are assigned to page models without cloning, so
 * identity of these objects is observable downstream.
 */
const pageSizes: Record<string, NamedPageSize> = {
	A0: {
		width: { value: 841, unit: "mm" },
		height: { value: 1189, unit: "mm" },
	},
	A1: {
		width: { value: 594, unit: "mm" },
		height: { value: 841, unit: "mm" },
	},
	A2: {
		width: { value: 420, unit: "mm" },
		height: { value: 594, unit: "mm" },
	},
	A3: {
		width: { value: 297, unit: "mm" },
		height: { value: 420, unit: "mm" },
	},
	A4: {
		width: { value: 210, unit: "mm" },
		height: { value: 297, unit: "mm" },
	},
	A5: {
		width: { value: 148, unit: "mm" },
		height: { value: 210, unit: "mm" },
	},
	A6: {
		width: { value: 105, unit: "mm" },
		height: { value: 148, unit: "mm" },
	},
	A7: {
		width: { value: 74, unit: "mm" },
		height: { value: 105, unit: "mm" },
	},
	A8: {
		width: { value: 52, unit: "mm" },
		height: { value: 74, unit: "mm" },
	},
	A9: {
		width: { value: 37, unit: "mm" },
		height: { value: 52, unit: "mm" },
	},
	A10: {
		width: { value: 26, unit: "mm" },
		height: { value: 37, unit: "mm" },
	},
	B4: {
		width: { value: 250, unit: "mm" },
		height: { value: 353, unit: "mm" },
	},
	B5: {
		width: { value: 176, unit: "mm" },
		height: { value: 250, unit: "mm" },
	},
	letter: {
		width: { value: 8.5, unit: "in" },
		height: { value: 11, unit: "in" },
	},
	legal: {
		width: { value: 8.5, unit: "in" },
		height: { value: 14, unit: "in" },
	},
	ledger: {
		width: { value: 11, unit: "in" },
		height: { value: 17, unit: "in" },
	},
};

export default pageSizes;
