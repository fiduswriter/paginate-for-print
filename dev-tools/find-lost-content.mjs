#!/usr/bin/env node
/**
 * Render any example (or spec fixture) HTML in headless Chromium and compare
 * the source text against the rendered output to find content that was lost
 * during pagination.
 *
 * The source is taken from the `#source` textarea when present (demo UI) or
 * from the file's body text (for examples the polyfill paginates directly).
 * Whitespace is collapsed and hyphens are stripped from both sides before a
 * greedy character-level alignment, so words the browser auto-hyphenated
 * across lines still match. Page margin boxes (running heads, page numbers)
 * are excluded from the rendered text.
 *
 * Usage:
 *   node dev-tools/find-lost-content.mjs <path-to-html> [--context <n>] [--port <n>]
 *
 * Examples:
 *   node dev-tools/find-lost-content.mjs examples/books/alice-2col.html
 *   node dev-tools/find-lost-content.mjs examples/multicol-floats.html
 *
 * Requires a build first (`npm run build`).
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import express from "express";
import { chromium } from "playwright-core";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const DEFAULT_PORT = 9998;

const args = process.argv.slice(2);
const htmlArg = args.find((a) => !a.startsWith("-"));
const contextIndex = args.indexOf("--context");
const CONTEXT = contextIndex >= 0 ? Number(args[contextIndex + 1]) : 60;
const minIndex = args.indexOf("--min");
const MIN_CHARS = minIndex >= 0 ? Number(args[minIndex + 1]) : 20;
const portIndex = args.indexOf("--port");
const PORT = portIndex >= 0 ? Number(args[portIndex + 1]) : DEFAULT_PORT;

	if (!htmlArg) {
	console.error(
		"usage: node dev-tools/find-lost-content.mjs <path-to-html> [--context <n>] [--min <n>] [--port <n>]",
	);
	process.exit(1);
}

/** Tokenize text into hyphen-stripped words; records each token's start offset
    in the original text. Whitespace and hyphenation characters are ignored so
    auto-hyphenated words and innerText/textContent spacing differences don't
    cause false gaps. */
function tokenize(text) {
	const words = [];
	const offsets = [];
	const re = /[^\s]+/g;
	let m;
	while ((m = re.exec(text)) !== null) {
		const raw = m[0];
		const stripped = raw.replace(/[-\u00AD\u2010\u2011]/g, "");
		if (stripped) {
			words.push(stripped);
			offsets.push(m.index);
		}
	}
	return { words, offsets };
}

/** Diff two word sequences with python3 difflib; returns [start, end) token
    index pairs of source words absent from the rendered text. */
function diffWords(sourceWords, renderedWords) {
	return new Promise((resolve, reject) => {
		const src = `${REPO}/dev-tools/.diff-source.tmp`;
		const rnd = `${REPO}/dev-tools/.diff-rendered.tmp`;
		fs.writeFileSync(src, sourceWords.join("\n"));
		fs.writeFileSync(rnd, renderedWords.join("\n"));
		const script = `
import json, sys, difflib
src = open(sys.argv[1], encoding="utf-8").read().splitlines()
rnd = open(sys.argv[2], encoding="utf-8").read().splitlines()
sm = difflib.SequenceMatcher(None, src, rnd, autojunk=False)
out = []
for tag, i1, i2, j1, j2 in sm.get_opcodes():
    if tag in ("delete", "replace") and i2 > i1:
        out.append([i1, i2])
print(json.dumps(out))
`;
		const py = spawn("python3", ["-c", script, src, rnd]);
		let out = "";
		let err = "";
		py.stdout.on("data", (d) => (out += d));
		py.stderr.on("data", (d) => (err += d));
		const timer = setTimeout(() => {
			py.kill();
			reject(new Error("python3 difflib timed out"));
		}, 120000);
		py.on("close", (code) => {
			clearTimeout(timer);
			fs.unlinkSync(src);
			fs.unlinkSync(rnd);
			if (code !== 0) {
				reject(new Error("python3 difflib failed: " + err));
				return;
			}
			try {
				resolve(JSON.parse(out));
			} catch (e) {
				reject(new Error("invalid difflib output: " + out.slice(0, 200)));
			}
		});
	});
}

