const TIMEOUT = 10000;

describe("page-floats-bottom-basic", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("page-floats/page-floats-bottom-basic/page-floats-bottom-basic.html");
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

	it("should pin the figure to the bottom of the page content", async () => {
		let info = await page.$eval("[data-page-number='1']", (pg) => {
			let content = pg.querySelector(".paged_page_content");
			let bottom = content.querySelector(".paged_float_bottom");
			let fig = bottom.querySelector("#float-b");
			let contentRect = content.getBoundingClientRect();
			let figRect = fig ? fig.getBoundingClientRect() : null;
			let betaRect = document.getElementById("beta").getBoundingClientRect();
			let wrapper = content.querySelector(
				":scope > div:not(.paged_float_top):not(.paged_float_bottom)"
			);
			let spacer = wrapper
				? wrapper.querySelector(":scope > .paged_float_spacer")
				: null;
			return {
				inContainer: !!fig,
				contentBottom: contentRect.bottom,
				figBottom: figRect ? figRect.bottom : null,
				figHeight: figRect ? figRect.height : null,
				betaBottom: betaRect.bottom,
				spacerHeight: spacer ? spacer.offsetHeight : null,
			};
		});
		expect(info.inContainer).toBe(true);
		expect(Math.abs(info.figBottom - info.contentBottom)).toBeLessThanOrEqual(3);
		expect(info.betaBottom).toBeLessThanOrEqual(
			info.figBottom - info.figHeight + 2
		);
		expect(info.spacerHeight).not.toBeNull();
		expect(Math.abs(info.spacerHeight - info.figHeight)).toBeLessThanOrEqual(3);
	});

	it("should keep the flow above the reserved space", async () => {
		let overlap = await page.$eval("[data-page-number='1']", (pg) => {
			let content = pg.querySelector(".paged_page_content");
			let fig = content.querySelector(".paged_float_bottom #float-b");
			let figTop = fig.getBoundingClientRect().top;
			let wrapper = content.querySelector(
				":scope > div:not(.paged_float_top):not(.paged_float_bottom)"
			);
			// Measure the flow content only (the float containers now live
			// inside the flow host, so exclude them from the range).
			let flowContent = wrapper.querySelector(
				":scope > .paged_columns, :scope > :not(.paged_float_top):not(.paged_float_bottom):not(.paged_float_spacer)"
			);
			let range = document.createRange();
			range.selectNodeContents(flowContent || wrapper);
			return range.getBoundingClientRect().bottom > figTop + 2;
		});
		expect(overlap).toBe(false);
	});
}
);
