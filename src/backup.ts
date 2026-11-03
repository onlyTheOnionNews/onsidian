// Getting files in and out (PLAN §5.1): import files, folders and zips (each zip becomes a folder), download a file, a
// folder or the whole vault as .zip, and restore a vault from a zip. Imports never overwrite: clashes get a number.
import type { Zippable } from 'fflate';
import type { App } from './app';
import { cleanRelPath, freePath, zipLayout } from './importpaths';
import type { BaseAdapter } from './adapters';
import { TFile, TFolder, type TAbstractFile } from './vault';
import { Notice } from './workspace';

/** A file to import and where it goes, relative to the destination folder ("Sub/note.md" keeps its folder). */
export interface ImportItem {
	path: string;
	file: File;
}

const TEXT = /\.(md|canvas|base|json|css|txt|csv|svg|html?)$/i;
const isHiddenPath = (p: string) => p.split('/').some((seg) => seg.startsWith('.'));

async function unzipFile(file: Blob): Promise<Record<string, Uint8Array>> {
	const { unzip } = await import('fflate');
	const buf = new Uint8Array(await file.arrayBuffer());
	return new Promise((res, rej) => unzip(buf, (err, out) => (err ? rej(err) : res(out))));
}

/** Write one file through the vault (so the tree and index update), or straight to storage for dot-folders. */
async function writeFile(app: App, path: string, data: Uint8Array): Promise<void> {
	if (isHiddenPath(path)) await app.vault.adapter.writeBinary(path, data.slice().buffer);
	else if (TEXT.test(path)) await app.vault.create(path, new TextDecoder().decode(data));
	else await app.vault.createBinary(path, data.slice().buffer);
}

/**
 * Import into `dest` (a folder path, '' for the vault root). Folders keep their structure; each .zip becomes a folder
 * named after it (or after its single top-level folder). Returns the top-level items created, in order.
 */
export async function importItems(app: App, items: ImportItem[], dest: string): Promise<string[]> {
	const base = dest && dest !== '/' ? `${dest}/` : '';
	const written = new Set<string>();
	const taken = (p: string) => written.has(p) || !!app.vault.getAbstractFileByPath(p);
	const tops = new Map<string, string>(); // imported top-level folder → its (possibly renumbered) name here
	const created: string[] = [];
	let count = 0;
	let skipped = 0;
	const put = async (path: string, data: Uint8Array) => {
		if (isHiddenPath(path) && (await app.vault.adapter.exists(path))) return void skipped++;
		await writeFile(app, path, data);
		written.add(path);
		count++;
	};
	const notice = new Notice(`Importing ${items.length} item${items.length === 1 ? '' : 's'}…`, 0);
	try {
		for (const { path, file } of items) {
			const rel = cleanRelPath(path);
			if (!rel) {
				skipped++;
				continue;
			}
			const slash = rel.lastIndexOf('/');
			if (/\.zip$/i.test(rel)) {
				const entries = await unzipFile(file);
				const { root, files } = zipLayout(Object.keys(entries));
				const folder = freePath(`${base}${rel.slice(0, slash + 1)}${root ?? rel.slice(slash + 1, -4)}`, taken, true);
				for (const [entry, inner] of files) await put(`${folder}/${inner}`, entries[entry]);
				written.add(folder);
				created.push(folder);
				continue;
			}
			const data = new Uint8Array(await file.arrayBuffer());
			if (slash < 0) {
				const target = freePath(base + rel, taken);
				await put(target, data);
				created.push(target);
				continue;
			}
			// From a folder: a clashing top folder is renumbered as a whole ("Notes 1/…"), not merged into.
			const top = rel.slice(0, rel.indexOf('/'));
			let folder = tops.get(top);
			if (!folder) {
				folder = freePath(base + top, taken, true);
				tops.set(top, folder);
				written.add(folder);
				created.push(folder);
			}
			await put(`${folder}/${rel.slice(top.length + 1)}`, data);
		}
		notice.setMessage(`Imported ${count} file${count === 1 ? '' : 's'}${skipped ? `, skipped ${skipped}` : ''}.`);
	} catch (e) {
		notice.setMessage(`Import stopped: ${(e as Error).message}. ${count} file${count === 1 ? '' : 's'} imported.`);
	} finally {
		setTimeout(() => notice.hide(), 5000);
	}
	return created;
}

/** Import, then open what arrived: a single file opens (a .canvas in Canvas view); otherwise it's shown in Files. */
export async function importAndShow(app: App, items: ImportItem[], dest: string): Promise<void> {
	if (!items.length) return;
	const created = await importItems(app, items, dest);
	const first = created[0] && app.vault.getAbstractFileByPath(created[0]);
	if (!first) return;
	if (created.length === 1 && first instanceof TFile) await app.workspace.getLeaf(false).openFile(first, { active: true });
	else for (const leaf of app.workspace.getLeavesOfType('file-explorer')) (leaf.view as any).revealFile?.(first);
}

/** Ask for files (or a folder) with the browser's file picker. Resolves [] when cancelled. */
export function pickFiles(opts: { folder?: boolean; accept?: string } = {}): Promise<ImportItem[]> {
	const input = createEl('input', { type: 'file', attr: { multiple: '' } });
	if (opts.accept) input.accept = opts.accept;
	if (opts.folder) (input as any).webkitdirectory = true;
	return new Promise((resolve) => {
		input.addEventListener('change', () => resolve([...(input.files ?? [])].map((file) => ({ path: (opts.folder && file.webkitRelativePath) || file.name, file }))), { once: true });
		input.addEventListener('cancel', () => resolve([]), { once: true });
		input.click();
	});
}

