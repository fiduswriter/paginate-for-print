import Layout from "./layout.js";
import EventEmitter from "event-emitter";
import BreakToken from "./breaktoken.js";
import type RenderResult from "./renderresult.js";
import type { ChunkerHooks } from "./chunker.js";
import type { PagedEventEmitter } from "../types/emitter.js";

/**
 * Root-level manual column configuration, as provided through the chunker's
 * per-page settings snapshot (`Chunker.pageSettings()` → `rootColumns`).
 */
type RootColumnsConfig = {
	count: number;
	gap?: string;
	fill?: "auto" | "balance";
	ruleColor?: string;
	ruleStyle?: string;
	ruleWidth?: string;
};

/**
 * Decides whether a page builds the manual-column fragmentainer structure:
 * active exactly when the settings snapshot carries a truthy `rootColumns`
 * entry with a count greater than 1. The count is not floored here; only the
 * column builder floors it.
 *
 * @param {Record<string, unknown>} settings - The page settings snapshot.
 * @returns {boolean} True when manual columns are active.
 */
function isManualColumns(settings: Record<string, unknown>): boolean {
	const rootColumns = settings.rootColumns as RootColumnsConfig | undefined;
	return Boolean(rootColumns && rootColumns.count > 1);
}

/**
 * Debug flag bag consulted for zero-progress stall reports. Set externally
 * (`globalThis.__PAGED_DEBUG = { stops: true }`) to emit diagnostics when a
 * layout pass makes no progress.
 */
type PagedDebug = { stops?: unknown };

/**
 * Placeholder for one Page instance; it owns the page DOM, the layout pass,
 * and the resize-driven overflow checks (see page.spec.md).
 */
class Page {
	pagesArea: HTMLElement;
	pageTemplate: HTMLTemplateElement;
	blank: boolean | undefined;
	width?: number;
	height?: number;
	hooks: ChunkerHooks;
	settings: Record<string, unknown>;
	element?: HTMLDivElement;
	pagebox?: HTMLElement | null;
	area?: HTMLElement;
	wrapper?: HTMLDivElement;
	footnotesArea?: HTMLElement | null;
	floatTopArea?: Element | null;
	floatBottomArea?: Element | null;
	startToken?: BreakToken;
	endToken?: BreakToken;
	zeroProgress?: boolean;
	layoutMethod?: Layout;
	position?: number;
	id?: string;
	name?: string;
	listening?: boolean;
	ro?: ResizeObserver;
	_onOverflow?: (token: BreakToken) => void;
	_onUnderflow?: (token: BreakToken) => void;
	_checkOverflowAfterResize?: () => void;
	_onScroll?: () => void;

	constructor(
		pagesArea: HTMLElement,
		pageTemplate: HTMLTemplateElement,
		blank: boolean | undefined,
		hooks: ChunkerHooks,
		options?: Record<string, unknown>,
	) {
		this.pagesArea = pagesArea;
		this.pageTemplate = pageTemplate;
		this.blank = blank;
		this.hooks = hooks;
		this.settings = options || {};
	}

	/**
	 * Stamps a fresh page element from the stored template into the pages
	 * area, captures all element references and builds the flow wrapper.
	 *
	 * @param {HTMLTemplateElement} template - Ignored; the clone always comes
	 *   from the stored template (the parameter exists for signature parity).
	 * @param {HTMLElement} [after] - Insert the page directly after this
	 *   element instead of appending. Must be a child of the pages area.
	 * @returns {HTMLDivElement} The freshly stamped page element.
	 */
	create(template?: HTMLTemplateElement, after?: HTMLElement): HTMLDivElement {
		const clone = document.importNode(this.pageTemplate.content, true);
		let page: HTMLDivElement;
		if (after) {
			this.pagesArea.insertBefore(clone, after.nextElementSibling);
			const index = Array.prototype.indexOf.call(
				this.pagesArea.children,
				after.nextElementSibling,
			);
			page = this.pagesArea.children[index] as HTMLDivElement;
		} else {
			this.pagesArea.appendChild(clone);
			page = this.pagesArea.lastChild as HTMLDivElement;
		}
		this.pagebox = page.querySelector(".paged_pagebox") as HTMLElement | null;
		this.area = page.querySelector(".paged_page_content") as HTMLElement;
		this.footnotesArea = page.querySelector(".paged_footnote_area");
		this.floatTopArea = page.querySelector(".paged_float_top");
		this.floatBottomArea = page.querySelector(".paged_float_bottom");

		const size = this.area.getBoundingClientRect();
		this.width = Math.round(size.width);
		this.height = Math.round(size.height);

		if (!isManualColumns(this.settings)) {
			this.area.style.columnWidth = Math.round(size.width) + "px";
			this.area.style.columnGap =
				"calc(var(--paged-margin-right) + var(--paged-margin-left) + var(--paged-bleed-right) + var(--paged-bleed-left) + var(--paged-column-gap-offset))";
		}

		this.element = page;
		this.createWrapper();
		return page;
	}

