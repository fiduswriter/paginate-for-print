const TIMEOUT = 10000;

describe("multicol-column-span-drop-cap", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage(
			"multicol/column-span-drop-cap/column-span-drop-cap.html",
		);
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("should not spill content out of a page's content area", async () => {
		// A drop-cap paragraph at the bottom of a short column segment used
		// to be laid out whole: the overflow range started inside the cap,
		// which the engine could not map back to the source, so no break was
		// taken and the paragraph rendered past the page.
		const spills = await page.evaluate(() =>
			Array.from(document.querySelectorAll(".paged_page")).map(
				(pg, index) => {
					const content = pg.querySelector(".paged_page_content");
					return {
						page: index + 1,
						spill:
							Math.max(
								content.scrollWidth - content.clientWidth,
								content.scrollHeight - content.clientHeight,
							),
					};
				},
			),
		);
		expect(spills.filter((entry) => entry.spill > 4)).toEqual([]);
	});

	it("should keep the heading with the drop cap it introduces", async () => {
		// `break-after: avoid` on the heading, plus the three lines the cap
		// needs, means the heading moves to the next page rather than being
		// stranded at the bottom of one.
		const kept = await page.evaluate(() => {
			const header = document.querySelector("#span-header");
			const headingPage = header.closest(".paged_page");
			const cap = document.querySelector(".paged_initial_letter");
			return {
				hasCap: !!cap,
				samePage: cap ? cap.closest(".paged_page") === headingPage : false,
			};
		});
		expect(kept.hasCap).toBe(true);
		expect(kept.samePage).toBe(true);
	});
});