import Handler, { type HandlerSource } from "../handler.js";
import { UUID, attr, querySelectorEscape } from "../../utils/utils.js";
import csstree from "css-tree";
import type { CssNode, List } from "css-tree";

/**
 * One recorded `target-counter()` / `target-counters()` occurrence: the
 * parsed target argument, the serialized original value, the requested
 * counter name (and optional counter style, or plural separator), the
 * selector piece it was found under and the synthetic name the occurrence
 * was rewritten into.
 */
interface CounterTargetValue {
	func: string;
	args: string[];
	value: string;
	counter?: string;
	style?: string;
	selector: string;
	fullSelector: string;
	variable: string;
	separator?: string;
	plural?: boolean;
	urlValue?: string;
}

/**
 * All recorded occurrences, keyed by the (untrimmed) comma piece of the
 * containing rule's serialized selector.
 */
interface CounterTargetsData {
	[selector: string]: CounterTargetValue;
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
 * The polisher as this module consumes it: a source of CSS hooks that also
 * owns the work stylesheet generated rules are inserted into.
 */
interface PolisherSource extends HandlerSource {
	styleSheet: CSSStyleSheet;
}

/**
 * The chunker's layout object as this module consumes it: the container of
 * all pages rendered so far, which lives in the main document.
 */
interface ChunkerLayout {
	pagesArea: ParentNode;
}

/**
 * Computed style as this module reads it: dashed property names, so the
 * `counter-reset` / `counter-increment` values surface under their CSS
 * spellings.
 */
interface ComputedStyles {
	[property: string]: string;
}

/**
 * Handler implementing the CSS GCPM `target-counter()` and
 * `target-counters()` generated-content functions: cross references
 * (typically a table of contents) whose generated content shows the page
 * number or counter values of the element the link points at.
 *
 * Two phases:
 * 1. `onContent` (polisher) — every `target-counter(...)` / `target-counters(...)`
 *    function under a `content` declaration is recorded and rewritten in
 *    place into `counter(target-counter-<uuid>[,<style>])` (singular) or
 *    `var(--target-counters-<uuid>)` (plural).
 * 2. `afterPageLayout` (chunker, awaited after each page) — for every
 *    recorded entry the referencing elements are located in the rendered
 *    pages, the element each reference points to is resolved, the target's
 *    page or counter value is computed and a rule binding the synthetic
 *    name to that value on the referencing element is appended to the
 *    polisher's stylesheet. References whose target has not been laid out
 *    yet stay unmarked and are retried on every later page.
 *
 * @extends Handler
 */
class TargetCounters extends Handler {
	/** The polisher's work stylesheet generated rules are inserted into. */
	styleSheet: CSSStyleSheet;
	/** Recorded occurrences, keyed by selector piece. */
	counterTargets: CounterTargetsData;

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
		this.counterTargets = {};
	}

	/**
	 * Records `target-counter()` / `target-counters()` functions under
	 * `content` declarations and rewrites them in place. Dispatch is purely
	 * on the function name; nested functions (`attr()` inside a target
	 * argument) and any other name are ignored, which also makes the double
	 * walk of `@media` rules idempotent: after the first visit the node's
	 * name is `counter`/`var` and falls through.
	 *
	 * @param {CssNode} funcNode - The Function node being visited.
	 * @param {List.Cursor} fItem - The function's cursor (unused).
	 * @param {List} fList - The list holding the function (unused).
	 * @param {DeclarationContext} declaration - The containing declaration
	 * (unused).
	 * @param {RuleContext} rule - The containing rule (or at-rule) context.
	 */
	onContent(
		funcNode: CssNode,
		fItem: List.Cursor,
		fList: List,
		declaration: DeclarationContext,
		rule: RuleContext,
	): void {
		if (funcNode.name === "target-counter") {
			this.handleTargetCounter(funcNode, rule);
		} else if (funcNode.name === "target-counters") {
			this.handleTargetCounters(funcNode, rule);
		}
	}

