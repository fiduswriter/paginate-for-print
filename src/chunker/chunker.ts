/**
 * The document chunker: the top-level orchestrator of the pagination engine.
 *
 * Takes user content (an HTML string, a live DOM node or a
 * `DocumentFragment`), drives it through the parse → filter → font/image
 * preload → render pipeline, and produces the final paginated DOM: a
 * `.paged_pages` container holding one stamped page element per rendered
 * page. It owns the page lifecycle loop (create page → lay out content →
 * fire hooks → advance the break token → repeat), the forced-side-break
 * logic that inserts blank left/right pages, the cancellation/restart
 * machinery that rewinds rendering when a page overflows after layout, and
 * the bookkeeping (page list, total count, break token, character
 * statistics) that the rest of the engine reads.
 *
 * Rendering is incremental: pages are produced step-by-step by an async
 * generator (`layout`), stepped in time-boxed batches through an
 * animation-frame-paced `Queue`, so the browser stays responsive during
 * pagination. The `Page` class performs the actual per-page layout via
 * `Layout`; this module only decides when pages are created, what token
 * they start from, and when the whole flow stops.
 */

import Page from "./page.js";
import ContentParser from "./parser.js";
import BreakToken from "./breaktoken.js";
import { prepareTextsEagerly, resetPredictionCaches } from "./layout.js";
import EventEmitter from "event-emitter";
import Hook from "../utils/hook.js";
import Queue from "../utils/queue.js";
import { installDomOperationCounters, resetDomOpStats } from "../utils/domops.js";
import { requestIdleCallback } from "../utils/utils.js";
import type Layout from "./layout.js";
import type { PagedEventEmitter } from "../types/emitter.js";

// Page-count cap; null disables the cap (inert guard kept for parity).
const MAX_PAGES = null;
// Render-iteration cap; false disables the cap (inert guard kept for parity).
const MAX_LAYOUTS = false;
// Per-image preload timeout, in milliseconds.
const IMAGE_PRELOAD_TIMEOUT_MS: number = 10000;
// Upper bound on the font load / font-ready barrier cycle.
const FONT_LOAD_PASSES: number = 3;

/**
 * The page skeleton stamped into every page element. Kept as markup so the
 * structure stays reviewable; `Page.create` clones it per page and handlers
 * query into the named boxes.
 */
const TEMPLATE = `
<div class="paged_page">
	<div class="paged_sheet">
		<div class="paged_bleed paged_bleed-top">
			<div class="paged_marks-crop"></div>
			<div class="paged_marks-middle">
				<div class="paged_marks-cross"></div>
			</div>
			<div class="paged_marks-crop"></div>
		</div>
		<div class="paged_bleed paged_bleed-bottom">
			<div class="paged_marks-crop"></div>
			<div class="paged_marks-middle">
				<div class="paged_marks-cross"></div>
			</div>		<div class="paged_marks-crop"></div>
		</div>
		<div class="paged_bleed paged_bleed-left">
			<div class="paged_marks-crop"></div>
			<div class="paged_marks-middle">
				<div class="paged_marks-cross"></div>
			</div>		<div class="paged_marks-crop"></div>
		</div>
		<div class="paged_bleed paged_bleed-right">
			<div class="paged_marks-crop"></div>
			<div class="paged_marks-middle">
				<div class="paged_marks-cross"></div>
			</div>
			<div class="paged_marks-crop"></div>
		</div>
		<div class="paged_pagebox">
			<div class="paged_margin-top-left-corner-holder">
				<div class="paged_margin paged_margin-top-left-corner"><div class="paged_margin-content"></div></div>
			</div>
			<div class="paged_margin-top">
				<div class="paged_margin paged_margin-top-left"><div class="paged_margin-content"></div></div>
				<div class="paged_margin paged_margin-top-center"><div class="paged_margin-content"></div></div>
				<div class="paged_margin paged_margin-top-right"><div class="paged_margin-content"></div></div>
			</div>
			<div class="paged_margin-top-right-corner-holder">
				<div class="paged_margin paged_margin-top-right-corner"><div class="paged_margin-content"></div></div>
			</div>
			<div class="paged_margin-right">
				<div class="paged_margin paged_margin-right-top"><div class="paged_margin-content"></div></div>
				<div class="paged_margin paged_margin-right-middle"><div class="paged_margin-content"></div></div>
				<div class="paged_margin paged_margin-right-bottom"><div class="paged_margin-content"></div></div>
			</div>
			<div class="paged_margin-left">
				<div class="paged_margin paged_margin-left-top"><div class="paged_margin-content"></div></div>
				<div class="paged_margin paged_margin-left-middle"><div class="paged_margin-content"></div></div>
				<div class="paged_margin paged_margin-left-bottom"><div class="paged_margin-content"></div></div>
			</div>
			<div class="paged_margin-bottom-left-corner-holder">
				<div class="paged_margin paged_margin-bottom-left-corner"><div class="paged_margin-content"></div></div>
			</div>
			<div class="paged_margin-bottom">
				<div class="paged_margin paged_margin-bottom-left"><div class="paged_margin-content"></div></div>
				<div class="paged_margin paged_margin-bottom-center"><div class="paged_margin-content"></div></div>
				<div class="paged_margin paged_margin-bottom-right"><div class="paged_margin-content"></div></div>
			</div>
			<div class="paged_margin-bottom-right-corner-holder">
				<div class="paged_margin paged_margin-bottom-right-corner"><div class="paged_margin-content"></div></div>
			</div>
			<div class="paged_area">
				<div class="paged_page_content">
					<div class="paged_float_top"></div>
					<div class="paged_float_bottom"></div>
				</div>
				<div class="paged_footnote_area">
					<div class="paged_footnote_content paged_footnote_empty">
						<div class="paged_footnote_inner_content"></div>
					</div>
				</div>
			</div>
		</div>
	</div>
</div>`;

