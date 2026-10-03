/**
 * Lists: keeps the native numbering of ordered lists (`<ol>`) intact across
 * page breaks.
 *
 * When the chunker splits an `<ol>` that spans pages, each continuation
 * fragment on a later page is a fresh `<ol>` element as far as the browser is
 * concerned; left alone, the browser would restart its native numbering at 1.
 * This module prevents that in two phases:
 *
 * 1. Before layout (`afterParsed`): every element child of every `<ol>` in
 *    the parsed content is annotated with a `data-item-num` attribute
 *    holding its absolute item number as a decimal string. These annotations
 *    are ordinary attributes, so the chunker's split/clone machinery carries
 *    them onto every continuation fragment automatically.
 * 2. After each page is laid out (`afterPageLayout`): every `<ol>` found
 *    inside the finished page box has its `start` IDL attribute reassigned
 *    to the `data-item-num` value of its first element child. The browser's
 *    native list numbering then resumes from the correct absolute number,
 *    both on continuation fragments and (harmlessly) on unsplit lists.
 *
 * The mechanism is deliberately CSS-counter-free and never inspects
 * `data-split-from` / `data-split-to`: numbering continuity is achieved
 * solely through the `start` attribute. `<ul>` lists are ignored entirely,
 * the `reversed` attribute is ignored (numbers always ascend by 1) and the
 * `value` attribute on individual `<li>` elements is ignored (numbering is
 * purely positional). No layout measurement is performed.
 */

import Handler from "../handler.js";
import type { HandlerSource } from "../handler.js";

class Lists extends Handler {
	/**
	 * Wires the handler against the engine objects. All three arguments are
	 * forwarded to the Handler base class, whose constructor merges the
	 * sources' hooks maps and auto-registers the `afterParsed` and
	 * `afterPageLayout` methods wherever matching hooks exist. No additional
	 * state is initialized; constructing a standalone instance with no
	 * arguments produces an inert handler.
	 * @param {HandlerSource} chunker - The chunker, exposing lifecycle hooks.
	 * @param {HandlerSource} polisher - The polisher, exposing CSS hooks.
	 * @param {HandlerSource} caller - The caller (previewer), exposing
	 * preview hooks.
	 */
	constructor(chunker?: HandlerSource, polisher?: HandlerSource, caller?: HandlerSource) {
		super(chunker, polisher, caller);
	}

	/**
	 * Annotates every element child of every `<ol>` in the parsed content
	 * with its absolute item number, before any page is rendered. The
	 * annotation is an ordinary attribute, so the chunker's split/clone
	 * machinery carries it onto every continuation fragment automatically.
	 *
	 * Nested lists are each annotated independently; `<ul>` elements and
	 * their children are untouched. A content root that is itself an `<ol>`
	 * element is not processed (querySelectorAll never matches the root),
	 * although any `<ol>` descendants of it are.
	 * @param {DocumentFragment | HTMLElement} content - The content root of
	 * the parsed flow.
	 */
	afterParsed(content: DocumentFragment | HTMLElement): void {
		const lists = content.querySelectorAll("ol");
		for (const list of lists) {
			this.addDataNumbers(list);
		}
	}

	/**
	 * Rewrites the `start` attribute of every `<ol>` inside a finished page
	 * box so that the browser's native numbering resumes from the absolute
	 * number of the list's first rendered item. Runs for every `<ol>` on
	 * every page, split or not: an unsplit list gains an explicit `start`
	 * equal to its first item's number (typically `start="1"` it never had).
	 *
	 * The assigned value is the raw `data-item-num` string of the first
	 * element child (or `undefined` if the attribute is absent), passed
	 * through the reflected `unsigned long` IDL attribute; the conversion is
	 * therefore the browser's WebIDL coercion (NaN/±Infinity → 0, truncation
	 * toward zero, modulo 2³² wrapping) and the coerced value is written
	 * back into the `start` content attribute. Lists without any element
	 * children are skipped entirely, leaving their `start` untouched.
	 *
	 * This hook fires after layout; the attribute write only changes which
	 * marker glyphs the browser renders and never requires re-measuring the
	 * page.
	 * @param {HTMLElement} pageElement - The full page box element.
	 * @param {any} page - The page object (ignored).
	 * @param {any} breakToken - The break token (ignored; some trigger paths
	 * pass undefined).
	 * @param {any} chunker - The chunker instance (ignored).
	 */
	afterPageLayout(pageElement: HTMLElement, page: any, breakToken: any, chunker: any): void {
		const lists = pageElement.getElementsByTagName("ol");
		for (const list of lists) {
			const first = list.firstElementChild;
			if (!first) {
				continue;
			}
			// Assign the raw string/undefined through the reflected unsigned
			// long IDL attribute; the WebIDL coercion happens in the setter
			// and the coerced value is written back to the content attribute.
			list.start = (first as HTMLElement).dataset.itemNum as unknown as number;
		}
	}

	/**
	 * Tags the element children of a single ordered list with their absolute
	 * item numbers. The starting number is the `start` content attribute
	 * parsed with base-10 `parseInt` (whose leniencies apply: leading
	 * whitespace, signs, truncation, early garbage termination; empty or
	 * unparseable values fall back to 1), and every element child —
	 * regardless of tag name — receives `data-item-num="<number>"`,
	 * overwriting any pre-existing value. The `start` attribute itself is
	 * never modified.
	 * @param {HTMLOListElement} list - The ordered list to annotate.
	 */
	addDataNumbers(list: HTMLOListElement): void {
		let start = 1;
		if (list.hasAttribute("start")) {
			start = parseInt(list.getAttribute("start") as string, 10);
			if (isNaN(start)) {
				start = 1;
			}
		}
		const children = list.children;
		for (let i = 0; i < children.length; i++) {
			children[i].setAttribute("data-item-num", String(i + start));
		}
	}
}

export default Lists;
