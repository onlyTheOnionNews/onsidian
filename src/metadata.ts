// MetadataCache (obsidian.d.ts): per-file CachedMetadata + link resolution.
// Parsing runs in a small worker pool when available, else in-process with periodic yields (PLAN §2 worker boundary).
// The index persists in IndexedDB (indexstore.ts): reopening a vault parses only notes whose mtime/size changed.
import type { CachedMetadata } from 'obsidian';
import { dirname, join } from './adapters';
import { Events } from './events';
import { IndexStore } from './indexstore';
import { getAllTags, getLinkpath, parseMetadata } from './parse';
import { TAbstractFile, TFile, Vault, normalizePath } from './vault';

type Parse = (text: string) => Promise<CachedMetadata>;

function inProcess(): Parse {
	let n = 0;
	return async (text) => {
		// Yield to the event loop every 20 notes so a big initial index doesn't freeze the UI.
		if (++n % 20 === 0) await new Promise((r) => setTimeout(r));
		return parseMetadata(text);
	};
}

function inWorker(): Parse {
	const fallback = inProcess();
	// ponytail: fixed pool of up to 4, round-robin. Parsing is ~0.25 ms/note, so more workers stop paying off.
	const size = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
	let workers: Worker[] = Array.from({ length: size }, () => new Worker(new URL('./indexer.worker.ts', import.meta.url), { type: 'module' }));
	const pending = new Map<number, { text: string; resolve: (c: CachedMetadata) => void }>();
	let nextId = 0;
	for (const w of workers) {
		w.onmessage = (e: MessageEvent<{ id: number; cache: CachedMetadata }>) => {
			pending.get(e.data.id)?.resolve(e.data.cache);
			pending.delete(e.data.id);
		};
		w.onerror = (e) => {
			if (!workers.length) return;
			// Worker blocked (CSP, broken bundle, …): finish everything in-process from now on.
			console.warn('Indexer worker failed; falling back to main thread.', e);
			for (const x of workers) x.terminate();
			workers = [];
			for (const [, p] of pending) fallback(p.text).then(p.resolve);
			pending.clear();
		};
	}
	return (text) => {
		if (!workers.length) return fallback(text);
		return new Promise((resolve) => {
			const id = nextId++;
			pending.set(id, { text, resolve });
			workers[id % workers.length].postMessage({ id, text });
		});
	};
}

export class MetadataCache extends Events {
	resolvedLinks: Record<string, Record<string, number>> = {};
	unresolvedLinks: Record<string, Record<string, number>> = {};
	private caches = new Map<string, CachedMetadata>();
	/** lowercase file name ("note.md") → files with that name, for link resolution. */
	private byName = new Map<string, TFile[]>();
	/** Link name key → notes linking to that name, so create/delete/rename re-resolve only those notes. */
	private linkers = new Map<string, Set<string>>();
	private linkKeys = new Map<string, string[]>();
	private parse: Parse;
	private ready = false;
	private store: IndexStore | null;

	constructor(private vault: Vault, useWorker: boolean, vaultId?: string) {
		super();
		this.parse = useWorker ? inWorker() : inProcess();
		this.store = vaultId && typeof indexedDB !== 'undefined' ? new IndexStore(vaultId) : null;
	}