/**
 * Upper-cases the first character of a camelCase property name and keeps
 * the rest, e.g. `breakInside` → `BreakInside`.
 *
 * @param {string} prop - The property name.
 * @returns {string} The capitalized property name.
 */
function capitalize(prop: string): string {
	return prop[0].toUpperCase() + prop.substring(1);
}

/**
 * The hook registry shared by the chunker, every `Page` and every `Layout`
 * it creates. The names double as the hook-name strings the `Handler` base
 * class matches handler methods against.
 *
 * The chunker fires `beforeParsed`, `filter`, `afterParsed`,
 * `beforePageLayout`, `afterPageLayout`, `finalizePage` and `afterRendered`
 * itself; the remaining hooks are fired by `Layout` during `Page.layout`
 * (the hooks object is forwarded unchanged). Handlers registered on
 * `onBreakToken` run with the hook itself as `this`; all other hooks run
 * with the owning chunker as `this`.
 */
export interface ChunkerHooks {
	beforeParsed: Hook<[Node | string, Chunker]>;
	filter: Hook<[DocumentFragment]>;
	afterParsed: Hook<[DocumentFragment, Chunker]>;
	beforePageLayout: Hook<[Page, Node | string | undefined, BreakToken | undefined, Chunker]>;
	onPageLayout: Hook<[HTMLElement, BreakToken | undefined, Layout]>;
	layout: Hook<[HTMLElement, Layout]>;
	renderNode: Hook<[Node, Node, Layout]>;
	layoutNode: Hook<[Node]>;
	onOverflow: Hook<[Range, HTMLElement, DOMRect, Layout]>;
	afterOverflowRemoved: Hook<[DocumentFragment | null | undefined, HTMLElement, Layout]>;
	afterOverflowAdded: Hook<[HTMLElement]>;
	onBreakToken: Hook<[BreakToken, Range | undefined, HTMLElement | undefined, Layout]>;
	beforeRenderResult: Hook<[BreakToken | undefined, HTMLElement, Layout]>;
	afterPageLayout: Hook<[HTMLElement, Page, BreakToken | null | undefined, Chunker]>;
	finalizePage: Hook<[HTMLElement, Page, BreakToken | undefined, Chunker]>;
	afterRendered: Hook<[Page[], Chunker]>;
}

/**
 * The result of one render step (or the whole render): the `{ done, value }`
 * pair from the generator protocol plus an optional `canceled` flag.
 * `canceled: true` with `done: true` and `value: undefined` means rendering
 * was stopped via `stop()` rather than having exhausted the content.
 */
export type RenderStep = IteratorResult<BreakToken | undefined, void> & {
	canceled?: boolean;
};

/**
 * Root-level multi-column configuration applied to every page's content
 * wrapper. `count` is always a floored integer > 1 when produced by
 * `detectRootColumns`; the other fields are passed through unvalidated.
 */
export interface RootColumnConfig {
	count: number;
	gap?: string;
	fill?: "auto" | "balance";
	ruleColor?: string;
	ruleStyle?: string;
	ruleWidth?: string;
}

/**
 * The document chunker. See the module doc for the pipeline overview.
 */
class Chunker {
	/** Options passed to the constructor, or `{}`. Stored by reference. */
	settings: Record<string, unknown>;
	/** The 16 lifecycle hooks, in interface order. */
	hooks: ChunkerHooks;
	/** Rendered pages, oldest first. */
	pages: Page[];
	/** Kept equal to `pages.length` by addPage/removePages (not by clonePage). */
	total: number;
	/** Render-step queue, frame-paced, with the chunker as task context. */
	q: Queue;
	/** Set by `stop()`; reset by `start()`. */
	stopped: boolean;
	/** True while a flow has finished; reset by `start()`. */
	rendered: boolean;
	/** The constructor's content argument, verbatim. */
	content: HTMLElement | DocumentFragment | string | undefined;
	/**
	 * Rules to disable during rendering, keyed by camelCase property name,
	 * then by the original declaration value.
	 */
	modifiedRules: Record<string, Record<string, CSSStyleRule[]>>;
	/** Rolling window (max 4) of per-page text lengths; diagnostic only. */
	charsPerBreak: number[];
	/** Running average of `charsPerBreak`; diagnostic only. */
	maxChars?: number;
	/** The `.paged_pages` container; created by `setup()`. */
	pagesArea?: HTMLDivElement;
	/** Holds the page skeleton markup; created by `setup()`. */
	pageTemplate?: HTMLTemplateElement;
	/** The parsed content, updated twice during `flow`. */
	source?: DocumentFragment | Node;
	/** The resume token between pages. */
	breakToken?: BreakToken;
	/** Selector strings from author CSS declaring multi-column formatting. */
	multicolSelectors: Set<string>;
	/** Selectors declaring `column-span: all`. */
	columnSpanSelectors: Set<string>;
	/** The active root-multicol config, computed by `detectRootColumns`. */
	rootColumns?: RootColumnConfig;
	/**
	 * Root-level column configuration captured from author CSS by the
	 * Columns handler; consumed by `detectRootColumns`.
	 */
	rootColumnsFromCss?: RootColumnConfig;

