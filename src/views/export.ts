// Static-site export (PLAN §7.2, replaces Publish): render notes with the app's renderer into a .zip of HTML pages
// the user can host anywhere. Links become relative .html links; attachments are copied; the page CSS is collected
// from the running app so the site looks the same.
// ponytail: rendered sequentially in a hidden container (fine for hundreds of notes); no search, graph or
// per-page incremental export. PDF/canvas/base embeds export as links.
import { zip, type Zippable } from 'fflate';
import type { App } from '../app';
import { CorePlugin } from '../coreplugins';
import { Component } from '../events';
import { MarkdownRenderer } from '../render';
import { Modal, Setting } from '../ui';
import { TFile, type TAbstractFile } from '../vault';
import { Notice } from '../workspace';

const enc = new TextEncoder();
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const htmlPath = (p: string) => p.replace(/\.md$/, '.html');

/** Relative URL from one site path to another. */
function relative(from: string, to: string): string {
	const a = from.split('/').slice(0, -1);
	const b = to.split('/');
	while (a.length && b.length > 1 && a[0] === b[0]) { a.shift(); b.shift(); }
	return [...a.map(() => '..'), ...b].map(encodeURIComponent).join('/');
}

function collectCss(): string {
	const parts: string[] = [];
	for (const sheet of [...document.styleSheets]) {
		try {
			for (const rule of [...sheet.cssRules]) parts.push(rule.cssText);
		} catch {
			// cross-origin stylesheet: skip
		}
	}
	return parts.join('\n') + '\nbody{overflow:auto;height:auto}.site{display:flex;min-height:100vh}.site-nav{width:260px;flex-shrink:0;padding:16px;background:var(--background-secondary);font-size:var(--font-ui-small);overflow:auto;max-height:100vh;position:sticky;top:0}.site-nav a{display:block;padding:2px 6px;border-radius:4px;color:var(--nav-item-color);text-decoration:none}.site-nav a:hover,.site-nav a.is-active{background:var(--nav-item-background-hover);color:var(--nav-item-color-active)}.site-nav .folder{margin-top:8px;font-weight:600;color:var(--text-muted)}.site-main{flex:1;min-width:0}@media (max-width:700px){.site{display:block}.site-nav{width:auto;position:static;max-height:none}}';
}

export async function exportStaticSite(app: App, folder: string, title: string): Promise<{ pages: number; zipBytes: Uint8Array }> {
	const prefix = folder && folder !== '/' ? `${folder.replace(/\/$/, '')}/` : '';
	const notes = app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(prefix)).sort((a, b) => a.path.localeCompare(b.path));
	const files: Zippable = {};
	const attachments = new Set<TFile>();
	const component = new Component();
	component.load();
	const host = document.body.createDiv('static-export-host');
	host.style.cssText = 'position:absolute;left:-10000px;top:0;width:900px;';
	const dark = document.body.hasClass('theme-dark');

	const nav = (current: string) => {
		const out: string[] = [`<a href="${relative(current, 'index.html')}"><strong>${esc(title)}</strong></a>`];
		let lastDir = '';
		for (const n of notes) {
			const p = n.path.slice(prefix.length);
			const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
			if (dir !== lastDir && dir) out.push(`<div class="folder">${esc(dir)}</div>`);
			lastDir = dir;
			const target = htmlPath(p);
			out.push(`<a href="${relative(current, target)}"${target === current ? ' class="is-active"' : ''}>${esc(n.basename)}</a>`);
		}
		return out.join('');
	};

	const page = (current: string, heading: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(heading)} - ${esc(title)}</title><link rel="stylesheet" href="${relative(current, 'site.css')}"></head>
