const TIMEOUT = 10000;

describe("page-floats-bare-syntax", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("page-floats/page-floats-bare-syntax/page-floats-bare-syntax.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("should activate page floats from bare float syntax", async () => {
		let info = await page.$eval(".paged_pages", (pagesArea) => {
			let pg1 = pagesArea.querySelector("[data-page-number='1']");
			let pg2 = pagesArea.querySelector("[data-page-number='2']");
			let fig = pg1.querySelector(".paged_float_top #float-a");
			return {
				pages: pagesArea.querySelectorAll(".paged_page").length,
				hasFig: !!fig,
				text1: pg1.textContent,
				text2: pg2.textContent,
			};
		});
		expect(info.pages).toEqual(2);
		expect(info.hasFig).toBe(true);
		expect(info.text1).not.toContain("spilling to the next page");
		expect(info.text2).toContain("spilling to the next page");
	});
}
);
