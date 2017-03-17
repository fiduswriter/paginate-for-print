(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.paginateForPrint = f()}})(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
"use strict";

Object.defineProperty(exports, "__esModule", {
    value: true
});
exports.LayoutApplier = undefined;

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

var _matchesSelector = require("./matches-selector");

var _cutContent = require("./cut-content");

var _pageCounters = require("./page-counters");

var _createToc = require("./create-toc");

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var LayoutApplier = exports.LayoutApplier = function () {
    function LayoutApplier(config) {
        _classCallCheck(this, LayoutApplier);

        this.config = config;
        this.bodyFlowObjects = [];
        //this.currentChapter = false
        //this.currentSection = false
        this.currentFragment = -1;

        /* pageCounters contains all the page counters we use in a book --
         * typically these are two -- roman for the frontmatter and arab for the main
         * body contents.
         */
        this.pageCounters = {
            arab: new _pageCounters.PageCounterArab(),
            roman: new _pageCounters.PageCounterRoman()
        };

        this.cutter = new _cutContent.ContentCutter(this.config);
    }

    _createClass(LayoutApplier, [{
        key: "initiate",
        value: function initiate() {
            // Create div for layout
            var layoutDiv = document.createElement('div'),
                flowedElement = this.config['flowFromElement'] ? this.config['flowFromElement'] : document.body,
                chapterStartSelector = this.config['chapterStartSelector'],
                sectionStartSelector = this.config['sectionStartSelector'],
                dividerSelector = chapterStartSelector + ',' + sectionStartSelector,
                dividers = flowedElement.querySelectorAll(dividerSelector),
                range = document.createRange(),
                nextChapter = false,
                nextSection = false,
                flowTo = this.config['flowToElement'] ? this.config['flowToElement'] : document.body;

            layoutDiv.id = 'pagination-layout';
            for (var i = 0; i < dividers.length; i++) {
                var _flowObject = {
                    chapter: false,
                    section: false
                };
                if (nextChapter) {
                    _flowObject.chapter = nextChapter;
                    nextChapter = false;
                }
                if (nextSection) {
                    _flowObject.section = nextSection;
                    nextSection = false;
                }
                range.setStart(flowedElement.firstChild, 0);
                range.setEnd(dividers[i], 0);
                _flowObject.fragment = range.extractContents();
                this.bodyFlowObjects.push(_flowObject);

                var extraElement = _flowObject.fragment.querySelectorAll(dividerSelector)[1];
                if (extraElement && extraElement.parentElement) {
                    extraElement.parentElement.removeChild(extraElement);
                }
                if ((0, _matchesSelector.matchesSelector)(dividers[i], chapterStartSelector)) {
                    var tempNode = flowedElement.querySelector(this.config['chapterTitleSelector']);
                    if (!tempNode) {
                        tempNode = document.createElement('div');
                    }
                    tempNode = tempNode.cloneNode(true);
                    nextChapter = document.createDocumentFragment();
                    while (tempNode.firstChild) {
                        nextChapter.appendChild(tempNode.firstChild);
                    }
                } else {
                    var _tempNode = flowedElement.querySelector(this.config['sectionTitleSelector']).cloneNode(true);
                    nextSection = document.createDocumentFragment();
                    while (_tempNode.firstChild) {
                        nextSection.appendChild(_tempNode.firstChild);
                    }
                }

                if (i === 0) {
                    if (_flowObject.fragment.textContent.trim().length === 0 && _flowObject.fragment.querySelectorAll('img,svg,canvas,hr').length === 0) {
                        this.bodyFlowObjects.pop();
                    }
                }
            }

            var flowObject = {
                chapter: false,
                section: false
            };
            if (nextChapter) {
                flowObject.chapter = nextChapter;
            }
            if (nextSection) {
                flowObject.section = nextSection;
            }

            flowObject.fragment = document.createDocumentFragment();

            while (flowedElement.firstChild) {
                flowObject.fragment.appendChild(flowedElement.firstChild);
            }

            this.bodyFlowObjects.push(flowObject);

            flowTo.appendChild(layoutDiv);

            this.paginateDivision(layoutDiv, 'arab');
        }
    }, {
        key: "paginateDivision",
        value: function paginateDivision(layoutDiv, pageCounterStyle) {
            if (++this.currentFragment < this.bodyFlowObjects.length) {
                var newContainer = document.createElement('div');
                layoutDiv.appendChild(newContainer);
                newContainer.classList.add('pagination-body');
                newContainer.classList.add('pagination-body-' + this.currentFragment);
                if (this.bodyFlowObjects[this.currentFragment].section) {
                    this.currentSection = this.bodyFlowObjects[this.currentFragment].section;
                    newContainer.classList.add('pagination-section');
                }
                if (this.bodyFlowObjects[this.currentFragment].chapter) {
                    this.currentChapter = this.bodyFlowObjects[this.currentFragment].chapter;
                    newContainer.classList.add('pagination-chapter');
                }
                this.flowElement(this.bodyFlowObjects[this.currentFragment].fragment, newContainer, pageCounterStyle, this.bodyFlowObjects[this.currentFragment].section, this.bodyFlowObjects[this.currentFragment].chapter);
            } else {
                this.currentChapter = false;
                this.currentSection = false;
                this.pageCounters[pageCounterStyle].numberPages();
                if (this.config['enableFrontmatter']) {
                    layoutDiv.insertBefore(document.createElement('div'), layoutDiv.firstChild);
                    layoutDiv.firstChild.classList.add('pagination-frontmatter');
                    var flowObject = {
                        fragment: document.createDocumentFragment()
                    };
                    if (this.config['frontmatterFlowFromElement']) {
                        var fmNode = this.config['frontmatterFlowFromElement'];
                        while (fmNode.firstChild) {
                            flowObject.fragment.appendChild(fmNode.firstChild);
                        }
                    }
                    if (this.config['numberPages']) {
                        flowObject.fragment.appendChild((0, _createToc.createToc)());
                    }
                    this.flowElement(flowObject.fragment, layoutDiv.firstChild, 'roman');
                }
            }
        }
    }, {
        key: "fillPage",
        value: function fillPage(node, container, pageCounterStyle) {

            var lastPage = this.createPage(container, pageCounterStyle),
                clonedNode = node.cloneNode(true),
                footnoteSelector = this.config['footnoteSelector'],
                topfloatSelector = this.config['topfloatSelector'],
                that = this;

            lastPage.appendChild(node);

            var overflow = this.cutter.cutToFit(lastPage);

            var topfloatsLength = lastPage.querySelectorAll(topfloatSelector).length;

            if (topfloatsLength > 0) {
                var topfloats = clonedNode.querySelectorAll(topfloatSelector);

                for (var i = 0; i < topfloatsLength; i++) {
                    lastPage.previousSibling.appendChild(topfloats[i]);
                }
                while (lastPage.firstChild) {
                    lastPage.removeChild(lastPage.firstChild);
                }
                node = clonedNode.cloneNode(true);
                lastPage.appendChild(node);
                overflow = this.cutter.cutToFit(lastPage);
            }

            var footnotes = lastPage.querySelectorAll(footnoteSelector);
            var footnotesLength = footnotes.length;
            if (footnotesLength > 0) {

                while (lastPage.nextSibling.firstChild) {
                    lastPage.nextSibling.removeChild(lastPage.nextSibling.firstChild);
                }

                for (var _i = 0; _i < footnotesLength; _i++) {
                    var clonedFootnote = footnotes[_i].cloneNode(true);
                    lastPage.nextSibling.appendChild(clonedFootnote);
                }

                while (lastPage.firstChild) {
                    lastPage.removeChild(lastPage.firstChild);
                }

                lastPage.appendChild(clonedNode);

                overflow = this.cutter.cutToFit(lastPage);
                for (var _i2 = lastPage.querySelectorAll(footnoteSelector).length; _i2 < footnotesLength; _i2++) {
                    var oldFn = lastPage.nextSibling.children[_i2];

                    while (oldFn.firstChild) {
                        oldFn.removeChild(oldFn.firstChild);
                    }
                }
            }

            if (overflow.firstChild && overflow.firstChild.textContent.trim().length === 0 && ['P', 'DIV'].indexOf(overflow.firstChild.nodeName) !== -1) {
                overflow.removeChild(overflow.firstChild);
            }

            if (lastPage.firstChild && lastPage.firstChild.nodeType != 3 && lastPage.firstChild.textContent.trim().length === 0 && lastPage.firstChild.querySelectorAll('img,svg,canvas').length === 0) {
                lastPage.removeChild(lastPage.firstChild);
            } else if (overflow.firstChild && lastPage.firstChild) {
                setTimeout(function () {
                    that.fillPage(overflow, container, pageCounterStyle);
                }, 1);
            } else {
                this.finish(container, pageCounterStyle);
            }
        }
    }, {
        key: "createPage",
        value: function createPage(container, pageCounterClass) {
            var page = document.createElement('div'),
                contentsContainer = document.createElement('div'),
                mainContentsContainer = document.createElement('div'),
                topfloats = document.createElement('div'),
                contents = document.createElement('div'),
                footnotes = document.createElement('div');

            page.classList.add('pagination-page');
            contentsContainer.classList.add('pagination-contents-container');
            mainContentsContainer.classList.add('pagination-main-contents-container');

            if (this.currentChapter || this.currentSection) {

                var header = document.createElement('div');

                header.classList.add('pagination-header');

                if (this.currentChapter) {

                    var chapterHeader = document.createElement('span');

                    chapterHeader.classList.add('pagination-header-chapter');
                    chapterHeader.appendChild(this.currentChapter.cloneNode(true));
                    header.appendChild(chapterHeader);
                }

                if (this.currentSection) {

                    var sectionHeader = document.createElement('span');
                    sectionHeader.classList.add('pagination-header-section');
                    sectionHeader.appendChild(this.currentSection.cloneNode(true));
                    header.appendChild(sectionHeader);
                }
                page.appendChild(header);
            }

            topfloats.classList.add('pagination-topfloats');
            //topfloats.appendChild(document.createElement('p'))

            contents.classList.add('pagination-contents');

            footnotes.classList.add('pagination-footnotes');
            footnotes.appendChild(document.createElement('p'));

            mainContentsContainer.appendChild(topfloats);
            mainContentsContainer.appendChild(contents);
            mainContentsContainer.appendChild(footnotes);

            page.appendChild(mainContentsContainer);

            if (this.config['numberPages']) {

                var pagenumberField = document.createElement('div');
                pagenumberField.classList.add('pagination-pagenumber');
                pagenumberField.classList.add('pagination-' + pageCounterClass);

                page.appendChild(pagenumberField);
            }

            container.appendChild(page);
            return contents;
        }
    }, {
        key: "flowElement",
        value: function flowElement(overflow, container, pageCounterStyle) {
            var that = this;
            setTimeout(function () {
                that.fillPage(overflow, container, pageCounterStyle);
            }, 1);
        }
    }, {
        key: "finish",
        value: function finish(container, pageCounterStyle) {
            var layoutDiv = container.parentElement;
            if (this.config['alwaysEven'] && container.querySelectorAll('.pagination-page').length % 2 === 1) {
                this.createPage(container, pageCounterStyle);
            }
            if (container.classList.contains('pagination-body')) {
                this.paginateDivision(layoutDiv, pageCounterStyle);
                if (this.bodyFlowObjects.length === this.currentFragment && this.config['enableFrontmatter'] === false) {
                    this.config['callback']();
                }
            } else {
                this.pageCounters[pageCounterStyle].numberPages();
                this.config['callback']();
            }
        }
    }]);

    return LayoutApplier;
}();

},{"./create-toc":2,"./cut-content":3,"./matches-selector":7,"./page-counters":8}],2:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, "__esModule", {
    value: true
});
exports.createToc = createToc;

