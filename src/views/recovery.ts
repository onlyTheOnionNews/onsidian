// File recovery core plugin (PLAN §5.6): snapshots of notes in IndexedDB, outside the vault, with diff + restore.
import moment from 'moment';
import type { App } from '../app';
import { CorePlugin } from '../coreplugins';
import { SettingTab } from '../modals';
import { Modal, Setting, prepareFuzzySearch } from '../ui';
import { TAbstractFile, TFile } from '../vault';
import { Notice } from '../workspace';

interface Snapshot { path: string; ts: number; data: string; }

class SnapshotStore {
	private db: Promise<IDBDatabase>;
	constructor(name: string) {
		this.db = new Promise((res, rej) => {
			const req = indexedDB.open(name, 1);
			req.onupgradeneeded = () => {
				const s = req.result.createObjectStore('snapshots', { keyPath: ['path', 'ts'] });
				s.createIndex('path', 'path');
				s.createIndex('ts', 'ts');
			};
			req.onsuccess = () => res(req.result);
			req.onerror = () => rej(req.error);
		});
	}

	private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
		const store = (await this.db).transaction('snapshots', mode).objectStore('snapshots');
		return new Promise((res, rej) => {
			const r = fn(store);
			r.onsuccess = () => res(r.result);
			r.onerror = () => rej(r.error);
		});
	}

	add(s: Snapshot) { return this.tx('readwrite', (st) => st.put(s)); }
	forPath(path: string) { return this.tx<Snapshot[]>('readonly', (st) => st.index('path').getAll(path)); }
	paths() { return this.tx<IDBValidKey[]>('readonly', (st) => st.index('path').getAllKeys()).then((keys) => [...new Set(keys.map((k) => (k as [string, number])[0]))]); }
	clear() { return this.tx('readwrite', (st) => st.clear()); }

	async deleteOlderThan(ts: number): Promise<void> {
		const store = (await this.db).transaction('snapshots', 'readwrite').objectStore('snapshots');
		await new Promise<void>((res, rej) => {
			const r = store.index('ts').openCursor(IDBKeyRange.upperBound(ts));
			r.onsuccess = () => {
				const c = r.result;
				if (!c) return res();
				c.delete();
				c.continue();
			};
			r.onerror = () => rej(r.error);
		});
	}
}

/**
 * Line diff via LCS. ponytail: O(n·m) memory/time; fine for notes up to a few thousand lines.
 * Swap in Myers / diff-match-patch if huge files show up.
 */
export function diffLines(a: string, b: string): { op: ' ' | '-' | '+'; text: string }[] {
	const x = a.split('\n');
	const y = b.split('\n');
	const n = x.length;
	const m = y.length;
	const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
	const out: { op: ' ' | '-' | '+'; text: string }[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (x[i] === y[j]) { out.push({ op: ' ', text: x[i] }); i++; j++; }
		else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ op: '-', text: x[i++] });
		else out.push({ op: '+', text: y[j++] });
	}
	while (i < n) out.push({ op: '-', text: x[i++] });
	while (j < m) out.push({ op: '+', text: y[j++] });
	return out;
}

export class FileRecoveryPlugin extends CorePlugin {
	id = 'file-recovery';
	name = 'File recovery';
	description = 'Keep snapshots of notes so you can recover earlier versions.';
	options = { intervalMinutes: 5, keepDays: 7 };
	store!: SnapshotStore;
	private last = new Map<string, { ts: number; data: string }>();

	async onload(): Promise<void> {
		this.store = new SnapshotStore(`obsidian-online-recovery:${this.app.appId}`);
		try { Object.assign(this.options, JSON.parse(localStorage.getItem(`obsidian-online-recovery-options:${this.app.appId}`) ?? '{}')); } catch { /* defaults */ }
		await this.store.deleteOlderThan(Date.now() - this.options.keepDays * 864e5).catch(() => {});
		this.registerEvent(this.app.vault.on('modify', (f: TAbstractFile) => f instanceof TFile && f.extension === 'md' && void this.snapshot(f)));
		// Keep a copy of a note right before it's deleted.
		this.registerEvent(this.app.vault.on('delete', (f: TAbstractFile) => {
			const prev = this.last.get(f.path);
			if (prev) void this.store.add({ path: f.path, ts: Date.now(), data: prev.data });
		}));
		this.addCommand({ id: 'file-recovery:open', name: 'File recovery: Open saved snapshots', icon: 'history', callback: () => new RecoveryModal(this.app, this).open() });
		this.addSettingTab(new RecoveryTab(this.app, this));
	}

	saveOptions(): void {
		try { localStorage.setItem(`obsidian-online-recovery-options:${this.app.appId}`, JSON.stringify(this.options)); } catch { /* storage blocked */ }
	}

