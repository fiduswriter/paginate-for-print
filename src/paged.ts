/**
 * Public paginate-for-print API.
 *
 * `paginate-for-print` exposes three helpers:
 *
 * 1. `printHTML(html, config)` — paginates `html` with paginate-for-print inside
 *    a hidden iframe and hands the window to `printCallback` (default: browser
 *    print dialog).
 *
 * 2. `renderHTML(html, container, options)` — paginates `html` and renders the
 *    result visibly inside `container`. No print dialog is opened.
 *
 * 3. `htmlToPDF(html, options)` — paginate and emit a real vector PDF in one
 *    call, with iframe cleanup handled internally.
 *
 * ```ts
 * import { htmlToPDF } from "paginate-for-print";
 *
 * const bytes = await htmlToPDF(htmlDoc, {
 *     title: "My document",
 *     metadata: { title: "My document" },
 * });
 * download(new Blob([bytes], { type: "application/pdf" }));
 * ```
 */
import {
	emitPdfFromWindow,
	PAGED_WITH_FLOATS_BACKEND,
	type EmitMetadata,
	type EmitOptions,
} from "pages-to-pdf";
import { printHTML } from "./print.js";

export {
	printHTML,
	type PrintHTMLConfig,
} from "./print.js";

export { paginateForPrintEngine } from "./engine.js";
export type {
	PaginateConfig,
	PaginatedWindow,
	PrintEngine,
} from "./engine.js";

/**
 * Options for {@link renderHTML}: pagination configuration for a visible
 * preview.
 */
export interface RenderHTMLOptions {
	/** Applied to the paginated iframe document. */
	title?: string;
	/** URL of the paginate-for-print polyfill bundle for the frame. */
	polyfillURL?: string;
	/** Extra Previewer settings (textMeasurement etc.). */
	settings?: Record<string, unknown>;
	/** Called with a message when something goes wrong. */
	errorCallback?: (message: string) => void;
}

/**
 * Paginates `html` with paginate-for-print and renders the result visibly
 * inside `container`. No print dialog is opened and the iframe stays in the
 * supplied container.
 *
 * @param html - A complete HTML document string.
 * @param container - The element that will hold the pagination iframe.
 * @param options - Pagination options.
 * @returns The pagination iframe.
 */
export async function renderHTML(
	html: string,
	container: HTMLElement,
	options: RenderHTMLOptions = {},
): Promise<HTMLIFrameElement> {
	return printHTML(html, {
		title: options.title,
		polyfillURL: options.polyfillURL,
		settings: options.settings,
		renderTo: container,
		errorCallback: options.errorCallback,
		printCallback: () => {
			// Visible preview: nothing to print.
		},
	});
}

/**
 * Options for {@link htmlToPDF}: pagination/print configuration combined
 * with the PDF emission extras.
 */
export interface HtmlToPDFOptions {
	/** Applied to the paginated iframe document and default PDF title. */
	title?: string;
	/** URL of the paginate-for-print polyfill bundle for the print frame. */
	polyfillURL?: string;
	/** Extra Previewer settings (textMeasurement etc.). */
	settings?: Record<string, unknown>;
	/** Source HTML embedded as a PDF file attachment when provided. */
	sourceHtml?: string;
	/** Document metadata (title/author/subject/keywords/language). */
	metadata?: EmitMetadata;
	/** Base URL for resolving fonts and assets in the paginated output. */
	baseUrl?: string;
	/** Where the WOFF2 decoder wasm lives (string URL or raw bytes). */
	woff2WasmUrl?: string | ArrayBuffer;
	/** Additional files to attach to the PDF. */
	attachments?: import("pages-to-pdf").EmitAttachment[];
	/** Print-level extras passed through to the emitter. */
	printOptions?: EmitOptions["printOptions"];
	/** Optional status callback for emission progress. */
	onProgress?: (message: string) => void;
}

/**
 * Paginates `html` with paginate-for-print and returns real vector PDF bytes —
 * no print dialog involved.
 *
 * @param html - A complete HTML document string.
 * @param options - Pagination and emission options.
 * @returns The PDF file bytes.
 */
export async function htmlToPDF(
	html: string,
	options: HtmlToPDFOptions = {},
): Promise<Uint8Array> {
	const emitOptions: EmitOptions = {
		sourceHtml: options.sourceHtml ?? html,
		metadata: {
			title: options.title,
			...(options.metadata || {}),
		},
		baseUrl: options.baseUrl,
		woff2WasmUrl: options.woff2WasmUrl,
		attachments: options.attachments,
		printOptions: options.printOptions,
		onProgress: options.onProgress,
		backend: PAGED_WITH_FLOATS_BACKEND,
	};

	const iframe: HTMLIFrameElement = await printHTML(html, {
		title: options.title,
		polyfillURL: options.polyfillURL,
		settings: options.settings,
		keepIframe: true,
		printCallback: () => {
			// htmlToPDF emits the PDF programmatically; do not open the browser
			// print dialog.
		},
		errorCallback: (message: string) => {
			throw new Error(message);
		},
	});
	try {
		const win = iframe.contentWindow!;
		return await emitPdfFromWindow(win, emitOptions);
	} finally {
		// Give microtasks spawned by emission a tick to unwind before the
		// window they measured against disappears.
		window.setTimeout(() => iframe.remove(), 0);
	}
}
