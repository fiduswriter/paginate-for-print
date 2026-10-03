/**
 * DOM utility layer of the paged-media engine: depth-first tree walking and
 * significant-node navigation, `data-ref` registry lookup, break-decision
 * predicates read from `data-*` attributes, text-offset range builders for
 * word- and letter-wise breaking, and the tree-rebuilding machinery that
 * houses continuation content in cloned ancestors after a page split.
 *
 * The module is stateless. Whitespace classification uses exactly the four
 * characters tab, LF, CR and space; NBSP (U+00A0) and narrow NBSP (U+202F)
 * are word characters, not whitespace.
 */

import { getBoundingClientRect } from "./utils.js";

/**
 * A node usable as a query root that may carry the engine's `data-ref`
 * registry: a mapping from `data-ref` attribute values to the registered
 * elements of the tree it describes.
 */
type NodeWithRefs = Node & { indexOfRefs?: Record<string, HTMLElement> };

/**
 * Matches any character outside the engine's whitespace set (tab, LF, CR,
 * space). A text node is all-whitespace when this finds no match.
 */
const notWhitespaceRe = /[^\t\n\r ]/;

/**
 * Matches a single word character: anything but JavaScript-whitespace,
 * with NBSP and narrow NBSP re-included as word characters.
 */
const wordCharRe = /^[\S\u202F\u00A0]$/;

/**
 * Attribute values of the break properties that demand a hard break.
 */
const breakTypes = ["always", "page", "left", "right", "recto", "verso"];

/**
 * Tag names that never act as block containers for splitting purposes.
 * Deliberately includes block-ish elements (P, headings, LI, TD, ...)
 * whose splitting is handled at the text level.
 */
const nonContainerTags = [
	"A",
	"ABBR",
	"ACRONYM",
	"B",
	"BDO",
	"BIG",
	"BR",
	"BUTTON",
	"CITE",
	"CODE",
	"DFN",
	"EM",
	"I",
	"IMG",
	"INPUT",
	"KBD",
	"LABEL",
	"MAP",
	"OBJECT",
	"Q",
	"SAMP",
	"SCRIPT",
	"SELECT",
	"SMALL",
	"SPAN",
	"STRONG",
	"SUB",
	"SUP",
	"TEXTAREA",
	"TIME",
	"TT",
	"VAR",
	"P",
	"H1",
	"H2",
	"H3",
	"H4",
	"H5",
	"H6",
	"FIGCAPTION",
	"BLOCKQUOTE",
	"PRE",
	"LI",
	"TD",
	"DT",
	"DD",
	"VIDEO",
	"CANVAS",
];

/**
 * Returns the deepest node along the last-child path of `node`, descending
 * only through element children and skipping ignorable tail nodes; the
 * descent stops at the first level whose last significant child is not an
 * element, so a trailing text node leaves its parent element as the result.
 *
 * @param {Node} node - Node to descend into.
 * @returns {Node} The deepest element of the last-child path, or `node`
 * itself when it has no element children.
 */
function findLastSignificantDescendant(node: Node): Node {
	let last: Node = node;
	let childNode: Node | null = last.lastChild;
	while (childNode) {
		if (isIgnorable(childNode)) {
			childNode = childNode.previousSibling;
			continue;
		}
		if (isElement(childNode)) {
			last = childNode;
			childNode = last.lastChild;
			continue;
		}
		break;
	}
	return last;
}

/**
 * Copies the rendered width of `originalElement` onto `destElement` as an
 * inline pixel width. Reads the computed width, falling back to the
 * bounding rect when it is empty, and writes nothing unless the parsed
 * integer is non-zero.
 *
 * @param {Element} originalElement - Rendered element to measure.
 * @param {Element} destElement - Clone to size.
 */
function copyWidth(originalElement: Element, destElement: Element): void {
	const styles = window.getComputedStyle(originalElement);
	let width = styles.width;
	if (!width) {
		const rect = getBoundingClientRect(originalElement);
		width = rect ? String(rect.width) : "";
	}
	const parsed = parseInt(width, 10);
	if (parsed) {
		(destElement as HTMLElement).style.width = parsed + "px";
	}
}

/**
 * Records the split relationship between a rendered original and its
 * continuation clone: the clone is marked with `data-split-from` when the
 * original was itself already a continuation, and the original always gets
 * `data-split-to` pointing at the clone's `data-ref` (the literal string
 * "null" when the clone carries none).
 *
 * @param {HTMLElement} orig - Rendered counterpart of the cloned node.
 * @param {Element} clone - Fresh continuation clone.
 */
function setSplit(orig: HTMLElement, clone: Element): void {
	if (orig.dataset.splitTo) {
		clone.setAttribute(
			"data-split-from",
			clone.getAttribute("data-ref") as unknown as string
		);
	}
	orig.setAttribute(
		"data-split-to",
		clone.getAttribute("data-ref") as unknown as string
	);
}

/**
 * Clones an element for use as a rebuilt ancestor: attributes are taken
 * over unchanged by the native clone (including `data-ref`, classes and
 * inline styles), except that `id` is moved to `data-id` and the break
 * attributes that caused the split are removed so the continuation does
 * not re-trigger them.
 *
 * @param {Element} node - Element to clone.
 * @param {boolean} [deep] - Clone the whole subtree instead of the
 * element alone.
 * @returns {HTMLElement} The fixed-up clone.
 */
function cloneNodeAncestor(node: Element, deep = false): HTMLElement {
	const clone = node.cloneNode(deep) as HTMLElement;
	if (clone.id) {
		clone.setAttribute("data-id", clone.id);
		clone.removeAttribute("id");
	}
	clone.removeAttribute("data-break-before");
	clone.removeAttribute("data-previous-break-after");
	return clone;
}

