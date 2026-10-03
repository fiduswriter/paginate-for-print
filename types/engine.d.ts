import type { BackendConfig } from "pages-to-pdf";
/**
 * Print engine adapter for pagination engine registries such as
 * `registerPrintEngine` from `@fiduswriter/document/exporter/print`.
 *
 * The object below is structurally compatible with the `PrintEngine`
 * interface defined by `@fiduswriter/document` without importing from it, so
 * the two pagination packages (`paginate-for-print` and `vivliostyle-pdf`)
 * expose equivalent engine objects that host applications can register.
 */
export interface PaginateConfig {
    /** The complete HTML document to paginate. */
    html: string;
    /** Document title, applied to the paginated iframe. */
    title?: string;
    /** Called with a message when pagination fails. */
    errorCallback?: (message: string) => void;
    /**
     * URL of the polyfill bundle (`dist/paged.polyfill.js`) to load inside
     * the print iframe. Engines that paginate with a script bundle loaded by
     * URL honor this setting; hosts that serve the bundle from their own
     * static files pass its URL here. When omitted, a URL relative to the
     * loaded bundle is used.
     */
    polyfillURL?: string;
}
/** A paginated document living in a hidden iframe. */
export interface PaginatedWindow {
    /** The iframe window holding the paginated DOM. */
    win: Window;
    /** Remove the iframe from the DOM once it is no longer needed. */
    cleanup: () => void;
}
/**
 * A pagination engine: renders the paginated output used by the browser
 * print dialog and describes its page structure to the DOM-to-PDF emitter
 * through the `backend` configuration.
 */
export interface PrintEngine {
    /** Identifier used by host applications to select the engine. */
    name: string;
    /**
     * Paginate the given HTML in a hidden iframe and hand back the iframe
     * window without opening a print dialog. The caller must invoke
     * `cleanup()` when it is done with the window.
     */
    preparePagination(config: PaginateConfig): Promise<PaginatedWindow>;
    /**
     * Paginate the given HTML and open the browser print dialog. Resolves
     * once the document has been handed to the browser.
     */
    print(config: PaginateConfig): Promise<void>;
    /** DOM-to-PDF emitter configuration matching this engine's output. */
    backend: BackendConfig;
}
export declare const paginateForPrintEngine: PrintEngine;
//# sourceMappingURL=engine.d.ts.map