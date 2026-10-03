const TIMEOUT = 15000;

describe("multicol-balance-span", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("multicol/balance-span/balance-span.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("should balance the row that ends before a column-span", async () => {
		const info = await page.evaluate(() => {
			const rows = Array.from(
				document.querySelectorAll(".paged_flow > .paged_columns"),
			);
			const spans = Array.from(
				document.querySelectorAll(".paged_flow > h2"),
			);
			const rowBeforeSpan = spans.length
				? spans[0].previousElementSibling
				: null;
			return {
				rowCount: rows.length,
				balancedCount: rows.filter(
					(r) => r.dataset.pagedManualColumnsBalanced !== undefined,
				).length,
				rowBeforeSpanBalanced:
					rowBeforeSpan &&
					rowBeforeSpan.classList.contains("paged_columns") &&
					rowBeforeSpan.dataset.pagedManualColumnsBalanced !== undefined,
				spanText: spans.length ? spans[0].textContent : "",
			};
		});
		expect(info.rowCount).toBeGreaterThan(1);
		expect(info.rowBeforeSpanBalanced).toBe(true);
		expect(info.spanText).toContain("Spanning heading");
	});

	it("should preserve all content", async () => {
		const text = await page.evaluate(() => {
			const pages = document.querySelectorAll(".paged_page");
			let t = "";
			pages.forEach((p) => (t += p.textContent));
			return t;
		});
		expect(text).toContain("Lorem ipsum dolor sit amet");
		expect(text).toContain("Spanning heading");
		expect(text).toContain("Quis autem vel eum iure");
	});
});
