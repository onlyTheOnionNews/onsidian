// Zip export/import (PLAN §5.1): the way data gets in and out of browser-storage vaults.
import { unzip, zip, type Zippable } from 'fflate';
import type { App } from './app';
import { Notice } from './workspace';

/** Every file in the vault, including .obsidian (settings) but not .trash. */
async function allPaths(app: App, dir = ''): Promise<string[]> {
	const l = await app.vault.adapter.list(dir);
	const out = l.files.slice();
	for (const f of l.folders) if (f !== '.trash') out.push(...(await allPaths(app, f)));
	return out;
}

export async function exportVaultZip(app: App): Promise<void> {
	const notice = new Notice('Preparing vault export…', 0);
	try {
		const files: Zippable = {};
		for (const path of await allPaths(app)) files[path] = new Uint8Array(await app.vault.adapter.readBinary(path));
		const data = await new Promise<Uint8Array>((res, rej) => zip(files, { level: 6 }, (err, out) => (err ? rej(err) : res(out))));
		const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/zip' }));
		const a = createEl('a', { href: url, attr: { download: `${app.vault.getName()}-${new Date().toISOString().slice(0, 10)}.zip` } });
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
		notice.setMessage(`Exported ${Object.keys(files).length} files.`);
	} catch (e) {
		notice.setMessage(`Export failed: ${(e as Error).message}`);
	} finally {
		setTimeout(() => notice.hide(), 4000);
	}
}

/** Adds files from a zip; existing files are never overwritten. A single top-level folder in the zip is unwrapped. */
export async function importZip(app: App): Promise<void> {
	const input = createEl('input', { type: 'file', attr: { accept: '.zip,application/zip' } });
	input.click();
	const file = await new Promise<File | null>((res) => input.addEventListener('change', () => res(input.files?.[0] ?? null), { once: true }));
	if (!file) return;
	const notice = new Notice(`Importing ${file.name}…`, 0);
	try {
		const entries = await new Promise<Record<string, Uint8Array>>((res, rej) =>
			file.arrayBuffer().then((buf) => unzip(new Uint8Array(buf), (err, out) => (err ? rej(err) : res(out)))));
		const paths = Object.keys(entries).filter((p) => !p.endsWith('/') && !p.startsWith('__MACOSX/'));
		const roots = new Set(paths.map((p) => p.split('/')[0]));
		const strip = roots.size === 1 && paths.every((p) => p.includes('/')) ? [...roots][0].length + 1 : 0;
		let added = 0;
		let skipped = 0;
		for (const p of paths) {
			const target = p.slice(strip);
			if (!target || target.split('/').some((seg) => seg === '..')) continue; // zip-slip guard
			if (await app.vault.adapter.exists(target)) {
				skipped++;
				continue;
			}
			const bytes = entries[p];
			const isText = /\.(md|canvas|base|json|css|txt)$/i.test(target);
			// Dot-folders (.obsidian etc.) aren't part of the vault tree: write them straight to storage.
			if (target.split('/').some((seg) => seg.startsWith('.'))) await app.vault.adapter.writeBinary(target, bytes.slice().buffer);
			else if (isText) await app.vault.create(target, new TextDecoder().decode(bytes));
			else await app.vault.createBinary(target, bytes.slice().buffer);
			added++;
		}
		notice.setMessage(`Imported ${added} files${skipped ? `, skipped ${skipped} that already exist` : ''}.`);
	} catch (e) {
		notice.setMessage(`Import failed: ${(e as Error).message}`);
	} finally {
		setTimeout(() => notice.hide(), 6000);
	}
}