/**
 * Climbs the parent chain looking for the nearest node that carries a
 * named page (`data-page`). Stops before the limiter when one is given,
 * reporting that case as `undefined` so callers can distinguish "reached
 * the limiter" from "reached the root".
 *
 * @param {Node} node - Node to climb from.
 * @param {Node} [limiter] - Node at which the climb is cut short.
 * @returns {HTMLElement|null|undefined} The named node, `undefined` when
 * the limiter was reached first, `null` when the root was exhausted.
 */
function getNodeWithNamedPage(
	node: Node,
	limiter?: Node
): HTMLElement | null | undefined {
	let current: Node | null = node;
	while (current) {
		if (limiter && current === limiter) {
			return undefined;
		}
		if (
			(current as HTMLElement).dataset &&
			(current as HTMLElement).dataset.page
		) {
			return current as HTMLElement;
		}
		current = current.parentNode;
	}
	return null;
}

/**
 * Type guard for element nodes.
 *
 * @param {Node|null|undefined} node - Node to test.
 * @returns {boolean} True for element nodes (nodeType 1).
 */
export function isElement(node: Node | null | undefined): node is Element {
	return !!node && node.nodeType === 1;
}

/**
 * Type guard for text nodes.
 *
 * @param {Node|null|undefined} node - Node to test.
 * @returns {boolean} True for text nodes (nodeType 3).
 */
export function isText(node: Node | null | undefined): node is Text {
	return !!node && node.nodeType === 3;
}

/**
 * Depth-first, pre-order generator of the nodes from `start` onward: the
 * start node is yielded first, subtrees are fully descended, and
 * traversal continues through following siblings and ancestor siblings.
 * A limiter bounds the walk while climbing out of a subtree: the limiter
 * itself is still yielded (and its subtree traversed), but nothing after
 * it is visited. A childless last-child limiter escapes the bound, since
 * only climbed-to parents are compared against it.
 *
 * @param {Node} start - First node to yield.
 * @param {Node} [limiter] - Node whose position ends the walk.
 * @yields {Node} Every reachable node in document order.
 */
export function* walk(start: Node, limiter?: Node): Generator<Node> {
	let node: Node | null = start;
	while (node) {
		yield node;
		if (node.childNodes.length > 0) {
			node = node.firstChild;
		} else if (node.nextSibling) {
			if (limiter && node === limiter) {
				return;
			}
			node = node.nextSibling;
		} else {
			let climbed: Node | null = node;
			while (climbed) {
				climbed = climbed.parentNode;
				if (!climbed) {
					return;
				}
				if (limiter && climbed === limiter) {
					return;
				}
				if (climbed.nextSibling) {
					node = climbed.nextSibling;
					break;
				}
			}
		}
	}
}

/**
 * Finds the next node after `node` in document order. `descend` only
 * controls whether the node's own first (significant) child counts as a
 * candidate; nodes passed by are never entered. With `skipIgnorable`
 * (the default) whitespace text nodes and comments are stepped over;
 * without it the literal next sibling — however insignificant — is
 * returned. The limiter is only compared against climbed ancestors.
 *
 * @param {Node} node - Node to start from.
 * @param {Node} [limiter] - Node that stops the upward search.
 * @param {boolean} [descend] - Consider the node's own children first.
 * @param {boolean} [skipIgnorable] - Skip whitespace text nodes and
 * comments; true by default.
 * @returns {Node|undefined} The next node, or undefined when the tree or
 * the limiter ends the search.
 */
export function nodeAfter(
	node: Node,
	limiter?: Node,
	descend = false,
	skipIgnorable = true
): Node | undefined {
	if (limiter && node === limiter) {
		return undefined;
	}
	if (descend && node.childNodes.length > 0) {
		let candidate: Node | null = node.firstChild;
		if (skipIgnorable && candidate && isIgnorable(candidate)) {
			candidate = nextSignificantNode(candidate);
		}
		if (candidate) {
			return candidate;
		}
	}
	if (!skipIgnorable) {
		let literal: Node | null = node.nextSibling;
		while (!literal && node.parentNode) {
			node = node.parentNode;
			if (limiter && node === limiter) {
				return undefined;
			}
			literal = node.nextSibling;
		}
		return literal || undefined;
	}
	let next: Node | null = nextSignificantNode(node);
	while (!next && node.parentNode) {
		node = node.parentNode;
		if (limiter && node === limiter) {
			return undefined;
		}
		next = nextSignificantNode(node);
	}
	return next || undefined;
}

/**
 * Finds the previous node before `node` in document order, always stepping
 * over ignorable nodes. With `descend`, a found preceding sibling is
 * replaced by its deepest last-child-path node. The limiter is checked on
 * the start node and again on every climbed ancestor.
 *
 * @param {Node} node - Node to start from.
 * @param {Node} [limiter] - Node that stops the upward search.
 * @param {boolean} [descend] - Descend into the preceding sibling.
 * @returns {Node|undefined} The previous node, or undefined when the tree
 * or the limiter ends the search.
 */
export function nodeBefore(
	node: Node,
	limiter?: Node,
	descend = false
): Node | undefined {
	let current: Node | null = node;
	do {
		if (limiter && current === limiter) {
			return undefined;
		}
		let before = previousSignificantNode(current);
		if (before && descend) {
			before = findLastSignificantDescendant(before);
		}
		if (before) {
			return before;
		}
		current = current.parentNode;
	} while (current);
	return undefined;
}

/**
 * Nearest element after `node` in document order, skipping intervening
 * non-element nodes.
 *
 * @param {Node} node - Node to start from.
 * @param {Node} [limiter] - Node that stops the search.
 * @param {boolean} [descend] - Consider the node's own children first.
 * @returns {Element|undefined} The next element, or undefined.
 */
