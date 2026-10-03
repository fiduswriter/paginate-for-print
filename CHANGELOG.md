# Changelog

## 0.10.0 (2026-09-01)

### Breaking

- **The public-API bundle is renamed**: `dist/paged.pdf.js` →
  `dist/paged.js`, `dist/paged.pdf.min.js` → `dist/paged.min.js`, and
  `types/paged.pdf.d.ts` → `types/paged.d.ts` (the "pdf" in the name was a
  leftover from when the bundle only wrapped the PDF export; it now carries
  the whole public API — `printHTML`, `renderHTML`, `htmlToPDF`). The package
  entry points are unchanged, so `import { htmlToPDF } from
  "paged-with-floats"` keeps working.

### Added

- **`leader()`** generated content for table-of-contents leaders.
- **`target-counters()`** for dotted hierarchical counter references (e.g.,
  `1.2.3`).
- **`target-counter()` URL fragment support**: `url(#id)` targets now resolve
  in addition to `attr(href)` lookups.
- **`string()` `first-except`** value, completing `first`/`last`/`start`/
  `first-except` support.
- **Running elements** now support `element(name, last|start|first-except)`,
  not only `first`.
- **`box-decoration-break: clone`** for split boxes (tables, inline elements).
- **`:recto` / `:verso` page selectors**, mapped to right/left pages.
- **`break-before` / `break-after: column`** for explicit column breaks inside
  manual-column pages.
- **Text wrapping around column floats**: `float-reference: column` with
  `float: left/right` is left to the browser's normal float behavior.
- **`initial-letter`** drop-caps support.
- **Rendering warnings** are returned to the client as `flow.warnings`:
  words that received an engine-inserted hyphen at a break point, and
  content protruding into the margin within the tolerance limit. The client
  application can ignore these notices or act on them.
- **Emergency word breaking**: words wider than their column are broken at
  an arbitrary character (`overflow-wrap: break-word` on column content)
  instead of protruding into the neighbouring column.

### Changed

- **Book demos updated** to showcase the new features: asymmetric `:recto` /
  `:verso` margins, `string(chapter, first-except)` running headers,
  `leader()` + `target-counter()` tables of contents, and `initial-letter`
  drop-caps in `examples/books/alice-2col.html` and
  `examples/books/frankenstein-3col.html`; `examples/books/moby-4col.html`
  uses a structured TOC with `target-counter()` page numbers alongside its
  existing page-float figure.
- **Improved `column-fill` balancing**: rows that end before a
  `column-span: all` element are now balanced (in addition to final and
  part-ending rows), as long as the balanced layout still fits.
- **Running-element override behavior preserved**: a higher-specificity margin
  rule whose running source has not appeared yet no longer clears content
  placed by a lower-specificity rule.
- **The Malay Archipelago demo** (`examples/multicol-floats.html`) extended
  with the contents overview, reception and influence sections plus three
  public-domain engravings from the 1869 first edition (Wikimedia Commons).

### Fixed

- **`target-counter()` page numbers** now resolve correctly when the function
  is used in `::after` / `::before` generated content (the counter is reset on
  the element itself so the pseudo-element can see it).
- **Chapters with `break-before: recto` now start on right-hand pages**
  reliably: page starts that begin at inter-element whitespace no longer skip
  the forced break, deferred `column-span` headings keep their side break,
  and the chunker consults the queued break node (falling back through the
  token node and the overflow node) when deciding whether blank verso pages
  are needed.
- **`break-before` / `break-after` side values no longer produce extra blank
  pages**: queued side breaks are not consulted while the token still carries
  overflow content to render, the forced-break queue is not carried across
  pages (the walk re-encounters queued nodes), and a side break on an empty
  page whose side already matches is satisfied in place.
- **"Unable to layout item" stalls** from vacuous break-token equality: the
  forced-break queue length now participates in token comparison.
- **Long lists fragmented across columns keep document order**: rebuilt
  overflow fragments are re-sorted by source position, and containers with
  interleaved text are left untouched by the reordering pass.
- **Height-probe leftovers no longer suppress generated content**: the
  `[data-split-to]` / `[data-split-from]` `::after`/`::before` suppression
  skips temporary (`temp-*`) split markers, so TOC entries keep their
  `target-counter()` page numbers.
- **Post-render audit accuracy**: images are awaited before the overflow
  audit runs, and the residual sweep clears stale range markers so overflow
  introduced by late-loading page floats is detected and extracted.
- **Initial-letter drop caps reserve their float height**: the avoid-adjacency
  check for `column-span` headings accounts for the drop cap's line count, so
  a heading plus its drop-cap paragraph are never squeezed onto a page tail.
- **Text-align-last / forced page break fixtures** no longer stall the
  renderer (`break-after: page` tokens end the page instead of advancing a
  column and losing the break).

## 0.9.0 (2026-08-28)

### Breaking

- **Public API reduced to three exports**: `printHTML`, `renderHTML`, and
  `htmlToPDF`. The `Previewer`, `registerHandlers`, and other internal symbols
  are no longer exported from the npm package.
