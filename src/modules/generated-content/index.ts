import type Handler from "../handler.js";
import Leader from "./leader.js";
import RunningHeaders from "./running-headers.js";
import StringSets from "./string-sets.js";
import TargetCounters from "./target-counters.js";
import TargetText from "./target-text.js";

/**
 * Generated-content handler registry: the five behavior handlers polyfilling
 * CSS generated content — `leader()`, running headers (`running()` elements),
 * `string-set`, `target-counter` and `target-text` — as a single ordered
 * array of class references (classes, not instances; instantiation happens
 * per `Handlers` construction in `src/utils/handlers.ts`, which spreads this
 * array into the middle group of `registeredHandlers`, between the paged-media
 * and filters groups).
 *
 * The order is the entire behavioral payload: it fixes instantiation order and
 * the cross-handler hook-callback order within the group (onDeclaration:
 * Leader → RunningHeaders → StringSets; afterParsed: RunningHeaders →
 * TargetText; afterPageLayout: RunningHeaders → StringSets → TargetCounters).
 * Do not reorder.
 *
 * The entries are the exact class objects imported from the sibling modules
 * (reference-identical aliases, no wrapping or copying). The array is built
 * once at module evaluation and exported directly — not frozen, sealed or
 * defensively copied — so it is shared module state; the sole consumer spreads
 * it into a fresh array. The `Handler` import is type-only (erased at compile
 * time): the entries are genuine Handler subclasses, but this module adds no
 * runtime dependency edge on `../handler.js` — the base class is loaded
 * transitively through the sibling modules.
 */
export default [
	Leader,
	RunningHeaders,
	StringSets,
	TargetCounters,
	TargetText
] as Array<typeof Handler>;
