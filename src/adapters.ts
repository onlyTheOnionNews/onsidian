// DataAdapter implementations (PLAN §5.1). All speak vault-relative normalized paths ('' = root).
//   HandleAdapter: File System Access folder (real disk, Chromium) or OPFS (all modern browsers) — same handle API.
//   KvAdapter:     IndexedDB (fallback) or in-memory Map (last resort).
// Everything above the primitives (text, append, process, copy, rename, trash) is shared in BaseAdapter.
import type { DataAdapter, DataWriteOptions, ListedFiles, Stat } from 'obsidian';

const enc = new TextEncoder();
const dec = new TextDecoder();

export function dirname(path: string): string {
	const i = path.lastIndexOf('/');
	return i < 0 ? '' : path.slice(0, i);
}

export function basename(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

export function join(dir: string, name: string): string {
	return dir ? `${dir}/${name}` : name;
}

export abstract class BaseAdapter implements DataAdapter {
	abstract getName(): string;
	abstract stat(path: string): Promise<Stat | null>;
	abstract list(path: string): Promise<ListedFiles>;
	abstract readBinary(path: string): Promise<ArrayBuffer>;
	abstract writeBinary(path: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void>;
	abstract mkdir(path: string): Promise<void>;
	/** Remove a file, or a folder (and contents when recursive). */
	protected abstract removeEntry(path: string, recursive: boolean): Promise<void>;

	async exists(path: string): Promise<boolean> {
		return (await this.stat(path)) !== null;
	}

	/** list() plus every file's stat, in one pass where the backend allows (the vault scan uses this). */
	async listWithStats(path: string): Promise<{ files: [string, Stat][]; folders: string[] }> {
		const l = await this.list(path);
		const files = await Promise.all(l.files.map(async (p) => [p, await this.stat(p)] as const));
		return { folders: l.folders, files: files.filter((x): x is [string, Stat] => !!x[1]) };
	}

	async read(path: string): Promise<string> {
		return dec.decode(await this.readBinary(path));
	}

	write(path: string, data: string, options?: DataWriteOptions): Promise<void> {
		return this.writeBinary(path, enc.encode(data).buffer as ArrayBuffer, options);
	}

	async append(path: string, data: string, options?: DataWriteOptions): Promise<void> {
		const old = (await this.exists(path)) ? await this.read(path) : '';
		await this.write(path, old + data, options);
	}

	async appendBinary(path: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
		const old = (await this.exists(path)) ? new Uint8Array(await this.readBinary(path)) : new Uint8Array();
		const out = new Uint8Array(old.length + data.byteLength);
		out.set(old);
		out.set(new Uint8Array(data), old.length);
		await this.writeBinary(path, out.buffer, options);
	}

	async process(path: string, fn: (data: string) => string, options?: DataWriteOptions): Promise<string> {
		const out = fn(await this.read(path));
		await this.write(path, out, options);
		return out;
	}

	// ponytail: no stable resource URLs yet (needs a Service Worker route); embeds land in phase 2.
	getResourcePath(_path: string): string {
		return '';
	}

	async rmdir(path: string, recursive: boolean): Promise<void> {
		if (!recursive) {
			const l = await this.list(path);
			if (l.files.length || l.folders.length) throw new Error(`Folder not empty: ${path}`);
		}
		await this.removeEntry(path, true);
	}

	remove(path: string): Promise<void> {
		return this.removeEntry(path, false);
	}

	async copy(from: string, to: string): Promise<void> {
		const st = await this.stat(from);
		if (!st) throw new Error(`Not found: ${from}`);
		if (await this.exists(to)) throw new Error(`Destination exists: ${to}`);
		if (st.type === 'file') return this.writeBinary(to, await this.readBinary(from));
		await this.mkdir(to);
		const l = await this.list(from);
		for (const p of [...l.files, ...l.folders]) await this.copy(p, join(to, basename(p)));
	}

	// ponytail: rename = copy + delete. FileSystemHandle.move() is faster where supported; switch when rename speed matters.
	async rename(from: string, to: string): Promise<void> {
		if (from === to) return;
		const st = await this.stat(from);
		await this.copy(from, to);
		await this.removeEntry(from, st?.type === 'folder');
	}

	// The web has no OS trash.
	async trashSystem(_path: string): Promise<boolean> {
		return false;
	}

	async trashLocal(path: string): Promise<void> {
		await this.mkdir('.trash');
		let target = join('.trash', basename(path));
		for (let n = 1; await this.exists(target); n++) target = join('.trash', `${basename(path)} ${n}`);
		await this.rename(path, target);
	}
}

// ---------- File System Access / OPFS ----------

export class HandleAdapter extends BaseAdapter {
	constructor(private root: FileSystemDirectoryHandle, private name: string) {
		super();
	}

	getName(): string {
		return this.name;
	}

	private parts(path: string): string[] {
		return path.split('/').filter(Boolean);
	}

	private async dir(path: string, create = false): Promise<FileSystemDirectoryHandle> {
		let h = this.root;
		for (const p of this.parts(path)) h = await h.getDirectoryHandle(p, { create });
		return h;
	}

	/** File handles by path (from scans and lookups), so reads don't re-walk the folders from the root. Handles are
	 * locators: a cached one for a since-deleted path fails like a fresh lookup would. */
	private handles = new Map<string, FileSystemFileHandle>();

	private async fileHandle(path: string, create = false): Promise<FileSystemFileHandle> {
		const cached = this.handles.get(path);
		if (cached) return cached;
		const h = await (await this.dir(dirname(path), create)).getFileHandle(basename(path), { create });
		this.handles.set(path, h);
		return h;
	}

	async stat(path: string): Promise<Stat | null> {
		if (!this.parts(path).length) return { type: 'folder', ctime: 0, mtime: 0, size: 0 };
		let parent: FileSystemDirectoryHandle;
		try {
			parent = await this.dir(dirname(path));
		} catch {
			return null;
		}
		const name = basename(path);
		try {
			const f = await (await parent.getFileHandle(name)).getFile();
			// The web exposes no creation time; ctime mirrors mtime.
			return { type: 'file', ctime: f.lastModified, mtime: f.lastModified, size: f.size };
		} catch {}
		try {
			await parent.getDirectoryHandle(name);
			return { type: 'folder', ctime: 0, mtime: 0, size: 0 };
		} catch {
			return null;
		}
	}

	async list(path: string): Promise<ListedFiles> {
		const out: ListedFiles = { files: [], folders: [] };
		for await (const [name, h] of (await this.dir(path)) as any as AsyncIterable<[string, FileSystemHandle]>) {
			(h.kind === 'file' ? out.files : out.folders).push(join(path, name));
		}
		return out;
	}

	/** Stats come straight from the directory's handles instead of re-walking from the root per file. */
	async listWithStats(path: string): Promise<{ files: [string, Stat][]; folders: string[] }> {
		const files: Promise<[string, Stat]>[] = [];
		const folders: string[] = [];
		for await (const [name, h] of (await this.dir(path)) as any as AsyncIterable<[string, FileSystemHandle]>) {
			const p = join(path, name);
			if (h.kind === 'directory') folders.push(p);
			else this.handles.set(p, h as FileSystemFileHandle), files.push((h as FileSystemFileHandle).getFile().then((f) => [p, { type: 'file', ctime: f.lastModified, mtime: f.lastModified, size: f.size }]));
		}
		return { files: await Promise.all(files), folders };
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		return (await (await this.fileHandle(path)).getFile()).arrayBuffer();
	}

	// ponytail: options.mtime/ctime ignored — handles can't set timestamps.
	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		const w = await (await this.fileHandle(path, true)).createWritable();
		await w.write(data);
		await w.close();
	}

	async mkdir(path: string): Promise<void> {
		await this.dir(path, true);
	}

	protected async removeEntry(path: string, recursive: boolean): Promise<void> {
		await (await this.dir(dirname(path))).removeEntry(basename(path), { recursive });
		for (const p of this.handles.keys()) if (p === path || p.startsWith(`${path}/`)) this.handles.delete(p);
	}
}

// ---------- Key-value backends (IndexedDB, memory) ----------

interface Rec {
	type: 'file' | 'folder';
	data?: ArrayBuffer;
	ctime: number;
	mtime: number;
}

export interface KvBackend {
	get(key: string): Promise<Rec | undefined>;
	put(key: string, rec: Rec): Promise<void>;
	del(key: string): Promise<void>;
	keys(): Promise<string[]>;
}

export class MemBackend implements KvBackend {
	private m = new Map<string, Rec>();
	async get(k: string) { return this.m.get(k); }
	async put(k: string, r: Rec) { this.m.set(k, r); }
	async del(k: string) { this.m.delete(k); }
	async keys() { return [...this.m.keys()]; }
}

export class IdbBackend implements KvBackend {
	private db: Promise<IDBDatabase>;

	constructor(dbName: string) {
		this.db = new Promise((res, rej) => {
			const req = indexedDB.open(dbName, 1);
			req.onupgradeneeded = () => req.result.createObjectStore('files');
			req.onsuccess = () => res(req.result);
			req.onerror = () => rej(req.error);
		});
	}

	private async run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
		const store = (await this.db).transaction('files', mode).objectStore('files');
		return new Promise((res, rej) => {
			const req = fn(store);
			req.onsuccess = () => res(req.result);
			req.onerror = () => rej(req.error);
		});
	}

	get(k: string) { return this.run<Rec | undefined>('readonly', (s) => s.get(k)); }
	async put(k: string, r: Rec) { await this.run('readwrite', (s) => s.put(r, k)); }
	async del(k: string) { await this.run('readwrite', (s) => s.delete(k)); }
	async keys() { return (await this.run('readonly', (s) => s.getAllKeys())) as string[]; }
}

