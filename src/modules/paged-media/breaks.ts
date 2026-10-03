/**
 * Handles the CSS fragmentation properties for paged media: `break-before`,
 * `break-after`, their legacy aliases `page-break-before` /
 * `page-break-after`, and the named-page property `page`.
 *
 * Works in two phases. During polishing (`onDeclaration`, fired per CSS
 * declaration while a stylesheet is parsed) every matching declaration is
 * recorded in an internal map keyed by the containing rule's selector
 * segments and removed from the stylesheet AST, so the browser never applies
 * it natively (`break-inside` and friends are left alone). After the content
 * is parsed (`afterParsed`) the recorded rules are translated into
 * `data-*` attributes stamped onto the matching elements of the content
 * fragment; the chunker reads those during rendering to force and shape page
 * breaks, including the side values `left`/`right`/`recto`/`verso`.
 *
 * Additionally, after each page is laid out (`afterPageLayout`) the
 * break/split information of the page's content is copied onto the page
 * element and the page metadata, so the pagination logic can tell "this page
 * starts with a forced break" apart from "this page starts with a split
 * continuation".
 */
import Handler from "../handler.js";
import csstree from "css-tree";
import type { CssNode, List } from "css-tree";
import type { HandlerSource } from "../handler.js";
import {
	displayedElementAfter,
	displayedElementBefore,
	needsPageBreak,
} from "../../utils/dom.js";

interface RuleContext {
	ruleNode: CssNode;
	[key: string]: any;
}

interface Breaker {
	property: string;
	value: string;
	selector: string;
	name?: string;
}

type BreaksMap = Record<string, Breaker[]>;

interface PageLike {
	splitFrom?: string;
	splitTo?: string;
	breakBefore?: string;
	breakAfter?: string;
	previousBreakAfter?: string;
	[key: string]: any;
}

/**
 * Records a break rule under every comma-separated segment of the rule's
 * generated selector. Segments are used as-is (the compact csstree.generate
 * output leaves no whitespace around commas).
 *
 * @param {BreaksMap} breaks - Map to register the record in.
 * @param {string} selector - Generated selector text of the containing rule.
 * @param {Breaker} record - The break record to file under each segment.
 */
function registerBreak(breaks: BreaksMap, selector: string, record: Breaker): void {
	const selectors = selector.split(",");
	for (const s of selectors) {
		if (!breaks[s]) {
			breaks[s] = [record];
		} else {
			breaks[s].push(record);
		}
	}
}

/**
 * Breaks handler: intercepts break/page CSS declarations, stamps break
 * attributes onto the content fragment and mirrors them onto finished pages.
 */
class Breaks extends Handler {
	/**
	 * Break rules keyed by CSS selector (one key per comma-separated
	 * selector segment), in source declaration order.
	 */
	breaks: BreaksMap;

	constructor(chunker?: HandlerSource, polisher?: HandlerSource, caller?: HandlerSource) {
		super(chunker, polisher, caller);
		this.breaks = {};
	}

	/**
	 * Polisher hook, fired once per CSS declaration of every stylesheet.
	 *
	 * Records `page`, `break-before`, `break-after` and the legacy
	 * `page-break-before` / `page-break-after` declarations (aliased to
	 * their modern names) in the breaks map and removes them from the
	 * stylesheet so the browser never applies them natively. Every other
	 * property — including `break-inside` — is left untouched. Property
	 * names are compared case-sensitively against the source text; values
	 * are kept verbatim (only the first value child's `name` is read).
	 *
	 * @param {CssNode} declaration - The CSS declaration node.
	 * @param {List.Cursor} dItem - The declaration's cursor in its list.
	 * @param {List} dList - The list containing the declaration.
	 * @param {RuleContext} rule - The containing rule context, whose
	 * `ruleNode.prelude` is serialized into the selector(s) recorded.
	 */
	onDeclaration(declaration: CssNode, dItem: List.Cursor | any, dList: List | any, rule: RuleContext): void {
		const property = declaration.property;

		if (property === "page") {
			const value = declaration.value.children.first().name;
			const selector = csstree.generate(rule.ruleNode.prelude);
			const record: Breaker = { property, value, selector, name: value };
			registerBreak(this.breaks, selector, record);
			dList.remove(dItem);
		}

		if (
			property === "break-before" ||
			property === "break-after" ||
			property === "page-break-before" ||
			property === "page-break-after"
		) {
			const value = declaration.value.children.first().name;
			const selector = csstree.generate(rule.ruleNode.prelude);
			const normalized = property === "page-break-before"
				? "break-before"
				: property === "page-break-after"
					? "break-after"
					: property;
			const record: Breaker = { property: normalized, value, selector };
			registerBreak(this.breaks, selector, record);
			dList.remove(dItem);
		}
	}

	/**
	 * Chunker hook, fired after the source content is parsed and before
	 * pagination starts. Applies the stored break rules to the content.
	 *
	 * @param {DocumentFragment} parsed - The parsed content fragment.
	 */
	afterParsed(parsed: DocumentFragment): void {
		this.processBreaks(parsed, this.breaks);
	}

