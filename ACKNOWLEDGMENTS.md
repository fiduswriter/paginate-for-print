# Acknowledgments

This project exists because of the extraordinary work of the Paged.js
development team, whose code forms the foundation that this project builds upon.
We gratefully acknowledge:

**Fred Chasen**, the principal author and architect of Paged.js. Fred wrote the
overwhelming majority of the codebase — several hundred commits covering the
chunker, the fragmentation and overflow engine, the CSS polisher, the page
template system, the handler and hooks architecture, and most of the feature
modules, including footnotes, string-sets, target-counters, generated content,
breaks and splits. Virtually every line of pagination machinery in this
repository originates in his work, and this project would not exist without it.

**Julien Taquet**, long-time core developer, who contributed continuously
across the whole project — typography and print CSS handling, page margin
boxes, named pages, bleed and marks support, and years of day-to-day
maintenance, testing and refinement of the rendering pipeline.

**Julie Blanc**, long-time core developer and designer, whose contributions
shaped the CSS processing side of the library — from `@page` conversion and
margin boxes to the visual design of paginated output — along with extensive
testing and documentation of print behaviors.

**Guillaume Grossetie**, one of the most prolific external contributors, whose
many commits improved the chunker and layout engine, break handling, and
numerous edge cases throughout the codebase.

**Nellie McKesson**, whose early contributions helped carry the project through
its formative period.

With additional substantial contributions from:

Martin Heini,
Thomas Parisot,
Antonin Libotte,
Erik Schilling,
Marius Dumitru Florea,
Nigel Cunningham,
William Muir,
Martin Olsson,
Nathan Schulzke,
Gijs de Heij,

and further fixes and improvements from:

Andrey Kislyuk,
Angela Liu,
Chris Beaven,
Edoardo Tona,
JenniferVdL,
Jonathan Boarman,
Lucas Willems,
Malte Rohde,
Mauro Bieg,
Nicholas Wylie,
Patrick Kranz,
Rob Mayer,
Sam Ruby,
Stéphane Elbaron,
Talbi Youssef,
Urban Suppiger,
Yann Trividic,
Antoine Fauchié,
mb21,
wangfengming,
wenbei421.

Thank you — every page rendered by this library rests on your work.

## License provenance

This project began as a fork of [Paged.js](https://github.com/pagedjs/pagedjs).
All code originally derived from Paged.js has since been replaced with
independent implementations, so the entirety of the current source is written
and maintained as part of **paged-with-floats** and
is licensed under the **GNU Lesser General Public License, version 3 or later
(LGPL-3.0-or-later)** — see the [License](./README.md#license) section and the
full license texts in [`COPYING.LESSER`](./COPYING.LESSER) and
[`COPYING`](./COPYING). The credits above are retained as historical
acknowledgment of the ideas and architecture this project grew out of.
