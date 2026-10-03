// Ambient module declarations for dependencies that do not ship TypeScript
// typings. Kept deliberately loose at AST edges; core contracts are typed in
// the modules themselves.

declare module "event-emitter" {
	function eventEmitter(target: object): void;
	export default eventEmitter;
}

declare module "event-emitter/pipe.js" {
	function pipe(from: object, to: object): void;
	export default pipe;
}

declare module "clear-cut" {
	export function calculateSpecificity(selector: string): number;
}

declare module "css-tree" {
	/** A css-tree v1 AST node. Structure varies by `type`; access is loose by design. */
	export type CssNode = { type: string } & Record<string, any>;

	export interface Cursor<T = CssNode> {
		prev: Cursor<T> | null;
		next: Cursor<T> | null;
		data: T;
	}

	export class List<T = CssNode> {
		length: number;
		head: Cursor<T> | null;
		tail: Cursor<T> | null;
		constructor();
		first(): T | null;
		last(): T | null;
		each(
			fn: (item: T, itemRef: Cursor<T>, list: List<T>) => boolean | void,
		): void;
		forEach(
			fn: (item: T, itemRef: Cursor<T>, list: List<T>) => void,
		): void;
		fromArray(items: T[]): this;
		appendData(item: T): Cursor<T>;
		insertData(item: T): Cursor<T>;
		push(item: T): void;
		unshift(item: T): void;
		append(item: T | List<T>): void;
		appendList(list: List<T>): void;
		insert(item: T, ref?: Cursor<T>): void;
		createItem(data: T): Cursor<T>;
		copy(): List<T>;
		remove(itemRef: Cursor<T> | T): void;
		toArray(): T[];
		[Symbol.iterator](): Iterator<T>;
	}

	export function parse(
		source: string,
		options?: Record<string, unknown>,
	): CssNode & { children: List };

	export function generate(node: unknown): string;

	export function walk(
		node: unknown,
		options: {
			visit?: string | string[];
			reverse?: boolean;
			enter?(node: CssNode, item?: Cursor, list?: List): boolean | void;
			leave?(node: CssNode, item?: Cursor, list?: List): boolean | void;
		},
	): void;

	export function clone(node: unknown): any;

	export interface KeywordInfo {
		name: string;
		basename: string;
		vendorPrefix: string | null;
		prefix: string;
		suffix: string;
		isCustom: boolean;
	}

	export interface PropertyInfo extends KeywordInfo {
		property: string;
	}

	export function keyword(name: string): KeywordInfo;
	export function property(name: string): PropertyInfo;

	export namespace List {
		export interface Cursor<T = CssNode> {
			prev: Cursor<T> | null;
			next: Cursor<T> | null;
			data: T;
		}
	}

	const csstree: {
		List: typeof List;
		parse: typeof parse;
		generate: typeof generate;
		walk: typeof walk;
		clone: typeof clone;
		keyword: typeof keyword;
		property: typeof property;
	};

	export default csstree;
}

/**
 * Runtime DOM facts the standard lib types miss:
 * - All Elements in play are HTML elements carrying `dataset`/`style`.
 * - CharacterData nodes expose sibling-element accessors per the
 *   NonDocumentTypeChildNode mixin.
 */
interface Element {
	readonly dataset: DOMStringMap;
	readonly style: CSSStyleDeclaration;
}

interface CharacterData {
	readonly nextElementSibling: Element | null;
	readonly previousElementSibling: Element | null;
}