	/**
	 * Rules to disable during rendering. String entries disable every
	 * top-level rule declaring the property; object entries `{ [prop]: value }`
	 * disable only rules whose current value equals `value`. Public and
	 * mutable: extend before `flow`.
	 */
	rulesToDisable: Array<string | Record<string, string>> = [
		"breakInside",
		"overflow",
		"overflowX",
		"overflowY",
	];

	/**
	 * Creates a chunker. When `content` is truthy the full `flow` pipeline is
	 * started un-awaited, so the constructor returns before any pagination
	 * happened; falsy content (including `""` and `null`) starts nothing.
	 *
	 * @param {HTMLElement | DocumentFragment | string} [content] - Content to
	 *   paginate immediately.
	 * @param {HTMLElement} [renderTo] - Container for the pages area.
	 * @param {Record<string, unknown>} [options] - Settings forwarded to
	 *   pages/layout (notably `rootColumns`, `textMeasurement`, `maxChars`,
	 *   `renderFrameBudget`, `debugDomOps`).
	 */
	constructor(
		content?: HTMLElement | DocumentFragment | string,
		renderTo?: HTMLElement,
		options?: Record<string, unknown>,
	) {
		this.settings = options || {};
		this.hooks = {
			beforeParsed: new Hook(this),
			filter: new Hook(this),
			afterParsed: new Hook(this),
			beforePageLayout: new Hook(this),
			onPageLayout: new Hook(this),
			layout: new Hook(this),
			renderNode: new Hook(this),
			layoutNode: new Hook(this),
			onOverflow: new Hook(this),
			afterOverflowRemoved: new Hook(this),
			afterOverflowAdded: new Hook(this),
			// No context: handlers registered here run with the hook itself
			// as `this`, unlike every other hook.
			onBreakToken: new Hook(),
			beforeRenderResult: new Hook(this),
			afterPageLayout: new Hook(this),
			finalizePage: new Hook(this),
			afterRendered: new Hook(this),
		};
		this.pages = [];
		this.total = 0;
		this.q = new Queue(this);
		this.stopped = false;
		this.rendered = false;
		this.content = content;
		this.modifiedRules = {};
		this.charsPerBreak = [];
		this.multicolSelectors = new Set();
		this.columnSpanSelectors = new Set();
		if (content) {
			// Un-awaited floating promise: rendering proceeds in the
			// background; a rejection becomes an unhandled rejection.
			this.flow(content, renderTo);
		}
	}

	/**
	 * Decides the root-level multicol config. Precedence: `settings.rootColumns`,
	 * then `rootColumnsFromCss` (both used when `Number(count) > 1`, with the
	 * count floored), then the computed style of a connected probe element
	 * (`content` when it is a connected HTMLElement, else `document.body`).
	 *
	 * @param {HTMLElement | DocumentFragment | string} [content] - Probe
	 *   element candidate for the computed-style path.
	 * @returns {RootColumnConfig | undefined} The active config, if any.
	 */
	detectRootColumns(
		content?: HTMLElement | DocumentFragment | string,
	): RootColumnConfig | undefined {
		const fromSettings = this.settings.rootColumns as RootColumnConfig | undefined;
		if (fromSettings && Number(fromSettings.count) > 1) {
			return {
				count: Math.floor(Number(fromSettings.count)),
				gap: fromSettings.gap,
				fill: fromSettings.fill,
				ruleColor: fromSettings.ruleColor,
				ruleStyle: fromSettings.ruleStyle,
				ruleWidth: fromSettings.ruleWidth,
			};
		}
		const fromCss = this.rootColumnsFromCss;
		if (fromCss && Number(fromCss.count) > 1) {
			return {
				count: Math.floor(Number(fromCss.count)),
				gap: fromCss.gap,
				fill: fromCss.fill,
				ruleColor: fromCss.ruleColor,
				ruleStyle: fromCss.ruleStyle,
				ruleWidth: fromCss.ruleWidth,
			};
		}

		let probe: HTMLElement | undefined;
		if (content instanceof HTMLElement && content.isConnected === true) {
			probe = content;
		} else if (typeof document !== "undefined") {
			probe = document.body;
		}
		if (probe) {
			const style = window.getComputedStyle(probe);
			const count = parseInt(style.columnCount);
			if (count > 1) {
				return {
					count,
					gap: style.columnGap !== "normal" ? style.columnGap : undefined,
					fill: style.columnFill === "auto" || style.columnFill === "balance"
						? style.columnFill
						: undefined,
					ruleColor: style.columnRuleColor,
					ruleStyle: style.columnRuleStyle,
					ruleWidth: style.columnRuleWidth,
				};
			}
		}

		return undefined;
	}

