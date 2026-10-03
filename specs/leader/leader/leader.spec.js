const TIMEOUT = 10000;

describe("leader", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("leader/leader/leader.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("renders a dotted leader pseudo-element", async () => {
		let bg = await page.$eval(".toc a", (r) =>
			window.getComputedStyle(r, "::before").backgroundImage,
		);
		expect(bg).toContain("radial-gradient");
	});

	it("makes the leader pseudo-element flexible", async () => {
		let flex = await page.$eval(".toc a", (r) =>
			window.getComputedStyle(r, "::before").flexGrow,
		);
		expect(flex).toBe("1");
	});

	it("places the page number after the leader", async () => {
		let orderBefore = await page.$eval(".toc a", (r) =>
			window.getComputedStyle(r, "::before").order,
		);
		let orderAfter = await page.$eval(".toc a", (r) =>
			window.getComputedStyle(r, "::after").order,
		);
		expect(orderBefore).toBe("1");
		expect(orderAfter).toBe("2");
	});
});