const app = express();
app.use(express.static(REPO));
const server = app.listen(PORT);

const browser = await chromium.launch({
	headless: true,
	args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();

await page.goto(`http://localhost:${PORT}/${htmlArg}`, {
	waitUntil: "networkidle",
});
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

const { textareaValue, rendered, pageTexts } = await page.evaluate(() => {
	const textarea = document.getElementById("source");
	const textareaValue = textarea ? textarea.value : "";
	// content-visibility hides off-screen pages, which would truncate
	// innerText; force every page visible before reading.
	const style = document.createElement("style");
	style.textContent =
		".paged_page, .paged_page * { content-visibility: visible !important; }";
	document.head.appendChild(style);
	// Content only: page margin boxes (page numbers, running heads) are
	// UI additions and would pollute the diff. innerText inserts line breaks
	// between block elements so the text aligns with the source's whitespace.
	const contents = Array.from(
		document.querySelectorAll(".paged_page .paged_page_content"),
	);
	const rendered = contents.map((c) => c.innerText).join("\n");
	const pageTexts = Array.from(
		document.querySelectorAll(".paged_page"),
	).map((p) => ({
		page: p.dataset.pageNumber,
		text: p.innerText,
	}));
	return { textareaValue, rendered, pageTexts };
});

// The source is either the demo UI's `#source` textarea (which holds the
// document's HTML) or the file's body. Parse it with jsdom and drop footnote
// elements: footnotes are extracted out of the flow into the page's footnote
// area, which sits outside `.paged_page_content`.
const html = fs.readFileSync(path.join(REPO, htmlArg), "utf8");
const vc = new (await import("jsdom")).VirtualConsole();
const sourceDom = new JSDOM(html, { virtualConsole: vc });
let sourceEl = sourceDom.window.document.body;
if ((textareaValue ?? "").trim()) {
	const tDom = new JSDOM(textareaValue, { virtualConsole: vc });
	sourceEl = tDom.window.document.body;
}
let source = "";
if (sourceEl) {
	sourceEl
		.querySelectorAll("[data-note], .footnote")
		.forEach((el) => el.remove());
	source = sourceEl.textContent || "";
} else {
	source = textareaValue || "";
}

const src = tokenize(source);
const rnd = tokenize(rendered);

const gapRanges = await diffWords(src.words, rnd.words);

// Merge gaps separated by a short matched run (usually fragments of one
// lost block). difflib already aligns precisely, so only very close gaps
// are merged.
const merged = [];
for (const [a, b] of gapRanges) {
	const last = merged[merged.length - 1];
	if (last && a - last[1] <= 3) {
		last[1] = b;
	} else {
		merged.push([a, b]);
	}
}

const report = [];
for (const [gStart, gEnd] of merged) {
	const start = src.offsets[gStart] ?? source.length;
	const end =
		gEnd > 0
			? (src.offsets[gEnd - 1] ?? source.length) + src.words[gEnd - 1].length
			: start;
	const missing = source.slice(start, end);
	if (missing.length < MIN_CHARS) {
		continue;
	}
	const before = source.slice(Math.max(0, start - CONTEXT), start);
	const after = source.slice(end, end + CONTEXT);
	const normCtx = (t) =>
		t.replace(/\s+/g, " ").trim().slice(0, 80);
	// Locate the page whose text contains the content just before the gap.
	let page = null;
	if (before.trim()) {
		const probe = before.replace(/\s+/g, " ").trim().slice(-40);
		for (const p of pageTexts) {
			if (p.text.includes(probe)) {
				page = p.page;
				break;
			}
		}
	}
	report.push({
		length: missing.length,
		page,
		before: normCtx(before),
		missing: normCtx(missing),
		after: normCtx(after),
	});
}

await browser.close();
server.close();

if (report.length === 0) {
	console.log("No lost content detected.");
} else {
	console.log(`${report.length} gap(s) where source content is missing from the render:\n`);
	for (const r of report) {
		console.log(
			`- ${r.length} chars${r.page ? ` · page ${r.page}` : ""}: ${JSON.stringify(r.missing)}`,
		);
		if (r.before) console.log(`    before: ${JSON.stringify(r.before)}`);
		if (r.after) console.log(`    after:  ${JSON.stringify(r.after)}`);
		console.log("");
	}
}
