const TIMEOUT = 10000;

describe("page-floats-defer", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("page-floats/page-floats-defer/page-floats-defer.html");
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

	it("should defer the float to the top of page 2", async () => {
		let info = await page.$eval(".paged_pages", (pagesArea) => {
			let pg1 = pagesArea.querySelector("[data-page-number='1']");
			let pg2 = pagesArea.querySelector("[data-page-number='2']");
			let big = pg2.querySelector(".paged_float_top #big");
			let content2 = pg2.querySelector(".paged_page_content");
			return {
				pg1Deferred: pg1.querySelector(".paged_float_top").children.length,
				inPg2: !!big,
				bigTop: big ? big.getBoundingClientRect().top : null,
				content2Top: content2.getBoundingClientRect().top,
			};
		});
		expect(info.pg1Deferred).toEqual(0);
		expect(info.inPg2).toBe(true);
		expect(Math.abs(info.bigTop - info.content2Top)).toBeLessThanOrEqual(3);
	});

	it("should keep following content on page 1", async () => {
		let texts = await page.$$eval(".paged_page", (pages) =>
			pages.map((p) => p.textContent)
		);
		expect(texts[0]).toContain("following the deferred float");
		expect(texts[1]).not.toContain("following the deferred float");
	});
}
);
