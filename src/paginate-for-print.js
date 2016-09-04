import {DEFAULT_CONFIG_VALUES} from "./defaults"
import {LayoutApplier} from "./apply-layout"

/*!
 * PaginateForPrint
 * Copyright 2014-2016 Johannes Wilm. Freely available under the AGPL. For further details see LICENSE.txt
 *
 */

export class PaginateForPrint {

    constructor(config) {
        this.config = Object.assign(DEFAULT_CONFIG_VALUES, config)
        this.stylesheets = []
        this.layoutApplier = new LayoutApplier(this.config)
    }

    initiate() {
        /* Initiate PaginateForPrint by setting basic CSS style. and initiating
           the layout mechanism.
         */
        this.setStyle()
        this.setPageStyle()
        this.setBrowserSpecifics()
        this.layoutApplier.initiate()
    }

    setBrowserSpecifics() {
        if (navigator.userAgent.toLowerCase().indexOf('firefox') > -1) {
            let stylesheet = document.createElement('style')
            // Small fix for Firefox to not print first two pages on top of oneanother.
            stylesheet.innerHTML = ".pagination-page:first-child {page-break-before: always;}"
            document.head.appendChild(stylesheet)
            this.stylesheets.push(stylesheet)
        }
    }

    setStyle() {
        /* Set style for the regions and pages used by Paginate for Print and add it
         * to the head of the DOM.
         */
        let stylesheet = document.createElement('style')
        let footnoteSelector = this.config['footnoteSelector']

        stylesheet.innerHTML = `
.pagination-footnotes ${footnoteSelector} {display: block;}
.pagination-contents ${footnoteSelector} > * {display:none;}
.pagination-main-contents-container ${footnoteSelector}, figure {
    -webkit-column-break-inside: avoid;
    page-break-inside: avoid;
}
body {
    counter-reset: pagination-footnote pagination-footnote-reference;
}
.pagination-contents ${footnoteSelector}::before {
    counter-increment: pagination-footnote-reference;
    content: counter(pagination-footnote-reference);
}
${footnoteSelector} > * > *:first-child::before {
    counter-increment: pagination-footnote;
    content: counter(pagination-footnote);
}
.pagination-page {
    position: relative;
}
.pagination-page {
    page-break-after: always;
    page-break-before: always;
    margin-left: auto;
    margin-right: auto;
}
.pagination-page:first-child {
    page-break-before: avoid;
}
.pagination-page:last-child {
    page-break-after: avoid;
}
.pagination-main-contents-container, .pagination-pagenumber, .pagination-header {
    position: absolute;
}
li.hide {
    list-style-type: none;
}
        `
        document.head.appendChild(stylesheet)
        this.stylesheets.push(stylesheet)
    }

    setPageStyle() {
        // Set style for a particular page size.
        let unit = this.config['lengthUnit'],
            contentsWidthNumber = this.config['pageWidth'] -
            this.config['innerMargin'] - this.config['outerMargin'],
            contentsWidth = contentsWidthNumber + unit,
            contentsHeightNumber = this.config['pageHeight'] -
            this.config['contentsTopMargin'] -
            this.config['contentsBottomMargin'],
            contentsHeight = contentsHeightNumber + unit,
            pageWidth = this.config['pageWidth'] + unit,
            pageHeight = this.config['pageHeight'] + unit,
            contentsBottomMargin = this.config['contentsBottomMargin'] +
            unit,
            innerMargin = this.config['innerMargin'] + unit,
            outerMargin = this.config['outerMargin'] + unit,
            pagenumberBottomMargin = this.config
                ['pagenumberBottomMargin'] +
            unit,
            headerTopMargin = this.config['headerTopMargin'] +
            unit,
            imageMaxHeight = contentsHeightNumber - 0.1 + unit,
            footnoteSelector = this.config['footnoteSelector']
            let pageStyleSheet = document.createElement('style')
            pageStyleSheet.innerHTML = `
.pagination-page {height: ${pageHeight}; width: ${pageWidth};background-color: #fff;}
@page {size:${pageWidth} ${pageHeight};}
body {background-color: #efefef; margin:0;}
@media screen{.pagination-page {border:solid 1px #000; margin-bottom:.2in;}}
.pagination-main-contents-container {
    width: ${contentsWidth};
    height: ${contentsHeight};
    bottom: ${contentsBottomMargin};
}
.pagination-contents-container {
    bottom: ${contentsBottomMargin};
    height: ${contentsHeight};
}
.pagination-contents {
    height: ${contentsHeight};
    width: ${contentsWidth};
}
img {max-height: ${imageMaxHeight}; max-width: 100%;}
.pagination-pagenumber {
    bottom: ${pagenumberBottomMargin};
}
.pagination-header {
    top: ${headerTopMargin};
}
.pagination-page:nth-child(odd) .pagination-main-contents-container,
.pagination-page:nth-child(odd) .pagination-pagenumber,
.pagination-page:nth-child(odd) .pagination-header {
    right: ${outerMargin};
    left: ${innerMargin};
}
.pagination-page:nth-child(even) .pagination-main-contents-container,
.pagination-page:nth-child(even) .pagination-pagenumber,
.pagination-page:nth-child(even) .pagination-header {
    right: ${innerMargin};
    left: ${outerMargin};
}
.pagination-page:nth-child(odd) .pagination-pagenumber,
.pagination-page:nth-child(odd) .pagination-header {text-align:right;}
.pagination-page:nth-child(odd) .pagination-header-section {display:none;}
.pagination-page:nth-child(even) .pagination-header-chapter {display:none;}
.pagination-page:nth-child(even) .pagination-pagenumber,
.pagination-page:nth-child(even) .pagination-header { text-align:left;}
${footnoteSelector} > * > * {font-size: 0.7em; margin:.25em;}
${footnoteSelector} > * > *::before, ${footnoteSelector}::before {
    position: relative;
    top: -0.5em;
    font-size: 80%;
}
#pagination-toc-title:before {
    content:'Contents';
}
.pagination-toc-entry .pagination-toc-pagenumber {float:right;}
            `
        document.head.insertBefore(pageStyleSheet,document.head.firstChild)
        this.stylesheets.push(pageStyleSheet)
    }

    // Remove stylesheets and all contents of the flow to element.
    tearDown() {
        // Remove stylesheets from DOM
        this.stylesheets.forEach(function(stylesheet){
            stylesheet.parentNode.removeChild(stylesheet)
        })
        let flowToElement = this.config['flowToElement'] ? this.config['flowToElement'] : document.body
        while (flowToElement.firstChild) {
            flowToElement.removeChild(flowToElement.firstChild)
        }
    }

}
