const TIMEOUT = 10000;

async function hasLeftWrapping(page, floatSelector) {
	return page.evaluate((selector) => {
		const figure = document.querySelector(selector);
		const column = figure?.closest(".paged_column");
		const paras = column?.querySelectorAll("p");
		const figureRect = figure?.getBoundingClientRect();
		if (!figureRect) {
			return false;
		}
		const range = document.createRange();
		for (const p of Array.from(paras || [])) {
			range.selectNodeContents(p);
			for (const r of Array.from(range.getClientRects())) {
				if (
					r.top < figureRect.bottom &&
					r.bottom > figureRect.top &&
					r.left > figureRect.left
				) {
					return true;
				}
			}
		}
		return false;
	}, floatSelector);
}

async function hasRightWrapping(page, floatSelector) {
	return page.evaluate((selector) => {
		const figure = document.querySelector(selector);
		const column = figure?.closest(".paged_column");
		const paras = column?.querySelectorAll("p");
		const figureRect = figure?.getBoundingClientRect();
		if (!figureRect) {
			return false;
		}
		const range = document.createRange();
		for (const p of Array.from(paras || [])) {
			range.selectNodeContents(p);
			for (const r of Array.from(range.getClientRects())) {
				if (
					r.top < figureRect.bottom &&
					r.bottom > figureRect.top &&
					r.right < figureRect.right
				) {
					return true;
				}
			}
		}
		return false;
	}, floatSelector);
}

describe("column-float-wrap", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("breaks/column-float-wrap/column-float-wrap.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("lets text wrap around a left column float", async () => {
		let wrapped = await hasLeftWrapping(page, ".figure-left");
		expect(wrapped).toBe(true);
	});

	it("lets text wrap around a right column float", async () => {
		let wrapped = await hasRightWrapping(page, ".figure-right");
		expect(wrapped).toBe(true);
	});
});
