/**
 * Clean-room rewrite of the CSS Generated Content running-elements module,
 * built from the behavioral specification in
 * `.pwf-cleanroom/specs/g06-genc/running-headers.spec.md`.
 *
 * Implements CSS GCPM running elements: an element declared with
 * `position: running(<name>)` is removed from the rendered flow and, on every
 * page, a deep clone of the appropriate occurrence is injected into every
 * margin box whose `content` is `element(<name>[, <style>])`. The `style`
 * keyword (`first`, `last`, `start`, `first-except`) selects which occurrence
 * of the source on the page is used; pages without an occurrence carry the
 * first-seen source forward.
 */

import Handler, { type HandlerSource } from "../handler.js";
import csstree from "css-tree";
import type { CssNode, List } from "css-tree";

/** One registered running source: a `position: running(<name>)` declaration. */
interface RunningHeaderValue {
	identifier: string;
	value?: string;
	selector: string;
	first?: Element;
	last?: Element;
	start?: Element;
	carryFirst?: Element;
	hasAppeared?: boolean;
}

/** Registry of running sources, keyed by the running name. */
interface RunningHeadersData {
	[name: string]: RunningHeaderValue;
}

/** One parsed `element(<name>, <style>)` reference in a `content` declaration. */
interface ElementContentValue {
	func: string;
	args: string[];
	value: string;
	style: string;
	selector: string;
	fullSelector: string;
}

/** Registry of element references, keyed by the margin-box target selector. */
interface ElementContentData {
	[selector: string]: ElementContentValue;
}

/** The rule context the polisher's declaration walk passes to `onDeclaration`. */
interface RuleContext {
	ruleNode: CssNode;
	ruleItem?: List.Cursor;
	rulelist?: List;
}

/** The raw sheet the polisher's `beforeTreeParse` hook hands over. */
interface SheetSource {
	text?: string;
}

/**
 * Pattern consumed by `beforeTreeParse`: the literal function name `element`,
 * optional whitespace, an open paren, and an argument run containing none of
 * `|`, `^`, `#` or `)`. Rewritten to `element-ident(...)` so the value
 * survives CSS parsing as an ordinary unknown function. Deliberately does not
 * match `element(#id)`, `elements(x)`, or the already-renamed
 * `element-ident(x)`.
 */
