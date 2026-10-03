/**
 * The polyfill's baseline stylesheet, inserted verbatim by
 * src/polisher/polisher.ts into a <style data-paged-inserted-styles="true">
 * element in document.head during `Polisher.setup()`.
 *
 * Contents (behaviorally reproduced by executing the previous build as a
 * black-box oracle and observing the stylesheet it inserts at runtime):
 * `:root` custom-property defaults, the `@page { size: letter; margin: 0 }`
 * baseline, the sheet/bleed/marks grid, pagebox + margin boxes,
 * content/flow/column boxes, footnote call and marker styles, page and
 * footnote counters, split-element cleanups, and the print media block.
 *
 * No imports, no named exports, no classes, no side effects at import time.
 * The sole export is this one default string.
 */

const baseStyles: string = `
:root {
	--paged-width: 8.5in;
	--paged-height: 11in;
	--paged-width-right: 8.5in;
	--paged-height-right: 11in;
	--paged-width-left: 8.5in;
	--paged-height-left: 11in;
	--paged-pagebox-width: 8.5in;
	--paged-pagebox-height: 11in;
	--paged-footnotes-height: 0mm;
	--paged-margin-top: 1in;
	--paged-margin-right: 1in;
	--paged-margin-bottom: 1in;
	--paged-margin-left: 1in;
	--paged-padding-top: 0mm;
	--paged-padding-right: 0mm;
	--paged-padding-bottom: 0mm;
	--paged-padding-left: 0mm;
	--paged-border-top: 0mm;
	--paged-border-right: 0mm;
	--paged-border-bottom: 0mm;
	--paged-border-left: 0mm;
	--paged-bleed-top: 0mm;
	--paged-bleed-right: 0mm;
	--paged-bleed-bottom: 0mm;
	--paged-bleed-left: 0mm;
	--paged-bleed-right-top: 0mm;
	--paged-bleed-right-right: 0mm;
	--paged-bleed-right-bottom: 0mm;
	--paged-bleed-right-left: 0mm;
	--paged-bleed-left-top: 0mm;
	--paged-bleed-left-right: 0mm;
	--paged-bleed-left-bottom: 0mm;
	--paged-bleed-left-left: 0mm;
	--paged-crop-color: black;
	--paged-crop-shadow: white;
	--paged-crop-offset: 2mm;
	--paged-crop-stroke: 1px;
	--paged-cross-size: 5mm;
	--paged-mark-cross-display: none;
	--paged-mark-crop-display: none;
	--paged-page-count: 0;
	--paged-page-counter-increment: 1;
	--paged-footnotes-count: 0;
	--paged-column-gap-offset: 1000px;
}

@page {
	size: letter;
	margin: 0;
}

.paged_sheet {
	box-sizing: border-box;
	width: var(--paged-width);
	height: var(--paged-height);
	overflow: hidden;
	position: relative;
	display: grid;
	grid-template-columns: [bleed-left] var(--paged-bleed-left) [sheet-center] calc(var(--paged-width) - var(--paged-bleed-left) - var(--paged-bleed-right)) [bleed-right] var(--paged-bleed-right);
	grid-template-rows: [bleed-top] var(--paged-bleed-top) [sheet-middle] calc(var(--paged-height) - var(--paged-bleed-top) - var(--paged-bleed-bottom)) [bleed-bottom] var(--paged-bleed-bottom);
}

.paged_right_page .paged_sheet {
	width: var(--paged-width-right);
	height: var(--paged-height-right);
	grid-template-columns: [bleed-left] var(--paged-bleed-right-left) [sheet-center] calc(var(--paged-width) - var(--paged-bleed-right-left) - var(--paged-bleed-right-right)) [bleed-right] var(--paged-bleed-right-right);
	grid-template-rows: [bleed-top] var(--paged-bleed-right-top) [sheet-middle] calc(var(--paged-height) - var(--paged-bleed-right-top) - var(--paged-bleed-right-bottom)) [bleed-bottom] var(--paged-bleed-right-bottom);
}

.paged_left_page .paged_sheet {
	width: var(--paged-width-left);
	height: var(--paged-height-left);
	grid-template-columns: [bleed-left] var(--paged-bleed-left-left) [sheet-center] calc(var(--paged-width) - var(--paged-bleed-left-left) - var(--paged-bleed-left-right)) [bleed-right] var(--paged-bleed-left-right);
	grid-template-rows: [bleed-top] var(--paged-bleed-left-top) [sheet-middle] calc(var(--paged-height) - var(--paged-bleed-left-top) - var(--paged-bleed-left-bottom)) [bleed-bottom] var(--paged-bleed-left-bottom);
}

.paged_bleed {
	display: flex;
	align-items: center;
	justify-content: center;
	flex-wrap: nowrap;
	overflow: hidden;
}

.paged_bleed-top {
	grid-column: bleed-left / -1;
	grid-row: bleed-top;
	flex-direction: row;
}

.paged_bleed-bottom {
	grid-column: bleed-left / -1;
	grid-row: bleed-bottom;
	flex-direction: row;
}

.paged_bleed-left {
	grid-column: bleed-left;
	grid-row: bleed-top / -1;
	flex-direction: column;
}

.paged_bleed-right {
	grid-column: bleed-right;
	grid-row: bleed-top / -1;
	flex-direction: column;
}

.paged_marks-crop {
	display: var(--paged-mark-crop-display);
	flex-grow: 0;
	flex-shrink: 0;
	z-index: 9999999999;
}

.paged_bleed-top .paged_marks-crop:nth-child(1),
.paged_bleed-bottom .paged_marks-crop:nth-child(1) {
	width: calc(var(--paged-bleed-left) - var(--paged-crop-stroke));
	border-right: var(--paged-crop-stroke) solid var(--paged-crop-color);
	box-shadow: 1px 0px 0px 0px var(--paged-crop-shadow);
}

.paged_right_page .paged_bleed-top .paged_marks-crop:nth-child(1),
.paged_right_page .paged_bleed-bottom .paged_marks-crop:nth-child(1) {
	width: calc(var(--paged-bleed-right-left) - var(--paged-crop-stroke));
}

.paged_left_page .paged_bleed-top .paged_marks-crop:nth-child(1),
.paged_left_page .paged_bleed-bottom .paged_marks-crop:nth-child(1) {
	width: calc(var(--paged-bleed-left-left) - var(--paged-crop-stroke));
}

.paged_bleed-top .paged_marks-crop:nth-child(3),
.paged_bleed-bottom .paged_marks-crop:nth-child(3) {
	width: calc(var(--paged-bleed-right) - var(--paged-crop-stroke));
	border-left: var(--paged-crop-stroke) solid var(--paged-crop-color);
	box-shadow: -1px 0px 0px 0px var(--paged-crop-shadow);
}

.paged_right_page .paged_bleed-top .paged_marks-crop:nth-child(3),
.paged_right_page .paged_bleed-bottom .paged_marks-crop:nth-child(3) {
	width: calc(var(--paged-bleed-right-right) - var(--paged-crop-stroke));
}

.paged_left_page .paged_bleed-top .paged_marks-crop:nth-child(3),
.paged_left_page .paged_bleed-bottom .paged_marks-crop:nth-child(3) {
	width: calc(var(--paged-bleed-left-right) - var(--paged-crop-stroke));
}

.paged_bleed-top .paged_marks-crop {
	align-self: flex-start;
	height: calc(var(--paged-bleed-top) - var(--paged-crop-offset));
}

.paged_right_page .paged_bleed-top .paged_marks-crop {
	height: calc(var(--paged-bleed-right-top) - var(--paged-crop-offset));
}

.paged_left_page .paged_bleed-top .paged_marks-crop {
	height: calc(var(--paged-bleed-left-top) - var(--paged-crop-offset));
}

.paged_bleed-bottom .paged_marks-crop {
	align-self: flex-end;
	height: calc(var(--paged-bleed-bottom) - var(--paged-crop-offset));
}

.paged_right_page .paged_bleed-bottom .paged_marks-crop {
	height: calc(var(--paged-bleed-right-bottom) - var(--paged-crop-offset));
}

.paged_left_page .paged_bleed-bottom .paged_marks-crop {
	height: calc(var(--paged-bleed-left-bottom) - var(--paged-crop-offset));
}

.paged_bleed-left .paged_marks-crop:nth-child(1),
.paged_bleed-right .paged_marks-crop:nth-child(1) {
	height: calc(var(--paged-bleed-top) - var(--paged-crop-stroke));
	border-bottom: var(--paged-crop-stroke) solid var(--paged-crop-color);
	box-shadow: 0px 1px 0px 0px var(--paged-crop-shadow);
}

.paged_right_page .paged_bleed-left .paged_marks-crop:nth-child(1),
.paged_right_page .paged_bleed-right .paged_marks-crop:nth-child(1) {
	height: calc(var(--paged-bleed-right-top) - var(--paged-crop-stroke));
}

.paged_left_page .paged_bleed-left .paged_marks-crop:nth-child(1),
.paged_left_page .paged_bleed-right .paged_marks-crop:nth-child(1) {
	height: calc(var(--paged-bleed-left-top) - var(--paged-crop-stroke));
}

.paged_bleed-left .paged_marks-crop:nth-child(3),
.paged_bleed-right .paged_marks-crop:nth-child(3) {
	height: calc(var(--paged-bleed-bottom) - var(--paged-crop-stroke));
	border-top: var(--paged-crop-stroke) solid var(--paged-crop-color);
	box-shadow: 0px -1px 0px 0px var(--paged-crop-shadow);
}

.paged_right_page .paged_bleed-left .paged_marks-crop:nth-child(3),
.paged_right_page .paged_bleed-right .paged_marks-crop:nth-child(3) {
	height: calc(var(--paged-bleed-right-bottom) - var(--paged-crop-stroke));
}

.paged_left_page .paged_bleed-left .paged_marks-crop:nth-child(3),
.paged_left_page .paged_bleed-right .paged_marks-crop:nth-child(3) {
	height: calc(var(--paged-bleed-left-bottom) - var(--paged-crop-stroke));
}

.paged_bleed-left .paged_marks-crop {
	width: calc(var(--paged-bleed-left) - var(--paged-crop-offset));
	align-self: flex-start;
}

.paged_right_page .paged_bleed-left .paged_marks-crop {
	width: calc(var(--paged-bleed-right-left) - var(--paged-crop-offset));
}

.paged_left_page .paged_bleed-left .paged_marks-crop {
	width: calc(var(--paged-bleed-left-left) - var(--paged-crop-offset));
}

.paged_bleed-right .paged_marks-crop {
	width: calc(var(--paged-bleed-right) - var(--paged-crop-offset));
	align-self: flex-end;
}

.paged_right_page .paged_bleed-right .paged_marks-crop {
	width: calc(var(--paged-bleed-right-right) - var(--paged-crop-offset));
}

.paged_left_page .paged_bleed-right .paged_marks-crop {
	width: calc(var(--paged-bleed-left-right) - var(--paged-crop-offset));
}

.paged_marks-middle {
	display: flex;
	flex-grow: 1;
	flex-shrink: 0;
	align-items: center;
	justify-content: center;
}

.paged_marks-cross {
	display: var(--paged-mark-cross-display);
	background-image: url(data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0idXRmLTgiPz48IURPQ1RZUEUgc3ZnIFBVQkxJQyAiLS8vVzNDLy9EVEQgU1ZHIDEuMS8vRU4iICJodHRwOi8vd3d3LnczLm9yZy9HcmFwaGljcy9TVkcvMS4xL0RURC9zdmcxMS5kdGQiPjxzdmcgdmVyc2lvbj0iMS4xIiBpZD0iTGF5ZXJfMSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiB4bWxuczp4bGluaz0iaHR0cDovL3d3dy53My5vcmcvMTk5OS94bGluayIgeD0iMHB4IiB5PSIwcHgiIHdpZHRoPSIzMi41MzdweCIgaGVpZ2h0PSIzMi41MzdweCIgdmlld0JveD0iMC4xMDQgMC4xMDQgMzIuNTM3IDMyLjUzNyIgZW5hYmxlLWJhY2tncm91bmQ9Im5ldyAwLjEwNCAwLjEwNCAzMi41MzcgMzIuNTM3IiB4bWw6c3BhY2U9InByZXNlcnZlIj48cGF0aCBmaWxsPSJub25lIiBzdHJva2U9IiNGRkZGRkYiIHN0cm9rZS13aWR0aD0iMy4zODkzIiBzdHJva2UtbWl0ZXJsaW1pdD0iMTAiIGQ9Ik0yOS45MzEsMTYuMzczYzAsNy40ODktNi4wNjgsMTMuNTYtMTMuNTU4LDEzLjU2Yy03LjQ4MywwLTEzLjU1Ny02LjA3Mi0xMy41NTctMTMuNTZjMC03LjQ4Niw2LjA3NC0xMy41NTQsMTMuNTU3LTEzLjU1NEMyMy44NjIsMi44MTksMjkuOTMxLDguODg3LDI5LjkzMSwxNi4zNzN6Ii8+PGxpbmUgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjRkZGRkZGIiBzdHJva2Utd2lkdGg9IjMuMzg5MyIgc3Ryb2tlLW1pdGVybGltaXQ9IjEwIiB4MT0iMC4xMDQiIHkxPSIxNi4zNzMiIHgyPSIzMi42NDIiIHkyPSIxNi4zNzMiLz48bGluZSBmaWxsPSJub25lIiBzdHJva2U9IiNGRkZGRkYiIHN0cm9rZS13aWR0aD0iMy4zODkzIiBzdHJva2UtbWl0ZXJsaW1pdD0iMTAiIHgxPSIxNi4zNzMiIHkxPSIwLjEwNCIgeDI9IjE2LjM3MyIgeTI9IjMyLjY0MiIvPjxwYXRoIGZpbGw9Im5vbmUiIHN0cm9rZT0iI0ZGRkZGRiIgc3Ryb2tlLXdpZHRoPSIzLjM4OTMiIHN0cm9rZS1taXRlcmxpbWl0PSIxMCIgZD0iTTI0LjUwOCwxNi4zNzNjMCw0LjQ5Ni0zLjYzOCw4LjEzNS04LjEzNSw4LjEzNWMtNC40OTEsMC04LjEzNS0zLjYzOC04LjEzNS04LjEzNWMwLTQuNDg5LDMuNjQ0LTguMTM1LDguMTM1LTguMTM1QzIwLjg2OSw4LjIzOSwyNC41MDgsMTEuODg0LDI0LjUwOCwxNi4zNzN6Ii8+PHBhdGggZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwMDAwIiBzdHJva2Utd2lkdGg9IjAuNjc3OCIgc3Ryb2tlLW1pdGVybGltaXQ9IjEwIiBkPSJNMjkuOTMxLDE2LjM3M2MwLDcuNDg5LTYuMDY4LDEzLjU2LTEzLjU1OCwxMy41NmMtNy40ODMsMC0xMy41NTctNi4wNzItMTMuNTU3LTEzLjU2YzAtNy40ODYsNi4wNzQtMTMuNTU0LDEzLjU1Ny0xMy41NTRDMjMuODYyLDIuODE5LDI5LjkzMSw4Ljg4NywyOS45MzEsMTYuMzczeiIvPjxsaW5lIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzAwMDAwMCIgc3Ryb2tlLXdpZHRoPSIwLjY3NzgiIHN0cm9rZS1taXRlcmxpbWl0PSIxMCIgeDE9IjAuMTA0IiB5MT0iMTYuMzczIiB4Mj0iMzIuNjQyIiB5Mj0iMTYuMzczIi8+PGxpbmUgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwMDAwIiBzdHJva2Utd2lkdGg9IjAuNjc3OCIgc3Ryb2tlLW1pdGVybGltaXQ9IjEwIiB4MT0iMTYuMzczIiB5MT0iMC4xMDQiIHgyPSIxNi4zNzMiIHkyPSIzMi42NDIiLz48cGF0aCBkPSJNMjQuNTA4LDE2LjM3M2MwLDQuNDk2LTMuNjM4LDguMTM1LTguMTM1LDguMTM1Yy00LjQ5MSwwLTguMTM1LTMuNjM4LTguMTM1LTguMTM1YzAtNC40ODksMy42NDQtOC4xMzUsOC4xMzUtOC4xMzVDMjAuODY5LDguMjM5LDI0LjUwOCwxMS44ODQsMjQuNTA4LDE2LjM3MyIvPjxsaW5lIGZpbGw9Im5vbmUiIHN0cm9rZT0iI0ZGRkZGRiIgc3Ryb2tlLXdpZHRoPSIwLjY3NzgiIHN0cm9rZS1taXRlcmxpbWl0PSIxMCIgeDE9IjguMjM5IiB5MT0iMTYuMzczIiB4Mj0iMjQuNTA4IiB5Mj0iMTYuMzczIi8+PGxpbmUgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjRkZGRkZGIiBzdHJva2Utd2lkdGg9IjAuNjc3OCIgc3Ryb2tlLW1pdGVybGltaXQ9IjEwIiB4MT0iMTYuMzczIiB5MT0iOC4yMzkiIHgyPSIxNi4zNzMiIHkyPSIyNC41MDgiLz48L3N2Zz4=);
  background-repeat: no-repeat;
  background-position: 50% 50%;
  background-size: var(--paged-cross-size);

  z-index: 2147483647;
	width: var(--paged-cross-size);
	height: var(--paged-cross-size);
}

.paged_pagebox {
	box-sizing: border-box;
	width: var(--paged-pagebox-width);
	height: var(--paged-pagebox-height);
	position: relative;
	display: grid;
	grid-template-columns: [left] var(--paged-margin-left) [center] calc(var(--paged-pagebox-width) - var(--paged-margin-left) - var(--paged-margin-right)) [right] var(--paged-margin-right);
	grid-template-rows: [header] var(--paged-margin-top) [page] calc(var(--paged-pagebox-height) - var(--paged-margin-top) - var(--paged-margin-bottom)) [footer] var(--paged-margin-bottom);
	grid-column: sheet-center;
	grid-row: sheet-middle;
}

.paged_pagebox * {
	box-sizing: border-box;
}

.paged_margin-top {
	width: calc(var(--paged-pagebox-width) - var(--paged-margin-left) - var(--paged-margin-right));
	height: var(--paged-margin-top);
	grid-column: center;
	grid-row: header;
	flex-wrap: nowrap;
	display: grid;
	grid-template-columns: repeat(3, 1fr);
	grid-template-rows: 100%;
}

.paged_margin-top-left-corner-holder {
	width: var(--paged-margin-left);
	height: var(--paged-margin-top);
	display: flex;
	grid-column: left;
	grid-row: header;
}

.paged_margin-top-right-corner-holder {
	width: var(--paged-margin-right);
	height: var(--paged-margin-top);
	display: flex;
	grid-column: right;
	grid-row: header;
}

.paged_margin-top-left-corner {
	width: var(--paged-margin-left);
}

.paged_margin-top-right-corner {
	width: var(--paged-margin-right);
}

.paged_margin-right {
	height: calc(var(--paged-pagebox-height) - var(--paged-margin-top) - var(--paged-margin-bottom));
	width: var(--paged-margin-right);
	right: 0;
	grid-column: right;
	grid-row: page;
	display: grid;
	grid-template-rows: repeat(3, 33.3333%);
	grid-template-columns: 100%;
}

.paged_margin-bottom {
	width: calc(var(--paged-pagebox-width) - var(--paged-margin-left) - var(--paged-margin-right));
	height: var(--paged-margin-bottom);
	grid-column: center;
	grid-row: footer;
	display: grid;
	grid-template-columns: repeat(3, 1fr);
	grid-template-rows: 100%;
}

.paged_margin-bottom-left-corner-holder {
	width: var(--paged-margin-left);
	height: var(--paged-margin-bottom);
	display: flex;
	grid-column: left;
	grid-row: footer;
}

.paged_margin-bottom-right-corner-holder {
	width: var(--paged-margin-right);
	height: var(--paged-margin-bottom);
	display: flex;
	grid-column: right;
	grid-row: footer;
}

.paged_margin-bottom-left-corner {
	width: var(--paged-margin-left);
}

.paged_margin-bottom-right-corner {
	width: var(--paged-margin-right);
}



.paged_margin-left {
	height: calc(var(--paged-pagebox-height) - var(--paged-margin-top) - var(--paged-margin-bottom));
	width: var(--paged-margin-left);
	grid-column: left;
	grid-row: page;
	display: grid;
	grid-template-rows: repeat(3, 33.33333%);
	grid-template-columns: 100%;
}

.paged_pages .paged_pagebox .paged_margin:not(.hasContent) {
	visibility: hidden;
}

.paged_pagebox > .paged_area {
	grid-column: center;
	grid-row: page;
	width: 100%;
	height: 100%;
	padding: var(--paged-padding-top) var(--paged-padding-right) var(--paged-padding-bottom) var(--paged-padding-left);
	border-top: var(--paged-border-top);
	border-right: var(--paged-border-right);
	border-bottom: var(--paged-border-bottom);
	border-left: var(--paged-border-left);
}

.paged_pagebox > .paged_area > .paged_page_content {
	width: 100%;
	height: calc(100% - var(--paged-footnotes-height));
	position: relative;
	column-fill: auto;
}

.paged_pagebox > .paged_area > .paged_page_content > div:not(.paged_float_top):not(.paged_float_bottom) {
	/* height: 100%, NOT inherit: the content area's specified height is a
	   calc() containing a percentage, and inherit takes that computed
	   (still percentage-bearing) value and resolves it against this box's
	   own containing block — subtracting the footnote height a second time
	   and doubling every mid-page footnote growth into a column spill. */
	height: 100%;
}

/* Float containers as direct children of the content area (single-column
   pages): classic structure. */
.paged_pagebox > .paged_area > .paged_page_content > .paged_float_top,
.paged_pagebox > .paged_area > .paged_page_content > .paged_float_bottom {
	display: flow-root;
}

.paged_pagebox > .paged_area > .paged_page_content > .paged_float_top {
	width: 100%;
}

.paged_pagebox > .paged_area > .paged_page_content > .paged_float_bottom {
	position: absolute;
	left: 0;
	right: 0;
	bottom: 0;
}

/* The flow host: a block holding the float containers and (for root-level
   multicol) manual column rows. Columns are content-sized; the layout
   engine detects overflow against the host's vertical extent, so no CSS
   column-count is ever needed. */
.paged_pagebox > .paged_area > .paged_page_content > .paged_flow {
	/* height: 100%, not inherit — see the note on the classic wrapper
	   above: inherit re-resolves the content area's calc() height against
	   this box's own containing block, subtracting the footnote height a
	   second time. */
	height: 100%;
	position: relative;
	display: flex;
	flex-direction: column;
}

.paged_pagebox > .paged_area > .paged_page_content > .paged_flow > .paged_float_top {
	width: 100%;
	flex: 0 0 auto;
}

.paged_pagebox > .paged_area > .paged_page_content > .paged_flow > .paged_float_bottom {
	position: absolute;
	left: 0;
	right: 0;
	bottom: 0;
}

.paged_pagebox > .paged_area > .paged_page_content > .paged_flow > .paged_columns {
	display: flex;
	flex: 1 1 0;
	min-height: 0;
}

.paged_pagebox > .paged_area > .paged_page_content > .paged_flow > .paged_columns > .paged_column {
	flex: 0 0 auto;
	height: 100%;
}

/* Emergency word breaking: a word wider than its column is broken at an
   arbitrary character instead of protruding into the neighbouring column
   (the analogue of TeX's last-resort emergency box handling). This only
   activates when a word cannot fit on a line by itself; ordinary text and
   linguistic hyphenation are unaffected. */
.paged_pagebox > .paged_area > .paged_page_content > .paged_flow,
.paged_pagebox > .paged_area > .paged_page_content > .paged_flow > .paged_columns > .paged_column {
	overflow-wrap: break-word;
}

.paged_pagebox > .paged_area > .paged_page_content > .paged_flow > .paged_float_spacer {
	height: auto;
	flex: 0 0 auto;
}

/* Safety net: the host document must never be a CSS multi-column container.
   Author rules on the book fragment are stripped by the Columns handler, but
   demo/host CSS or inline styles can still set column-count on body/html and
   break the manual column engine. This reset is intentionally !important so
   it cannot be overridden by stray host styles. */
html, body {
	column-count: auto !important;
	column-width: auto !important;
	columns: auto !important;
}

.paged_pagebox > .paged_area > .paged_footnote_area {
	position: relative;
	overflow: hidden;
	height: var(--paged-footnotes-height);
	display: flex;
    justify-content: flex-end;
    flex-flow: column;
}

.paged_pagebox > .paged_area > .paged_footnote_area > .paged_footnote_content {
	overflow: hidden;
}

.paged_pagebox > .paged_area > .paged_footnote_area > .paged_footnote_inner_content {
	overflow: hidden;
}

.paged_area [data-footnote-call] {
	all: unset;
	counter-increment: footnote;
}

.paged_area [data-split-from] {
	counter-increment: unset;
	counter-reset: unset;
}

[data-footnote-call]::after {
	vertical-align: super;
	font-size: 65%;
	line-height: normal;
	content: counter(footnote);
}

@supports ( font-variant-position: super ) {
	[data-footnote-call]::after {
		vertical-align: baseline;
		font-size: 100%;
		line-height: inherit;
		font-variant-position: super;
	}
}

.paged_footnote_empty {
	display: none;
}

.paged_area [data-split-from] {
	counter-increment: unset;
	counter-reset: unset;
}

[data-footnote-marker] {
	text-indent: 0;
	display: list-item;
	list-style-position: inside;
}

[data-footnote-marker][data-split-from] {
	list-style: none;
}

[data-footnote-marker]:not([data-split-from]) {
	counter-increment: footnote-marker;
}

[data-footnote-marker]::marker {
	content: counter(footnote-marker) ". ";
}

[data-footnote-marker][data-split-from]::marker {
	content: unset;
}

.paged_area .paged_footnote_inner_content [data-note-display="inline"] {
 	display: inline;
}

.paged_page {
	counter-increment: page var(--paged-page-counter-increment);
	width: var(--paged-width);
	height: var(--paged-height);
}

/* Footnote counters are re-seeded on every page's area from the running
   count the footnotes handler writes into --paged-footnotes-count on the
   page element. The reset must live on .paged_area (a descendant), not on
   .paged_page: pages use content-visibility: auto, which implies style
   containment — the page's own counter state is isolated from its rendered
   subtree, so a reset there is ignored by the markers and calls (they
   restart at 1 in every engine). A reset on a descendant of the
   content-visibility element is honored. */
.paged_area {
	counter-reset: footnote var(--paged-footnotes-count) footnote-marker var(--paged-footnotes-count);
}

.paged_page.paged_right_page {
	width: var(--paged-width-right);
	height: var(--paged-height-right);
}

.paged_page.paged_left_page {
	width: var(--paged-width-left);
	height: var(--paged-height-left);
}

.paged_pages {
	counter-reset: pages var(--paged-page-count) footnote var(--paged-footnotes-count) footnote-marker var(--paged-footnotes-count);
}

.paged_pagebox .paged_margin-top-left-corner,
.paged_pagebox .paged_margin-top-right-corner,
.paged_pagebox .paged_margin-bottom-left-corner,
.paged_pagebox .paged_margin-bottom-right-corner,
.paged_pagebox .paged_margin-top-left,
.paged_pagebox .paged_margin-top-right,
.paged_pagebox .paged_margin-bottom-left,
.paged_pagebox .paged_margin-bottom-right,
.paged_pagebox .paged_margin-top-center,
.paged_pagebox .paged_margin-bottom-center,
.paged_pagebox .paged_margin-top-center,
.paged_pagebox .paged_margin-bottom-center,
.paged_margin-right-middle,
.paged_margin-left-middle  {
	display: flex;
	align-items: center;
}

.paged_margin-right-top,
.paged_margin-left-top  {
	display: flex;
	align-items: flex-top;
}


.paged_margin-right-bottom,
.paged_margin-left-bottom  {
	display: flex;
	align-items: flex-end;
}



/*
.paged_pagebox .paged_margin-top-center,
.paged_pagebox .paged_margin-bottom-center {
	height: 100%;
	display: none;
	align-items: center;
	flex: 1 0 33%;
	margin: 0 auto;
}

.paged_pagebox .paged_margin-top-left-corner,
.paged_pagebox .paged_margin-top-right-corner,
.paged_pagebox .paged_margin-bottom-right-corner,
.paged_pagebox .paged_margin-bottom-left-corner {
	display: none;
	align-items: center;
}

.paged_pagebox .paged_margin-left-top,
.paged_pagebox .paged_margin-right-top {
	display: none;
	align-items: flex-start;
}

.paged_pagebox .paged_margin-right-middle,
.paged_pagebox .paged_margin-left-middle {
	display: none;
	align-items: center;
}

.paged_pagebox .paged_margin-left-bottom,
.paged_pagebox .paged_margin-right-bottom {
	display: none;
	align-items: flex-end;
}
*/

.paged_pagebox .paged_margin-top-left,
.paged_pagebox .paged_margin-top-right-corner,
.paged_pagebox .paged_margin-bottom-left,
.paged_pagebox .paged_margin-bottom-right-corner { text-align: left; }

.paged_pagebox .paged_margin-top-left-corner,
.paged_pagebox .paged_margin-top-right,
.paged_pagebox .paged_margin-bottom-left-corner,
.paged_pagebox .paged_margin-bottom-right { text-align: right; }

.paged_pagebox .paged_margin-top-center,
.paged_pagebox .paged_margin-bottom-center,
.paged_pagebox .paged_margin-left-top,
.paged_pagebox .paged_margin-left-middle,
.paged_pagebox .paged_margin-left-bottom,
.paged_pagebox .paged_margin-right-top,
.paged_pagebox .paged_margin-right-middle,
.paged_pagebox .paged_margin-right-bottom { text-align: center; }

.paged_pages .paged_margin .paged_margin-content {
	width: 100%;
}

.paged_pages .paged_margin-left .paged_margin-content::after,
.paged_pages .paged_margin-top .paged_margin-content::after,
.paged_pages .paged_margin-right .paged_margin-content::after,
.paged_pages .paged_margin-bottom .paged_margin-content::after {
	display: block;
}

.paged_pages > .paged_page > .paged_sheet > .paged_pagebox > .paged_area > div [data-split-to]:not([data-paged-box-decoration="clone"]) {
	margin-bottom: unset;
	padding-bottom: unset;
}

.paged_pages > .paged_page > .paged_sheet > .paged_pagebox > .paged_area > div [data-split-from]:not([data-paged-box-decoration="clone"]) {
	text-indent: unset;
	margin-top: unset;
	padding-top: unset;
}

.paged_pages > .paged_page > .paged_sheet > .paged_pagebox > .paged_area > div [data-split-from] > *::first-letter,
.paged_pages > .paged_page > .paged_sheet > .paged_pagebox > .paged_area > div [data-split-from]::first-letter {
	color: unset;
	font-size: unset;
	font-weight: unset;
	font-family: unset;
	color: unset;
	line-height: unset;
	float: unset;
	padding: unset;
	margin: unset;
}

.paged_pages > .paged_page > .paged_sheet > .paged_pagebox > .paged_area > div [data-split-to]:not([data-footnote-call]):not([data-split-to^="temp-"]):after,
.paged_pages > .paged_page > .paged_sheet > .paged_pagebox > .paged_area > div [data-split-to]:not([data-footnote-call]):not([data-split-to^="temp-"])::after {
	content: unset;
}

.paged_pages > .paged_page > .paged_sheet > .paged_pagebox > .paged_area > div [data-split-from]:not([data-footnote-call]):not([data-split-from^="temp-"]):before,
.paged_pages > .paged_page > .paged_sheet > .paged_pagebox > .paged_area > div [data-split-from]:not([data-footnote-call]):not([data-split-from^="temp-"])::before {
	content: unset;
}

.paged_pages > .paged_page > .paged_sheet > .paged_pagebox > .paged_area > div li[data-split-from]:first-of-type {
	list-style: none;
}

/*
[data-page]:not([data-split-from]),
[data-break-before="page"]:not([data-split-from]),
[data-break-before="always"]:not([data-split-from]),
[data-break-before="left"]:not([data-split-from]),
[data-break-before="right"]:not([data-split-from]),
[data-break-before="recto"]:not([data-split-from]),
[data-break-before="verso"]:not([data-split-from])
{
	break-before: column;
}

[data-page]:not([data-split-to]),
[data-break-after="page"]:not([data-split-to]),
[data-break-after="always"]:not([data-split-to]),
[data-break-after="left"]:not([data-split-to]),
[data-break-after="right"]:not([data-split-to]),
[data-break-after="recto"]:not([data-split-to]),
[data-break-after="verso"]:not([data-split-to])
{
	break-after: column;
}
*/

.paged_clear-after::after {
	content: none !important;
}

[data-align-last-split-element='justify'] {
	text-align-last: justify;
}


@media print {
	html {
		width: 100%;
		height: 100%;
		-webkit-print-color-adjust: exact;
		print-color-adjust: exact;
	}
	body {
		margin: 0;
		padding: 0;
		width: 100% !important;
		height: 100% !important;
		min-width: 100%;
		max-width: 100%;
		min-height: 100%;
		max-height: 100%;
	}
	.paged_pages {
		width: auto;
		display: block !important;
		transform: none !important;
		height: 100% !important;
		min-height: 100%;
		max-height: 100%;
		overflow: visible;
	}
	.paged_page {
		margin: 0;
		padding: 0;
		max-height: 100%;
		min-height: 100%;
		height: 100% !important;
		page-break-after: always;
		break-after: page;
	}
	.paged_sheet {
		margin: 0;
		padding: 0;
		max-height: 100%;
		min-height: 100%;
		height: 100% !important;
	}
}
`;

export default baseStyles;
