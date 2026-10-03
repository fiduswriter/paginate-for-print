/**
 * Paged-media handler registry: the fifteen behavior handlers polyfilling
 * browser print/pagination CSS — print media adjustments, `@page` rules,
 * break rules, splits, box decoration, counters, lists, fixed positioning,
 * page counters, `nth-of-type` fixes, following-page selection, footnotes,
 * page floats, multi-column layout and initial letters — as a single ordered
 * array of class references (classes, not instances; instantiation happens per
 * `Handlers` construction in `src/utils/handlers.ts`, which spreads this array
 * as the FIRST group of `registeredHandlers`, ahead of the generated-content
 * and filters groups).
 *
 * The order is the entire behavioral payload: it fixes instantiation order and
 * the cross-handler hook-callback order within the group and relative to every
 * other handler in the engine (onDeclaration: PrintMedia → AtPage → Breaks →
 * Splits → BoxDecoration → Counters → Lists → PositionFixed →
 * PageCounterIncrement → NthOfType → Following → Footnotes → PageFloats →
 * Columns → InitialLetter). Do not reorder.
 *
 * The entries are the exact class objects imported from the sibling modules
 * (reference-identical aliases, no wrapping or copying). The array is built
 * once at module evaluation and exported directly — not frozen, sealed or
 * defensively copied — so it is shared module state; the sole consumer spreads
 * it into a fresh array, so registry mutations never reach this array. The
 * `Handler` import is type-only (erased at compile time): the entries are
 * genuine Handler subclasses, but this module adds no runtime dependency edge
 * on `../handler.js` — the base class is loaded transitively through the
 * sibling modules.
 */
import type Handler from "../handler.js";
import AtPage from "./atpage.js";
import Breaks from "./breaks.js";
import BoxDecoration from "./box-decoration.js";
import PrintMedia from "./print-media.js";
import Splits from "./splits.js";
import Counters from "./counters.js";
import Lists from "./lists.js";
import PositionFixed from "./position-fixed.js";
import PageCounterIncrement from "./page-counter-increment.js";
import NthOfType from "./nth-of-type.js";
import Following from "./following.js";
import Footnotes from "./footnotes.js";
import PageFloats from "./page-floats.js";
import Columns from "./columns.js";
import InitialLetter from "./initial-letter.js";

const handlers: Array<typeof Handler> = [
	PrintMedia,
	AtPage,
	Breaks,
	Splits,
	BoxDecoration,
	Counters,
	Lists,
	PositionFixed,
	PageCounterIncrement,
	NthOfType,
	Following,
	Footnotes,
	PageFloats,
	Columns,
	InitialLetter,
];

export default handlers;