	/**
	 * Creates the `.paged_pages` container (appended to `renderTo`, else to
	 * the document body) and the inert page-template skeleton. Calling twice
	 * replaces both fields with new elements; the old pages area stays in the
	 * DOM, orphaned. Renders nothing.
	 *
	 * @param {HTMLElement} [renderTo] - Container for the pages area.
	 */
	setup(renderTo?: HTMLElement): void {
		this.pagesArea = document.createElement("div");
		this.pagesArea.classList.add("paged_pages");
		if (renderTo) {
			renderTo.appendChild(this.pagesArea);
		} else {
			document.querySelector("body")!.appendChild(this.pagesArea);
		}
		this.pageTemplate = document.createElement("template");
		this.pageTemplate.innerHTML = TEMPLATE;
	}

	/**
	 * Snapshots the rules that will be disabled during rendering. Iterates a
	 * snapshot of every top-level rule of every stylesheet and records each
	 * rule matching a `rulesToDisable` entry (string entries match on mere
	 * declaration, object entries require every key to match the rule's
	 * current value). Rules nested inside at-rules are never seen.
	 */
	recordRulesToDisable(): void {
		const sheets = Array.from(document.styleSheets);
		for (const sheet of sheets) {
			const rules = Array.from(sheet.cssRules);
			for (const rule of rules) {
				const styleRule = rule as CSSStyleRule;
				if (!styleRule.style) {
					continue;
				}
				const declarations = styleRule.style as unknown as Record<string, string>;
				for (const entry of this.rulesToDisable) {
					if (typeof entry === "string") {
						if (!declarations[entry]) {
							continue;
						}
						const prop = entry;
						const value = declarations[prop];
						if (!this.modifiedRules[prop]) {
							this.modifiedRules[prop] = {};
						}
						if (!this.modifiedRules[prop][value]) {
							this.modifiedRules[prop][value] = [];
						}
						this.modifiedRules[prop][value].push(styleRule);
					} else {
						// Only the entry's first own key is consulted.
						const prop = Object.keys(entry)[0];
						const current = declarations[prop];
						if (!current || current !== entry[prop]) {
							continue;
						}
						if (!this.modifiedRules[prop]) {
							this.modifiedRules[prop] = {};
						}
						if (!this.modifiedRules[prop][current]) {
							this.modifiedRules[prop][current] = [];
						}
						this.modifiedRules[prop][current].push(styleRule);
					}
				}
			}
		}
	}

	/**
	 * Clears every recorded declaration on the live CSSOM rules and annotates
	 * the matched elements with `data-original-<property>` attributes holding
	 * the recorded value, so inline-state checks survive rendering.
	 *
	 * @param {DocumentFragment | HTMLElement | string} rendered - The content
	 *   to annotate. A string throws a TypeError exactly when a rule was
	 *   recorded (strings have no `querySelectorAll`).
	 */
	disableRules(rendered: DocumentFragment | HTMLElement | string): void {
		for (const [prop, buckets] of Object.entries(this.modifiedRules)) {
			for (const [value, rules] of Object.entries(buckets)) {
				for (const rule of rules) {
					(rule.style as unknown as Record<string, string>)[prop] = "";
					const matched = (rendered as DocumentFragment | HTMLElement).querySelectorAll(
						rule.selectorText,
					);
					for (const node of Array.from(matched)) {
						(node as HTMLElement).dataset["original" + capitalize(prop)] = value;
					}
				}
			}
		}
	}

	/**
	 * Restores every recorded declaration on the live CSSOM rules. The
	 * dataset delete key is built with `substring(2)` (disabling built it
	 * with `substring(1)`), so the delete targets a misspelled key and the
	 * `data-original-*` attributes remain on the nodes — reproduced as-is.
	 *
	 * @param {DocumentFragment | HTMLElement | string} rendered - The content
	 *   to clean up. A string throws a TypeError exactly when a rule was
	 *   recorded.
	 */
	enableRules(rendered: DocumentFragment | HTMLElement | string): void {
		for (const [prop, buckets] of Object.entries(this.modifiedRules)) {
			for (const [value, rules] of Object.entries(buckets)) {
				for (const rule of rules) {
					(rule.style as unknown as Record<string, string>)[prop] = value;
					const matched = (rendered as DocumentFragment | HTMLElement).querySelectorAll(
						rule.selectorText,
					);
					for (const node of Array.from(matched)) {
						delete (node as HTMLElement).dataset[
							"original" + prop[0].toUpperCase() + prop.substring(2)
						];
					}
				}
			}
		}
	}

