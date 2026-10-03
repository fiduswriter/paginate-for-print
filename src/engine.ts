import type { BackendConfig } from "pages-to-pdf";

import { PAGED_WITH_FLOATS_BACKEND } from "pages-to-pdf";
import { printHTML } from "./print.js";

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

/**
 * Firefox has issues printing images that are located in an iframe. As a
 * workaround, the paginated body is swapped into the main document, the main
 * window prints, and the original body is restored afterwards. This
 * workaround can be removed once that browser bug has been fixed.
 */
function printViaBodySwap(win: Window): void {
	const oldBody = document.body;
	document.body.parentElement!.dataset.printPaginated = "true";
	document.body = win.document.body;
	// Data attributes that trigger editor-specific styling in the main
	// document's CSS must not affect the swapped-in print content.
	document.body
		.querySelectorAll("figure, table")
		.forEach(el => delete (el as HTMLElement).dataset.category);
	win.document
		.querySelectorAll("style")
		.forEach(el => document.body.appendChild(el));
	const backgroundStyle = document.createElement("style");
	backgroundStyle.innerHTML = "body {background-color: white;}";
	document.body.appendChild(backgroundStyle);
	window.print();
	document.body = oldBody;
	delete document.body.parentElement!.dataset.printPaginated;
}

function isFirefox(): boolean {
	return navigator.userAgent.includes("Gecko/");
}

async function preparePagination(
	config: PaginateConfig,
): Promise<PaginatedWindow> {
	return new Promise((resolve, reject) => {
		let failed = false;
		void printHTML(config.html, {
			title: config.title,
			polyfillURL: config.polyfillURL,
			errorCallback: (message) => {
				failed = true;
				config.errorCallback?.(message);
				reject(new Error(message));
			},
			keepIframe: true,
		}).then((iframe) => {
			if (failed) {
				// The promise has already been rejected via errorCallback.
				return;
			}
			resolve({
				win: iframe.contentWindow!,
				cleanup: () => iframe.remove(),
			});
		});
	});
}

async function print(config: PaginateConfig): Promise<void> {
	if (isFirefox()) {
		await printHTML(config.html, {
			title: config.title,
			polyfillURL: config.polyfillURL,
			errorCallback: config.errorCallback,
			printCallback: printViaBodySwap,
		});
		return;
	}
	// Without a printCallback, paginate-for-print prints the paginated
	// iframe directly and removes it afterwards.
	await printHTML(config.html, {
		title: config.title,
		polyfillURL: config.polyfillURL,
		errorCallback: config.errorCallback,
	});
}

export const paginateForPrintEngine: PrintEngine = {
	name: "paginate-for-print",
	preparePagination,
	print,
	backend: PAGED_WITH_FLOATS_BACKEND,
};
