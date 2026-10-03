const TIMEOUT = 10000;

describe("initial-letter", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("initial-letter/initial-letter/initial-letter.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("enlarges the first letter", async () => {
		let sizes = await page.evaluate(() => {
			const cap = document.querySelector(".paged_initial_letter");
			return {
				capFontSize: cap ? window.getComputedStyle(cap).fontSize : "0px",
				bodyFontSize: window.getComputedStyle(document.body).fontSize,
			};
		});
		expect(parseFloat(sizes.capFontSize)).toBeGreaterThan(parseFloat(sizes.bodyFontSize));
	});
});
