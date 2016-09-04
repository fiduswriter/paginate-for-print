export class PageCounterArab {
    // arab is the page counter used by the main body contents.

    /* Create a pagecounter. cssClass is the CSS class employed by this page
     * counter to mark all page numbers associated with it.
     */
    constructor() {
        this.cssClass = 'arab'
        this.counterValue = 0

    }

    show() {
        /* Standard show function for page counter is to show the value itself
         * using arabic numbers.
         */
        return this.counterValue
    }

    incrementAndShow() {
        /* Increment the page count by one and return the reuslt page count
         * using the show function.
         */
        this.counterValue++
        return this.show()
    }

    numberPages() {
        /* If the pages associated with this page counter need to be updated,
         * go through all of them from the start of the book and number them,
         * thereby potentially removing old page numbers.
         */
        this.counterValue = 0

        let pagenumbersToNumber = document.querySelectorAll(
            '.pagination-page .pagination-pagenumber.pagination-' +
            this.cssClass)
        for (let i = 0; i < pagenumbersToNumber.length; i++) {
            pagenumbersToNumber[i].innerHTML = this.incrementAndShow()
        }
    }
}



export class PageCounterRoman extends PageCounterArab {
    // roman is the page counter used by the frontmatter.
    constructor() {
        super()
        this.cssClass = 'roman'
    }

    show() {
        // Create roman numeral representations of numbers.
        let digits = String(+this.counterValue).split(""),
            key = ["", "C", "CC", "CCC", "CD", "D", "DC", "DCC", "DCCC",
                "CM",
                "",
                "X", "XX", "XXX", "XL", "L", "LX", "LXX", "LXXX", "XC",
                "",
                "I", "II",
                "III", "IV", "V", "VI", "VII", "VIII", "IX"
            ],
            roman = "",
            i = 3
        while (i--) {
            roman = (key[+digits.pop() + (i * 10)] || "") + roman
        }
        return new Array(+digits.join("") + 1).join("M") + roman
    }

}
