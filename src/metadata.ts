// MetadataCache (obsidian.d.ts): per-file CachedMetadata + link resolution.
// Parsing runs in a worker when available, else in-process with periodic yields (PLAN §2 worker boundary).
// ponytail: no persistent index — every load re-parses all notes. Persist to IDB keyed by mtime+size when cold start gets slow.
import type { CachedMetadata } from 'obsidian';
import { dirname, join } from './adapters';
import { Events } from './events';
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
	let worker: Worker | null = new Worker(new URL('./indexer.worker.ts', import.meta.url), { type: 'module' });
	const pending = new Map<number, { text: string; resolve: (c: CachedMetadata) => void }>();
	let nextId = 0;
	worker.onmessage = (e: MessageEvent<{ id: number; cache: CachedMetadata }>) => {
		pending.get(e.data.id)?.resolve(e.data.cache);
		pending.delete(e.data.id);
	};
	worker.onerror = (e) => {
		// Worker blocked (CSP, broken bundle, …): finish everything in-process from now on.
		console.warn('Indexer worker failed; falling back to main thread.', e);
		worker?.terminate();
		worker = null;
		for (const [, p] of pending) fallback(p.text).then(p.resolve);
		pending.clear();
	};
	return (text) => {
		if (!worker) return fallback(text);
		return new Promise((resolve) => {
			const id = nextId++;
			pending.set(id, { text, resolve });
			worker!.postMessage({ id, text });
		});
	};
}

export class MetadataCache extends Events {
	resolvedLinks: Record<string, Record<string, number>> = {};
	unresolvedLinks: Record<string, Record<string, number>> = {};
	private caches = new Map<string, CachedMetadata>();
	/** lowercase file name ("note.md") → files with that name, for link resolution. */
	private byName = new Map<string, TFile[]>();
	private parse: Parse;
	private ready = false;

	constructor(private vault: Vault, useWorker: boolean) {
		super();
		this.parse = useWorker ? inWorker() : inProcess();
	}

	/** Index every markdown file, then start following vault events. */
	async initialize(): Promise<void> {
		for (const f of this.vault.getFiles()) this.addName(f);
		await Promise.all(this.vault.getMarkdownFiles().map((f) => this.index(f, false)));
		this.resolveAll();
		this.ready = true;
		this.trigger('resolved');

		this.vault.on('create', (f: TAbstractFile) => {
			if (!(f instanceof TFile)) return;
			this.addName(f);
			// A new name can resolve links in other notes, so creation re-resolves everything.
			if (f.extension === 'md') void this.index(f, true, true);
			else this.resolveAll();
		});
		this.vault.on('modify', (f: TAbstractFile) => {
			if (f instanceof TFile && f.extension === 'md') void this.index(f, true);
		});
		this.vault.on('delete', (f: TAbstractFile) => {
			if (!(f instanceof TFile)) return;
			this.removeName(f);
			const prev = this.caches.get(f.path) ?? null;
			this.caches.delete(f.path);
			this.resolveAll();
			this.trigger('deleted', f, prev);
		});
		this.vault.on('rename', (f: TAbstractFile, oldPath: string) => {
			if (!(f instanceof TFile)) return;
			this.removeName(f, oldPath);
			this.addName(f);
			const c = this.caches.get(oldPath);
			this.caches.delete(oldPath);
			if (c) this.caches.set(f.path, c);
			this.resolveAll();
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
		linkpath = getLinkpath(linkpath).replace(/^\//, '');
		if (!linkpath) return this.vault.getFileByPath(sourcePath);
		const srcDir = dirname(sourcePath);
		for (const p of [linkpath, linkpath + '.md', join(srcDir, linkpath), join(srcDir, linkpath + '.md')]) {
			const f = this.vault.getFileByPath(p);
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
		if (structural) this.resolveAll();
		else this.resolveFile(file.path, cache);
		this.trigger('changed', file, data, cache);
		this.trigger('resolve', file);
		if (this.ready) this.trigger('resolved');
	}

	// ponytail: recomputes every file's links on structural changes — O(total links). Fine to ~10k notes;
	// track reverse "who links to name X" if create/delete/rename gets slow.
	private resolveAll(): void {
		this.resolvedLinks = {};
		this.unresolvedLinks = {};
		for (const [path, cache] of this.caches) this.resolveFile(path, cache);
	}

	private resolveFile(path: string, cache: CachedMetadata): void {
		const resolved: Record<string, number> = {};
		const unresolved: Record<string, number> = {};
		for (const ref of [...(cache.links ?? []), ...(cache.embeds ?? []), ...(cache.frontmatterLinks ?? [])]) {
			const lp = getLinkpath(ref.link);
			if (!lp) continue; // [[#heading]] in the same file
			const dest = this.getFirstLinkpathDest(lp, path);
			if (dest) resolved[dest.path] = (resolved[dest.path] ?? 0) + 1;
			else unresolved[lp] = (unresolved[lp] ?? 0) + 1;
		}
		this.resolvedLinks[path] = resolved;
		this.unresolvedLinks[path] = unresolved;
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
