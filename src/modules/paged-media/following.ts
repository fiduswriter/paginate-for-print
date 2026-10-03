/**
 * Preserves *adjacent sibling* (`+`) matching across pagination.
 *
 * Once content has been distributed into page boxes the browser's native
 * adjacent sibling combinator no longer means what the author wrote: the two
 * siblings may have landed in different page boxes (an `h1 + p` rule stops
 * matching when the `h1` stayed on the previous page), and a split element's
 * continuation is a clone whose sibling context differs from the source. This
 * handler therefore converts every author rule whose selector text contains a
 * `+` into a pre-pagination snapshot:
 *
 * 1. CSS phase (`onRule`, fired per CSS rule while each author stylesheet is
 *    parsed): qualifying rules are recorded in the `selectors` map (selector
 *    text → generated id + declarations) and removed from the stylesheet AST,
 *    so the original sibling-dependent rule never reaches the output CSS.
 *    The combinator is never validated: any `+` anywhere in the serialized
 *    selector text triggers capture (including inside `:nth-child(2n+1)`
 *    arguments or attribute values), while `~`, `>` and descendant
 *    combinators do not.
 * 2. DOM phase (`afterParsed`, fired after the source content is parsed and
 *    before pagination starts): each recorded selector is evaluated verbatim
 *    against the still-original content tree, every match is stamped with the
 *    generated id in a `data-following` attribute (comma-appending when the
 *    element already carries tokens from other selectors), and one
 *    attribute-substring rule carrying the recorded declarations is appended
 *    to the polisher's stylesheet.
 *
 * Why the styling survives page breaks: the attributes are set on the
 * *content* fragment elements before chunking; the chunker moves those very
 * elements into page boxes (attributes travel with the node), and when an
 * element splits across a page boundary its continuation is a deep clone,
 * and native `cloneNode` copies all attributes — so every page fragment of
 * the element still carries `data-following` and still matches the injected
 * rule. The module itself never inspects `data-split-from`/`data-split-to`
 * and performs no re-matching after a split.
 */
import Handler from "../handler.js";
import csstree from "css-tree";
import type { CssNode, List } from "css-tree";
import type { HandlerSource } from "../handler.js";
import { UUID } from "../../utils/utils.js";

/**
 * The polisher's shape as required by this handler: the base-class source
 * plus the live stylesheet the converted rules are appended to.
 */
interface PolisherSource extends HandlerSource {
	styleSheet: CSSStyleSheet;
}

/**
 * Converts adjacent-sibling rules into pre-pagination data-attribute
 * snapshots, as described in the module documentation.
 */
class Following extends Handler {
	/**
	 * The polisher's live stylesheet, captured at construction; the sole
	 * destination of the injected attribute-based rules (appended at the
	 * tail).
	 */
	styleSheet: CSSStyleSheet;

	/**
	 * The module's only cross-phase state. Keys are serialized selector
	 * fragments (split on every comma); values are `[id, declarations]`
	 * tuples where the id is `"following-"` followed by a fresh UUID — minted
	 * once per qualifying rule, so all comma pieces of one rule share it —
	 * and the declarations are the rule's serialized block with all braces
	 * stripped. Fragments shared by several rules keep the first rule's id
	 * and accumulate their declarations joined with `;`.
	 */
	selectors: Record<string, [string, string]>;

	/**
	 * Wires the handler against the engine objects and captures the
	 * polisher's stylesheet.
	 *
	 * @param {HandlerSource} chunker - The chunker, exposing lifecycle hooks.
	 * @param {PolisherSource} polisher - The polisher, exposing CSS hooks
	 * and the stylesheet rules are injected into.
	 * @param {HandlerSource} caller - The caller (previewer), exposing
	 * preview hooks.
	 */
	constructor(chunker?: HandlerSource, polisher?: PolisherSource, caller?: HandlerSource) {
		super(chunker, polisher, caller);
		this.styleSheet = polisher!.styleSheet;
		this.selectors = {};
	}

