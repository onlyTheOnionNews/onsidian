// Vault + TAbstractFile/TFile/TFolder (obsidian.d.ts). In-memory tree mirrored from a DataAdapter.
import type { DataWriteOptions, FileStats } from 'obsidian';
import { BaseAdapter, basename, dirname, join } from './adapters';
import { Events, debounce } from './events';

export function normalizePath(path: string): string {
	path = path.replace(/[\\  ]/g, (c) => (c === '\\' ? '/' : ' ')).replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
	return path.normalize('NFC') || '/';
}

export abstract class TAbstractFile {
	vault!: Vault;
	path = '';
	name = '';
	parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
	stat: FileStats = { ctime: 0, mtime: 0, size: 0 };
	basename = '';
	extension = '';
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
	isRoot(): boolean {
		return this.path === '/';
	}
}

function setPath(f: TAbstractFile, path: string): void {
	f.path = path;
	f.name = path === '/' ? '' : basename(path);
	if (f instanceof TFile) {
		const dot = f.name.lastIndexOf('.');
		f.basename = dot > 0 ? f.name.slice(0, dot) : f.name;
		f.extension = dot > 0 ? f.name.slice(dot + 1) : '';
	}
}

/** Defaults for .obsidian/app.json + appearance.json keys (Obsidian's names, so vault folders stay interchangeable). */
export const DEFAULT_CONFIG: Record<string, unknown> = {
	// app.json
	readableLineLength: true,
	spellcheck: true,
	defaultViewMode: 'source',
	livePreview: true,
	showLineNumber: false,
	foldHeading: true,
	foldIndent: true,
	strictLineBreaks: false,
	propertiesInDocument: 'visible',
	newLinkFormat: 'shortest',
	useMarkdownLinks: false,
	alwaysUpdateLinks: true,
	newFileLocation: 'root',
	newFileFolderPath: '/',
	attachmentFolderPath: '/',
	promptDelete: true,
	trashOption: 'local',
	// appearance.json
	theme: 'system',
	accentColor: '',
	baseFontSize: 16,
	interfaceFontFamily: '',
	textFontFamily: '',
	monospaceFontFamily: '',
	cssTheme: '',
	enabledCssSnippets: [],
};

const APPEARANCE_KEYS = new Set(['theme', 'accentColor', 'baseFontSize', 'interfaceFontFamily', 'textFontFamily', 'monospaceFontFamily', 'cssTheme', 'enabledCssSnippets']);

export class Vault extends Events {
	configDir = '.obsidian';
	/** Merged app.json + appearance.json, as read from disk (defaults are applied by getConfig). */
	config: Record<string, unknown> = {};
	private files = new Map<string, TAbstractFile>();
	private root: TFolder;
	private contentCache = new Map<string, string>();

	constructor(public adapter: BaseAdapter) {
		super();
		this.root = new TFolder();
		this.root.vault = this;
		setPath(this.root, '/');
		this.files.set('/', this.root);
	}

	getName(): string {
		return this.adapter.getName();
	}

	// ---------- .obsidian config (internal API in Obsidian; plugins and Relay use getConfig/setConfig) ----------

	async readConfigJson(name: string): Promise<Record<string, any> | null> {
		const path = `${this.configDir}/${name}.json`;
		try {
			return (await this.adapter.exists(path)) ? JSON.parse(await this.adapter.read(path)) : null;
		} catch (e) {
			console.warn(`Ignoring unreadable ${path}`, e);
			return null;
		}
	}

	async writeConfigJson(name: string, data: unknown): Promise<void> {
		await this.adapter.mkdir(this.configDir);
		await this.adapter.write(`${this.configDir}/${name}.json`, JSON.stringify(data, null, 2));
	}

	async loadConfig(): Promise<void> {
		this.config = { ...(await this.readConfigJson('app')), ...(await this.readConfigJson('appearance')) };
	}

	getConfig(key: string): any {
		return key in this.config ? this.config[key] : DEFAULT_CONFIG[key];
	}

	setConfig(key: string, value: unknown): void {
		if (value === undefined || value === DEFAULT_CONFIG[key]) delete this.config[key];
		else this.config[key] = value;
		this.saveConfig();
		this.trigger('config-changed', key);
	}

