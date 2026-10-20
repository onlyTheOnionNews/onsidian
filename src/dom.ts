// Global DOM/Array helpers that obsidian.d.ts declares (`declare global`) and plugins call directly.
// Types come from the `obsidian` package; this file provides the runtime.
// ponytail: phase-1 subset (the ones our UI and most plugins use); fill the rest from the API coverage list in phase 3.
import type {} from 'obsidian';

type Info = DomElementInfo | string | undefined;

function applyInfo(el: HTMLElement | SVGElement, o: Info): void {
	if (o === undefined) return;
	if (typeof o === 'string') o = { cls: o };
	if (o.cls) el.classList.add(...(Array.isArray(o.cls) ? o.cls : o.cls.split(' ')).filter(Boolean));
	if (o.text !== undefined) {
		if (typeof o.text === 'string') el.textContent = o.text;
		else el.replaceChildren(o.text);
	}
	if (o.attr) for (const [k, v] of Object.entries(o.attr)) if (v !== null) el.setAttribute(k, String(v));
	if (o.title !== undefined) el.setAttribute('title', o.title);
	if (o.value !== undefined && 'value' in el) (el as HTMLInputElement).value = o.value;
	if (o.type !== undefined) el.setAttribute('type', o.type);
	if (o.placeholder !== undefined) el.setAttribute('placeholder', o.placeholder);
	if (o.href !== undefined) el.setAttribute('href', o.href);
	if (o.parent) o.prepend ? (o.parent as ParentNode).prepend(el) : o.parent.appendChild(el);
}

function createElImpl<K extends keyof HTMLElementTagNameMap>(tag: K, o?: Info, cb?: (el: HTMLElementTagNameMap[K]) => void) {
	const el = document.createElement(tag);
	applyInfo(el, o);
	cb?.(el);
	return el;
}

function def(target: object, name: string, value: unknown): void {
	// Non-enumerable so `for…in` over arrays/objects isn't polluted.
	Object.defineProperty(target, name, { value, configurable: true, writable: true, enumerable: false });
}

const g = globalThis as any;
g.createEl = createElImpl;
g.createDiv = (o?: Info, cb?: any) => createElImpl('div', o, cb);
g.createSpan = (o?: Info, cb?: any) => createElImpl('span', o, cb);
g.createFragment = (cb?: (f: DocumentFragment) => void) => {
	const f = document.createDocumentFragment();
	cb?.(f);
	return f;
};
g.createSvg = (tag: string, o?: Info, cb?: any) => {
	const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
	applyInfo(el, o);
	cb?.(el);
	return el;
};
g.sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
g.nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));
g.fish = (sel: string) => document.querySelector(sel);
g.fishAll = (sel: string) => Array.from(document.querySelectorAll(sel));
g.activeWindow = window;
g.activeDocument = document;
g.isBoolean = (v: unknown) => typeof v === 'boolean';

for (const proto of [Node.prototype, DocumentFragment.prototype]) {
	def(proto, 'createEl', function (this: Node, tag: any, o?: Info, cb?: any) {
		const el = createElImpl(tag, o, cb);
		const info = typeof o === 'object' ? o : undefined;
		if (!info?.parent) info?.prepend ? (this as Element).prepend(el) : this.appendChild(el);
		return el;
	});
	def(proto, 'createDiv', function (this: any, o?: Info, cb?: any) { return this.createEl('div', o, cb); });
	def(proto, 'createSpan', function (this: any, o?: Info, cb?: any) { return this.createEl('span', o, cb); });
}

def(Node.prototype, 'detach', function (this: Node) { this.parentNode?.removeChild(this); });
def(Node.prototype, 'appendText', function (this: Node, val: string) { this.appendChild(document.createTextNode(val)); });
def(Node.prototype, 'insertAfter', function (this: Node, node: Node, child: Node | null) {
	return this.insertBefore(node, child ? child.nextSibling : this.firstChild);
});
def(Node.prototype, 'instanceOf', function (this: Node, type: abstract new (...a: any[]) => unknown) { return this instanceof type; });
Object.defineProperty(Node.prototype, 'doc', { configurable: true, get(this: Node) { return this.ownerDocument ?? document; } });
Object.defineProperty(Node.prototype, 'win', { configurable: true, get(this: Node) { return (this.ownerDocument ?? document).defaultView ?? window; } });
def(Node.prototype, 'empty', function (this: Node) { while (this.lastChild) this.removeChild(this.lastChild); });
def(Node.prototype, 'setText', function (this: Node, t: string | DocumentFragment) {
	if (typeof t === 'string') this.textContent = t;
	else { (this as any).empty(); this.appendChild(t); }
});

const E = Element.prototype;
def(E, 'getText', function (this: Element) { return this.textContent ?? ''; });
def(E, 'addClass', function (this: Element, ...c: string[]) { this.classList.add(...c); });
def(E, 'addClasses', function (this: Element, c: string[]) { this.classList.add(...c); });
def(E, 'removeClass', function (this: Element, ...c: string[]) { this.classList.remove(...c); });
def(E, 'removeClasses', function (this: Element, c: string[]) { this.classList.remove(...c); });
def(E, 'toggleClass', function (this: Element, c: string | string[], v: boolean) {
	for (const x of Array.isArray(c) ? c : [c]) this.classList.toggle(x, v);
});
def(E, 'hasClass', function (this: Element, c: string) { return this.classList.contains(c); });
def(E, 'setAttr', function (this: Element, k: string, v: string | number | boolean | null) {
	v === null ? this.removeAttribute(k) : this.setAttribute(k, String(v));
});
def(E, 'setAttrs', function (this: any, o: Record<string, any>) { for (const k in o) this.setAttr(k, o[k]); });
def(E, 'getAttr', function (this: Element, k: string) { return this.getAttribute(k); });
def(E, 'find', function (this: Element, s: string) { return this.querySelector(s); });
def(E, 'findAll', function (this: Element, s: string) { return Array.from(this.querySelectorAll(s)); });

const H = HTMLElement.prototype;
def(H, 'show', function (this: HTMLElement) { this.style.removeProperty('display'); });
def(H, 'hide', function (this: HTMLElement) { this.style.display = 'none'; });
def(H, 'toggle', function (this: any, show: boolean) { show ? this.show() : this.hide(); });
def(H, 'isShown', function (this: HTMLElement) { return this.style.display !== 'none' && this.isConnected; });

const A = Array.prototype;
def(A, 'first', function (this: unknown[]) { return this[0]; });
def(A, 'last', function (this: unknown[]) { return this[this.length - 1]; });
def(A, 'contains', function (this: unknown[], v: unknown) { return this.includes(v); });
def(A, 'remove', function (this: unknown[], v: unknown) {
	const i = this.indexOf(v);
	if (i >= 0) this.splice(i, 1);
});
def(A, 'unique', function (this: unknown[]) { return [...new Set(this)]; });
