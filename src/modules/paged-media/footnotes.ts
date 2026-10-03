/**
 * CSS GCPM footnotes polyfill of the paged-media engine.
 *
 * Turns authored `float: footnote` declarations into a working footnote
 * system: elements whose CSS says `float: footnote` are pulled out of the
 * flowing content while a page is rendered, appended to a per-page footnote
 * area at the bottom of the page, given auto-numbered markers, and given
 * superscript "call" anchors at their original position in the text. Also
 * implements `footnote-policy` (`auto` / `line` / `block`), `footnote-display`
 * (`block` / `inline`), and the `::footnote-marker` / `::footnote-call`
 * pseudo-elements (rewritten into real attribute selectors).
 *
 * Cooperates with the layout engine (`src/chunker/layout.ts`) over the CSS
 * custom property `--paged-footnotes-height`, set inline on each page's
 * `.paged_area` element: the layout engine reserves an estimated footnote
 * height on that property before laying out a page (recording the reservation
 * in `data-paged-footnote-reserve`); `.paged_page_content` sizes itself as
 * `calc(100% - var(--paged-footnotes-height))`, so shrinking or growing the
 * variable re-flows the columns. While a page is being filled this module
 * only ever grows the height up to the recorded reserve (never below it); at
 * page end it releases the reserve and sizes the area to the notes it
 * actually holds.
 *
 * Cross-page footnote numbering is driven by an instance counter seeded onto
 * every page as `--paged-footnotes-count`. Notes that overflow the footnote
 * area are extracted, queued, and re-moved onto the following page (or onto a
 * cloned continuation page when the flow has ended).
 */
import Handler from "../handler.js";
import type { HandlerSource } from "../handler.js";
import { isContainer, isElement, isText, walk } from "../../utils/dom.js";
import Layout from "../../chunker/layout.js";
import type BreakToken from "../../chunker/breaktoken.js";
import csstree from "css-tree";
import type { CssNode, List } from "css-tree";

/**
 * One registry entry: a generated selector string plus the parsed
 * `footnote-policy` and `footnote-display` identifiers.
 */
interface FootnoteSelector {
	selector: string;
	policy: string;
	display: string;
}

/**
 * The structural subset of the chunker's Page that this module reads: the
 * page root element and the page's `.paged_footnote_area` element.
 */
interface FootnotePage {
	element: HTMLElement;
	footnotesArea: HTMLElement;
}

/**
 * The structural subset of the chunker used by `afterPageLayout`. The real
 * `Chunker.clonePage` is async; this interface declares `void` and the call
 * site never awaits it.
 */
interface FootnoteChunker {
	settings: Record<string, any>;
	clonePage(page: FootnotePage): void;
}

/**
 * A narrow view of `Layout` used only to type the `findOverflow` call.
 */
interface OverflowFinder {
	findOverflow(rendered: Element, bounds: DOMRect): Range | null | undefined;
}

/**
 * The footnote handler, as described in the module documentation.
 */
class Footnotes extends Handler {
	/** Registry of footnote selectors keyed by generated selector string. */
	footnotes: Record<string, FootnoteSelector>;

	/** Pending footnote payloads (wrapper divs / extracted fragments) for the next page. */
	needsLayout: Node[];

	/** Notes whose call left the page with the overflow; re-attached later. */
	overflow: HTMLElement[];

	/** Running count of non-continuation footnote markers placed on completed pages. */
	footnotesPlaced: number;

	/**
	 * Wires the handler against the engine objects and initializes the four
	 * state fields to fresh empty values.
	 *
	 * @param {HandlerSource} chunker - The chunker, exposing lifecycle hooks.
	 * @param {HandlerSource} polisher - The polisher, exposing CSS hooks.
	 * @param {HandlerSource} caller - The caller (previewer), exposing
	 * preview hooks.
	 */
	constructor(chunker?: HandlerSource, polisher?: HandlerSource, caller?: HandlerSource) {
		super(chunker, polisher, caller);
		this.footnotes = {};
		this.needsLayout = [];
		this.overflow = [];
		this.footnotesPlaced = 0;
	}

