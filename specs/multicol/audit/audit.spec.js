const TIMEOUT = 60000;

function summarize(page) {
	return page.evaluate(() => {
		const pages = Array.from(document.querySelectorAll(".paged_page"));
		const violations = pages.map((pg, index) => {
			const wrap = pg.querySelector(
				".paged_page_content > div:not(.paged_float_top):not(.paged_float_bottom)"
			);
			if (!wrap) {
				return { page: index + 1, spill: 0 };
			}
			const spill = Math.max(
				wrap.scrollWidth - wrap.clientWidth,
				wrap.scrollHeight - wrap.clientHeight
			);
			return { page: index + 1, spill };
		});
		return { count: pages.length, violations };
	});
}

describe("multicol-audit", () => {
	let domPage;
	let pretextPage;
	let fastPage;
	let domSummary;
	let pretextSummary;
	let fastSummary;

	beforeAll(async () => {
		domPage = await loadPage("multicol/audit/audit-dom.html");
		await domPage.rendered;
		pretextPage = await loadPage("multicol/audit/audit-pretext.html");
		await pretextPage.rendered;
		fastPage = await loadPage("multicol/audit/audit-fast.html");
		await fastPage.rendered;
		domSummary = await summarize(domPage);
		pretextSummary = await summarize(pretextPage);
		fastSummary = await summarize(fastPage);
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await domPage.close();
			await pretextPage.close();
			await fastPage.close();
		}
	});

	it("should paginate several pages in every mode", () => {
		expect(domSummary.count).toBeGreaterThan(3);
		expect(pretextSummary.count).toBeGreaterThan(3);
		expect(fastSummary.count).toBeGreaterThan(3);
	});

	it("should produce the same verified-pretext and dom page counts", () => {
		expect(pretextSummary.count).toEqual(domSummary.count);
	});

	it("should leave no content outside its designated space when breaking is verified", () => {
		// dom measures real rects and pretext verifies each predicted break,
		// so neither may spill. Fast mode (verifyTextPrediction: false) breaks
		// on pure arithmetic and documents residual spills as a tradeoff
		// (see README) — only its basic sanity is asserted above.
		[domSummary, pretextSummary].forEach((summary) => {
			const bad = summary.violations.filter((v) => v.spill > 4);
			expect(bad).toEqual([]);
		});
	});
});
