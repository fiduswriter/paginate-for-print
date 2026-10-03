import Handler from "../handler.js";
import type { HandlerSource } from "../handler.js";

/**
 * Handler that removes every `<script>` element from the parsed content
 * before pagination begins.
 *
 * The class member named `filter` is auto-registered (by the base Handler
 * constructor) onto the chunker's `filter` hook, which is triggered
 * synchronously on the parsed content fragment before any chunking or layout.
 * The removal is total and unconditional: no `type`-based exemption, no
 * disabling or hiding — matched scripts are detached from the tree entirely,
 * so they can never execute, reserve space, or be cloned into pages. Elements
 * whose local name is `script` in any namespace (including inline SVG) are
 * removed; `<noscript>` and script elements inside `<template>` content are
 * left untouched.
 */
class ScriptsFilter extends Handler {
	constructor(chunker?: HandlerSource, polisher?: HandlerSource, caller?: HandlerSource) {
		super(chunker, polisher, caller);
	}

	/**
	 * Removes every `<script>` element from the subtree rooted at `content`
	 * (excluding `content` itself, which is never tested). Mutates the tree
	 * in place; matched elements are detached via `remove()`, everything else
	 * keeps its order and identity.
	 * @param {DocumentFragment | HTMLElement} content - The parsed content
	 * fragment (or an element) to strip of script elements.
	 * @returns {void} Nothing; the effect is entirely the DOM mutation.
	 */
	filter(content: DocumentFragment | HTMLElement): void {
		const scripts = content.querySelectorAll("script");
		for (const script of Array.from(scripts)) {
			script.remove();
		}
	}
}

export default ScriptsFilter;