- **Removed the `/pdf` subpath export**. Consumers must import from the root:
  ```ts
  import { printHTML, renderHTML, htmlToPDF } from "paged-with-floats";
  ```
- **Dropped non-ESM public-API builds**. The package no longer ships CJS or
  legacy browser bundles for the public API; `dist/paged.pdf.js` is ESM only.
  The pagination polyfill is still provided as `dist/paged.polyfill.js` (UMD).
- **`pages-to-pdf` is external** in the public-API bundle. Consumers of
  `htmlToPDF`/`printHTML` bring their own copy of `pages-to-pdf`; the bundle
  no longer embeds it.

### Added

- **`renderHTML(html, container, options)`**: a new helper that paginates a
  document and renders the result visibly inside a supplied DOM container. It
  is a convenience wrapper around `printHTML` with the new `renderTo` option.
- **`printHTML` gained a `renderTo` option**. When set, the pagination iframe
  is appended visibly to the given element instead of being hidden, making it
  easy to build live previews.
- **Source maps** are now emitted for the public-API bundle and the type
  declarations.

### Changed

- **Type declarations restricted to the public API**. The published `types/`
  folder now only contains declarations for `paged.pdf.ts` and `print.ts`;
  internal module types are no longer shipped.
- **NPM `files` whitelist tightened** to include only the public-API bundles,
  polyfill bundle, bundled fonts, public type files, source maps, and license
  files.
- **README rewritten** to document the new root-only public API.

## 0.8.0 (2026-08-28)

### Added

- **Footnote area height reservation**: before a page's columns are filled,
  the engine predicts what the page will hold and reserves the height the
  footnote area will need — each note probed at real layout width, the
  splitting paragraph's call positions refined via pretext line offsets and
  the estimate iterated to the smallest safe reserve. Extracting notes no
  longer shrinks already-laid-out columns, which previously spilled text and
  pushed whole blocks to the next page, leaving empty trailing columns.
  The footnotes handler treats the recorded reserve as a floor while the
  page fills and releases the unused remainder when the page is done.
- **Continuous footnote numbering across pages**: the footnotes handler
  seeds each page with the running marker count and the counters re-seed on
  the page's content area — required because `content-visibility: auto` on
  pages implies style containment, which isolates the page element's own
  counter state (spec behavior, identical in Chromium and Firefox). Markers
  and call anchors now number continuously across the whole document.
- **Part-end column balancing**: pages that end a part — a forced page break
  or a deferred `column-span: all` heading — are marked during layout, and
  their final manual-column row is converted to a native
  `column-fill: balance` multicol block after rendering (reverted when the
  balanced layout would overflow). Authors keep full control: an explicit
  `column-fill: auto` leaves the sequential fill untouched.
- **Footnote calls always travel with content**: overflow fragments that
  consist of a bare footnote-call anchor (the marker wrapped past the column
  edge on its own) are extended backward over the last word of the kept
  text, so a call never lands alone in an otherwise empty paragraph.
- **Footnote content survives page moves**: footnote elements in rebuilt
  overflow fragments are cloned with their content, and duplicate landings
  are dropped — empty marker shells no longer appear after a note's call
  crosses a page boundary, and marker numbers no longer drift +1 against
  their calls.
- **Developer tools** (`dev-tools/`): `find-lost-content.mjs` diffs source
  against rendered pages to locate lost or duplicated content,
  `inspect-pages.mjs` audits per-page/per-column geometry (scroll/client
  overflow, floats, notes), `dump-page.mjs` dumps per-column block text.
  `AGENTS.md` documents the repository conventions for AI agents.

### Fixed

- **Whitespace lost after inline elements**: the layout walker was
  re-created through `nodeAfter` after every deep clone (inline elements are
  deep-cloned), and `nodeAfter` treated whitespace-only text nodes as
  ignorable — spaces directly following `<i>`/`<b>`/`<span>` boundaries were
  never rendered, concatenating words ("entomologistWilliam").
  `nodeAfter` gained a `skipIgnorable` flag and the walker re-creation sites
  render those spaces; `findElement` also hardened against text nodes.
- **Footnote area doubled its footprint**: the flow host's `height: inherit`
  re-resolved the content area's `calc(100% − var(--paged-footnotes-height))`
  against its own containing block, so every pixel of footnote height
  removed two pixels of column space and each mid-page footnote extraction
  spilled double. The flow host now uses `height: 100%`.
- **Deferred page floats rendered twice**: the deferred queue now suppresses
  fresh clones of a float that is already queued, removing duplicated
  captions without restricting float deferral.
- **Lost / out-of-order content around footnote paragraph splits**: overflow
  ranges map back to the source across footnote extraction and split
  continuations (`indexOfTextNodeForOverflow`), residual overflow is
  coalesced to the next page in document order — including later rendered
  fragments of a kept split element — and carried overflow is rebuilt in
  source order instead of being dropped or duplicated.
