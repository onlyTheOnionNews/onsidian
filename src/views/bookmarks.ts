// Bookmarks core plugin: .obsidian/bookmarks.json in Obsidian's format (file, folder, search, heading, block, url, group).
import type { App } from '../app';
import { CorePlugin } from '../coreplugins';
import { Events } from '../events';
import { setIcon } from '../icons';
import { Keymap } from '../keymap';
import { Menu, promptText } from '../ui';
import { TAbstractFile, TFile, TFolder } from '../vault';
import { ItemView, type WorkspaceLeaf } from '../workspace';

export interface BookmarkItem {
	type: 'file' | 'folder' | 'search' | 'heading' | 'block' | 'url' | 'group' | 'graph';
	title?: string;
	path?: string;
	subpath?: string;
	query?: string;
	url?: string;
	items?: BookmarkItem[];
	ctime?: number;
}

const ICON: Record<string, string> = { file: 'file', folder: 'folder', search: 'search', heading: 'heading', block: 'box', url: 'globe', group: 'folder-closed', graph: 'git-fork' };

class BookmarksView extends ItemView {
	icon = 'bookmark';

	constructor(leaf: WorkspaceLeaf, private plugin: BookmarksPlugin) {
		super(leaf);
		this.headerEl.hide();
	}

	getViewType(): string { return 'bookmarks'; }
	getDisplayText(): string { return 'Bookmarks'; }

	onload(): void {
		this.registerEvent(this.plugin.events.on('changed', () => this.render()));
		this.render();
	}

	render(): void {
		this.contentEl.empty();
		const bar = this.contentEl.createDiv('nav-header').createDiv('nav-buttons-container');
		const add = bar.createDiv({ cls: 'clickable-icon nav-action-button', attr: { 'aria-label': 'New bookmark group' } });
		setIcon(add, 'folder-plus');
		add.addEventListener('click', async () => {
			const title = await promptText(this.app, 'New bookmark group', '', 'Create');
			if (title?.trim()) this.plugin.addItem({ type: 'group', title: title.trim(), items: [] });
		});
		if (!this.plugin.items.length) {
			this.contentEl.createDiv({ cls: 'pane-empty', text: 'No bookmarks yet. Use "Bookmark…" in a file\'s menu or the command palette.' });
			return;
		}
		this.renderItems(this.contentEl.createDiv('bookmarks-container'), this.plugin.items);
	}

	private renderItems(parent: HTMLElement, items: BookmarkItem[]): void {
		for (const item of items) {
			const el = parent.createDiv('tree-item');
			const self = el.createDiv('tree-item-self is-clickable bookmark');
			setIcon(self.createDiv('tree-item-icon'), ICON[item.type] ?? 'bookmark');
			self.createDiv({ cls: 'tree-item-inner', text: this.plugin.titleOf(item) });
			self.addEventListener('click', (e) => void this.plugin.openItem(item, e));
			self.addEventListener('contextmenu', (e) => {
				const menu = new Menu();
				if (item.type === 'group') menu.addItem((i) => i.setTitle('Rename group…').setIcon('pencil').onClick(async () => {
					const t = await promptText(this.app, 'Rename group', item.title ?? '');
					if (t?.trim()) {
						item.title = t.trim();
						this.plugin.save();
					}
				}));
				menu.addItem((i) => i.setTitle('Remove bookmark').setIcon('trash-2').setWarning(true).onClick(() => this.plugin.removeItem(item)));
				menu.showAtMouseEvent(e);
			});
			if (item.type === 'group') this.renderItems(el.createDiv('tree-item-children'), item.items ?? []);
		}
	}
}

export class BookmarksPlugin extends CorePlugin {
	id = 'bookmarks';
	name = 'Bookmarks';
	description = 'Bookmark files, folders, headings and searches.';
	items: BookmarkItem[] = [];
	/** 'changed' fires after any edit; the view re-renders on it. */
	events = new Events();

