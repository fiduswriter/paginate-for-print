import Sheet from "./sheet.js";
import baseStyles from "./base.js";
import Hook from "../utils/hook.js";
import request from "../utils/request.js";
import type { Dimension } from "./sizes.js";
import type { CssNode, List } from "css-tree";

/**
 * Extra context passed as trailing arguments to declaration-related hooks,
 * identifying the rule that contains the visited node. `ruleItem` and
 * `rulelist` are absent when the declaration originates from `Sheet.insertRule`.
 */
export interface RuleContext {
	ruleNode: CssNode;
	ruleItem?: List.Cursor;
	rulelist?: List;
}

/**
 * Context passed to the `onContent` hook describing the `content` declaration
 * in which a function node was found.
 */
export interface DeclarationContext {
	declarationNode: CssNode;
	dItem?: List.Cursor;
	dList?: List;
}

/**
 * Context passed to the `onPseudoSelector` hook describing the selector
 * in which a pseudo-element selector was found.
 */
export interface SelectorContext {
	selectNode: CssNode;
	selectItem?: List.Cursor;
	selectList?: List;
}

/**
 * Hook map shared between Polisher, its Sheets and registered handlers.
 * Each hook receives the css-tree walk callback arguments of the node it
 * is triggered for, plus extra context where noted.
 */
export interface PolisherHooks {
	onUrl: Hook<[CssNode, List.Cursor, List]>;
	onAtPage: Hook<[CssNode, List.Cursor, List]>;
	onAtMedia: Hook<[CssNode, List.Cursor, List]>;
	onRule: Hook<[CssNode, List.Cursor, List]>;
	onDeclaration: Hook<[CssNode, List.Cursor, List, RuleContext]>;
	onContent: Hook<[CssNode, List.Cursor, List, DeclarationContext, RuleContext]>;
	onSelector: Hook<[CssNode, List.Cursor, List, RuleContext]>;
	onPseudoSelector: Hook<[CssNode, List.Cursor, List, SelectorContext, RuleContext]>;
	onImport: Hook<[CssNode, List.Cursor, List]>;
	beforeTreeParse: Hook<[string, Sheet]>;
	beforeTreeWalk: Hook<[CssNode]>;
	afterTreeWalk: Hook<[CssNode, Sheet]>;
}

/**
 * The Polisher is the CSS layer of the paged-media engine: it owns the shared
 * hook map every per-stylesheet Sheet and behavior module works through,
 * injects the baseline stylesheet and an empty work stylesheet into the
 * document, and coordinates turning author CSS — fetched from URLs or given
 * inline — into processed `<style>` elements in the document head.
 *
 * It is a thin facade: parsing, AST rewriting and hook triggering live in
 * {@link Sheet}; the Polisher creates one Sheet per source with its shared
 * hook map, awaits the sheet's parse pipeline, recursively resolves the
 * sheet's applied `@import`s (each fully converted and inserted before the
 * importing sheet is recorded), then serializes the post-handler AST and
 * inserts the resulting text into the document head.
 */
class Polisher {
	/** One entry per processed stylesheet, in processing order. */
	sheets: Sheet[];
	/** Every `<style>` element created by {@link insert}, in creation order. */
	inserted: HTMLStyleElement[];
	/** The 12 live hooks, created in the constructor and never replaced. */
	hooks: PolisherHooks;
	/** The style element holding the baseline stylesheet; assigned by {@link setup}. */
	base!: HTMLStyleElement;
	/** The empty work style element created by {@link setup}. */
	styleEl!: HTMLStyleElement;
	/** The `sheet` CSSOM object of {@link styleEl}; `null` when none was created. */
	styleSheet!: CSSStyleSheet | null;
	/** Mirrored from the last processed sheet's `@page` size declarations. */
	width?: Dimension;
	/** Mirrored from the last processed sheet's `@page` size declarations. */
	height?: Dimension;
	/** Mirrored from the last processed sheet's `@page` size declarations. */
	orientation?: string;

	/**
	 * Creates a new Polisher instance.
	 * @param {boolean} [setup=true] - Whether to immediately run setup.
	 */
	constructor(setup?: boolean) {
		this.sheets = [];
		this.inserted = [];

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

		if (setup !== false) {
			this.setup();
		}
	}

	/**
	 * Sets up the base stylesheet and injects a <style> element into the document head.
	 * @returns {CSSStyleSheet} - The created stylesheet object.
	 */
	setup(): CSSStyleSheet | null {
		this.base = this.insert(baseStyles);

		this.styleEl = document.createElement("style");
		document.head.appendChild(this.styleEl);
		this.styleSheet = this.styleEl.sheet;

		return this.styleSheet;
	}

	/**
	 * Adds and processes one or more CSS sources (URLs or inline CSS).
	 * @param {...(string|Object<string, string>)} sources - URLs or object maps of URLs to CSS strings.
	 * @returns {Promise<string>} - The final processed CSS text.
	 */
	async add(...sources: Array<string | Record<string, string>>): Promise<string> {
		const urls: string[] = [];
		const fetched: Array<Promise<string> | string | undefined> = [];

		for (const source of sources) {
			if (typeof source === "object") {
				let value: string | undefined;

				for (const href in source) {
					urls.push(href);
					value = source[href];
				}

				fetched.push(value as string);
			} else {
				urls.push(source as string);
				fetched.push(request(source as string).then((response) => response.text()));
			}
		}

		let text = "";

		const fetchedTexts = await Promise.all(fetched);

		for (let index = 0; index < fetchedTexts.length; index++) {
			text = await this.convertViaSheet(fetchedTexts[index] as string, urls[index]);
			this.insert(text);
		}

		return text;
	}

	/**
	 * Converts raw CSS into a Sheet object, parses it, handles imports,
	 * and returns the processed CSS string.
	 * @param {string} cssStr - The raw CSS string.
	 * @param {string} href - The source URL for the CSS.
	 * @returns {Promise<string>} - The processed CSS text.
	 */
	async convertViaSheet(cssStr: string, href: string): Promise<string> {
		const sheet = new Sheet(href, this.hooks);

		await sheet.parse(cssStr);

		for (const url of sheet.imported) {
			const response = await request(url);
			const text = await response.text();
			const converted = await this.convertViaSheet(text, url);
			this.insert(converted);
		}

		this.sheets.push(sheet);

		if (sheet.width !== undefined) {
			this.width = sheet.width;
		}

		if (sheet.height !== undefined) {
			this.height = sheet.height;
		}

		if (sheet.orientation !== undefined) {
			this.orientation = sheet.orientation;
		}

		return sheet.toString();
	}

	/**
	 * Inserts a CSS string into the document inside a <style> tag.
	 * @param {string} text - The CSS to insert.
	 * @returns {HTMLStyleElement} - The created style element.
	 */
	insert(text: string): HTMLStyleElement {
		const head = document.querySelector("head");
		const styleEl = document.createElement("style");

		styleEl.setAttribute("data-paged-inserted-styles", "true");
		styleEl.appendChild(document.createTextNode(text));
		// A missing head element throws a TypeError here, by design.
		head!.appendChild(styleEl);

		this.inserted.push(styleEl);

		return styleEl;
	}

	/**
	 * Cleans up all inserted styles and resets the polisher.
	 */
	destroy(): void {
		this.styleEl.remove();

		for (const styleEl of this.inserted) {
			styleEl.remove();
		}

		this.sheets = [];
	}
}

export default Polisher;
