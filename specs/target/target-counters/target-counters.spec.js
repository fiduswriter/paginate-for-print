const TIMEOUT = 10000;

describe("target-counters", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("target/target-counters/target-counters.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("renders the hierarchical counter value as a dotted string", async () => {
		let text = await page.$eval(".toc a", (r) =>
			window.getComputedStyle(r, "::after").content,
		);
		expect(text).toContain("\"1.2\"");
	});
});
