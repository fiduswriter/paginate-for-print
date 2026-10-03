/**
 * Registry barrel for the engine's DOM filters.
 *
 * Collects the five filter classes — the small behavior modules that clean the
 * source document before/while it is chunked (whitespace-only text nodes,
 * HTML comments, script elements, style-related cleanup, undisplayed
 * `display: none` content) — into a single module-level array and exports
 * that array as the module's default export. No filtering is implemented
 * here; the sole responsibility of this module is the ordered assembly.
 *
 * The consumer is `src/utils/handlers.ts`, which spreads this array into the
 * global `registeredHandlers` list (after the paged-media and
 * generated-content registries). Every `Handlers` instance then instantiates
 * each filter class in registry order, so the order fixed below determines
 * the relative order in which the filters' hook callbacks run during every
 * pagination run. Reordering silently changes pagination output — do not
 * reorder.
 *
 * The module is deterministic and side-effect-free at import time apart from
 * constructing the array itself: no DOM access, no event emission, no
 * registration calls of its own.
 */
import type Handler from "../handler.js";
import WhiteSpaceFilter from "./whitespace.js";
import CommentsFilter from "./comments.js";
import ScriptsFilter from "./scripts.js";
import StylesFilter from "./styles.js";
import UndisplayedFilter from "./undisplayed.js";

/**
 * Ordered registry of the five filter classes, built once at module import
 * time as a fresh array literal, in behavioral order:
 * whitespace → comments → scripts → styles → undisplayed.
 *
 * The array is exported directly — not copied — so it is shared module state:
 * an importer mutating it (push/splice/pop) mutates every other importer's
 * view. The current consumer spreads it into a fresh array, so post-import
 * mutation does not change the global handler registry; the registry snapshot
 * is taken when `utils/handlers.ts` is loaded.
 *
 * The elements are the exact class objects imported from the sibling filter
 * modules (same module specifiers, same default-export bindings) — not
 * subclasses or wrappers. The `Handler` import is type-only: it is erased at
 * compile time and adds no runtime dependency on `modules/handler.js`.
 */
const handlers: Array<typeof Handler> = [
	WhiteSpaceFilter,
	CommentsFilter,
	ScriptsFilter,
	StylesFilter,
	UndisplayedFilter
];

export default handlers;
