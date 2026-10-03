/**
 * The high-level API facade of the pagination engine.
 *
 * A {@link Previewer} takes raw content (an element, a document fragment, an
 * HTML string, or "whatever is in the page body"), a list of stylesheets and a
 * render target, and orchestrates the full pipeline: CSS harvesting and
 * processing (Polisher), handler-module instantiation, pagination (Chunker),
 * post-render balancing, image settling and a render audit, returning a
 * {@link FlowResult}.
 *
 * It is also an event hub: consumers subscribe with `on`/`once`/`off` to
 * `page`, `rendering`, `rendered`, `size` and `atpages`. The emitter methods
 * are mixed into the class prototype at module load time via the
 * `event-emitter` package's default export.
 */
import EventEmitter from "event-emitter";
import Hook from "../utils/hook.js";
import Chunker from "../chunker/chunker.js";
import Polisher from "../polisher/polisher.js";
import type { PolisherHooks } from "../polisher/polisher.js";
import {
	validateRenderedPages,
	collectRenderWarnings,
	rebalanceMulticolFinals,
	rebalanceManualColumnFinals,
} from "../chunker/layout.js";
import type {
	OverflowViolation,
	RenderWarning,
} from "../chunker/layout.js";
import type Page from "../chunker/page.js";
import { initializeHandlers, registerHandlers } from "../utils/handlers.js";
import type Handler from "../modules/handler.js";
import type { PagedEventEmitter } from "../types/emitter.js";
import type { PagedConfig } from "./polyfill.js";

/** A length with a unit, e.g. `{ value: 8.5, unit: "in" }`. */
export interface PageSize {
	value: number;
	unit: string;
}

/**
 * Resolved page size. `format` is a named paper format (e.g. `"A4"`) when the
 * size came from a named `@page size`, `orientation` is `"portrait"` or
 * `"landscape"` when applicable; both are `undefined` for default/custom
 * sizes.
 */
export interface Size {
	width: PageSize;
	height: PageSize;
	format?: string;
	orientation?: string;
}

/**
 * The value returned by {@link Previewer.preview}: the Chunker instance
 * itself, augmented in place with the rendered pages, the chunking-only
 * performance measurement, the effective page size and the render audit
 * results.
 */
export type FlowResult = Chunker & {
	pages: Page[];
	performance?: number;
	size?: Size;
	overflowViolations?: OverflowViolation[];
	warnings?: RenderWarning[];
};

/**
 * Comparator sorting a mixed list of `<style>` and `<link>` elements into
 * document order using `compareDocumentPosition`. `PRECEDING` on the result
 * means the second node precedes the first, so the first sorts after (return
 * 1); `FOLLOWING` sorts the first before (return -1); any other combination
 * returns 0, keeping the relative order (Array.prototype.sort is stable).
 */
function documentPositionComparator(
	a: Element,
	b: Element,
): number {
	const position = a.compareDocumentPosition(b);

	if (position & Node.DOCUMENT_POSITION_PRECEDING) {
		return 1;
	}

	if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
		return -1;
	}

	return 0;
}

/**
 * Maps one harvested stylesheet element to its stylesheet source: a `<style>`
 * element becomes an object keyed by the current page URL with the CSS text
 * as value, a `<link>` becomes its resolved `href`. The element is removed
 * from the DOM in the process. Unknown elements warn and yield `undefined`.
 */
function harvestStylesheet(
	element: Element,
): string | Record<string, string> | undefined {
	element.remove();

	if (element instanceof HTMLStyleElement) {
		return {
			[window.location.href]: element.textContent!,
		};
	}

	if (element instanceof HTMLLinkElement) {
		return element.href;
	}

	console.warn(`Unable to process: ${element}, ignoring.`);
	return undefined;
}

/**
 * The main class responsible for preparing, chunking, styling and rendering
 * content into paginated previews.
 *
 * Emits events: `page`, `rendering`, `rendered`, `size`, `atpages`.
 */
class Previewer {
	settings: Record<string, unknown>;
	polisher: Polisher;
	chunker: Chunker;
	hooks: {
		beforePreview: Hook<[unknown, unknown]>;
		afterPreview: Hook<[Page[]]>;
	};
	size: Size;
	atpages?: unknown[];
	handlers?: ReturnType<typeof initializeHandlers>;

