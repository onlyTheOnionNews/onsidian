// UI primitives from obsidian.d.ts: Modal, SuggestModal, FuzzySuggestModal, Menu, Setting (+ controls),
// prepareFuzzySearch / prepareSimpleSearch / renderMatches. DOM mirrors Obsidian's class names.
import type { App } from './app';
import { Component } from './events';
import { setIcon } from './icons';
import { Scope } from './keymap';

// ---------------- Search helpers ----------------

export type SearchMatchPart = [number, number];
export interface SearchResult { score: number; matches: SearchMatchPart[]; }
export interface FuzzyMatch<T> { item: T; match: SearchResult; }

/**
 * Subsequence match (case-insensitive). Spaces in the query are ignored. Score is ≤ 0, higher is better: penalties for
 * gaps and late starts, bonuses for matches at word starts and runs of consecutive characters.
 */
export function prepareFuzzySearch(query: string): (text: string) => SearchResult | null {
	const q = query.toLowerCase().replace(/\s+/g, '');
	return (text: string) => {
		if (!q) return { score: 0, matches: [] };
		const t = text.toLowerCase();
		const matches: SearchMatchPart[] = [];
		let score = 0;
		let ti = 0;
		for (let qi = 0; qi < q.length; qi++) {
			// Prefer the next occurrence at a word start, else the next occurrence.
			let found = -1;
			for (let j = ti; j < t.length; j++) {
				if (t[j] !== q[qi]) continue;
				if (found < 0) found = j;
				if (j === 0 || /[\s\-_/.]/.test(t[j - 1])) { found = j; break; }
				if (matches.length && j === matches[matches.length - 1][1]) { found = j; break; }
			}
			if (found < 0) return null;
			const last = matches[matches.length - 1];
			if (last && last[1] === found) {
				last[1]++;
				score += 1;
			} else {
				score -= found - ti + (matches.length ? 1 : 0);
				matches.push([found, found + 1]);
			}
			if (found === 0 || /[\s\-_/.]/.test(t[found - 1])) score += 2;
			ti = found + 1;
		}
		// Shorter texts rank above longer ones with the same match.
		return { score: Math.min(0, score - text.length * 0.01 - 2 * q.length), matches };
	};
}

/** Every space-separated word must occur (case-insensitive substring). */
export function prepareSimpleSearch(query: string): (text: string) => SearchResult | null {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	return (text: string) => {
		const t = text.toLowerCase();
		const matches: SearchMatchPart[] = [];
		let score = 0;
		for (const w of words) {
			const i = t.indexOf(w);
			if (i < 0) return null;
			matches.push([i, i + w.length]);
			score -= i;
		}
		return { score, matches: matches.sort((a, b) => a[0] - b[0]) };
	};
}

export function renderMatches(el: HTMLElement | DocumentFragment, text: string, matches: SearchMatchPart[] | null, offset = 0): void {
	let pos = 0;
	for (const [s0, e0] of matches ?? []) {
		const s = s0 + offset;
		const e = e0 + offset;
		if (s < pos || s >= text.length) continue;
		if (s > pos) el.appendText(text.slice(pos, s));
		el.createSpan({ cls: 'suggestion-highlight', text: text.slice(s, e) });
		pos = e;
	}
	if (pos < text.length) el.appendText(text.slice(pos));
}

export function renderResults(el: HTMLElement, text: string, result: SearchResult, offset?: number): void {
	renderMatches(el, text, result.matches, offset);
}

// ---------------- Modal ----------------

export class Modal {
	scope = new Scope();
	containerEl: HTMLElement;
	modalEl: HTMLElement;
	titleEl: HTMLElement;
	contentEl: HTMLElement;
	shouldRestoreSelection = true;
	private closeCallback?: () => any;
	private restoreFocus: Element | null = null;

	constructor(public app: App) {
		this.containerEl = createDiv('modal-container mod-dim');
		const bg = this.containerEl.createDiv('modal-bg');
		bg.addEventListener('click', () => this.close());
		this.modalEl = this.containerEl.createDiv('modal');
		const close = this.modalEl.createDiv({ cls: 'modal-close-button', attr: { 'aria-label': 'Close' } });
		setIcon(close, 'x');
		close.addEventListener('click', () => this.close());
		this.titleEl = this.modalEl.createDiv('modal-header').createDiv('modal-title');
		this.contentEl = this.modalEl.createDiv('modal-content');
		this.scope.register(null, 'Escape', () => {
			this.close();
			return false;
		});
	}

