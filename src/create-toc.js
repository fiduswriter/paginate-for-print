import {matchesSelector} from "./matches-selector"

export function createToc() {
    let tocDiv = document.createElement('div'),
        tocTitleH1 = document.createElement('h1'),
        tocItems = document.getElementById('pagination-layout').querySelectorAll(
            '.pagination-body'),
        itemType

    tocDiv.id = 'pagination-toc'
    tocTitleH1.id = 'pagination-toc-title'
    tocDiv.appendChild(tocTitleH1)

    for (let i = 0; i < tocItems.length; i++) {
        if (matchesSelector(tocItems[i],
                '.pagination-chapter')) {
            itemType = 'chapter'
        } else if (matchesSelector(tocItems[i],
                '.pagination-section')) {
            itemType = 'section'
        } else {
            continue
        }
        let tocItemDiv = document.createElement('div')
        tocItemDiv.classList.add('pagination-toc-entry')
        let tocItemTextSpan = document.createElement('span')
        tocItemTextSpan.classList.add('pagination-toc-text')

        tocItemTextSpan.appendChild(document.createTextNode(
            tocItems[i].querySelector('.pagination-header-' +
                itemType).textContent.trim()))
        tocItemDiv.appendChild(tocItemTextSpan)

        let tocItemPnSpan = document.createElement('span')
        tocItemPnSpan.classList.add('pagination-toc-pagenumber')

        tocItemPnSpan.appendChild(document.createTextNode(tocItems[
                i].querySelector('.pagination-pagenumber').textContent
            .trim()))

        tocItemDiv.appendChild(tocItemPnSpan)

        tocDiv.appendChild(tocItemDiv)
    }

    return tocDiv

}
