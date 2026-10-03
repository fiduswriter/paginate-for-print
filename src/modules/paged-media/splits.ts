/**
 * Splits behavior handler: repairs the bookkeeping between a continuation
 * fragment rendered on the current page and the fragment of the same logical
 * element that stayed on the previous page.
 *
 * When the chunker breaks an element across two pages, the continuation on the
 * new page is a clone carrying `data-split-from` and — clones preserving
 * attributes — the same `data-ref` UUID as the fragment on the earlier page.
 * Running once per page, after its layout, this handler uses that invariant to
 *
 * 1. write `data-split-to` onto the earlier-page counterpart (explicitly
 *    marking it as "continues onto the next page"),
 * 2. write `data-split-original="true"` onto that counterpart when it is the
 *    first fragment of the split chain (it carries no `data-split-from`
 *    itself), and
 * 3. write `data-last-split-element="true"` plus
 *    `data-align-last-split-element="<value>"` on the *last* linked
 *    counterpart, so the base stylesheet rule
 *    `[data-align-last-split-element='justify'] { text-align-last: justify; }`
 *    can force its final line to justify when the author asked for justified
 *    text and did not set `text-align-last` themselves.
 *
 * The module is state-free and idempotent: all writes are plain value
 * assignments, so a page that triggers the hook more than once (forced, blank
 * or cloned pages) is simply re-linked against the same preceding page.
 */
import Handler, { type HandlerSource } from "../handler.js";

/**
 * Paged-media handler linking split fragments of one logical element across
 * consecutive pages and repairing last-line justification of the earlier
 * fragment.
 */
class Splits extends Handler {
	/**
	 * Creates an instance of the Splits handler.
	 *
	 * Forwards the engine objects to the base class, which stores them
	 * verbatim and auto-registers the {@link Splits#afterPageLayout} method,
	 * bound to the instance, on any source exposing an `afterPageLayout` hook
	 * (in practice the chunker's). No other hook matches an instance member.
	 *
	 * @param {HandlerSource} chunker - The chunker, exposing lifecycle hooks.
	 * @param {HandlerSource} polisher - The polisher, exposing CSS hooks.
	 * @param {HandlerSource} caller - The object that coordinates handlers.
	 */
	constructor(chunker?: HandlerSource, polisher?: HandlerSource, caller?: HandlerSource) {
		super(chunker, polisher, caller);
	}

	/**
	 * Called after a page has been laid out. Links every continuation
	 * fragment on the page (`[data-split-from]`) to its same-`data-ref`
	 * counterpart on the previous page and repairs that counterpart's
	 * last-line alignment.
	 *
	 * For each split element, in tree order, the first element with a matching
	 * `data-ref` on the previous page gets `data-split-to="<ref>"` (overwriting
	 * any pre-existing value) and — when it is not itself a continuation —
	 * `data-split-original="true"`. Afterwards, if the counterpart of the last
	 * split element was found, alignment metadata is written onto it via
	 * {@link Splits#handleAlignment}; a failed lookup for the last split
	 * suppresses the alignment step entirely, even when earlier splits were
	 * linked. Pages that are the first child of their container are skipped
	 * without writing anything.
	 *
	 * @param {HTMLElement} pageElement - Root element of the finished page.
	 * @param {any} page - The engine's Page object (unused).
	 * @param {any} breakToken - The break token that started this page
	 *   (unused; `undefined` for forced/blank/cloned pages).
	 * @param {any} chunker - The chunker instance (unused).
	 */
	afterPageLayout(pageElement: HTMLElement, page: any, breakToken: any, chunker: any): void {
		let splits = Array.from(pageElement.querySelectorAll<HTMLElement>("[data-split-from]"));

		let pages = pageElement.parentNode!;
		let index = Array.prototype.indexOf.call(pages.children, pageElement);

		// Nothing precedes the first page, so there is no counterpart to link.
		if (index === 0) {
			return;
		}

		let prevPage = pages.children[index - 1];

		// Holds the counterpart of the most recently processed split element —
		// matched or not — so that after the loop it is truthy if and only if
		// the last split element found its counterpart.
		let from: HTMLElement | null | undefined;

		for (let split of splits) {
			let ref = split.dataset.ref;

			from = prevPage.querySelector<HTMLElement>("[data-ref='" + ref + "']");

			if (from) {
				from.dataset.splitTo = ref!;
				if (!from.dataset.splitFrom) {
					from.dataset.splitOriginal = "true";
				}
			}
		}

		if (from) {
			this.handleAlignment(from);
		}
	}

	/**
	 * Writes last-line alignment metadata onto a split fragment's earlier
	 * counterpart.
	 *
	 * Reads the node's computed `text-align` and `text-align-last` and writes
	 * `data-last-split-element="true"` plus `data-align-last-split-element`:
	 * `"justify"` when the text is justified with automatic last-line
	 * alignment (the combination the base stylesheet's
	 * `[data-align-last-split-element='justify']` rule acts on), the raw
	 * computed `text-align-last` value otherwise. Writing the attribute feeds
	 * back into the computed style, but the outcome is stable — a re-read of
	 * `"justify"` takes the else branch and writes `"justify"` again.
	 *
	 * @param {HTMLElement} node - The element whose alignment metadata is
	 *   written. No validation; anything with a `dataset` and a computable
	 *   style works.
	 */
	handleAlignment(node: HTMLElement): void {
		let styles = window.getComputedStyle(node) as unknown as Record<string, string>;
		let align = styles["text-align"];
		let alignLast = styles["text-align-last"];

		node.dataset.lastSplitElement = "true";

		if (align === "justify" && alignLast === "auto") {
			node.dataset.alignLastSplitElement = "justify";
		} else {
			node.dataset.alignLastSplitElement = alignLast;
		}
	}
}

export default Splits;
