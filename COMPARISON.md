# How paged-with-floats compares to Vivliostyle

[Vivliostyle](https://vivliostyle.org/) is the most complete open-source CSS
typesetting engine available today. This library does not attempt to match it,
and if its license terms work for you, you should generally prefer it.

## License

Vivliostyle.js is licensed under the
[GNU AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html) — a strong copyleft
license that also applies when the software is used to serve content over a
network: applications and services built on it must make their source
available under compatible terms. **paged-with-floats is licensed under the
GNU LGPL-3.0-or-later**, which permits using and embedding the library in
applications of any kind — including proprietary ones — provided the library
itself remains free and replaceable. If your project cannot accept AGPL
terms, that is the reason this library exists.

## Features

Vivliostyle implements substantially more of the CSS standards than this
library does. Its [Supported CSS Features](https://docs.vivliostyle.org/en/reference/supported-css-features/)
reference documents the full picture. The table below summarizes how the two
projects cover the CSS specifications most relevant to paged media.

| Feature / CSS module | Vivliostyle | paged-with-floats | Notes |
|---|---|---|---|
| **CSS Paged Media 3** | | | |
| `@page` rules, `size`, `bleed`, `marks` | ✅ Full | ✅ Full | |
| Page-margin boxes (`@top-left`, `@top-center`, …) | ✅ Full | ✅ Full | |
| Page selectors `:left`, `:right` | ✅ Full | ✅ Full | |
| Page selectors `:first`, `:blank`, `:nth()` | ✅ Full | ⚠️ Basic | Vivliostyle also supports `:nth(An+B of <page-type>)` page-group matching. |
| Named pages (`page` property) | ✅ Full | ✅ Full | |
| Page-based counters (`page`, `pages`) | ✅ Full | ✅ Full | |
| `:recto` / `:verso` page selectors | ✅ Full | ✅ Full | |
| Non-standard crop/inside-outside margin properties | ✅ Full | ❌ None | `crop-offset`, `crop-marks-line-color`, `margin-inside`/`margin-outside`, etc. |
| **CSS Fragmentation** | | | |
| `break-before` / `break-after` | ✅ Full | ⚠️ Partial | paged-with-floats supports `page`/`always`/`left`/`right`/`recto`/`verso`, `column`, and `avoid`; not `region`. |
| `break-inside: avoid` | ✅ Full | ✅ Basic | Vivliostyle treats `avoid-page`/`avoid-column`/`avoid-region` as `avoid`. |
| `box-decoration-break` | ✅ Full | ✅ Full | |
| `margin-break` | ✅ Full | ❌ None | |
| **CSS Multi-column Layout** | | | |
| `column-count`, `columns`, `column-gap`, `column-rule-*` | ✅ Full | ✅ Full | |
| `column-span: all` | ✅ Full | ✅ Full | Vivliostyle root multicol only spans page floats; non-root multicol is unrestricted. |
| `column-fill` | ✅ Full | ⚠️ Partial | paged-with-floats balances the final fragment, part-ending rows, and rows that end before a `column-span: all`. |
| Nested multicol containers | ✅ Full | ❌ None | paged-with-floats degrades the inner container to one column. |
| RTL / vertical column order | ✅ Full | ❌ None | |
| **CSS Page Floats** | | | |
| Basic page floats (`float-reference: page; float: top/bottom`) | ✅ Full | ⚠️ Partial | paged-with-floats stacks floats as blocks; text does not wrap around them. |
| Logical / corner float values (`block-start`, `inline-start`, `snap-block`, combinations) | ✅ Full | ❌ None | paged-with-floats accepts `block-start`/`block-end` as aliases for top/bottom only. |
| `float-reference: column` / `region` | ✅ Full | ⚠️ Partial | paged-with-floats wraps text around `float: left/right` in columns; other values are not supported. |
| Extended `clear` values (`block-start`, `same`, etc.) | ✅ Full | ❌ None | |
| `float-min-wrap-block` | ✅ Full | ❌ None | Non-standard property. |
| Text wrapping around page floats | ✅ Full | ❌ None | |
| **CSS Generated Content for Paged Media 3** | | | |
| Footnotes (`float: footnote`) | ✅ Full | ✅ Basic | paged-with-floats: `footnote-policy: auto/line/block`; `footnote-display: block/inline`. |
| `::footnote-call` / `::footnote-marker` | ✅ Full | ✅ Full | |
| `@footnote` rule | ✅ Full | ✅ Full | |
| `string-set` / `string()` | ✅ Full | ✅ Full | paged-with-floats supports `first`/`last`/`start`/`first-except`. |
| Running elements (`position: running()` / `content: element()`) | ✅ Full | ✅ Full | paged-with-floats supports `first`/`last`/`start`/`first-except`. |
| `target-counter()` | ✅ Full | ✅ Full | paged-with-floats supports `attr()` and `url()` target lookups. |
| `target-counters()` | ✅ Full | ✅ Full | |
| `target-text()` | ✅ Full | ⚠️ Partial | paged-with-floats supports `attr()`-based lookups and a limited set of styles. |
| `leader()` | ✅ Full | ✅ Full | |
| `content()` function | ✅ Full | ❌ None | |
| **CSS Writing Modes 3** | | | |
| Vertical writing, `writing-mode`, `direction`, RTL | ✅ Full | ❌ None | paged-with-floats assumes horizontal top-to-bottom text. |
| **Other typesetting features** | | | |
| `initial-letter` | ✅ Full | ✅ Full | |
| `repeat-on-break` (CSS Repeated Headers and Footers proposal) | ✅ Full | ❌ None | Non-standard. |
| EPUB Adaptive Layout (`@-epubx-*`) | ✅ Full | ❌ None | Non-standard. |

As far as the maintainers are aware, all major standardized CSS paged-media
features are implemented by Vivliostyle; the gaps listed above are gaps in
paged-with-floats rather than features missing from both engines.

In short: use **Vivliostyle** for maximum standards coverage and typesetting
fidelity; use **paged-with-floats** when the LGPL license is required and the
feature set described above is sufficient for your needs.

## Documentation and CLI

For documentation of the CSS standards implemented here — which properties
and values exist, and how they are specified to behave — use Vivliostyle's
[Supported CSS Features](https://docs.vivliostyle.org/en/reference/supported-css-features/)
reference and the rest of the [Vivliostyle documentation](https://docs.vivliostyle.org/en/);
they are the most complete available documentation of practical CSS paged
media typesetting.

A hands-on overview to getting started with CSS typesetting is available in
the [Vivliostyle tutorials](https://vivliostyle.org/tutorials/) and the
[Vivliostyle samples](https://vivliostyle.org/samples/).

This library itself does not ship a command line tool. For rendering HTML/CSS
documents to PDF from the command line, [Vivliostyle CLI](https://github.com/vivliostyle/vivliostyle-cli)
([documentation](https://docs.vivliostyle.org/en/cli/)) is the most capable
open-source option; it works with any HTML/CSS document, independently of this
library.
