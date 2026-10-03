/**
 * Print media handler: adapts author `@media` at-rules for the paginated
 * rendering.
 *
 * The polyfill paginates in a normal *screen* browser context, so author
 * styles written for print would never apply on their own. During the CSS
 * processing phase (the per-stylesheet parse pipeline of `Sheet`) this
 * handler therefore rewrites every `@media` at-rule it is shown:
 *
 * - `@media print` blocks are **unwrapped**: the rules nested inside the
 *   block are lifted out and appended, list-wise, to the tail of the list
 *   that contained the block, and the at-rule itself is removed. As
 *   appends, the extracted rules serialize after every other rule of the
 *   enclosing list — so they win same-specificity cascade ties regardless
 *   of where the block was authored. The rules are moved unmodified: no
 *   scoping class is added, no selector is touched.
 * - `@media` blocks whose query cannot apply in the paginated context
 *   (`screen`, feature-only queries like `(min-width: 500px)`, …) are
 *   **removed** from the stylesheet altogether.
 * - `@media all` and blocks carrying the engine's `paged-ignore`
 *   escape-hatch media type are **kept verbatim**, nested as authored:
 *   `all` matches the paginated screen rendering too, and
 *   `screen, paged-ignore` is the idiomatic way to keep screen-only styles
 *   alive through pagination (the unknown media type never matches, the
 *   `screen` arm does).
 *
 * Matching is done purely on the presence of authored identifier tokens in
 * the media prelude (exact, case-sensitive `print` / `all` /
 * `paged-ignore`): negation is not evaluated, so `@media not print`
 * unwraps as well. The module is stateless and fully synchronous; all
 * mutation happens in place on the css-tree AST and its linked lists, and
 * it touches no DOM and emits no events.
 */

import Handler from "../handler.js";
import csstree from "css-tree";
import type { CssNode, List } from "css-tree";
import type { HandlerSource } from "../handler.js";

/**
 * Paged-media behavior module that rewrites `@media` at-rules for the
 * paginated screen rendering (unwraps `print`, removes inapplicable
 * queries, keeps `all` / `paged-ignore`).
 */
class PrintMedia extends Handler {
	/**
	 * Wires the handler against the engine objects; subscribes the
	 * `onAtMedia` method to the polisher's `onAtMedia` hook via the base
	 * class's name-matching auto-registration.
	 *
	 * @param {HandlerSource} chunker - The chunker, exposing lifecycle hooks.
	 * @param {HandlerSource} polisher - The polisher, exposing CSS hooks.
	 * @param {HandlerSource} caller - The caller (previewer), exposing
	 * preview hooks.
	 */
	constructor(chunker?: HandlerSource, polisher?: HandlerSource, caller?: HandlerSource) {
		super(chunker, polisher, caller);
	}

	/**
	 * `onAtMedia` hook, fired by `Sheet.atrules` for every at-rule whose
	 * lowercased, vendor-stripped basename is `media` (this method itself
	 * never inspects `node.name`). Mutates the stylesheet in place:
	 *
	 * 1. `print` among the authored prelude identifiers → unwrap: the
	 *    at-rule's block children are appended, list-wise, to the tail of
	 *    the parent list (which empties the block) and the at-rule is then
	 *    unlinked from that list. A blockless at-rule (`@media print;`)
	 *    throws a `TypeError` reading `children` of `null`.
	 * 2. Neither `all` nor `paged-ignore` among them → remove the whole
	 *    at-rule from the parent list; its block stays attached to the
	 *    detached node. A blockless at-rule (`@media screen;`) is removed
	 *    without error — the block is never read on this branch.
	 * 3. Otherwise (`all` and/or `paged-ignore`) → do nothing: the at-rule
	 *    stays exactly where it is and serializes verbatim.
	 *
	 * @param {CssNode} node - The `@media` at-rule node.
	 * @param {List.Cursor} item - The at-rule's cursor in its parent list.
	 * @param {List} list - The list containing the at-rule: the stylesheet's
	 * top-level children list for a top-level `@media`, or a block's
	 * children list for a nested one.
	 */
	onAtMedia(node: CssNode, item: List.Cursor | any, list: List | any): void {
		const media = this.getMediaName(node);

		if (media.includes("print")) {
			// Move the block's rules to the tail of the enclosing list (the
			// move leaves the block's children list empty), then unlink the
			// at-rule wrapper itself.
			list.appendList(node.block.children);
			list.remove(item);
		} else if (!media.includes("all") && !media.includes("paged-ignore")) {
			// The query cannot match during the paginated screen rendering.
			list.remove(item);
		}
		// `all` / `paged-ignore`: keep the block nested as authored.
	}

	/**
	 * Collects the authored identifier tokens of an `@media` prelude,
	 * case-preserved, deduplicated never, in walk (pre-)order: media types,
	 * the `and` / `only` / `not` qualifier keywords and identifier feature
	 * values (`landscape` in `(orientation: landscape)`) — numeric or
	 * dimension feature values collect nothing. Returns a fresh array per
	 * call.
	 *
	 * An absent prelude, or one css-tree fell back to parsing as `Raw`
	 * (notably range syntax such as `(width <= 600px)`), yields an empty
	 * array. A `null` prelude (e.g. `@media { … }`) is deliberately NOT
	 * caught: the `undefined` guard passes `null` through and reading the
	 * prelude's `type` throws a `TypeError` — current behavior, replicated.
	 *
	 * @param {CssNode} node - The `@media` at-rule node.
	 * @returns {string[]} The prelude's identifier names, as authored.
	 */
	getMediaName(node: CssNode): string[] {
		const media: string[] = [];

		if (typeof node.prelude === "undefined" || node.prelude.type !== "AtrulePrelude") {
			return media;
		}

		csstree.walk(node.prelude, {
			visit: "Identifier",
			enter: (identifier: CssNode) => {
				media.push(identifier.name);
			},
		});

		return media;
	}
}

export default PrintMedia;
