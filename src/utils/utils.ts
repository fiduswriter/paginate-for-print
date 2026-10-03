/**
 * General-purpose, dependency-free helpers shared across the engine:
 * thin geometry wrappers, identifier mints, selector building and
 * escaping, CSS value flattening, and a promise-exposing deferred.
 * This module sits at the bottom of the import graph and imports nothing.
 */

/**
 * Local alias for the shape of a scheduler that runs `cb` at some later
 * point of time and returns a numeric handle for it.
 */
type idleRequester = (cb: () => void) => number;

/**
 * Returns the bounding box of an element or range. Nodes that expose no
 * box of their own (text nodes, comments, ...) are measured through a
 * document range spanning the node and its descendants instead.
 *
 * @param {Element|Range} [element] - Element or range to measure.
 * @returns {DOMRect|undefined} The bounding box, or undefined when no
 * argument (or a falsy one) is given.
 */
export function getBoundingClientRect(
	element?: Element | Range,
): DOMRect | undefined {
	if (!element) {
		return undefined;
	}

	if (typeof element.getBoundingClientRect === "function") {
		return element.getBoundingClientRect();
	}

	const range = document.createRange();
	range.selectNode(element as unknown as Node);
	return range.getBoundingClientRect();
}

/**
 * Returns the client rectangles of an element or range, one per CSS
 * border box. Nodes that expose no rectangles of their own (text nodes,
 * comments, ...) are measured through a document range spanning the node
 * and its descendants instead.
 *
 * @param {Element|Range} [element] - Element or range to measure.
 * @returns {DOMRectList|undefined} The client rectangles, or undefined
 * when no argument (or a falsy one) is given.
 */
export function getClientRects(
	element?: Element | Range,
): DOMRectList | undefined {
	if (!element) {
		return undefined;
	}

	if (typeof element.getClientRects === "function") {
		return element.getClientRects();
	}

	const range = document.createRange();
	range.selectNode(element as unknown as Node);
	return range.getClientRects();
}

/**
 * Mints a version-4-shaped UUID string: 8-4-4-4-12 hex groups, a literal
 * `4` opening the third group and one of `8`/`9`/`a`/`b` opening the
 * fourth. Entropy comes from one Math.random draw per output character,
 * folded together with the wall-clock time and, when available, a
 * high-resolution timer reading. Time-biased and not cryptographically
 * random, but distinct in practice.
 *
 * @returns {string} A 36-character UUID.
 */
export function UUID(): string {
	let time = Date.now();
	if (
		typeof performance !== "undefined" &&
		typeof performance.now === "function"
	) {
		time += performance.now();
	}

	const hex = "0123456789abcdef";
	let uuid = "";
	for (let i = 0; i < 36; i++) {
		if (i === 8 || i === 13 || i === 18 || i === 23) {
			uuid += "-";
			continue;
		}
		// One draw per character; the mutating clock value only breaks
		// ties between identical draws and keeps the output time-seeded.
		const draw = (Math.random() + (time % 89) / 89) % 1;
		time = time * 31 + 17;
		if (i === 14) {
			uuid += "4";
		} else if (i === 19) {
			uuid += hex.charAt(8 + Math.floor(draw * 4));
		} else {
			uuid += hex.charAt(Math.floor(draw * 16));
		}
	}
	return uuid;
}

/**
 * Returns the index of the first entry of `nodeList` that is the very
 * same object as `element`, or -1 when the list is empty or holds no
 * identical entry. Comparison is by identity, not structural equality.
 *
 * @param {Element} element - The element to look for.
 * @param {ArrayLike<Element>} nodeList - NodeList, HTMLCollection or
 * plain array to scan.
 * @returns {number} The 0-based position, or -1 when absent.
 */
export function positionInNodeList(
	element: Element,
	nodeList: ArrayLike<Element>,
): number {
	for (let i = 0; i < nodeList.length; i++) {
		if (nodeList[i] === element) {
			return i;
		}
	}
	return -1;
}

/**
 * Builds a CSS selector that identifies `ele` within its owner document,
 * trying progressively more specific forms: a unique id, a bare root tag
 * name, per-class selectors (optionally scoped by tag name and
 * nth-child), and finally the full structural ancestor chain. Uniqueness
 * is decided by document-wide match counts only; the single match is
 * never verified to be `ele` itself. Although declared to return a
 * string, the function returns undefined at runtime for elements that
 * match none of the forms.
 *
 * @param {Element} ele - The element to describe.
 * @returns {string} The selector, or undefined (runtime only) when no
 * form applies.
 */
export function findCssSelector(ele: Element): string {
	// The escaper is resolved from the global window up front, before any
	// other step; environments without window.CSS.escape fail here.
	const cssEscape = window.CSS.escape;

	// 1. A unique id wins outright, wherever the element itself lives.
	if (ele.id) {
		const idSelector = "#" + cssEscape(ele.id);
		if (ele.ownerDocument.querySelectorAll(idSelector).length === 1) {
			return idSelector;
		}
	}

	// 2. Bare tag names for the structural roots of the document.
	if (ele.localName === "html") {
		return "html";
	}
	if (ele.localName === "head") {
		return "head";
	}
	if (ele.localName === "body") {
		return "body";
	}

	// 3. One class at a time, three increasingly specific forms each.
	if (ele.classList.length > 0) {
		for (let i = 0; i < ele.classList.length; i++) {
			const classSelector = "." + cssEscape(ele.classList.item(i)!);
			if (ele.ownerDocument.querySelectorAll(classSelector).length === 1) {
				return classSelector;
			}

			const tagAndClass = cssEscape(ele.localName) + classSelector;
			if (ele.ownerDocument.querySelectorAll(tagAndClass).length === 1) {
				return tagAndClass;
			}

			const nth =
				":nth-child(" +
				(positionInNodeList(ele, ele.parentNode!.children) + 1) +
				")";
			const scoped = tagAndClass + nth;
			if (ele.ownerDocument.querySelectorAll(scoped).length === 1) {
				return scoped;
			}
		}
	}

	// 4. Full structural form: the parent's selector plus nth-child.
	const parent = ele.parentNode;
	if (parent && parent !== ele.ownerDocument && parent.nodeType === 1) {
		const parentElement = parent as Element;
		const nth =
			":nth-child(" + (positionInNodeList(ele, parent.children) + 1) + ")";
		return (
			findCssSelector(parentElement) +
			" > " +
			cssEscape(ele.localName) +
			nth
		);
	}

	// 5. Declared string, undefined at runtime — a deliberate type lie.
	return undefined as unknown as string;
}

