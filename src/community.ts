// Community plugin/theme browsers + themes and CSS snippets (`app.customCss`) (PLAN §4, §6.4).
// Lists and READMEs come from raw.githubusercontent.com (CORS-enabled). Release files: jsDelivr at the version tag,
// then a network bridge for the GitHub release asset, else the user installs manually.
import type { App } from './app';
import { requestUrl, activeBridge } from './network';
import type { PluginManifest } from './plugins';
import { MarkdownRenderer } from './render';
import { Modal, Setting, prepareFuzzySearch } from './ui';
import { Notice } from './workspace';
import { Component } from './events';

const RELEASES = 'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD';
const raw = (repo: string, file: string) => `https://raw.githubusercontent.com/${repo}/HEAD/${file}`;

interface PluginEntry { id: string; name: string; author: string; description: string; repo: string; }
interface ThemeEntry { name: string; author: string; repo: string; screenshot: string; modes: string[]; }

let pluginList: Promise<{ entries: PluginEntry[]; downloads: Record<string, number> }> | null = null;
let themeList: Promise<ThemeEntry[]> | null = null;

function loadPluginList() {
	return (pluginList ??= (async () => {
		const [entries, stats] = await Promise.all([
			fetch(`${RELEASES}/community-plugins.json`).then((r) => r.json()) as Promise<PluginEntry[]>,
			fetch(`${RELEASES}/community-plugin-stats.json`).then((r) => r.json()).catch(() => ({})) as Promise<Record<string, { downloads?: number }>>,
		]);
		const downloads = Object.fromEntries(Object.entries(stats).map(([id, s]) => [id, s?.downloads ?? 0]));
		entries.sort((a, b) => (downloads[b.id] ?? 0) - (downloads[a.id] ?? 0));
		return { entries, downloads };
	})().catch((e) => {
		pluginList = null;
		throw e;
	}));
}

function loadThemeList() {
	return (themeList ??= fetch(`${RELEASES}/community-css-themes.json`).then((r) => r.json()).catch((e) => {
		themeList = null;
		throw e;
	}));
}

/** Fetch a release file: jsDelivr at the tag (works when the file is committed), then the GitHub asset via a bridge. */
export async function fetchReleaseFile(repo: string, version: string, file: string, optional = false): Promise<string | undefined> {
	const cdn = await fetch(`https://cdn.jsdelivr.net/gh/${repo}@${version}/${file}`).catch(() => null);
	if (cdn?.ok) return cdn.text();
	if (activeBridge() !== 'Direct (CORS only)') {
		const r = await requestUrl({ url: `https://github.com/${repo}/releases/download/${version}/${file}`, throw: false });
		if (r.status < 400) return r.text;
	}
	if (optional) return undefined;
	throw new Error(`Couldn't download ${file} for ${repo}@${version}. It isn't on jsDelivr and no network bridge is installed. Download it from github.com/${repo}/releases and use "Install plugin from files", or set up a bridge in Settings → Network.`);
}

// ---------------- Plugin browser ----------------

export class PluginBrowser extends Modal {
	private listEl!: HTMLElement;
	private detailEl!: HTMLElement;
	private query = '';
	private detailComponent = new Component();

	onOpen(): void {
		this.modalEl.addClass('mod-community-modal');
		this.setTitle('Community plugins');
		const wrap = this.contentEl.createDiv('community-modal');
		const side = wrap.createDiv('community-modal-sidebar');
		const search = side.createEl('input', { type: 'search', placeholder: 'Search community plugins…' });
		this.listEl = side.createDiv('community-modal-search-results');
		this.detailEl = wrap.createDiv('community-modal-details');
		this.detailEl.createDiv({ cls: 'pane-empty', text: 'Select a plugin to see details.' });
		search.addEventListener('input', () => {
			this.query = search.value;
			void this.renderList();
		});
		this.detailComponent.load();
		void this.renderList();
		search.focus();
	}

	onClose(): void {
		this.detailComponent.unload();
	}

