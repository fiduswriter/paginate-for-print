const TIMEOUT = 10000;

describe("start-empty-column", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("breaks/start-empty-column/start-empty-column.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("does not create an empty first column", async () => {
		let col = await page.$eval(".first", (el) => {
			const column = el.closest(".paged_column");
			return column ? parseInt(column.dataset.pagedColumn, 10) : -1;
		});
		expect(col).toBe(0);
	});
});
