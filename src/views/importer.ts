// Importer core plugin (PLAN §5.6): Markdown, HTML, CSV, Evernote ENEX, Notion export, Google Keep (Takeout).
// Everything runs in the browser; .zip inputs are unpacked with fflate. Existing files are never overwritten.
// Not here: OneNote (needs a Microsoft app registration for the deployed origin) and Apple Notes (needs SQLite/wasm).
import { unzipSync } from 'fflate';
import moment from 'moment';
import { htmlToMarkdown, stringifyYaml } from '../api';
import type { App } from '../app';
import { CorePlugin } from '../coreplugins';
import { Modal, Setting } from '../ui';
import { normalizePath } from '../vault';
import { Notice } from '../workspace';

interface InFile { path: string; bytes: Uint8Array; }
interface OutFile { path: string; data: string | Uint8Array; }

const dec = new TextDecoder();
const text = (f: InFile) => dec.decode(f.bytes);
const ext = (p: string) => p.slice(p.lastIndexOf('.') + 1).toLowerCase();
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const stem = (p: string) => base(p).replace(/\.[^.]+$/, '');
/** Characters Obsidian doesn't allow in file names. */
const safeName = (s: string) => s.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled';

async function readInputs(files: File[]): Promise<InFile[]> {
	const out: InFile[] = [];
	for (const f of files) {
		const bytes = new Uint8Array(await f.arrayBuffer());
		if (f.name.toLowerCase().endsWith('.zip')) {
			for (const [path, data] of Object.entries(unzipSync(bytes))) {
				if (!path.endsWith('/') && !path.startsWith('__MACOSX/')) out.push({ path, bytes: data });
			}
		} else {
			out.push({ path: (f as any).webkitRelativePath || f.name, bytes });
		}
	}
	return out;
}

// ---------------- Format converters ----------------

function importMarkdown(files: InFile[]): OutFile[] {
	return files.map((f) => ({ path: f.path, data: ext(f.path) === 'md' ? text(f) : f.bytes }));
}

/** Local <img src> pointing at files in the input are copied and embedded; remote images stay links. */
function importHtml(files: InFile[]): OutFile[] {
	const byPath = new Map(files.map((f) => [f.path.toLowerCase(), f]));
	const out: OutFile[] = [];
	for (const f of files.filter((x) => /^html?$/.test(ext(x.path)))) {
		const doc = new DOMParser().parseFromString(text(f), 'text/html');
		const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
		for (const img of doc.querySelectorAll('img[src]')) {
			const src = decodeURIComponent(img.getAttribute('src') ?? '');
			const local = byPath.get(normalizePath(dir + src).toLowerCase());
			if (local) {
				out.push({ path: `attachments/${base(local.path)}`, data: local.bytes });
				img.replaceWith(doc.createTextNode(`![[${base(local.path)}]]`));
			}
		}
		const title = doc.title || stem(f.path);
		out.push({ path: `${safeName(title)}.md`, data: htmlToMarkdown(doc.body) + '\n' });
	}
	return out;
}

/** RFC 4180-ish CSV: quoted fields, "" escapes, newlines inside quotes. */
export function parseCsv(src: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (quoted) {
			if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
			else if (c === '"') quoted = false;
			else field += c;
		} else if (c === '"') quoted = true;
		else if (c === ',') { row.push(field); field = ''; }
		else if (c === '\n' || c === '\r') {
			if (c === '\r' && src[i + 1] === '\n') i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
		} else field += c;
	}
	if (field || row.length) {
		row.push(field);
		rows.push(row);
	}
	return rows.filter((r) => r.some((x) => x.trim()));
}

/** One note per row: the first column is the title, the rest become properties. */
function importCsv(files: InFile[]): OutFile[] {
	const out: OutFile[] = [];
	for (const f of files.filter((x) => ext(x.path) === 'csv')) {
		const [header, ...rows] = parseCsv(text(f).replace(/^﻿/, ''));
		if (!header) continue;
		const folder = safeName(stem(f.path));
		for (const r of rows) {
			const props: Record<string, unknown> = {};
			header.slice(1).forEach((h, i) => {
				const v = r[i + 1]?.trim();
				if (v) props[h.trim() || `column ${i + 2}`] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
			});
			const fm = Object.keys(props).length ? `---\n${stringifyYaml(props)}---\n` : '';
			out.push({ path: `${folder}/${safeName(r[0] ?? 'Untitled')}.md`, data: fm });
		}
	}
	return out;
}

