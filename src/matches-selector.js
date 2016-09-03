
export function matchesSelector(element, selector) {

    if (navigator.userAgent.toLowerCase().indexOf('firefox') > -1) {
        // Firefox
        return element.mozMatchesSelector(selector)
    } else {
        // Webkit + Chrome + Edge
        return element.webkitMatchesSelector(selector)
    }
}
