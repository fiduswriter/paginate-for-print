/**
 * Clean-room rewrite of the CSS Generated Content running-strings module,
 * built from the behavioral specification in
 * `.pwf-cleanroom/specs/g06-genc/string-sets.spec.md`.
 */

import Handler, { type HandlerSource } from "../handler.js";
import csstree from "css-tree";
import type { CssNode, List } from "css-tree";
import { cleanPseudoContent } from "../../utils/css.js";

/** One parsed `string-set` pair: `<identifier> <func>(<value>)` on `selector`. */
interface StringSetValue {
	identifier: string;
	func: string;
	value: string;
	selector: string;
}

/** Registry of parsed `string-set` declarations, keyed by identifier. */
interface StringSetData {
	[identifier: string]: StringSetValue;
}

/** Raw last matched value per identifier, carried across pages. */
interface PageLastStringData {
	[name: string]: string | null;
}

/** The rule context the polisher's declaration walk passes to `onDeclaration`. */
interface RuleContext {
	ruleNode: CssNode;
	ruleItem?: List.Cursor;
	rulelist?: List;
}

/** The declaration context the polisher passes to `onContent`. */
interface DeclarationContext {
	declarationNode: CssNode;
	dItem?: List.Cursor;
	dList?: List;
}

/**
 * The raw value a single element contributes to a string: its full
 * `textContent` for `content`, the named attribute (empty when missing) for
 * `attr`, and `undefined` for any other function.
 */
function matchedValue(element: Element, set: StringSetValue): string | null | undefined {
	if (set.func === "content") {
		return element.textContent;
	}
	if (set.func === "attr") {
		return element.getAttribute(set.value) || "";
	}
	return undefined;
}

/**
 * Wraps a raw string value in double quotes after cleaning it for embedding
 * in a CSS string literal. A nullish raw value cleans to `undefined`, so it
 * is written as the literal quoted text `"undefined"`.
 */
function quotedValue(value: string | null | undefined): string {
	return "\"" + cleanPseudoContent(value as string | null) + "\"";
}

/**
 * Handles CSS Generated Content for Paged Media running strings: the
 * `string-set` property and the `string()` function.
 *
 * During the CSS phase (`onDeclaration`, `onContent`) every `string-set`
 * declaration is recorded in a per-identifier registry and every
 * `string(name, keyword)` function inside a `content` declaration is rewritten
 * in place into `var(--paged-string-<keyword>-<name>)`. During the layout
 * phase (`afterPageLayout`) the four CSS-defined values of each registered
 * string are computed for the finished page and written as quoted custom
 * properties on the page's root element.
 *
 * @class
 * @extends Handler
 */
class StringSets extends Handler {
	/** Registry of parsed `string-set` declarations, keyed by identifier. */
	stringSetSelectors: StringSetData;
	/** Last `string()` keyword processed by `onContent` (write-only side effect). */
	type?: string;
	/** Raw last matched value per identifier; accumulated across all pages. */
	pageLastString?: PageLastStringData;

	/**
	 * Creates the handler and subscribes its hooks.
	 *
	 * @param {Object} chunker - The chunker, exposing `afterPageLayout`.
	 * @param {Object} polisher - The polisher, exposing `onDeclaration` and
	 * `onContent`.
	 * @param {Object} caller - The caller (previewer), exposing preview hooks.
	 */
	constructor(chunker?: HandlerSource, polisher?: HandlerSource, caller?: HandlerSource) {
		super(chunker, polisher, caller);

		/**
		 * Stores parsed `string-set` declarations keyed by identifier; later
		 * declarations for the same identifier replace the record.
		 */
		this.stringSetSelectors = {};
	}

	/**
	 * Records `string-set` declarations in the registry.
	 *
	 * Declarations for other properties are ignored (case-sensitively). The
	 * selector stored for a declaration is the serialized prelude of the node
	 * the polisher's walk was rooted at — for a declaration reached through an
	 * at-rule's own declarations walk that is the at-rule's prelude, which is
	 * why a `string-set` inside `@media` ends up keyed to the media prelude
	 * (the double visit's second record overwrites the first).
	 *
	 * Identifier/function/argument lists are zipped positionally, so excess
	 * identifiers keep records with `undefined` in the missing slots.
	 *
	 * @param {Object} declaration - The CSS declaration node.
	 * @param {Object} dItem - Declaration item (not used).
	 * @param {Object} dList - Declaration list (not used).
	 * @param {Object} rule - The rule context carrying `ruleNode`.
	 */
	onDeclaration(declaration: CssNode, dItem: List.Cursor, dList: List, rule: RuleContext): void {
		if (declaration.property !== "string-set") {
			return;
		}

		let selector = csstree.generate(rule.ruleNode.prelude);

		let identifiers: string[] = [];
		let functions: string[] = [];
		let values: string[] = [];

		declaration.value.children.forEach((node: CssNode) => {
			if (node.type === "Identifier") {
				identifiers.push(node.name);
			} else if (node.type === "Function") {
				functions.push(node.name);
				node.children.forEach((child: CssNode) => {
					if (child.type === "Identifier") {
						values.push(child.name);
					}
				});
			}
		});

		identifiers.forEach((identifier, i) => {
			this.stringSetSelectors[identifier] = {
				identifier: identifier,
				func: functions[i],
				value: values[i],
				selector: selector,
			};
		});
	}

