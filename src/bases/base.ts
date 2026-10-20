// Bases core plugin (PLAN §5.5): .base files, ```base blocks and ![[x.base#View]] embeds.
// Query: every vault file → global + view filters → formulas → sort → group → limit → summaries.
// Layouts: table, cards, list, kanban; other view types come from plugins (Plugin.registerBasesView), e.g. Maps.
import { dump as dumpYaml, load as loadYaml, CORE_SCHEMA } from 'js-yaml';
import type { App } from '../app';
import { CorePlugin } from '../coreplugins';
import { Component, debounce } from '../events';
import { setIcon } from '../icons';
import { Keymap } from '../keymap';
import { getAllTags, parseLinktext } from '../parse';
import { MarkdownPreviewRenderer, MarkdownRenderChild } from '../render';
import { Menu, Modal, Setting, promptText } from '../ui';
import { TFile, type TAbstractFile } from '../vault';
import { Notice, TextFileView, type WorkspaceLeaf } from '../workspace';
import {
	HtmlVal, IconVal, ImageVal, LinkVal, compareVals, evalFilter, evaluate, isDate, isFile, summarize, toText,
	type EvalContext, type FileLike, type Filter, type Val,
} from './expr';
import { toApiValue, type Value } from './values';
import DOMPurify from 'dompurify';

// ---------------- Config ----------------

export interface ViewConfig {
	type: string;
	name: string;
	filters?: Filter;
	order?: string[];
	sort?: { property: string; direction?: 'ASC' | 'DESC' }[];
	groupBy?: { property: string; direction?: 'ASC' | 'DESC' };
	groupOrder?: (string | null)[];
	limit?: number;
	summaries?: Record<string, string>;
	[key: string]: unknown;
}

export interface BaseConfig {
	filters?: Filter;
	formulas?: Record<string, string>;
	properties?: Record<string, { displayName?: string }>;
	summaries?: Record<string, string>;
	views?: ViewConfig[];
}

export function parseBaseYaml(text: string): BaseConfig {
	const parsed = text.trim() ? loadYaml(text, { schema: CORE_SCHEMA }) : {};
	if (parsed === null || parsed === undefined) return {};
	if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('A base must be a YAML mapping.');
	return parsed as BaseConfig;
}

/** "status" → "note.status"; file./formula./note. ids pass through. */
export function propId(id: string): string {
	return /^(file|formula|note)\./.test(id) ? id : `note.${id}`;
}

export function displayName(cfg: BaseConfig, id: string): string {
	const p = propId(id);
	const bare = p.replace(/^note\./, '');
	const named = cfg.properties?.[p]?.displayName ?? cfg.properties?.[bare]?.displayName;
	if (named) return named;
	if (p.startsWith('note.')) return bare;
	if (p.startsWith('formula.')) return p.slice(8);
	return p.replace('file.', 'file ');
}

/** Expression that reads a property id (quotes names that aren't plain identifiers). */
function propExpr(id: string): string {
	const p = propId(id);
	const dot = p.indexOf('.');
	const scope = p.slice(0, dot);
	const name = p.slice(dot + 1);
	return /^[A-Za-z_][\w]*$/.test(name) ? `${scope}.${name}` : `${scope}[${JSON.stringify(name)}]`;
}

// ---------------- Query ----------------

export interface Row {
	file: TFile;
	fl: FileLike;
	ctx: EvalContext;
	get(prop: string): Val;
	errors: Map<string, string>;
}

export interface QueryResult {
	rows: Row[];
	groups: { key: Val; rows: Row[] }[] | null;
	order: string[];
	total: number;
	errors: string[];
}

export class BaseRunner {
	private files = new Map<TFile, FileLike>();

	constructor(private app: App, public config: BaseConfig, private self: TFile | null) {}

	fileLike(file: TFile): FileLike {
		let fl = this.files.get(file);
		if (fl) return fl;
		const { metadataCache, vault } = this.app;
		const cache = metadataCache.getFileCache(file);
		const dot = file.name.lastIndexOf('.');
		fl = {
			name: file.name,
			basename: dot > 0 ? file.name.slice(0, dot) : file.name,
			path: file.path,
			folder: file.parent && !file.parent.isRoot() ? file.parent.path : '',
			ext: file.extension,
			size: file.stat.size,
			ctime: file.stat.ctime,
			mtime: file.stat.mtime,
			properties: cache?.frontmatter ?? {},
			tags: cache ? getAllTags(cache) ?? [] : [],
			links: [...(cache?.links ?? []), ...(cache?.frontmatterLinks ?? [])].map((l) => parseLinktext(l.link).path),
			embeds: (cache?.embeds ?? []).map((l) => parseLinktext(l.link).path),
			backlinks: () => Object.entries(metadataCache.resolvedLinks)
				.filter(([, t]) => t[file.path])
				.map(([src]) => vault.getFileByPath(src))
				.filter((f): f is TFile => !!f)
				.map((f) => this.fileLike(f)),
			resolve: (path: string) => {
				const target = metadataCache.getFirstLinkpathDest(parseLinktext(path.replace(/^\[\[|\]\]$/g, '')).path, file.path) ?? vault.getFileByPath(path);
				return target ? this.fileLike(target) : null;
			},
		};
		this.files.set(file, fl);
		return fl;
	}

