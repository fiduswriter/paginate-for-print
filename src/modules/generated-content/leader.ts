import Handler, { type HandlerSource } from "../handler.js";
import csstree from "css-tree";
import type { CssNode, List } from "css-tree";

interface LeaderRule {
	selector: string;
	parentSelector: string;
	pseudo: string;
	style: string;
	hasOtherContent: boolean;
}

/**
 * Handles CSS `leader()` functions used in `content` declarations.
 *
 * The polyfill rewrites the rule so the leader becomes a flexible pseudo-element
 * between the element's main content and any trailing generated content (e.g. a
 * page number from `target-counter()`). The parent is set to `display: flex` and
 * a new pseudo-element is injected with `flex: 1` and a repeating background.
 *
 * Supported leader styles:
 * - `leader(dotted)`, `leader('.')` — dotted leader
 * - `leader(solid)`, `leader('-')` — solid underline leader
 * - `leader(space)` — blank flexible space
 *
 * Limitations: leaders placed in `::before` are supported, but the generated
 * leader pseudo-element may clash with an existing pseudo-element on the same
 * side. The common TOC pattern (`::after` with leader + page number) is safe.
 */
class Leader extends Handler {
	leaders: LeaderRule[];

	constructor(
		chunker?: HandlerSource,
		polisher?: HandlerSource,
		caller?: HandlerSource,
	) {
		super(chunker, polisher, caller);
		this.leaders = [];
	}

	onDeclaration(
		declaration: CssNode,
		dItem: List.Cursor,
		dList: List,
		rule: { ruleNode: CssNode },
	) {
		if (declaration.property !== "content") {
			return;
		}

		let value = declaration.value;
		if (!value || !value.children) {
			return;
		}

		let children = value.children as List<CssNode>;
		let leaderItem: any = null;
		let leaderStyle: string | null = null;
		let hasOtherContent = false;

		children.forEach((child, item) => {
			if (child.type === "Function" && child.name === "leader") {
				leaderItem = item;
				leaderStyle = this.leaderStyle(child);
			} else if (child.type !== "WhiteSpace") {
				hasOtherContent = true;
			}
		});

		if (!leaderItem || !leaderStyle) {
			return;
		}

		let selector = csstree.generate(rule.ruleNode.prelude);
		let parsed = this.parseSelector(selector);
		if (!parsed) {
			return;
		}

		// Remove the leader function and adjacent whitespace from the content.
		children.remove(leaderItem);
		if (leaderItem.next && leaderItem.next.data.type === "WhiteSpace") {
			children.remove(leaderItem.next);
		} else if (leaderItem.prev && leaderItem.prev.data.type === "WhiteSpace") {
			children.remove(leaderItem.prev);
		}

		// If nothing remains, drop the whole declaration.
		if (!hasOtherContent) {
			dList.remove(dItem);
		}

		selector.split(",").forEach((s) => {
			let trimmed = s.trim();
			let p = this.parseSelector(trimmed);
			if (!p) {
				return;
			}
			this.leaders.push({
				selector: trimmed,
				parentSelector: p.parentSelector,
				pseudo: p.pseudo,
				style: leaderStyle!,
				hasOtherContent,
			});
		});
	}

	/**
	 * Extracts the leader style from the function argument.
	 */
	leaderStyle(funcNode: CssNode): string {
		let first = funcNode.children.first();
		if (!first) {
			return "dotted";
		}
		if (first.type === "Identifier") {
			return first.name;
		}
		if (first.type === "String" || first.type === "Raw") {
			let value = String(first.value).replace(/["']/g, "").trim();
			return value || "dotted";
		}
		return "dotted";
	}

	/**
	 * Splits a selector like `.toc a::after` into parent `.toc a` and pseudo
	 * `::after`. Returns null when no pseudo-element is present.
	 */
	parseSelector(
		selector: string,
	): { parentSelector: string; pseudo: string } | null {
		let match = selector.match(/(.*)(::before|::after)$/i);
		if (!match) {
			return null;
		}
		return {
			parentSelector: match[1].trim(),
			pseudo: match[2].toLowerCase(),
		};
	}

	/**
	 * Builds the leader background declaration for a given style.
	 */
	leaderBackground(style: string): string {
		if (style === "space") {
			return "";
		}
		if (style === "solid" || style === "-") {
			return (
				"border-bottom: 1px solid currentColor; " +
				"margin-bottom: 0.35em; background: none;"
			);
		}
		// Default: dotted (also covers leader('.') and unknown chars).
		return (
			"background-image: radial-gradient(circle, currentColor 1px, transparent 1px); " +
			"background-size: 0.5em 0.5em; " +
			"background-repeat: repeat-x; " +
			"background-position: left 0.85em;"
		);
	}

	/**
	 * Injects the flex parent rule and the leader pseudo-element rule into the
	 * stylesheet after the tree walk has collected all leader uses.
	 */
	afterTreeWalk(ast: CssNode, sheet: { insertRule: (rule: CssNode) => void }) {
		this.leaders.forEach((entry) => {
			let leaderPseudo = entry.pseudo === "::after" ? "::before" : "::after";
			let css = `${entry.parentSelector} {
				display: flex;
				align-items: baseline;
			}
			${entry.parentSelector}${leaderPseudo} {
				content: "";
				flex: 1 1 auto;
				order: 1;
				margin: 0 0.25em;
				${this.leaderBackground(entry.style)}
			}`;

			if (entry.hasOtherContent) {
				// Keep the original pseudo content (e.g. page number) after the leader.
				css += `\n${entry.selector} { order: 2; }`;
			}

			let parsed = csstree.parse(css, { context: "stylesheet" });
			if (parsed.type === "StyleSheet" && parsed.children) {
				parsed.children.forEach((rule: CssNode) => {
					sheet.insertRule(rule);
				});
			}
		});
	}
}

export default Leader;
