const TIMEOUT = 10000;

describe("multicol-two-columns", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("multicol/two-columns/two-columns.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("should render more than one page", async () => {
		let pages = await page.$$eval(".paged_page", (r) => r.length);
		expect(pages).toBeGreaterThan(1);
	});

	it("should lay the flow out in two distinct columns on page 1", async () => {
		let info = await page.$eval("[data-page-number='1'] .paged_page_content", (content) => {
			const wrapper = content.querySelector(
				":scope > div:not(.paged_float_top):not(.paged_float_bottom)",
			);
			const xs = new Set();
			wrapper.querySelectorAll("p, h1").forEach((el) => {
				Array.from(el.getClientRects()).forEach(function (r) {
					xs.add(Math.round(r.left));
				});
			});
			// Manual columns: no `column-count` is ever applied; the flow
			// is cut into explicit `.paged_column` boxes.
			const columnCount = wrapper.querySelectorAll(
				":scope > .paged_columns > .paged_column",
			).length;
			return {
				columnCount: String(columnCount),
				distinctLefts: Array.from(xs).sort((a, b) => a - b),
				wrapperWidth: wrapper.clientWidth,
			};
		});
		expect(info.columnCount).toEqual("2");
		expect(info.distinctLefts.length).toEqual(2);
	});

	it("should not spill visible content into an off-page column", async () => {
		let widths = await page.$$eval(".paged_page .paged_page_content > div:not(.paged_float_top):not(.paged_float_bottom)", (els) =>
			els.map((el) => el.scrollWidth)
		);
		widths.forEach((w) => {
			expect(w).toBeLessThanOrEqual(400);
		});
	});

	it("should paginate and carry the spilling text onward", async () => {
		let texts = await page.$$eval(".paged_page", (pages) =>
			pages.map((p) => p.textContent)
		);
		expect(texts.length).toBeGreaterThan(1);
		expect(texts[texts.length - 1]).toContain(
			"spills to the next page"
		);
	});

	it("should preserve all content across pages", async () => {
		let len = await page.evaluate(() => {
			const pages = document.querySelectorAll(".paged_page");
			let text = "";
			pages.forEach((p) => (text += p.textContent));
			return text.replace(/\s+/g, " ").trim().length;
		});
		expect(len).toBeGreaterThan(500);
	});
});