/** Files and folders dropped from the computer. Call synchronously in the drop handler (items expire after it). */
export function droppedItems(dt: DataTransfer): Promise<ImportItem[]> {
	const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
	const plain = [...dt.files];
	return (async () => {
		if (!entries.length) return plain.map((file) => ({ path: file.name, file }));
		const out: ImportItem[] = [];
		const walk = async (e: FileSystemEntry, prefix: string): Promise<void> => {
			if (e.isFile) {
				out.push({ path: prefix + e.name, file: await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej)) });
				return;
			}
			const reader = (e as FileSystemDirectoryEntry).createReader();
			for (;;) {
				const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
				if (!batch.length) break; // readEntries returns at most ~100 per call
				for (const child of batch) await walk(child, `${prefix}${e.name}/`);
			}
		};
		for (const e of entries) await walk(e, '');
		return out;
	})();
}

// ---------------- Download ----------------

function download(data: BlobPart, name: string, type = 'application/octet-stream'): void {
	const url = URL.createObjectURL(new Blob([data], { type }));
	createEl('a', { href: url, attr: { download: name } }).click();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Every file under `dir` in storage, including .obsidian (settings) but not .trash. */
async function allPaths(adapter: BaseAdapter, dir = ''): Promise<string[]> {
	const l = await adapter.list(dir);
	const out = l.files.slice();
	for (const f of l.folders) if (f !== '.trash') out.push(...(await allPaths(adapter, f)));
	return out;
}

/** Download the whole vault (folder = null, settings included) or one folder as a .zip. */
export async function exportZip(app: App, folder: TFolder | null = null): Promise<void> {
	const name = folder && !folder.isRoot() ? folder.name : app.vault.getName();
	const notice = new Notice(`Preparing ${name}.zip…`, 0);
	try {
		const prefix = folder && !folder.isRoot() ? `${folder.path}/` : '';
		const paths = await allPaths(app.vault.adapter as BaseAdapter, prefix.slice(0, -1));
		const files: Zippable = {};
		// A folder's zip opens as that folder; the vault's zip holds the vault's contents at its root (importable as a vault).
		for (const path of paths) files[prefix ? `${name}/${path.slice(prefix.length)}` : path] = new Uint8Array(await app.vault.adapter.readBinary(path));
		const { zip } = await import('fflate');
		const data = await new Promise<Uint8Array>((res, rej) => zip(files, { level: 6 }, (err, out) => (err ? rej(err) : res(out))));
		download(data as BlobPart, prefix ? `${name}.zip` : `${name}-${new Date().toISOString().slice(0, 10)}.zip`, 'application/zip');
		notice.setMessage(`Downloaded ${paths.length} files.`);
	} catch (e) {
		notice.setMessage(`Download failed: ${(e as Error).message}`);
	} finally {
		setTimeout(() => notice.hide(), 4000);
	}
}

export const exportVaultZip = (app: App) => exportZip(app);

export async function downloadFile(app: App, file: TFile): Promise<void> {
	download(await app.vault.readBinary(file), file.name);
}

/** Write a vault zip into empty storage (a new vault): contents at the root, settings included. */
export async function restoreVaultZip(adapter: BaseAdapter, zip: File): Promise<number> {
	const entries = await unzipFile(zip);
	const { files } = zipLayout(Object.keys(entries));
	for (const [entry, rel] of files) await adapter.writeBinary(rel, entries[entry].slice().buffer);
	return files.length;
}

/** Merge a vault zip into this vault's root, skipping files that already exist (recovery after storage was cleared). */
export async function importZip(app: App): Promise<void> {
	const [item] = await pickFiles({ accept: '.zip,application/zip' });
	if (!item) return;
	const notice = new Notice(`Importing ${item.file.name}…`, 0);
	try {
		const entries = await unzipFile(item.file);
		let added = 0;
		let skipped = 0;
		for (const [entry, rel] of zipLayout(Object.keys(entries)).files) {
			if (await app.vault.adapter.exists(rel)) {
				skipped++;
				continue;
			}
			await writeFile(app, rel, entries[entry]);
			added++;
		}
		notice.setMessage(`Imported ${added} files${skipped ? `, skipped ${skipped} that already exist` : ''}.`);
	} catch (e) {
		notice.setMessage(`Import failed: ${(e as Error).message}`);
	} finally {
		setTimeout(() => notice.hide(), 6000);
	}
}

/** Explorer / folder menu entries for importing into `folder` and downloading it. */
export function addTransferMenuItems(app: App, menu: any, target: TAbstractFile): void {
	if (target instanceof TFile) {
		menu.addItem((i: any) => i.setTitle('Download').setIcon('download').setSection('action').onClick(() => void downloadFile(app, target)));
		return;
	}
	const folder = target as TFolder;
	const dest = folder.isRoot() ? '' : folder.path;
	const here = folder.isRoot() ? '' : ' here';
	menu.addItem((i: any) => i.setTitle(`Import files${here}…`).setIcon('file-up').setSection('import').onClick(async () => importAndShow(app, await pickFiles(), dest)));
	menu.addItem((i: any) => i.setTitle(`Import folder${here}…`).setIcon('folder-up').setSection('import').onClick(async () => importAndShow(app, await pickFiles({ folder: true }), dest)));
	menu.addItem((i: any) => i.setTitle(`Import .zip as folder${here}…`).setIcon('file-archive').setSection('import').onClick(async () => importAndShow(app, await pickFiles({ accept: '.zip,application/zip' }), dest)));
	menu.addItem((i: any) => i.setTitle(folder.isRoot() ? 'Download vault as .zip' : 'Download as .zip').setIcon('download').setSection('import').onClick(() => void exportZip(app, folder.isRoot() ? null : folder)));
}
