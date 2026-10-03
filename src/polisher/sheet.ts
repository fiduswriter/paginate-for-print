import csstree from "css-tree";
import type { CssNode, List } from "css-tree";
import { UUID } from "../utils/utils.js";
import Hook from "../utils/hook.js";
import type { Dimension } from "./sizes.js";
import type { PolisherHooks } from "./polisher.js";

/**
 * Per-stylesheet workhorse of the CSS polisher layer.
 *
 * One instance wraps one author stylesheet (fetched or inline): it parses a
 * CSS string into a css-tree v1 AST, then runs a fixed pipeline of AST
 * rewrites and hook triggers through which the behavior modules (at-page,
 * generated content, columns, running headers, ...) inspect and rewrite the
 * stylesheet. All rewrites are in-place mutations of the css-tree AST; hooks
 * receive live nodes and lists, so every change is immediately visible to
 * later hooks and to the final serialization.
 *
 * The pipeline run by {@link Sheet.parse}, in order:
 * `beforeTreeParse` (CSS text rewrite) → parse → `beforeTreeWalk` →
 * {@link Sheet.replaceUrls} (absolutize `url()` values) → mint `id` →
 * {@link Sheet.replaceIds} (`#id` → `[data-id="id"]`) → reset `imported` →
 * {@link Sheet.urls} → {@link Sheet.rules} → {@link Sheet.atrules} →
 * `afterTreeWalk` (handlers typically call {@link Sheet.insertRule} here) →
 * return the AST. Only `beforeTreeParse`, `beforeTreeWalk` and
 * `afterTreeWalk` are awaited; the promises of all node hooks are discarded,
 * so only synchronous handler mutations are guaranteed to be seen by later
 * steps.
 *
 * The only browser-global dependency is `window.location.href`, read at
 * construction time to resolve the sheet's base URL. No DOM is created or
 * mutated by this class, and it is not an event emitter: all observation
 * happens through hooks and return values.
 */
class Sheet {
	/** The hook map (injected or self-created). Never replaced afterwards. */
	hooks: PolisherHooks;
	/** Resolved base URL used for `url()` and `@import` resolution. */
	url: URL;
	private _text!: string;
	/** The parsed stylesheet AST; `undefined` until `parse` reaches the parse step. */
	ast!: CssNode & { children: List };
	/** Fresh UUID minted on every `parse`; observable to handlers. */
	id!: string;
	/**
	 * Absolute URLs of applied `@import` rules; reset to a fresh array on
	 * every `parse` before the at-rule walk. Fetching them is the Polisher's
	 * job, not the Sheet's.
	 */
	imported!: string[];
	/** Optional page width; populated externally by `@page` size handlers. */
	width?: Dimension;
	/** Optional page height; populated externally by `@page` size handlers. */
	height?: Dimension;
	/** Optional page orientation; populated externally by `@page` handlers. */
	orientation?: string;

	/**
	 * @param {string} url The sheet's base URL for relative resolution,
	 * parsed against `window.location.href`; when that parse fails the
	 * location href alone is used instead.
	 * @param {PolisherHooks} [hooks] Optional shared hook map. When given it
	 * is stored verbatim (no key is added or replaced) and must already
	 * contain all 12 hooks; otherwise a fresh map of 12 hooks, each bound to
	 * this sheet, is created.
	 */
	constructor(url: string, hooks?: PolisherHooks) {
		if (hooks) {
			this.hooks = hooks;
		} else {
			this.hooks = {} as PolisherHooks;
			this.hooks.onUrl = new Hook(this);
			this.hooks.onAtPage = new Hook(this);
			this.hooks.onAtMedia = new Hook(this);
			this.hooks.onRule = new Hook(this);
			this.hooks.onDeclaration = new Hook(this);
			this.hooks.onContent = new Hook(this);
			this.hooks.onSelector = new Hook(this);
			this.hooks.onPseudoSelector = new Hook(this);
			this.hooks.onImport = new Hook(this);
			this.hooks.beforeTreeParse = new Hook(this);
			this.hooks.beforeTreeWalk = new Hook(this);
			this.hooks.afterTreeWalk = new Hook(this);
		}

		try {
			this.url = new URL(url, window.location.href);
		} catch {
			this.url = new URL(window.location.href);
		}
	}

