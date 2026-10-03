const TIMEOUT = 10000;

describe("page-floats-forced-break", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("page-floats/page-floats-forced-break/page-floats-forced-break.html");
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

	it("should keep the float on the anchor page", async () => {
		let info = await page.$eval(".paged_pages", (pagesArea) => {
			let pg1 = pagesArea.querySelector("[data-page-number='1']");
			let pg2 = pagesArea.querySelector("[data-page-number='2']");
			return {
				fbOnPage1: !!pg1.querySelector(".paged_float_top #fb"),
				totalFb: pagesArea.querySelectorAll("#fb").length,
				page1Text: pg1.textContent,
				page2Text: pg2.textContent,
				pg2TopEmpty: pg2.querySelector(".paged_float_top").children
					.length,
				h1OnPage2: !!pg2.querySelector("h1"),
			};
		});
		expect(info.fbOnPage1).toBe(true);
		expect(info.totalFb).toEqual(1);
		expect(info.page1Text).toContain("Anchor paragraph on page one.");
		expect(info.page1Text).not.toContain("Chapter heading");
		expect(info.page2Text).toContain("Chapter heading");
		expect(info.pg2TopEmpty).toEqual(0);
		expect(info.h1OnPage2).toBe(true);
	});
}
);
