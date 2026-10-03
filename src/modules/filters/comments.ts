import Handler from "../handler.js";
import type { HandlerSource } from "../handler.js";
import { filterTree } from "../../utils/dom.js";

/**
 * Handler that removes every HTML comment node from the parsed content
 * before pagination starts.
 *
 * The class member named `filter` is auto-registered (by the base Handler
 * constructor) onto the chunker's `filter` hook, which is triggered
 * synchronously on the parsed content fragment after parsing and before
 * `afterParsed`. No comment text ever reaches a page.
 *
 * The filter is unconditional: every comment node in the subtree is deleted,
 * regardless of its content (ordinary comments, IE conditional comments,
 * `<?php ... ?>`-style constructs that browsers parse as comments). Nothing
 * else is touched: elements that held only comments survive as empty
 * elements, and surrounding text/whitespace is left for the other filters.
 */
class CommentsFilter extends Handler {
	constructor(chunker?: HandlerSource, polisher?: HandlerSource, caller?: HandlerSource) {
		super(chunker, polisher, caller);
	}

	/**
	 * Removes every comment node from the subtree rooted at `content`
	 * (excluding `content` itself, which a TreeWalker never yields).
	 * Mutates the tree in place; returns undefined.
	 * @param {DocumentFragment | HTMLElement} content - The parsed content
	 * fragment (or an element) to strip of comment nodes.
	 * @returns {void} Nothing; the tree is mutated in place.
	 */
	filter(content: DocumentFragment | HTMLElement): void {
		filterTree(content, null, NodeFilter.SHOW_COMMENT);
	}
}

export default CommentsFilter;