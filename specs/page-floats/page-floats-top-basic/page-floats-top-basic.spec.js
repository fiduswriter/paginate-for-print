const TIMEOUT = 10000;

describe("page-floats-top-basic", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("page-floats/page-floats-top-basic/page-floats-top-basic.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("should render 2 pages", async () => {
		let pages = await page.$$eval(".paged_page", (r) => r.length);
		expect(pages).toEqual(2);
	});

	it("should place the figure in the top float container of page 1", async () => {
		let info = await page.$eval("[data-page-number='1']", (pg) => {
			let top = pg.querySelector(".paged_float_top");
			let fig = top.querySelector("#float-a");
			let content = pg.querySelector(".paged_page_content");
			// The float must not sit inside the flow content (everything in
			// the host except its float containers).
			let flowHasFigure = !!content.querySelector(
				".paged_flow > :not(.paged_float_top):not(.paged_float_bottom) figure"
			);
			return {
				inContainer: !!fig,
				containerCount: top.children.length,
				contentTop: content.getBoundingClientRect().top,
				figTop: fig ? fig.getBoundingClientRect().top : null,
				figBottom: fig ? fig.getBoundingClientRect().bottom : null,
				firstPTop: document.getElementById("first").getBoundingClientRect().top,
				wrapperHasFigure: flowHasFigure,
			};
		});
		expect(info.inContainer).toBe(true);
		expect(info.containerCount).toEqual(1);
		expect(info.figTop).toBeGreaterThanOrEqual(info.contentTop - 1);
		expect(info.figTop).toBeLessThanOrEqual(info.contentTop + 3);
		expect(info.firstPTop).toBeGreaterThanOrEqual(info.figBottom - 2);
		expect(info.wrapperHasFigure).toBe(false);
	});

	it("should move the last paragraph to page 2", async () => {
		let texts = await page.$$eval(".paged_page", (pages) =>
			pages.map((p) => p.textContent)
		);
		expect(texts[0]).not.toContain("spilling to the next page");
		expect(texts[1]).toContain("spilling to the next page");
	});

	it("should leave the top container of page 2 empty", async () => {
		let count = await page.$eval(
			"[data-page-number='2'] .paged_float_top",
			(t) => t.children.length
		);
		expect(count).toEqual(0);
	});
}
);
