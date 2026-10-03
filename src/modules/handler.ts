/**
 * Handler base class: the common superclass of every behavior module of the
 * engine (paged-media polyfills, generated-content modules, DOM filters).
 *
 * A Handler is constructed with the three engine objects — chunker, polisher
 * and caller — each of which may expose a `hooks` map (hook name to Hook
 * instance). The constructor merges those maps (later sources win on name
 * collisions) and, for every hook name for which the instance — including its
 * whole prototype chain — has a same-named member, registers that member,
 * bound to the instance, as a task on the corresponding hook. A module
 * "subscribes" to a lifecycle hook simply by declaring a method with the
 * hook's name; there is no declarative registration API and no unsubscribe.
 *
 * At import time this module installs the four event-emitter methods
 * (`on`, `once`, `off`, `emit`) onto `Handler.prototype`, so every handler
 * instance is a small event emitter without further setup.
 */
import EventEmitter from "event-emitter";
import type { Hook } from "../utils/hook.js";
import type { PagedEventEmitter } from "../types/emitter.js";

/** A map of hook names to Hook instances, as exposed by chunker/polisher/previewer. */
export type HooksMap = Record<string, Hook<any[]>>;

/**
 * The minimal shape the base class requires of each of its three constructor
 * arguments: optionally a `hooks` map. Modules that need more from a source
 * declare their own extended interfaces starting from this one.
 */
export interface HandlerSource {
	hooks?: HooksMap;
}

/**
 * Base class of all behavior modules. Merges the hooks maps of its three
 * constructor arguments (chunker, polisher, caller; later sources win on name
 * collisions) and registers each instance member whose name matches a merged
 * hook name as a bound callback on that hook.
 */
class Handler {
	// Escape hatch letting subclasses and external code read/write arbitrary
	// properties on instances without casts. Type-level only.
	[key: string]: any;

	chunker?: HandlerSource | null;
	polisher?: HandlerSource | null;
	caller?: HandlerSource | null;

	/**
	 * Wires the handler against the engine objects.
	 *
	 * Performs, in order: (1) merges the sources' hooks maps into a fresh
	 * snapshot object (chunker → polisher → caller, later wins on collision,
	 * falsy sources and falsy/primitive hooks values contribute nothing);
	 * (2) stores the three arguments verbatim on the instance — before the
	 * registration loop, whose membership test consults these fields;
	 * (3) for every merged hook name that is present on the instance (full
	 * prototype-chain `in` test), registers the same-named member, bound to
	 * the instance, on that hook. Registrations performed before an error
	 * are not rolled back; there is no teardown or unsubscribe.
	 * @param {HandlerSource} chunker - The chunker, exposing lifecycle hooks.
	 * @param {HandlerSource} polisher - The polisher, exposing CSS hooks.
	 * @param {HandlerSource} caller - The caller (previewer), exposing
	 * preview hooks.
	 */
	constructor(chunker?: HandlerSource, polisher?: HandlerSource, caller?: HandlerSource) {
		// Merge the hooks maps into a snapshot. Object.assign contributes
		// nothing for undefined/null/primitive hooks values (no own
		// enumerable string-keyed properties) and preserves the insertion
		// position of overridden keys.
		const merged: HooksMap = {};
		for (const source of [chunker, polisher, caller]) {
			if (!source) {
				continue;
			}
			Object.assign(merged, source.hooks);
		}

		// Store the arguments verbatim, in order, BEFORE registering: a hook
		// named like a source field must find the field already assigned.
		this.chunker = chunker;
		this.polisher = polisher;
		this.caller = caller;

		// Auto-register: every merged hook name that matches an instance
		// member (own or inherited) gets that member, bound to the instance,
		// appended to the hook's task registry. Instance fields assigned
		// after this constructor returns (subclass field initializers) are
		// never seen by this loop.
		for (const name in merged) {
			if (!(name in this)) {
				continue;
			}
			merged[name].register(this[name].bind(this));
		}
	}
}

// The emitter methods exist at runtime through this import-time prototype
// mutation; the interface merge below only supplies the types.
interface Handler extends PagedEventEmitter {}

// Install on/once/off/emit onto Handler.prototype (non-enumerable, writable,
// configurable) so that every handler — and every subclass instance — is an
// event emitter without further setup. Applied once, at module evaluation.
EventEmitter(Handler.prototype);

export default Handler;