	/**
	 * Rewrites `string(name, keyword)` functions inside `content` declarations
	 * into `var()` references to the engine-owned custom property, in place.
	 *
	 * The keyword defaults to `first` when absent or unrecognized; the last
	 * processed keyword is kept on `this.type`. Functions other than `string`
	 * pass through untouched, and because the node's name becomes `var`, a
	 * re-visit of the same node is a no-op.
	 *
	 * @param {Object} funcNode - The CSS function node.
	 * @param {Object} fItem - Function item (not used).
	 * @param {Object} fList - Function list (not used).
	 * @param {Object} declaration - The containing declaration context (not used).
	 * @param {Object} rule - The rule context (not used).
	 */
	onContent(funcNode: CssNode, fItem: List.Cursor, fList: List, declaration: DeclarationContext, rule: RuleContext): void {
		if (funcNode.name !== "string") {
			return;
		}

		let identifier;
		if (funcNode.children) {
			identifier = funcNode.children.first().name;
		}
		// Deliberately unguarded: an empty string() throws here, before any
		// rewrite is applied.
		this.type = funcNode.children.last().name;

		let keyword = this.type;
		let varName;
		if (keyword === "first" || keyword === "last" || keyword === "start" || keyword === "first-except") {
			varName = `--paged-string-${keyword}-${identifier}`;
		} else {
			varName = `--paged-string-first-${identifier}`;
		}

		funcNode.name = "var";
		let children = new csstree.List();
		children.appendData({
			type: "Identifier",
			loc: null,
			name: varName,
		});
		funcNode.children = children;
	}

	/**
	 * Computes each registered string's `first`, `last`, `start` and
	 * `first-except` value for the finished page and writes them as quoted
	 * custom properties on the page root element.
	 *
	 * Values of pages without matches carry the previous page's value forward;
	 * `first-except` is empty on pages where the string is set. The `start`
	 * value is the first value when the first matched element's top edge
	 * coincides exactly with the `.paged_page_content` box's top edge.
	 *
	 * @param {HTMLElement} fragment - The page's root element.
	 */
	afterPageLayout(fragment: HTMLElement): void {
		if (this.pageLastString === undefined) {
			this.pageLastString = {};
		}

		for (let name of Object.keys(this.stringSetSelectors)) {
			let set = this.stringSetSelectors[name];
			let selected = fragment.querySelectorAll(set.selector);

			// Read the previous-page carry value before any update.
			let stringPrevPage;
			if (name in this.pageLastString) {
				stringPrevPage = this.pageLastString[name];
			} else {
				stringPrevPage = "";
			}

			let varFirst: string | null | undefined;
			let varLast: string | null | undefined;
			let varStart: string | null | undefined;
			let varFirstExcept: string | null | undefined;

			if (selected.length === 0) {
				// Carry all four values forward; the recorded last value is
				// left untouched.
				varFirst = stringPrevPage;
				varLast = stringPrevPage;
				varStart = stringPrevPage;
				varFirstExcept = stringPrevPage;
			} else {
				// The carry state is advanced only here: by pages that have a
				// match, and only for content/attr functions.
				let lastMatched = selected[selected.length - 1];
				if (set.func === "content") {
					this.pageLastString[name] = lastMatched.textContent;
				} else if (set.func === "attr") {
					this.pageLastString[name] = lastMatched.getAttribute(set.value) || "";
				}

				let firstMatched = selected[0];
				varFirst = matchedValue(firstMatched, set);
				varLast = matchedValue(lastMatched, set);

				// Deliberately unguarded: a match outside a
				// .paged_page_content ancestor throws here.
				let selTop = firstMatched.getBoundingClientRect().top;
				let pageContent = firstMatched.closest(".paged_page_content");
				let pageContentTop = pageContent!.getBoundingClientRect().top;
				if (selTop === pageContentTop) {
					varStart = varFirst;
				} else {
					varStart = stringPrevPage;
				}

				varFirstExcept = "";
			}

			fragment.style.setProperty(`--paged-string-first-${name}`, quotedValue(varFirst));
			fragment.style.setProperty(`--paged-string-last-${name}`, quotedValue(varLast));
			fragment.style.setProperty(`--paged-string-start-${name}`, quotedValue(varStart));
			fragment.style.setProperty(`--paged-string-first-except-${name}`, quotedValue(varFirstExcept));
		}
	}
}

export default StringSets;
