/**
 * One-shot HTTP fetch adapter over `XMLHttpRequest`.
 *
 * Performs a single request for `url` and resolves to a standard WHATWG
 * `Response` built from the response body text and the status code. It is the
 * engine's only outbound network primitive; the Polisher uses it to fetch
 * each stylesheet URL and, recursively, each `@import` target.
 *
 * This exists on `XMLHttpRequest` rather than the modern `fetch` API for
 * local-file support: when a document is opened from the filesystem
 * (`file://`), Chrome reports XHR status `0` instead of the real HTTP status
 * (there is no HTTP involved). That specific case is normalized to status
 * `200` so local stylesheets load successfully; `fetch` either fails on
 * `file://` URLs in Chrome or rejects on network-level conditions with a
 * `TypeError`, so it cannot express this. Everything else about the returned
 * `Response` comes from the platform `Response` constructor.
 *
 * The resolved `Response` is a plain constructor default: it carries only the
 * automatic `content-type: text/plain;charset=UTF-8` header (for a string
 * body); all real HTTP response headers of the original request are
 * discarded — callers consume `.text()` only.
 *
 * Rejection model:
 * - a synchronous `open`/`setRequestHeader`/`send` failure (invalid or
 *   forbidden method, non-convertible body, ...) rejects the returned promise
 *   with the thrown error object;
 * - a network-level failure rejects with the XHR error progress EVENT object
 *   itself — not an `Error` instance (no `.message`, no `.status`, no stack).
 *
 * If the `Response` constructor throws inside the load handler (it throws a
 * `RangeError` for any status outside 200–599, reachable when a non-`file://`
 * URL completes with status 0), the returned promise NEVER SETTLES: event
 * listener exceptions do not reject promises. The same holds if the request
 * is somehow aborted (no reference to the XHR escapes, so nothing in normal
 * code can abort it).
 *
 * @param {string} url - The URL to request, forwarded exactly as passed, with
 *   no resolution, validation, or normalization (relative URLs are resolved
 *   by the browser against the document base; `file://` URLs are allowed
 *   through — that is the point of the status normalization).
 * @param {object} [options] - Request options; unknown keys are ignored.
 * @param {string} [options.method] - The request method, forwarded with its
 *   case preserved; falls back to the literal lowercase `"get"` when falsy
 *   (an empty-string method also becomes `"get"`).
 * @param {Record<string, string>} [options.headers] - Request headers, set
 *   via a `for-in` loop: inherited enumerable keys are included, integer-like
 *   keys are visited first, and nullish is a zero-iteration no-op.
 * @param {string} [options.credentials] - Only the exact string `"include"`
 *   sets the XHR's `withCredentials` to `true`; any other value yields
 *   `false`.
 * @param {BodyInit | null} [options.body] - The request body, forwarded
 *   as-is when truthy; any falsy value (including `""`, `0`, `false`, and
 *   nullish) sends `null`.
 * @returns {Promise<Response>} Resolves to a `Response` when the XHR load
 *   event fires (any final HTTP status, including 404 and 500); rejects as
 *   described above; never settles if the `Response` constructor throws in
 *   the load handler. The request setup happens synchronously during the
 *   call itself; the promise settles asynchronously.
 */
export default async function request(
	url: string,
	options: {
		method?: string;
		headers?: Record<string, string>;
		credentials?: string;
		body?: BodyInit | null;
	} = {},
): Promise<Response> {
	return new Promise<Response>((resolve, reject) => {
		const xhr = new XMLHttpRequest();

		xhr.open(options.method || "get", url, true);
		for (const name in options.headers) {
			xhr.setRequestHeader(name, (options.headers as Record<string, string>)[name]);
		}
		xhr.withCredentials = options.credentials === "include";
		xhr.onload = () => {
			let status = xhr.status;
			if (status === 0 && url.startsWith("file://")) {
				status = 200;
			}
			resolve(new Response(xhr.responseText, { status }));
		};
		xhr.onerror = (evt) => {
			reject(evt);
		};
		xhr.send((options.body || null) as Document | XMLHttpRequestBodyInit | null);
	});
}
