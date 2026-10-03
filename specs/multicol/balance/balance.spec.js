const TIMEOUT = 15000;

describe("multicol-balance", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("multicol/balance/balance.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("should constrain intermediate fragments but balance the final one", async () => {
		let info = await page.$$eval(".paged_page section", (sections) =>
			sections.map((sec) => ({
				heightStyle: sec.style.height,
				scrollW: sec.scrollWidth,
				clientW: sec.clientWidth,
				text: sec.textContent.slice(0, 24),
			}))
		);
		expect(info.length).toBeGreaterThan(1);
		const constrained = info.filter((f) => f.heightStyle !== "");
		expect(constrained.length).toBe(info.length - 1);
		constrained.forEach((f) => {
			expect(f.scrollW).toBeLessThanOrEqual(f.clientW + 2);
		});
		const last = info[info.length - 1];
		expect(last.heightStyle).toEqual("");
		expect(last.scrollW).toBeLessThanOrEqual(last.clientW + 2);
	});

	it("should preserve all content", async () => {
		let text = await page.evaluate(() => {
			const pages = document.querySelectorAll(".paged_page");
			let t = "";
			pages.forEach((p) => (t += p.textContent));
			return t;
		});
		expect(text).toContain("Lorem ipsum dolor sit amet");
		expect(text).toContain("quo minus id quod maxime");
	});
});
