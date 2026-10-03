import Handler from "../handler.js";
import type { HandlerSource } from "../handler.js";
import {
	filterTree,
	isElement,
	isIgnorable,
	nextSignificantNode,
	previousSignificantNode
} from "../../utils/dom.js";

/**
 * Single space used to replace a collapsed whitespace run.
 */
const singleSpace = " ";

/**
 * Handler that cleans whitespace-only text nodes out of the parsed content
 * before pagination starts.
 *
 * The class member named `filter` is auto-registered (by the base Handler
 * constructor) onto the chunker's `filter` hook, which is triggered
 * synchronously on the parsed content fragment after `beforeParsed` and
 * before `afterParsed`.
 *
 * A whitespace-only text node (TAB/LF/CR/SPACE characters only, longer than
 * one character) is either deleted or collapsed to a single space:
 *
 * - Inside a `<pre>` subtree (detected structurally via the parent's
 *   `closest("pre")`, never via computed `white-space` style) it is
 *   preserved verbatim.
 * - Whitespace runs with significant content on BOTH sides (skipping
 *   comments and other whitespace text nodes, without climbing) collapse to
 *   exactly one space — the interior case.
 * - Runs with significant content on at most one side (leading/trailing
 *   runs) are removed outright — the edge case.
 * - One-character runs, empty text nodes and text containing any other
 *   character (NBSP, form feed, vertical tab, real text) are never touched.
 *
 * Adjacent whitespace runs are decided independently and each collapses to
 * its own single-space node; merging them is left to CSS whitespace
 * processing in the browser.
 *
 * Known limitation (kept intentionally to stay behavior-identical):
 * sequences of whitespace should also be preserved when the parent element
 * has a CSS `white-space` value of `pre`, `pre-wrap` or `break-spaces`
 * (sequences preserved) or `pre-line` (sequences collapsed, newlines
 * preserved). Honor that by inspecting the parent's computed style.
 */
class WhiteSpaceFilter extends Handler {
	constructor(chunker?: HandlerSource, polisher?: HandlerSource, caller?: HandlerSource) {
		super(chunker, polisher, caller);
	}

	/**
	 * Removes or collapses every whitespace-only text node in the subtree
	 * rooted at `content` (excluding `content` itself, which a TreeWalker
	 * never yields). Mutates the tree in place.
	 * @param {DocumentFragment | HTMLElement} content - The parsed content
	 * fragment (or an element) to clean.
	 * @returns {void} Nothing; the tree is mutated in place.
	 */
	filter(content: DocumentFragment | HTMLElement): void {
		filterTree(content, (node: Node) => {
			return this.filterEmpty(node as Text);
		}, NodeFilter.SHOW_TEXT);
	}

	/**
	 * Decides the fate of a single text node, optionally mutating it.
	 *
	 * Returns `NodeFilter.FILTER_ACCEPT` when the node should be removed
	 * from its parent, `NodeFilter.FILTER_REJECT` when it should survive
	 * (possibly rewritten to a single space). Never mutates a node that
	 * fails the eligibility gate or sits inside a `<pre>` subtree.
	 * @param {Text} node - Text node to decide on.
	 * @returns {number} `NodeFilter.FILTER_ACCEPT` (1) to remove the node,
	 * `NodeFilter.FILTER_REJECT` (2) to keep it.
	 */
	filterEmpty(node: Text): number {
		// Eligibility gate: only runs of more than one character, made up
		// exclusively of TAB, LF, CR and SPACE, are candidates.
		const content = node.textContent;
		if (!content || content.length <= 1 || !isIgnorable(node)) {
			return NodeFilter.FILTER_REJECT;
		}

		// Pre preservation: check the DOM structure through the immediate
		// parent, not CSS computed styles (see the documented limitation).
		const parent = node.parentNode;
		if (isElement(parent) && parent.closest("pre")) {
			return NodeFilter.FILTER_REJECT;
		}

		// Significant-sibling scan: comments and other whitespace-only text
		// nodes are invisible to this decision; the scans never climb past
		// the parent nor descend into element children.
		const prev = previousSignificantNode(node);
		const next = nextSignificantNode(node);

		if (!prev && !next) {
			// Nothing significant besides this node: collapse to one space
			// but keep the node.
			node.textContent = singleSpace;
			return NodeFilter.FILTER_REJECT;
		}

		if (!prev || !next) {
			// The run touches one edge of the parent's significant content:
			// remove it entirely, without leaving a space behind.
			return NodeFilter.FILTER_ACCEPT;
		}

		// Interior run between two significant siblings: collapse to one
		// space and keep the node.
		node.textContent = singleSpace;
		return NodeFilter.FILTER_REJECT;
	}
}

export default WhiteSpaceFilter;
