// Sidebar core plugins that follow the active note: backlinks, outgoing links, outline, tags; plus word count
// and page preview (hover popovers).
import type { App } from '../app';
import { CorePlugin } from '../coreplugins';
import { debounce } from '../events';
import { setIcon } from '../icons';
import { Keymap } from '../keymap';
import { getAllTags, parseLinktext } from '../parse';
import { MarkdownRenderer } from '../render';
import { searchVault, type SearchMatch } from '../search';
import type { TFile } from '../vault';
import { ItemView, type FileView, type WorkspaceLeaf } from '../workspace';
import { renderFileResult } from './search';

/** Re-renders (debounced) when the active note or the metadata changes. */
abstract class ActiveFileView extends ItemView {
	file: TFile | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.headerEl.hide();
	}

	onload(): void {
		this.registerEvent(this.app.workspace.on('file-open', () => this.refresh()));
		this.registerEvent(this.app.metadataCache.on('resolved', () => this.refresh()));
		this.registerEvent(this.app.metadataCache.on('changed', () => this.refresh()));
		this.refresh();
	}

	protected refresh = debounce(() => {
		this.file = this.app.workspace.getActiveFile();
		void this.render();
	}, 200);

	protected abstract render(): Promise<void> | void;

	protected showEmpty(text: string): void {
		this.contentEl.empty();
		this.contentEl.createDiv({ cls: 'pane-empty', text });
	}
}

function section(parent: HTMLElement, title: string, count: number | null, collapsed = false): HTMLElement {
	const wrap = parent.createDiv({ cls: ['tree-item', 'backlink-pane-section', collapsed ? 'is-collapsed' : ''].filter(Boolean) });
	const head = wrap.createDiv('tree-item-self is-clickable tree-item-section-header');
	setIcon(head.createDiv('tree-item-icon collapse-icon'), 'chevron-down');
	head.createDiv({ cls: 'tree-item-inner', text: title });
	if (count !== null) head.createDiv('tree-item-flair-outer').createSpan({ cls: 'tree-item-flair', text: String(count) });
	const body = wrap.createDiv('search-result-container');
	head.addEventListener('click', () => {
		wrap.toggleClass('is-collapsed', !wrap.hasClass('is-collapsed'));
		wrap.dispatchEvent(new CustomEvent('section-toggle'));
	});
	return body;
}

// ---------------- Backlinks ----------------

class BacklinksView extends ActiveFileView {
	icon = 'links-coming-in';
	getViewType(): string { return 'backlink'; }
	getDisplayText(): string { return 'Backlinks'; }

	protected async render(): Promise<void> {
		const { app, file } = this;
		if (!file) return this.showEmpty('No file is open.');
		this.contentEl.empty();
		const sources = Object.entries(app.metadataCache.resolvedLinks).filter(([src, t]) => src !== file.path && t[file.path]).map(([src]) => src).sort();
		const linked = section(this.contentEl, 'Linked mentions', sources.length);
		for (const src of sources) {
			const srcFile = app.vault.getFileByPath(src);
			const cache = app.metadataCache.getCache(src);
			if (!srcFile || !cache) continue;
			const matches: SearchMatch[] = [...(cache.links ?? []), ...(cache.embeds ?? [])]
				.filter((l) => app.metadataCache.getFirstLinkpathDest(parseLinktext(l.link).path, src) === file)
				.map((l) => ({ from: l.position.start.offset, to: l.position.end.offset }));
			renderFileResult(app, linked, srcFile, await app.vault.cachedRead(srcFile), matches);
		}
		if (!sources.length) linked.createDiv({ cls: 'search-empty-state', text: 'No backlinks found.' });

		// Unlinked mentions are a full-text search, so they're computed only when expanded (as in Obsidian).
		const unlinked = section(this.contentEl, 'Unlinked mentions', null, true);
		const wrap = unlinked.parentElement!;
		wrap.addEventListener('section-toggle', async () => {
			if (wrap.hasClass('is-collapsed') || unlinked.childElementCount) return;
			const linkedSet = new Set(sources);
			const results = (await searchVault(app, `"${file.basename.replace(/"/g, '')}"`))
				.filter((r) => r.file !== file && r.file.extension === 'md' && !linkedSet.has(r.file.path) && r.matches.length);
			for (const r of results) renderFileResult(app, unlinked, r.file, await app.vault.cachedRead(r.file), r.matches);
			if (!results.length) unlinked.createDiv({ cls: 'search-empty-state', text: 'No unlinked mentions found.' });
		});
	}
}