	/** Index every markdown file (reusing the persisted index for unchanged notes), then follow vault events. */
	async initialize(): Promise<void> {
		for (const f of this.vault.getFiles()) this.addName(f);
		const stored = (await this.store?.load()) ?? new Map();
		const stale: TFile[] = [];
		const md = this.vault.getMarkdownFiles();
		for (const f of md) {
			const e = stored.get(f.path);
			if (e && e.mtime === f.stat.mtime && e.size === f.stat.size) this.caches.set(f.path, e.cache);
			else stale.push(f);
		}
		await Promise.all(stale.map((f) => this.index(f, false)));
		const live = new Set(md.map((f) => f.path));
		void this.store?.update(
			stale.filter((f) => this.caches.has(f.path)).map((f) => this.entry(f)),
			[...stored.keys()].filter((p) => !live.has(p)),
		);
		this.resolveAll();
		this.ready = true;
		this.trigger('resolved');

		this.vault.on('create', (f: TAbstractFile) => {
			if (!(f instanceof TFile)) return;
			this.addName(f);
			// A new name can resolve links in other notes: re-resolve the notes that link to that name.
			if (f.extension === 'md') void this.index(f, true, true);
			else this.resolveLinkersOf(f.path);
		});
		this.vault.on('modify', (f: TAbstractFile) => {
			if (f instanceof TFile && f.extension === 'md') void this.index(f, true);
		});
		this.vault.on('delete', (f: TAbstractFile) => {
			if (!(f instanceof TFile)) return;
			this.removeName(f);
			const prev = this.caches.get(f.path) ?? null;
			this.caches.delete(f.path);
			void this.store?.update([], [f.path]);
			this.unresolveFile(f.path);
			this.resolveLinkersOf(f.path);
			this.trigger('deleted', f, prev);
		});
		this.vault.on('rename', (f: TAbstractFile, oldPath: string) => {
			if (!(f instanceof TFile)) return;
			this.removeName(f, oldPath);
			this.addName(f);
			const c = this.caches.get(oldPath);
			this.caches.delete(oldPath);
			if (c) this.caches.set(f.path, c);
			void this.store?.update(c ? [this.entry(f)] : [], [oldPath]);
			this.unresolveFile(oldPath);
			if (c) this.resolveFile(f.path, c); // relative links resolve from the new folder
			this.resolveLinkersOf(oldPath, f.path);
		});
	}

	/** Internal Obsidian name (plugins patch or call it): re-index one file. */
	computeFileMetadataAsync(file: TFile): Promise<void> {
		return this.index(file, true);
	}

	/** Internal Obsidian name (plugins patch it): recompute link resolution for one source path. */
	resolveLinks(path: string): void {
		const cache = this.caches.get(path);
		if (cache) this.resolveFile(path, cache);
	}

	/** Internal Obsidian API: every tag in the vault with its count. */
	getTags(): Record<string, number> {
		const out: Record<string, number> = {};
		for (const cache of this.caches.values()) for (const t of getAllTags(cache) ?? []) out[t] = (out[t] ?? 0) + 1;
		return out;
	}

	getFileCache(file: TFile): CachedMetadata | null {
		return this.caches.get(file.path) ?? null;
	}

	getCache(path: string): CachedMetadata | null {
		return this.caches.get(normalizePath(path)) ?? null;
	}

