// Web clipper core plugin (PLAN §7.2): pages arrive from a bookmarklet (postMessage from the page that opened us) or
// from the installed PWA's share target (the Service Worker stashes the POST in Cache Storage). Content is never put
// in a URL. Every clip is confirmed by the user before anything is written, and the HTML is sanitized on conversion.
import moment from 'moment';
import { htmlToMarkdown, stringifyYaml } from '../api';
import type { App } from '../app';
import { CorePlugin } from '../coreplugins';
import { SettingTab } from '../modals';
import { Modal, Setting } from '../ui';
import { Notice } from '../workspace';
import { MSG, bookmarklet, parseClip, type Clip } from './clip';

/** Clip → note text: frontmatter with the source, then the article (or selection/shared text) as Markdown. */
export async function clipToMarkdown(clip: Clip, now = moment()): Promise<{ title: string; body: string }> {
	let title = clip.title;
	let body = clip.text?.trim() ?? '';
	if (!body && clip.html) {
		const doc = new DOMParser().parseFromString(clip.html, 'text/html');
		if (clip.url) {
			const base = doc.createElement('base');
			base.href = clip.url;
			doc.head.prepend(base);
		}
		const { Readability } = await import('@mozilla/readability');
		const article = new Readability(doc.cloneNode(true) as Document).parse();
		title ||= article?.title ?? '';
		// htmlToMarkdown sanitizes (DOMPurify) before converting.
		body = htmlToMarkdown(article?.content ?? doc.body.innerHTML).trim();
	}
	const fm: Record<string, string> = { created: now.format('YYYY-MM-DD') };
	if (clip.url) fm.source = clip.url;
	return { title: title || 'Clipped page', body: `---\n${stringifyYaml(fm)}---\n${body}\n` };
}

class ClipModal extends Modal {
	constructor(app: App, private clip: Clip) {
		super(app);
	}
	async onOpen(): Promise<void> {
		const { title, body } = await clipToMarkdown(this.clip);
		let name = title.replace(/[\\/:*?"<>|#^[\]]/g, '').slice(0, 100).trim() || 'Clipped page';
		this.setTitle('Save clipped page?');
		if (this.clip.url) this.contentEl.createDiv({ cls: 'setting-item-description', text: `From ${this.clip.url}` });
		new Setting(this.contentEl).setName('Note name').addText((t) => t.setValue(name).onChange((v) => (name = v.trim())));
		this.contentEl.createEl('pre', { cls: 'clipper-preview', text: body.length > 1500 ? `${body.slice(0, 1500)}…` : body });
		const buttons = this.modalEl.createDiv('modal-button-container');
		buttons.createEl('button', { cls: 'mod-cta', text: 'Save' }).addEventListener('click', async () => {
			if (!name) return;
			const fm = this.app.fileManager;
			const file = await fm.createNewMarkdownFile(fm.getNewFileParent(''), name, body);
			this.close();
			await this.app.workspace.getLeaf(false).openFile(file);
			new Notice(`Clipped "${file.basename}".`);
		});
		buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
	}
}

export class ClipperPlugin extends CorePlugin {
	id = 'web-clipper';
	name = 'Web clipper';
	description = 'Save web pages as notes with a bookmarklet, or by sharing to the installed app.';

	onload(): void {
		this.addSettingTab(new ClipperTab(this.app));
		const params = new URLSearchParams(location.search);
		if (!params.has('clip') && !params.has('share')) return;
		history.replaceState(null, '', location.pathname);
		this.app.workspace.onLayoutReady(() => {
			if (params.has('share')) void this.receiveShare();
			else this.receiveBookmarklet();
		});
	}

	private open(clip: Clip | null): void {
		if (clip) new ClipModal(this.app, clip).open();
		else new Notice('Nothing to clip was received.');
	}

	private receiveBookmarklet(): void {
		const opener = window.opener as Window | null;
		if (!opener) return;
		const onMessage = (e: MessageEvent) => {
			// The page's own scripts may message us too: wait for an actual clip.
			const clip = e.source === opener ? parseClip(e.data) : null;
			if (!clip) return;
			window.removeEventListener('message', onMessage);
			this.open(clip);
		};
		this.registerDomEvent(window, 'message', onMessage);
		// "ready" carries no data, so any origin may see it; the page answers only to our origin.
		opener.postMessage(`${MSG}-ready`, '*');
	}

	private async receiveShare(): Promise<void> {
		const cache = await caches.open('share-target');
		const res = await cache.match('shared');
		await cache.delete('shared');
		const d = res ? await res.json() : null;
		// The share sheet gives title/text/url; many apps put the URL inside text.
		const url = d?.url || d?.text?.match(/https?:\/\/\S+/)?.[0] || '';
		this.open(d && parseClip({ type: MSG, title: d.title, url, text: d.text && d.text !== url ? d.text : '' }));
	}
}

class ClipperTab extends SettingTab {
	constructor(app: App) {
		super(app);
		this.id = 'web-clipper';
		this.name = 'Web clipper';
	}
	display(): void {
		this.containerEl.empty();
		const s = new Setting(this.containerEl).setName('Bookmarklet')
			.setDesc('Drag this link to your bookmarks bar. On any page, click it to save the article (or your selection) to the vault that was open last. You confirm each clip before it is saved.');
		s.controlEl.createEl('a', { cls: 'clipper-bookmarklet', text: 'Clip to onsidian', href: bookmarklet(location.href) })
			.addEventListener('click', (e) => {
				e.preventDefault();
				new Notice('Drag this link to your bookmarks bar.');
			});
		new Setting(this.containerEl).setName('Share to this app')
			.setDesc('Install onsidian as an app (browser menu → Install). It then appears in your device’s share sheet.');
	}
}
