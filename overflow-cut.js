function flowElement(node, container) {
    var overflow = document.createDocumentFragment();
    
    while (node.firstChild) {
        overflow.appendChild(node.firstChild);
    }

    function checkForOverflow(el) {
        var isOverflowing,
            curOverflow = el.style.overflow;
        if ( !curOverflow || curOverflow === "visible" ) {
            el.style.overflow = "hidden";
        }
        isOverflowing = el.clientHeight < (el.scrollHeight-10);
        el.style.overflow = curOverflow;
        return isOverflowing;
    };
    
    
    function createPage  () {
        var pageNode = document.createElement('div');
        pageNode.classList.add('page');
        var contentArea = document.createElement('div');
        contentArea.classList.add('content');
        pageNode.appendChild(contentArea);
        container.appendChild(pageNode);
        return contentArea;
    }
    
    var splitter = 0;
    
    function fillPage (node) {
        var lastPage = createPage(), overflow = document.createDocumentFragment();
    
        lastPage.appendChild(node);
    
        while ( checkForOverflow(lastPage) ) {
            overflow.insertBefore(lastPage.lastChild, overflow.firstChild);
        }
        if (overflow.firstChild) {// || overflow.firstChild.nodeType === 3) {
            var splitNode = overflow.firstChild;
        
            lastPage.appendChild(splitNode);
        
            splitNode.classList.add('split');
            splitNode.setAttribute('data-split', splitter++);
            var newNode = splitNode.cloneNode();
            overflow.insertBefore(newNode, overflow.firstChild);
            while ( checkForOverflow(lastPage) ) {
                newNode.insertBefore(splitNode.lastChild, newNode.firstChild);
            }
            
            if (splitNode.childNodes.length===0) {
                lastPage.removeChild(splitNode);
                newNode.classList.remove('split');
                newNode.removeAttribute('data-split');
                splitter--;
            } else {
                console.log('something');
            }
        }    
            
        if (overflow.childNodes.length>0) {
            fillPage(overflow);
        }
    }
    fillPage(overflow);
}