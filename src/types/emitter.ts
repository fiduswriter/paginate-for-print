/**
 * Event-emitter surface mixed into classes via the `event-emitter` package's
 * prototype mutation. Classes declare `interface X extends PagedEventEmitter {}`
 * so consumers see the emitter methods.
 */
export interface PagedEventEmitter {
	on(type: string, listener: (...args: any[]) => void): void;
	once(type: string, listener: (...args: any[]) => void): void;
	off(type: string, listener: (...args: any[]) => void): void;
	emit(type: string, ...args: any[]): void;
}
