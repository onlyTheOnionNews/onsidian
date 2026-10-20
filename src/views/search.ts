// Global search core plugin: sidebar view, command, `query` code blocks, and `openGlobalSearch` for plugins.
import type { App } from '../app';
import { CorePlugin } from '../coreplugins';
import { debounce } from '../events';
import { setIcon } from '../icons';
import { Keymap } from '../keymap';
import { MarkdownPreviewRenderer } from '../render';
import { searchVault, type FileResult, type SearchMatch } from '../search';
import type { TFile } from '../vault';
import { ItemView, type WorkspaceLeaf } from '../workspace';

/**
 * File title + matched lines with highlights, as in Obsidian's search/backlink panes.
 * Clicking a line opens the file there. Lines are capped so huge results stay responsive.
 */
export function renderFileResult(app: App, parent: HTMLElement, file: TFile, text: string, matches: SearchMatch[], collapsed = false): void {
	const item = parent.createDiv({ cls: ['tree-item', 'search-result', collapsed ? 'is-collapsed' : ''].filter(Boolean) });
	const title = item.createDiv('tree-item-self search-result-file-title is-clickable');
	const fold = title.createDiv('tree-item-icon collapse-icon');
	setIcon(fold, 'chevron-down');
	title.createDiv({ cls: 'tree-item-inner', text: file.extension === 'md' ? file.basename : file.name });
	if (matches.length) title.createDiv({ cls: 'tree-item-flair-outer' }).createSpan({ cls: 'tree-item-flair', text: String(matches.length) });
	const list = item.createDiv('search-result-file-matches');
	fold.addEventListener('click', (e) => {
		e.stopPropagation();
		item.toggleClass('is-collapsed', !item.hasClass('is-collapsed'));
	});
	title.addEventListener('click', (e) => void app.workspace.getLeaf(Keymap.isModEvent(e)).openFile(file));

	// Group matches by line.
	const byLine = new Map<number, SearchMatch[]>();
	for (const m of matches) {
		const lineStart = text.lastIndexOf('\n', m.from - 1) + 1;
		const group = byLine.get(lineStart) ?? [];
		group.push(m);
		byLine.set(lineStart, group);
	}
	let shown = 0;
	for (const [lineStart, ms] of byLine) {
		if (++shown > 50) {
			list.createDiv({ cls: 'search-result-more-text', text: `…and ${byLine.size - 50} more lines` });
			break;
		}
		const lineEnd = text.indexOf('\n', lineStart);
		const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
		const row = list.createDiv('search-result-file-match tappable');
		// Trim long lines around the first match.
		const first = ms[0].from - lineStart;
		const from = Math.max(0, first - 60);
		const to = Math.min(line.length, first + 140);
		let pos = from;
		if (from > 0) row.appendText('…');
		for (const m of ms) {
			const s = Math.max(m.from - lineStart, pos);
			const e = Math.min(m.to - lineStart, to);
			if (s >= to || e <= s) continue;
			row.appendText(line.slice(pos, s));
			row.createSpan({ cls: 'search-result-file-matched-text', text: line.slice(s, e) });
			pos = e;
		}
		row.appendText(line.slice(pos, to) + (to < line.length ? '…' : ''));
		const lineNo = text.slice(0, lineStart).split('\n').length - 1;
		row.addEventListener('click', (e) => void app.workspace.getLeaf(Keymap.isModEvent(e)).openFile(file, { active: true, eState: { line: lineNo } }));
	}
}

