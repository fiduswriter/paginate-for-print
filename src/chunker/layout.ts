/**
 * The layout engine: fills one page (and, in manual-columns mode, one column
 * at a time) with content taken from the still-unrendered source fragment,
 * detects the moment content stops fitting, decides where the break goes,
 * extracts the overflowing content from the page, and hands the caller a
 * BreakToken describing where the next page must resume.
 *
 * Called once per page (and again per overflow-restart cycle) by
 * `Page.layout` / `Page.append`, which construct one Layout instance per pass
 * with the page's content area, the shared ChunkerHooks registry, and the
 * page settings snapshot.
 */

import {
	getBoundingClientRect,
	getClientRects,
} from "../utils/utils.js";
import {
	buildElementMeasure,
	buildFontSpec,
	fontKey,
	getTextMeasureService,
	measureInlineRunsHeight,
	measurementCapabilities,
	setMeasureLocale,
} from "../utils/textmeasure.js";
import type {
	ElementMeasure,
	FontSpec,
	InlineRun,
} from "../utils/textmeasure.js";
import { getDomOpStats } from "../utils/domops.js";
import type { LayoutCursor, PreparedTextWithSegments } from "@chenglou/pretext";
import {
	child,
	cloneNode,
	findElement,
	hasContent,
	indexOf,
	indexOfTextNodeForOverflow,
	isContainer,
	isElement,
	isIgnorable,
	isText,
	letters,
	needsBreakBefore,
	needsPageBreak,
	needsPreviousBreakAfter,
	nodeAfter,
	nodeBefore,
	parentOf,
	prevValidNode,
	rebuildTree,
	replaceOrAppendElement,
	walk,
	words,
} from "../utils/dom.js";
import BreakToken from "./breaktoken.js";
import RenderResult from "./renderresult.js";
import EventEmitter from "event-emitter";
import Hook from "../utils/hook.js";
import Overflow from "./overflow.js";
import type { ChunkerHooks } from "./chunker.js";
import type { PagedEventEmitter } from "../types/emitter.js";

const MAX_CHARS_PER_BREAK = 1500;

interface WithRefs extends HTMLElement {
	indexOfRefs?: Record<string, HTMLElement>;
}

type LayoutHooks = ChunkerHooks & {
	beforeOverflow?: Hook<any>;
};

interface FragmentainerMeta {
	count: number;
	gap: number;
	columnWidth: number;
}

const COLUMN_EPSILON = 1;
const OVERFLOW_TOLERANCE = 4;
const PREDICT_MIN_WORDS = 12;
const PREDICT_MAX_CHARS = 6000;
const PREDICT_WIDTH_SHRINKS_PX = [0, 1, 2];
const CONTINUATION_CACHE_MAX = 512;

interface ContinuationEntry {
	fullText: string;
	fontKey: string;
	prepared: PreparedTextWithSegments;
}

const predictFallbackNodes = new WeakSet<Text>();
const continuationPreparedTexts = new Map<string, ContinuationEntry>();

const eagerPreparedTexts = new Map<
	string,
	Array<{
		childIndex: number;
		fullText: string;
		fontKey: string;
		prepared: PreparedTextWithSegments;
	}>
>();

const EAGER_MIN_CHARS = 60;

const elementMeasures = new Map<string, ElementMeasure>();

const segmentProbeCache = new Map<
	string,
	{ height: number; line: number; marginTop: number; marginBottom: number }
>();

let segmentProbeHost: HTMLElement | null = null;

/**
 * Returns the shared hidden host used for block-height probes, creating it
 * (appended to the document body, off-screen) when absent or detached.
 */
function getSegmentProbeHost(): HTMLElement {
	if (segmentProbeHost && segmentProbeHost.isConnected) {
		return segmentProbeHost;
	}
	const host = document.createElement("div");
	host.setAttribute("data-paged-segment-probe", "");
	host.setAttribute(
		"style",
		"position: absolute; visibility: hidden; overflow: hidden; height: 1px; left: -99999px; top: 0px;",
	);
	document.body.appendChild(host);
	segmentProbeHost = host;
	return host;
}

/**
 * Diagnostics counters for the text-prediction path. The exported object is
 * mutated in place (and installed on `window.__pagedPredictStats`), so
 * consumers observe live counts.
 */
export const predictStats = {
	prepareCalls: 0,
	prepareMs: 0,
	reuses: 0,
	predicts: 0,
	predictMs: 0,
	fallbacks: 0,
	quickFits: 0,
	unverified: 0,
	eagerEntries: 0,
	rejects: {} as Record<string, number>,
};

/**
 * Records a prediction rejection under the given reason and signals the
 * caller to fall back to the legacy DOM walker.
 */
function rejectPrediction(reason: string): null {
	predictStats.rejects[reason] = (predictStats.rejects[reason] || 0) + 1;
	return null;
}

/**
 * Index of a text node among its parent's direct Text children.
 */
function textNodeIndexInParent(node: Text, parent: Element): number {
	let index = 0;
	for (let i = 0; i < parent.childNodes.length; i++) {
		const childNode = parent.childNodes[i];
		if (childNode === node) {
			return index;
		}
		if (childNode.nodeType === 3) {
			index++;
		}
	}
	return -1;
}

/**
 * Counts maximal runs of non-whitespace characters.
 */
function countWords(text: string): number {
	const matches = text.match(/\S+/g);
	return matches ? matches.length : 0;
}

/**
 * Clears the per-flow prediction caches: the continuation store, the eager
 * warm-up entries, the element measures, and the segment probe cache, plus
 * the eager-entry counter. Rejection counters, the fallback node memo, the
 * probe host, and the hyphenation events are deliberately left untouched.
 */
export function resetPredictionCaches(): void {
	continuationPreparedTexts.clear();
	eagerPreparedTexts.clear();
	elementMeasures.clear();
	segmentProbeCache.clear();
	predictStats.eagerEntries = 0;
}

export interface OverflowViolation {
	page: string;
	kind: "h-spill" | "v-spill";
	detail: string;
}

export interface RenderWarning {
	kind: "hyphenation" | "sub-tolerance-spill";
	page?: string;
	detail: string;
}

const hyphenationEvents = new Map<string, number>();

/**
 * Records that one word on a page received an engine-inserted hyphen at a
 * break point. Pure counter mutation; drained by collectRenderWarnings.
 */
export function recordHyphenationWarning(page?: string): void {
	const key = page || "-";
	hyphenationEvents.set(key, (hyphenationEvents.get(key) || 0) + 1);
}

/**
 * Collects sub-tolerance spill notices for every rendered page/container and
 * drains the recorded hyphenation events. Never throws on a falsy
 * pagesArea; returns only the hyphenation warnings in that case.
 */
export function collectRenderWarnings(
	pagesArea?: HTMLElement | null,
): RenderWarning[] {
	const warnings: RenderWarning[] = [];
	if (pagesArea) {
		const pages = pagesArea.querySelectorAll(".paged_page");
		for (const pg of pages) {
			const content = pg.querySelector(".paged_page_content");
			const wrapper = content
				? content.querySelector(
						":scope > div:not(.paged_float_top):not(.paged_float_bottom)",
					)
				: null;
			if (!wrapper) {
				continue;
			}
			const columnBoxes = wrapper.querySelectorAll(
				":scope > .paged_columns > .paged_column",
			);
			const containers: Element[] = columnBoxes.length
				? Array.from(columnBoxes)
				: [wrapper];
			for (const container of containers) {
				const el = container as HTMLElement;
				const hProtrusion = el.scrollWidth - el.clientWidth;
				if (hProtrusion > 0 && hProtrusion <= OVERFLOW_TOLERANCE) {
					warnings.push({
						kind: "sub-tolerance-spill",
						page: (pg as HTMLElement).dataset.pageNumber,
						detail:
							"content protrudes horizontally by " +
							hProtrusion +
							"px " +
							"(within tolerance)",
					});
				}
				const vProtrusion = el.scrollHeight - el.clientHeight;
				if (vProtrusion > 0 && vProtrusion <= OVERFLOW_TOLERANCE) {
					warnings.push({
						kind: "sub-tolerance-spill",
						page: (pg as HTMLElement).dataset.pageNumber,
						detail:
							"content protrudes vertically by " +
							vProtrusion +
							"px (within tolerance)",
					});
				}
			}
		}
	}
	const keys = Array.from(hyphenationEvents.keys());
	keys.sort((a, b) => {
		const an = a === "-" ? Number.MAX_SAFE_INTEGER : Number(a);
		const bn = b === "-" ? Number.MAX_SAFE_INTEGER : Number(b);
		return an - bn;
	});
	for (const key of keys) {
		const count = hyphenationEvents.get(key) || 0;
		warnings.push({
			kind: "hyphenation",
			page: key === "-" ? undefined : key,
			detail:
				count === 1
					? "1 word was hyphenated at a break point"
					: count + " words were hyphenated at break points",
		});
	}
	hyphenationEvents.clear();
	return warnings;
}

/**
 * Audits finished pages for content that ended up outside its designated
 * space. Returns [] for a falsy pagesArea.
 */
export function validateRenderedPages(
	pagesArea?: HTMLElement | null,
): OverflowViolation[] {
	const violations: OverflowViolation[] = [];
	if (!pagesArea) {
		return violations;
	}
	const pages = pagesArea.querySelectorAll(".paged_page");
	for (const pg of pages) {
		const content = pg.querySelector(".paged_page_content");
		const wrapper = content
			? content.querySelector(
					":scope > div:not(.paged_float_top):not(.paged_float_bottom)",
				)
			: null;
		if (!wrapper) {
			continue;
		}
		const columnBoxes = wrapper.querySelectorAll(
			":scope > .paged_columns > .paged_column",
		);
		const containers: Element[] = columnBoxes.length
			? Array.from(columnBoxes)
			: [wrapper];
		for (const container of containers) {
			const el = container as HTMLElement;
			if (el.scrollWidth > el.clientWidth + COLUMN_EPSILON) {
				violations.push({
					page: pg.id,
					kind: "h-spill",
					detail:
						"scrollWidth " +
						el.scrollWidth +
						" > clientWidth " +
						el.clientWidth,
				});
			}
			if (el.scrollHeight > el.clientHeight + OVERFLOW_TOLERANCE) {
				violations.push({
					page: pg.id,
					kind: "v-spill",
					detail:
						"scrollHeight " +
						el.scrollHeight +
						" > clientHeight " +
						el.clientHeight,
				});
			}
		}
	}
	return violations;
}

/**
 * Re-balances the final fragments of fragmented (mid-flow) multicol blocks:
 * lifts the forced height/column-fill constraint, checks whether the block
 * still spills, and keeps the constraint when it does. Returns the number of
 * fragments re-balanced.
 */
export function rebalanceMulticolFinals(
	pagesArea?: HTMLElement | null,
): number {
	if (!pagesArea) {
		return 0;
	}
	let balanced = 0;
	const constrained = pagesArea.querySelectorAll<HTMLElement>(
		"[data-paged-fragmentainer-constrained]",
	);
	for (const el of constrained) {
		const savedHeight = el.style.height;
		const savedColumnFill = el.style.columnFill;
		el.style.height = "auto";
		el.style.columnFill = "";
		el.getBoundingClientRect();
		const rect = el.getBoundingClientRect();
		const contentBottom =
			el.closest(".paged_page_content")?.getBoundingClientRect().bottom ??
			rect.bottom;
		const spills =
			el.scrollWidth > el.clientWidth + COLUMN_EPSILON ||
			el.scrollHeight > el.clientHeight + COLUMN_EPSILON ||
			rect.bottom > contentBottom + COLUMN_EPSILON;
		if (spills) {
			el.style.height = savedHeight;
			el.style.columnFill = savedColumnFill;
		} else {
			delete el.dataset.pagedFragmentainerConstrained;
			balanced++;
		}
	}
	return balanced;
}

/**
 * Balances one manual column row: relaxes the row's fixed sizing, verifies
 * nothing spills (and that a completed row stays within its allocated
 * bottom), and marks the row balanced when it succeeds. Returns whether the
 * row was balanced.
 */
function balanceManualColumnRow(
	row: HTMLElement,
	columns: HTMLElement[],
	maxBottom?: number,
): boolean {
	const savedFlex = row.style.flex;
	row.style.flex = "0 0 auto";
	row.style.height = "auto";
	row.getBoundingClientRect();
	const rect = row.getBoundingClientRect();
	const contentBottom =
		row.closest(".paged_page_content")?.getBoundingClientRect().bottom ??
		rect.bottom;
	const spills =
		row.scrollWidth > row.clientWidth + COLUMN_EPSILON ||
		row.scrollHeight > row.clientHeight + COLUMN_EPSILON ||
		rect.bottom > contentBottom + COLUMN_EPSILON;
	const overAllocated =
		maxBottom !== undefined && rect.bottom > maxBottom + COLUMN_EPSILON;
	if (spills || overAllocated || !columns.length) {
		row.style.flex = savedFlex;
		row.style.height = "";
		return false;
	}
	row.setAttribute("data-paged-manual-columns-balanced", "true");
	return true;
}

/**
 * Re-balances root-level manual column rows that end early (last page,
 * part-end pages, rows terminated by a span). Returns the number of rows
 * converted.
 */
export function rebalanceManualColumnFinals(
	pagesArea?: HTMLElement | null,
): number {
	if (!pagesArea) {
		return 0;
	}
	const pages = Array.from(
		pagesArea.querySelectorAll<HTMLElement>(".paged_page"),
	);
	const candidatePages = new Set<HTMLElement>();
	for (const page of pages) {
		if (page.dataset.pagedPartEnd) {
			candidatePages.add(page);
		}
	}
	for (let i = pages.length - 1; i >= 0; i--) {
		if (pages[i].querySelector(":scope .paged_flow > .paged_columns")) {
			candidatePages.add(pages[i]);
			break;
		}
	}
	let balanced = 0;
	for (const page of pages) {
		const rows = Array.from(
			page.querySelectorAll<HTMLElement>(
				":scope .paged_flow > .paged_columns",
			),
		);
		for (let r = 0; r < rows.length; r++) {
			const row = rows[r];
			const isLastRow = r === rows.length - 1;
			if (isLastRow && !candidatePages.has(page)) {
				continue;
			}
			if (!row.hasChildNodes()) {
				continue;
			}
			const columns = Array.from(
				row.querySelectorAll<HTMLElement>(":scope > .paged_column"),
			);
			if (columns.length <= 1) {
				continue;
			}
			if ((row.dataset.pagedColumnFill || "balance") === "auto") {
				continue;
			}
			let maxBottom: number | undefined = undefined;
			if (!isLastRow) {
				maxBottom = row.getBoundingClientRect().bottom;
			}
			if (balanceManualColumnRow(row, columns, maxBottom)) {
				balanced++;
			}
		}
	}
	return balanced;
}

/**
 * One-per-flow warm-up pass: attaches the source fragment to a hidden host
 * so computed styles resolve, captures element measures and (in pretext
 * mode) prepared texts, then hands the nodes back to a fresh detached
 * fragment. The input is returned unchanged when measurement is unavailable
 * or the flow contains elements that do not survive being moved.
 */
export function prepareTextsEagerly(
	source: DocumentFragment | Node,
	settings: Record<string, unknown>,
): DocumentFragment | Node {
	if (!measurementCapabilities()) {
		return source;
	}
	if (typeof document === "undefined" || !document.body) {
		return source;
	}
	if (
		source instanceof DocumentFragment &&
		source.querySelector("iframe, object, embed")
	) {
		return source;
	}
	const host = document.createElement("div");
	host.setAttribute("data-paged-measure-host", "");
	host.setAttribute(
		"style",
		"position: absolute; visibility: hidden; overflow: hidden; width: 1px; height: 1px; left: -99999px; top: 0px;",
	);
	document.body.appendChild(host);
	host.appendChild(source as Node);
	try {
		setMeasureLocale(
			document.documentElement?.getAttribute("lang") || undefined,
		);
		const elementWalker = document.createTreeWalker(
			host,
			NodeFilter.SHOW_ELEMENT,
		);
		let element = elementWalker.nextNode();
		while (element) {
			const ref = (element as HTMLElement).dataset?.ref;
			if (ref && !elementMeasures.has(ref)) {
				const measureRecord = buildElementMeasure(element as Element);
				if (measureRecord) {
					elementMeasures.set(ref, measureRecord);
				}
			}
			element = elementWalker.nextNode();
		}
		if (settings.textMeasurement === "pretext") {
			const textWalker = document.createTreeWalker(
				host,
				NodeFilter.SHOW_TEXT,
			);
			let textNode = textWalker.nextNode() as Text | null;
			while (textNode) {
				const full = textNode.textContent || "";
				const parent = textNode.parentElement;
				if (
					full.trim().length >= EAGER_MIN_CHARS &&
					countWords(full) >= PREDICT_MIN_WORDS &&
					parent &&
					parent.dataset.ref
				) {
					const spec = buildFontSpec(parent);
					if (spec && spec.lineHeight > 0) {
						const prepared = getTextMeasureService().prepare(full, spec);
						const ref = parent.dataset.ref;
						let list = eagerPreparedTexts.get(ref);
						if (!list) {
							list = [];
							eagerPreparedTexts.set(ref, list);
						}
						list.push({
							childIndex: textNodeIndexInParent(textNode, parent),
							fullText: full,
							fontKey: fontKey(spec),
							prepared,
						});
						predictStats.eagerEntries++;
					}
				}
				textNode = textWalker.nextNode() as Text | null;
			}
		}
	} catch (error) {
		console.warn(
			"paginate-for-print: eager text preparation failed: " +
				(error as Error).message,
		);
	}
	const out = document.createDocumentFragment();
	while (host.firstChild) {
		out.appendChild(host.firstChild);
	}
	host.remove();
	return out;
}

class Layout {
	element: HTMLElement;
	bounds: DOMRect;
	parentBounds: DOMRect | { left: number };
	gap: number;
	hooks: LayoutHooks;
	settings: Record<string, unknown>;
	maxChars: number;
	forceRenderBreak: boolean;
	temporaryIndex: number;
	failed?: boolean;
	multicolSelectors: Set<string>;
	columnSpanSelectors: Set<string>;
	rootColumns?: {
		count: number;
		gap?: string;
		fill?: "auto" | "balance";
		ruleColor?: string;
		ruleStyle?: string;
		ruleWidth?: string;
	};
	fragmentainers: Set<Element>;
	private fragmentainerMeta: WeakMap<Element, FragmentainerMeta>;
	private savedFragmentainerHeights: Map<Element, string>;
	private boundsDirty = true;
	private inResidualSweep = false;
	private measure = getTextMeasureService();
	private predictFallbacks = predictFallbackNodes;
	private continuationPrepared = continuationPreparedTexts;
	private predictionVerified: boolean;
	private segmentHeightQueue: Array<{
		ref: string;
		height: number | null;
		spanHeight?: number;
		minRoom?: number;
		defer?: boolean;
	}> = [];

	/**
	 * Constructs one layout pass for a page content area (or, later, a
	 * manual column once setActiveColumn swaps the root).
	 *
	 * @param {HTMLElement} element - The page content area to fill.
	 * @param {ChunkerHooks} [hooks] - The chunker's hook registry; a
	 *   fallback registry is created when omitted.
	 * @param {Record<string, unknown>} [options] - The page settings
	 *   snapshot (maxChars, multicolSelectors, columnSpanSelectors,
	 *   rootColumns, textMeasurement, verifyTextPrediction, hyphenGlyph).
	 */
	constructor(
		element: HTMLElement,
		hooks?: ChunkerHooks,
		options?: Record<string, unknown>,
	) {
		this.element = element;
		this.bounds = element.getBoundingClientRect();
		this.parentBounds =
			(element.offsetParent as HTMLElement | null)?.getBoundingClientRect() || {
				left: 0,
			};
		const gapValue = parseFloat(getComputedStyle(element).columnGap);
		this.gap = gapValue
			? gapValue - (this.bounds.left - this.parentBounds.left)
			: 0;
		this.hooks = (hooks as LayoutHooks) || {
			onPageLayout: new Hook(),
			layout: new Hook(),
			renderNode: new Hook(),
			layoutNode: new Hook(),
			beforeOverflow: new Hook(),
			onOverflow: new Hook(),
			afterOverflowRemoved: new Hook(),
			afterOverflowAdded: new Hook(),
			onBreakToken: new Hook(),
			beforeRenderResult: new Hook(),
		};
		this.settings = options || {};
		this.maxChars = (this.settings.maxChars as number) || MAX_CHARS_PER_BREAK;
		this.forceRenderBreak = false;
		this.temporaryIndex = 0;
		this.multicolSelectors =
			(this.settings.multicolSelectors as Set<string>) || new Set();
		this.columnSpanSelectors =
			(this.settings.columnSpanSelectors as Set<string>) || new Set();
		this.rootColumns = this.settings.rootColumns as Layout["rootColumns"];
		this.fragmentainers = new Set();
		this.fragmentainerMeta = new WeakMap();
		this.savedFragmentainerHeights = new Map();
		this.boundsDirty = true;
		this.inResidualSweep = false;
		this.measure = getTextMeasureService();
		this.predictFallbacks = predictFallbackNodes;
		this.continuationPrepared = continuationPreparedTexts;
		this.predictionVerified = this.settings.verifyTextPrediction !== false;
		this.segmentHeightQueue = [];
	}