// ---------------- Outgoing links ----------------

class OutgoingLinksView extends ActiveFileView {
	icon = 'links-going-out';
	getViewType(): string { return 'outgoing-link'; }
	getDisplayText(): string { return 'Outgoing links'; }

	protected render(): void {
		const { app, file } = this;
		if (!file) return this.showEmpty('No file is open.');
		this.contentEl.empty();
		const cache = app.metadataCache.getFileCache(file);
		const refs = [...(cache?.links ?? []), ...(cache?.embeds ?? []), ...(cache?.frontmatterLinks ?? [])];
		const resolved = new Map<string, TFile>();
		const unresolved = new Set<string>();
		for (const r of refs) {
			const path = parseLinktext(r.link).path;
			if (!path) continue;
			const dest = app.metadataCache.getFirstLinkpathDest(path, file.path);
			if (dest) resolved.set(dest.path, dest);
			else unresolved.add(path);
		}
		const linksEl = section(this.contentEl, 'Links', resolved.size);
		for (const dest of resolved.values()) this.item(linksEl, dest.basename, dest.path, file.path);
		const unresEl = section(this.contentEl, 'Unresolved links', unresolved.size);
		for (const p of unresolved) this.item(unresEl, p, p, file.path, true);
	}

	private item(parent: HTMLElement, text: string, link: string, source: string, unresolved = false): void {
		const el = parent.createDiv('tree-item search-result').createDiv({ cls: ['tree-item-self', 'is-clickable', unresolved ? 'is-unresolved' : ''].filter(Boolean) });
		el.createDiv({ cls: 'tree-item-inner', text });
		el.addEventListener('click', (e) => void this.app.workspace.openLinkText(link, source, Keymap.isModEvent(e)));
	}
}

// ---------------- Outline ----------------

class OutlineView extends ActiveFileView {
	icon = 'list';
	getViewType(): string { return 'outline'; }
	getDisplayText(): string { return 'Outline'; }

	protected render(): void {
		const { app, file } = this;
		const headings = file ? app.metadataCache.getFileCache(file)?.headings ?? [] : [];
		if (!headings.length) return this.showEmpty(file ? 'No headings found.' : 'No file is open.');
		this.contentEl.empty();
		const root = this.contentEl.createDiv('outline-view');
		const stack: { level: number; el: HTMLElement }[] = [{ level: 0, el: root }];
		for (const h of headings) {
			while (stack[stack.length - 1].level >= h.level) stack.pop();
			const item = stack[stack.length - 1].el.createDiv('tree-item');
			const self = item.createDiv({ cls: 'tree-item-self is-clickable', attr: { 'data-level': String(h.level) } });
			self.createDiv({ cls: 'tree-item-inner', text: h.heading });
			self.addEventListener('click', () => this.jump(h.position.start.line));
			stack.push({ level: h.level, el: item.createDiv('tree-item-children') });
		}
	}

	private jump(line: number): void {
		const leaf = this.app.workspace.getMostRecentLeaf();
		if ((leaf?.view as FileView | undefined)?.file !== this.file) return;
		leaf!.view.setEphemeralState({ line });
		this.app.workspace.setActiveLeaf(leaf!, { focus: true });
	}
}

// ---------------- Tags ----------------