const ELEMENT_FUNC_PATTERN = /element[\s]*\(([^|^#)]*)\)/g;

/**
 * First pseudo-element occurrence stripped from a margin-box content rule
 * selector to obtain the real element's selector (querying a selector that
 * ends in a pseudo-element returns the originating element, but the module
 * strips it explicitly to build its registry key).
 */
const PSEUDO_ELEMENT_PATTERN = /::after|::before/;

/**
 * Handles CSS GCPM running elements for page margin boxes.
 *
 * During the CSS phase, `beforeTreeParse` renames `element(...)` functions to
 * `element-ident(...)` in the raw sheet text and `onDeclaration` records every
 * `position: running(<name>)` source (keyed by the running name) and every
 * `content: element-ident(<name>, <style>)` reference (keyed by the margin-box
 * selector). `afterParsed` hides the source elements in the flow. On each
 * page, `afterPageLayout` tracks per-page source occurrences (`first`, `last`,
 * `start`, plus the persistent `carryFirst`) and injects a deep clone of the
 * chosen source into each registered margin box, emulating the page-context
 * cascade by processing selectors in `pageWeight` order.
 *
 * @class
 */
class RunningHeaders extends Handler {
	/** Running sources keyed by running name (insertion order = CSS order). */
	runningSelectors: RunningHeadersData;
	/** Element references keyed by margin-box selector (insertion order). */
	elements: ElementContentData;
	/** Selector processing order, computed once at the first page injection. */
	orderedSelectors?: string[];

	/**
	 * Wires the handler against the engine objects and initializes the two
	 * registries. Constructing with no arguments produces a fully usable
	 * object for the pure methods.
	 * @param {HandlerSource} chunker - The chunker, exposing lifecycle hooks.
	 * @param {HandlerSource} polisher - The polisher, exposing CSS hooks.
	 * @param {HandlerSource} caller - The caller (previewer), exposing
	 * preview hooks.
	 */
	constructor(chunker?: HandlerSource, polisher?: HandlerSource, caller?: HandlerSource) {
		super(chunker, polisher, caller);
		this.runningSelectors = {} as RunningHeadersData;
		this.elements = {} as ElementContentData;
	}

	/**
	 * Rewrites every `element(...)` function in the sheet's raw text to
	 * `element-ident(...)` before the sheet is parsed, so the value survives
	 * CSS parsing and serialization as an ordinary unknown function. The
	 * rewrite is global and case-sensitive; whitespace between the name and
	 * the paren is consumed, whitespace inside the parens is preserved.
	 * `element(#id)`, `elements(x)` and `element-ident(x)` do not match.
	 * @param {string} text - The raw CSS text (not mutated).
	 * @param {SheetSource} sheet - The sheet whose `text` is rewritten.
	 */
	beforeTreeParse(text: string, sheet: SheetSource): void {
		sheet.text = text.replace(ELEMENT_FUNC_PATTERN, "element-ident($1)");
	}

	/**
	 * Records running sources and element references from declarations.
	 *
	 * For `position: running(<name>)` the containing rule's generated selector
	 * is stored under the running name; the last function entered in the
	 * declaration subtree names the source (a nested function wins). For
	 * `content: element-ident(...)` (any function whose name contains
	 * "element") an entry is stored per selector in the rule's selector list,
	 * keyed by the selector with its first `::after`/`::before` removed. The
	 * CSS tree is never mutated.
	 * @param {CssNode} declaration - The declaration node being walked.
	 * @param {List.Cursor} dItem - The declaration's list cursor (unused).
	 * @param {List} dList - The declaration's list (unused).
	 * @param {RuleContext} rule - The containing rule context.
	 */
	onDeclaration(declaration: CssNode, dItem: List.Cursor, dList: List, rule: RuleContext): void {
		if (declaration.property === "position") {
			const selector = csstree.generate(rule.ruleNode.prelude);
			// The value's first child names the function ("running" for a
			// running declaration; a bare `position: running` identifier also
			// matches, a String argument yields undefined and is stored under
			// the key "undefined").
			const name = declaration.value.children.first().name;
			if (name === "running") {
				// The last function entered wins; for an empty `running()`
				// function the first child is null and reading `.name` throws
				// a TypeError that aborts CSS processing.
				let runningName: string | undefined;
				csstree.walk(declaration, {
					visit: "Function",
					enter: (node) => {
						runningName = node.children.first().name;
					}
				});
				// An undefined runningName is stored under the key "undefined"
				// (string coercion of the object key); the entry's selector is
				// still valid for the hiding step but can never be resolved by
				// an element() reference.
				this.runningSelectors[runningName as string] = {
					identifier: "running",
					value: runningName,
					selector
				};
			}
		} else if (declaration.property === "content") {
			csstree.walk(declaration, {
				visit: "Function",
				enter: (funcNode) => {
					// Both `element` and the rewritten `element-ident` match.
					if (funcNode.name.includes("element")) {
						const selector = csstree.generate(rule.ruleNode.prelude);
						const func = funcNode.name;
						// The first child names the running source; an empty
						// function throws here (first child is null).
						const value = funcNode.children.first().name;
						const args = [value];
						// The first Identifier child is the running-name
						// argument; every subsequent Identifier child
						// overwrites the style, so the last one wins.
						let style = "first";
						let seenIdentifier = false;
						funcNode.children.forEach((child: CssNode) => {
							if (child.type === "Identifier") {
								if (seenIdentifier) {
									style = child.name;
								}
								seenIdentifier = true;
							}
						});
						// One key per selector in the rule's selector list,
						// each stripped of its first ::after/::before.
						for (const part of selector.split(",")) {
							const key = part.replace(PSEUDO_ELEMENT_PATTERN, "");
							this.elements[key] = {
								func,
								args,
								value,
								style,
								selector: key,
								fullSelector: selector
							};
						}
					}
				}
			});
		}
	}

	/**
	 * Hides every running source in the parsed content: each element matching
	 * a registered source selector gets inline `display: none` and
	 * `data-undisplayed="undisplayed"`, so the chunker skips it when
	 * accounting page content and break tokens. The elements stay attached in
	 * the flow and are cloned page by page.
	 * @param {ParentNode} fragment - The parsed source content.
	 */
	afterParsed(fragment: ParentNode): void {
		for (const name of Object.keys(this.runningSelectors)) {
			const entry = this.runningSelectors[name];
			if (entry.identifier === "running") {
				const selected = fragment.querySelectorAll(entry.selector);
				for (const element of Array.from(selected) as HTMLElement[]) {
					element.style.display = "none";
					element.dataset.undisplayed = "undisplayed";
				}
			}
		}
	}

	/**
	 * Updates per-page running-source state and injects clones into margin
	 * boxes for the finished page.
	 *
	 * Phase A resets `first`/`last`/`start` for every running entry, then —
	 * when the source appears on the page — records the first and last match,
	 * detects the `start` match (the first element whose top is within 1px of
	 * the page content area's top; browser geometry), and latches
	 * `carryFirst` on the first page where the source appears.
	 *
	 * Phase B walks the registered margin-box selectors in `pageWeight` order
	 * (computed once), chooses the source element per style keyword, and
	 * replaces the target's content with a visible deep clone. Selectors
	 * processed later overwrite earlier ones (cascade emulation).
	 * @param {HTMLElement} fragment - The page's root element.
	 */
	afterPageLayout(fragment: HTMLElement): void {
		// Phase A — per-page running-source state.
		for (const name of Object.keys(this.runningSelectors)) {
			const entry = this.runningSelectors[name];
			entry.first = undefined;
			entry.last = undefined;
			entry.start = undefined;
			const selected = fragment.querySelectorAll(entry.selector);
			if (selected.length > 0 && entry.identifier === "running") {
				entry.first = selected[0];
				entry.last = selected[selected.length - 1];
				entry.hasAppeared = true;
				const pageContent = fragment.querySelector(".paged_page_content");
				if (pageContent) {
					const pageTop = pageContent.getBoundingClientRect().top;
					for (const element of Array.from(selected)) {
						if (Math.abs(element.getBoundingClientRect().top - pageTop) < 1) {
							entry.start = element;
							break;
						}
					}
				}
				if (!entry.start) {
					entry.start = entry.first;
				}
				if (!entry.carryFirst) {
					entry.carryFirst = entry.first;
				}
			}
		}

		// Phase B — margin-box injection.
		if (!this.orderedSelectors) {
			this.orderedSelectors = this.orderSelectors(this.elements);
		}
		for (const selector of this.orderedSelectors) {
			if (!selector) {
				continue;
			}
			const entry = this.elements[selector];
			const target = fragment.querySelector(selector);
			if (!target) {
				continue;
			}
			const running = this.runningSelectors[entry.args[0]];
			if (!running) {
				continue;
			}
			let source: Element | undefined;
			if (entry.style === "last") {
				source = running.last || running.carryFirst;
			} else if (entry.style === "start") {
				source = running.start || running.carryFirst;
			} else if (entry.style === "first-except") {
				// Intentionally empty on any page where the source appears.
				source = running.first ? undefined : running.carryFirst;
			} else {
				source = running.first || running.carryFirst;
			}
			if (!source) {
				if (entry.style === "first-except") {
					target.innerHTML = "";
				}
				continue;
			}
			target.innerHTML = "";
			const clone = source.cloneNode(true) as HTMLElement;
			// Assigning null removes the cloned inline `display: none`: the
			// CSSOM's [LegacyNullToEmptyString] IDL semantics treat null as
			// the empty string, which drops the property.
			(clone.style as { display: string | null }).display = null;
			target.appendChild(clone);
		}
	}

	/**
	 * Assigns an ordering weight to a margin-box selector string, derived from
	 * the page-context classes of the selector's first compound: plain `@page`
	 * 1, `:left`/`:right` 2, `:blank` 3, `:first` and `:nth(n)` 4, named 5,
	 * named `:left`/`:right` 6, named `:first` lands in tier 5 (no
	 * nth-of-type) and named `:nth(n)` 7. An empty string throws (the class
	 * list is empty and `indexOf` is read off undefined).
	 * @param {string} s - A margin-box selector string (a key of `elements`).
	 * @return {number} A weight from 1 to 7.
	 */
	pageWeight(s: string): number {
		const parts = s.split(" ")[0].split(".");
		// Drop the empty string before the first class.
		parts.shift();
		let weight = 1;
		if (parts.length === 4) {
			if (/^paged_[\w-]+_first_page$/.test(parts[3])) {
				weight = 7;
			} else if (parts[3] === "paged_left_page" || parts[3] === "paged_right_page") {
				weight = 6;
			}
		} else if (parts.length === 3) {
			if (parts[1] === "paged_named_page") {
				weight = parts[2].indexOf(":nth-of-type") !== -1 ? 7 : 5;
			}
		} else if (parts.length === 2) {
			if (parts[1] === "paged_first_page") {
				weight = 4;
			} else if (parts[1] === "paged_blank_page") {
				weight = 3;
			} else if (parts[1] === "paged_left_page" || parts[1] === "paged_right_page") {
				weight = 2;
			}
		} else {
			// 0, 1 or 5+ classes. For an empty class list parts[0] is
			// undefined and reading indexOf throws.
			if (parts[0].indexOf(":nth-of-type") !== -1) {
				weight = 4;
			}
		}
		return weight;
	}

	/**
	 * Orders margin-box selectors for injection: bucketed by `pageWeight` and
	 * concatenated from weight 1 to 7, so higher-weight (more specific page
	 * context) selectors are processed later and win. Within a weight bucket
	 * selectors are prepended, so the earliest-inserted selector is processed
	 * last and wins over later-inserted same-weight selectors.
	 * @param {ElementContentData} obj - The element-reference registry.
	 * @return {string[]} The ordered selector keys.
	 */
	orderSelectors(obj: ElementContentData): string[] {
		const buckets: string[][] = [];
		for (let i = 0; i <= 7; i++) {
			buckets.push([]);
		}
		for (const key of Object.keys(obj)) {
			const weight = this.pageWeight(key);
			buckets[weight].unshift(key);
		}
		let ordered: string[] = [];
		for (let i = 1; i <= 7; i++) {
			ordered = ordered.concat(buckets[i]);
		}
		return ordered;
	}
}

export default RunningHeaders;
