// The `app` object (obsidian.d.ts App) that core views and, later, plugins receive.
import type { BaseAdapter } from './adapters';
import { MetadataCache } from './metadata';
import { FileExplorerView } from './views/explorer';
import { MarkdownView } from './views/markdown';
import { Vault } from './vault';
import { ViewRegistry, Workspace, type WorkspaceLeaf } from './workspace';

export class App {
	vault: Vault;
	metadataCache: MetadataCache;
	viewRegistry = new ViewRegistry();
	workspace: Workspace;
	/** Root element: .app-container > .horizontal-main-container > .workspace, plus the status bar. */
	containerEl = createDiv('app-container');
	statusBarEl: HTMLElement;

	constructor(adapter: BaseAdapter, useWorker: boolean) {
		this.vault = new Vault(adapter);
		this.metadataCache = new MetadataCache(this.vault, useWorker);
		this.workspace = new Workspace(this);
		this.containerEl.createDiv('horizontal-main-container').appendChild(this.workspace.containerEl);
		this.statusBarEl = this.containerEl.createDiv('status-bar');

		this.viewRegistry.registerView('markdown', (leaf) => new MarkdownView(leaf));
		this.viewRegistry.registerExtensions(['md'], 'markdown');
		this.viewRegistry.registerView('file-explorer', (leaf) => new FileExplorerView(leaf));
		this.workspace.leftRibbon.addRibbonIcon('square-pen', 'Create new note', () => void this.newNote());
		this.workspace.leftRibbon.addRibbonIcon('panel-left', 'Toggle left sidebar', () => this.workspace.leftSplit.toggle());
	}

	async load(): Promise<void> {
		await this.vault.load();
		this.workspace.initLayout();
		await this.workspace.ensureSideLeaf('file-explorer', 'left', { reveal: true });
		// Index in the background: the UI is usable while a large vault is still being parsed.
		void this.metadataCache.initialize();
	}

	addStatusBarItem(): HTMLElement {
		return this.statusBarEl.createDiv('status-bar-item');
	}

	/** Create "Untitled.md" (or "Untitled N.md") at the vault root and open it. */
	async newNote(leaf?: WorkspaceLeaf): Promise<void> {
		let path = 'Untitled.md';
		for (let n = 1; this.vault.getAbstractFileByPath(path); n++) path = `Untitled ${n}.md`;
		const file = await this.vault.create(path, '');
		await (leaf ?? this.workspace.getLeaf(false)).openFile(file, { active: true });
	}
}
