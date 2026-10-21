// The `obsidian` module that community plugins `require('obsidian')`, plus the require() shim for their other externals.
// Coverage against obsidian.d.ts: `npm run api-coverage`.
import * as cmAutocomplete from '@codemirror/autocomplete';
import * as cmCommands from '@codemirror/commands';
import * as cmLanguage from '@codemirror/language';
import * as cmState from '@codemirror/state';
import * as cmView from '@codemirror/view';
import * as lezerCommon from '@lezer/common';
import * as lezerHighlight from '@lezer/highlight';
import * as lezerLr from '@lezer/lr';
import DOMPurify from 'dompurify';
import { dump as dumpYaml, load as loadYaml, CORE_SCHEMA } from 'js-yaml';
import moment from 'moment';
import { BaseAdapter } from './adapters';
import { loadPdfJs } from './views/pdf';
import { BasesView } from './bases/base';
import {
	BooleanValue, DateValue, DurationValue, FileValue, HTMLValue, IconValue, ImageValue, LinkValue, ListValue, NotNullValue, NullValue,
	NumberValue, ObjectValue, PrimitiveValue, RegExpValue, RelativeDateValue, StringValue, TagValue, UrlValue, Value,
} from './bases/values';
import { Editor } from './editor';
import { Component, Events, debounce } from './events';
import { FileManager } from './filemanager';
import { addIcon, getIcon, getIconIds, removeIcon, setIcon } from './icons';
import { Keymap, Scope, isMac } from './keymap';
import { MetadataCache } from './metadata';
import { SettingPage, SettingTab } from './modals';
import { request, requestUrl } from './network';
import { getAllTags, getLinkpath, parseLinktext } from './parse';
import { Plugin, PluginSettingTab } from './plugins';
import {
	MarkdownPreviewRenderer, MarkdownRenderChild, MarkdownRenderer, finishRenderMath, loadMathJax, loadMermaid, loadPrism, renderMath,
} from './render';
import { AbstractInputSuggest, EditorSuggest, PopoverSuggest } from './suggest';
import {
	AbstractTextComponent, BaseComponent, ButtonComponent, ColorComponent, ConfirmationButton, ConfirmationModal, DropdownComponent,
	ExtraButtonComponent, FuzzySuggestModal, Menu, MenuItem, Modal, MomentFormatComponent, ProgressBarComponent, SearchComponent,
	SecretComponent, SecretStorage, Setting, SettingGroup, SliderComponent, SuggestModal, TextAreaComponent, TextComponent, ToggleComponent, ValueComponent,
	prepareFuzzySearch, prepareSimpleSearch, renderMatches, renderResults,
} from './ui';
import { TAbstractFile, TFile, TFolder, Vault, normalizePath } from './vault';
import { MarkdownView, editorEditorField, editorInfoField, editorLivePreviewField, editorViewField } from './views/markdown';
import {
	FileView, ItemView, Notice, TextFileView, View, Workspace, WorkspaceItem, WorkspaceLeaf, WorkspaceParent, WorkspaceRibbon,
	WorkspaceRoot, WorkspaceSidedock, WorkspaceSplit, WorkspaceTabs,
} from './workspace';

/** The obsidian.d.ts version this host targets (plugins gate features with requireApiVersion). */
export const apiVersion = '1.14.4';

const ua = navigator.userAgent;
export const Platform = {
	isDesktop: true,
	isMobile: false,
	isDesktopApp: false,
	isMobileApp: false,
	isIosApp: false,
	isAndroidApp: false,
	isPhone: false,
	isTablet: false,
	isMacOS: isMac,
	isWin: /Windows/.test(ua),
	isLinux: /Linux/.test(ua) && !/Android/.test(ua),
	isSafari: /Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua),
	resourcePathPrefix: 'blob:',
	/** onsidian extension: lets plugins detect the web build. */
	isWeb: true,
};

function compareVersions(a: string, b: string): number {
	const pa = a.split('.').map(Number);
	const pb = b.split('.').map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d) return d;
	}
	return 0;
}

export function requireApiVersion(version: string): boolean {
	return compareVersions(apiVersion, version) >= 0;
}

export const parseYaml = (yaml: string): any => loadYaml(yaml, { schema: CORE_SCHEMA });
export const stringifyYaml = (obj: any): string => dumpYaml(obj, { schema: CORE_SCHEMA, lineWidth: -1 });

