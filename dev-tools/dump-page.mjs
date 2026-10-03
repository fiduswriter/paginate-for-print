#!/usr/bin/env node
import express from "express";
import { chromium } from "playwright-core";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const PORT = 9998;
const htmlArg = process.argv[2];
const pageNum = process.argv[3];
if (!htmlArg || !pageNum) {
  console.error("usage: node dump-page.mjs <path-to-html> <page-number>");
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
await page.goto(`http://localhost:${PORT}/${htmlArg}`, { waitUntil: "networkidle" });
await page.waitForFunction(() => document.querySelectorAll(".paged_page").length > 0, { timeout: 60000 }).catch(() => {});
let lastCount = 0;
let stableMs = 0;
while (stableMs < 1500) {
  await page.waitForTimeout(200);
  const status = await page.evaluate(() => {
    const el = document.getElementById("status");
    return el ? el.textContent : "";
  });
  const count = await page.evaluate(() => document.querySelectorAll(".paged_page").length);
  const settled = !status || !status.includes("Rendering");
  if (count === lastCount && settled) stableMs += 200; else { stableMs = 0; lastCount = count; }
}

const info = await page.evaluate((num) => {
  const pg = document.querySelector(`.paged_page[data-page-number="${num}"]`);
  if (!pg) return { error: `page ${num} not found` };
  const flow = pg.querySelector(".paged_flow");
  const rows = Array.from(flow.querySelectorAll(":scope > .paged_columns"));
  return {
    rows: rows.map((row) => ({
      rowHeight: row.getBoundingClientRect().height,
      styleHeight: row.style.height,
      cols: Array.from(row.querySelectorAll(":scope > .paged_column")).map((c) => ({
        col: c.dataset.pagedColumn,
        clientHeight: c.clientHeight,
        scrollHeight: c.scrollHeight,
        overflow: c.scrollHeight - c.clientHeight,
        blocks: Array.from(c.children).map((b) => ({
          tag: b.tagName,
          ref: b.dataset?.ref,
          text: (b.textContent || "").slice(0, 200),
          attrs: Array.from(b.attributes).map((a) => `${a.name}=${a.value}`).join(","),
        })),
      })),
    })),
  };
}, pageNum);

console.log(JSON.stringify(info, null, 2));

await browser.close();
server.close();