	/**
	 * Builds (or rebuilds) the flow wrapper inside the content area.
	 *
	 * In manual-columns mode the flow host becomes a column scaffold: the
	 * float containers are moved inside it and a `.paged_columns` row is
	 * appended between them. In single-column mode the wrapper is inserted
	 * between the template's top and bottom float containers, which stay
	 * direct children of the content area.
	 *
	 * @returns {HTMLDivElement} The freshly created wrapper.
	 */
	createWrapper(): HTMLDivElement {
		const wrapper = document.createElement("div");
		wrapper.classList.add("paged_flow");

		if (isManualColumns(this.settings)) {
			if (this.floatTopArea) {
				wrapper.appendChild(this.floatTopArea);
			} else {
				const floatTop = document.createElement("div");
				floatTop.classList.add("paged_float_top");
				wrapper.appendChild(floatTop);
				this.floatTopArea = floatTop;
			}
			this.buildManualColumns(
				wrapper,
				this.settings.rootColumns as RootColumnsConfig,
			);
			if (this.floatBottomArea) {
				wrapper.appendChild(this.floatBottomArea);
			} else {
				const floatBottom = document.createElement("div");
				floatBottom.classList.add("paged_float_bottom");
				wrapper.appendChild(floatBottom);
				this.floatBottomArea = floatBottom;
			}
			this.area!.appendChild(wrapper);
		} else {
			this.area!.insertBefore(
				wrapper,
				(this.floatBottomArea ?? null) as Element | null,
			);
		}

		this.wrapper = wrapper;
		return wrapper;
	}

	/**
	 * Populates a flow host with one explicit column row: a `.paged_columns`
	 * flex row holding `count` `.paged_column` boxes sized by `calc()` widths.
	 * Pure append — callers remove stale rows before calling.
	 *
	 * @param {HTMLDivElement} wrapper - The flow host to append the row to.
	 * @param {RootColumnsConfig} rootColumns - The manual column config.
	 */
	private buildManualColumns(
		wrapper: HTMLDivElement,
		rootColumns: {
			count: number;
			gap?: string;
			fill?: "auto" | "balance";
			ruleColor?: string;
			ruleStyle?: string;
			ruleWidth?: string;
		},
	): void {
		const count = Math.floor(rootColumns.count);
		const gap =
			rootColumns.gap !== undefined && rootColumns.gap !== "normal"
				? rootColumns.gap
				: "1em";
		const fill = rootColumns.fill || "balance";

		wrapper.dataset.rootColumns = String(count);
		wrapper.dataset.rootColumnFill = fill;

		const row = document.createElement("div");
		row.classList.add("paged_columns");
		row.style.gap = gap;
		row.dataset.pagedColumnFill = fill;

		for (let i = 0; i < count; i++) {
			const column = document.createElement("div");
			column.classList.add("paged_column");
			column.dataset.pagedColumn = String(i);
			column.style.width = `calc((100% - ${count - 1} * ${gap}) / ${count})`;
			if (i > 0 && rootColumns.ruleWidth) {
				let borderLeft = `${rootColumns.ruleWidth} ${rootColumns.ruleStyle || "solid"}`;
				if (rootColumns.ruleColor) {
					borderLeft += ` ${rootColumns.ruleColor}`;
				}
				column.style.borderLeft = borderLeft;
			}
			row.appendChild(column);
		}

		wrapper.appendChild(row);
	}