export function sanitizeHTMLToDom(html: string): DocumentFragment {
	return DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true });
}

/** Minimal HTML → Markdown for common elements (headings, emphasis, links, lists, code, paragraphs). */
export function htmlToMarkdown(html: string | HTMLElement | Document | DocumentFragment): string {
	const root = typeof html === 'string' ? sanitizeHTMLToDom(html) : html;
	const walk = (n: Node): string => {
		if (n.nodeType === Node.TEXT_NODE) return n.textContent ?? '';
		if (!(n instanceof Element)) return [...n.childNodes].map(walk).join('');
		const inner = [...n.childNodes].map(walk).join('');
		switch (n.tagName) {
			case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': return `\n${'#'.repeat(Number(n.tagName[1]))} ${inner.trim()}\n\n`;
			case 'STRONG': case 'B': return `**${inner}**`;
			case 'EM': case 'I': return `*${inner}*`;
			case 'DEL': case 'S': return `~~${inner}~~`;
			case 'MARK': return `==${inner}==`;
			case 'CODE': return n.parentElement?.tagName === 'PRE' ? inner : `\`${inner}\``;
			case 'PRE': return `\n\`\`\`\n${inner.replace(/\n$/, '')}\n\`\`\`\n\n`;
			case 'A': return `[${inner}](${n.getAttribute('href') ?? ''})`;
			case 'IMG': return `![${n.getAttribute('alt') ?? ''}](${n.getAttribute('src') ?? ''})`;
			case 'BR': return '\n';
			case 'P': case 'DIV': return `${inner.trim()}\n\n`;
			case 'LI': return `${n.parentElement?.tagName === 'OL' ? `${[...n.parentElement.children].indexOf(n) + 1}.` : '-'} ${inner.trim()}\n`;
			case 'UL': case 'OL': return `${inner}\n`;
			case 'BLOCKQUOTE': return inner.trim().split('\n').map((l) => `> ${l}`).join('\n') + '\n\n';
			case 'HR': return '\n---\n\n';
			default: return inner;
		}
	};
	return walk(root).replace(/\n{3,}/g, '\n\n').trim();
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
	let s = '';
	for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
	return btoa(s);
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
}

