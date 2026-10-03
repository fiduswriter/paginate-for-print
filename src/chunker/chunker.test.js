/**
 * Unit tests for the chunker (src/chunker/chunker.ts), run under jsdom.
 *
 * Scope: construction defaults and the `setup()` DOM bootstrap — the pages
 * container and the inert page-template skeleton. The actual pagination
 * pipeline (flow/render, overflow detection, page floats) needs real layout
 * and is covered by the Playwright specs under specs/, not here.
 *
 * All tests in this file share one jsdom document, so the body is emptied
 * before every test.
 */

import Chunker from "./chunker.js";

/** Standard lifecycle hook names the chunker registers at construction. */
const LIFECYCLE_HOOKS = [
	"beforeParsed",
	"filter",
	"afterParsed",
	"beforePageLayout",
	"onPageLayout",
	"layout",
	"renderNode",
	"layoutNode",
	"onOverflow",
	"afterOverflowRemoved",
	"afterOverflowAdded",
	"onBreakToken",
	"beforeRenderResult",
	"afterPageLayout",
	"finalizePage",
	"afterRendered"
];

describe("Chunker", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
	});

	describe("construction defaults", () => {
		/** Nothing is bootstrapped until setup() runs. */
		it("starts without a pages area, a page template, or pagination DOM", () => {
			const chunker = new Chunker();

			expect(chunker.pagesArea).toBeUndefined();
			expect(chunker.pageTemplate).toBeUndefined();
			expect(document.body.children).toHaveLength(0);
		});

		/** Baseline instance state right after construction. */
		it("initializes its counters, flags and registries to their defaults", () => {
			const chunker = new Chunker();

			expect(chunker.pages).toEqual([]);
			expect(chunker.total).toBe(0);
			expect(chunker.stopped).toBe(false);
			expect(chunker.rendered).toBe(false);
			expect(chunker.settings).toEqual({});
			expect(chunker.multicolSelectors).toEqual(new Set());
			expect(chunker.columnSpanSelectors).toEqual(new Set());
			expect(chunker.q).toBeDefined();
		});

		/** One entry per standard lifecycle name, each an idle hook object. */
		it("registers the standard lifecycle hooks", () => {
			const chunker = new Chunker();

			expect(Object.keys(chunker.hooks).sort()).toEqual([...LIFECYCLE_HOOKS].sort());
			for (const name of LIFECYCLE_HOOKS) {
				const hook = chunker.hooks[name];
				expect(typeof hook).toBe("object");
				expect(hook).not.toBeNull();
				expect(typeof hook.trigger).toBe("function");
				expect(typeof hook.register).toBe("function");
				expect(hook.hooks).toEqual([]);
			}
		});

		/** Only truthy content may kick off the render pipeline. */
		it("does not start rendering for falsy content", () => {
			const chunker = new Chunker("");

			expect(chunker.pages).toEqual([]);
			expect(chunker.rendered).toBe(false);
			expect(document.body.children).toHaveLength(0);
		});
	});

	describe("setup without a render target", () => {
		/** Parity with the original smoke test: class on the pages container. */
		it("gives the pages container the paged_pages class", () => {
			const chunker = new Chunker();
			chunker.setup();

			expect(chunker.pagesArea).toBeInstanceOf(HTMLDivElement);
			expect(chunker.pagesArea.classList.contains("paged_pages")).toBe(true);
			expect(chunker.pagesArea.className).toBe("paged_pages");
		});

		/** Default attachment target is the document body. */
		it("appends the pages container to the body", () => {
			const chunker = new Chunker();
			chunker.setup();

			expect(chunker.pagesArea.parentElement).toBe(document.body);
			expect(document.body.contains(chunker.pagesArea)).toBe(true);
		});

		/** The unguarded default attachment has nothing to append to. */
		it("throws a TypeError when the document has no body", () => {
			const body = document.body;
			document.documentElement.removeChild(body);
			try {
				const chunker = new Chunker();
				expect(() => chunker.setup()).toThrow(TypeError);
			} finally {
				document.documentElement.appendChild(body);
			}
		});
	});

	describe("the page template", () => {
		let chunker;

		beforeEach(() => {
			chunker = new Chunker();
			chunker.setup();
		});

		/** The skeleton is a template element, never live page markup. */
		it("is a template element whose markup stays out of the live document", () => {
			expect(chunker.pageTemplate).toBeInstanceOf(HTMLTemplateElement);
			expect(document.querySelector(".paged_page")).toBeNull();
		});

		/** The inert skeleton's root element is the page structure. */
		it("carries a paged_page root inside its content", () => {
			const root = chunker.pageTemplate.content.firstElementChild;

			expect(root).not.toBeNull();
			expect(root.classList.contains("paged_page")).toBe(true);
		});
	});

	describe("setup with an explicit render target", () => {
		/** An in-document render target wins over the body default. */
		it("parents the pages container to an attached render target", () => {
			const container = document.createElement("div");
			document.body.appendChild(container);

			const chunker = new Chunker();
			chunker.setup(container);

			expect(chunker.pagesArea.parentElement).toBe(container);
			expect(document.body.contains(chunker.pagesArea)).toBe(true);
		});

		/** The render target does not have to be in the document. */
		it("parents the pages container to a detached render target", () => {
			const container = document.createElement("div");

			const chunker = new Chunker();
			chunker.setup(container);

			expect(chunker.pagesArea.parentElement).toBe(container);
			expect(document.body.contains(chunker.pagesArea)).toBe(false);
			expect(document.body.children).toHaveLength(0);
		});
	});

	describe("repeated setup", () => {
		/** Each call creates a new container; the old one is left in place. */
		it("installs a fresh pages container on every call", () => {
			const chunker = new Chunker();
			chunker.setup();
			const first = chunker.pagesArea;

			chunker.setup();

			expect(chunker.pagesArea).not.toBe(first);
			const installed = document.body.querySelectorAll(".paged_pages");
			expect(installed).toHaveLength(2);
			expect(installed[0]).toBe(first);
			expect(installed[1]).toBe(chunker.pagesArea);
		});

		/** A later no-argument call re-routes to the default parent. */
		it("falls back to the body as parent after an explicit render target", () => {
			const container = document.createElement("div");
			document.body.appendChild(container);

			const chunker = new Chunker();
			chunker.setup(container);
			chunker.setup();

			expect(chunker.pagesArea.parentElement).toBe(document.body);
			expect(container.contains(chunker.pagesArea)).toBe(false);
			expect(container.querySelector(".paged_pages")).not.toBeNull();
		});
	});
});
