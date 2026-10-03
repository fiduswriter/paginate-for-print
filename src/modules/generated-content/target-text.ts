import Handler, { type HandlerSource } from "../handler.js";
import { UUID, attr, querySelectorEscape } from "../../utils/utils.js";
import { cleanPseudoContent } from "../../utils/css.js";
import csstree from "css-tree";
import type { CssNode, List } from "css-tree";

/**
 * One recorded `target-text()` occurrence: the inner target function, the
 * attribute names it reads, the serialized original value, the requested
 * style, the selector piece it was found under and the CSS custom property
 * the occurrence was rewritten into.
 */
interface TextTargetValue {
	func: string;
	args: string[];
	value: string;
	style: string;
	selector: string;
	fullSelector: string;
	variable: string;
}

/**
 * All recorded occurrences, keyed by the (untrimmed) comma piece of the
 * containing rule's serialized selector.
 */
interface TextTargetsData {
	[selector: string]: TextTargetValue;
}

/**
 * Structural mirror of the polisher's rule context, as passed by the Sheet
 * with every declaration-related hook trigger.
 */
interface RuleContext {
	ruleNode: CssNode;
	ruleItem?: List.Cursor;
	rulelist?: List;
}

/**
 * Structural mirror of the Sheet's declaration context.
 */
interface DeclarationContext {
	declarationNode: CssNode;
	dItem?: List.Cursor;
	dList?: List;
}

/**
 * Structural mirror of the Sheet's selector context.
 */
interface SelectorContext {
	selectNode: CssNode;
	selectItem?: List.Cursor;
	selectList?: List;
}

/**
 * The polisher as this module consumes it: a source of CSS hooks that also
 * owns the work stylesheet generated rules are inserted into.
 */
interface PolisherSource extends HandlerSource {
	styleSheet: CSSStyleSheet;
}

/**
 * Handler implementing the CSS GCPM `target-text()` generated-content
 * function: cross-references (typically a table of contents) whose generated
 * content is filled with text taken from the element the link points at.
 *
 * Three phases:
 * 1. `onContent` (polisher) — every `target-text(...)` function under a
 *    `content` declaration is recorded and rewritten in place into
 *    `var(--paged-<uuid>)`.
 * 2. `onPseudoSelector` (polisher) — the raw `content` strings of
 *    `::before`/`::after` rules are captured into two instance-global
 *    accumulators for the `before`/`after` styles.
 * 3. `afterParsed` (chunker, before pagination) — for every recorded entry
 *    the source elements are located in the parsed content fragment, the
 *    referenced attribute's value is used as a selector to find the target
 *    element, the requested text is extracted, the source element is tagged
 *    with `data-target-text="<uuid>"` and a rule
 *    `[data-target-text="<uuid>"]<pseudo> { --paged-<uuid>: "<text>" }` is
 *    inserted into the polisher's stylesheet. Custom-property inheritance
 *    then carries the text into the author's rewritten pseudo-element
 *    content.
 *
 * @extends Handler
 */
class TargetText extends Handler {
	/** The polisher's work stylesheet generated rules are inserted into. */
	styleSheet: CSSStyleSheet;
	/** Recorded `target-text()` occurrences, keyed by selector piece. */
	textTargets: TextTargetsData;
	/** Raw `content` string of the last seen `::before` rule (quotes included). */
	beforeContent: string;
	/** Raw `content` string of the last seen `::after` rule (quotes included). */
	afterContent: string;
	/** Scratch storage: last rule prelude during `onContent`, last minted uuid during `afterParsed`. */
	selector: string;

