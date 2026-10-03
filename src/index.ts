/**
 * Public API barrel — src/index.ts.
 *
 * This module holds no logic: it exists only to re-export, under a single
 * namespace, the classes, registry functions and values that third parties
 * (and the polyfill bundle) may touch. The polyfill assigns this whole
 * namespace to `window.Paged`, so the export list below is the library's
 * public browser API surface: do not add, rename, or drop exports, and keep
 * the three type-only exports type-only (they must not appear at runtime).
 *
 * Importing this module evaluates the sibling modules in the order imported
 * here. The observable load-time effects are those of the siblings: the
 * handler registry being seeded, the event-emitter methods being mixed into
 * the `Handlers` prototype, and the print-engine constant being created.
 */

export { default as Chunker } from "./chunker/chunker.js";

export { default as Polisher } from "./polisher/polisher.js";

export { default as Previewer } from "./polyfill/previewer.js";

export { default as Handler } from "./modules/handler.js";

export {
	registeredHandlers,
	registerHandlers,
	initializeHandlers
} from "./utils/handlers.js";

export { pagedWithFloatsEngine } from "./engine.js";
export type {
	PaginateConfig,
	PaginatedWindow,
	PrintEngine
} from "./engine.js";