	/**
	 * The full pipeline: parse → filter → font/image preload → render.
	 * Resolves to the chunker itself. Never throws synchronously; pipeline
	 * failures reject. Handlers observe the exact operation order documented
	 * in the spec.
	 *
	 * @param {HTMLElement | DocumentFragment | string | undefined} content -
	 *   The content to paginate.
	 * @param {HTMLElement} [renderTo] - Container for the pages area (only
	 *   honored on the first flow; a re-flow reuses the container).
	 * @returns {Promise<Chunker>} This chunker, after rendering finished.
	 */
	async flow(
		content: HTMLElement | DocumentFragment | string | undefined,
		renderTo?: HTMLElement,
	): Promise<Chunker> {
		await this.hooks.beforeParsed.trigger(content as Node | string, this);

		if (content) {
			this.recordRulesToDisable();
			this.disableRules(content as HTMLElement);
		}

		let parsed = new ContentParser(content as unknown as string) as unknown as DocumentFragment | Node;
		this.hooks.filter.triggerSync(parsed as DocumentFragment);
		this.source = parsed;
		this.breakToken = undefined;
		this.rootColumns = this.detectRootColumns(content);

		if (this.pagesArea && this.pageTemplate) {
			// Re-flow: reuse the container, drop the previous pages.
			this.q.clear();
			this.removePages();
		} else {
			this.setup(renderTo);
		}

		this.emit("rendering", parsed);
		await this.hooks.afterParsed.trigger(parsed as DocumentFragment, this);
		await this.loadFonts();
		await this.loadImages(parsed);

		const debug = (globalThis as { __PAGED_DEBUG?: { domops?: unknown } })
			.__PAGED_DEBUG;
		if (this.settings.debugDomOps === true || (debug && debug.domops)) {
			installDomOperationCounters();
			resetDomOpStats();
		}

		resetPredictionCaches();

		parsed = prepareTextsEagerly(parsed, this.settings);
		this.source = parsed;

		let step = await this.render(parsed, this.breakToken);
		while (step.canceled) {
			// A page overflowed after layout: restart from the token the
			// overflow listener installed.
			this.start();
			step = await this.render(parsed, this.breakToken);
		}

		this.rendered = true;
		this.pagesArea!.style.setProperty("--paged-page-count", String(this.total));
		await this.hooks.afterRendered.trigger(this.pages, this);
		this.emit("rendered", this.pages);
		this.enableRules(content as HTMLElement);

		return this;
	}

	/**
	 * Drives the whole document through the `layout` generator in
	 * time-boxed batches, paced by the frame-paced queue. The first batch
	 * runs on the queue's first tick — never synchronously.
	 *
	 * @param {DocumentFragment | Node} parsed - The content to render.
	 * @param {BreakToken} [startAt] - The token to resume from.
	 * @returns {Promise<RenderStep>} The final generator result, flagged
	 *   `canceled` when rendering was stopped mid-way.
	 */
	async render(
		parsed: DocumentFragment | Node,
		startAt?: BreakToken,
	): Promise<RenderStep> {
		const renderer = this.layout(parsed, startAt);
		let result: RenderStep;
		// MAX_LAYOUTS is false, so the cap below is inert.
		let count = 0;
		do {
			result = (await this.q.enqueue(() =>
				this.renderBudgeted(
					renderer,
					(this.settings.renderFrameBudget as number | undefined) ?? 12,
				),
			)) as RenderStep;
			if (MAX_LAYOUTS && ++count > (MAX_LAYOUTS as unknown as number)) {
				this.stop();
			}
		} while (!result.done);
		return result;
	}

	/**
	 * Steps the generator repeatedly within one wall-clock budget. The stop
	 * flag is checked before and after every generator step; a stop between
	 * steps abandons the generator immediately and reports the canceled
	 * result. At least one step always runs, and a final `done` result is
	 * returned even when the budget is exhausted.
	 *
	 * @param {AsyncGenerator<BreakToken | undefined>} renderer - The page
	 *   loop generator.
	 * @param {number} [budgetMs=12] - Wall-clock budget per call.
	 * @returns {Promise<RenderStep>} The last generator result.
	 */
	async renderBudgeted(
		renderer: AsyncGenerator<BreakToken | undefined>,
		budgetMs = 12,
	): Promise<RenderStep> {
		const start = performance.now();
		let result: RenderStep;
		do {
			if (this.stopped) {
				return { done: true, value: undefined, canceled: true };
			}
			result = await renderer.next();
			if (this.stopped) {
				return { done: true, value: undefined, canceled: true };
			}
		} while (!result.done && performance.now() - start < budgetMs);
		return result;
	}

	/** Resets the stop and rendered flags. */
	start(): void {
		this.rendered = false;
		this.stopped = false;
	}

	/**
	 * Sets the stop flag. In-flight and queued batches still run but return
	 * the canceled result; the queue is not cleared.
	 */
	stop(): void {
		this.stopped = true;
	}

	/**
	 * Alternative one-step-per-idle-callback strategy (kept as public API;
	 * not used internally). Schedules with `requestIdleCallback` (falling
	 * back to `requestAnimationFrame` in environments without idle
	 * callbacks); rejects with a TypeError when neither exists.
	 *
	 * @param {AsyncGenerator<BreakToken | undefined>} renderer - The page
	 *   loop generator.
	 * @returns {Promise<RenderStep>} One generator step, flagged canceled
	 *   when rendering was stopped.
	 */
	renderOnIdle(
		renderer: AsyncGenerator<BreakToken | undefined>,
	): Promise<RenderStep> {
		return new Promise((resolve) => {
			requestIdleCallback!(async () => {
				if (this.stopped) {
					resolve({ done: true, value: undefined, canceled: true });
					return;
				}
				const result = await renderer.next();
				if (this.stopped) {
					resolve({ done: true, value: undefined, canceled: true });
					return;
				}
				resolve(result);
			});
		});
	}

