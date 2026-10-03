const TIMEOUT = 30000;

describe("page-floats-multicol-overflow", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("page-floats/page-floats-multicol-overflow/page-floats-multicol-overflow.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("should render more than one page", async () => {
		let pages = await page.$$eval(".paged_page", (r) => r.length);
		expect(pages).toBeGreaterThan(1);
	});

	it("should place the top float above the columns on the first page", async () => {
		let info = await page.evaluate(() => {
			const fig = document.querySelector("#float-a");
			const pg = fig && fig.closest(".paged_page");
			const figRect = fig ? fig.getBoundingClientRect() : null;
			const col = pg && pg.querySelector(".paged_columns > .paged_column");
			const colRect = col ? col.getBoundingClientRect() : null;
			return {
				inTopContainer: !!fig && fig.parentElement.classList.contains("paged_float_top"),
				pageNumber: pg ? parseInt(pg.dataset.pageNumber, 10) : null,
				aboveColumns:
					figRect && colRect ? figRect.bottom <= colRect.top : false,
			};
		});
		expect(info.inTopContainer).toBe(true);
		expect(info.pageNumber).toEqual(1);
		expect(info.aboveColumns).toBe(true);
	});

	it("should shrink the column boxes to the space below the top float", async () => {
		let info = await page.evaluate(() => {
			const pg = document.querySelector("[data-page-number='1']");
			const contentRect = pg.querySelector(".paged_page_content").getBoundingClientRect();
			const cols = Array.from(
				pg.querySelectorAll(".paged_columns > .paged_column"),
			).map((c) => {
				const r = c.getBoundingClientRect();
				return {
					top: r.top,
					bottom: r.bottom,
					height: r.height,
					clientHeight: c.clientHeight,
					scrollHeight: c.scrollHeight,
				};
			});
			const flow = pg.querySelector(".paged_flow");
			return {
				contentBottom: contentRect.bottom,
				cols,
				flowScrollHeight: flow ? flow.scrollHeight : null,
				flowClientHeight: flow ? flow.clientHeight : null,
			};
		});

		expect(info.cols.length).toBeGreaterThan(0);
		info.cols.forEach((col) => {
			// The column box must end at or above the content area's bottom
			// (the top float occupies space above it).
			expect(col.bottom).toBeLessThanOrEqual(info.contentBottom + 2);
			// No content may spill past the column's own box.
			expect(col.scrollHeight - col.clientHeight).toBeLessThanOrEqual(2);
		});
		// The flow host must not grow beyond its content area either.
		if (info.flowClientHeight !== null) {
			expect(info.flowScrollHeight - info.flowClientHeight).toBeLessThanOrEqual(2);
		}
	});

	it("should keep the float and following text in order", async () => {
		let texts = await page.$$eval(".paged_page", (pages) =>
			pages.map((p) => p.textContent)
		);
		let floatIdx = texts.findIndex((t) => t.includes("FIG-A-TALL"));
		expect(floatIdx).toBeGreaterThanOrEqual(0);
		// The trailing paragraph must land on the same or a later page.
		let h1Idx = texts.findIndex((t) => t.includes("Page floats in a two-column flow"));
		expect(h1Idx).toBeGreaterThanOrEqual(floatIdx);
	});
});
