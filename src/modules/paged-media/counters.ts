/**
 * Named CSS counter polyfill: takes over the bookkeeping of every authored
 * counter except the page counter's own increment.
 *
 * CSS counters do not survive the engine's pagination untouched — each page
 * rebuilds a subtree, split elements duplicate, and `target-counter()` cross
 * references need values before the browser computes counters — so this
 * module re-creates the authored counters' effect itself, in three phases:
 *
 * 1. **CSS phase** (polisher's `onDeclaration` hook): `counter-increment` /
 *    `counter-reset` declarations are parsed into per-counter records keyed
 *    by the containing rule's normalized selector, and the consumed value
 *    components are stripped from the stylesheet AST (the whole declaration
 *    is removed once nothing non-whitespace remains), so the browser never
 *    applies them to content elements natively. Identifiers `page` and
 *    `target-counter-*` are left alone (owned by the `PageCounterIncrement`
 *    and `TargetCounters` handlers).
 * 2. **DOM phase** (chunker's `afterParsed` hook): every matching content
 *    element is stamped with data attributes
 *    (`data-counter-<name>-increment` / `data-counter-<name>-reset` plus the
 *    `data-counter-increment` / `data-counter-reset` summaries), the
 *    document-wide running value is precomputed into
 *    `data-counter-<name>-value` (read later by `target-counter()`), and one
 *    real `counter-increment` rule per stamped element is emitted into the
 *    work stylesheet, merged across counters and passes. A final scope rule
 *    re-zeros every custom counter on the `.paged_pages` root.
 * 3. **Pagination phase** (chunker's `afterPageLayout` hook): resets of the
 *    `page`, `footnote` and `footnote-marker` counters found on content
 *    elements become a page-scoped rule that suppresses the page's own
 *    counter increment and re-seeds the counters at that page.
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
 * One captured counter increment, keyed by normalized selector.
 */
interface CounterIncrementRecord {
	selector: string;
	number: number;
}

/**
 * One captured counter reset, keyed by normalized selector. The string case
 * of `number` holds a CSS custom-property name (such as `--chapter-start`)
 * to be resolved from each matched element's inline style at stamp time.
 */
interface CounterResetRecord {
	selector: string;
	number: number | string;
}

/**
 * The bookkeeping for one counter name: increments and resets, each keyed by
 * normalized selector (last capture wins, at the key's first-capture
 * position).
 */
interface CounterEntry {
	name: string;
	increments: Record<string, CounterIncrementRecord>;
	resets: Record<string, CounterResetRecord>;
}

/**
 * The handler's registry, keyed by counter name in first-capture order.
 */
type CountersMap = Record<string, CounterEntry>;

/**
 * Paged-media behavior module that polyfills named CSS counters across the
 * pagination pipeline (see the module doc for the three phases).
 */
class Counters extends Handler {
	/**
	 * The CSSOM object of the polisher's work stylesheet; all emitted rules
	 * are appended here.
	 */
	styleSheet: CSSStyleSheet;

	/**
	 * Counter registry keyed by counter name (exact authored casing);
	 * increments and resets are keyed by normalized selector string.
	 */
	counters: CountersMap;

	/**
	 * data-ref values of page-counter reset elements already accounted for
	 * during pagination (stored values are always the empty string).
	 */
	resetCountersMap: Map<string, string>;

