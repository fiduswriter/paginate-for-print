<img style="display: block; margin: 3em auto;" src="assets/logo.svg" alt="paged-with-floats — a block floating above a paginated page"/>

[![CI](https://github.com/fiduswriter/paged-with-floats/actions/workflows/ci.yml/badge.svg)](https://github.com/fiduswriter/paged-with-floats/actions/workflows/ci.yml)

**Live demos:** <https://fiduswriter.github.io/paged-with-floats/>

paged-with-floats
==================

**paged-with-floats** is an open-source library to display paginated content
in the browser and to generate print books using web technology. It polyfills
the [Paged Media](https://www.w3.org/TR/css-page-3/) and
[Generated Content for Paged Media](https://www.w3.org/TR/css-gcpm-3/) CSS
modules — `@page` rules and page margin boxes, named pages, running headers
via `string()`, footnotes with `::footnote-call` / `::footnote-marker`,
target-counters, breaks and splits — and provides a handler and hook
architecture for building custom layout logic on top.

For a feature comparison with Vivliostyle, see [COMPARISON.md](./COMPARISON.md).

## CSS Page Floats

Elements can be pulled out of the normal flow and placed at the top or bottom
edge of the page on which their anchor appears, as specified by the
[CSS Page Floats](https://drafts.csswg.org/css-page-floats/) module:

```css
figure {
	float-reference: page;
	float: top; /* or bottom */
}
```

If there is not enough room left on the page, the float defers to the next
page while following content continues to fill the current one.

## Multi-column layout

CSS multi-column content is paginated. Both root-level flows and mid-document
blocks work:

```css
body {
	column-count: 2; /* whole document flows through two columns per page */
}

section {
	columns: 3; /* blocks may appear anywhere in a single-column flow */
}
```

Content fills column by column, continues onto further columns, then breaks
to the next page, where any partially-filled multicol block continues with
fresh columns. `column-gap`, `column-rule-*` and `column-span: all` are
honored (spanning works natively once the container is a real multicol
context). `column-fill: balance` is ignored on containers that fragment
across pages — they fill `auto`, except for an unfragmented final portion,
which balances naturally.

Not supported: nested multicol containers (a fragmentainer inside another is
degraded to one column with a console warning) and RTL column order.

`column-fill: balance` is honored on final pages: while a multicol block
spans pages it fills `auto` into the remaining space; once rendering
completes the last fragment's height constraint is released so its columns
balance — verified not to re-introduce overflow before the release sticks.
Manual-column documents balance the final row of the last page and of every
page that ends a part (a forced break or a deferred spanning heading), unless
the author set `column-fill: auto`.

## Footnotes

Elements with `float: footnote` move into a footnote area at the bottom of
the page, with a superscript call anchor left in the text:

```css
.footnote {
	float: footnote;
}

::footnote-call {
	vertical-align: super;
	font-size: 0.8em;
}

::footnote-marker {
	font-weight: bold;
}
```

The footnote area is sized before the page's columns are filled (its height
is estimated from the notes the page will extract), so note extraction never
re-flows already-laid-out text. `footnote-policy` (`line` / `block`) and
`footnote-display` (`block` / `inline`) are supported, notes that do not fit
move to the next page together with their calls, and markers number
continuously across pages.

## Text measurement

Three text-breaking backends are available via settings:

```js
window.PagedConfig = {
	settings: {
		textMeasurement: "dom", // default: legacy DOM walker (fastest)
		// textMeasurement: "pretext", // predicted breaking, verified
		verifyTextPrediction: false,  // pretext only: skip per-break probes
	},
};
```

- **`dom`** (default): the classic walker; measures words through DOM rects.
  Fastest in benchmarks across a five-book Project Gutenberg corpus.
- **`pretext`**: predicts break offsets arithmetically from cached canvas
  measurements ([pretext](https://github.com/chenglou/pretext)); the whole
  document's texts are prepared once after fonts load and continuations
  reuse those objects. Each prediction is verified against real DOM rects,
  falling back to the `dom` walker when inconsistent. Produces identical
  page output to `dom` on the full corpus at a small speed cost today; the
  architecture is the basis for upcoming features (column balancing,
  hyphenation search).
- **`pretext` + `verifyTextPrediction: false`**: accepts arithmetic breaks
  without probes. Post-render auditing guards quality: after `preview()`,
  `flow.overflowViolations` lists pages whose content ended up outside its
  designated space (`validateRenderedPages(pagesArea)` audits any output).

See `examples/measurement-benchmark.html` to compare modes on the same
document, `specs/fixtures/gutenberg/` for realistic corpora (public-domain
books; not part of the npm package), and `window.__pagedDomOps` /
`window.__pagedPredictStats` for read/prediction counters when debugging
(`settings.debugDomOps` enables the former).

Pagination work is coalesced into time-boxed animation frames
(`settings.renderFrameBudget`, default 12 ms) — raising it paginates faster
at the cost of UI responsiveness during rendering.

## Print & PDF export

The public API is published as the root export of the npm package and
exposes three helpers:

```ts
import { printHTML, renderHTML, htmlToPDF } from "paged-with-floats";

// 1. Paginate HTML in a hidden iframe, then print or process it.
printHTML(htmlDoc, {
	title: "my printed page",
	printCallback: (iframeWin) => iframeWin.print(), // optional
	errorCallback: (message) => alert(message),      // optional
});

// 2. Render the paginated result visibly inside a container on the page:
await renderHTML(
	htmlDoc,
	document.getElementById("preview-container"),
	{ title: "my preview", errorCallback: (message) => alert(message) }
);

// 3. Paginate and emit a real vector PDF in one call:
const bytes = await htmlToPDF(htmlDoc, {
	title: "My document",
});
download(new Blob([bytes], { type: "application/pdf" }));
```

For full control, paginate with `printHTML` (use `keepIframe: true`) and
pass the iframe window to `emitPdfFromWindow` from the separate
[`pages-to-pdf`](https://git.fiduswriter.org/fiduswriter/pages-to-pdf)
library (LGPL-3.0-or-later):

```ts
import { printHTML } from "paged-with-floats";
import { emitPdfFromWindow } from "pages-to-pdf";

const iframe = await printHTML(htmlDoc, {
	title: "My document",
	keepIframe: true,
	printCallback: (win) => {
		emitPdfFromWindow(win, console.log, {
			sourceHtml: htmlDoc,
			metadata: { title: "My document" },
		}).then((bytes) => download(new Blob([bytes])));
	},
});
```

`paged-with-floats` configures `pages-to-pdf` with the paged-with-floats
backend preset, so no explicit backend is required.

Fallback fonts for documents without `@font-face` rules are bundled in
`assets/fonts/` and copied to `dist/fonts/` at build time; exports that cannot
load them proceed without those fallbacks. Remote images require CORS-safe
URLs. See `examples/multicol-floats.html` for a print-ready demo combining
multicol, page floats and footnotes.

## TypeScript

The library is written in strict TypeScript and ships type declarations for
the public API:

```ts
import { printHTML, htmlToPDF, type PrintHTMLConfig } from "paged-with-floats";
```

## NPM Module
```sh
$ npm install paged-with-floats
```

```js
import { htmlToPDF } from "paged-with-floats";

const bytes = await htmlToPDF(`<!doctype html>
<html>
  <head><style>@page { size: A4; }</style></head>
  <body><p>Hello, paged media!</p></body>
</html>`, {
  title: "Hello",
});

// Download the PDF.
const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
const a = document.createElement("a");
a.href = url;
a.download = "hello.pdf";
a.click();
URL.revokeObjectURL(url);
```

## Polyfill

`printHTML` and `htmlToPDF` load the polyfill bundle automatically inside the
pagination iframe, so most consumers do not need to reference it directly.

To paginate a whole page in place (for example to add custom handlers or to
drive the layout from a plain HTML page), add the `paged.polyfill.js` script.
It replaces all `@page` CSS and renders the page with Paged Media styles
applied:

```html
<script src="https://unpkg.com/paged-with-floats/dist/paged.polyfill.js"></script>
```

By default the polyfill will run automatically as soon as the DOM is ready.
However, you can add an async `before` function or return a Promise to delay the polyfill starting.

```html
<script>
	window.PagedConfig = {
		before: () => {
			return new Promise((resolve, reject) => {
				setTimeout(() => { resolve() }, 1000);
			})
		},
		after: (flow) => { console.log("after", flow) },
	};
</script>
```

Otherwise you can disable `auto` running the previewer and call `window.PagedPolyfill.preview();`
whenever you want to start.

```html
<script>
	window.PagedConfig = {
		auto: false,
		after: (flow) => { console.log("after", flow) },
	};

	setTimeout(() => {
		window.PagedPolyfill.preview();
	}, 1000);
</script>
```

## Chunker
Chunks up a document into paged media flows and applies print classes.

## Polisher
Converts `@page` css to classes, and applies counters and content.

## Module

Modules are groups of handlers that apply the layout and styles of a CSS
module, such as Generated Content or Page Floats.

When the polyfill bundle (`dist/paged.polyfill.js`) runs it exposes a global
`Paged` object; custom handlers can be registered on the page that loads the
polyfill:

```html
<script src="https://unpkg.com/paged-with-floats/dist/paged.polyfill.js"></script>
<script>
	class MyHandler extends Paged.Handler {
		constructor(chunker, polisher, caller) {
			super(chunker, polisher, caller);
		}

		afterPageLayout(pageFragment, page) {
			console.log(pageFragment);
		}
	}
	Paged.registerHandlers(MyHandler);
</script>
```

Handlers have methods that correspond to the hooks for the parsing, layout and rendering of the Chunker and Polisher. Returning a promise or `async` function from a method in a handler will complete that task before continuing with the other registered methods for that hook.

```js
// Previewer
beforePreview(content, renderTo)
afterPreview(pages)

// Chunker
beforeParsed(content)
filter(content)
afterParsed(parsed)
beforePageLayout(page)
onPageLayout(pageWrapper, breakToken, layout);
afterPageLayout(pageElement, page, breakToken)
finalizePage(pageElement, page, breakToken)
afterRendered(pages)

// Polisher
beforeTreeParse(text, sheet)
beforeTreeWalk(ast)
afterTreeWalk(ast, sheet)
onUrl(urlNode)
onAtPage(atPageNode)
onRule(ruleNode)
onDeclaration(declarationNode, ruleNode)
onContent(contentNode, declarationNode, ruleNode)

// Layout
layoutNode(node)
renderNode(node, sourceNode, layout)
onOverflow(overflow, rendered, bounds)
onBreakToken(breakToken, overflow, rendered)
afterOverflowRemoved(removed, rendered)
beforeRenderResult(breakToken, pageWrapper)
```

## How paged-with-floats processes content

Chunker.flow()\
└── Chunker.render() -> Looping through all pages\
└──── Chunker.layout*() -> Handles overflowing pages, adding new ones\
└────── Page.layout() -> Creates new Layout and waits for new Breaktoken\
└──────── Layout.renderTo() -> Iterates through nodes\
└────────── Layout.findBreakToken() -> Tries to find overflow/breaktoken

## Setup
Install dependencies
```sh
$ npm install
```

## Development
Run the local dev-server with livereload and autocompile on [http://localhost:9090/](http://localhost:9090/)
```sh
$ npm start
```

## Deployment
Build the `dist` output
```sh
$ npm run build
```

Compile the `lib` output
```sh
$ npm run compile
```

Generate legacy builds with polyfills included
```sh
$ npm run legacy
```

## Testing

Testing uses [Jest](https://facebook.github.io/jest/en/) but is split into Tests and Specs.

### Tests

Unit tests for Chunker and Polisher methods are run in node using JSDOM.

```bash
npm test
```

### Specs

Specs run a html file in Chrome (using playwright) to test against CSS specifications.

There are two tiers:

**DOM specs** (`npm run specs-dom`) assert rendered page structure and run
anywhere — no extra system dependencies. This includes all of the page floats
tests as well as a growing set of the older suites. CI runs these on every
push.

```bash
npm run specs-dom
```

**PDF render-baseline specs** (`npm run specs`) additionally output a pdf and
compare pages (one at a time) against stored baseline images. Pixel
comparisons only stay meaningful when Chromium, fonts, freetype and
Ghostscript are pinned, so these are best run inside the Docker container
(see below), which provides that environment. Where Ghostscript is not
available these tests skip automatically instead of failing — locally,
`npm run specs` reports them as skipped and everything else runs green.

```bash
npm run docker-specs
```

To regenerate the baselines after an intentional rendering change:

```bash
npm run docker-update-specs
```

The image uses only free fonts: fixtures referencing Times New Roman /
Arial / Courier New resolve to the metric-compatible Liberation families
via fontconfig aliases — no Microsoft fonts are installed.

If you prefer to run the PDF comparison suite outside Docker, you need a
local Ghostscript for your system according to https://www.npmjs.com/package/ghostscript4js#prerequisites

For Mac you can install it with

```bash
brew install ghostscript
```

For Debian you can install it with

```bash
sudo apt-get install ghostscript
sudo apt-get install libgs-dev
```

Now you can install the `ghostscript4js` library. For Linux you can optionally pass the location ghostscript was installed to in `GS4JS_HOME`.

```bash
GS4JS_HOME="/usr/lib/$(gcc -dumpmachine)" npm install ghostscript4js
```

To test the pdf output of specs, you'll need to build the library locally.

```bash
npm run build
```

Then run the jest tests in puppeteer.

```bash
npm run specs
```

To debug the results of a test in a browser you can add `NODE_ENV=debug`

```bash
NODE_ENV=debug npm run specs
```

To update the stored pdf images you can run

```bash
npm run specs -- --updateSnapshot
```

### Docker

The Docker image exists for one purpose: it pins Chromium, the font set,
freetype behavior and Ghostscript so that the PDF render-baseline comparisons
stay deterministic across machines. It is used by `npm run docker-specs`,
`npm run docker-update-specs` and by the `render-specs` job in CI. The image
can also serve as a development server, but Docker is not required for
development or publishing.

The render-baseline jobs build the image themselves; to build it manually run

```bash
docker build -t paged-with-floats .
```

By default the container will run the development server with `npm start`

```bash
docker run -it -p 9090:9090 paged-with-floats
```

## License

Everything generated as part of **paged-with-floats** — all modifications and
additions made in this repository, including the complete page floats
implementation — is

> Copyright (C) 2026 Johannes Wilm

and licensed under the **GNU Lesser General Public License, version 3 or later
(LGPL-3.0-or-later)**. The full license texts are included in this repository
as [`COPYING.LESSER`](./COPYING.LESSER) (LGPL-3.0) and [`COPYING`](./COPYING)
(GPL-3.0, which the LGPL incorporates); see also
<https://www.gnu.org/licenses/>. The project's history as a Paged.js fork and
the replacement of all upstream-derived code are documented in
[`LICENSE.md`](./LICENSE.md), the
[Acknowledgments](./ACKNOWLEDGMENTS.md), and
[`MIT_LICENSE_TRACKING.md`](./MIT_LICENSE_TRACKING.md).

## Acknowledgments

This library builds on the work of many contributors to the open-source
paginated-media ecosystem. The full credits are in
[`ACKNOWLEDGMENTS.md`](./ACKNOWLEDGMENTS.md).
