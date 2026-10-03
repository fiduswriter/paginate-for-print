const TIMEOUT = 10000;

describe("header orphan", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("splits/tables/header-orphan.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("should not leave a header-only table fragment behind", async () => {
		const fragments = await page.$$eval("table", (tables) => {
			return tables.map((table) => ({
				bodyRows: table.querySelectorAll("tbody tr").length,
				splitFrom: table.hasAttribute("data-split-from")
			}));
		});
		expect(fragments.length).toBeGreaterThan(0);
		for (const fragment of fragments) {
			// A table fragment must carry at least one body row: neither an
			// empty shell (whole-table move) nor a lone header group (and
			// possibly a caption) may remain on the earlier page.
			expect(fragment.bodyRows).toBeGreaterThan(0);
		}
	});

	it("should move the caption along with the table", async () => {
		const captions = await page.$$eval("table caption", (captions) => {
			return captions.map((caption) => {
				const table = caption.closest("table");
				return {
					text: caption.textContent.trim(),
					bodyRows: table.querySelectorAll("tbody tr").length
				};
			});
		});
		expect(captions.length).toBe(1);
		expect(captions[0].text).toBe("Caption of the table");
		// The caption travels with table content, not with a header-only
		// fragment.
		expect(captions[0].bodyRows).toBeGreaterThan(0);
	});

	it("should split the moved table between rows only", async () => {
		const splitRows = await page.$$eval("tr[data-split-from]", (rows) => rows.length);
		expect(splitRows).toBe(0);
	});

	it("should not lose rows across the split", async () => {
		const bodyCells = await page.$$eval(
			"table tbody tr",
			(rows) => rows.map((row) => Array.from(row.cells).map((cell) => cell.textContent.trim())),
		);
		const rowHeads = bodyCells.map((cells) => cells[0]);
		for (let i = 1; i <= 8; i++) {
			expect(rowHeads).toContain(`Cell A${i}`);
		}
	});

	it("should carry the repeated header on continuation fragments", async () => {
		const continuations = await page.$$eval(
			"table[data-split-from] thead",
			(theads) => theads.length
		);
		// Continuation fragments re-render the header group, keeping each
		// fragment self-contained for assistive technology.
		expect(continuations).toBeGreaterThan(0);
	});
});