/**
 * Returns the value of the first attribute from `attributes` that is
 * present on `element`, checked in array order. A present-but-empty
 * attribute returns "".
 *
 * @param {Element} element - The element to read from.
 * @param {string[]} attributes - Attribute names, in priority order.
 * @returns {string|undefined} The first present attribute's value, or
 * undefined when none is present.
 */
export function attr(
	element: Element,
	attributes: string[],
): string | undefined {
	for (const name of attributes) {
		if (element.hasAttribute(name)) {
			return element.getAttribute(name) ?? undefined;
		}
	}
	return undefined;
}

/**
 * Escapes an arbitrary string into a safe CSS selector fragment. A
 * modified CSS.escape: unlike the native function it deliberately leaves
 * `#`, `.` and selector-legal characters unescaped, so a value starting
 * with `#` keeps working as an id selector (with a `.` escaped only when
 * it would otherwise end that id). Control characters and leading digits
 * are escaped as `\` + hex + space; other unsafe characters get a single
 * backslash and no trailing space.
 *
 * @param {unknown} [value] - The value to escape; coerced with String().
 * @returns {string} The escaped selector fragment.
 * @throws {TypeError} When called with no argument at all.
 */
export function querySelectorEscape(value?: unknown): string {
	if (arguments.length === 0) {
		throw new TypeError("`CSS.escape` requires an argument.");
	}

	const str = String(value);
	let result = "";
	for (let i = 0; i < str.length; i++) {
		const unit = str.charCodeAt(i);

		if (unit === 0) {
			result += "\uFFFD";
			continue;
		}

		if (
			(unit >= 0x1 && unit <= 0x1f) ||
			unit === 0x7f ||
			(i === 0 && unit >= 0x30 && unit <= 0x39) ||
			(i === 1 &&
				unit >= 0x30 &&
				unit <= 0x39 &&
				str.charCodeAt(0) === 0x2d)
		) {
			result += "\\" + unit.toString(16) + " ";
			continue;
		}

		if (unit === 0x2d && str.length === 1) {
			result += "\\-";
			continue;
		}

		if (unit === 0x2e && str.charAt(0) === "#") {
			result += "\\.";
			continue;
		}

		if (
			unit >= 0x80 ||
			unit === 0x2d ||
			unit === 0x5f ||
			unit === 0x23 ||
			unit === 0x2e ||
			(unit >= 0x30 && unit <= 0x39) ||
			(unit >= 0x41 && unit <= 0x5a) ||
			(unit >= 0x61 && unit <= 0x7a)
		) {
			result += str.charAt(i);
			continue;
		}

		result += "\\" + str.charAt(i);
	}
	return result;
}

/**
 * Minimal structural type for the legacy "CSSValue" objects produced by
 * the CSS parser: any value plus an optional unit string.
 */
export interface CSSValue {
	value: unknown;
	unit?: string;
}

/**
 * A deferred: exposes a native promise together with the functions that
 * settle it from the outside. The instance is frozen after construction;
 * the first settle wins and later resolve/reject calls are ignored. The
 * generic parameter is deliberately not enforced on `resolve`.
 */
export class defer<T = void> {
	/** Correlation handle, unique per instance. Purely informational. */
	id!: string;
	/** The promise settled by resolve/reject. */
	promise!: Promise<T>;
	/** Settles the promise; extra arguments follow native promise rules. */
	resolve!: (...args: any[]) => void;
	/** Rejects the promise; the first argument becomes the reason. */
	reject!: (...args: any[]) => void;

	constructor() {
		this.id = UUID();
		this.promise = new Promise<T>((resolve, reject) => {
			this.resolve = resolve as unknown as (...args: any[]) => void;
			this.reject = reject as unknown as (...args: any[]) => void;
		});
		Object.freeze(this);
	}
}

/**
 * Idle-time scheduler, resolved once at module load from the global
 * window: the native requestIdleCallback when present, otherwise
 * requestAnimationFrame, otherwise undefined (Node, jsdom). Callers must
 * null-check before use.
 */
export const requestIdleCallback: idleRequester | undefined = (() => {
	if (typeof window === "undefined") {
		return undefined;
	}
	if (window.requestIdleCallback) {
		return window.requestIdleCallback;
	}
	if (window.requestAnimationFrame) {
		return window.requestAnimationFrame;
	}
	return undefined;
})();

/**
 * Flattens a CSS value object into a string: the stringified value with
 * the unit appended when the unit is truthy.
 *
 * @param {CSSValue} obj - The value (and optional unit) to flatten.
 * @returns {string} E.g. "16px" for {value: 16, unit: "px"}.
 */
export function CSSValueToString(obj: CSSValue): string {
	return String(obj.value) + (obj.unit || "");
}
