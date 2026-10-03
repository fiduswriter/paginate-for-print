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
import { type EmitMetadata, type EmitOptions } from "pages-to-pdf";
export { printHTML, type PrintHTMLConfig, } from "./print.js";
export { paginateForPrintEngine } from "./engine.js";
export type { PaginateConfig, PaginatedWindow, PrintEngine, } from "./engine.js";
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
export declare function renderHTML(html: string, container: HTMLElement, options?: RenderHTMLOptions): Promise<HTMLIFrameElement>;
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
export declare function htmlToPDF(html: string, options?: HtmlToPDFOptions): Promise<Uint8Array>;
//# sourceMappingURL=paged.d.ts.map