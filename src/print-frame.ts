/**
 * Contract between `printHTML` and the polyfill bundle running inside the
 * hidden print iframe.
 *
 * Lives in its own module (no imports) so both the npm bundle
 * (`src/paginate.ts` → `src/print.ts`) and the standalone polyfill bundle
 * (`src/polyfill/polyfill.ts`, built separately into
 * `dist/paginate.polyfill.js`) can share the marker value and the init API
 * type without either entry pulling the other into its bundle.
 *
 * `printHTML` cannot pass the pagination configuration through an inline
 * script: the srcdoc document inherits the embedding page's content security
 * policy, so with a policy that lacks `script-src 'unsafe-inline'` an inline
 * bootstrap script never executes and pagination hangs until the timeout.
 * Instead the iframe is given a recognizable `name` (which srcdoc documents
 * inherit as `window.name`), the polyfill bundle defers its auto-run when it
 * sees that marker and publishes `window.PaginatePrint.init`, and the parent
 * page calls `init` with the configuration once the bundle has loaded.
 */

/**
 * Marker assigned to the print iframe's `name` attribute. The polyfill
 * defers auto-pagination when `window.name` equals this value.
 */
export const PRINT_FRAME_MARKER = "paginate-for-print-frame";

/**
 * Configuration accepted by `window.PaginatePrint.init`. Same shape as the
 * legacy `window.PaginateConfig` object the polyfill reads at evaluation.
 */
export interface PrintFrameConfig {
	auto?: boolean;
	before?: () => void | Promise<void>;
	after?: (result?: unknown) => void | Promise<void>;
	content?: string | HTMLElement;
	stylesheets?: Array<string | Record<string, string> | undefined>;
	renderTo?: string | HTMLElement;
	settings?: Record<string, unknown>;
}

declare global {
	interface Window {
		/**
		 * Present in print iframes once the polyfill bundle has loaded there.
		 * Calling `init` constructs the previewer with the given settings and
		 * runs the auto pagination chain exactly once; further calls are
		 * ignored.
		 */
		PaginatePrint?: {
			init: (config: PrintFrameConfig) => void;
		};
	}
}
