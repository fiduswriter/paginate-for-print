import EventEmitter from "event-emitter";
import pipe from "event-emitter/pipe.js";
import pagedMediaHandlers from "../modules/paged-media/index.js";
import generatedContentHandlers from "../modules/generated-content/index.js";
import filters from "../modules/filters/index.js";
import type Handler from "../modules/handler.js";
import type { PagedEventEmitter } from "../types/emitter.js";

/**
 * Array of all registered handler classes. Initialized at module load with the
 * ordered contents of the paged-media, generated-content and filters module
 * registries; extended at runtime via registerHandlers. This is shared,
 * module-level state: every mutation (via registerHandlers or direct array
 * manipulation by any importer) is globally visible and affects every
 * subsequent Handlers construction.
 */
export let registeredHandlers: Array<typeof Handler> = [
	...pagedMediaHandlers,
	...generatedContentHandlers,
	...filters,
];

/**
 * Class responsible for instantiating and managing handler instances.
 * Emits events from all handlers through itself.
 *
 * The event-emitter methods (on, once, off, emit) are mixed into the
 * prototype at import time, so every instance acts as an event hub
 * collecting the events emitted by its handler instances.
 */
export class Handlers {
	handlers: Handler[];

	/**
	 * Instantiates every currently registered handler class with the given
	 * engine objects, in registry order, and pipes each handler instance's
	 * events into this instance. Construction is synchronous; if a handler
	 * constructor throws, the exception propagates without rollback.
	 * @param {Object} chunker - The chunker object to pass to handlers.
	 * @param {Object} polisher - The polisher object to pass to handlers.
	 * @param {Object} caller - The caller object to pass to handlers.
	 */
	constructor(chunker: object, polisher: object, caller: object) {
		this.handlers = [];
		for (const HandlerClass of registeredHandlers) {
			const handler = new HandlerClass(chunker, polisher, caller);
			this.handlers.push(handler);
			pipe(handler, this);
		}
	}
}

export interface Handlers extends PagedEventEmitter {}

/**
 * Adds new handler classes to the end of the list of registered handlers.
 * Mutates the shared registry in place; already-constructed Handlers
 * instances are unaffected.
 * @param {...typeof Handler} handlers - One or more handler classes to register.
 */
export function registerHandlers(...handlers: Array<typeof Handler>): void {
	registeredHandlers.push(...handlers);
}

/**
 * Creates and initializes a new Handlers instance.
 * @param {Object} chunker - The chunker object to pass to handlers.
 * @param {Object} polisher - The polisher object to pass to handlers.
 * @param {Object} caller - The caller object to pass to handlers.
 * @returns {Handlers} The initialized Handlers instance.
 */
export function initializeHandlers(
	chunker: object,
	polisher: object,
	caller: object,
): Handlers {
	return new Handlers(chunker, polisher, caller);
}

// Mix event emitter methods (on, once, off, emit) into Handlers.prototype so
// that every instance is an emitter without further setup.
EventEmitter(Handlers.prototype);