	private saveConfig = debounce(async () => {
		const app: Record<string, unknown> = {};
		const appearance: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(this.config)) (APPEARANCE_KEYS.has(k) ? appearance : app)[k] = v;
		await this.writeConfigJson('app', app);
		await this.writeConfigJson('appearance', appearance);
	}, 500);

	/** Build the tree from storage. Triggers 'create' per item, as Obsidian does on first load. */
	async load(): Promise<void> {
		const walk = async (dir: string) => {
			const l = await this.adapter.list(dir);
			for (const p of l.folders) {
				if (isHidden(p)) continue;
				this.attach(new TFolder(), p);
				await walk(p);
			}
			for (const p of l.files) {
				if (isHidden(p)) continue;
				const f = this.attach(new TFile(), p) as TFile;
				await this.refreshStat(f);
			}
		};
		await walk('');
		for (const f of this.files.values()) if (f !== this.root) this.trigger('create', f);
	}

	/**
	 * Pick up changes made outside the app (FsAccess folders edited by desktop Obsidian, etc.).
	 * ponytail: full rescan with stat per file; the FileSystemObserver API can replace it where supported.
	 */
	async rescan(): Promise<void> {
		const seen = new Set<string>(['/']);
		const walk = async (dir: string) => {
			const l = await this.adapter.list(dir);
			for (const p of l.folders) {
				if (isHidden(p)) continue;
				seen.add(p);
				if (!this.files.has(p)) this.trigger('create', this.attach(new TFolder(), p));
				await walk(p);
			}
			for (const p of l.files) {
				if (isHidden(p)) continue;
				seen.add(p);
				const existing = this.files.get(p);
				if (!existing) {
					const f = this.attach(new TFile(), p) as TFile;
					await this.refreshStat(f);
					this.trigger('create', f);
				} else if (existing instanceof TFile) {
					const before = existing.stat.mtime;
					await this.refreshStat(existing);
					if (existing.stat.mtime !== before) {
						this.contentCache.delete(p);
						this.trigger('modify', existing);
					}
				}
			}
		};
		await walk('');
		for (const [p, f] of [...this.files]) if (!seen.has(p) && this.files.has(p)) this.forget(f);
	}

	// ---------- lookup ----------

	getAbstractFileByPath(path: string): TAbstractFile | null {
		return this.files.get(normalizePath(path)) ?? null;
	}

	getFileByPath(path: string): TFile | null {
		const f = this.getAbstractFileByPath(path);
		return f instanceof TFile ? f : null;
	}

	getFolderByPath(path: string): TFolder | null {
		const f = this.getAbstractFileByPath(path);
		return f instanceof TFolder ? f : null;
	}

	getRoot(): TFolder {
		return this.root;
	}

	getAllLoadedFiles(): TAbstractFile[] {
		return [...this.files.values()];
	}

	getAllFolders(includeRoot = false): TFolder[] {
		return [...this.files.values()].filter((f): f is TFolder => f instanceof TFolder && (includeRoot || f !== this.root));
	}

	getFiles(): TFile[] {
		return [...this.files.values()].filter((f): f is TFile => f instanceof TFile);
	}

	getMarkdownFiles(): TFile[] {
		return this.getFiles().filter((f) => f.extension === 'md');
	}

	static recurseChildren(root: TFolder, cb: (file: TAbstractFile) => any): void {
		cb(root);
		for (const c of root.children) c instanceof TFolder ? Vault.recurseChildren(c, cb) : cb(c);
	}

	// ---------- read ----------

	async read(file: TFile): Promise<string> {
		const data = await this.adapter.read(file.path);
		this.contentCache.set(file.path, data);
		return data;
	}

	async cachedRead(file: TFile): Promise<string> {
		return this.contentCache.get(file.path) ?? this.read(file);
	}

	readBinary(file: TFile): Promise<ArrayBuffer> {
		return this.adapter.readBinary(file.path);
	}

	getResourcePath(file: TFile): string {
		return this.adapter.getResourcePath(file.path);
	}

	// ---------- write ----------

	async create(path: string, data: string, options?: DataWriteOptions): Promise<TFile> {
		path = this.checkNew(path);
		await this.adapter.write(path, data, options);
		this.contentCache.set(path, data);
		return this.created(path);
	}

	async createBinary(path: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<TFile> {
		path = this.checkNew(path);
		await this.adapter.writeBinary(path, data, options);
		return this.created(path);
	}

	async createFolder(path: string): Promise<TFolder> {
		path = this.checkNew(path);
		await this.adapter.mkdir(path);
		await this.ensureParents(path);
		const f = this.attach(new TFolder(), path) as TFolder;
		this.trigger('create', f);
		return f;
	}

	async modify(file: TFile, data: string, options?: DataWriteOptions): Promise<void> {
		await this.adapter.write(file.path, data, options);
		this.contentCache.set(file.path, data);
		await this.modified(file);
	}

	async modifyBinary(file: TFile, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
		await this.adapter.writeBinary(file.path, data, options);
		this.contentCache.delete(file.path);
		await this.modified(file);
	}

	async append(file: TFile, data: string, options?: DataWriteOptions): Promise<void> {
		await this.modify(file, (await this.read(file)) + data, options);
	}

	async appendBinary(file: TFile, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
		await this.adapter.appendBinary(file.path, data, options);
		this.contentCache.delete(file.path);
		await this.modified(file);
	}

	async process(file: TFile, fn: (data: string) => string, options?: DataWriteOptions): Promise<string> {
		const out = fn(await this.read(file));
		await this.modify(file, out, options);
		return out;
	}

	async copy<T extends TAbstractFile>(file: T, newPath: string): Promise<T> {
		newPath = this.checkNew(newPath);
		await this.adapter.copy(file.path, newPath);
		if (file instanceof TFile) return (await this.created(newPath)) as unknown as T;
		await this.ensureParents(newPath);
		const folder = this.attach(new TFolder(), newPath) as TFolder;
		this.trigger('create', folder);
		await this.rescan(); // picks up the copied children
		return folder as unknown as T;
	}

	async rename(file: TAbstractFile, newPath: string): Promise<void> {
		newPath = this.checkNew(newPath);
		await this.adapter.rename(file.path, newPath);
		await this.ensureParents(newPath);
		// Re-key the item and every descendant, then fire 'rename' for each, parent first.
		const moved: [TAbstractFile, string][] = [];
		const walk = (f: TAbstractFile, path: string) => {
			moved.push([f, f.path]);
			this.files.delete(f.path);
			const cached = this.contentCache.get(f.path);
			this.contentCache.delete(f.path);
			setPath(f, path);
			this.files.set(path, f);
			if (cached !== undefined) this.contentCache.set(path, cached);
			if (f instanceof TFolder) for (const c of f.children) walk(c, join(path, c.name));
		};
		this.detachFromParent(file);
		walk(file, newPath);
		this.attachToParent(file);
		for (const [f, old] of moved) this.trigger('rename', f, old);
	}

	async delete(file: TAbstractFile, _force?: boolean): Promise<void> {
		if (file instanceof TFolder) await this.adapter.rmdir(file.path, true);
		else await this.adapter.remove(file.path);
		this.forget(file);
	}

	async trash(file: TAbstractFile, system: boolean): Promise<void> {
		if (!(system && (await this.adapter.trashSystem(file.path)))) await this.adapter.trashLocal(file.path);
		this.forget(file);
	}

	// ---------- internals ----------

	private checkNew(path: string): string {
		path = normalizePath(path);
		if (this.files.has(path)) throw new Error('File already exists.');
		return path;
	}

	private async created(path: string): Promise<TFile> {
		await this.ensureParents(path);
		const f = this.attach(new TFile(), path) as TFile;
		await this.refreshStat(f);
		this.trigger('create', f);
		return f;
	}

	private async modified(file: TFile): Promise<void> {
		await this.refreshStat(file);
		this.trigger('modify', file);
	}

	/** Parents created implicitly by the adapter get TFolders (and 'create' events). */
	private async ensureParents(path: string): Promise<void> {
		const dir = dirname(path);
		if (!dir || this.files.has(dir)) return;
		await this.ensureParents(dir);
		this.trigger('create', this.attach(new TFolder(), dir));
	}

	private async refreshStat(f: TFile): Promise<void> {
		const st = await this.adapter.stat(f.path);
		if (st) f.stat = { ctime: st.ctime, mtime: st.mtime, size: st.size };
	}

	private attach(f: TAbstractFile, path: string): TAbstractFile {
		f.vault = this;
		setPath(f, path);
		this.files.set(path, f);
		this.attachToParent(f);
		return f;
	}

	private attachToParent(f: TAbstractFile): void {
		const parent = this.files.get(dirname(f.path) || '/') as TFolder;
		f.parent = parent;
		parent.children.push(f);
	}

	private detachFromParent(f: TAbstractFile): void {
		const siblings = f.parent?.children ?? [];
		const i = siblings.indexOf(f);
		if (i >= 0) siblings.splice(i, 1);
	}

	/** Drop an item (and descendants) from the tree; 'delete' fires children first. */
	private forget(f: TAbstractFile): void {
		if (f instanceof TFolder) for (const c of [...f.children]) this.forget(c);
		this.detachFromParent(f);
		this.files.delete(f.path);
		this.contentCache.delete(f.path);
		this.trigger('delete', f);
	}
}

/** Dot-files/folders (incl. .obsidian, .trash) are not part of the vault tree, as in Obsidian. */
function isHidden(path: string): boolean {
	return basename(path).startsWith('.');
}
