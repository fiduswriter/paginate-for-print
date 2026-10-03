import Handler from "../handler.js";
import type { HandlerSource } from "../handler.js";
import type { Hook } from "../../utils/hook.js";
import type BreakToken from "../../chunker/breaktoken.js";
import csstree from "css-tree";
import type { CssNode, List } from "css-tree";

interface FloatsPage {
	element: HTMLElement;
	createWrapper: () => HTMLDivElement;
}

interface FloatsChunker {
	stopped?: boolean;
	addPage(): FloatsPage;
	hooks: {
		beforePageLayout: Hook<any[]>;
		afterPageLayout: Hook<any[]>;
		finalizePage: Hook<any[]>;
	};
	emit(type: string, ...args: any[]): void;
}

interface DeferredFloat {
	element: HTMLElement;
	side: string;
	anchorRef?: string;
}

interface PlacedFloat {
	element: HTMLElement;
	side: string;
	outerHeight: number;
	anchorRef?: string;
}

/**
 * Mapping of supported `float` values to the edge of the page
 * the float is placed at.
 *
 * @type {Object.<string, string>}
 */
const FLOAT_SIDES = {
	top: "top",
	"block-start": "top",
	bottom: "bottom",
	"block-end": "bottom",
};

/**
 * How many times a float may be deferred before it is force-placed,
 * guarding against infinite deferral loops.
 *
 * @type {number}
 */
const MAX_DEFERRALS = 2;

/** Tolerance in px when classifying a rect as inside the spill column. */
const COLUMN_SPILL_EPSILON = 1;

/**
 * Handles CSS page floats (`float-reference: page` combined with
 * `float: top | bottom | block-start | block-end`).
 *
 * Following https://drafts.csswg.org/css-page-floats/ within the limits
 * of paged.js's measure-and-split layout engine:
 *
 * - Floats are stacked blocks; text does not wrap around them.
 * - Top floats stack above the flow content, bottom floats pin to the
 *   bottom of the page content area.
 * - A float that does not fit on the current page defers alone to the
 *   next page; following content keeps filling the current page.
 * - If the float's anchor is moved forward by fragmentation (e.g.
 *   break-inside avoid), the float moves with it.
 * - Bare `float: top | bottom` without `float-reference` also activates
 *   page floats; `left | right` with `float-reference: page` degrade to
 *   top placement.
 *
 * @class
 */
class PageFloats extends Handler {
	pageFloats: Record<string, string>;
	floatReferences: Record<string, boolean>;
	deferred: DeferredFloat[];
	deferredCounts: Record<string, number>;
	placed: Map<string, PlacedFloat>;
	pendingSpacers: Set<HTMLElement>;

	/**
	 * Creates an instance of PageFloats.
	 * @param {object} chunker - The chunker instance handling content chunks.
	 * @param {object} polisher - The polisher instance handling polishing/layout.
	 * @param {object} caller - The caller instance managing handler orchestration.
	 */
	constructor(chunker?: HandlerSource, polisher?: HandlerSource, caller?: HandlerSource) {
		super(chunker, polisher, caller);

		/**
		 * Selectors of elements declared as page floats.
		 * @type {Object.<string, string>} selector -> "top" | "bottom"
		 */
		this.pageFloats = {};

		/**
		 * Selectors declared with `float-reference: page`.
		 * @type {Object.<string, boolean>}
		 */
		this.floatReferences = {};

		/**
		 * Floats awaiting placement on the next page.
		 * @type {Array.<{element: Element, side: string}>}
		 */
		this.deferred = [];

		/**
		 * Deferral counters per float data-ref.
		 * @type {Object.<string, number>}
		 */
		this.deferredCounts = {};

		/**
		 * Data-refs of floats that are currently deferred. A float that is
		 * deferred should not be placed again from a newly rendered clone; the
		 * queued deferred element is the one that will be positioned.
		 * @type {Set<string>}
		 */
		this.deferredRefs = new Set();

		/**
		 * Currently placed floats by data-ref, used to follow anchors
		 * across fragmentation.
		 * @type {Map<string, {element: Element, side: string, outerHeight: number}>}
		 */
		this.placed = new Map();

		/**
		 * Content areas whose spacer could not be synced yet because
		 * their flow wrapper did not exist at placement time.
		 * @type {Set<Element>}
		 */
		this.pendingSpacers = new Set();
	}

