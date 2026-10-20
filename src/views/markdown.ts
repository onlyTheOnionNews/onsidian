// MarkdownView (PLAN §5.2): editing view = CM6 with Live Preview (or plain source), reading view = shared renderer.
import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { yamlFrontmatter } from '@codemirror/lang-yaml';
import { foldGutter, foldKeymap, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { Editor } from '../editor';
import { setIcon } from '../icons';
import { livePreview } from '../livepreview';
import { parseFrontmatterYaml, renderProperties } from '../properties';
import { MarkdownRenderer } from '../render';
import type { TAbstractFile, TFile } from '../vault';
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
	{ tag: t.meta, class: 'cm-meta' },
	// Code inside fenced blocks, themed with --code-* variables.
	{ tag: t.comment, class: 'cm-comment' },
	{ tag: [t.keyword, t.controlKeyword, t.moduleKeyword], class: 'cm-keyword' },
	{ tag: [t.string, t.special(t.string)], class: 'cm-string' },
	{ tag: [t.number, t.bool, t.null, t.atom], class: 'cm-number' },
	{ tag: [t.function(t.variableName), t.function(t.propertyName)], class: 'cm-def' },
	{ tag: [t.propertyName, t.attributeName], class: 'cm-property' },
	{ tag: t.operator, class: 'cm-operator' },
	{ tag: [t.typeName, t.className, t.tagName], class: 'cm-tag' },
]);

export type MarkdownViewMode = 'source' | 'preview';

