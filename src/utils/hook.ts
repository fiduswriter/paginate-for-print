/**
 * A task function registered on a {@link Hook}. It receives the hook's
 * argument list positionally and may return anything. When run through
 * {@link Hook.trigger}, a truthy return value with a `then` function is
 * awaited as a promise-like; every other return value is passed through
 * as-is. {@link Hook.triggerSync} always passes the raw return value through.
 */
export type HookFunction<TArgs extends unknown[] = any[]> = (
	...args: TArgs
) => unknown;

/**
 * An ordered registry of task functions sharing a single execution context.
 *
 * Tasks are appended with {@link register} and run in registration order,
 * either concurrently through {@link trigger} (which awaits promise-like
 * results) or synchronously through {@link triggerSync} (which returns raw
 * return values). The registry itself is exposed live via {@link hooks} and
 * {@link list}, so it can also be mutated directly.
 */
export class Hook<TArgs extends unknown[] = any[]> {
	/**
	 * The object tasks are invoked with as `this`. Set to the constructor
	 * argument when that argument is truthy, otherwise to the hook instance
	 * itself (`||` semantics, so `0`, `""`, `false` and `null` all fall back).
	 * Consulted fresh on every run and freely reassignable.
	 */
	context: unknown;

	/**
	 * The registry array, live and writable: pushing, splicing or assigning
	 * entries here changes what subsequent runs execute.
	 */
	hooks: Array<HookFunction<TArgs>>;

	/**
	 * Creates a hook bound to `context`. A falsy context (including an
	 * omitted one) falls back to the new hook instance itself.
	 */
	constructor(context?: unknown) {
		this.context = context || this;
		this.hooks = [];
	}

	/**
	 * Appends tasks to the registry in argument order. Each argument is
	 * either a function (appended verbatim; duplicates are not removed) or
	 * an array-like collection, which is unpacked one level: its elements at
	 * indices `0 .. length-1` are appended, nested arrays included verbatim.
	 * A string is therefore unpacked by character, while values without a
	 * numeric `length` are silently ignored.
	 */
	register(...fns: Array<HookFunction<TArgs> | Array<HookFunction<TArgs>>>): void {
		for (const fn of fns) {
			if (typeof fn === "function") {
				this.hooks.push(fn);
			} else {
				for (let j = 0; j < fn.length; j++) {
					this.hooks.push(fn[j]);
				}
			}
		}
	}

	/**
	 * Runs every registered task and returns a promise for their results.
	 *
	 * All tasks are invoked synchronously inside this call, in registration
	 * order, with `this` bound to the context the hook held when the run
	 * started and the given arguments passed positionally. A truthy return
	 * value with a `then` function is awaited as a promise-like; anything
	 * else resolves to itself. The returned promise (a `Promise.all` over
	 * the collected values) resolves with the settled results in
	 * registration order and rejects with the first rejection in time. A
	 * task throwing synchronously propagates that exception out of this
	 * call itself, so no promise is returned in that case.
	 */
	trigger(...args: TArgs): Promise<unknown[]> {
		const promises: Array<Promise<unknown>> = [];
		const context = this.context;

		this.hooks.forEach((task) => {
			const result: unknown = task.apply(context, args);

			if (result && typeof (result as { then?: unknown }).then === "function") {
				promises.push(result as Promise<unknown>);
			} else {
				promises.push(Promise.resolve(result));
			}
		});

		return Promise.all(promises);
	}

	/**
	 * Runs every registered task synchronously, in registration order, with
	 * `this` bound to the context the hook held when the run started and the
	 * given arguments passed positionally, and returns their raw return
	 * values — promise objects are NOT awaited or unwrapped. A task throwing
	 * synchronously propagates that exception out of this call, skipping
	 * remaining tasks.
	 */
	triggerSync(...args: TArgs): unknown[] {
		const results: unknown[] = [];
		const context = this.context;

		this.hooks.forEach((task) => {
			results.push(task.apply(context, args));
		});

		return results;
	}

	/**
	 * Returns the registry array itself — the live internal reference, not a
	 * copy. Mutating the returned array mutates the hook's registry.
	 */
	list(): Array<HookFunction<TArgs>> {
		return this.hooks;
	}

	/**
	 * Replaces the registry with a fresh empty array (the previous array is
	 * abandoned, not emptied) and returns that new empty array.
	 */
	clear(): Array<HookFunction<TArgs>> {
		this.hooks = [];
		return this.hooks;
	}
}

export default Hook;
