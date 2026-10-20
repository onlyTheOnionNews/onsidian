// Known vaults + adapter selection (PLAN §5.1 adapter chain): FsAccess folder → OPFS → IndexedDB → memory.
import { HandleAdapter, IdbBackend, KvAdapter, MemBackend, type BaseAdapter } from './adapters';
import type { Caps } from './caps';

export type VaultKind = 'fs' | 'opfs' | 'idb' | 'mem';

export interface VaultEntry {
	id: string;
	name: string;
	kind: VaultKind;
	handle?: FileSystemDirectoryHandle;
	/** Files seen at last open/close; lets us notice storage the browser cleared behind our back. */
	fileCount?: number;
}

/** Vault list lives in its own IndexedDB store (handles are structured-cloneable; localStorage can't hold them). */
const registry = vaultStore();

function vaultStore() {
	let db: Promise<IDBDatabase> | null = null;
	const open = () => (db ??= new Promise((res, rej) => {
		const req = indexedDB.open('obsidian-online', 1);
		req.onupgradeneeded = () => req.result.createObjectStore('vaults', { keyPath: 'id' });
		req.onsuccess = () => res(req.result);
		req.onerror = () => rej(req.error);
	}));
	const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => {
		const store = (await open()).transaction('vaults', mode).objectStore('vaults');
		return new Promise<T>((res, rej) => {
			const req = fn(store);
			req.onsuccess = () => res(req.result);
			req.onerror = () => rej(req.error);
		});
	};
	return {
		list: () => run<VaultEntry[]>('readonly', (s) => s.getAll()),
		put: (v: VaultEntry) => run('readwrite', (s) => s.put(v)),
		del: (id: string) => run('readwrite', (s) => s.delete(id)),
	};
}

export async function listVaults(caps: Caps): Promise<VaultEntry[]> {
	if (!caps.idb) return [];
	try {
		return await registry.list();
	} catch {
		return [];
	}
}

export async function rememberFileCount(v: VaultEntry, count: number): Promise<void> {
	if (v.kind === 'mem' || v.fileCount === count) return;
	v.fileCount = count;
	await registry.put(v).catch(() => {});
}

export async function forgetVault(id: string): Promise<void> {
	await registry.del(id);
}

/** Browser-storage kind this browser supports best (memory when storage is blocked entirely). */
export function browserVaultKind(caps: Caps): VaultKind {
	return caps.opfs ? 'opfs' : caps.idb ? 'idb' : 'mem';
}

export async function addFolderVault(): Promise<VaultEntry> {
	const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite', id: 'obsidian-online-vault' }) as FileSystemDirectoryHandle;
	const entry: VaultEntry = { id: crypto.randomUUID(), name: handle.name, kind: 'fs', handle };
	await registry.put(entry);
	return entry;
}

export async function addBrowserVault(name: string, kind: VaultKind): Promise<VaultEntry> {
	const entry: VaultEntry = { id: crypto.randomUUID(), name, kind };
	if (kind !== 'mem') await registry.put(entry);
	return entry;
}

/** Must run inside a user gesture for 'fs' vaults: the browser re-asks folder permission each session. */
export async function openAdapter(v: VaultEntry): Promise<BaseAdapter> {
	switch (v.kind) {
		case 'fs': {
			const h = v.handle as any;
			if ((await h.queryPermission({ mode: 'readwrite' })) !== 'granted' && (await h.requestPermission({ mode: 'readwrite' })) !== 'granted') {
				throw new Error('Permission to the vault folder was denied.');
			}
			return new HandleAdapter(v.handle!, v.name);
		}
		case 'opfs': {
			const vaults = await (await navigator.storage.getDirectory()).getDirectoryHandle('vaults', { create: true });
			return new HandleAdapter(await vaults.getDirectoryHandle(v.id, { create: true }), v.name);
		}
		case 'idb':
			return new KvAdapter(new IdbBackend(`vault:${v.id}`), v.name);
		case 'mem':
			return new KvAdapter(new MemBackend(), v.name);
	}
}

/**
 * One tab per vault (PLAN §2), so two tabs never overwrite each other. A second tab can take the vault over: it asks
 * the owner over a BroadcastChannel, the owner flushes its saves and releases the Web Lock, then the new tab gets it.
 * Without Web Locks we can't tell tabs apart, so the vault opens anyway.
 */
export interface VaultLock {
	release(): void;
}

export class VaultBusyError extends Error {
	constructor(name: string) {
		super(`"${name}" is open in another tab.`);
	}
}

function requestLock(id: string, ifAvailable: boolean): Promise<VaultLock | null> {
	if (!navigator.locks) return Promise.resolve({ release() {} });
	return new Promise((resolve) => {
		void navigator.locks.request(`vault:${id}`, { ifAvailable }, (lock) => {
			if (!lock) {
				resolve(null);
				return undefined;
			}
			// Held until release(): the lock lives as long as this promise is pending.
			return new Promise<void>((done) => resolve({ release: done }));
		});
	});
}

export const lockVault = (id: string) => requestLock(id, true);

const channel = (id: string) => (typeof BroadcastChannel === 'function' ? new BroadcastChannel(`obsidian-online:vault:${id}`) : null);

/** Ask the tab holding the vault to hand it over, then wait for the lock. */
export async function takeOverVault(id: string): Promise<VaultLock> {
	const ch = channel(id);
	ch?.postMessage({ type: 'takeover' });
	ch?.close();
	return (await requestLock(id, false))!;
}

/** In the owning tab: call `onTakeover` when another tab asks for the vault. */
export function onTakeoverRequest(id: string, onTakeover: () => void): void {
	const ch = channel(id);
	if (ch) ch.onmessage = (e) => e.data?.type === 'takeover' && onTakeover();
}