	private async renderList(): Promise<void> {
		this.listEl.empty();
		let data: Awaited<ReturnType<typeof loadPluginList>>;
		try {
			data = await loadPluginList();
		} catch (e) {
			this.listEl.createDiv({ cls: 'pane-empty', text: `Couldn't load the plugin list: ${(e as Error).message}` });
			return;
		}
		const match = prepareFuzzySearch(this.query);
		const items = data.entries.filter((p) => !this.query || match(`${p.name} ${p.author} ${p.description}`)).slice(0, 200);
		for (const p of items) {
			const el = this.listEl.createDiv('community-item');
			el.createDiv({ cls: 'community-item-name', text: p.name });
			const meta = el.createDiv('community-item-meta');
			meta.createSpan({ text: `By ${p.author}` });
			meta.createSpan({ text: ` · ${(data.downloads[p.id] ?? 0).toLocaleString()} downloads` });
			if (this.app.plugins.manifests[p.id]) meta.createSpan({ cls: 'community-item-installed', text: ' · Installed' });
			el.createDiv({ cls: 'community-item-desc', text: p.description });
			el.addEventListener('click', () => {
				for (const x of this.listEl.querySelectorAll('.is-selected')) x.removeClass('is-selected');
				el.addClass('is-selected');
				void this.showDetail(p);
			});
		}
	}