var _matchesSelector = require('./matches-selector');

function createToc() {
    var tocDiv = document.createElement('div'),
        tocTitleH1 = document.createElement('h1'),
        tocItems = document.getElementById('pagination-layout').querySelectorAll('.pagination-body'),
        itemType = void 0;

    tocDiv.id = 'pagination-toc';
    tocTitleH1.id = 'pagination-toc-title';
    tocDiv.appendChild(tocTitleH1);

    for (var i = 0; i < tocItems.length; i++) {
        if ((0, _matchesSelector.matchesSelector)(tocItems[i], '.pagination-chapter')) {
            itemType = 'chapter';
        } else if ((0, _matchesSelector.matchesSelector)(tocItems[i], '.pagination-section')) {
            itemType = 'section';
        } else {
            continue;
        }
        var tocItemDiv = document.createElement('div');
        tocItemDiv.classList.add('pagination-toc-entry');
        var tocItemTextSpan = document.createElement('span');
        tocItemTextSpan.classList.add('pagination-toc-text');

        tocItemTextSpan.appendChild(document.createTextNode(tocItems[i].querySelector('.pagination-header-' + itemType).textContent.trim()));
        tocItemDiv.appendChild(tocItemTextSpan);

        var tocItemPnSpan = document.createElement('span');
        tocItemPnSpan.classList.add('pagination-toc-pagenumber');

        tocItemPnSpan.appendChild(document.createTextNode(tocItems[i].querySelector('.pagination-pagenumber').textContent.trim()));

        tocItemDiv.appendChild(tocItemPnSpan);

        tocDiv.appendChild(tocItemDiv);
    }

    return tocDiv;
}

},{"./matches-selector":7}],3:[function(require,module,exports){
"use strict";

Object.defineProperty(exports, "__esModule", {
    value: true
});
exports.ContentCutter = undefined;

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

var _getBoundingClientRect = require("./get-bounding-client-rect");

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var ContentCutter = exports.ContentCutter = function () {
    function ContentCutter(config) {
        _classCallCheck(this, ContentCutter);

        this.config = config;
    }

    // main cut method


    _createClass(ContentCutter, [{
        key: "cutToFit",
        value: function cutToFit(contents) {

            var range = void 0,
                overflow = void 0,
                manualPageBreak = void 0,
                ignoreLastLIcut = false,
                cutLIs = void 0,
                pageBreak = void 0,

            // contentHeight = height of page - height of top floats - height of footnotes.
            contentHeight = contents.parentElement.clientHeight - contents.previousSibling.clientHeight - contents.nextSibling.clientHeight,
                contentWidth = contents.parentElement.clientWidth,
                boundingRect = void 0,
                rightCutOff = void 0;

            // set height to contentHeight
            contents.style.height = contentHeight + "px";

            if (navigator.userAgent.toLowerCase().indexOf('firefox') > -1) {
                // Firefox has some insane bug which means that the new content height
                // isn't applied immediately when dealing with multicol -- unless one
                // removes the content and re-adds it.
                var nSib = contents.nextSibling;
                var pEl = contents.parentElement;
                pEl.removeChild(contents);
                pEl.insertBefore(contents, nSib);
            }

            // Set height temporarily to "auto" so the page flows beyond where
            // it should end and we can find the page break.
            contents.style.width = contentWidth * 2 + 100 + 'px';
            contents.style.columnWidth = contentWidth + 'px';
            contents.style.columnGap = '100px';
            contents.style.columnFill = 'auto';

            contents.style.MozColumnWidth = contentWidth + 'px';
            contents.style.MozColumnGap = '100px';
            contents.style.MozColumnFill = 'auto';

            boundingRect = contents.getBoundingClientRect();
            rightCutOff = boundingRect.left + contentWidth + 20;

            manualPageBreak = contents.querySelector(this.config['pagebreakSelector']);

            if (manualPageBreak && manualPageBreak.getBoundingClientRect().left < rightCutOff) {
                range = document.createRange();
                range.setStartBefore(manualPageBreak);
            } else if (boundingRect.right <= rightCutOff) {
                contents.style.width = contentWidth + "px";
                return false;
            } else {
                pageBreak = this.findPageBreak(contents, rightCutOff);
                if (!pageBreak) {
                    contents.style.width = contentWidth + "px";
                    return false;
                }
                range = document.createRange();
                range.setStart(pageBreak.node, pageBreak.offset);
            }

            contents.style.width = contentWidth + "px";
            // We find that the first item is an OL/UL which may have started on the previous page.
            if (['OL', 'UL'].indexOf(range.startContainer.nodeName) !== -1 || range.startContainer.nodeName === '#text' && range.startContainer.parentNode && ['OL', 'UL'].indexOf(range.startContainer.parentNode.nodeName) !== -1 && range.startContainer.length === range.startOffset) {
                // We are cutting from inside a List, don't touch the innermost list items.
                ignoreLastLIcut = true;
            }
            range.setEndAfter(contents.lastChild);
            overflow = range.extractContents();
            cutLIs = this.countOLItemsAndFixLI(contents);
            if (ignoreLastLIcut) {
                // Because the cut happened exactly between two LI items, don't try to unify the two lowest level LIs.
                cutLIs[cutLIs.length - 1].hideFirstLI = false;
                if (cutLIs[cutLIs.length - 1].start) {
                    cutLIs[cutLIs.length - 1].start++;
                }
            }
            this.applyInitialOLcount(overflow, cutLIs);

            if (!contents.lastChild || contents.textContent.trim().length === 0 && contents.querySelectorAll('img,svg,canvas').length === 0) {
                contents.appendChild(overflow);
                overflow = false;
            }
            return overflow;
        }
    }, {
        key: "countOLItemsAndFixLI",
        value: function countOLItemsAndFixLI(element, countList) {
            var start = 1,
                hideFirstLI = false;

            if (typeof countList === 'undefined') {
                countList = [];
            }
            if (element.nodeName === 'OL') {
                if (element.hasAttribute('start')) {
                    start = parseInt(element.getAttribute('start'));
                }
                if (element.lastElementChild.textContent.length === 0) {
                    element.removeChild(element.lastElementChild);
                } else {
                    start--;
                    hideFirstLI = true;
                }
                countList.push({
                    start: start + element.childElementCount,
                    hideFirstLI: hideFirstLI
                });
            } else if (element.nodeName === 'UL') {
                if (element.lastElementChild.textContent.length === 0) {
                    element.removeChild(element.lastElementChild);
                } else {
                    hideFirstLI = true;
                }
                countList.push({
                    hideFirstLI: hideFirstLI
                });
            }

            if (element.childElementCount > 0) {
                return this.countOLItemsAndFixLI(element.lastElementChild, countList);
            } else {
                return countList;
            }
        }
    }, {
        key: "applyInitialOLcount",
        value: function applyInitialOLcount(element, countList) {
            if (element.nodeName === '#document-fragment') {
                element = element.childNodes[0];
            }
            var listCount = void 0;
            if (countList.length === 0) {
                return;
            }
            if (element.nodeName === 'OL') {
                listCount = countList.shift();
                element.setAttribute('start', listCount.start);
                if (listCount.hideFirstLI) {
                    element.firstElementChild.classList.add('hide');
                }
            } else if (element.nodeName === 'UL') {
                listCount = countList.shift();
                if (listCount.hideFirstLI) {
                    element.firstElementChild.classList.add('hide');
                }
            }
            if (element.childElementCount > 0) {
                this.applyInitialOLcount(element.firstElementChild, countList);
            } else {
                return;
            }
        }
    }, {
        key: "findPrevNode",
        value: function findPrevNode(node) {
            if (node.previousSibling) {
                return node.previousSibling;
            } else {
                return this.findPrevNode(node.parentElement);
            }
        }

        // Go through a node (contents) and find the exact position where it goes
        // further to the right than the right cutoff.

    }, {
        key: "findPageBreak",
        value: function findPageBreak(contents, rightCutOff) {
            var contentCoords = void 0,
                found = void 0,
                prevNode = void 0;
            if (contents.nodeType === 1) {
                contentCoords = (0, _getBoundingClientRect.getBoundingClientRect)(contents);
                if (contentCoords.left < rightCutOff) {
                    if (contentCoords.right > rightCutOff) {
                        found = false;
                        var i = 0;
                        while (found === false && i < contents.childNodes.length) {
                            found = this.findPageBreak(contents.childNodes[i], rightCutOff);
                            i++;
                        }
                        if (found) {
                            return found;
                        }
                    } else {
                        return false;
                    }
                }
                prevNode = this.findPrevNode(contents);
                return {
                    node: prevNode,
                    offset: prevNode.length ? prevNode.length : prevNode.childNodes.length
                };
            } else if (contents.nodeType === 3) {
                var range = document.createRange(),
                    offset = contents.length;
                range.setStart(contents, 0);
                range.setEnd(contents, offset);
                contentCoords = range.getBoundingClientRect();

                if (contentCoords.bottom === contentCoords.top) {
                    // A text node that doesn't have any output.
                    return false;
                } else if (contentCoords.left < rightCutOff) {
                    if (contentCoords.right > rightCutOff) {
                        found = false;
                        while (found === false && offset > 0) {
                            offset--;
                            range.setEnd(contents, offset);
                            contentCoords = range.getBoundingClientRect();
                            if (contentCoords.right <= rightCutOff) {
                                found = {
                                    node: contents,
                                    offset: offset
                                };
                            }
                        }
                        if (found) {
                            return found;
                        }
                    } else {
                        return false;
                    }
                }
                prevNode = this.findPrevNode(contents);
                return {
                    node: prevNode,
                    offset: prevNode.length ? prevNode.length : prevNode.childNodes.length
                };
            } else {
                return false;
            }
        }
    }]);

    return ContentCutter;
}();

},{"./get-bounding-client-rect":5}],4:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, "__esModule", {
    value: true
});
var DEFAULT_CONFIG_VALUES = exports.DEFAULT_CONFIG_VALUES = {
    // SELECTORS
    sectionStartSelector: 'h1', // The CSS selector that marks the start of a new section.
    sectionTitleSelector: 'h1', // The CSS selector at a start of a section that marks the title of that section.
    chapterStartSelector: 'h2', // The CSS selector that marks the start of a new chapter.
    chapterTitleSelector: 'h2', // The CSS selector at a start of a chapter that marks the title of that chapter.
    footnoteSelector: '.pagination-footnote', // The CSS selector of elements that are to be converted to footnotes.
    pagebreakSelector: '.pagination-pagebreak', // The CSS selector of elements that are to be converted to page breaks.
    topfloatSelector: '.pagination-topfloat', // The CSS selector of elements that are to be converted to top floating elements.
    //        'marginnoteSelector': '.pagination-marginnote',

    // FLOW ELEMENTS
    flowFromElement: false, // An element where to flow from (if false, document.body will be taken)
    frontmatterFlowFromElement: false, // An element that holds the contents to be flown into the frontmatter
    flowToElement: false, // An element where to flow to (if false, document.body will be taken)

    // LAYOUT OPTIONS
    numberPages: true, // Whether to number pages
    alwaysEven: true, // Whether every section/chapter always should have an even number of pages
    enableFrontmatter: true, // Whether to add frontmatter (Title page, Table-of-Contents, etc.)
    //        'enableTableOfFigures': false,
    //        'enableTableOfTables': false,
    //        'enableMarginNotes': false,
    //        'enableCrossReferences': true,
    //        'enableWordIndex': true,

    // CALLBACK
    callback: function callback() {},

    // STYLING OpTIONS (Can be overriden with CSS)
    outerMargin: 0.5,
    innerMargin: 0.8,
    contentsTopMargin: 0.8,
    headerTopMargin: 0.3,
    contentsBottomMargin: 0.8,
    pagenumberBottomMargin: 0.3,
    pageHeight: 8.3,
    pageWidth: 5.8,
    //        'marginNotesWidth': 1.5,
    //        'marginNotesSeparatorWidth': 0.09,
    //        'marginNotesVerticalSeparatorWidth': 0.09,
    lengthUnit: 'in'
};

},{}],5:[function(require,module,exports){
"use strict";

Object.defineProperty(exports, "__esModule", {
    value: true
});
exports.getBoundingClientRect = getBoundingClientRect;
// Chrome (+ possibly others) currently has issues when trying to find the real coordinates of elements when in multicol.
// This is a workaround that uses a range over the elements contents and combines all client rects around it.

function getBoundingClientRect(element) {
    var r = document.createRange();
    r.setStart(element, 0);
    r.setEnd(element, element.childNodes.length);
    return r.getBoundingClientRect();
}

},{}],6:[function(require,module,exports){
"use strict";

var _paginateForPrint = require("./paginate-for-print");

module.exports = function (configValues) {
    var paginator = new _paginateForPrint.PaginateForPrint(configValues);
    paginator.initiate();
    return function () {
        paginator.tearDown();
    };
};

},{"./paginate-for-print":9}],7:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, "__esModule", {
    value: true
});
exports.matchesSelector = matchesSelector;
function matchesSelector(element, selector) {

    if (navigator.userAgent.toLowerCase().indexOf('firefox') > -1) {
        // Firefox
        return element.mozMatchesSelector(selector);
    } else {
        // Webkit + Chrome + Edge
        return element.webkitMatchesSelector(selector);
    }
}

},{}],8:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, "__esModule", {
    value: true
});

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _possibleConstructorReturn(self, call) { if (!self) { throw new ReferenceError("this hasn't been initialised - super() hasn't been called"); } return call && (typeof call === "object" || typeof call === "function") ? call : self; }

