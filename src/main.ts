// Boot: DOM helpers → theme → capability probe → vault picker → App.
import './dom';
import './theme.css';
import './ui.css';
import './markdown.css';
import { App } from './app';
import { applyAppearance } from './appearance';
import { probeCaps, type Caps } from './caps';
import {
	addBrowserVault, addFolderVault, browserVaultKind, forgetVault, listVaults, lockVault, openAdapter,
	type VaultEntry, type VaultKind,
} from './vaults';

const KIND_LABEL: Record<VaultKind, string> = {
	fs: 'Folder on disk',
	opfs: 'Browser storage (OPFS)',
	idb: 'Browser storage (IndexedDB)',
	mem: 'Memory only — not saved',
};

const WELCOME = `# Welcome

This vault lives in your browser. Notes are plain Markdown.

- Link notes with [[wikilinks]], e.g. [[Second note]].
- Tag them with #tags.
- Switch between editing and reading view with the book icon at the top right.
`;

const LAST_VAULT_KEY = 'obsidian-online:last-vault';

function storageGet(key: string): string | null {
	try { return localStorage.getItem(key); } catch { return null; }
}

function storageSet(key: string, value: string): void {
	try { localStorage.setItem(key, value); } catch { /* private mode: just don't remember */ }
}

async function openVault(v: VaultEntry, caps: Caps, isNew = false): Promise<void> {
	if (!(await lockVault(v.id))) throw new Error(`"${v.name}" is already open in another tab.`);
	const adapter = await openAdapter(v);
	if (isNew && v.kind !== 'fs') await adapter.write('Welcome.md', WELCOME);
	const app = new App(adapter, caps.workers);
	(globalThis as any).app = app; // plugins and devtools expect a global `app`
	document.body.replaceChildren(app.containerEl);
	document.title = `${v.name} - obsidian-online`;
	await app.load();
	if (v.kind !== 'mem') storageSet(LAST_VAULT_KEY, v.id);

	const storage = app.addStatusBarItem();
	storage.setText(KIND_LABEL[v.kind]);
	if (v.kind === 'opfs' || v.kind === 'idb') {
		// Ask the browser not to evict the vault under storage pressure.
		const persisted = await navigator.storage?.persist?.().catch(() => false);
		if (!persisted) {
			storage.setText(`${KIND_LABEL[v.kind]} — not persistent`);
			storage.setAttr('title', 'The browser may clear this vault under storage pressure. Keep backups (zip export arrives in phase 2).');
			storage.addClass('mod-warning');
		}
	}
	if (v.kind === 'fs') {
		// Desktop Obsidian (or anything else) may edit the same folder.
		window.addEventListener('focus', () => void app.vault.rescan());
	}
}

async function showPicker(caps: Caps, error?: string): Promise<void> {
	const vaults = await listVaults(caps);
	const root = createDiv('vault-picker');
	document.body.replaceChildren(root);
	const card = root.createDiv('vault-picker-card');
	card.createEl('h1', { text: 'obsidian-online' });
	if (error) card.createDiv({ cls: 'vault-picker-error', text: error });

	const run = (fn: () => Promise<void>) => async () => {
		try {
			await fn();
		} catch (e) {
			if ((e as DOMException)?.name === 'AbortError') return; // user closed the folder picker
			await showPicker(caps, String((e as Error)?.message ?? e));
		}
	};

	if (vaults.length) {
		card.createEl('h2', { text: 'Your vaults' });
		const list = card.createDiv('vault-list');
		for (const v of vaults) {
			const row = list.createDiv('vault-list-item');
			const open = row.createEl('button', { cls: 'vault-list-item-open' });
			open.createDiv({ cls: 'vault-list-item-title', text: v.name });
			open.createDiv({ cls: 'vault-list-item-kind', text: KIND_LABEL[v.kind] });
			open.addEventListener('click', run(() => openVault(v, caps)));
			const forget = row.createEl('button', { cls: 'clickable-icon', text: '×', attr: { 'aria-label': v.kind === 'fs' ? 'Remove from list (folder is kept)' : 'Remove from list (data stays in browser storage)' } });
			forget.addEventListener('click', run(async () => {
				await forgetVault(v.id);
				await showPicker(caps);
			}));
		}
	}

	card.createEl('h2', { text: 'Open or create' });
	const folderBtn = card.createEl('button', { cls: 'mod-cta', text: 'Open folder as vault' });
	if (caps.fsAccess) {
		folderBtn.addEventListener('click', run(async () => openVault(await addFolderVault(), caps)));
	} else {
		folderBtn.disabled = true;
		card.createDiv({ cls: 'setting-item-description', text: 'Opening a folder on disk needs the File System Access API (Chromium-based browsers). Use a browser vault instead.' });
	}

	const kind = browserVaultKind(caps);
	const form = card.createEl('form', { cls: 'vault-create' });
	const input = form.createEl('input', { type: 'text', placeholder: 'New vault name', value: 'My vault' });
	form.createEl('button', { text: 'Create browser vault', type: 'submit' });
	form.createDiv({ cls: 'setting-item-description', text: `Stored in: ${KIND_LABEL[kind]}.` });
	form.addEventListener('submit', (e) => {
		e.preventDefault();
		const name = input.value.trim();
		if (name) void run(async () => openVault(await addBrowserVault(name, kind), caps, true))();
	});

	const missing = (Object.entries({ WebAssembly: caps.wasm, 'Web Workers': caps.workers, WebGL: caps.webgl, 'Service Worker': caps.serviceWorker }) as [string, boolean][])
		.filter(([, ok]) => !ok).map(([n]) => n);
	if (missing.length) card.createDiv({ cls: 'setting-item-description', text: `Unavailable in this browser: ${missing.join(', ')}. Features fall back where possible.` });
}

async function boot(): Promise<void> {
	applyAppearance(null); // system scheme until a vault's appearance.json is loaded
	const caps = await probeCaps();
	// Reopen the last browser vault directly. Folder vaults need a click to re-grant permission, so they go via the picker.
	const last = storageGet(LAST_VAULT_KEY);
	const entry = last ? (await listVaults(caps)).find((v) => v.id === last && v.kind !== 'fs') : undefined;
	if (entry) {
		try {
			return await openVault(entry, caps);
		} catch (e) {
			return showPicker(caps, String((e as Error)?.message ?? e));
		}
	}
	await showPicker(caps);
}

void boot();