export function elementAfter(
	node: Node,
	limiter?: Node,
	descend = false
): Element | undefined {
	let next = nodeAfter(node, limiter, descend);
	while (next && next.nodeType !== 1) {
		next = nodeAfter(next, limiter, descend);
	}
	return next as Element | undefined;
}

/**
 * Nearest element before `node` in document order, skipping intervening
 * non-element nodes.
 *
 * @param {Node} node - Node to start from.
 * @param {Node} [limiter] - Node that stops the search.
 * @param {boolean} [descend] - Descend into the preceding sibling.
 * @returns {Element|undefined} The previous element, or undefined.
 */
export function elementBefore(
	node: Node,
	limiter?: Node,
	descend = false
): Element | undefined {
	let before = nodeBefore(node, limiter, descend);
	while (before && before.nodeType !== 1) {
		before = nodeBefore(before, limiter, descend);
	}
	return before as Element | undefined;
}

/**
 * Nearest element after `node` that is not marked undisplayed via a
 * truthy `data-undisplayed` attribute.
 *
 * @param {Node} node - Node to start from.
 * @param {Node} [limiter] - Node that stops the search.
 * @param {boolean} [descend] - Consider the node's own children first.
 * @returns {Element|undefined} The next displayed element, or undefined.
 */
export function displayedElementAfter(
	node: Node,
	limiter?: Node,
	descend = false
): Element | undefined {
	let next = elementAfter(node, limiter, descend);
	while (next && (next as HTMLElement).dataset.undisplayed) {
		next = elementAfter(next, limiter, descend);
	}
	return next;
}

/**
 * Nearest element before `node` that is not marked undisplayed via a
 * truthy `data-undisplayed` attribute.
 *
 * @param {Node} node - Node to start from.
 * @param {Node} [limiter] - Node that stops the search.
 * @param {boolean} [descend] - Descend into the preceding sibling.
 * @returns {Element|undefined} The previous displayed element, or
 * undefined.
 */
export function displayedElementBefore(
	node: Node,
	limiter?: Node,
	descend = false
): Element | undefined {
	let before = elementBefore(node, limiter, descend);
	while (before && (before as HTMLElement).dataset.undisplayed) {
		before = elementBefore(before, limiter, descend);
	}
	return before;
}

/**
 * Collects `currentNode` and all its descendant elements into a single
 * array by unshifting every visited element onto a shared accumulator,
 * which leaves the array in reverse depth-first order: the deepest,
 * last-visited elements first and `currentNode` itself last. A supplied
 * accumulator is mutated in place and returned.
 *
 * @param {Element} currentNode - Element to stack with its descendants.
 * @param {Element[]} [stacked] - Accumulator to prepend to.
 * @returns {Element[]} The accumulator, reversed pre-order.
 */
export function stackChildren(
	currentNode: Element,
	stacked?: Element[]
): Element[] {
	const stack = stacked || [];
	stack.unshift(currentNode);
	const children = currentNode.children;
	for (let i = 0; i < children.length; i++) {
		stackChildren(children[i], stack);
	}
	return stack;
}

/**
 * Builds the continuation clone of a table row: cells still spanned from
 * preceding rows (rowSpan) are duplicated with a decremented rowSpan, the
 * row's own cells fill the remaining columns in order, and cell widths
 * are copied from the already rendered cells when available. The row's
 * preceding siblings determine the column count.
 *
 * @param {HTMLTableRowElement} node - Row to rebuild.
 * @param {Element} [alreadyRendered] - Rendered tree to measure against.
 * @param {number} [existingChildren] - Truthy when spanned cells already
 * exist in the target and must not be duplicated.
 * @returns {HTMLTableRowElement} Shallow row clone with rebuilt cells.
 */
export function rebuildTableRow(
	node: HTMLTableRowElement,
	alreadyRendered?: Element,
	existingChildren?: number
): HTMLTableRowElement {
	const row = node.cloneNode(false) as HTMLTableRowElement;

	const precedingRows: Element[] = [];
	let maxCols = 0;
	let scan: Element | null = node.parentElement!.firstElementChild;
	while (scan && scan !== node) {
		precedingRows.push(scan);
		if (scan.children.length > maxCols) {
			maxCols = scan.children.length;
		}
		scan = scan.nextElementSibling;
	}
	if (maxCols === 0) {
		const counterpart = findElement(node, alreadyRendered);
		maxCols = counterpart ? counterpart.children.length : 0;
	}

	let cursor = 0;
	for (let currentCol = 0; currentCol < maxCols; currentCol++) {
		let countdown: number | undefined = undefined;
		let sourceCell: Element | undefined = undefined;
		for (const scanRow of precedingRows) {
			const cell = scanRow.children[currentCol];
			if (countdown === undefined) {
				sourceCell = cell;
				if (cell && (cell as HTMLTableCellElement).rowSpan > 1) {
					countdown = (cell as HTMLTableCellElement).rowSpan;
				}
			}
			if (countdown !== undefined) {
				countdown--;
				if (countdown < 1) {
					countdown = undefined;
				}
			}
		}

		let destination: HTMLTableCellElement | undefined = undefined;
		if (countdown !== undefined) {
			if (!existingChildren) {
				const cell = sourceCell!.cloneNode(false) as HTMLTableCellElement;
				cell.rowSpan = (sourceCell as HTMLTableCellElement).rowSpan
					? countdown
					: 0;
				destination = cell;
			}
		} else {
			const ownCell = node.children[cursor] as HTMLTableCellElement;
			cursor++;
			if (ownCell) {
				destination = ownCell.cloneNode(false) as HTMLTableCellElement;
			}
		}

		if (destination) {
			if (alreadyRendered) {
				let widthSource: Element | null | undefined;
				if (countdown !== undefined) {
					widthSource = findElement(sourceCell!, alreadyRendered);
				} else {
					widthSource = findElement(destination, alreadyRendered);
				}
				if (widthSource) {
					copyWidth(widthSource, destination);
				}
			}
			row.appendChild(destination);
		}
	}

	return row;
}

