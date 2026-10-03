import {
	layout,
	prepareWithSegments,
	layoutNextLineRange,
	setLocale,
	type PreparedTextWithSegments,
	type LayoutCursor,
	type PrepareOptions,
} from "@chenglou/pretext";
import {
	prepareRichInline,
	measureRichInlineStats,
	type PreparedRichInline,
	type RichInlineItem,
} from "@chenglou/pretext/rich-inline";

/**
 * Canvas/Intl-backed text measurement used to predict text break offsets
 * arithmetically instead of probing the DOM once per word.
 *
 * Pretext measures segment widths through the browser's own font engine
 * (canvas measureText) and caches them, so repeated line-layout passes are
 * pure arithmetic. Predicted break offsets are verified against real DOM
 * geometry by the caller.
 *
 * TEMPORARY: the legacy DOM-walking fallback in Layout.textBreak exists
 * only until parity testing shows this predictor handles every case; it is
 * then removed along with these capability gates.
 */

export interface FontSpec {
	/** Canvas font shorthand, e.g. `400 16px "Times New Roman"`. */
	font: string;
	/** Resolved letter-spacing in CSS px (0 when normal). */
	letterSpacing: number;
	/** Whitespace handling matched to the element's computed style. */
	whiteSpace: "normal" | "pre-wrap";
	/** Used line height in CSS px. */
	lineHeight: number;
	/** CJK word breaking; pretext models `keep-all`, not `break-all`. */
	wordBreak?: "keep-all";
}

/**
 * Cache key covering every input that changes a prepared text's metrics.
 * Shared by the eager warm-up and the lazy prediction path so both hit the
 * same cache entries.
 */
export function fontKey(spec: FontSpec): string {
	return `${spec.font}\u0000${spec.letterSpacing}\u0000${spec.whiteSpace}\u0000${spec.wordBreak || ""}`;
}

/**
 * Points pretext's segmenter at the document's locale (word breaking rules
 * differ per language). Call once per flow; safe to repeat.
 */
export function setMeasureLocale(locale?: string | null): void {
	try {
		setLocale(locale || undefined);
	} catch {
		// Unknown/unsupported locale tags must never break pagination.
	}
}

const MAX_CACHE_ENTRIES = 2048;

/**
 * Static measurements of a source element used by the column-span segment
 * height planner: everything needed to estimate a block's natural height
 * arithmetically once the source fragment is detached again.
 *
 * Captured while the source is temporarily attached (computed styles
 * resolve), keyed by the element's data-ref.
 */
export interface ElementMeasure {
	/** Canvas font spec for inline content, null when unmeasurable. */
	font: FontSpec | null;
	/** Computed display, e.g. `block`. */
	display: string;
	/** Whether the element establishes a block-level box. */
	block: boolean;
	/** Vertical margins in CSS px (collapsing is ignored by the planner). */
	marginTop: number;
	marginBottom: number;
	/** Horizontal and vertical padding + border sums in CSS px. */
	padBorderX: number;
	padBorderY: number;
}

