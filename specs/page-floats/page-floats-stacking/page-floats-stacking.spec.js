const TIMEOUT = 10000;

describe("page-floats-stacking", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("page-floats/page-floats-stacking/page-floats-stacking.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("should render 1 page", async () => {
		let pages = await page.$$eval(".paged_page", (r) => r.length);
		expect(pages).toEqual(1);
	});

	it("should stack top floats in document order", async () => {
		let info = await page.$eval("[data-page-number='1']", (pg) => {
			let top = pg.querySelector(".paged_float_top");
			let ids = Array.from(top.children).map((c) => c.id);
			let rects = Array.from(top.children).map((c) =>
				c.getBoundingClientRect()
			);
			return { ids, stacked: rects[0].top < rects[1].top };
		});
		expect(info.ids).toEqual(["top-a", "top-b"]);
		expect(info.stacked).toBe(true);
	});

	it("should pin the bottom float below the top floats", async () => {
		let info = await page.$eval("[data-page-number='1']", (pg) => {
			let content = pg.querySelector(".paged_page_content");
			let c = content.querySelector(".paged_float_bottom #bot-c");
			let b = content.querySelector(".paged_float_top #top-b");
			let cRect = c.getBoundingClientRect();
			let bRect = b.getBoundingClientRect();
			return {
				inContainer: !!c,
				contentBottom: content.getBoundingClientRect().bottom,
				cBottom: cRect.bottom,
				bBottom: bRect.bottom,
				cTop: cRect.top,
			};
		});
		expect(info.inContainer).toBe(true);
		expect(Math.abs(info.cBottom - info.contentBottom)).toBeLessThanOrEqual(3);
		expect(info.bBottom).toBeLessThanOrEqual(info.cTop + 2);
	});
}
);
