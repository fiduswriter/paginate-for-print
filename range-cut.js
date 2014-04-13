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
    };

    function createPage() {
        var pageNode = document.createElement('div');
        pageNode.classList.add('page');
        var contentArea = document.createElement('div');
        contentArea.classList.add('content');
        pageNode.appendChild(contentArea);
        container.appendChild(pageNode);
        return contentArea;
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

        var lastPage = createPage(),
            coordinates, bottomLeftX, bottomLeftY;


        lastPage.appendChild(node);
        lastPage.scrollIntoView(true);

        if (lastPage.scrollHeight > lastPage.clientHeight) {
            lastPage.style[columnWidth] = lastPage.clientWidth + 'px';

            coordinates = lastPage.getBoundingClientRect();
            bottomLeftX = coordinates.left;
            bottomLeftY = coordinates.bottom;
            range = caretRange(bottomLeftX + 1, bottomLeftY - 1);


            range.setEndAfter(lastPage.lastChild);
            overflow = range.extractContents();
            lastPage.style[columnWidth] = 'auto';
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