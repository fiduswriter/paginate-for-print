const TIMEOUT = 30000; // The MathJax fixture is heavy; under full-suite
// parallel load the 10s default hook timeout flaked on fast machines.

describe("default", () => {
	let page;

	beforeAll(async () => {
		page = await loadPage("math/mathjax.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("mathjax elements should not throw an exception", async () => {
		let count = await page.$$eval("math" , (r) => {
			// eslint-disable-next-line no-console
			return r.length;
		});
		expect(count).toEqual(96);
	});
});
