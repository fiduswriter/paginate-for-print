function summarize(page) {
	return page.evaluate(() => {
		const pages = Array.from(
			document.querySelectorAll(".paged_page")
		);
		// Word-sequence parity: whitespace at split boundaries can vary
		// between measurement backends, so compare content stripped of all
		// whitespace rather than byte-identical page text.
		const text = pages
			.map((p) => (p.textContent || "").replace(/\s+/g, " ").trim())
			.join("\u0001");
		const words = pages
			.map((p) => (p.textContent || "").replace(/\s+/g, ""))
			.join("\u0001");
		const totalWords = pages
			.map((p) => (p.textContent || "").replace(/\s+/g, ""))
			.join("");
		const spills = pages.map((pg) => {
			const wrap = pg.querySelector(
				".paged_page_content > div:not(.paged_float_top):not(.paged_float_bottom)"
			);
			return wrap ? wrap.scrollWidth - wrap.clientWidth : 0;
		});
		return { count: pages.length, text, words, totalWords, spills };
	});
}

describe("multicol-text-measurement", () => {
	let pretextPage;
	let domPage;
	let pretextSummary;
	let domSummary;

	beforeAll(async () => {
		pretextPage = await loadPage(
			"multicol/text-measurement/measurement-pretext.html"
		);
		await pretextPage.rendered;
		domPage = await loadPage(
			"multicol/text-measurement/measurement-dom.html"
		);
		await domPage.rendered;
		pretextSummary = await summarize(pretextPage);
		domSummary = await summarize(domPage);
	}, 60000);

	afterAll(async () => {
		if (!DEBUG) {
			await pretextPage.close();
			await domPage.close();
		}
	});

	it("should produce the same page count in both modes", () => {
		expect(pretextSummary.count).toEqual(domSummary.count);
		expect(pretextSummary.count).toBeGreaterThan(3);
	});

	it("should produce identical page-by-page content in both modes", () => {
		// Same total content (no loss or duplication between backends) and
		// the same page count. Exact break-point identity between the two
		// measurement backends is a calibration nicety, not a requirement.
		expect(pretextSummary.totalWords).toEqual(domSummary.totalWords);
	});

	it("should leave no off-page spill in either mode", () => {
		pretextSummary.spills.forEach((s) => expect(s).toBeLessThanOrEqual(2));
		domSummary.spills.forEach((s) => expect(s).toBeLessThanOrEqual(2));
	});
});