	/**
	 * Runs exactly one generator step immediately — no queue, no idle
	 * scheduling. Kept as public API; not used internally.
	 *
	 * @param {AsyncGenerator<BreakToken | undefined>} renderer - The page
	 *   loop generator.
	 * @returns {Promise<RenderStep>} The step result, flagged canceled when
	 *   rendering was stopped before or during the step.
	 */
	async renderAsync(
		renderer: AsyncGenerator<BreakToken | undefined>,
	): Promise<RenderStep> {
		if (this.stopped) {
			return { done: true, value: undefined, canceled: true };
		}
		const result = await renderer.next();
		if (this.stopped) {
			return { done: true, value: undefined, canceled: true };
		}
		return result;
	}

	/**
	 * Forced page-break handling: inserts one blank page when the next page's
	 * side (derived from the current total) clashes with the node's forced
	 * `break-before` / previous `break-after` values, or when `force` is
	 * given. Does nothing on the first page (currentPage === 1), even when
	 * forced. A blank page gets the full blank-page hook/event sequence
	 * without any layout pass.
	 *
	 * @param {Node | undefined | null} node - The node whose dataset decides
	 *   the next page's side (dataset-less nodes pass through safely).
	 * @param {boolean} [force] - Force a blank page (except on page 1).
	 */
	async handleBreaks(
		node: Node | undefined | null,
		force?: boolean,
	): Promise<void> {
		const currentPage = this.total + 1;
		const currentPosition = currentPage % 2 === 0 ? "left" : "right";
		const currentSide = currentPage % 2 === 0 ? "verso" : "recto";

		let previousBreakAfter: string | undefined;
		let breakBefore: string | undefined;
		if (node && typeof (node as HTMLElement).dataset !== "undefined") {
			previousBreakAfter = (node as HTMLElement).dataset.previousBreakAfter;
			breakBefore = (node as HTMLElement).dataset.breakBefore;
		}

		// Checked before the force test: even force adds nothing on page 1.
		if (currentPage === 1) {
			return;
		}

		if (force) {
			// fall through to the blank-page insertion below
		} else if (
			(previousBreakAfter === "left" || previousBreakAfter === "right") &&
			previousBreakAfter !== currentPosition
		) {
			force = true;
		} else if (
			(previousBreakAfter === "verso" || previousBreakAfter === "recto") &&
			previousBreakAfter !== currentSide
		) {
			force = true;
		} else if (
			(breakBefore === "left" || breakBefore === "right") &&
			breakBefore !== currentPosition
		) {
			force = true;
		} else if (
			(breakBefore === "verso" || breakBefore === "recto") &&
			breakBefore !== currentSide
		) {
			force = true;
		} else {
			return;
		}

		const page = this.addPage(true);
		await this.hooks.beforePageLayout.trigger(page, undefined, undefined, this);
		this.emit("page", page);
		await this.hooks.afterPageLayout.trigger(page.element!, page, undefined, this);
		await this.hooks.finalizePage.trigger(page.element!, page, undefined, this);
		this.emit("renderedPage", page);
	}

	/**
	 * The page-loop generator. One `next()` attempts at most one page and
	 * yields the outgoing break token. Terminates when a page returns no
	 * continuation: either the flow finished (a final `yield undefined`
	 * precedes the done result) or the page made zero progress and is
	 * dropped without further ceremony.
	 *
	 * @param {Node | string} content - The parsed content to render from.
	 * @param {BreakToken} [startAt] - The token to resume from; falsy values
	 *   become the literal `false` (leaked to handlers on the first page).
	 * @returns {AsyncGenerator<BreakToken | undefined, void, void>} The page
	 *   loop.
	 */
	async *layout(
		content: Node | string,
		startAt?: BreakToken,
	): AsyncGenerator<BreakToken | undefined, void, void> {
		let breakToken: BreakToken | false | undefined =
			(startAt as BreakToken | undefined) || false;
		let page: Page | undefined;
		let prevPage: HTMLElement | undefined;

		while (
			breakToken !== undefined &&
			(MAX_PAGES === null || this.total < MAX_PAGES)
		) {
			// Probe the previous page's rendered content: is the page empty?
			let range: Range | undefined;
			if (page && page.wrapper && page.wrapper.childElementCount > 0) {
				range = document.createRange();
				range.setStartBefore(page.wrapper.childNodes[0]);
				range.setEndAfter(page.wrapper.lastChild!);
			}
			const emptyBody = !range || range.getBoundingClientRect().height === 0;
			const emptyFootnotes =
				!page ||
				!page.footnotesArea ||
				!page.footnotesArea.firstElementChild ||
				!page.footnotesArea.firstElementChild.childElementCount ||
				!page.footnotesArea.firstElementChild.firstElementChild!
					.getBoundingClientRect().height;
			const emptyPage = emptyBody && emptyFootnotes;
			const prevNumPages = this.total;

			if (!page || !emptyPage) {
				if (breakToken) {
					// Pick the node whose dataset decides the next page's side.
					const token = breakToken as BreakToken;
					const sideValue = (
						n: Node | undefined | null,
						includePrevious = true,
					): string | null => {
						if (!n || typeof (n as HTMLElement).dataset === "undefined") {
							return null;
						}
						const dataset = (n as HTMLElement).dataset;
						if (
							dataset.breakBefore === "left" ||
							dataset.breakBefore === "right" ||
							dataset.breakBefore === "recto" ||
							dataset.breakBefore === "verso"
						) {
							return dataset.breakBefore;
						}
						if (
							includePrevious &&
							(dataset.previousBreakAfter === "left" ||
								dataset.previousBreakAfter === "right" ||
								dataset.previousBreakAfter === "recto" ||
								dataset.previousBreakAfter === "verso")
						) {
							return dataset.previousBreakAfter;
						}
						return null;
					};

					let candidates: Array<Node | undefined>;
					let fallback: Node | undefined;
					if (token.overflow.length > 0) {
						const selfSide =
							token.getForcedBreakQueue().length === 0 &&
							sideValue(token.node, false);
						if (selfSide) {
							candidates = [
								token.node,
								token.overflow[0] && token.overflow[0].node,
							];
						} else {
							candidates = [token.overflow[0] && token.overflow[0].node];
						}
						fallback = token.overflow[0] && token.overflow[0].node;
					} else {
						candidates = [...token.getForcedBreakQueue(), token.node];
						fallback = token.node;
					}
					let breakNode: Node | undefined = fallback;
					for (const candidate of candidates) {
						if (sideValue(candidate)) {
							breakNode = candidate;
							break;
						}
					}
					await this.handleBreaks(breakNode);
				} else {
					await this.handleBreaks((content as Node).firstChild);
				}
			}

			const addedExtra = this.total !== prevNumPages;
			if (!page || addedExtra || !emptyPage) {
				this.addPage();
			}
			page = this.pages[this.total - 1];
			await this.hooks.beforePageLayout.trigger(
				page,
				content,
				breakToken as unknown as BreakToken | undefined,
				this,
			);
			this.emit("page", page);
			breakToken = await (page as Page).layout(
				content as DocumentFragment,
				breakToken as unknown as BreakToken | undefined,
				prevPage as unknown as Page,
			);

			// Zero-progress termination: the page absorbed nothing, so drop it
			// and end the loop without finalizing it.
			if (
				breakToken === undefined &&
				(page as Page).zeroProgress &&
				(page as Page).isBlank()
			) {
				this.removePages(this.pages.indexOf(page as Page));
				break;
			}

			await this.hooks.afterPageLayout.trigger(
				(page as Page).element as HTMLElement,
				page,
				breakToken as unknown as BreakToken | null | undefined,
				this,
			);
			await this.hooks.finalizePage.trigger(
				(page as Page).element as HTMLElement,
				page,
				undefined,
				this,
			);
			this.emit("renderedPage", page);
			prevPage = (page as Page).wrapper as HTMLElement;
			this.recoredCharLength((page as Page).wrapper!.textContent!.length);
			yield breakToken as BreakToken | undefined;
		}
	}

