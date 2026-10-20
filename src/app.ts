// The `app` object (obsidian.d.ts App) that core views and, later, plugins receive.
import type { BaseAdapter } from './adapters';
import { applyAppearance } from './appearance';
import { registerCoreCommands } from './commands';
import { InternalPlugins } from './coreplugins';
import { FileManager } from './filemanager';
import { Commands, Keymap, Scope } from './keymap';
import { pluginRequire } from './api';
import { MetadataCache } from './metadata';
import { PluginManager } from './plugins';
import { SettingsModal } from './modals';
import { FileExplorerView } from './views/explorer';
import { MarkdownView } from './views/markdown';
import { BookmarksPlugin } from './views/bookmarks';
import { BacklinkPlugin, OutgoingLinkPlugin, OutlinePlugin, PagePreviewPlugin, TagPanePlugin, WordCountPlugin } from './views/panels';
import { GlobalSearchPlugin } from './views/search';
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
		for (const P of [GlobalSearchPlugin, BookmarksPlugin, BacklinkPlugin, OutgoingLinkPlugin, OutlinePlugin, TagPanePlugin, PagePreviewPlugin, WordCountPlugin]) {
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
