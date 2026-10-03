const TIMEOUT = 10000;

describe("rows unsplittable", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("splits/tables/rows-unsplittable.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("should split the table across pages", async () => {
		const fragments = await page.$$eval("table[data-split-from]", (t) => t.length);
		expect(fragments).toBeGreaterThan(0);
	});

	it("should never split a row mid-row", async () => {
		const splitRows = await page.$$eval("tr[data-split-from]", (rows) => {
			return rows.map((row) => {
				const table = row.closest("table");
				const firstRow = table.querySelector("tr");
				return {
					cells: row.cells.length,
					columns: firstRow ? firstRow.cells.length : 0,
					text: row.textContent.trim().slice(0, 40)
				};
			});
		});
		// A continuation of a row (data-split-from) only exists when a row
		// had to be split mid-row. Rows that fit on a single page must move
		// to the next page as a whole instead.
		expect(splitRows).toEqual([]);
	});

	it("should keep every row at full column count", async () => {
		const rows = await page.$$eval("table tr", (trs) => {
			return trs.map((row) => {
				const table = row.closest("table");
				const firstRow = table.querySelector("tr");
				return {
					cells: row.cells.length,
					columns: firstRow ? firstRow.cells.length : 0,
					splitFrom: row.hasAttribute("data-split-from")
				};
			});
		});
		for (const row of rows) {
			// The one legitimate exception: a row too tall for a full page
			// (not producible by this spec's one-line cells).
			expect(row.cells).toBe(row.columns);
		}
	});

	it("should not lose rows across the split", async () => {
		const bodyCells = await page.$$eval(
			"table tbody tr",
			(rows) => rows.map((row) => Array.from(row.cells).map((cell) => cell.textContent.trim())),
		);
		const rowHeads = bodyCells.map((cells) => cells[0]);
		for (let i = 1; i <= 20; i++) {
			expect(rowHeads).toContain(`Cell A${i}`);
		}
	});
});