	/**
	 * Intercepts `float-reference` and `float` declarations, records page
	 * float selectors and removes the declarations from the stylesheet.
	 *
	 * @param {object} declaration - The CSS declaration node.
	 * @param {object} dItem - Declaration item in the list.
	 * @param {object} dList - Declaration list.
	 * @param {object} rule - The CSS rule node.
	 * @returns {void}
	 */
	onDeclaration(declaration: CssNode, dItem: List.Cursor, dList: List, rule: { ruleNode: CssNode } | null | undefined) {
		if (!rule || !rule.ruleNode || rule.ruleNode.type !== "Rule") {
			return;
		}

		let property = declaration.property;

		if (property === "float-reference") {
			let identifier =
				declaration.value.children && declaration.value.children.first();
			let reference = identifier && identifier.name;
			let selector = csstree.generate(rule.ruleNode.prelude);

			selector.split(",").forEach((s) => {
				s = s.trim();
				if (reference === "page") {
					this.floatReferences[s] = true;
				} else {
					delete this.floatReferences[s];
				}
			});

			dList.remove(dItem);
			return;
		}

		if (property !== "float") {
			return;
		}

		let identifier =
			declaration.value.children && declaration.value.children.first();
		let value = identifier && identifier.name;
		let selectors = csstree
			.generate(rule.ruleNode.prelude)
			.split(",")
			.map((s) => s.trim());
		let side = value && (FLOAT_SIDES as Record<string, string>)[value];

		if (side) {
			selectors.forEach((selector) => {
				this.pageFloats[selector] = side;
			});
			dList.remove(dItem);
			return;
		}

		if (value === "left" || value === "right") {
			if (selectors.every((selector) => this.floatReferences[selector])) {
				console.warn(
					"paged-with-floats: float:",
					value,
					"with float-reference: page is placed as a top page float",
				);
				selectors.forEach((selector) => {
					this.pageFloats[selector] = "top";
				});
				dList.remove(dItem);
			} else if (
				selectors.some((selector) => this.floatReferences[selector])
			) {
				console.warn(
					"paged-with-floats: ignoring unsupported combination of float:",
					value,
					"and float-reference: page",
				);
			}
		}
	}

	/**
	 * Tags matching elements with page float attributes and assigns
	 * document-order indices for stable stacking.
	 *
	 * @param {Document|Element} parsed - The parsed source content.
	 * @returns {void}
	 */
	afterParsed(parsed: Document | Element) {
		for (let selector in this.pageFloats) {
			let elements: NodeListOf<Element>;
			try {
				elements = parsed.querySelectorAll(selector);
			} catch {
				console.warn("paged-with-floats: invalid page float selector:", selector);
				continue;
			}
			Array.from(elements).forEach((element) => {
				element.setAttribute("data-page-float", this.pageFloats[selector]);
			});
		}

		Array.from(parsed.querySelectorAll("[data-page-float]")).forEach(
			(element, index) => {
				element.setAttribute("data-page-float-order", index as unknown as string);
			},
		);
	}

