const TIMEOUT = 10000;

describe("page-size", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("page-rules/size/page-size/page-size.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("should render 1 page", async () => {
		let pages = await page.$$eval(".paged_page", (r) => {
			return r.length;
		});

		expect(pages).toEqual(1);
	});

	it("should give the page a width of 148mm", async () => {
		let width = await page.$eval(".paged_page", (r) => {
			return window.getComputedStyle(r).getPropertyValue("--paged-width");
		});

		expect(width).toEqual("148mm");
	});

	it("should give the page a height of 210mm", async () => {
		let width = await page.$eval(".paged_page", (r) => {
			return window.getComputedStyle(r).getPropertyValue("--paged-height");
		});

		expect(width).toEqual("210mm");
	});

	if (!DEBUG) {
		it_snapshots("should create a pdf", async () => {
			let pdf = await page.pdf(PDF_SETTINGS);

			expect(pdf).toMatchPDFSnapshot(1);
		});
	}
}
);