function px(value: string | null | undefined): number {
	const parsed = parseFloat(value || "");
	return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Captures the computed-style record for one element. The element must be
 * attached to the document for styles to resolve; detached elements get no
 * meaningful values from getComputedStyle.
 */
export function buildElementMeasure(el: Element): ElementMeasure | null {
	if (typeof window === "undefined" || !window.getComputedStyle) {
		return null;
	}
	const style = window.getComputedStyle(el);
	const display = style.display || "block";
	return {
		font: buildFontSpec(el),
		display,
		block: !display.startsWith("inline") && display !== "contents",
		marginTop: px(style.marginTop),
		marginBottom: px(style.marginBottom),
		padBorderX:
			px(style.paddingLeft) +
			px(style.paddingRight) +
			px(style.borderLeftWidth) +
			px(style.borderRightWidth),
		padBorderY:
			px(style.paddingTop) +
			px(style.paddingBottom) +
			px(style.borderTopWidth) +
			px(style.borderBottomWidth),
	};
}

/**
 * A contiguous run of inline text sharing one font specification; blocks
 * with mixed inline formatting (bold, italic, size changes) are estimated
 * as a sequence of these so line counts follow the real font metrics.
 */
export interface InlineRun {
	text: string;
	spec: FontSpec;
}

/**
 * Counts the lines a text wraps into at the given width, using the shared
 * pretext measurement cache (pure arithmetic once the text is prepared).
 * Returns null when the specification cannot be measured, so callers can
 * fall back to a DOM probe. Hyphenation is not modelled, so the count can
 * err on the high side for `hyphens: auto` text — never on the low side.
 */
export function measureTextLines(
	service: TextMeasureService,
	text: string,
	spec: FontSpec | null,
	width: number,
): number | null {
	if (!spec || !(width > 0)) {
		return null;
	}
	if (!text.trim().length) {
		return 0;
	}
	try {
		const prepared = service.prepare(text, spec);
		return layout(prepared, width, spec.lineHeight).lineCount;
	} catch {
		return null;
	}
}

/**
 * Height of a block's inline content at the given width. Single-font blocks
 * go through the plain text path (sharing its cache with textBreak); blocks
 * mixing fonts are laid out as rich inline runs so each run is measured in
 * its own font. Line height is the largest run's (a line is as tall as its
 * tallest inline box). Returns null when the runs cannot be modelled
 * (e.g. pre-wrap mixed content), so the caller can fall back to a DOM probe.
 *
 * Lines are counted at a slightly narrower width than given: canvas and DOM
 * font metrics drift apart by a few percent (different fallback chains,
 * kerning), which would otherwise systematically underestimate the count.
 */
export function measureInlineRunsHeight(
	service: TextMeasureService,
	runs: InlineRun[],
	width: number,
): number | null {
	const usable = runs.filter((run) => run.text.trim().length);
	if (!usable.length || !(width > 0)) {
		return usable.length ? null : 0;
	}
	const safeWidth = width * 0.95;
	const first = usable[0].spec;
	const uniform = usable.every((run) => fontKey(run.spec) === fontKey(first));
	if (uniform) {
		const text = usable.map((run) => run.text).join("");
		const lines = measureTextLines(service, text, first, safeWidth);
		return lines === null ? null : lines * first.lineHeight;
	}
	if (usable.some((run) => run.spec.whiteSpace !== "normal")) {
		// prepareRichInline has no whitespace mode; do not guess.
		return null;
	}
	let lineHeight = 0;
	const items: RichInlineItem[] = usable.map((run) => {
		lineHeight = Math.max(lineHeight, run.spec.lineHeight);
		const item: RichInlineItem = {
			text: run.text,
			font: run.spec.font,
		};
		if (run.spec.letterSpacing) {
			item.letterSpacing = run.spec.letterSpacing;
		}
		return item;
	});
	try {
		const prepared = service.prepareRich(items);
		const stats = measureRichInlineStats(prepared, safeWidth);
		return stats.lineCount * lineHeight;
	} catch {
		return null;
	}
}

export function measurementCapabilities(): boolean {
	return (
		typeof Intl !== "undefined" &&
		typeof (Intl as unknown as { Segmenter?: unknown }).Segmenter !==
			"undefined" &&
		typeof document !== "undefined" &&
		typeof document.createElement("canvas").getContext === "function"
	);
}

/**
 * Builds a canvas font specification from an element's computed style.
 * Returns null when the style cannot be mapped faithfully enough to bother
 * predicting (the caller then uses the legacy path).
 */
export function buildFontSpec(el: Element | null | undefined): FontSpec | null {
	if (!el) {
		return null;
	}
	const style = window.getComputedStyle(el);

	const fontFamily = style.fontFamily;
	const fontSize = parseFloat(style.fontSize);
	if (!fontFamily || !Number.isFinite(fontSize) || fontSize <= 0) {
		return null;
	}

	let lineHeight = parseFloat(style.lineHeight);
	if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
		lineHeight = fontSize * 1.14;
	}

	let letterSpacing = 0;
	const rawSpacing = style.getPropertyValue("letter-spacing");
	if (rawSpacing && rawSpacing !== "none") {
		const parsed = parseFloat(rawSpacing);
		if (Number.isFinite(parsed)) {
			letterSpacing = parsed;
		}
	}

	const whiteSpace =
		style.whiteSpace === "pre-wrap" || style.whiteSpace === "break-spaces"
			? "pre-wrap"
			: "normal";
	if (
		style.whiteSpace !== "normal" &&
		style.whiteSpace !== "pre-wrap" &&
		style.whiteSpace !== "nowrap" &&
		style.whiteSpace !== "break-spaces"
	) {
		// pre lines etc. are outside pretext's model.
		return null;
	}

	const weight = style.fontWeight || "400";
	const fontStyle = style.fontStyle && style.fontStyle !== "normal" ? style.fontStyle + " " : "";

	const spec: FontSpec = {
		font: `${fontStyle}${weight} ${fontSize}px ${fontFamily}`,
		letterSpacing,
		whiteSpace,
		lineHeight,
	};
	if (style.wordBreak === "keep-all") {
		spec.wordBreak = "keep-all";
	}
	return spec;
}