	open(): void {
		this.restoreFocus = document.activeElement;
		document.body.appendChild(this.containerEl);
		this.app.keymap.pushScope(this.scope);
		void this.onOpen();
	}

	close(): void {
		if (!this.containerEl.isConnected) return;
		this.app.keymap.popScope(this.scope);
		this.containerEl.detach();
		this.onClose();
		this.closeCallback?.();
		if (this.shouldRestoreSelection) (this.restoreFocus as HTMLElement | null)?.focus?.();
	}

	onOpen(): Promise<void> | void {}
	onClose(): void {}
	onHistoryBack(): void { this.close(); }

	setTitle(title: string): this {
		this.titleEl.setText(title);
		return this;
	}

	setContent(content: string | DocumentFragment): this {
		this.contentEl.setText(content);
		return this;
	}

	setCloseCallback(cb: () => any): this {
		this.closeCallback = cb;
		return this;
	}
}

// ---------------- SuggestModal ----------------

export interface Instruction { command: string; purpose: string; }

export abstract class SuggestModal<T> extends Modal {
	limit = 100;
	emptyStateText = 'No results found.';
	inputEl: HTMLInputElement;
	resultContainerEl: HTMLElement;
	private instructionsEl: HTMLElement;
	private values: T[] = [];
	private selected = 0;
	private updateId = 0;

	constructor(app: App) {
		super(app);
		this.modalEl.className = 'prompt';
		this.modalEl.empty();
		this.inputEl = this.modalEl.createDiv('prompt-input-container').createEl('input', { cls: 'prompt-input', type: 'text' });
		this.inputEl.setAttr('enterkeyhint', 'done');
		this.resultContainerEl = this.modalEl.createDiv('prompt-results');
		this.instructionsEl = this.modalEl.createDiv('prompt-instructions');
		this.inputEl.addEventListener('input', () => void this.updateSuggestions());
		this.scope.register([], 'ArrowDown', () => {
			this.move(1);
			return false;
		});
		this.scope.register([], 'ArrowUp', () => {
			this.move(-1);
			return false;
		});
		this.scope.register(null, 'Enter', (evt) => {
			this.selectActiveSuggestion(evt);
			return false;
		});
	}

	setPlaceholder(placeholder: string): void {
		this.inputEl.placeholder = placeholder;
	}

	setInstructions(instructions: Instruction[]): void {
		this.instructionsEl.empty();
		for (const i of instructions) {
			const el = this.instructionsEl.createDiv('prompt-instruction');
			el.createSpan({ cls: 'prompt-instruction-command', text: i.command });
			el.createSpan({ text: i.purpose });
		}
	}

	open(): void {
		super.open();
		this.inputEl.focus();
		void this.updateSuggestions();
	}

	onNoSuggestion(): void {
		this.resultContainerEl.empty();
		this.resultContainerEl.createDiv({ cls: 'suggestion-empty', text: this.emptyStateText });
	}

	selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void {
		this.close();
		this.onChooseSuggestion(value, evt);
	}

	selectActiveSuggestion(evt: MouseEvent | KeyboardEvent): void {
		const v = this.values[this.selected];
		if (v !== undefined) this.selectSuggestion(v, evt);
	}

	abstract getSuggestions(query: string): T[] | Promise<T[]>;
	abstract renderSuggestion(value: T, el: HTMLElement): void;
	abstract onChooseSuggestion(item: T, evt: MouseEvent | KeyboardEvent): void;

	private async updateSuggestions(): Promise<void> {
		const id = ++this.updateId;
		const values = await this.getSuggestions(this.inputEl.value);
		if (id !== this.updateId) return; // a newer keystroke won
		this.values = values.slice(0, this.limit);
		this.selected = 0;
		if (!this.values.length) return this.onNoSuggestion();
		this.resultContainerEl.empty();
		this.values.forEach((v, i) => {
			const el = this.resultContainerEl.createDiv('suggestion-item');
			this.renderSuggestion(v, el);
			el.addEventListener('mousemove', () => this.setSelected(i, false));
			el.addEventListener('click', (evt) => this.selectSuggestion(v, evt));
		});
		this.setSelected(0, false);
	}

	private move(delta: number): void {
		if (!this.values.length) return;
		this.setSelected((this.selected + delta + this.values.length) % this.values.length, true);
	}