	/**
	 * Polisher hook, fired for every declaration of every parsed rule.
	 *
	 * Handles `float: footnote` (registers the rule's generated selector and
	 * strips the declaration so the browser never applies the float
	 * natively), `footnote-policy` and `footnote-display` (attach the parsed
	 * identifier to an already-registered selector's entry). Property names
	 * and value identifiers are compared case-sensitively; only the first
	 * child of the declaration value is inspected.
	 *
	 * @param {CssNode} declaration - The declaration node.
	 * @param {List.Cursor} dItem - The declaration's cursor in its list.
	 * @param {List} dList - The list containing the declaration.
	 * @param {Object} rule - The containing rule context.
	 * @param {CssNode} rule.ruleNode - The rule node (its prelude is
	 * serialized into the registry key).
	 */
	onDeclaration(declaration: CssNode, dItem: List.Cursor, dList: List, rule: { ruleNode: CssNode }): void {
		const value = declaration.value as { children?: List } | undefined;
		const first = value && value.children && value.children.first();
		const name = (first as { name?: string } | undefined)?.name;

		if (declaration.property === "float") {
			if (name === "footnote") {
				const selector = csstree.generate(rule.ruleNode.prelude);
				this.footnotes[selector] = { selector, policy: "auto", display: "block" };
				dList.remove(dItem);
			}
		} else if (declaration.property === "footnote-policy") {
			if (name) {
				const selector = csstree.generate(rule.ruleNode.prelude);
				if (this.footnotes[selector]) {
					this.footnotes[selector].policy = name;
				}
			}
		} else if (declaration.property === "footnote-display") {
			const selector = csstree.generate(rule.ruleNode.prelude);
			if (name && this.footnotes[selector]) {
				this.footnotes[selector].display = name;
			}
		}
	}

	/**
	 * Polisher hook, fired for every PseudoElementSelector found inside a
	 * Selector node of a rule's prelude (pseudo-classes never reach it).
	 *
	 * For `::footnote-marker` / `::footnote-call`, the first selector of the
	 * prelude is rewritten in place: every pseudo-element is stripped from
	 * the compound, a `data-footnote-marker` / `data-footnote-call`
	 * attribute selector is appended, and the pseudo is replaced by
	 * `::marker` / `::after`. Any other pseudo name leaves the AST
	 * untouched; only the first comma-separated selector is rewritten.
	 *
	 * @param {CssNode} pseudoNode - The pseudo-element selector node.
	 * @param {List.Cursor} pItem - The pseudo's cursor (unused).
	 * @param {List} pList - The list containing the pseudo (unused).
	 * @param {Object} selector - The sheet's selector-context object
	 * (declared `string`; never read).
	 * @param {Object} rule - The containing rule context.
	 * @param {CssNode} rule.ruleNode - The rule node whose prelude is
	 * rewritten.
	 */
	onPseudoSelector(pseudoNode: CssNode, pItem: List.Cursor, pList: List, selector: string, rule: { ruleNode: CssNode }): void {
		if (pseudoNode.name !== "footnote-marker" && pseudoNode.name !== "footnote-call") {
			return;
		}

		const attribute = pseudoNode.name === "footnote-marker"
			? "data-footnote-marker"
			: "data-footnote-call";
		const pseudo = pseudoNode.name === "footnote-marker"
			? "marker"
			: "after";

		const prelude = rule.ruleNode.prelude as { children: List };
		const firstSelector = prelude.children.first() as CssNode;
		const children = new csstree.List();
		firstSelector.children.forEach((child: CssNode) => {
			if (child.type !== "PseudoElementSelector") {
				children.appendData(child);
			}
		});
		children.appendData({
			type: "AttributeSelector",
			name: { type: "Identifier", name: attribute },
			flags: null,
			loc: null,
			matcher: null,
			value: null,
		} as unknown as CssNode);
		children.appendData({
			type: "PseudoElementSelector",
			name: pseudo,
			loc: null,
			children: null,
		} as unknown as CssNode);
		firstSelector.children = children;
	}

	/**
	 * Chunker hook, fired once per flow after the content is parsed, before
	 * any page exists. Stamps every matched element of every registered
	 * footnote selector.
	 *
	 * @param {Document | Element} parsed - The parsed source content.
	 */
	afterParsed(parsed: Document | Element): void {
		this.processFootnotes(parsed, this.footnotes);
	}

