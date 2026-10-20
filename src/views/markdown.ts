// MarkdownView: CM6 source mode + markdown-it reading mode (PLAN §5.2). Live Preview and the `Editor` API are phase 2.
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
import { setIcon } from '../icons';
import type { TAbstractFile } from '../vault';
import { TextFileView, type WorkspaceLeaf } from '../workspace';

// Obsidian's source-mode class names, so themes styling `.cm-header-1`, `.cm-strong`… work unchanged.
const obsidianClasses = HighlightStyle.define([
	...[t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6].map((tag, i) => ({ tag, class: `cm-header cm-header-${i + 1}` })),
	{ tag: t.strong, class: 'cm-strong' },
	{ tag: t.emphasis, class: 'cm-em' },
	{ tag: t.strikethrough, class: 'cm-strikethrough' },
	{ tag: t.link, class: 'cm-link' },
	{ tag: t.url, class: 'cm-url' },
	{ tag: t.monospace, class: 'cm-inline-code' },
	{ tag: t.quote, class: 'cm-quote' },
	{ tag: t.list, class: 'cm-list' },
	{ tag: t.processingInstruction, class: 'cm-formatting' },
	{ tag: t.contentSeparator, class: 'cm-hr' },
]);

export type MarkdownViewMode = 'source' | 'preview';

export class MarkdownView extends TextFileView {
	icon = 'file-text';
	mode: MarkdownViewMode = 'source';
	editor: EditorView;
	private sourceEl: HTMLElement;
	private previewEl: HTMLElement;
	private previewSizerEl: HTMLElement;
	private modeButton: HTMLElement;
	private dirty = false;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.contentEl.addClass('markdown-view-content');
		this.sourceEl = this.contentEl.createDiv('markdown-source-view cm-s-obsidian mod-cm6 is-readable-line-width');
		this.previewEl = this.contentEl.createDiv('markdown-reading-view').createDiv('markdown-preview-view markdown-rendered is-readable-line-width');
		this.previewSizerEl = this.previewEl.createDiv('markdown-preview-sizer markdown-preview-section');
		this.editor = new EditorView({ parent: this.sourceEl, state: this.makeState('') });
		this.modeButton = this.addAction('book-open', 'Switch to reading view', () => this.setMode(this.mode === 'source' ? 'preview' : 'source'));
		this.previewEl.addEventListener('click', (e) => this.onPreviewClick(e));
		this.applyMode();
	}

	getViewType(): string {
		return 'markdown';
	}

	onload(): void {
		this.registerEvent(this.app.vault.on('modify', (f: TAbstractFile) => f === this.file && void this.onExternalModify()));
		this.registerEvent(this.app.vault.on('rename', (f: TAbstractFile) => f === this.file && this.updateHeader()));
		this.registerEvent(this.app.vault.on('delete', (f: TAbstractFile) => {
			if (f !== this.file) return;
			this.requestSave.cancel();
			this.file = null;
			void this.leaf.setViewState({ type: 'empty' });
		}));
	}

	onunload(): void {
		this.editor.destroy();
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), mode: this.mode, source: this.mode === 'source' };
	}

	async setState(state: any, result: { history: boolean }): Promise<void> {
		await super.setState(state, result);
		if (state?.mode === 'source' || state?.mode === 'preview') this.setMode(state.mode);
	}

	getViewData(): string {
		return this.editor.state.doc.toString();
	}

	setViewData(data: string, clear: boolean): void {
		this.data = data;
		if (clear) this.editor.setState(this.makeState(data));
		else this.editor.dispatch({ changes: { from: 0, to: this.editor.state.doc.length, insert: data } });
		this.dirty = false;
		if (this.mode === 'preview') this.renderPreview();
	}

	clear(): void {
		this.editor.setState(this.makeState(''));
		this.previewSizerEl.empty();
	}

	async save(clear?: boolean): Promise<void> {
		await super.save(clear);
		this.dirty = false;
	}

	setMode(mode: MarkdownViewMode): void {
		if (mode === this.mode) return;
		this.mode = mode;
		this.applyMode();
		this.app.workspace.onLeafStateChanged(this.leaf);
	}

	private applyMode(): void {
		const reading = this.mode === 'preview';
		if (reading) this.renderPreview();
		this.sourceEl.toggle(!reading);
		(this.previewEl.parentElement as HTMLElement).toggle(reading);
		this.contentEl.toggleClass('is-reading', reading);
		setIcon(this.modeButton, reading ? 'pencil' : 'book-open');
		this.modeButton.setAttr('aria-label', reading ? 'Switch to editing view' : 'Switch to reading view');
	}

	private makeState(doc: string): EditorState {
		return EditorState.create({
			doc,
			extensions: [
				history(),
				keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
				markdown(),
				syntaxHighlighting(obsidianClasses),
				EditorView.lineWrapping,
				EditorView.contentAttributes.of({ spellcheck: 'true' }),
				EditorView.updateListener.of((u) => {
					if (!u.docChanged) return;
					this.dirty = true;
					this.requestSave();
				}),
			],
		});
	}

	/**
	 * Another writer changed the file (rescan of an FsAccess folder, a plugin, another view).
	 * ponytail: unsaved local edits win and the next save overwrites; a 3-way merge comes with Relay/sync work (phase 5).
	 */
	private async onExternalModify(): Promise<void> {
		if (!this.file || this.dirty) return;
		const data = await this.app.vault.cachedRead(this.file);
		if (data !== this.getViewData()) this.setViewData(data, false);
	}

	private renderPreview(): void {
		const src = this.getViewData();
		const fm = this.file && this.app.metadataCache.getFileCache(this.file)?.frontmatterPosition;
		// Properties UI is phase 2; until then reading view hides the YAML block like Obsidian does.
		const body = fm ? src.slice(fm.end.offset) : src.replace(/^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/, '');
		const html = md.render(body, { resolve: (link: string) => !!this.app.metadataCache.getFirstLinkpathDest(link.split('#')[0], this.file?.path ?? '') || !link.split('#')[0] });
		this.previewSizerEl.empty();
		this.previewSizerEl.appendChild(DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true, ADD_ATTR: ['target'] }));
	}

	private onPreviewClick(e: MouseEvent): void {
		const a = (e.target as HTMLElement).closest('a');
		if (!a) return;
		if (a.hasClass('internal-link')) {
			e.preventDefault();
			void this.app.workspace.openLinkText(a.getAttr('data-href') ?? '', this.file?.path ?? '', e.ctrlKey || e.metaKey ? 'tab' : false);
		} else if (a.hasClass('tag')) {
			e.preventDefault(); // tag search arrives with the search plugin (phase 2)
		}
	}
}

