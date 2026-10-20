// Dev-only plugin compatibility run (PLAN §6.2). Loads each plugin from compat-plugins/ (see scripts/fetch-compat-plugins.mjs)
// into one App on a memory vault, records load/runtime errors and what it registered, then unloads it.
// Open /compat.html (all) or /compat.html?only=<id>. Results: window.__compat and the table on the page.
import './dom';
import './theme.css';
import './ui.css';
import './markdown.css';
import { KvAdapter, MemBackend } from './adapters';
import { App } from './app';
import { applyAppearance } from './appearance';
import { probeCaps } from './caps';

interface Entry { id: string; name: string; version: string; downloads: number; styles: boolean; }
interface Result {
	id: string;
	name: string;
	status: 'ok' | 'runtime-errors' | 'load-failed' | 'unload-failed';
	loadError?: string;
	runtimeErrors: string[];
	ms: number;
	commands: number;
	views: string[];
	settingsTab: boolean;
	leftovers: string[];
	missingApi?: string[];
}

const SEED: Record<string, string> = {
	'Welcome.md': '---\ntags: [demo]\naliases: [Home]\n---\n# Welcome\n\nSee [[Daily/2026-10-20]] and [[Tasks]].\n',
	'Tasks.md': '# Tasks\n\n- [ ] write report 📅 2026-10-21\n- [x] ship it\n',
	'Daily/2026-10-20.md': '# 2026-10-20\n\nMet with #team about [[Welcome]].\n',
	'Data.md': '---\nstatus: active\nrating: 4\n---\n```dataview\nLIST FROM #demo\n```\n',
};

async function main(): Promise<void> {
	(window as any).__obsidianOnlineDiagnose = true;
	applyAppearance(null);
	const caps = await probeCaps();
	const only = new URLSearchParams(location.search).get('only');
	const index: Entry[] = await fetch('/compat-plugins/index.json').then((r) => r.json());
	const entries = only ? index.filter((e) => e.id === only) : index;

	const adapter = new KvAdapter(new MemBackend(), 'Compat');
	for (const [p, t] of Object.entries(SEED)) await adapter.write(p, t);
	const app = new App(adapter, caps.workers, 'compat-run');
	(window as any).app = app;
	document.body.replaceChildren(app.containerEl);
	await app.load();
	await app.workspace.getLeaf(false).openFile(app.vault.getFileByPath('Welcome.md')!);
	app.plugins.setCommunityPluginsEnabled(true);

	const panel = document.body.createDiv('compat-panel');
	const results: Result[] = ((window as any).__compat = []);
	let current: Result | null = null;
	// Attribute by the stack's "plugin:<id>/" frame when present (plugins that leak timers keep failing after unload).
	const capture = (msg: string) => {
		const owner = /plugin:([^/\s]+)\//.exec(msg)?.[1];
		const target = (owner && results.find((x) => x.id === decodeURIComponent(owner))) || current;
		target?.runtimeErrors.push(msg.slice(0, 300));
	};
	window.addEventListener('error', (e) => capture(String(e.error?.stack ?? e.message)));
	window.addEventListener('unhandledrejection', (e) => capture(String(e.reason?.stack ?? e.reason)));
	const origError = console.error;
	console.error = (...a: unknown[]) => {
		capture(a.map((x) => (x instanceof Error ? x.stack ?? x.message : String(x))).join(' '));
		origError(...a);
	};

	for (const e of entries) {
		const r: Result = { id: e.id, name: e.name, status: 'ok', runtimeErrors: [], ms: 0, commands: 0, views: [], settingsTab: false, leftovers: [] };
		current = r;
		results.push(r);
		const get = (f: string) => fetch(`/compat-plugins/${e.id}/${f}${f.endsWith('.css') ? '?direct' : ''}`).then((x) => x.text());
		const missingBefore = new Map((window as any).__obsidianOnlineMissing ?? []);
		const viewsBefore = new Set(Object.keys(app.viewRegistry.viewByType));
		const t0 = performance.now();
		try {
			await app.plugins.installPlugin({ manifest: await get('manifest.json'), main: await getMain(e.id), styles: e.styles ? await get('styles.css') : undefined });
			const ok = await app.plugins.enablePluginAndSave(e.id);
			r.ms = Math.round(performance.now() - t0);
			if (!ok) {
				r.status = 'load-failed';
				r.loadError = app.plugins.errors[e.id];
			}
			await new Promise((res) => setTimeout(res, 1200)); // async init (onLayoutReady, timers)
			r.commands = app.commands.listCommands().filter((c) => c.id.startsWith(`${e.id}:`)).length;
			r.views = Object.keys(app.viewRegistry.viewByType).filter((v) => !viewsBefore.has(v));
			r.settingsTab = app.setting.pluginTabs.some((t) => t.id === e.id);
		} catch (err) {
			r.status = 'load-failed';
			r.loadError = String((err as Error)?.message ?? err);
		}
		try {
			await app.plugins.disablePluginAndSave(e.id);
		} catch (err) {
			r.status = 'unload-failed';
			r.runtimeErrors.push(`unload: ${(err as Error)?.message ?? err}`);
		}
		r.leftovers = [
			...app.commands.listCommands().filter((c) => c.id.startsWith(`${e.id}:`)).map((c) => `command ${c.id}`),
			...r.views.filter((v) => app.viewRegistry.viewByType[v]).map((v) => `view ${v}`),
		];
		if (r.status === 'ok' && r.runtimeErrors.length) r.status = 'runtime-errors';
		// Missing API members this plugin read (first time seen during its run).
		r.missingApi = [...((window as any).__obsidianOnlineMissing ?? new Map()).keys()].filter((k: string) => !missingBefore.has(k));
		current = null;
		render(panel, results, entries.length);
	}
	console.error = origError;
}

