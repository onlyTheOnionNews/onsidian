// The `app` object (obsidian.d.ts App) that core views and, later, plugins receive.
import type { BaseAdapter } from './adapters';
import { applyAppearance } from './appearance';
import { registerCoreCommands } from './commands';
import { CustomCss } from './community';
import { InternalPlugins } from './coreplugins';
import { FileManager } from './filemanager';
import { Commands, Keymap, Scope, hotkeyLabel } from './keymap';
import { pluginRequire } from './api';
import { MetadataCache } from './metadata';
import { PluginManager } from './plugins';
import { SettingsModal } from './modals';
import { markdownEmbedCreator } from './render';
import { SecretStorage } from './ui';
import { FileExplorerView } from './views/explorer';
import { MarkdownView } from './views/markdown';
import { BookmarksPlugin } from './views/bookmarks';
import { BacklinkPlugin, OutgoingLinkPlugin, OutlinePlugin, PagePreviewPlugin, TagPanePlugin, WordCountPlugin } from './views/panels';
import { GlobalSearchPlugin } from './views/search';
import { DailyNotesPlugin, NoteComposerPlugin, RandomNotePlugin, SlidesPlugin, TemplatesPlugin, UniqueNotePlugin } from './views/notes';
import { FileRecoveryPlugin } from './views/recovery';
import { GraphPlugin } from './views/graph';
import { Vault } from './vault';
import { ViewRegistry, Workspace, type WorkspaceLeaf } from './workspace';

export class App {
	vault: Vault;
	metadataCache: MetadataCache;
	fileManager: FileManager;
	viewRegistry = new ViewRegistry();
	/** Root key scope: command hotkeys live here; modals/menus push their own scopes above it. */
	scope = new Scope();
	keymap = new Keymap(this.scope);
	commands: Commands;
	workspace: Workspace;
	setting: SettingsModal;
	internalPlugins: InternalPlugins;
	plugins: PluginManager;
	customCss: CustomCss;
	/** Plugin secrets, device-local (never written to the vault). */
	secretStorage: SecretStorage;
	/** Internal registry plugins use to render custom file types as embeds (Kanban, Excalidraw…). */
	embedRegistry = {
		embedByExtension: {} as Record<string, (ctx: { app: App; containerEl: HTMLElement; sourcePath: string; linktext?: string }, file: unknown, subpath: string) => unknown>,
		registerExtension(ext: string, creator: any) { this.embedByExtension[ext] = creator; },
		registerExtensions(exts: string[], creator: any) { for (const e of exts) this.embedByExtension[e] = creator; },
		unregisterExtension(ext: string) { delete this.embedByExtension[ext]; },
		unregisterExtensions(exts: string[]) { for (const e of exts) delete this.embedByExtension[e]; },
		isExtensionRegistered(ext: string) { return ext in this.embedByExtension; },
		getEmbedCreator(file: { extension: string }) { return this.embedByExtension[file.extension] ?? null; },
	};
	/** Obsidian URI actions registered by plugins (registerObsidianProtocolHandler). */
	protocolHandlers = new Map<string, (params: Record<string, string>) => any>();
	/** Root element: .app-container > .horizontal-main-container > .workspace, plus the status bar. */
	containerEl = createDiv('app-container');
	statusBarEl: HTMLElement;

	constructor(adapter: BaseAdapter, useWorker: boolean, public appId: string) {
		this.vault = new Vault(adapter);
		this.metadataCache = new MetadataCache(this.vault, useWorker);
		this.fileManager = new FileManager(this);
		this.commands = new Commands(this);
		this.workspace = new Workspace(this);
		this.setting = new SettingsModal(this);
		this.internalPlugins = new InternalPlugins(this);
		this.plugins = new PluginManager(this, appId, pluginRequire);
		this.customCss = new CustomCss(this);
		this.secretStorage = new SecretStorage(appId);
		this.embedRegistry.registerExtension('md', Object.assign(markdownEmbedCreator, { builtin: true }));
		for (const P of [
			GlobalSearchPlugin, BookmarksPlugin, BacklinkPlugin, OutgoingLinkPlugin, OutlinePlugin, TagPanePlugin, PagePreviewPlugin, WordCountPlugin,
			TemplatesPlugin, DailyNotesPlugin, UniqueNotePlugin, RandomNotePlugin, NoteComposerPlugin, SlidesPlugin, FileRecoveryPlugin, GraphPlugin,
		]) {
			this.internalPlugins.add(new P(this));
		}
		this.containerEl.createDiv('horizontal-main-container').appendChild(this.workspace.containerEl);
		this.statusBarEl = this.containerEl.createDiv('status-bar');

		this.viewRegistry.registerView('markdown', (leaf) => new MarkdownView(leaf));
		this.viewRegistry.registerExtensions(['md'], 'markdown');
		this.viewRegistry.registerView('file-explorer', (leaf) => new FileExplorerView(leaf));
		registerCoreCommands(this);

		const ribbon = this.workspace.leftRibbon;
		ribbon.addRibbonIcon('panel-left', 'Toggle left sidebar', () => this.workspace.leftSplit.toggle());
		ribbon.addRibbonIcon('square-pen', 'Create new note', () => void this.newNote());
		ribbon.addRibbonIcon('search', 'Open quick switcher', () => this.commands.executeCommandById('switcher:open'));
		ribbon.addRibbonIcon('terminal', 'Open command palette', () => this.commands.executeCommandById('command-palette:open'));
		ribbon.addRibbonIcon('settings', 'Settings', () => this.setting.open()).addClass('mod-bottom');
	}