	/**
	 * Runs the whole parse lifecycle (see the class docs for the exact step
	 * order). Calling `parse` again on the same instance replaces `ast`,
	 * re-mints `id`, resets `imported` and re-runs every hook on the new
	 * tree.
	 *
	 * @param {string} text The raw CSS text. `beforeTreeParse` handlers may
	 * rewrite it through the `sheet.text` setter; the current private text is
	 * what actually gets parsed.
	 * @returns {Promise<CssNode & { children: List }>} The sheet's AST (the
	 * same object as the `ast` field).
	 */
	async parse(text: string): Promise<CssNode & { children: List }> {
		this.text = text;

		await this.hooks.beforeTreeParse.trigger(this.text, this);

		this.ast = csstree.parse(this._text);

		await this.hooks.beforeTreeWalk.trigger(this.ast);

		this.replaceUrls(this.ast);
		this.id = UUID();
		this.replaceIds(this.ast);
		this.imported = [];
		this.urls(this.ast);
		this.rules(this.ast);
		this.atrules(this.ast);

		await this.hooks.afterTreeWalk.trigger(this.ast, this);

		return this.ast;
	}

	/**
	 * Appends a rule to the tail of the top-level `ast.children` list and
	 * runs {@link Sheet.declarations} on it: the inserted rule gets
	 * `onDeclaration` (and `onContent` for `content` declarations) with
	 * `ruleItem` and `rulelist` absent — but deliberately no `onRule` and no
	 * selector walk. Meant to be called from `afterTreeWalk` handlers;
	 * appended rules serialize after all author rules.
	 *
	 * @param {CssNode} rule The rule node to append.
	 * @returns {List.Cursor} Whatever `List.appendData` returns; no consumer
	 * relies on the value (with css-tree 1.1.3 this is the children list
	 * itself, despite the declared cursor return type).
	 */
	insertRule(rule: CssNode): List.Cursor {
		const listItem = this.ast.children.appendData(rule);
		this.declarations(rule);
		return listItem;
	}

	/**
	 * Triggers `onUrl` for every Url node in the tree, walk-callback args
	 * passed through. Runs after {@link Sheet.replaceUrls}, so handlers see
	 * already-absolute URLs; Url nodes inside `@import` preludes included.
	 *
	 * @param {CssNode} ast The tree to walk.
	 */
	urls(ast: CssNode): void {
		csstree.walk(ast, {
			visit: "Url",
			enter: (node, item, list) => {
				this.hooks.onUrl.trigger(node, item!, list!);
			},
		});
	}

	/**
	 * Triggers the at-rule hooks for every Atrule node in the tree (nested
	 * at-rules included, e.g. margin boxes inside `@page`): `@page` fires
	 * `onAtPage` plus a declarations walk, `@media` fires `onAtMedia` plus a
	 * declarations walk, `@import` fires `onImport` plus
	 * {@link Sheet.imports}; any other at-rule stays silent. The at-rule
	 * name is lowercased and stripped of its vendor prefix first, so `@PAGE`
	 * and `@-x-page` both count as `page`.
	 *
	 * @param {CssNode} ast The tree to walk.
	 */
	atrules(ast: CssNode): void {
		csstree.walk(ast, {
			visit: "Atrule",
			enter: (node, item, list) => {
				const basename = csstree.keyword(node.name).basename;

				if (basename === "page") {
					this.hooks.onAtPage.trigger(node, item!, list!);
					this.declarations(node, item, list);
				} else if (basename === "media") {
					this.hooks.onAtMedia.trigger(node, item!, list!);
					this.declarations(node, item, list);
				} else if (basename === "import") {
					this.hooks.onImport.trigger(node, item!, list!);
					this.imports(node, item!, list!);
				}
			},
		});
	}

	/**
	 * For every Rule node in the tree (rules inside `@media`/`@supports`
	 * blocks included) triggers, in order: `onRule`, a declarations walk,
	 * then {@link Sheet.onSelector}.
	 *
	 * @param {CssNode} ast The tree to walk.
	 */
	rules(ast: CssNode): void {
		csstree.walk(ast, {
			visit: "Rule",
			enter: (node, item, list) => {
				this.hooks.onRule.trigger(node, item!, list!);
				this.declarations(node, item, list);
				this.onSelector(node, item, list);
			},
		});
	}