	/**
	 * Numbers and classifies the page element: `page-N` id, page number data
	 * attribute, first/blank/named page classes and the left/right parity
	 * quartet.
	 *
	 * @param {number} pgnum - Zero-based page number.
	 */
	index(pgnum: number): void {
		this.position = pgnum;
		const index = pgnum + 1;
		this.id = `page-${index}`;
		this.element!.dataset.pageNumber = String(index);
		this.element!.id = this.id;

		if (this.name) {
			this.element!.classList.add(`paged_${this.name}_page`);
		}

		if (this.blank) {
			this.element!.classList.add("paged_blank_page");
		}

		if (pgnum === 0) {
			this.element!.classList.add("paged_first_page");
		}

		if (pgnum % 2 !== 1) {
			this.element!.classList.remove("paged_left_page", "paged_verso_page");
			this.element!.classList.add("paged_right_page", "paged_recto_page");
		} else {
			this.element!.classList.remove("paged_right_page", "paged_recto_page");
			this.element!.classList.add("paged_left_page", "paged_verso_page");
		}
	}

	/**
	 * Marks or unmarks the page as currently being laid out. While active the
	 * page carries a `data-paged-active` attribute and an inline
	 * `content-visibility: visible` override, and the cached size is
	 * invalidated so geometry reads happen against the live layout.
	 *
	 * @param {boolean} active - Whether a layout pass is running.
	 */
	setLayoutActive(active: boolean): void {
		if (!this.element) {
			return;
		}
		if (active) {
			this.element.setAttribute("data-paged-active", "true");
			this.element.style.setProperty("content-visibility", "visible");
			this.invalidateActiveSize();
		} else {
			this.element.removeAttribute("data-paged-active");
			this.element.style.removeProperty("content-visibility");
		}
	}

	/**
	 * Marks the cached page measurements stale so the next geometry read
	 * happens against the live layout.
	 */
	private invalidateActiveSize(): void {
		this.width = undefined;
		this.height = undefined;
	}

	/**
	 * Runs one full layout pass: clears the page, marks it active, renders
	 * the source fragment into the flow wrapper and records the resulting
	 * break token bookkeeping.
	 *
	 * @param {DocumentFragment} contents - The source fragment to render.
	 * @param {BreakToken} [breakToken] - The incoming token of this pass.
	 * @param {Page} [prevPage] - Declared as a Page but actually receives the
	 *   previous page's wrapper element; forwarded to `renderTo` untouched.
	 * @returns {Promise<BreakToken | undefined>} The outgoing token, or
	 *   `undefined` on a zero-progress stall.
	 */
	async layout(
		contents: DocumentFragment,
		breakToken: BreakToken | undefined,
		prevPage?: Page,
	): Promise<BreakToken | undefined> {
		this.clear();
		this.setLayoutActive(true);
		// Always a real token: the literal `false` the chunker leaks for the
		// first page must not become the page's startToken — handlers read
		// `startToken.overflow` and treat a falsy token as "start of flow"
		// against whatever `content` object they hold.
		this.startToken =
			breakToken || new BreakToken((contents as DocumentFragment)?.firstChild as Node);
		this.layoutMethod = new Layout(this.area!, this.hooks, this.settings);

		const renderResult: RenderResult = await this.layoutMethod.renderTo(
			this.wrapper!,
			contents,
			breakToken,
			prevPage as unknown as HTMLElement,
		);
		const newBreakToken = renderResult.breakToken as BreakToken | undefined;

		this.setLayoutActive(false);

		// Zero-progress stall: the page absorbed nothing, so pagination would
		// loop forever. Report and bail without finishing the page.
		if (breakToken && newBreakToken && breakToken.equals(newBreakToken)) {
			this.zeroProgress = true;
			const debug = (globalThis as { __PAGED_DEBUG?: PagedDebug })
				.__PAGED_DEBUG;
			if (debug && debug.stops) {
				console.warn(
					"[paginate-for-print] zero-progress page; token:",
					JSON.stringify({
						nodeText: breakToken.node.textContent?.slice(0, 60),
						offset: breakToken.overflow[0]?.offset,
						overflowNodeText: (
							breakToken.overflow[0]?.node as Text | undefined
						)?.textContent?.slice(0, 60),
					}),
				);
			}
			return undefined;
		}

		// Finished blank page: exists only as a place for pagination to stop.
		if (
			!newBreakToken &&
			breakToken &&
			breakToken.isFinished() &&
			this.isBlank()
		) {
			this.zeroProgress = true;
		}

		this.addListeners(contents);
		this.endToken = newBreakToken;
		return newBreakToken;
	}