	private setSelected(i: number, scroll: boolean): void {
		const items = this.resultContainerEl.children;
		items[this.selected]?.removeClass('is-selected');
		this.selected = i;
		items[i]?.addClass('is-selected');
		if (scroll) items[i]?.scrollIntoView({ block: 'nearest' });
	}
}

export abstract class FuzzySuggestModal<T> extends SuggestModal<FuzzyMatch<T>> {
	getSuggestions(query: string): FuzzyMatch<T>[] {
		const search = prepareFuzzySearch(query);
		const out: FuzzyMatch<T>[] = [];
		for (const item of this.getItems()) {
			const match = search(this.getItemText(item));
			if (match) out.push({ item, match });
		}
		return query.trim() ? out.sort((a, b) => b.match.score - a.match.score) : out;
	}

	renderSuggestion(item: FuzzyMatch<T>, el: HTMLElement): void {
		renderResults(el, this.getItemText(item.item), item.match);
	}

	onChooseSuggestion(item: FuzzyMatch<T>, evt: MouseEvent | KeyboardEvent): void {
		this.onChooseItem(item.item, evt);
	}

	abstract getItems(): T[];
	abstract getItemText(item: T): string;
	abstract onChooseItem(item: T, evt: MouseEvent | KeyboardEvent): void;
}

// ---------------- Menu ----------------

export class MenuItem {
	dom: HTMLElement;
	private iconEl: HTMLElement;
	private titleEl: HTMLElement;
	/** @internal */ callback?: (evt: MouseEvent | KeyboardEvent) => any;
	/** @internal */ disabled = false;
	/** @internal */ section = '';

	/** @internal Menu creates items; the API constructor is private. */
	constructor(private menu: Menu) {
		this.dom = createDiv('menu-item tappable');
		this.iconEl = this.dom.createDiv('menu-item-icon');
		this.titleEl = this.dom.createDiv('menu-item-title');
		this.dom.addEventListener('click', (evt) => this.activate(evt));
		this.dom.addEventListener('mouseenter', () => this.menu.select(this));
	}

	setTitle(title: string | DocumentFragment): this { this.titleEl.setText(title); return this; }
	setIcon(icon: string | null): this { icon ? setIcon(this.iconEl, icon) : this.iconEl.empty(); return this; }
	setChecked(checked: boolean | null): this {
		this.dom.toggleClass('mod-checked', !!checked);
		if (checked) setIcon(this.dom.createDiv('menu-item-icon mod-checked'), 'check');
		return this;
	}
	setDisabled(disabled: boolean): this { this.disabled = disabled; this.dom.toggleClass('is-disabled', disabled); return this; }
	setWarning(isWarning: boolean): this { this.dom.toggleClass('is-warning', isWarning); return this; }
	setIsLabel(isLabel: boolean): this { this.dom.toggleClass('is-label', isLabel); return this; }
	setSection(section: string): this { this.section = section; return this; }
	onClick(cb: (evt: MouseEvent | KeyboardEvent) => any): this { this.callback = cb; return this; }

	/** @internal */
	activate(evt: MouseEvent | KeyboardEvent): void {
		if (this.disabled) return;
		this.menu.hide();
		this.callback?.(evt);
	}
}

export class Menu extends Component {
	dom: HTMLElement;
	items: (MenuItem | 'separator')[] = [];
	private selected: MenuItem | null = null;
	private hideCallbacks: (() => any)[] = [];
	private parentEl: HTMLElement | null = null;

	constructor() {
		super();
		this.dom = createDiv('menu');
		this.dom.addEventListener('contextmenu', (e) => e.preventDefault());
	}

	setNoIcon(): this { this.dom.addClass('mod-no-icon'); return this; }
	setUseNativeMenu(_native: boolean): this { return this; }
	setParentElement(el: HTMLElement): this { this.parentEl = el; return this; }

	addItem(cb: (item: MenuItem) => any): this {
		const item = new MenuItem(this);
		this.items.push(item);
		cb(item);
		return this;
	}

	addSeparator(): this {
		this.items.push('separator');
		return this;
	}

	showAtMouseEvent(evt: MouseEvent): this {
		evt.preventDefault();
		return this.showAtPosition({ x: evt.clientX, y: evt.clientY });
	}