	async load(): Promise<void> {
		await this.vault.loadConfig();
		this.commands.customKeys = (await this.vault.readConfigJson('hotkeys')) ?? {};
		applyAppearance(this.vault);
		await this.customCss.load();
		this.propertyTypes = (await this.vault.readConfigJson('types'))?.types ?? {};
		this.vault.on('config-changed', () => applyAppearance(this.vault));
		await this.vault.load();
		// The explorer claims the first sidebar tab before plugins add theirs (onLayoutReady runs in order).
		this.workspace.onLayoutReady(() => void this.workspace.ensureSideLeaf('file-explorer', 'left'));
		// Plugins before the layout, so their views exist when saved leaves are restored.
		await this.internalPlugins.load();
		await this.workspace.initLayout();
		this.guardUnsavedChanges();
		// Community plugins load after the layout, as in Obsidian (their views then claim pending leaves).
		await this.plugins.initialize();
		// Index in the background: the UI is usable while a large vault is still being parsed.
		void this.metadataCache.initialize();
	}

	/** Flush pending autosaves when the tab is hidden; warn before closing while a save is still pending. */
	private guardUnsavedChanges(): void {
		const flush = () => {
			let pending = false;
			this.workspace.iterateAllLeaves((leaf) => {
				const v = leaf.view as any;
				if (v?.requestSave?.run) {
					const r = v.requestSave.run();
					if (r !== undefined) pending = true;
				}
			});
			return pending;
		};
		document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
		window.addEventListener('beforeunload', (e) => {
			if (flush()) e.preventDefault(); // the browser asks "Leave site?" while the write finishes
		});
	}

	isMobile = false;

	/** Internal: status bar wrapper (`app.statusBar.containerEl`). */
	get statusBar(): { containerEl: HTMLElement } {
		return { containerEl: this.statusBarEl };
	}

	/** Internal: hotkey lookups (`app.hotkeyManager`), backed by app.commands. */
	get hotkeyManager() {
		const c = this.commands;
		const save = () => void this.vault.writeConfigJson('hotkeys', c.customKeys);
		return {
			customKeys: c.customKeys,
			getHotkeys: (id: string) => c.customKeys[id],
			getDefaultHotkeys: (id: string) => c.commands[id]?.hotkeys ?? [],
			setHotkeys: (id: string, keys: any[]) => {
				c.customKeys[id] = keys;
				save();
			},
			removeHotkeys: (id: string) => {
				delete c.customKeys[id];
				save();
			},
			printHotkeyForCommand: (id: string) => c.getHotkeys(id).map((h) => hotkeyLabel(h)).join(', '),
			bake() {},
			save,
		};
	}

	/** Property name → type, from .obsidian/types.json. */
	propertyTypes: Record<string, string> = {};

	/**
	 * Internal: property names and types (`app.metadataTypeManager`). Types come from .obsidian/types.json, else are
	 * inferred from values. setType() writes types.json.
	 */
	get metadataTypeManager() {
		const app = this;
		const infer = (v: unknown) =>
			Array.isArray(v) ? 'multitext'
				: typeof v === 'number' ? 'number'
				: typeof v === 'boolean' ? 'checkbox'
				: typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? 'datetime'
				: typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? 'date'
				: 'text';
		return {
			types: this.propertyTypes,
			properties: {} as Record<string, unknown>,
			getAllProperties() {
				const out: Record<string, { name: string; type: string; count: number }> = {};
				for (const f of app.vault.getMarkdownFiles()) {
					for (const [k, v] of Object.entries(app.metadataCache.getFileCache(f)?.frontmatter ?? {})) {
						const key = k.toLowerCase();
						out[key] ??= { name: k, type: app.propertyTypes[key] ?? infer(v), count: 0 };
						out[key].count++;
					}
				}
				return out;
			},
			getPropertyInfo(name: string) {
				return this.getAllProperties()[name.toLowerCase()] ?? null;
			},
			getTypeInfo(name: string) {
				return { expected: { type: app.propertyTypes[name.toLowerCase()] ?? 'text' } };
			},
			setType(name: string, type: string) {
				app.propertyTypes[name.toLowerCase()] = type;
				void app.vault.writeConfigJson('types', { types: app.propertyTypes });
			},
			on: () => ({}),
			offref() {},
		};
	}

	showReleaseNotes(): void {}
	runOpeningBehavior(): void {}

	/** Internal Obsidian API many plugins use: per-vault localStorage (JSON values). */
	loadLocalStorage(key: string): any {
		try {
			const v = localStorage.getItem(`${this.appId}-${key}`);
			return v === null ? null : JSON.parse(v);
		} catch {
			return null;
		}
	}

	saveLocalStorage(key: string, value: unknown): void {
		try {
			if (value === undefined || value === null) localStorage.removeItem(`${this.appId}-${key}`);
			else localStorage.setItem(`${this.appId}-${key}`, JSON.stringify(value));
		} catch { /* storage blocked */ }
	}

	addStatusBarItem(): HTMLElement {
		return this.statusBarEl.createDiv('status-bar-item');
	}

	/** New note in the configured default location, opened in `leaf` (or the current one). */
	async newNote(leaf?: WorkspaceLeaf): Promise<void> {
		const source = this.workspace.getActiveFile()?.path ?? '';
		const file = await this.fileManager.createNewMarkdownFile(this.fileManager.getNewFileParent(source));
		await (leaf ?? this.workspace.getLeaf(false)).openFile(file, { active: true, state: { mode: 'source' } });
	}
}
