const TIMEOUT = 10000;

describe("break-after-column", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("breaks/break-after-column/break-after-column.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("moves the following element to the second column", async () => {
		let col = await page.$eval(".second", (el) => {
			const column = el.closest(".paged_column");
			return column ? parseInt(column.dataset.pagedColumn, 10) : -1;
		});
		expect(col).toBe(1);
	});
});