	/**
	 * Records a page's text length into the rolling `charsPerBreak` window
	 * (max 4 entries) and updates the running `maxChars` average. Zero-length
	 * pages are ignored.
	 *
	 * @param {number} length - The page's text-content length.
	 */
	recoredCharLength(length: number): void {
		if (length === 0) {
			return;
		}
		this.charsPerBreak.push(length);
		if (this.charsPerBreak.length > 4) {
			this.charsPerBreak.shift();
		}
		this.maxChars = this.charsPerBreak.reduce(
			(sum, value) => sum + value,
			0,
		) / this.charsPerBreak.length;
	}

	/**
	 * Destroys pages from `fromIndex` to the end and truncates the list.
	 * A `fromIndex` at or beyond the list length is a no-op.
	 *
	 * @param {number} [fromIndex=0] - Index of the first page to remove.
	 */
	removePages(fromIndex = 0): void {
		if (fromIndex >= this.pages.length) {
			return;
		}
		for (let i = fromIndex; i < this.pages.length; i++) {
			this.pages[i].destroy();
		}
		if (fromIndex > 0) {
			this.pages.splice(fromIndex);
		} else {
			this.pages = [];
		}
		this.total = this.pages.length;
	}

	/**
	 * A shallow spread of `settings` extended with the three per-page keys:
	 * `rootColumns`, `multicolSelectors` and `columnSpanSelectors`. The sets
	 * are passed by reference (live, shared); mutating the returned object
	 * does not affect `settings`.
	 *
	 * @returns {Record<string, unknown>} The per-page settings snapshot.
	 */
	pageSettings(): Record<string, unknown> {
		return {
			...this.settings,
			rootColumns: this.rootColumns,
			multicolSelectors: this.multicolSelectors,
			columnSpanSelectors: this.columnSpanSelectors,
		};
	}

	/**
	 * Creates, stamps, numbers and appends a page; registers the overflow
	 * and underflow listeners on non-blank pages. The overflow listener
	 * warns, stops all in-flight render batches, stores the overflow token
	 * and destroys every page after this one — the restart then happens
	 * through flow's while(canceled) loop.
	 *
	 * @param {boolean} [blank] - Create a blank page (no listeners).
	 * @returns {Page} The new page.
	 */
	addPage(blank?: boolean): Page {
		const lastPage = this.pages[this.pages.length - 1];
		const page = new Page(
			this.pagesArea!,
			this.pageTemplate!,
			blank,
			this.hooks,
			this.pageSettings(),
		);
		this.pages.push(page);
		page.create(undefined, lastPage && lastPage.element);
		page.index(this.total);

		if (!blank) {
			page.onOverflow((overflowToken) => {
				console.warn("overflow on", page.id, overflowToken);
				if (this.rendered) {
					return;
				}
				const index = this.pages.indexOf(page) + 1;
				this.stop();
				this.breakToken = overflowToken;
				this.removePages(index);
				// The re-render branch below is dead code kept for parity: the
				// early return above guarantees `rendered` is falsy here. The
				// restart happens through flow's while(canceled) loop.
				if ((this.rendered as boolean) === true) {
					// (inert)
				}
			});
			// Underflow handling is disabled: a genuine no-op callback slot.
			page.onUnderflow(() => {
				// (inert)
			});
		}

		this.total = this.pages.length;
		return page;
	}