	row(file: TFile): Row {
		const fl = this.fileLike(file);
		const memo = new Map<string, Val>();
		const computing = new Set<string>();
		const errors = new Map<string, string>();
		const self = this.self ? this.fileLike(this.self) : null;
		const types = this.app.propertyTypes;
		const ctx: EvalContext = {
			file: fl,
			note: fl.properties as Record<string, unknown>,
			self,
			propType: (n) => types[n.toLowerCase()],
			formula: (name) => {
				if (memo.has(name)) return memo.get(name)!;
				const src = this.config.formulas?.[name];
				if (src === undefined) return null;
				if (computing.has(name)) {
					errors.set(`formula.${name}`, 'Circular formula reference');
					return null;
				}
				computing.add(name);
				let v: Val = null;
				try {
					v = evaluate(String(src), ctx);
				} catch (e) {
					errors.set(`formula.${name}`, (e as Error).message);
				}
				computing.delete(name);
				memo.set(name, v);
				return v;
			},
		};
		return {
			file, fl, ctx, errors,
			get: (prop) => {
				const p = propId(prop);
				if (p.startsWith('formula.')) return ctx.formula(p.slice(8));
				try {
					return evaluate(propExpr(p), ctx);
				} catch (e) {
					errors.set(p, (e as Error).message);
					return null;
				}
			},
		};
	}

	run(view: ViewConfig): QueryResult {
		const errors: string[] = [];
		const filterOk = (f: Filter | undefined, row: Row) => {
			try {
				return evalFilter(f, row.ctx);
			} catch (e) {
				const msg = (e as Error).message;
				if (!errors.includes(msg)) errors.push(msg);
				return false;
			}
		};
		let rows = this.app.vault.getFiles().map((f) => this.row(f)).filter((r) => filterOk(this.config.filters, r) && filterOk(view.filters, r));
		const sort = view.sort?.length ? view.sort : [{ property: 'file.name', direction: 'ASC' as const }];
		rows.sort((a, b) => {
			for (const s of sort) {
				const c = compareVals(a.get(s.property), b.get(s.property)) * (s.direction === 'DESC' ? -1 : 1);
				if (c) return c;
			}
			return 0;
		});
		const total = rows.length;
		if (view.limit && view.limit > 0) rows = rows.slice(0, view.limit);
		let groups: QueryResult['groups'] = null;
		if (view.groupBy?.property) {
			const map = new Map<string, { key: Val; rows: Row[] }>();
			for (const r of rows) {
				const key = r.get(view.groupBy.property);
				const keys = Array.isArray(key) && key.length ? key : [key];
				for (const k of keys) {
					const id = k === null || (Array.isArray(k) && !k.length) ? '\u0000null' : toText(k as Val);
					if (!map.has(id)) map.set(id, { key: id === '\u0000null' ? null : (k as Val), rows: [] });
					map.get(id)!.rows.push(r);
				}
			}
			groups = [...map.values()].sort((a, b) => compareVals(a.key, b.key) * (view.groupBy!.direction === 'DESC' ? -1 : 1));
			if (view.groupOrder) {
				const order = view.groupOrder.map((x) => (x === null ? null : String(x)));
				groups = order.map((o) => groups!.find((g) => (g.key === null ? null : toText(g.key)) === o)).filter((g): g is { key: Val; rows: Row[] } => !!g);
			}
		}
		const order = view.order?.length ? view.order : ['file.name'];
		return { rows, groups, order, total, errors };
	}

	/** Every property id seen in results + formulas (for the Properties menu). */
	allProperties(rows: Row[]): string[] {
		const notes = new Set<string>();
		for (const r of rows) for (const k of Object.keys(r.fl.properties)) notes.add(`note.${k}`);
		const file = ['file.name', 'file.basename', 'file.path', 'file.folder', 'file.ext', 'file.size', 'file.ctime', 'file.mtime', 'file.tags', 'file.links'];
		return [...file, ...[...notes].sort(), ...Object.keys(this.config.formulas ?? {}).map((f) => `formula.${f}`)];
	}

	summary(view: ViewConfig, rows: Row[], prop: string): Val {
		const name = view.summaries?.[prop] ?? view.summaries?.[propId(prop)];
		if (!name) return null;
		try {
			return summarize(name, rows.map((r) => r.get(prop)), this.config.summaries?.[name]);
		} catch {
			return null;
		}
	}
}

// ---------------- Value rendering ----------------

export function renderValue(app: App, el: HTMLElement, v: Val, sourcePath: string): void {
	el.empty();
	if (v === null) return;
	if (Array.isArray(v)) {
		const list = el.createDiv('bases-list-value');
		for (const item of v) renderValue(app, list.createSpan('bases-list-item'), item, sourcePath);
		return;
	}
	if (typeof v === 'boolean') {
		const cb = el.createEl('input', { type: 'checkbox', cls: 'bases-checkbox' });
		cb.checked = v;
		cb.disabled = true;
		return;
	}
	if (isFile(v)) return linkEl(el, v.path, v.basename);
	if (v instanceof LinkVal) return linkEl(el, v.path, v.display ?? v.path.replace(/\.md$/, ''));
	if (v instanceof HtmlVal) {
		el.appendChild(DOMPurify.sanitize(v.html, { RETURN_DOM_FRAGMENT: true }));
		return;
	}
	if (v instanceof ImageVal) {
		const img = el.createEl('img', { cls: 'bases-image' });
		const file = app.metadataCache.getFirstLinkpathDest(v.src.replace(/^\[\[|\]\]$/g, ''), sourcePath);
		if (file) void app.vault.getResourceUrl(file).then((u) => (img.src = u));
		else if (/^https?:/.test(v.src)) img.src = v.src;
		return;
	}
	if (v instanceof IconVal) return setIcon(el.createSpan('bases-icon'), v.name);
	if (typeof v === 'string' && /^https?:\/\/\S+$/.test(v)) {
		el.createEl('a', { cls: 'external-link', text: v, href: v, attr: { target: '_blank', rel: 'noopener nofollow' } });
		return;
	}
	if (typeof v === 'string' && /^#[^\s#]+$/.test(v)) {
		el.createEl('a', { cls: 'tag', text: v, href: v });
		return;
	}
	el.setText(toText(v));
}