class TagsView extends ItemView {
	icon = 'tags';
	private sortByCount = false;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.headerEl.hide();
	}

	getViewType(): string { return 'tag'; }
	getDisplayText(): string { return 'Tags'; }

	onload(): void {
		const r = debounce(() => this.render(), 300);
		this.registerEvent(this.app.metadataCache.on('resolved', r));
		this.registerEvent(this.app.metadataCache.on('changed', r));
		this.render();
	}

	private render(): void {
		const counts = new Map<string, number>();
		for (const f of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(f);
			for (const t of new Set(cache ? getAllTags(cache) ?? [] : [])) {
				// "#a/b" also counts toward its parent "#a".
				const parts = t.slice(1).split('/');
				for (let i = 1; i <= parts.length; i++) {
					const key = '#' + parts.slice(0, i).join('/');
					counts.set(key, (counts.get(key) ?? 0) + 1);
				}
			}
		}
		this.contentEl.empty();
		const bar = this.contentEl.createDiv('nav-header').createDiv('nav-buttons-container');
		const sortBtn = bar.createDiv({ cls: 'clickable-icon nav-action-button', attr: { 'aria-label': this.sortByCount ? 'Sort by name' : 'Sort by frequency' } });
		setIcon(sortBtn, this.sortByCount ? 'arrow-down-a-z' : 'arrow-down-wide-narrow');
		sortBtn.addEventListener('click', () => {
			this.sortByCount = !this.sortByCount;
			this.render();
		});
		if (!counts.size) {
			this.contentEl.createDiv({ cls: 'pane-empty', text: 'No tags found.' });
			return;
		}
		const list = this.contentEl.createDiv('tag-container');
		const render = (parent: HTMLElement, prefix: string) => {
			const children = [...counts.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/') && k !== prefix.slice(0, -1));
			children.sort(this.sortByCount ? (a, b) => counts.get(b)! - counts.get(a)! : (a, b) => a.localeCompare(b));
			for (const tag of children) {
				const item = parent.createDiv('tree-item');
				const self = item.createDiv('tree-item-self tag-pane-tag is-clickable');
				self.createDiv({ cls: 'tree-item-inner tag-pane-tag-text', text: tag.slice(prefix === '#' ? 1 : prefix.length) });
				self.createDiv('tree-item-flair-outer').createSpan({ cls: 'tree-item-flair', text: String(counts.get(tag)) });
				self.addEventListener('click', () => void openSearch(this.app, `tag:${tag}`));
				render(item.createDiv('tree-item-children'), tag + '/');
			}
		};
		render(list, '#');
	}
}

function openSearch(app: App, query: string): Promise<void> | undefined {
	return (app.internalPlugins.getEnabledPluginById('global-search') as any)?.openGlobalSearch(query);
}

// ---------------- Plugins ----------------

export class BacklinkPlugin extends CorePlugin {
	id = 'backlink';
	name = 'Backlinks';
	description = 'Show notes that link to the active note.';
	onload(): void {
		this.registerView('backlink', (leaf) => new BacklinksView(leaf));
		this.addCommand({ id: 'backlink:open', name: 'Backlinks: Show backlinks', callback: () => void this.app.workspace.ensureSideLeaf('backlink', 'right', { reveal: true }) });
		this.app.workspace.onLayoutReady(() => void this.app.workspace.ensureSideLeaf('backlink', 'right'));
	}
}

export class OutgoingLinkPlugin extends CorePlugin {
	id = 'outgoing-link';
	name = 'Outgoing links';
	description = 'Show links in the active note.';
	onload(): void {
		this.registerView('outgoing-link', (leaf) => new OutgoingLinksView(leaf));
		this.addCommand({ id: 'outgoing-links:open', name: 'Outgoing links: Show outgoing links', callback: () => void this.app.workspace.ensureSideLeaf('outgoing-link', 'right', { reveal: true }) });
		this.app.workspace.onLayoutReady(() => void this.app.workspace.ensureSideLeaf('outgoing-link', 'right'));
	}
}

export class OutlinePlugin extends CorePlugin {
	id = 'outline';
	name = 'Outline';
	description = 'Show the headings of the active note.';
	onload(): void {
		this.registerView('outline', (leaf) => new OutlineView(leaf));
		this.addCommand({ id: 'outline:open', name: 'Outline: Show outline', callback: () => void this.app.workspace.ensureSideLeaf('outline', 'right', { reveal: true }) });
		this.app.workspace.onLayoutReady(() => void this.app.workspace.ensureSideLeaf('outline', 'right'));
	}
}

export class TagPanePlugin extends CorePlugin {
	id = 'tag-pane';
	name = 'Tags view';
	description = 'List all tags with counts.';
	onload(): void {
		this.registerView('tag', (leaf) => new TagsView(leaf));
		this.addCommand({ id: 'tag-pane:open', name: 'Tags view: Show tags', callback: () => void this.app.workspace.ensureSideLeaf('tag', 'right', { reveal: true }) });
		this.app.workspace.onLayoutReady(() => void this.app.workspace.ensureSideLeaf('tag', 'right'));
	}
}