	/**
	 * Creates a previewer. Constructing a previewer performs no DOM work and
	 * no awaited work: the polisher's setup is deferred until `preview()`.
	 * @param {Record<string, unknown>} [options] - Settings shared with the
	 *   chunker; stored by reference.
	 */
	constructor(options?: Record<string, unknown>) {
		this.settings = options || {};
		this.polisher = new Polisher(false);
		this.chunker = new Chunker(undefined, undefined, this.settings);
		this.hooks = {
			beforePreview: new Hook<[unknown, unknown]>(this),
			afterPreview: new Hook<[Page[]]>(this),
		};
		this.size = {
			width: {
				value: 8.5,
				unit: "in",
			},
			height: {
				value: 11,
				unit: "in",
			},
			format: undefined,
			orientation: undefined,
		};

		// Forward the chunker's per-page event; the payload passes through
		// unchanged.
		this.chunker.on("page", (page) => {
			this.emit("page", page);
		});

		// Forward the chunker's start-of-pagination event; the payload is the
		// previewer's chunker instance. The chunker's own "rendered" event is
		// deliberately not forwarded — the consumer-facing "rendered" event is
		// emitted by preview() after the audit.
		this.chunker.on("rendering", () => {
			this.emit("rendering", this.chunker);
		});
	}

	/**
	 * Creates a fresh Handlers instance, instantiating every currently
	 * registered handler class with `(chunker, polisher, previewer)`, and
	 * bridges the handlers' `size` and `atpages` events onto this previewer.
	 * @returns {ReturnType<typeof initializeHandlers>} The new Handlers instance.
	 */
	initializeHandlers(): ReturnType<typeof initializeHandlers> {
		const handlers = initializeHandlers(this.chunker, this.polisher, this);

		handlers.on("size", (size) => {
			this.size = size;
			this.emit("size", size);
		});

		handlers.on("atpages", (pages) => {
			this.atpages = pages;
			this.emit("atpages", pages);
		});

		return handlers;
	}

	/**
	 * Adds handler classes to the shared, module-global handler registry, so
	 * they are instantiated for every subsequent Handlers construction —
	 * including other previewer instances.
	 * @param {...typeof Handler} args - Handler classes to register.
	 */
	registerHandlers(...args: Array<typeof Handler>): void {
		registerHandlers.apply(registerHandlers, args);
	}

	/**
	 * Reads a query parameter from the current page URL. For a duplicated
	 * parameter the last occurrence wins; values are URL-decoded.
	 * @param {string} name - Parameter name to look up.
	 * @returns {string | undefined} The last matching value, or `undefined`
	 *   when the parameter does not appear.
	 */
	getParams(name: string): string | undefined {
		const params = new URLSearchParams(window.location.search);
		let value: string | undefined = undefined;

		for (const [key, paramValue] of params) {
			if (key === name) {
				value = paramValue;
			}
		}

		return value;
	}

	/**
	 * Moves the body's content into an inert `<template data-ref="paged-content">`
	 * and returns its fragment. Idempotent: once the template exists, its
	 * content is returned and the body is left untouched.
	 * @returns {DocumentFragment} The wrapped content fragment.
	 */
	wrapContent(): DocumentFragment {
		const body = document.querySelector("body")!;
		const existing = body.querySelector(
			":scope > template[data-ref='paged-content']",
		) as HTMLTemplateElement | null;

		if (existing) {
			return existing.content;
		}

		const template = document.createElement("template");
		template.dataset.ref = "paged-content";
		template.innerHTML = body.innerHTML;
		body.innerHTML = "";
		body.appendChild(template);

		return template.content;
	}

	/**
	 * Harvests the document's stylesheets (author `<style>` elements and
	 * stylesheet `<link>`s, excluding screen-media, `data-paged-ignore` and
	 * `data-paged-inserted-styles` ones), removing each element from the DOM.
	 * @param {Document} [doc] - Document to harvest from; defaults to the
	 *   current document.
	 * @returns {Array<string | Record<string, string> | undefined>} The
	 *   harvested stylesheet list in document order.
	 */
	removeStyles(doc: Document = document): Array<string | Record<string, string> | undefined> {
		const styleSheets = doc.querySelectorAll(
			"link[rel='stylesheet']:not([data-paged-ignore], [media~='screen'])",
		);
		const inlineStyles = doc.querySelectorAll(
			"style:not([data-paged-inserted-styles], [data-paged-ignore], [media~='screen'])",
		);

		const stylesheets: Element[] = [...styleSheets, ...inlineStyles];

		stylesheets.sort(documentPositionComparator);

		return stylesheets.map(harvestStylesheet);
	}

	/**
	 * Harvests stylesheets embedded in the content root (`<style>` elements
	 * and stylesheet `<link>`s living in the body/fragment), removing each
	 * element from the content. Needed for manual callers that pass fragments
	 * with embedded CSS — without it handlers never see those declarations.
	 * @param {DocumentFragment | HTMLElement | string | null} [content] -
	 *   Content root to harvest from; falsy values and strings yield `[]`.
	 * @returns {Array<string | Record<string, string> | undefined>} The
	 *   harvested stylesheet list in document order.
	 */
	removeContentStyles(
		content?: DocumentFragment | HTMLElement | string | null,
	): Array<string | Record<string, string> | undefined> {
		if (!content || typeof (content as HTMLElement).querySelectorAll !== "function") {
			return [];
		}

		const root = content as DocumentFragment | HTMLElement;

		const stylesheets: Element[] = [
			...root.querySelectorAll(
				"style:not([data-paged-inserted-styles], [data-paged-ignore], [media~='screen']), link[rel='stylesheet']:not([data-paged-ignore], [media~='screen'])",
			),
		];

		stylesheets.sort(documentPositionComparator);

		return stylesheets.map(harvestStylesheet);
	}

