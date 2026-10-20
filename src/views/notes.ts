// Note-creation core plugins (PLAN §5.5): Templates, Daily notes, Unique note creator, Random note, Note composer, Slides.
// Options live in Obsidian's own files (.obsidian/templates.json, daily-notes.json, zk-prefixer.json).
import moment from 'moment';
import type { App } from '../app';
import { CorePlugin } from '../coreplugins';
import { Keymap } from '../keymap';
import { SettingTab } from '../modals';
import { MarkdownRenderer } from '../render';
import { FuzzySuggestModal, Setting } from '../ui';
import { TFile, TFolder, normalizePath } from '../vault';
import { Notice } from '../workspace';
import { Component } from '../events';

// ---------------- Templates ----------------

interface TemplateOptions { folder: string; dateFormat: string; timeFormat: string; }

/** Replace {{title}}, {{date}}, {{time}}, {{date:FORMAT}}, {{time:FORMAT}} (Obsidian's template variables). */
export function applyTemplateVariables(text: string, title: string, opts: { dateFormat: string; timeFormat: string }, now = moment()): string {
	return text.replace(/{{\s*(title|date|time)\s*(?::([^}]*))?}}/gi, (_m, name: string, fmt?: string) => {
		const n = name.toLowerCase();
		if (n === 'title') return title;
		return now.format(fmt?.trim() || (n === 'date' ? opts.dateFormat : opts.timeFormat));
	});
}

class FilePicker extends FuzzySuggestModal<TFile> {
	constructor(app: App, private files: TFile[], private onPick: (f: TFile) => void, placeholder: string) {
		super(app);
		this.setPlaceholder(placeholder);
	}
	getItems(): TFile[] { return this.files; }
	getItemText(f: TFile): string { return f.path.replace(/\.md$/, ''); }
	onChooseItem(f: TFile): void { this.onPick(f); }
}

export class TemplatesPlugin extends CorePlugin {
	id = 'templates';
	name = 'Templates';
	description = 'Insert templates (with {{title}}, {{date}}, {{time}}) from a folder.';
	options: TemplateOptions = { folder: '', dateFormat: 'YYYY-MM-DD', timeFormat: 'HH:mm' };

	async onload(): Promise<void> {
		this.options = await this.loadOptions('templates', this.options);
		this.addCommand({
			id: 'insert-template', name: 'Templates: Insert template', icon: 'files',
			editorCheckCallback: (checking, editor, view) => {
				if (!this.options.folder) return false;
				if (checking) return true;
				const files = this.templateFiles();
				if (!files.length) new Notice(`No templates in "${this.options.folder}".`);
				else {
					new FilePicker(this.app, files, async (f) => {
						const text = applyTemplateVariables(await this.app.vault.read(f), view.file?.basename ?? '', this.options);
						editor.replaceSelection(text);
					}, 'Choose a template…').open();
				}
				return true;
			},
		});
		const fmt = (key: 'dateFormat' | 'timeFormat') => (checking: boolean, editor: any) => {
			if (!checking) editor.replaceSelection(moment().format(this.options[key]));
			return true;
		};
		this.addCommand({ id: 'insert-current-date', name: 'Templates: Insert current date', editorCheckCallback: fmt('dateFormat') });
		this.addCommand({ id: 'insert-current-time', name: 'Templates: Insert current time', editorCheckCallback: fmt('timeFormat') });
		this.addSettingTab(new OptionsTab(this.app, this.id, this.name, 'templates', this.options, [
			['folder', 'Template folder location', 'Files in this folder are available as templates.'],
			['dateFormat', 'Date format', '{{date}} format (moment.js).'],
			['timeFormat', 'Time format', '{{time}} format (moment.js).'],
		]));
	}

	templateFiles(): TFile[] {
		const folder = this.app.vault.getFolderByPath(normalizePath(this.options.folder));
		const out: TFile[] = [];
		if (folder) collect(folder, out);
		return out;
	}
}

function collect(folder: TFolder, out: TFile[]): void {
	for (const c of folder.children) {
		if (c instanceof TFile && c.extension === 'md') out.push(c);
		else if (c instanceof TFolder) collect(c, out);
	}
}

