// Core plugins (Obsidian's "internal plugins"): toggleable features saved in .obsidian/core-plugins.json.
// Exposed as `app.internalPlugins` (getPluginById / getEnabledPluginById), which many community plugins call.
import type { App } from './app';
import { Component } from './events';
import type { Command } from './keymap';
import type { ViewCreator } from './workspace';

export abstract class CorePlugin extends Component {
	abstract id: string;
	abstract name: string;
	abstract description: string;
	defaultOn = true;

	constructor(public app: App) {
		super();
	}

	registerView(type: string, creator: ViewCreator): void {
		this.app.viewRegistry.registerView(type, creator);
		this.register(() => {
			this.app.workspace.detachLeavesOfType(type);
			this.app.viewRegistry.unregisterView(type);
		});
	}

	addCommand(cmd: Command): Command {
		this.app.commands.addCommand(cmd);
		this.register(() => this.app.commands.removeCommand(cmd.id));
		return cmd;
	}

	addRibbonIcon(icon: string, title: string, cb: (evt: MouseEvent) => any): HTMLElement {
		const el = this.app.workspace.leftRibbon.addRibbonIcon(icon, title, cb);
		this.register(() => el.detach());
		return el;
	}

	addSettingTab(tab: { core: boolean }): void {
		tab.core = true;
		this.app.setting.addSettingTab(tab as any);
		this.register(() => this.app.setting.removeSettingTab(tab as any));
	}

	/** Options stored in .obsidian/<file>.json (Obsidian's file names, so desktop and web share them). */
	async loadOptions<T extends object>(file: string, defaults: T): Promise<T> {
		return { ...defaults, ...((await this.app.vault.readConfigJson(file)) ?? {}) };
	}

	addStatusBarItem(): HTMLElement {
		const el = this.app.addStatusBarItem();
		this.register(() => el.detach());
		return el;
	}
}

export class InternalPlugins {
	plugins: Record<string, { instance: CorePlugin; enabled: boolean }> = {};

	constructor(private app: App) {}

	/** Internal: id → enabled (`app.internalPlugins.config`). */
	get config(): Record<string, boolean> {
		return Object.fromEntries(Object.values(this.plugins).map((p) => [p.instance.id, p.enabled]));
	}

	add(plugin: CorePlugin): void {
		this.plugins[plugin.id] = { instance: plugin, enabled: false };
	}

	getPluginById(id: string): { instance: CorePlugin; enabled: boolean } | null {
		return this.plugins[id] ?? null;
	}

	getEnabledPluginById(id: string): CorePlugin | null {
		const p = this.plugins[id];
		return p?.enabled ? p.instance : null;
	}

	/** Enable plugins per core-plugins.json (object {id: boolean}; older vaults use an array of enabled ids). */
	async load(): Promise<void> {
		const saved = await this.app.vault.readConfigJson('core-plugins');
		const enabled = (id: string, dflt: boolean) => (Array.isArray(saved) ? saved.includes(id) : saved && id in saved ? !!saved[id] : dflt);
		for (const p of Object.values(this.plugins)) if (enabled(p.instance.id, p.instance.defaultOn)) this.setEnabled(p.instance.id, true, false);
	}

	setEnabled(id: string, on: boolean, save = true): void {
		const p = this.plugins[id];
		if (!p || p.enabled === on) return;
		p.enabled = on;
		on ? p.instance.load() : p.instance.unload();
		if (save) void this.app.vault.writeConfigJson('core-plugins', Object.fromEntries(Object.values(this.plugins).map((x) => [x.instance.id, x.enabled])));
	}
}
