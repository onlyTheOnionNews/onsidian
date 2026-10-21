// Persisted metadata index (PLAN §2): each note's CachedMetadata in IndexedDB, valid while the note's mtime and size
// match and the parser hasn't changed. Reopening a vault then reads and parses only the notes that changed.
// Any IndexedDB failure (blocked, private mode) just means no persistence: the index is rebuilt from the notes.
// The metadata is stored as a JSON string: IndexedDB clones one string per note far faster than a deep object
// (10k notes: 1.0 s vs 2.0 s to load).
import type { CachedMetadata } from 'obsidian';
import { PARSER_VERSION } from './parse';

export interface IndexEntry {
	path: string;
	mtime: number;
	size: number;
	v: number;
	cache: CachedMetadata;
}

export class IndexStore {
	private db: Promise<IDBDatabase | null>;

	constructor(vaultId: string) {
		this.db = new Promise((res) => {
			try {
				const req = indexedDB.open(`obsidian-online-index:${vaultId}`, 1);
				req.onupgradeneeded = () => req.result.createObjectStore('notes', { keyPath: 'path' });
				req.onsuccess = () => res(req.result);
				req.onerror = () => res(null);
			} catch {
				res(null);
			}
		});
	}

	/** Entries still valid for this parser version, by path. */
	async load(): Promise<Map<string, IndexEntry>> {
		const db = await this.db;
		if (!db) return new Map();
		const all = await new Promise<(Omit<IndexEntry, 'cache'> & { json: string })[]>((res) => {
			const req = db.transaction('notes').objectStore('notes').getAll();
			req.onsuccess = () => res(req.result);
			req.onerror = () => res([]);
		});
		const out = new Map<string, IndexEntry>();
		for (const { json, ...e } of all) if (e.v === PARSER_VERSION && typeof json === 'string') out.set(e.path, { ...e, cache: JSON.parse(json) });
		return out;
	}

	/** Write and delete in one transaction. */
	async update(put: Omit<IndexEntry, 'v'>[], remove: string[] = []): Promise<void> {
		const db = await this.db;
		if (!db || (!put.length && !remove.length)) return;
		const tx = db.transaction('notes', 'readwrite');
		const store = tx.objectStore('notes');
		for (const { cache, ...e } of put) store.put({ ...e, v: PARSER_VERSION, json: JSON.stringify(cache) });
		for (const p of remove) store.delete(p);
		await new Promise<void>((res) => {
			tx.oncomplete = tx.onerror = tx.onabort = () => res();
		});
	}
}
