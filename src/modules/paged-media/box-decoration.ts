import Handler, { type HandlerSource } from "../handler.js";
import csstree from "css-tree";
import type { CssNode, List } from "css-tree";

interface RuleContext {
	ruleNode: CssNode;
	[key: string]: any;
}

/**
 * Handles CSS `box-decoration-break: clone` for elements that are split across
 * pages or columns.
 *
 * The polyfill's base stylesheet removes top/bottom margins and padding from
 * split fragments (`[data-split-from]` / `[data-split-to]`) to emulate the
 * default slice behaviour. When an author asks for `box-decoration-break:
 * clone`, this handler marks the matching elements so those properties are
 * restored on every fragment.
 */
class BoxDecoration extends Handler {
	cloneSelectors: Set<string>;

	constructor(
		chunker?: HandlerSource,
		polisher?: HandlerSource,
		caller?: HandlerSource,
	) {
		super(chunker, polisher, caller);
		this.cloneSelectors = new Set();
	}

	onDeclaration(
		declaration: CssNode,
		dItem: List.Cursor,
		dList: List,
		rule: RuleContext,
	) {
		if (declaration.property !== "box-decoration-break") {
			return;
		}

		let value = csstree.generate(declaration.value).trim().toLowerCase();
		if (value !== "clone") {
			return;
		}

		let selector = csstree.generate(rule.ruleNode.prelude);
		selector.split(",").forEach((s) => {
			this.cloneSelectors.add(s.trim());
		});

		// Leave the declaration in place so the browser can also apply it where
		// it understands it; the polyfill's split styling is gated by the data
		// attribute added in afterParsed.
	}

	afterParsed(fragment: ParentNode) {
		for (let selector of this.cloneSelectors) {
			let elements: NodeListOf<Element>;
			try {
				elements = fragment.querySelectorAll(selector);
			} catch {
				console.warn(
					"paged-with-floats: invalid box-decoration-break selector:",
					selector,
				);
				continue;
			}
			elements.forEach((element) => {
				element.setAttribute("data-paged-box-decoration", "clone");
			});
		}
	}
}

export default BoxDecoration;
