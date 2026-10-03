/**
 * Simulates `position: fixed` for paginated output: an element fixed to the
 * viewport has no meaning across a sequence of page boxes (browsers print a
 * fixed element at most once), so the author expectation — "this element
 * appears on every page" — is reproduced by re-inserting a copy of the
 * element at the top of every generated page.
 *
 * Works in three phases, tied to three lifecycle hooks:
 *
 * 1. **CSS parse time** (`onDeclaration`, fired by the polisher for every
 *    declaration of every processed stylesheet): whenever a `position: fixed`
 *    declaration is visited, the containing rule's selector text is recorded
 *    and the declaration is **removed from the stylesheet AST**, so the
 *    serialized output CSS never applies `position: fixed` to anything.
 * 2. **After content parse, before pagination** (`afterParsed`): every
 *    element in the parsed content matching one of the recorded selectors is
 *    forced to inline `position: absolute`, remembered in an instance list,
 *    and **detached from the content flow**. The detached originals are never
 *    re-inserted anywhere; they live on purely as clone templates.
 * 3. **After each page layout** (`afterPageLayout`): a deep clone of every
 *    remembered element is prepended to the finished page's page box. The
 *    clone carries the inline `position: absolute`, and the page box is
 *    `position: relative` (engine baseline stylesheet), so the remaining
 *    author offsets (`top`, `left`, …) place it identically on every page.
 *
 * The module never reads computed styles, never measures layout and never
 * positions the clones itself — placement is entirely whatever the surviving
 * author CSS says. Inline `style="position: fixed"` is not handled (only
 * stylesheet declarations are seen). No events, no console output.
 */

import Handler from "../handler.js";
import csstree from "css-tree";
import type { CssNode, List } from "css-tree";
import type { HandlerSource } from "../handler.js";

/** The shape this module requires of the polisher argument. */
interface PolisherSource extends HandlerSource {
	styleSheet: CSSStyleSheet;
}

/** The trailing context the `onDeclaration` hook passes, identifying the containing rule. */
interface RuleContext {
	ruleNode: CssNode;
	[key: string]: any;
}

/**
 * Paged-media behavior module that turns `position: fixed` elements into
 * per-page absolutely positioned clones.
 */
class PositionFixed extends Handler {
	/**
	 * The polisher's stylesheet object, stored at construction for API
	 * parity/external access. The class itself never reads it again. Stored
	 * as-is: a `null`/`undefined` value is accepted without complaint.
	 */
	styleSheet: CSSStyleSheet;

	/**
	 * Serialized selector text of every rule that contained a matching
	 * `position: fixed` declaration, one entry per matched declaration, in
	 * encounter order. Never cleared by the module.
	 */
	fixedElementsSelector: string[];

	/**
	 * Detached original elements that matched the recorded selectors, in
	 * processing order; cloned onto each page during layout. Never cleared
	 * by the module.
	 */
	fixedElements: HTMLElement[];

	/**
	 * Wires the handler against the engine objects. Forwards to super() for
	 * hook auto-registration (onDeclaration, afterParsed, afterPageLayout),
	 * then stores `polisher.styleSheet` (throws when polisher is falsy) and
	 * initializes the two empty collector arrays.
	 * @param {HandlerSource} chunker - The chunker, exposing lifecycle hooks.
	 * @param {PolisherSource} polisher - The polisher, exposing CSS hooks and
	 * its stylesheet object. Required at runtime: a falsy value throws a
	 * `TypeError` when its `styleSheet` is read.
	 * @param {HandlerSource} caller - The caller (previewer), exposing
	 * preview hooks.
	 */
	constructor(chunker?: HandlerSource, polisher?: PolisherSource, caller?: HandlerSource) {
		super(chunker, polisher, caller);
		this.styleSheet = polisher!.styleSheet;
		this.fixedElementsSelector = [];
		this.fixedElements = [];
	}

