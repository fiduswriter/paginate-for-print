/**
 * Unit tests for the print-engine adapter (src/engine.ts), run under jsdom.
 *
 * Scope: how the adapter drives `printHTML`. The pagination iframe itself
 * needs real layout and is covered by the Playwright specs under specs/, so
 * `printHTML` is mocked here and only its configuration is asserted.
 *
 * `printHTML` prints the paginated iframe whenever it is called without a
 * `printCallback`. That default is what makes `print()` open the browser print
 * dialog, so `preparePagination` — whose contract is to hand back the iframe
 * window *without* printing — must pass a `printCallback` of its own. It did
 * not, so PDF export opened the print dialog mid-export.
 */

const mockPrintHTML = jest.fn();

jest.mock("./print.js", () => ({
	printHTML: (...args) => mockPrintHTML(...args),
}));

// pages-to-pdf ships ESM only, which this CommonJS jest setup cannot require.
// The backend preset is inert here — only printHTML's configuration is
// under test — so a stub is enough to load the adapter.
jest.mock("pages-to-pdf", () => ({
	PAGINATE_FOR_PRINT_BACKEND: {},
}));

import { paginateForPrintEngine } from "./engine.js";

/** A stand-in for the iframe `printHTML` resolves with. */
function fakeIframe() {
	return { contentWindow: {}, remove: jest.fn() };
}

describe("paginateForPrintEngine", () => {
	beforeEach(() => {
		mockPrintHTML.mockReset();
		mockPrintHTML.mockResolvedValue(fakeIframe());
	});

	describe("preparePagination", () => {
		it("does not let the iframe print itself", async () => {
			await paginateForPrintEngine.preparePagination({ html: "<p>x</p>" });

			expect(mockPrintHTML).toHaveBeenCalledTimes(1);
			// A printCallback suppresses printHTML's automatic print.
			expect(mockPrintHTML.mock.calls[0][1].printCallback).toEqual(
				expect.any(Function),
			);
		});

		it("keeps the iframe for the caller and hands back its window", async () => {
			const iframe = fakeIframe();
			mockPrintHTML.mockResolvedValue(iframe);

			const paginated = await paginateForPrintEngine.preparePagination({
				html: "<p>x</p>",
			});

			expect(mockPrintHTML.mock.calls[0][1].keepIframe).toBe(true);
			expect(paginated.win).toBe(iframe.contentWindow);

			paginated.cleanup();
			expect(iframe.remove).toHaveBeenCalled();
		});

		it("forwards the title, polyfill URL and error callback", async () => {
			const errorCallback = jest.fn();
			await paginateForPrintEngine.preparePagination({
				html: "<p>x</p>",
				title: "A document",
				polyfillURL: "https://example.org/paginate.polyfill.js",
				errorCallback,
			});

			expect(mockPrintHTML.mock.calls[0][1]).toMatchObject({
				title: "A document",
				polyfillURL: "https://example.org/paginate.polyfill.js",
				errorCallback: expect.any(Function),
			});
		});

		it("rejects and reports through the caller's error callback", async () => {
			const errorCallback = jest.fn();
			mockPrintHTML.mockImplementation((_html, config) => {
				config.errorCallback("Pagination did not complete in time.");
				return Promise.resolve(fakeIframe());
			});

			await expect(
				paginateForPrintEngine.preparePagination({
					html: "<p>x</p>",
					errorCallback,
				}),
			).rejects.toThrow("Pagination did not complete in time.");
			expect(errorCallback).toHaveBeenCalledWith(
				"Pagination did not complete in time.",
			);
		});
	});

	describe("print", () => {
		it("leaves the automatic print in place so the dialog opens", async () => {
			await paginateForPrintEngine.print({ html: "<p>x</p>" });

			expect(mockPrintHTML).toHaveBeenCalledTimes(1);
			// No printCallback: printHTML prints the iframe itself.
			expect(mockPrintHTML.mock.calls[0][1].printCallback).toBeUndefined();
			expect(mockPrintHTML.mock.calls[0][1].keepIframe).toBeUndefined();
		});
	});
});