	/**
	 * Stamps the note-bearing elements of the parsed content: each element
	 * matched by a registry key gets `data-note="footnote"`,
	 * `data-break-before="avoid"`, the entry's policy and display as
	 * `data-note-policy` / `data-note-display` (defaulting to `auto` /
	 * `block` when falsy), and is passed to `processFootnoteContainer`.
	 *
	 * @param {Document | Element} parsed - The parsed source content.
	 * @param {Record<string, FootnoteSelector>} notes - The registry of
	 * footnote selectors.
	 */
	processFootnotes(parsed: Document | Element, notes: Record<string, FootnoteSelector>): void {
		for (const selector in notes) {
			const note = notes[selector];
			const elements = parsed.querySelectorAll(selector);
			for (const element of elements) {
				const el = element as HTMLElement;
				el.setAttribute("data-note", "footnote");
				el.setAttribute("data-break-before", "avoid");
				el.setAttribute("data-note-policy", note.policy || "auto");
				el.setAttribute("data-note-display", note.display || "block");
				this.processFootnoteContainer(el);
			}
		}
	}

	/**
	 * Marks the element that "carries" the note with `data-has-notes="true"`:
	 * starting from the note's parent, the deepest non-container element
	 * directly below the nearest container ancestor gets the attribute. A
	 * parentless note is safe (nothing happens).
	 *
	 * @param {HTMLElement} node - The note element.
	 */
	processFootnoteContainer(node: HTMLElement): void {
		let element = node.parentElement;
		let prevElement = element;
		while (element) {
			if (isContainer(element)) {
				(prevElement as HTMLElement).setAttribute("data-has-notes", "true");
				return;
			}
			prevElement = element;
			element = element.parentElement;
		}
		if (prevElement) {
			prevElement.setAttribute("data-has-notes", "true");
		}
	}

	/**
	 * Layout hook, fired for every element cloned into the rendered page.
	 * Collects the node itself (when it is a note) or all its descendant
	 * notes, and moves the visible ones into the page's footnote area.
	 *
	 * @param {Node} node - The rendered clone.
	 */
	renderNode(node: Node): void {
		if (node.nodeType !== 1) {
			return;
		}
		const el = node as HTMLElement;
		if (!el.dataset) {
			return;
		}
		let notes: NodeListOf<HTMLElement> | HTMLElement[];
		if (el.dataset.note === "footnote") {
			notes = [el];
		} else {
			notes = el.querySelectorAll("[data-note='footnote']");
		}
		if (notes.length > 0) {
			this.findVisibleFootnotes(notes, el);
		}
	}

	/**
	 * Moves every note whose left edge lies within the content box's right
	 * edge into the page's footnote area (with call creation). The node must
	 * sit inside a page (have `.paged_page_content` and `.paged_area`
	 * ancestors) or the non-null `closest` lookups throw.
	 *
	 * @param {NodeListOf<HTMLElement> | HTMLElement[]} notes - The notes to
	 * test and move.
	 * @param {HTMLElement} node - The rendered element carrying the notes.
	 */
	findVisibleFootnotes(notes: NodeListOf<HTMLElement> | HTMLElement[], node: HTMLElement): void {
		const area = node.closest(".paged_page_content") as HTMLElement;
		const size = area.getBoundingClientRect();
		const right = size.left + size.width;
		for (let index = 0; index < notes.length; index++) {
			const note = notes[index];
			const bounds = note.getBoundingClientRect();
			if (bounds.left < right) {
				this.moveFootnote(note, node.closest(".paged_area") as HTMLElement, true);
			}
		}
	}

	/**
	 * Writes the footnote-area height custom property, clamped from below by
	 * the layout engine's reservation (`data-paged-footnote-reserve`): while
	 * the reserve attribute exists, the written height can never drop below
	 * the reserved value.
	 *
	 * @param {HTMLElement} pageArea - The page's `.paged_area` element.
	 * @param {number} px - The requested height in pixels.
	 */
	setFootnoteAreaHeight(pageArea: HTMLElement, px: number): void {
		const reserve = parseFloat(pageArea.dataset.pagedFootnoteReserve || "");
		const value = Number.isFinite(reserve) ? Math.max(px, reserve) : px;
		pageArea.style.setProperty("--paged-footnotes-height", value + "px");
	}

	/**
	 * End-of-page companion to the reserve: deletes the
	 * `data-paged-footnote-reserve` attribute and shrinks the height
	 * variable to the footnote content's actual extent — but only when that
	 * is smaller than the current value (a release can only shrink).
	 *
	 * @param {HTMLElement} pageArea - The page's `.paged_area` element.
	 */
	releaseFootnoteReserve(pageArea: HTMLElement): void {
		if (pageArea.dataset.pagedFootnoteReserve === undefined) {
			return;
		}
		delete pageArea.dataset.pagedFootnoteReserve;
		const noteContent = pageArea.querySelector(".paged_footnote_content") as HTMLElement;
		if (!noteContent) {
			return;
		}
		const height = noteContent.scrollHeight;
		const total = this.marginsHeight(noteContent) +
			this.paddingHeight(noteContent) +
			this.borderHeight(noteContent);
		const final = Math.max(0, height + total);
		const current = parseFloat(pageArea.style.getPropertyValue("--paged-footnotes-height")) || 0;
		if (final < current) {
			pageArea.style.setProperty("--paged-footnotes-height", final + "px");
		}
	}

