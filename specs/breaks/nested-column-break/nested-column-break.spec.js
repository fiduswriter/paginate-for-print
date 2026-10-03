const TIMEOUT = 10000;

describe("nested-column-break", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("breaks/nested-column-break/nested-column-break.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("keeps the broken element inside its ancestor box", async () => {
		let info = await page.$eval(".second", (el) => {
			const column = el.closest(".paged_column");
			const box = el.closest(".box");
			return {
				column: column ? parseInt(column.dataset.pagedColumn, 10) : -1,
				hasBox: !!box,
			};
		});
		expect(info.column).toBe(1);
		expect(info.hasBox).toBe(true);
	});
});