	/**
	 * Handles the singular `target-counter(<target>, <counter-name>
	 * [, <counter-style>])` form: records one entry per comma piece of the
	 * containing rule's serialized selector (later entries overwrite earlier
	 * ones under the same key) and rewrites the function node in place into
	 * `counter(target-counter-<uuid>[,<style>])`. An unsupported target
	 * argument leaves the node and the record map untouched.
	 *
	 * @param {CssNode} funcNode - The `target-counter` Function node.
	 * @param {RuleContext} rule - The containing rule (or at-rule) context.
	 */
	handleTargetCounter(funcNode: CssNode, rule: RuleContext): void {
		const first = funcNode.children.toArray()[0];
		const target = this.parseTarget(first);
		if (!target) {
			return;
		}

		const fullSelector = csstree.generate(rule.ruleNode.prelude);

		// The original function text, captured before the node is rewritten.
		const value = csstree.generate(funcNode);

		// First and second direct Identifier child: counter name and optional
		// counter style. The style node is cloned for the rewrite below.
		let counter: string | undefined;
		let style: string | undefined;
		let styleNode: CssNode | undefined;
		funcNode.children.forEach((child: CssNode) => {
			if (child.type === "Identifier") {
				if (!counter) {
					counter = child.name;
				} else if (!style) {
					style = child.name;
					styleNode = child;
				}
			}
		});

		// One fresh synthetic counter name per target-counter() occurrence.
		const variable = "target-counter-" + UUID();

		fullSelector.split(",").forEach((piece: string) => {
			const record: CounterTargetValue = {
				func: target.func,
				args: target.args,
				value: value,
				counter: counter,
				style: style,
				selector: piece,
				fullSelector: fullSelector,
				variable: variable,
				urlValue: target.urlValue,
			};
			this.counterTargets[piece] = record;
		});

		// Rewrite in place: content: counter(target-counter-<uuid>[,<style>]).
		funcNode.name = "counter";
		funcNode.children = new csstree.List();
		funcNode.children.appendData({
			type: "Identifier",
			loc: 0,
			name: variable,
		});
		if (styleNode) {
			funcNode.children.appendData({
				type: "Operator",
				loc: 0,
				value: ",",
			});
			funcNode.children.appendData(csstree.clone(styleNode));
		}
	}

