/**
 * Unit tests for printHTML (src/print.ts), run under jsdom with fake timers.
 *
 * Scope: how the print iframe is assembled and driven. The srcdoc must not
 * contain any inline script — it inherits the embedding page's content
 * security policy, and under a policy without `script-src 'unsafe-inline'`
 * an inline bootstrap script is blocked, leaving pagination to hang until
 * the timeout. The configuration instead crosses the frame boundary through
 * window.PaginatePrint.init, published by the external polyfill bundle.
 *
 * The pagination engine itself needs real layout and is covered by the
 * Playwright specs under specs/, so the iframe is a fake here.
 */

import { printHTML } from "./print.js";
import { PRINT_FRAME_MARKER } from "./print-frame.js";

/** A stand-in iframe whose contentWindow we control directly. */
function fakeIframe() {
	const contentWindow = {};
	return {
		iframe: {
			style: {},
			name: "",
			srcdoc: "",
			contentWindow,
			onerror: null,
			remove: jest.fn(),
		},
		contentWindow,
	};
}

describe("printHTML", () => {
	let createElementSpy;
	let appendChildSpy;
	let realCreateElement;

	beforeEach(() => {
		jest.useFakeTimers();
		realCreateElement = document.createElement.bind(document);
		const { iframe } = fakeIframe();
		createElementSpy = jest
			.spyOn(document, "createElement")
			.mockImplementation((tag) =>
				tag === "iframe" ? iframe : realCreateElement(tag),
			);
		appendChildSpy = jest
			.spyOn(document.body, "appendChild")
			.mockImplementation(() => {});
	});

	afterEach(() => {
		createElementSpy.mockRestore();
		appendChildSpy.mockRestore();
		jest.useRealTimers();
	});

	it("ships no inline script in the srcdoc and names the print frame", async () => {
		const { iframe } = fakeIframe();
		createElementSpy.mockImplementation((tag) =>
			tag === "iframe" ? iframe : realCreateElement(tag),
		);

		printHTML("<html><body><p>Hello</p></body></html>", {
			settings: { textMeasurement: "estimate" },
		});

		expect(iframe.name).toBe(PRINT_FRAME_MARKER);
		expect(iframe.srcdoc).not.toMatch(/<script(?!\s[^>]*\bsrc=)/);
		expect(iframe.srcdoc).not.toContain("PaginateConfig");
		expect(iframe.srcdoc).not.toContain("__PAGED_PRINT_ACTIVE");
		expect(iframe.srcdoc).toMatch(
			/<script src="http:\/\/localhost\/paginate\.polyfill\.js"><\/script>/,
		);
	});

	it("hands the configuration to the polyfill through PaginatePrint.init", async () => {
		const { iframe, contentWindow } = fakeIframe();
		createElementSpy.mockImplementation((tag) =>
			tag === "iframe" ? iframe : realCreateElement(tag),
		);
		const printCallback = jest.fn();

		const promise = printHTML(
			"<html><body><p>Hello</p></body></html>",
			{
				settings: { textMeasurement: "estimate" },
				printCallback,
			},
		);

		// The bundle has not loaded yet: init must not fire spontaneously.
		await jest.advanceTimersByTimeAsync(500);
		expect(printCallback).not.toHaveBeenCalled();

		// The polyfill bundle publishes window.PaginatePrint when loaded.
		const init = jest.fn();
		contentWindow.PaginatePrint = { init };
		await jest.advanceTimersByTimeAsync(100);

		expect(init).toHaveBeenCalledTimes(1);
		const config = init.mock.calls[0][0];
		expect(config).toMatchObject({
			auto: true,
			settings: { textMeasurement: "estimate" },
		});
		expect(config.after).toEqual(expect.any(Function));
		expect(contentWindow.__PAGED_BUNDLE_BASE).toBe("http://localhost/");
		expect(contentWindow.__PAGED_PRINT_ACTIVE).toBe(true);

		// init runs at most once.
		await jest.advanceTimersByTimeAsync(300);
		expect(init).toHaveBeenCalledTimes(1);

		// Pagination completing triggers the print callback and resolves.
		config.after();
		await jest.advanceTimersByTimeAsync(100);
		expect(printCallback).toHaveBeenCalledTimes(1);
		expect(printCallback.mock.calls[0][0]).toBe(contentWindow);
		await expect(promise).resolves.toBe(iframe);
	});

	it("fails through the timeout when the bundle never loads", async () => {
		const errorCallback = jest.fn();

		const promise = printHTML("<html><body><p>Hello</p></body></html>", {
			errorCallback,
		});

		// Jump the clock past the deadline instead of pumping 300 s worth
		// of 100 ms interval ticks.
		jest.setSystemTime(Date.now() + 300000 + 100);
		jest.advanceTimersByTime(100);
		expect(errorCallback).toHaveBeenCalledWith(
			"Pagination did not complete in time.",
		);
		await expect(promise).resolves.toBeDefined();
	});
});