	/**
	 * Appends a duplicate of an existing page's chrome (used by the footnotes
	 * module for endnote pages): a fresh page with the original's classes
	 * (minus `paged_left_page`/`paged_right_page`) and the full blank-page
	 * hook/event sequence. No layout pass, no char statistics, no overflow
	 * listeners, and — deliberately — no `total` update.
	 *
	 * @param {Page} originalPage - The page to duplicate.
	 */
	async clonePage(originalPage: Page): Promise<void> {
		const lastPage = this.pages[this.pages.length - 1];
		const page = new Page(
			this.pagesArea!,
			this.pageTemplate!,
			false,
			this.hooks,
			this.pageSettings(),
		);
		this.pages.push(page);
		page.create(undefined, lastPage && lastPage.element);
		page.index(this.total);

		await this.hooks.beforePageLayout.trigger(page, undefined, undefined, this);
		this.emit("page", page);

		const classes = Array.from(originalPage.element!.classList);
		for (const className of classes) {
			if (className !== "paged_left_page" && className !== "paged_right_page") {
				page.element!.classList.add(className);
			}
		}

		await this.hooks.afterPageLayout.trigger(page.element!, page, undefined, this);
		await this.hooks.finalizePage.trigger(page.element!, page, undefined, this);
		this.emit("renderedPage", page);
	}

	/**
	 * Preloads all registered font faces so on-screen text breaking matches
	 * later PDF measurement. Runs at most `FONT_LOAD_PASSES` passes; a pass
	 * that finds nothing to load ends the cycle. Failures warn and never
	 * reject; faces already loading or loaded are never re-triggered.
	 *
	 * @returns {Promise<string[]>} The preloaded font families, in
	 *   load-completion order.
	 */
	async loadFonts(): Promise<string[]> {
		const families: string[] = [];
		if (!document.fonts || typeof document.fonts.forEach !== "function") {
			return families;
		}
		for (let pass = 0; pass < FONT_LOAD_PASSES; pass++) {
			let sawUnloaded = false;
			const pending: Array<Promise<void>> = [];
			document.fonts.forEach((face) => {
				if (face.status === "unloaded") {
					sawUnloaded = true;
					pending.push(
						face.load().then(
							() => {
								families.push(face.family);
							},
							() => {
								console.warn("Failed to preload font-family:", face.family);
							},
						),
					);
				}
			});
			await Promise.all(pending);
			if (document.fonts) {
				await document.fonts.ready;
			}
			if (!sawUnloaded) {
				break;
			}
		}
		return families;
	}

	/**
	 * Preloads every image so float placement and overflow detection see
	 * final boxes during the walk. Resolves immediately without a document,
	 * without content, or when the content cannot be queried.
	 *
	 * @param {DocumentFragment | Node} parsed - The parsed content.
	 */
	async loadImages(parsed: DocumentFragment | Node): Promise<void> {
		if (typeof document === "undefined") {
			return;
		}
		if (!parsed) {
			return;
		}
		if (
			typeof (parsed as DocumentFragment).querySelectorAll !== "function"
		) {
			return;
		}
		const images = Array.from(
			(parsed as DocumentFragment).querySelectorAll("img"),
		) as HTMLImageElement[];
		await Promise.all(images.map((img) => this.preloadImage(img)));
	}

	/**
	 * Preloads one image through a detached loader so clones inserted during
	 * layout decode immediately; the original element's own load event is not
	 * awaited. Marks the element eager first so clones keep the attribute.
	 * Always resolves (never rejects); the timeout is a harmless second
	 * resolution after an earlier load/error.
	 *
	 * @param {HTMLImageElement} img - The image to preload.
	 * @returns {Promise<void>} Resolves on loader load/error or after the
	 *   timeout.
	 */
	private preloadImage(img: HTMLImageElement): Promise<void> {
		img.loading = "eager";		if (img.complete && img.naturalWidth > 0) {
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			const finish = resolve;
			const timeout = setTimeout(finish, IMAGE_PRELOAD_TIMEOUT_MS);
			const loader = new Image();
			loader.addEventListener("load", () => {
				clearTimeout(timeout);
				finish();
			}, { once: true });
			loader.addEventListener("error", () => {
				clearTimeout(timeout);
				finish();
			}, { once: true });
			loader.src = img.src;
		});
	}

	/**
	 * Removes the pages area and the page template from the DOM. Does not
	 * clear `pages`/`total` and does not destroy individual pages. Throws a
	 * TypeError when called before `setup()`.
	 */
	destroy(): void {
		this.pagesArea!.remove();
		this.pageTemplate!.remove();
	}
}

// Mix the event-emitter surface (on/once/off/emit) into the prototype.
EventEmitter(Chunker.prototype);

interface Chunker extends PagedEventEmitter {}

export default Chunker;
