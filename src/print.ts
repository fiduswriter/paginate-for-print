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
	 * URL of the paginate-for-print polyfill bundle (`dist/paged.polyfill.js`) to
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

function defaultPolyfillURL(): string {
	for (const script of Array.from(document.querySelectorAll("script[src]"))) {
		const src = (script as HTMLScriptElement).src || "";
		if (/paged[^/]*\.js$/.test(src)) {
			return new URL("paged.polyfill.js", src).href;
		}
	}
	return new URL("paged.polyfill.js", window.location.href).href;
}

const PRINT_TIMEOUT_MS = 300000;

export function printHTML(
	html: string,
	config: PrintHTMLConfig = {},
): Promise<HTMLIFrameElement> {
	return new Promise<HTMLIFrameElement>((resolve) => {
		const iframe = document.createElement("iframe");
		const renderTo = config.renderTo;
		if (renderTo) {
			// Visible preview mode: fill the supplied container so full pages
			// can be seen.
			iframe.style.width = "100%";
			iframe.style.minHeight = "80vh";
			iframe.style.border = "0";
			iframe.style.display = "block";
		} else {
			// Hidden print mode: keep the iframe out of sight.
			iframe.style.position = "fixed";
			iframe.style.right = "0";
			iframe.style.bottom = "0";
			iframe.style.width = "1px";
			iframe.style.height = "1px";
			iframe.style.opacity = "0";
			iframe.style.border = "0";
		}

		let settled = false;

		const fail = (message: string) => {
			if (settled) return;
			settled = true;
			if (config.errorCallback) {
				config.errorCallback(message);
			} else {
				console.error("paginate-for-print printHTML:", message);
			}
			resolve(iframe);
		};

		// Strip every script from the source: the print frame paginates
		// with its own polyfill injection, and page scripts (analytics,
		// demo wiring, a nested polyfill tag) must not run here.
		const cleanMarkup = html.replace(
			/<script\b[\s\S]*?<\/script>/gi,
			"",
		);

		let markup = cleanMarkup;
		if (config.title && !/<title>/i.test(markup)) {
			markup = markup.replace(
				/(<head[^>]*>)/i,
				`$1<title>${config.title}</title>`,
			);
			if (!/<title>/i.test(markup)) {
				markup = `<title>${config.title}</title>` + markup;
			}
		}

		// Inject OUR polyfill loader (source scripts were stripped above)
		// and resolve the bundle base for the PDF emitter's fonts.
		const polyfillURL = new URL(
			config.polyfillURL || defaultPolyfillURL(),
			document.baseURI,
		).href;
		const bundleBase = new URL(".", polyfillURL).href;
		const polyfillTag = `<script src="${polyfillURL}"></script>`;

		const settingsJSON = JSON.stringify(config.settings || {});

		// Injected before the polyfill so it applies to the auto-started
		// preview. The `after` hook marks completion deterministically —
		// listening for the "rendered" event from outside races polyfill
		// startup.
		const bootstrap = `<script>window.__PAGED_PRINT_ACTIVE = true;
window.__PAGED_BUNDLE_BASE = ${JSON.stringify(bundleBase)};
window.PagedConfig = {
	auto: true,
	settings: ${settingsJSON},
	after: function () {
		window.__PAGED_RENDER_DONE = true;
	}
};</script>`;

		// srcdoc gives the frame a real parsed document whose relative
		// URLs resolve against this page — document.write into an
		// about:blank iframe breaks both.
		iframe.srcdoc =
			bootstrap +
			(markup.includes("</body>")
				? markup.replace("</body>", `${polyfillTag}</body>`)
				: markup + polyfillTag);

		iframe.onerror = () => fail("Print frame failed to load.");

		const startedAt = Date.now();
		const timer = window.setInterval(() => {
			const win = iframe.contentWindow;
			if (!win) {
				return;
			}
			if (
				Date.now() - startedAt > PRINT_TIMEOUT_MS
			) {
				window.clearInterval(timer);
				fail("Pagination did not complete in time.");
				return;
			}
			if (!(win as unknown as { __PAGED_PRINT_ACTIVE?: boolean }).__PAGED_PRINT_ACTIVE) {
				// Polyfill not yet executed; keep waiting.
				return;
			}
			if ((win as unknown as { __PAGED_RENDER_DONE?: boolean }).__PAGED_RENDER_DONE) {
				window.clearInterval(timer);
				settled = true;
				try {
					if (config.printCallback) {
						config.printCallback(win);
						resolve(iframe);
					} else {
						win.focus();
						win.print();
						resolve(iframe);
					}
					if (!config.keepIframe && !renderTo) {
						window.setTimeout(() => iframe.remove(), 0);
					}
				} catch (error) {
					fail(String(error));
				}
			}
		}, 100);

		if (renderTo) {
			renderTo.appendChild(iframe);
		} else {
			document.body.appendChild(iframe);
		}
	});
}
