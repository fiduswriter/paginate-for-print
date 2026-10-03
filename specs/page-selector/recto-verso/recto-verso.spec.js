const TIMEOUT = 10000;

describe("recto-verso", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("page-selector/recto-verso/recto-verso.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("applies recto margin content to right-hand pages", async () => {
		let text = await page.$eval(
			".paged_recto_page .paged_margin-top-center > .paged_margin-content",
			(r) => window.getComputedStyle(r, "::after").content,
		);
		expect(text).toContain("recto");
	});

	it("applies verso margin content to left-hand pages", async () => {
		let text = await page.$eval(
			".paged_verso_page .paged_margin-top-center > .paged_margin-content",
			(r) => window.getComputedStyle(r, "::after").content,
		);
		expect(text).toContain("verso");
	});
});
