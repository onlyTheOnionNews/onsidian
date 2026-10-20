// Community plugin host (PLAN §6): Plugin base class, `app.plugins` manager, CommonJS loader with a require() shim.
// Plugins are trusted code (same as desktop) and stay off until the user turns off Restricted mode on this device.
import type { App } from './app';
import { Component } from './events';
import type { Command } from './keymap';
import { MarkdownPreviewRenderer, type CodeBlockProcessor, type MarkdownPostProcessor } from './render';
import { SettingTab } from './modals';
import { trackMissing } from './api';
import { basesViewRegistry } from './bases/base';
import { Notice, type ViewCreator } from './workspace';

export interface PluginManifest {
	dir?: string;
	id: string;
	name: string;
	author: string;
	version: string;
	minAppVersion: string;
	description: string;
	authorUrl?: string;
	isDesktopOnly?: boolean;
	/** Ships with the app (URL of its files); settings still live in the vault's plugin folder. */
	bundled?: string;
}

export abstract class Plugin extends Component {
	settings?: unknown;

	constructor(public app: App, public manifest: PluginManifest) {
		super();
	}

	/** Obsidian awaits a plugin's (possibly async) onload before loading its children. */
	async load(): Promise<void> {
		if (this._loaded) return;
		this._loaded = true;
		await this.onload();
		for (const c of this._children) c.load();
	}

	onload(): Promise<void> | void {}
	onUserEnable(): void {}
	onExternalSettingsChange?(): any;

	addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => any): HTMLElement {
		const el = this.app.workspace.leftRibbon.addRibbonIcon(icon, title, callback);
		this.register(() => el.detach());
		return el;
	}

	addStatusBarItem(): HTMLElement {
		const el = this.app.addStatusBarItem();
		el.addClass(`plugin-${this.manifest.id.replace(/[^\w-]/g, '-')}`);
		this.register(() => el.detach());
		return el;
	}

	/** Command ids are namespaced "pluginId:commandId", as in Obsidian. */
	addCommand(command: Command): Command {
		const cmd = { ...command, id: `${this.manifest.id}:${command.id}`, name: `${this.manifest.name}: ${command.name}` };
		this.app.commands.addCommand(cmd);
		this.register(() => this.app.commands.removeCommand(cmd.id));
		return cmd;
	}

	removeCommand(commandId: string): void {
		this.app.commands.removeCommand(`${this.manifest.id}:${commandId}`);
	}

	addSettingTab(tab: SettingTab): void {
		this.app.setting.addSettingTab(tab);
		this.register(() => this.app.setting.removeSettingTab(tab));
	}

	registerView(type: string, creator: ViewCreator): void {
		this.app.viewRegistry.registerView(type, creator);
		this.register(() => {
			this.app.workspace.detachLeavesOfType(type);
			this.app.viewRegistry.unregisterView(type);
		});
	}

	registerExtensions(extensions: string[], viewType: string): void {
		this.app.viewRegistry.registerExtensions(extensions, viewType);
		this.register(() => {
			for (const e of extensions) delete this.app.viewRegistry.typeByExtension[e];
		});
	}

	registerHoverLinkSource(id: string, info: { display: string; defaultMod: boolean }): void {
		this.app.workspace.hoverLinkSources[id] = info;
		this.register(() => delete this.app.workspace.hoverLinkSources[id]);
	}

	registerMarkdownPostProcessor(pp: MarkdownPostProcessor, sortOrder?: number): MarkdownPostProcessor {
		MarkdownPreviewRenderer.registerPostProcessor(pp, sortOrder);
		this.register(() => MarkdownPreviewRenderer.unregisterPostProcessor(pp));
		return pp;
	}

	registerMarkdownCodeBlockProcessor(language: string, handler: CodeBlockProcessor, sortOrder?: number): MarkdownPostProcessor {
		MarkdownPreviewRenderer.registerCodeBlockPostProcessor(language, handler);
		this.register(() => MarkdownPreviewRenderer.unregisterCodeBlockPostProcessor(language));
		const pp: MarkdownPostProcessor = () => {};
		pp.sortOrder = sortOrder;
		return pp;
	}

	registerEditorExtension(extension: unknown): void {
		const list = this.app.workspace.editorExtensions;
		list.push(extension);
		this.app.workspace.updateOptions();
		this.register(() => {
			const i = list.indexOf(extension);
			if (i >= 0) list.splice(i, 1);
			this.app.workspace.updateOptions();
		});
	}

	registerEditorSuggest(suggest: { close(): void }): void {
		const list = this.app.workspace.editorSuggest.suggests;
		list.push(suggest);
		this.register(() => {
			suggest.close();
			const i = list.indexOf(suggest);
			if (i >= 0) list.splice(i, 1);
		});
	}

	registerObsidianProtocolHandler(action: string, handler: (params: Record<string, string>) => any): void {
		this.app.protocolHandlers.set(action, handler);
		this.register(() => this.app.protocolHandlers.delete(action));
	}

	/** Adds a Bases layout (e.g. the official Maps plugin's map view). */
	registerBasesView(viewId: string, registration: { name: string; icon: string; factory: (controller: any, containerEl: HTMLElement) => any; options?: (config: any) => unknown[] }): boolean {
		if (basesViewRegistry.has(viewId)) return false;
		basesViewRegistry.set(viewId, registration);
		this.register(() => basesViewRegistry.delete(viewId));
		return true;
	}

	registerCliHandler(): void {}

	async loadData(): Promise<any> {
		const path = `${this.manifest.dir}/data.json`;
		if (!(await this.app.vault.adapter.exists(path))) return null;
		return JSON.parse(await this.app.vault.adapter.read(path));
	}

	async saveData(data: any): Promise<void> {
		await this.app.vault.adapter.write(`${this.manifest.dir}/data.json`, JSON.stringify(data, null, 2));
	}
}