// ---------- markdown-it with Obsidian syntax ----------

const md = new MarkdownIt({ html: true, linkify: true, breaks: false });

// [[link]], [[link|alias]], ![[embed]] → internal links (embeds render as links until phase 2).
md.inline.ruler.before('link', 'wikilink', (state, silent) => {
	const src = state.src;
	let pos = state.pos;
	const embed = src.startsWith('![[', pos);
	if (!embed && !src.startsWith('[[', pos)) return false;
	const start = pos + (embed ? 3 : 2);
	const end = src.indexOf(']]', start);
	if (end < 0 || src.slice(start, end).includes('\n')) return false;
	if (!silent) {
		const inner = src.slice(start, end);
		const bar = inner.indexOf('|');
		const link = (bar < 0 ? inner : inner.slice(0, bar)).trim();
		const tok = state.push('wikilink', '', 0);
		tok.meta = { link, display: bar < 0 ? link : inner.slice(bar + 1), embed };
	}
	state.pos = end + 2;
	return true;
});
md.renderer.rules.wikilink = (tokens, i, _opts, env) => {
	const { link, display } = tokens[i].meta as { link: string; display: string };
	const resolve = (env as { resolve?: (link: string) => boolean } | undefined)?.resolve;
	const unresolved = resolve && !resolve(link) ? ' is-unresolved' : '';
	const esc = md.utils.escapeHtml;
	return `<a data-href="${esc(link)}" href="${esc(link)}" class="internal-link${unresolved}" target="_blank" rel="noopener nofollow">${esc(display)}</a>`;
};

// #tag (same character rules as the indexer).
md.inline.ruler.after('wikilink', 'tag', (state, silent) => {
	if (state.src[state.pos] !== '#' || (state.pos > 0 && !/\s/.test(state.src[state.pos - 1]))) return false;
	const m = /^#([\p{L}\p{N}\p{M}_\/-]+)/u.exec(state.src.slice(state.pos));
	if (!m || /^\d+$/.test(m[1])) return false;
	if (!silent) state.push('tag', '', 0).content = m[0];
	state.pos += m[0].length;
	return true;
});
md.renderer.rules.tag = (tokens, i) => {
	const tag = md.utils.escapeHtml(tokens[i].content);
	return `<a href="${tag}" class="tag" target="_blank" rel="noopener nofollow">${tag}</a>`;
};

// Markdown links: external → new tab; relative → internal link to a vault file.
md.renderer.rules.link_open = (tokens, i, opts, _env, self) => {
	const tok = tokens[i];
	const href = String(tok.attrGet('href') ?? '');
	if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
		tok.attrJoin('class', 'external-link');
		tok.attrSet('target', '_blank');
		tok.attrSet('rel', 'noopener nofollow');
	} else {
		let target = href;
		try { target = decodeURIComponent(href); } catch {}
		tok.attrJoin('class', 'internal-link');
		tok.attrSet('data-href', target);
	}
	return self.renderToken(tokens, i, opts);
};
