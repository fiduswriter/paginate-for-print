/**
 * `@page` handler: the paged-media module that turns author `@page` rules
 * into CSS the paginated rendering can actually apply.
 *
 * The module has two halves. The CSS-processing half runs during each
 * stylesheet parse: every `@page` at-rule is consumed via the polisher's
 * `onAtPage` hook, extracting page names, pseudo selectors (`:left`,
 * `:right`, `:first`, `:blank`, `:recto`, `:verso`), `:nth(...)` arguments,
 * margin boxes (`@top-center`, `@bottom-left-corner`, ...), `@footnote`
 * blocks and the `size`, `bleed`, `marks`, `margin*`, `padding*` and
 * `border*` declarations into a per-selector page model registry. The
 * at-rules are removed from the stylesheet AST. At `afterTreeWalk` the
 * equivalent author CSS is re-emitted: one plain rule per page class
 * (`.paged_page.paged_chapter_page { ... }`), margin-box style, display and
 * content rules, a `:root` rule carrying all `--paged-*` custom properties
 * (page size, per-side bleed, marks visibility, orientation), and synthetic
 * `@page` / `@page :left` / `@page :right` at-rules carrying the physical
 * (bleed-inclusive) page size.
 *
 * The chunker half runs during pagination: named-page classes are stamped on
 * rendered page elements based on the `data-page` bookkeeping other handlers
 * wrote, footnote-only pages are re-attributed to the previous page's named
 * context, and `finalizePage` computes per-page inline
 * `grid-template-columns` / `grid-template-rows` for the margin-box groups
 * that actually carry content.
 *
 * The handler is an event emitter; it emits `size` and `atpages` (the live
 * page registry) once per stylesheet whose bare `@page` rule carries a size
 * that is new to the handler. All emitted CSS strings are the serialized
 * (minified) css-tree form.
 */
import Handler from "../handler.js";
import csstree from "css-tree";
import type { CssNode, List } from "css-tree";
import type { HandlerSource } from "../handler.js";
import pageSizes from "../../polisher/sizes.js";
import { findElement, rebuildAncestors } from "../../utils/dom.js";
import { CSSValueToString } from "../../utils/utils.js";

/** One CSS dimension token: a numeric or string magnitude plus a unit. */
interface DimensionValue {
	value: number | string;
	unit: string;
}

/** The parsed `size` declaration. */
interface SizeSpec {
	width?: DimensionValue;
	height?: DimensionValue;
	orientation?: string;
	format?: string;
}

/** Per-side bleed dimensions. */
interface BleedSides {
	top: DimensionValue;
	right: DimensionValue;
	bottom: DimensionValue;
	left: DimensionValue;
}

/** A margin/padding side: empty object when no value was collected. */
type MarginSide = Partial<DimensionValue>;
type MarginSides = Record<string, MarginSide>;

/** Border sides hold generated value strings; empty objects are placeholders. */
type BorderSides = Record<string, string | MarginSide>;

/** css-tree List with the mutation members this module relies on. */
type CssList = List & {
	append(item: CssNode, ref?: List.Cursor): void;
	appendList(items: List): void;
	copy(): CssList;
	createItem(data: CssNode): List.Cursor;
};

interface CssBlockNode {
	type: string;
	loc?: unknown;
	children: CssList;
}

/**
 * One entry of the page model registry, keyed by the serialized `@page`
 * prelude (or `"*"` for a bare `@page`).
 */
interface PageModel {
	selector: string;
	name?: string;
	psuedo?: string;
	nth?: string;
	marginalia: Record<string, CssNode>;
	width?: DimensionValue;
	height?: DimensionValue;
	orientation?: string;
	format?: string;
	size?: SizeSpec;
	bleed?: BleedSides;
	marks?: string[];
	margin: MarginSides;
	padding: MarginSides;
	border: BorderSides;
	backgroundOrigin?: unknown;
	block: CssBlockNode;
	notes?: Record<string, CssNode>;
	added: boolean;
}

/** One margin-box entry, keyed by the serialized full selector. */
interface MarginaliaEntry {
	page: PageModel;
	selector: string;
	block: CssNode;
	hasContent: boolean;
}

/** Declarations collected out of an `@page` block by `replaceDeclarations`. */
interface ParsedDeclarations {
	size?: SizeSpec;
	bleed?: Array<DimensionValue | "auto">;
	marks?: string[];
	margin?: MarginSides;
	padding?: MarginSides;
	border?: BorderSides;
}

/** The part of the Sheet this module drives: appending generated rules. */
interface SheetLike {
	insertRule(rule: CssNode): CssNode;
}

/** One pending-overflow entry of a break token. */
interface OverflowEntry {
	node?: Node;
	topLevel?: boolean;
}

/** The slice of a break token this module reads. */
interface BreakTokenRef {
	node: Node;
	overflow: OverflowEntry[];
}

/** The slice of the chunker's Page objects this module reads and stamps. */
interface ChunkerPage {
	element: HTMLElement;
	wrapper?: HTMLElement;
	footnotesArea: HTMLElement;
	startToken?: BreakTokenRef;
	name?: string;
}

/** The slice of the chunker this module reads during pagination. */
interface ChunkerSource {
	pages: ChunkerPage[];
}

/**
 * Paged-media behavior module implementing CSS `@page` rules: page models,
 * margin boxes, page size/bleed/marks variables, named-page stamping and
 * margin-box grid balancing.
 */
class AtPage extends Handler {
	/** Page model registry keyed by serialized `@page` prelude (or `"*"`). */
	pages: Record<string, PageModel>;
	/** Last size applied to the root variables. */
	width?: DimensionValue;
	height?: DimensionValue;
	orientation?: string;
	/** Format keyword of the last applied size, when any. */
	format?: string;
	/** Margin-box registry keyed by serialized full selector. */
	marginalia: Record<string, MarginaliaEntry>;

	/**
	 * Wires the handler against the engine objects (the base class
	 * auto-registers the `onAtPage`, `afterTreeWalk`, `beforePageLayout`,
	 * `afterPageLayout` and `finalizePage` hooks by method name) and
	 * initializes the page model and margin-box registries.
	 *
	 * @param {HandlerSource} chunker - The chunker, exposing lifecycle hooks.
	 * @param {HandlerSource} polisher - The polisher, exposing CSS hooks.
	 * @param {HandlerSource} caller - The caller (previewer), exposing
	 * preview hooks.
	 */
	constructor(
		chunker?: HandlerSource,
		polisher?: HandlerSource,
		caller?: HandlerSource,
	) {
		super(chunker, polisher, caller);
		this.pages = {};
		this.width = undefined;
		this.height = undefined;
		this.orientation = undefined;
		this.marginalia = {};
	}

	/**
	 * Builds a fresh, unregistered page model: optional fields all own
	 * `undefined`, empty marginalia, the four-side margin/padding/border maps
	 * (keys `top`, `right`, `left`, `bottom`), an empty plain object as the
	 * block placeholder and `added: false`.
	 *
	 * @param {string} selector - The registry key for the model.
	 * @returns {PageModel} The fresh model.
	 */
	pageModel(selector: string): PageModel {
		return {
			selector,
			name: undefined,
			psuedo: undefined,
			nth: undefined,
			marginalia: {},
			width: undefined,
			height: undefined,
			orientation: undefined,
			margin: {
				top: {},
				right: {},
				left: {},
				bottom: {}
			},
			padding: {
				top: {},
				right: {},
				left: {},
				bottom: {}
			},
			border: {
				top: {},
				right: {},
				left: {},
				bottom: {}
			},
			backgroundOrigin: undefined,
			block: {} as CssBlockNode,
			marks: undefined,
			notes: undefined,
			added: false
		};
	}

