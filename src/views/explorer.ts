// File explorer core view (PLAN §5.1), using Obsidian's nav-* / tree-item class names for theme compatibility.
// ponytail: re-renders the whole tree on any vault change (fine to a few thousand items; diff per item if it lags).
// No drag-and-drop yet.
import { setIcon } from '../icons';
import { Menu, promptText } from '../ui';
import { TAbstractFile, TFile, TFolder } from '../vault';
import { ItemView, Notice, type WorkspaceLeaf } from '../workspace';

export class FileExplorerView extends ItemView {
	icon = 'folder-closed';
	private treeEl: HTMLElement;
	private collapsed = new Set<string>();
	private renderQueued = false;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.containerEl.addClass('file-explorer');
		this.headerEl.hide();
		const nav = this.contentEl.createDiv('nav-header').createDiv('nav-buttons-container');
		const button = (icon: string, label: string, cb: () => void) => {
			const el = nav.createDiv({ cls: 'clickable-icon nav-action-button', attr: { 'aria-label': label } });
			setIcon(el, icon);
			el.addEventListener('click', cb);
		};
		button('square-pen', 'New note', () => void this.app.newNote());
		button('folder-plus', 'New folder', () => void this.newFolder(this.app.vault.getRoot()));
		button('chevrons-down-up', 'Collapse all', () => {
			for (const f of this.app.vault.getAllFolders()) this.collapsed.add(f.path);
			this.render();
		});
		this.treeEl = this.contentEl.createDiv('nav-files-container');
	}

	getViewType(): string {
		return 'file-explorer';
	}

	getDisplayText(): string {
		return 'Files';
	}

	onload(): void {
		for (const e of ['create', 'delete', 'rename']) this.registerEvent(this.app.vault.on(e, () => this.queueRender()));
		this.registerEvent(this.app.workspace.on('file-open', () => this.queueRender()));
		this.render();
	}

	private queueRender(): void {
		if (this.renderQueued) return;
		this.renderQueued = true;
		setTimeout(() => {
			this.renderQueued = false;
			this.render();
		});
	}

	private render(): void {
		const active = this.app.workspace.getActiveFile();
		const root = this.treeEl.createDiv();
		this.renderChildren(this.app.vault.getRoot(), root, active);
		this.treeEl.replaceChildren(root);
	}

	private renderChildren(folder: TFolder, el: HTMLElement, active: TFile | null): void {
		const sorted = [...folder.children].sort((a, b) =>
			Number(b instanceof TFolder) - Number(a instanceof TFolder) || a.name.localeCompare(b.name, undefined, { numeric: true }));
		for (const item of sorted) {
			if (item instanceof TFolder) this.renderFolder(item, el, active);
			else this.renderFile(item as TFile, el, active);
		}
	}

	private renderFolder(folder: TFolder, parent: HTMLElement, active: TFile | null): void {
		const collapsed = this.collapsed.has(folder.path);
		const item = parent.createDiv({ cls: ['tree-item', 'nav-folder', collapsed ? 'is-collapsed' : ''].filter(Boolean) });
		const self = item.createDiv({ cls: 'tree-item-self nav-folder-title is-clickable mod-collapsible', attr: { 'data-path': folder.path, draggable: 'true' } });
		const icon = self.createDiv({ cls: ['tree-item-icon', 'collapse-icon', 'nav-folder-collapse-indicator', collapsed ? 'is-collapsed' : ''].filter(Boolean) });
		setIcon(icon, 'chevron-down'); // rotated by CSS when collapsed
		self.createDiv({ cls: 'tree-item-inner nav-folder-title-content', text: folder.name });
		self.addEventListener('click', () => {
			collapsed ? this.collapsed.delete(folder.path) : this.collapsed.add(folder.path);
			this.render();
		});
		self.addEventListener('contextmenu', (e) => this.onContextMenu(e, folder));
		if (!collapsed) this.renderChildren(folder, item.createDiv('tree-item-children nav-folder-children'), active);
	}

	private renderFile(file: TFile, parent: HTMLElement, active: TFile | null): void {
		const item = parent.createDiv('tree-item nav-file');
		const self = item.createDiv({
			cls: ['tree-item-self', 'nav-file-title', 'is-clickable', file === active ? 'is-active' : ''].filter(Boolean),
			attr: { 'data-path': file.path, draggable: 'true' },
		});
		self.createDiv({ cls: 'tree-item-inner nav-file-title-content', text: file.extension === 'md' ? file.basename : file.name });
		if (file.extension !== 'md') self.createDiv({ cls: 'nav-file-tag', text: file.extension });
		self.addEventListener('click', (e) => void this.app.workspace.getLeaf(e.ctrlKey || e.metaKey ? 'tab' : false).openFile(file));
		self.addEventListener('dragstart', (e) => e.dataTransfer?.setData('text/plain', file.path));
		self.addEventListener('auxclick', (e) => e.button === 1 && void this.app.workspace.getLeaf('tab').openFile(file));
		self.addEventListener('contextmenu', (e) => this.onContextMenu(e, file));
	}

	private onContextMenu(e: MouseEvent, file: TAbstractFile): void {
		const menu = new Menu();
		const safe = (fn: () => Promise<unknown>) => () => fn().catch((err) => new Notice(String(err?.message ?? err)));
		if (file instanceof TFolder) {
			menu.addItem((i) => i.setTitle('New note').setIcon('square-pen').setSection('new').onClick(safe(async () => {
				const f = await this.app.fileManager.createNewMarkdownFile(file);
				await this.app.workspace.getLeaf(false).openFile(f, { active: true });
			})));
			menu.addItem((i) => i.setTitle('New folder').setIcon('folder-plus').setSection('new').onClick(safe(() => this.newFolder(file))));
		} else if (file instanceof TFile) {
			menu.addItem((i) => i.setTitle('Open in new tab').setIcon('file-plus').setSection('open').onClick(safe(() => this.app.workspace.getLeaf('tab').openFile(file))));
			menu.addItem((i) => i.setTitle('Open to the right').setIcon('separator-vertical').setSection('open').onClick(safe(() => this.app.workspace.getLeaf('split').openFile(file))));
		}
		menu.addItem((i) => i.setTitle('Copy path').setIcon('copy').setSection('info').onClick(safe(() => navigator.clipboard.writeText(file.path))));
		menu.addItem((i) => i.setTitle('Rename…').setIcon('pencil').setSection('action').onClick(safe(() => this.rename(file))));
		menu.addItem((i) => i.setTitle('Delete').setIcon('trash-2').setWarning(true).setSection('danger').onClick(safe(() => this.app.fileManager.promptForDeletion(file))));
		this.app.workspace.trigger('file-menu', menu, file, 'file-explorer-context-menu', this.leaf);
		menu.showAtMouseEvent(e);
	}

	private async rename(file: TAbstractFile): Promise<void> {
		const isNote = file instanceof TFile && file.extension === 'md';
		const name = (await promptText(this.app, 'Rename', isNote ? (file as TFile).basename : file.name))?.trim();
		if (!name) return;
		const finalName = isNote && !name.endsWith('.md') ? `${name}.md` : name;
		await this.app.fileManager.renameFile(file, file.parent && !file.parent.isRoot() ? `${file.parent.path}/${finalName}` : finalName);
	}

	private async newFolder(parent: TFolder): Promise<void> {
		const base = parent.isRoot() ? '' : `${parent.path}/`;
		let path = `${base}Untitled`;
		for (let n = 1; this.app.vault.getAbstractFileByPath(path); n++) path = `${base}Untitled ${n}`;
		this.collapsed.delete(parent.path);
		await this.app.vault.createFolder(path);
	}

	/** Expand the file's parent folders and scroll it into view. */
	revealFile(file: TAbstractFile): void {
		for (let p = file.parent; p && !p.isRoot(); p = p.parent) this.collapsed.delete(p.path);
		this.render();
		this.treeEl.querySelector(`[data-path="${CSS.escape(file.path)}"]`)?.scrollIntoView({ block: 'center' });
	}
}