function linkEl(el: HTMLElement, path: string, text: string): void {
	el.createEl('a', { cls: 'internal-link', text, attr: { 'data-href': path, href: path } });
}

// ---------------- Rendering a base (shared by the file view, code blocks and embeds) ----------------

/** Plugin view types (Plugin.registerBasesView). */
export const basesViewRegistry = new Map<string, { name: string; icon: string; factory: (controller: any, containerEl: HTMLElement) => any; options?: (config: any) => unknown[] }>();

const LAYOUTS: Record<string, { name: string; icon: string }> = {
	table: { name: 'Table', icon: 'table' },
	cards: { name: 'Cards', icon: 'layout-grid' },
	list: { name: 'List', icon: 'list' },
	kanban: { name: 'Kanban', icon: 'square-kanban' },
};

export interface BaseHost {
	app: App;
	/** File holding the config (the .base file, or the note with the code block). */
	sourcePath: string;
	/** `this` for expressions. */
	self: TFile | null;
	/** Persist config changes; absent = read-only (embeds). */
	save?: (cfg: BaseConfig) => void;
}

export class BaseRenderer extends MarkdownRenderChild {
	viewIndex = 0;
	private bodyEl: HTMLElement;
	private toolbarEl: HTMLElement;
	private pluginView: any = null;

	constructor(private host: BaseHost, containerEl: HTMLElement, public config: BaseConfig, viewName?: string) {
		super(containerEl);
		containerEl.addClass('bases-view');
		this.toolbarEl = containerEl.createDiv('bases-toolbar');
		this.bodyEl = containerEl.createDiv('bases-body');
		if (viewName) this.viewIndex = Math.max(0, (config.views ?? []).findIndex((v) => v.name === viewName));
	}

	onload(): void {
		const r = debounce(() => this.render(), 300, true);
		this.registerEvent(this.host.app.metadataCache.on('resolved', r));
		this.registerEvent(this.host.app.metadataCache.on('changed', r));
		this.registerEvent(this.host.app.vault.on('rename', r));
		this.registerEvent(this.host.app.vault.on('delete', r));
		this.render();
	}

	onunload(): void {
		this.pluginView?.unload?.();
	}

	get views(): ViewConfig[] {
		if (!this.config.views?.length) this.config.views = [{ type: 'table', name: 'Table' }];
		return this.config.views;
	}

	get view(): ViewConfig {
		return this.views[Math.min(this.viewIndex, this.views.length - 1)];
	}

	private changed(): void {
		this.host.save?.(this.config);
		this.render();
	}

	render(): void {
		const { app } = this.host;
		const runner = new BaseRunner(app, this.config, this.host.self);
		const view = this.view;
		const result = runner.run(view);
		this.renderToolbar(runner, result);
		this.bodyEl.empty();
		for (const e of result.errors) this.bodyEl.createDiv({ cls: 'bases-error', text: `Filter error: ${e}` });
		const plugin = basesViewRegistry.get(view.type);
		if (plugin) return this.renderPluginView(plugin, runner, result);
		this.pluginView?.unload?.();
		this.pluginView = null;
		const layout = view.type in LAYOUTS ? view.type : 'table';
		this.bodyEl.setAttr('data-layout', layout);
		if (layout === 'table') this.renderTable(runner, result);
		else if (layout === 'cards') this.renderCards(runner, result);
		else if (layout === 'list') this.renderList(runner, result);
		else this.renderKanban(runner, result);
	}

	// ----- toolbar -----