	/**
	 * `onAtPage` hook, fired by the polisher for every `@page` at-rule.
	 * Extracts the page selector key, merges or creates the page model,
	 * pulls margin boxes, notes and declarations out of the at-rule, and
	 * removes the at-rule from the stylesheet.
	 *
	 * @param {CssNode} node - The `@page` Atrule node.
	 * @param {List.Cursor} item - The at-rule's cursor in its parent list.
	 * @param {List} list - The list containing the at-rule.
	 */
	onAtPage(node: CssNode, item: List.Cursor, list: List): void {
		let named: string | undefined;
		let psuedo: string | undefined;
		let nth: string | undefined;
		let selector: string;

		if (node.prelude) {
			named = this.getTypeSelector(node);
			psuedo = this.getPsuedoSelector(node);
			nth = this.getNthSelector(node);
			selector = csstree.generate(node.prelude);
		} else {
			selector = "*";
		}

		const marginalia = this.replaceMarginalia(node);

		let page: PageModel;
		let needsMerge = false;

		if (selector in this.pages) {
			page = this.pages[selector];
			needsMerge = true;
			page.added = false;
		} else {
			page = this.pageModel(selector);
			this.pages[selector] = page;
		}

		page.name = named;
		page.psuedo = psuedo;
		page.nth = nth;

		if (needsMerge) {
			Object.assign(page.marginalia, marginalia);
		} else {
			page.marginalia = marginalia;
		}

		page.notes = this.replaceNotes(node);

		const declarations = this.replaceDeclarations(node);

		if (declarations.size) {
			page.size = declarations.size;
			page.width = declarations.size.width;
			page.height = declarations.size.height;
			page.orientation = declarations.size.orientation;
			page.format = declarations.size.format;
		}

		if (declarations.bleed && declarations.bleed[0] != "auto") {
			if (declarations.bleed.length === 4) {
				page.bleed = {
					top: declarations.bleed[0] as DimensionValue,
					right: declarations.bleed[1] as DimensionValue,
					bottom: declarations.bleed[2] as DimensionValue,
					left: declarations.bleed[3] as DimensionValue
				};
			} else if (declarations.bleed.length === 3) {
				page.bleed = {
					top: declarations.bleed[0] as DimensionValue,
					right: declarations.bleed[1] as DimensionValue,
					bottom: declarations.bleed[2] as DimensionValue,
					left: declarations.bleed[1] as DimensionValue
				};
			} else if (declarations.bleed.length === 2) {
				page.bleed = {
					top: declarations.bleed[0] as DimensionValue,
					right: declarations.bleed[1] as DimensionValue,
					bottom: declarations.bleed[0] as DimensionValue,
					left: declarations.bleed[1] as DimensionValue
				};
			} else {
				page.bleed = {
					top: declarations.bleed[0] as DimensionValue,
					right: declarations.bleed[0] as DimensionValue,
					bottom: declarations.bleed[0] as DimensionValue,
					left: declarations.bleed[0] as DimensionValue
				};
			}
		}

		if (declarations.marks) {
			if (!declarations.bleed || declarations.bleed[0] == "auto") {
				page.bleed = {
					top: { value: 6, unit: "mm" },
					right: { value: 6, unit: "mm" },
					bottom: { value: 6, unit: "mm" },
					left: { value: 6, unit: "mm" }
				};
			}
			page.marks = declarations.marks;
		}

		if (declarations.margin) {
			page.margin = declarations.margin;
		}

		if (declarations.padding) {
			page.padding = declarations.padding;
		}

		if (declarations.border) {
			page.border = declarations.border;
		}

		if (declarations.marks) {
			page.marks = declarations.marks;
		}

		if (needsMerge) {
			page.block.children.appendList(node.block.children as CssList);
		} else {
			page.block = node.block as CssBlockNode;
		}

		list.remove(item);
	}

	/**
	 * `afterTreeWalk` hook, fired once per parsed stylesheet. Re-inserts the
	 * page class rules (and their satellite margin-box and notes rules), and
	 * — when the bare `@page` rule is new or re-merged and carries a size the
	 * handler has not applied before — appends the `:root` variables rule and
	 * the synthetic `@page` at-rules and emits the `size` and `atpages`
	 * events.
	 *
	 * @param {CssNode} ast - The full stylesheet AST.
	 * @param {SheetLike} sheet - The sheet; its `insertRule` appends rules to
	 * the AST and re-walks their declarations.
	 */
	afterTreeWalk(ast: CssNode, sheet: SheetLike): void {
		const dirtyPage = ("*" in this.pages) && this.pages["*"].added === false;

		this.addPageClasses(this.pages, ast, sheet);

		if (dirtyPage) {
			const { width, height, format, orientation, bleed, marks } = this.pages["*"];
			const bleedverso = this.pages[":left"] ? this.pages[":left"].bleed : undefined;
			const bleedrecto = this.pages[":right"] ? this.pages[":right"].bleed : undefined;

			if (width && height && (this.width !== width || this.height !== height)) {
				this.width = width;
				this.height = height;
				this.format = format;
				this.orientation = orientation;

				this.addRootVars(ast, width, height, orientation, bleed, bleedrecto, bleedverso, marks);
				this.addRootPage(ast, this.pages["*"].size!, bleed, bleedrecto, bleedverso);

				this.emit("size", { width, height, orientation, format, bleed });
				this.emit("atpages", this.pages);
			}
		}
	}

	/**
	 * Returns the page name carried by a `@page` prelude: the last
	 * TypeSelector name found, or `undefined` when the prelude has none.
	 *
	 * @param {CssNode} ast - The at-rule (or prelude) to walk.
	 * @returns {string|undefined} The page name.
	 */
	getTypeSelector(ast: CssNode): string | undefined {
		let named: string | undefined;

		csstree.walk(ast, {
			visit: "TypeSelector",
			enter: (selector) => {
				named = selector.name;
			}
		});

		return named;
	}

	/**
	 * Returns the pseudo-class name of a `@page` prelude (skipping `:nth`),
	 * i.e. `left`, `right`, `first`, `blank`, `recto` or `verso`. The last
	 * non-nth pseudo class selector wins.
	 *
	 * @param {CssNode} ast - The at-rule (or prelude) to walk.
	 * @returns {string|undefined} The pseudo selector name.
	 */
	getPsuedoSelector(ast: CssNode): string | undefined {
		let psuedo: string | undefined;

		csstree.walk(ast, {
			visit: "PseudoClassSelector",
			enter: (selector) => {
				if (selector.name !== "nth") {
					psuedo = selector.name;
				}
			}
		});

		return psuedo;
	}

	/**
	 * Returns the raw argument string of a `@page` prelude's `:nth(...)`
	 * pseudo (css-tree hands it over as a Raw node's value). The last nth
	 * pseudo wins; `undefined` when there is none.
	 *
	 * @param {CssNode} ast - The at-rule (or prelude) to walk.
	 * @returns {string|undefined} The nth argument, e.g. `"2n+1"`.
	 */
	getNthSelector(ast: CssNode): string | undefined {
		let nth: string | undefined;

		csstree.walk(ast, {
			visit: "PseudoClassSelector",
			enter: (selector) => {
				if (selector.name === "nth" && selector.children) {
					nth = selector.children.first().value;
				}
			}
		});

		return nth;
	}

	/**
	 * Pulls the margin-box at-rules (`@top-center`, `@bottom-left-corner`,
	 * ... and the `top`/`bottom`/`left`/`right` aliases, normalized) out of
	 * an `@page` block, mapping region name to the at-rule's Block node, and
	 * removes the at-rules from their list.
	 *
	 * @param {CssNode} ast - The `@page` at-rule whose block to walk.
	 * @returns {Record<string, CssNode>} Region name to Block node, in
	 * document order.
	 */
	replaceMarginalia(ast: CssNode): Record<string, CssNode> {
		const marginBoxes = [
			"top-left-corner",
			"top-left",
			"top-center",
			"top-right",
			"top-right-corner",
			"top-right-corner",
			"bottom-left-corner",
			"bottom-left",
			"bottom-center",
			"bottom-right",
			"bottom-right-corner",
			"left-top",
			"left-middle",
			"left-bottom",
			"right-top",
			"right-middle",
			"right-bottom",
			"right-right-corner",
			"top",
			"bottom",
			"left",
			"right"
		];

		const parsed: Record<string, CssNode> = {};

		csstree.walk(ast.block, {
			visit: "Atrule",
			enter: (node, item, list) => {
				let name = node.name;

				if (marginBoxes.indexOf(name) !== -1) {
					if (name === "top") {
						name = "top-center";
					} else if (name === "bottom") {
						name = "bottom-center";
					} else if (name === "left") {
						name = "left-middle";
					} else if (name === "right") {
						name = "right-middle";
					}

					parsed[name] = node.block;
					list!.remove(item!);
				}
			}
		});

		return parsed;
	}

	/**
	 * Pulls `@footnote` blocks out of an `@page` block, mapping `"footnote"`
	 * to the at-rule's Block node, and removes the at-rule from its list.
	 *
	 * @param {CssNode} ast - The `@page` at-rule whose block to walk.
	 * @returns {Record<string, CssNode>} `{"footnote": Block}` or `{}`.
	 */
	replaceNotes(ast: CssNode): Record<string, CssNode> {
		const parsed: Record<string, CssNode> = {};

		csstree.walk(ast.block, {
			visit: "Atrule",
			enter: (node, item, list) => {
				if (node.name === "footnote") {
					parsed["footnote"] = node.block;
					list!.remove(item!);
				}
			}
		});

		return parsed;
	}