/**
 * Builds a document fragment holding a fresh clone of `node`'s element
 * ancestor chain (and of `node` itself unless it is a text node) so
 * continuation content can be inserted under it. Clones keep their
 * `data-ref`, lose their `id` (moved to `data-id`) and their break
 * attributes; rendered column widths are copied from the already rendered
 * counterparts, table rows are rebuilt with their rowspan context, a
 * preceding `thead` is deep-cloned in as a repeated header, flex/grid
 * table-row boxes duplicate all their children, and list-style rendering
 * is flagged for suppression on continuation fragments.
 *
 * @param {Node} node - Node whose ancestors to rebuild.
 * @param {DocumentFragment} [fragment] - Fragment to build into; a new
 * one is created when omitted.
 * @param {Element} [alreadyRendered] - Previously rendered tree used for
 * width copying and split bookkeeping.
 * @returns {DocumentFragment} The fragment with the rebuilt chain.
 */
export function rebuildTree(
	node: Node,
	fragment?: DocumentFragment,
	alreadyRendered?: Element
): DocumentFragment {
	const doc = fragment || document.createDocumentFragment();

	const ancestors: Element[] = [];
	let ancestor: Node | null = node.parentNode;
	while (ancestor && ancestor.nodeType === 1) {
		ancestors.unshift(ancestor as Element);
		ancestor = ancestor.parentNode;
	}
	if (!isText(node)) {
		ancestors.push(node as Element);
	}

	let listItems = 0;
	for (const gathered of ancestors) {
		if (gathered.tagName === "LI") {
			listItems++;
		}
	}

	let container: HTMLElement | DocumentFragment = doc;
	let dupSiblings = false;

	for (const subject of ancestors) {
		let parent!: HTMLElement;

		if (subject.nodeName === "TR") {
			// Table row: reuse an existing clone or rebuild the row with
			// its rowspan context.
			let row = findElement(subject, container) as HTMLElement | null;
			if (!row) {
				row = rebuildTableRow(
					subject as HTMLTableRowElement,
					alreadyRendered,
					container.childElementCount
				);
				container.appendChild(row);
			}
			parent = row;
		} else if (dupSiblings) {
			// Flex/grid/table-row children must all be present on the
			// continuation to preserve item positions.
			const siblings: Element[] = [];
			if (subject.parentElement) {
				const elementChildren = subject.parentElement.children;
				for (let i = 0; i < elementChildren.length; i++) {
					siblings.push(elementChildren[i]);
				}
			} else {
				siblings.push(subject);
			}
			for (const sibling of siblings) {
				let clone = findElement(sibling, container) as HTMLElement | null;
				if (!clone) {
					clone = cloneNodeAncestor(sibling);
					if (alreadyRendered) {
						const counterpart = findElement(sibling, alreadyRendered);
						if (counterpart) {
							copyWidth(counterpart, clone);
						}
					}
					container.appendChild(clone);
				}
				if (sibling === subject) {
					parent = clone;
				}
			}
		} else {
			// Default: one clone per subject, sized from its rendered
			// counterpart, with rendered column groups carried over.
			let clone = findElement(subject, container) as HTMLElement | null;
			if (!clone) {
				clone = cloneNodeAncestor(subject);
				if (alreadyRendered) {
					const counterpart = findElement(subject, alreadyRendered);
					if (counterpart) {
						copyWidth(counterpart, clone);
						for (
							let i = 0;
							i < counterpart.children.length;
							i++
						) {
							const childElement = counterpart.children[i];
							if (childElement.tagName === "COLGROUP") {
								clone.appendChild(childElement.cloneNode(true));
							}
						}
					}
				}
				container.appendChild(clone);
			}
			parent = clone;
		}

		// Repeat a preceding thead so continuation table fragments keep
		// their column headers.
		const previousSibling = subject.previousElementSibling;
		if (previousSibling && previousSibling.nodeName === "THEAD") {
			let theadClone = findElement(
				previousSibling,
				container
			) as HTMLElement | null;
			if (!theadClone) {
				theadClone = cloneNodeAncestor(previousSibling, true);
				if (alreadyRendered) {
					const theadCounterpart = findElement(
						previousSibling,
						alreadyRendered
					);
					if (theadCounterpart) {
						for (const walked of walk(theadClone, theadClone)) {
							if (isElement(walked)) {
								copyWidth(
									findElement(walked, alreadyRendered) as Element,
									walked as HTMLElement
								);
							}
						}
					}
				}
				theadClone.setAttribute("data-repeated-thead", "true");
				container.insertBefore(theadClone, container.firstChild);
			}
		}

		// Wire the split bookkeeping between the rendered original and
		// the clone.
		if (alreadyRendered) {
			const counterpart = inIndexOfRefs(subject, alreadyRendered);
			if (counterpart) {
				setSplit(counterpart, parent);
			}
		}

		// Children of flex/grid/table-row boxes (marked inline or via
		// data-clonesiblings, whose loose comparison only accepts the
		// value "1") are all duplicated for the next subject.
		dupSiblings =
			((subject as HTMLElement).dataset.clonesiblings as unknown as boolean) ==
				true ||
			(subject as HTMLElement).style.display === "grid" ||
			(subject as HTMLElement).style.display === "flex" ||
			(subject as HTMLElement).style.display === "table-row";

		// Flag list-style suppression on continuation fragments: fresh
		// pages flag every rebuilt ancestor of a text node, and the
		// ancestors above the innermost list item of an element node.
		if (subject.tagName === "LI") {
			listItems--;
		}
		if (!fragment && (isText(node) || listItems > 0)) {
			parent.setAttribute("data-suppress-list-style", "true");
		}

		container = parent;
	}

	return doc;
}

