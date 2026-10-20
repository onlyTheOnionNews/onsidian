// PopoverSuggest / AbstractInputSuggest / EditorSuggest (obsidian.d.ts): suggestion popovers for inputs and the editor.
import type { App } from './app';
import type { Editor, EditorPosition } from './editor';
import { Scope } from './keymap';
import type { Instruction } from './ui';
import type { TFile } from './vault';

export abstract class PopoverSuggest<T> {
	scope: Scope;
	suggestEl: HTMLElement;
	protected values: T[] = [];
	protected selected = 0;
	private instructionsEl: HTMLElement;
	private listEl: HTMLElement;

	constructor(public app: App, scope?: Scope) {
		this.scope = scope ?? new Scope(app.scope);
		this.suggestEl = createDiv('suggestion-container');
		this.listEl = this.suggestEl.createDiv('suggestion');
		this.instructionsEl = this.suggestEl.createDiv('prompt-instructions');
		this.instructionsEl.hide();
		this.suggestEl.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input/editor
		const nav = (d: number) => () => {
			if (this.values.length) this.setSelected((this.selected + d + this.values.length) % this.values.length);
			return false;
		};
		this.scope.register([], 'ArrowDown', nav(1));
		this.scope.register([], 'ArrowUp', nav(-1));
		this.scope.register([], 'Enter', (e) => {
			const v = this.values[this.selected];
			if (v === undefined) return;
			this.selectSuggestion(v, e);
			return false;
		});
		this.scope.register([], 'Tab', (e) => {
			const v = this.values[this.selected];
			if (v === undefined) return;
			this.selectSuggestion(v, e);
			return false;
		});
		this.scope.register([], 'Escape', () => {
			this.close();
			return false;
		});
	}

	abstract renderSuggestion(value: T, el: HTMLElement): void;
	abstract selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void;

	setInstructions(instructions: Instruction[]): void {
		this.instructionsEl.empty();
		this.instructionsEl.toggle(!!instructions.length);
		for (const i of instructions) {
			const el = this.instructionsEl.createDiv('prompt-instruction');
			el.createSpan({ cls: 'prompt-instruction-command', text: i.command });
			el.createSpan({ text: i.purpose });
		}
	}

	open(): void {
		if (!this.suggestEl.isConnected) document.body.appendChild(this.suggestEl);
		this.app.keymap.pushScope(this.scope);
	}

	close(): void {
		this.app.keymap.popScope(this.scope);
		this.suggestEl.detach();
	}

	onHistoryBack(): void {
		this.close();
	}

	/** @internal */
	showValues(values: T[], anchor: DOMRect): void {
		this.values = values;
		this.listEl.empty();
		if (!values.length) return this.close();
		values.forEach((v, i) => {
			const el = this.listEl.createDiv('suggestion-item');
			this.renderSuggestion(v, el);
			el.addEventListener('mousemove', () => this.setSelected(i));
			el.addEventListener('click', (e) => this.selectSuggestion(v, e));
		});
		this.open();
		this.setSelected(0);
		const below = anchor.bottom + 4;
		const h = this.suggestEl.offsetHeight;
		this.suggestEl.style.left = `${Math.max(4, Math.min(anchor.left, window.innerWidth - this.suggestEl.offsetWidth - 4))}px`;
		this.suggestEl.style.top = `${below + h > window.innerHeight ? Math.max(4, anchor.top - h - 4) : below}px`;
	}

	private setSelected(i: number): void {
		const items = this.listEl.children;
		items[this.selected]?.removeClass('is-selected');
		this.selected = i;
		items[i]?.addClass('is-selected');
		items[i]?.scrollIntoView({ block: 'nearest' });
	}
}

export abstract class AbstractInputSuggest<T> extends PopoverSuggest<T> {
	limit = 100;
	private selectCb?: (value: T, evt: MouseEvent | KeyboardEvent) => any;

	constructor(app: App, public textInputEl: HTMLInputElement | HTMLDivElement) {
		super(app);
		const update = async () => {
			const values = (await this.getSuggestions(this.getValue())).slice(0, this.limit);
			if (document.activeElement === textInputEl) this.showValues(values, textInputEl.getBoundingClientRect());
		};
		textInputEl.addEventListener('input', () => void update());
		textInputEl.addEventListener('focus', () => void update());
		textInputEl.addEventListener('blur', () => this.close());
	}

	setValue(value: string): void {
		if (this.textInputEl instanceof HTMLInputElement) this.textInputEl.value = value;
		else this.textInputEl.textContent = value;
	}

	getValue(): string {
		return this.textInputEl instanceof HTMLInputElement ? this.textInputEl.value : this.textInputEl.textContent ?? '';
	}

	protected abstract getSuggestions(query: string): T[] | Promise<T[]>;

	selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void {
		this.selectCb?.(value, evt);
		this.close();
	}

	onSelect(cb: (value: T, evt: MouseEvent | KeyboardEvent) => any): this {
		this.selectCb = cb;
		return this;
	}
}

export interface EditorSuggestTriggerInfo { start: EditorPosition; end: EditorPosition; query: string; }
export interface EditorSuggestContext extends EditorSuggestTriggerInfo { editor: Editor; file: TFile; }

export abstract class EditorSuggest<T> extends PopoverSuggest<T> {
	context: EditorSuggestContext | null = null;
	limit = 100;

	abstract onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null;
	abstract getSuggestions(context: EditorSuggestContext): T[] | Promise<T[]>;

	/** @internal Called by the workspace on every edit in the active editor. Returns true if it opened. */
	async trigger(editor: Editor, file: TFile | null): Promise<boolean> {
		const info = this.onTrigger(editor.getCursor(), editor, file);
		if (!info || !file) {
			this.close();
			return false;
		}
		this.context = { ...info, editor, file };
		const values = (await this.getSuggestions(this.context)).slice(0, this.limit);
		const cm = (editor as any).cm;
		const at = cm?.coordsAtPos(editor.posToOffset(info.start));
		this.showValues(values, at ? new DOMRect(at.left, at.top, 0, at.bottom - at.top) : new DOMRect());
		return values.length > 0;
	}

	close(): void {
		this.context = null;
		super.close();
	}
}
