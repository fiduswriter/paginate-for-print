const TIMEOUT = 10000; // Some book might take longer than this to renderer

describe("counter-pages", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("counters/counter-pages/counter-pages.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	// Unable to read counter values
	xit("should have page numbering", async () => {
		let text = await page.$eval("[data-page-number='1'] .paged_margin-bottom-left > .paged_margin-content", (r) => window.getComputedStyle(r, "::after").content);
		expect(text).toContain("1 / 6");
	});

	if (!DEBUG) {
		it_snapshots("should create a pdf", async () => {
			let pdf = await page.pdf(PDF_SETTINGS);

			expect(pdf).toMatchPDFSnapshot(1);
		});
	}
}
);