	private async showDetail(p: PluginEntry): Promise<void> {
		const el = this.detailEl;
		el.empty();
		el.createEl('h2', { text: p.name });
		el.createDiv({ cls: 'community-item-meta', text: `By ${p.author} · github.com/${p.repo}` });
		const actions = el.createDiv('community-modal-button-container');
		const status = el.createDiv('setting-item-description');
		let manifest: PluginManifest | null = null;
		try {
			manifest = await (await fetch(raw(p.repo, 'manifest.json'))).json();
		} catch {
			status.setText('Couldn’t read this plugin’s manifest.json.');
		}
		if (manifest) {
			status.setText(`Version ${manifest.version}${manifest.isDesktopOnly ? ' · Desktop-only: needs Node.js/Electron, so it can’t run in a browser.' : ''}`);
			const installed = this.app.plugins.manifests[p.id];
			const btn = actions.createEl('button', { cls: 'mod-cta', text: installed ? (installed.version === manifest.version ? 'Reinstall' : `Update to ${manifest.version}`) : 'Install' });
			btn.disabled = !!manifest.isDesktopOnly;
			btn.addEventListener('click', async () => {
				btn.disabled = true;
				btn.setText('Installing…');
				try {
					const version = manifest!.version;
					const [main, styles] = await Promise.all([fetchReleaseFile(p.repo, version, 'main.js'), fetchReleaseFile(p.repo, version, 'styles.css', true)]);
					const releaseManifest = (await fetchReleaseFile(p.repo, version, 'manifest.json', true)) ?? JSON.stringify(manifest);
					await this.app.plugins.installPlugin({ manifest: releaseManifest, main: main!, styles });
					btn.setText('Installed');
					if (this.app.plugins.isEnabled()) {
						const enable = actions.createEl('button', { text: 'Enable' });
						enable.addEventListener('click', async () => {
							await this.app.plugins.enablePluginAndSave(p.id);
							enable.setText(this.app.plugins.errors[p.id] ? 'Failed (see Settings)' : 'Enabled');
							enable.disabled = true;
						});
					} else {
						status.setText('Installed. Turn off Restricted mode in Settings → Community plugins to enable it.');
					}
					void this.renderList();
				} catch (e) {
					btn.disabled = false;
					btn.setText('Install');
					new Notice((e as Error).message, 10000);
				}
			});
		}
		const readme = el.createDiv('community-modal-readme markdown-rendered');
		try {
			const md = await (await fetch(raw(p.repo, 'README.md'))).text();
			// Relative images/links in READMEs point into the repo.
			const fixed = md.replace(/(!?\[[^\]]*\]\()(?!https?:|#|mailto:)([^)\s]+)/g, (_m, pre, path) => `${pre}${raw(p.repo, path.replace(/^\.?\//, ''))}`);
			await MarkdownRenderer.render(this.app, fixed, readme, '', this.detailComponent);
		} catch {
			readme.setText('No README.');
		}
	}
}

// ---------------- Themes & snippets (app.customCss) ----------------

export class CustomCss {
	themes: Record<string, { name: string; version?: string; author?: string }> = {};
	snippets: string[] = [];
	private themeEl: HTMLStyleElement | null = null;
	private snippetEls: HTMLStyleElement[] = [];

	constructor(private app: App) {}

	private get themesDir() { return `${this.app.vault.configDir}/themes`; }
	private get snippetsDir() { return `${this.app.vault.configDir}/snippets`; }

	async load(): Promise<void> {
		const { adapter } = this.app.vault;
		this.themes = {};
		if (await adapter.exists(this.themesDir)) {
			for (const dir of (await adapter.list(this.themesDir)).folders) {
				const name = dir.slice(dir.lastIndexOf('/') + 1);
				let m: any = { name };
				try { m = { name, ...JSON.parse(await adapter.read(`${dir}/manifest.json`)) }; } catch { /* manifest optional */ }
				if (await adapter.exists(`${dir}/theme.css`)) this.themes[name] = m;
			}
		}
		this.snippets = (await adapter.exists(this.snippetsDir))
			? (await adapter.list(this.snippetsDir)).files.filter((f) => f.endsWith('.css')).map((f) => f.slice(f.lastIndexOf('/') + 1, -4)).sort()
			: [];
		await this.apply();
	}

	/** Re-read and (re)apply the selected theme and enabled snippets. */
	async apply(): Promise<void> {
		const { vault } = this.app;
		const theme = String(vault.getConfig('cssTheme') ?? '');
		this.themeEl?.remove();
		this.themeEl = null;
		if (theme && this.themes[theme]) {
			// Themes go after our CSS so they can override it, before snippets so snippets win.
			this.themeEl = document.head.createEl('style', { attr: { id: 'css-theme', 'data-theme': theme } });
			this.themeEl.textContent = await vault.adapter.read(`${this.themesDir}/${theme}/theme.css`);
		}
		for (const el of this.snippetEls) el.remove();
		this.snippetEls = [];
		const enabled: string[] = vault.getConfig('enabledCssSnippets') ?? [];
		for (const s of this.snippets.filter((x) => enabled.includes(x))) {
			const el = document.head.createEl('style', { attr: { 'data-snippet': s } });
			el.textContent = await vault.adapter.read(`${this.snippetsDir}/${s}.css`);
			this.snippetEls.push(el);
		}
		this.app.workspace.trigger('css-change');
	}

	setTheme(name: string): void {
		this.app.vault.setConfig('cssTheme', name);
		void this.apply();
	}

	setSnippetEnabled(name: string, on: boolean): void {
		const cur: string[] = this.app.vault.getConfig('enabledCssSnippets') ?? [];
		this.app.vault.setConfig('enabledCssSnippets', on ? [...new Set([...cur, name])] : cur.filter((s) => s !== name));
		void this.apply();
	}

	async installTheme(t: ThemeEntry): Promise<void> {
		const { adapter } = this.app.vault;
		const manifestText = await fetch(raw(t.repo, 'manifest.json')).then((r) => (r.ok ? r.text() : null)).catch(() => null);
		const version = manifestText ? JSON.parse(manifestText).version : undefined;
		let css = await fetch(raw(t.repo, 'theme.css')).then((r) => (r.ok ? r.text() : null)).catch(() => null);
		if (!css && version) css = (await fetchReleaseFile(t.repo, version, 'theme.css')) ?? null;
		if (!css) throw new Error(`Couldn't download theme.css for ${t.name}.`);
		const dir = `${this.themesDir}/${t.name}`;
		await adapter.mkdir(dir);
		await adapter.write(`${dir}/theme.css`, css);
		if (manifestText) await adapter.write(`${dir}/manifest.json`, manifestText);
		await this.load();
	}

	async uninstallTheme(name: string): Promise<void> {
		if (this.app.vault.getConfig('cssTheme') === name) this.app.vault.setConfig('cssTheme', '');
		await this.app.vault.adapter.rmdir(`${this.themesDir}/${name}`, true);
		await this.load();
	}

	async addSnippetFiles(files: File[]): Promise<void> {
		await this.app.vault.adapter.mkdir(this.snippetsDir);
		for (const f of files) if (f.name.endsWith('.css')) await this.app.vault.adapter.write(`${this.snippetsDir}/${f.name.replace(/[/\\]/g, '_')}`, await f.text());
		await this.load();
	}
}

export class ThemeBrowser extends Modal {
	onOpen(): void {
		this.modalEl.addClass('mod-community-modal');
		this.setTitle('Community themes');
		const search = this.contentEl.createEl('input', { type: 'search', placeholder: 'Search themes…', cls: 'setting-search' });
		const grid = this.contentEl.createDiv('community-theme-grid');
		const render = async () => {
			grid.empty();
			let themes: ThemeEntry[];
			try {
				themes = await loadThemeList();
			} catch (e) {
				grid.createDiv({ cls: 'pane-empty', text: `Couldn't load the theme list: ${(e as Error).message}` });
				return;
			}
			const match = prepareFuzzySearch(search.value);
			for (const t of themes.filter((x) => !search.value || match(`${x.name} ${x.author}`)).slice(0, 120)) {
				const card = grid.createDiv('community-theme-card');
				card.createEl('img', { attr: { src: raw(t.repo, t.screenshot), alt: '', loading: 'lazy' } });
				card.createDiv({ cls: 'community-item-name', text: t.name });
				card.createDiv({ cls: 'community-item-meta', text: `By ${t.author} · ${(t.modes ?? []).join(', ')}` });
				const installed = !!this.app.customCss.themes[t.name];
				const btn = card.createEl('button', { cls: installed ? '' : 'mod-cta', text: installed ? 'Use' : 'Install and use' });
				btn.addEventListener('click', async () => {
					btn.disabled = true;
					try {
						if (!installed) await this.app.customCss.installTheme(t);
						this.app.customCss.setTheme(t.name);
						btn.setText('In use');
					} catch (e) {
						btn.disabled = false;
						new Notice((e as Error).message, 8000);
					}
				});
			}
		};
		search.addEventListener('input', () => void render());
		void render();
	}
}

/** Appearance settings: theme selection + snippets (appended to the Appearance tab). */
export function renderThemeSettings(app: App, el: HTMLElement, refresh: () => void): void {
	new Setting(el).setName('Themes').setHeading();
	new Setting(el).setName('Theme').setDesc('Community themes override the default look.')
		.addDropdown((d) => {
			d.addOption('', 'Default');
			for (const name of Object.keys(app.customCss.themes).sort()) d.addOption(name, name);
			d.setValue(String(app.vault.getConfig('cssTheme') ?? '')).onChange((v) => app.customCss.setTheme(v));
		})
		.addButton((b) => b.setButtonText('Browse').onClick(() => new ThemeBrowser(app).setCloseCallback(refresh).open()));
	const current = String(app.vault.getConfig('cssTheme') ?? '');
	if (current) new Setting(el).setName(`Uninstall ${current}`).addButton((b) => b.setButtonText('Uninstall').setWarning().onClick(async () => {
		await app.customCss.uninstallTheme(current);
		refresh();
	}));

	new Setting(el).setName('CSS snippets').setHeading();
	new Setting(el).setName('Snippets').setDesc('CSS files in .obsidian/snippets. Add .css files, then switch them on.')
		.addButton((b) => b.setButtonText('Add .css files').onClick(() => {
			const input = createEl('input', { type: 'file', attr: { multiple: '', accept: '.css,text/css' } });
			input.addEventListener('change', async () => {
				await app.customCss.addSnippetFiles([...(input.files ?? [])]);
				refresh();
			});
			input.click();
		}))
		.addExtraButton((b) => b.setIcon('refresh-cw').setTooltip('Reload snippets').onClick(async () => {
			await app.customCss.load();
			refresh();
		}));
	const enabled: string[] = app.vault.getConfig('enabledCssSnippets') ?? [];
	for (const s of app.customCss.snippets) {
		new Setting(el).setName(s).addToggle((t) => t.setValue(enabled.includes(s)).onChange((v) => app.customCss.setSnippetEnabled(s, v)));
	}
}