	/**
	 * Collects the handled declarations (`size`, `bleed`, `marks`, `margin`,
	 * `margin-*`, `padding`, `padding-*`, `border`, `border-*`) out of an
	 * `@page` block, removing them as they are matched; everything else stays
	 * in the block for the page class rule.
	 *
	 * @param {CssNode} ast - The `@page` at-rule whose block to walk.
	 * @returns {ParsedDeclarations} The collected declarations.
	 */
	replaceDeclarations(ast: CssNode): ParsedDeclarations {
		const parsed: ParsedDeclarations = {};

		csstree.walk(ast.block, {
			visit: "Declaration",
			enter: (declaration, item, list) => {
				const prop = csstree.property(declaration.property).name;

				if (prop === "marks") {
					const marks: string[] = [];

					csstree.walk(declaration, {
						visit: "Identifier",
						enter: (identifier) => {
							marks.push(identifier.name);
						}
					});

					parsed.marks = marks;
					list!.remove(item!);
				} else if (prop === "margin") {
					parsed.margin = this.getMargins(declaration);
					list!.remove(item!);
				} else if (prop.startsWith("margin-")) {
					const m = prop.slice("margin-".length);
					if (!parsed.margin) {
						parsed.margin = {
							top: {},
							right: {},
							left: {},
							bottom: {}
						};
					}
					parsed.margin[m] = declaration.value.children.first();
					list!.remove(item!);
				} else if (prop === "padding") {
					parsed.padding = this.getPaddings(declaration.value);
					list!.remove(item!);
				} else if (prop.startsWith("padding-")) {
					const p = prop.slice("padding-".length);
					if (!parsed.padding) {
						parsed.padding = {
							top: {},
							right: {},
							left: {},
							bottom: {}
						};
					}
					parsed.padding[p] = declaration.value.children.first();
					list!.remove(item!);
				} else if (prop === "border") {
					if (!parsed.border) {
						parsed.border = {
							top: {},
							right: {},
							left: {},
							bottom: {}
						};
					}
					parsed.border.top = csstree.generate(declaration.value);
					parsed.border.right = csstree.generate(declaration.value);
					parsed.border.bottom = csstree.generate(declaration.value);
					parsed.border.left = csstree.generate(declaration.value);
					list!.remove(item!);
				} else if (prop.startsWith("border-")) {
					const b = prop.slice("border-".length);
					if (!parsed.border) {
						parsed.border = {
							top: {},
							right: {},
							left: {},
							bottom: {}
						};
					}
					parsed.border[b] = csstree.generate(declaration.value);
					list!.remove(item!);
				} else if (prop === "size") {
					parsed.size = this.getSize(declaration);
					list!.remove(item!);
				} else if (prop === "bleed") {
					const bleed: Array<DimensionValue | "auto"> = [];

					csstree.walk(declaration, {
						enter: (value) => {
							if (value.type === "String" && value.value.includes("auto")) {
								bleed.push("auto");
							} else if (value.type === "Dimension") {
								bleed.push({
									value: value.value,
									unit: value.unit
								});
							} else if (value.type === "Number") {
								bleed.push({
									value: value.value,
									unit: "px"
								});
							}
						}
					});

					parsed.bleed = bleed;
					list!.remove(item!);
				}
			}
		});

		return parsed;
	}