	/**
	 * Runs the full pipeline: CSS harvesting and processing, handler
	 * instantiation, pagination, post-render balancing, image settling and the
	 * render audit. The returned object is the chunker itself, mutated in
	 * place with `pages`, `performance`, `size`, `overflowViolations` and
	 * `warnings`.
	 * @param {HTMLElement | DocumentFragment | string} [content] - Content to
	 *   paginate; falsy content (including the empty string) wraps the body.
	 * @param {Array<string | Record<string, string> | undefined>} [stylesheets] -
	 *   Explicit stylesheet list; `undefined`/`null` harvests the document's
	 *   styles instead, an empty array suppresses harvesting.
	 * @param {HTMLElement | string} [renderTo] - Render target for the pages
	 *   area (honored on the first flow only).
	 * @returns {Promise<FlowResult>} The augmented chunker.
	 */
	async preview(
		content?: HTMLElement | DocumentFragment | string,
		stylesheets?: Array<string | Record<string, string> | undefined>,
		renderTo?: HTMLElement | string,
	): Promise<FlowResult> {
		await this.hooks.beforePreview.trigger(content, renderTo);

		let flowContent: HTMLElement | DocumentFragment | string;

		if (content) {
			flowContent = content;
		} else {
			flowContent = this.wrapContent();
		}

		let docStylesheets: Array<string | Record<string, string> | undefined> = [];

		if (stylesheets === undefined || stylesheets === null) {
			docStylesheets = this.removeStyles();
		}

		const contentStylesheets = this.removeContentStyles(flowContent);

		// Document styles first, then the caller-supplied list, then
		// content-embedded styles last (they originate latest in source order).
		const flowStylesheets = [
			...docStylesheets,
			...(stylesheets ?? []),
			...contentStylesheets,
		];

		// Base CSS must be in place before handlers are constructed.
		this.polisher.setup();

		this.handlers = this.initializeHandlers();

		// During this awaited phase the handlers run; `@page size` resolution
		// surfaces as the "size" event and collected `@page` rules as the
		// "atpages" event (both stored on the instance and re-emitted).
		await this.polisher.add(
			...(flowStylesheets as Array<string | Record<string, string>>),
		);

		const startTime = performance.now();

		const flow = await this.chunker.flow(
			flowContent,
			renderTo as HTMLElement,
		) as FlowResult;

		const endTime = performance.now();

		// Release the forced height/fill constraints on final multicol
		// fragments and on root-level manual-column rows that end early, so
		// their columns balance like `column-fill: balance` on the last page.
		rebalanceMulticolFinals(this.chunker.pagesArea);
		rebalanceManualColumnFinals(this.chunker.pagesArea);

		// Image settling: wait for every image in the rendered pages to load
		// or fail, then give the browser one layout pass before auditing —
		// a late-loading image changes column heights, and auditing against
		// in-flight geometry would report spills that no longer exist (or miss
		// live ones).
		const images = (this.chunker.pagesArea || document).querySelectorAll("img");

		await Promise.all(
			Array.from(images).map((image) => {
				return new Promise((resolve) => {
					if (image.complete) {
						resolve(null);
						return;
					}

					image.addEventListener("load", () => resolve(null), { once: true });
					image.addEventListener("error", () => resolve(null), { once: true });
				});
			}),
		);

		await new Promise((resolve) => {
			requestAnimationFrame(resolve);
		});

		flow.performance = endTime - startTime;
		flow.size = this.size;

		flow.overflowViolations = validateRenderedPages(this.chunker.pagesArea);

		if (flow.overflowViolations.length) {
			console.warn(
				`paged-with-floats: ${flow.overflowViolations.length} page(s) contain content outside its designated space`,
				flow.overflowViolations.slice(0, 5),
			);
		}

		flow.warnings = collectRenderWarnings(this.chunker.pagesArea);

		if (flow.warnings.length) {
			console.warn(
				`paged-with-floats: ${flow.warnings.length} rendering warning(s) (available on flow.warnings)`,
			);
		}

		this.emit("rendered", flow);

		await this.hooks.afterPreview.trigger(flow.pages);

		return flow;
	}
}

interface Previewer extends PagedEventEmitter {}

// Mix the event-emitter methods (on, once, off, emit) into the prototype so
// every previewer instance is an event hub.
EventEmitter(Previewer.prototype);

export default Previewer;

// Re-exported for consumers of this module's types.
export type { PolisherHooks };
export type { PagedConfig };