function flowElement(node, container) {
    var overflow = document.createDocumentFragment();

    while (node.firstChild) {
        overflow.appendChild(node.firstChild);
    }

    function caretRange(x, y) {
        if (document.caretPositionFromPoint) {
            // Firefox
            var position = document.caretPositionFromPoint(x, y),
                range = document.createRange();
            range.setStart(position.offsetNode, position.offset);
            return range;
        } else {
            // Webkit + Chrome
            return document.caretRangeFromPoint(x, y);
        }
    }

    
    function cutToFit(contents) {

            contents.style.height = (contents.parentElement.clientHeight-contents.nextSibling.clientHeight)+'px';

            contents.style[columnWidth] = contents.clientWidth + 'px';

            var coordinates = contents.getBoundingClientRect(),
            bottomLeftX = coordinates.left,
            bottomLeftY = coordinates.bottom,
            range = caretRange(bottomLeftX + 1, bottomLeftY - 1);


            range.setEndAfter(contents.lastChild);
            overflow = range.extractContents();
            

            return overflow;
    }
    
    function createPage() {
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
        footnotes.innerHTML="<p></p>";
        
        mainContentsContainer.appendChild(contents);
        mainContentsContainer.appendChild(footnotes);
        
        page.appendChild(mainContentsContainer);
        container.appendChild(page);
        return contents;
    }

    var splitter = 0;


    var columnWidth;

    if (document.body.style.webkitColumnWidth) {
        // Webkit + Chrome
        columnWidth = 'webkitColumnWidth';
    } else {
        // Firefox
        columnWidth = 'mozColumnWidth';
    }

    function fillPage(node) {

        var lastPage = createPage(), clonedNode = node.cloneNode(true), footnotes, footnotesLength, clonedFootnote, i, oldFn, fnHeightTotal;


        lastPage.appendChild(node);
        lastPage.scrollIntoView(true);

        if (lastPage.scrollHeight > lastPage.clientHeight) {
            
            overflow = cutToFit(lastPage);
            
            
            footnotes = lastPage.querySelectorAll('.pagination-footnote');
            footnotesLength = footnotes.length;
            if (footnotesLength > 0) {
                for (i=0;i<footnotesLength;i++) {
                    clonedFootnote = footnotes[i].cloneNode(true);
                    lastPage.nextSibling.appendChild(clonedFootnote);
                }
                
                while (lastPage.firstChild) {
                    lastPage.removeChild(lastPage.firstChild);
                }
                
                
                lastPage.appendChild(clonedNode);
                lastPage.scrollIntoView(true);
                
                overflow = cutToFit(lastPage);
                
                for (i=lastPage.querySelectorAll('.pagination-footnote').length;i<footnotesLength;i++) {
                    oldFn = lastPage.nextSibling.children[i];
                    
                    while(oldFn.firstChild) {
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
            } else if (overflow.firstChild && lastPage.firstChild) {
                fillPage(overflow);
            }

        }
    }
    fillPage(overflow);
}