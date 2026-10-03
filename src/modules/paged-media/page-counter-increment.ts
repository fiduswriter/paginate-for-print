/**
 * Page counter increment handler: lets authors drive the special CSS `page`
 * counter from regular content rules.
 *
 * A declaration like `h1 { counter-increment: page 2 }` in author CSS is
 * intercepted during stylesheet polishing, **removed from the author
 * stylesheet** (so the browser never applies it natively to the content
 * element, which would double-count against the polyfilled page counting),
 * and recorded under the containing rule's normalized selector. Later, once
 * the content DOM has been parsed but before any page is rendered, every
 * recorded increment is re-emitted into the polisher's work stylesheet as an
 * equivalent CSS custom property rule:
 *
 * ```
 * <selector> { --paged-page-counter-increment: <number> }
 * ```
 *
 * The engine's baseline stylesheet defaults `--paged-page-counter-increment`
 * to `1` on `:root` and declares
 * `.paged_page { counter-increment: page var(--paged-page-counter-increment) }`,
 * so each rendered page increments the `page` counter by the value the custom
 * property resolves to on the page element. Because custom properties are
 * inherited, a re-emitted rule moves the author's increment onto the pages
 * whenever its selector matches an ancestor of the rendered pages (or a page
 * element itself); a selector matching only content inside a page has no
 * effect on that page's counter.
 *
 * Declarations of other counters are left entirely to the sibling
 * `Counters` handler (registered earlier); declarations inside `@page` (and
 * its margin boxes) belong to the `@page` machinery and are excluded here.
 */

import Handler from "../handler.js";
import csstree from "css-tree";
import type { CssNode, List } from "css-tree";
import type { HandlerSource } from "../handler.js";

/**
 * The polisher, as this handler consumes it: a handler source that also
 * carries the CSSOM work stylesheet the emitted rules are appended to.
 */
interface PolisherSource extends HandlerSource {
	styleSheet: CSSStyleSheet;
}

/**
 * The containing rule or at-rule of a visited declaration, as passed by the
 * polisher's declaration walk. Only `ruleNode` is read; the polisher also
 * supplies `ruleItem` / `rulelist`, tolerated through the index signature.
 */
interface RuleContext {
	ruleNode: CssNode;
	[key: string]: any;
}

/**
 * One captured page counter increment, keyed by normalized selector.
 * `number` is declared as a number but may hold the raw string of a css-tree
 * Number node at runtime (e.g. `"2"`, `"-1"`); only the implicit default is a
 * genuine JS number.
 */
interface IncrementRecord {
	selector: string;
	number: number;
}

/**
 * The handler's page counter bookkeeping. `resets` exists for symmetry with
 * the sibling counters handler and stays an empty object forever.
 */
interface PageCounterState {
	name: string;
	increments: Record<string, IncrementRecord>;
	resets: Record<string, unknown>;
}

/**
 * Paged-media behavior module that routes out-of-`@page`
 * `counter-increment: page` declarations into the
 * `--paged-page-counter-increment` custom property.
 */
class PageCounterIncrement extends Handler {
	/**
	 * The CSSOM object of the polisher's work stylesheet; emitted
	 * custom-property rules are appended here.
	 */
	styleSheet: CSSStyleSheet;

	/**
	 * Tracks page counter increments (and, inertly, resets) by normalized
	 * selector string. Only the "page" counter is processed.
	 */
	pageCounter: PageCounterState;

	/**
	 * Wires the handler against the engine objects; subscribes
	 * `onDeclaration` to the polisher's `onDeclaration` hook and
	 * `afterParsed` to the chunker's `afterParsed` hook via the base class's
	 * name-matching auto-registration, then captures the polisher's work
	 * stylesheet and starts a fresh, per-instance increments registry.
	 *
	 * @param {HandlerSource} chunker - The chunker, exposing lifecycle hooks.
	 * @param {HandlerSource} polisher - The polisher, exposing CSS hooks and
	 * the work stylesheet.
	 * @param {HandlerSource} caller - The caller (previewer), exposing
	 * preview hooks.
	 */
	constructor(chunker?: HandlerSource, polisher?: PolisherSource, caller?: HandlerSource) {
		super(chunker, polisher, caller);

		this.styleSheet = polisher!.styleSheet;

		this.pageCounter = {
			name: "page",
			increments: {},
			resets: {},
		};
	}