	/**
	 * Marks the cached bounds stale so the next refreshBounds re-reads the
	 * element's rect. Called after every DOM mutation the engine makes.
	 */
	invalidateBounds(): void {
		this.boundsDirty = true;
	}

	/**
	 * Returns the lazily-shared bounds for the current mutation batch:
	 * re-reads geometry at most once between invalidations. Manual columns
	 * inside a flow host report their own box rather than the flow's.
	 */
	refreshBounds(): DOMRect {
		if (!this.boundsDirty) {
			return this.bounds;
		}
		this.bounds = this.element.getBoundingClientRect();
		if (
			this.element.classList.contains("paged_column") &&
			this.element.closest(".paged_flow")
		) {
			this.bounds = this.manualColumnBounds(this.element);
		}
		this.boundsDirty = false;
		return this.bounds;
	}

	/**
	 * Makes a column the active layout root. Only columns swap the root
	 * element; single-column pages keep the content area. Bounds are
	 * computed immediately either way.
	 */
	setActiveColumn(dest: HTMLElement): void {
		if (dest.classList.contains("paged_column")) {
			this.element = dest;
		}
		this.boundsDirty = true;
		if (
			dest.classList.contains("paged_column") &&
			dest.closest(".paged_flow")
		) {
			this.bounds = this.manualColumnBounds(dest);
		} else {
			this.bounds = this.refreshBounds();
		}
	}

	/**
	 * The column's own box: flex already sizes manual columns for the top
	 * float and span segments, so using the flow host's full height here
	 * would make columns inside a shorter segment accept the whole page.
	 */
	private manualColumnBounds(column: HTMLElement): DOMRect {
		const rect = column.getBoundingClientRect();
		return new DOMRect(
			rect.left,
			rect.top,
			rect.width,
			Math.max(0, rect.height),
		);
	}

	/**
	 * Whether the element is a multi-column fragmentainer (column-count > 1).
	 */
	isMulticolElement(el: Element): boolean {
		return this.getFragmentainerMeta(el).count > 1;
	}

	/**
	 * The cached fragmentainer geometry for an element: column count, gap
	 * (approximating `normal` as 1em) and per-column width.
	 */
	getFragmentainerMeta(el: Element): FragmentainerMeta {
		let meta = this.fragmentainerMeta.get(el);
		if (meta) {
			return meta;
		}
		const style = getComputedStyle(el);
		const count = parseInt(style.columnCount) || 1;
		let gap = parseFloat(style.columnGap);
		if (Number.isNaN(gap)) {
			gap = parseFloat(style.fontSize) || 0;
		}
		const width = el.clientWidth || el.getBoundingClientRect().width;
		const columnWidth =
			count > 1 ? (width - (count - 1) * gap) / count : width;
		meta = { count, gap, columnWidth };
		this.fragmentainerMeta.set(el, meta);
		return meta;
	}

	/**
	 * The layout box of a fragmentainer. A fragmented multicol container's
	 * bounding rect is the union across all fragments, which poisons
	 * geometry; the real box starts at the first client rect and is sized by
	 * the client dimensions.
	 */
	fragmentainerBox(el: Element): {
		left: number;
		top: number;
		right: number;
		bottom: number;
	} {
		const rect = el.getBoundingClientRect();
		let left = rect.left;
		let top = rect.top;
		if (el instanceof HTMLElement) {
			const rects = el.getClientRects();
			if (rects && rects.length) {
				left = rects[0].left;
				top = rects[0].top;
			}
		}
		let width = el.clientWidth || rect.width;
		let height = el.clientHeight || rect.height;
		if (!width) {
			width = rect.width;
		}
		if (!height) {
			height = rect.height;
		}
		return {
			left,
			top,
			right: left + width,
			bottom: top + height,
		};
	}

	/**
	 * Registers every multicol element reachable from `root`: the root
	 * itself when it is a multicol HTMLElement, plus every match of the
	 * configured multicol selectors (invalid selectors are skipped).
	 */
	registerFragmentainers(root: HTMLElement | Node): void {
		if (root instanceof HTMLElement && this.isMulticolElement(root)) {
			this.registerFragmentainer(root);
		}
		if (!this.multicolSelectors.size) {
			return;
		}
		for (const selector of this.multicolSelectors) {
			let matches: NodeListOf<Element> | null = null;
			try {
				matches = (root as Element).querySelectorAll(selector);
			} catch {
				matches = null;
			}
			if (!matches) {
				continue;
			}
			for (const match of matches) {
				if (this.isMulticolElement(match)) {
					this.registerFragmentainer(match);
				}
			}
		}
	}

	/**
	 * Registers one fragmentainer unless it sits inside an already
	 * registered one; nested multicol is degraded to a single column with a
	 * warning instead of being registered.
	 */
	private registerFragmentainer(el: Element): void {
		if (this.fragmentainers.has(el)) {
			return;
		}
		let ancestor: Node | null = el.parentNode;
		let nested = false;
		while (ancestor && ancestor.nodeType === 1) {
			const ancestorEl = ancestor as HTMLElement;
			if (
				ancestorEl.classList.contains("paged_page_content") ||
				ancestorEl.classList.contains("paged_footnote_inner_content")
			) {
				break;
			}
			if (this.fragmentainers.has(ancestorEl)) {
				nested = true;
				break;
			}
			ancestor = ancestorEl.parentNode;
		}
		if (nested) {
			console.warn(
				"paginate-for-print: nested multi-column containers are not supported; rendering the inner container as a single column.",
			);
			(el as HTMLElement).style.columnCount = "1";
			this.fragmentainerMeta.set(el, {
				count: 1,
				gap: 0,
				columnWidth: el.getBoundingClientRect().width,
			});
			return;
		}
		this.fragmentainers.add(el);
	}

	/**
	 * The registered fragmentainer containing `node`, if any; the climb
	 * stops at the active element, the page content area, or the footnote
	 * area's inner content.
	 */
	getFragmentainer(node: Node): Element | null {
		let current: Node | null = isElement(node)
			? (node as Node)
			: (node.parentElement as Node | null);
		while (current && current.nodeType === 1) {
			const el = current as HTMLElement;
			if (
				current === this.element ||
				el.classList.contains("paged_page_content") ||
				el.classList.contains("paged_footnote_inner_content")
			) {
				return null;
			}
			if (this.fragmentainers.has(current as Element)) {
				return current as Element;
			}
			current = el.parentNode as Node | null;
		}
		return null;
	}

	/**
	 * The deepest trailing non-whitespace text node of `element`, following
	 * last-child chains; undefined when the element ends without text
	 * content (e.g. in a BR or an empty inline tail).
	 */
	private deepestTrailingText(element: Element): Text | undefined {
		let node: Node | null = element;
		while (node) {
			let childNode: Node | null = node.lastChild;
			while (childNode && isIgnorable(childNode)) {
				childNode = childNode.previousSibling;
			}
			if (!childNode) {
				return undefined;
			}
			if (isText(childNode)) {
				if ((childNode.textContent || "").trim().length) {
					return childNode as Text;
				}
				return undefined;
			}
			node = childNode;
		}
		return undefined;
	}

	/**
	 * The single overflow predicate: without a fragmentainer the rect is
	 * checked against the bounds (plus `additions` vertically); with one,
	 * hidden spill-over columns and the last visible column's bottom edge
	 * decide.
	 */
	rectOverflows(
		rect: DOMRect,
		additions: number,
		frag: Element | null,
		bounds: DOMRect = this.bounds,
	): boolean {
		if (!frag) {
			return (
				rect.right > bounds.right + COLUMN_EPSILON ||
				rect.bottom > bounds.bottom + additions + COLUMN_EPSILON
			);
		}
		const meta = this.getFragmentainerMeta(frag);
		const box = this.fragmentainerBox(frag);
		if (rect.left >= box.right + meta.gap - COLUMN_EPSILON) {
			return true;
		}
		if (meta.count > 1) {
			const colIndex = Math.floor(
				(rect.left - box.left + COLUMN_EPSILON) /
					(meta.columnWidth + meta.gap),
			);
			if (colIndex >= meta.count - 1) {
				return (
					rect.bottom > box.bottom + additions + COLUMN_EPSILON &&
					rect.left < box.right + COLUMN_EPSILON
				);
			}
			return false;
		}
		return rect.bottom > box.bottom + additions + COLUMN_EPSILON;
	}

	/**
	 * Constrains a multicol block to the remaining vertical space so the
	 * browser fragments it internally instead of balancing past the bottom
	 * edge. Silent no-op when the block fits or has no measurable box.
	 */
	constrainMulticolHeight(el: Element, bounds: DOMRect = this.bounds): void {
		const box = this.fragmentainerBox(el);
		if (box.bottom - box.top === 0 || box.bottom <= bounds.bottom + COLUMN_EPSILON) {
			return;
		}
		const available = Math.floor(bounds.bottom - box.top);
		if (available <= 0) {
			return;
		}
		(el as HTMLElement).style.columnFill = "auto";
		(el as HTMLElement).style.height = available + "px";
		(el as HTMLElement).dataset.pagedFragmentainerConstrained = "true";
		this.fragmentainerMeta.delete(el);
		this.invalidateBounds();
	}

	/**
	 * The containers to fill, in order: the newest column segment's boxes,
	 * or the flow host itself on a single-column page.
	 */
	flowColumns(wrapper: HTMLElement): HTMLElement[] {
		const rows = wrapper.querySelectorAll<HTMLElement>(
			":scope > .paged_columns",
		);
		if (rows.length) {
			const lastRow = rows[rows.length - 1];
			return Array.from(
				lastRow.querySelectorAll<HTMLElement>(":scope > .paged_column"),
			);
		}
		return [wrapper];
	}

	/**
	 * Moves the fill to the next column: activates it, rebuilds the current
	 * overflow into it, and clears any overflow tagging that crossed the
	 * column boundary.
	 */
	private advanceColumn(
		columns: HTMLElement[],
		colIndex: number,
		token: BreakToken,
		prevPage: HTMLElement | null,
		source?: DocumentFragment | Node,
	): HTMLElement {
		const next = columns[colIndex + 1];
		this.setActiveColumn(next);
		this.addOverflowToPage(next, token, prevPage || undefined, source);
		this.clearOverflowTags(next);
		this.registerFragmentainers(next);
		return next;
	}

	/**
	 * Removes the overflow-detection markers from `dest` and its subtree:
	 * every column starts its fill with a clean slate.
	 */
	private clearOverflowTags(dest: HTMLElement): void {
		delete dest.dataset.overflowTagged;
		delete dest.dataset.rangeStartOverflow;
		delete dest.dataset.rangeEndOverflow;
		const tagged = dest.querySelectorAll(
			"[data-overflow-tagged], [data-range-start-overflow], [data-range-end-overflow]",
		);
		for (const el of tagged) {
			delete (el as HTMLElement).dataset.overflowTagged;
			delete (el as HTMLElement).dataset.rangeStartOverflow;
			delete (el as HTMLElement).dataset.rangeEndOverflow;
		}
	}

	/**
	 * The node a page's walk starts from: the incoming token's node, the
	 * source's first child, or undefined when the flow is finished.
	 */
	getStart(
		source: DocumentFragment | Node,
		breakToken?: BreakToken,
	): Node | undefined {
		if (breakToken && breakToken.finished) {
			return undefined;
		}
		if (breakToken && breakToken.node) {
			return breakToken.node;
		}
		return (source.firstChild as Node) || undefined;
	}

	/**
	 * Whether the node demands a hard break before it renders: a break
	 * before of its own (suppressing the duplicate when the parent demands
	 * the same break), a previous sibling's break-after, or a named-page
	 * change.
	 */
	shouldBreak(node: Node, limiter?: Node): boolean {
		if (needsBreakBefore(node)) {
			let doubleBreakBefore = false;
			if (node.parentNode && !nodeBefore(node, limiter)) {
				const parent = node.parentNode as HTMLElement;
				if (needsBreakBefore(parent)) {
					doubleBreakBefore =
						(node as HTMLElement).dataset.breakBefore ===
						parent.dataset.breakBefore;
				}
			}
			if (!doubleBreakBefore) {
				return true;
			}
		}
		if (needsPreviousBreakAfter(node)) {
			return true;
		}
		return needsPageBreak(node, nodeBefore(node, limiter) as Node);
	}

	/**
	 * Builds a BreakToken at `node`. Note the offset lands in BreakToken's
	 * overflow-array slot; only the falsy `0` is ever passed (a fresh empty
	 * array). The onBreakToken hook may replace the token.
	 */
	breakAt(
		node: Node | undefined,
		offset = 0,
		forcedBreakQueue: Node[] = [],
	): BreakToken {
		let newBreakToken = new (BreakToken as unknown as {
			new (node: Node, overflowArray?: unknown): BreakToken;
		})(node as Node, offset);
		if (forcedBreakQueue.length) {
			newBreakToken.setForcedBreakQueue(forcedBreakQueue.slice());
		}
		const results = this.hooks.onBreakToken.triggerSync(
			newBreakToken,
			undefined,
			node as HTMLElement | undefined,
			this,
		);
		for (const result of results) {
			if (result !== undefined) {
				newBreakToken = result as BreakToken;
			}
		}
		return newBreakToken;
	}

	/**
	 * Whether a token must end the page rather than advance a column: a
	 * queued forced break, a side break, or a page/always break on the token
	 * node.
	 */
	private isForcedBreakToken(token: BreakToken): boolean {
		if (token.getForcedBreakQueue().length) {
			return true;
		}
		if (this.sideBreakValue(token.node)) {
			return true;
		}
		const el = token.node as HTMLElement;
		if (el && el.dataset) {
			if (
				el.dataset.breakBefore === "page" ||
				el.dataset.breakBefore === "always"
			) {
				return true;
			}
			if (
				el.dataset.previousBreakAfter === "page" ||
				el.dataset.previousBreakAfter === "always"
			) {
				return true;
			}
		}
		return false;
	}

	/**
	 * The node's side break requirement (left/right/recto/verso), if any.
	 */
	private sideBreakValue(node: Node | null | undefined): string | null {
		const el = node as HTMLElement;
		if (el && el.dataset) {
			const before = el.dataset.breakBefore;
			if (before && SIDEBREAK_VALUES.indexOf(before) !== -1) {
				return before;
			}
			const after = el.dataset.previousBreakAfter;
			if (after && SIDEBREAK_VALUES.indexOf(after) !== -1) {
				return after;
			}
		}
		return null;
	}

	/**
	 * Whether the node demands a column break.
	 */
	private needsColumnBreak(node: Node): boolean {
		const el = node as HTMLElement;
		return (
			el.dataset?.breakBefore === "column" ||
			el.dataset?.previousBreakAfter === "column"
		);
	}

