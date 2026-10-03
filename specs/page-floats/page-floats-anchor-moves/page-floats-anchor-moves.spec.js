const TIMEOUT = 10000;

describe("page-floats-anchor-moves", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("page-floats/page-floats-anchor-moves/page-floats-anchor-moves.html");
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

	it("should move the float together with its kept block", async () => {
		let info = await page.$eval(".paged_pages", (pagesArea) => {
			let pg1 = pagesArea.querySelector("[data-page-number='1']");
			let pg2 = pagesArea.querySelector("[data-page-number='2']");
			let moved = pg2.querySelector(".paged_float_top #moved");
			return {
				pg1Floats: pg1.querySelectorAll("[data-page-float]").length,
				pg2Float: pg2.querySelector(".paged_float_top").children.length,
				inPg2: !!moved,
				text1: pg1.textContent,
				text2: pg2.textContent,
			};
		});
		expect(info.pg1Floats).toEqual(0);
		expect(info.pg2Float).toEqual(1);
		expect(info.inPg2).toBe(true);
		expect(info.text1).not.toContain("Kept line b1");
		expect(info.text2).toContain("Kept line b1");
		expect(info.text2).toContain("Kept line a8");
	});
}
);
