#!/usr/bin/env node
/**
 * Probe footnote/column geometry per page for a demo HTML.
 */
import express from "express";
import { chromium } from "playwright-core";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const PORT = 9997;

const htmlArg = process.argv[2];
if (!htmlArg) {
	console.error("usage: node dev-tools/probe-footnotes.mjs <path-to-html>");
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
page.on("console", (msg) => {
	if (msg.type() === "warning" || msg.type() === "error") {
		console.log(`[console.${msg.type()}] ${msg.text()}`);
	}
});

await page.goto(`http://localhost:${PORT}/${htmlArg}`, {
	waitUntil: "networkidle",
});
await page
	.waitForFunction(() => document.querySelectorAll(".paged_page").length > 0, {
		timeout: 30000,
	})
	.catch(() => {});
let lastCount = 0;
let stableMs = 0;
while (stableMs < 1500) {
	await page.waitForTimeout(200);
	const count = await page.evaluate(
		() => document.querySelectorAll(".paged_page").length,
	);
	if (count === lastCount) {
		stableMs += 200;
	} else {
		stableMs = 0;
		lastCount = count;
	}
}

const geometry = await page.evaluate(() => {
	const result = [];
	document.querySelectorAll(".paged_page").forEach((pg) => {
		const area = pg.querySelector(".paged_area");
		const content = pg.querySelector(".paged_page_content");
		const flow = pg.querySelector(".paged_flow");
		const notesArea = pg.querySelector(".paged_footnote_area");
		const notesContent = pg.querySelector(".paged_footnote_content");
		const notesInner = pg.querySelector(".paged_footnote_inner_content");
		const topFloat = pg.querySelector(".paged_flow > .paged_float_top");
		const bottomFloat = pg.querySelector(".paged_flow > .paged_float_bottom");
		const spacer = pg.querySelector(".paged_flow > .paged_float_spacer");
		const columnsRow = pg.querySelector(".paged_flow > .paged_columns");
		const entry = {
			page: pg.dataset.pageNumber,
			notesVar: area ? area.style.getPropertyValue("--paged-footnotes-height") : null,
			contentH: content ? Math.round(content.getBoundingClientRect().height) : null,
			flowH: flow ? Math.round(flow.getBoundingClientRect().height) : null,
			rowH: columnsRow ? Math.round(columnsRow.getBoundingClientRect().height) : null,
			topFloatH: topFloat ? Math.round(topFloat.getBoundingClientRect().height) : 0,
			bottomFloatH: bottomFloat ? Math.round(bottomFloat.getBoundingClientRect().height) : 0,
			spacerH: spacer ? Math.round(spacer.getBoundingClientRect().height) : 0,
			notesAreaH: notesArea ? Math.round(notesArea.getBoundingClientRect().height) : null,
			notesContentScrollH: notesContent ? notesContent.scrollHeight : null,
			notesCount: notesInner ? notesInner.querySelectorAll("[data-note='footnote']").length : 0,
			noteLines: [],
			cols: [],
		};
		if (notesInner) {
			notesInner.querySelectorAll("[data-note='footnote']").forEach((n) => {
				entry.noteLines.push({
					ref: n.dataset.ref,
					h: Math.round(n.getBoundingClientRect().height),
					text: (n.textContent || "").trim().slice(0, 40),
				});
			});
		}
		pg.querySelectorAll(".paged_flow > .paged_columns").forEach((row) => {
			row.querySelectorAll(":scope > .paged_column").forEach((c) => {
				const range = document.createRange();
				range.selectNodeContents(c);
				const rect = range.getBoundingClientRect();
				const text = (c.textContent || "").replace(/\s+/g, " ").trim();
				entry.cols.push({
					col: c.dataset.pagedColumn,
					clientH: c.clientHeight,
					scrollH: c.scrollHeight,
					contentTop: rect.top !== 0 || rect.bottom !== 0 ? Math.round(rect.top) : null,
					contentBottom: rect.top !== 0 || rect.bottom !== 0 ? Math.round(rect.bottom) : null,
					start: text.slice(0, 50),
					end: text.slice(-50),
				});
			});
		});
		result.push(entry);
	});
	return result;
});

console.log(JSON.stringify(geometry, null, 1));

await browser.close();
server.close();