	/**
	 * Relocates rendered page float clones into the page's float
	 * containers. Also catches floats nested inside deep-cloned
	 * ancestors, which never get their own renderNode call.
	 *
	 * @param {Element} clone - The cloned node appended to the page.
	 * @returns {void}
	 */
	renderNode(clone: Node) {
		if (!(clone as HTMLElement).dataset) {
			return;
		}

		let targets: HTMLElement[] = [];
		if ((clone as HTMLElement).dataset.pageFloat && !(clone as HTMLElement).dataset.pageFloatPlaced) {
			targets.push(clone as HTMLElement);
		}
		if ((clone as HTMLElement).querySelectorAll) {
			((clone as HTMLElement).querySelectorAll("[data-page-float]") as NodeListOf<HTMLElement>).forEach((element) => {
				if (!element.dataset.pageFloatPlaced) {
					targets.push(element);
				}
			});
		}

		if (!targets.length) {
			return;
		}

		let pageElement = (clone as HTMLElement).closest(".paged_page");
		if (!pageElement) {
			return;
		}

		targets.sort(
			(a, b) =>
				parseInt(a.dataset.pageFloatOrder!) - parseInt(b.dataset.pageFloatOrder!),
		);

		targets.forEach((element) => {
			let ref = element.dataset.ref;
			if (ref && this.deferredRefs.has(ref)) {
				// This clone belongs to a float that is already queued for
				// deferred placement; the deferred element will be moved to
				// the correct page, so discard the new clone to avoid duplicates.
				element.remove();
				return;
			}
			element.dataset.pageFloatPlaced = "true";
			this.placeFloat(
				element,
				element.dataset.pageFloat!,
				pageElement as HTMLElement,
				!!element.dataset.forcePageFloat,
			);
		});
	}

	/**
	 * Places any floats deferred from previous pages onto the freshly
	 * started page, before its content is laid out.
	 *
	 * @param {object} page - The Page instance about to be laid out.
	 * @returns {void}
	 */
	beforePageLayout(page: FloatsPage) {
		if (!page.element) {
			return;
		}

		while (this.deferred.length) {
			let item = this.deferred.shift()!;
			item.element.dataset.pageFloatDeferred = "true";
			this.placeFloat(item.element, item.side, page.element, true, item.anchorRef);
		}

		let content = page.element.querySelector(".paged_page_content");
		if (content && !this.flowWrapper(content as HTMLElement)) {
			this.syncSpacer(content as HTMLElement);
		}
	}

	/**
	 * Syncs spacers for pages whose wrapper was created after their
	 * deferred floats were placed.
	 *
	 * @param {Element} wrapper - The page's flow content wrapper.
	 * @returns {void}
	 */
	layout(wrapper: HTMLElement) {
		let content = wrapper.parentElement;
		if (content && this.pendingSpacers.delete(content)) {
			this.syncSpacer(content);
		}
	}

	/**
	 * When the source content has finished but floats are still queued
	 * for the next page, the chunker would stop rendering. Appends one
	 * more page and runs its layout pipeline so deferred floats land.
	 *
	 * @param {object} chunker - The chunker instance.
	 * @returns {void}
	 */
	continueForDeferred(chunker: FloatsChunker) {
		if (chunker.stopped || !this.deferred.length) {
			return;
		}

		let page = chunker.addPage();

		// This page never goes through a normal layout pass, so its flow
		// host (including the float containers, which are built by
		// createWrapper rather than the template) must be created here for
		// the deferred floats to land in.
		page.createWrapper();

		chunker.hooks.beforePageLayout.trigger(
			page,
			undefined,
			undefined,
			chunker,
		);
		chunker.emit("page", page);
		chunker.hooks.afterPageLayout.trigger(
			page.element,
			page,
			undefined,
			chunker,
		);
		chunker.hooks.finalizePage.trigger(
			page.element,
			page,
			undefined,
			chunker,
		);
		chunker.emit("renderedPage", page);
	}

	/**
	 * Runs after a page is finished. If no further content follows but
	 * floats are still deferred, keeps the renderer going for them.
	 *
	 * @param {Element} pageElement - The page's root element in the DOM.
	 * @param {object} page - The Page instance.
	 * @param {object} breakToken - Token for the next content, if any.
	 * @param {object} chunker - The chunker instance.
	 * @returns {void}
	 */
	afterPageLayout(pageElement: HTMLElement, page: FloatsPage, breakToken: BreakToken | null, chunker: FloatsChunker) {
		// Floats that survived the page's overflow handling have landed;
		// stop suppressing freshly rendered clones for them.
		for (let [ref, entry] of Array.from(this.placed)) {
			if (entry.element.isConnected) {
				this.deferredRefs.delete(ref);
			}
		}

		if (!breakToken && this.deferred.length) {
			this.continueForDeferred(chunker);
		}
	}

