/**
 * Shared demo helpers.
 *
 * - Injects `content-visibility: auto` for rendered pages so appending
 *   page N does not re-layout pages 1..N-1 — long books stay interactive
 *   while paginating. The library forces the page currently being laid
 *   out back to visible (inline style + data-paged-active), so this is
 *   purely an optimization for finished pages.
 * - `DemoUI.addDownloadButton()`: adds a fixed "Download PDF" button that
 *   paginates this page's source in a hidden frame and saves a real
 *   vector PDF (via dist/paged.pdf.js).
 * - `DemoUI.addMeasurementSelect()`: lets the user switch between the
 *   library's text-measurement backends (dom / pretext / fast). The chosen
 *   mode is persisted in the URL query string and used for both on-screen
 *   pagination and PDF export.
 * - `DemoUI.addColumnSelect()`: lets the user override the number of
 *   columns a page's root flow uses (persisted via `?columns=<n>`). The
 *   override is injected as a `body { column-count }` rule, which the
 *   polisher picks up exactly like author CSS — including the single-column
 *   case, where the rule's count of 1 disables root-level multicol.
 */
(() => {
	const style = document.createElement("style");
	style.textContent =
		".paged_page{content-visibility:auto;contain-intrinsic-size:auto 1400px;}" +
		".paged_page[data-paged-active]{content-visibility:visible;}";
	document.head.appendChild(style);

	// Honor an explicit ?columns= override on the live document: the injected
	// body rule is processed by the polisher like any author CSS (captured as
	// root-level columns; count 1 disables multicol). !important wins the
	// capture over the author's own declaration regardless of sheet order.
	const COLUMN_OVERRIDE_ID = "paged-demo-columns";
	const initialColumns = new URLSearchParams(location.search).get("columns");
	if (initialColumns !== null) {
		const override = document.createElement("style");
		override.id = COLUMN_OVERRIDE_ID;
		override.textContent =
			"body{column-count:" + initialColumns + " !important}";
		document.head.appendChild(override);
	}

	const POLYFILL_TAG_RE =
		/<script[^>]+src="[^"]*paged\.polyfill\.js"[^>]*>\s*<\/script>\s*/gi;

	async function getSource() {
		if (window.__DEMO_SOURCE) {
			return window.__DEMO_SOURCE;
		}
		// Fetch the original file: serializing the live DOM would capture
		// the paginator's generated page structure instead of the source.
		const response = await fetch(location.href);
		let text = await response.text();
		// The hidden print frame loads the polyfill itself.
		text = text.replace(POLYFILL_TAG_RE, "");
		window.__DEMO_SOURCE = text;
		return text;
	}

	function ensureToolbar() {
		let bar = document.getElementById("paged-demo-toolbar");
		if (!bar) {
			bar = document.createElement("div");
			bar.id = "paged-demo-toolbar";
			bar.style.cssText =
				"position:fixed;top:12px;right:12px;z-index:9999;display:flex;gap:8px;" +
				"font-family:system-ui,sans-serif;";
			document.body.appendChild(bar);
		}
		return bar;
	}

	function makeButton(label) {
		const b = document.createElement("button");
		b.textContent = label;
		b.style.cssText =
			"padding:8px 14px;border:1px solid #333;border-radius:6px;background:#fff;" +
			"cursor:pointer;font-size:14px;box-shadow:0 1px 4px rgba(0,0,0,.25);";
		return b;
	}

	function saveBytes(bytes, filename) {
		const blob = new Blob([bytes], { type: "application/pdf" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = filename;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 5000);
	}

	/**
	 * Paginates arbitrary source HTML in a hidden frame and returns real
	 * vector PDF bytes.
	 */
	function bundleBase() {
		const tag = document.querySelector('script[src*="paged.polyfill"]');
		if (tag) {
			return new URL(".", tag.src).href;
		}
		return new URL("./", location.href).href;
	}

	/**
	 * Read the measurement mode from the URL query string.
	 * @returns {"dom" | "pretext" | "fast"}
	 */
	function getSelectedMeasurement() {
		const params = new URLSearchParams(location.search);
		const mode = params.get("measurement");
		if (mode === "pretext" || mode === "fast") {
			return mode;
		}
		return "dom";
	}

	/**
	 * Convert a measurement mode into the Previewer settings object used by
	 * both on-screen pagination and PDF export.
	 *
	 * - "dom": legacy DOM-walking measurement (default).
	 * - "pretext": canvas/Intl-predicted breaks with DOM verification.
	 * - "fast": pretext predicted breaks without per-break verification.
	 */
	function getMeasurementSettings(mode = getSelectedMeasurement()) {
		if (mode === "fast") {
			return { textMeasurement: "pretext", verifyTextPrediction: false };
		}
		if (mode === "pretext") {
			return { textMeasurement: "pretext" };
		}
		return { textMeasurement: "dom" };
	}

	/**
	 * Read the column-count override from the URL query string.
	 * @returns {{ count: number, explicit: boolean }} The requested column
	 * count (1–4) and whether it came from an explicit `?columns=` param.
	 */
	function getColumnSelection() {
		const params = new URLSearchParams(location.search);
		const raw = params.get("columns");
		if (raw !== null) {
			const n = parseInt(raw, 10);
			if (Number.isFinite(n) && n >= 1 && n <= 4) {
				return { count: n, explicit: true };
			}
		}
		return { count: 2, explicit: false };
	}

	/**
	 * Injects a `body { column-count }` override into source HTML so the
	 * polisher treats it exactly like author CSS (the Columns handler
	 * captures it as root-level configuration; a count of 1 disables
	 * multicol). Used both for the live document (before the polyfill runs)
	 * and for the hidden print frame's copy of the source.
	 */
	function withColumnOverride(source, count) {
		const override =
			'<style data-paged-demo-columns>body{column-count:' +
			count +
			" !important}</style>";
		return source.replace("</head>", override + "</head>");
	}

	async function generatePdf(		source,
		{ title = document.title, onProgress, settings } = {},
	) {
		const { htmlToPDF, emitPdfFromPagedWindow, printHTML } =
			await import(new URL("paged.js", bundleBase()).href);
		if (!onProgress) {
			return htmlToPDF(source.replace(POLYFILL_TAG_RE, ""), {
				title,
				polyfillURL: new URL(
					"paged.polyfill.js",
					bundleBase(),
				).href,
				metadata: { title },
				settings,
			});
		}
		// With progress reporting: keep the print frame around and feed
		// emitter status to the caller while pages are emitted.
		let iframe;
		const bytes = await new Promise((resolve, reject) => {
			printHTML(source.replace(POLYFILL_TAG_RE, ""), {
				title,
				polyfillURL: new URL("paged.polyfill.js", bundleBase()).href,
				keepIframe: true,
				settings,
				errorCallback: reject,
				printCallback: (win) => {
					emitPdfFromPagedWindow(win, onProgress, {
						sourceHtml: source.replace(POLYFILL_TAG_RE, ""),
						metadata: { title },
						baseUrl: bundleBase(),
					})
						.then(resolve)
						.catch(reject)
						.finally(() => iframe?.remove());
				},
			}).then((frame) => (iframe = frame));
		});
		return bytes;
	}

	const DemoUI = {
		generatePdf,
		getSelectedMeasurement,
		getMeasurementSettings,
		getColumnSelection,
		withColumnOverride,

		/**
		 * Adds a "Download PDF" button. The page's own source (fetched from
		 * the server) is re-paginated in a hidden frame and emitted as PDF.
		 */
		addDownloadButton({
			label = "Download PDF",
			filename,
			title = document.title,
			settings = getMeasurementSettings(),
		} = {}) {
			const bar = ensureToolbar();
			const button = makeButton(label);
			button.id = "paged-download-pdf";
			bar.appendChild(button);
			button.addEventListener("click", async () => {
				const original = label;
				button.disabled = true;
				button.textContent = "Generating PDF…";
				try {
					let source = await getSource();
					const columns = getColumnSelection();
					if (columns.explicit) {
						source = withColumnOverride(source, columns.count);
					}
					const bytes = await generatePdf(source, {
						title,
						settings,
						onProgress: (message) => {
							button.textContent = message;
						},
					});
					saveBytes(
						bytes,
						filename ||
							(location.pathname.split("/").pop() || "demo"
							).replace(/\.html$/, "") + ".pdf",
					);
				} catch (error) {
					alert("PDF generation failed: " + error.message);
				} finally {
					button.disabled = false;
					button.textContent = original;
				}
			});
		},

		/**
		 * Adds a select that switches the number of columns the page's root
		 * flow uses. Changing the value reloads the page with a
		 * `?columns=<n>` query parameter; the polisher reads the override
		 * from the injected `body { column-count }` rule (same path as
		 * author CSS), and a count of 1 disables root-level multicol.
		 */
		addColumnSelect({ label = "Columns" } = {}) {
			const build = () => {
				const bar = ensureToolbar();
				const wrapper = document.createElement("label");
				wrapper.style.cssText =
					"display:flex;align-items:center;gap:6px;font-size:14px;" +
					"padding:6px 10px;border:1px solid #333;border-radius:6px;" +
					"background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25);";
				wrapper.textContent = label + ":";
				const select = document.createElement("select");
				select.style.cssText =
					"font-size:14px;border:none;background:transparent;cursor:pointer;";
				const current = getColumnSelection().count;
				for (let n = 1; n <= 4; n++) {
					const option = document.createElement("option");
					option.value = String(n);
					option.textContent = String(n);
					option.selected = n === current;
					select.appendChild(option);
				}
				select.addEventListener("change", () => {
					const url = new URL(location.href);
					url.searchParams.set("columns", select.value);
					location.replace(url.href);
				});
				wrapper.appendChild(select);
				bar.insertBefore(wrapper, bar.firstChild);
			};
			if (document.body) {
				build();
			} else {
				document.addEventListener("DOMContentLoaded", build);
			}
		},

		/**
		 * Adds a select that switches the text-measurement backend. Changing the
		 * value reloads the page with a `?measurement=<mode>` query parameter so
		 * the polyfill re-renders using the chosen backend.
		 */
		addMeasurementSelect({ label = "Text measurement" } = {}) {
			const build = () => {
				const bar = ensureToolbar();
				const wrapper = document.createElement("label");
				wrapper.style.cssText =
					"display:flex;align-items:center;gap:6px;font-size:14px;" +
					"padding:6px 10px;border:1px solid #333;border-radius:6px;" +
					"background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25);";
				wrapper.textContent = label + ":";
				const select = document.createElement("select");
				select.style.cssText =
					"font-size:14px;border:none;background:transparent;cursor:pointer;";
				const modes = [
					{ value: "dom", text: "DOM (legacy)" },
					{ value: "pretext", text: "Pretext (verified)" },
					{ value: "fast", text: "Pretext (fast)" },
				];
				const current = getSelectedMeasurement();
				for (const mode of modes) {
					const option = document.createElement("option");
					option.value = mode.value;
					option.textContent = mode.text;
					option.selected = mode.value === current;
					select.appendChild(option);
				}
				select.addEventListener("change", () => {
					const url = new URL(location.href);
					if (select.value === "dom") {
						url.searchParams.delete("measurement");
					} else {
						url.searchParams.set("measurement", select.value);
					}
					location.replace(url.href);
				});
				wrapper.appendChild(select);
				bar.insertBefore(wrapper, bar.firstChild);
			};
			if (document.body) {
				build();
			} else {
				document.addEventListener("DOMContentLoaded", build);
			}
		},

		getSource,
		saveBytes,
		makeButton,
		ensureToolbar,

		/** Regex removing a bundled polyfill script tag from source HTML. */
		POLYFILL_TAG_RE,
	};

	window.DemoUI = DemoUI;
})();