export abstract class PluginSettingTab extends SettingTab {
	constructor(app: App, public plugin: Plugin) {
		super(app);
		this.id = plugin.manifest.id;
		this.name = plugin.manifest.name;
	}

	getControlValue(key: string): unknown {
		return (this.plugin.settings as any)?.[key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const s = (this.plugin.settings ??= {}) as Record<string, unknown>;
		s[key] = value;
		await this.plugin.saveData(s);
	}
}

// ---------------- Loader ----------------

type Factory = (require: (id: string) => unknown, module: { exports: any }, exports: any, global: Window) => void;
const pending = new Map<string, (f: Factory) => void>();
(window as any).__obsidianOnlineDefine = (key: string, factory: Factory) => pending.get(key)?.(factory);

/**
 * Evaluate a CommonJS bundle through a blob: <script> (so a CSP can allow `blob:` without 'unsafe-eval').
 * Syntax/runtime errors at top level surface via window 'error' events, which we match by the script URL.
 */
export async function evaluateCommonJs(code: string, name: string, requireFn: (id: string) => unknown): Promise<any> {
	const key = `${name}:${Math.random().toString(36).slice(2)}`;
	const src = `window.__obsidianOnlineDefine(${JSON.stringify(key)}, function (require, module, exports, global) {\n${code}\n});\n//# sourceURL=plugin:${encodeURIComponent(name)}/main.js`;
	const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
	const script = document.createElement('script');
	const onError = (e: ErrorEvent) => e.filename === url && reject?.(e.error ?? new Error(e.message));
	let reject: ((e: Error) => void) | undefined;
	try {
		const factory = await new Promise<Factory>((res, rej) => {
			reject = rej;
			pending.set(key, res);
			window.addEventListener('error', onError);
			script.onerror = () => rej(new Error('Script failed to load (blocked by CSP?)'));
			// Fires after the script ran; a no-op if define() already resolved.
			script.onload = () => rej(new Error('Plugin bundle did not define a module.'));
			script.src = url;
			document.head.appendChild(script);
		});
		const module = { exports: {} as any };
		factory(requireFn, module, module.exports, window);
		return module.exports;
	} finally {
		window.removeEventListener('error', onError);
		script.remove();
		pending.delete(key);
		URL.revokeObjectURL(url);
	}
}

/** In diagnose mode, plugins get an `app` whose managers report reads of members we don't implement. */
function diagnosticApp(app: App): App {
	if (!(window as any).__obsidianOnlineDiagnose) return app;
	const wrapped = new Map<string, unknown>();
	for (const k of ['workspace', 'vault', 'metadataCache', 'fileManager', 'plugins', 'internalPlugins', 'commands', 'setting', 'viewRegistry', 'keymap']) {
		wrapped.set(k, trackMissing((app as any)[k], `app.${k}`));
	}
	const tracked = trackMissing(app, 'app');
	return new Proxy(tracked, { get: (t, p, r) => (typeof p === 'string' && wrapped.has(p) ? wrapped.get(p) : Reflect.get(t, p, r)) });
}

// ---------------- Manager (`app.plugins`) ----------------

const RESTRICTED_KEY = (vaultId: string) => `obsidian-online:community-plugins:${vaultId}`;
const SEEDED_KEY = (vaultId: string) => `obsidian-online:bundled-seeded:${vaultId}`;
const local = {
	get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
	set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

/**
 * Plugins that ship with the app (PLAN §7.1): Relay is the built-in collaboration feature. Vendored at build time
 * (scripts/vendor-relay.mjs), exempt from Restricted mode, on by default, and can't be uninstalled, only turned off.
 * A vault that has its own copy installed uses that copy instead.
 */
export const BUNDLED_PLUGINS = ['system3-relay'];

export class PluginManager {
	manifests: Record<string, PluginManifest> = {};
	plugins: Record<string, Plugin> = {};
	enabledPlugins = new Set<string>();
	/** Load/runtime errors by plugin id, shown in settings. */
	errors: Record<string, string> = {};
	private styles: Record<string, HTMLStyleElement> = {};

	constructor(private app: App, private vaultId: string, private requireFn: (id: string) => unknown) {}

	get dir(): string {
		return `${this.app.vault.configDir}/plugins`;
	}

	/** Restricted mode is per device and per vault (trusting plugins is a device decision), on by default. */
	isEnabled(): boolean {
		try { return localStorage.getItem(RESTRICTED_KEY(this.vaultId)) === 'on'; } catch { return false; }
	}

	setCommunityPluginsEnabled(on: boolean): void {
		try {
			if (on) localStorage.setItem(RESTRICTED_KEY(this.vaultId), 'on');
			else localStorage.removeItem(RESTRICTED_KEY(this.vaultId));
		} catch { /* storage blocked: can't remember the choice */ }
	}

	async loadManifests(): Promise<void> {
		this.manifests = {};
		const { adapter } = this.app.vault;
		if (!(await adapter.exists(this.dir))) return;
		for (const folder of (await adapter.list(this.dir)).folders) {
			try {
				const m = JSON.parse(await adapter.read(`${folder}/manifest.json`)) as PluginManifest;
				if (m.id) this.manifests[m.id] = { ...m, dir: folder };
			} catch {
				// not a plugin folder
			}
		}
		for (const id of BUNDLED_PLUGINS) {
			if (this.manifests[id]) continue;
			const url = new URL(`bundled/${id}/`, document.baseURI).href;
			try {
				const m = (await (await fetch(`${url}manifest.json`)).json()) as PluginManifest;
				this.manifests[id] = { ...m, dir: `${this.dir}/${id}`, bundled: url };
			} catch {
				// not vendored in this build
			}
		}
	}

	/** Startup: read manifests + community-plugins.json, then load enabled plugins unless restricted. */
	async initialize(): Promise<void> {
		await this.loadManifests();
		const saved = await this.app.vault.readConfigJson('community-plugins');
		this.enabledPlugins = new Set(Array.isArray(saved) ? saved.filter((x) => typeof x === 'string') : []);
		// Bundled plugins start enabled, once per vault; after that the user's toggle (community-plugins.json) decides.
		// ponytail: the "seeded" marker is per device, so another device enables it once more; sync it if that bites.
		if (BUNDLED_PLUGINS.some((id) => this.manifests[id]?.bundled) && !local.get(SEEDED_KEY(this.vaultId))) {
			for (const id of BUNDLED_PLUGINS) if (this.manifests[id]) this.enabledPlugins.add(id);
			await this.saveConfig();
			local.set(SEEDED_KEY(this.vaultId), '1');
		}
		for (const id of this.enabledPlugins) if (this.isEnabled() || this.manifests[id]?.bundled) await this.loadPlugin(id);
	}

	getPlugin(id: string): Plugin | null {
		return this.plugins[id] ?? null;
	}

	async loadPlugin(id: string): Promise<Plugin | null> {
		const m = this.manifests[id];
		if (!m) return null;
		if (this.plugins[id]) return this.plugins[id];
		delete this.errors[id];
		if (m.isDesktopOnly) {
			this.errors[id] = 'Desktop-only plugin: it needs Node.js or Electron, which browsers don\'t provide.';
			return null;
		}
		try {
			const code = m.bundled ? await (await fetch(`${m.bundled}main.js`)).text() : await this.app.vault.adapter.read(`${m.dir}/main.js`);
			const exported = await evaluateCommonJs(code, id, this.requireFn);
			const PluginClass = exported?.default ?? exported;
			if (typeof PluginClass !== 'function') throw new Error('main.js does not export a Plugin class.');
			const plugin: Plugin = new PluginClass(diagnosticApp(this.app), m);
			this.plugins[id] = plugin;
			await this.loadStyles(m);
			await plugin.load();
			return plugin;
		} catch (e) {
			console.error(`Plugin "${id}" failed to load`, e);
			this.errors[id] = String((e as Error)?.message ?? e);
			await this.unloadPlugin(id);
			return null;
		}
	}

	async unloadPlugin(id: string): Promise<void> {
		const p = this.plugins[id];
		delete this.plugins[id];
		this.styles[id]?.remove();
		delete this.styles[id];
		try {
			p?.unload();
		} catch (e) {
			console.error(`Plugin "${id}" failed to unload`, e);
		}
	}

	async enablePlugin(id: string): Promise<boolean> {
		const p = await this.loadPlugin(id);
		if (p) p.onUserEnable();
		return !!p;
	}

	async disablePlugin(id: string): Promise<void> {
		await this.unloadPlugin(id);
	}

	async enablePluginAndSave(id: string): Promise<boolean> {
		this.enabledPlugins.add(id);
		await this.saveConfig();
		return this.enablePlugin(id);
	}

	async disablePluginAndSave(id: string): Promise<void> {
		this.enabledPlugins.delete(id);
		await this.saveConfig();
		await this.disablePlugin(id);
	}

	async uninstallPlugin(id: string): Promise<void> {
		const m = this.manifests[id];
		if (m?.bundled) return; // built in: it can only be turned off, and its folder holds the vault's settings
		await this.disablePluginAndSave(id);
		if (m?.dir) await this.app.vault.adapter.rmdir(m.dir, true);
		delete this.manifests[id];
		await this.loadManifests(); // a removed local copy of a bundled plugin falls back to the built-in one
	}

	/** Write a plugin's files into .obsidian/plugins/<id>/ (from a zip, folder, or download). */
	async installPlugin(files: { manifest: string; main: string; styles?: string }): Promise<PluginManifest> {
		const m = JSON.parse(files.manifest) as PluginManifest;
		if (!m.id || !/^[\w.-]+$/.test(m.id)) throw new Error('manifest.json has no valid "id".');
		const dir = `${this.dir}/${m.id}`;
		const { adapter } = this.app.vault;
		const wasLoaded = !!this.plugins[m.id];
		if (wasLoaded) await this.unloadPlugin(m.id);
		await adapter.mkdir(dir);
		await adapter.write(`${dir}/manifest.json`, files.manifest);
		await adapter.write(`${dir}/main.js`, files.main);
		if (files.styles !== undefined) await adapter.write(`${dir}/styles.css`, files.styles);
		this.manifests[m.id] = { ...m, dir };
		if (wasLoaded) await this.loadPlugin(m.id);
		new Notice(`Installed ${m.name} ${m.version}.`);
		return this.manifests[m.id];
	}

	private async loadStyles(m: PluginManifest): Promise<void> {
		const path = `${m.dir}/styles.css`;
		const css = m.bundled
			? await fetch(`${m.bundled}styles.css`).then((r) => (r.ok ? r.text() : null))
			: (await this.app.vault.adapter.exists(path)) ? await this.app.vault.adapter.read(path) : null;
		if (css === null) return;
		const style = document.head.createEl('style', { attr: { 'data-plugin': m.id } });
		style.textContent = css;
		this.styles[m.id] = style;
	}

	private async saveConfig(): Promise<void> {
		await this.app.vault.writeConfigJson('community-plugins', [...this.enabledPlugins]);
	}
}
