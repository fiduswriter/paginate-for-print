// Chrome (+ possibly others) currently has issues when trying to find the real coordinates of elements when in multicol.
// This is a workaround that uses a range over the elements contents and combines all client rects around it.

export function getBoundingClientRect(element) {
    let r = document.createRange()
    r.setStart(element, 0)
    r.setEnd(element, element.childNodes.length)
    return r.getBoundingClientRect()
}
