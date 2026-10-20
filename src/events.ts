// `Events` and `Component` from obsidian.d.ts.

type Fn = (...data: any[]) => unknown;

export interface EventRef {
	e: Events;
	name: string;
	fn: Fn;
	ctx?: any;
}

export class Events {
	private _events: Record<string, EventRef[]> = {};

	on(name: string, callback: Fn, ctx?: any): EventRef {
		const ref: EventRef = { e: this, name, fn: callback, ctx };
		(this._events[name] ??= []).push(ref);
		return ref;
	}

	off(name: string, callback: Fn): void {
		const list = this._events[name];
		if (list) this._events[name] = list.filter((r) => r.fn !== callback);
	}

	offref(ref: EventRef): void {
		if (!ref) return; // plugins sometimes unregister refs they never got
		const list = this._events[ref.name];
		if (list) this._events[ref.name] = list.filter((r) => r !== ref);
	}

	trigger(name: string, ...data: unknown[]): void {
		// Copy: handlers may unsubscribe while we iterate.
		for (const ref of [...(this._events[name] ?? [])]) this.tryTrigger(ref, data);
	}

	tryTrigger(ref: EventRef, args: unknown[]): void {
		try {
			ref.fn.apply(ref.ctx, args);
		} catch (e) {
			// One bad listener (often a plugin) must not break the others.
			console.error(e);
		}
	}
}

export class Component {
	_loaded = false;
	/** @internal (Plugin.load awaits onload, then loads children itself) */
	_children: Component[] = [];
	/** @internal */
	_cleanups: (() => any)[] = [];

	load(): void {
		if (this._loaded) return;
		this._loaded = true;
		this.onload();
		for (const c of this._children) c.load();
	}

	onload(): void {}

	unload(): void {
		if (!this._loaded) return;
		this._loaded = false;
		for (const c of this._children.splice(0)) c.unload();
		for (const fn of this._cleanups.splice(0)) fn();
		this.onunload();
	}

	onunload(): void {}

	addChild<T extends Component>(component: T): T {
		this._children.push(component);
		if (this._loaded) component.load();
		return component;
	}

	removeChild<T extends Component>(component: T): T {
		const i = this._children.indexOf(component);
		if (i >= 0) {
			this._children.splice(i, 1);
			component.unload();
		}
		return component;
	}

	register(cb: () => any): void {
		this._cleanups.push(cb);
	}

	registerEvent(ref: EventRef): void {
		this.register(() => ref.e.offref(ref));
	}

	registerDomEvent(el: EventTarget, type: string, callback: (ev: any) => any, options?: boolean | AddEventListenerOptions): void {
		el.addEventListener(type, callback, options);
		this.register(() => el.removeEventListener(type, callback, options));
	}

	registerInterval(id: number): number {
		this.register(() => clearInterval(id));
		return id;
	}
}

export interface Debouncer<T extends unknown[], V> {
	(...args: T): void;
	cancel(): Debouncer<T, V>;
	run(): V | void;
}

/** obsidian.d.ts `debounce`: trailing call after `timeout` ms; `resetTimer` restarts the wait on every call. */
export function debounce<T extends unknown[], V>(cb: (...args: T) => V, timeout = 0, resetTimer = false): Debouncer<T, V> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let lastArgs: T | null = null;
	const fire = () => {
		timer = null;
		const args = lastArgs!;
		lastArgs = null;
		return cb(...args);
	};
	const d = ((...args: T) => {
		lastArgs = args;
		if (timer && resetTimer) {
			clearTimeout(timer);
			timer = null;
		}
		if (!timer) timer = setTimeout(fire, timeout);
	}) as Debouncer<T, V>;
	d.cancel = () => {
		if (timer) clearTimeout(timer);
		timer = null;
		lastArgs = null;
		return d;
	};
	d.run = () => {
		if (!timer) return;
		clearTimeout(timer);
		return fire();
	};
	return d;
}
