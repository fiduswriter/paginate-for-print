/**
 * Vivliostyle-print-compatible print entry point.
 *
 * Mirrors the API documented in the vivliostyle-print README:
 *
 * ```ts
 * import { printHTML } from "paginate-for-print";
 *
 * printHTML(htmlDoc, {
 *     title: "my printed page",
 *     printCallback: (iframeWin) => iframeWin.print(), // optional
 *     errorCallback: (message) => alert(message),      // optional
 * });
 * ```
 *
 * Instead of vivliostyle's layout engine, the given document is paginated
 * by paginate-for-print inside a hidden same-origin iframe that loads this library's
 * polyfill bundle. When pagination has finished, `printCallback` receives
 * the iframe window (for e.g. htmlToPDF); without a
 * callback the iframe prints directly and is removed.
 */
export interface PrintHTMLConfig {
    /** Document title, applied to the paginated iframe document. */
    title?: string;
    /**
     * Called with the iframe window once pagination has completed. Call
     * `iframeWin.print()` (or hand the window to
     * `htmlToPDF`) as needed. When omitted, printing
     * happens automatically.
     */
    printCallback?: (win: Window) => void;
    /** Called with a message when something goes wrong. */
    errorCallback?: (message: string) => void;
    /**
     * URL of the paginate-for-print polyfill bundle (`dist/paginate.polyfill.js`) to
     * load inside the iframe. Defaults to a URL relative to this bundle,
     * which works when dist/ output is served as-is.
     */
    polyfillURL?: string;
    /** Extra Previewer settings (textMeasurement etc.). */
    settings?: Record<string, unknown>;
    /**
     * Keep the iframe in the document after pagination finishes. Set this
     * when the printCallback hands the window to an async consumer such
     * as htmlToPDF; remove it yourself afterwards.
     */
    keepIframe?: boolean;
    /**
     * When provided, the paginated iframe is rendered visibly inside this
     * element instead of being hidden. The iframe is sized to fill the
     * container so full pages are visible. This implies `keepIframe: true`
     * and overrides the default hidden styles.
     */
    renderTo?: HTMLElement;
}
declare global {
    interface Window {
        __PAGED_PRINT_ACTIVE?: boolean;
        __PAGED_RENDER_DONE?: boolean;
        /** Directory URL of the polyfill bundle, for font/asset resolution. */
        __PAGED_BUNDLE_BASE?: string;
    }
}
export declare function printHTML(html: string, config?: PrintHTMLConfig): Promise<HTMLIFrameElement>;
//# sourceMappingURL=print.d.ts.map