<body class="${dark ? 'theme-dark' : 'theme-light'}"><div class="site"><nav class="site-nav">${nav(current)}</nav>
<main class="site-main markdown-preview-view markdown-rendered is-readable-line-width"><div class="markdown-preview-sizer">
<h1 class="inline-title">${esc(heading)}</h1>${body}</div></main></div></body></html>`;

	try {
		for (const note of notes) {
			const sitePath = htmlPath(note.path.slice(prefix.length));
			const el = host.createDiv();
			const text = (await app.vault.cachedRead(note)).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
			await MarkdownRenderer.render(app, text, el, note.path, component);
			// Internal links → relative .html (unresolved stay as text).
			for (const a of el.querySelectorAll<HTMLAnchorElement>('a.internal-link')) {
				const href = a.dataset.href ?? a.getAttribute('href') ?? '';
				const [path, sub] = href.split('#');
				const target = path ? app.metadataCache.getFirstLinkpathDest(path, note.path) : note;
				if (target?.extension === 'md' && target.path.startsWith(prefix)) {
					a.setAttribute('href', relative(sitePath, htmlPath(target.path.slice(prefix.length))) + (sub ? `#${sub}` : ''));
					a.removeAttribute('target');
				} else if (target) {
					attachments.add(target);
					a.setAttribute('href', relative(sitePath, `files/${target.path}`));
				} else {
					a.replaceWith(document.createTextNode(a.textContent ?? ''));
				}
			}
			// Images/media embeds (blob: URLs) → copied files.
			for (const media of el.querySelectorAll<HTMLImageElement | HTMLVideoElement | HTMLAudioElement>('.internal-embed img, .internal-embed video, .internal-embed audio')) {
				const embed = media.closest('.internal-embed');
				const file = app.metadataCache.getFirstLinkpathDest((embed?.getAttribute('src') ?? '').split('#')[0], note.path);
				if (!file) continue;
				attachments.add(file);
				media.setAttribute('src', relative(sitePath, `files/${file.path}`));
			}
			// Interactive bits that don't survive as static HTML.
			for (const x of el.querySelectorAll('.markdown-embed-link, .metadata-container, input.task-list-item-checkbox')) {
				if (x instanceof HTMLInputElement) x.disabled = true;
				else x.remove();
			}
			files[sitePath] = enc.encode(page(sitePath, note.basename, el.innerHTML));
			el.remove();
		}
		const home = notes.find((n) => /^(index|home|welcome|readme)$/i.test(n.basename) && !n.path.slice(prefix.length).includes('/'));
		files['index.html'] = home
			? enc.encode(page('index.html', home.basename, `<meta http-equiv="refresh" content="0; url=${relative('index.html', htmlPath(home.path.slice(prefix.length)))}">`))
			: enc.encode(page('index.html', title, `<ul>${notes.map((n) => `<li><a href="${relative('index.html', htmlPath(n.path.slice(prefix.length)))}">${esc(n.path.slice(prefix.length, -3))}</a></li>`).join('')}</ul>`));
		for (const f of attachments) files[`files/${f.path}`] = new Uint8Array(await app.vault.readBinary(f));
		files['site.css'] = enc.encode(collectCss());
	} finally {
		host.remove();
		component.unload();
	}
	const zipBytes = await new Promise<Uint8Array>((res, rej) => zip(files, { level: 6 }, (e, out) => (e ? rej(e) : res(out))));
	return { pages: notes.length, zipBytes };
}

class ExportModal extends Modal {
	constructor(app: App, private folder = '') {
		super(app);
	}
	onOpen(): void {
		this.setTitle('Export as static website');
		let title = this.app.vault.getName();
		new Setting(this.contentEl).setName('Folder').setDesc('Export only this folder (empty = whole vault).').addText((t) => t.setValue(this.folder).onChange((v) => (this.folder = v.trim())));
		new Setting(this.contentEl).setName('Site title').addText((t) => t.setValue(title).onChange((v) => (title = v)));
		this.contentEl.createDiv({ cls: 'setting-item-description', text: 'Creates a .zip of HTML pages, attachments and styles. Upload it to any static host. Frontmatter is not included.' });
		const buttons = this.modalEl.createDiv('modal-button-container');
		buttons.createEl('button', { cls: 'mod-cta', text: 'Export' }).addEventListener('click', async () => {
			const notice = new Notice('Building site…', 0);
			try {
				const { pages, zipBytes } = await exportStaticSite(this.app, this.folder, title);
				const url = URL.createObjectURL(new Blob([zipBytes as BlobPart], { type: 'application/zip' }));
				createEl('a', { href: url, attr: { download: `${title || 'site'}.zip` } }).click();
				setTimeout(() => URL.revokeObjectURL(url), 60_000);
				notice.setMessage(`Exported ${pages} pages.`);
				this.close();
			} catch (e) {
				notice.setMessage(`Export failed: ${(e as Error).message}`);
			} finally {
				setTimeout(() => notice.hide(), 5000);
			}
		});
	}
}

export class StaticExportPlugin extends CorePlugin {
	id = 'static-export';
	name = 'Static site export';
	description = 'Export notes as a website (.zip) to host anywhere.';
	onload(): void {
		this.addCommand({ id: 'static-export:export', name: 'Export as static website…', icon: 'globe', callback: () => new ExportModal(this.app).open() });
		this.registerEvent(this.app.workspace.on('file-menu', (menu: any, file: TAbstractFile) => {
			if ('children' in file) menu.addItem((i: any) => i.setTitle('Export as website…').setIcon('globe').setSection('action').onClick(() => new ExportModal(this.app, file.path === '/' ? '' : file.path).open()));
		}));
	}
}
