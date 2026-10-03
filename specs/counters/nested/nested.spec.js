const TIMEOUT = 10000; // Some book might take longer than this to renderer

describe("counter-pages", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("counters/nested/nested.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	// Selectors are page-agnostic (first/last element in document order):
	// hard-coded page numbers break whenever line wrapping shifts the
	// pagination, while the counter semantics under test stay the same.

	it("should have a reset and increment on first h1", async () => {
		let text = await page.$eval(
			".paged_page_content h1",
			(r) => window.getComputedStyle(r)["counterIncrement"]
		);
		expect(text).toContain("titleLevel1 1 titleLevel2 0");
	});

	it("should have a increment on first h2", async () => {
		let text = await page.$eval(
			".paged_page_content h2",
			(r) => window.getComputedStyle(r)["counterIncrement"]
		);
		expect(text).toContain("titleLevel2 1");
	});

	it("should have a reset and increment on first h3", async () => {
		let text = await page.$$eval(
			".paged_page_content h3",
			(r) => window.getComputedStyle(r[0])["counterIncrement"]
		);
		expect(text).toContain("titleLevel3 1");
	});

	it("should have a reset and increment on last h1", async () => {
		let text = await page.$$eval(
			".paged_page_content h1",
			(r) => window.getComputedStyle(r[r.length - 1])["counterIncrement"]
		);
		expect(text).toContain("titleLevel1 1 titleLevel2 -4");
	});

	it("should have a increment on last h2", async () => {
		let text = await page.$$eval(
			".paged_page_content h2",
			(r) => window.getComputedStyle(r[r.length - 1])["counterIncrement"]
		);
		expect(text).toContain("titleLevel2 1");
	});

	it("should have a reset and increment on last h3", async () => {
		let text = await page.$$eval(
			".paged_page_content h3",
			(r) => window.getComputedStyle(r[r.length - 1])["counterIncrement"]
		);
		expect(text).toContain("titleLevel3 0");
	});

	if (!DEBUG) {
		it_snapshots("should create a pdf", async () => {
			let pdf = await page.pdf(PDF_SETTINGS);

			expect(pdf).toMatchPDFSnapshot(1);
			let pageCount = await page.$$eval(".paged_page", (r) => r.length);
			expect(pdf).toMatchPDFSnapshot(pageCount);
		});
	}
}
);