	/**
	 * Whether a manual column holds anything: any element child, or a text
	 * child with trimmed content.
	 */
	private columnHasContent(column: HTMLElement): boolean {
		for (const childNode of Array.from(column.childNodes)) {
			if (isElement(childNode)) {
				return true;
			}
			if (isText(childNode) && (childNode.textContent || "").trim().length) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Inert escape hatch: sets the force-render-break flag, which nothing in
	 * this module reads.
	 */
	forceBreak(): void {
		this.forceRenderBreak = true;
	}

	/**
	 * Clones `node` into the page's flow: into its rendered parent's
	 * counterpart when present, rebuilding the ancestor chain when not, or
	 * directly into `dest` when the node has no element parent. The
	 * renderNode hook may replace the clone.
	 */
	append(
		node: Node,
		dest: HTMLElement,
		source: DocumentFragment | Node,
		breakToken: BreakToken | null | undefined,
		shallow = true,
		rebuild = true,
	): ChildNode {
		let clone = cloneNode(node, !shallow) as ChildNode;
		if (node.parentNode && isElement(node.parentNode)) {
			const parent = findElement(node.parentNode, dest as WithRefs);
			if (parent) {
				replaceOrAppendElement(parent as HTMLElement, clone);
			} else if (rebuild) {
				const fragment = rebuildTree(
					node.parentElement as Element,
					undefined,
					source as Element,
				);
				const fragmentParent = findElement(
					node.parentElement as Element,
					fragment as unknown as WithRefs,
				) as HTMLElement;
				if (fragmentParent) {
					replaceOrAppendElement(fragmentParent, clone);
				}
				dest.appendChild(fragment);
			} else {
				dest.appendChild(clone);
			}
		} else {
			dest.appendChild(clone);
		}
		const ref = (clone as Element).getAttribute
			? (clone as Element).getAttribute("data-ref")
			: null;
		if (ref) {
			const refs =
				(dest as WithRefs).indexOfRefs ||
				((dest as WithRefs).indexOfRefs = {});
			refs[ref] = clone as HTMLElement;
		}
		const flowHost = dest.closest(".paged_flow") as HTMLElement | null;
		const floatTopBefore = flowHost
			? flowHost.querySelector(":scope > .paged_float_top")
			: null;
		const floatHeightBefore = floatTopBefore
			? floatTopBefore.getBoundingClientRect().height
			: 0;
		const results = this.hooks.renderNode.triggerSync(clone, node, this);
		for (const result of results) {
			if (result !== undefined) {
				clone = result as ChildNode;
			}
		}
		// A page float that just landed in the flow's top float row shrinks
		// the room the planned segment rows were sized against. Re-fix the
		// last row to the actually remaining space so the walk keeps
		// detecting overflow at column boundaries instead of overfilling the
		// page (the row is flex-shrink: 0 by design so later spans cannot
		// shrink it underneath already-balanced columns).
		if (flowHost) {
			const floatTopAfter = flowHost.querySelector(
				":scope > .paged_float_top",
			);
			const floatHeightAfter = floatTopAfter
				? floatTopAfter.getBoundingClientRect().height
				: 0;
			if (floatHeightAfter > floatHeightBefore + COLUMN_EPSILON) {
				this.replanFixedSegmentRows(flowHost);
			}
		}
		this.invalidateBounds();
		return clone;
	}

	/**
	 * Re-fixes the last planned segment row to the space actually left by
	 * the flow host's other children (top float, span rows, spanned blocks).
	 * Only ever shrinks: the plan was made before later siblings took their
	 * space, so growth is not a planning correction.
	 */
	private replanFixedSegmentRows(wrapper: HTMLElement): void {
		const rows = wrapper.querySelectorAll<HTMLElement>(
			":scope > .paged_columns",
		);
		const last = rows[rows.length - 1];
		if (!last || last.dataset.pagedSegmentFixed !== "true") {
			return;
		}
		const remaining =
			wrapper.getBoundingClientRect().height - last.offsetTop;
		const current = last.getBoundingClientRect().height;
		if (
			remaining > COLUMN_EPSILON &&
			remaining < current - COLUMN_EPSILON
		) {
			this.fixSegmentRowHeight(last, remaining);
			this.invalidateBounds();
		}
	}

	/**
	 * Merges the children of `source` into `dest`: text children are moved,
	 * element children recurse into their rendered counterpart or are
	 * appended.
	 */
	addOverflowNodes(dest: HTMLElement, source: Node): void {
		for (const item of Array.from(source.childNodes)) {
			if (isText(item)) {
				dest.append(item);
			} else {
				const existing = findElement(item as Element, dest as WithRefs);
				if (existing) {
					this.addOverflowNodes(existing as HTMLElement, item);
				} else {
					dest.appendChild(item);
				}
			}
		}
	}

	/**
	 * Rebuilds the previous page's carried overflow into `dest`: entries are
	 * sorted into source document order, chained into one fragment, tagged
	 * for detection, reordered, and appended; carried page floats are
	 * re-fired through renderNode.
	 */
	addOverflowToPage(
		dest: HTMLElement,
		breakToken: BreakToken | undefined,
		alreadyRendered?: DocumentFragment | Node,
		source?: DocumentFragment | Node,
	): void {
		if (!dest) {
			console.warn(
				"paginate-for-print: addOverflowToPage called with null dest",
				new Error().stack,
			);
			return;
		}
		if (!breakToken || !breakToken.overflow || !breakToken.overflow.length) {
			return;
		}
		const overflows = Array.from(breakToken.overflow);
		overflows.sort((a, b) =>
			this.compareOverflowPositions(a, b, source),
		);
		let fragment: DocumentFragment | undefined;
		for (const overflow of overflows) {
			if (!overflow.content) {
				continue;
			}
			fragment = rebuildTree(
				overflow.node,
				fragment,
				alreadyRendered as Element | undefined,
			);
			const addTo = overflow.ancestor
				? findElement(overflow.ancestor, fragment as unknown as WithRefs)
				: fragment;
			this.addOverflowNodes(addTo as HTMLElement, overflow.content);
		}
		if (fragment) {
			for (const el of fragment.querySelectorAll("[data-ref]")) {
				const ref = el.getAttribute("data-ref");
				if (ref && !dest.querySelector("[data-ref='" + ref + "']")) {
					const refs =
						(dest as WithRefs).indexOfRefs ||
						((dest as WithRefs).indexOfRefs = {});
					refs[ref] = el as HTMLElement;
				}
			}
			for (const tag of [
				"overflow-tagged",
				"overflow-partial",
				"range-start-overflow",
				"range-end-overflow",
			]) {
				const camel = tag.replace(/-([a-z])/g, (match, letter: string) =>
					letter.toUpperCase(),
				);
				const tagged = fragment.querySelectorAll("[data-" + tag + "]");
				for (const el of tagged) {
					delete (el as HTMLElement).dataset[camel];
				}
			}
			this.reorderBySourceOrder(fragment, source);
			dest.appendChild(fragment);
			const floats = fragment.querySelectorAll("[data-page-float]");
			for (const el of floats) {
				if ((el as HTMLElement).dataset && !(el as HTMLElement).dataset.pageFloatPlaced) {
					this.hooks.renderNode.triggerSync(el, el, this);
				}
			}
			this.hooks.afterOverflowAdded.trigger(dest);
		}
		this.invalidateBounds();
	}

	/**
	 * Maps a (possibly detached) overflow node to its position in the source
	 * tree for sorting: a connected node maps to itself, a detached one to
	 * its element's data-ref counterpart.
	 */
	private sourceOf(
		node: Node,
		source?: DocumentFragment | Node,
	): Node {
		if (node.isConnected) {
			return node;
		}
		try {
			const probe = isElement(node) ? node : node.parentElement;
			if (probe) {
				const found = findElement(probe, source as WithRefs);
				if (found) {
					return found;
				}
			}
		} catch {
			// lookup errors fall back to the node itself
		}
		return node;
	}

	/**
	 * Document-order comparator for overflow entries: same node sorts by
	 * offset, different nodes by their source positions (comparison errors
	 * leave the original order).
	 */
	private compareOverflowPositions(
		a: Overflow,
		b: Overflow,
		source?: DocumentFragment | Node,
	): number {
		if (a.node === b.node) {
			return (a.offset || 0) - (b.offset || 0);
		}
		const sourceA = this.sourceOf(a.node, source);
		const sourceB = this.sourceOf(b.node, source);
		if (!sourceA || !sourceB) {
			return 0;
		}
		try {
			const position = sourceA.compareDocumentPosition(sourceB);
			if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
				return -1;
			}
			if (position & Node.DOCUMENT_POSITION_PRECEDING) {
				return 1;
			}
		} catch {
			// cross-document comparison errors leave the original order
		}
		return 0;
	}

	/**
	 * Re-orders children of containers inside a rebuilt overflow fragment so
	 * they follow source document order. Only pure element sequences with
	 * refs are touched; text-containing containers are left alone.
	 */
	private reorderBySourceOrder(
		fragment: DocumentFragment,
		source?: DocumentFragment | Node,
	): void {
		const containers: (Element | DocumentFragment)[] = [
			fragment,
			...Array.from(fragment.querySelectorAll("*")),
		];
		for (const container of containers) {
			if ((container as Element).closest?.("table")) {
				continue;
			}
			const elementChildren = Array.from(
				(container as Element).children || [],
			) as Element[];
			if (elementChildren.length < 2) {
				continue;
			}
			let hasTextChild = false;
			for (const childNode of Array.from(container.childNodes)) {
				if (
					childNode.nodeType === 3 &&
					(childNode.textContent || "").trim().length
				) {
					hasTextChild = true;
					break;
				}
			}
			if (hasTextChild) {
				continue;
			}
			if (!elementChildren.every((el) => el.getAttribute("data-ref"))) {
				continue;
			}
			const sourceNodes = elementChildren.map((el) =>
				findElement(el, source as WithRefs),
			);
			if (sourceNodes.some((node) => !node)) {
				continue;
			}
			const paths = sourceNodes.map((node) =>
				this.sourceIndexPath(node as Element),
			);
			if (paths.some((path) => path === null)) {
				continue;
			}
			const comparablePaths = paths as number[][];
			let outOfOrder = false;
			for (let i = 1; i < comparablePaths.length; i++) {
				if (
					compareSourcePaths(comparablePaths[i - 1], comparablePaths[i]) > 0
				) {
					outOfOrder = true;
					break;
				}
			}
			if (!outOfOrder) {
				continue;
			}
			const order = elementChildren
				.map((el, i) => i)
				.sort(
					(ia, ib) =>
						compareSourcePaths(
							comparablePaths[ia],
							comparablePaths[ib],
						),
				);
			for (const i of order) {
				(container as Element).appendChild(elementChildren[i]);
			}
		}
	}

	/**
	 * A node's source index path: its element-child index at each ancestor
	 * level, root first. A -1 aborts to null.
	 */
	private sourceIndexPath(node: Node): number[] | null {
		const path: number[] = [];
		let current: Node | null = node;
		while (current) {
			const parent: Node | null = current.parentNode;
			if (!parent || parent.nodeType !== 1) {
				break;
			}
			const index = Array.prototype.indexOf.call(
				(parent as Element).children,
				current,
			);
			if (index === -1) {
				return null;
			}
			path.unshift(index);
			current = parent;
		}
		return path;
	}

	/**
	 * Restores the table cells that follow the break token's cell: the
	 * browser may have pulled them into the previous fragment's column span.
	 */
	rebuildTableFromBreakToken(
		breakToken: BreakToken | undefined,
		dest: HTMLElement,
		source: DocumentFragment | Node,
	): void {
		const node = breakToken ? breakToken.node : undefined;
		if (!node) {
			return;
		}
		const probe = (isElement(node) ? node : node.parentElement) as Element;
		if (!probe || typeof probe.closest !== "function") {
			return;
		}
		const td = probe.closest("td");
		if (!td) {
			return;
		}
		const renderedTd = findElement(td, dest as WithRefs, true);
		if (!renderedTd) {
			return;
		}
		let sibling = td.nextElementSibling;
		while (sibling) {
			if (sibling.nodeName !== "TD") {
				break;
			}
			this.append(sibling, dest, source, null, true);
			sibling = sibling.nextElementSibling;
		}
	}

	/**
	 * Recursion over the rendered tree's last-element-child chain: prunes
	 * emptied overflow-tagged elements (they will be re-added on the next
	 * page) and registers surviving refs.
	 */
	lastChildCheck(parentElement: Element, rootElement: WithRefs): void {
		const lastElementChild = parentElement.lastElementChild;
		if (lastElementChild) {
			this.lastChildCheck(lastElementChild, rootElement);
		}
		const refId = parentElement.getAttribute("data-ref");
		if ((parentElement as HTMLElement).dataset?.overflowTagged) {
			if (!(parentElement.textContent || "").trim().length) {
				if (parentElement.parentElement) {
					parentElement.parentElement.removeChild(parentElement);
				}
			}
		} else if (refId) {
			if (!rootElement.indexOfRefs) {
				rootElement.indexOfRefs = {};
			}
			if (!rootElement.indexOfRefs[refId]) {
				rootElement.indexOfRefs[refId] = parentElement as HTMLElement;
			}
		}
	}

	/**
	 * First ancestor (the starting node included) whose
	 * data-original-break-inside is exactly "avoid"; the climb stops at the
	 * limiter.
	 */
	avoidBreakInside(node: Node, limiter: Node): Element | undefined {
		let current: Node | null = node;
		while (current) {
			if (limiter && current === limiter) {
				return undefined;
			}
			if (
				isElement(current) &&
				(current as HTMLElement).dataset?.originalBreakInside === "avoid"
			) {
				return current as Element;
			}
			current = current.parentNode;
		}
		return undefined;
	}

	/**
	 * Cheap scroll-size based overflow probe for the given element against
	 * the bounds, including a scan of registered fragmentainers whose
	 * internal spill does not grow the wrapper.
	 */
	hasOverflow(element: HTMLElement, bounds: DOMRect = this.bounds): boolean {
		const parent = element.parentNode as Element | null;
		let constrainingElement: Element = parent || element;
		if (parent) {
			if (
				parent.classList.contains("paged_page_content") ||
				parent.classList.contains("paged_columns")
			) {
				constrainingElement = element;
			}
		}
		const elementRect = element.getBoundingClientRect();
		if (
			Math.max(
				Math.ceil(elementRect.width),
				(constrainingElement as HTMLElement).scrollWidth,
			) > Math.ceil(bounds.width) ||
			Math.max(
				Math.ceil(elementRect.height),
				(constrainingElement as HTMLElement).scrollHeight,
			) > Math.ceil(bounds.height)
		) {
			return true;
		}
		for (const frag of this.fragmentainers) {
			if (frag === element || frag === constrainingElement) {
				continue;
			}
			const fragRect = frag.getBoundingClientRect();
			if (
				(frag as HTMLElement).scrollWidth >
					Math.ceil(fragRect.width) + COLUMN_EPSILON ||
				(frag as HTMLElement).scrollHeight >
					Math.ceil(fragRect.height) + COLUMN_EPSILON
			) {
				return true;
			}
		}
		return false;
	}

	/**
	 * The first child of `node` that overflows `bounds`. Null means
	 * "overflowing children exist but were deliberately skipped" (range
	 * markers); undefined means none.
	 */
	firstOverflowingChild(
		node: Node,
		bounds: DOMRect,
	): ChildNode | null | undefined {
		const bLeft = Math.ceil(bounds.left);
		const bRight = Math.floor(bounds.right);
		const bTop = Math.ceil(bounds.top);
		const bBottom = Math.floor(bounds.bottom);
		let parentBottomPaddingBorder = 0;
		if (isElement(node)) {
			const sums = this.getAncestorPaddingBorderAndMarginSums(
				node as Element,
			);
			parentBottomPaddingBorder =
				sums["padding-bottom"] + sums["border-bottom-width"];
		}
		const nodeFrag = this.getFragmentainer(node);
		let skipRange = false;
		let result: ChildNode | null | undefined = undefined;
		for (const childNode of Array.from(node.childNodes)) {
			if ((childNode as Element).nodeName === "COLGROUP") {
				continue;
			}
			const pos = getBoundingClientRect(childNode as unknown as Element);
			if (!pos) {
				continue;
			}
			if (
				isText(childNode) &&
				!(childNode.textContent || "").trim().length &&
				pos.height === 0 &&
				pos.width === 0
			) {
				continue;
			}
			let bottomMargin = 0;
			if (isElement(childNode)) {
				const childEl = childNode as HTMLElement;
				bottomMargin = parseFloat(getComputedStyle(childEl).marginBottom);
				const startMarked = childEl.dataset.rangeStartOverflow !== undefined;
				const endMarked = childEl.dataset.rangeEndOverflow !== undefined;
				if (startMarked && endMarked) {
					// collapsed pair — treated normally
				} else if (startMarked) {
					skipRange = true;
					result = null;
					continue;
				} else if (endMarked) {
					skipRange = false;
					continue;
				}
				if (childEl.dataset.overflowTagged) {
					continue;
				}
				if (skipRange) {
					continue;
				}
			}
			const isLastChild = indexOf(childNode) === node.childNodes.length - 1;
			const bottom = Math.floor(
				pos.bottom +
					bottomMargin +
					(isLastChild ? parentBottomPaddingBorder : 0),
			);
			if (!(pos.height + bottomMargin)) {
				continue;
			}
			if (this.fragmentainers.has(childNode as Element)) {
				const fragBox = this.fragmentainerBox(
					childNode as unknown as Element,
				);
				if (
					(childNode as HTMLElement).scrollWidth >
						fragBox.right - fragBox.left + COLUMN_EPSILON ||
					(childNode as HTMLElement).scrollHeight >
						fragBox.bottom - fragBox.top + COLUMN_EPSILON
				) {
					return childNode;
				}
				continue;
			}
			if (nodeFrag) {
				const rects = this.nodeClientRects(childNode);
				const list: DOMRect[] =
					rects && rects.length
						? (Array.from(rects) as DOMRect[])
						: [pos as DOMRect];
				for (const rect of list) {
					if (this.rectOverflows(rect, bottomMargin, nodeFrag, bounds)) {
						return childNode;
					}
				}
			} else if (
				(this.inManualColumns
					// Inside manual columns a purely horizontal overhang is
					// normal inline behavior (a no-wrap run, an ellipsized TOC
					// label) that a column break cannot fix; only content
					// sitting entirely outside the bounds counts, so such runs
					// stay whole instead of being shredded. The vertical edges
					// decide the break position.
					? pos.right < bLeft - COLUMN_EPSILON ||
						pos.left > bRight + COLUMN_EPSILON
					: pos.left < bLeft || pos.right > bRight) ||
				pos.top < bTop ||
				bottom > bBottom
			) {
				return childNode;
			}
		}
		return result;
	}

	/**
	 * Whether the active layout root is a manual column box: only then do
	 * purely horizontal overhangs get the entirely-outside treatment in
	 * {@link firstOverflowingChild}.
	 */
	private get inManualColumns(): boolean {
		return this.element.classList.contains("paged_column");
	}

	/**
	 * Whether the node itself spills past the bounds through its own
	 * padding, margin or text: the intrinsic bottom-right point of its last
	 * untagged child (its own rect for BR and text nodes) plus the summed
	 * bottom padding/border/margin of its ancestor chain.
	 */
	private intrinsicOverflowPoint(node: Node, bounds: DOMRect): boolean {
		let rect: DOMRect | undefined;
		if (isText(node) || (isElement(node) && node.nodeName === "BR")) {
			rect = getBoundingClientRect(node as Element) as DOMRect | undefined;
		} else if (isElement(node)) {
			let lastChild = node.lastChild;
			while (
				lastChild &&
				isElement(lastChild) &&
				(lastChild as HTMLElement).dataset?.overflowTagged
			) {
				lastChild = lastChild.previousSibling;
			}
			if (lastChild) {
				rect = getBoundingClientRect(lastChild as Element) as DOMRect;
			}
		}
		if (!rect) {
			return false;
		}
		// Margins never hold content; only padding and borders of the
		// ancestor chain can visually contain the node's tail.
		const sums = this.getAncestorPaddingBorderAndMarginSums(
			node.parentElement,
			false,
			true,
		);
		const additions =
			sums["padding-bottom"] +
			sums["border-bottom-width"];
		const probeRect = new DOMRect(rect.right, rect.bottom, 0, 0);
		return this.rectOverflows(
			probeRect,
			additions,
			this.getFragmentainer(node),
			bounds,
		);
	}

	/**
	 * The next untagged sibling of `node`, climbing parents; prev follows
	 * the climb. Text siblings with visible content count too: the walk
	 * must be able to reach the tail text that follows an inline sibling
	 * (a footnote call, a moved note, a BR), or a paragraph's overflowing
	 * last lines would never be visited. Returns null when the walk reaches
	 * `topNode`, `rendered`, or exhausts.
	 */
	private nextUntaggedElementSibling(
		node: Node,
		topNode: Node,
		rendered: HTMLElement,
	): Node | null {
		let climber: Node | null = node;
		while (climber) {
			let sibling = climber.nextSibling;
			while (sibling) {
				if (isElement(sibling)) {
					if (!(sibling as HTMLElement).dataset?.overflowTagged) {
						return sibling;
					}
				} else if (
					isText(sibling) &&
					(sibling.textContent || "").trim().length
				) {
					return sibling;
				}
				sibling = sibling.nextSibling;
			}
			if (climber === topNode || climber === rendered) {
				return null;
			}
			climber = climber.parentNode;
			if (!climber || climber === rendered || climber === topNode) {
				return null;
			}
		}
		return null;
	}

	/**
	 * Descends from `startNode` to the deepest node where the overflow
	 * begins, advancing past fully-overflowed subtrees. Returns the node
	 * before the overflowing node and whether any overflow was found.
	 */
	startOfNewOverflow(
		startNode: Node,
		rendered: HTMLElement,
		bounds: DOMRect,
	): [ChildNode | null | undefined, boolean] {
		const topNode: Node = startNode;
		let node: Node | null = startNode;
		let prev: Node = startNode;
		let done = false;
		let anyOverflowFound = false;
		while (!done && node) {
			prev = node;
			const childNode = this.firstOverflowingChild(node, bounds);
			if (childNode) {
				anyOverflowFound = true;
				node = childNode;
				continue;
			}
			if (childNode === null) {
				const next = this.nextUntaggedElementSibling(node, topNode, rendered);
				if (!next) {
					return [null, anyOverflowFound];
				}
				node = next;
				continue;
			}
if (this.intrinsicOverflowPoint(node, bounds)) {
				done = true;
				break;
			}
			const next = this.nextUntaggedElementSibling(node, topNode, rendered);
			if (!next) {
				return [null, anyOverflowFound];
			}
			node = next;
		}
		return [prev as ChildNode, anyOverflowFound];
	}

	/**
	 * The entry point of overflow detection: returns the next overflow
	 * Range, or undefined when nothing spills.
	 */
	findOverflow(
		rendered: HTMLElement,
		bounds: DOMRect,
		source?: DocumentFragment | Node,
	): Range | undefined {
		if (!this.hasOverflow(rendered, bounds)) {
			return undefined;
		}
		if (rendered.dataset.overflowTagged) {
			return undefined;
		}
		let node: Node | null = rendered;
		while (isText(node)) {
			node = (node as Text).nextElementSibling;
		}
		if (!node) {
			return undefined;
		}
		const [startOfOverflow, anyOverflowFound] = this.startOfNewOverflow(
			node,
			rendered,
			bounds,
		);
		if (!anyOverflowFound || !startOfOverflow) {
			return undefined;
		}
		if (
			(isText(startOfOverflow) &&
				(startOfOverflow.parentElement as HTMLElement)?.dataset
					?.overflowTagged) ||
			(isElement(startOfOverflow) &&
				(startOfOverflow as HTMLElement).dataset?.overflowTagged)
		) {
			return undefined;
		}
		let rangeStart: Node = startOfOverflow;
		let check: Node = startOfOverflow;
		node = startOfOverflow;
		let visibleSiblings = false;
		let rangeEnd: Node | null | undefined = rendered.lastElementChild;
		do {
			if (
				isElement(check) &&
				(check.classList.contains("region-content") ||
					check.classList.contains("paged_page_content"))
			) {
				break;
			}
			const checkBounds = getBoundingClientRect(
				check as Element,
			) as DOMRect;
			const overflows = this.rectOverflows(
				checkBounds,
				0,
				this.getFragmentainer(check),
				bounds,
			);
			if (overflows) {
				const rowBreakAt = this.tableRowNeedsBreakAt(check, rendered, bounds);
				if (rowBreakAt) {
					if (rowBreakAt.nodeName === "TABLE") {
						rangeEnd = rowBreakAt;
					} else {
						rangeStart = rowBreakAt;
					}
					break;
				}
				const avoidEl = this.avoidBreakInside(check, rendered);
				if (avoidEl) {
					const rowspanBreakAt = this.rowspanNeedsBreakAt(
						(avoidEl.closest("tr") || check) as Element,
						rendered,
					);
					if (rowspanBreakAt) {
						rangeStart = rowspanBreakAt;
						rangeEnd = rendered.lastChild;
						break;
					}
					// Move the avoid block whole: the break goes before it, so
					// the fit test is the block's own height against a fresh
					// page's space, not the deep overflowing node's.
					const avoidRect = avoidEl.getBoundingClientRect();
					const width = avoidRect.width > bounds.width
						? this.getUnconstrainedElementHeight(avoidEl)
						: avoidRect.height;
					const mustSplit = width > bounds.height;
					if (!mustSplit) {
						rangeStart = avoidEl;
						break;
					}
				}
				let sibling = check.nextSibling;
				while (sibling) {
					const siblingRect = getBoundingClientRect(
						sibling as Element,
					) as DOMRect | undefined;
					if (siblingRect && siblingRect.height > 0) {
						break;
					}
					sibling = sibling.nextSibling;
				}
				if (sibling) {
					const siblingRect = getBoundingClientRect(
						sibling as Element,
					) as DOMRect;
					const frag = this.getFragmentainer(check);
					const startsBeyond = this.rectOverflows(
						new DOMRect(siblingRect.left, siblingRect.top, siblingRect.width, 0),
						0,
						frag,
						bounds,
					);
					const endsBeyond = this.rectOverflows(
						new DOMRect(siblingRect.left, siblingRect.bottom, siblingRect.width, 0),
						0,
						frag,
						bounds,
					);
					if (startsBeyond || endsBeyond) {
						if (!visibleSiblings) {
							rangeEnd = check.parentElement
								? check.parentElement.lastChild
								: rangeEnd;
						}
					} else {
						visibleSiblings = true;
						rangeEnd = undefined;
					}
				}
			}
			const checkParent = check.parentElement;
			if (checkParent) {
				for (const childEl of Array.from(checkParent.children)) {
					(childEl as unknown as { width?: string }).width =
						getComputedStyle(childEl).width;
				}
			}
			if (!checkParent) {
				break;
			}
			check = checkParent;
		} while (check && check !== rendered);
		return this.tagAndCreateOverflowRange(
			startOfOverflow,
			rangeStart,
			rangeEnd || undefined,
			bounds,
			rendered,
		);
	}

	/**
	 * Converts the chosen break nodes into a tagged Range: text starts get
	 * their offset, avoid-pairs pull the start backwards, and the involved
	 * elements are marked so re-detection finds only NEW overflow.
	 */
	tagAndCreateOverflowRange(
		startOfOverflow: Node,
		rangeStart: Node,
		rangeEnd?: Node,
		bounds?: DOMRect,
		rendered?: HTMLElement,
	): Range | undefined {
		const boundsToUse = bounds || this.bounds;
		const renderedRoot = rendered;
		let start: number;
		let end: number;
		let vStart: number;
		let vEnd: number;
		const frag = this.getFragmentainer(rangeStart);
		if (frag) {
			const box = this.fragmentainerBox(frag);
			start = box.left;
			end = box.right;
			vStart = box.top;
			vEnd = box.bottom;
		} else {
			start = boundsToUse.left;
			end = boundsToUse.right;
			vStart = boundsToUse.top;
			vEnd = boundsToUse.bottom;
		}
		let position: Node = rangeStart;
		let offset: number | undefined = undefined;
		if (isText(rangeStart) && (rangeStart.textContent || "").trim().length) {
			offset = this.textBreak(rangeStart, start, end, vStart, vEnd);
			if (offset === undefined) {
				let climber: Node | null = rangeStart;
				let advanced: Element | null = null;
				while (climber && climber !== renderedRoot) {
					if ((climber as Element).nextElementSibling) {
						advanced = (climber as Element).nextElementSibling;
						break;
					}
					climber = climber.parentNode;
				}
				if (!advanced) {
					return undefined;
				}
				startOfOverflow = advanced;
				rangeStart = advanced;
				position = advanced;
				offset = undefined;
			}
		}
		for (;;) {
			const carrier = isText(position)
				? position.parentElement
				: isElement(position)
					? (position as HTMLElement)
					: null;
			if (!carrier) {
				break;
			}
			const wantsAvoid =
				carrier.dataset.previousBreakAfter === "avoid" ||
				carrier.dataset.breakBefore === "avoid";
			if (!wantsAvoid) {
				break;
			}
			// The avoid marks guard the boundary *before* the carrier. A break
			// that keeps any of the carrier's content on this page never
			// crosses that boundary (the previous sibling and the carrier's
			// kept head stay together), so only a break at the carrier's very
			// start needs the pull-back; pulling a mid-carrier break backwards
			// would discard fitting content and can park the break on a
			// textless inline node such as a footnote call anchor.
			let keepsCarrierContent = false;
			if (position !== carrier) {
				if (isText(position) && offset) {
					keepsCarrierContent = true;
				} else {
					let probe: Node | null = position;
					while ((probe = probe.previousSibling)) {
						if (
							isText(probe) &&
							(probe.textContent || "").trim().length
						) {
							keepsCarrierContent = true;
							break;
						}
						if (isElement(probe)) {
							keepsCarrierContent = true;
							break;
						}
					}
				}
			}
			if (keepsCarrierContent) {
				break;
			}
			const previousElement = carrier.previousElementSibling;
			if (!previousElement) {
				break;
			}
			if (previousElement.dataset.splitFrom) {
				break;
			}
			let before = nodeBefore(previousElement, renderedRoot, true);
			if (!before) {
				break;
			}
			// Position the break inside the previous element's trailing text
			// when one exists: a tail that fits whole stays on this page (the
			// text path advances to the next element when it fits), while a
			// tail that crosses the edge splits at the measured line. The
			// descended node may itself be textless (an empty inline such as a
			// footnote call anchor); the break must then fall back to the
			// nearest preceding text instead of parking on the empty node.
			if (isElement(before)) {
				const deepestText = this.deepestTrailingText(before as Element);
				if (deepestText) {
					before = deepestText;
				} else if (!(before.textContent || "").trim().length) {
					let probe: Node | undefined = before;
					for (;;) {
						const previous = nodeBefore(
							probe as Node,
							previousElement,
						);
						if (!previous) {
							break;
						}
						probe = previous;
						if (
							isText(previous) &&
							(previous.textContent || "").trim().length
						) {
							before = previous;
							break;
						}
						if (
							isElement(previous) &&
							(previous as HTMLElement).dataset?.splitFrom
						) {
							break;
						}
					}
				}
			}
			position = before;
			rangeStart = before;
			startOfOverflow = before;
			// The offset belonged to the pre-pull-back node: re-measure the
			// pulled-back text so a tail that fits whole advances past it.
			offset = undefined;
		}
		if (
			isText(rangeStart) &&
			(rangeStart.textContent || "").trim().length &&
			offset === undefined
		) {
			const pulledOffset = this.textBreak(
				rangeStart as Text,
				start,
				end,
				vStart,
				vEnd,
			);
			if (pulledOffset === undefined) {
				let climber: Node | null = rangeStart;
				let advanced: Element | null = null;
				while (climber && climber !== renderedRoot) {
					if ((climber as Element).nextElementSibling) {
						advanced = (climber as Element).nextElementSibling;
						break;
					}
					climber = climber.parentNode;
				}
				if (advanced) {
					startOfOverflow = advanced;
					rangeStart = advanced;
					position = advanced;
				}
			} else {
				offset = pulledOffset;
			}
		}
		const range = this.getRange(rangeStart, (offset || 0) as number, rangeEnd);
		if (isText(rangeStart)) {
			const parent = rangeStart.parentElement;
			if (parent) {
				parent.setAttribute(
					"data-split-to",
					parent.getAttribute("data-ref") as string,
				);
				parent.dataset.rangeStartOverflow = "true";
				parent.dataset.overflowTagged = "true";
				position = parent;
			}
		} else if (isElement(rangeStart)) {
			(rangeStart as HTMLElement).dataset.rangeStartOverflow = "true";
		}
		if (rangeEnd) {
			if (isElement(rangeEnd)) {
				const rangeEndEl = rangeEnd as HTMLElement;
				const startParent = isText(rangeStart)
					? rangeStart.parentElement
					: isElement(rangeStart)
						? (rangeStart as HTMLElement).parentElement
						: null;
				const endRef = rangeEndEl.getAttribute("data-ref");
				const containsStart =
					!!(startParent && endRef && startParent.closest("[data-ref='" + endRef + "']"));
				if (containsStart) {
					const after = nodeAfter(rangeEnd);
					if (after) {
						(after as HTMLElement).dataset.rangeEndOverflow = "true";
						(after as HTMLElement).dataset.overflowTagged = "true";
					} else {
						rangeEndEl.dataset.rangeEndOverflow = "true";
						rangeEndEl.dataset.overflowTagged = "true";
					}
				} else {
					rangeEndEl.dataset.rangeEndOverflow = "true";
					rangeEndEl.dataset.overflowTagged = "true";
				}
			} else if (isText(rangeEnd)) {
				const parent = rangeEnd.parentElement;
				if (parent) {
					parent.dataset.rangeEndOverflow = "true";
				}
			}
		}
		let splitWalker: Node | null = position.parentNode;
		while (splitWalker && splitWalker !== renderedRoot) {
			if (isElement(splitWalker) && splitWalker.previousSibling) {
				const el = splitWalker as HTMLElement;
				el.setAttribute("data-split-to", el.getAttribute("data-ref") as string);
			}
			splitWalker = splitWalker.parentNode;
		}
		const commonAncestor = range.commonAncestorContainer;
		let tagClimber: Node | null = position;
		while (tagClimber) {
			const parent: Node | null = tagClimber.parentNode;
			if (!parent || parent === commonAncestor) {
				break;
			}
			if (isElement(parent)) {
				(parent as HTMLElement).dataset.overflowTagged = "true";
			}
			tagClimber = parent;
		}
		let startTop: Node | null = position;
		while (startTop && startTop.parentNode !== commonAncestor) {
			startTop = startTop.parentNode;
		}
		let endTop: Node | null = rangeEnd || null;
		while (endTop && endTop.parentNode !== commonAncestor) {
			endTop = endTop.parentNode;
		}
		if (startTop && startTop !== endTop) {
			let sibling = startTop.nextSibling;
			while (sibling && sibling !== endTop) {
				if (isElement(sibling)) {
					(sibling as HTMLElement).dataset.overflowTagged = "true";
				}
				sibling = sibling.nextSibling;
			}
			let lastClimber: Node | null = endTop || startTop;
			while (lastClimber && lastClimber !== renderedRoot) {
				if ((lastClimber as Element).nextElementSibling && isElement(lastClimber)) {
					break;
				}
				if (isElement(lastClimber)) {
					(lastClimber as HTMLElement).dataset.overflowTagged = "true";
				}
				const parent: Node | null = lastClimber.parentNode;
				if (!parent || parent === commonAncestor || parent === renderedRoot) {
					break;
				}
				lastClimber = parent;
			}
		}
		return range;
	}

	/**
	 * The client rectangles of a node: elements and ranges delegate to
	 * getClientRects, other nodes are measured through a range.
	 */
	nodeClientRects(node: Node): DOMRectList | undefined {
		return getClientRects(node as Element);
	}

	/**
	 * Collects overflow ranges until detection is exhausted (guarded),
	 * merges duplicates into already-collected ranges, and processes them
	 * into a BreakToken; a residual sweep catches overflow created by the
	 * extraction itself.
	 */
	findBreakToken(
		rendered: HTMLElement,
		source: DocumentFragment | Node,
		bounds: DOMRect = this.bounds,
		prevBreakToken?: BreakToken,
		node: Node | null = null,
		extract = true,
	): BreakToken | undefined {
		const collected: Range[] = [];
		let iterations = 0;
		let overflowResult = this.findOverflow(rendered, bounds, source);
		while (overflowResult) {
			if (iterations >= 100) {
				console.error(
					"paginate-for-print: overflow collection guard exceeded; bailing out.",
				);
				break;
			}
			iterations++;
			let existing = false;
			for (const item of collected) {
				if (
					item.startContainer === overflowResult.startContainer &&
					item.endContainer === overflowResult.endContainer
				) {
					if (
						item.startOffset >= overflowResult.startOffset &&
						item.endOffset <= overflowResult.endOffset
					) {
						item.setStart(
							overflowResult.startContainer,
							overflowResult.startOffset,
						);
					} else if (
						item.endOffset > overflowResult.endOffset &&
						item.startOffset == overflowResult.startOffset
					) {
						item.setEnd(
							overflowResult.endContainer,
							overflowResult.endOffset,
						);
						(item as unknown as { EndOffset?: number }).EndOffset = (
							overflowResult as unknown as { EndOffset?: number }
						).EndOffset;
					}
					existing = true;
					break;
				}
			}
			if (!existing) {
				collected.push(overflowResult);
			}
			overflowResult = this.findOverflow(rendered, bounds, source);
		}
		if (collected.length) {
			const breakToken = this.processOverflowResult(
				collected,
				rendered,
				source,
				bounds,
				prevBreakToken,
				node,
				extract,
			);
			if (breakToken && extract) {
				this.extractResidualOverflow(
					rendered,
					bounds,
					source,
					breakToken,
					prevBreakToken,
				);
			}
			return breakToken;
		}
		return undefined;
	}

	/**
	 * Maps collected overflow ranges back to source resume positions,
	 * extracts the overflowing content, and fires the overflow hooks.
	 * Callers must tolerate an undefined-valued return when no range
	 * produced a token.
	 */
	processOverflowResult(
		ranges: Range[],
		rendered: HTMLElement,
		source: DocumentFragment | Node,
		bounds: DOMRect,
		prevBreakToken: BreakToken | undefined,
		node: Node | null,
		extract?: boolean,
	): BreakToken {
		let breakToken: BreakToken | undefined;
		for (const originalRange of ranges) {
			let overflowRange: Range = originalRange;
			const onOverflowResults = this.hooks.onOverflow.triggerSync(
				overflowRange,
				rendered,
				bounds,
				this,
			);
			for (const result of onOverflowResults) {
				if (result !== undefined) {
					overflowRange = result as Range;
				}
			}
			this.extendOverflowToWord(overflowRange);
			const overflow = this.createOverflow(overflowRange, rendered, source);
			if (!overflow) {
				continue;
			}
			if (!breakToken) {
				breakToken = new BreakToken(node as Node, [overflow]);
			} else {
				breakToken.overflow.push(overflow);
			}
			const onBreakTokenResults = this.hooks.onBreakToken.triggerSync(
				breakToken,
				overflowRange,
				rendered,
				this,
			);
			for (const result of onBreakTokenResults) {
				if (result !== undefined) {
					breakToken = result as BreakToken;
				}
			}
			if (prevBreakToken && breakToken.equals(prevBreakToken)) {
				continue;
			}
			let breakLetter: string | undefined;
			if (
				overflow.node &&
				overflow.offset &&
				(overflow.node as Text).textContent
			) {
				breakLetter = (overflow.node as Text).textContent[overflow.offset];
			}
			if (overflow.node && extract) {
				overflow.ancestor = findElement(
					overflow.range!.commonAncestorContainer,
					source as WithRefs,
				) as Element;
				overflow.content = this.removeOverflow(overflowRange, breakLetter);
			}
		}
		for (const range of ranges) {
			void range;
			this.lastChildCheck(rendered, rendered as WithRefs);
		}
		if (
			(rendered as WithRefs).indexOfRefs &&
			extract &&
			breakToken &&
			breakToken.overflow.length
		) {
			const first = breakToken.overflow[0];
			if (first.content) {
				for (const el of first.content.querySelectorAll("[data-ref]")) {
					const ref = el.getAttribute("data-ref");
					const renderedRefs = (rendered as WithRefs).indexOfRefs;
					if (
						ref &&
						!rendered.querySelector("[data-ref='" + ref + "']") &&
						renderedRefs
					) {
						delete renderedRefs[ref];
					}
				}
			}
		}
		if (breakToken) {
			for (const overflow of breakToken.overflow) {
				// A zero-progress overflow (same resume position as the
				// previous token) is recorded without extraction: nothing
				// left the rendered flow, so the hook must not fire.
				if (!overflow.content) {
					continue;
				}
				this.hooks.afterOverflowRemoved.trigger(
					overflow.content,
					rendered,
					this,
				);
			}
		}
		return breakToken as BreakToken;
	}

	/**
	 * Maps a rendered overflow range back to a source resume position:
	 * element anchors resolve through their rendered/source counterparts,
	 * text anchors through the ordinal text-child mapping.
	 */
	createOverflow(
		overflow: Range,
		rendered: HTMLElement,
		source: DocumentFragment | Node,
	): Overflow | undefined {
		const hyphen = (this.settings.hyphenGlyph as string) || "\u2011";
		let node: Node | undefined;
		let offset = 0;
		let topLevel = false;
		const startContainer = overflow.startContainer;
		const startOffset = overflow.startOffset;
		if (isElement(startContainer)) {
			const container = startContainer;
			let temp: Node | undefined;
			if (container.nodeName === "INPUT") {
				temp = container;
			} else {
				temp = child(container, startOffset);
			}
			if (temp && isElement(temp)) {
				const renderedNode = findElement(temp as Element, rendered as WithRefs);
				if (renderedNode) {
					node = findElement(renderedNode, source as WithRefs) || undefined;
					offset = 0;
				} else {
					let prev: Node | null = prevValidNode(temp);
					if (!prev) {
						return undefined;
					}
					const renderedPrev = findElement(prev, rendered as WithRefs);
					if (!renderedPrev) {
						return undefined;
					}
					const sourcePrev = findElement(renderedPrev, source as WithRefs);
					if (!sourcePrev) {
						return undefined;
					}
					if (!temp.nextSibling) {
						const walker = document.createTreeWalker(
							sourcePrev,
							NodeFilter.SHOW_ELEMENT,
						);
						let lastElement = walker.lastChild();
						while (lastElement) {
							const deeper = walker.lastChild();
							if (!deeper) {
								break;
							}
							lastElement = deeper;
						}
						if (
							lastElement &&
							!findElement(lastElement, rendered as WithRefs)
						) {
							return undefined;
						}
					}
					node = (sourcePrev.nextSibling as Node) || undefined;
					offset = 0;
				}
			} else if (temp) {
				if (container === rendered) {
					node = source as Node;
					topLevel = true;
					const mapping = indexOfTextNodeForOverflow(
						temp,
						source as Element,
						source as Element,
						hyphen,
					);
					if (mapping.index === 0) {
						node = source as Node;
						offset = 0;
					} else {
						node = child(source as Node, mapping.index);
						offset = 0;
					}
				} else {
					const renderedNode =
						findElement(container, rendered as WithRefs) ||
						(() => {
							const prev = prevValidNode(container);
							return prev
								? findElement(prev, rendered as WithRefs)
								: undefined;
						})();
					if (!renderedNode) {
						return undefined;
					}
					const parent = findElement(renderedNode, source as WithRefs);
					if (!parent) {
						return undefined;
					}
					const mapping = indexOfTextNodeForOverflow(
						temp,
						renderedNode as Element,
						parent as Element,
						hyphen,
					);
					if (mapping.index === 0) {
						node = parent;
						offset = 0;
					} else {
						node = child(parent, mapping.index);
						offset = 0;
					}
				}
			}
		} else if (isText(startContainer)) {
			const containerParent = startContainer.parentElement;
			let renderedNode: Element | null | undefined = containerParent
				? findElement(containerParent, rendered as WithRefs)
				: undefined;
			if (!renderedNode) {
				const prev = prevValidNode(startContainer);
				renderedNode = prev
					? findElement(prev, rendered as WithRefs)
					: undefined;
			}
			if (!renderedNode) {
				return undefined;
			}
			const parent = findElement(renderedNode, source as WithRefs);
			if (!parent) {
				return undefined;
			}
			const mapping = indexOfTextNodeForOverflow(
				startContainer,
				renderedNode as Element,
				parent as Element,
				hyphen,
			);
			if (mapping.index === -1) {
				node = parent;
				offset = 0;
			} else {
				const sourceChild = child(parent, mapping.index);
				node = sourceChild;
				offset = sourceChild
					? ((sourceChild.textContent || "").indexOf(
							startContainer.textContent || "",
						) || 0)
					: 0;
			}
		}
		if (!node) {
			return undefined;
		}
		return new Overflow(
			node,
			offset,
			overflow.getBoundingClientRect().height,
			overflow,
			topLevel,
		);
	}

	/**
	 * Builds a Range from a break position: a text start begins at the
	 * character offset, an element start selects the node; the end always
	 * sits after `rangeEnd` so following nodes are included.
	 */
	getRange(rangeStart: Node, offset: number, rangeEnd?: Node): Range {
		const range = document.createRange();
		if (isText(rangeStart)) {
			range.setStart(rangeStart, offset);
		} else {
			range.selectNode(rangeStart);
		}
		range.setEndAfter(rangeEnd || rangeStart);
		return range;
	}

	/**
	 * Extracts the overflowing content from the page and hyphenates the kept
	 * tail when the break lands mid-word.
	 */
	removeOverflow(overflow: Range, breakLetter?: string): DocumentFragment {
		const extracted = overflow.extractContents();
		this.hyphenateAtBreak(overflow.startContainer, breakLetter);
		return extracted;
	}

	/**
	 * Appends the engine's hyphen glyph to a text container whose kept tail
	 * ends in a word character (or a soft hyphen), marking the parent and
	 * recording the hyphenation event for the page.
	 */
	hyphenateAtBreak(startContainer: Node, breakLetter?: string): void {
		if (isText(startContainer)) {
			const text = startContainer.textContent || "";
			const prevLetter = text.charAt(text.length - 1);
			const passes = (value: string) => /^\w|\u00AD$/.test(value);
			if (
				(breakLetter && passes(prevLetter) && passes(breakLetter)) ||
				(!breakLetter && passes(prevLetter))
			) {
				const glyph = (this.settings.hyphenGlyph as string) || "\u2011";
				startContainer.parentElement?.classList.add("paged_hyphen");
				startContainer.appendData(glyph);
				recordHyphenationWarning(
					this.element.closest(".paged_page")?.getAttribute("data-page-number") ||
						undefined,
				);
			}
		}
		this.invalidateBounds();
	}

	/**
	 * Pulls the range's start back to the beginning of a word: a
	 * continuation fragment must carry at least one word of content.
	 */
	extendOverflowToWord(range: Range): void {
		if ((range.toString() || "").trim().length) {
			return;
		}
		let container: Node = range.startContainer;
		let offset = range.startOffset;
		if (!isText(container)) {
			const previous = container.childNodes[offset - 1];
			if (!previous) {
				return;
			}
			container = previous;
			offset = Number.MAX_SAFE_INTEGER;
		}
		let wordChars = 0;
		let current: Node | null = container;
		let currentOffset = offset;
		for (let hops = 0; hops < 60; hops++) {
			if (
				isText(current) &&
				!((current.parentElement as HTMLElement)?.dataset?.note === "footnote")
			) {
				const text = current.textContent || "";
				const before = text.substring(0, Math.min(currentOffset, text.length));
				const match = /(\S+)\s*$/.exec(before);
				if (match) {
					const word = match[1];
					const wordWordChars = word.replace(/[^\w]/g, "").length;
					if (wordWordChars + wordChars >= 2) {
						range.setStart(current, before.length - word.length);
						return;
					}
					wordChars += wordWordChars;
				}
			}
			let prev: Node | null = current
				? nodeBefore(current, undefined, false) || null
				: null;
			while (prev && !isText(prev)) {
				prev = nodeBefore(prev, undefined, false) || null;
			}
			if (!prev) {
				return;
			}
			current = prev;
			currentOffset = (prev.textContent || "").length;
		}
	}

	/**
	 * Duck-typed token comparison used by handlers: missing fields are
	 * skipped, present-and-different fields disagree.
	 */
	equalTokens(
		a?: { node?: Node; offset?: number } | null,
		b?: { node?: Node; offset?: number } | null,
	): boolean {
		if (!a || !b) {
			return false;
		}
		if (a.node && b.node && a.node !== b.node) {
			return false;
		}
		if (
			a.offset !== undefined &&
			b.offset !== undefined &&
			a.offset !== b.offset
		) {
			return false;
		}
		return true;
	}

	/**
	 * Re-sweeps the page for overflow created by the extraction itself
	 * (the kept text re-wraps); pushes any further overflow onto the token.
	 */
	private extractResidualOverflow(
		rendered: HTMLElement,
		bounds: DOMRect,
		source: DocumentFragment | Node,
		breakToken: BreakToken,
		prevBreakToken: BreakToken | undefined,
	): void {
		if (!rendered.isConnected) {
			return;
		}
		this.inResidualSweep = true;
		let iterations = 0;
		while (this.hasOverflow(rendered, bounds)) {
			iterations++;
			if (iterations >= 10) {
				console.warn(
					"paginate-for-print: stopped re-extracting residual overflow on a page (guard limit)",
				);
				break;
			}
			iterations++;
			try {
				this.clearOverflowTags(rendered);
				const range = this.findOverflow(rendered, bounds, source);
				if (!range) {
					break;
				}
				const residualToken = this.processOverflowResult(
					[range],
					rendered,
					source,
					bounds,
					prevBreakToken,
					breakToken.node,
					true,
				);
				if (residualToken && residualToken.overflow.length) {
					breakToken.overflow.push(...residualToken.overflow);
				} else {
					break;
				}
			} catch (error) {
				console.warn(
					"paginate-for-print: residual overflow sweep failed: " +
						(error as Error).message,
				);
				break;
			}
		}
		this.inResidualSweep = false;
	}

	/**
	 * Sweeps every manual column of the page for overflow that appeared
	 * after the page's last check, folding the residue into the outgoing
	 * token and coalescing out-of-order blocks when the break moved earlier.
	 */
	private sweepResidualColumnOverflow(
		wrapper: HTMLElement,
		source: DocumentFragment | Node,
		breakToken: BreakToken,
		prevBreakToken: BreakToken | undefined,
	): void {
		const previousEarliest = this.earliestOverflowNode(breakToken.overflow);
		const columns = wrapper.querySelectorAll<HTMLElement>(
			":scope > .paged_columns > .paged_column",
		);
		for (const column of columns) {
			const spill = column.scrollHeight - column.clientHeight;
			if (spill > OVERFLOW_TOLERANCE) {
				const columnBounds = this.manualColumnBounds(column);
				if (this.hasOverflow(column, columnBounds)) {
					this.extractResidualOverflow(
						column,
						columnBounds,
						source,
						breakToken,
						prevBreakToken,
					);
				}
			}
		}
		const newEarliest = this.earliestOverflowNode(breakToken.overflow);
		if (newEarliest !== previousEarliest) {
			const pageEl = wrapper.closest(".paged_page");
			const footnoteArea = pageEl
				? pageEl.querySelector(".paged_footnote_area")
				: null;
			if (footnoteArea && (footnoteArea.textContent || "").trim().length) {
				this.coalesceResidualOverflow(wrapper, source, breakToken);
			}
		}
	}

	/**
	 * The source node with the earliest document position among the
	 * overflow entries' nodes.
	 */
	private earliestOverflowNode(
		overflows: Overflow[] | undefined,
	): Node | undefined {
		if (!overflows || !overflows.length) {
			return undefined;
		}
		let earliest: Node | undefined;
		for (const overflow of overflows) {
			if (!overflow.node) {
				continue;
			}
			if (!earliest) {
				earliest = overflow.node;
				continue;
			}
			try {
				const position = overflow.node.compareDocumentPosition(earliest);
				if (position & Node.DOCUMENT_POSITION_PRECEDING) {
					earliest = overflow.node;
				}
			} catch {
				// comparison errors ignored
			}
		}
		return earliest;
	}

	/**
	 * When residual overflow was discovered earlier than the token's
	 * existing entries, extracts every rendered block that follows the
	 * earliest point so the next page lays everything out in document order.
	 */
	private coalesceResidualOverflow(
		wrapper: HTMLElement,
		source: DocumentFragment | Node,
		breakToken: BreakToken,
	): void {
		const earliest = this.earliestOverflowNode(breakToken.overflow);
		if (!earliest) {
			return;
		}
		const candidates = wrapper.querySelectorAll(
			":scope > .paged_columns > .paged_column > *, :scope > :not(.paged_float_top):not(.paged_float_bottom):not(.paged_float_spacer):not(.paged_columns)",
		);
		const removed = document.createDocumentFragment();
		let keptSource: Element | null = null;
		for (const block of Array.from(candidates)) {
			const el = block as HTMLElement;
			if (
				el.classList &&
				(el.classList.contains("paged_float_top") ||
					el.classList.contains("paged_float_bottom") ||
					el.classList.contains("paged_float_spacer") ||
					el.classList.contains("paged_columns"))
			) {
				continue;
			}
			if (!el.dataset?.ref) {
				continue;
			}
			const sourceEl = findElement(el, source as WithRefs);
			if (!sourceEl) {
				continue;
			}
			if (!keptSource && sourceEl.contains(earliest)) {
				keptSource = sourceEl;
				continue;
			}
			let isAfter = false;
			try {
				const position = sourceEl.compareDocumentPosition(earliest);
				if (position & Node.DOCUMENT_POSITION_PRECEDING) {
					isAfter = true;
				}
			} catch {
				continue;
			}
			if (!isAfter && keptSource && sourceEl === keptSource) {
				isAfter = true;
			}
			if (!isAfter) {
				continue;
			}
			const range = document.createRange();
			range.selectNode(block);
			const overflow = this.createOverflow(range, wrapper, source);
			if (overflow) {
				overflow.content = this.removeOverflow(range);
				overflow.ancestor =
					findElement(
						range.commonAncestorContainer,
						source as WithRefs,
					) || undefined;
				breakToken.overflow.push(overflow);
				removed.appendChild(overflow.content.cloneNode(true));
			} else {
				const contentFragment = document.createDocumentFragment();
				for (const childNode of Array.from(block.childNodes)) {
					contentFragment.appendChild(childNode.cloneNode(true));
				}
				if (block.parentElement) {
					block.parentElement.removeChild(block);
				}
				const fallbackOverflow = new Overflow(
					sourceEl,
					0,
					0,
					undefined,
					true,
				);
				fallbackOverflow.content = contentFragment;
				breakToken.overflow.push(fallbackOverflow);
				removed.appendChild(contentFragment.cloneNode(true));
			}
		}
		if (removed.hasChildNodes()) {
			this.hooks.afterOverflowRemoved.trigger(removed, wrapper, this);
		}
	}

	/**
	 * The resume token for a wrapper that grew back under-full: the node
	 * after the last rendered element's source counterpart. The token is
	 * anchored at whatever follows (possibly nothing) once anything was
	 * rendered at all.
	 */
	findEndToken(
		rendered: HTMLElement,
		source: DocumentFragment | Node,
	): BreakToken | undefined {
		let last = rendered.lastElementChild as HTMLElement | null;
		while (last && last.lastElementChild) {
			last = last.lastElementChild as HTMLElement;
		}
		if (!last) {
			return undefined;
		}
		const counterpart = findElement(last, source as WithRefs);
		const next = nodeAfter(counterpart as Node, source, false, false);
		return this.breakAt(next);
	}

	/**
	 * The character offset at which `node` first exceeds the available
	 * space; undefined means no break is needed within this node (the
	 * prediction path) or 0 (the legacy path's conversion of "no break").
	 */
	textBreak(
		node: Text,
		start: number,
		end: number,
		vStart: number,
		vEnd: number,
	): number | undefined {
		const __offset = this.textBreakInner(node, start, end, vStart, vEnd);
		return __offset;
	}

	private textBreakInner(
		node: Text,
		start: number,
		end: number,
		vStart: number,
		vEnd: number,
	): number | undefined {
		this.addTemporarySplit(node.parentElement);
		const parentAdditions = this.parentBottomAdditions(node.parentElement);
		if (this.settings.textMeasurement === "pretext" && !this.predictFallbacks.has(node)) {
			let predicted: number | undefined | null;
			try {
				predicted = this.predictTextBreak(
					node,
					start,
					end,
					vStart,
					vEnd,
					parentAdditions,
				);
			} catch {
				predicted = null;
			}
			if (predicted === null) {
				this.predictFallbacks.add(node);
				predictStats.fallbacks++;
			} else {
				this.deleteTemporarySplit(node.parentElement);
				if (predicted === undefined) {
					return undefined;
				}
				if (
					!(node.textContent || "").substring(0, predicted).trim().length
				) {
					return 0;
				}
				return predicted;
			}
		}
		const legacyOffset = this.legacyTextBreakCore(
			node,
			start,
			end,
			vStart,
			vEnd,
			parentAdditions,
		);
		if (legacyOffset === undefined) {
			// Nothing in this node crosses the available space: the caller
			// advances past the whole node instead of breaking at offset 0.
			return undefined;
		}
		this.deleteTemporarySplit(node.parentElement);
		if (
			!(node.textContent || "").substring(0, legacyOffset).trim().length
		) {
			return 0;
		}
		return legacyOffset;
	}

	/**
	 * The bottom padding + border-width + margin sums of the parent chain,
	 * granting the walk's slack when verifying breaks.
	 */
	private parentBottomAdditions(parent: Element | null): number {
		if (!parent) {
			return 0;
		}
		// Margins are blank space no content renders into, so they never
		// count toward the space a line may occupy; only ancestor padding
		// and borders can visually hold content past its box.
		const sums = this.getAncestorPaddingBorderAndMarginSums(
			parent,
			true,
			true,
		);
		return (
			sums["padding-bottom"] +
			sums["border-bottom-width"]
		);
	}

	/**
	 * The legacy fallback word/letter rect walker: the first word (or
	 * letter) whose box passes the available space is the break.
	 */
	private legacyTextBreakCore(
		node: Text,
		start: number,
		end: number,
		vStart: number,
		vEnd: number,
		parentAdditions: number,
	): number | undefined {
		const frag = this.getFragmentainer(node);
		for (const word of words(node)) {
			const rect = getBoundingClientRect(word);
			if (!rect) {
				continue;
			}
			const left = Math.floor(rect.left);
			const right = Math.floor(rect.right);
			const top = rect.top;
			const bottom = rect.bottom;
			if (frag) {
				const wordRect = new DOMRect(
					left,
					top,
					right - left,
					bottom - top,
				);
				if (this.rectOverflows(wordRect, parentAdditions, frag)) {
					return word.startOffset;
				}
				continue;
			}
			if (left > end || top > vEnd - parentAdditions) {
				return word.startOffset;
			}
			if (right > end || bottom > vEnd - parentAdditions) {
				for (const letter of letters(word)) {
					const letterRect = getBoundingClientRect(letter);
					if (!letterRect) {
						continue;
					}
					if (
						Math.floor(letterRect.right) > end ||
						letterRect.bottom > vEnd - parentAdditions
					) {
						return letter.startOffset;
					}
				}
			}
		}
		return undefined;
	}

	/**
	 * Whether the node's LAST character renders outside the bounds: when it
	 * does not, flow order is monotonic and nothing earlier can overflow.
	 */
	private textEndOverflows(
		node: Text,
		frag: Element | null,
		parentAdditions: number,
	): boolean {
		const text = node.textContent || "";
		if (!text.length) {
			return false;
		}
		const range = document.createRange();
		range.setStart(node, text.length - 1);
		range.setEnd(node, text.length);
		const rect = getBoundingClientRect(range);
		if (!rect || (rect.width === 0 && rect.height === 0)) {
			return true;
		}
		return this.rectOverflows(rect, parentAdditions, frag);
	}

	/**
	 * The pretext-backed prediction fast path; returns an offset when
	 * confidently predicted, undefined when the text provably fits, null to
	 * request the legacy fallback.
	 */
	private predictTextBreak(
		node: Text,
		start: number,
		end: number,
		vStart: number,
		vEnd: number,
		parentAdditions: number,
	): number | undefined | null {
		const startTime = performance.now();
		try {
			return this.predictTextBreakInner(
				node,
				start,
				end,
				vStart,
				vEnd,
				parentAdditions,
			);
		} finally {
			predictStats.predictMs += performance.now() - startTime;
		}
	}

	/**
	 * The prediction decision sequence: capability gates, quick-fit probe,
	 * word inventory, arithmetic line walk with narrowing retries, and
	 * verified probes before the offset is accepted.
	 */
	private predictTextBreakInner(
		node: Text,
		start: number,
		end: number,
		vStart: number,
		vEnd: number,
		parentAdditions: number,
	): number | undefined | null {
		if (!measurementCapabilities()) {
			return rejectPrediction("capabilities");
		}
		const spec = buildFontSpec(node.parentElement);
		if (!spec || spec.lineHeight <= 0) {
			return rejectPrediction("font-spec");
		}
		const text = node.textContent || "";
		if (!text.trim().length) {
			return undefined;
		}
		const frag = this.getFragmentainer(node);
		predictStats.predicts++;
		const shrinkList = this.predictionVerified
			? PREDICT_WIDTH_SHRINKS_PX
			: [0];
		if (!this.predictionVerified) {
			predictStats.unverified++;
		}
		if (this.predictionVerified && !this.textEndOverflows(node, frag, parentAdditions)) {
			predictStats.quickFits++;
			return undefined;
		}
		const wordList: Range[] = [];
		for (const word of words(node)) {
			wordList.push(word);
			if (wordList.length > 5000) {
				return rejectPrediction("too-many-words");
			}
		}
		if (wordList.length < 2) {
			return rejectPrediction("too-few-words");
		}
		const r0 = getBoundingClientRect(wordList[0]);
		if (!r0) {
			return rejectPrediction("no-first-rect");
		}
		if (this.rectOverflows(r0, parentAdditions, frag)) {
			return wordList[0].startOffset;
		}
		if (wordList.length < PREDICT_MIN_WORDS) {
			return rejectPrediction("min-words");
		}
		let colLeft: number;
		let colRight: number;
		let colBottom: number;
		let columnsRemaining: number;
		let box: { left: number; top: number; right: number; bottom: number } | null = null;
		let meta: FragmentainerMeta | null = null;
		let stride = 0;
		let colIndex0 = 0;
		if (frag) {
			box = this.fragmentainerBox(frag);
			meta = this.getFragmentainerMeta(frag);
			stride = meta.columnWidth + meta.gap;
			colIndex0 = Math.floor((r0.left - box.left + COLUMN_EPSILON) / stride);
			if (colIndex0 < 0) {
				colIndex0 = 0;
			}
			if (colIndex0 > meta.count - 1) {
				colIndex0 = meta.count - 1;
			}
			if (meta.columnWidth < 4) {
				return rejectPrediction("narrow-column");
			}
			colLeft = box.left + colIndex0 * stride;
			colRight = colLeft + meta.columnWidth;
			colBottom = box.bottom - parentAdditions;
			columnsRemaining = meta.count - 1 - colIndex0;
		} else {
			colLeft = start;
			colRight = end;
			colBottom = vEnd - parentAdditions;
			columnsRemaining = 0;
		}
		const parent = node.parentElement;
		const ref = parent?.dataset?.ref;
		const fk = fontKey(spec);
		const nodeIndex = parent ? textNodeIndexInParent(node, parent) : -1;
		let prepared: PreparedTextWithSegments | null = null;
		let baseOffset = 0;
		let truncated = false;
		const eagerList = ref ? eagerPreparedTexts.get(ref) : undefined;
		if (eagerList && parent) {
			const entry = eagerList.find(
				(candidate) =>
					candidate.childIndex === nodeIndex &&
					candidate.fontKey === fk &&
					candidate.fullText.endsWith(text),
			);
			if (entry) {
				prepared = entry.prepared;
				baseOffset = entry.fullText.length - text.length;
				predictStats.reuses++;
			}
		}
		if (!prepared && ref) {
			const stored = this.continuationPrepared.get(ref);
			if (
				stored &&
				stored.fontKey === fk &&
				stored.fullText.length > text.length &&
				stored.fullText.endsWith(text)
			) {
				prepared = stored.prepared;
				baseOffset = stored.fullText.length - text.length;
				predictStats.reuses++;
			}
		}
		if (!prepared) {
			const preparedText =
				text.length > PREDICT_MAX_CHARS
					? text.substring(0, PREDICT_MAX_CHARS)
					: text;
			truncated = preparedText.length !== text.length;
			const prepareStart = performance.now();
			prepared = this.measure.prepare(preparedText, spec);
			predictStats.prepareCalls++;
			predictStats.prepareMs += performance.now() - prepareStart;
		}
		let lastReject: string | null = null;
		for (const shrink of shrinkList) {
			let y = r0.top;
			let currentColIndex = colIndex0;
			let currentColRight = colRight;
			let remaining = columnsRemaining;
			let candidate: LayoutCursor | null = null;
			let firstLine = true;
			this.measure.walkLines(
				prepared,
				Math.max(currentColRight - r0.left - shrink, 1),
				Math.max(
					frag && meta ? meta.columnWidth - shrink : colRight - colLeft - shrink,
					1,
				),
				(line) => {
					const fits = y + spec.lineHeight <= colBottom + COLUMN_EPSILON;
					if (!fits) {
						if (remaining > 0 && box && meta) {
							remaining--;
							currentColIndex++;
							currentColRight =
								box.left + currentColIndex * stride + meta.columnWidth;
							y = box.top + spec.lineHeight;
							return;
						}
						candidate = line.start;
						return false;
					}
					y += spec.lineHeight;
					firstLine = false;
				},
			);
			void firstLine;
			if (!candidate) {
				if (truncated) {
					return rejectPrediction("truncated");
				}
				if (!this.predictionVerified) {
					return undefined;
				}
				const lastRect = getBoundingClientRect(
					wordList[wordList.length - 1],
				);
				if (
					!lastRect ||
					this.rectOverflows(lastRect, parentAdditions, frag)
				) {
					lastReject = "fits-mismatch";
					continue;
				}
				return undefined;
			}
			const absOffset = this.measure.cursorToOffset(prepared, candidate);
			const candidateOffset = absOffset - baseOffset;
			if (candidateOffset <= 0 || candidateOffset > text.length) {
				return rejectPrediction("offset-range");
			}
			let j = 0;
			for (let i = 0; i < wordList.length; i++) {
				if (wordList[i].startOffset <= candidateOffset) {
					j = i;
				} else {
					break;
				}
			}
			if (!this.predictionVerified) {
				return wordList[j].startOffset;
			}
			const overflowMemo = new Map<number, boolean | undefined>();
			const overflows = (index: number): boolean | undefined => {
				if (overflowMemo.has(index)) {
					return overflowMemo.get(index);
				}
				const rect = getBoundingClientRect(wordList[index]);
				let value: boolean | undefined;
				if (!rect || (rect.width === 0 && rect.height === 0)) {
					value = undefined;
				} else {
					value = this.rectOverflows(rect, parentAdditions, frag);
				}
				overflowMemo.set(index, value);
				return value;
			};
			let nudges = 0;
			while (j < wordList.length - 1 && overflows(j) === false && nudges < 3) {
				j++;
				nudges++;
			}
			if (overflows(j) !== true) {
				lastReject = "no-nonfit";
				break;
			}
			while (j > 0 && overflows(j - 1) === true && nudges < 6) {
				j--;
				nudges++;
			}
			if (j > 0 && overflows(j - 1) === true) {
				lastReject = "prev-overlaps";
				continue;
			}
			if (ref) {
				if (this.continuationPrepared.size >= CONTINUATION_CACHE_MAX) {
					this.continuationPrepared.clear();
				}
				this.continuationPrepared.set(ref, {
					fullText: text,
					fontKey: fk,
					prepared,
				});
			}
			return wordList[j].startOffset;
		}
		return rejectPrediction(lastReject || "exhausted");
	}

	/**
	 * Temporarily lengthens the layout context so wrapped content can reach
	 * its natural height: multicol fragmentainers get height auto, other
	 * content a 5000px pagebox, plus data-split-from markers.
	 */
	removeHeightConstraint(element: Element): void {
		const frag = this.getFragmentainer(element);
		if (frag && frag !== this.element) {
			this.savedFragmentainerHeights.set(
				frag as HTMLElement,
				(frag as HTMLElement).style.height,
			);
			(frag as HTMLElement).style.height = "auto";
		} else {
			const page = element.parentElement?.closest(".paged_page");
			if (page) {
				(page as HTMLElement).style.setProperty(
					"--paged-pagebox-height",
					"5000px",
				);
			}
		}
		this.addTemporarySplit(element.parentElement, false);
		this.invalidateBounds();
	}

	/**
	 * Exact inverse of removeHeightConstraint; callers must pair the calls.
	 */
	restoreHeightConstraint(element: Element): void {
		const frag = this.getFragmentainer(element);
		if (frag && frag !== this.element) {
			const saved = this.savedFragmentainerHeights.get(frag);
			(frag as HTMLElement).style.height = saved ?? "";
			this.savedFragmentainerHeights.delete(frag);
		} else {
			const page = element.parentElement?.closest(".paged_page");
			if (page) {
				(page as HTMLElement).style.removeProperty("--paged-pagebox-height");
			}
		}
		this.deleteTemporarySplit(element.parentElement, false);
		this.invalidateBounds();
	}

	/**
	 * The element's natural height with the height constraint lifted:
	 * rect height plus the ancestor chain's top/bottom padding, border and
	 * margin sums plus any repeated thead heights. Non-element nodes (text
	 * nodes reached from an overflow start) are measured through a document
	 * range spanning the node.
	 */
	getUnconstrainedElementHeight(
		element: Element,
		includeAncestors = true,
		includeTableHead = true,
	): number {
		this.removeHeightConstraint(element);
		const box = getBoundingClientRect(element);
		let total = box ? box.height : 0;
		if (includeAncestors) {
			const sums = this.getAncestorPaddingBorderAndMarginSums(
				element.parentElement,
			);
			total +=
				sums["padding-top"] +
				sums["padding-bottom"] +
				sums["border-top-width"] +
				sums["border-bottom-width"] +
				sums["margin-top"] +
				sums["margin-bottom"];
		}
		if (includeTableHead) {
			total += this.getAncestorTheadSizes(element.parentElement);
		}
		this.restoreHeightConstraint(element);
		return total;
	}

	/**
	 * Sums 12 computed box properties over the ancestor chain starting AT
	 * the given element. Computed values are accumulated with parseInt
	 * without a guard, so a non-px/empty computed value contributes NaN and
	 * poisons the sum. Assumes no margin collapsing.
	 */
	getAncestorPaddingBorderAndMarginSums(
		element?: Element | null,
		stopAtFragmentainer = false,
		excludeMargins = false,
	): Record<string, number> {
		const sums: Record<string, number> = {
			"padding-top": 0,
			"padding-right": 0,
			"padding-bottom": 0,
			"padding-left": 0,
			"border-top-width": 0,
			"border-right-width": 0,
			"border-bottom-width": 0,
			"border-left-width": 0,
			"margin-top": 0,
			"margin-right": 0,
			"margin-bottom": 0,
			"margin-left": 0,
		};
		const keys = Object.keys(sums).filter(
			(key) => !(excludeMargins && key.startsWith("margin-")),
		);
		let current: Element | null = element || null;
		while (current) {
			if (
				current.classList.contains("paged_page_content") ||
				current.classList.contains("paged_footnote_inner_content")
			) {
				break;
			}
			if (
				stopAtFragmentainer &&
				current !== this.element &&
				this.fragmentainers.has(current)
			) {
				break;
			}
			const style = getComputedStyle(current);
			for (const key of keys) {
				sums[key] += parseInt(style.getPropertyValue(key));
			}
			current = current.parentElement;
		}
		return sums;
	}

	/**
	 * Sums the computed height of every direct THEAD child of each TABLE on
	 * the ancestor walk.
	 */
	getAncestorTheadSizes(element?: Element | null): number {
		let total = 0;
		let current: Element | null = element || null;
		while (current) {
			if (
				current.classList.contains("paged_page_content") ||
				current.classList.contains("paged_footnote_inner_content")
			) {
				break;
			}
			if (current.tagName === "TABLE") {
				for (const childEl of Array.from(current.children)) {
					if (childEl.tagName === "THEAD") {
						total += parseInt(getComputedStyle(childEl).height);
					}
				}
			}
			current = current.parentElement;
		}
		return total;
	}

	/**
	 * Walks up from the given element marking data-split-to (or
	 * data-split-from) with a temporary scoped value, without overwriting
	 * existing markers.
	 */
	addTemporarySplit(element?: Element | null, isTo = true): void {
		this.temporaryIndex++;
		const attribute = isTo ? "data-split-to" : "data-split-from";
		let current: Element | null = element || null;
		while (current) {
			if (
				current.classList.contains("paged_page_content") ||
				current.classList.contains("paged_footnote_inner_content")
			) {
				break;
			}
			if (!current.hasAttribute(attribute)) {
				current.setAttribute(attribute, "temp-" + this.temporaryIndex);
			}
			current = current.parentElement;
		}
		this.invalidateBounds();
	}

	/**
	 * The inverse walk: removes the temporary markers set by the most
	 * recent add only (value must equal "temp-" + the current index).
	 */
	deleteTemporarySplit(element?: Element | null, isTo = true): void {
		const attribute = isTo ? "data-split-to" : "data-split-from";
		const expected = "temp-" + this.temporaryIndex;
		let current: Element | null = element || null;
		while (current) {
			if (
				current.classList.contains("paged_page_content") ||
				current.classList.contains("paged_footnote_inner_content")
			) {
				break;
			}
			if (current.getAttribute(attribute) === expected) {
				current.removeAttribute(attribute);
			}
			current = current.parentElement;
		}
		this.invalidateBounds();
	}

	/**
	 * The number of body rows (rows outside thead, whose closest table is
	 * exactly `table`) that precede `row` in table.rows.
	 */
	tableBodyRowsBefore(row: Element, table: Element): number {
		let count = 0;
		for (const tableRow of Array.from((table as HTMLTableElement).rows)) {
			if (tableRow === row) {
				break;
			}
			if (!tableRow.closest("thead") && tableRow.closest("table") === table) {
				count++;
			}
		}
		return count;
	}

	/**
	 * Whether any visible content precedes `element` on the page:
	 * geometry-dependent, so always false in jsdom.
	 */
	hasVisibleContentBefore(element: Element, rendered: HTMLElement): boolean {
		let current: Element | null = element;
		while (current && current !== rendered) {
			let sibling = current.previousSibling;
			while (sibling) {
				const probe = isElement(sibling)
					? (sibling as Element)
					: sibling.parentElement;
				if (probe && probe !== rendered) {
					if (probe.getBoundingClientRect().height > 0) {
						return true;
					}
				}
				sibling = sibling.previousSibling;
			}
			current = current.parentElement;
		}
		return false;
	}

	/**
	 * When the overflow starts inside a table row, returns the element the
	 * break must be placed before: the whole table (when moving it converges
	 * better), undefined (defer to break-inside or mid-row splitting), or
	 * the row itself.
	 */
	tableRowNeedsBreakAt(
		node: Node,
		rendered: HTMLElement,
		bounds: DOMRect,
	): Element | undefined {
		const probe = (isElement(node) ? node : node.parentElement) as Element;
		if (!probe || typeof probe.closest !== "function") {
			return undefined;
		}
		const row = probe.closest("tr");
		if (!row) {
			return undefined;
		}
		if (!row.isConnected || !rendered.contains(row)) {
			return undefined;
		}
		const rowBounds = row.getBoundingClientRect();
		const rowHeight =
			rowBounds.width > bounds.width
				? this.getUnconstrainedElementHeight(row)
				: rowBounds.height;
		if (rowHeight > bounds.height) {
			return undefined;
		}
		const table = row.closest("table");
		if (table && rendered.contains(table)) {
			if (this.tableBodyRowsBefore(row, table) === 0) {
				if (this.hasVisibleContentBefore(table, rendered)) {
					return table;
				}
			}
		}
		if ((row as HTMLElement).dataset?.originalBreakInside === "avoid") {
			return undefined;
		}
		return row;
	}

	/**
	 * Only for TR nodes in tables containing a colspan element: when the
	 * row's cell count differs from the table's column count, returns the
	 * previous full row the following rowspan hangs over.
	 */
	rowspanNeedsBreakAt(
		tableRow: Element,
		rendered: HTMLElement,
	): Element | undefined {
		if (tableRow.nodeName !== "TR") {
			return undefined;
		}
		const table = parentOf(tableRow, "TABLE", rendered) as Element | undefined;
		if (!table) {
			return undefined;
		}
		if (!table.querySelector("[colspan]")) {
			return undefined;
		}
		const firstRow = (table as HTMLTableElement).rows[0];
		if (!firstRow) {
			return undefined;
		}
		const colspanSum = (row: Element): number => {
			let total = 0;
			for (const cell of Array.from(row.children)) {
				const value = parseInt(cell.getAttribute("colspan") || "");
				total += Number.isNaN(value) ? 1 : value;
			}
			return total;
		};
		const columnCount = colspanSum(firstRow);
		const cellCount = (row: Element): number => row.children.length;
		if (cellCount(tableRow) === columnCount) {
			return undefined;
		}
		let fallback: Element = tableRow;
		let candidate: Element | null = tableRow.previousElementSibling;
		while (candidate) {
			if (cellCount(candidate) === columnCount) {
				return candidate;
			}
			fallback = candidate;
			candidate = candidate.previousElementSibling;
		}
		return fallback;
	}

	/**
	 * Whether the node matches any configured column-span selector.
	 * Author-CSS tracking decides — computed style on detached source nodes
	 * is unreliable.
	 */
	private isColumnSpan(node: Node | null | undefined): boolean {
		if (!node || !(node instanceof HTMLElement)) {
			return false;
		}
		for (const selector of this.columnSpanSelectors) {
			try {
				if (node.matches(selector)) {
					return true;
				}
			} catch {
				// invalid selectors are skipped silently
			}
		}
		return false;
	}

	/**
	 * Opens a new column segment below a span: a .paged_columns row with
	 * count .paged_column boxes sized like the page's initial row.
	 */
	private startSpanRow(wrapper: HTMLElement): HTMLElement[] {
		const floored = this.rootColumns ? Math.floor(this.rootColumns.count) : 0;
		if (!this.rootColumns || floored <= 1) {
			return [wrapper];
		}
		const gap =
			this.rootColumns.gap !== undefined && this.rootColumns.gap !== "normal"
				? this.rootColumns.gap
				: "1em";
		const fill = this.rootColumns.fill || "balance";
		const row = document.createElement("div");
		row.classList.add("paged_columns");
		row.style.gap = gap;
		row.dataset.pagedColumnFill = fill;
		for (let i = 0; i < floored; i++) {
			const column = document.createElement("div");
			column.classList.add("paged_column");
			column.dataset.pagedColumn = String(i);
			column.style.width = `calc((100% - ${floored - 1} * ${gap}) / ${floored})`;
			if (i > 0 && this.rootColumns.ruleWidth) {
				let borderLeft = `${this.rootColumns.ruleWidth} ${this.rootColumns.ruleStyle || "solid"}`;
				if (this.rootColumns.ruleColor) {
					borderLeft += ` ${this.rootColumns.ruleColor}`;
				}
				column.style.borderLeft = borderLeft;
			}
			row.appendChild(column);
		}
		wrapper.appendChild(row);
		return Array.from(
			row.querySelectorAll<HTMLElement>(":scope > .paged_column"),
		);
	}

	/**
	 * Moves a column-span:all node whole into the flow host and opens the
	 * next segment row for it, shrinking the completed row first and
	 * migrating overflow the shrink exposes.
	 */
	private applyColumnSpan(
		wrapper: HTMLElement,
		node: Node,
		source: DocumentFragment | Node,
		breakToken: BreakToken | undefined,
	): HTMLElement[] {
		const rows = wrapper.querySelectorAll<HTMLElement>(
			":scope > .paged_columns",
		);
		if (rows.length) {
			this.shrinkCorrectSegmentRow(rows[rows.length - 1]);
		}
		this.append(node, wrapper, source, breakToken, false);
		const newColumns = this.startSpanRow(wrapper);
		this.applyPlannedSegmentHeight(node, newColumns);
		this.migrateShrunkenSegmentOverflow(wrapper, source);
		return newColumns;
	}

	/**
	 * After a new segment row opens, flex re-distributes and earlier segment
	 * rows shrink; content that previously fitted can now overflow. Moves
	 * such overflow into the next column of the same segment so migrated
	 * content stays in document order.
	 */
	private migrateShrunkenSegmentOverflow(
		wrapper: HTMLElement,
		source: DocumentFragment | Node,
	): void {
		const rows = wrapper.querySelectorAll<HTMLElement>(
			":scope > .paged_columns",
		);
		for (let r = 0; r < rows.length - 1; r++) {
			const columns = Array.from(
				rows[r].querySelectorAll<HTMLElement>(":scope > .paged_column"),
			);
			for (let c = 0; c < columns.length; c++) {
				const column = columns[c];
				let guard = 0;
				while (this.hasOverflow(column, this.manualColumnBounds(column))) {
					if (guard >= 10) {
						break;
					}
					guard++;
					this.clearOverflowTags(column);
					const columnBounds = this.manualColumnBounds(column);
					const range = this.findOverflow(column, columnBounds, source);
					if (!range) {
						break;
					}
					if (c >= columns.length - 1) {
						break;
					}
					const fragment = this.removeOverflow(range);
					const target = columns[c + 1];
					if (target.hasChildNodes()) {
						target.insertBefore(fragment, target.firstChild);
					} else {
						target.appendChild(fragment);
					}
				}
			}
		}
	}

	/**
	 * Plans (once per page) the heights of the column segments a page's
	 * spans will close, from measured/probed estimates of the upcoming
	 * source blocks. Gates silently leave rows flexible.
	 */
	private planSegmentHeights(
		wrapper: HTMLElement,
		source: DocumentFragment | Node,
		start: Node | undefined,
	): void {
		this.segmentHeightQueue = [];
		if (!this.rootColumns || this.rootColumns.count <= 1) {
			return;
		}
		if (!this.columnSpanSelectors.size || !elementMeasures.size || !start) {
			return;
		}
		const rows = wrapper.querySelectorAll<HTMLElement>(
			":scope > .paged_columns",
		);
		if (rows.length !== 1) {
			return;
		}
		const row = rows[0];
		const columns = row.querySelectorAll<HTMLElement>(
			":scope > .paged_column",
		);
		if (columns.length <= 1) {
			return;
		}
		const firstColumnRect = columns[0].getBoundingClientRect();
		if (firstColumnRect.width < 8) {
			return;
		}
		const floatTop = wrapper.querySelector(":scope > .paged_float_top");
		const available =
			wrapper.getBoundingClientRect().height -
			(floatTop ? floatTop.getBoundingClientRect().height : 0);
		if (available <= 0) {
			return;
		}
		const queue: Array<{
			ref: string;
			height: number | null;
			spanHeight?: number;
			minRoom?: number;
			defer?: boolean;
		}> = [];
		const extents = this.columnContentExtents(row);
		let segmentTotal = extents.reduce((sum, value) => sum + value, 0);
		let topStart: Node | null = start;
		while (topStart && topStart.parentNode !== source) {
			topStart = topStart.parentNode;
		}
		if (!topStart) {
			return;
		}
		const fullWidth = wrapper.getBoundingClientRect().width;
		const columnWidth = firstColumnRect.width;
		const fill = this.rootColumns.fill || "balance";
		const ctx = { maxLine: 0, maxMargin: 0 };
		let firstHeight: number | null = null;
		let used = 0;
		let pendingSpanRef: string | null = null;
		let pendingSpanHeight = 0;
		let spansSeen = 0;
		let node: Node | null = topStart;
		while (node) {
			if (isElement(node)) {
				const el = node as HTMLElement;
				if (this.isColumnSpan(el)) {
					const h = this.segmentRowHeight(
						segmentTotal,
						columns.length,
						ctx.maxLine || 16,
						ctx.maxMargin,
						available,
						fill,
					);
					if (firstHeight === null) {
						if (h >= available - COLUMN_EPSILON) {
							return;
						}
						firstHeight = h;
						used = h;
					} else if (pendingSpanRef !== null) {
						const fits = h < available - used - COLUMN_EPSILON;
						queue.push({ ref: pendingSpanRef, height: fits ? h : null });
						used += h + pendingSpanHeight;
						if (!fits || used >= available - COLUMN_EPSILON || spansSeen >= 12) {
							const deferCtx = { maxLine: 0, maxMargin: 0 };
							const spanHeight = this.estimateFlowBlockHeight(
								el,
								fullWidth,
								deferCtx,
							);
							queue.push({
								ref: el.dataset.ref || "",
								height: null,
								spanHeight,
								minRoom: deferCtx.maxLine || 16,
								defer: true,
							});
							break;
						}
					}
					spansSeen++;
					pendingSpanRef = el.dataset.ref || "";
					const spanCtx = { maxLine: 0, maxMargin: 0 };
					pendingSpanHeight = this.estimateFlowBlockHeight(
						el,
						fullWidth,
						spanCtx,
					);
					segmentTotal = 0;
					ctx.maxLine = 0;
					ctx.maxMargin = 0;
				} else {
					const skip =
						node === topStart && start !== topStart ? start : undefined;
					segmentTotal += this.estimateFlowBlockHeight(
						el,
						columnWidth,
						ctx,
						skip,
					);
				}
			} else if (isText(node)) {
				if ((node.textContent || "").trim().length) {
					return;
				}
			}
			node = node.nextSibling;
		}
		if (firstHeight === null) {
			return;
		}
		if (node === null && pendingSpanRef !== null) {
			const h = this.segmentRowHeight(
				segmentTotal,
				columns.length,
				ctx.maxLine || 16,
				ctx.maxMargin,
				available,
				fill,
			);
			const fits = h < available - used - COLUMN_EPSILON;
			queue.push({ ref: pendingSpanRef, height: fits ? h : null });
		}
		this.fixSegmentRowHeight(row, firstHeight);
		this.segmentHeightQueue = queue;
	}

	/**
	 * A segment row's height: the content's own height rounded up to whole
	 * lines (capped at the page for auto fill) plus margin slop, or the
	 * balanced share of it.
	 */
	private segmentRowHeight(
		segmentTotal: number,
		count: number,
		line: number,
		margin: number,
		available: number,
		fill: string,
	): number {
		if (fill === "auto") {
			return Math.min(
				Math.ceil(segmentTotal / line) * line + margin + 2 * COLUMN_EPSILON,
				available - COLUMN_EPSILON,
			);
		}
		return (
			Math.ceil(segmentTotal / count / line) * line +
			margin +
			2 * COLUMN_EPSILON
		);
	}

	/**
	 * Estimates a source block's natural height at `width`, including
	 * margins: block children recurse, leaves measure their inline runs,
	 * everything else probes.
	 */
	private estimateFlowBlockHeight(
		el: Element,
		width: number,
		ctx: { maxLine: number; maxMargin: number },
		skipBefore?: Node,
	): number {
		if (!(el instanceof HTMLElement)) {
			return 0;
		}
		const rec = el.dataset.ref
			? elementMeasures.get(el.dataset.ref)
			: undefined;
		if (!rec) {
			return this.probeBlockHeight(el, width, ctx);
		}
		if (rec.display === "none") {
			return 0;
		}
		const innerWidth = Math.max(4, width - rec.padBorderX);
		let content = 0;
		let hasBlockChildren = false;
		for (const childNode of Array.from(el.children)) {
			const child = childNode as HTMLElement;
			const childRef = child.dataset?.ref;
			const childRec = childRef ? elementMeasures.get(childRef) : undefined;
			const isBlock = childRec
				? childRec.block && childRec.display !== "none"
				: true;
			if (!isBlock) {
				continue;
			}
			// A floated child (the polyfill's `initial-letter` cap is one)
			// blockifies, but its box hangs beside the text instead of
			// stacking below it: counting it would add the cap's height to
			// the block that already wraps around it.
			if (child.style.float && child.style.float !== "none") {
				continue;
			}
			hasBlockChildren = true;
			if (
				skipBefore &&
				childNode !== skipBefore &&
				!childNode.contains(skipBefore as Node) &&
				childNode.compareDocumentPosition(skipBefore as Node) &
					Node.DOCUMENT_POSITION_PRECEDING
			) {
				continue;
			}
			content += this.estimateFlowBlockHeight(
				childNode,
				innerWidth,
				ctx,
				childNode.contains(skipBefore as Node) || childNode === skipBefore
					? skipBefore
					: undefined,
			);
		}
		if (!hasBlockChildren) {
			if (!(el.textContent || "").trim().length) {
				return this.probeBlockHeight(el, width, ctx);
			}
			const runs = this.collectInlineRuns(el, skipBefore);
			const measured = measureInlineRunsHeight(this.measure, runs, innerWidth);
			if (measured === null) {
				return this.probeBlockHeight(el, width, ctx);
			}
			content = measured;
			if (rec.font) {
				ctx.maxLine = Math.max(ctx.maxLine, rec.font.lineHeight);
			}
		}
		ctx.maxMargin = Math.max(ctx.maxMargin, rec.marginTop, rec.marginBottom);
		const margins = skipBefore
			? rec.marginBottom
			: rec.marginTop + rec.marginBottom;
		return content + rec.padBorderY + margins;
	}

	/**
	 * Gathers a block's flow text as font runs, skipping footnotes,
	 * script/style and display-none subtrees; consecutive same-font runs
	 * are merged. Text with no available spec at all is dropped.
	 */
	private collectInlineRuns(el: Element, skipBefore?: Node): InlineRun[] {
		const runs: InlineRun[] = [];
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		let textNode = walker.nextNode();
		while (textNode) {
			if (skipBefore && textNode !== skipBefore) {
				const position = skipBefore.compareDocumentPosition(textNode);
				if (position & Node.DOCUMENT_POSITION_PRECEDING) {
					textNode = walker.nextNode();
					continue;
				}
			}
			const parent = textNode.parentElement;
			let skip = false;
			let climber: Node | null = parent;
			while (climber && climber !== el) {
				if (isElement(climber)) {
					const climbEl = climber as HTMLElement;
					if (climbEl.dataset?.note === "footnote") {
						skip = true;
						break;
					}
					if (climbEl.nodeName === "SCRIPT" || climbEl.nodeName === "STYLE") {
						skip = true;
						break;
					}
					const climbRec = climbEl.dataset?.ref
						? elementMeasures.get(climbEl.dataset.ref)
						: undefined;
					if (climbRec && climbRec.display === "none") {
						skip = true;
						break;
					}
				}
				climber = climber.parentNode;
			}
			if (!skip && parent) {
				const parentRef = (parent as HTMLElement).dataset?.ref;
				const parentRec = parentRef ? elementMeasures.get(parentRef) : undefined;
				const elRef = (el as HTMLElement).dataset?.ref;
				const elRec = elRef ? elementMeasures.get(elRef) : undefined;
				const spec = parentRec?.font || elRec?.font;
				if (spec) {
					const last = runs[runs.length - 1];
					if (last && fontKey(last.spec) === fontKey(spec)) {
						last.text += textNode.textContent || "";
					} else {
						runs.push({ text: textNode.textContent || "", spec });
					}
				}
			}
			textNode = walker.nextNode();
		}
		return runs;
	}

	/**
	 * Measures a block's natural height by cloning it into the probe host at
	 * the given width; cached per ref and quantized width.
	 */
	private probeBlockHeight(
		el: Element,
		width: number,
		ctx?: { maxLine: number; maxMargin: number },
	): number {
		const ref = (el as HTMLElement).dataset?.ref || "";
		const key = ref + " " + Math.round(width * 4);
		const cached = segmentProbeCache.get(key);
		if (cached) {
			if (ctx) {
				ctx.maxLine = Math.max(ctx.maxLine, cached.line);
				ctx.maxMargin = Math.max(
					ctx.maxMargin,
					cached.marginTop,
					cached.marginBottom,
				);
			}
			return cached.height;
		}
		const host = getSegmentProbeHost();
		host.style.width = Math.max(4, width) + "px";
		const clone = el.cloneNode(true) as HTMLElement;
		host.appendChild(clone);
		const style = getComputedStyle(clone);
		const rawLine = parseFloat(style.lineHeight);
		const fontSize = parseFloat(style.fontSize);
		const line =
			Number.isFinite(rawLine) && rawLine > 0
				? rawLine
				: (Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 16) * 1.14;
		let marginTop = parseFloat(style.marginTop);
		let marginBottom = parseFloat(style.marginBottom);
		if (!Number.isFinite(marginTop)) {
			marginTop = 0;
		}
		if (!Number.isFinite(marginBottom)) {
			marginBottom = 0;
		}
		const height = clone.offsetHeight;
		clone.remove();
		if (ctx) {
			ctx.maxLine = Math.max(ctx.maxLine, line);
			ctx.maxMargin = Math.max(ctx.maxMargin, marginTop, marginBottom);
		}
		if (segmentProbeCache.size >= 4096) {
			segmentProbeCache.clear();
		}
		segmentProbeCache.set(key, { height, line, marginTop, marginBottom });
		return height;
	}

	/**
	 * Like probeBlockHeight, but the clone's footnote subtrees are removed
	 * first — they leave the flow when the block renders, and the
	 * footnote-reserve prediction must see the same heights the real walk
	 * lays out.
	 */
	private probeBlockHeightWithoutNotes(
		block: HTMLElement,
		width: number,
	): { height: number; line: number; marginTop: number; marginBottom: number } {
		const ref = block.dataset?.ref || "";
		const key = ref + " nonotes " + Math.round(width * 4);
		const cached = segmentProbeCache.get(key);
		if (cached) {
			return cached;
		}
		const host = getSegmentProbeHost();
		host.style.width = Math.max(4, width) + "px";
		const clone = block.cloneNode(true) as HTMLElement;
		for (const note of clone.querySelectorAll("[data-note='footnote']")) {
			note.remove();
		}
		clone.removeAttribute("id");
		host.appendChild(clone);
		const style = getComputedStyle(clone);
		let marginTop = parseFloat(style.marginTop);
		let marginBottom = parseFloat(style.marginBottom);
		if (!Number.isFinite(marginTop)) {
			marginTop = 0;
		}
		if (!Number.isFinite(marginBottom)) {
			marginBottom = 0;
		}
		const height = clone.offsetHeight;
		clone.remove();
		if (segmentProbeCache.size >= 4096) {
			segmentProbeCache.clear();
		}
		segmentProbeCache.set(key, { height, line: 0, marginTop, marginBottom });
		return { height, line: 0, marginTop, marginBottom };
	}

	/**
	 * Per column of a row, the distance from the column's top to the bottom
	 * of its content.
	 */
	private columnContentExtents(row: HTMLElement): number[] {
		return Array.from(
			row.querySelectorAll<HTMLElement>(":scope > .paged_column"),
		).map((column) => this.contentExtent(column));
	}

	/**
	 * Distance from the container's top to the bottom of its content,
	 * including the trailing margin of its deepest last child.
	 */
	private contentExtent(container: HTMLElement): number {
		if (!container.hasChildNodes()) {
			return 0;
		}
		const rect = container.getBoundingClientRect();
		const top = rect.top;
		const range = document.createRange();
		range.selectNodeContents(container);
		const rangeRect = range.getBoundingClientRect();
		let rangeBottom = rangeRect.bottom;
		if (rangeRect.top === 0 && rangeRect.bottom === 0) {
			rangeBottom = 0;
		}
		let deepestBottom = 0;
		let trailingMargin = 0;
		let node: HTMLElement | null =
			(container.lastElementChild as HTMLElement) || null;
		while (node) {
			deepestBottom = node.getBoundingClientRect().bottom;
			const marginBottom = parseFloat(getComputedStyle(node).marginBottom);
			if (Number.isFinite(marginBottom) && marginBottom > trailingMargin) {
				trailingMargin = marginBottom;
			}
			node = (node.lastElementChild as HTMLElement) || null;
		}
		return Math.max(
			0,
			Math.max(rangeBottom, deepestBottom + trailingMargin) - top,
		);
	}

	/**
	 * Fixes a segment row's flex basis to the planned height and marks it
	 * fixed so the balancer and deferral logic can tell.
	 */
	private fixSegmentRowHeight(row: HTMLElement, height: number): void {
		row.style.flex = "0 0 " + Math.max(0, Math.ceil(height)) + "px";
		row.dataset.pagedSegmentFixed = "true";
	}

	/**
	 * Shrinks a completed segment row to its real content height; never
	 * grows a row and never shrinks below the content.
	 */
	private shrinkCorrectSegmentRow(row: HTMLElement): void {
		const extents = this.columnContentExtents(row);
		const needed = extents.length ? Math.max(...extents) : 0;
		if (needed <= 0) {
			return;
		}
		const current = row.getBoundingClientRect().height;
		if (needed < current - COLUMN_EPSILON) {
			this.fixSegmentRowHeight(row, needed);
		}
	}

	/**
	 * Consumes the planned segment height for a span node when the planner
	 * saw it; spans the planner did not see keep their row flexible.
	 */
	private applyPlannedSegmentHeight(
		node: Node,
		newColumns: HTMLElement[],
	): void {
		const entry = this.segmentHeightQueue[0];
		const nodeRef = (node as HTMLElement).dataset?.ref || "";
		if (!entry || entry.ref !== nodeRef) {
			return;
		}
		this.segmentHeightQueue.shift();
		const row = newColumns[0]?.parentElement as HTMLElement | undefined;
		if (!row || !row.classList.contains("paged_columns")) {
			return;
		}
		const remaining = row.getBoundingClientRect().height;
		const target = Math.min(entry.height ?? remaining, remaining);
		if (target > COLUMN_EPSILON) {
			this.fixSegmentRowHeight(row, target);
		}
	}

	/**
	 * Whether a span must wait for the next page: measured against the live
	 * flow host, so it stays correct even when the planner's estimate was
	 * off.
	 */
	private shouldDeferColumnSpan(wrapper: HTMLElement, node: Node): boolean {
		if (!(node instanceof HTMLElement)) {
			return false;
		}
		const rows = wrapper.querySelectorAll<HTMLElement>(
			":scope > .paged_columns",
		);
		if (!rows.length) {
			return false;
		}
		const lastRow = rows[rows.length - 1];
		if (lastRow.dataset.pagedSegmentFixed !== "true") {
			return false;
		}
		const remaining =
			wrapper.getBoundingClientRect().bottom -
			lastRow.getBoundingClientRect().bottom;
		if (remaining <= COLUMN_EPSILON) {
			return true;
		}
		const ctx = { maxLine: 0, maxMargin: 0 };
		const spanHeight = this.estimateFlowBlockHeight(
			node,
			wrapper.getBoundingClientRect().width,
			ctx,
		);
		const minRoom = (ctx.maxLine || 16) + 2 * COLUMN_EPSILON;
		return remaining < spanHeight + minRoom;
	}

	/**
	 * Releases the page's final segment row back to flexible sizing so it
	 * absorbs the leftover space; rows closed by a following span keep
	 * their measured height.
	 */
	private relaxFinalSegmentRow(wrapper: HTMLElement): void {
		const rows = wrapper.querySelectorAll<HTMLElement>(
			":scope > .paged_columns",
		);
		if (!rows.length) {
			return;
		}
		const lastRow = rows[rows.length - 1];
		if (lastRow.dataset.pagedSegmentFixed) {
			lastRow.style.flex = "";
			delete lastRow.dataset.pagedSegmentFixed;
		}
	}

	/**
	 * Predicts, before content is laid out, how much space the page's
	 * upcoming footnotes need and reserves it via the
	 * --paged-footnotes-height custom property on the page area.
	 */
	private reserveFootnoteAreaHeight(
		wrapper: HTMLElement,
		source: DocumentFragment | Node,
		start: Node | undefined,
	): void {
		if (!start) {
			return;
		}
		if (!measurementCapabilities()) {
			return;
		}
		if (!elementMeasures.size) {
			return;
		}
		const area = wrapper.closest(".paged_area") as HTMLElement | null;
		if (!area || area.dataset.pagedFootnoteReserve) {
			return;
		}
		const noteContent = area.querySelector(
			".paged_footnote_content",
		) as HTMLElement | null;
		const noteInner = area.querySelector(
			".paged_footnote_inner_content",
		) as HTMLElement | null;
		if (!noteContent || !noteInner) {
			return;
		}
		const columns = this.flowColumns(wrapper);
		let columnWidth: number;
		if (columns.length > 1) {
			columnWidth = columns[0].getBoundingClientRect().width;
		} else {
			columnWidth = wrapper.clientWidth;
		}
		if (columnWidth <= 8) {
			return;
		}
		const flowH = wrapper.getBoundingClientRect().height;
		if (flowH <= 0) {
			return;
		}
		let placedFloatH = 0;
		for (const float of wrapper.querySelectorAll(
			":scope > .paged_float_top, :scope > .paged_float_spacer",
		)) {
			placedFloatH += float.getBoundingClientRect().height;
		}
		const rowH0 = flowH - placedFloatH;
		if (rowH0 <= 0) {
			return;
		}
		const count = this.rootColumns ? this.rootColumns.count : 1;
		const used = this.currentUsedColumnHeight(wrapper, count, rowH0);
		const budgetBase = count * rowH0 - used;
		if (budgetBase <= 0) {
			return;
		}
		const chrome = this.footnoteChrome(noteContent);
		const probeWidth =
			noteInner.clientWidth || noteContent.clientWidth || columnWidth;
		const flowWidth = wrapper.getBoundingClientRect().width;
		let topStart: Node | null = start;
		while (topStart && topStart.parentNode !== source) {
			topStart = topStart.parentNode;
		}
		if (!topStart) {
			return;
		}
		const extractionAt = (reserve: number): number => {
			const budget = budgetBase - count * reserve;
			if (budget <= 0) {
				return 0;
			}
			return this.predictFootnoteReserve(
				source,
				topStart as Node,
				start as Node,
				columnWidth,
				flowWidth,
				budget,
				probeWidth,
			);
		};
		const fullExtraction = extractionAt(0);
		if (fullExtraction < 0 || fullExtraction === 0) {
			return;
		}
		let lo = 0;
		let hi = fullExtraction + chrome;
		for (let i = 0; i < 10 && hi - lo > 0.5; i++) {
			const mid = (lo + hi) / 2;
			const extraction = extractionAt(mid);
			if (extraction < 0) {
				return;
			}
			if (extraction + chrome <= mid) {
				hi = mid;
			} else {
				lo = mid;
			}
		}
		if (hi <= 0) {
			return;
		}
		// The balance point itself is the space to reserve: at `hi` the
		// prediction is self-consistent — with the budget the page keeps
		// after giving up `hi`, exactly the notes counted at `hi` (plus the
		// area chrome) fit into `hi`. Reserving anything less re-opens
		// budget the prediction did not account for, so more calls land on
		// the page than were reserved for and the area overflows.
		let appliedReserve = Math.ceil(hi);
		if (appliedReserve <= 0) {
			return;
		}
		const current = parseFloat(
			area.style.getPropertyValue("--paged-footnotes-height"),
		);
		const currentUsed = Number.isFinite(current) ? current : 0;
		if (flowH - placedFloatH - currentUsed - appliedReserve < 24) {
			appliedReserve = Math.max(0, flowH - placedFloatH - 24 - currentUsed);
			if (appliedReserve <= 0) {
				return;
			}
		}
		area.style.setProperty(
			"--paged-footnotes-height",
			Math.ceil(currentUsed + appliedReserve) + "px",
		);
		area.dataset.pagedFootnoteReserve = String(
			Math.ceil(currentUsed + appliedReserve),
		);
		this.invalidateBounds();
	}

	/**
	 * Sums the rendered heights of the footnotes whose calls will land on
	 * the page, walking the upcoming top-level source blocks against the
	 * budget. A non-whitespace text node makes the region unmodellable (-1).
	 */
	private predictFootnoteReserve(
		source: DocumentFragment | Node,
		topStart: Node,
		start: Node,
		columnWidth: number,
		flowWidth: number,
		budget: number,
		probeWidth: number,
	): number {
		let total = 0;
		let consumed = 0;
		let prevMargin = 0;
		let node: Node | null = topStart;
		while (node) {
			if (isElement(node)) {
				const el = node as HTMLElement;
				if (needsBreakBefore(el) && consumed > 0) {
					break;
				}
				const skip =
					node === topStart && start !== topStart ? start : undefined;
				let boxH: number;
				let marginT = 0;
				let marginB = 0;
				if (skip) {
					const ctx = { maxLine: 0, maxMargin: 0 };
					boxH = this.estimateFlowBlockHeight(el, columnWidth, ctx, skip);
					const rec = el.dataset.ref
						? elementMeasures.get(el.dataset.ref)
						: undefined;
					marginT = rec ? rec.marginTop : 0;
					marginB = rec ? rec.marginBottom : 0;
				} else {
					const probe = this.probeBlockHeightWithoutNotes(el, columnWidth);
					boxH = Math.max(
						0,
						probe.height - probe.marginTop - probe.marginBottom,
					);
					marginT = probe.marginTop;
					marginB = probe.marginBottom;
				}
				for (const float of this.floatElementsIn(el)) {
					boxH = Math.max(
						0,
						boxH - this.probeBlockHeight(float, flowWidth),
					);
				}
				const remaining = budget - consumed;
				const outer = Math.max(prevMargin, marginT) + boxH;
				if (outer <= remaining + COLUMN_EPSILON) {
					consumed += outer;
					prevMargin = marginB;
					const noteReserve = this.estimateBlockNoteReserve(
						el,
						Infinity,
						boxH,
						columnWidth,
						probeWidth,
						skip,
					);
					total += noteReserve;
				} else if (remaining - Math.max(prevMargin, marginT) > 0) {
					total += this.estimateBlockNoteReserve(
						el,
						remaining - Math.max(prevMargin, marginT),
						boxH,
						columnWidth,
						probeWidth,
						skip,
					);
					break;
				} else {
					break;
				}
			} else if (isText(node)) {
				if ((node.textContent || "").trim().length) {
					return -1;
				}
			}
			node = node.nextSibling;
		}
		return total;
	}

	/**
	 * Sums the heights of a block's footnotes whose calls land before the
	 * predicted split offset.
	 */
	private estimateBlockNoteReserve(
		block: HTMLElement,
		remaining: number,
		blockHeight: number,
		columnWidth: number,
		probeWidth: number,
		skipBefore?: Node,
	): number {
		const runs: InlineRun[] = [];
		const notes: Array<{ offset: number; el: HTMLElement }> = [];
		this.collectFlowTextAndNotes(block, skipBefore, runs, notes);
		if (!notes.length) {
			return 0;
		}
		let limitOffset: number;
		if (Number.isFinite(remaining)) {
			const measured = measureInlineRunsHeight(this.measure, runs, columnWidth);
			if (measured !== null && measured > 0) {
				let lineH = 1;
				for (const run of runs) {
					lineH = Math.max(lineH, run.spec.lineHeight);
				}
				const contentSpace = remaining - Math.max(0, blockHeight - measured);
				const fitLines = contentSpace > 0 ? Math.floor(contentSpace / lineH) : 0;
				const totalLines = Math.max(1, Math.ceil(measured / lineH));
				if (fitLines >= totalLines) {
					limitOffset = Infinity;
				} else if (fitLines <= 0) {
					limitOffset = -1;
				} else {
					const fullText = runs.map((run) => run.text).join("");
					const uniform = runs.every(
						(run) => fontKey(run.spec) === fontKey(runs[0].spec),
					);
					if (uniform) {
						limitOffset = this.offsetAtLine(
							fullText,
							runs[0].spec,
							columnWidth,
							fitLines,
						);
					} else {
						limitOffset = Math.floor(
							(fullText.length * fitLines) / totalLines,
						);
					}
				}
			} else {
				limitOffset = Infinity;
			}
		} else {
			limitOffset = Infinity;
		}
		let total = 0;
		for (const note of notes) {
			if (note.offset < limitOffset) {
				total += this.estimateNoteHeight(note.el, probeWidth);
			}
		}
		return total;
	}

	/**
	 * Recursive walk gathering a block's flow text as font runs plus every
	 * footnote element with its flow-text offset; mirrors collectInlineRuns'
	 * filters.
	 */
	private collectFlowTextAndNotes(
		el: Element,
		skipBefore: Node | undefined,
		runs: InlineRun[],
		notes: Array<{ offset: number; el: HTMLElement }>,
		inheritedSpec?: FontSpec | null,
	): void {
		for (const childNode of Array.from(el.childNodes)) {
			if (isText(childNode)) {
				if (skipBefore && childNode !== skipBefore) {
					const position = skipBefore.compareDocumentPosition(childNode);
					if (position & Node.DOCUMENT_POSITION_PRECEDING) {
						continue;
					}
				}
				const parent = childNode.parentElement;
				let spec: FontSpec | null | undefined = inheritedSpec;
				if (parent) {
					const parentRef = (parent as HTMLElement).dataset?.ref;
					const parentRec = parentRef
						? elementMeasures.get(parentRef)
						: undefined;
					if (parentRec) {
						spec = parentRec.font;
					}
				}
				if (spec) {
					const last = runs[runs.length - 1];
					if (last && fontKey(last.spec) === fontKey(spec)) {
						last.text += childNode.textContent || "";
					} else {
						runs.push({ text: childNode.textContent || "", spec });
					}
				}
			} else if (isElement(childNode)) {
				const childEl = childNode as HTMLElement;
				if (childEl.nodeName === "SCRIPT" || childEl.nodeName === "STYLE") {
					continue;
				}
				const rec = childEl.dataset?.ref
					? elementMeasures.get(childEl.dataset.ref)
					: undefined;
				if (rec && rec.display === "none") {
					continue;
				}
				if (childEl.dataset?.note === "footnote") {
					let offset = 0;
					for (const run of runs) {
						offset += run.text.length;
					}
					notes.push({ offset, el: childEl });
					continue;
				}
				this.collectFlowTextAndNotes(
					childEl,
					skipBefore,
					runs,
					notes,
					rec ? rec.font : inheritedSpec,
				);
			}
		}
	}

	/**
	 * The flow-text offset just past the given line when wrapped at 0.95x
	 * the width; conservative text.length on any failure.
	 */
	private offsetAtLine(
		text: string,
		spec: FontSpec,
		width: number,
		lines: number,
	): number {
		try {
			const prepared = this.measure.prepare(text, spec);
			const safeWidth = Math.max(width * 0.95, 1);
			let recorded: number | null = null;
			let count = 0;
			this.measure.walkLines(prepared, safeWidth, safeWidth, (line) => {
				recorded = this.measure.cursorToOffset(prepared, line.end);
				count++;
				if (count >= lines) {
					return false;
				}
			});
			return count >= lines && recorded !== null ? recorded : text.length;
		} catch {
			return text.length;
		}
	}

	/**
	 * Rendered height of one footnote, probed by cloning into a replica of
	 * the page's footnote area (so the area-scoped base styles and the
	 * marker styles apply exactly as they will in the real area) with its
	 * list-item marker applied.
	 */
	private estimateNoteHeight(note: HTMLElement, width: number): number {
		const ref = note.dataset?.ref || "";
		const key = ref + "\u0000note\u0000" + Math.round(width * 4);
		const cached = segmentProbeCache.get(key);
		if (cached) {
			return cached.height;
		}
		const host = getSegmentProbeHost();
		host.style.width = Math.max(4, width) + "px";
		const replica = document.createElement("div");
		replica.setAttribute(
			"style",
			"position: static; visibility: visible; overflow: visible; height: auto; left: 0px; top: 0px; width: " +
				Math.max(4, width) +
				"px;",
		);
		replica.className = "paged_pagebox";
		replica.style.setProperty("--paged-pagebox-width", Math.max(4, width) + "px");
		replica.style.setProperty("--paged-pagebox-height", "auto");
		replica.style.setProperty("--paged-margin-left", "0px");
		replica.style.setProperty("--paged-margin-right", "0px");
		replica.style.setProperty("--paged-margin-top", "0px");
		replica.style.setProperty("--paged-margin-bottom", "0px");
		replica.style.setProperty("--paged-bleed-left", "0px");
		replica.style.setProperty("--paged-bleed-right", "0px");
		const area = document.createElement("div");
		area.className = "paged_area";
		const footnoteArea = document.createElement("div");
		footnoteArea.className = "paged_footnote_area";
		footnoteArea.style.height = "auto";
		const noteContent = document.createElement("div");
		noteContent.className = "paged_footnote_content";
		const noteInner = document.createElement("div");
		noteInner.className = "paged_footnote_inner_content";
		noteInner.style.columnWidth = Math.max(4, width) + "px";
		noteInner.style.columnGap = "0px";
		noteContent.appendChild(noteInner);
		footnoteArea.appendChild(noteContent);
		area.appendChild(footnoteArea);
		replica.appendChild(area);
		host.appendChild(replica);
		const clone = note.cloneNode(true) as HTMLElement;
		clone.removeAttribute("id");
		if (clone.dataset?.ref) {
			clone.setAttribute("data-footnote-marker", clone.dataset.ref);
		}
		noteInner.appendChild(clone);
		let marginTop = parseFloat(getComputedStyle(clone).marginTop);
		let marginBottom = parseFloat(getComputedStyle(clone).marginBottom);
		if (!Number.isFinite(marginTop)) {
			marginTop = 0;
		}
		if (!Number.isFinite(marginBottom)) {
			marginBottom = 0;
		}
		const height = noteInner.scrollHeight;
		replica.remove();
		if (segmentProbeCache.size >= 4096) {
			segmentProbeCache.clear();
		}
		segmentProbeCache.set(key, { height, line: 0, marginTop, marginBottom: 0 });
		return height;
	}

	/**
	 * The page floats inside a node: the node itself when it carries the
	 * marker, else all marked descendants.
	 */
	private floatElementsIn(node: Node): HTMLElement[] {
		if (!(node instanceof HTMLElement)) {
			return [];
		}
		if (node.dataset.pageFloat) {
			return [node];
		}
		return Array.from(node.querySelectorAll<HTMLElement>("[data-page-float]"));
	}

	/**
	 * Height of flow content already rebuilt into the page's columns, in
	 * the sequential-fill coordinate space.
	 */
	private currentUsedColumnHeight(
		wrapper: HTMLElement,
		count: number,
		rowH: number,
	): number {
		if (count <= 1) {
			return this.contentExtent(wrapper);
		}
		const rows = wrapper.querySelectorAll<HTMLElement>(
			":scope > .paged_columns",
		);
		if (!rows.length) {
			return 0;
		}
		const lastRow = rows[rows.length - 1];
		const columns = lastRow.querySelectorAll<HTMLElement>(
			":scope > .paged_column",
		);
		let used = 0;
		let index = 0;
		for (const column of columns) {
			if (column.hasChildNodes()) {
				used = Math.max(used, index * rowH + this.contentExtent(column));
			}
			index++;
		}
		return used;
	}

	/**
	 * The vertical margin/padding/border chrome the footnote content box
	 * adds around notes.
	 */
	private footnoteChrome(noteContent: HTMLElement): number {
		const style = getComputedStyle(noteContent);
		let chrome = 0;
		for (const prop of [
			"marginTop",
			"marginBottom",
			"paddingTop",
			"paddingBottom",
			"borderTopWidth",
			"borderBottomWidth",
		]) {
			const value = parseFloat(
				String(style[prop as keyof CSSStyleDeclaration]),
			);
			chrome += Number.isNaN(value) ? 0 : value;
		}
		return chrome;
	}

	/**
	 * Fills the page (or column) with content from the still-unrendered
	 * source fragment, starting at the incoming break token. Reacts to
	 * overflow by advancing through manual columns and, when the page is
	 * full, hands back a BreakToken describing where the next page resumes.
	 */
	async renderTo(
		wrapper: HTMLElement,
		source: DocumentFragment | Node,
		breakToken: BreakToken | undefined,
		prevPage: HTMLElement | null = null,
		bounds: DOMRect = this.bounds,
	): Promise<RenderResult> {
		const start = this.getStart(source, breakToken);
		let firstDivisible: Node | null | undefined = start;
		while (
			firstDivisible &&
			isElement(firstDivisible) &&
			(firstDivisible as Element).childNodes.length === 1
		) {
			firstDivisible = (firstDivisible as Element).firstChild;
		}
		let walker = walk(start as Node, source);
		let node: Node | undefined;
		let done = false;
		let next: IteratorResult<Node, void>;
		const forcedBreakQueue: Node[] = [];
		const prevBreakToken = breakToken || new BreakToken(start as Node);
		let columns = this.flowColumns(wrapper);
		let colIndex = 0;
		let dest = columns[0];
		this.setActiveColumn(dest);
		this.hooks.onPageLayout.trigger(wrapper, prevBreakToken, this);
		this.addOverflowToPage(dest, breakToken, prevPage || undefined, source);
		this.reserveFootnoteAreaHeight(wrapper, source, start);
		bounds = this.refreshBounds();
		this.registerFragmentainers(dest);
		for (const frag of Array.from(this.fragmentainers)) {
			this.constrainMulticolHeight(frag, bounds);
		}
		let newBreakToken = this.findBreakToken(
			dest,
			source,
			bounds,
			prevBreakToken,
			start,
		);
		if (prevBreakToken.isFinished()) {
			if (newBreakToken) {
				newBreakToken.setFinished();
			}
			return new RenderResult(newBreakToken);
		}
		if (
			newBreakToken &&
			!newBreakToken.isFinished() &&
			colIndex < columns.length - 1 &&
			!this.isForcedBreakToken(newBreakToken)
		) {
			dest = this.advanceColumn(columns, colIndex, newBreakToken, prevPage, source);
			colIndex++;
			bounds = this.refreshBounds();
			newBreakToken = undefined;
		}
		this.planSegmentHeights(wrapper, source, start);
		let hasRenderedContent = false;
		for (const childNode of Array.from(wrapper.childNodes)) {
			if (isText(childNode)) {
				if ((childNode.textContent || "").trim().length) {
					hasRenderedContent = true;
				}
			} else if (!(childNode instanceof HTMLElement)) {
				hasRenderedContent = true;
			} else {
				const el = childNode;
				if (
					!el.dataset?.undisplayed &&
					!el.classList.contains("paged_float_top") &&
					!el.classList.contains("paged_float_bottom") &&
					!el.classList.contains("paged_float_spacer") &&
					!el.classList.contains("paged_columns")
				) {
					hasRenderedContent = true;
				}
			}
		}
		if (prevBreakToken) {
			forcedBreakQueue.length = 0;
		}
		let iterations = 0;
		while (!done && !newBreakToken) {
			iterations++;
			if (iterations > 10000) {
				console.error(
					"paginate-for-print: layout main loop guard exceeded; bailing out. node=",
					node ? node.nodeName : node,
					"done=",
					done,
					"newBreakToken=",
					newBreakToken,
				);
				this.failed = true;
				return new RenderResult(
					undefined,
					"Layout main loop guard exceeded" as unknown as Error,
				);
			}
			next = walker.next();
			node = next.value as Node | undefined;
			done = next.done as boolean;
			if (node) {
				this.hooks.layoutNode.trigger(node);
				if (this.shouldBreak(node)) {
					const side = this.sideBreakValue(node);
					let doBreak = hasRenderedContent;
					const pageEl = this.element.closest(".paged_page") as
						| HTMLElement
						| null;
					if (!hasRenderedContent && side && node !== start) {
						doBreak = !(
							pageEl &&
							pageEl.classList.contains("paged_" + side + "_page")
						);
					}
					if (doBreak) {
						forcedBreakQueue.push(node);
						if (pageEl) {
							pageEl.dataset.pagedPartEnd = "true";
						}
					}
				}
				if (!forcedBreakQueue.length) {
					const named = (node as HTMLElement).dataset?.page;
					if (named) {
						const pageEl = this.element.closest(".paged_page") as
							| HTMLElement
							| null;
						if (pageEl) {
							pageEl.classList.add("pagejs_named_page");
							pageEl.classList.add("paged_" + named + "_page");
							if (!(node as HTMLElement).dataset?.splitFrom) {
								pageEl.classList.add("paged_" + named + "_first_page");
							}
						}
					}
				}
			}
			if (
				node &&
				columns.length > 1 &&
				this.isColumnSpan(node) &&
				!forcedBreakQueue.includes(node)
			) {
				const hasOvf = this.hasOverflow(dest, this.refreshBounds());
				let defer = this.shouldDeferColumnSpan(wrapper, node);
				if (!defer) {
					const spanEl = node as HTMLElement;
					// The next *significant* node, not the literal next sibling:
					// whitespace between the span and the block it introduces
					// carries no dataset and no drop cap, which silently
					// disabled both the `break-after: avoid` lookahead and the
					// room reserved for an `initial-letter` on the block after
					// the span.
					const nextNode = nodeAfter(node, source, false);
					const avoidAfter =
						spanEl.dataset?.breakAfter === "avoid" ||
						((nextNode as HTMLElement | undefined)?.dataset
							?.previousBreakAfter === "avoid");
					if (avoidAfter) {
						const lastRow = wrapper.querySelector(
							":scope > .paged_columns:last-of-type",
						) as HTMLElement | null;
						let contentHeight = 0;
						if (lastRow) {
							for (const column of lastRow.querySelectorAll(
								":scope > .paged_column",
							)) {
								contentHeight = Math.max(
									contentHeight,
									(column as HTMLElement).scrollHeight,
								);
							}
						}
						const wrapperRect = wrapper.getBoundingClientRect();
						const remaining = lastRow
							? wrapperRect.bottom -
								(lastRow.getBoundingClientRect().top + contentHeight)
							: 0;
						const spanCtx = { maxLine: 0, maxMargin: 0 };
						const spanHeight = this.estimateFlowBlockHeight(
							spanEl,
							wrapperRect.width,
							spanCtx,
						);
						const line = spanCtx.maxLine || 16;
						let need = line;
						const initialLetter = nextNode
							? (nextNode as HTMLElement).querySelector?.(
									".paged_initial_letter",
								)
							: null;
						if (initialLetter) {
							const initialLetterLines = parseInt(
								(initialLetter as HTMLElement).dataset
									.pagedInitialLetterLines || "",
							);
							if (initialLetterLines > 0) {
								const nextCtx = { maxLine: 0, maxMargin: 0 };
								this.estimateFlowBlockHeight(
									nextNode as Element,
									wrapperRect.width,
									nextCtx,
								);
								need = initialLetterLines * (nextCtx.maxLine || line);
							}
						}
						if (remaining < spanHeight + need + 2 * COLUMN_EPSILON) {
							defer = true;
						}
					}
				}
				const canAbsorb = (!hasOvf || colIndex < columns.length - 1) && !defer;
				if (canAbsorb) {
					columns = this.applyColumnSpan(wrapper, node, source, breakToken);
					colIndex = 0;
					dest = columns[0];
					this.setActiveColumn(dest);
					bounds = this.refreshBounds();
					hasRenderedContent = true;
					walker = walk(
						nodeAfter(node, source, false, false) as Node,
						source,
					);
					continue;
				}
				if (defer) {
					const pageEl = this.element.closest(".paged_page") as
						| HTMLElement
						| null;
					if (pageEl) {
						pageEl.dataset.pagedPartEnd = "true";
					}
					newBreakToken = this.breakAt(node, 0);
					this.relaxFinalSegmentRow(wrapper);
					this.sweepResidualColumnOverflow(
						wrapper,
						source,
						newBreakToken,
						prevBreakToken,
					);
					return new RenderResult(newBreakToken);
				}
			}
			if (
				node &&
				columns.length > 1 &&
				this.needsColumnBreak(node) &&
				this.columnHasContent(dest)
			) {
				if (colIndex < columns.length - 1) {
					dest = this.advanceColumn(
						columns,
						colIndex,
						new BreakToken(node),
						prevPage,
						source,
					);
					colIndex++;
					bounds = this.refreshBounds();
				} else {
					forcedBreakQueue.push(node);
				}
			}
			if (
				forcedBreakQueue.length ||
				!node ||
				!node.parentElement ||
				isElement(node)
			) {
				this.hooks.layout.trigger(wrapper, this);
				const imgs = wrapper.querySelectorAll("img");
				if (imgs.length) {
					await this.waitForImages(imgs);
					// Image loads grow page floats and shrink the room planned
					// segment rows were fixed against; re-fix them before the
					// overflow check reads the columns.
					this.replanFixedSegmentRows(wrapper);
				}
				bounds = this.refreshBounds();
				newBreakToken = this.findBreakToken(
					dest,
					source,
					bounds,
					prevBreakToken,
					node !== undefined ? node : null,
				);
				if (
					newBreakToken &&
					node === undefined &&
					colIndex >= columns.length - 1
				) {
					newBreakToken.setFinished();
				}
				if (forcedBreakQueue.length) {
					if (newBreakToken) {
						newBreakToken.setForcedBreakQueue(forcedBreakQueue);
					} else {
						newBreakToken = this.breakAt(
							forcedBreakQueue.shift() as Node,
							0,
							forcedBreakQueue,
						);
					}
				}
				if (newBreakToken && newBreakToken.equals(prevBreakToken)) {
					this.failed = true;
					console.warn(
						"paginate-for-print: unable to layout item, stopping render: " +
							node,
					);
					return new RenderResult(
						undefined,
						("Unable to layout item: " + node) as unknown as Error,
					);
				}
				if (
					newBreakToken &&
					!newBreakToken.isFinished() &&
					colIndex < columns.length - 1 &&
					!this.isForcedBreakToken(newBreakToken)
				) {
					dest = this.advanceColumn(
						columns,
						colIndex,
						newBreakToken,
						prevPage,
						source,
					);
					colIndex++;
					bounds = this.refreshBounds();
					newBreakToken = undefined;
					// The walker has already yielded `node` but this iteration
					// appended nothing: rewind onto it so it is rendered at the
					// head of the next column instead of being skipped (its
					// parent shell would otherwise be rebuilt out of order by
					// the first child's append).
					if (node && (node as Node).parentElement) {
						walker = walk(node as Node, source);
					}
					continue;
				}
				if (!node || newBreakToken) {
					this.relaxFinalSegmentRow(wrapper);
					if (newBreakToken) {
						this.sweepResidualColumnOverflow(
							wrapper,
							source,
							newBreakToken,
							prevBreakToken,
						);
					}
					return new RenderResult(newBreakToken);
				}
			}
			const shallow = isContainer(node as Node);
			const appendedClone = this.append(
				node as Node,
				dest,
				source,
				breakToken,
				shallow,
			);
			if (
				appendedClone instanceof HTMLElement &&
				this.isMulticolElement(appendedClone)
			) {
				this.registerFragmentainer(appendedClone);
				this.constrainMulticolHeight(appendedClone, this.refreshBounds());
			} else {
				const parentFrag = this.getFragmentainer(appendedClone);
				if (
					parentFrag &&
					parentFrag !== appendedClone &&
					parentFrag !== this.element
				) {
					this.constrainMulticolHeight(parentFrag, this.refreshBounds());
				}
			}
			this.invalidateBounds();
			hasRenderedContent =
				hasRenderedContent ||
				(hasContent(node as Node) &&
					!((node as HTMLElement).dataset?.undisplayed));
			if (!shallow) {
				walker = walk(
					nodeAfter(node as Node, source, false, false) as Node,
					source,
				);
			}
		}
		if (done && !newBreakToken) {
			let cascades = 0;
			while (cascades < columns.length) {
				cascades++;
				bounds = this.refreshBounds();
				newBreakToken = this.findBreakToken(
					dest,
					source,
					bounds,
					prevBreakToken,
					undefined,
				);
				if (
					newBreakToken &&
					node === undefined &&
					colIndex >= columns.length - 1
				) {
					newBreakToken.setFinished();
				}
				if (
					newBreakToken &&
					!newBreakToken.isFinished() &&
					colIndex < columns.length - 1 &&
					!this.isForcedBreakToken(newBreakToken)
				) {
					dest = this.advanceColumn(
						columns,
						colIndex,
						newBreakToken,
						prevPage,
						source,
					);
					colIndex++;
					newBreakToken = undefined;
					continue;
				}
				break;
			}
		}
		this.hooks.beforeRenderResult.trigger(newBreakToken, wrapper, this);
		this.relaxFinalSegmentRow(wrapper);
		if (newBreakToken) {
			this.sweepResidualColumnOverflow(
				wrapper,
				source,
				newBreakToken,
				prevBreakToken,
			);
		}
		return new RenderResult(newBreakToken);
	}

	/**
	 * Awaits every image's load concurrently; an image that can never
	 * settle would hang the walk, so callers pass only settleable images.
	 */
	async waitForImages(imgs: NodeListOf<HTMLImageElement>): Promise<void> {
		await Promise.all(Array.from(imgs).map((img) => this.awaitImageLoaded(img)));
	}

	/**
	 * Resolves when the image has settled: immediately when already
	 * complete, otherwise on load/error with the image's computed size.
	 */
	async awaitImageLoaded(image: HTMLImageElement): Promise<unknown> {
		if (image.complete === true) {
			return undefined;
		}
		return new Promise((resolve) => {
			const settle = (value?: unknown) => {
				image.onload = null;
				image.onerror = null;
				resolve(value);
			};
			image.onload = () => {
				const style = getComputedStyle(image);
				settle([style.width, style.height]);
			};
			image.onerror = (event) => {
				const style = getComputedStyle(image);
				settle([style.width, style.height, event]);
			};
		});
	}
}

const SIDEBREAK_VALUES = ["left", "right", "recto", "verso"];

/**
 * Lexicographic comparison of two source index paths: element-wise numeric
 * compare, with the shorter path first on equal prefixes.
 */
function compareSourcePaths(a: number[], b: number[]): number {
	const length = Math.min(a.length, b.length);
	for (let i = 0; i < length; i++) {
		if (a[i] !== b[i]) {
			return a[i] - b[i];
		}
	}
	return a.length - b.length;
}

EventEmitter(Layout.prototype);

interface Layout extends PagedEventEmitter {}

declare global {
	interface Window {
		__pagedPredictStats?: typeof predictStats;
	}
}
if (typeof window !== "undefined") {
	window.__pagedPredictStats = predictStats;
	(globalThis as unknown as { __pagedDomOps?: unknown }).__pagedDomOps =
		getDomOpStats();
}

export default Layout;