function importEnex(files: InFile[]): OutFile[] {
	const out: OutFile[] = [];
	for (const f of files.filter((x) => ext(x.path) === 'enex')) {
		const xml = new DOMParser().parseFromString(text(f), 'application/xml');
		const notebook = safeName(stem(f.path));
		for (const note of xml.querySelectorAll('note')) {
			const title = note.querySelector('title')?.textContent ?? 'Untitled';
			// Attachments, keyed by MD5 of their bytes (what <en-media hash="…"> refers to).
			const media = new Map<string, string>();
			for (const res of note.querySelectorAll('resource')) {
				const b64 = res.querySelector('data')?.textContent?.replace(/\s+/g, '') ?? '';
				if (!b64) continue;
				const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
				const mime = res.querySelector('mime')?.textContent ?? '';
				const name = res.querySelector('resource-attributes > file-name')?.textContent || `${md5(bytes).slice(0, 8)}.${mime.split('/')[1] ?? 'bin'}`;
				const path = `${notebook}/attachments/${safeName(name.replace(/\.[^.]+$/, ''))}.${ext(name) || 'bin'}`;
				out.push({ path, data: bytes });
				media.set(md5(bytes), base(path));
			}
			// Rewrite ENML's self-closing tags as text first: the HTML parser ignores "/>" on unknown elements and would
			// swallow the following text into <en-todo>.
			const enml = (note.querySelector('content')?.textContent ?? '')
				.replace(/<en-todo([^>]*?)\/?>(?:<\/en-todo>)?/g, (_m, attrs: string) => (/checked="true"/.test(attrs) ? '- [x] ' : '- [ ] '))
				.replace(/<en-media([^>]*?)\/?>(?:<\/en-media>)?/g, (_m, attrs: string) => {
					const name = media.get(/hash="([0-9a-f]+)"/.exec(attrs)?.[1] ?? '');
					return name ? `![[${name}]]` : '';
				});
			const doc = new DOMParser().parseFromString(enml, 'text/html');
			const props: Record<string, unknown> = {};
			const created = note.querySelector('created')?.textContent;
			if (created) props.created = moment.utc(created, 'YYYYMMDDTHHmmssZ').local().format('YYYY-MM-DDTHH:mm');
			const tags = [...note.querySelectorAll('tag')].map((t) => t.textContent?.replace(/\s+/g, '-')).filter(Boolean);
			if (tags.length) props.tags = tags;
			const src = note.querySelector('note-attributes > source-url')?.textContent;
			if (src) props.source = src;
			const fm = Object.keys(props).length ? `---\n${stringifyYaml(props)}---\n` : '';
			out.push({ path: `${notebook}/${safeName(title)}.md`, data: `${fm}${htmlToMarkdown(doc.body)}\n` });
		}
	}
	return out;
}

/** Notion "Markdown & CSV" export: strip the 32-hex IDs from paths and turn relative links into wikilinks. */
function importNotion(files: InFile[]): OutFile[] {
	const clean = (p: string) => p.split('/').map((seg) => seg.replace(/ [0-9a-f]{32}(?=\.|$)/i, '')).join('/');
	return files.map((f) => {
		if (ext(f.path) !== 'md') return { path: clean(f.path), data: f.bytes };
		const body = text(f).replace(/\[([^\]]*)\]\(([^)]+)\)/g, (m, label: string, href: string) => {
			if (/^[a-z]+:/i.test(href)) return m;
			let target = href;
			try { target = decodeURIComponent(href); } catch { /* keep */ }
			const name = stem(clean(target));
			if (ext(target) === 'md') return name === label ? `[[${name}]]` : `[[${name}|${label}]]`;
			return `![[${base(clean(target))}]]`;
		});
		return { path: clean(f.path), data: body };
	});
}