- **Manual-column layout robustness**: column bounds account for top page
  floats (the engine no longer treats the full page height as available
  column space); runaway overflow collection bails out with a loop guard
  instead of hanging the page; page floats with images are preloaded so
  placement gets a real height; equal-height `column-span: all` segments are
  height-planned per page instead of sharing the page equally, and spans
  without room defer to the next page.
- **Overflow tolerance**: spills smaller than one line are accepted as
  tolerance slop (by the engine and the post-render audit) instead of
  failing, and the residual sweep grants the same bottom-margin slack the
  break verification uses — it no longer re-extracts lines the walk placed
  inside their parent's bottom-margin zone.
- **PDF export**: hyphenated words no longer overlap; text ranges split
  across lines are measured correctly.

### Changed

- **Breaking (JavaScript API)**: `emitPdfFromPagedjsWindow` renamed to
  `emitPdfFromPagedWindow`. `window.PagedPolyfill` is now actually defined —
  it exposes the running previewer instance, so the documented
  `window.PagedPolyfill.preview()` and its `on`/`off` event methods work
  (previously the global did not exist and the spec harness's rendered
  signal silently never fired).

### Internal

- Developer/agent workflow: `AGENTS.md` (repository conventions, layout
  invariants, debugging recipes) and a `PLAN.md`-driven multi-part workflow
  for the layout overhaul.
- Overflow bookkeeping tags are cleared per column, and bounds re-measure
  lazily via dirty-flagging (shared measurement batches per mutation).

## 0.7.0 (2026-08-26)

### Added

- **CSS multi-column support**: root-level (`body { column-count }`) and
  mid-flow blocks (`columns: 2`) fragment across pages with true column
  filling; `column-gap`, `column-rule-*` and `column-span: all` honored.
  `column-fill: balance` is applied to final fragments via a post-render
  rebalance pass. Nested multicol degrades to one column with a warning.
- **TypeScript throughout** (strict), shipped `.d.ts`; `main`/`exports`
  now point at built artifacts, `src/` ships as TypeScript reference.
- **Text-measurement backends**, selectable via
  `settings.textMeasurement`:
  - `"dom"` (default): legacy DOM word-walker; fastest in benchmarks.
  - `"pretext"`: predicted breaking via
    [@chenglou/pretext](https://github.com/chenglou/pretext) with
    per-break verification against real DOM rects and automatic legacy
    fallback; the whole document's texts are prepared once after fonts
    load, continuations reuse the prepared objects.
  - `"pretext"` + `verifyTextPrediction: false`: pure arithmetic breaks;
    audit output afterwards via `flow.overflowViolations` /
    `validateRenderedPages()`.
- **Print & PDF export** (`paged-with-floats/pdf`):
  - `printHTML(html, config)` — vivliostyle-print-compatible hidden-iframe
    pagination + printing.
  - `emitPdfFromPagedjsWindow(win)` — vivliostyle-pdf-style vector PDF
    emission (embedded subsetted fonts incl. WOFF/WOFF2, link
    annotations, outline, metadata) for pagedjs-paginated windows; does
    the same job as vivliostyle-pdf's `emitPdfFromVivliostyleWindow`.
  - `htmlToPDF(html, options)` — both steps composed into one call.
- **Performance**: frame-budgeted rendering (`settings.renderFrameBudget`,
  default 12 ms) — Moby Dick dom-mode pagination dropped ~44% (15.9 s →
  8.9 s); dirty-flag bounds caching in Layout.
- **Diagnostics**: `window.__pagedDomOps` DOM-read counters,
  `window.__pagedPredictStats` prediction counters, gated by
  `__PAGED_DEBUG` / `settings.debugDomOps`.
- Project Gutenberg benchmark/parity fixtures under
  `specs/fixtures/gutenberg/` (not part of the npm package).

### Changed

- **Breaking (CSS/DOM surface)**: all generated class names,
  custom properties, data attributes and element ids now use a `paged_` /
  `paged-` / `--paged-` prefix instead of `pagedjs_*` / `--pagedjs-*` /
  `data-pagedjs-*` (e.g. `.pagedjs_page` → `.paged_page`,
  `--pagedjs-width` → `--paged-width`). Debug globals renamed accordingly:
  `__PAGEDJS_DEBUG` → `__PAGED_DEBUG`. The JavaScript API globals
  (`window.Paged`, `window.PagedConfig`, `window.PagedPolyfill`) are
  unchanged.
- PDF render-baseline specs skip automatically when Ghostscript is not
  installed instead of failing; Docker baselines were regenerated on free
  fonts only (Microsoft core fonts removed from the image; spec fixtures'
  MS font names alias to metric-compatible Liberation families).
- Programmatic layout failures are reported with a warning instead of
  stopping silently.

### Internal

- Full codebase converted to strict TypeScript; eslint switched to
  typescript-eslint; jest transforms TS via babel; rollup builds through
  `@rollup/plugin-typescript`. Behavior verified against the pre-conversion
  baseline across the complete spec suite.
