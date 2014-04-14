/*!
 * simplePagination.js
 * Copyright 2014 Johannes Wilm. Freely available under the AGPL. For further details see LICENSE.txt
 *
 * This is a drop-in replacement for pagination.js that does not use CSS Regions.
 * Please see pagination.js for usage instructions. Only basic options are available.
 */


(function () {
    
    

    var exports = this,
        defaults,
        pagination = {};

    /* pagination is the object that contains the namespace used by 
     * pagination.js.
     */

    defaults = {
        // pagination.config starts out with default config options.
        //        'sectionStartMarker': 'h1',
        //        'sectionTitleMarker': 'h1',
        //        'chapterStartMarker': 'h2',
        //        'chapterTitleMarker': 'h2',
        'flowElement': 'document.body',
        //        'alwaysEven': false,
        //        'columns': 1,
        //        'enableFrontmatter': true,
        //        'enableTableOfFigures': false,
        //        'enableTableOfTables': false,
        //        'enableMarginNotes': false,
        //        'enableCrossReferences': true,
        //        'enableWordIndex': true,
        //        'bulkPagesToAdd': 50,
        //        'pagesToAddIncrementRatio': 1.4,
        //        'frontmatterContents': '',
        'autoStart': true,
        //        'numberPages': true,
        //        'divideContents': true,
        //        'footnoteSelector': '.pagination-footnote',
        //        'topfloatSelector': '.pagination-topfloat',
        //        'marginnoteSelector': '.pagination-marginnote',
        //        'maxPageNumber': 10000,
        //        'columnSeparatorWidth': 0.09,
        'outerMargin': 0.5,
        'innerMargin': 0.8,
        'contentsTopMargin': 0.8,
        'headerTopMargin': 0.3,
        'contentsBottomMargin': 0.8,
        'pagenumberBottomMargin': 0.3,
        'pageHeight': 8.3,
        'pageWidth': 5.8,
        //        'marginNotesWidth': 1.5,
        //        'marginNotesSeparatorWidth': 0.09,
        //        'marginNotesVerticalSeparatorWidth': 0.09,
        'lengthUnit': 'in'
    };

    pagination.setBrowserSpecifics = function () {

        if (document.caretPositionFromPoint) {
            // Firefox
            pagination.caretRange = function (x, y) {
                var position = document.caretPositionFromPoint(x, y),
                    range = document.createRange();
                range.setStart(position.offsetNode, position.offset);
                return range;
            };
            pagination.columnWidthTerm = 'mozColumnWidth';
        } else {
            // Webkit + Chrome
            pagination.caretRange = function (x, y) {
                return document.caretRangeFromPoint(x, y);
            }
            pagination.columnWidthTerm = 'webkitColumnWidth';
        }

    };


    pagination.pageStyleSheet = document.createElement('style');

    pagination.initiate = function () {
        /* Initiate pagination.js by importing user set config options and 
         * setting basic CSS style.
         */
        //window.scrollTo(0,0);
        this.setStyle();
        this.setPageStyle();
        document.head.insertBefore(
            pagination.pageStyleSheet,
            document.head.firstChild);
        this.setBrowserSpecifics();
    };

    pagination.setStyle = function () {
        /* Set style for the regions and pages used by pagination.js and add it
         * to the head of the DOM.
         */
        var stylesheet = document.createElement('style');
        stylesheet.innerHTML = "\
        .pagination-footnotes .pagination-footnote {\
            display: block;\
        }\
        .pagination-contents .pagination-footnote > * {\
            display:none;\
        }\
        .pagination-main-contents-container .pagination-footnote {\
            -webkit-column-break-inside: avoid;\
            page-break-inside: avoid;\
        }\
        body {\
            counter-reset: pagination-footnote pagination-footnote-reference;\
        }\
        .pagination-contents .pagination-footnote::before {\
            counter-increment: pagination-footnote-reference;\
            content: counter(pagination-footnote-reference);\
        }\
        .pagination-footnote > * > *:first-child::before {\
            counter-increment: pagination-footnote;\
            content: counter(pagination-footnote);\
        }\
        .pagination-page {\
            position: relative;\
            page-break-after: always;\
        }\
        .pagination-main-contents-container {\
            position: absolute;\
        }\
        ";
        document.head.appendChild(stylesheet);
    };


    pagination.setPageStyle = function () {
        // Set style for a particular page size.
        var unit = pagination.config('lengthUnit'),
            contentsWidthNumber = pagination.config('pageWidth') - pagination.config(
                'innerMargin') - pagination.config('outerMargin'),
            contentsWidth = contentsWidthNumber + unit,
            contentsHeightNumber = pagination.config('pageHeight') - pagination
                .config('contentsTopMargin') - pagination.config(
                    'contentsBottomMargin'),
            contentsHeight = contentsHeightNumber + unit,
            pageWidth = pagination.config('pageWidth') + unit,
            pageHeight = pagination.config('pageHeight') + unit,
            contentsBottomMargin = pagination.config('contentsBottomMargin') +
                unit,
            innerMargin = pagination.config('innerMargin') + unit,
            outerMargin = pagination.config('outerMargin') + unit,
            pagenumberBottomMargin = pagination.config('pagenumberBottomMargin') +
                unit,
            headerTopMargin = pagination.config('headerTopMargin') + unit,
            imageMaxHeight = contentsHeightNumber - .1 + unit,
            imageMaxWidth = contentsWidthNumber - .1 + unit;

        pagination.pageStyleSheet.innerHTML = "\
            .pagination-page {height:" + pageHeight + "; width:" + pageWidth + ";\
            background-color: #fff;}\
            @page {size:" + pageWidth + " " + pageHeight + ";}\
            body {background-color: #efefef;}\
            @media screen{.pagination-page {border:solid 1px #000; margin-bottom:.2in;}} \
            .pagination-main-contents-container {width:" + contentsWidth + "; height:" + contentsHeight + ";\
                bottom:" + contentsBottomMargin + ";} \
            .pagination-contents-container {bottom:" + contentsBottomMargin + ";\
               height:" + contentsHeight + "}\
            .pagination-contents {height:" + contentsHeight + "; width:" + contentsWidth + ";}\
            img {max-height: " + imageMaxHeight + "; max-width: " + imageMaxWidth + ";}\
            .pagination-pagenumber {bottom:" + pagenumberBottomMargin + ";}\
            .pagination-header {top:" + headerTopMargin + ";}\
            .pagination-page:nth-child(odd) .pagination-main-contents-container, \
            .pagination-page:nth-child(odd) .pagination-pagenumber, \
            .pagination-page:nth-child(odd) .pagination-header {right:" + outerMargin + ";left:" + innerMargin + ";}\
            .pagination-page:nth-child(even) .pagination-main-contents-container, \
            .pagination-page:nth-child(even) .pagination-pagenumber, \
            .pagination-page:nth-child(even) .pagination-header {right:" + innerMargin + ";left:" + outerMargin + ";}\
            .pagination-page:nth-child(odd) .pagination-pagenumber,\
            .pagination-page:nth-child(odd) .pagination-header {text-align:right;}\
            .pagination-page:nth-child(odd) .pagination-header-section {display:none;}\
            .pagination-page:nth-child(even) .pagination-header-chapter {display:none;}\
            .pagination-page:nth-child(even) .pagination-pagenumber,\
            .pagination-page:nth-child(even) .pagination-header { text-align:left;}\
            .pagination-footnote > * > * {font-size: 0.7em; margin:.25em;}\
            .pagination-footnote > * > *::before, .pagination-footnote::before \
            {position: relative; top: -0.5em; font-size: 80%;}\
            ";

    };


    pagination.config = function (configKey) {
        /* Return configuration variables either from paginationConfig if present,
         * or using default values.
         */
        var returnValue;
        if (typeof paginationConfig != 'undefined' && paginationConfig.hasOwnProperty(configKey)) {
            returnValue = paginationConfig[configKey];
        } else if (defaults.hasOwnProperty(configKey)) {
            returnValue = defaults[configKey];
        } else {
            returnValue = false;
        }
        return returnValue;
    };

    pagination.cutToFit = function (contents) {

        contents.style.height = (contents.parentElement.clientHeight - contents.nextSibling.clientHeight) + 'px';

        contents.style[pagination.columnWidthTerm] = contents.clientWidth + 'px';
//window.scrollTo(0,document.body.scrollHeight);
        var coordinates = contents.getBoundingClientRect(),
            bottomLeftX = coordinates.left,
            bottomLeftY = coordinates.bottom,
            range = pagination.caretRange(bottomLeftX + 1, bottomLeftY - 1);


        range.setEndAfter(contents.lastChild);
        overflow = range.extractContents();


        return overflow;
    };


    pagination.createPage = function (container, pageCounterClass) {
        var page = document.createElement('div');
        page.classList.add('pagination-page');
        contentsContainer = document.createElement('div');
        contentsContainer.classList.add('pagination-contents-container');
        mainContentsContainer = document.createElement('div');
        mainContentsContainer.classList.add('pagination-main-contents-container');

        contents = document.createElement('div');
        contents.classList.add('pagination-contents');

        footnotes = document.createElement('div');
        footnotes.classList.add('pagination-footnotes');
        footnotes.innerHTML = "<p></p>";

        mainContentsContainer.appendChild(contents);
        mainContentsContainer.appendChild(footnotes);

        page.appendChild(mainContentsContainer);
        
        if (pagination.config('numberPages')) {
            pagenumberfield = document.createElement('div');
            pagenumberfield.classList.add('pagination-pagenumber');
            pagenumberfield.classList.add('pagination-' + pageCounterClass);

            page.appendChild(pagenumberfield);
        }
        
        
        container.appendChild(page);
        return contents;
    };

    pagination.fillPage = function (node, container) {

        var lastPage = pagination.createPage(container, 'arabic'),
            clonedNode = node.cloneNode(true),
            footnotes, footnotesLength, clonedFootnote, i, oldFn, fnHeightTotal;


        lastPage.appendChild(node);
        lastPage.nextSibling.scrollIntoView(false);

        if (lastPage.scrollHeight > lastPage.clientHeight) {

            overflow = pagination.cutToFit(lastPage);


            footnotes = lastPage.querySelectorAll('.pagination-footnote');
            footnotesLength = footnotes.length;
            if (footnotesLength > 0) {
                for (i = 0; i < footnotesLength; i++) {
                    clonedFootnote = footnotes[i].cloneNode(true);
                    lastPage.nextSibling.appendChild(clonedFootnote);
                }

                while (lastPage.firstChild) {
                    lastPage.removeChild(lastPage.firstChild);
                }


                lastPage.appendChild(clonedNode);
                lastPage.nextSibling.scrollIntoView(false);

                overflow = pagination.cutToFit(lastPage);

                for (i = lastPage.querySelectorAll('.pagination-footnote').length; i < footnotesLength; i++) {
                    oldFn = lastPage.nextSibling.children[i];

                    while (oldFn.firstChild) {
                        oldFn.removeChild(oldFn.firstChild);
                    }
                }
            }


            if ((overflow.firstChild.nodeName === 'P' || overflow.firstChild.nodeName === 'DIV') && overflow.firstChild.innerHTML.length === 0) {
                overflow.removeChild(overflow.firstChild);
            }
            if (lastPage.innerHTML === '<p></p>' || lastPage.innerHTML === '<div></div>') {
                lastPage.removeChild(lastPage.firstChild);
                lastPage.appendChild(overflow);
                setTimeout(function(){window.scrollTo(0,0);},1000);
            } else if (overflow.firstChild && lastPage.firstChild) {
                setTimeout(function(){
                pagination.fillPage(overflow, container);},1);
            } else {
                console.log('here')
                setTimeout(function(){window.scrollTo(0,0);},1000);
            }

        } else {
            window.scrollTo(0,0);
        }
    };

    pagination.flowElement = function (node, container) {
        var overflow = document.createDocumentFragment();

        while (node.firstChild) {
            overflow.appendChild(node.firstChild);
        }
        setTimeout( function() {
            window.scrollTo(0,document.body.scrollHeight);
            pagination.fillPage(overflow, container);
        }, 1);
    };

    if (pagination.config('autoStart') === true) {
        document.addEventListener(
            "readystatechange",
            function () {
                if (document.readyState === 'interactive') {
                    var imgs = document.images,
                        len = imgs.length,
                        counter = 0;

                    function incrementCounter() {
                        counter++;
                        if (counter === len) {
                            
                            pagination.flowElement(eval(pagination.config('flowElement')), document.body);
                        }
                    }

                    [].forEach.call(imgs, function (img) {
                        img.addEventListener('load', incrementCounter, false);
                    });

                }
            }
        );
    }
    exports.pagination = pagination;
}).call(this);

if (typeof paginationConfig === 'undefined' || !paginationConfig.hasOwnProperty('autostart') || paginationConfig.autostart === false) {
    pagination.initiate();
}