export class TextMeasureService {
	private cache: Map<string, PreparedTextWithSegments>;
	private richCache: Map<string, PreparedRichInline>;

	constructor() {
		this.cache = new Map();
		this.richCache = new Map();
	}

	/**
	 * Prepares (and caches) a text for measurement. Cache keys include every
	 * input that changes metrics.
	 */
	prepare(text: string, spec: FontSpec): PreparedTextWithSegments {
		const options: PrepareOptions = {
			whiteSpace: spec.whiteSpace,
		};
		if (spec.letterSpacing) {
			options.letterSpacing = spec.letterSpacing;
		}
		if (spec.wordBreak) {
			options.wordBreak = spec.wordBreak;
		}
		const key = `${fontKey(spec)}\u0000${text}`;
		let prepared = this.cache.get(key);
		if (!prepared) {
			prepared = prepareWithSegments(text, spec.font, options);
			if (this.cache.size >= MAX_CACHE_ENTRIES) {
				this.cache.clear();
			}
			this.cache.set(key, prepared);
		}
		return prepared;
	}

	/**
	 * Prepares (and caches) mixed-font inline content for measurement.
	 */
	prepareRich(items: RichInlineItem[]): PreparedRichInline {
		const key = JSON.stringify(items);
		let prepared = this.richCache.get(key);
		if (!prepared) {
			prepared = prepareRichInline(items);
			if (this.richCache.size >= MAX_CACHE_ENTRIES) {
				this.richCache.clear();
			}
			this.richCache.set(key, prepared);
		}
		return prepared;
	}

	/**
	 * Lays out successive lines of `prepared` at the given widths, invoking
	 * `onLine` with each range. Returns the number of lines produced.
	 *
	 * `firstMaxWidth` allows the first line to be partially occupied (when a
	 * node continues mid-line after inline siblings). `startCursor` resumes
	 * layout from a previous position (continuation reuse).
	 */
	walkLines(
		prepared: PreparedTextWithSegments,
		firstMaxWidth: number,
		maxWidth: number,
		onLine: (line: {
			start: LayoutCursor;
			end: LayoutCursor;
			width: number;
		}) => boolean | void,
		startCursor?: LayoutCursor,
	): number {
		let cursor: LayoutCursor = startCursor || {
			segmentIndex: 0,
			graphemeIndex: 0,
		};
		let count = 0;
		for (;;) {
			const width = count === 0 ? Math.max(firstMaxWidth, 1) : maxWidth;
			const line = layoutNextLineRange(prepared, cursor, width);
			if (!line) {
				return count;
			}
			count++;
			const stop = onLine({
				start: line.start,
				end: line.end,
				width: line.width,
			});
			if (stop === false) {
				return count;
			}
			cursor = line.end;
		}
	}

	/**
	 * Maps a layout cursor to a UTF-16 code-unit offset in the original
	 * string. Cursors mid-cluster resolve to the cluster start (the extra
	 * grapheme fraction is approximated proportionally within the cluster).
	 */
	cursorToOffset(prepared: PreparedTextWithSegments, cursor: LayoutCursor): number {
		const segments = prepared.segments;
		let offset = 0;
		const target = cursor.segmentIndex;
		for (let i = 0; i < target && i < segments.length; i++) {
			offset += segments[i].length;
		}
		if (target < segments.length && cursor.graphemeIndex > 0) {
			const cluster = segments[target];
			offset +=
				Math.min(cursor.graphemeIndex, cluster.length) *
				(cluster.length / [...cluster].length);
		}
		return Math.round(offset);
	}

	/**
	 * Maps a character offset to a layout cursor via prefix sums.
	 */
	offsetToCursor(prepared: PreparedTextWithSegments, offset: number): LayoutCursor {
		const segments = prepared.segments;
		let seen = 0;
		for (let i = 0; i < segments.length; i++) {
			const len = segments[i].length;
			if (seen + len > offset) {
				return { segmentIndex: i, graphemeIndex: offset - seen };
			}
			seen += len;
		}
		return { segmentIndex: segments.length, graphemeIndex: 0 };
	}
}

const sharedService = new TextMeasureService();

export function getTextMeasureService(): TextMeasureService {
	return sharedService;
}