	/**
	 * Follows anchors across fragmentation: when a placed float's anchor
	 * is removed with the overflow, the float defers to the next page.
	 * Also removes float spacers swept along with extracted overflow;
	 * they belong to this page's flow only.
	 *
	 * @param {Element} removed - Fragment of overflow content removed.
	 * @param {Element} rendered - Current page content.
	 * @returns {void}
	 */
	afterOverflowRemoved(removed: HTMLElement | null, rendered: HTMLElement) {
		if (!removed) {
			return;
		}

		removed.querySelectorAll(".paged_float_spacer").forEach((spacer) => {
			spacer.remove();
		});

		if (!this.placed.size) {
			return;
		}

		let content = rendered.closest(".paged_page_content");
		if (content) {
			this.syncSpacer(content as HTMLElement);
		}

		for (let [ref, entry] of Array.from(this.placed)) {
			if (!entry.element.isConnected) {
				this.placed.delete(ref);
				continue;
			}
			let rolledBack = entry.anchorRef
				? !!removed.querySelector(`[data-ref='${entry.anchorRef}']`)
				: false;
			if (rolledBack) {
				entry.element.remove();
				this.placed.delete(ref);
				let content = entry.element.closest(".paged_page_content");
				if (content) {
					this.syncSpacer(content as HTMLElement);
				}
				this.deferFloat(entry.element, entry.side, entry.anchorRef);
			}
		}
	}

	/**
	 * Moves a float into its edge container, checking whether it fits in
	 * the remaining space of the page. Non-fitting floats defer to the
	 * next page; oversized floats are placed anyway to avoid loops.
	 *
	 * Both edges share one fit condition: after placement, the flow
	 * content plus the float's height must stay above the bottom of the
	 * content area reduced by the reserved bottom height.
	 *
	 * @param {Element} element - The rendered float element.
	 * @param {string} side - "top" or "bottom".
	 * @param {Element} pageElement - The .paged_page element.
	 * @param {boolean} skipFitCheck - Place without checking for space.
	 * @param {string} anchorRef - Known anchor ref, from a deferral.
	 * @returns {void}
	 */
	placeFloat(element: HTMLElement, side: string, pageElement: HTMLElement, skipFitCheck = false, anchorRef?: string) {
		let content = pageElement.querySelector(".paged_page_content") as HTMLElement;
		let container = content.querySelector(`.paged_float_${side}`) as HTMLElement | null;
		if (!content || !container) {
			return;
		}

		let anchor = anchorRef || this.findAnchorRef(element);
		let areaHeight = content.getBoundingClientRect().height;
		let outerHeight = this.outerHeight(element);

		element.remove();

		let oversized = outerHeight >= areaHeight;

		if (!skipFitCheck && !oversized) {
			let flowBottom = this.flowBottom(content);
			let availableBottom =
				content.getBoundingClientRect().bottom -
				this.reservedHeight(content);
			let fits =
				Math.ceil(flowBottom) + Math.ceil(outerHeight) <=
				Math.floor(availableBottom);

			if (!fits) {
				this.deferFloat(element, side, anchor);
				return;
			}
		}

		if (oversized) {
			console.warn(
				"paged-with-floats: page float is taller than the page area; placing anyway",
			);
		}

		container.appendChild(element);
		element.removeAttribute("data-break-before");

		this.syncSpacer(content);

		let ref = element.dataset.ref;
		if (ref) {
			this.placed.set(ref, { element, side, outerHeight, anchorRef: anchor });
			delete this.deferredCounts[ref];
		}
	}

