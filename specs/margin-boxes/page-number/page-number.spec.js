const TIMEOUT = 30000;

describe("page-number", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("margin-boxes/page-number/page-number.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("should render several pages", async () => {
		let pages = await page.$$eval(".paged_page", (r) => r.length);
		expect(pages).toBeGreaterThanOrEqual(2);
	});

	it("should show the running chapter title in the top-center margin box", async () => {
		let text = await page.$eval(
			"[data-page-number='1'] .paged_margin-top-center",
			(el) => {
				const content = el.querySelector(".paged_margin-content");
				const style = window.getComputedStyle(content, "::after");
				return { display: style.display, content: style.content };
			}
		);
		expect(text.display).not.toEqual("none");
		expect(text.content).toContain("Numbered pages");
	});

	it_snapshots("should draw page numbers and the running head into the pdf", async () => {
		let pdf = await page.pdf(PDF_SETTINGS);

		// Page 1 carries both the counter(page) footer and the string()
		// running head; before pseudo-content synthesis these were blank.
		expect(pdf).toMatchPDFSnapshot(1);
	});
});
