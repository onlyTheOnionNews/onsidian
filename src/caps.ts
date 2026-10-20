// Capability probe (PLAN §1). Runs once at boot; features read `caps`, never sniff browsers.

// Smallest valid wasm module: magic + version.
const MIN_WASM = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

export interface Caps {
	wasm: boolean;
	workers: boolean;
	fsAccess: boolean;
	opfs: boolean;
	idb: boolean;
	persisted: boolean;
	webgl: boolean;
	serviceWorker: boolean;
	crypto: boolean;
	broadcastChannel: boolean;
	locks: boolean;
}

export let caps: Caps;

export async function probeCaps(): Promise<Caps> {
	caps = {
		wasm: probe(() => typeof WebAssembly === 'object' && WebAssembly.validate(MIN_WASM)),
		workers: typeof Worker === 'function',
		fsAccess: 'showDirectoryPicker' in globalThis,
		opfs: await probeAsync(async () => {
			const root = await navigator.storage.getDirectory();
			// Safari's main thread lacked createWritable for a while; without it we can't write → use IDB.
			const h = await root.getFileHandle('.caps-probe', { create: true });
			const ok = 'createWritable' in h;
			await root.removeEntry('.caps-probe');
			return ok;
		}),
		idb: await probeAsync(() => new Promise<boolean>((res) => {
			const req = indexedDB.open('caps-probe');
			req.onsuccess = () => { req.result.close(); res(true); };
			req.onerror = () => res(false);
		})),
		persisted: await probeAsync(async () => !!(await navigator.storage?.persisted?.())),
		webgl: probe(() => {
			const c = document.createElement('canvas');
			return !!(c.getContext('webgl2') || c.getContext('webgl'));
		}),
		serviceWorker: 'serviceWorker' in navigator && isSecureContext,
		crypto: !!globalThis.crypto?.subtle && isSecureContext,
		broadcastChannel: typeof BroadcastChannel === 'function',
		locks: !!navigator.locks,
	};
	return caps;
}

function probe(fn: () => boolean): boolean {
	try { return fn(); } catch { return false; }
}

async function probeAsync(fn: () => Promise<boolean>): Promise<boolean> {
	try { return await fn(); } catch { return false; }
}
