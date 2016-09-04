export const DEFAULT_CONFIG_VALUES = {
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
    callback: function() {},

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
}
