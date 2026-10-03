const TIMEOUT = 10000; // Some book might take longer than this to renderer

describe("counter-page", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("counters/counter-page/counter-page.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	// Unable to read counter values
	xit("should have a page number for all pages", async () => {
		let text1 = await page.$eval("[data-page-number='1'] .paged_margin-bottom-left > .paged_margin-content", (r) => window.getComputedStyle(r, "::after").content);
		expect(text1).toContain("1");

		let text2 = await page.$eval("[data-page-number='2'] .paged_margin-bottom-left > .paged_margin-content", (r) => window.getComputedStyle(r, "::after").content);
		expect(text2).toContain("2");

		let text3 = await page.$eval("[data-page-number='3'] .paged_margin-bottom-left > .paged_margin-content", (r) => window.getComputedStyle(r, "::after").content);
		expect(text3).toContain("3");

		let text4 = await page.$eval("[data-page-number='4'] .paged_margin-bottom-left > .paged_margin-content", (r) => window.getComputedStyle(r, "::after").content);
		expect(text4).toContain("4");

		let text5 = await page.$eval("[data-page-number='5'] .paged_margin-bottom-left > .paged_margin-content", (r) => window.getComputedStyle(r, "::after").content);
		expect(text5).toContain("5");

		let text6 = await page.$eval("[data-page-number='6'] .paged_margin-bottom-left > .paged_margin-content", (r) => window.getComputedStyle(r, "::after").content);
		expect(text6).toContain("6");
	});

	if (!DEBUG) {
		it_snapshots("should create a pdf", async () => {
			let pdf = await page.pdf(PDF_SETTINGS);

			expect(pdf).toMatchPDFSnapshot(1);
			expect(pdf).toMatchPDFSnapshot(6);
		});
	}
}
);