	private renderToolbar(runner: BaseRunner, result: QueryResult): void {
		const tb = this.toolbarEl;
		tb.empty();
		const editable = !!this.host.save;
		const viewBtn = tb.createDiv({ cls: 'bases-toolbar-item bases-view-switcher clickable-icon' });
		const info = basesViewRegistry.get(this.view.type) ?? LAYOUTS[this.view.type] ?? LAYOUTS.table;
		setIcon(viewBtn.createSpan(), info.icon);
		viewBtn.createSpan({ text: this.view.name });
		viewBtn.addEventListener('click', (e) => {
			const menu = new Menu();
			this.views.forEach((v, i) => menu.addItem((it) => it.setTitle(v.name).setChecked(i === this.viewIndex).setSection('views').onClick(() => {
				this.viewIndex = i;
				this.render();
			})));
			if (editable) {
				menu.addItem((it) => it.setTitle('New view').setIcon('plus').setSection('manage').onClick(async () => {
					const name = await promptText(this.host.app, 'New view', `View ${this.views.length + 1}`, 'Create');
					if (!name) return;
					this.views.push({ type: 'table', name });
					this.viewIndex = this.views.length - 1;
					this.changed();
				}));
				menu.addItem((it) => it.setTitle('Rename view').setIcon('pencil').setSection('manage').onClick(async () => {
					const name = await promptText(this.host.app, 'Rename view', this.view.name);
					if (!name) return;
					this.view.name = name;
					this.changed();
				}));
				if (this.views.length > 1) menu.addItem((it) => it.setTitle('Delete view').setIcon('trash-2').setWarning(true).setSection('manage').onClick(() => {
					this.views.splice(this.viewIndex, 1);
					this.viewIndex = 0;
					this.changed();
				}));
			}
			menu.showAtMouseEvent(e);
		});
		tb.createDiv({ cls: 'bases-toolbar-results', text: `${result.total} result${result.total === 1 ? '' : 's'}` });
		tb.createDiv('bases-toolbar-spacer');
		if (!editable) return;
		const btn = (icon: string, label: string, onClick: (e: MouseEvent) => void) => {
			const b = tb.createDiv({ cls: 'bases-toolbar-item clickable-icon', attr: { 'aria-label': label } });
			setIcon(b, icon);
			b.addEventListener('click', onClick);
		};
		const all = runner.allProperties(result.rows);
		btn('layout-template', 'Layout', (e) => {
			const menu = new Menu();
			for (const [type, l] of [...Object.entries(LAYOUTS), ...[...basesViewRegistry].map(([t, r]) => [t, r] as const)]) {
				menu.addItem((it) => it.setTitle(l.name).setIcon(l.icon).setChecked(this.view.type === type).onClick(() => {
					this.view.type = type;
					this.changed();
				}));
			}
			menu.showAtMouseEvent(e);
		});
		btn('arrow-up-down', 'Sort', (e) => {
			const menu = new Menu();
			const cur = this.view.sort?.[0];
			for (const p of all) {
				for (const dir of ['ASC', 'DESC'] as const) {
					menu.addItem((it) => it.setTitle(`${displayName(this.config, p)} ${dir === 'ASC' ? '↑' : '↓'}`).setSection(p).setChecked(cur?.property === p && (cur.direction ?? 'ASC') === dir).onClick(() => {
						this.view.sort = [{ property: p, direction: dir }];
						this.changed();
					}));
				}
			}
			menu.addItem((it) => it.setTitle('Clear sort').setSection('clear').onClick(() => {
				delete this.view.sort;
				this.changed();
			}));
			menu.showAtMouseEvent(e);
		});
		btn('list-checks', 'Properties', (e) => {
			const menu = new Menu();
			for (const p of all) {
				const on = result.order.includes(p);
				menu.addItem((it) => it.setTitle(displayName(this.config, p)).setChecked(on).onClick(() => {
					const order = [...result.order];
					this.view.order = on ? order.filter((x) => x !== p) : [...order, p];
					this.changed();
				}));
			}
			menu.showAtMouseEvent(e);
		});
		btn('group', 'Group by', (e) => {
			const menu = new Menu();
			menu.addItem((it) => it.setTitle('No grouping').setChecked(!this.view.groupBy).onClick(() => {
				delete this.view.groupBy;
				this.changed();
			}));
			for (const p of all) {
				menu.addItem((it) => it.setTitle(displayName(this.config, p)).setChecked(this.view.groupBy?.property === p).onClick(() => {
					this.view.groupBy = { property: p, direction: 'ASC' };
					delete this.view.groupOrder;
					this.changed();
				}));
			}
			menu.showAtMouseEvent(e);
		});
		btn('settings-2', 'View settings', () => new ViewSettingsModal(this.host.app, this.view, () => this.changed()).open());
		btn('file-plus', 'New note', () => void this.newNote({}));
	}

	// ----- layouts -----

	private sections(result: QueryResult): { key: Val | undefined; rows: Row[] }[] {
		return result.groups ?? [{ key: undefined, rows: result.rows }];
	}

	private groupHeader(parent: HTMLElement, key: Val | undefined, count: number): void {
		if (key === undefined) return;
		const h = parent.createDiv('bases-group-heading');
		const label = h.createSpan('bases-group-value');
		if (key === null) label.setText('None');
		else renderValue(this.host.app, label, key, this.host.sourcePath);
		h.createSpan({ cls: 'bases-group-count', text: String(count) });
	}

	private cell(el: HTMLElement, row: Row, prop: string): void {
		const v = row.get(prop);
		const err = row.errors.get(propId(prop));
		if (err) {
			el.createSpan({ cls: 'bases-cell-error', text: '⚠', attr: { 'aria-label': err, title: err } });
			return;
		}
		renderValue(this.host.app, el, v, this.host.sourcePath);
		if (prop === 'file.name' || prop === 'file.basename') {
			el.empty();
			linkEl(el, row.file.path, prop === 'file.name' && row.file.extension !== 'md' ? row.file.name : row.file.basename);
		}
	}

	private renderTable(runner: BaseRunner, result: QueryResult): void {
		const wrap = this.bodyEl.createDiv('bases-table-container');
		const table = wrap.createEl('table', { cls: 'bases-table' });
		const head = table.createEl('thead').createEl('tr');
		for (const p of result.order) {
			const th = head.createEl('th', { cls: 'bases-table-header' });
			th.createSpan({ text: displayName(this.config, p) });
			const s = this.view.sort?.[0];
			if (s?.property === p) setIcon(th.createSpan('bases-sort-indicator'), s.direction === 'DESC' ? 'arrow-down' : 'arrow-up');
			if (this.host.save) th.addEventListener('click', () => {
				const desc = s?.property === p && (s.direction ?? 'ASC') === 'ASC';
				this.view.sort = [{ property: p, direction: desc ? 'DESC' : 'ASC' }];
				this.changed();
			});
		}
		for (const sec of this.sections(result)) {
			const tbody = table.createEl('tbody');
			if (sec.key !== undefined) this.groupHeader(tbody.createEl('tr', { cls: 'bases-group-row' }).createEl('td', { attr: { colspan: String(result.order.length) } }), sec.key, sec.rows.length);
			for (const row of sec.rows) {
				const tr = tbody.createEl('tr', { cls: 'bases-tr' });
				for (const p of result.order) {
					const td = tr.createEl('td', { cls: 'bases-td', attr: { 'data-property': p } });
					this.cell(td, row, p);
					if (this.host.save && propId(p).startsWith('note.') && row.file.extension === 'md') this.makeEditable(td, row, p);
				}
			}
			if (this.view.summaries && Object.keys(this.view.summaries).length) {
				const tr = tbody.createEl('tr', { cls: 'bases-summary-row' });
				for (const p of result.order) {
					const td = tr.createEl('td', { cls: 'bases-summary' });
					const name = this.view.summaries[p] ?? this.view.summaries[propId(p)];
					if (!name) continue;
					td.createSpan({ cls: 'bases-summary-label', text: `${name} ` });
					renderValue(this.host.app, td.createSpan(), runner.summary(this.view, sec.rows, p), this.host.sourcePath);
				}
			}
		}
		this.bindLinks(wrap);
	}

