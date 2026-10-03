const TIMEOUT = 10000;

describe("page-floats-footnotes", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("page-floats/page-floats-footnotes/page-floats-footnotes.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("should render 1 page", async () => {
		let pages = await page.$$eval(".paged_page", (r) => r.length);
		expect(pages).toEqual(1);
	});

	it("should place the float and the footnote on the same page", async () => {
		let info = await page.$eval("[data-page-number='1']", (pg) => {
			let fig = pg.querySelector(".paged_float_top #pf-one");
			let noteContent = pg.querySelector(".paged_footnote_content");
			return {
				hasFig: !!fig,
				noteText: noteContent ? noteContent.textContent : "",
			};
		});
		expect(info.hasFig).toBe(true);
		expect(info.noteText).toContain("shares the page with a page float");
	});
}
);