	/**
	 * Wires the handler against the engine objects; subscribes
	 * `onDeclaration` to the polisher's `onDeclaration` hook and
	 * `afterParsed` / `afterPageLayout` to the chunker hooks via the base
	 * class's name-matching auto-registration, then captures the polisher's
	 * work stylesheet and starts the fresh per-instance registries.
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

		this.counters = {};
		this.resetCountersMap = new Map();
	}

	/**
	 * `onDeclaration` hook, fired by the polisher for every declaration of
	 * every parsed stylesheet. For a declaration whose property is exactly
	 * (case-sensitive) `counter-increment` or `counter-reset`, parses the
	 * value into records and strips the consumed components; once no child
	 * with a truthy non-whitespace type remains, the declaration is removed
	 * from its block, so it never reaches the browser natively. Any other
	 * property is ignored entirely.
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
			this.handleIncrement(declaration, rule);
		} else if (declaration.property === "counter-reset") {
			this.handleReset(declaration, rule);
		} else {
			return;
		}

		if (!this.hasNonWhitespaceChildren(declaration.value.children)) {
			dList.remove(dItem);
		}
	}

	/**
	 * Tests whether a css-tree child list still holds content.
	 *
	 * @param {List} children - The list to inspect.
	 * @returns {boolean} `true` iff at least one node has a truthy `type`
	 * that is not exactly `"WhiteSpace"`; nodes with a falsy `type` do not
	 * count as content.
	 */
	hasNonWhitespaceChildren(children: List): boolean {
		let result = false;
		children.forEach((node: CssNode) => {
			if (node.type && node.type !== "WhiteSpace") {
				result = true;
			}
		});
		return result;
	}

	/**
	 * `afterParsed` hook, fired once per pagination flow after the content
	 * fragment is parsed (and its `data-ref` UUIDs assigned), before any
	 * page is created. Stamps the recorded counters onto the content
	 * elements and precomputes their running values, then inserts the
	 * scope rule that re-zeros every custom counter on the `.paged_pages`
	 * root.
	 *
	 * @param {DocumentFragment} parsed - The parsed content fragment.
	 */
	afterParsed(parsed: DocumentFragment): void {
		this.processCounters(parsed, this.counters);
		this.scopeCounters(this.counters);
	}

	/**
	 * Gets or creates the registry entry for a counter name.
	 *
	 * @param {string} name - The counter name (exact authored casing).
	 * @returns {CounterEntry} The existing or freshly created entry.
	 */
	addCounter(name: string): CounterEntry {
		if (name in this.counters) {
			return this.counters[name];
		}

		const counter = { name, increments: {}, resets: {} };
		this.counters[name] = counter;
		return counter;
	}

	/**
	 * Parses one `counter-increment` declaration value into increment
	 * records, one per non-reserved identifier.
	 *
	 * Decision pipeline, per identifier of the value (in order):
	 *
	 * 1. Identifiers `page` and `target-counter-*` are skipped entirely
	 *    (no record, nothing stripped): they belong to the sibling
	 *    `PageCounterIncrement` and `TargetCounters` handlers.
	 * 2. An explicit value is read from a `WhiteSpace` + `Number` pair
	 *    directly after the identifier (`parseInt` of the number's raw
	 *    source, so it truncates toward zero); without a number the value
	 *    is the implicit default `1` (any falsy parse result — including an
	 *    authored `0` — records as `1`).
	 * 3. The containing rule's selector prelude is serialized with
	 *    `csstree.generate` and used as the registry key; a re-capture for
	 *    the same selector overwrites the previous record. There is no
	 *    `@page` guard: a declaration directly inside `@page` has a `null`
	 *    prelude and makes `csstree.generate` throw a `TypeError`.
	 * 4. The consumed nodes (identifier, whitespace, number) are stripped
	 *    from the value; removing the current/upcoming cursors is safe
	 *    mid-iteration.
	 *
	 * @param {CssNode} declaration - The `counter-increment` Declaration node.
	 * @param {RuleContext} rule - The containing rule context.
	 * @returns {CounterIncrementRecord[]} The records created (possibly
	 * empty).
	 */
	handleIncrement(declaration: CssNode, rule: RuleContext): CounterIncrementRecord[] {
		const children = declaration.value.children;
		const increments: CounterIncrementRecord[] = [];

		children.forEach((node: CssNode, item: List.Cursor, list: List) => {
			if (node.type !== "Identifier") {
				return;
			}

			const name = node.name;

			// Reserved identifiers consumed by the page counter and target
			// cross-reference handlers must survive in the stylesheet.
			if (name === "page" || name.startsWith("target-counter-")) {
				return;
			}

			let whitespace = null;
			let number = null;
			if (item.next && item.next.data.type === "WhiteSpace") {
				whitespace = item.next;
				if (whitespace.next && whitespace.next.data.type === "Number") {
					number = whitespace.next;
				}
			}

			const value = number ? parseInt(number.data.value) : undefined;

			const selector = csstree.generate(rule.ruleNode.prelude);
			const counter = this.addCounter(name);
			const increment = { selector, number: value || 1 };
			counter.increments[selector] = increment;
			increments.push(increment);

			list.remove(item);
			if (whitespace) {
				list.remove(whitespace);
			}
			if (number) {
				list.remove(number);
			}
		});

		return increments;
	}

