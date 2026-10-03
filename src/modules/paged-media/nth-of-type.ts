/**
 * Preserves `:first-of-type`, `:last-of-type` and `:nth-of-type` matching
 * across pagination.
 *
 * Once content lives inside page boxes the browser's native of-type matching
 * no longer means what the author wrote: every page box re-establishes the
 * sibling context, and elements split across pages change their position
 * among same-type siblings. This handler therefore converts every author rule
 * whose selector uses one of those three pseudo-classes into a pre-pagination
 * snapshot:
 *
 * 1. CSS phase (`onRule`, fired per CSS rule while each author stylesheet is
 *    parsed): qualifying rules are recorded in the `selectors` map (selector
 *    text → generated id + declarations) and removed from the stylesheet AST,
 *    so the original selector-based rule never reaches the output CSS. The
 *    nth expression is not parsed or rewritten; `odd`, `even`, `2n+1` etc.
 *    stay verbatim inside the stored selector text.
 * 2. DOM phase (`afterParsed`, fired after the source content is parsed and
 *    before pagination starts): each recorded selector is evaluated against
 *    the still-original content tree, every match is stamped with the
 *    generated id in a `data-nth-of-type` attribute, and one
 *    attribute-substring rule carrying the recorded declarations is appended
 *    to the polisher's stylesheet. The declarations therefore follow the
 *    element wherever pagination moves it, without any recomputation.
 *
 * The snapshot is taken exactly once — the module never consults
 * `data-split-from`/`data-split-to` and performs no layout measurement.
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
 * Detection test for a qualifying selector. Deliberately a plain,
 * case-sensitive substring test: `:nth-last-of-type` does not match (after
 * `:nth` the text must continue with `-of-type`), uppercase spellings such as
 * `:NTH-OF-TYPE` do not match, and text inside quoted strings or attribute
 * values is not excluded (a false positive hijacks the rule).
 */
const OF_TYPE_PSEUDO = /:(first|last|nth)-of-type/;

/**
 * Converts of-type pseudo-class rules into pre-pagination data-attribute
 * snapshots, as described in the module documentation.
 */
class NthOfType extends Handler {
	/**
	 * The polisher's live stylesheet, captured at construction; the sole
	 * destination of the injected attribute-based rules (appended at the
	 * tail).
	 */
	styleSheet: CSSStyleSheet;

	/**
	 * The module's only cross-phase state. Keys are serialized selector
	 * fragments (split on every comma); values are `[id, declarations]`
	 * tuples where the id is `"nth-of-type-"` followed by a fresh UUID and
	 * the declarations are the rule's serialized block with all braces
	 * stripped. Fragments shared by several rules share the first rule's id
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
	 * Rules whose serialized selector contains one of the three of-type
	 * pseudo-classes are recorded in the `selectors` map and removed from the
	 * stylesheet AST; all other rules are left completely untouched. No nth
	 * expression is parsed or validated, and the selector text is split on
	 * every comma character (a naive split that does not respect commas
	 * inside strings or attribute values).
	 *
	 * @param {CssNode} ruleNode - The CSS rule node.
	 * @param {List.Cursor} ruleItem - The rule's cursor in its list.
	 * @param {List} rulelist - The list containing the rule (the
	 * stylesheet's top-level list or an at-rule block's inner list).
	 */
	onRule(ruleNode: CssNode, ruleItem: List.Cursor | any, rulelist: List | any): void {
		const selector = csstree.generate(ruleNode.prelude);

		if (!selector.match(OF_TYPE_PSEUDO)) {
			return;
		}

		// Serialize the block and strip every brace character. The compact
		// form joins declarations with `;` and preserves letter case; inner
		// braces (from structures that survived parsing) are stripped too.
		const declarations = csstree.generate(ruleNode.block).replace(/[{}]/g, "");

		// A fresh id per qualifying rule — not per selector fragment and not
		// per element.
		const uuid = "nth-of-type-" + UUID();

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
	 * the parsed content fragment.
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
	 * For each recorded selector, in insertion order: the ORIGINAL selector
	 * (of-type pseudo-classes and all) is evaluated against the fragment by
	 * the host, every match is tagged with the selector's id in a
	 * `data-nth-of-type` attribute (a non-empty existing value gets the id
	 * appended after a comma; an absent or empty value is replaced), and one
	 * attribute-substring rule is appended to the tail of the polisher's
	 * stylesheet.
	 *
	 * An invalid selector key or an unparsable declarations string throws a
	 * `DOMException` (SyntaxError) and aborts the whole pass; mutations from
	 * earlier selectors persist. Running twice with the same state is not
	 * idempotent: ids accumulate and duplicate rules are inserted.
	 *
	 * @param {DocumentFragment} parsed - The parsed source content.
	 * @param {Record<string, [string, string]>} selectors - The recorded
	 * selectors; defaults to the handler's own map when called through
	 * `afterParsed`.
	 */
	processSelectors(parsed: DocumentFragment, selectors: Record<string, [string, string]>): void {
		for (const selector in selectors) {
			const [uuid, declarations] = selectors[selector];
			const elements = parsed.querySelectorAll(selector);
			for (const element of elements) {
				const oldValue = element.getAttribute("data-nth-of-type");
				if (oldValue) {
					element.setAttribute("data-nth-of-type", oldValue + "," + uuid);
				} else {
					element.setAttribute("data-nth-of-type", uuid);
				}
			}
			this.styleSheet.insertRule(
				`*[data-nth-of-type*='${uuid}'] { ${declarations}; }`,
				this.styleSheet.cssRules.length
			);
		}
	}
}

export default NthOfType;
