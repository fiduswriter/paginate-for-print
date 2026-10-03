const TIMEOUT = 15000;

describe("multicol-section-split", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("multicol/section-split/section-split.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("should split the multicol section across more than one page", async () => {
		let info = await page.$$eval(".paged_page", (pages) =>
			pages.map((pg) => {
				const sec = pg.querySelector("section");
				return {
					id: pg.id,
					hasSection: !!sec,
					text: pg.textContent.replace(/\s+/g, " "),
				};
			})
		);
		const withSection = info.filter((p) => p.hasSection);
		expect(withSection.length).toBeGreaterThan(1);
	});

	it("should keep each page's section fragment in two columns without off-page spill", async () => {
		let info = await page.$$eval(".paged_page section", (sections) =>
			sections.map((sec) => {
				const xs = new Set();
				sec.querySelectorAll("p").forEach((p) => {
					Array.from(p.getClientRects()).forEach(function (r) {
						xs.add(Math.round(r.left));
					});
				});
				return {
					scrollWidth: sec.scrollWidth,
					clientWidth: sec.clientWidth,
					distinctLefts: Array.from(xs).sort((a, b) => a - b).length,
				};
			})
		);
		info.forEach((frag) => {
			expect(frag.scrollWidth).toBeLessThanOrEqual(frag.clientWidth + 2);
			expect(frag.distinctLefts).toBeLessThanOrEqual(2);
		});
	});

	it("should preserve all section content across the split", async () => {
		let text = await page.evaluate(() => {
			const pages = document.querySelectorAll(".paged_page");
			let t = "";
			pages.forEach((p) => (t += p.textContent));
			return t;
		});
		expect(text).toContain("Lorem ipsum dolor sit amet");
		expect(text).toContain("Quis autem vel eum iure reprehenderit");
	});

	it("should start the section content on page 1 and continue it later", async () => {
		let texts = await page.$$eval(".paged_page", (pages) =>
			pages.map((p) => p.textContent)
		);
		expect(texts[0]).toContain("Lorem ipsum dolor sit amet");
		expect(texts[texts.length - 1]).toContain("Quis autem vel eum");
	});
});
