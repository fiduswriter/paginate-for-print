const TIMEOUT = 10000;

describe("multicol-break-inside-avoid", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("multicol/break-inside-avoid/break-inside-avoid.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("should keep both paragraphs of the avoid block together", async () => {
		let info = await page.$$eval(".paged_page", (pages) =>
			pages.map((pg) => {
				const block = pg.querySelector("#keep-together");
				if (!block) {
					return null;
				}
				const r = block.getBoundingClientRect();
				const ps = Array.from(block.querySelectorAll("p")).map((p) =>
					Math.round(p.getBoundingClientRect().top)
				);
				return { top: Math.round(r.top), bottom: Math.round(r.bottom), ps };
			})
		);
		const found = info.filter((x) => x !== null);
		expect(found.length).toEqual(1);
		expect(found[0].ps.length).toEqual(2);
	});

	it("should render all content", async () => {
		let text = await page.evaluate(() => {
			const pages = document.querySelectorAll(".paged_page");
			let t = "";
			pages.forEach((p) => (t += p.textContent));
			return t;
		});
		expect(text).toContain("Filler text before the avoid block");
		expect(text).toContain("Second paragraph of the unbreakable block");
		expect(text).toContain("Trailing text after the avoided block");
	});
});