	private renderCards(_runner: BaseRunner, result: QueryResult): void {
		const size = Number(this.view.cardSize) || 200;
		const imageProp = typeof this.view.image === 'string' ? this.view.image : null;
		const fit = this.view.imageFit === 'contain' ? 'contain' : 'cover';
		const ratio = Number(this.view.imageAspectRatio) || 1;
		for (const sec of this.sections(result)) {
			this.groupHeader(this.bodyEl, sec.key, sec.rows.length);
			const grid = this.bodyEl.createDiv('bases-cards-container');
			grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${size}px, 1fr))`;
			for (const row of sec.rows) this.card(grid, row, result.order, imageProp, fit, ratio);
		}
		this.bindLinks(this.bodyEl);
	}

	private card(parent: HTMLElement, row: Row, order: string[], imageProp: string | null, fit: string, ratio: number): HTMLElement {
		const card = parent.createDiv('bases-cards-item');
		if (imageProp) {
			const cover = card.createDiv('bases-cards-cover');
			cover.style.aspectRatio = String(1 / ratio);
			const v = row.get(imageProp);
			const src = v instanceof LinkVal ? v.path : toText(v);
			if (/^#[0-9a-f]{3,8}$/i.test(src)) cover.style.background = src;
			else if (src) {
				const img = cover.createEl('img');
				img.style.objectFit = fit;
				const f = this.host.app.metadataCache.getFirstLinkpathDest(src.replace(/^\[\[|\]\]$/g, ''), row.file.path);
				if (f) void this.host.app.vault.getResourceUrl(f).then((u) => (img.src = u));
				else if (/^https?:/.test(src)) img.src = src;
			}
		}
		const [first, ...rest] = order;
		const title = card.createDiv('bases-cards-title');
		this.cell(title, row, first ?? 'file.name');
		for (const p of rest) {
			const line = card.createDiv('bases-cards-property');
			line.createDiv({ cls: 'bases-cards-label', text: displayName(this.config, p) });
			this.cell(line.createDiv('bases-cards-value'), row, p);
		}
		return card;
	}

	private renderList(_runner: BaseRunner, result: QueryResult): void {
		const markers = this.view.markers === 'number' ? 'ol' : 'ul';
		const indent = !!this.view.indentProperties;
		const sep = typeof this.view.separator === 'string' ? this.view.separator : ', ';
		for (const sec of this.sections(result)) {
			this.groupHeader(this.bodyEl, sec.key, sec.rows.length);
			const list = this.bodyEl.createEl(markers, { cls: `bases-list${this.view.markers === 'none' ? ' mod-no-markers' : ''}` });
			for (const row of sec.rows) {
				const li = list.createEl('li');
				const [first, ...rest] = result.order;
				this.cell(li.createSpan('bases-list-primary'), row, first ?? 'file.name');
				if (!rest.length) continue;
				if (indent) {
					const sub = li.createEl('ul');
					for (const p of rest) {
						const item = sub.createEl('li');
						item.createSpan({ cls: 'bases-list-label', text: `${displayName(this.config, p)}: ` });
						this.cell(item.createSpan(), row, p);
					}
				} else {
					for (const p of rest) {
						li.appendText(sep);
						this.cell(li.createSpan(), row, p);
					}
				}
			}
		}
		this.bindLinks(this.bodyEl);
	}

	/** Columns = groups of view.groupBy. Dragging a card sets that note property (or moves the file for file.folder). */
	private renderKanban(_runner: BaseRunner, result: QueryResult): void {
		const group = this.view.groupBy?.property;
		if (!group || !result.groups) {
			this.bodyEl.createDiv({ cls: 'pane-empty', text: 'Kanban needs a property to group by. Use "Group by" in the toolbar.' });
			return;
		}
		const p = propId(group);
		const movable = !!this.host.save && (p.startsWith('note.') || p === 'file.folder');
		const board = this.bodyEl.createDiv('bases-kanban');
		const width = Number(this.view.columnWidth) || 260;
		for (const g of result.groups) {
			const col = board.createDiv('bases-kanban-column');
			col.style.width = `${width}px`;
			const head = col.createDiv('bases-kanban-column-header');
			this.groupHeader(head, g.key, g.rows.length);
			const cards = col.createDiv('bases-kanban-cards');
			for (const row of g.rows) {
				const card = this.card(cards, row, result.order, typeof this.view.image === 'string' ? this.view.image : null, 'cover', Number(this.view.imageAspectRatio) || 1.6);
				if (!movable || (p.startsWith('note.') && row.file.extension !== 'md')) continue;
				card.draggable = true;
				card.addEventListener('dragstart', (e) => {
					e.dataTransfer?.setData('application/x-bases-card', row.file.path);
					card.addClass('is-dragging');
				});
				card.addEventListener('dragend', () => card.removeClass('is-dragging'));
			}
			if (movable) {
				col.addEventListener('dragover', (e) => {
					if (!e.dataTransfer?.types.includes('application/x-bases-card')) return;
					e.preventDefault();
					col.addClass('is-drop-target');
				});
				col.addEventListener('dragleave', () => col.removeClass('is-drop-target'));
				col.addEventListener('drop', (e) => {
					col.removeClass('is-drop-target');
					const path = e.dataTransfer?.getData('application/x-bases-card');
					const file = path ? this.host.app.vault.getFileByPath(path) : null;
					if (file) void this.moveCard(file, p, g.key);
				});
				if (p.startsWith('note.')) {
					const add = col.createDiv({ cls: 'bases-kanban-add clickable-icon', text: '+ New' });
					add.addEventListener('click', () => void this.newNote({ [p.slice(5)]: g.key === null ? undefined : toYamlValue(g.key) }));
				}
			}
		}
		this.bindLinks(board);
	}

	private async moveCard(file: TFile, p: string, key: Val): Promise<void> {
		const { app } = this.host;
		if (p === 'file.folder') {
			const folder = key === null ? '' : toText(key);
			await app.fileManager.renameFile(file, folder ? `${folder}/${file.name}` : file.name);
			return;
		}
		const prop = p.slice(5);
		await app.fileManager.processFrontMatter(file, (fm) => {
			const k = Object.keys(fm).find((x) => x.toLowerCase() === prop.toLowerCase()) ?? prop;
			if (key === null) delete fm[k];
			else fm[k] = toYamlValue(key);
		});
	}

	/** Double-click a note-property cell to edit it in place; checkboxes toggle on click. */
	private makeEditable(td: HTMLElement, row: Row, prop: string): void {
		const { app } = this.host;
		const key = propId(prop).slice(5);
		const current = row.get(prop);
		const write = (value: unknown) => app.fileManager.processFrontMatter(row.file, (fm) => {
			const k = Object.keys(fm).find((x) => x.toLowerCase() === key.toLowerCase()) ?? key;
			if (value === '' || value === null || value === undefined) delete fm[k];
			else fm[k] = value;
		});
		const box = td.querySelector<HTMLInputElement>('input.bases-checkbox');
		if (box) {
			box.disabled = false;
			box.addEventListener('change', () => void write(box.checked));
			return;
		}
		td.addEventListener('dblclick', () => {
			const input = td.createEl('input', { type: 'text', cls: 'bases-cell-input', value: Array.isArray(current) ? current.map(toText).join(', ') : toText(current) });
			td.empty();
			td.appendChild(input);
			input.focus();
			const commit = () => {
				const raw = input.value.trim();
				let value: unknown = raw;
				if (Array.isArray(current)) value = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : null;
				else if (typeof current === 'number' && raw !== '' && !Number.isNaN(Number(raw))) value = Number(raw);
				void write(value);
			};
			input.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') input.blur();
				if (e.key === 'Escape') {
					input.value = Array.isArray(current) ? current.map(toText).join(', ') : toText(current);
					input.blur();
				}
			});
			input.addEventListener('blur', commit, { once: true });
		});
	}

	private bindLinks(el: HTMLElement): void {
		el.addEventListener('click', (e) => {
			const a = (e.target as HTMLElement).closest('a.internal-link') as HTMLElement | null;
			if (!a) return;
			e.preventDefault();
			void this.host.app.workspace.openLinkText(a.dataset.href ?? '', this.host.sourcePath, Keymap.isModEvent(e));
		});
	}

	/** New note in the default location, prefilled with properties (kanban column value, plugin processors). */
	async newNote(props: Record<string, unknown>, processor?: (fm: any, file: TFile) => void): Promise<void> {
		const { app } = this.host;
		const parent = app.fileManager.getNewFileParent(this.host.sourcePath);
		const file = await app.fileManager.createNewMarkdownFile(parent);
		const entries = Object.entries(props).filter(([, v]) => v !== undefined);
		if (entries.length || processor) {
			await app.fileManager.processFrontMatter(file, (fm) => {
				for (const [k, v] of entries) fm[k] = v;
				processor?.(fm, file);
			});
		}
		await app.workspace.getLeaf(false).openFile(file, { active: true });
	}

	// ----- plugin view types -----

	private renderPluginView(reg: NonNullable<ReturnType<typeof basesViewRegistry.get>>, runner: BaseRunner, result: QueryResult): void {
		this.bodyEl.setAttr('data-layout', this.view.type);
		const host = this.bodyEl.createDiv('bases-plugin-view');
		const controller = new Component() as Component & { app: App };
		controller.app = this.host.app;
		const view = reg.factory(controller, host);
		this.pluginView?.unload?.();
		this.pluginView = view;
		view.app = this.host.app;
		view.config = new ViewConfigApi(this.config, this.view, () => this.changed());
		view.allProperties = runner.allProperties(result.rows);
		view.data = new QueryResultApi(runner, this.view, result);
		view.createFileForView = (_name?: string, fn?: (fm: any, file: TFile) => void) => this.newNote({}, fn);
		view.load?.();
		try {
			view.onDataUpdated?.();
		} catch (e) {
			host.createDiv({ cls: 'bases-error', text: `View "${reg.name}" failed: ${(e as Error).message}` });
		}
	}
}

function toYamlValue(v: Val): unknown {
	if (v instanceof LinkVal) return `[[${v.path}${v.display ? '|' + v.display : ''}]]`;
	if (isDate(v)) return v.format(v.hours() || v.minutes() ? 'YYYY-MM-DDTHH:mm' : 'YYYY-MM-DD');
	if (isFile(v)) return `[[${v.basename}]]`;
	if (Array.isArray(v)) return v.map(toYamlValue);
	return v;
}

// ---- API wrappers for plugin views (BasesViewConfig / BasesQueryResult / BasesEntry) ----

class ViewConfigApi {
	name: string;
	constructor(private cfg: BaseConfig, private view: ViewConfig, private changed: () => void) {
		this.name = view.name;
	}
	get(key: string): unknown { return this.view[key]; }
	set(key: string, value: unknown): void {
		if (value === null || value === undefined) delete this.view[key];
		else this.view[key] = value;
		this.changed();
	}
	getAsPropertyId(key: string): string | null {
		const v = this.view[key];
		return typeof v === 'string' && v ? propId(v) : null;
	}
	getEvaluatedFormula(): null { return null; }
	getOrder(): string[] { return this.view.order?.length ? this.view.order : ['file.name']; }
	getSort(): { property: string; direction: string }[] { return (this.view.sort ?? []).map((s) => ({ property: s.property, direction: s.direction ?? 'ASC' })); }
	getDisplayName(id: string): string { return displayName(this.cfg, id); }
}

class EntryApi {
	constructor(readonly row: Row) {}
	get file(): TFile { return this.row.file; }
	getValue(prop: string): Value | null { return toApiValue(this.row.get(prop)); }
}

class QueryResultApi {
	data: EntryApi[];
	private groups: { key?: Value; entries: EntryApi[]; hasKey(): boolean }[];
	constructor(private runner: BaseRunner, private view: ViewConfig, private result: QueryResult) {
		const byRow = new Map(result.rows.map((r) => [r, new EntryApi(r)]));
		this.data = [...byRow.values()];
		this.groups = (result.groups ?? [{ key: undefined as Val | undefined, rows: result.rows }]).map((g) => ({
			key: g.key === undefined ? undefined : toApiValue(g.key),
			entries: g.rows.map((r) => byRow.get(r)!),
			hasKey: () => g.key !== undefined && g.key !== null,
		}));
	}
	get groupedData() { return this.groups; }
	get properties(): string[] { return this.result.order; }
	getSummaryValue(_qc: unknown, entries: EntryApi[], prop: string, summaryKey: string): Value {
		const rows = entries.map((e) => e.row);
		return toApiValue(summarize(summaryKey, rows.map((r) => r.get(prop)), this.runner.config.summaries?.[summaryKey]));
	}
}

/** Base class plugins extend (obsidian.d.ts BasesView). The host fills app/config/data before onDataUpdated(). */
export abstract class BasesView extends Component {
	abstract type: string;
	app!: App;
	config!: ViewConfigApi;
	allProperties: string[] = [];
	data!: QueryResultApi;
	constructor(_controller: unknown) {
		super();
	}
	abstract onDataUpdated(): void;
	createFileForView(_baseFileName?: string, _fm?: (frontmatter: any, file: TFile) => void): Promise<void> {
		return Promise.resolve();
	}
}

// ---------------- View settings ----------------

class ViewSettingsModal extends Modal {
	constructor(app: App, private view: ViewConfig, private onChange: () => void) {
		super(app);
	}
	onOpen(): void {
		this.setTitle(`View settings: ${this.view.name}`);
		const el = this.contentEl;
		const v = this.view;
		const set = (k: string, val: unknown) => {
			if (val === '' || val === undefined || val === null) delete v[k];
			else v[k] = val;
			this.onChange();
		};
		new Setting(el).setName('Limit').setDesc('Maximum number of results (empty = all).')
			.addText((t) => t.setValue(v.limit ? String(v.limit) : '').onChange((x) => set('limit', x.trim() ? Number(x) : undefined)));
		if (v.type === 'cards' || v.type === 'kanban') {
			new Setting(el).setName(v.type === 'cards' ? 'Card size' : 'Column width').addSlider((s) => s.setLimits(120, 480, 10).setValue(Number(v[v.type === 'cards' ? 'cardSize' : 'columnWidth']) || (v.type === 'cards' ? 200 : 260)).setDynamicTooltip()
				.onChange((x) => set(v.type === 'cards' ? 'cardSize' : 'columnWidth', x)));
			new Setting(el).setName('Image property').setDesc('Property holding a cover image (link, URL or hex color).')
				.addText((t) => t.setPlaceholder('note.cover').setValue(String(v.image ?? '')).onChange((x) => set('image', x.trim())));
			new Setting(el).setName('Image fit').addDropdown((d) => d.addOptions({ cover: 'Cover', contain: 'Contain' }).setValue(String(v.imageFit ?? 'cover')).onChange((x) => set('imageFit', x)));
			new Setting(el).setName('Image aspect ratio').addSlider((s) => s.setLimits(0.25, 2.5, 0.05).setValue(Number(v.imageAspectRatio) || 1).setDynamicTooltip().onChange((x) => set('imageAspectRatio', x)));
		}
		if (v.type === 'list') {
			new Setting(el).setName('Markers').addDropdown((d) => d.addOptions({ bullet: 'Bullets', number: 'Numbers', none: 'None' }).setValue(String(v.markers ?? 'bullet')).onChange((x) => set('markers', x)));
			new Setting(el).setName('Indent properties').addToggle((t) => t.setValue(!!v.indentProperties).onChange((x) => set('indentProperties', x || undefined)));
			new Setting(el).setName('Separator').addText((t) => t.setValue(String(v.separator ?? ', ')).onChange((x) => set('separator', x)));
		}
		el.createDiv({ cls: 'setting-item-description', text: 'Filters, formulas and summaries are edited in the base source (the "Edit source" button in the view header).' });
	}
}

// ---------------- .base file view ----------------

export class BasesFileView extends TextFileView {
	icon = 'database';
	private renderer: BaseRenderer | null = null;
	private config: BaseConfig = {};
	private sourceMode = false;
	private viewName: string | undefined;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.contentEl.addClass('bases-file-view');
		this.addAction('code', 'Edit source', () => {
			this.sourceMode = !this.sourceMode;
			this.redraw();
		});
	}

	getViewType(): string { return 'bases'; }

	getState(): Record<string, unknown> {
		return { ...super.getState(), viewName: this.renderer?.view.name };
	}

	async setState(state: any, result: { history: boolean }): Promise<void> {
		if (typeof state?.viewName === 'string') this.viewName = state.viewName;
		await super.setState(state, result);
	}

	setEphemeralState(state: any): void {
		const sub = String(state?.subpath ?? '').replace(/^#/, '');
		if (sub && this.renderer) {
			const i = this.renderer.views.findIndex((v) => v.name === sub);
			if (i >= 0) {
				this.renderer.viewIndex = i;
				this.renderer.render();
			}
		}
	}

	/** Returns the file's own text unless the UI changed the config (keeps hand-written YAML formatting). */
	getViewData(): string {
		return this.data;
	}

	setViewData(data: string): void {
		this.data = data;
		this.redraw();
	}

	clear(): void {
		this.data = '';
		this.renderer?.unload();
		this.renderer = null;
		this.contentEl.empty();
	}

	private redraw(): void {
		const name = this.renderer?.view.name ?? this.viewName;
		this.renderer?.unload();
		this.renderer = null;
		this.contentEl.empty();
		if (this.sourceMode) {
			const ta = this.contentEl.createEl('textarea', { cls: 'bases-source-editor' });
			ta.value = this.data;
			ta.spellcheck = false;
			ta.addEventListener('input', () => {
				this.data = ta.value;
				this.requestSave();
			});
			return;
		}
		try {
			this.config = parseBaseYaml(this.data);
		} catch (e) {
			// Not overwritten: getViewData() returns the file text unchanged.
			this.contentEl.createDiv({ cls: 'bases-error', text: `This base has invalid YAML: ${(e as Error).message}. Use "Edit source" to fix it.` });
			return;
		}
		this.renderer = new BaseRenderer({
			app: this.app,
			sourcePath: this.file?.path ?? '',
			self: this.file,
			save: (cfg) => {
				this.data = dumpYaml(cfg, { schema: CORE_SCHEMA, lineWidth: -1, noRefs: true });
				this.requestSave();
			},
		}, this.contentEl.createDiv(), this.config, name);
		this.renderer.load();
	}

	onunload(): void {
		this.renderer?.unload();
	}
}

// ---------------- Plugin ----------------

export class BasesPlugin extends CorePlugin {
	id = 'bases';
	name = 'Bases';
	description = 'Database-like views of notes and their properties (.base files).';

	onload(): void {
		this.registerView('bases', (leaf) => new BasesFileView(leaf));
		this.app.viewRegistry.registerExtensions(['base'], 'bases');
		this.register(() => delete this.app.viewRegistry.typeByExtension.base);
		this.addCommand({ id: 'bases:new-file', name: 'Bases: Create new base', icon: 'database', callback: () => void this.createBase() });
		this.addCommand({
			id: 'bases:insert', name: 'Bases: Insert new base',
			editorCallback: (editor) => editor.replaceSelection('```base\nviews:\n  - type: table\n    name: Table\n```\n'),
		});
		this.registerEvent(this.app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => {
			if ('children' in file) menu.addItem((i) => i.setTitle('New base').setIcon('database').setSection('new').onClick(() => void this.createBase(file.path)));
		}));
		// ```base blocks: read-only, `this` is the note containing the block.
		MarkdownPreviewRenderer.registerCodeBlockPostProcessor('base', (source, el, ctx) => {
			let config: BaseConfig;
			try {
				config = parseBaseYaml(source);
			} catch (e) {
				el.createDiv({ cls: 'bases-error', text: `Invalid base: ${(e as Error).message}` });
				return;
			}
			const self = this.app.vault.getFileByPath(ctx.sourcePath);
			ctx.addChild(new BaseRenderer({ app: this.app, sourcePath: ctx.sourcePath, self }, el.createDiv('bases-embed'), config));
		});
		this.register(() => MarkdownPreviewRenderer.unregisterCodeBlockPostProcessor('base'));
		// ![[x.base]] and ![[x.base#View name]]: `this` is the embedding note.
		this.app.embedRegistry.registerExtension('base', (ctx: { app: App; containerEl: HTMLElement; sourcePath: string }, file: TFile, subpath: string) => {
			const child = new Component() as Component & { loadFile(): Promise<void> };
			child.loadFile = async () => {
				try {
					const cfg = parseBaseYaml(await this.app.vault.cachedRead(file));
					const r = new BaseRenderer({ app: this.app, sourcePath: file.path, self: this.app.vault.getFileByPath(ctx.sourcePath) }, ctx.containerEl.createDiv('bases-embed'), cfg, subpath.replace(/^#/, '') || undefined);
					child.addChild(r);
				} catch (e) {
					ctx.containerEl.createDiv({ cls: 'bases-error', text: `Invalid base: ${(e as Error).message}` });
				}
			};
			return child;
		});
		this.register(() => this.app.embedRegistry.unregisterExtension('base'));
	}

	private async createBase(folder?: string): Promise<void> {
		const base = folder && folder !== '/' ? `${folder}/` : '';
		let path = `${base}Untitled.base`;
		for (let n = 1; this.app.vault.getAbstractFileByPath(path); n++) path = `${base}Untitled ${n}.base`;
		const file = await this.app.vault.create(path, 'views:\n  - type: table\n    name: Table\n');
		await this.app.workspace.getLeaf(false).openFile(file, { active: true });
		new Notice('New base: every file in the vault, until you add filters (Edit source).');
	}
}