export class WordCountPlugin extends CorePlugin {
	id = 'word-count';
	name = 'Word count';
	description = 'Show word and character counts in the status bar.';
	onload(): void {
		const el = this.addStatusBarItem();
		const update = debounce(() => {
			const editor = this.app.workspace.activeEditor?.editor;
			const text: string = editor ? (editor.somethingSelected() ? editor.getSelection() : editor.getValue()) : '';
			el.setText(editor ? `${countWords(text)} words  ${text.length} characters` : '');
		}, 300);
		this.registerEvent(this.app.workspace.on('editor-change', update));
		this.registerEvent(this.app.workspace.on('active-leaf-change', update));
		this.registerDomEvent(document, 'selectionchange', update);
		update();
	}
}

/** Word segmentation that handles CJK (Intl.Segmenter), with a whitespace fallback. */
export function countWords(text: string): number {
	const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
	if (typeof Intl.Segmenter === 'function') {
		let n = 0;
		for (const s of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(body)) if (s.isWordLike) n++;
		return n;
	}
	return body.split(/\s+/).filter(Boolean).length;
}

/**
 * Page preview: hovering an internal link shows the note in a popover. In the editor it needs Mod held (Obsidian's
 * default). Listens to the public 'hover-link' workspace event, so plugins can trigger previews too.
 */
export class PagePreviewPlugin extends CorePlugin {
	id = 'page-preview';
	name = 'Page preview';
	description = 'Preview notes by hovering over internal links.';
	private popover: HTMLElement | null = null;
	private hideTimer = 0;

	onload(): void {
		let showTimer = 0;
		this.registerDomEvent(document, 'mouseover', (e: MouseEvent) => {
			const a = (e.target as HTMLElement).closest('.internal-link, .cm-hmd-internal-link') as HTMLElement | null;
			if (!a || this.popover?.contains(a)) return;
			const inEditor = !!a.closest('.cm-content');
			if (inEditor && !Keymap.isModifier(e, 'Mod')) return;
			const linktext = a.dataset.href ?? a.getAttr('href') ?? '';
			const sourcePath = this.app.workspace.getActiveFile()?.path ?? '';
			clearTimeout(showTimer);
			showTimer = window.setTimeout(() => this.app.workspace.trigger('hover-link', { event: e, source: inEditor ? 'editor' : 'preview', hoverParent: null, targetEl: a, linktext, sourcePath }), 300);
			a.addEventListener('mouseleave', () => clearTimeout(showTimer), { once: true });
		});
		this.registerEvent(this.app.workspace.on('hover-link', (info: { targetEl: HTMLElement; linktext: string; sourcePath: string }) => void this.show(info)));
		this.register(() => this.hide());
	}

	private async show({ targetEl, linktext, sourcePath }: { targetEl: HTMLElement; linktext: string; sourcePath: string }): Promise<void> {
		const { path, subpath } = parseLinktext(linktext);
		const file = this.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
		if (!file || file.extension !== 'md') return;
		this.hide();
		const pop = (this.popover = document.body.createDiv('popover hover-popover'));
		const content = pop.createDiv('markdown-embed markdown-rendered').createDiv('markdown-embed-content markdown-preview-view');
		const r = targetEl.getBoundingClientRect();
		pop.style.left = `${Math.min(r.left, window.innerWidth - 470)}px`;
		pop.style.top = r.bottom + 400 > window.innerHeight ? `${Math.max(8, r.top - 408)}px` : `${r.bottom + 6}px`;
		const embed = `![[${file.path}${subpath}]]`;
		await MarkdownRenderer.render(this.app, embed, content, sourcePath, this);
		const leave = () => { this.hideTimer = window.setTimeout(() => this.hide(), 300); };
		const enter = () => clearTimeout(this.hideTimer);
		targetEl.addEventListener('mouseleave', leave, { once: true });
		pop.addEventListener('mouseleave', leave);
		pop.addEventListener('mouseenter', enter);
	}

	private hide(): void {
		this.popover?.detach();
		this.popover = null;
	}
}
