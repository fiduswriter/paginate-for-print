const TIMEOUT = 10000;

describe("box-decoration-break", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("splits/box-decoration-break/box-decoration-break.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("preserves padding on every split fragment when clone is requested", async () => {
		let boxes = await page.$$eval(".box", (els) =>
			els.map((el) => ({
				paddingTop: window.getComputedStyle(el).paddingTop,
				paddingBottom: window.getComputedStyle(el).paddingBottom,
			})),
		);
		expect(boxes.length).toBeGreaterThanOrEqual(2);
		boxes.forEach((box) => {
			expect(box.paddingTop).toBe("20px");
			expect(box.paddingBottom).toBe("20px");
		});
	});

	it("preserves border on every split fragment when clone is requested", async () => {
		let boxes = await page.$$eval(".box", (els) =>
			els.map((el) => window.getComputedStyle(el).borderTopWidth),
		);
		expect(boxes.length).toBeGreaterThanOrEqual(2);
		boxes.forEach((border) => expect(border).toBe("4px"));
	});
});