	/**
	 * Reports whether the flow wrapper holds no displayable content. Only the
	 * wrapper's direct children are scanned; float scaffolding, float spacers
	 * and elements carrying a truthy `data-undisplayed` value don't count as
	 * content. Any element child (including non-HTML elements such as SVG)
	 * counts as content; text and comment nodes never do.
	 *
	 * @returns {boolean} True when the page holds no displayable content.
	 */
	isBlank(): boolean {
		if (!this.wrapper) {
			return true;
		}
		for (const child of Array.from(this.wrapper.children)) {
			const isContent =
				child instanceof Element &&
				!child.dataset.undisplayed &&
				!child.classList.contains("paged_float_top") &&
				!child.classList.contains("paged_float_bottom") &&
				!child.classList.contains("paged_float_spacer");
			if (isContent) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Continues filling the already-laid-out page. Delegates to a full layout
	 * pass when no layout engine instance exists yet.
	 *
	 * @param {DocumentFragment} contents - The source fragment to render.
	 * @param {BreakToken} [breakToken] - The incoming token of this pass.
	 * @returns {Promise<BreakToken | undefined>} The outgoing token.
	 */
	async append(
		contents: DocumentFragment,
		breakToken: BreakToken | undefined,
	): Promise<BreakToken | undefined> {
		if (!this.layoutMethod) {
			return this.layout(contents, breakToken);
		}

		this.setLayoutActive(true);
		const renderResult = await this.layoutMethod.renderTo(
			this.wrapper!,
			contents,
			breakToken,
		);
		const newBreakToken = renderResult.breakToken as BreakToken | undefined;
		this.setLayoutActive(false);
		this.endToken = newBreakToken;
		return newBreakToken;
	}

	/**
	 * Finds the first entry whose `data-ref` attribute matches.
	 *
	 * @param {string} ref - The ref to look for.
	 * @param {HTMLElement[]} entries - The entries to scan in order.
	 * @returns {HTMLElement | undefined} The first matching entry.
	 */
	getByParent(ref: string, entries: HTMLElement[]): HTMLElement | undefined {
		for (const entry of entries) {
			if (entry.dataset.ref === ref) {
				return entry;
			}
		}
		return undefined;
	}

	/**
	 * Registers the callback invoked when a resize-related overflow is
	 * detected on this page.
	 *
	 * @param {(token: BreakToken) => void} func - The overflow callback.
	 */
	onOverflow(func: (token: BreakToken) => void): void {
		this._onOverflow = func;
	}

	/**
	 * Registers the callback invoked when a resize-related underflow is
	 * detected on this page.
	 *
	 * @param {(token: BreakToken) => void} func - The underflow callback.
	 */
	onUnderflow(func: (token: BreakToken) => void): void {
		this._onUnderflow = func;
	}

	/**
	 * Resets the page for a fresh layout pass. Removes listeners first, then
	 * rebuilds the fragmentainer: single-column pages get a fresh empty
	 * wrapper, manual-column pages keep their float containers (placed floats
	 * survive the pass) and get one fresh column row.
	 */
	clear(): void {
		this.removeListeners();

		if (isManualColumns(this.settings)) {
			if (!this.wrapper) {
				this.createWrapper();
			} else {
				for (const child of Array.from(this.wrapper.children)) {
					const isFloatContainer =
						child instanceof HTMLElement &&
						(child.classList.contains("paged_float_top") ||
							child.classList.contains("paged_float_bottom"));
					if (!isFloatContainer) {
						child.remove();
					}
				}
				this.buildManualColumns(
					this.wrapper,
					this.settings.rootColumns as RootColumnsConfig,
				);
			}
		} else {
			if (this.wrapper) {
				this.wrapper.remove();
			}
			this.createWrapper();
		}
	}

	/**
	 * Installs resize/scroll monitoring on the page element. Uses a
	 * ResizeObserver when available; otherwise falls back to the DOM's
	 * `overflow`/`underflow` events.
	 *
	 * @param {DocumentFragment} contents - The source fragment, captured for
	 *   the resize checks.
	 * @returns {boolean} Always true.
	 */
	addListeners(contents: DocumentFragment): boolean {
		if (typeof ResizeObserver !== "undefined") {
			this.addResizeObserver(contents);
		} else {
			this._checkOverflowAfterResize = this.checkOverflowAfterResize.bind(
				this,
				contents,
			);
			this.element!.addEventListener(
				"overflow",
				this._checkOverflowAfterResize,
				false,
			);
			this.element!.addEventListener(
				"underflow",
				this._checkOverflowAfterResize,
				false,
			);
		}

		this._onScroll = () => {
			if (this.listening) {
				this.element!.scrollLeft = 0;
			}
		};
		this.element!.addEventListener("scroll", this._onScroll, false);
		this.listening = true;
		return true;
	}

	/**
	 * Tears the resize/scroll monitoring down; safe to call repeatedly and
	 * before any listener was added.
	 */
	removeListeners(): void {
		this.listening = false;
		if (typeof ResizeObserver !== "undefined" && this.ro) {
			this.ro.disconnect();
		} else if (this.element) {
			// Removing a handler that was never registered is a silent no-op.
			this.element.removeEventListener(
				"overflow",
				this._checkOverflowAfterResize as EventListener,
				false,
			);
			this.element.removeEventListener(
				"underflow",
				this._checkOverflowAfterResize as EventListener,
				false,
			);
		}
		if (this.element) {
			this.element.removeEventListener(
				"scroll",
				this._onScroll as EventListener,
				false,
			);
		}
	}

	/**
	 * Observes the flow wrapper for resizes and defers overflow/underflow
	 * checks into a requestAnimationFrame. Growth runs the overflow check and
	 * re-reads the wrapper's live height; shrink runs the underflow check and
	 * adopts the entry's height.
	 *
	 * @param {DocumentFragment} contents - The source fragment, captured for
	 *   the resize checks.
	 */
	addResizeObserver(contents: DocumentFragment): void {
		let prevHeight = this.wrapper!.getBoundingClientRect().height;
		const callback = (entries: ResizeObserverEntry[]) => {
			if (!this.listening) {
				return;
			}
			requestAnimationFrame(() => {
				for (const entry of entries) {
					const rect = entry.contentRect;
					if (rect.height > prevHeight) {
						this.checkOverflowAfterResize(contents);
						prevHeight = this.wrapper!.getBoundingClientRect().height;
					} else if (rect.height < prevHeight) {
						this.checkUnderflowAfterResize(contents);
						prevHeight = rect.height;
					}
				}
			});
		};
		this.ro = new ResizeObserver(callback);
		this.ro.observe(this.wrapper!);
	}

	/**
	 * Re-checks for overflow after a resize; called on growth. Passes
	 * `undefined` bounds so the layout instance's own default applies.
	 *
	 * @param {DocumentFragment} contents - The source fragment to resume from.
	 */
	checkOverflowAfterResize(contents: DocumentFragment): void {
		if (!this.listening || !this.layoutMethod) {
			return;
		}
		const token = this.layoutMethod.findBreakToken(
			this.wrapper!,
			contents,
			undefined,
			this.startToken,
		);
		if (token) {
			this.endToken = token;
			if (this._onOverflow) {
				this._onOverflow(token);
			}
		}
	}

	/**
	 * Re-checks for underflow after a resize; called on shrink. Does not
	 * update the stored end token.
	 *
	 * @param {DocumentFragment} contents - The source fragment to resume from.
	 */
	checkUnderflowAfterResize(contents: DocumentFragment): void {
		if (!this.listening || !this.layoutMethod) {
			return;
		}
		const token = this.layoutMethod.findEndToken(this.wrapper!, contents);
		if (token && this._onUnderflow) {
			this._onUnderflow(token);
		}
	}

	/**
	 * Removes the page from the DOM and tears its monitoring down. Layout
	 * state (engine instance, area, tokens, measurements) is kept.
	 */
	destroy(): void {
		this.removeListeners();
		this.setLayoutActive(false);
		this.element!.remove();
		this.element = undefined;
		this.wrapper = undefined;
	}
}

// Mix the event-emitter surface (on/once/off/emit) into the prototype.
EventEmitter(Page.prototype);

interface Page extends PagedEventEmitter {}

export default Page;