	showAtPosition(pos: { x: number; y: number; width?: number; overlap?: boolean; left?: boolean }, doc: Document = document): this {
		this.render();
		doc.body.appendChild(this.dom);
		this.parentEl?.addClass('has-active-menu');
		const r = this.dom.getBoundingClientRect();
		const x = Math.min(pos.x, window.innerWidth - r.width - 4);
		const y = pos.y + r.height > window.innerHeight ? Math.max(4, pos.y - r.height) : pos.y;
		this.dom.style.left = `${Math.max(4, x)}px`;
		this.dom.style.top = `${y}px`;
		this.load();
		// Close on outside click / Escape / window blur; arrows + Enter navigate. Registered after this click finishes.
		setTimeout(() => {
			this.registerDomEvent(doc, 'mousedown', (e: MouseEvent) => !this.dom.contains(e.target as Node) && this.hide(), true);
			this.registerDomEvent(window, 'blur', () => this.hide());
			this.registerDomEvent(doc, 'keydown', (e: KeyboardEvent) => this.onKey(e), true);
		});
		return this;
	}

	hide(): this {
		if (!this.dom.isConnected) return this;
		this.dom.detach();
		this.parentEl?.removeClass('has-active-menu');
		this.unload();
		for (const cb of this.hideCallbacks) cb();
		return this;
	}

	close(): void { this.hide(); }
	onHide(cb: () => any): void { this.hideCallbacks.push(cb); }
	onHistoryBack(): void { this.hide(); }

	static forEvent(evt: PointerEvent | MouseEvent): Menu {
		const m = new Menu();
		setTimeout(() => m.dom.isConnected || m.showAtMouseEvent(evt));
		return m;
	}

	/** @internal */
	select(item: MenuItem | null): void {
		this.selected?.dom.removeClass('selected');
		this.selected = item;
		item?.dom.addClass('selected');
	}

	private render(): void {
		this.dom.empty();
		const items = this.items.filter((i): i is MenuItem => i !== 'separator');
		if (!items.some((i) => i.section)) {
			// No sections: items and explicit separators in insertion order.
			for (const i of this.items) i === 'separator' ? this.dom.createDiv('menu-separator') : this.dom.appendChild(i.dom);
			return;
		}
		// Sections: group items by section (first-seen order) with a separator between groups, as Obsidian does.
		const sections = [...new Set(items.map((i) => i.section))];
		sections.forEach((s, n) => {
			if (n) this.dom.createDiv('menu-separator');
			for (const i of items) if (i.section === s) this.dom.appendChild(i.dom);
		});
	}

	private onKey(e: KeyboardEvent): void {
		const items = this.items.filter((i): i is MenuItem => i !== 'separator' && !i.disabled);
		if (e.key === 'Escape') this.hide();
		else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			const i = this.selected ? items.indexOf(this.selected) : -1;
			const n = e.key === 'ArrowDown' ? i + 1 : (i < 0 ? items.length : i) - 1;
			this.select(items[(n + items.length) % items.length] ?? null);
		} else if (e.key === 'Enter' && this.selected) this.selected.activate(e);
		else return;
		e.preventDefault();
		e.stopPropagation();
	}
}

// ---------------- Setting + controls ----------------

abstract class ValueComponent<T> {
	disabled = false;
	protected changeCb?: (v: T) => any;
	abstract getValue(): T;
	abstract setValue(v: T): this;
	onChange(cb: (v: T) => any): this { this.changeCb = cb; return this; }
	setDisabled(d: boolean): this { this.disabled = d; return this; }
	then(cb: (c: this) => any): this { cb(this); return this; }
}

export class ToggleComponent extends ValueComponent<boolean> {
	toggleEl: HTMLElement;
	private value = false;
	constructor(containerEl: HTMLElement) {
		super();
		this.toggleEl = containerEl.createDiv({ cls: 'checkbox-container', attr: { role: 'switch', tabindex: '0' } });
		this.toggleEl.createEl('input', { type: 'checkbox', attr: { tabindex: '-1' } });
		const flip = () => {
			if (this.disabled) return;
			this.setValue(!this.value);
			this.changeCb?.(this.value);
		};
		this.toggleEl.addEventListener('click', flip);
		this.toggleEl.addEventListener('keydown', (e) => {
			if (e.key !== ' ' && e.key !== 'Enter') return;
			e.preventDefault();
			flip();
		});
	}
	getValue(): boolean { return this.value; }
	setValue(v: boolean): this {
		this.value = v;
		this.toggleEl.toggleClass('is-enabled', v);
		this.toggleEl.setAttr('aria-checked', String(v));
		return this;
	}
	setTooltip(t: string): this { this.toggleEl.setAttr('aria-label', t); return this; }
}