export class SearchView extends ItemView {
	icon = 'search';
	private inputEl: HTMLInputElement;
	private summaryEl: HTMLElement;
	private resultsEl: HTMLElement;
	private caseSensitive = false;
	private sort: 'alphabetical' | 'modified' = 'alphabetical';
	private run = { cancelled: false };

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.headerEl.hide();
		const box = this.contentEl.createDiv('search-row').createDiv('search-input-container');
		this.inputEl = box.createEl('input', { type: 'search', placeholder: 'Search…', attr: { spellcheck: 'false' } });
		const matchCase = box.createDiv({ cls: 'input-right-decorator clickable-icon', attr: { 'aria-label': 'Match case' } });
		setIcon(matchCase, 'case-sensitive');
		matchCase.addEventListener('click', () => {
			this.caseSensitive = !this.caseSensitive;
			matchCase.toggleClass('is-active', this.caseSensitive);
			void this.search();
		});
		const params = this.contentEl.createDiv('search-params');
		const sort = params.createEl('select', { cls: 'dropdown' });
		sort.createEl('option', { value: 'alphabetical', text: 'File name (A to Z)' });
		sort.createEl('option', { value: 'modified', text: 'Modified time (new to old)' });
		sort.addEventListener('change', () => {
			this.sort = sort.value as typeof this.sort;
			void this.search();
		});
		this.summaryEl = this.contentEl.createDiv('search-result-info');
		this.resultsEl = this.contentEl.createDiv('search-result-container');
		this.inputEl.addEventListener('input', () => this.debounced());
		this.inputEl.addEventListener('keydown', (e) => e.key === 'Enter' && void this.search());
	}

	private debounced = debounce(() => void this.search(), 300, true);

	getViewType(): string { return 'search'; }
	getDisplayText(): string { return 'Search'; }
	getState(): Record<string, unknown> { return { query: this.inputEl.value, matchingCase: this.caseSensitive }; }
	async setState(state: any): Promise<void> {
		if (typeof state?.query === 'string') this.setQuery(state.query);
	}

	onload(): void {
		this.registerEvent(this.app.vault.on('modify', () => this.inputEl.value && this.debounced()));
	}

	setQuery(q: string): void {
		this.inputEl.value = q;
		void this.search();
	}

	focus(): void {
		this.inputEl.focus();
		this.inputEl.select();
	}

	private async search(): Promise<void> {
		this.run.cancelled = true;
		const run = (this.run = { cancelled: false });
		const q = this.inputEl.value.trim();
		this.resultsEl.empty();
		this.summaryEl.setText('');
		if (!q) return;
		const results = await searchVault(this.app, q, { caseSensitive: this.caseSensitive, signal: run });
		if (run.cancelled) return;
		results.sort(this.sort === 'modified'
			? (a, b) => b.file.stat.mtime - a.file.stat.mtime
			: (a, b) => a.file.basename.localeCompare(b.file.basename, undefined, { numeric: true }));
		this.summaryEl.setText(`${results.length} result${results.length === 1 ? '' : 's'}`);
		for (const r of results) renderFileResult(this.app, this.resultsEl, r.file, await this.app.vault.cachedRead(r.file), r.matches);
	}
}

export class GlobalSearchPlugin extends CorePlugin {
	id = 'global-search';
	name = 'Search';
	description = 'Search the vault with operators like file:, tag:, line:, [property:value].';

	onload(): void {
		this.registerView('search', (leaf) => new SearchView(leaf));
		this.addCommand({ id: 'global-search:open', name: 'Search: Search in all files', icon: 'search', hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'F' }], callback: () => void this.openGlobalSearch('') });
		void this.app.workspace.onLayoutReady(() => this.app.workspace.ensureSideLeaf('search', 'left', { reveal: false }));
		// ```query``` blocks render live results inside notes.
		MarkdownPreviewRenderer.registerCodeBlockPostProcessor('query', async (source, el) => {
			el.addClass('internal-query');
			const results: FileResult[] = await searchVault(this.app, source.trim());
			el.createDiv({ cls: 'internal-query-header', text: `${results.length} result${results.length === 1 ? '' : 's'} for "${source.trim()}"` });
			for (const r of results.slice(0, 100)) renderFileResult(this.app, el, r.file, await this.app.vault.cachedRead(r.file), r.matches, true);
		});
		this.register(() => MarkdownPreviewRenderer.unregisterCodeBlockPostProcessor('query'));
	}

	/** Public: plugins call app.internalPlugins.getPluginById('global-search').instance.openGlobalSearch(q). */
	async openGlobalSearch(query: string): Promise<void> {
		const leaf = await this.app.workspace.ensureSideLeaf('search', 'left', { reveal: true });
		const view = leaf.view as SearchView;
		if (query) view.setQuery(query);
		view.focus();
	}
}