/** Google Keep (Takeout): JSON per note, with checklists, labels and attachments. */
function importKeep(files: InFile[]): OutFile[] {
	const byName = new Map(files.map((f) => [base(f.path), f]));
	const out: OutFile[] = [];
	for (const f of files.filter((x) => ext(x.path) === 'json')) {
		let n: any;
		try { n = JSON.parse(text(f)); } catch { continue; }
		if (!n || (n.textContent === undefined && !n.listContent)) continue;
		if (n.isTrashed) continue;
		const lines: string[] = [];
		if (n.textContent) lines.push(n.textContent);
		for (const item of n.listContent ?? []) lines.push(`- [${item.isChecked ? 'x' : ' '}] ${item.text}`);
		for (const a of n.attachments ?? []) {
			const file = byName.get(a.filePath);
			if (!file) continue;
			out.push({ path: `Keep/attachments/${a.filePath}`, data: file.bytes });
			lines.push(`![[${a.filePath}]]`);
		}
		const props: Record<string, unknown> = {};
		if (n.createdTimestampUsec) props.created = moment(Number(n.createdTimestampUsec) / 1000).format('YYYY-MM-DDTHH:mm');
		const tags = (n.labels ?? []).map((l: any) => String(l.name).replace(/\s+/g, '-'));
		if (n.isArchived) tags.push('archived');
		if (tags.length) props.tags = tags;
		const fm = Object.keys(props).length ? `---\n${stringifyYaml(props)}---\n` : '';
		out.push({ path: `Keep/${safeName(n.title || stem(f.path))}.md`, data: `${fm}${lines.join('\n')}\n` });
	}
	return out;
}

const FORMATS: Record<string, { name: string; accept: string; desc: string; run: (f: InFile[]) => OutFile[] }> = {
	markdown: { name: 'Markdown files', accept: '.md,.zip,image/*,.pdf', desc: 'Markdown files or a .zip of a Markdown folder (attachments kept).', run: importMarkdown },
	html: { name: 'HTML files', accept: '.html,.htm,.zip', desc: 'HTML pages (or a .zip with their images) converted to Markdown.', run: importHtml },
	csv: { name: 'CSV', accept: '.csv', desc: 'One note per row; the first column is the note name, others become properties.', run: importCsv },
	enex: { name: 'Evernote (.enex)', accept: '.enex', desc: 'Evernote export files, with attachments, tags and checklists.', run: importEnex },
	notion: { name: 'Notion export (.zip)', accept: '.zip', desc: 'Notion "Markdown & CSV" export. IDs are removed from names and links.', run: importNotion },
	keep: { name: 'Google Keep (Takeout .zip)', accept: '.zip,.json', desc: 'Google Takeout Keep folder, with checklists, labels and attachments.', run: importKeep },
};

class ImporterModal extends Modal {
	private format = 'markdown';
	private files: File[] = [];
	private folder = `Imported ${moment().format('YYYY-MM-DD')}`;

	onOpen(): void {
		this.setTitle('Import notes');
		const el = this.contentEl;
		const descEl = createDiv('setting-item-description');
		new Setting(el).setName('Format').addDropdown((d) => {
			for (const [k, f] of Object.entries(FORMATS)) d.addOption(k, f.name);
			d.setValue(this.format).onChange((v) => {
				this.format = v;
				descEl.setText(FORMATS[v].desc);
			});
		});
		el.appendChild(descEl);
		descEl.setText(FORMATS[this.format].desc);
		const picked = createDiv('setting-item-description');
		new Setting(el).setName('Files').addButton((b) => b.setButtonText('Choose files…').onClick(() => {
			const input = createEl('input', { type: 'file', attr: { multiple: '', accept: FORMATS[this.format].accept } });
			input.addEventListener('change', () => {
				this.files = [...(input.files ?? [])];
				picked.setText(this.files.map((f) => f.name).join(', '));
			});
			input.click();
		}));
		el.appendChild(picked);
		new Setting(el).setName('Output folder').addText((t) => t.setValue(this.folder).onChange((v) => (this.folder = v)));
		const buttons = this.modalEl.createDiv('modal-button-container');
		buttons.createEl('button', { cls: 'mod-cta', text: 'Import' }).addEventListener('click', () => void this.run());
	}