	/**
	 * The per-move height negotiation: decides, from real browser geometry
	 * and the note's policy, whether the note fits the page's footnote area
	 * and how much the area must grow.
	 *
	 * Branch order (first match wins):
	 * (a) the call is horizontally outside the content box → the note is
	 * removed (it belongs to a later column / page);
	 * (b) the page holds no notes yet and there is not even room for the
	 * empty area chrome above the call → the note is queued for the next
	 * page in a plain wrapper div;
	 * (c) the note is re-attached after an overflow cycle → grow the area to
	 * the note's content (margins + borders, no padding);
	 * (d) the grown area would still end above the call bottom → same fit
	 * write as (c);
	 * (e) the note does not fit under the policy but there is positive room
	 * between the policy offset and the area top → grow to the policy delta
	 * and clamp the inner content (forcing the policy break);
	 * (f) otherwise nothing is written.
	 *
	 * @param {HTMLElement} node - The moved note element.
	 * @param {HTMLElement} noteContent - The page's `.paged_footnote_content`.
	 * @param {HTMLElement} pageArea - The page's `.paged_area` element.
	 * @param {HTMLElement | null | undefined} noteCall - The note's call
	 * anchor in the flow, when one exists.
	 * @param {boolean} needsNoteCall - Whether the note's call was just
	 * created (false for overflow re-attachments).
	 */
	recalcFootnotesHeight(
		node: HTMLElement,
		noteContent: HTMLElement,
		pageArea: HTMLElement,
		noteCall: HTMLElement | null | undefined,
		needsNoteCall: boolean,
	): void {
		if (noteContent.classList.contains("paged_footnote_empty")) {
			noteContent.classList.remove("paged_footnote_empty");
		}
		const height = noteContent.scrollHeight;

		const area = pageArea.querySelector(".paged_page_content") as HTMLElement;
		const areaBounds = area.getBoundingClientRect();
		const right = areaBounds.left + areaBounds.width;

		const noteCallBounds = noteCall && noteCall.getBoundingClientRect();

		const noteArea = pageArea.querySelector(".paged_footnote_area") as HTMLElement;
		const noteAreaBounds = noteArea.getBoundingClientRect();

		const total = this.marginsHeight(noteContent) +
			this.paddingHeight(noteContent) +
			this.borderHeight(noteContent);

		let notAreaTop = Math.floor(noteAreaBounds.top);
		if (noteAreaBounds.height === 0) {
			notAreaTop -= this.marginsHeight(noteContent, false);
			notAreaTop -= this.paddingHeight(noteContent, false);
			notAreaTop -= this.borderHeight(noteContent, false);
		}

		const notePolicy = node.dataset.notePolicy;
		let noteCallPosition = 0;
		let noteCallOffset = 0;
		if (noteCall) {
			const range = document.createRange();
			if (noteCall.previousSibling) {
				range.setStartBefore(noteCall.previousSibling);
			} else {
				range.setStartBefore(noteCall);
			}
			range.setEndAfter(noteCall);
			const rangeBounds = range.getBoundingClientRect();
			noteCallPosition = rangeBounds.bottom;
			if (!notePolicy || notePolicy === "auto") {
				noteCallOffset = Math.ceil(rangeBounds.bottom);
			} else if (notePolicy === "line") {
				noteCallOffset = Math.ceil(rangeBounds.top);
			} else if (notePolicy === "block") {
				const parentParagraph = noteCall.closest("p") as HTMLElement;
				const previousParagraph = parentParagraph.previousElementSibling;
				if (previousParagraph) {
					noteCallOffset = Math.ceil((previousParagraph as HTMLElement).getBoundingClientRect().bottom);
				} else {
					noteCallOffset = Math.ceil(rangeBounds.bottom);
				}
			}
		}

		const contentDelta = height + total - noteAreaBounds.height;
		const noteDelta = noteCallPosition ? notAreaTop - noteCallPosition : 0;
		const notePolicyDelta = noteCallPosition
			? Math.floor(noteAreaBounds.top) - noteCallOffset
			: 0;
		const hasNotes = noteArea.querySelector("[data-note='footnote']");

		if (needsNoteCall && (noteCallBounds as DOMRect).left > right) {
			// The call is horizontally outside the content box: the note
			// belongs to a later column; detach it for the next page.
			node.remove();
		} else if (!hasNotes && needsNoteCall && total > noteDelta) {
			// Not even room for the empty footnote-area chrome: queue the
			// note for the next page in a plain wrapper.
			this.setFootnoteAreaHeight(pageArea, 0);
			const wrapper = document.createElement("div");
			wrapper.appendChild(node);
			this.needsLayout.push(wrapper);
		} else if (!needsNoteCall) {
			// Re-attached after an overflow cycle: grow to the note's
			// content (margins + borders, padding deliberately excluded).
			this.setFootnoteAreaHeight(
				pageArea,
				height + this.marginsHeight(noteContent) + this.borderHeight(noteContent)
			);
		} else if (noteCallPosition < noteAreaBounds.top - contentDelta) {
			// The note fits without pushing its call off the page.
			this.setFootnoteAreaHeight(
				pageArea,
				height + this.marginsHeight(noteContent) + this.borderHeight(noteContent)
			);
		} else if (notePolicyDelta > 0) {
			// Does not fit under the policy: grow by the policy delta and
			// clamp the inner content so the clipped remainder is recovered
			// by the afterPageLayout overflow pass.
			this.setFootnoteAreaHeight(pageArea, noteAreaBounds.height + notePolicyDelta);
			const noteInnerContent = noteContent.querySelector(".paged_footnote_inner_content") as HTMLElement;
			noteInnerContent.style.height = (noteAreaBounds.height + notePolicyDelta - total) + "px";
		}
	}

