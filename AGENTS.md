# AGENTS.md

Guidance for AI agents and contributors working in this repository.

## Project overview

`paged-with-floats` is a fork of Paged.js. It chunks a document into paged-media
flows in the browser, applies print CSS (`@page`, page floats, footnotes,
multi-column layout, `column-span`), and can export the result to PDF.

The core value-add over upstream Paged.js is **CSS page floats** and solid
**multi-column / `column-span`** support. Layout changes almost always touch
the chunker; visual/demo issues are usually reproduced with the examples
under `examples/`.

## Commands

```sh
npm run build    # rollup bundle into dist/ + copy PDF fonts
npm run compile  # babel src/ -> lib/ (CJS)
npm run lint     # eslint -c .eslintrc.json src specs
npm test         # lint + tsc --noEmit + jest
npm start        # rollup watch + dev server (examples)
```

- Typecheck: `npx tsc --noEmit`
- DOM specs: `npx jest --config=specs/jest.config.js <pattern>`
  (e.g. `page-floats`, `multicol`, `notes`, `multicol/column-span`)
- Full spec suite: `npm run specs` (runs build + compile first)

**`dist/` and `lib/` are gitignored and not committed.** Specs load
`dist/paged.polyfill.js`, so after changing `src/` you must run
`npm run build` before running specs or looking at the examples.

## Repository layout

- `src/chunker/` — the pagination engine.
  - `chunker.ts` — document chunker, page/render orchestration.
  - `layout.ts` — the layout engine: filling columns, overflow detection
    (`findOverflow`, `findBreakToken`, `extractResidualOverflow`,
    `sweepResidualColumnOverflow`), manual columns, `column-span`, break tokens.
    This is the largest and most delicate file.
  - `page.ts` — page wrapper creation, manual column boxes
    (`buildManualColumns`, `createWrapper`).
  - `breaktoken.ts`, `overflow.ts` — break/overflow data models.
- `src/polisher/` — CSS layer: parses `@page`/paged-media CSS and injects the
  polyfill stylesheet (`base.ts`). It decides whether to use manual columns
  (`column-count` on the root) and registers properties like
  `--paged-footnotes-height`.
- `src/modules/paged-media/` — behavior modules: `page-floats.ts`, `footnotes.ts`,
  `columns.ts`, `page-margin-boxes.ts`, page counters, etc.
- `src/pdf/` — PDF export (`pdf-emitter.ts` draws text from DOM geometry).
- `src/utils/` — DOM/layout helpers (`dom.ts`, `layout.ts`, `font.ts`, …).
- `examples/` — standalone HTML demos (e.g. `multicol-floats.html`,
  `books/alice-2col.html`). Run `npm start` and open them.
- `specs/` — jest specs, run in Chromium via Playwright. Each DOM spec is a
  `*.spec.js` + `*.html` pair under a directory; the HTML loads
  `../../../dist/paged.polyfill.js` and the spec asserts on the rendered DOM.
  Some suites use `it_snapshots` to render PDFs; those need Ghostscript and
  are skipped otherwise.

## The manual-column layout model

When `column-count` is set on the page root, the polyfill builds an explicit
DOM structure per page instead of relying on CSS multicol:

```
.paged_pagebox > .paged_area
  .paged_page_content
    .paged_flow                 (display:flex; flex-direction:column; height:inherit)
      .paged_float_top          (top page floats)
      .paged_columns            (one row of columns; multiple rows after a column-span)
        .paged_column           (width: calc((100% - (N-1)*gap)/N); height:100%)
      .paged_float_bottom
  .paged_footnote_area
```

Key invariants to keep in mind when touching `layout.ts`:

- **Manual-column bounds** are computed in `Layout.manualColumnBounds()` and
  must match the column's *actual* box (which flex already sizes for the top
  float and `column-span` segments). Using the full flow-host height here makes
  segment columns accept the whole page and overlap following content.
- **Overflow detection** reads `scrollHeight` against `bounds`; a page can also
  end with residual overflow (footnote-area growth, split-paragraph re-wrap),
  handled by `sweepResidualColumnOverflow()` → `extractResidualOverflow()`.
- **`column-span: all`** splits the page into multiple `.paged_columns` rows
  (segments); the walker fills them in order. See `applyColumnSpan` /
  `isColumnSpan` in `layout.ts`.
- **Segment heights are planned, not equal.** `Layout.planSegmentHeights`
  estimates each upcoming segment's natural height once per page (pretext
  line counts from the `ElementMeasure` records captured in
  `prepareTextsEagerly`, plus a probe-host DOM measurement for tables/images)
  and fixes rows at `flex: 0 0 <h>px`; only the last segment on a page stays
  flexible (`flex: 1 1 0`). Completed segments are shrink-corrected to their
  measured content extent when a span opens, and spans with no planned room
  are deferred (`shouldDeferColumnSpan`). Fixed rows must never be shrunk by
  later spans — a flexible row that is filled tall and then shrunk spills
  content its last column cannot absorb.
- **Page floats** are placed during the walk via the `renderNode` hook in
  `src/modules/paged-media/page-floats.ts`; top floats sit above the columns
  and shrink the available column height.

## Conventions

- TypeScript in `src/`, plain JS in `specs/`.
- Indent with tabs; semicolons required; `console.warn`/`console.error` only
  (no `console.log`).
- Comments are `/** ... */` JSDoc style; JSDoc completeness is not linted
  (the `valid-jsdoc` rule is off).
- Commit messages are short, lowercase, imperative sentences
  (e.g. "don't state page to be finished before being done with the last
  column").

## Debugging layout issues

The examples are the fastest repro path:

- `examples/multicol-floats.html` — page floats in two columns (float +
  footnotes + `hyphens: auto` interaction).
- `examples/books/alice-2col.html` — two-column book with `column-span: all`
  headings.

`npm start` serves the examples; the polyfill rebuilds on watch. For geometry
debugging, drive a headless browser (playwright-core is a devDependency) and
read `getBoundingClientRect()`/`scrollHeight`/`clientHeight` on the
`.paged_flow`, `.paged_columns`, and `.paged_column` elements, then filter
console messages for `paged-with-floats:` warnings.