	private async run(): Promise<void> {
		if (!this.files.length) {
			new Notice('Choose files to import first.');
			return;
		}
		const notice = new Notice('Importing…', 0);
		try {
			const { added, skipped } = await importFiles(this.app, this.format, this.files, this.folder);
			notice.setMessage(`Imported ${added} files into "${this.folder}"${skipped ? `, skipped ${skipped} that already existed` : ''}.`);
			this.close();
		} catch (e) {
			notice.setMessage(`Import failed: ${(e as Error).message}`);
		} finally {
			setTimeout(() => notice.hide(), 6000);
		}
	}
}

/** Convert `files` with `format` and write them under `folder` (never overwriting). */
export async function importFiles(app: App, format: string, files: File[], folder: string): Promise<{ added: number; skipped: number }> {
	const f = FORMATS[format];
	if (!f) throw new Error(`Unknown format "${format}"`);
	return writeOutputs(app, f.run(await readInputs(files)), folder);
}

async function writeOutputs(app: App, files: OutFile[], folder: string): Promise<{ added: number; skipped: number }> {
	let added = 0;
	let skipped = 0;
	const root = normalizePath(folder || 'Imported');
	for (const f of files) {
		const path = normalizePath(`${root}/${f.path}`);
		if (path.split('/').some((seg) => seg === '..' || seg.startsWith('.'))) continue; // zip-slip / hidden paths
		if (app.vault.getAbstractFileByPath(path)) {
			skipped++;
			continue;
		}
		if (typeof f.data === 'string') await app.vault.create(path, f.data);
		else await app.vault.createBinary(path, f.data.slice().buffer);
		added++;
	}
	return { added, skipped };
}

export class ImporterPlugin extends CorePlugin {
	id = 'importer';
	name = 'Importer';
	description = 'Import notes from Markdown, HTML, CSV, Evernote, Notion and Google Keep.';
	onload(): void {
		this.addCommand({ id: 'importer:open', name: 'Importer: Open importer', icon: 'import', callback: () => new ImporterModal(this.app).open() });
	}
}

// ---------------- MD5 (Evernote media hashes; WebCrypto has no MD5) ----------------

/** Compact RFC 1321 MD5 → hex. */
export function md5(data: Uint8Array): string {
	const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
	const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
	const len = data.length;
	const padded = new Uint8Array(((len + 8) >> 6) * 64 + 64);
	padded.set(data);
	padded[len] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(padded.length - 8, (len * 8) >>> 0, true);
	view.setUint32(padded.length - 4, Math.floor((len * 8) / 2 ** 32), true);
	let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
	for (let off = 0; off < padded.length; off += 64) {
		const M = Array.from({ length: 16 }, (_, i) => view.getUint32(off + i * 4, true));
		let [a, b, c, d] = [a0, b0, c0, d0];
		for (let i = 0; i < 64; i++) {
			const r = i >> 4;
			const f = r === 0 ? (b & c) | (~b & d) : r === 1 ? (d & b) | (~d & c) : r === 2 ? b ^ c ^ d : c ^ (b | ~d);
			const g = r === 0 ? i : r === 1 ? (5 * i + 1) % 16 : r === 2 ? (3 * i + 5) % 16 : (7 * i) % 16;
			const tmp = d;
			d = c;
			c = b;
			const x = (a + f + K[i] + M[g]) >>> 0;
			const s = S[r * 4 + (i % 4)];
			b = (b + ((x << s) | (x >>> (32 - s)))) >>> 0;
			a = tmp;
		}
		a0 = (a0 + a) >>> 0;
		b0 = (b0 + b) >>> 0;
		c0 = (c0 + c) >>> 0;
		d0 = (d0 + d) >>> 0;
	}
	return [a0, b0, c0, d0].map((w) => [0, 8, 16, 24].map((s) => ((w >>> s) & 0xff).toString(16).padStart(2, '0')).join('')).join('');
}
