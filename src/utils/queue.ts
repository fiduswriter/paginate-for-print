import { defer } from "./utils.js";

// Internal (non-exported) queue-item model.
type QueuedTask = (...args: any[]) => unknown;

interface QueuedItemTask {
	task: QueuedTask;
	args: any[];
	deferred: defer;
	promise: Promise<unknown>;
}

interface QueuedItemPromise {
	promise: Promise<unknown>;
	task?: undefined;
	args?: undefined;
	deferred?: undefined;
}

type QueueItem = QueuedItemTask | QueuedItemPromise;

// Module-private constant (fallback interval when animation frames are not being produced).
const TICK_FALLBACK_MS: number = 100;

/**
 * Serial task queue paced by animation frames, with a timer fallback so
 * pagination keeps progressing when the browser stops producing frames
 * (e.g. for an occluded or minimized preview window).
 *
 * Tasks are executed strictly FIFO, one at a time; each step is started on
 * a fresh scheduler tick (animation frame or, at the latest, the fallback
 * timer). Promise values may be enqueued as well; they are passed through
 * untouched and only gate the drain.
 */
class Queue {
	_q: QueueItem[];
	context: unknown;
	tick: (cb: () => void) => number;
	running: boolean | Promise<unknown> | undefined;
	paused: boolean;
	defered!: defer;

	/**
	 * @param {unknown} context - The `this` value passed to every task
	 *   invocation, exactly as given (never defaulted or wrapped).
	 */
	constructor(context: unknown) {
		this.context = context;
		this._q = [];
		this.tick = this.scheduleTick.bind(this);
		this.running = false;
		this.paused = false;
	}

	/**
	 * The default tick scheduler: invokes `cb` at most once, via whichever
	 * of an animation frame or a fallback timer (TICK_FALLBACK_MS) arrives
	 * first. The animation frame is requested first; the fallback timer is
	 * created right after. The animation-frame request is never cancelled,
	 * and the first signal to fire clears the fallback timer (which may not
	 * exist yet when the frame signal wins synchronously). Returns the
	 * animation-frame handle only.
	 *
	 * @param {() => void} cb - The callback to invoke on the next tick.
	 * @returns {number} The animation-frame request handle.
	 */
	private scheduleTick(cb: () => void): number {
		let fired = false;
		let timeout: number | undefined;
		const tickCallback = () => {
			if (fired) {
				return;
			}
			fired = true;
			window.clearTimeout(timeout);
			cb();
		};
		const frame = requestAnimationFrame.call(window, tickCallback);
		timeout = window.setTimeout(tickCallback, TICK_FALLBACK_MS);
		return frame;
	}

	/**
	 * Append a task (or promise) to the queue and auto-start the drain loop
	 * when the queue is idle and not paused.
	 *
	 * @param {QueuedTask | Promise<unknown>} [task] - A function to invoke,
	 *   or any truthy non-function value (typically a promise) to pass
	 *   through as a promise item.
	 * @param {any[]} args - Arguments passed to the task invocation.
	 * @returns {Promise<unknown>} For a function task, the promise that
	 *   settles when the task completes; otherwise the exact value passed in.
	 */
	enqueue(
		task?: QueuedTask | Promise<unknown>,
		...args: any[]
	): Promise<unknown> {
		if (!task) {
			throw new Error("No Task Provided");
		}

		let item: QueueItem;
		let promise: Promise<unknown>;
		if (typeof task === "function") {
			const deferred = new defer();
			item = { task, args, deferred, promise: deferred.promise };
			promise = deferred.promise;
		} else {
			item = { promise: task };
			promise = task;
		}

		this._q.push(item);

		if (!this.paused && !this.running) {
			this.run();
		}

		return promise;
	}

	/**
	 * Take the head item, if any, and start it. Task rejections are
	 * contained: they settle the enqueue promise but never reject the
	 * promise returned here.
	 *
	 * @returns {Promise<unknown>} The promise of the started item (a fresh
	 *   already-resolved promise when the queue is empty or paused).
	 */
	dequeue(): Promise<unknown> {
		if (this._q.length && !this.paused) {
			const item = this._q.shift() as QueueItem;
			if (typeof item.task === "function") {
				const result: any = item.task.apply(this.context, item.args);
				if (result && typeof result.then === "function") {
					return (result as Promise<unknown>).then(
						(value: unknown) => {
							item.deferred.resolve(value);
						},
						(reason: unknown) => {
							item.deferred.reject(reason);
						},
					);
				}
				// Synchronous completion: resolve the deferred with the
				// result applied as an argument list (arrays resolve with
				// their first element; non-array-like objects and null
				// resolve undefined; other primitives throw a TypeError
				// synchronously out of this method).
				item.deferred.resolve.apply(undefined, result as any);
				return item.promise;
			}
			return item.promise;
		}
		return Promise.resolve();
	}

	// Synchronous drain of every pending item. Does not touch `running` or
	// `paused`. HAZARD: loops forever when paused with pending items.
	dump(): void {
		while (this._q.length) {
			this.dequeue();
		}
	}

	// Frame-paced sequential drain; resolves when the queue empties.
	// Calling run() unpauses the queue.
	run(): Promise<unknown> {
		if (!this.running) {
			this.running = true;
			this.defered = new defer();
		}

		this.tick.call(window, () => {
			if (this._q.length) {
				this.dequeue().then(() => {
					this.run();
				});
			} else {
				this.defered.resolve();
				this.running = undefined;
			}
		});

		if (this.paused) {
			this.paused = false;
		}

		return this.defered.promise;
	}

	// Microtask-paced drain; fastest possible processing. Returns the
	// active cycle state when busy (the literal boolean `true` during a
	// run cycle), a chain promise when draining, or undefined when idle
	// and empty.
	flush(): Promise<unknown> | undefined {
		if (this.running) {
			return this.running as Promise<unknown>;
		}

		if (this._q.length) {
			this.running = this.dequeue().then(() => {
				this.running = undefined;
				return this.flush();
			});
			return this.running as Promise<unknown>;
		}

		return undefined;
	}

	clear(): void {
		this._q = [];
	}

	length(): number {
		return this._q.length;
	}

	pause(): void {
		this.paused = true;
	}

	stop(): void {
		this._q = [];
		this.running = false;
		this.paused = true;
	}
}

/**
 * Adapt a Node-style last-argument-callback function into a
 * promise-returning wrapper. Calling Task does not run `task`; the
 * returned wrapper invokes it with the wrapper's own arguments followed
 * by a callback whose `(value, err)` pair decides resolution/rejection.
 *
 * @param {(...args: any[]) => void} task - The function to wrap.
 * @param {any[]} args - Dead parameter, kept for signature compatibility;
 *   never used.
 * @param {unknown} context - The `this` value for the task invocation;
 *   when falsy the wrapper's own `this` is used.
 * @returns {(...cbArgs: any[]) => Promise<unknown>} The promise-returning
 *   wrapper.
 */
export function Task(
	task: (...args: any[]) => void,
	args: any[] = [],
	context?: unknown,
): (...cbArgs: any[]) => Promise<unknown> {
	return function (this: unknown, ...cbArgs: any[]) {
		return new Promise((resolve, reject) => {
			cbArgs.push((value: unknown, err: unknown) => {
				if (!value && err) {
					reject(err);
				} else {
					resolve(value);
				}
			});
			task.apply(context || this, cbArgs);
		});
	};
}

export default Queue;
