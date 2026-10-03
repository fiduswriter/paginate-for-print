import Handler from "../handler.js";
import type { HandlerSource } from "../handler.js";
import csstree from "css-tree";
import type { CssNode, List } from "css-tree";

interface RuleContext {
	ruleNode: CssNode;
	[key: string]: any;
}

interface InitialLetterRule {
	selector: string;
	value: string;
}

/**
 * Polyfills the CSS `initial-letter` property for browsers that do not
 * implement it natively (or where the polyfill's own reset suppresses it).
 *
 * The implementation wraps the first grapheme cluster of affected blocks in
 * a floated span sized to span the requested number of line heights. This
 * produces a basic drop/raised cap effect while the surrounding text wraps.
 *
 * Only the first numeric value of `initial-letter: <size> <drop>` is used
 * for sizing; the drop value is honored as the same value when omitted, which
 * matches the common drop-cap case.
 */
class InitialLetter extends Handler {
	rules: InitialLetterRule[];

	constructor(
		chunker?: HandlerSource,
		polisher?: HandlerSource,
		caller?: HandlerSource,
	) {
		super(chunker, polisher, caller);
		this.rules = [];
	}

	onDeclaration(
		declaration: CssNode,
		dItem: List.Cursor,
		dList: List,
		rule: RuleContext,
	) {
		if (declaration.property !== "initial-letter") {
			return;
		}

		const value = csstree.generate(declaration.value).trim();
		const selector = csstree.generate(rule.ruleNode.prelude);

		selector.split(",").forEach((s) => {
			this.rules.push({
				selector: s.trim(),
				value,
			});
		});

		// Leave the declaration in place so native implementations can still
		// use it; the polyfill adds a floated wrapper span in afterParsed.
	}

	afterParsed(parsed: Document | Element) {
		for (const rule of this.rules) {
			let elements: NodeListOf<Element>;
			try {
				elements = parsed.querySelectorAll(rule.selector);
			} catch {
				console.warn(
					"paged-with-floats: invalid initial-letter selector:",
					rule.selector,
				);
				continue;
			}

			const size = this.parseSize(rule.value);
			if (!size) {
				continue;
			}

			Array.from(elements).forEach((element) => {
				if (!(element instanceof HTMLElement)) {
					return;
				}
				this.applyInitialLetter(element, size);
			});
		}
	}

	/**
	 * Parses the first numeric value from an `initial-letter` declaration.
	 * Returns undefined for `normal` or unparseable values.
	 */
	private parseSize(value: string): number | undefined {
		const normalized = value.toLowerCase().trim();
		if (normalized === "normal" || normalized === "auto") {
			return undefined;
		}
		const match = normalized.match(/^([0-9]*\.?[0-9]+)/);
		if (!match) {
			return undefined;
		}
		const size = parseFloat(match[1]);
		return size > 0 ? size : undefined;
	}

	/**
	 * Wraps the first textual grapheme cluster of an element in a floated
	 * span sized to span `size` line heights.
	 */
	private applyInitialLetter(element: HTMLElement, size: number): void {
		const firstText = this.firstTextNode(element);
		if (!firstText || !firstText.data) {
			return;
		}

		const letter = this.firstGrapheme(firstText.data);
		if (!letter) {
			return;
		}

		const span = document.createElement("span");
		span.classList.add("paged_initial_letter");
		span.textContent = letter;
		// The line count lets the layout engine reserve room for the float
		// (a drop cap's first line box spans all of it) when deciding whether
		// a following block fits below a column-span heading.
		span.dataset.pagedInitialLetterLines = String(size);
		span.style.cssText =
			"float: left; " +
			"font-size: calc(" + size + " * 1lh); " +
			"line-height: 1; " +
			"padding-right: 0.1em; " +
			"margin-top: 0.05em;";

		const remaining = firstText.data.slice(letter.length);
		if (remaining) {
			firstText.data = remaining;
			firstText.parentNode!.insertBefore(span, firstText);
		} else {
			firstText.parentNode!.replaceChild(span, firstText);
		}
	}

	/**
	 * Finds the first visible text node inside an element, ignoring
	 * whitespace-only nodes.
	 */
	private firstTextNode(element: HTMLElement): Text | null {
		const walker = document.createTreeWalker(
			element,
			NodeFilter.SHOW_TEXT,
			{
				acceptNode: (node) => {
					const text = node as Text;
					if (!text.data || !text.data.trim().length) {
						return NodeFilter.FILTER_SKIP;
					}
					return NodeFilter.FILTER_ACCEPT;
				},
			},
		);
		return walker.nextNode() as Text | null;
	}

	/**
	 * Returns the first grapheme cluster of a string. Uses Intl.Segmenter
	 * when available, falling back to the first code unit.
	 */
	private firstGrapheme(text: string): string {
		if (typeof Intl !== "undefined" && (Intl as any).Segmenter) {
			const segmenter = new (Intl as any).Segmenter("en", {
				granularity: "grapheme",
			});
			const iterator = segmenter.segment(text)[Symbol.iterator]();
			const first = iterator.next().value;
			if (first && first.segment) {
				return first.segment;
			}
		}
		return text.charAt(0);
	}
}

export default InitialLetter;
