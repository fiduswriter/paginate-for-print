const TIMEOUT = 10000;

describe("footnotes padding", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("notes/footnotes-padding/footnotes-padding.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("should render 6 pages", async () => {
		let pages = await page.$$eval(".paged_page", (r) => {
			return r.length;
		});

		expect(pages).toEqual(6);
	});

	it("moves the long footnote to page 2", async () => {
		// The reserve sizes the footnote area before the columns fill; a
		// footnote taller than the page can hold is no longer started and
		// cut at the page bottom (the pre-reserve layout spilled it into
		// the margin) — it moves whole to page 2 instead. Cutting a note
		// at the area edge is not modeled by the reserve yet.
		let textStart = await page.$eval("[data-page-number='1']", (r) => r.textContent);
		expect(textStart).not.toContain("The Haarlem Legend of the Invention of Printing by");
		let textPage2 = await page.$eval("[data-page-number='2']", (r) => r.textContent);
		expect(textPage2).toContain("The Haarlem Legend of the Invention of Printing by");
		expect(textPage2).toContain("Lourens Janszoon Coster");
	});


	if (!DEBUG) {
		it_snapshots("should create a pdf", async () => {
			let pdf = await page.pdf(PDF_SETTINGS);

			expect(pdf).toMatchPDFSnapshot(1);
			expect(pdf).toMatchPDFSnapshot(2);
		});
	}
}
);