/** Read a template file and fill variables (shared by daily notes and unique notes). */
async function templateText(app: App, path: string, title: string): Promise<string> {
	if (!path) return '';
	const f = app.metadataCache.getFirstLinkpathDest(path.replace(/\.md$/, ''), '') ?? app.vault.getFileByPath(normalizePath(path));
	if (!f) {
		new Notice(`Template "${path}" not found.`);
		return '';
	}
	const t = (app.internalPlugins.getEnabledPluginById('templates') as TemplatesPlugin | null)?.options ?? { dateFormat: 'YYYY-MM-DD', timeFormat: 'HH:mm' };
	return applyTemplateVariables(await app.vault.read(f), title, t);
}

async function ensureFolder(app: App, folder: string): Promise<string> {
	const path = normalizePath(folder);
	if (path !== '/' && !app.vault.getAbstractFileByPath(path)) await app.vault.createFolder(path);
	return path === '/' ? '' : path;
}

// ---------------- Daily notes ----------------

interface DailyOptions { format: string; folder: string; template: string; autorun: boolean; }

export class DailyNotesPlugin extends CorePlugin {
	id = 'daily-notes';
	name = 'Daily notes';
	description = 'Create or open today’s note.';
	options: DailyOptions = { format: 'YYYY-MM-DD', folder: '', template: '', autorun: false };

	async onload(): Promise<void> {
		this.options = await this.loadOptions('daily-notes', this.options);
		this.addRibbonIcon('calendar-days', 'Open today’s daily note', (e) => void this.open(moment(), Keymap.isModEvent(e)));
		this.addCommand({ id: 'daily-notes', name: 'Daily notes: Open today’s daily note', icon: 'calendar-days', callback: () => void this.open(moment()) });
		this.addCommand({ id: 'daily-notes:goto-prev', name: 'Daily notes: Open previous daily note', checkCallback: (c) => this.step(-1, c) });
		this.addCommand({ id: 'daily-notes:goto-next', name: 'Daily notes: Open next daily note', checkCallback: (c) => this.step(1, c) });
		this.addSettingTab(new OptionsTab(this.app, this.id, this.name, 'daily-notes', this.options, [
			['format', 'Date format', 'Note name format (moment.js), e.g. YYYY-MM-DD or YYYY/MM/YYYY-MM-DD.'],
			['folder', 'New file location', 'Daily notes go in this folder.'],
			['template', 'Template file location', 'Path of the template for new daily notes.'],
			['autorun', 'Open daily note on startup', ''],
		]));
		if (this.options.autorun) this.app.workspace.onLayoutReady(() => void this.open(moment()));
	}

	pathFor(date: moment.Moment): string {
		const name = date.format(this.options.format || 'YYYY-MM-DD');
		return normalizePath(`${this.options.folder ? this.options.folder + '/' : ''}${name}.md`);
	}

	async open(date: moment.Moment, newLeaf: ReturnType<typeof Keymap.isModEvent> = false): Promise<void> {
		const path = this.pathFor(date);
		let file = this.app.vault.getFileByPath(path);
		if (!file) {
			const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
			if (dir) await ensureFolder(this.app, dir);
			const title = path.slice(path.lastIndexOf('/') + 1, -3);
			file = await this.app.vault.create(path, await templateText(this.app, this.options.template, title));
		}
		await this.app.workspace.getLeaf(newLeaf).openFile(file, { active: true });
	}

	/** All existing daily notes, by date. */
	private dailies(): { date: moment.Moment; file: TFile }[] {
		const out: { date: moment.Moment; file: TFile }[] = [];
		const prefix = this.options.folder ? normalizePath(this.options.folder) + '/' : '';
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (prefix && !f.path.startsWith(prefix)) continue;
			const d = moment(f.path.slice(prefix.length, -3), this.options.format, true);
			if (d.isValid()) out.push({ date: d, file: f });
		}
		return out.sort((a, b) => a.date.valueOf() - b.date.valueOf());
	}

	private step(dir: number, checking: boolean): boolean {
		const current = this.app.workspace.getActiveFile();
		const list = this.dailies();
		const i = list.findIndex((x) => x.file === current);
		const target = i >= 0 ? list[i + dir] : undefined;
		if (!target) return false;
		if (!checking) void this.app.workspace.getLeaf(false).openFile(target.file);
		return true;
	}
}