	/**
	 * Polisher hook, fired once per CSS rule of every processed stylesheet —
	 * top-level rules and rules nested inside `@media`/`@supports` alike.
	 *
	 * Rules whose serialized selector text contains a `+` character anywhere
	 * are recorded in the `selectors` map and removed from the stylesheet
	 * AST; all other rules are left completely untouched. The selector is not
	 * parsed or normalized beyond what `csstree.generate` produces (the
	 * compact form), and the selector text is split on every comma character
	 * (a naive split that does not respect commas inside strings or argument
	 * lists).
	 *
	 * @param {CssNode} ruleNode - The CSS rule node.
	 * @param {List.Cursor} ruleItem - The rule's cursor in its list.
	 * @param {List} rulelist - The list containing the rule (the
	 * stylesheet's top-level list or an at-rule block's inner list).
	 */
	onRule(ruleNode: CssNode, ruleItem: List.Cursor | any, rulelist: List | any): void {
		const selector = csstree.generate(ruleNode.prelude);

		if (!selector.match(/\+/)) {
			return;
		}

		// Serialize the block and strip every brace character. The compact
		// form joins declarations with `;` and preserves letter case; inner
		// braces (from structures that survived parsing) are stripped too.
		const declarations = csstree.generate(ruleNode.block).replace(/[{}]/g, "");

		// A fresh id per qualifying rule — not per selector fragment and not
		// per element.
		const uuid = "following-" + UUID();

		selector.split(",").forEach((fragment) => {
			const known = this.selectors[fragment];
			if (!known) {
				this.selectors[fragment] = [uuid, declarations];
			} else {
				// A second rule with the same selector text contributes its
				// declarations under the first rule's id.
				known[1] += ";" + declarations;
			}
		});

		rulelist.remove(ruleItem);
	}

	/**
	 * Chunker lifecycle hook, fired once per render after the content DOM is
	 * parsed and before pagination begins. Applies the recorded selectors to
	 * the parsed content fragment. The chunker argument the hook passes as a
	 * second parameter is ignored.
	 *
	 * @param {DocumentFragment} parsed - The parsed source content.
	 */
	afterParsed(parsed: DocumentFragment): void {
		this.processSelectors(parsed, this.selectors);
	}

	/**
	 * Applies the recorded selectors to the parsed content DOM and injects
	 * the converted rules.
	 *
	 * For each recorded selector, in insertion order: the selector text is
	 * evaluated verbatim against the fragment by the host, every match is
	 * tagged with the selector's id in a `data-following` attribute (a
	 * non-empty existing value gets the id appended after a comma, with no
	 * space; an absent or empty value is replaced), and one
	 * attribute-substring rule of the exact shape
	 * `*[data-following*='<id>'] { <declarations>; }` is appended at the very
	 * end of the polisher's stylesheet.
	 *
	 * An invalid selector key throws a `DOMException` (SyntaxError) and
	 * aborts the whole pass; mutations from earlier selectors persist. An
	 * empty selectors map is a complete no-op. Running twice with the same
	 * state is not idempotent: ids accumulate and duplicate rules are
	 * inserted.
	 *
	 * @param {DocumentFragment} parsed - The parsed source content.
	 * @param {Record<string, [string, string]>} selectors - The recorded
	 * selectors; the handler's own map when called through `afterParsed`.
	 */
	processSelectors(parsed: DocumentFragment, selectors: Record<string, [string, string]>): void {
		for (const selector in selectors) {
			const [uuid, declarations] = selectors[selector];
			const elements = parsed.querySelectorAll(selector);
			for (const element of elements) {
				const oldValue = element.getAttribute("data-following");
				if (oldValue) {
					element.setAttribute("data-following", oldValue + "," + uuid);
				} else {
					element.setAttribute("data-following", uuid);
				}
			}
			this.styleSheet.insertRule(
				`*[data-following*='${uuid}'] { ${declarations}; }`,
				this.styleSheet.cssRules.length
			);
		}
	}
}

export default Following;