	/**
	 * Parses one `counter-reset` declaration value into reset records; same
	 * iteration shape as {@link handleIncrement} with these differences:
	 *
	 * 1. An explicit value may also be a `var()` function: its first
	 *    child's name (a custom-property string) is recorded and resolved
	 *    from each matched element's inline style at stamp time; any
	 *    fallback arguments are ignored.
	 * 2. A reset declared directly in an `@page` at-rule (any variant, its
	 *    prelude not consulted) is recorded under the constant selector
	 *    `.paged_page` and its value children are left completely
	 *    untouched — the declaration survives into the serialized CSS and
	 *    the browser applies it natively in page context.
	 * 3. A `footnote` reset first appends a `footnote-marker 0` pair to the
	 *    value, which the ongoing iteration then processes as an ordinary
	 *    reset — so every authored `footnote` reset produces a matching
	 *    `footnote-marker` reset under the same selector.
	 *
	 * @param {CssNode} declaration - The `counter-reset` Declaration node.
	 * @param {RuleContext} rule - The containing rule context.
	 */
	handleReset(declaration: CssNode, rule: RuleContext): void {
		const children = declaration.value.children;

		children.forEach((node: CssNode, item: List.Cursor, list: List) => {
			if (node.type !== "Identifier") {
				return;
			}

			const name = node.name;

			let whitespace = null;
			let valueNode: any = null;
			if (item.next && item.next.data.type === "WhiteSpace") {
				whitespace = item.next;
				if (whitespace.next) {
					const next = whitespace.next.data;
					if (next.type === "Number" || (next.type === "Function" && next.name === "var")) {
						valueNode = whitespace.next;
					}
				}
			}

			let value: string | number | undefined;
			if (valueNode) {
				value =
					valueNode.data.type === "Number"
						? parseInt(valueNode.data.value)
						: valueNode.data.children.first().name;
			}

			let selector: string;
			if (rule.ruleNode.name === "page" && rule.ruleNode.type === "Atrule") {
				// Resets in `@page` (any variant) are recorded for the page
				// box but left in the CSS for the browser to apply natively.
				selector = ".paged_page";
			} else {
				selector = csstree.generate(rule.ruleNode.prelude || rule.ruleNode);
			}

			if (name === "footnote") {
				this.addFootnoteMarkerCounter(children);
			}

			const counter = this.addCounter(name);
			counter.resets[selector] = { selector, number: value || 0 };

			if (selector !== ".paged_page") {
				list.remove(item);
				if (whitespace) {
					list.remove(whitespace);
				}
				if (valueNode) {
					list.remove(valueNode);
				}
			}
		});
	}

	/**
	 * Stamps every recorded counter onto the parsed content fragment:
	 * per counter, increments then resets, then (except for the `page`
	 * counter) the precomputed running values.
	 *
	 * @param {DocumentFragment} parsed - The parsed content fragment.
	 * @param {CountersMap} counters - The registry to process (the same
	 * object as `this.counters` in engine use).
	 */
	processCounters(parsed: DocumentFragment, counters: CountersMap): void {
		for (const name in counters) {
			const counter = counters[name];
			this.processCounterIncrements(parsed, counter);
			this.processCounterResets(parsed, counter);
			if (counter.name !== "page") {
				this.addCounterValues(parsed, counter);
			}
		}
	}