export class TextComponent extends ValueComponent<string> {
	inputEl: HTMLInputElement;
	constructor(containerEl: HTMLElement) {
		super();
		this.inputEl = containerEl.createEl('input', { type: 'text' });
		this.inputEl.addEventListener('input', () => this.changeCb?.(this.inputEl.value));
	}
	getValue(): string { return this.inputEl.value; }
	setValue(v: string): this { this.inputEl.value = v; return this; }
	setPlaceholder(p: string): this { this.inputEl.placeholder = p; return this; }
	setDisabled(d: boolean): this { this.inputEl.disabled = d; return super.setDisabled(d); }
}

export class TextAreaComponent extends ValueComponent<string> {
	inputEl: HTMLTextAreaElement;
	constructor(containerEl: HTMLElement) {
		super();
		this.inputEl = containerEl.createEl('textarea');
		this.inputEl.addEventListener('input', () => this.changeCb?.(this.inputEl.value));
	}
	getValue(): string { return this.inputEl.value; }
	setValue(v: string): this { this.inputEl.value = v; return this; }
	setPlaceholder(p: string): this { this.inputEl.placeholder = p; return this; }
}

export class DropdownComponent extends ValueComponent<string> {
	selectEl: HTMLSelectElement;
	constructor(containerEl: HTMLElement) {
		super();
		this.selectEl = containerEl.createEl('select', { cls: 'dropdown' });
		this.selectEl.addEventListener('change', () => this.changeCb?.(this.selectEl.value));
	}
	addOption(value: string, display: string): this { this.selectEl.createEl('option', { value, text: display }); return this; }
	addOptions(opts: Record<string, string>): this { for (const k in opts) this.addOption(k, opts[k]); return this; }
	getValue(): string { return this.selectEl.value; }
	setValue(v: string): this { this.selectEl.value = v; return this; }
	setDisabled(d: boolean): this { this.selectEl.disabled = d; return super.setDisabled(d); }
}

export class SliderComponent extends ValueComponent<number> {
	sliderEl: HTMLInputElement;
	constructor(containerEl: HTMLElement) {
		super();
		this.sliderEl = containerEl.createEl('input', { cls: 'slider', type: 'range' });
		this.sliderEl.addEventListener('input', () => this.changeCb?.(Number(this.sliderEl.value)));
	}
	setLimits(min: number | null, max: number | null, step: number | 'any'): this {
		if (min !== null) this.sliderEl.min = String(min);
		if (max !== null) this.sliderEl.max = String(max);
		this.sliderEl.step = String(step);
		return this;
	}
	setDynamicTooltip(): this { this.sliderEl.addEventListener('input', () => this.sliderEl.setAttr('aria-label', this.sliderEl.value)); return this; }
	getValue(): number { return Number(this.sliderEl.value); }
	setValue(v: number): this { this.sliderEl.value = String(v); return this; }
}

export class ColorComponent extends ValueComponent<string> {
	colorPickerEl: HTMLInputElement;
	constructor(containerEl: HTMLElement) {
		super();
		this.colorPickerEl = containerEl.createEl('input', { type: 'color' });
		this.colorPickerEl.addEventListener('input', () => this.changeCb?.(this.colorPickerEl.value));
	}
	getValue(): string { return this.colorPickerEl.value; }
	setValue(v: string): this { this.colorPickerEl.value = v; return this; }
}

export class ButtonComponent {
	buttonEl: HTMLButtonElement;
	constructor(containerEl: HTMLElement) { this.buttonEl = containerEl.createEl('button'); }
	setButtonText(t: string): this { this.buttonEl.setText(t); return this; }
	setIcon(icon: string): this { setIcon(this.buttonEl, icon); return this; }
	setCta(): this { this.buttonEl.addClass('mod-cta'); return this; }
	setWarning(): this { this.buttonEl.addClass('mod-warning'); return this; }
	setTooltip(t: string): this { this.buttonEl.setAttr('aria-label', t); return this; }
	setDisabled(d: boolean): this { this.buttonEl.disabled = d; return this; }
	onClick(cb: (evt: MouseEvent) => any): this { this.buttonEl.addEventListener('click', cb); return this; }
	then(cb: (c: this) => any): this { cb(this); return this; }
}

