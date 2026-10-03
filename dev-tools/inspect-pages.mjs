#!/usr/bin/env node
/**
 * Render any example (or spec fixture) HTML in headless Chromium with the
 * built polyfill and dump the paginated geometry plus console diagnostics.
 *
 * Useful for reproducing and debugging layout issues without opening a
 * browser: it reports, per page, the column boxes and their fill state
 * (scrollHeight vs clientHeight), any page floats, and console errors /
 * warnings such as "overflow collection guard exceeded", residual-overflow
 * sweep failures and "content outside its designated space".
 *
 * Usage:
 *   node dev-tools/inspect-pages.mjs <path-to-html> [options]
 *
 * Options:
 *   --status-only  Only print the status line and error summary.
 *   --json         Print the geometry as JSON instead of a readable report.
 *   --port <n>     Port for the static server (default 9998).
 *
 * Examples:
 *   node dev-tools/inspect-pages.mjs examples/books/alice-2col.html
 *   node dev-tools/inspect-pages.mjs examples/multicol-floats.html --json
 *   node dev-tools/inspect-pages.mjs specs/multicol/two-columns/two-columns.html
 *
 * Requires a build first (`npm run build`): the examples load
 * `dist/paged.polyfill.js`, which is gitignored and only exists after a build.
 */
import express from "express";
import { chromium } from "playwright-core";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const DEFAULT_PORT = 9998;
const OVERFLOW_TOLERANCE = 4;

const args = process.argv.slice(2);
const htmlArg = args.find((a) => !a.startsWith("-"));
const statusOnly = args.includes("--status-only");
const jsonOutput = args.includes("--json");
const portIndex = args.indexOf("--port");
const PORT = portIndex >= 0 ? Number(args[portIndex + 1]) : DEFAULT_PORT;

if (!htmlArg) {
	console.error(
		"usage: node dev-tools/inspect-pages.mjs <path-to-html> [--status-only] [--json] [--port <n>]",
	);
	process.exit(1);
}

const app = express();
app.use(express.static(REPO));
const server = app.listen(PORT);

const browser = await chromium.launch({
	headless: true,
	args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const page = await browser.newPage();
const logs = [];
page.on("console", (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
page.on("pageerror", (e) =>
	logs.push(`[pageerror] ${e.message}\n${e.stack}`),
);

await page.goto(`http://localhost:${PORT}/${htmlArg}`, {
	waitUntil: "networkidle",
});

// Wait for the polyfill to produce pages. Some demos show progress in
// #status ("Rendering…"); others (plain polyfill) render incrementally.
// Wait for both the status to settle and the page count to stop growing.
await page
	.waitForFunction(
		() => document.querySelectorAll(".paged_page").length > 0,
		{ timeout: 30000 },
	)
	.catch(() => {});
let lastCount = 0;
let stableMs = 0;
while (stableMs < 1500) {
	await page.waitForTimeout(200);
	const status = await page.evaluate(() => {
		const el = document.getElementById("status");
		return el ? el.textContent : "";
	});
	const count = await page.evaluate(
		() => document.querySelectorAll(".paged_page").length,
	);
	const settled = !status || !status.includes("Rendering");
	if (count === lastCount && settled) {
		stableMs += 200;
	} else {
		stableMs = 0;
		lastCount = count;
	}
}

const geometry = await page.evaluate(() => {
	const result = {
		status: document.getElementById("status")?.textContent ?? null,
		pages: [],
	};
	document.querySelectorAll(".paged_page").forEach((pg) => {
		const content = pg.querySelector(".paged_page_content");
		const flow = pg.querySelector(".paged_flow");
		const topFloat = pg.querySelector(".paged_flow > .paged_float_top");
		const contentRect = content ? content.getBoundingClientRect() : null;
		const entry = {
			page: pg.dataset.pageNumber,
			contentBottom: contentRect ? Math.round(contentRect.bottom) : null,
			topFloatHeight: topFloat
				? Math.round(topFloat.getBoundingClientRect().height)
				: 0,
			segments: [],
		};
		pg.querySelectorAll(".paged_flow > .paged_columns").forEach((row) => {
			const cols = [];
			row.querySelectorAll(":scope > .paged_column").forEach((c) => {
				const rect = c.getBoundingClientRect();
				const text = (c.textContent || "").replace(/\s+/g, " ").trim();
				cols.push({
					col: c.dataset.pagedColumn,
					top: Math.round(rect.top),
					bottom: Math.round(rect.bottom),
					clientHeight: c.clientHeight,
					scrollHeight: c.scrollHeight,
					overflow: c.scrollHeight - c.clientHeight,
					lastText: text.slice(-60),
				});
			});
			entry.segments.push({
				rowHeight: Math.round(row.getBoundingClientRect().height),
				inlineHeight: row.style.height || null,
				cols,
			});
		});
		result.pages.push(entry);
	});
	return result;
});

const issues = logs.filter(
	(l) =>
		l.includes("pageerror") ||
		l.includes("overflow collection guard") ||
		l.includes("residual overflow sweep failed") ||
		l.includes("content outside its designated space") ||
		l.includes("unable to layout item"),
);

const overflowCount = geometry.pages.reduce(
	(sum, p) =>
		sum +
		p.segments.reduce(
			(s, seg) =>
				s + seg.cols.filter((c) => c.overflow > OVERFLOW_TOLERANCE).length,
			0,
		),
	0,
);

if (jsonOutput) {
	console.log(JSON.stringify({ geometry, issues }, null, 1));
} else if (statusOnly) {
	console.log(
		`${geometry.pages.length} pages — ${overflowCount} overflowing column(s)` +
			(geometry.status ? ` — ${geometry.status}` : ""),
	);
	issues.forEach((i) => console.log("  ", i.split("\n")[0]));
} else {
	console.log(
		`${geometry.pages.length} page(s)` +
			(geometry.status ? ` — ${geometry.status}` : "") +
			` — ${overflowCount} overflowing column(s)`,
	);
	if (overflowCount) {
		for (const p of geometry.pages) {
			for (const seg of p.segments) {
				for (const c of seg.cols) {
					if (c.overflow > OVERFLOW_TOLERANCE) {
						console.log(
							`  page ${p.page} col ${c.col}: ${c.scrollHeight} vs ${c.clientHeight} (${c.overflow}px spill) — "${c.lastText}"`,
						);
					}
				}
			}
		}
	}
	if (issues.length) {
		console.log("\nconsole issues:");
		issues.forEach((i) => console.log("  " + i.split("\n")[0]));
	}
}

await browser.close();
server.close();