/**
 * Builds a fresh document fragment holding shallow clones of `node`'s
 * element ancestors, each marked as a continuation with `data-split-from`
 * and stripped of `id` and break attributes. When the chain runs through a
 * table cell, the cell's preceding sibling cells are cloned in ahead of it
 * so the continuation cell keeps its column position. No already rendered
 * tree is consulted.
 *
 * @param {Node} node - Node whose ancestors to rebuild.
 * @returns {DocumentFragment} The fragment with the cloned chain.
 */
export function rebuildAncestors(node: Node): DocumentFragment {
	const fragment = document.createDocumentFragment();

	const ancestors: Element[] = [];
	let ancestor: Node | null = node.parentNode;
	while (ancestor && ancestor.nodeType === 1) {
		ancestors.unshift(ancestor as Element);
		ancestor = ancestor.parentNode;
	}

	let container: Node = fragment;
	for (const original of ancestors) {
		const clone = original.cloneNode(false) as HTMLElement;
		clone.setAttribute(
			"data-split-from",
			clone.getAttribute("data-ref") as unknown as string
		);
		if (clone.id) {
			clone.setAttribute("data-id", clone.id);
			clone.removeAttribute("id");
		}
		clone.removeAttribute("data-break-before");
		clone.removeAttribute("data-previous-break-after");
		if (original.nodeName === "TD" && original.parentElement) {
			const preceding: Element[] = [];
			let before = original.previousElementSibling;
			while (before) {
				preceding.unshift(before.cloneNode(false) as Element);
				before = before.previousElementSibling;
			}
			for (const cell of preceding) {
				container.appendChild(cell);
			}
		}
		container.appendChild(clone);
		container = clone;
	}

	return fragment;
}

/**
 * Whether the node demands a break before itself, per its
 * `data-break-before` attribute accepting one of the hard break values.
 *
 * @param {Node} node - Node to inspect.
 * @returns {boolean} True when a break before is demanded.
 */
export function needsBreakBefore(node: Node): boolean {
	if (node && (node as HTMLElement).dataset) {
		const value = (node as HTMLElement).dataset.breakBefore;
		if (value && breakTypes.indexOf(value) !== -1) {
			return true;
		}
	}
	return false;
}

/**
 * Whether the node demands a break after itself, per its
 * `data-break-after` attribute accepting one of the hard break values.
 *
 * @param {Node} node - Node to inspect.
 * @returns {boolean} True when a break after is demanded.
 */
export function needsBreakAfter(node: Node): boolean {
	if (node && (node as HTMLElement).dataset) {
		const value = (node as HTMLElement).dataset.breakAfter;
		if (value && breakTypes.indexOf(value) !== -1) {
			return true;
		}
	}
	return false;
}

/**
 * Whether the node demands a break after its previous sibling, per its
 * `data-previous-break-after` attribute accepting one of the hard break
 * values.
 *
 * @param {Node} node - Node to inspect.
 * @returns {boolean} True when a break after the previous node is
 * demanded.
 */
export function needsPreviousBreakAfter(node: Node): boolean {
	if (node && (node as HTMLElement).dataset) {
		const value = (node as HTMLElement).dataset.previousBreakAfter;
		if (value && breakTypes.indexOf(value) !== -1) {
			return true;
		}
	}
	return false;
}

/**
 * Whether the named page changes between `node` and the previous
 * significant node. Page names are read from `data-page` on the nodes or,
 * failing that, from their ancestors; undisplayed nodes are skipped on
 * both sides, and a node inside the previous node's subtree belongs to the
 * previous node's page group.
 *
 * @param {Node} node - Node about to be rendered.
 * @param {Node} previousSignificantNode - Last rendered significant node.
 * @returns {boolean} True when the page name differs.
 */
export function needsPageBreak(
	node: Node,
	previousSignificantNode: Node
): boolean {
	if (!node || !previousSignificantNode || isIgnorable(node)) {
		return false;
	}
	if (
		(node as HTMLElement).dataset &&
		(node as HTMLElement).dataset.undisplayed
	) {
		return false;
	}

	let previous: Node | null | undefined = previousSignificantNode;
	while (
		previous &&
		(previous as HTMLElement).dataset &&
		(previous as HTMLElement).dataset.undisplayed
	) {
		previous = nodeBefore(previous);
	}
	if (!previous) {
		return false;
	}

	let previousPage: string | undefined;
	if ((previous as HTMLElement).dataset) {
		previousPage = (previous as HTMLElement).dataset.page;
	}
	if (previousPage === undefined) {
		const named = getNodeWithNamedPage(previous);
		if (named) {
			previousPage = named.dataset.page;
		}
	}

	let currentPage: string | undefined;
	if ((node as HTMLElement).dataset) {
		currentPage = (node as HTMLElement).dataset.page;
	}
	if (currentPage === undefined) {
		const named = getNodeWithNamedPage(node, previous);
		if (named) {
			currentPage = named.dataset.page;
		} else if (named === undefined) {
			// The climb reached the previous node, so the node lies
			// inside the previous node's page group.
			return false;
		}
	}

	return currentPage !== previousPage;
}

/**
 * Yields one range per maximal run of word characters in the text node.
 * NBSP and narrow NBSP count as word characters; inside a PRE parent every
 * character does, so the whole text node yields a single range.
 *
 * @param {Text} node - Text node to scan.
 * @yields {Range} Non-overlapping ranges over the word runs, in order.
 */
