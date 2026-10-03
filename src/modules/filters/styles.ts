import Handler from "../handler.js";
import type { HandlerSource } from "../handler.js";

/**
 * Handler that strips author stylesheets from the paginated content.
 *
 * Content-embedded `<style>` elements and stylesheet `<link>`s must never
 * travel into rendered pages: their rules would apply globally and outside
 * the polisher's control (e.g. a raw `body { column-count }` restyling the
 * page list itself). Styles are harvested from the content before parsing
 * (see Previewer.removeContentStyles) and processed through the polisher;
 * this filter is the safety net for anything that slips past that path.
 *
 * @class
 * @extends Handler
 */
class StylesFilter extends Handler {
	/**
	 * Create a StylesFilter instance.
	 *
	 * @param {Object} chunker - Responsible for managing document chunks during rendering.
	 * @param {Object} polisher - Handles post-processing and styling of content.
	 * @param {Object} caller - The entity invoking this handler (e.g., layout controller).
	 */
	constructor(chunker?: HandlerSource, polisher?: HandlerSource, caller?: HandlerSource) {
		super(chunker, polisher, caller);
	}

	/**
	 * Removes content-embedded stylesheets from the given DOM content.
	 *
	 * @param {DocumentFragment | HTMLElement} content - The DOM content to sanitize.
	 */
	filter(content: DocumentFragment | HTMLElement) {
		content
			.querySelectorAll(
				"style:not([data-paged-inserted-styles]), " +
					"link[rel='stylesheet']",
			)
			.forEach((element) => {
				element.remove();
			});
	}
}

export default StylesFilter;