	/**
	 * Inserts the scope rule that defines (and zeros) every custom counter
	 * at the common `.paged_pages` root, so content increments are not reset
	 * by page boundaries and do not leak outside the pagination output. The
	 * fixed tail entries (`page 0`, `pages var(--paged-page-count)`,
	 * `footnote var(--paged-footnotes-count)`,
	 * `footnote-marker var(--paged-footnotes-count)`) are always present.
	 *
	 * @param {CountersMap} counters - The registry whose names (except
	 * `page`, in insertion order) are zeroed.
	 */
	scopeCounters(counters: CountersMap): void {
		const scopes: string[] = [];
		for (const name in counters) {
			if (name !== "page") {
				scopes.push(`${name} 0`);
			}
		}

		this.insertRule(
			`.paged_pages { counter-reset: ${scopes.join(" ")} page 0 pages var(--paged-page-count) footnote var(--paged-footnotes-count) footnote-marker var(--paged-footnotes-count)}`
		);
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

	/**
	 * Stamps one counter's increment records onto the parsed fragment: per
	 * record (registry insertion order), every matching element (document
	 * order) gets `data-counter-<name>-increment` set to the record's
	 * number, and the `data-counter-increment` summary attribute appended
	 * with the counter name.
	 *
	 * @param {DocumentFragment} parsed - The parsed content fragment.
	 * @param {CounterEntry} counter - The counter entry to process.
	 */
	processCounterIncrements(parsed: DocumentFragment, counter: CounterEntry): void {
		for (const selector in counter.increments) {
			const record = counter.increments[selector];
			const elements = parsed.querySelectorAll(record.selector);

			for (const element of elements) {
				element.setAttribute(`data-counter-${counter.name}-increment`, String(record.number));

				const existing = element.getAttribute("data-counter-increment");
				if (existing) {
					element.setAttribute("data-counter-increment", `${existing} ${counter.name}`);
				} else {
					element.setAttribute("data-counter-increment", counter.name);
				}
			}
		}
	}

	/**
	 * Stamps one counter's reset records onto the parsed fragment: per
	 * record (registry insertion order), every matching element (document
	 * order) gets `data-counter-<name>-reset` set to the record's value,
	 * and the `data-counter-reset` summary attribute appended with the
	 * counter name. A var() reference (a string starting with `--`) is
	 * resolved against the element's inline style only, falling back to `0`.
	 *
	 * @param {DocumentFragment} parsed - The parsed content fragment.
	 * @param {CounterEntry} counter - The counter entry to process.
	 */
	processCounterResets(parsed: DocumentFragment, counter: CounterEntry): void {
		for (const selector in counter.resets) {
			const record = counter.resets[selector];
			const elements = parsed.querySelectorAll(record.selector);

			for (const element of elements) {
				let value = record.number;
				if (typeof value === "string" && value.startsWith("--")) {
					value = element.style.getPropertyValue(value) || 0;
				}

				element.setAttribute(`data-counter-${counter.name}-reset`, String(value));

				const existing = element.getAttribute("data-counter-reset");
				if (existing) {
					element.setAttribute("data-counter-reset", `${existing} ${counter.name}`);
				} else {
					element.setAttribute("data-counter-reset", counter.name);
				}
			}
		}
	}

	/**
	 * Precomputes the document-wide running value of one counter across the
	 * whole source fragment: the document-order union of its reset and
	 * increment elements is walked with a running count (starting at `0`,
	 * guaranteed by the scope rule), each reset emulated as a relative
	 * increment against that count, and each incrementing element gets its
	 * running value stamped as `data-counter-<name>-value` — the contract
	 * consumed by `target-counter()` / `target-counters()`. Only elements
	 * with an increment get a value attribute.
	 *
	 * @param {DocumentFragment} parsed - The parsed content fragment.
	 * @param {CounterEntry} counter - The counter entry to process.
	 */
	addCounterValues(parsed: DocumentFragment, counter: CounterEntry): void {
		if (counter.name === "page" || counter.name === "footnote") {
			return;
		}

		const elements = parsed.querySelectorAll(
			`[data-counter-${counter.name}-reset], [data-counter-${counter.name}-increment]`
		);

		let count = 0;
		for (const element of elements) {
			const incrementArray: string[] = [];

			if (element.hasAttribute(`data-counter-${counter.name}-reset`)) {
				const resetValue = parseInt(element.getAttribute(`data-counter-${counter.name}-reset`) as string);
				// Emulate the reset as a relative increment against the
				// running value.
				incrementArray.push(`${counter.name} ${resetValue - count}`);
				count = resetValue;
			}

			if (element.hasAttribute(`data-counter-${counter.name}-increment`)) {
				const incrementValue = parseInt(
					element.getAttribute(`data-counter-${counter.name}-increment`) as string
				);
				count += incrementValue;
				element.setAttribute(`data-counter-${counter.name}-value`, String(count));
				incrementArray.push(`${counter.name} ${incrementValue}`);
			}

			if (incrementArray.length) {
				this.incrementCounterForElement(element as HTMLElement, incrementArray);
			}
		}
	}

	/**
	 * Appends a `footnote-marker 0` reset pair to a `counter-reset` value
	 * list, so a `footnote` counter reset always comes with a matching
	 * `footnote-marker` reset. The four appended nodes join the tail of the
	 * list; the caller's in-flight iteration then processes the appended
	 * identifier as an ordinary reset.
	 *
	 * The "already added" guard walks the list for identifiers first — with
	 * css-tree 1.1.3 walking a bare `List` visits nothing, so the guard
	 * (which also checks the name `footnote-maker`) never fires and the
	 * insertion happens for every `footnote` identifier encountered.
	 *
	 * @param {List} list - The declaration's value child list.
	 */
	addFootnoteMarkerCounter(list: List): void {
		const names: string[] = [];
		csstree.walk(list, {
			visit: "Identifier",
			enter: (node: CssNode) => {
				names.push(node.name);
			},
		});

		if (names.includes("footnote-maker")) {
			return;
		}

		list.insertData({ type: "WhiteSpace", value: " " });
		list.insertData({ type: "Identifier", name: "footnote-marker" });
		list.insertData({ type: "WhiteSpace", value: " " });
		list.insertData({ type: "Number", value: 0 });
	}

	/**
	 * Emits (or re-emits) one `counter-increment` rule for an element, keyed
	 * on its `data-ref` and confined to the original fragment with
	 * `:not([data-split-from])` so a split continuation never re-increments.
	 *
	 * Because `counter-increment` is a single property and the new rule sits
	 * after any earlier rule for the same element, the merged rule carries
	 * all previously recorded counters: the work stylesheet is scanned for
	 * earlier rules of the same element (matched on the exact serialized
	 * selector and a first style property of `counter-increment`), their
	 * values are folded with the new increments by the keep-last operator,
	 * while the new increments themselves are folded by summing values per
	 * counter name (combining an element's simultaneous reset delta and
	 * increment).
	 *
	 * @param {HTMLElement} element - The stamped element (identified by its
	 * `data-ref`).
	 * @param {string[]} incrementArray - `name value` strings for this pass.
	 */
	incrementCounterForElement(element: HTMLElement, incrementArray: string[]): void {
		if (!element || !incrementArray || !incrementArray.length) {
			return;
		}

		const ref = element.dataset.ref;
		const selector = `[data-ref="${ref}"]:not([data-split-from])`;

		const increments: string[] = [];
		for (const rule of Array.from(this.styleSheet.cssRules)) {
			if ((rule as CSSStyleRule).selectorText === selector && (rule as any).style[0] === "counter-increment") {
				increments.push((rule as any).style.counterIncrement);
			}
		}

		increments.push(
			this.mergeIncrements(incrementArray, (prev, next) => (parseInt(prev as string) || 0) + (parseInt(next as string) || 0))
		);

		const merged = this.mergeIncrements(increments, (prev, next) => next);

		this.insertRule(`${selector} { counter-increment: ${merged} }`);
	}

	/**
	 * Folds `name value` pairs: each input string is split on single spaces
	 * and consumed as consecutive (name, value) pairs; for each pair the
	 * per-name accumulator is replaced by `operator(previousValue, value)`
	 * (previous value `undefined` on first occurrence). Returns all
	 * accumulated names joined as `name1 value1 name2 value2 …`, in
	 * first-occurrence order of the names.
	 *
	 * @param {string[]} incrementArray - The `name value` strings to fold.
	 * @param {Function} operator - Combines the previous accumulator value
	 * with the next raw value (the module uses a `parseInt`-based sum and a
	 * keep-last operator).
	 * @returns {string} The merged `counter-increment` declaration value.
	 */
	mergeIncrements(
		incrementArray: string[],
		operator: (prev: string | undefined, next: string | undefined) => string | number | undefined
	): string {
		const merged: Record<string, string | number | undefined> = {};

		for (const increment of incrementArray) {
			const values = increment.split(" ");
			for (let i = 0; i < values.length; i += 2) {
				const name = values[i];
				merged[name] = operator(merged[name] as string | undefined, values[i + 1]);
			}
		}

		const result: string[] = [];
		for (const name in merged) {
			result.push(`${name} ${merged[name]}`);
		}
		return result.join(" ");
	}

	/**
	 * `afterPageLayout` hook, fired once per laid-out page. Resets of the
	 * `page`, `footnote` and `footnote-marker` counters found on the page's
	 * content elements (stamped during the DOM phase) are translated into
	 * one page-scoped rule that suppresses the page's own counter increment
	 * (`counter-increment: none`) and re-seeds the counters at that page
	 * box; following pages continue from the seeded value.
	 *
	 * Page-counter resets are deduped by the element's `data-ref` (guards
	 * duplicate rules when a page is laid out again); split continuations
	 * are excluded by `:not([data-split-from])`. Footnote resets are never
	 * deduped and always emit both the `footnote` and the `footnote-marker`
	 * token.
	 *
	 * @param {HTMLElement} pageElement - The page's root element (tagged
	 * with the 1-based `data-page-number` attribute).
	 * @param {unknown} page - The page object; ignored.
	 */
	afterPageLayout(pageElement: HTMLElement, page: any): void {
		const resets: string[] = [];

		const pageCounterResets = pageElement.querySelectorAll("[data-counter-page-reset]:not([data-split-from])");
		for (const element of pageCounterResets) {
			const ref = element.dataset.ref;
			if (ref && this.resetCountersMap.has(ref)) {
				continue;
			}
			if (ref) {
				this.resetCountersMap.set(ref, "");
			}
			resets.push(`page ${element.dataset.counterPageReset}`);
		}

		const footnoteResets = pageElement.querySelectorAll("[data-counter-footnote-reset]:not([data-split-from])");
		for (const element of footnoteResets) {
			const value = element.dataset.counterFootnoteReset;
			resets.push(`footnote ${value}`, `footnote-marker ${value}`);
		}

		if (resets.length) {
			const pageNumber = pageElement.dataset.pageNumber;
			this.insertRule(`[data-page-number="${pageNumber}"] { counter-increment: none; counter-reset: ${resets.join(" ")} }`);
		}
	}
}

export default Counters;