	/**
	 * Parses a `size` declaration: dimensions (first two win), quoted or bare
	 * page-size keywords resolved against the page-sizes table (bare
	 * keywords additionally record the format name), and the `landscape` /
	 * `portrait` orientation.
	 *
	 * @param {CssNode} declaration - The `size` Declaration node.
	 * @returns {SizeSpec} The parsed size, members `undefined` as applicable.
	 */
	getSize(declaration: CssNode): SizeSpec {
		let width: DimensionValue | undefined;
		let height: DimensionValue | undefined;
		let orientation: string | undefined;
		let format: string | undefined;

		csstree.walk(declaration, {
			visit: "Dimension",
			enter: (dimension) => {
				if (typeof width === "undefined") {
					width = {
						value: dimension.value,
						unit: dimension.unit
					};
				} else if (typeof height === "undefined") {
					height = {
						value: dimension.value,
						unit: dimension.unit
					};
				}
			}
		});

		csstree.walk(declaration, {
			visit: "String",
			enter: (str) => {
				const name = str.value.replace(/["|']/g, "");
				if (pageSizes[name]) {
					width = pageSizes[name].width;
					height = pageSizes[name].height;
				}
			}
		});

		csstree.walk(declaration, {
			visit: "Identifier",
			enter: (identifier) => {
				if (identifier.name === "landscape" || identifier.name === "portrait") {
					orientation = identifier.name;
				} else if (identifier.name !== "auto") {
					if (pageSizes[identifier.name]) {
						width = pageSizes[identifier.name].width;
						height = pageSizes[identifier.name].height;
					}
					format = identifier.name;
				}
			}
		});

		return {
			width,
			height,
			orientation,
			format
		};
	}

	/**
	 * Expands a `margin` declaration value into the four-side map.
	 * Dimension nodes are collected verbatim, Number nodes as
	 * `{value, unit: "px"}`; anything else (e.g. `auto`) is ignored.
	 *
	 * @param {CssNode} declaration - The `margin` Declaration node.
	 * @returns {MarginSides} The side map (`top`, `right`, `left`, `bottom`).
	 */
	getMargins(declaration: CssNode): MarginSides {
		const margins: MarginSides = {
			top: {},
			right: {},
			left: {},
			bottom: {}
		};

		const values: any[] = [];

		csstree.walk(declaration, {
			enter: (node) => {
				if (node.type === "Dimension") {
					values.push(node);
				} else if (node.type === "Number") {
					values.push({
						value: node.value,
						unit: "px"
					});
				}
			}
		});

		if (values.length === 1) {
			margins.top = values[0];
			margins.right = values[0];
			margins.left = values[0];
			margins.bottom = values[0];
		} else if (values.length === 2) {
			margins.top = values[0];
			margins.bottom = values[0];
			margins.right = values[1];
			margins.left = values[1];
		} else if (values.length === 3) {
			margins.top = values[0];
			margins.right = values[1];
			margins.left = values[1];
			margins.bottom = values[2];
		} else if (values.length === 4) {
			margins.top = values[0];
			margins.right = values[1];
			margins.bottom = values[2];
			margins.left = values[3];
		}

		return margins;
	}

	/**
	 * Expands a `padding` declaration value into the four-side map, exactly
	 * like {@link getMargins} does for margins.
	 *
	 * @param {CssNode} declaration - The `padding` value node (or
	 * declaration).
	 * @returns {MarginSides} The side map (`top`, `right`, `left`, `bottom`).
	 */
	getPaddings(declaration: CssNode): MarginSides {
		const paddings: MarginSides = {
			top: {},
			right: {},
			left: {},
			bottom: {}
		};

		const values: any[] = [];

		csstree.walk(declaration, {
			enter: (node) => {
				if (node.type === "Dimension") {
					values.push(node);
				} else if (node.type === "Number") {
					values.push({
						value: node.value,
						unit: "px"
					});
				}
			}
		});

		if (values.length === 1) {
			paddings.top = values[0];
			paddings.right = values[0];
			paddings.left = values[0];
			paddings.bottom = values[0];
		} else if (values.length === 2) {
			paddings.top = values[0];
			paddings.bottom = values[0];
			paddings.right = values[1];
			paddings.left = values[1];
		} else if (values.length === 3) {
			paddings.top = values[0];
			paddings.right = values[1];
			paddings.left = values[1];
			paddings.bottom = values[2];
		} else if (values.length === 4) {
			paddings.top = values[0];
			paddings.right = values[1];
			paddings.bottom = values[2];
			paddings.left = values[3];
		}

		return paddings;
	}

	/**
	 * Expands a `border` declaration into the four-side map of generated
	 * value strings. Not used by the module itself (the equivalent logic is
	 * inlined in `replaceDeclarations`); kept as part of the class surface.
	 *
	 * @param {CssNode} declaration - The `border` Declaration node.
	 * @returns {BorderSides} The side map.
	 */
	getBorders(declaration: CssNode): BorderSides {
		const border: BorderSides = {
			top: {},
			right: {},
			left: {},
			bottom: {}
		};

		if (declaration.property === "border") {
			border.top = csstree.generate(declaration.value);
			border.right = csstree.generate(declaration.value);
			border.bottom = csstree.generate(declaration.value);
			border.left = csstree.generate(declaration.value);
		} else if (declaration.property === "border-top") {
			border.top = csstree.generate(declaration.value);
		} else if (declaration.property === "border-right") {
			border.right = csstree.generate(declaration.value);
		} else if (declaration.property === "border-bottom") {
			border.bottom = csstree.generate(declaration.value);
		} else if (declaration.property === "border-left") {
			border.left = csstree.generate(declaration.value);
		}

		return border;
	}

	/**
	 * Inserts one rule per not-yet-inserted page model, in fixed order:
	 * the fixed pseudo/side list (`*`, `:left`, `:right`, `:recto`, `:verso`,
	 * `:first`, `:blank`), then every page with an nth argument, then every
	 * named page — both latter passes in registry order.
	 *
	 * @param {Record<string, PageModel>} pages - The page model registry.
	 * @param {CssNode} ast - The stylesheet AST receiving the rules.
	 * @param {SheetLike} sheet - The sheet to insert through.
	 */
	addPageClasses(pages: Record<string, PageModel>, ast: CssNode, sheet: SheetLike): void {
		const pageSelectors = ["*", ":left", ":right", ":recto", ":verso", ":first", ":blank"];

		pageSelectors.forEach((selector) => {
			if (pages[selector] && !pages[selector].added) {
				const rule = this.createPage(pages[selector], ast.children as List, sheet);
				sheet.insertRule(rule);
				pages[selector].added = true;
			}
		});

		for (const selector in pages) {
			if (pages[selector].nth && !pages[selector].added) {
				const rule = this.createPage(pages[selector], ast.children as List, sheet);
				sheet.insertRule(rule);
				pages[selector].added = true;
			}
		}

		for (const selector in pages) {
			if (pages[selector].name && !pages[selector].added) {
				const rule = this.createPage(pages[selector], ast.children as List, sheet);
				sheet.insertRule(rule);
				pages[selector].added = true;
			}
		}
	}

	/**
	 * Builds the CSS rule for one page and its satellite rules: margin-box
	 * style rules (appended directly to the AST), margin-box display and
	 * content rules (inserted via the sheet), notes rules (appended directly)
	 * and the page class rule itself, which the caller inserts.
	 *
	 * @param {PageModel} page - The page model to build the rule for.
	 * @param {List} ruleList - The AST's top-level children.
	 * @param {SheetLike} sheet - The sheet to insert display/content rules
	 * through.
	 * @returns {CssNode} The page class rule (not yet inserted).
	 */
	createPage(page: PageModel, ruleList: List, sheet: SheetLike): CssNode {
		const selectors = this.selectorsForPage(page);
		const children = page.block.children.copy();
		const block: CssBlockNode = {
			type: "Block",
			loc: 0,
			children
		};
		const rule = this.createRule(selectors, block as unknown as CssNode);

		this.addMarginVars(page.margin, children, children.first() as unknown as List.Cursor);
		this.addPaddingVars(page.padding, children, children.first() as unknown as List.Cursor);
		this.addBorderVars(page.border, children, children.first() as unknown as List.Cursor);

		if (page.width) {
			this.addDimensions(page.width, page.height as DimensionValue, page.orientation, children as unknown as List, children.first() as unknown as List.Cursor);
		}

		if (page.marginalia) {
			this.addMarginaliaStyles(page, ruleList, rule, sheet);
			this.addMarginaliaContent(page, ruleList, rule, sheet);
		}

		if (page.notes) {
			this.addNotesStyles(page.notes, page, ruleList, rule, sheet);
		}

		return rule as unknown as CssNode;
	}

	/**
	 * Appends `--paged-margin-<side>` variable declarations for every side
	 * that carries a value. The `item` argument is ignored by css-tree: the
	 * declarations land at the end of the list.
	 *
	 * @param {MarginSides} margin - The side map.
	 * @param {CssList} list - The declaration list to append to.
	 * @param {List.Cursor} item - Unused insertion reference.
	 */
	addMarginVars(margin: MarginSides, list: CssList, item: List.Cursor): void {
		for (const m in margin) {
			if (typeof margin[m].value !== "undefined") {
				list.appendData(this.createVariable("--paged-margin-" + m, CSSValueToString(margin[m] as DimensionValue)) as CssNode);
			}
		}
	}

	/**
	 * Appends `--paged-padding-<side>` variable declarations, exactly like
	 * {@link addMarginVars} does for margins.
	 *
	 * @param {MarginSides} padding - The side map.
	 * @param {CssList} list - The declaration list to append to.
	 * @param {List.Cursor} item - Unused insertion reference.
	 */
	addPaddingVars(padding: MarginSides, list: CssList, item: List.Cursor): void {
		for (const p in padding) {
			if (typeof padding[p].value !== "undefined") {
				list.appendData(this.createVariable("--paged-padding-" + p, CSSValueToString(padding[p] as DimensionValue)) as CssNode);
			}
		}
	}

	/**
	 * Appends `--paged-border-<side>` variable declarations for every side
	 * whose stored value is a string.
	 *
	 * @param {BorderSides} border - The side map.
	 * @param {CssList} list - The declaration list to append to.
	 * @param {List.Cursor} item - Unused insertion reference.
	 */
	addBorderVars(border: BorderSides, list: CssList, item: List.Cursor): void {
		for (const b in border) {
			if (typeof border[b] === "string") {
				list.appendData(this.createVariable("--paged-border-" + b, border[b] as string) as CssNode);
			}
		}
	}

	/**
	 * Appends `--paged-pagebox-width` / `--paged-pagebox-height` variables
	 * for the page's physical size; the two values swap for landscape.
	 *
	 * @param {DimensionValue} width - The page width.
	 * @param {DimensionValue} height - The page height.
	 * @param {string|undefined} orientation - The authored orientation.
	 * @param {List} list - The declaration list to append to.
	 * @param {List.Cursor} item - Unused insertion reference.
	 */
	addDimensions(
		width: DimensionValue,
		height: DimensionValue,
		orientation: string | undefined,
		list: List,
		item: List.Cursor,
	): void {
		let widthString = CSSValueToString(width);
		let heightString = CSSValueToString(height);

		if (orientation && orientation !== "portrait") {
			const swap = widthString;
			widthString = heightString;
			heightString = swap;
		}

		list.appendData(this.createVariable("--paged-pagebox-width", widthString) as CssNode);
		list.appendData(this.createVariable("--paged-pagebox-height", heightString) as CssNode);
	}

	/**
	 * Appends, per margin-box region of the page, a style rule to the AST's
	 * top-level children: the region's declarations minus `content`, with
	 * `vertical-align` translated to `align-items` (top→flex-start,
	 * middle→center, bottom→flex-end) and `width`/`height` duplicated as
	 * `max-width`/`max-height` on the matching axis. Registers the region in
	 * the margin-box registry with its `hasContent` flag.
	 *
	 * @param {PageModel} page - The owning page model.
	 * @param {List} list - The AST's top-level children.
	 * @param {CssNode} item - The page rule (unused here).
	 * @param {SheetLike} sheet - The sheet (unused here).
	 */
	addMarginaliaStyles(page: PageModel, list: List, item: CssNode, sheet: SheetLike): void {
		for (const loc in page.marginalia) {
			const block = csstree.clone(page.marginalia[loc]);

			if (block.children.first() === null) {
				continue;
			}

			let hasContent = false;

			csstree.walk(block, {
				visit: "Declaration",
				enter: (node, declItem, declList) => {
					if (node.property === "content") {
						if (node.value.children.first().name === "none") {
							hasContent = false;
						} else {
							hasContent = true;
						}
						declList!.remove(declItem!);
					} else if (node.property === "vertical-align") {
						csstree.walk(node, {
							visit: "Identifier",
							enter: (identifier) => {
								if (identifier.name === "top") {
									identifier.name = "flex-start";
								} else if (identifier.name === "middle") {
									identifier.name = "center";
								} else if (identifier.name === "bottom") {
									identifier.name = "flex-end";
								}
							}
						});
						node.property = "align-items";
					} else if (
						(node.property === "width" &&
							["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"].indexOf(loc) !== -1) ||
						(node.property === "height" &&
							["left-top", "left-middle", "left-bottom", "right-top", "right-middle", "right-bottom"].indexOf(loc) !== -1)
					) {
						const clone = csstree.clone(node);
						clone.property = node.property === "width" ? "max-width" : "max-height";
						declList!.appendData(clone);
					}
				}
			});

			const marginSelectors = this.selectorsForPageMargin(page, loc);
			const marginRule = this.createRule(marginSelectors as List, block as CssNode);
			list.appendData(marginRule as unknown as CssNode);

			const marginSelectorList = this.selectorsForPageMargin(page, loc);
			const sel = csstree.generate({
				type: "Selector",
				children: marginSelectorList
			});

			this.marginalia[sel] = {
				page,
				selector: sel,
				block: page.marginalia[loc],
				hasContent
			};
		}
	}

	/**
	 * Appends, per margin-box region carrying a `content` declaration, a
	 * display rule (`display: none` when the content is `none`, else
	 * `display: block`) and a content rule moving the `content` declaration
	 * onto the box's `::after` pseudo — both inserted via the sheet.
	 * Regions without a `content` declaration are skipped entirely.
	 *
	 * @param {PageModel} page - The owning page model.
	 * @param {List} list - The AST's top-level children (unused here).
	 * @param {CssNode} item - The page rule (unused here).
	 * @param {SheetLike} sheet - The sheet to insert the rules through.
	 */
	addMarginaliaContent(page: PageModel, list: List, item: CssNode, sheet: SheetLike): void {
		for (const loc in page.marginalia) {
			const content = csstree.clone(page.marginalia[loc]);

			let displayNone = false;

			csstree.walk(content, {
				visit: "Declaration",
				enter: (node, declItem, declList) => {
					if (node.property === "content") {
						if (node.value.children.first().name === "none") {
							displayNone = true;
						}
					} else {
						declList!.remove(declItem!);
					}
				}
			});

			if (content.children.first() === null) {
				continue;
			}

			const displaySelectors = this.selectorsForPageMargin(page, loc);
			displaySelectors.appendData({
				type: "Combinator",
				name: ">"
			});
			displaySelectors.appendData({
				type: "ClassSelector",
				name: "paged_margin-content",
				children: null
			});
			displaySelectors.appendData({
				type: "Combinator",
				name: ">"
			});
			displaySelectors.appendData({
				type: "TypeSelector",
				name: "*",
				children: null
			});

			const displayBlock = this.createBlock([
				this.createDeclaration("display", displayNone ? "none" : "block")
			]);
			sheet.insertRule(this.createRule(displaySelectors as List, displayBlock as unknown as CssNode) as CssNode);

			const contentSelectors = this.selectorsForPageMargin(page, loc);
			contentSelectors.appendData({
				type: "Combinator",
				name: ">"
			});
			contentSelectors.appendData({
				type: "ClassSelector",
				name: "paged_margin-content",
				children: null
			});
			contentSelectors.appendData({
				type: "PseudoElementSelector",
				name: "after",
				children: null
			});

			sheet.insertRule(this.createRule(contentSelectors as List, content as CssNode) as CssNode);
		}
	}

	/**
	 * Appends the `:root` variables rule to the AST: per-side bleed
	 * variables (main, recto `--paged-bleed-right-*`, verso
	 * `--paged-bleed-left-*`), a plain `--paged-width`/`--paged-height`
	 * pair, one `--paged-mark-<id>-display` variable per mark, the
	 * orientation variable, and finally the six size variables
	 * (`--paged-width`, `--paged-height` and the `-right`/`-left` pairs),
	 * bleed-inclusive `calc()` strings when a bleed is present. All three
	 * width/height pairs swap for non-portrait orientations.
	 *
	 * @param {CssNode} ast - The stylesheet AST to append the rule to.
	 * @param {DimensionValue} width - The page width.
	 * @param {DimensionValue} height - The page height.
	 * @param {string|undefined} orientation - The authored orientation.
	 * @param {BleedSides|undefined} bleed - The main per-side bleed.
	 * @param {BleedSides|undefined} bleedrecto - The recto (`:right`) bleed.
	 * @param {BleedSides|undefined} bleedverso - The verso (`:left`) bleed.
	 * @param {string[]|undefined} marks - The mark identifiers.
	 */
	addRootVars(
		ast: CssNode,
		width: DimensionValue,
		height: DimensionValue,
		orientation: string | undefined,
		bleed: BleedSides | undefined,
		bleedrecto: BleedSides | undefined,
		bleedverso: BleedSides | undefined,
		marks: string[] | undefined,
	): void {
		const selectors = new csstree.List();
		selectors.appendData({
			type: "PseudoClassSelector",
			name: "root",
			children: null
		});

		const rulesArray: CssNode[] = [];

		let widthString = CSSValueToString(width);
		let heightString = CSSValueToString(height);

		let widthStringRight = widthString;
		let heightStringRight = heightString;
		let widthStringLeft = widthString;
		let heightStringLeft = heightString;

		if (bleed) {
			widthString = `calc( ${widthString} + ${CSSValueToString(bleed.left)} + ${CSSValueToString(bleed.right)} )`;
			heightString = `calc( ${heightString} + ${CSSValueToString(bleed.top)} + ${CSSValueToString(bleed.bottom)} )`;

			widthStringRight = widthString;
			heightStringRight = heightString;
			widthStringLeft = widthString;
			heightStringLeft = heightString;

			if (bleedrecto) {
				widthStringRight = `calc( ${CSSValueToString(width)} + ${CSSValueToString(bleedrecto.left)} + ${CSSValueToString(bleedrecto.right)} )`;
				heightStringRight = `calc( ${CSSValueToString(height)} + ${CSSValueToString(bleedrecto.top)} + ${CSSValueToString(bleedrecto.bottom)} )`;
			}

			if (bleedverso) {
				widthStringLeft = `calc( ${CSSValueToString(width)} + ${CSSValueToString(bleedverso.left)} + ${CSSValueToString(bleedverso.right)} )`;
				heightStringLeft = `calc( ${CSSValueToString(height)} + ${CSSValueToString(bleedverso.top)} + ${CSSValueToString(bleedverso.bottom)} )`;
			}

			rulesArray.push(this.createVariable("--paged-bleed-top", CSSValueToString(bleed.top)) as CssNode);
			rulesArray.push(this.createVariable("--paged-bleed-right", CSSValueToString(bleed.right)) as CssNode);
			rulesArray.push(this.createVariable("--paged-bleed-bottom", CSSValueToString(bleed.bottom)) as CssNode);
			rulesArray.push(this.createVariable("--paged-bleed-left", CSSValueToString(bleed.left)) as CssNode);

			const bleedRight = bleedrecto || bleed;
			const bleedLeft = bleedverso || bleed;

			rulesArray.push(this.createVariable("--paged-bleed-right-top", CSSValueToString(bleedRight.top)) as CssNode);
			rulesArray.push(this.createVariable("--paged-bleed-right-right", CSSValueToString(bleedRight.right)) as CssNode);
			rulesArray.push(this.createVariable("--paged-bleed-right-bottom", CSSValueToString(bleedRight.bottom)) as CssNode);
			rulesArray.push(this.createVariable("--paged-bleed-right-left", CSSValueToString(bleedRight.left)) as CssNode);

			rulesArray.push(this.createVariable("--paged-bleed-left-top", CSSValueToString(bleedLeft.top)) as CssNode);
			rulesArray.push(this.createVariable("--paged-bleed-left-right", CSSValueToString(bleedLeft.right)) as CssNode);
			rulesArray.push(this.createVariable("--paged-bleed-left-bottom", CSSValueToString(bleedLeft.bottom)) as CssNode);
			rulesArray.push(this.createVariable("--paged-bleed-left-left", CSSValueToString(bleedLeft.left)) as CssNode);

			rulesArray.push(this.createVariable("--paged-width", CSSValueToString(width)) as CssNode);
			rulesArray.push(this.createVariable("--paged-height", CSSValueToString(height)) as CssNode);
		}

		if (marks) {
			for (const mark of marks) {
				rulesArray.push(this.createVariable("--paged-mark-" + mark + "-display", "block") as CssNode);
			}
		}

		if (orientation) {
			rulesArray.push(this.createVariable("--paged-orientation", orientation) as CssNode);

			if (orientation !== "portrait") {
				let swap = widthString;
				widthString = heightString;
				heightString = swap;

				swap = widthStringRight;
				widthStringRight = heightStringRight;
				heightStringRight = swap;

				swap = widthStringLeft;
				widthStringLeft = heightStringLeft;
				heightStringLeft = swap;
			}
		}

		rulesArray.push(this.createVariable("--paged-width", widthString) as CssNode);
		rulesArray.push(this.createVariable("--paged-height", heightString) as CssNode);
		rulesArray.push(this.createVariable("--paged-width-right", widthStringRight) as CssNode);
		rulesArray.push(this.createVariable("--paged-height-right", heightStringRight) as CssNode);
		rulesArray.push(this.createVariable("--paged-width-left", widthStringLeft) as CssNode);
		rulesArray.push(this.createVariable("--paged-height-left", heightStringLeft) as CssNode);

		const rule = this.createRule(selectors as List, rulesArray);

		(ast.children as CssList).appendData(rule as unknown as CssNode);
	}

	/**
	 * Appends the notes (footnote area) rules to the AST's top-level
	 * children: the page's selector list followed by the
	 * `.paged_<note>_content` class, with the note's block as the body.
	 *
	 * @param {Record<string, CssNode>} notes - Note name to Block node.
	 * @param {PageModel} page - The owning page model.
	 * @param {List} list - The AST's top-level children.
	 * @param {CssNode} item - The page rule (unused here).
	 * @param {SheetLike} sheet - The sheet (unused here).
	 */
	addNotesStyles(notes: Record<string, CssNode>, page: PageModel, list: List, item: CssNode, sheet: SheetLike): void {
		for (const note in notes) {
			const selectors = this.selectorsForPage(page);
			selectors.appendData({
				type: "Combinator",
				name: " "
			});
			selectors.appendData({
				type: "ClassSelector",
				name: "paged_" + note + "_content",
				children: null
			});

			const notesRule = this.createRule(selectors as List, notes[note]);
			list.appendData(notesRule as unknown as CssNode);
		}
	}

	/**
	 * Appends the synthetic `@page` at-rules to the AST: the main rule
	 * (`size` followed by `margin: 0px` and a duplicated `padding: 0px`)
	 * carrying the bleed-inclusive dimensions when a bleed is present, or the
	 * format/orientation keywords, or the plain dimensions; plus `@page
	 * :left` / `@page :right` rules when verso/recto bleeds exist.
	 *
	 * @param {CssNode} ast - The stylesheet AST to append to.
	 * @param {SizeSpec} size - The `*` page's parsed size.
	 * @param {BleedSides} [bleed] - The main per-side bleed.
	 * @param {BleedSides} [bleedrecto] - The recto (`:right`) bleed.
	 * @param {BleedSides} [bleedverso] - The verso (`:left`) bleed.
	 */
	addRootPage(
		ast: CssNode,
		size: SizeSpec,
		bleed?: BleedSides,
		bleedrecto?: BleedSides,
		bleedverso?: BleedSides,
	): void {
		const calcDimension = (a: DimensionValue, b: DimensionValue, c: DimensionValue): CssNode => {
			const children = new csstree.List();
			const parts = [a, b, c];
			parts.forEach((part, idx) => {
				children.appendData({
					type: "Dimension",
					loc: null,
					value: part.value,
					unit: part.unit
				});
				if (idx < parts.length - 1) {
					children.appendData({
						type: "WhiteSpace",
						value: " "
					});
					children.appendData({
						type: "Operator",
						value: "+"
					});
					children.appendData({
						type: "WhiteSpace",
						value: " "
					});
				}
			});
			return {
				type: "Function",
				loc: null,
				name: "calc",
				children
			} as CssNode;
		};

		const pageRule = (name: string, dims: CssNode, declarationsOnly: boolean): CssNode => {
			const blockChildren = new csstree.List();
			blockChildren.appendData({
				type: "Declaration",
				property: "size",
				value: {
					type: "Value",
					children: dims
				}
			} as CssNode);

			if (!declarationsOnly) {
				const marginChildren = new csstree.List();
				marginChildren.appendData({
					type: "Dimension",
					loc: null,
					value: 0,
					unit: "px"
				});
				blockChildren.appendData({
					type: "Declaration",
					property: "margin",
					value: {
						type: "Value",
						children: marginChildren
					}
				} as CssNode);

				for (let i = 0; i < 2; i++) {
					const paddingChildren = new csstree.List();
					paddingChildren.appendData({
						type: "Dimension",
						loc: null,
						value: 0,
						unit: "px"
					});
					blockChildren.appendData({
						type: "Declaration",
						property: "padding",
						value: {
							type: "Value",
							children: paddingChildren
						}
					} as CssNode);
				}
			}

			return {
				type: "Atrule",
				loc: null,
				name,
				prelude: null,
				block: {
					type: "Block",
					loc: null,
					children: blockChildren
				}
			} as CssNode;
		};

		const dimensions = new csstree.List();

		if (bleed) {
			dimensions.appendData(calcDimension(size.width!, bleed.left, bleed.right));
			dimensions.appendData({
				type: "WhiteSpace",
				value: " "
			});
			dimensions.appendData(calcDimension(size.height!, bleed.top, bleed.bottom));
		} else if (size.format) {
			dimensions.appendData({
				type: "Identifier",
				loc: null,
				name: size.format
			});
			if (size.orientation) {
				dimensions.appendData({
					type: "WhiteSpace",
					value: " "
				});
				dimensions.appendData({
					type: "Identifier",
					loc: null,
					name: size.orientation
				});
			}
		} else {
			dimensions.appendData({
				type: "Dimension",
				loc: null,
				value: size.width!.value,
				unit: size.width!.unit
			});
			dimensions.appendData({
				type: "WhiteSpace",
				value: " "
			});
			dimensions.appendData({
				type: "Dimension",
				loc: null,
				value: size.height!.value,
				unit: size.height!.unit
			});
		}

		const astChildren = ast.children as CssList;
		astChildren.append(astChildren.createItem(pageRule("page", dimensions as unknown as CssNode, false)) as any);

		if (bleedverso) {
			const versoDimensions = new csstree.List();
			versoDimensions.appendData(calcDimension(size.width!, bleedverso.left, bleedverso.right));
			versoDimensions.appendData({
				type: "WhiteSpace",
				value: " "
			});
			versoDimensions.appendData(calcDimension(size.height!, bleedverso.top, bleedverso.bottom));
			astChildren.append(astChildren.createItem(pageRule("page :left", versoDimensions as unknown as CssNode, true)) as any);
		}

		if (bleedrecto) {
			const rectoDimensions = new csstree.List();
			rectoDimensions.appendData(calcDimension(size.width!, bleedrecto.left, bleedrecto.right));
			rectoDimensions.appendData({
				type: "WhiteSpace",
				value: " "
			});
			rectoDimensions.appendData(calcDimension(size.height!, bleedrecto.top, bleedrecto.bottom));
			astChildren.append(astChildren.createItem(pageRule("page :right", rectoDimensions as unknown as CssNode, true)) as any);
		}
	}

	/**
	 * Parses an An+B argument string into an `Nth` node: the part before the
	 * first `n` becomes `a` (when an `n` is present), the part after `+` (or
	 * the whole string, when there is no `n`) becomes `b`. No trimming or
	 * sign normalization.
	 *
	 * @param {string} nth - The raw nth argument, e.g. `"2n+1"`.
	 * @returns {CssNode} The `Nth` node.
	 */
	getNth(nth: string): CssNode {
		let a: string | null = null;
		let b: string | null = null;

		if (nth.includes("n")) {
			a = nth.slice(0, nth.indexOf("n"));
			if (nth.includes("+")) {
				b = nth.slice(nth.indexOf("+") + 1);
			}
		} else {
			b = nth;
		}

		return {
			type: "Nth",
			loc: null,
			selector: null,
			nth: {
				type: "AnPlusB",
				loc: null,
				a,
				b
			}
		} as CssNode;
	}

	/**
	 * Stamps the named-page classes onto a rendered page element based on the
	 * start element's `data-page` attribute: `paged_named_page`,
	 * `paged_<name>_page` and — when the start element is not a split
	 * continuation — `paged_<name>_first_page`. The `pages` argument is
	 * unused.
	 *
	 * @param {ChunkerPage} page - The Page object to stamp.
	 * @param {Element} start - The page's start element.
	 * @param {ChunkerPage[]} pages - Unused.
	 */
	addPageAttributes(page: ChunkerPage, start: Element, pages: ChunkerPage[]): void {
		const named = [(start as HTMLElement).dataset.page];

		named.forEach((name) => {
			if (name) {
				page.name = name;
				page.element.classList.add("paged_named_page");
				page.element.classList.add("paged_" + name + "_page");
				if (!(start as HTMLElement).dataset.splitFrom) {
					page.element.classList.add("paged_" + name + "_first_page");
				}
			}
		});
	}

	/**
	 * Determines which content element a new page starts with, for
	 * named-page attribution: the break token's overflow/token node (resolved
	 * to the rendered counterpart for top-level overflow), the pending
	 * content's first child, or the nearest named ancestor of the token node
	 * found through a rebuilt ancestor chain.
	 *
	 * @param {Element|Document|undefined} content - The pending content.
	 * @param {BreakTokenRef|undefined} breakToken - The page's break token.
	 * @returns {Element|null|undefined} The start element.
	 */
	getStartElement(
		content: Element | Document | undefined,
		breakToken: BreakTokenRef | undefined,
	): Element | null | undefined {
		let node: Node | null | undefined;
		if (breakToken) {
			node = (breakToken.overflow[0] && breakToken.overflow[0].node) || breakToken.node;
		}

		if (!content && !breakToken) {
			return undefined;
		}

		if (!node) {
			return (content as Element).children[0];
		}

		if (breakToken!.node && breakToken!.overflow[0] && breakToken!.overflow[0].topLevel) {
			return findElement(breakToken!.node, content);
		}

		if (node.nodeType === 1 && node.parentNode && node.parentNode.nodeType === 11) {
			return node as Element;
		}

		if (
			node.nodeType === 1 &&
			(node as HTMLElement).dataset &&
			(node as HTMLElement).dataset.page
		) {
			return node as Element;
		}

		const fragment = rebuildAncestors(node);
		const pages = fragment.querySelectorAll("[data-page]");
		if (pages.length) {
			return pages[pages.length - 1];
		}

		return fragment.children[0];
	}

	/**
	 * `beforePageLayout` hook, fired once per page before layout. Stamps the
	 * named-page classes when the page's start element carries (or descends
	 * from) a `data-page` element.
	 *
	 * @param {ChunkerPage} page - The Page being laid out.
	 * @param {Element|Document|undefined} contents - The pending content.
	 * @param {BreakTokenRef|undefined} breakToken - The page's break token.
	 * @param {ChunkerSource} chunker - The chunker.
	 */
	beforePageLayout(
		page: ChunkerPage,
		contents: Element | Document | undefined,
		breakToken: BreakTokenRef | undefined,
		chunker: ChunkerSource,
	): void {
		const start = this.getStartElement(contents, breakToken);
		if (start) {
			this.addPageAttributes(page, start, chunker.pages);
		}
	}

	/**
	 * `afterPageLayout` hook, fired once per page after layout. The first
	 * argument (the page's root element) is ignored; the page under inspection
	 * is the chunker's last page. When the page body is empty but footnotes
	 * rendered onto it (and there is a previous page), the page is
	 * re-attributed to the previous page's start element so footnote-only
	 * continuation pages keep the previous page's named context.
	 *
	 * @param {ChunkerPage} page - The page's root element (ignored).
	 * @param {Element|Document|undefined} contents - The pending content.
	 * @param {BreakTokenRef|undefined} breakToken - The break token.
	 * @param {ChunkerSource} chunker - The chunker.
	 */
	afterPageLayout(
		page: ChunkerPage,
		contents: Element | Document | undefined,
		breakToken: BreakTokenRef | undefined,
		chunker: ChunkerSource,
	): void {
		const thisPage = chunker.pages[chunker.pages.length - 1];

		let emptyBody = false;
		if (!thisPage.wrapper) {
			emptyBody = true;
		} else {
			emptyBody = true;
			for (const child of Array.from(thisPage.wrapper.children)) {
				if (
					child instanceof HTMLElement &&
					!child.classList.contains("paged_float_top") &&
					!child.classList.contains("paged_float_bottom") &&
					child.getBoundingClientRect().height
				) {
					emptyBody = false;
					break;
				}
			}
		}

		const emptyFootnotes =
			!thisPage.footnotesArea.firstElementChild!.childElementCount ||
			!thisPage.footnotesArea.firstElementChild!.firstElementChild!.getBoundingClientRect()
				.height;

		if (emptyBody && !emptyFootnotes && chunker.pages.length > 1) {
			const prevBreakToken = chunker.pages[chunker.pages.length - 2].startToken;
			const start = this.getStartElement(contents, prevBreakToken);
			if (start) {
				this.addPageAttributes(thisPage, start, chunker.pages);
			}
		}
	}

	/**
	 * `finalizePage` hook, fired once per finished page. Phase 1 stamps
	 * `hasContent` on the margin boxes whose content declaration is not
	 * `none` and whose page selector matches this page. Phase 2 computes the
	 * inline `grid-template-columns` of the top/bottom margin groups and the
	 * `grid-template-rows` of the left/right margin groups from the computed
	 * `max-width`/`max-height` of the boxes that carry content, with an
	 * `offsetWidth`-measured minmax fallback for fully unsized rows.
	 *
	 * @param {Element} fragment - The page's root element (unused; the page
	 * object's element is used instead).
	 * @param {ChunkerPage} page - The Page being finalized.
	 * @param {undefined} breakToken - Always `undefined` here.
	 * @param {ChunkerSource} chunker - The chunker (unused).
	 */
	finalizePage(
		fragment: Element,
		page: ChunkerPage,
		breakToken: undefined,
		chunker: ChunkerSource,
	): void {
		for (const sel in this.marginalia) {
			const sels = sel.split(" ");
			if (page.element.matches(sels[0]) && this.marginalia[sel].hasContent) {
				(page.element.querySelector(sels[1]) as HTMLElement).classList.add("hasContent");
			}
		}

		for (const loc of ["top", "bottom"]) {
			const marginGroup = page.element.querySelector(".paged_margin-" + loc) as HTMLElement;
			const center = page.element.querySelector(".paged_margin-" + loc + "-center") as HTMLElement;
			const left = page.element.querySelector(".paged_margin-" + loc + "-left") as HTMLElement;
			const right = page.element.querySelector(".paged_margin-" + loc + "-right") as HTMLElement;

			const centerContent = center.classList.contains("hasContent");
			const leftContent = left.classList.contains("hasContent");
			const rightContent = right.classList.contains("hasContent");

			let centerWidth: string | undefined;
			let leftWidth: string | undefined;
			let rightWidth: string | undefined;

			if (leftContent) {
				leftWidth = (window.getComputedStyle(left) as any)["max-width"];
			}

			if (rightContent) {
				rightWidth = (window.getComputedStyle(right) as any)["max-width"];
			}

			if (centerContent) {
				centerWidth = (window.getComputedStyle(center) as any)["max-width"];
			}

			if (centerContent && centerWidth !== "none" && centerWidth !== "auto") {
				if (leftContent && leftWidth !== "none" && leftWidth !== "auto") {
					marginGroup.style.gridTemplateColumns = `${leftWidth} ${centerWidth} 1fr`;
				} else if (rightContent && rightWidth !== "none" && rightWidth !== "auto") {
					marginGroup.style.gridTemplateColumns = `1fr ${centerWidth} ${rightWidth}`;
				} else {
					marginGroup.style.gridTemplateColumns = `1fr ${centerWidth} 1fr`;
				}
			} else if (centerContent) {
				if (leftContent && rightContent) {
					if (
						leftWidth !== "none" && leftWidth !== "auto" &&
						rightWidth !== "none" && rightWidth !== "auto"
					) {
						marginGroup.style.gridTemplateColumns = `${leftWidth} 1fr ${rightWidth}`;
					} else if (leftWidth !== "none" && leftWidth !== "auto") {
						marginGroup.style.gridTemplateColumns = `${leftWidth} 1fr ${leftWidth}`;
					} else if (rightWidth !== "none" && rightWidth !== "auto") {
						marginGroup.style.gridTemplateColumns = `${rightWidth} 1fr ${rightWidth}`;
					} else {
						marginGroup.style.gridTemplateColumns = "auto auto 1fr";
						left.style.whiteSpace = "nowrap";
						center.style.whiteSpace = "nowrap";
						right.style.whiteSpace = "nowrap";
						const p = (center.offsetWidth * 100) / (left.offsetWidth + center.offsetWidth + right.offsetWidth);
						if (p > 40) {
							marginGroup.style.gridTemplateColumns = `minmax(16.66%, 1fr) minmax(33%, ${p}%) minmax(16.66%, 1fr)`;
						} else {
							marginGroup.style.gridTemplateColumns = "repeat(3, 1fr)";
						}
						left.style.whiteSpace = "normal";
						center.style.whiteSpace = "normal";
						right.style.whiteSpace = "normal";
					}
				} else if (leftContent) {
					if (leftWidth !== "none" && leftWidth !== "auto") {
						marginGroup.style.gridTemplateColumns = `${leftWidth} 1fr ${leftWidth}`;
					} else {
						marginGroup.style.gridTemplateColumns = "auto auto 1fr";
						left.style.whiteSpace = "nowrap";
						center.style.whiteSpace = "nowrap";
						const p = (center.offsetWidth * 100) / (left.offsetWidth + center.offsetWidth);
						marginGroup.style.gridTemplateColumns = `minmax(16.66%, 1fr) minmax(33%, ${p}%) minmax(16.66%, 1fr)`;
						left.style.whiteSpace = "normal";
						center.style.whiteSpace = "normal";
					}
				} else if (rightContent) {
					if (rightWidth !== "none" && rightWidth !== "auto") {
						marginGroup.style.gridTemplateColumns = `${rightWidth} 1fr ${rightWidth}`;
					} else {
						marginGroup.style.gridTemplateColumns = "auto auto 1fr";
						right.style.whiteSpace = "nowrap";
						center.style.whiteSpace = "nowrap";
						const p = (center.offsetWidth * 100) / (right.offsetWidth + center.offsetWidth);
						marginGroup.style.gridTemplateColumns = `minmax(16.66%, 1fr) minmax(33%, ${p}%) minmax(16.66%, 1fr)`;
						right.style.whiteSpace = "normal";
						center.style.whiteSpace = "normal";
					}
				} else {
					marginGroup.style.gridTemplateColumns = "0 1fr 0";
				}
			} else {
				if (leftContent) {
					if (rightContent) {
						if (
							leftWidth !== "none" && leftWidth !== "auto" &&
							rightWidth !== "none" && rightWidth !== "auto"
						) {
							marginGroup.style.gridTemplateColumns = `${leftWidth} 1fr ${rightWidth}`;
						} else if (leftWidth !== "none" && leftWidth !== "auto") {
							marginGroup.style.gridTemplateColumns = `${leftWidth} 0 1fr`;
						} else if (rightWidth !== "none" && rightWidth !== "auto") {
							marginGroup.style.gridTemplateColumns = `1fr 0 ${rightWidth}`;
						} else {
							marginGroup.style.gridTemplateColumns = "auto 1fr auto";
							left.style.whiteSpace = "nowrap";
							right.style.whiteSpace = "nowrap";
							const p = (left.offsetWidth * 100) / (left.offsetWidth + right.offsetWidth);
							marginGroup.style.gridTemplateColumns = `minmax(16.66%, ${p}%) 0 1fr`;
							left.style.whiteSpace = "normal";
							right.style.whiteSpace = "normal";
						}
					} else {
						marginGroup.style.gridTemplateColumns = "1fr 0 0";
					}
				} else if (rightContent) {
					if (rightWidth !== "none" && rightWidth !== "auto") {
						marginGroup.style.gridTemplateColumns = `1fr 0 ${rightWidth}`;
					} else {
						marginGroup.style.gridTemplateColumns = "0 0 1fr";
					}
				} else {
					marginGroup.style.gridTemplateColumns = `1fr 0 ${rightWidth}`;
				}
			}
		}

		for (const loc of ["left", "right"]) {
			const middle = page.element.querySelector(".paged_margin-" + loc + "-middle.hasContent") as HTMLElement | null;
			const marginGroup = page.element.querySelector(".paged_margin-" + loc) as HTMLElement;
			const top = page.element.querySelector(".paged_margin-" + loc + "-top") as HTMLElement;
			const bottom = page.element.querySelector(".paged_margin-" + loc + "-bottom") as HTMLElement;

			const middleContent = !!middle;
			const middleHeight = middle ? (window.getComputedStyle(middle) as any)["max-height"] : undefined;

			const topContent = top.classList.contains("hasContent");
			const bottomContent = bottom.classList.contains("hasContent");

			let topHeight: string | undefined;
			let bottomHeight: string | undefined;

			if (topContent) {
				topHeight = (window.getComputedStyle(top) as any)["max-height"];
			}

			if (bottomContent) {
				bottomHeight = (window.getComputedStyle(bottom) as any)["max-height"];
			}

			if (middleContent && middleHeight !== "none" && middleHeight !== "auto") {
				if (topContent && topHeight !== "none" && topHeight !== "auto") {
					marginGroup.style.gridTemplateRows = `${topHeight} ${middleHeight} calc(100% - (${topHeight} + ${middleHeight}))`;
				} else if (bottomContent && bottomHeight !== "none" && bottomHeight !== "auto") {
					marginGroup.style.gridTemplateRows = `1fr ${middleHeight} ${bottomHeight}`;
				} else {
					marginGroup.style.gridTemplateRows = `calc((100% - ${middleHeight})/2) ${middleHeight} calc((100% - ${middleHeight})/2)`;
				}
			} else if (middleContent) {
				if (topContent && bottomContent) {
					if (
						topHeight !== "none" && topHeight !== "auto" &&
						bottomHeight !== "none" && bottomHeight !== "auto"
					) {
						marginGroup.style.gridTemplateRows = `${topHeight} calc(100% - ${topHeight} - ${bottomHeight}) ${bottomHeight}`;
					} else if (topHeight !== "none" && topHeight !== "auto") {
						marginGroup.style.gridTemplateRows = `${topHeight} calc(100% - ${topHeight}*2) ${topHeight}`;
					} else if (bottomHeight !== "none" && bottomHeight !== "auto") {
						marginGroup.style.gridTemplateRows = `${bottomHeight} calc(100% - ${bottomHeight}*2) ${bottomHeight}`;
					}
				} else if (topContent) {
					if (topHeight !== "none" && topHeight !== "auto") {
						marginGroup.style.gridTemplateRows = `${topHeight} calc(100% - ${topHeight}*2) ${topHeight}`;
					}
				} else if (bottomContent) {
					if (bottomHeight !== "none" && bottomHeight !== "auto") {
						marginGroup.style.gridTemplateRows = `${bottomHeight} calc(100% - ${bottomHeight}*2) ${bottomHeight}`;
					}
				} else {
					marginGroup.style.gridTemplateRows = "0 1fr 0";
				}
			} else {
				if (topContent) {
					if (bottomContent) {
						if (
							topHeight !== "none" && topHeight !== "auto" &&
							bottomHeight !== "none" && bottomHeight !== "auto"
						) {
							marginGroup.style.gridTemplateRows = `${topHeight} 1fr ${bottomHeight}`;
						} else if (topHeight !== "none" && topHeight !== "auto") {
							marginGroup.style.gridTemplateRows = `${topHeight} 0 1fr`;
						} else if (bottomHeight !== "none" && bottomHeight !== "auto") {
							marginGroup.style.gridTemplateRows = `1fr 0 ${bottomHeight}`;
						} else {
							marginGroup.style.gridTemplateRows = "1fr 0 1fr";
						}
					} else {
						marginGroup.style.gridTemplateRows = "1fr 0 0";
					}
				} else if (bottomContent) {
					if (bottomHeight !== "none" && bottomHeight !== "auto") {
						marginGroup.style.gridTemplateRows = `1fr 0 ${bottomHeight}`;
					} else {
						marginGroup.style.gridTemplateRows = "0 0 1fr";
					}
				} else {
					marginGroup.style.gridTemplateRows = `1fr 0 ${bottomHeight}`;
				}
			}
		}
	}

	/**
	 * Builds the class-selector list for a page: `paged_page`, plus
	 * `paged_named_page` and `paged_<name>_page` for named pages, plus
	 * `paged_<pseudo>_page` for side/first/blank pages (or, for a named page
	 * with `:first`, the combined `paged_<name>_first_page`), plus an
	 * `:nth-of-type(...)` pseudo when the page has an nth argument.
	 *
	 * @param {PageModel} page - The page model.
	 * @returns {List} The selector list.
	 */
	selectorsForPage(page: PageModel): List {
		const selectors = new csstree.List();

		selectors.appendData({
			type: "ClassSelector",
			name: "paged_page",
			children: null
		});

		if (page.name) {
			selectors.appendData({
				type: "ClassSelector",
				name: "paged_named_page",
				children: null
			});
			selectors.appendData({
				type: "ClassSelector",
				name: "paged_" + page.name + "_page",
				children: null
			});
		}

		if (page.psuedo && !(page.name && page.psuedo === "first")) {
			selectors.appendData({
				type: "ClassSelector",
				name: "paged_" + page.psuedo + "_page",
				children: null
			});
		}

		if (page.name && page.psuedo === "first") {
			selectors.appendData({
				type: "ClassSelector",
				name: "paged_" + page.name + "_first_page",
				children: null
			});
		}

		if (page.nth) {
			const nthList = new csstree.List();
			nthList.appendData(this.getNth(page.nth));
			selectors.appendData({
				type: "PseudoClassSelector",
				name: "nth-of-type",
				children: nthList
			});
		}

		return selectors as List;
	}

	/**
	 * Builds the selector list for a page's margin box: the page's selector
	 * list followed by a space combinator and the box's
	 * `paged_margin-<region>` class.
	 *
	 * @param {PageModel} page - The owning page model.
	 * @param {string} margin - The normalized region name.
	 * @returns {List} The selector list.
	 */
	selectorsForPageMargin(page: PageModel, margin: string): List {
		const selectors = this.selectorsForPage(page);
		selectors.appendData({
			type: "Combinator",
			name: " "
		});
		selectors.appendData({
			type: "ClassSelector",
			name: "paged_margin-" + margin,
			children: null
		});

		return selectors as List;
	}

	/**
	 * Builds a Declaration whose value is a `Value` with a single Identifier
	 * (used for the generated `display` declarations).
	 *
	 * @param {string} property - The property name.
	 * @param {string} value - The identifier value.
	 * @param {boolean} [important] - Stored verbatim as the important flag.
	 * @returns {CssNode} The Declaration node.
	 */
	createDeclaration(property: string, value: string, important?: boolean) {
		const children = new csstree.List();
		children.appendData({
			type: "Identifier",
			loc: null,
			name: value
		});

		return {
			type: "Declaration",
			loc: null,
			important,
			property,
			value: {
				type: "Value",
				loc: null,
				children
			}
		};
	}

	/**
	 * Builds a custom-property Declaration with a Raw value node.
	 *
	 * @param {string} property - The `--paged-*` property name.
	 * @param {string} value - The raw value text.
	 * @returns {CssNode} The Declaration node.
	 */
	createVariable(property: string, value: string) {
		return {
			type: "Declaration",
			loc: null,
			property,
			value: {
				type: "Raw",
				value
			}
		};
	}

	/**
	 * Builds a Declaration whose value is a `calc()` Function joining the
	 * given dimensions with the operator (trailing whitespace after the last
	 * dimension included, as the original generator emits it).
	 *
	 * @param {string} property - The property name.
	 * @param {DimensionValue[]} items - The dimensions to join.
	 * @param {boolean} [important] - Stored verbatim as the important flag.
	 * @param {string} [operator] - The join operator, defaults to `"+"`.
	 * @returns {CssNode} The Declaration node.
	 */
	createCalculatedDimension(
		property: string,
		items: DimensionValue[],
		important?: boolean,
		operator = "+",
	) {
		const children = new csstree.List();

		items.forEach((item, idx) => {
			children.appendData({
				type: "Dimension",
				loc: null,
				value: item.value,
				unit: item.unit
			});
			children.appendData({
				type: "WhiteSpace",
				value: " "
			});
			if (idx < items.length - 1) {
				children.appendData({
					type: "Operator",
					value: operator
				});
				children.appendData({
					type: "WhiteSpace",
					value: " "
				});
			}
		});

		return {
			type: "Declaration",
			loc: null,
			important,
			property,
			value: {
				type: "Function",
				loc: null,
				name: "calc",
				children
			}
		};
	}

	/**
	 * Builds a Declaration carrying a single Dimension node copied from the
	 * given value/unit pair.
	 *
	 * @param {string} property - The property name.
	 * @param {DimensionValue} cssValue - The dimension to copy.
	 * @param {boolean} [important] - Stored verbatim as the important flag.
	 * @returns {CssNode} The Declaration node.
	 */
	createDimension(property: string, cssValue: DimensionValue, important?: boolean) {
		const children = new csstree.List();
		children.appendData({
			type: "Dimension",
			loc: null,
			value: cssValue.value,
			unit: cssValue.unit
		});

		return {
			type: "Declaration",
			loc: null,
			important,
			property,
			value: {
				type: "Value",
				loc: null,
				children
			}
		};
	}

	/**
	 * Builds a Block node holding the given declarations in array order.
	 *
	 * @param {CssNode[]} declarations - The declarations to append.
	 * @returns {CssNode} The Block node.
	 */
	createBlock(declarations: CssNode[]) {
		const children = new csstree.List();
		declarations.forEach((declaration) => {
			children.appendData(declaration);
		});

		return {
			type: "Block",
			loc: null,
			children
		};
	}

	/**
	 * Builds a Rule node with a one-selector prelude wrapping the given
	 * selector list; an array block is converted with {@link createBlock}.
	 *
	 * @param {List} selectors - The selector's children.
	 * @param {CssNode|CssNode[]} block - The rule's block node or
	 * declaration array.
	 * @returns {CssNode} The Rule node.
	 */
	createRule(selectors: List, block: CssNode | CssNode[]) {
		const selectorList = new csstree.List();
		selectorList.appendData({
			type: "Selector",
			children: selectors
		});

		return {
			type: "Rule",
			prelude: {
				type: "SelectorList",
				children: selectorList
			},
			block: Array.isArray(block) ? this.createBlock(block) : block
		};
	}
}

export default AtPage;
