/**
 * Represents an overflow area in a document or visual element.
 * Used to track positions and dimensions when content exceeds bounds.
 *
 * An overflow record describes a single piece of content that spilled past
 * the current column/page boundary during pagination: where rendering must
 * resume (the `node` and `offset` within the source DOM), the detected
 * overflowing `range` with its pixel `overflowHeight`, and whether the
 * overflow was anchored at the top-level rendered container (`topLevel`).
 * After the spilled content has been extracted from the page, the layout
 * engine attaches the extracted `content` fragment and the source `ancestor`
 * element into which it must be rebuilt on the next page.
 *
 * The record is plain data: no DOM queries, no measurement, no events, no
 * imports. Its only behavioral logic is `equals`, the identity predicate used
 * by the pagination loop's zero-progress (stall) detection.
 */
class Overflow {
	node: Node;
	offset?: number;
	overflowHeight?: number;
	range?: Range;
	topLevel?: boolean;
	/** Set later by layout when the overflow fragment has been extracted. */
	ancestor?: Element | null;
	/** Set later by layout: extracted content for this overflow entry. */
	content?: DocumentFragment;

	/**
	 * Creates an instance of Overflow.
	 *
	 * Stores each argument on the like-named field by reference, unvalidated
	 * and uncopied — no coercion, so falsy scalars (`0`, `false`) are kept
	 * distinct from `undefined`. Omitted trailing arguments simply leave the
	 * corresponding fields `undefined`. The `ancestor` and `content` fields
	 * are not set here; they are attached by the layout engine after the
	 * spilled content has been extracted.
	 *
	 * @param {Node} node - The node in the source DOM at which rendering must
	 *   resume; frequently a text node, an element anchor uses offset `0`.
	 * @param {number} [offset] - The offset within `node` (character offset
	 *   for text nodes, `0` for element anchors).
	 * @param {number} [overflowHeight] - The pixel height of the detected
	 *   overflow (bookkeeping; currently read by nothing).
	 * @param {Range} [range] - The live `Range` that was detected as
	 *   overflowing; read after extraction to derive the ancestor.
	 * @param {boolean} [topLevel] - True only when the overflow was anchored
	 *   at the top-level rendered container itself.
	 */
	constructor(
		node: Node,
		offset?: number,
		overflowHeight?: number,
		range?: Range,
		topLevel?: boolean,
	) {
		this.node = node;
		this.offset = offset;
		this.overflowHeight = overflowHeight;
		this.range = range;
		this.topLevel = topLevel;
	}

	/**
	 * Compares this overflow record's resume position to another.
	 *
	 * The operand is duck-typed: usually another Overflow instance, but any
	 * object with optional `node`/`offset` properties is accepted. Two rules
	 * can disagree, and each is skipped when it cannot apply:
	 *
	 * 1. Node rule — skipped when `this.node` is falsy or the operand's
	 *    `node` is `undefined` (an absent key and an explicitly `undefined`
	 *    value are indistinguishable; an explicitly `null` node counts as
	 *    present). When it runs, the nodes are compared by reference
	 *    identity: distinct references are unequal even when the DOM nodes
	 *    are structurally identical.
	 * 2. Offset rule — runs only when both offsets are not `undefined`; a
	 *    strict numeric inequality is a disagreement. Offset `0` is a
	 *    present, meaningful value (a break at the very start of a node),
	 *    not an absence. If either offset is `undefined` it is ignored
	 *    entirely.
	 *
	 * All other fields (`overflowHeight`, `range`, `topLevel`, `ancestor`,
	 * `content`) are deliberately ignored. Never throws, mutates nothing, is
	 * deterministic.
	 *
	 * @param {Partial<Pick<Overflow, "node" | "offset">>} otherOffset - The
	 *   operand record (or duck-typed stand-in) to compare against; a falsy
	 *   operand is never equal.
	 * @returns {boolean} True if no fired rule found a disagreement, false
	 *   otherwise.
	 */
	equals(
		otherOffset?: Partial<Pick<Overflow, "node" | "offset">> | null,
	): boolean {
		if (!otherOffset) {
			return false;
		}
		if (this.node && otherOffset.node !== undefined) {
			if (this.node !== otherOffset.node) {
				return false;
			}
		}
		if (this.offset !== undefined && otherOffset.offset !== undefined) {
			if (this.offset !== otherOffset.offset) {
				return false;
			}
		}
		return true;
	}
}

export default Overflow;
