/**
 * Opt-in counters for layout-triggering DOM reads performed by paged-with-floats.
 *
 * Installed lazily (settings.debugDomOps or window.__PAGED_DEBUG.domops)
 * by wrapping the relevant prototype accessors; zero overhead otherwise.
 * These count JavaScript-level reads; engine-side layouts are visible via
 * CDP Performance.getMetrics (LayoutCount) in test harnesses.
 */

export interface DomOpStats {
	rectReads: number;
	rectsReads: number;
	rangeRectReads: number;
	scrollReads: number;
	clientReads: number;
	offsetReads: number;
	installed: boolean;
}

const stats: DomOpStats = {
	rectReads: 0,
	rectsReads: 0,
	rangeRectReads: 0,
	scrollReads: 0,
	clientReads: 0,
	offsetReads: 0,
	installed: false,
};

export function getDomOpStats(): DomOpStats {
	return stats;
}

export function resetDomOpStats(): void {
	stats.rectReads = 0;
	stats.rectsReads = 0;
	stats.rangeRectReads = 0;
	stats.scrollReads = 0;
	stats.clientReads = 0;
	stats.offsetReads = 0;
}

export function installDomOperationCounters(): void {
	if (stats.installed || typeof Element === "undefined") {
		return;
	}
	stats.installed = true;

	const wrapMethod = (
		proto: unknown,
		name: string,
		key: keyof DomOpStats,
	) => {
		const descriptor = Object.getOwnPropertyDescriptor(proto, name);
		if (!descriptor || typeof descriptor.value !== "function") {
			return;
		}
		const original = descriptor.value as (...args: unknown[]) => unknown;
		Object.defineProperty(proto, name, {
			...descriptor,
			value(this: unknown, ...args: unknown[]) {
				stats[key]++;
				return original.apply(this, args);
			},
		});
	};

	const wrapGetter = (
		proto: unknown,
		prop: string,
		key: keyof DomOpStats,
	) => {
		const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
		if (!descriptor || !descriptor.get) {
			return;
		}
		const getter = descriptor.get;
		Object.defineProperty(proto, prop, {
			...descriptor,
			get(this: unknown) {
				stats[key]++;
				return getter.call(this);
			},
		});
	};

	wrapMethod(Element.prototype as unknown as object, "getBoundingClientRect", "rectReads");
	wrapMethod(Element.prototype as unknown as object, "getClientRects", "rectsReads");
	wrapMethod(Range.prototype as unknown as object, "getBoundingClientRect", "rangeRectReads");
	wrapMethod(Range.prototype as unknown as object, "getClientRects", "rangeRectReads");

	wrapGetter(Element.prototype as unknown as object, "scrollWidth", "scrollReads");
	wrapGetter(Element.prototype as unknown as object, "scrollHeight", "scrollReads");
	wrapGetter(Element.prototype as unknown as object, "scrollLeft", "scrollReads");
	wrapGetter(Element.prototype as unknown as object, "scrollTop", "scrollReads");
	wrapGetter(Element.prototype as unknown as object, "clientWidth", "clientReads");
	wrapGetter(Element.prototype as unknown as object, "clientHeight", "clientReads");
	wrapGetter(HTMLElement.prototype as unknown as object, "offsetTop", "offsetReads");
	wrapGetter(HTMLElement.prototype as unknown as object, "offsetLeft", "offsetReads");
	wrapGetter(HTMLElement.prototype as unknown as object, "offsetWidth", "offsetReads");
	wrapGetter(HTMLElement.prototype as unknown as object, "offsetHeight", "offsetReads");
	wrapGetter(HTMLElement.prototype as unknown as object, "offsetParent", "offsetReads");
}
