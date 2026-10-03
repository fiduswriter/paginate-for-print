import Overflow from "./overflow.js";

/**
 * Break token: the resume bookmark that carries pagination from one page (or
 * column) to the next. Records where rendering stopped: the node to resume
 * at, the overflow records describing the content that spilled past the
 * column edge, whether the flow is finished, and a FIFO queue of nodes that
 * still owe a forced break.
 *
 * The chunker's render loop feeds this token back into the next page's layout
 * and keeps looping until the token reports finished. The token is a plain,
 * fully synchronous data model: it performs no DOM mutation, no measurement,
 * and emits no events. Its behavioral logic is `equals` (the pagination
 * loop's stall/termination detection) and the forced-break queue (FIFO
 * append/take semantics).
 */
class BreakToken {
	node: Node;
	overflow: Overflow[];
	finished: boolean;
	breakNeededAt: Node[];

	/**
	 * Creates an instance of BreakToken.
	 *
	 * @param {Node} node - The node at which rendering stopped; the next
	 *   page's layout resumes from here. Stored as-is, unvalidated: it may
	 *   be undefined (via type casts at construction sites), a text node, a
	 *   comment node, or an element.
	 * @param {Overflow[]} [overflowArray] - The overflow records for content
	 *   that spilled past the column edge. Stored by reference, unvalidated,
	 *   so callers can push further entries onto the token's list; a falsy
	 *   value yields a fresh empty array.
	 */
	constructor(node: Node, overflowArray?: Overflow[]) {
		this.node = node;
		this.overflow = overflowArray || [];
		this.finished = false;
		this.breakNeededAt = [];
	}

	/**
	 * Compares this token to another.
	 *
	 * Four checks must all pass, each short-circuiting to false: the token
	 * node by reference identity, the overflow arrays by length, the overflow
	 * entries pairwise by delegating to the entries' own `equals` method, and
	 * the forced-break queues by length plus structural DOM equality
	 * (`isEqualNode` — distinct but structurally identical nodes compare
	 * equal). The finished flag is deliberately not compared. The operand is
	 * dereferenced unconditionally: a missing operand throws a TypeError.
	 *
	 * @param {BreakToken} otherBreakToken - The token to compare against.
	 * @returns {boolean} True if the two tokens are equal, false otherwise.
	 */
	equals(otherBreakToken: BreakToken): boolean {
		if (this.node !== otherBreakToken.node) {
			return false;
		}
		if (this.overflow.length !== otherBreakToken.overflow.length) {
			return false;
		}
		for (const index in this.overflow) {
			if (
				!(this.overflow as any)[index].equals(
					(otherBreakToken.overflow as any)[index]
				)
			) {
				return false;
			}
		}
		const otherQueue = otherBreakToken.getForcedBreakQueue();
		if (this.breakNeededAt.length !== otherQueue.length) {
			return false;
		}
		for (let i = 0; i < this.breakNeededAt.length; i++) {
			if (!this.breakNeededAt[i].isEqualNode(otherQueue[i])) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Marks the flow as finished, which stops the chunker's page loop.
	 */
	setFinished(): void {
		this.finished = true;
	}

	/**
	 * Checks whether the flow has been marked as finished.
	 *
	 * @returns {boolean} True for a token that was passed to `setFinished`,
	 *   false for any freshly constructed token.
	 */
	isFinished(): boolean {
		return this.finished;
	}

	/**
	 * Appends a node that still owes a forced break to the tail of the
	 * forced-break queue, preserving insertion order. No validation, no
	 * deduplication: pushing the same node twice yields two queue entries.
	 *
	 * @param {Node} needsBreak - The node to queue up.
	 */
	addNeedsBreak(needsBreak: Node): void {
		this.breakNeededAt.push(needsBreak);
	}

	/**
	 * Removes and returns the node at the head of the forced-break queue
	 * (FIFO via shift). Operates on whatever array is currently installed as
	 * the queue, so it reflects a preceding `setForcedBreakQueue`.
	 *
	 * @returns {Node | undefined} The next node that owes a forced break, or
	 *   undefined when the queue is empty.
	 */
	getNextNeedsBreak(): Node | undefined {
		return this.breakNeededAt.shift();
	}

	/**
	 * Returns the forced-break queue.
	 *
	 * @returns {Node[]} The live internal queue, not a copy: mutating the
	 *   returned array (push, shift, splice) mutates the token's queue.
	 */
	getForcedBreakQueue(): Node[] {
		return this.breakNeededAt;
	}

	/**
	 * Replaces the forced-break queue.
	 *
	 * @param {Node[]} queue - The new queue, installed by reference (no
	 *   copy): later mutations of the array are visible through the token.
	 * @returns {Node[]} The installed queue.
	 */
	setForcedBreakQueue(queue: Node[]): Node[] {
		this.breakNeededAt = queue;
		return this.breakNeededAt;
	}
}

export default BreakToken;