// ---------------- Unique note creator ----------------

export class UniqueNotePlugin extends CorePlugin {
	id = 'zk-prefixer';
	name = 'Unique note creator';
	description = 'Create notes named with a timestamp (Zettelkasten).';
	defaultOn = false;
	options = { format: 'YYYYMMDDHHmm', folder: '', template: '' };

	async onload(): Promise<void> {
		this.options = await this.loadOptions('zk-prefixer', this.options);
		this.addCommand({ id: 'zk-prefixer', name: 'Unique note creator: Create new unique note', icon: 'file-plus', callback: () => void this.create() });
		this.addRibbonIcon('file-plus', 'Create new unique note', () => void this.create());
		this.addSettingTab(new OptionsTab(this.app, this.id, this.name, 'zk-prefixer', this.options, [
			['format', 'Unique prefix format', 'moment.js format for the note name.'],
			['folder', 'New file location', ''],
			['template', 'Template file location', ''],
		]));
	}

	private async create(): Promise<void> {
		const dir = await ensureFolder(this.app, this.options.folder || '/');
		let name = moment().format(this.options.format);
		for (let n = 1; this.app.vault.getAbstractFileByPath(`${dir ? dir + '/' : ''}${name}.md`); n++) name = `${moment().format(this.options.format)} ${n}`;
		const file = await this.app.vault.create(`${dir ? dir + '/' : ''}${name}.md`, await templateText(this.app, this.options.template, name));
		await this.app.workspace.getLeaf(false).openFile(file, { active: true });
	}
}

// ---------------- Random note ----------------

export class RandomNotePlugin extends CorePlugin {
	id = 'random-note';
	name = 'Random note';
	description = 'Open a random note.';
	defaultOn = false;
	onload(): void {
		const open = () => {
			const files = this.app.vault.getMarkdownFiles();
			if (files.length) void this.app.workspace.getLeaf(false).openFile(files[Math.floor(Math.random() * files.length)]);
		};
		this.addCommand({ id: 'random-note', name: 'Random note: Open random note', icon: 'dice', callback: open });
		this.addRibbonIcon('dice', 'Open random note', open);
	}
}

// ---------------- Note composer ----------------

export class NoteComposerPlugin extends CorePlugin {
	id = 'note-composer';
	name = 'Note composer';
	description = 'Merge notes, or extract a selection into a new note.';
	onload(): void {
		this.addCommand({
			id: 'note-composer:merge-file', name: 'Note composer: Merge current file with another file…',
			checkCallback: (checking) => {
				const src = this.app.workspace.getActiveFile();
				if (src?.extension !== 'md') return false;
				if (!checking) {
					const targets = this.app.vault.getMarkdownFiles().filter((f) => f !== src);
					new FilePicker(this.app, targets, async (target) => {
						const text = await this.app.vault.read(src);
						await this.app.vault.append(target, `\n\n${text.replace(/^---\n[\s\S]*?\n---\n?/, '')}`);
						await this.relinkAndTrash(src, target);
						await this.app.workspace.getLeaf(false).openFile(target);
					}, `Merge "${src.basename}" into…`).open();
				}
				return true;
			},
		});
		this.addCommand({
			id: 'note-composer:split-file', name: 'Note composer: Extract current selection…',
			editorCheckCallback: (checking, editor, view) => {
				if (!editor.somethingSelected()) return false;
				if (!checking) void this.extract(editor, view.file);
				return true;
			},
		});
	}