export class KvAdapter extends BaseAdapter {
	constructor(private kv: KvBackend, private name: string) {
		super();
	}

	getName(): string {
		return this.name;
	}

	async stat(path: string): Promise<Stat | null> {
		if (!path) return { type: 'folder', ctime: 0, mtime: 0, size: 0 };
		const r = await this.kv.get(path);
		return r ? { type: r.type, ctime: r.ctime, mtime: r.mtime, size: r.data?.byteLength ?? 0 } : null;
	}

	// ponytail: O(total keys) per call. Fine to ~10k files; keep a parent→children index if vault load gets slow.
	async list(path: string): Promise<ListedFiles> {
		const out: ListedFiles = { files: [], folders: [] };
		for (const k of await this.kv.keys()) {
			if (dirname(k) !== path || !k) continue;
			const r = await this.kv.get(k);
			(r?.type === 'file' ? out.files : out.folders).push(k);
		}
		return out;
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		const r = await this.kv.get(path);
		if (r?.type !== 'file') throw new Error(`Not a file: ${path}`);
		return r.data!.slice(0);
	}

	async writeBinary(path: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
		await this.mkdir(dirname(path));
		const old = await this.kv.get(path);
		const now = Date.now();
		await this.kv.put(path, {
			type: 'file',
			data: data.slice(0),
			ctime: options?.ctime ?? old?.ctime ?? now,
			mtime: options?.mtime ?? now,
		});
	}

	async mkdir(path: string): Promise<void> {
		if (!path || (await this.kv.get(path))) return;
		await this.mkdir(dirname(path));
		const now = Date.now();
		await this.kv.put(path, { type: 'folder', ctime: now, mtime: now });
	}

	protected async removeEntry(path: string, recursive: boolean): Promise<void> {
		if (recursive) for (const k of await this.kv.keys()) if (k.startsWith(path + '/')) await this.kv.del(k);
		await this.kv.del(path);
	}
}