function _inherits(subClass, superClass) { if (typeof superClass !== "function" && superClass !== null) { throw new TypeError("Super expression must either be null or a function, not " + typeof superClass); } subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, enumerable: false, writable: true, configurable: true } }); if (superClass) Object.setPrototypeOf ? Object.setPrototypeOf(subClass, superClass) : subClass.__proto__ = superClass; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var PageCounterArab = exports.PageCounterArab = function () {
    // arab is the page counter used by the main body contents.

    /* Create a pagecounter. cssClass is the CSS class employed by this page
     * counter to mark all page numbers associated with it.
     */
    function PageCounterArab() {
        _classCallCheck(this, PageCounterArab);

        this.cssClass = 'arab';
        this.counterValue = 0;
    }

    _createClass(PageCounterArab, [{
        key: 'show',
        value: function show() {
            /* Standard show function for page counter is to show the value itself
             * using arabic numbers.
             */
            return this.counterValue;
        }
    }, {
        key: 'incrementAndShow',
        value: function incrementAndShow() {
            /* Increment the page count by one and return the reuslt page count
             * using the show function.
             */
            this.counterValue++;
            return this.show();
        }
    }, {
        key: 'numberPages',
        value: function numberPages() {
            /* If the pages associated with this page counter need to be updated,
             * go through all of them from the start of the book and number them,
             * thereby potentially removing old page numbers.
             */
            this.counterValue = 0;

            var pagenumbersToNumber = document.querySelectorAll('.pagination-page .pagination-pagenumber.pagination-' + this.cssClass);
            for (var i = 0; i < pagenumbersToNumber.length; i++) {
                pagenumbersToNumber[i].innerHTML = this.incrementAndShow();
            }
        }
    }]);

    return PageCounterArab;
}();