export class ExtraButtonComponent {
	extraSettingsEl: HTMLElement;
	constructor(containerEl: HTMLElement) { this.extraSettingsEl = containerEl.createDiv('clickable-icon extra-setting-button'); }
	setIcon(icon: string): this { setIcon(this.extraSettingsEl, icon); return this; }
	setTooltip(t: string): this { this.extraSettingsEl.setAttr('aria-label', t); return this; }
	setDisabled(d: boolean): this { this.extraSettingsEl.toggleClass('is-disabled', d); return this; }
	onClick(cb: () => any): this { this.extraSettingsEl.addEventListener('click', cb); return this; }
	then(cb: (c: this) => any): this { cb(this); return this; }
}

export class Setting {
	settingEl: HTMLElement;
	infoEl: HTMLElement;
	nameEl: HTMLElement;
	descEl: HTMLElement;
	controlEl: HTMLElement;
	components: unknown[] = [];

	constructor(containerEl: HTMLElement) {
		this.settingEl = containerEl.createDiv('setting-item');
		this.infoEl = this.settingEl.createDiv('setting-item-info');
		this.nameEl = this.infoEl.createDiv('setting-item-name');
		this.descEl = this.infoEl.createDiv('setting-item-description');
		this.controlEl = this.settingEl.createDiv('setting-item-control');
	}

	setName(name: string | DocumentFragment): this { this.nameEl.setText(name); return this; }
	setDesc(desc: string | DocumentFragment): this { this.descEl.setText(desc); return this; }
	setClass(cls: string): this { this.settingEl.addClass(cls); return this; }
	setTooltip(t: string): this { this.nameEl.setAttr('aria-label', t); return this; }
	setHeading(): this { this.settingEl.addClass('setting-item-heading'); return this; }
	setDisabled(d: boolean): this { this.settingEl.toggleClass('is-disabled', d); return this; }
	then(cb: (s: this) => any): this { cb(this); return this; }

	private add<C>(c: C, cb: (c: C) => any): this {
		this.components.push(c);
		cb(c);
		return this;
	}

	addToggle(cb: (c: ToggleComponent) => any): this { return this.add(new ToggleComponent(this.controlEl), cb); }
	addText(cb: (c: TextComponent) => any): this { return this.add(new TextComponent(this.controlEl), cb); }
	addTextArea(cb: (c: TextAreaComponent) => any): this { return this.add(new TextAreaComponent(this.controlEl), cb); }
	addDropdown(cb: (c: DropdownComponent) => any): this { return this.add(new DropdownComponent(this.controlEl), cb); }
	addSlider(cb: (c: SliderComponent) => any): this { return this.add(new SliderComponent(this.controlEl), cb); }
	addColorPicker(cb: (c: ColorComponent) => any): this { return this.add(new ColorComponent(this.controlEl), cb); }
	addButton(cb: (c: ButtonComponent) => any): this { return this.add(new ButtonComponent(this.controlEl), cb); }
	addExtraButton(cb: (c: ExtraButtonComponent) => any): this { return this.add(new ExtraButtonComponent(this.controlEl), cb); }
}

/** One-line text prompt / confirm, built on Modal (replaces window.prompt/confirm). */
export function promptText(app: App, title: string, value = '', cta = 'Save'): Promise<string | null> {
	return new Promise((resolve) => {
		const m = new Modal(app).setTitle(title);
		let result: string | null = null;
		const form = m.contentEl.createEl('form');
		const input = form.createEl('input', { type: 'text', value });
		input.style.width = '100%';
		const buttons = m.modalEl.createDiv('modal-button-container');
		new ButtonComponent(buttons).setButtonText(cta).setCta().onClick(() => form.requestSubmit());
		new ButtonComponent(buttons).setButtonText('Cancel').onClick(() => m.close());
		form.addEventListener('submit', (e) => {
			e.preventDefault();
			result = input.value;
			m.close();
		});
		m.setCloseCallback(() => resolve(result));
		m.open();
		input.focus();
		input.select();
	});
}

export function confirmAction(app: App, title: string, message: string, cta = 'Delete', warning = true): Promise<boolean> {
	return new Promise((resolve) => {
		const m = new Modal(app).setTitle(title).setContent(message);
		let ok = false;
		const buttons = m.modalEl.createDiv('modal-button-container');
		const b = new ButtonComponent(buttons).setButtonText(cta).onClick(() => { ok = true; m.close(); });
		warning ? b.setWarning() : b.setCta();
		new ButtonComponent(buttons).setButtonText('Cancel').onClick(() => m.close());
		m.setCloseCallback(() => resolve(ok));
		m.open();
		b.buttonEl.focus();
	});
}
