import Handler, { type HandlerSource } from "../handler.js";
import csstree from "css-tree";
import type { CssNode, List } from "css-tree";

interface RuleContext {
	ruleNode: CssNode;
	[key: string]: any;
}

/** Root-level column configuration captured from `body`/`html` rules. */
interface RootColumnCssConfig {
	count?: number
	gap?: string
	fill?: "auto" | "balance"
	ruleColor?: string
	ruleStyle?: string
	ruleWidth?: string
}

/**
 * Declaration properties that participate in CSS multi-column layout. When
 * any of them appears in a rule, the rule's selectors are recorded so that
 * the layout stage can identify rendered fragmentainer roots.
 */
const COLUMN_PROPERTIES = [
	"column-count",
	"column-width",
	"columns",
	"column-fill",
	"column-gap",
	"column-span",
	"column-rule",
	"column-rule-color",
	"column-rule-style",
	"column-rule-width",
];

/**
 * Tracks multi-column rules from author CSS.
 *
 * For content-level selectors the declarations are left in place so that
 * cloned page content receives the browser's native multi-column
 * formatting; this handler records which selectors produce fragmentainers
 * and hands that knowledge to the chunker for use during layout.
 *
 * Column declarations on `body`/`html` are treated as *root-level* column
 * configuration instead: they are captured into `rootColumnsFromCss` for
 * the chunker (which applies them to each page's flow wrapper) and removed
 * from the stylesheet. Shipping them would restyle the host document —
 * most visibly turning the rendered page list itself into a browser
 * multicol container.
 *
 * Nested multicol (a fragmentainer inside another fragmentainer) is not
 * supported; the layout stage degrades the inner container to a single
 * column and warns.
 */
class Columns extends Handler {
	/** Selectors seen in author CSS that declare multi-column formatting. */
	multicolSelectors: Set<string>;
	/** Selectors declaring `column-span: all` (full-width rows). */
	columnSpanSelectors: Set<string>;
	/** Root-level config assembled from body/html column declarations. */
	rootColumnsFromCss: RootColumnCssConfig;
	/**
	 * Whether an `!important` root column-count was seen; further
	 * non-important declarations must not override it.
	 */
	private rootColumnsCountLocked = false;

	constructor(
		chunker?: HandlerSource,
		polisher?: HandlerSource,
		caller?: HandlerSource,
	) {
		super(chunker, polisher, caller);

		this.multicolSelectors = new Set();
		this.columnSpanSelectors = new Set();
		this.rootColumnsFromCss = {};
	}

	/**
	 * Whether a selector targets the document root elements, making its
	 * column declarations a root-level configuration rather than styling
	 * for flow content.
	 */
	private isRootSelector(selector: string): boolean {
		return /^(\*|html|body)$/i.test(selector);
	}

	/**
	 * Extracts the column count from a `column-count` / `columns`
	 * declaration value, or undefined when the value carries none
	 * (e.g. `columns: <width>` alone).
	 */
	private countFromDeclaration(value: CssNode): number | undefined {
		const children = value.children as List<CssNode> | undefined;
		if (!children) {
			return undefined;
		}
		let count: number | undefined;
		children.forEach((child) => {
			if (count !== undefined) {
				return;
			}
			if (child.type === "Number") {
				count = parseInt(child.value, 10);
			} else if (child.type === "Dimension" && child.unit === "") {
				count = parseInt(child.value, 10);
			}
		});
		return count !== undefined && Number.isFinite(count) ? count : undefined;
	}

	onDeclaration(
		declaration: CssNode,
		dItem: List.Cursor,
		dList: List,
		rule: RuleContext,
	) {
		const property = declaration.property;

		if (!COLUMN_PROPERTIES.includes(property)) {
			return;
		}

		const prelude = rule.ruleNode.prelude;
		if (!prelude) {
			return;
		}

		const selector = csstree.generate(prelude);
		const selectors = selector
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		const isRoot = selectors.some((s) => this.isRootSelector(s));

		selectors.forEach((s) => {
			this.multicolSelectors.add(s);

			// Share with the chunker so the layout stage can find the
			// rendered fragmentainer roots for each page.
			const chunker = this.chunker as unknown as
				| { multicolSelectors?: Set<string>; columnSpanSelectors?: Set<string> }
				| null
				| undefined;
			if (chunker && chunker.multicolSelectors) {
				chunker.multicolSelectors.add(s);
			}

			// `column-span: all` selectors drive the manual column engine's
			// full-width rows; track them for the layout stage too.
			if (property === "column-span") {
				this.columnSpanSelectors.add(s);
				if (chunker && chunker.columnSpanSelectors) {
					chunker.columnSpanSelectors.add(s);
				}
			}
		});

		if (isRoot) {
			const rawValue = csstree.generate(declaration.value).trim();
			const value = rawValue.toLowerCase();
			if (property === "column-count" || property === "columns") {
				const count = this.countFromDeclaration(declaration.value);
				// Record the declared count, honoring cascade importance:
				// an `!important` declaration locks the value so later
				// (non-important) rules cannot overwrite it. A count of 1 is
				// kept as-is — detection interprets it as "no multicol"
				// (single column), letting an override beat an author's
				// `column-count: 2`.
				if (count !== undefined) {
					if (declaration.important || !this.rootColumnsCountLocked) {
						this.rootColumnsFromCss.count = count;
						this.rootColumnsCountLocked = !!declaration.important;
					}
				}
			} else if (property === "column-fill") {
				if (value === "auto" || value === "balance") {
					this.rootColumnsFromCss.fill = value;
				}
			} else if (property === "column-gap") {
				this.rootColumnsFromCss.gap =
					value !== "normal" ? rawValue : undefined;
			} else if (property === "column-rule-color") {
				this.rootColumnsFromCss.ruleColor = value;
			} else if (property === "column-rule-style") {
				this.rootColumnsFromCss.ruleStyle = value;
			} else if (property === "column-rule-width") {
				this.rootColumnsFromCss.ruleWidth = value;
			}

			// Forward whatever is assembled so far on every pass; the last
			// complete assignment wins once all declarations were seen.
			const chunker = this.chunker as unknown as
				| { rootColumnsFromCss?: RootColumnCssConfig }
				| null
				| undefined;
			if (chunker && this.rootColumnsFromCss.count !== undefined) {
				chunker.rootColumnsFromCss = { ...this.rootColumnsFromCss };
			}

			// Strip the declaration: root columns are realized by the
			// library on the page wrappers, never on the host document.
			dList.remove(dItem);
			return;
		}

		// `column-fill: balance` is ignored on fragmentainers that the layout
		// stage constrains to the remaining page height (an inline
		// `column-fill: auto` is applied alongside the height constraint).
		// Nothing to rewrite here on the CSS side.
		void dItem;
		void dList;
	}
}

export default Columns;