	/**
	 * Resolve a link path (no #subpath) as seen from `sourcePath`. Order: exact vault path, path relative to the
	 * source's folder, then by file name (case-insensitive), preferring a match in the source's folder, then the
	 * shortest path. ponytail: approximates Obsidian's rules; revisit with fixtures from real ambiguous vaults.
	 */
	getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null {
		linkpath = getLinkpath(linkpath);
		if (!linkpath.replace(/^\//, '')) return this.vault.getFileByPath(sourcePath);
		linkpath = normalizePath(linkpath); // once; the candidates below are then already normalized
		const srcDir = dirname(sourcePath);
		for (const p of [linkpath, linkpath + '.md', join(srcDir, linkpath), join(srcDir, linkpath + '.md')]) {
			const f = this.vault.fileAt(p);
			if (f) return f;
		}
		const lower = linkpath.toLowerCase();
		const candidates = [...(this.byName.get(nameKey(lower)) ?? []), ...(this.byName.get(nameKey(lower + '.md')) ?? [])]
			.filter((f) => {
				const p = f.path.toLowerCase();
				return p === lower || p === lower + '.md' || p.endsWith('/' + lower) || p.endsWith('/' + lower + '.md');
			});
		if (!candidates.length) return null;
		return candidates.find((f) => dirname(f.path) === srcDir) ?? candidates.sort((a, b) => a.path.length - b.path.length)[0];
	}

	/** Shortest link text that resolves back to `file` (Obsidian's default "shortest path when possible"). */
	fileToLinktext(file: TFile, sourcePath: string, omitMdExtension = true): string {
		const strip = (p: string) => (omitMdExtension && file.extension === 'md' ? p.slice(0, -3) : p);
		const short = strip(file.name);
		return this.getFirstLinkpathDest(short, sourcePath) === file ? short : strip(file.path);
	}

	// ---------- internals ----------

	private async index(file: TFile, notify: boolean, structural = false): Promise<void> {
		const data = await this.vault.cachedRead(file);
		const cache = await this.parse(data);
		if (this.vault.getFileByPath(file.path) !== file) return; // deleted/renamed while parsing
		this.caches.set(file.path, cache);
		if (!notify) return;
		void this.store?.update([this.entry(file)]);
		this.resolveFile(file.path, cache);
		if (structural) this.resolveLinkersOf(file.path);
		this.trigger('changed', file, data, cache);
		this.trigger('resolve', file);
		if (this.ready) this.trigger('resolved');
	}

	private entry(f: TFile) {
		return { path: f.path, mtime: f.stat.mtime, size: f.stat.size, cache: this.caches.get(f.path)! };
	}

	/** Re-resolve the notes whose links name any of these files (their targets may have changed). */
	private resolveLinkersOf(...paths: string[]): void {
		const sources = new Set<string>();
		for (const p of paths) for (const s of this.linkers.get(linkKey(p)) ?? []) sources.add(s);
		for (const s of sources) {
			const c = this.caches.get(s);
			if (c) this.resolveFile(s, c);
		}
	}

	private unresolveFile(path: string): void {
		delete this.resolvedLinks[path];
		delete this.unresolvedLinks[path];
		for (const k of this.linkKeys.get(path) ?? []) this.linkers.get(k)?.delete(path);
		this.linkKeys.delete(path);
	}

	private resolveAll(): void {
		this.resolvedLinks = {};
		this.unresolvedLinks = {};
		for (const [path, cache] of this.caches) this.resolveFile(path, cache);
	}

	private resolveFile(path: string, cache: CachedMetadata): void {
		const resolved: Record<string, number> = {};
		const unresolved: Record<string, number> = {};
		this.unresolveFile(path);
		const keys = new Set<string>();
		for (const ref of [...(cache.links ?? []), ...(cache.embeds ?? []), ...(cache.frontmatterLinks ?? [])]) {
			const lp = getLinkpath(ref.link);
			if (!lp) continue; // [[#heading]] in the same file
			keys.add(linkKey(lp));
			const dest = this.getFirstLinkpathDest(lp, path);
			if (dest) resolved[dest.path] = (resolved[dest.path] ?? 0) + 1;
			else unresolved[lp] = (unresolved[lp] ?? 0) + 1;
		}
		this.resolvedLinks[path] = resolved;
		this.unresolvedLinks[path] = unresolved;
		this.linkKeys.set(path, [...keys]);
		for (const k of keys) {
			let set = this.linkers.get(k);
			if (!set) this.linkers.set(k, (set = new Set()));
			set.add(path);
		}
	}

	private addName(f: TFile): void {
		const k = nameKey(f.path);
		const list = this.byName.get(k) ?? [];
		if (!list.includes(f)) list.push(f);
		this.byName.set(k, list);
	}

	private removeName(f: TFile, path = f.path): void {
		const list = this.byName.get(nameKey(path));
		const i = list?.indexOf(f) ?? -1;
		if (i >= 0) list!.splice(i, 1);
	}
}

const nameKey = (path: string) => path.slice(path.lastIndexOf('/') + 1).toLowerCase();
/** Name a link refers to, comparable with a file's: "Folder/Note.md", "note" and "../note" all give "note". */
const linkKey = (path: string) => nameKey(path).replace(/\.md$/, '');