export class MarkdownView extends TextFileView {
	icon = 'file-text';
	mode: MarkdownViewMode;
	/** Live Preview (true) vs plain source (false) for the editing view. */
	livePreview: boolean;
	/** The API's Editor; the raw CM6 view is `editor.cm` (as in Obsidian). */
	editor: Editor;
	cm: EditorView;
	/** Reading view handle (Relay patches previewMode.render). */
	previewMode: { containerEl: HTMLElement; render: () => Promise<void> };
	private sourceEl: HTMLElement;
	private previewEl: HTMLElement;
	private previewSizerEl: HTMLElement;
	private modeButton: HTMLElement;
	private dirty = false;
	private renderToken = 0;
	/** Settles when the latest reading-view render finished (scrolling to a heading waits for it). */
	private rendered: Promise<void> = Promise.resolve();
	private options = new Compartment();
	private lp = new Compartment();

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.mode = this.app.vault.getConfig('defaultViewMode') === 'preview' ? 'preview' : 'source';
		this.livePreview = !!this.app.vault.getConfig('livePreview');
		this.contentEl.addClass('markdown-view-content');
		this.sourceEl = this.contentEl.createDiv('markdown-source-view cm-s-obsidian mod-cm6');
		this.previewEl = this.contentEl.createDiv('markdown-reading-view').createDiv('markdown-preview-view markdown-rendered');
		this.previewSizerEl = this.previewEl.createDiv('markdown-preview-sizer markdown-preview-section');
		this.previewMode = { containerEl: this.previewEl, render: () => this.renderPreview() };
		this.cm = new EditorView({ parent: this.sourceEl, state: this.makeState('') });
		this.editor = new Editor(this.cm);
		this.modeButton = this.addAction('book-open', 'Switch to reading view', () => this.setMode(this.mode === 'source' ? 'preview' : 'source'));
		this.previewEl.addEventListener('click', (e) => this.onPreviewClick(e));
		this.applyOptions();
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
		this.registerEvent(this.app.vault.on('config-changed', (key: string) => {
			this.applyOptions();
			if (key === 'livePreview') this.setLivePreview(!!this.app.vault.getConfig('livePreview'));
			if (this.mode === 'preview') void this.renderPreview();
		}));
		// Link targets appearing/disappearing changes how links render (resolved vs unresolved).
		this.registerEvent(this.app.metadataCache.on('resolved', () => this.mode === 'preview' && !this.dirty && void this.renderPreview()));
	}

	onunload(): void {
		this.cm.destroy();
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), mode: this.mode, source: !this.livePreview };
	}

	async setState(state: any, result: { history: boolean }): Promise<void> {
		await super.setState(state, result);
		if (typeof state?.source === 'boolean') this.setLivePreview(!state.source);
		if (state?.mode === 'source' || state?.mode === 'preview') this.setMode(state.mode);
	}

	getEphemeralState(): Record<string, unknown> {
		return { cursor: this.editor.getCursor(), scroll: this.mode === 'source' ? this.cm.scrollDOM.scrollTop : this.previewEl.scrollTop };
	}

	/** `{subpath: '#Heading' | '#^block'}` or `{line}` scrolls there (used when following links). */
	setEphemeralState(state: any): void {
		if (!state || !this.file) return;
		const sub = String(state.subpath ?? '');
		const headingKey = sub.slice(1).split('#').pop()!.trim().toLowerCase();
		let line: number | undefined = state.line;
		if (sub) {
			const cache = this.app.metadataCache.getFileCache(this.file);
			line = sub.startsWith('#^')
				? cache?.blocks?.[sub.slice(2)]?.position.start.line
				: cache?.headings?.find((h) => h.heading.trim().toLowerCase() === headingKey)?.position.start.line;
		}
		if (line === undefined) return;
		if (this.mode === 'source') {
			this.editor.setCursor({ line, ch: 0 });
			this.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
			return;
		}
		void this.rendered.then(() => {
			const target = sub.startsWith('#^')
				? this.previewEl.querySelector(`[data-block-id="${CSS.escape(sub.slice(2))}"]`)
				: [...this.previewEl.querySelectorAll<HTMLElement>('[data-heading]')].find((h) => h.dataset.heading?.trim().toLowerCase() === headingKey);
			target?.scrollIntoView({ block: 'start' });
		});
	}

	getViewData(): string {
		return this.cm.state.doc.toString();
	}

	setViewData(data: string, clear: boolean): void {
		this.data = data;
		if (clear) this.cm.setState(this.makeState(data));
		else this.cm.dispatch({ changes: { from: 0, to: this.cm.state.doc.length, insert: data } });
		this.dirty = false;
		if (this.mode === 'preview') void this.renderPreview();
	}

	clear(): void {
		this.cm.setState(this.makeState(''));
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

	setLivePreview(on: boolean): void {
		if (on === this.livePreview) return;
		this.livePreview = on;
		this.cm.dispatch({ effects: this.lp.reconfigure(this.lpExtension()) });
		this.app.workspace.onLeafStateChanged(this.leaf);
	}

	private applyMode(): void {
		const reading = this.mode === 'preview';
		if (reading) void this.renderPreview();
		this.sourceEl.toggle(!reading);
		(this.previewEl.parentElement as HTMLElement).toggle(reading);
		this.contentEl.toggleClass('is-reading', reading);
		setIcon(this.modeButton, reading ? 'pencil' : 'book-open');
		this.modeButton.setAttr('aria-label', reading ? 'Switch to editing view' : 'Switch to reading view');
	}

	/** Settings that map onto editor/DOM options. */
	private applyOptions(): void {
		const cfg = (k: string) => this.app.vault.getConfig(k);
		for (const el of [this.sourceEl, this.previewEl]) el.toggleClass('is-readable-line-width', !!cfg('readableLineLength'));
		const ext: Extension[] = [EditorView.contentAttributes.of({ spellcheck: String(!!cfg('spellcheck')) })];
		if (cfg('showLineNumber')) ext.push(lineNumbers());
		if (cfg('foldHeading') || cfg('foldIndent')) ext.push(foldGutter({ openText: '▾', closedText: '▸' }));
		this.cm.dispatch({ effects: this.options.reconfigure(ext) });
	}

	private lpExtension(): Extension {
		if (!this.livePreview) return [];
		const host = { app: this.app, component: this, sourcePath: () => this.file?.path ?? '' };
		return livePreview(host, (lang) => lang === 'mermaid');
	}

	private makeState(doc: string): EditorState {
		return EditorState.create({
			doc,
			extensions: [
				history(),
				keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
				yamlFrontmatter({ content: markdown({ base: markdownLanguage, codeLanguages: languages }) }),
				syntaxHighlighting(obsidianClasses),
				EditorView.lineWrapping,
				autocompletion({ override: [(ctx) => this.complete(ctx)], icons: false }),
				this.options.of([]),
				this.lp.of(this.lpExtension()),
				EditorView.updateListener.of((u) => {
					if (!u.docChanged) return;
					this.dirty = true;
					this.requestSave();
					this.app.workspace.trigger('editor-change', this.editor, this);
				}),
			],
		});
	}

	/** `[[` → note names (and headings after `#`); `#` → tags. */
	private complete(ctx: CompletionContext): CompletionResult | null {
		const { metadataCache, vault } = this.app;
		const link = ctx.matchBefore(/\[\[[^\]|\n]*$/);
		if (link) {
			const query = link.text.slice(2);
			const hash = query.indexOf('#');
			if (hash >= 0) {
				const file = query.slice(0, hash) ? metadataCache.getFirstLinkpathDest(query.slice(0, hash), this.file?.path ?? '') : this.file;
				const headings = (file && metadataCache.getFileCache(file)?.headings) ?? [];
				return { from: link.from + 2 + hash + 1, options: headings.map((h) => ({ label: h.heading, apply: h.heading + ']]' })) };
			}
			const source = this.file?.path ?? '';
			return {
				from: link.from + 2,
				options: vault.getFiles().map((f: TFile) => {
					const text = metadataCache.fileToLinktext(f, source);
					return { label: text, detail: f.parent && !f.parent.isRoot() ? f.parent.path : undefined, apply: text + ']]' };
				}),
			};
		}
		const tag = ctx.matchBefore(/(?:^|\s)#[\p{L}\p{N}\p{M}_\/-]*$/u);
		if (tag && (tag.text.trim().length > 1 || ctx.explicit)) {
			const tags = new Set<string>();
			for (const f of vault.getMarkdownFiles()) for (const tg of metadataCache.getFileCache(f)?.tags ?? []) tags.add(tg.tag);
			return { from: tag.from + tag.text.indexOf('#'), options: [...tags].map((tg) => ({ label: tg })) };
		}
		return null;
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

	private renderPreview(): Promise<void> {
		return (this.rendered = this.doRenderPreview());
	}

	private async doRenderPreview(): Promise<void> {
		const token = ++this.renderToken;
		const src = this.getViewData();
		const out = createDiv();
		const fm = /^---\r?\n([\s\S]*?)\r?\n?---(?:\r?\n|$)/.exec(src);
		let body = src;
		if (fm) {
			// Blank lines keep source line numbers intact for task checkboxes.
			body = '\n'.repeat(fm[0].split('\n').length - 1) + src.slice(fm[0].length);
			if (this.app.vault.getConfig('propertiesInDocument') !== 'hidden') {
				renderProperties(out.createDiv(), parseFrontmatterYaml(fm[1]), (data) => {
					if (!this.file) return;
					void this.app.fileManager.processFrontMatter(this.file, (obj) => {
						for (const k of Object.keys(obj)) delete obj[k];
						Object.assign(obj, data);
					});
				});
			}
		}
		await MarkdownRenderer.render(this.app, body, out, this.file?.path ?? '', this);
		if (token !== this.renderToken) return; // a newer render started
		const scroll = this.previewEl.scrollTop;
		this.previewSizerEl.replaceChildren(...out.childNodes);
		this.previewEl.scrollTop = scroll;
	}

	private onPreviewClick(e: MouseEvent): void {
		const target = e.target as HTMLElement;
		const box = target.closest('input.task-list-item-checkbox') as HTMLInputElement | null;
		if (box && !box.closest('.markdown-embed')) {
			void this.toggleTask(Number(box.dataset.line), box.checked);
			return;
		}
		const a = target.closest('a');
		if (!a) return;
		if (a.hasClass('internal-link')) {
			e.preventDefault();
			void this.app.workspace.openLinkText(a.getAttr('data-href') ?? '', this.file?.path ?? '', e.ctrlKey || e.metaKey ? 'tab' : false);
		} else if (a.hasClass('tag')) {
			e.preventDefault();
			void (this.app.internalPlugins.getEnabledPluginById('global-search') as any)?.openGlobalSearch(`tag:${a.getText()}`);
		}
	}

	/** Reading-view checkbox: flip "[ ]" ↔ "[x]" on that source line. */
	private async toggleTask(line: number, checked: boolean): Promise<void> {
		const lines = this.getViewData().split('\n');
		if (lines[line] === undefined) return;
		lines[line] = lines[line].replace(/\[(.)\]/, checked ? '[x]' : '[ ]');
		this.setViewData(lines.join('\n'), false);
		await this.save();
	}
}