	/**
	 * Wires the handler against the engine objects and captures the polisher's
	 * work stylesheet. Hook registration happens in the base constructor,
	 * before the field assignments below.
	 *
	 * @param {HandlerSource} chunker - The chunker, exposing lifecycle hooks.
	 * @param {PolisherSource} polisher - The polisher, exposing CSS hooks and
	 * the work stylesheet. Required: its `styleSheet` is dereferenced with a
	 * non-null assertion, so a missing polisher throws.
	 * @param {HandlerSource} caller - The caller (previewer), exposing
	 * preview hooks.
	 */
	constructor(
		chunker?: HandlerSource,
		polisher?: PolisherSource,
		caller?: HandlerSource,
	) {
		super(chunker, polisher, caller);

		this.styleSheet = polisher!.styleSheet;
		this.textTargets = {};
		this.beforeContent = "";
		this.afterContent = "";
		this.selector = {} as string;
	}

	/**
	 * Records `target-text()` functions under `content` declarations and
	 * rewrites them in place into `var(--paged-<uuid>)`. The function's
	 * serialized prelude of the containing rule is split on commas and one
	 * entry per piece is stored; pieces are not trimmed. Any other function
	 * name is ignored entirely.
	 *
	 * The declaration's property is not verified here — the Sheet only fires
	 * this hook for `content` declarations. Errors (degenerate arguments, a
	 * prelude-less at-rule context) are never caught and abort the parse.
	 *
	 * @param {CssNode} funcNode - The Function node being visited.
	 * @param {List.Cursor} fItem - The function's cursor (unused).
	 * @param {List} fList - The list holding the function (unused).
	 * @param {DeclarationContext} declaration - The containing declaration
	 * (unused).
	 * @param {RuleContext} rule - The containing rule (or at-rule) context.
	 */
	onContent(funcNode: CssNode, fItem: List.Cursor, fList: List, declaration: DeclarationContext, rule: RuleContext): void {
		if (funcNode.name !== "target-text") {
			return;
		}

		// The entire serialized prelude of the containing rule; for a bare
		// `@page` this is null and `generate` throws a TypeError.
		this.selector = csstree.generate(rule.ruleNode.prelude);

		const first = funcNode.children.first();
		const last = funcNode.children.last();

		// The inner function's name, in practice "attr". Unguarded: an empty
		// argument list makes this read throw a TypeError.
		const func = first.name;

		// Capture the original function text before the node is rewritten.
		const value = csstree.generate(funcNode);

		// Every Identifier among the inner function's arguments, in order —
		// attribute names to try, with the CSS type keyword treated as a
		// fallback attribute name. Degenerate first arguments throw here.
		const args: string[] = [];
		first.children.forEach((child: CssNode) => {
			if (child.type === "Identifier") {
				args.push(child.name);
			}
		});

		// With normally authored input the last child is the second argument
		// Identifier ("content", "before", "after", "first-letter"); anything
		// else (single argument, other node type) leaves style undefined and
		// falls back to "content" below.
		let style: string | undefined;
		if (last !== first) {
			style = last.name;
		}

		// One fresh custom-property name per target-text() occurrence.
		const variable = "--paged-" + UUID();

		// One entry per comma piece, untrimmed; existing keys are overwritten
		// (last declaration wins, original insertion position kept).
		this.selector.split(",").forEach((piece: string) => {
			this.textTargets[piece] = {
				func: func,
				args: args,
				value: value,
				style: style || "content",
				selector: piece,
				fullSelector: this.selector,
				variable: variable,
			};
		});

		// Rewrite in place: content: var(--paged-<uuid>).
		funcNode.name = "var";
		funcNode.children = new csstree.List();
		funcNode.children.appendData({
			type: "Identifier",
			loc: 0,
			name: variable,
		});
	}

