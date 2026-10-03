/**
 * Handler that marks elements whose `display` resolves to `none`.
 *
 * The module works in two phases. While the Polisher parses the author
 * stylesheets, every `display` declaration is captured in a map keyed by the
 * normalized selector text (`onDeclaration`). When the Chunker has parsed the
 * content into a detached fragment but before any page is built, the captured
 * rules are resolved against that fragment, the CSS cascade is approximated
 * per element (importance, then specificity, then stable source order), and
 * every element whose winning value is `none` — plus every element whose own
 * inline `style` sets `display: none` — is stamped with
 * `data-undisplayed="undisplayed"`.
 *
 * The module never removes, hides or restyles anything: the author's own
 * `display: none` rules keep applying at render time (pages live in the same
 * document). The marker exists purely for the engine's traversal logic, which
 * skips neighbors carrying a truthy `data-undisplayed`.
 *
 * No layout APIs are used anywhere: the content is a detached fragment at
 * `filter` time, so computed styles are meaningless and the marking depends
 * only on DOM structure and the captured CSS.
 *
 * @class
 * @extends Handler
 */
import Handler from "../handler.js";
import type { HandlerSource } from "../handler.js";
import csstree from "css-tree";
import type { CssNode, List } from "css-tree";
import { calculateSpecificity } from "clear-cut";
import { cleanSelector } from "../../utils/css.js";

/**
 * A captured `display` declaration, keyed by its selector text.
 *
 * Typing caveat: `important` is declared `boolean`, but css-tree keeps the
 * identifier after `!` verbatim, so at runtime it may hold a truthy string
 * (e.g. `"ie"` for the `!ie` hack). Any truthy value counts as important.
 */
interface DisplayRule {
	value: string;
	selector: string;
	specificity: number;
	important: boolean;
}

/**
 * Marks elements styled with `display: none` from CSS or inline styles.
 *
 * Subscribes purely by method name: `onDeclaration` is registered on the
 * Polisher's `onDeclaration` hook, `filter` on the Chunker's `filter` hook.
 */
class UndisplayedFilter extends Handler {
	/** Captured `display` declarations, keyed by selector text (last write wins per key). */
	displayRules: Record<string, DisplayRule>;

	/**
	 * Create an UndisplayedFilter instance.
	 *
	 * @param {HandlerSource} chunker - The chunker, exposing lifecycle hooks.
	 * @param {HandlerSource} polisher - The polisher, exposing CSS hooks.
	 * @param {HandlerSource} caller - The caller (previewer), exposing preview
	 * hooks.
	 */
	constructor(chunker?: HandlerSource, polisher?: HandlerSource, caller?: HandlerSource) {
		super(chunker, polisher, caller);
		this.displayRules = {};
	}

	/**
	 * Captures one CSS declaration during the Polisher's sheet walk.
	 *
	 * Only declarations whose property is exactly the lowercase string
	 * `display` are captured (css-tree preserves the raw source spelling, so
	 * `DISPLAY: none` is never captured). The display value is read as the
	 * name of the first child of the declaration's value children — a
	 * functional value such as `var(--x)` therefore records `var`, and only
	 * the lowercase identifier `none` can ever trigger marking later.
	 *
	 * The rule's prelude is serialized with css-tree's generator and split on
	 * commas; each resulting selector piece becomes a key in `displayRules`,
	 * fully replacing any previous entry for that key (last write wins). The
	 * Polisher's sheet walk visits declarations inside a nested `@media`/
	 * `@supports` block twice — once with the inner rule as context and once
	 * with the at-rule itself, producing a bogus key from the at-rule prelude;
	 * such keys are harmless (they are recorded like any other and simply
	 * never match, or are skipped as invalid selectors at query time).
	 *
	 * @param {CssNode} declaration - The declaration node being visited.
	 * @param {List.Cursor} dItem - The declaration's cursor in its list.
	 * @param {List} dList - The list containing the declaration.
	 * @param {Object} rule - The rule context; `ruleNode` is the subtree root
	 * the declaration walk started from (an ordinary Rule, or the at-rule
	 * itself for the double visit inside nested at-rule blocks).
	 */
	onDeclaration(
		declaration: CssNode,
		dItem: List.Cursor,
		dList: List,
		rule: { ruleNode: CssNode },
	): void {
		if (declaration.property !== "display") {
			return;
		}

		const selector = csstree.generate(rule.ruleNode.prelude);
		const value = declaration.value?.children?.first()?.name;

		for (const key of selector.split(",")) {
			this.displayRules[key] = {
				value,
				selector: key,
				specificity: calculateSpecificity(key),
				important: declaration.important as unknown as boolean,
			};
		}
	}

