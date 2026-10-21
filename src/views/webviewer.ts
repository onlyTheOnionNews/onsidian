// Web viewer core plugin (PLAN §5.6): sandboxed <iframe>; reader mode (fetch via network bridge + Readability) for the
// many sites that refuse framing; save the reader version to the vault as Markdown; optional "open external links here".
import DOMPurify from 'dompurify';
import moment from 'moment';
import { htmlToMarkdown } from '../api';
import type { App } from '../app';
import { CorePlugin } from '../coreplugins';
import { setIcon } from '../icons';
import { requestUrl } from '../network';
import { SettingTab } from '../modals';
import { Setting, promptText } from '../ui';
import { ItemView, Notice, type WorkspaceLeaf } from '../workspace';

const HTTP = /^https?:\/\//i;

export class WebViewerView extends ItemView {
	icon = 'globe';
	navigation = true;
	url = '';
	private title = '';
	private history: string[] = [];
	private future: string[] = [];
	private urlInput: HTMLInputElement;
	private frameWrap: HTMLElement;
	private readerEl: HTMLElement;
	private reader = false;
	private readerHtml = '';

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.contentEl.addClass('webviewer-content');
		const bar = this.contentEl.createDiv('webviewer-address');
		const btn = (icon: string, label: string, fn: () => void) => {
			const b = bar.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': label } });
			setIcon(b, icon);
			b.addEventListener('click', fn);
			return b;
		};
		btn('arrow-left', 'Back', () => this.step(this.history, this.future));
		btn('arrow-right', 'Forward', () => this.step(this.future, this.history));
		btn('rotate-cw', 'Reload', () => void this.navigate(this.url, false));
		this.urlInput = bar.createEl('input', { type: 'text', cls: 'webviewer-url', placeholder: 'https://…' });
		this.urlInput.addEventListener('keydown', (e) => {
			if (e.key !== 'Enter') return;
			let u = this.urlInput.value.trim();
			if (u && !HTTP.test(u)) u = `https://${u}`;
			void this.navigate(u);
		});
		btn('book-open-text', 'Reader mode', () => void this.toggleReader());
		btn('save', 'Save page to vault', () => void this.saveToVault());
		btn('external-link', 'Open in browser', () => this.url && window.open(this.url, '_blank', 'noopener'));
		this.contentEl.createDiv({ cls: 'webviewer-hint', text: 'Blank page? Many sites refuse to be embedded. Try Reader mode (needs a network bridge for most sites) or Open in browser.' });
		this.frameWrap = this.contentEl.createDiv('webviewer-frame');
		this.readerEl = this.contentEl.createDiv('webviewer-reader markdown-rendered markdown-preview-view');
		this.readerEl.hide();
	}

	getViewType(): string { return 'webviewer'; }
	getDisplayText(): string { return this.title || this.url || 'Web viewer'; }
	getState(): Record<string, unknown> { return { url: this.url, reader: this.reader }; }

	async setState(state: any): Promise<void> {
		if (typeof state?.url === 'string' && state.url !== this.url) await this.navigate(state.url);
		if (state?.reader && !this.reader) await this.toggleReader();
	}

	private step(from: string[], to: string[]): void {
		const u = from.pop();
		if (!u) return;
		to.push(this.url);
		void this.navigate(u, false);
	}

	async navigate(url: string, record = true): Promise<void> {
		if (!HTTP.test(url)) {
			new Notice('Only http(s) addresses can be opened.');
			return;
		}
		// The app's own origin can't be framed: a same-origin, scripted frame could reach into the app.
		if (new URL(url).origin === location.origin) {
			new Notice('This address belongs to the app itself and can’t be opened here.');
			return;
		}
		if (record && this.url) {
			this.history.push(this.url);
			this.future = [];
		}
		this.url = url;
		this.title = new URL(url).host;
		this.urlInput.value = url;
		this.frameWrap.empty();
		this.frameWrap.createEl('iframe', {
			attr: {
				src: url,
				sandbox: 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin',
				referrerpolicy: 'no-referrer',
				allow: '',
			},
		});
		if (this.reader) await this.loadReader();
		this.updateHeader();
		this.app.workspace.onLeafStateChanged(this.leaf);
	}

	private async toggleReader(): Promise<void> {
		this.reader = !this.reader;
		this.frameWrap.toggle(!this.reader);
		this.readerEl.toggle(this.reader);
		if (this.reader) await this.loadReader();
	}

	private async loadReader(): Promise<void> {
		this.readerEl.empty();
		this.readerHtml = '';
		if (!this.url) return;
		this.readerEl.createDiv({ cls: 'pane-empty', text: 'Loading…' });
		try {
			const html = (await requestUrl({ url: this.url })).text;
			const doc = new DOMParser().parseFromString(html, 'text/html');
			// Resolve relative links/images against the page URL.
			const base = doc.createElement('base');
			base.href = this.url;
			doc.head.prepend(base);
			const { Readability } = await import('@mozilla/readability');
			const article = new Readability(doc).parse();
			if (!article?.content) throw new Error('No readable article found on this page.');
			this.title = article.title || this.title;
			this.readerHtml = article.content;
			this.readerEl.empty();
			this.readerEl.createEl('h1', { text: article.title ?? '' });
			if (article.byline) this.readerEl.createDiv({ cls: 'webviewer-byline', text: article.byline });
			this.readerEl.appendChild(DOMPurify.sanitize(article.content, { RETURN_DOM_FRAGMENT: true }));
			for (const a of this.readerEl.querySelectorAll('a[href]')) a.setAttr('target', '_blank');
			this.updateHeader();
		} catch (e) {
			this.readerEl.empty();
			this.readerEl.createDiv({ cls: 'pane-empty', text: `Reader mode failed: ${(e as Error).message}` });
		}
	}

	private async saveToVault(): Promise<void> {
		if (!this.url) return;
		if (!this.readerHtml) {
			if (!this.reader) await this.toggleReader();
			if (!this.readerHtml) return;
		}
		const name = (await promptText(this.app, 'Save page as note', this.title.replace(/[\\/:*?"<>|#^[\]]/g, '').slice(0, 100), 'Save'))?.trim();
		if (!name) return;
		const body = htmlToMarkdown(this.readerHtml);
		const text = `---\nsource: "${this.url}"\ncreated: ${moment().format('YYYY-MM-DD')}\n---\n# ${this.title}\n\n${body}\n`;
		const file = await this.app.fileManager.createNewMarkdownFile(this.app.fileManager.getNewFileParent(''), name, text);
		new Notice(`Saved "${file.basename}".`);
	}
}

export class WebViewerPlugin extends CorePlugin {
	id = 'webviewer';
	name = 'Web viewer';
	description = 'Open web pages in a tab, with reader mode and saving to the vault.';
	defaultOn = false;
	options = { openExternalURLs: false };

	async onload(): Promise<void> {
		this.options = await this.loadOptions('webviewer', this.options);
		this.registerView('webviewer', (leaf) => new WebViewerView(leaf));
		this.addCommand({
			id: 'webviewer:open', name: 'Web viewer: Open URL…', icon: 'globe',
			callback: async () => {
				const url = await promptText(this.app, 'Open URL', 'https://', 'Open');
				if (url) await openWebViewer(this.app, url);
			},
		});
		// Optionally route external links in notes here instead of a new browser tab.
		this.registerDomEvent(document, 'click', (e: MouseEvent) => {
			if (!this.options.openExternalURLs) return;
			const a = (e.target as HTMLElement).closest('a.external-link') as HTMLAnchorElement | null;
			if (!a || !HTTP.test(a.href) || a.closest('.webviewer-reader')) return;
			e.preventDefault();
			void openWebViewer(this.app, a.href);
		}, true);
		this.addSettingTab(new WebViewerTab(this.app, this));
	}
}

async function openWebViewer(app: App, url: string): Promise<void> {
	await app.workspace.getLeaf('tab').setViewState({ type: 'webviewer', state: { url }, active: true });
}

class WebViewerTab extends SettingTab {
	constructor(app: App, private plugin: WebViewerPlugin) {
		super(app);
		this.id = 'webviewer';
		this.name = 'Web viewer';
	}
	display(): void {
		this.containerEl.empty();
		new Setting(this.containerEl).setName('Open external links').setDesc('Open web links from notes in the web viewer instead of a browser tab.')
			.addToggle((t) => t.setValue(this.plugin.options.openExternalURLs).onChange((v) => {
				this.plugin.options.openExternalURLs = v;
				void this.app.vault.writeConfigJson('webviewer', this.plugin.options);
			}));
	}
}