	/**
	 * Captures the raw `content` string of `::before`/`::after` rules into the
	 * instance-global accumulators. Fired once per pseudo-element selector of
	 * every rule; the whole containing block is scanned each time, and later
	 * rules overwrite earlier values (last seen in processing order wins).
	 * String node values keep their surrounding quotes. Any other pseudo name
	 * or non-`content` declarations are ignored.
	 *
	 * @param {CssNode} pseudoNode - The PseudoElementSelector being visited.
	 * @param {List.Cursor} pItem - The pseudo selector's cursor (unused).
	 * @param {List} pList - The list holding the pseudo selector (unused).
	 * @param {SelectorContext} selector - The containing selector context
	 * (unused).
	 * @param {RuleContext} rule - The containing rule context.
	 */
	onPseudoSelector(pseudoNode: CssNode, pItem: List.Cursor, pList: List, selector: SelectorContext, rule: RuleContext): void {
		rule.ruleNode.block.children.forEach((declaration: CssNode) => {
			if (declaration.property === "content") {
				if (pseudoNode.name === "before") {
					declaration.value.children.forEach((child: CssNode) => {
						if (child.type === "String") {
							this.beforeContent = child.value;
						}
					});
				} else if (pseudoNode.name === "after") {
					declaration.value.children.forEach((child: CssNode) => {
						if (child.type === "String") {
							this.afterContent = child.value;
						}
					});
				}
			}
		});
	}

	/**
	 * Resolves every recorded `target-text()` entry against the parsed content
	 * fragment, before pagination: for each element matching a selector piece,
	 * the referenced attribute's value is used as a selector to find the
	 * target element (an `href="#id"` value therefore locates the target by
	 * id). The source element is tagged with a fresh
	 * `data-target-text="<uuid>"` attribute and a rule defining the entry's
	 * variable to the extracted text is inserted (with a single argument, so
	 * at index 0) into the polisher's stylesheet:
	 * `[data-target-text="<uuid>"]<pseudo> { --paged-<var>: "<text>" }`.
	 *
	 * `before`/`after` styles read the global pseudo-content accumulators;
	 * every other style reads the target element's text, with `first-letter`
	 * additionally truncated to its first UTF-16 code unit. Elements whose
	 * target cannot be resolved are skipped silently.
	 *
	 * @param {ParentNode} fragment - The parsed content fragment.
	 */
	afterParsed(fragment: ParentNode): void {
		for (const name of Object.keys(this.textTargets)) {
			const target = this.textTargets[name];

			// Split at every single or double colon; split[0] is the element
			// query, split[1] (when present) becomes the pseudo suffix. The
			// split cannot distinguish pseudo-classes from pseudo-elements.
			const split = target.selector.split(/::?/g);

			// An invalid query (a colon inside an attribute selector corrupts
			// it) throws a SyntaxError, unguarded.
			const queried = fragment.querySelectorAll(split[0]);

			for (const selected of queried) {
				// Value of the first recorded attribute name present.
				const val = attr(selected, target.args);

				// The attribute value is used as a selector; a leading `#`
				// survives querySelectorEscape, `undefined` coerces to the
				// string "undefined" (matching nothing).
				const element = fragment.querySelector(querySelectorEscape(val));

				if (element) {
					if (target.style) {
						// Fresh per-element uuid; also overwrites the selector
						// scratch field.
						this.selector = UUID();

						// The attribute goes on the source element.
						selected.setAttribute("data-target-text", this.selector);

						let pseudo = "";
						if (split.length > 1) {
							pseudo = "::" + split[1];
						}

						let textContent: string | undefined;
						if (target.style === "before") {
							textContent = cleanPseudoContent(this.beforeContent);
						} else if (target.style === "after") {
							textContent = cleanPseudoContent(this.afterContent);
						} else {
							// "content", "first-letter" and anything unknown:
							// the target element's own text, spaces-only trim.
							textContent = cleanPseudoContent(element.textContent, " ");
						}

						if (target.style === "first-letter") {
							textContent = textContent!.charAt(0);
						}

						// Single-argument insertRule: a real CSSOM inserts at
						// index 0; an invalid selector (e.g. the pseudo-class
						// quirk) makes it throw.
						this.styleSheet.insertRule(`[data-target-text="${this.selector}"]${pseudo} { ${target.variable}: "${textContent}" }`);
					} else {
						console.warn("missed target", val);
					}
				}
			}
		}
	}
}

export default TargetText;