	/**
	 * Polisher hook, fired for every Declaration node of every processed
	 * stylesheet (a declaration inside `@media`/`@page` is visited twice per
	 * parse — removing it from the AST on the first visit neutralizes the
	 * second one).
	 *
	 * For a declaration whose property is exactly `position` and whose parsed
	 * value starts with the identifier `fixed` (both compared
	 * case-sensitively; `!important` and in-value comments still match):
	 *
	 * 1. The containing rule's prelude is serialized with `csstree.generate`
	 *    (csstree's canonical form: whitespace after commas and around
	 *    non-descendant combinators dropped, descendant combinator kept as a
	 *    single space) and pushed onto {@link fixedElementsSelector}.
	 * 2. The declaration is removed from its declaration list, so the
	 *    serialized output CSS no longer contains it and the rule's remaining
	 *    declarations survive.
	 *
	 * A declaration `position: ;` (empty value children) throws a `TypeError`
	 * reading `name` of the empty value's `first()` result; a literal
	 * `position: fixed` inside a bare `@page` block (no prelude) throws a
	 * `TypeError` from `csstree.generate(undefined)`. Both crashes are
	 * contractual and propagate out of the stylesheet parse.
	 * @param {CssNode} declaration - The CSS declaration node.
	 * @param {List.Cursor} dItem - The declaration's cursor in its list;
	 * removing it from {@link dList} removes the declaration from the AST.
	 * @param {List} dList - The list containing the declaration.
	 * @param {RuleContext} rule - The containing rule context; the walk is
	 * rooted at `rule.ruleNode` (the enclosing Rule for ordinary rules, the
	 * enclosing at-rule for the second, at-rule-rooted visit).
	 */
	onDeclaration(declaration: CssNode, dItem: List.Cursor | any, dList: List | any, rule: RuleContext): void {
		if (declaration.property === "position" &&
				declaration.value.children.first().name === "fixed") {
			const selector = csstree.generate(rule.ruleNode.prelude);
			this.fixedElementsSelector.push(selector);
			dList.remove(dItem);
		}
	}

	/**
	 * Chunker hook, fired once per flow after the source content has been
	 * parsed into its working tree and before any page is rendered.
	 *
	 * For each recorded selector (capture order), every descendant of the
	 * fragment matching it (document order) is: forced to inline
	 * `position: absolute` (replacing any pre-existing inline `position`
	 * declaration wholesale), pushed onto {@link fixedElements}, and detached
	 * from the flow. Detachment makes later passes blind: an element matching
	 * several selectors is registered exactly once, by the earliest recorded
	 * matching selector; nested fixed elements are registered (and therefore
	 * cloned per page) only if their selector is processed before their
	 * ancestor's. A selector string that is not a valid `querySelectorAll`
	 * selector throws a `DOMException` (`SyntaxError`) which propagates and
	 * aborts the whole preview.
	 * @param {DocumentFragment} fragment - The content root of the parsed
	 * flow.
	 */
	afterParsed(fragment: DocumentFragment): void {
		for (const selector of this.fixedElementsSelector) {
			const fixedElements = fragment.querySelectorAll<HTMLElement>(selector);
			for (const el of fixedElements) {
				el.style.setProperty("position", "absolute");
				this.fixedElements.push(el);
				el.remove();
			}
		}
	}

	/**
	 * Chunker hook, fired once per rendered page after the page's content has
	 * been laid out. Deep-clones every remembered element and prepends the
	 * clone to the page's `.paged_pagebox` (its first child, ahead of the
	 * page content area and margin boxes). Because every clone is inserted
	 * at `afterbegin`, the DOM order of the clones among themselves is the
	 * reverse of {@link fixedElements} order.
	 *
	 * One clone per element per call; calling it twice on the same page
	 * inserts a second, redundant set of clones (no deduplication). If the
	 * page element has no `.paged_pagebox` descendant, dereferencing the
	 * `querySelector` result for `insertAdjacentElement` throws a
	 * `TypeError`, which propagates and aborts the page render (contractual).
	 * @param {HTMLElement} pageElement - The full page element.
	 * @param {any} page - The page object (ignored).
	 * @param {any} breakToken - The break token (ignored; some trigger paths
	 * pass undefined).
	 */
	afterPageLayout(pageElement: HTMLElement, page: any, breakToken: any): void {
		for (const el of this.fixedElements) {
			const clone = el.cloneNode(true) as HTMLElement;
			pageElement.querySelector(".paged_pagebox")!
				.insertAdjacentElement("afterbegin", clone);
		}
	}
}

export default PositionFixed;