	/**
	 * Finds the float's anchor: the ref of the closest preceding sibling
	 * in the flow, or of its closest ancestor with a ref. The float
	 * follows this anchor when fragmentation moves it forward.
	 *
	 * @param {Element} element - The rendered float element.
	 * @returns {string|undefined} The anchor's data-ref, if any.
	 */
	findAnchorRef(element: HTMLElement) {
		let sibling = element.previousSibling as HTMLElement | null;
		while (sibling) {
			if (sibling.dataset && sibling.dataset.ref) {
				return sibling.dataset.ref;
			}
			sibling = sibling.previousSibling as HTMLElement | null;
		}

		let parent = element.parentElement;
		while (
			parent &&
			parent.classList &&
			!parent.classList.contains("paged_page_content")
		) {
			if (parent.dataset && parent.dataset.ref) {
				return parent.dataset.ref;
			}
			parent = parent.parentElement;
		}
		return undefined;
	}

	/**
	 * Queues a float for placement on the next page and counts
	 * consecutive deferrals to guard against loops.
	 *
	 * @param {Element} element - The float element.
	 * @param {string} side - "top" or "bottom".
	 * @param {string} anchorRef - Ref of the float's anchor, if any.
	 * @returns {void}
	 */
	deferFloat(element: HTMLElement, side: string, anchorRef?: string) {
		let ref = element.dataset.ref;
		if (ref) {
			this.deferredRefs.add(ref);
			this.deferredCounts[ref] = (this.deferredCounts[ref] || 0) + 1;
			if (this.deferredCounts[ref] > MAX_DEFERRALS) {
				console.warn(
					"paged-with-floats: page float deferred more than",
					MAX_DEFERRALS,
					"times; forcing placement",
				);
				element.dataset.forcePageFloat = "true";
				delete this.deferredCounts[ref];
			}
		}
		this.deferred.push({ element, side, anchorRef });
	}

	/**
	 * Bottom edge of the rendered flow content within the page,
	 * excluding the float spacer.
	 *
	 * For manual-columns pages the flow lives inside the column boxes; the
	 * bottom is the deepest visible line across all columns (the column
	 * boxes themselves are full-height and must not count as content).
	 *
	 * @param {Element} content - The .paged_page_content element.
	 * @returns {number} Pixel coordinate of the flow's bottom edge.
	 */
	flowBottom(content: HTMLElement) {
		let wrapper = this.flowWrapper(content);
		if (!wrapper || !wrapper.firstChild) {
			return content.getBoundingClientRect().top;
		}

		const columns = wrapper.querySelectorAll(
			":scope > .paged_columns > .paged_column",
		);
		if (columns.length) {
			let bottom = content.getBoundingClientRect().top;
			for (const column of Array.from(columns) as HTMLElement[]) {
				const columnBottom = this.columnContentBottom(column);
				if (columnBottom > bottom) {
					bottom = columnBottom;
				}
			}
			return bottom;
		}

		let spacer = wrapper.querySelector(":scope > .paged_float_spacer") as HTMLElement | null;
		let hidden = false;
		if (spacer && spacer.style.display !== "none") {
			spacer.style.display = "none";
			hidden = true;
		}
		let bottom: number;
		try {
			bottom = this.visibleFlowBottom(wrapper as HTMLElement);
		} finally {
			if (hidden) {
				spacer!.style.display = "";
			}
		}
		return bottom;
	}

	/**
	 * Bottom edge of a manual column's *content*, excluding the column
	 * box itself (which spans the full page height by design).
	 *
	 * @param {HTMLElement} column - The .paged_column element.
	 * @returns {number} Pixel coordinate of the deepest content line.
	 */
	private columnContentBottom(column: HTMLElement): number {
		const range = document.createRange();
		let bottom = column.getBoundingClientRect().top;
		const walker = document.createTreeWalker(
			column,
			NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
			{
				acceptNode: (node) =>
					node === column
						? NodeFilter.FILTER_SKIP
						: NodeFilter.FILTER_ACCEPT,
			},
		);
		let current = walker.nextNode();
		const pushRect = (rect: DOMRect) => {
			if (rect && (rect.width || rect.height) && rect.bottom > bottom) {
				bottom = rect.bottom;
			}
		};
		while (current) {
			if (current.nodeType === Node.ELEMENT_NODE) {
				const rects = (current as Element).getClientRects();
				for (let i = 0; i < rects.length; i++) {
					pushRect(rects[i]);
				}
			} else {
				range.selectNodeContents(current);
				const rects = range.getClientRects();
				for (let i = 0; i < rects.length; i++) {
					pushRect(rects[i]);
				}
			}
			current = walker.nextNode();
		}
		return bottom;
	}