export function* words(node: Text): Generator<Range> {
	const text = node.nodeValue as string;
	const preformatted = !!node.parentNode && node.parentNode.nodeName === "PRE";

	let start: number | null = null;
	for (let i = 0; i < text.length; i++) {
		if (preformatted || wordCharRe.test(text.charAt(i))) {
			if (start === null) {
				start = i;
			}
		} else if (start !== null) {
			const range = document.createRange();
			range.setStart(node, start);
			range.setEnd(node, i);
			yield range;
			start = null;
		}
	}
	if (start !== null) {
		const range = document.createRange();
		range.setStart(node, start);
		range.setEnd(node, text.length);
		yield range;
	}
}

/**
 * Yields one single-character range per UTF-16 code unit from the word
 * range's start offset to the END of the containing text node — the word
 * range's end offset is ignored.
 *
 * @param {Range} wordRange - Range over a text node to split up.
 * @yields {Range} Per-character ranges within the text node.
 */
export function* letters(wordRange: Range): Generator<Range> {
	const textNode = wordRange.startContainer as Text;
	for (
		let offset = wordRange.startOffset;
		offset < textNode.length;
		offset++
	) {
		const range = document.createRange();
		range.setStart(textNode, offset);
		range.setEnd(textNode, offset + 1);
		yield range;
	}
}

/**
 * Whether the node behaves as a block container for splitting purposes:
 * everything without a tag name, and every tag name outside the
 * non-container list, unless it hides itself via an inline
 * `display: none`.
 *
 * @param {Node} node - Node to classify.
 * @returns {boolean} True when the node is treated as a container.
 */
export function isContainer(node: Node): boolean {
	if (!(node as Element).tagName) {
		return true;
	}
	if (
		(node as HTMLElement).style &&
		(node as HTMLElement).style.display === "none"
	) {
		return false;
	}
	return !nonContainerTags.includes((node as Element).tagName);
}

/**
 * Native clone passthrough.
 *
 * @param {Node} n - Node to clone.
 * @param {boolean} [deep] - Clone the whole subtree; false by default.
 * @returns {Node} The clone.
 */
export function cloneNode(n: Node, deep = false): Node {
	return n.cloneNode(deep);
}

/**
 * Looks up the registered element for `node`'s `data-ref` in the
 * `indexOfRefs` registry attached to `doc`.
 *
 * @param {Node} node - Element whose `data-ref` to resolve.
 * @param {NodeWithRefs} [doc] - Registry holder.
 * @returns {HTMLElement|undefined} The registered element, or undefined
 * when there is no registry or no hit.
 */
export function inIndexOfRefs(
	node: Node,
	doc?: NodeWithRefs
): HTMLElement | undefined {
	if (!doc || !doc.indexOfRefs) {
		return undefined;
	}
	return doc.indexOfRefs[(node as Element).getAttribute("data-ref") as string];
}

/**
 * Puts `child` into `parentNode`, replacing an existing element child with
 * the same `data-ref` (matched on the element-children list, replaced at
 * that numeric index of the full childNodes list) and appending it
 * otherwise.
 *
 * @param {HTMLElement} parentNode - Parent to update.
 * @param {Node} child - Node to insert.
 */
export function replaceOrAppendElement(parentNode: HTMLElement, child: Node) {
	if (!isText(child)) {
		const ref = (child as Element).getAttribute("data-ref");
		const children = parentNode.children;
		for (let i = 0; i < children.length; i++) {
			if (children[i].getAttribute("data-ref") == ref) {
				parentNode.replaceChild(child, parentNode.childNodes[i]);
				return;
			}
		}
	}
	parentNode.appendChild(child);
}

/**
 * Finds the element registered for `node`'s `data-ref` inside `doc`, via
 * the registry when available and a `data-ref` attribute query otherwise.
 *
 * @param {Node} node - Element to resolve.
 * @param {NodeWithRefs} [doc] - Tree (with optional registry) to search.
 * @param {boolean} [forceQuery] - Skip the registry and query directly.
 * @returns {Element|null|undefined} The matching element, null when the
 * query finds none, undefined for missing arguments.
 */
export function findElement(
	node: Node,
	doc?: NodeWithRefs,
	forceQuery?: boolean
): Element | null | undefined {
	if (!doc || !isElement(node)) {
		return undefined;
	}
	return findRef(
		(node as Element).getAttribute("data-ref"),
		doc,
		forceQuery
	);
}

/**
 * Resolves a `data-ref` value inside `doc`: through the `indexOfRefs`
 * registry when present and not bypassed, else with a
 * `[data-ref='<ref>']` attribute query (a missing ref queries for the
 * literal "null").
 *
 * @param {string|null} ref - Ref value to look up.
 * @param {NodeWithRefs} doc - Tree (with optional registry) to search.
 * @param {boolean} [forceQuery] - Skip the registry and query directly.
 * @returns {Element|null|undefined} The matching element or null.
 */
export function findRef(
	ref: string | null,
	doc: NodeWithRefs,
	forceQuery?: boolean
): Element | null | undefined {
	if (!forceQuery && doc.indexOfRefs) {
		const indexed = doc.indexOfRefs[ref as string];
		if (indexed) {
			return indexed;
		}
	}
	return (doc as Document).querySelector("[data-ref='" + ref + "']");
}

/**
 * Whether the node carries paginatable content: any text node, or an
 * element with a non-empty `data-ref` attribute.
 *
 * @param {Node} node - Node to test.
 * @returns {boolean} True for valid nodes.
 */