	onload(): void {
		this.registerView('bookmarks', (leaf) => new BookmarksView(leaf, this));
		void this.loadBookmarks();
		this.addCommand({ id: 'bookmarks:open', name: 'Bookmarks: Show bookmarks', callback: () => void this.app.workspace.ensureSideLeaf('bookmarks', 'left', { reveal: true }) });
		this.addCommand({ id: 'bookmarks:bookmark-current-view', name: 'Bookmarks: Bookmark…', hotkeys: [], checkCallback: (checking) => {
			const file = this.app.workspace.getActiveFile();
			if (!file) return false;
			if (!checking) this.addItem({ type: 'file', path: file.path });
			return true;
		} });
		this.registerEvent(this.app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => {
			const existing = this.findByPath(file.path);
			menu.addItem((i) => i.setTitle(existing ? 'Remove bookmark' : 'Bookmark…').setIcon('bookmark').setSection('action').onClick(() => {
				if (existing) this.removeItem(existing);
				else this.addItem({ type: file instanceof TFolder ? 'folder' : 'file', path: file.path });
			}));
		}));
		// Keep paths current when files move; drop bookmarks of deleted files.
		this.registerEvent(this.app.vault.on('rename', (f: TAbstractFile, old: string) => {
			let changed = false;
			this.walk((b) => {
				if (b.path === old) { b.path = f.path; changed = true; }
			});
			if (changed) this.save();
		}));
		this.app.workspace.onLayoutReady(() => void this.app.workspace.ensureSideLeaf('bookmarks', 'left'));
	}

	private async loadBookmarks(): Promise<void> {
		this.items = (await this.app.vault.readConfigJson('bookmarks'))?.items ?? [];
		this.events.trigger('changed');
	}

	save(): void {
		void this.app.vault.writeConfigJson('bookmarks', { items: this.items });
		this.events.trigger('changed');
	}

	addItem(item: BookmarkItem): void {
		this.items.push({ ...item, ctime: Date.now() });
		this.save();
	}

	removeItem(item: BookmarkItem): void {
		const strip = (list: BookmarkItem[]): BookmarkItem[] => list.filter((b) => b !== item).map((b) => (b.items ? { ...b, items: strip(b.items) } : b));
		this.items = strip(this.items);
		this.save();
	}

	findByPath(path: string): BookmarkItem | null {
		let found: BookmarkItem | null = null;
		this.walk((b) => { if (!found && (b.type === 'file' || b.type === 'folder') && b.path === path) found = b; });
		return found;
	}

	titleOf(b: BookmarkItem): string {
		if (b.title) return b.title;
		if (b.type === 'search') return b.query ?? '';
		if (b.type === 'url') return b.url ?? '';
		const name = (b.path ?? '').split('/').pop()!.replace(/\.md$/, '');
		return b.subpath ? `${name} › ${b.subpath.replace(/^#\^?/, '')}` : name;
	}

	async openItem(b: BookmarkItem, e: MouseEvent): Promise<void> {
		const app: App = this.app;
		switch (b.type) {
			case 'file':
			case 'heading':
			case 'block': {
				const file = app.vault.getFileByPath(b.path ?? '');
				if (file instanceof TFile) await app.workspace.getLeaf(Keymap.isModEvent(e)).openFile(file, { active: true, eState: b.subpath ? { subpath: b.subpath } : undefined });
				break;
			}
			case 'folder': {
				const folder = app.vault.getFolderByPath(b.path ?? '');
				const leaf = await app.workspace.ensureSideLeaf('file-explorer', 'left', { reveal: true });
				if (folder) (leaf.view as any).revealFile?.(folder);
				break;
			}
			case 'search':
				await (app.internalPlugins.getEnabledPluginById('global-search') as any)?.openGlobalSearch(b.query ?? '');
				break;
			case 'url':
				window.open(b.url, '_blank', 'noopener');
				break;
		}
	}

	private walk(fn: (b: BookmarkItem) => void, list = this.items): void {
		for (const b of list) {
			fn(b);
			if (b.items) this.walk(fn, b.items);
		}
	}
}