export function arrayBufferToHex(buf: ArrayBuffer): string {
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToArrayBuffer(hex: string): ArrayBuffer {
	return new Uint8Array(hex.match(/../g)?.map((h) => parseInt(h, 16)) ?? []).buffer;
}

export function stripHeading(heading: string): string {
	return heading.replace(/[!"#$%&()*+,.:;<=>?@^`{|}~/[\]\\\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function stripHeadingForLink(heading: string): string {
	return heading.replace(/[:#|^\\\r\n]|%%|\[\[|\]\]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function parseFrontMatterAliases(fm: any): string[] | null {
	return parseFrontMatterStringArray(fm, /^alias(es)?$/i);
}

export function parseFrontMatterTags(fm: any): string[] | null {
	const tags = parseFrontMatterStringArray(fm, /^tags?$/i, true);
	return tags?.map((t) => (t.startsWith('#') ? t : `#${t}`)) ?? null;
}

export function parseFrontMatterEntry(fm: any, key: string | RegExp): any | null {
	if (!fm) return null;
	for (const k of Object.keys(fm)) if (typeof key === 'string' ? k === key : key.test(k)) return fm[k];
	return null;
}

export function parseFrontMatterStringArray(fm: any, key: string | RegExp, nospaces = false): string[] | null {
	const v = parseFrontMatterEntry(fm, key);
	if (v == null) return null;
	const list = Array.isArray(v) ? v : String(v).split(nospaces ? /[,\s]+/ : /,/);
	const out = list.map((x) => String(x).trim()).filter(Boolean);
	return out.length ? out : null;
}

export function getFrontMatterInfo(content: string): { exists: boolean; frontmatter: string; from: number; to: number; contentStart: number } {
	const m = /^---\r?\n([\s\S]*?\r?\n)?---(\r?\n|$)/.exec(content);
	if (!m) return { exists: false, frontmatter: '', from: 0, to: 0, contentStart: 0 };
	return { exists: true, frontmatter: m[1] ?? '', from: 4, to: 4 + (m[1]?.length ?? 0), contentStart: m[0].length };
}

export function iterateCacheRefs(cache: any, cb: (ref: any) => boolean | void): boolean {
	for (const ref of [...(cache?.links ?? []), ...(cache?.embeds ?? []), ...(cache?.frontmatterLinks ?? [])]) if (cb(ref)) return true;
	return false;
}

export const iterateRefs = (refs: any[], cb: (ref: any) => boolean | void): boolean => refs.some((r) => cb(r) === true);

/** Resolve "#Heading" / "#^block" inside a file's cache. */
export function resolveSubpath(cache: any, subpath: string): any {
	if (subpath.startsWith('#^')) {
		const block = cache?.blocks?.[subpath.slice(2)];
		return block ? { type: 'block', block, start: block.position.start, end: block.position.end } : null;
	}
	const want = subpath.replace(/^#/, '').split('#').pop()!.trim().toLowerCase();
	const hs = cache?.headings ?? [];
	const i = hs.findIndex((h: any) => stripHeading(h.heading).toLowerCase() === stripHeading(want).toLowerCase());
	if (i < 0) return null;
	const next = hs.slice(i + 1).find((h: any) => h.level <= hs[i].level);
	return { type: 'heading', current: hs[i], next: next ?? null, start: hs[i].position.start, end: next?.position.start ?? null };
}

export function sortSearchResults(results: { match: { score: number } }[]): void {
	results.sort((a, b) => b.match.score - a.match.score);
}

export function displayTooltip(el: HTMLElement, text: string): void {
	el.setAttr('aria-label', text);
}

export function setTooltip(el: HTMLElement, text: string): void {
	el.setAttr('aria-label', text);
}

// ---- Classes plugins only use for instanceof / typing on web ----
/** Desktop/mobile adapters: real classes (so `instanceof` works) that nothing on the web is an instance of. */
export class FileSystemAdapter {}
export class CapacitorAdapter {}
export class TExternalFile extends TAbstractFile {}
export class MenuSeparator {}
export class MarkdownPreviewView {
	/** Legacy static renderer (deprecated in Obsidian, still used by plugins). */
	static renderMarkdown(markdown: string, el: HTMLElement, sourcePath: string, component: Component): Promise<void> {
		return MarkdownRenderer.render((window as any).app, markdown, el, sourcePath, component);
	}
	static render(...args: Parameters<typeof MarkdownRenderer.render>): Promise<void> {
		return MarkdownRenderer.render(...args);
	}
}
export class MarkdownEditView {}
export class WorkspaceContainer extends WorkspaceSplit {}
export class WorkspaceWindow extends WorkspaceContainer {}
export class WorkspaceFloating extends WorkspaceParent {
	protected renderChildren(): void {}
}
export class WorkspaceMobileDrawer extends WorkspaceParent {
	protected renderChildren(): void {}
}
export enum PopoverState { Showing, Shown, Hiding, Hidden }

/** A popover anchored to an element (page preview uses its own; plugins build custom ones with this). */
export class HoverPopover extends Component {
	hoverEl = createDiv('popover hover-popover');
	state = PopoverState.Showing;
	constructor(_parent: unknown, targetEl: HTMLElement | null, _waitTime?: number, staticPos?: { x: number; y: number } | null) {
		super();
		document.body.appendChild(this.hoverEl);
		const r = targetEl?.getBoundingClientRect();
		this.hoverEl.style.left = `${staticPos?.x ?? r?.left ?? 0}px`;
		this.hoverEl.style.top = `${staticPos?.y ?? (r ? r.bottom + 6 : 0)}px`;
		this.state = PopoverState.Shown;
		this.load();
	}
	onunload(): void {
		this.state = PopoverState.Hidden;
		this.hoverEl.detach();
	}
	hide(): void {
		this.unload();
	}
}

/** Async work to finish before quitting (workspace 'quit' event). */
export class Tasks {
	private list: Promise<any>[] = [];
	add(cb: () => Promise<any>): void { this.list.push(cb()); }
	addPromise(p: Promise<any>): void { this.list.push(p); }
	isEmpty(): boolean { return !this.list.length; }
	promise(): Promise<any> { return Promise.all(this.list); }
}

export const getLanguage = (): string => (navigator.language || 'en').split('-')[0];
export const getBlobArrayBuffer = (blob: Blob): Promise<ArrayBuffer> => blob.arrayBuffer();
/** ViewPlugin exposing { mousedown } (Live Preview selection state). */
export const livePreviewState = cmView.ViewPlugin.define(() => ({ mousedown: false }));



/** The module object handed to plugins. Values are what the API exports at runtime. */
export const obsidianModule = {
	apiVersion, Platform, requireApiVersion, moment,
	// core
	Events, Component, debounce, Keymap, Scope, Notice,
	App: Object, // type-only in practice; plugins don't construct App
	Vault, TAbstractFile, TFile, TFolder, normalizePath, MetadataCache, FileManager, DataAdapter: BaseAdapter,
	FileSystemAdapter, CapacitorAdapter, TExternalFile, Tasks, SecretStorage,
	Plugin, PluginSettingTab, SettingTab, SettingPage, SettingGroup,
	// Bases
	BasesView, Value, NotNullValue, NullValue, PrimitiveValue, StringValue, NumberValue, BooleanValue, DateValue, RelativeDateValue,
	DurationValue, ListValue, ObjectValue, LinkValue, FileValue, TagValue, UrlValue, RegExpValue, HTMLValue, ImageValue, IconValue,
	// workspace & views
	Workspace, WorkspaceItem, WorkspaceParent, WorkspaceSplit, WorkspaceRoot, WorkspaceSidedock, WorkspaceTabs, WorkspaceLeaf,
	WorkspaceRibbon, WorkspaceContainer, WorkspaceWindow, WorkspaceFloating, WorkspaceMobileDrawer, View, ItemView, FileView, TextFileView, EditableFileView: TextFileView, MarkdownView,
	Editor, editorInfoField, editorViewField, editorLivePreviewField, editorEditorField, livePreviewState, MarkdownPreviewView, MarkdownEditView,
	// UI
	Modal, SuggestModal, FuzzySuggestModal, ConfirmationModal, ConfirmationButton, Menu, MenuItem, MenuSeparator, Setting,
	BaseComponent, ValueComponent, AbstractTextComponent, ToggleComponent, TextComponent, TextAreaComponent, SearchComponent,
	MomentFormatComponent, ProgressBarComponent, SecretComponent, DropdownComponent, SliderComponent, ColorComponent,
	ButtonComponent, ExtraButtonComponent, PopoverSuggest, AbstractInputSuggest, EditorSuggest, HoverPopover, PopoverState,
	getIconIds, getLanguage, getBlobArrayBuffer,
	setIcon, getIcon, addIcon, removeIcon, setTooltip, displayTooltip,
	// rendering
	MarkdownRenderer, MarkdownRenderChild, MarkdownPreviewRenderer, renderMath, finishRenderMath, loadMathJax, loadMermaid, loadPrism, loadPdfJs,
	// helpers
	requestUrl, request, parseYaml, stringifyYaml, sanitizeHTMLToDom, htmlToMarkdown,
	prepareFuzzySearch, prepareSimpleSearch, renderMatches, renderResults, sortSearchResults,
	getAllTags, getLinkpath, parseLinktext, parseFrontMatterAliases, parseFrontMatterTags, parseFrontMatterEntry,
	parseFrontMatterStringArray, getFrontMatterInfo, iterateCacheRefs, iterateRefs, resolveSubpath, stripHeading, stripHeadingForLink,
	arrayBufferToBase64, base64ToArrayBuffer, arrayBufferToHex, hexToArrayBuffer,
};

/** Node/Electron built-ins: a value that throws a clear error when used, so desktop-guarded code still loads. */
function unavailable(name: string): unknown {
	// A regular function (not an arrow): it needs a .prototype so `class X extends require('mod').Y` still loads.
	const fail = function () {
		throw new Error(`"${name}" is not available in the browser (onsidian). This plugin path is desktop-only.`);
	};
	return new Proxy(fail, { get: (_t, prop) => (prop === Symbol.toPrimitive || prop === 'then' ? undefined : fail), apply: fail, construct: fail });
}

/** Minimal POSIX `path`, enough for the many mobile-compatible plugins that import it. */
const path = {
	sep: '/',
	join: (...parts: string[]) => normalizePath(parts.join('/')),
	basename: (p: string, ext?: string) => {
		const b = p.slice(p.lastIndexOf('/') + 1);
		return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
	},
	dirname: (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.'),
	extname: (p: string) => {
		const b = p.slice(p.lastIndexOf('/') + 1);
		const i = b.lastIndexOf('.');
		return i > 0 ? b.slice(i) : '';
	},
	normalize: (p: string) => normalizePath(p),
	resolve: (...parts: string[]) => '/' + normalizePath(parts.join('/')),
	relative: (from: string, to: string) => {
		const a = normalizePath(from).split('/');
		const b = normalizePath(to).split('/');
		while (a.length && b.length && a[0] === b[0]) { a.shift(); b.shift(); }
		return [...a.map(() => '..'), ...b].join('/');
	},
	isAbsolute: (p: string) => p.startsWith('/'),
	posix: undefined as unknown,
};
path.posix = path;

/** Minimal Node `events` (many bundles subclass EventEmitter even on mobile). */
class EventEmitter {
	private _ev = new Map<string | symbol, ((...a: any[]) => void)[]>();
	private _max = 10;
	on(name: string | symbol, fn: (...a: any[]) => void): this {
		this._ev.set(name, [...(this._ev.get(name) ?? []), fn]);
		return this;
	}
	addListener(name: string | symbol, fn: (...a: any[]) => void): this { return this.on(name, fn); }
	prependListener(name: string | symbol, fn: (...a: any[]) => void): this {
		this._ev.set(name, [fn, ...(this._ev.get(name) ?? [])]);
		return this;
	}
	once(name: string | symbol, fn: (...a: any[]) => void): this {
		const wrap = (...a: any[]) => {
			this.off(name, wrap);
			fn.apply(this, a);
		};
		return this.on(name, wrap);
	}
	off(name: string | symbol, fn: (...a: any[]) => void): this {
		this._ev.set(name, (this._ev.get(name) ?? []).filter((f) => f !== fn));
		return this;
	}
	removeListener(name: string | symbol, fn: (...a: any[]) => void): this { return this.off(name, fn); }
	removeAllListeners(name?: string | symbol): this {
		if (name === undefined) this._ev.clear();
		else this._ev.delete(name);
		return this;
	}
	emit(name: string | symbol, ...args: any[]): boolean {
		const list = this._ev.get(name);
		if (!list?.length) {
			if (name === 'error') throw args[0] instanceof Error ? args[0] : new Error(String(args[0]));
			return false;
		}
		for (const f of [...list]) f.apply(this, args);
		return true;
	}
	listeners(name: string | symbol): ((...a: any[]) => void)[] { return [...(this._ev.get(name) ?? [])]; }
	listenerCount(name: string | symbol): number { return this._ev.get(name)?.length ?? 0; }
	eventNames(): (string | symbol)[] { return [...this._ev.keys()]; }
	setMaxListeners(n: number): this { this._max = n; return this; }
	getMaxListeners(): number { return this._max; }
}

/** Minimal Node `util`: the parts mobile-compatible bundles reach for at load time. */
const util = {
	promisify: (fn: (...a: any[]) => void) => (...args: any[]) => new Promise((res, rej) => fn(...args, (err: unknown, value: unknown) => (err ? rej(err) : res(value)))),
	format: (f: unknown, ...args: unknown[]) => {
		if (typeof f !== 'string') return [f, ...args].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
		let i = 0;
		return f.replace(/%[sdifjoO%]/g, (m) => (m === '%%' ? '%' : i < args.length ? (m === '%j' || m === '%o' || m === '%O' ? JSON.stringify(args[i++]) : String(args[i++])) : m));
	},
	inspect: (x: unknown) => {
		try { return typeof x === 'string' ? x : JSON.stringify(x); } catch { return String(x); }
	},
	inherits: (ctor: any, superCtor: any) => {
		Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
		Object.setPrototypeOf(ctor, superCtor);
	},
	deprecate: <T>(fn: T) => fn,
	isDeepStrictEqual: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b),
	types: {
		isPromise: (x: unknown) => x instanceof Promise,
		isDate: (x: unknown) => x instanceof Date,
		isRegExp: (x: unknown) => x instanceof RegExp,
	},
	TextEncoder,
	TextDecoder,
};

const modules: Record<string, unknown> = {
	obsidian: obsidianModule,
	moment,
	'@codemirror/state': cmState,
	'@codemirror/view': cmView,
	'@codemirror/language': cmLanguage,
	'@codemirror/commands': cmCommands,
	'@codemirror/autocomplete': cmAutocomplete,
	'@lezer/common': lezerCommon,
	'@lezer/highlight': lezerHighlight,
	'@lezer/lr': lezerLr,
	path,
	events: Object.assign(EventEmitter, { EventEmitter, default: EventEmitter }),
	util,
};

/**
 * Diagnostics (compat page sets window.__obsidianOnlineDiagnose): record API names plugins read that we don't provide,
 * in window.__obsidianOnlineMissing ("obsidian.X", "app.X", "app.workspace.X", ...).
 */
export function trackMissing<T extends object>(target: T, label: string): T {
	if (!(window as any).__obsidianOnlineDiagnose) return target;
	const missing: Map<string, number> = ((window as any).__obsidianOnlineMissing ??= new Map());
	return new Proxy(target, {
		get(t, prop, recv) {
			if (typeof prop === 'string' && !(prop in t) && !['then', 'toJSON', '__esModule', 'default'].includes(prop)) {
				const key = `${label}.${prop}`;
				missing.set(key, (missing.get(key) ?? 0) + 1);
			}
			return Reflect.get(t, prop, recv);
		},
	});
}

/**
 * ES5-compiled plugins (TypeScript target ES5) subclass with `_super.call(this, ...) || this`, which throws on ES2015
 * classes. Obsidian's own base classes tolerate it, so ours are exposed through callable wrappers: called without
 * `new`, the wrapper constructs a real instance for the subclass and returns it, which ES5 subclasses then use as `this`.
 */
function callable<C extends abstract new (...args: any[]) => any>(C: C): C {
	const F = function (this: any, ...args: unknown[]) {
		return Reflect.construct(C, args, new.target ?? this?.constructor ?? C);
	} as unknown as C;
	F.prototype = C.prototype;
	Object.setPrototypeOf(F, C);
	Object.defineProperty(F, 'name', { value: C.name });
	return F;
}

const isClass = (v: unknown): v is abstract new (...a: any[]) => any =>
	typeof v === 'function' && /^class[\s{]/.test(Function.prototype.toString.call(v));
const pluginFacingModule: Record<string, unknown> = Object.fromEntries(
	Object.entries(obsidianModule).map(([k, v]) => [k, isClass(v) ? callable(v) : v]),
);

export function pluginRequire(id: string): unknown {
	const name = id.replace(/^node:/, '');
	if (name === 'obsidian') return trackMissing(pluginFacingModule, 'obsidian');
	if (name in modules) return modules[name];
	// Externals we don't ship and Node/Electron built-ins: loadable, but unusable.
	return unavailable(name);
}

(window as any).moment = moment;

/**
 * Obsidian exposes CodeMirror 5's mode registry as `window.CodeMirror` (legacy syntax modes; Dataview, Admonition,
 * Spaced Repetition and others define or look up modes). Modes are stored, not used for highlighting: our editor is CM6.
 */
const cm5Modes: Record<string, unknown> = {};
const cm5Mime: Record<string, unknown> = {};
(window as any).CodeMirror ??= {
	modes: cm5Modes,
	mimeModes: cm5Mime,
	modeInfo: [] as unknown[],
	defineMode(name: string, factory: unknown, ...deps: string[]) {
		cm5Modes[name] = factory;
		void deps;
	},
	defineMIME(mime: string, spec: unknown) {
		cm5Mime[mime] = spec;
	},
	defineSimpleMode(name: string, states: unknown) {
		cm5Modes[name] = () => ({ startState: () => ({}), token: (stream: any) => (stream.skipToEnd?.(), null), states });
	},
	/** Instantiate a mode; unknown ones fall back to a null mode that consumes the line. */
	getMode(config: unknown, spec: string | { name: string }) {
		const name = typeof spec === 'string' ? spec : spec?.name;
		const factory = cm5Modes[name] as ((c: unknown, s: unknown) => any) | undefined;
		try {
			if (factory) return factory(config ?? {}, spec ?? {});
		} catch (e) {
			console.warn(`CodeMirror 5 mode "${name}" failed`, e);
		}
		return { name: 'null', token: (stream: any) => (stream.skipToEnd?.(), null) };
	},
	startState: (mode: any) => mode?.startState?.() ?? true,
	copyState: (_mode: unknown, state: any) => (state && typeof state === 'object' ? { ...state } : state),
	registerHelper() {},
	defineExtension() {},
	defineOption() {},
	Pass: { toString: () => 'CodeMirror.Pass' },
	commands: {},
	keyMap: {},
	runMode() {},
};
