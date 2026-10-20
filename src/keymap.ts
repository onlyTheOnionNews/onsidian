// Scope / Keymap / commands + hotkeys (obsidian.d.ts). One window-level keydown listener (capture phase) dispatches:
// top scope (modal, menu, suggest) → its parents → app.scope (command hotkeys). Unmatched keys reach CM6 / the browser.
import type { App } from './app';

export type Modifier = 'Mod' | 'Ctrl' | 'Meta' | 'Shift' | 'Alt';

export interface Hotkey {
	modifiers: Modifier[];
	key: string;
}

export interface KeymapContext {
	modifiers: string | null;
	key: string | null;
	vkey: string;
}

export type KeymapEventListener = (evt: KeyboardEvent, ctx: KeymapContext) => false | any;

export interface KeymapEventHandler {
	scope: Scope;
	modifiers: string | null;
	key: string | null;
	func: KeymapEventListener;
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Canonical modifier string in Obsidian's order, e.g. "Mod,Shift". 'Mod' is Cmd on macOS, Ctrl elsewhere. */
function modString(mods: Modifier[]): string {
	const set = new Set(mods.map((m) => (m === (isMac ? 'Meta' : 'Ctrl') ? 'Mod' : m)));
	return (['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift'] as const).filter((m) => set.has(m)).join(',');
}

function eventMods(evt: KeyboardEvent | MouseEvent): string {
	const mods: Modifier[] = [];
	if (evt.ctrlKey) mods.push('Ctrl');
	if (evt.metaKey) mods.push('Meta');
	if (evt.altKey) mods.push('Alt');
	if (evt.shiftKey) mods.push('Shift');
	return modString(mods);
}

/** Layout-independent key name: letters/digits from `code` (Alt/Shift change `key`), named keys from `key`. */
export function eventKey(evt: KeyboardEvent): string {
	const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(evt.code);
	if (m) return m[1] ?? m[2];
	return evt.key.length === 1 ? evt.key.toUpperCase() : evt.key;
}

export function hotkeyMatches(hk: Hotkey, evt: KeyboardEvent): boolean {
	return modString(hk.modifiers) === eventMods(evt) && hk.key.toUpperCase() === eventKey(evt).toUpperCase();
}

export function hotkeyLabel(hk: Hotkey): string {
	const names: Record<string, string> = isMac
		? { Mod: '⌘', Ctrl: '⌃', Meta: '⌘', Alt: '⌥', Shift: '⇧' }
		: { Mod: 'Ctrl', Ctrl: 'Ctrl', Meta: 'Win', Alt: 'Alt', Shift: 'Shift' };
	const mods = modString(hk.modifiers).split(',').filter(Boolean).map((m) => names[m]);
	const key = hk.key.length === 1 ? hk.key.toUpperCase() : hk.key.replace(/^Arrow/, '');
	return [...mods, key].join(isMac ? '' : ' + ');
}

export class Scope {
	keys: KeymapEventHandler[] = [];

	constructor(public parent?: Scope) {}

	register(modifiers: Modifier[] | null, key: string | null, func: KeymapEventListener): KeymapEventHandler {
		const h: KeymapEventHandler = { scope: this, modifiers: modifiers ? modString(modifiers) : null, key, func };
		this.keys.push(h);
		return h;
	}

	unregister(handler: KeymapEventHandler): void {
		const i = this.keys.indexOf(handler);
		if (i >= 0) this.keys.splice(i, 1);
	}

	/** @internal true when a handler consumed the event. */
	handleKey(evt: KeyboardEvent, ctx: KeymapContext): boolean {
		for (const h of this.keys) {
			if (h.modifiers !== null && h.modifiers !== ctx.modifiers) continue;
			if (h.key !== null && h.key.toUpperCase() !== (ctx.key ?? '').toUpperCase() && h.key !== evt.key) continue;
			if (h.func(evt, ctx) === false) {
				evt.preventDefault();
				evt.stopPropagation();
				return true;
			}
			return false; // handler ran and let the event through
		}
		return this.parent?.handleKey(evt, ctx) ?? false;
	}
}

export class Keymap {
	private scopes: Scope[] = [];