export function validNode(node: Node): boolean {
	if (isText(node)) {
		return true;
	}
	if (isElement(node)) {
		return !!(node as HTMLElement).dataset.ref;
	}
	return false;
}

/**
 * Nearest valid node at or before `node`, walking previous siblings and
 * climbing parents without descending into skipped subtrees.
 *
 * @param {Node} node - Node to start from.
 * @returns {Node|null} The first valid node, or null when the walk runs
 * past the document root.
 */
export function prevValidNode(node: Node): Node | null {
	let current: Node | null = node;
	while (current && !validNode(current)) {
		current = current.previousSibling || current.parentNode;
	}
	return current;
}

/**
 * Nearest valid node at or after `node`, walking next siblings and, at
 * the end of a child list, the parent's next sibling directly (which
 * throws when there is no parent and ends the walk when the parent has no
 * next sibling).
 *
 * @param {Node} node - Node to start from.
 * @returns {Node|null} The first valid node, or null when the parent
 * chain tops out.
 */
export function nextValidNode(node: Node): Node | null {
	let current: Node | null = node;
	while (current && !validNode(current)) {
		if (current.nextSibling) {
			current = current.nextSibling;
		} else {
			current = (current.parentNode as Node).nextSibling;
		}
	}
	return current;
}

/**
 * Index of `node` within its parent's childNodes; 0 for a parentless node.
 *
 * @param {Node} node - Node to locate.
 * @returns {number} The child index.
 */
export function indexOf(node: Node): number {
	if (!node.parentNode) {
		return 0;
	}
	return Array.prototype.indexOf.call(node.parentNode.childNodes, node);
}

/**
 * The child of `node` at `index`, verbatim — out-of-range indices yield
 * undefined despite the declared return type.
 *
 * @param {Node} node - Parent node to index into.
 * @param {number} index - Child index.
 * @returns {Node} The child at the index.
 */
export function child(node: Node, index: number): Node {
	return node.childNodes[index] as Node;
}

/**
 * Whether the node would take up space: elements are visible when their
 * computed display is not none, text nodes when they have non-whitespace
 * content and their parent is displayed, and everything else never is.
 *
 * @param {Node} node - Node to test.
 * @returns {boolean} True when the node is visible.
 */
export function isVisible(node: Node): boolean {
	if (isElement(node)) {
		return window.getComputedStyle(node).display !== "none";
	}
	if (isText(node)) {
		if (!hasTextContent(node)) {
			return false;
		}
		return (
			window.getComputedStyle(node.parentNode as Element).display !== "none"
		);
	}
	return false;
}

/**
 * Whether the node holds rendered content: any element, or a text node
 * with non-whitespace content.
 *
 * @param {Node} node - Node to test.
 * @returns {boolean} True when the node has content.
 */
export function hasContent(node: Node): boolean {
	if (isElement(node)) {
		return true;
	}
	if (isText(node)) {
		return (node.textContent as string).trim().length > 0;
	}
	return false;
}

/**
 * Whether the node has direct text content: an element is contentful when
 * one of its direct childNodes is a non-whitespace text node, a text node
 * when its own content is non-whitespace.
 *
 * @param {Node} node - Node to test.
 * @returns {boolean} True when direct text content exists.
 */
export function hasTextContent(node: Node): boolean {
	if (isElement(node)) {
		for (let i = 0; i < node.childNodes.length; i++) {
			const childNode = node.childNodes[i];
			if (
				childNode.nodeType === 3 &&
				(childNode.textContent as string).trim().length > 0
			) {
				return true;
			}
		}
		return false;
	}
	if (isText(node)) {
		return (node.textContent as string).trim().length > 0;
	}
	return false;
}

/**
 * Maps a rendered text node to the index of the source text node it
 * corresponds to within `parent`'s childNodes: by the previous sibling's
 * `data-ref` position when there is one, otherwise by matching the text
 * content (minus a trailing hyphenation hyphen) against the first text
 * child that contains it.
 *
 * @param {Node} node - Rendered text node to map.
 * @param {Element} parent - Source parent to search.
 * @param {string} hyphen - Hyphenation string to strip from the tail.
 * @returns {number} The source child index, or -1 when unresolvable.
 */
export function indexOfTextNode(
	node: Node,
	parent: Element,
	hyphen: string
): number {
	if (!isText(node)) {
		return -1;
	}
	if (node.previousSibling) {
		const ref = (node.previousSibling as HTMLElement).dataset.ref;
		const match = parent.querySelector("[data-ref='" + ref + "']");
		return Array.prototype.indexOf.call(parent.childNodes, match) + 1;
	}
	let content = node.textContent as string;
	if (content.endsWith(hyphen)) {
		content = content.slice(0, content.length - hyphen.length);
	}
	for (let i = 0; i < parent.childNodes.length; i++) {
		const childNode = parent.childNodes[i];
		if (
			childNode.nodeType === 3 &&
			(childNode.textContent as string).indexOf(content) !== -1
		) {
			return i;
		}
	}
	return -1;
}

/**
 * Maps a rendered paragraph's text node to its source counterpart by
 * ordinal position among non-ignorable text children, which survives
 * footnote spans having altered the child lists. When the rendered node is
 * not a child of `renderedParent`, or the source has run out of text
 * children, the content-based `indexOfTextNode` result is used instead.
 *
 * @param {Node} node - Rendered text node to map.
 * @param {Element} renderedParent - Parent of the rendered text node.
 * @param {Element} sourceParent - Source paragraph to map into.
 * @param {string} hyphen - Hyphenation string for the content fallback.
 * @returns {object} The source child index and an offset adjustment of 0.
 */
