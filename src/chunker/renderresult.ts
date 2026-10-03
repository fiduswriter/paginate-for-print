import BreakToken from "./breaktoken.js";

/**
 * Represents the result of a rendering operation: the break token where
 * rendering ended or needs to continue, plus an optional rendering error.
 */
class RenderResult {
	/** The token where rendering ended or needs to continue. */
	breakToken?: BreakToken | null;
	/** An optional error that occurred during rendering. */
	error?: Error;

	/**
	 * Create a RenderResult.
	 *
	 * @param {BreakToken} breakToken - A token indicating where rendering
	 *   stopped due to overflow.
	 * @param {Error} [error] - Optional error encountered during rendering.
	 */
	constructor(breakToken?: BreakToken | null, error?: Error) {
		this.breakToken = breakToken;
		this.error = error;
	}
}

/**
 * An error thrown when content cannot fit within the available layout space.
 */
export class OverflowContentError extends Error {
	/** The overflowing items that triggered this error. */
	items: unknown[];

	/**
	 * Create an OverflowContentError.
	 *
	 * @param {string} message - The error message.
	 * @param {unknown[]} items - The content items that could not be rendered
	 *   due to overflow.
	 */
	constructor(message: string, items: unknown[]) {
		super(message);
		this.items = items;
	}
}

export default RenderResult;