	/**
	 * `onDeclaration` hook, fired by the polisher for every declaration of
	 * every parsed stylesheet (rules nested in `@media` / `@supports`
	 * included, `@import`ed sheets recursively). For a declaration whose
	 * property is exactly `counter-increment` that names the `page` counter
	 * outside `@page`, removes the declaration from the stylesheet AST so it
	 * never reaches the browser natively; anything else is left untouched.
	 *
	 * Removing the current item mid-walk is safe: the css-tree `List` is
	 * walk-cursor aware, so iteration continues with the next declaration of
	 * the same block.
	 *
	 * @param {CssNode} declaration - The visited css-tree Declaration node.
	 * @param {List.Cursor} dItem - The declaration's cursor in `dList`.
	 * @param {List} dList - The declaration list of the containing block.
	 * @param {RuleContext} rule - The containing rule context; only
	 * `rule.ruleNode` is consulted.
	 */
	onDeclaration(declaration: CssNode, dItem: List.Cursor | any, dList: List | any, rule: RuleContext): void {
		if (declaration.property === "counter-increment") {
			const increment = this.handleIncrement(declaration, rule);

			if (increment) {
				dList.remove(dItem);
			}
		}
	}

	/**
	 * `afterParsed` hook, fired once per pagination run after the content
	 * fragment is parsed and before any page is created. Emits one custom
	 * property rule per captured increment — in registry insertion order
	 * (first-capture order of the selectors) — at the tail of the work
	 * stylesheet:
	 *
	 * ```
	 * <selector> { --paged-page-counter-increment: <number> }
	 * ```
	 *
	 * The parsed content fragment argument is deliberately ignored; the
	 * method never looks at the DOM. Re-firing appends the rules again (no
	 * dedup, no registry reset).
	 *
	 * @param {unknown} _ - The parsed content fragment; unused.
	 */
	afterParsed(_: unknown): void {
		for (const selector in this.pageCounter.increments) {
			const increment = this.pageCounter.increments[selector];
			this.insertRule(`${increment.selector} { --paged-page-counter-increment: ${increment.number} }`);
		}
	}

	/**
	 * Parses one `counter-increment` declaration and decides whether it names
	 * the `page` counter outside `@page`; if so, records the increment under
	 * the containing rule's normalized selector and returns the record.
	 *
	 * Decision pipeline:
	 *
	 * 1. The value's first child is the counter identifier; the increment
	 *    number is the raw `.value` of the *last* child when the value has
	 *    more than one component (whitespace and operator nodes included in
	 *    the count — no sign normalization, no numeric validation), otherwise
	 *    the implicit default `1`.
	 * 2. Synthetic `target-counter-*` names are reserved for the
	 *    target-cross-reference machinery and stay in the stylesheet.
	 * 3. Any identifier other than (case-sensitive) `page` is ignored — an
	 *    empty value or a leading non-identifier component bails here too.
	 * 4. Declarations inside an `@page` at-rule (margin boxes included) are
	 *    managed by the `@page` machinery and ignored; this check happens
	 *    before selector generation, so an `@page` node's missing prelude is
	 *    never touched.
	 * 5. The containing rule's selector prelude is serialized with
	 *    `csstree.generate` (normalizing away spaces after commas and around
	 *    non-descendant combinators) and used as the registry key; a
	 *    re-capture for the same selector overwrites the previous record.
	 *
	 * @param {CssNode} declaration - The `counter-increment` Declaration node.
	 * @param {RuleContext} rule - The containing rule context.
	 * @returns {IncrementRecord | undefined} The captured record, or
	 * `undefined` when the declaration does not qualify.
	 */
	handleIncrement(declaration: CssNode, rule: RuleContext): IncrementRecord | undefined {
		const children = declaration.value.children;
		const identifier = children.first();
		const number = children.getSize() > 1 ? children.last().value : 1;
		const name = identifier === null ? undefined : identifier.name;

		// Synthetic names consumed by the target-cross-reference machinery
		// must survive in the stylesheet untouched.
		if (typeof name === "string" && name.startsWith("target-counter-")) {
			return undefined;
		}

		// Page-only filter (case-sensitive); also bails on empty values and
		// on values whose first component is not an identifier.
		if (name !== "page") {
			return undefined;
		}

		// Declarations inside `@page` (its margin boxes included) belong to
		// the `@page` machinery, not here.
		if (rule.ruleNode.name === "page" && rule.ruleNode.type === "Atrule") {
			return undefined;
		}

		const selector = csstree.generate(rule.ruleNode.prelude);
		const increment = { selector, number };

		this.pageCounter.increments[selector] = increment;

		return increment;
	}

	/**
	 * Appends a rule to the tail of the polisher's work stylesheet CSSOM.
	 * A rule text the browser cannot parse (e.g. an invalid selector) makes
	 * `CSSStyleSheet.insertRule` throw a `DOMException`, which propagates
	 * synchronously; no other validation is performed.
	 *
	 * @param {string} rule - The full rule text to insert.
	 */
	insertRule(rule: string): void {
		this.styleSheet.insertRule(rule, this.styleSheet.cssRules.length);
	}
}

export default PageCounterIncrement;
