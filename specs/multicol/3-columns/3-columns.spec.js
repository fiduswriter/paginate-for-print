const TIMEOUT = 15000;

describe("multicol-3-columns", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("multicol/3-columns/3-columns.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("should render multiple pages", async () => {
		let pages = await page.$$eval(".paged_page", (r) => r.length);
		expect(pages).toBeGreaterThan(1);
	});

	it("should lay the flow out in 3 distinct columns on page 1", async () => {
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
			return Array.from(xs).sort((a, b) => a - b);
		});
		expect(info.length).toEqual(3);
	});

	it("should not spill visible content into an off-page column", async () => {
		let widths = await page.$$eval(".paged_page .paged_page_content > div:not(.paged_float_top):not(.paged_float_bottom)", (els) =>
			els.map((el) => el.scrollWidth)
		);
		widths.forEach((w) => {
			expect(w).toBeLessThanOrEqual(700);
		});
	});
});
