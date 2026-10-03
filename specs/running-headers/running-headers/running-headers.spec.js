const TIMEOUT = 10000;

describe("running headers", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("running-headers/running-headers/running-headers.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("element(first) shows the first running source on the page", async () => {
		let text = await page.$eval(".paged_first_page .paged_margin-top-left", (r) =>
			r.textContent,
		);
		expect(text).toContain("First Chapter");
	});

	it("element(last) shows the last running source on the page", async () => {
		let text = await page.$eval(".paged_first_page .paged_margin-top-center", (r) =>
			r.textContent,
		);
		expect(text).toContain("First Chapter");
	});

	it("element(first-except) is empty on the page where the source first appears", async () => {
		let text = await page.$eval(
			".paged_first_page .paged_margin-bottom-center",
			(r) => r.textContent,
		);
		expect(text).toBe("");
	});
});