	/**
	 * Bottom edge of flow content sitting in a *visible* column of the
	 * wrapper.
	 *
	 * A single union bounding rect over the whole wrapper is wrong under
	 * multi-column layout: fragments continue into a hidden spill column to
	 * the right of the last visible one, and that column's line bottoms
	 * masquerade as flow content reaching the page bottom — which made top
	 * floats defer (or force-place late) even when visible columns had room.
	 * Client rects are therefore filtered to those starting left of the
	 * spill-column edge before taking the maximum bottom.
	 *
	 * @param {HTMLElement} wrapper - The page's flow content wrapper.
	 * @returns {number} Pixel coordinate of the visible flow's bottom edge.
	 */
	private visibleFlowBottom(wrapper: HTMLElement): number {
		const geometry = this.spillColumnLeft(wrapper);
		const range = document.createRange();
		let bottom = wrapper.getBoundingClientRect().top;

		const pushRect = (rect: DOMRect) => {
			if (!rect || (!rect.width && !rect.height)) {
				return;
			}
			if (geometry !== null && rect.left >= geometry - COLUMN_SPILL_EPSILON) {
				return;
			}
			if (rect.bottom > bottom) {
				bottom = rect.bottom;
			}
		};

		const walker = document.createTreeWalker(
			wrapper,
			NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
			{
				acceptNode: (node) => {
					// Float containers and the float spacer are not flow
					// content; skip their subtrees entirely.
					if (node !== wrapper && node.nodeType === Node.ELEMENT_NODE) {
						const cls = (node as Element).className || "";
						if (
							cls.includes("paged_float_top") ||
							cls.includes("paged_float_bottom") ||
							cls.includes("paged_float_spacer")
						) {
							return NodeFilter.FILTER_REJECT;
						}
					}
					return NodeFilter.FILTER_ACCEPT;
				},
			},
		);
		let current = walker.nextNode();
		while (current) {
			if (current.nodeType === Node.ELEMENT_NODE) {
				const rects = (current as Element).getClientRects();
				for (let i = 0; i < rects.length; i++) {
					pushRect(rects[i]);
				}
			} else {
				range.selectNodeContents(current);
				const rects = range.getClientRects();
				for (let i = 0; i < rects.length; i++) {
					pushRect(rects[i]);
				}
			}
			current = walker.nextNode();
		}

		return bottom;
	}

	/**
	 * The left edge of the wrapper's hidden spill column, or null when the
	 * wrapper is not a multi-column fragmentainer.
	 *
	 * Mirrors the chunker's fragmentainer math (`column-gap: normal`
	 * approximated via font size; fragmented boxes anchored at their first
	 * client rect).
	 *
	 * @param {HTMLElement} wrapper - The flow content wrapper.
	 * @returns {number|null} Spill column left edge in pixels, or null.
	 */
	private spillColumnLeft(wrapper: HTMLElement): number | null {
		const styles = window.getComputedStyle(wrapper);
		const count = parseInt(styles.columnCount) || 1;
		if (count <= 1) {
			return null;
		}
		let gap = parseFloat(styles.columnGap);
		if (Number.isNaN(gap)) {
			gap = parseFloat(styles.fontSize) || 0;
		}
		const width =
			wrapper.clientWidth || wrapper.getBoundingClientRect().width;
		const columnWidth = (width - (count - 1) * gap) / count;
		const rects = wrapper.getClientRects();
		const boxLeft = rects.length ? rects[0].left : wrapper.getBoundingClientRect().left;
		return boxLeft + count * (columnWidth + gap);
	}

