const TIMEOUT = 10000;

describe("repeated thead", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("splits/tables/repeated-thead.html");
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

	it("should repeat a visible thead on every continuation", async () => {
		const continuations = await page.$$eval(
			"table[data-split-from]",
			(tables) => {
				return tables.map((tbl) => {
					const thead = tbl.querySelector("thead[data-repeated-thead]");
					if (!thead) {
						return { repeated: false };
					}
					const visibility = window.getComputedStyle(thead).visibility;
					const cells = Array.from(thead.querySelectorAll("th, td")).map(
						(cell) => cell.textContent.trim(),
					);
					return {
						repeated: true,
						visibility,
						cells,
					};
				});
			}
		);
		expect(continuations.length).toBeGreaterThan(0);
		for (const continuation of continuations) {
			expect(continuation.repeated).toBe(true);
			expect(continuation.visibility).not.toBe("collapse");
			expect(continuation.visibility).not.toBe("hidden");
			expect(continuation.cells).toEqual(["Head 1", "Head 2", "Head 3"]);
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

	it("should not create empty continuation rows", async () => {
		const emptyRows = await page.$$eval(
			"table[data-split-from] tbody tr",
			(rows) => rows.filter(
				(row) => row.cells.length && !row.textContent.trim(),
			).length,
		);
		expect(emptyRows).toBe(0);
	});

	if (!DEBUG) {
		it_snapshots("should create a pdf", async () => {
			let pdf = await page.pdf(PDF_SETTINGS);

			expect(pdf).toMatchPDFSnapshot(1);
			expect(pdf).toMatchPDFSnapshot(2);
		});
	}
});