export function indexOfTextNodeForOverflow(
	node: Node,
	renderedParent: Element,
	sourceParent: Element,
	hyphen: string
): { index: number; offsetAdjustment: number } {
	if (!isText(node)) {
		return { index: -1, offsetAdjustment: 0 };
	}

	let ordinal = 0;
	let found = false;
	for (let i = 0; i < renderedParent.childNodes.length; i++) {
		const renderedChild = renderedParent.childNodes[i];
		if (renderedChild === node) {
			found = true;
			break;
		}
		if (renderedChild.nodeType === 3 && !isIgnorable(renderedChild)) {
			ordinal++;
		}
	}
	if (!found) {
		return {
			index: indexOfTextNode(node, sourceParent, hyphen),
			offsetAdjustment: 0,
		};
	}

	let counter = 0;
	let lastTextIndex = -1;
	for (let i = 0; i < sourceParent.childNodes.length; i++) {
		const sourceChild = sourceParent.childNodes[i];
		if (sourceChild.nodeType === 3) {
			if (counter === ordinal) {
				return { index: i, offsetAdjustment: 0 };
			}
			if (!isIgnorable(sourceChild)) {
				counter++;
				lastTextIndex = i;
			}
		} else if (
			(sourceChild as HTMLElement).dataset &&
			(sourceChild as HTMLElement).dataset.note === "footnote"
		) {
			continue;
		}
	}

	if (lastTextIndex !== -1) {
		return { index: lastTextIndex, offsetAdjustment: 0 };
	}
	return {
		index: indexOfTextNode(node, sourceParent, hyphen),
		offsetAdjustment: 0,
	};
}

/**
 * Whether the node carries no rendering of its own: comment nodes and
 * whitespace-only text nodes are ignorable, everything else is not.
 *
 * @param {Node} node - Node to test.
 * @returns {boolean} True for ignorable nodes.
 */
export function isIgnorable(node: Node): boolean {
	return (
		node.nodeType === 8 ||
		(node.nodeType === 3 && isAllWhitespace(node))
	);
}

/**
 * Whether the node's text content holds nothing but tab, LF, CR and space
 * characters (the empty string counts).
 *
 * @param {Node} node - Node to test.
 * @returns {boolean} True when the content is all whitespace.
 */
export function isAllWhitespace(node: Node): boolean {
	return !notWhitespaceRe.test(node.textContent as string);
}

/**
 * Nearest preceding sibling that is neither a comment nor a whitespace
 * text node; does not climb or descend.
 *
 * @param {Node} sib - Node to start from.
 * @returns {Node|null} The previous significant sibling, or null.
 */
export function previousSignificantNode(sib: Node): Node | null {
	let node: Node | null = sib.previousSibling;
	while (node && isIgnorable(node)) {
		node = node.previousSibling;
	}
	return node;
}

/**
 * Nearest following sibling that is neither a comment nor a whitespace
 * text node; does not climb or descend.
 *
 * @param {Node} sib - Node to start from.
 * @returns {Node|null} The next significant sibling, or null.
 */
export function nextSignificantNode(sib: Node): Node | null {
	let node: Node | null = sib.nextSibling;
	while (node && isIgnorable(node)) {
		node = node.nextSibling;
	}
	return node;
}

/**
 * First ancestor (never the argument itself) whose `data-break-inside`
 * is exactly "avoid".
 *
 * @param {Node} node - Node to climb from.
 * @returns {Node|null} The avoid-break ancestor, or null.
 */
export function breakInsideAvoidParentNode(node: Node): Node | null {
	let parent = node.parentNode;
	while (parent) {
		if (
			(parent as HTMLElement).dataset &&
			(parent as HTMLElement).dataset.breakInside === "avoid"
		) {
			return parent;
		}
		parent = parent.parentNode;
	}
	return null;
}

/**
 * First ancestor (never the argument itself) whose `nodeName` equals
 * `nodeName` exactly; the climb stops at the limiter when one is given.
 *
 * @param {Node} node - Node to climb from.
 * @param {string} nodeName - Ancestor name to look for, case-sensitively.
 * @param {Node} [limiter] - Node at which the climb is cut short.
 * @returns {Node|undefined} The matching ancestor, or undefined.
 */
export function parentOf(
	node: Node,
	nodeName: string,
	limiter?: Node
): Node | undefined {
	if (limiter && node === limiter) {
		return undefined;
	}
	let parent: Node | null = node.parentNode;
	while (parent) {
		if (limiter && parent === limiter) {
			return undefined;
		}
		if (parent.nodeName === nodeName) {
			return parent;
		}
		parent = parent.parentNode;
	}
	return undefined;
}

/**
 * Removes every node the walker yields from the subtree rooted at
 * `content` (or at `this.dom` when no content is given). The filter
 * function follows standard NodeFilter semantics: accepted nodes are
 * removed, rejected and skipped nodes survive. The root itself survives.
 *
 * @param {Node} content - Subtree root to clean out.
 * @param {Function} [func] - NodeFilter acceptNode callback deciding
 * which nodes are removed.
 * @param {number} [what] - Node types to visit; all by default.
 * @returns {void} Nothing; the tree is mutated in place.
 */
export function filterTree(
	this: any,
	content: Node,
	func?: ((node: Node) => number) | null,
	what?: number
) {
	const root = content || this.dom;
	const createWalker = document.createTreeWalker as (
		rootNode: Node,
		whatToShow?: number,
		filter?: NodeFilter | null,
		expandEntityReferences?: boolean
	) => TreeWalker;
	const walker = createWalker.call(
		document,
		root,
		what || NodeFilter.SHOW_ALL,
		func ? { acceptNode: func } : null,
		false
	);

	let node = walker.nextNode();
	while (node) {
		const nextNode = walker.nextNode();
		node.parentNode!.removeChild(node);
		node = nextNode;
	}
}