	/**
	 * The wrapper holding the normal flow content of a page.
	 *
	 * @param {Element} content - The .paged_page_content element.
	 * @returns {Element|null} The flow wrapper.
	 */
	flowWrapper(content: HTMLElement) {
		return content.querySelector(
			":scope > div:not(.paged_float_top):not(.paged_float_bottom)",
		) as HTMLElement | null;
	}

	/**
	 * Vertical space currently occupied by a page's bottom float
	 * container.
	 *
	 * @param {Element} content - The .paged_page_content element.
	 * @returns {number} Reserved height in pixels.
	 */
	reservedHeight(content: HTMLElement) {
		let container = content.querySelector(".paged_float_bottom");
		if (!container) {
			return 0;
		}
		return container.scrollHeight;
	}

	/**
	 * Keeps an in-flow spacer as the last child of the flow wrapper so
	 * that fragmentation reserves the space taken by bottom floats.
	 * Overflow detection measures against the full page bounds, so the
	 * reserved region has to occupy real space in the flow.
	 *
	 * @param {Element} content - The .paged_page_content element.
	 * @returns {void}
	 */
	syncSpacer(content: HTMLElement) {
		let wrapper = this.flowWrapper(content);
		if (!wrapper) {
			this.pendingSpacers.add(content);
			return;
		}
		let reserve = this.reservedHeight(content);
		// On manual-columns pages the spacer sits above the column row and
		// pushes every column's content down uniformly.
		let columns = wrapper.querySelector(":scope > .paged_columns");
		let spacer = wrapper.querySelector(":scope > .paged_float_spacer") as HTMLElement | null;

		if (reserve <= 0) {
			if (spacer) {
				spacer.remove();
			}
			return;
		}

		if (!spacer) {
			spacer = document.createElement("div");
			spacer.classList.add("paged_float_spacer");
			if (columns) {
				wrapper.insertBefore(spacer, columns);
			} else {
				wrapper.appendChild(spacer);
			}
		}
		spacer.style.height = reserve + "px";
	}

	/**
	 * Border box height plus vertical margins of an element.
	 *
	 * Uses computed styles rather than bounding rects: floats live in a
	 * multicol context, and a fragmented element's client rects span the
	 * whole column area, which would grossly overstate its size.
	 *
	 * @param {Element} element - The element to measure.
	 * @returns {number} Outer height in pixels.
	 */
	outerHeight(element: HTMLElement) {
		let styles = window.getComputedStyle(element);

		if (styles.display === "none") {
			return 0;
		}

		let height = parseFloat(styles.height) || 0;

		// Images inside a page float may still be decoding when the float is
		// first placed. Force a layout pass and fall back to the image's
		// natural height (scaled by width when max-width constrains it) so the
		// float does not measure as zero and get placed in a space it will
		// overflow once decoding finishes.
		if (height <= 0 && element.querySelector("img")) {
			void element.offsetHeight;
			styles = window.getComputedStyle(element);
			height = parseFloat(styles.height) || 0;
			if (height <= 0) {
				const img = element.querySelector("img") as HTMLImageElement;
				if (img && img.naturalWidth > 0) {
					const styleWidth = parseFloat(window.getComputedStyle(img).width);
					if (styleWidth > 0 && styleWidth < img.naturalWidth) {
						height =
							(img.naturalHeight * styleWidth) / img.naturalWidth;
					} else {
						height = img.naturalHeight;
					}
				}
			}
			if (height <= 0) {
				console.warn(
					"paged-with-floats: page float measured with zero height while containing images; " +
						"the images may not have finished loading before measurement",
				);
			}
		}

		return (
			height +
			(parseFloat(styles.marginTop) || 0) +
			(parseFloat(styles.marginBottom) || 0) +
			(parseFloat(styles.paddingTop) || 0) +
			(parseFloat(styles.paddingBottom) || 0) +
			(parseFloat(styles.borderTopWidth) || 0) +
			(parseFloat(styles.borderBottomWidth) || 0)
		);
	}
}

export default PageFloats;