var PageCounterRoman = exports.PageCounterRoman = function (_PageCounterArab) {
    _inherits(PageCounterRoman, _PageCounterArab);

    // roman is the page counter used by the frontmatter.
    function PageCounterRoman() {
        _classCallCheck(this, PageCounterRoman);

        var _this = _possibleConstructorReturn(this, (PageCounterRoman.__proto__ || Object.getPrototypeOf(PageCounterRoman)).call(this));

        _this.cssClass = 'roman';
        return _this;
    }

    _createClass(PageCounterRoman, [{
        key: 'show',
        value: function show() {
            // Create roman numeral representations of numbers.
            var digits = String(+this.counterValue).split(""),
                key = ["", "C", "CC", "CCC", "CD", "D", "DC", "DCC", "DCCC", "CM", "", "X", "XX", "XXX", "XL", "L", "LX", "LXX", "LXXX", "XC", "", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX"],
                roman = "",
                i = 3;
            while (i--) {
                roman = (key[+digits.pop() + i * 10] || "") + roman;
            }
            return new Array(+digits.join("") + 1).join("M") + roman;
        }
    }]);

    return PageCounterRoman;
}(PageCounterArab);

},{}],9:[function(require,module,exports){
"use strict";

Object.defineProperty(exports, "__esModule", {
    value: true
});
exports.PaginateForPrint = undefined;

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

var _defaults = require("./defaults");

var _applyLayout = require("./apply-layout");

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

/*!
 * PaginateForPrint
 * Copyright 2014-2016 Johannes Wilm. Freely available under the AGPL. For further details see LICENSE.txt
 *
 */

var PaginateForPrint = exports.PaginateForPrint = function () {
    function PaginateForPrint(config) {
        _classCallCheck(this, PaginateForPrint);

        this.config = Object.assign(_defaults.DEFAULT_CONFIG_VALUES, config);
        this.stylesheets = [];
        this.layoutApplier = new _applyLayout.LayoutApplier(this.config);
    }

    _createClass(PaginateForPrint, [{
        key: "initiate",
        value: function initiate() {
            /* Initiate PaginateForPrint by setting basic CSS style. and initiating
               the layout mechanism.
             */
            this.setStyle();
            this.setPageStyle();
            this.setBrowserSpecifics();
            this.layoutApplier.initiate();
        }
    }, {
        key: "setBrowserSpecifics",
        value: function setBrowserSpecifics() {
            if (navigator.userAgent.toLowerCase().indexOf('firefox') > -1) {
                var stylesheet = document.createElement('style');
                // Small fix for Firefox to not print first two pages on top of oneanother.
                stylesheet.innerHTML = ".pagination-page:first-child {page-break-before: always;}";
                document.head.appendChild(stylesheet);
                this.stylesheets.push(stylesheet);
            }
        }
    }, {
        key: "setStyle",
        value: function setStyle() {
            /* Set style for the regions and pages used by Paginate for Print and add it
             * to the head of the DOM.
             */
            var stylesheet = document.createElement('style');
            var footnoteSelector = this.config['footnoteSelector'];

            stylesheet.innerHTML = "\n.pagination-footnotes " + footnoteSelector + " {display: block;}\n.pagination-contents " + footnoteSelector + " > * {display:none;}\n.pagination-main-contents-container " + footnoteSelector + ", figure {\n    -webkit-column-break-inside: avoid;\n    page-break-inside: avoid;\n}\nbody {\n    counter-reset: pagination-footnote pagination-footnote-reference;\n}\n.pagination-contents " + footnoteSelector + "::before {\n    counter-increment: pagination-footnote-reference;\n    content: counter(pagination-footnote-reference);\n}\n" + footnoteSelector + " > * > *:first-child::before {\n    counter-increment: pagination-footnote;\n    content: counter(pagination-footnote);\n}\n.pagination-page {\n    position: relative;\n}\n.pagination-page {\n    page-break-after: always;\n    page-break-before: always;\n    margin-left: auto;\n    margin-right: auto;\n}\n.pagination-page:first-child {\n    page-break-before: avoid;\n}\n.pagination-page:last-child {\n    page-break-after: avoid;\n}\n.pagination-main-contents-container, .pagination-pagenumber, .pagination-header {\n    position: absolute;\n}\nli.hide {\n    list-style-type: none;\n}\n        ";
            document.head.appendChild(stylesheet);
            this.stylesheets.push(stylesheet);
        }
    }, {
        key: "setPageStyle",
        value: function setPageStyle() {
            // Set style for a particular page size.
            var unit = this.config['lengthUnit'],
                contentsWidthNumber = this.config['pageWidth'] - this.config['innerMargin'] - this.config['outerMargin'],
                contentsWidth = contentsWidthNumber + unit,
                contentsHeightNumber = this.config['pageHeight'] - this.config['contentsTopMargin'] - this.config['contentsBottomMargin'],
                contentsHeight = contentsHeightNumber + unit,
                pageWidth = this.config['pageWidth'] + unit,
                pageHeight = this.config['pageHeight'] + unit,
                contentsBottomMargin = this.config['contentsBottomMargin'] + unit,
                innerMargin = this.config['innerMargin'] + unit,
                outerMargin = this.config['outerMargin'] + unit,
                pagenumberBottomMargin = this.config['pagenumberBottomMargin'] + unit,
                headerTopMargin = this.config['headerTopMargin'] + unit,
                imageMaxHeight = contentsHeightNumber - 0.1 + unit,
                footnoteSelector = this.config['footnoteSelector'];
            var pageStyleSheet = document.createElement('style');
            pageStyleSheet.innerHTML = "\n.pagination-page {height: " + pageHeight + "; width: " + pageWidth + ";background-color: #fff;}\n@page {size:" + pageWidth + " " + pageHeight + ";}\nbody {background-color: #efefef; margin:0;}\n@media screen{.pagination-page {border:solid 1px #000; margin-bottom:.2in;}}\n.pagination-main-contents-container {\n    width: " + contentsWidth + ";\n    height: " + contentsHeight + ";\n    bottom: " + contentsBottomMargin + ";\n}\n.pagination-contents-container {\n    bottom: " + contentsBottomMargin + ";\n    height: " + contentsHeight + ";\n}\n.pagination-contents {\n    height: " + contentsHeight + ";\n    width: " + contentsWidth + ";\n}\nimg {max-height: " + imageMaxHeight + "; max-width: 100%;}\n.pagination-pagenumber {\n    bottom: " + pagenumberBottomMargin + ";\n}\n.pagination-header {\n    top: " + headerTopMargin + ";\n}\n.pagination-page:nth-child(odd) .pagination-main-contents-container,\n.pagination-page:nth-child(odd) .pagination-pagenumber,\n.pagination-page:nth-child(odd) .pagination-header {\n    right: " + outerMargin + ";\n    left: " + innerMargin + ";\n}\n.pagination-page:nth-child(even) .pagination-main-contents-container,\n.pagination-page:nth-child(even) .pagination-pagenumber,\n.pagination-page:nth-child(even) .pagination-header {\n    right: " + innerMargin + ";\n    left: " + outerMargin + ";\n}\n.pagination-page:nth-child(odd) .pagination-pagenumber,\n.pagination-page:nth-child(odd) .pagination-header {text-align:right;}\n.pagination-page:nth-child(odd) .pagination-header-section {display:none;}\n.pagination-page:nth-child(even) .pagination-header-chapter {display:none;}\n.pagination-page:nth-child(even) .pagination-pagenumber,\n.pagination-page:nth-child(even) .pagination-header { text-align:left;}\n" + footnoteSelector + " > * > * {font-size: 0.7em; margin:.25em;}\n" + footnoteSelector + " > * > *::before, " + footnoteSelector + "::before {\n    position: relative;\n    top: -0.5em;\n    font-size: 80%;\n}\n#pagination-toc-title:before {\n    content:'Contents';\n}\n.pagination-toc-entry .pagination-toc-pagenumber {float:right;}\n            ";
            document.head.insertBefore(pageStyleSheet, document.head.firstChild);
            this.stylesheets.push(pageStyleSheet);
        }

        // Remove stylesheets and all contents of the flow to element.

    }, {
        key: "tearDown",
        value: function tearDown() {
            // Remove stylesheets from DOM
            this.stylesheets.forEach(function (stylesheet) {
                stylesheet.parentNode.removeChild(stylesheet);
            });
            var flowToElement = this.config['flowToElement'] ? this.config['flowToElement'] : document.body;
            while (flowToElement.firstChild) {
                flowToElement.removeChild(flowToElement.firstChild);
            }
        }
    }]);

    return PaginateForPrint;
}();

},{"./apply-layout":1,"./defaults":4}]},{},[6])(6)
});