	/**
	 * Stamps the recorded break rules onto the matching elements of the
	 * content fragment: `data-break-before` / `data-next-break-before`,
	 * `data-break-after` / `data-previous-break-after`, `data-page` /
	 * `data-after-page`. Values are written verbatim; later records
	 * overwrite earlier ones. A `break-before: page` whose named-page
	 * change already forces a break implicitly is skipped.
	 *
	 * @param {DocumentFragment} parsed - The content fragment to process.
	 * @param {BreaksMap} breaks - Break rules keyed by selector.
	 */
	processBreaks(parsed: DocumentFragment, breaks: BreaksMap): void {
		for (const selector in breaks) {
			const elements = parsed.querySelectorAll(selector);
			const records = breaks[selector];
			for (const element of Array.from(elements)) {
				for (const record of records) {
					switch (record.property) {
					case "break-after": {
						const nodeAfter = displayedElementAfter(element, parsed);
						element.setAttribute("data-break-after", record.value);
						if (nodeAfter) {
							nodeAfter.setAttribute("data-previous-break-after", record.value);
						}
						break;
					}
					case "break-before": {
						const nodeBefore = displayedElementBefore(element, parsed, true);
						if (!nodeBefore) {
							// No previous displayed element: a break before
							// the start of the flow is not allowed, nothing
							// is written at all.
							break;
						}
						if (record.value === "page" && needsPageBreak(element, nodeBefore)) {
							// The named-page change already forces this
							// break; the explicit one would be redundant.
							continue;
						}
						element.setAttribute("data-break-before", record.value);
						nodeBefore.setAttribute("data-next-break-before", record.value);
						break;
					}
					case "page": {
						element.setAttribute("data-page", record.value);
						const nodeAfter = displayedElementAfter(element, parsed);
						if (nodeAfter) {
							nodeAfter.setAttribute("data-after-page", record.value);
						}
						break;
					}
					default:
						// Reachable only for records injected from outside
						// the stylesheet walk (e.g. via mergeBreaks).
						element.setAttribute("data-" + record.property, record.value);
					}
				}
			}
		}
	}

	/**
	 * Merges additional break records into an existing breaks map and
	 * returns it. Shared keys concatenate (existing entries first, then
	 * the new ones); disjoint keys take the new array by reference.
	 *
	 * @param {BreaksMap} pageBreaks - Map to merge into and return.
	 * @param {BreaksMap} newBreaks - Map whose records are merged in.
	 * @returns {BreaksMap} The merged `pageBreaks` object.
	 */
	mergeBreaks(pageBreaks: BreaksMap, newBreaks: BreaksMap): BreaksMap {
		for (const b in newBreaks) {
			if (b in pageBreaks) {
				pageBreaks[b] = pageBreaks[b].concat(newBreaks[b]);
			} else {
				pageBreaks[b] = newBreaks[b];
			}
		}
		return pageBreaks;
	}

	/**
	 * Copies the break/split information of a finished page's content onto
	 * the page metadata and the page element. The first content element
	 * carrying each attribute in document order decides: a split
	 * continuation (`data-split-from` / `data-split-to`) takes precedence
	 * over a forced break, and the exact value `avoid` never forces a
	 * page-level break. The previous break-after value is recorded on the
	 * metadata only, never mirrored onto the page element.
	 *
	 * @param {HTMLElement} pageElement - The rendered page's element.
	 * @param {PageLike} page - The page's metadata object, mutated here.
	 */
	addBreakAttributes(pageElement: HTMLElement, page: PageLike): void {
		const before = pageElement.querySelector("[data-break-before]");
		const after = pageElement.querySelector("[data-break-after]");
		const previousBreakAfter = pageElement.querySelector("[data-previous-break-after]");

		if (before) {
			if (before.dataset.splitFrom) {
				page.splitFrom = before.dataset.splitFrom;
				pageElement.setAttribute("data-split-from", before.dataset.splitFrom);
			} else if (before.dataset.breakBefore && before.dataset.breakBefore !== "avoid") {
				page.breakBefore = before.dataset.breakBefore;
				pageElement.setAttribute("data-break-before", before.dataset.breakBefore);
			}
		}

		if (after && after.dataset) {
			if (after.dataset.splitTo) {
				page.splitTo = after.dataset.splitTo;
				pageElement.setAttribute("data-split-to", after.dataset.splitTo);
			} else if (after.dataset.breakAfter && after.dataset.breakAfter !== "avoid") {
				page.breakAfter = after.dataset.breakAfter;
				pageElement.setAttribute("data-break-after", after.dataset.breakAfter);
			}
		}

		if (
			previousBreakAfter &&
			previousBreakAfter.dataset.previousBreakAfter &&
			previousBreakAfter.dataset.previousBreakAfter !== "avoid"
		) {
			page.previousBreakAfter = previousBreakAfter.dataset.previousBreakAfter;
		}
	}

	/**
	 * Chunker hook, fired after each page's layout completes. Delegates to
	 * {@link addBreakAttributes}.
	 *
	 * @param {HTMLElement} pageElement - The rendered page's element.
	 * @param {PageLike} page - The page's metadata object.
	 */
	afterPageLayout(pageElement: HTMLElement, page: PageLike): void {
		return this.addBreakAttributes(pageElement, page);
	}
}

export default Breaks;
