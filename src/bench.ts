// Dev-only performance benchmark (PLAN §10 phase 6). Generates a synthetic vault of N notes in OPFS (once, reused),
// then times cold load, metadata indexing, search, quick-switcher matching, the graph and opening a large note.
// Open /bench.html?n=10000 (default 1000). Results: window.__bench and the table on the page.
import './dom';
import './theme.css';
import './ui.css';
import './markdown.css';
import { HandleAdapter } from './adapters';
import { prepareFuzzySearch } from './ui';
import { App } from './app';
import { applyAppearance } from './appearance';
import { probeCaps } from './caps';
import { searchVault } from './search';

const WORDS = ('the of and to in is that it was for on are as with his they at be this from have or by one had not but what all were when we there can an your which their said if do will each about how up out them then she many some so these would other into has more her two like him see time could no make than first been its who now people my made over did down only way find use may water long little very after words called just where most know get through back much go good new write our me man too any day same right look think also around another came come work three word must because does part even place well such here take why things help put years different away again off went old number great tell men say small every found still between name should home big give air line set own under read last never us left end along while might next sound below saw something thought both few those always looked show large often together asked house world going want school important until form food keep children feet land side without boy once animals life enough took sometimes four head above kind began almost live page got earth need far hand high year mother light parts country father let night following picture being study second eyes soon times story boys since white days ever paper hard near sentence better best across during today others however sure means knew try told young miles sun ways thing whole hear example heard several change answer room sea against top turned learn point city play toward five using himself usually').split(' ');