	/**
	 * Moves one note element into a page's footnote area: creates or
	 * re-finds its call anchor (when requested), dedupes by `data-ref`
	 * against the area's content, appends the note, marks it with
	 * `data-footnote-marker` and `id="note-<ref>"`, counts it (unless it is
	 * a split continuation), and renegotiates the area height.
	 *
	 * @param {Node} node - The note element to move.
	 * @param {HTMLElement} pageArea - The page's `.paged_area` element.
	 * @param {boolean} needsNoteCall - Whether a call anchor must be created
	 * (true) or already exists in the flow (false).
	 */
	moveFootnote(node: Node, pageArea: HTMLElement, needsNoteCall: boolean): void {
		const noteArea = pageArea.querySelector(".paged_footnote_area") as HTMLElement;
		const noteContent = noteArea.querySelector(".paged_footnote_content") as HTMLElement;
		const noteInnerContent = noteContent.querySelector(".paged_footnote_inner_content") as HTMLElement;

		if (!isElement(node)) {
			return;
		}
		const note = node as HTMLElement;

		let noteCall: HTMLElement | null | undefined;
		if (needsNoteCall) {
			if (note.parentElement) {
				noteCall = this.createFootnoteCall(note);
			} else {
				// Overflow re-insertion: the call already exists in the page.
				noteCall = pageArea.querySelector("[data-ref=\"" + note.dataset.ref + "\"]") as HTMLElement;
			}
		}

		note.removeAttribute("data-break-before");

		const existing = noteInnerContent.querySelector("[data-ref=\"" + note.dataset.ref + "\"]");
		if (existing) {
			// A copy of this note already sits in the area: drop the
			// redundant one and stop (no counter change, no height recalc).
			note.remove();
			return;
		}

		noteInnerContent.appendChild(note);
		note.dataset.footnoteMarker = note.dataset.ref;
		if (!note.dataset.splitFrom) {
			this.footnotesPlaced += 1;
		}
		note.id = "note-" + note.dataset.ref;

		this.recalcFootnotesHeight(note, noteContent, pageArea, noteCall, needsNoteCall);
	}

	/**
	 * Creates the in-text call anchor for a note and inserts it into the
	 * flow at the note's original position. The anchor copies every class
	 * of the note, carries `data-footnote-call` and `data-ref`, a
	 * `data-data-counter-footnote-increment="1"` bookkeeping attribute, and
	 * an `href` pointing at the note's future `id`.
	 *
	 * @param {HTMLElement} node - The note element (must have a parent).
	 * @returns {HTMLAnchorElement} The inserted call anchor.
	 */
	createFootnoteCall(node: HTMLElement): HTMLAnchorElement {
		const footnoteCall = document.createElement("a");
		const classes = node.classList;
		for (let index = 0; index < classes.length; index++) {
			footnoteCall.classList.add(classes[index]);
		}
		footnoteCall.dataset.footnoteCall = node.dataset.ref;
		footnoteCall.dataset.ref = node.dataset.ref;
		footnoteCall.dataset.dataCounterFootnoteIncrement = "1";
		footnoteCall.href = "#note-" + node.dataset.ref;
		(node.parentElement as HTMLElement).insertBefore(footnoteCall, node);
		return footnoteCall;
	}

