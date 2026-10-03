const TIMEOUT = 10000;

describe("multicol-column-span", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("multicol/column-span/column-span.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("should span the header across the full column width", async () => {
		let info = await page.$eval("[data-page-number='1']", (pg) => {
			const wrapper = pg.querySelector(
				".paged_page_content > div:not(.paged_float_top):not(.paged_float_bottom)",
			);
			const h = pg.querySelector("#span-header");
			return {
				headerWidth: Math.round(h.getBoundingClientRect().width),
				wrapperWidth: wrapper.clientWidth,
			};
		});
		expect(info.headerWidth).toEqual(info.wrapperWidth);
	});

	it("should keep body text in columns around the spanned header", async () => {
		let info = await page.$eval("[data-page-number='1'] .paged_page_content", (content) => {
			const wrapper = content.querySelector(
				":scope > div:not(.paged_float_top):not(.paged_float_bottom)",
			);
			// The span interrupts the columns: content appears in two column
			// segments (before and after the header), each with two columns.
			const rows = wrapper.querySelectorAll(":scope > .paged_columns");
			const paragraphsInColumns =
				wrapper.querySelectorAll(".paged_column p").length;
			return {
				rows: rows.length,
				paragraphsInColumns,
				colsPerRow: rows[0]
					? rows[0].querySelectorAll(":scope > .paged_column").length
					: 0,
			};
		});
		expect(info.rows).toBeGreaterThanOrEqual(2);
		expect(info.paragraphsInColumns).toBeGreaterThanOrEqual(2);
		expect(info.colsPerRow).toEqual(2);
	});
});