	private async extract(editor: any, source: TFile | null): Promise<void> {
		const selection: string = editor.getSelection();
		const firstLine = selection.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').trim() ?? 'Untitled';
		const name = firstLine.replace(/[\\/:*?"<>|#^[\]]/g, '').slice(0, 80) || 'Untitled';
		const parent = this.app.fileManager.getNewFileParent(source?.path ?? '');
		const file = await this.app.fileManager.createNewMarkdownFile(parent, name, selection);
		editor.replaceSelection(this.app.fileManager.generateMarkdownLink(file, source?.path ?? ''));
	}

	/** Point links at the merged-into note, then trash the source. */
	private async relinkAndTrash(src: TFile, target: TFile): Promise<void> {
		const { metadataCache, vault } = this.app;
		for (const [path, links] of Object.entries(metadataCache.resolvedLinks)) {
			if (!links[src.path]) continue;
			const f = vault.getFileByPath(path);
			if (!f || f === src) continue;
			const newLink = metadataCache.fileToLinktext(target, path);
			await vault.process(f, (text) => text.replace(/\[\[([^\]|#]+)([^\]]*)\]\]/g, (m, link: string, rest: string) =>
				metadataCache.getFirstLinkpathDest(link, path) === src ? `[[${newLink}${rest}]]` : m));
		}
		await this.app.fileManager.trashFile(src);
	}
}

// ---------------- Slides ----------------

export class SlidesPlugin extends CorePlugin {
	id = 'slides';
	name = 'Slides';
	description = 'Present a note as slides, split by --- lines.';
	defaultOn = false;
	onload(): void {
		this.addCommand({
			id: 'slides:start', name: 'Slides: Start presentation', icon: 'presentation',
			checkCallback: (checking) => {
				const f = this.app.workspace.getActiveFile();
				if (f?.extension !== 'md') return false;
				if (!checking) void this.present(f);
				return true;
			},
		});
	}

	private async present(file: TFile): Promise<void> {
		const text = (await this.app.vault.read(file)).replace(/^---\n[\s\S]*?\n---\n?/, '');
		const slides = text.split(/^\s*---\s*$/m).map((s) => s.trim()).filter(Boolean);
		if (!slides.length) return;
		const root = document.body.createDiv('slides-container');
		const stage = root.createDiv('slides-stage markdown-rendered');
		const counter = root.createDiv('slides-counter');
		const comp = new Component();
		comp.load();
		let i = 0;
		const show = async () => {
			stage.empty();
			await MarkdownRenderer.render(this.app, slides[i], stage, file.path, comp);
			counter.setText(`${i + 1} / ${slides.length}`);
		};
		const close = () => {
			document.removeEventListener('keydown', onKey, true);
			comp.unload();
			root.remove();
			if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
		};
		const onKey = (e: KeyboardEvent) => {
			const next = ['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(e.key);
			const prev = ['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key);
			if (e.key === 'Escape') close();
			else if (next && i < slides.length - 1) { i++; void show(); }
			else if (prev && i > 0) { i--; void show(); }
			else return;
			e.preventDefault();
			e.stopPropagation();
		};
		document.addEventListener('keydown', onKey, true);
		root.addEventListener('click', (e) => {
			if ((e.target as HTMLElement).closest('a')) return;
			if (i < slides.length - 1) { i++; void show(); }
		});
		await root.requestFullscreen?.().catch(() => {}); // optional: fullscreen may be denied
		await show();
	}
}

// ---------------- Shared options tab ----------------

/** Simple settings tab bound to a .obsidian/<file>.json options object. Booleans get toggles, others text fields. */
class OptionsTab extends SettingTab {
	constructor(app: App, id: string, name: string, private file: string, private options: Record<string, any>, private fields: [string, string, string][]) {
		super(app);
		this.id = id;
		this.name = name;
	}

	display(): void {
		this.containerEl.empty();
		const save = () => void this.app.vault.writeConfigJson(this.file, this.options);
		for (const [key, name, desc] of this.fields) {
			const s = new Setting(this.containerEl).setName(name).setDesc(desc);
			if (typeof this.options[key] === 'boolean') s.addToggle((t) => t.setValue(this.options[key]).onChange((v) => { this.options[key] = v; save(); }));
			else s.addText((t) => t.setValue(String(this.options[key] ?? '')).onChange((v) => { this.options[key] = v; save(); }));
		}
	}
}