	/**
	 * Walks the given subtree for Declaration nodes, triggering
	 * `onDeclaration` per declaration with the containing rule as trailing
	 * context, and `onContent` for every Function node inside a declaration
	 * whose property is exactly `content` (non-function value parts and
	 * functions under other properties produce nothing). Hook promises are
	 * not awaited.
	 *
	 * Because this walk is rooted at the subtree given, a declaration inside
	 * a rule nested in `@media` is visited twice per parse — once from
	 * {@link Sheet.rules} (rule context: the inner Rule) and once from
	 * {@link Sheet.atrules} (rule context: the `@media` Atrule). Handlers
	 * must tolerate that double visit.
	 *
	 * @param {CssNode} ruleNode The subtree to walk (usually a Rule; its own
	 * type does not matter to the walk).
	 * @param {List.Cursor} [ruleItem] The rule's cursor in its parent list;
	 * absent when called from {@link Sheet.insertRule}.
	 * @param {List} [rulelist] The list containing the rule; absent when
	 * called from {@link Sheet.insertRule}.
	 */
	declarations(
		ruleNode: CssNode,
		ruleItem?: List.Cursor,
		rulelist?: List,
	): void {
		csstree.walk(ruleNode, {
			visit: "Declaration",
			enter: (node, item, list) => {
				this.hooks.onDeclaration.trigger(node, item!, list!, {
					ruleNode,
					ruleItem,
					rulelist,
				});

				if (node.property === "content") {
					csstree.walk(node, {
						visit: "Function",
						enter: (funcNode, fItem, fList) => {
							this.hooks.onContent.trigger(
								funcNode,
								fItem!,
								fList!,
								{
									declarationNode: node,
									dItem: item,
									dList: list,
								},
								{
									ruleNode,
									ruleItem,
									rulelist,
								},
							);
						},
					});
				}
			},
		});
	}

	/**
	 * Walks the given rule node for Selector nodes (each comma-separated
	 * selector of the prelude is one Selector node), triggering `onSelector`
	 * per selector and `onPseudoSelector` for every PseudoElementSelector
	 * found inside a selector. Pseudo-*classes* (`:hover`, ...) never reach
	 * `onPseudoSelector`.
	 *
	 * @param {CssNode} ruleNode The rule whose prelude selectors to walk.
	 * @param {List.Cursor} [ruleItem] The rule's cursor in its parent list.
	 * @param {List} [rulelist] The list containing the rule.
	 */
	onSelector(
		ruleNode: CssNode,
		ruleItem?: List.Cursor,
		rulelist?: List,
	): void {
		csstree.walk(ruleNode, {
			visit: "Selector",
			enter: (node, item, list) => {
				this.hooks.onSelector.trigger(node, item!, list!, {
					ruleNode,
					ruleItem,
					rulelist,
				});

				node.children.forEach((child: CssNode) => {
					if (child.type === "PseudoElementSelector") {
						csstree.walk(child, {
							visit: "PseudoElementSelector",
							enter: (pseudoNode, pItem, pList) => {
								this.hooks.onPseudoSelector.trigger(
									pseudoNode,
									pItem!,
									pList!,
									{
										selectNode: node,
										selectItem: item,
										selectList: list,
									},
									{
										ruleNode,
										ruleItem,
										rulelist,
									},
								);
							},
						});
					}
				});
			},
		});
	}