	/**
	 * Handles the plural `target-counters(<target>, <counter-name>
	 * [, <separator>][, <counter-style>])` form: like the singular handler,
	 * but the separator is taken from the first String/Raw child (defaulting
	 * to `"."`) regardless of its position among the arguments, and the node
	 * is rewritten into `var(--target-counters-<uuid>)`.
	 *
	 * @param {CssNode} funcNode - The `target-counters` Function node.
	 * @param {RuleContext} rule - The containing rule (or at-rule) context.
	 */
	handleTargetCounters(funcNode: CssNode, rule: RuleContext): void {
		const first = funcNode.children.toArray()[0];
		const target = this.parseTarget(first);
		if (!target) {
			return;
		}

		const fullSelector = csstree.generate(rule.ruleNode.prelude);

		// The original function text, captured before the node is rewritten.
		const value = csstree.generate(funcNode);

		// Arguments are parsed by node type, not position: the first two
		// Identifier children are counter name and counter style, the first
		// String or Raw child is the separator.
		let counter: string | undefined;
		let style: string | undefined;
		let separator: string | undefined;
		let separatorSet = false;
		funcNode.children.forEach((child: CssNode) => {
			if (child.type === "Identifier") {
				if (!counter) {
					counter = child.name;
				} else if (!style) {
					style = child.name;
				}
			} else if (child.type === "String" || child.type === "Raw") {
				if (!separatorSet) {
					separator = String(child.value).replace(/["']/g, "");
					separatorSet = true;
				}
			}
		});
		if (!separatorSet) {
			separator = ".";
		}

		// One fresh synthetic custom-property name per target-counters()
		// occurrence (note the different prefix from the singular form).
		const variable = "target-counters-" + UUID();

		fullSelector.split(",").forEach((piece: string) => {
			const record: CounterTargetValue = {
				func: target.func,
				args: target.args,
				value: value,
				counter: counter,
				style: style,
				selector: piece,
				fullSelector: fullSelector,
				variable: variable,
				separator: separator,
				plural: true,
				urlValue: target.urlValue,
			};
			this.counterTargets[piece] = record;
		});

		// Rewrite in place: content: var(--target-counters-<uuid>).
		funcNode.name = "var";
		funcNode.children = new csstree.List();
		funcNode.children.appendData({
			type: "Identifier",
			loc: 0,
			name: "--" + variable,
		});
	}

	/**
	 * Parses the first child of a target function node into the module's
	 * target shape. Recognized: an `attr()` Function (its direct Identifier
	 * children become the attribute names to try, in order), a `url()`
	 * Function and a `Url` node (both yield the URL text with all quote
	 * characters stripped, fragment `#` kept). Anything else yields null.
	 * A missing node (empty function) throws on the node access.
	 *
	 * @param {CssNode} first - The first child of the target function node.
	 * @returns {object|null} `{ func: "attr", args }`, `{ func: "url", args:
	 * [], urlValue }`, or null when the shape is unsupported.
	 */
	parseTarget(
		first: CssNode,
	): { func: string; args: string[]; urlValue?: string } | null {
		if (first.type === "Function" && first.name === "attr") {
			const args: string[] = [];
			first.children.forEach((child: CssNode) => {
				if (child.type === "Identifier") {
					args.push(child.name);
				}
			});
			return {
				func: "attr",
				args: args,
			};
		}

		if (first.type === "Function" && first.name === "url") {
			let urlValue = "";
			const firstChild = first.children.first();
			if (firstChild) {
				urlValue = String(firstChild.value).replace(/["']/g, "");
			}
			return {
				func: "url",
				args: [],
				urlValue: urlValue,
			};
		}

		if (first.type === "Url") {
			return {
				func: "url",
				args: [],
				urlValue: first.value.value.replace(/["']/g, ""),
			};
		}

		return null;
	}

	/**
	 * Resolves every recorded entry against the pages rendered so far. Runs
	 * the entire record map on every page event; idempotence comes from a
	 * `data-<variable>` marker attribute, so each referencing element is
	 * processed at most once. For every unmarked matching element, the
	 * referenced element is resolved (via the reference's attribute value or
	 * URL fragment), the element is marked, a rule binding the synthetic
	 * name to the target's value is appended to the polisher's stylesheet
	 * and a forced reflow flushes the new rule. Unresolvable references are
	 * left unmarked and retried on the next page event.
	 *
	 * @param {HTMLElement} fragment - The page root element (unused).
	 * @param {unknown} page - The page object (unused).
	 * @param {unknown} breakToken - The break token (unused).
	 * @param {ChunkerLayout} chunker - The layout object exposing
	 * `pagesArea`, the container of all rendered pages.
	 */
	afterPageLayout(
		fragment: HTMLElement,
		page: unknown,
		breakToken: unknown,
		chunker: ChunkerLayout,
	): void {
		const pagesArea = chunker.pagesArea;

		for (const name of Object.keys(this.counterTargets)) {
			const target = this.counterTargets[name];

			// Split at every single or double colon; split[0] is the element
			// query, split[1] (when present) becomes the pseudo suffix. The
			// split cannot distinguish pseudo-classes from pseudo-elements.
			const split = target.selector.split(/::?/g);

			const query = split[0];

			let pseudo = "";
			if (split.length > 1) {
				pseudo = "::" + split[1];
			}

			// Static list: elements marked during this same pass stay in it,
			// but the marker keeps later passes away from them.
			const selected = pagesArea.querySelectorAll(
				query + ":not([data-" + target.variable + "])",
			);

			for (const element of Array.from(selected)) {
				let referenced: Element | null | undefined;

				if (target.func === "attr") {
					// The attribute value is used as a selector; a leading `#`
					// survives querySelectorEscape, `undefined` coerces to the
					// string "undefined" (matching nothing), an empty value
					// makes querySelector throw.
					const val = attr(element, target.args);
					referenced = pagesArea.querySelector(querySelectorEscape(val));
				} else if (target.func === "url" && target.urlValue) {
					// The fragment after the last `#` of the URL is the id to
					// look up; an empty fragment skips the lookup.
					let fragmentId = target.urlValue;
					if (fragmentId.includes("#")) {
						fragmentId = fragmentId.substring(fragmentId.lastIndexOf("#") + 1);
					}
					if (fragmentId) {
						referenced = pagesArea.querySelector(
							"#" + querySelectorEscape(fragmentId),
						);
					}
				}

				if (!referenced) {
					// Forward reference: retried on the next page event.
					continue;
				}

				const id = UUID();

				// The marker goes on the referencing element, never on the
				// target; it doubles as the idempotence guard.
				element.setAttribute("data-" + target.variable, id);

				if (target.plural) {
					// Joined counter values, outermost first, as a custom
					// property. No values: no rule, but still marked.
					const values = this.collectCounterValues(referenced, target.counter);
					if (values.length) {
						this.styleSheet.insertRule(
							`[data-${target.variable}="${id}"]${pseudo} { --${target.variable}: "${values.join(target.separator)}"; }`,
							this.styleSheet.cssRules.length,
						);
					}
				} else if (target.counter === "page") {
					// Replay the page-counter bookkeeping from the computed
					// counter-reset / counter-increment of the page elements,
					// stopping after the page that contains the target.
					let pg = 0;
					const pages = pagesArea.querySelectorAll(".paged_page");
					for (const pageElement of Array.from(pages)) {
						const styles = window.getComputedStyle(
							pageElement,
						) as unknown as ComputedStyles;

						const reset = styles["counter-reset"].replace("page", "").trim();
						if (reset !== "none") {
							pg = parseInt(reset);
						}

						const increment = styles["counter-increment"].replace("page", "").trim();
						if (increment !== "none") {
							pg += parseInt(increment);
						}

						if (pageElement.contains(referenced)) {
							break;
						}
					}

					// No pseudo suffix: counters reset on a pseudo-element are
					// not visible to counter() in that pseudo's own content.
					this.styleSheet.insertRule(
						`[data-${target.variable}="${id}"] { counter-reset: ${target.variable} ${pg}; }`,
						this.styleSheet.cssRules.length,
					);
				} else {
					// Pre-computed running value written by the Counters module.
					const val = referenced.getAttribute(
						"data-counter-" + target.counter + "-value",
					);
					if (val) {
						this.styleSheet.insertRule(
							`[data-${target.variable}="${id}"] { counter-reset: ${target.variable} ${target.variable} ${parseInt(val)}; }`,
							this.styleSheet.cssRules.length,
						);
					}
				}

				// Force a synchronous style/layout flush so the just-inserted
				// rule takes effect before the next page is laid out.
				const marked = document.querySelector(
					`[data-${target.variable}="${id}"]`,
				);
				if (marked) {
					marked.style.display = "none";
					marked.clientHeight;
					marked.style.removeProperty("display");
				}
			}
		}
	}

	/**
	 * Collects the `data-counter-<counter>-value` attributes of `element`
	 * and every ancestor up to the document root — the walk does not stop at
	 * page boundaries. Elements with the attribute absent or present but
	 * empty contribute nothing. Returns the values outermost ancestor first,
	 * `element`'s own value last.
	 *
	 * @param {Element} element - The element to start the walk at.
	 * @param {string} [counter] - The counter name. Falsy: no walk.
	 * @returns {string[]} The collected values, outermost first.
	 */
	collectCounterValues(element: Element, counter?: string): string[] {
		if (!counter) {
			return [];
		}

		const values: string[] = [];
		let current: Element | null = element;
		while (current) {
			const value = current.getAttribute("data-counter-" + counter + "-value");
			if (value) {
				values.push(value);
			}
			current = current.parentElement;
		}
		return values.reverse();
	}
}

export default TargetCounters;