function rng(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const noteName = (i: number) => `Note ${i}`;
const notePath = (i: number) => `Folder ${Math.floor(i / 100)}/${noteName(i)}.md`;

/** A ~400-word note with frontmatter, headings, links, tags, a task list and a callout. */
function note(i: number, n: number): string {
	const r = rng(i + 1);
	const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
	const words = (k: number) => Array.from({ length: k }, () => pick(WORDS)).join(' ');
	const link = () => `[[${noteName(Math.floor(r() * n))}]]`;
	const out = [`---\ntags: [topic${i % 50}, area${i % 7}]\ncreated: 2026-01-${String((i % 28) + 1).padStart(2, '0')}\nrating: ${i % 5}\n---`, `# ${words(4)}`];
	for (let s = 0; s < 4; s++) {
		out.push(`## ${words(3)}`);
		out.push(`${words(40)} ${link()} ${words(20)} #tag${Math.floor(r() * 200)} ${words(15)}.`);
		out.push(`- ${words(8)} ${link()}\n- ${words(6)}\n- [ ] ${words(5)}`);
	}
	out.push(`> [!note] ${words(3)}\n> ${words(20)} ${link()}`);
	return out.join('\n\n') + '\n';
}

async function benchDir(n: number): Promise<FileSystemDirectoryHandle> {
	const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('bench', { create: true });
	const dir = await root.getDirectoryHandle(String(n), { create: true });
	const done = await dir.getFileHandle('.complete').then(() => true, () => false);
	if (done) return dir;
	const adapter = new HandleAdapter(dir, `bench-${n}`);
	const status = document.body.createDiv({ text: `Generating ${n} notes…` });
	for (let i = 0; i < n; i++) {
		await adapter.write(notePath(i), note(i, n));
		if (i % 500 === 0) status.setText(`Generating ${i}/${n} notes…`);
	}
	await adapter.write('Big note.md', Array.from({ length: 200 }, (_, k) => note(k, n)).join('\n'));
	await dir.getFileHandle('.complete', { create: true });
	status.remove();
	return dir;
}

const time = async <T>(fn: () => Promise<T> | T): Promise<[number, T]> => {
	const t0 = performance.now();
	const v = await fn();
	return [Math.round(performance.now() - t0), v];
};
const heapMB = () => Math.round(((performance as any).memory?.usedJSHeapSize ?? 0) / 1048576);

async function main(): Promise<void> {
	applyAppearance(null);
	const n = Number(new URLSearchParams(location.search).get('n') ?? 1000);
	const caps = await probeCaps();
	const dir = await benchDir(n);
	const results: Record<string, number | string> = { notes: n, heapBeforeMB: heapMB() };
	(window as any).__bench = results;

	const adapter = new HandleAdapter(dir, `bench-${n}`);
	// Each run opens tabs; start from the default layout so runs don't restore the previous run's views.
	await adapter.remove('.obsidian/workspace-web.json').catch(() => {});
	const app = new App(adapter, caps.workers, `bench-${n}`);
	(window as any).app = app;
	document.body.replaceChildren(app.containerEl);
	const resolved = new Promise<void>((r) => app.metadataCache.on('resolved', () => r()));
	const t0 = performance.now();
	[results.vaultLoadMs] = await time(() => app.vault.load());
	// App.load reloads the vault itself; measure the full startup separately.
	app.vault.load = async () => {};
	// Startup breakdown: time each phase of App.load.
	const phase = (obj: any, name: string, label: string) => {
		const orig = obj[name].bind(obj);
		obj[name] = async (...args: unknown[]) => {
			const [ms, v] = await time(() => orig(...args));
			results[`load: ${label}`] = ms;
			return v;
		};
	};
	phase(app.internalPlugins, 'load', 'core plugins');
	phase(app.workspace, 'initLayout', 'layout');
	phase(app.plugins, 'initialize', 'community plugins');
	phase(app.vault, 'loadConfig', 'config');
	[results.appLoadMs] = await time(() => app.load());
	await resolved;
	results.indexedMs = Math.round(performance.now() - t0);
	results.heapIndexedMB = heapMB();

	for (const q of ['water', 'mother earth', '"often together"', 'tag:#tag42', 'path:"Folder 3"', 'line:(water light)', '[rating:4]', '/sound\\w+/']) {
		const [ms, r] = await time(() => searchVault(app, q));
		results[`search ${q}`] = `${ms} ms (${r.length})`;
	}
	const files = app.vault.getFiles();
	for (const q of ['note 12', 'nt99']) {
		const [ms, hits] = await time(() => {
			const fuzzy = prepareFuzzySearch(q);
			return files.filter((f) => fuzzy(f.path)).length;
		});
		results[`switcher ${q}`] = `${ms} ms (${hits})`;
	}

	const big = app.vault.getFileByPath('Big note.md')!;
	const leaf = app.workspace.getLeaf(true);
	[results.openBigNoteMs] = await time(() => leaf.openFile(big));
	[results.readingViewBigNoteMs] = await time(async () => {
		await leaf.setViewState({ type: 'markdown', state: { file: big.path, mode: 'preview' } });
		await new Promise((r) => setTimeout(r, 0));
	});
	[results.readingViewBigNoteCompleteMs] = await time(() => (leaf.view as any).rendered);

	[results.graphOpenMs] = await time(() => app.workspace.getLeaf(true).setViewState({ type: 'graph', active: true }));
	const graph = app.workspace.getActiveViewOfType(Object.getPrototypeOf(app.workspace.activeLeaf!.view).constructor) as any;
	if (graph?.layout) {
		const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
		const draws: number[] = [];
		for (let k = 0; k < 30; k++) draws.push((await time(() => graph.draw()))[0]);
		results.graphNodes = graph.nodes.length;
		results.graphDrawMedianMs = median(draws);
		// While the layout runs: how late does a 16 ms timer fire (main-thread blocking), and how many layout steps land.
		let steps = 0;
		const onTick = graph.requestDraw.bind(graph);
		graph.requestDraw = () => { steps++; onTick(); };
		let worst = 0;
		const start = performance.now();
		for (let k = 0; k < 60; k++) {
			const t = performance.now();
			await new Promise((r) => setTimeout(r, 16));
			worst = Math.max(worst, performance.now() - t - 16);
		}
		results.graphWorstTimerLagMs = Math.round(worst);
		results.graphLayoutStepsPerSec = Math.round(steps / ((performance.now() - start) / 1000));
	}

	[results.createNoteMs] = await time(() => app.vault.create(`New ${Date.now()}.md`, '[[Note 1]]'));
	results.heapEndMB = heapMB();
	console.table(results);
	const table = document.body.createEl('table', { cls: 'bench-results' });
	table.style.cssText = 'position:fixed;top:8px;right:8px;z-index:999;background:var(--background-primary);font-size:12px;border:1px solid var(--background-modifier-border)';
	for (const [k, v] of Object.entries(results)) {
		const tr = table.createEl('tr');
		tr.createEl('td', { text: k });
		tr.createEl('td', { text: String(v) });
	}
	(window as any).__benchDone = true;
}

void main();
