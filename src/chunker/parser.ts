/**
 * Content parser: the entry point of the chunker pipeline.
 *
 * Takes the user-supplied content (an HTML string or a live DOM node) and
 * normalizes it into a detached DOM tree in which every element carries a
 * unique `data-ref` attribute (a version-4-shaped UUID string) and every
 * element with an `id` also carries a `data-id` attribute mirroring that id.
 *
 * These attributes are the stable per-element identity used by the rest of
 * the pagination engine: later stages re-locate the original source element
 * of a rendered node via its `data-ref`, and the CSS polisher rewrites ID
 * selectors in author stylesheets into `[data-id="..."]` attribute selectors
 * so that `#id` rules keep working after chunking.
 *
 * The class is consumed as a factory: the `new ContentParser(content)`
 * expression evaluates to the parsed fragment/node itself (see the
 * constructor), not to the instance. The instance is discarded; only the
 * side effects — the annotated DOM — matter.
 */

import { UUID } from "../utils/utils.js";

class ContentParser {
	/**
	 * The parsed/annotated content. Set by the constructor for string and
	 * Node input; `undefined` when the input was neither. Never re-assigned
	 * afterwards except by `destroy()`.
	 */
	dom?: DocumentFragment | Node;

	/**
	 * Optional reference registry mapping `data-ref` values to elements.
	 * The class itself never writes to it; it starts as `undefined` and can
	 * only be populated by external code. Exists for API compatibility only.
	 */
	refs?: Record<string, HTMLElement>;

	/**
	 * Factory-style constructor. The `new` expression evaluates to:
	 *
	 * - the very same node object, when `content` is a `Node` (truthy with a
	 *   truthy `nodeType`): its descendant elements are annotated in place,
	 *   no cloning occurs;
	 * - a new detached, annotated `DocumentFragment`, when `content` is a
	 *   string (the empty string included);
	 * - the ContentParser instance itself, for anything else (the
	 *   constructor then returns without an object value, which JavaScript
	 *   ignores, leaving `dom` and `refs` undefined).
	 *
	 * The `cb` argument is accepted and completely ignored; no callback is
	 * ever invoked and no input throws.
	 *
	 * @param {string | Node} content - HTML markup string or DOM node to parse.
	 * @param {unknown} cb - Unused; accepted for signature compatibility.
	 */
	constructor(content: string | Node, cb?: unknown) {
		if (content && (content as Node).nodeType) {
			const node = content as Node;
			this.addRefs(node);
			this.dom = node;
			return node as unknown as ContentParser;
		}

		if (typeof content === "string") {
			this.dom = this.parse(content);
			return this.dom as unknown as ContentParser;
		}

		// Nothing to parse: `dom` and `refs` stay undefined and the explicit
		// non-object return value is ignored, so the `new` expression
		// evaluates to the instance itself.
	}

	/**
	 * Parses an HTML markup string into a new detached `DocumentFragment`
	 * owned by the current document, using the fragment parsing algorithm in
	 * the context of the live document (`document.createRange()` followed by
	 * `range.createContextualFragment`). Multiple top-level nodes are kept as
	 * siblings in source order, interstitial whitespace and comments are
	 * preserved, relative URLs resolve against the document's base URL, and
	 * `<script>` elements are created but marked already-started so they do
	 * not execute even when the fragment is later inserted.
	 *
	 * @param {string} markup - HTML markup to parse.
	 * @param {unknown} mime - Unused; accepted for signature compatibility.
	 * @returns {DocumentFragment} The parsed and annotated fragment.
	 */
	parse(markup: string, mime?: unknown): DocumentFragment {
		const range = document.createRange();
		const fragment = range.createContextualFragment(markup);
		this.addRefs(fragment);
		return fragment;
	}

	/**
	 * Annotates the given node in place (never cloned) by assigning
	 * `data-ref` / `data-id` attributes to its descendant elements. When
	 * `contents` is itself an Element, the element is not annotated; only
	 * its descendants are.
	 *
	 * @param {Node} contents - Node to annotate.
	 * @returns {Node} The very same node object.
	 */
	add(contents: Node): Node {
		this.addRefs(contents);
		return contents;
	}

	/**
	 * Walks the descendant elements of `content` in document order with a
	 * `TreeWalker` (element nodes only, root never visited) and, for each
	 * visited element:
	 *
	 * 1. assigns a fresh `data-ref` UUID unless the element already has one
	 *    (pre-existing values are preserved, making the operation
	 *    idempotent), and
	 * 2. mirrors a non-empty `element.id` into the `data-id` attribute,
	 *    overwriting any previous `data-id`. Elements without an id keep
	 *    any stale `data-id` untouched.
	 *
	 * Works on detached trees; it never attaches or detaches anything.
	 * Annotation is by `setAttribute`, so it applies to any element
	 * namespace (SVG elements included).
	 *
	 * @param {Node} content - Root of the tree to annotate.
	 */
	addRefs(content: Node): void {
		const walker = document.createTreeWalker(
			content,
			NodeFilter.SHOW_ELEMENT,
		);
		let element = walker.nextNode() as Element | null;
		while (element) {
			if (!element.hasAttribute("data-ref")) {
				element.setAttribute("data-ref", UUID());
			}
			if (element.id) {
				element.setAttribute("data-id", element.id);
			}
			element = walker.nextNode() as Element | null;
		}
	}

	/**
	 * Looks up an element by its `data-ref` value in the reference registry.
	 * The registry is never populated by the class itself, so in practice
	 * this returns `undefined` unless external code has assigned `refs`.
	 *
	 * @param {string} ref - The `data-ref` value to look up.
	 * @returns {HTMLElement | undefined} The registered element, if any.
	 */
	find(ref: string): HTMLElement | undefined {
		return this.refs?.[ref];
	}

	/**
	 * Clears the instance's fields. Performs no DOM cleanup: no nodes or
	 * attributes are removed anywhere.
	 */
	destroy(): void {
		this.refs = undefined;
		this.dom = undefined;
	}
}

export default ContentParser;