	/**
	 * Absolutizes every non-data `url()` value in the tree in place: quote
	 * characters are stripped from the value text, the remainder is resolved
	 * against the sheet's base URL, and the absolute URL is written back
	 * *unquoted* (a quoted `url("x.png")` serializes unquoted afterwards).
	 * Data URIs — `data:` raw or quoted `"data:`/`'data:` — are left
	 * untouched so their payloads are not re-serialized. An unresolvable URL
	 * throws, unguarded, and aborts the parse.
	 *
	 * @param {CssNode} ast The tree to rewrite.
	 */
	replaceUrls(ast: CssNode): void {
		csstree.walk(ast, {
			visit: "Url",
			enter: (node) => {
				const value = node.value;

				if (value.type === "Raw" && value.value.startsWith("data:")) {
					return;
				}

				if (
					value.type === "String" &&
					(value.value.startsWith("\"data:") ||
						value.value.startsWith("'data:"))
				) {
					return;
				}

				const href = value.value.replace(/["']/g, "");
				node.value.value = new URL(href, this.url).toString();
			},
		});
	}

	/**
	 * Scopes every selector in the tree under the given id: an IdSelector
	 * node and a single space are prepended to each Selector node's
	 * children, turning `h1` into `#<id> h1`. Applies to every Selector node
	 * in the tree, including inside `@media`.
	 *
	 * @param {CssNode} ast The tree to rewrite.
	 * @param {string} id The scoping id (without `#`).
	 */
	addScope(ast: CssNode, id: string): void {
		csstree.walk(ast, {
			visit: "Selector",
			enter: (node) => {
				node.children.prependData({
					type: "WhiteSpace",
					loc: null,
					value: " ",
				});
				node.children.prependData({
					type: "IdSelector",
					loc: null,
					name: id,
					children: null,
				});
			},
		});
	}

	/**
	 * Extracts named pages: for every `page: <name>` declaration inside an
	 * ordinary rule (css-tree lowercases authored casing of the property),
	 * records the page name together with the rule's serialized prelude —
	 * later duplicates overwrite earlier map entries — and rewrites the
	 * declaration in place to `break-before: always`. Declarations inside
	 * `@page` at-rules are not visited (an `@page` is an Atrule, not a Rule)
	 * and stay untouched.
	 *
	 * @param {CssNode} ast The tree to inspect and rewrite.
	 * @returns {Record<string, { name: string; selector: string }>} The
	 * named pages found, keyed by page name; empty when there were none.
	 */
	getNamedPageSelectors(
		ast: CssNode,
	): Record<string, { name: string; selector: string }> {
		const result: Record<string, { name: string; selector: string }> = {};

		csstree.walk(ast, {
			visit: "Rule",
			enter: (node) => {
				csstree.walk(node, {
					visit: "Declaration",
					enter: (declaration) => {
						if (declaration.property === "page") {
							const name = declaration.value.children.first().name;

							result[name] = {
								name,
								selector: csstree.generate(node.prelude),
							};

							declaration.property = "break-before";
							declaration.value.children.first().name = "always";
						}
					},
				});
			},
		});

		return result;
	}

	/**
	 * Rewrites every IdSelector node found inside the tree's rules in place
	 * into an AttributeSelector on the `data-id` attribute, so `#intro`
	 * serializes as `[data-id="intro"]`: the chunker tags the paginated DOM
	 * with `data-id` attributes, keeping author ID-based selectors working
	 * after repagination. Includes selectors inside `@media`; nothing else
	 * changes.
	 *
	 * @param {CssNode} ast The tree to rewrite.
	 */
	replaceIds(ast: CssNode): void {
		csstree.walk(ast, {
			visit: "Rule",
			enter: (node) => {
				csstree.walk(node, {
					visit: "IdSelector",
					enter: (idNode) => {
						const name = idNode.name;

						idNode.type = "AttributeSelector";
						idNode.name = {
							type: "Identifier",
							name: "data-id",
							loc: null,
						};
						idNode.matcher = "=";
						idNode.value = {
							type: "String",
							loc: null,
							value: `"${name}"`,
						};
						idNode.flags = null;
					},
				});
			},
		});
	}

	/**
	 * Processes one `@import` at-rule (called only from the `atrules` walk).
	 * The import applies only when its media queries name no medium other
	 * than `screen` or `speech`: every collected media-type token must pass,
	 * where a token passes when it is `screen`/`speech` and a `not` token
	 * passes only when the *next* token is `screen`/`speech` (a trailing
	 * `not` therefore fails). A bare `@import` — or one with only media
	 * features, which collect no Identifier tokens — is applied. Applied
	 * imports get their URL(s) resolved against the base URL, pushed onto
	 * `imported`, and the at-rule removed from its parent list. Unquoted
	 * `url()` preludes hold a Raw rather than a String and are neither
	 * imported nor removed. Nested fetching of `imported` is the Polisher's
	 * job.
	 *
	 * @param {CssNode} node The `@import` at-rule node.
	 * @param {List.Cursor} item The at-rule's cursor in its parent list.
	 * @param {List} list The list containing the at-rule.
	 */
	imports(node: CssNode, item: List.Cursor, list: List): void {
		const media: string[] = [];

		csstree.walk(node, {
			visit: "MediaQuery",
			enter: (mediaNode) => {
				csstree.walk(mediaNode, {
					visit: "Identifier",
					enter: (idNode) => {
						media.push(idNode.name);
					},
				});
			},
		});

		const applies = media.every((token, index) => {
			if (token === "not") {
				return (
					media[index + 1] === "screen" || media[index + 1] === "speech"
				);
			}
			return token === "screen" || token === "speech";
		});

		if (!applies) {
			return;
		}

		csstree.walk(node, {
			visit: "String",
			enter: (stringNode) => {
				const href = stringNode.value.replace(/["']/g, "");
				this.imported.push(new URL(href, this.url).toString());
				list.remove(item);
			},
		});
	}

	/** @param {string} t */
	set text(t: string) {
		this._text = t;
	}

	/** @returns {string} The stored raw CSS text; `undefined` before any assignment. */
	get text(): string {
		return this._text;
	}

	/**
	 * Serializes the given AST, or the sheet's own when the argument is
	 * falsy, with css-tree's minified generator (no whitespace between
	 * rules, `div>p` selectors). Because `parse` mutated the AST in place,
	 * the output reflects the absolutized URLs, `[data-id]` selectors,
	 * removed `@import`s, named-page rewrites and every handler edit — this
	 * is the text the Polisher inserts into the document.
	 *
	 * @param {CssNode} [ast] The tree to serialize; falsy falls back to the
	 * sheet's own AST.
	 * @returns {string} The serialized CSS text.
	 */
	toString(ast?: CssNode): string {
		return csstree.generate(ast || this.ast);
	}
}

export default Sheet;