	constructor(private root: Scope) {
		window.addEventListener('keydown', (evt) => {
			if (evt.isComposing) return;
			const key = eventKey(evt);
			const ctx: KeymapContext = { modifiers: eventMods(evt), key, vkey: key };
			(this.scopes[this.scopes.length - 1] ?? this.root).handleKey(evt, ctx);
		}, true);
	}

	pushScope(scope: Scope): void {
		this.popScope(scope);
		this.scopes.push(scope);
	}

	popScope(scope: Scope): void {
		const i = this.scopes.indexOf(scope);
		if (i >= 0) this.scopes.splice(i, 1);
	}

	static isModifier(evt: MouseEvent | TouchEvent | KeyboardEvent, modifier: Modifier): boolean {
		const e = evt as KeyboardEvent;
		switch (modifier) {
			case 'Mod': return isMac ? e.metaKey : e.ctrlKey;
			case 'Ctrl': return e.ctrlKey;
			case 'Meta': return e.metaKey;
			case 'Alt': return e.altKey;
			case 'Shift': return e.shiftKey;
		}
	}

	/** Mod-click → new tab, Mod+Alt → split, Mod+Alt+Shift → window (tab until pop-outs exist). */
	static isModEvent(evt?: MouseEvent | KeyboardEvent | null): 'tab' | 'split' | 'window' | boolean {
		if (!evt) return false;
		const mod = Keymap.isModifier(evt, 'Mod') || (evt instanceof MouseEvent && evt.button === 1);
		if (!mod) return false;
		if (evt.altKey && evt.shiftKey) return 'window';
		if (evt.altKey) return 'split';
		return 'tab';
	}
}

// ---------------- Commands ----------------

export interface Command {
	id: string;
	name: string;
	icon?: string;
	mobileOnly?: boolean;
	repeatable?: boolean;
	callback?: () => any;
	checkCallback?: (checking: boolean) => boolean | void;
	editorCallback?: (editor: any, ctx: any) => any;
	editorCheckCallback?: (checking: boolean, editor: any, ctx: any) => boolean | void;
	hotkeys?: Hotkey[];
}

/** `app.commands` (internal in Obsidian, widely used by plugins) plus the hotkey manager. */
export class Commands {
	commands: Record<string, Command> = {};
	/** User overrides from .obsidian/hotkeys.json; an empty array removes the default hotkeys. */
	customKeys: Record<string, Hotkey[]> = {};

	constructor(private app: App) {
		app.scope.register(null, null, (evt) => {
			for (const cmd of Object.values(this.commands)) {
				if (!this.getHotkeys(cmd.id).some((hk) => hotkeyMatches(hk, evt))) continue;
				if (evt.repeat && !cmd.repeatable) return false;
				if (this.executeCommand(cmd)) return false;
			}
		});
	}

	addCommand(cmd: Command): Command {
		this.commands[cmd.id] = cmd;
		return cmd;
	}

	removeCommand(id: string): void {
		delete this.commands[id];
	}

	findCommand(id: string): Command | undefined {
		return this.commands[id];
	}

	listCommands(): Command[] {
		return Object.values(this.commands);
	}

	getHotkeys(id: string): Hotkey[] {
		return this.customKeys[id] ?? this.commands[id]?.hotkeys ?? [];
	}

	isAvailable(cmd: Command): boolean {
		return this.run(cmd, true);
	}

	executeCommandById(id: string): boolean {
		const cmd = this.commands[id];
		return !!cmd && this.executeCommand(cmd);
	}

	executeCommand(cmd: Command): boolean {
		return this.run(cmd, false);
	}

	private run(cmd: Command, checking: boolean): boolean {
		const md = this.app.workspace.activeEditor;
		if (cmd.editorCheckCallback || cmd.editorCallback) {
			if (!md?.editor) return false;
			if (cmd.editorCheckCallback) return cmd.editorCheckCallback(checking, md.editor, md) !== false;
			if (!checking) cmd.editorCallback!(md.editor, md);
			return true;
		}
		if (cmd.checkCallback) return cmd.checkCallback(checking) !== false;
		if (!checking) cmd.callback?.();
		return !!cmd.callback;
	}
}