	/**
	 * Chunker hook, fired after a page's layout finished. Styles the
	 * footnote inner content as a multicol container sized to the area (so
	 * overflowing notes spill into an offscreen second column), detects
	 * overflow with a fresh Layout over the footnote area, and on overflow
	 * extracts the spilled content (splitting a note mid-content when
	 * necessary), queues it for the next page, and sizes the area to what
	 * remains. Finally clears the inner-content height and releases the
	 * layout engine's footnote reserve.
	 *
	 * @param {HTMLElement} pageElement - The page's root element.
	 * @param {FootnotePage} page - The Page object (its `footnotesArea` is
	 * the page's `.paged_footnote_area`).
	 * @param {BreakToken | null} breakToken - The resume token, null for
	 * cloned continuation pages.
	 * @param {FootnoteChunker} chunker - The chunker (used for its settings
	 * and `clonePage`).
	 */
	afterPageLayout(pageElement: HTMLElement, page: FootnotePage, breakToken: BreakToken | null, chunker: FootnoteChunker): void {
		const pageArea = pageElement.querySelector(".paged_area") as HTMLElement;
		const noteArea = page.footnotesArea;
		const noteContent = noteArea.querySelector(".paged_footnote_content") as HTMLElement;
		const noteInnerContent = noteArea.querySelector(".paged_footnote_inner_content") as HTMLElement;

		const noteContentBounds = noteContent.getBoundingClientRect();
		noteInnerContent.style.columnWidth = Math.round(noteContentBounds.width) + "px";
		noteInnerContent.style.columnGap = "calc(var(--paged-margin-right) + var(--paged-margin-left))";

		const layout: OverflowFinder = new Layout(noteArea, undefined, chunker.settings);
		const overflow = layout.findOverflow(noteInnerContent, noteContentBounds);

		if (overflow) {
			const startContainer = overflow.startContainer;
			const startOffset = overflow.startOffset;
			const footnoteContainer = isText(startContainer)
				? ((startContainer as Text).parentElement as HTMLElement).closest("[data-footnote-marker]")
				: (startContainer as Element).closest("[data-footnote-marker]");

			let notEntireNote = !footnoteContainer || startOffset !== 0;
			if (footnoteContainer && startOffset === 0) {
				// Text before the overflow point inside the note means the
				// note is split mid-content.
				let pos: Node | null = startContainer;
				while (pos && pos !== footnoteContainer) {
					pos = pos.previousSibling || pos.parentNode;
					if (isText(pos)) {
						notEntireNote = true;
					}
				}
			}

			let extracted: DocumentFragment;
			if (notEntireNote) {
				// Partial split: extract the overflowing content and rebuild
				// a continuation from a text-free clone of the whole note
				// container, grafting the extracted content where the split
				// child's shell stood.
				extracted = overflow.extractContents();
				const splitChild = extracted.firstElementChild as HTMLElement | null;

				const parentRange = document.createRange();
				parentRange.selectNode(footnoteContainer as Node);
				const cloned = parentRange.cloneContents();

				let replacePos: HTMLElement | undefined;
				let pending: Text | null = null;
				let current: Node | null = null;
				const iterator = walk(cloned.firstChild as Node, cloned as unknown as Node);
				for (;;) {
					// Handle the previously yielded node (one-iteration lag).
					if (current && isElement(current)) {
						const el = current as HTMLElement;
						if ((splitChild as HTMLElement | null)?.dataset?.ref == el.dataset.ref) {
							replacePos = el;
						}
						if (el.dataset.footnoteMarker) {
							el.dataset.splitFrom = "true";
							delete el.dataset.footnoteMarker;
						}
					}
					const step = iterator.next();
					if (step.done) {
						break;
					}
					current = step.value;
					if (pending) {
						pending.remove();
						pending = null;
					}
					if (isText(current)) {
						pending = current as Text;
						replacePos = (current as Text).parentElement as HTMLElement;
					}
				}
				if (pending) {
					pending.remove();
					pending = null;
				}

				if (splitChild) {
					splitChild.dataset.splitFrom = splitChild.dataset.ref;
					((replacePos as HTMLElement).parentNode as Node).replaceChild(extracted, replacePos as HTMLElement);
				} else {
					(replacePos as HTMLElement).appendChild(extracted);
				}

				// The queued payload is the restructured clone, not the raw
				// extracted range.
				extracted = cloned;

				this.handleAlignment(noteInnerContent.lastElementChild as HTMLElement);
			} else {
				// The whole note overflows: extract it intact.
				const range = document.createRange();
				range.setStartBefore(footnoteContainer as Node);
				range.setEndAfter(footnoteContainer as Node);
				extracted = range.extractContents();
			}

			this.needsLayout.push(extracted);

			// Clear the policy clamp from recalcFootnotesHeight branch (e).
			noteContent.style.removeProperty("height");
			noteInnerContent.style.removeProperty("height");

			// Re-measure and write DIRECTLY, bypassing the reserve clamp
			// (the page is already breaking; the columns must re-flow
			// against the post-extraction height). Full chrome, including
			// padding this time.
			const height = noteInnerContent.getBoundingClientRect().height;
			pageArea.style.setProperty(
				"--paged-footnotes-height",
				(height +
					this.marginsHeight(noteContent) +
					this.borderHeight(noteContent) +
					this.paddingHeight(noteContent)) + "px"
			);

			if (noteInnerContent.childNodes.length === 0) {
				noteContent.classList.add("paged_footnote_empty");
			}

			if (!breakToken) {
				// The flow has ended but notes still overflow: a cloned
				// continuation page receives them (clonePage triggers
				// beforePageLayout on the clone, which drains needsLayout).
				chunker.clonePage(page);
			} else {
				const overflowNode = (breakToken.overflow as unknown as { node?: HTMLElement }).node;
				if (
					overflowNode &&
					overflowNode.dataset &&
					(overflowNode.dataset.breakBefore || overflowNode.dataset.previousBreakAfter)
				) {
					chunker.clonePage(page);
				}
			}
		}

		noteInnerContent.style.height = "auto";
		this.releaseFootnoteReserve(pageArea);
	}

