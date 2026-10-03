const TIMEOUT = 10000;

describe("target-counter with url()", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("target/target-counter/target-counter-url.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("resolves a url() fragment reference", async () => {
		let text = await page.$eval("#ref-call", (r) =>
			window.getComputedStyle(r, "::after").content,
		);
		expect(text).toContain("(See p. ");
	});
});