	/**
	 * Chunker-side filter: resolves the captured rules against the parsed
	 * content fragment and marks the elements whose winning `display` value
	 * is `none`, then independently marks every element whose inline
	 * `style.display` is exactly `none`.
	 *
	 * Only the `data-undisplayed` attribute is written; nothing is removed,
	 * hidden or restyled, and no element is ever un-marked.
	 *
	 * @param {HTMLElement | DocumentFragment} content - The parsed content
	 * fragment (detached; `querySelectorAll` is scoped to its descendants).
	 */
	filter(content: HTMLElement | DocumentFragment): void {
		const { matches, selectors } = this.sortDisplayedSelectors(
			content,
			this.displayRules,
		);

		matches.forEach((element, index) => {
			const rules = selectors[index];
			const winning = rules[rules.length - 1];
			if (winning.value === "none" && this.removable(element)) {
				element.dataset.undisplayed = "undisplayed";
			}
		});

		content.querySelectorAll<HTMLElement>("[style]").forEach((element) => {
			if (element.style.display === "none") {
				element.dataset.undisplayed = "undisplayed";
			}
		});
	}

	/**
	 * Comparison predicate sorting a single element's collected rules so that
	 * the most significant rule ends up LAST: a truthy `important` (string
	 * included — see the `!ie` hack) outranks everything, then ascending
	 * specificity; equal rules compare as 0, and `Array.prototype.sort`'s
	 * stability lets the rule pushed last win such ties. Must not depend on
	 * `this` (it is used as an unbound comparator reference).
	 *
	 * @param {DisplayRule} a - First rule.
	 * @param {DisplayRule} b - Second rule.
	 * @returns {number} Positive when `a` sorts after `b`, negative before,
	 * zero for full ties.
	 */
	sorter(a: DisplayRule, b: DisplayRule): number {
		if (a.important && !b.important) {
			return 1;
		}
		if (b.important && !a.important) {
			return -1;
		}
		return a.specificity - b.specificity;
	}

	/**
	 * Matches the given rules against `content` and buckets them per matched
	 * element.
	 *
	 * Iterates the rule map in key insertion order. For each rule the
	 * selector is tried with `content.querySelectorAll`; when that throws
	 * (invalid selector — at-rule preludes, engine-specific pseudo-elements,
	 * malformed input), it is retried once with `cleanSelector`, which strips
	 * the engine's `::footnote-call` / `::footnote-marker` names. If the
	 * retry also throws, the rule is silently skipped. Only descendants of
	 * `content` are tested — `content` itself is never matched or marked.
	 *
	 * @param {HTMLElement | DocumentFragment} content - The subtree to query.
	 * @param {Record<string, DisplayRule>} displayRules - Captured rules by
	 * selector text; defaults to an empty map.
	 * @returns {Object} `matches` (elements, first-encounter order) and the
	 * parallel `selectors`: per element, the rules matching it, sorted
	 * ascending with {@link UndisplayedFilter.sorter} (winner = last).
	 */
	sortDisplayedSelectors(
		content: HTMLElement | DocumentFragment,
		displayRules: Record<string, DisplayRule> = {},
	): { matches: HTMLElement[]; selectors: DisplayRule[][] } {
		const matches: HTMLElement[] = [];
		const selectors: DisplayRule[][] = [];

		for (const key in displayRules) {
			const rule = displayRules[key];
			let matched: NodeListOf<HTMLElement>;
			try {
				matched = content.querySelectorAll<HTMLElement>(rule.selector);
			} catch {
				try {
					matched = content.querySelectorAll<HTMLElement>(
						cleanSelector(rule.selector) as string,
					);
				} catch {
					continue;
				}
			}

			for (const element of Array.from(matched)) {
				const index = matches.indexOf(element);
				if (index === -1) {
					matches.push(element);
					selectors.push([rule]);
				} else {
					selectors[index].push(rule);
					selectors[index].sort(this.sorter);
				}
			}
		}

		return { matches, selectors };
	}

	/**
	 * Cascade guard for the CSS pass: an element carrying an inline
	 * `display` other than `none` (or the empty string) must beat any
	 * stylesheet rule, so it is not removable. Only the element's own inline
	 * style is consulted; style-less elements and elements with no inline
	 * `display` (or inline `display: none`) are removable.
	 *
	 * @param {HTMLElement} element - The candidate element.
	 * @returns {boolean} False iff the element has a style object whose
	 * inline `display` is neither empty nor `none`.
	 */
	removable(element: HTMLElement): boolean {
		if (element.style) {
			if (element.style.display !== "" && element.style.display !== "none") {
				return false;
			}
		}
		return true;
	}
}

export default UndisplayedFilter;