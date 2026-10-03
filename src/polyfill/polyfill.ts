/**
 * Auto-polyfill entry point.
 *
 * This is the browser-entry "polyfill" script: on evaluation it publishes the
 * library's API namespace as `window.Paged`, snapshots the user configuration
 * from `window.PagedConfig` (read once), constructs the single
 * {@link Previewer} instance with the user's `settings`, publishes it as
 * `window.PagedPolyfill` and as this module's default export, and — once the
 * document reaches the "interactive" ready state (or immediately when the
 * script is evaluated while already interactive/complete) — runs the optional
 * `before` hook, auto-runs `previewer.preview(content, stylesheets, renderTo)`
 * unless `auto` is exactly `false`, and runs the optional `after` hook with
 * the preview result.
 *
 * There is deliberately no error handling anywhere in the chain: a throwing
 * `before` hook aborts the whole chain (neither preview nor `after` run), a
 * rejected preview skips `after`, and every failure surfaces as an unhandled
 * promise rejection.
 */
import Previewer from "./previewer.js";
import * as Paged from "../index.js";

declare global {
	interface Window {
		Paged: typeof Paged;
		PagedPolyfill: Previewer;
		PagedConfig?: PagedConfig;
	}
}

/**
 * User configuration read once from `window.PagedConfig` at script
 * evaluation.
 *
 * - `auto` — only the exact value `false` disables the automatic preview; any
 *   other value (absent, `undefined`, `0`, ...) auto-runs it.
 * - `before` — optional hook awaited before the auto preview; receives no
 *   arguments, its return value is discarded.
 * - `after` — optional hook awaited after the auto preview; receives the
 *   preview's resolved value, or `undefined` when the preview did not run.
 * - `content` / `stylesheets` / `renderTo` — forwarded verbatim, positionally
 *   in that order, to `previewer.preview(...)`.
 * - `settings` — consumed only as the `Previewer` constructor argument; it is
 *   not forwarded to `preview(...)`.
 */
export interface PagedConfig {
	auto?: boolean;
	before?: () => void | Promise<void>;
	after?: (result?: unknown) => void | Promise<void>;
	content?: string | HTMLElement;
	stylesheets?: Array<string | Record<string, string> | undefined>;
	renderTo?: string | HTMLElement;
	settings?: Record<string, unknown>;
}

// Publish the library's full API namespace synchronously, for debugging and
// for external scripts.
window.Paged = Paged;

/**
 * Promise of the document's ready-state string, settling at the
 * DOMContentLoaded-equivalent point. When the document is still loading, a
 * handler is installed on `document.onreadystatechange` (direct property
 * assignment, overwriting any pre-existing host handler) that resolves the
 * promise — with `"interactive"` — at the "interactive" transition; a later
 * "complete" transition fires the handler again but has no effect. When the
 * document is already interactive or complete, the promise resolves
 * immediately with the current ready state and no handler is installed. The
 * promise never rejects.
 */
const ready: Promise<string> = new Promise<string>((resolve) => {
	if (
		document.readyState === "interactive" ||
		document.readyState === "complete"
	) {
		resolve(document.readyState);
	} else {
		document.onreadystatechange = () => {
			if (document.readyState === "interactive") {
				resolve("interactive");
			}
		};
	}
});

// The user's configuration, read exactly once here: when `window.PagedConfig`
// is truthy, `config` IS that object (by reference — no copying, merging,
// validation or mutation); otherwise a fresh default object is used.
const config: PagedConfig = window.PagedConfig || { auto: true };

// The single previewer instance for this script load, constructed with the
// user's settings (possibly `undefined`).
const previewer: Previewer = new Previewer(config.settings);

// The same instance is the module's default export ...
export default previewer;

// ... and is published on the window, so callers can drive previews manually
// or observe rendering events.
window.PagedPolyfill = previewer;

// The auto-run chain: await `before`, then auto-run the preview unless
// `auto` is exactly `false`, then await `after` with the preview result
// (`undefined` when the preview was skipped). No error handling: failures
// surface as unhandled promise rejections.
ready.then(async () => {
	if (config.before) {
		await config.before();
	}

	let done: unknown;

	if (config.auto !== false) {
		done = await previewer.preview(
			config.content,
			config.stylesheets,
			config.renderTo,
		);
	}

	if (config.after) {
		await config.after(done);
	}
});