	private async snapshot(file: TFile): Promise<void> {
		const data = await this.app.vault.cachedRead(file);
		const prev = this.last.get(file.path);
		const now = Date.now();
		this.last.set(file.path, { ts: prev && now - prev.ts < this.options.intervalMinutes * 60e3 ? prev.ts : now, data });
		if (prev && now - prev.ts < this.options.intervalMinutes * 60e3) return;
		if (prev?.data === data) return;
		await this.store.add({ path: file.path, ts: now, data }).catch((e) => console.warn('File recovery snapshot failed', e));
	}
}

class RecoveryModal extends Modal {
	constructor(app: App, private plugin: FileRecoveryPlugin) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass('mod-community-modal', 'mod-file-recovery');
		this.setTitle('File recovery');
		const wrap = this.contentEl.createDiv('community-modal');
		const side = wrap.createDiv('community-modal-sidebar');
		const search = side.createEl('input', { type: 'search', placeholder: 'Search files…' });
		const list = side.createDiv('community-modal-search-results');
		const detail = wrap.createDiv('community-modal-details');
		detail.createDiv({ cls: 'pane-empty', text: 'Select a file to see its snapshots.' });
		const paths = (await this.plugin.store.paths()).sort();
		const render = () => {
			list.empty();
			const match = prepareFuzzySearch(search.value);
			for (const p of paths.filter((x) => !search.value || match(x))) {
				const el = list.createDiv({ cls: 'community-item', text: p });
				el.addEventListener('click', () => {
					for (const x of list.querySelectorAll('.is-selected')) x.removeClass('is-selected');
					el.addClass('is-selected');
					void this.showFile(detail, p);
				});
			}
			if (!paths.length) list.createDiv({ cls: 'pane-empty', text: 'No snapshots yet. They are taken as you edit.' });
		};
		search.addEventListener('input', render);
		render();
	}

	private async showFile(el: HTMLElement, path: string): Promise<void> {
		el.empty();
		const snaps = (await this.plugin.store.forPath(path)).sort((a, b) => b.ts - a.ts);
		const file = this.app.vault.getFileByPath(path);
		const current = file ? await this.app.vault.read(file) : '';
		el.createEl('h2', { text: path });
		const picker = el.createEl('select', { cls: 'dropdown' });
		for (const [i, s] of snaps.entries()) picker.createEl('option', { value: String(i), text: `${moment(s.ts).format('YYYY-MM-DD HH:mm:ss')} (${moment(s.ts).fromNow()})` });
		const actions = el.createDiv('community-modal-button-container');
		const restore = actions.createEl('button', { cls: 'mod-cta', text: file ? 'Restore this version' : 'Recreate file' });
		const copy = actions.createEl('button', { text: 'Copy to clipboard' });
		const diffEl = el.createDiv('file-recovery-diff');
		const show = () => {
			const snap = snaps[Number(picker.value)];
			diffEl.empty();
			if (!snap) return;
			for (const d of diffLines(current, snap.data)) diffEl.createDiv({ cls: `file-recovery-line mod-${d.op === '+' ? 'added' : d.op === '-' ? 'removed' : 'same'}`, text: `${d.op} ${d.text}` });
		};
		picker.addEventListener('change', show);
		restore.addEventListener('click', async () => {
			const snap = snaps[Number(picker.value)];
			if (!snap) return;
			if (file) await this.app.vault.modify(file, snap.data);
			else await this.app.vault.create(path, snap.data);
			new Notice(`Restored ${path} to ${moment(snap.ts).format('YYYY-MM-DD HH:mm')}.`);
			this.close();
		});
		copy.addEventListener('click', () => void navigator.clipboard.writeText(snaps[Number(picker.value)]?.data ?? '').then(() => new Notice('Copied.')));
		show();
	}
}

class RecoveryTab extends SettingTab {
	constructor(app: App, private plugin: FileRecoveryPlugin) {
		super(app);
		this.id = 'file-recovery';
		this.name = 'File recovery';
	}
	display(): void {
		const el = this.containerEl;
		el.empty();
		new Setting(el).setName('Snapshot interval').setDesc('Minimum minutes between snapshots of the same note.')
			.addSlider((s) => s.setLimits(1, 60, 1).setValue(this.plugin.options.intervalMinutes).setDynamicTooltip().onChange((v) => { this.plugin.options.intervalMinutes = v; this.plugin.saveOptions(); }));
		new Setting(el).setName('History length').setDesc('Days to keep snapshots (stored in this browser, not in the vault).')
			.addSlider((s) => s.setLimits(1, 90, 1).setValue(this.plugin.options.keepDays).setDynamicTooltip().onChange((v) => { this.plugin.options.keepDays = v; this.plugin.saveOptions(); }));
		new Setting(el).setName('Snapshots').addButton((b) => b.setButtonText('View').onClick(() => new RecoveryModal(this.app, this.plugin).open()))
			.addButton((b) => b.setButtonText('Clear history').setWarning().onClick(async () => {
				await this.plugin.store.clear();
				new Notice('File recovery history cleared.');
			}));
	}
}
