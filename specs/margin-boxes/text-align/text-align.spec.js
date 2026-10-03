const TIMEOUT = 10000;

describe("issue", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("margin-boxes/text-align/text-align.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	xit("should render 6 pages", async () => {
		let pages = await page.$$eval(".paged_page", (r) => {
			return r.length;
		});

		expect(pages).toEqual(6);
	});


	if (!DEBUG) {
		it_snapshots("should create a pdf", async () => {
			let pdf = await page.pdf(PDF_SETTINGS);

			expect(pdf).toMatchPDFSnapshot(1);
		});
	}
}
);