/** main.js is saved as main.js.txt so Vite serves it untouched (it transforms .js requests). */
async function getMain(id: string): Promise<string> {
	return fetch(`/compat-plugins/${id}/main.js.txt`).then((r) => r.text());
}

function render(panel: HTMLElement, results: Result[], total: number): void {
	panel.empty();
	const counts = results.reduce<Record<string, number>>((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});
	panel.createEl('h3', { text: `Plugin compatibility: ${results.length}/${total} run · ${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(' · ')}` });
	const table = panel.createEl('table');
	const head = table.createEl('tr');
	for (const h of ['Plugin', 'Status', 'ms', 'Cmds', 'Views', 'Settings', 'Details']) head.createEl('th', { text: h });
	for (const r of results) {
		const tr = table.createEl('tr', { cls: `compat-${r.status}` });
		tr.createEl('td', { text: r.name });
		tr.createEl('td', { text: r.status });
		tr.createEl('td', { text: String(r.ms) });
		tr.createEl('td', { text: String(r.commands) });
		tr.createEl('td', { text: r.views.join(', ') });
		tr.createEl('td', { text: r.settingsTab ? 'yes' : '' });
		tr.createEl('td', { text: [r.loadError, ...r.runtimeErrors.slice(0, 2), ...r.leftovers.map((l) => `leftover ${l}`)].filter(Boolean).join(' | ').slice(0, 400) });
	}
}

const style = document.head.createEl('style');
style.textContent = `.compat-panel{position:fixed;inset:auto 0 0 0;max-height:55vh;overflow:auto;z-index:999;background:var(--background-primary);border-top:2px solid var(--interactive-accent);padding:8px 12px;font:12px var(--font-interface)}
.compat-panel table{border-collapse:collapse;width:100%}.compat-panel td,.compat-panel th{border:1px solid var(--background-modifier-border);padding:2px 6px;text-align:left;vertical-align:top}
.compat-ok td:nth-child(2){color:var(--text-success)}.compat-runtime-errors td:nth-child(2){color:var(--text-warning)}.compat-load-failed td:nth-child(2),.compat-unload-failed td:nth-child(2){color:var(--text-error)}`;

void main();