	/**
	 * Marks the last fragment of a split footnote for last-line alignment:
	 * sets `data-last-split-element="true"` and copies the computed
	 * `text-align-last` into `data-align-last-split-element` (mapping
	 * `auto` to `justify`).
	 *
	 * @param {HTMLElement} node - The last rendered fragment of the note.
	 */
	handleAlignment(node: HTMLElement): void {
		const styles = window.getComputedStyle(node);
		const alignLast = (styles as unknown as Record<string, string>)["text-align-last"];
		node.dataset.lastSplitElement = "true";
		if (alignLast === "auto") {
			node.dataset.alignLastSplitElement = "justify";
		} else {
			node.dataset.alignLastSplitElement = alignLast as string;
		}
	}

	/**
	 * Chunker hook, fired before each page's content layout. Seeds the
	 * page's `--paged-footnotes-count` with the running count (BEFORE the
	 * drain, so the seed reflects only markers placed on earlier pages),
	 * then drains the pending-payload queue onto the page (with call
	 * creation off — those notes' calls already exist in the flow).
	 *
	 * @param {FootnotePage} page - The Page about to be laid out.
	 */
	beforePageLayout(page: FootnotePage): void {
		page.element.style.setProperty("--paged-footnotes-count", String(this.footnotesPlaced));
		while (this.needsLayout.length) {
			const payload = this.needsLayout.shift() as Node;
			const children = Array.from(payload.childNodes);
			for (const child of children) {
				this.moveFootnote(child, page.element.querySelector(".paged_area") as HTMLElement, false);
			}
		}
	}

	/**
	 * Layout hook, fired after overflow content was removed from the
	 * rendered flow. Removes from the footnote area every note whose call
	 * anchor left the page with the overflow (decrementing the counter for
	 * non-continuation notes) and queues them for re-attachment; marks the
	 * area empty when nothing is left.
	 *
	 * @param {HTMLElement} removed - The fragment that was taken out.
	 * @param {HTMLElement} rendered - The rendered content wrapper.
	 */
	afterOverflowRemoved(removed: HTMLElement, rendered: HTMLElement): void {
		const area = rendered.closest(".paged_area");
		if (!area) {
			return;
		}
		const notes = area.querySelectorAll(".paged_footnote_area [data-note='footnote']");
		for (let index = 0; index < notes.length; index++) {
			const note = notes[index] as HTMLElement;
			const call = removed.querySelector("[data-footnote-call=\"" + note.dataset.ref + "\"]");
			if (call) {
				// The call left this page with the overflow, so the note
				// must leave the area too.
				note.remove();
				if (!note.dataset.splitFrom) {
					this.footnotesPlaced -= 1;
				}
				this.overflow.push(note);
			}
		}
		const noteInnerContent = area.querySelector(".paged_footnote_inner_content");
		if (noteInnerContent && noteInnerContent.childNodes.length === 0) {
			(noteInnerContent.parentElement as HTMLElement).classList.add("paged_footnote_empty");
		}
	}

	/**
	 * Layout hook, fired after carried overflow content was re-added to the
	 * rendered flow of the new page. Moves notes still inside the re-added
	 * flow normally, then re-attaches the queued overflow notes (deduping
	 * stale copies), recounting them and renegotiating the area height.
	 *
	 * @param {HTMLElement} rendered - The rendered content wrapper.
	 */
	afterOverflowAdded(rendered: HTMLElement): void {
		const notes = rendered.querySelectorAll("[data-note='footnote']") as NodeListOf<HTMLElement>;
		if (notes.length) {
			this.findVisibleFootnotes(notes, rendered);
		}
		const area = rendered.closest(".paged_area") as HTMLElement;
		const noteContent = area.querySelector(".paged_footnote_content") as HTMLElement;
		const notesInnerContent = area.querySelector(".paged_footnote_inner_content") as HTMLElement;

		if (this.overflow.length) {
			for (const item of this.overflow) {
				const existing = notesInnerContent.querySelector("[data-ref=\"" + item.dataset.ref + "\"]");
				if (existing && existing !== item) {
					// An identical note already landed through moveFootnote:
					// drop the stale copy.
					item.remove();
					continue;
				}
				notesInnerContent.appendChild(item);
				if (!item.dataset.splitFrom) {
					this.footnotesPlaced += 1;
				}
				const call = rendered.querySelector("[data-ref=\"" + item.dataset.ref + "\"]") as HTMLElement | null;
				this.recalcFootnotesHeight(item, noteContent, area, call, false);
			}
			this.overflow = [];
		}
	}

	/**
	 * Sums the element's computed vertical margins. The top margin is
	 * always added; the bottom margin only when `total` is true (default).
	 * Unparsable or zero values contribute nothing.
	 *
	 * @param {HTMLElement} element - Element to measure.
	 * @param {boolean} [total] - Include the bottom margin; true by default.
	 * @returns {number} The integer sum.
	 */
	marginsHeight(element: HTMLElement, total = true): number {
		const styles = window.getComputedStyle(element);
		const top = parseInt(styles.marginTop, 10);
		const bottom = parseInt(styles.marginBottom, 10);
		let sum = 0;
		if (top) {
			sum += top;
		}
		if (total && bottom) {
			sum += bottom;
		}
		return sum;
	}

	/**
	 * Sums the element's computed vertical padding. The top padding is
	 * always added; the bottom padding only when `total` is true (default).
	 * Unparsable or zero values contribute nothing.
	 *
	 * @param {HTMLElement} element - Element to measure.
	 * @param {boolean} [total] - Include the bottom padding; true by default.
	 * @returns {number} The integer sum.
	 */
	paddingHeight(element: HTMLElement, total = true): number {
		const styles = window.getComputedStyle(element);
		const top = parseInt(styles.paddingTop, 10);
		const bottom = parseInt(styles.paddingBottom, 10);
		let sum = 0;
		if (top) {
			sum += top;
		}
		if (total && bottom) {
			sum += bottom;
		}
		return sum;
	}

	/**
	 * Sums the element's computed vertical border widths (read from the
	 * `borderTop` / `borderBottom` shorthands; the width leads the
	 * serialized value in a browser, and engines that return an empty
	 * string yield NaN, contributing nothing). The top border is always
	 * added; the bottom border only when `total` is true (default).
	 *
	 * @param {HTMLElement} element - Element to measure.
	 * @param {boolean} [total] - Include the bottom border; true by default.
	 * @returns {number} The integer sum.
	 */
	borderHeight(element: HTMLElement, total = true): number {
		const styles = window.getComputedStyle(element);
		const top = parseInt(styles.borderTop, 10);
		const bottom = parseInt(styles.borderBottom, 10);
		let sum = 0;
		if (top) {
			sum += top;
		}
		if (total && bottom) {
			sum += bottom;
		}
		return sum;
	}
}

export default Footnotes;
