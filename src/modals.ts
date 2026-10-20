// Core modals: command palette, quick switcher, settings (app.setting with SettingTab / PluginSettingTab hooks).
import type { App } from './app';
import { caps } from './caps';
import { setIcon } from './icons';
import { Keymap, eventKey, hotkeyLabel, isMac, type Command, type Hotkey, type Modifier } from './keymap';
import { FuzzySuggestModal, Modal, Setting, SuggestModal, prepareFuzzySearch, renderResults, type FuzzyMatch, type SearchResult } from './ui';
import { TFile } from './vault';
import { Notice } from './workspace';
import { PluginBrowser, renderThemeSettings } from './community';
import { activeBridge, bridgeUserscript, getCorsProxy, hoppscotchVersion, requestUrl, setCorsProxy } from './network';

// ---------------- Command palette ----------------

const recentCommands: string[] = [];

export class CommandPalette extends FuzzySuggestModal<Command> {
	constructor(app: App) {
		super(app);
		this.setPlaceholder('Select a command…');
		this.setInstructions([
			{ command: '↑↓', purpose: 'to navigate' },
			{ command: '↵', purpose: 'to use' },
			{ command: 'esc', purpose: 'to dismiss' },
		]);
	}

	getItems(): Command[] {
		const all = this.app.commands.listCommands().filter((c) => this.app.commands.isAvailable(c));
		const rank = (c: Command) => {
			const i = recentCommands.indexOf(c.id);
			return i < 0 ? Infinity : i;
		};
		return all.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
	}

	getItemText(c: Command): string {
		return c.name;
	}

	renderSuggestion(item: FuzzyMatch<Command>, el: HTMLElement): void {
		el.addClass('mod-complex');
		renderResults(el.createDiv('suggestion-content').createDiv('suggestion-title'), item.item.name, item.match);
		const aux = el.createDiv('suggestion-aux');
		for (const hk of this.app.commands.getHotkeys(item.item.id)) aux.createEl('kbd', { cls: 'suggestion-hotkey', text: hotkeyLabel(hk) });
	}

	onChooseItem(c: Command): void {
		const i = recentCommands.indexOf(c.id);
		if (i >= 0) recentCommands.splice(i, 1);
		recentCommands.unshift(c.id);
		this.app.commands.executeCommand(c);
	}
}

// ---------------- Quick switcher ----------------

interface SwitcherItem {
	file?: TFile;
	alias?: string;
	create?: string;
	match: SearchResult;
}

export class QuickSwitcher extends SuggestModal<SwitcherItem> {
	constructor(app: App) {
		super(app);
		this.setPlaceholder('Find or create a note…');
		this.setInstructions([
			{ command: '↵', purpose: 'to open' },
			{ command: isMac ? '⌘ ↵' : 'ctrl ↵', purpose: 'to open in new tab' },
			{ command: 'shift ↵', purpose: 'to create' },
			{ command: 'esc', purpose: 'to dismiss' },
		]);
		this.scope.register(['Mod'], 'Enter', (evt) => {
			this.selectActiveSuggestion(evt);
			return false;
		});
		this.scope.register(['Shift'], 'Enter', (evt) => {
			const name = this.inputEl.value.trim();
			if (name) {
				this.close();
				this.onChooseSuggestion({ create: name, match: { score: 0, matches: [] } }, evt);
			}
			return false;
		});
	}

	getSuggestions(query: string): SwitcherItem[] {
		const { vault, metadataCache, workspace } = this.app;
		if (!query.trim()) {
			const recent = workspace.getLastOpenFiles().map((p) => vault.getFileByPath(p)).filter((f): f is TFile => !!f);
			const rest = vault.getFiles().filter((f) => !recent.includes(f)).sort((a, b) => b.stat.mtime - a.stat.mtime);
			return [...recent, ...rest].map((file) => ({ file, match: { score: 0, matches: [] } }));
		}
		const search = prepareFuzzySearch(query);
		const out: SwitcherItem[] = [];
		for (const file of vault.getFiles()) {
			const text = file.extension === 'md' ? file.path.slice(0, -3) : file.path;
			const match = search(text);
			if (match) out.push({ file, match });
			const aliases = metadataCache.getFileCache(file)?.frontmatter?.aliases;
			for (const alias of Array.isArray(aliases) ? aliases : aliases ? [aliases] : []) {
				const m = search(String(alias));
				if (m) out.push({ file, alias: String(alias), match: m });
			}
		}
		out.sort((a, b) => b.match.score - a.match.score);
		const exact = out.some((i) => i.file?.basename.toLowerCase() === query.trim().toLowerCase());
		if (!exact) out.push({ create: query.trim(), match: { score: 0, matches: [] } });
		return out;
	}

	renderSuggestion(item: SwitcherItem, el: HTMLElement): void {
		el.addClass('mod-complex');
		const content = el.createDiv('suggestion-content');
		const title = content.createDiv('suggestion-title');
		if (item.create !== undefined) {
			title.setText(item.create);
			el.createDiv('suggestion-aux').createEl('kbd', { cls: 'suggestion-hotkey', text: 'Shift ↵ to create' });
			return;
		}
		const file = item.file!;
		if (item.alias) {
			renderResults(title, item.alias, item.match);
			content.createDiv({ cls: 'suggestion-note', text: file.path });
			return;
		}
		const text = file.extension === 'md' ? file.path.slice(0, -3) : file.path;
		renderResults(title, text, item.match);
		if (file.extension !== 'md') el.createDiv('suggestion-aux').createSpan({ cls: 'suggestion-flair nav-file-tag', text: file.extension });
	}

	async onChooseSuggestion(item: SwitcherItem, evt: MouseEvent | KeyboardEvent): Promise<void> {
		const { workspace, vault, fileManager } = this.app;
		let file = item.file;
		if (item.create !== undefined) {
			const source = workspace.getActiveFile()?.path ?? '';
			const parent = fileManager.getNewFileParent(source);
			const path = `${parent.isRoot() ? '' : parent.path + '/'}${item.create}.md`;
			file = vault.getFileByPath(path) ?? (await vault.create(path, ''));
		}
		if (file) await workspace.getLeaf(Keymap.isModEvent(evt)).openFile(file, { active: true });
	}
}

// ---------------- Settings ----------------

export abstract class SettingTab {
	id = '';
	name = '';
	icon = 'settings';
	/** Core-plugin options are listed in their own group. */
	core = false;
	containerEl: HTMLElement = createDiv('vertical-tab-content');
	/** Declarative settings (obsidian 1.13). ponytail: stored for plugins, not rendered; plugins also implement display(). */
	settingItems: unknown[] = [];
	constructor(public app: App) {}
	abstract display(): void;
	hide(): void {
		this.containerEl.empty();
	}
	getSettingDefinitions(): unknown[] {
		return [];
	}
	update(): void {
		this.settingItems = this.getSettingDefinitions();
	}
	getControlValue(key: string): unknown {
		return this.app.vault.getConfig(key);
	}
	setControlValue(key: string, value: unknown): void | Promise<void> {
		this.app.vault.setConfig(key, value);
	}
}

/** A sub-page inside settings (obsidian 1.13). Plugins subclass it; it renders into containerEl. */
export abstract class SettingPage {
	rootEl = createDiv('setting-page');
	titlebarEl = this.rootEl.createDiv('setting-page-titlebar');
	containerEl = this.rootEl.createDiv('setting-page-content');
	title = '';
	abstract display(): void;
	hide(): void {
		this.containerEl.empty();
	}
}

export class SettingsModal extends Modal {
	settingTabs: SettingTab[] = [];
	pluginTabs: SettingTab[] = [];
	/** Open SettingPages, innermost last (obsidian 1.13 internals). */
	pageStack: unknown[] = [];
	activeTab: SettingTab | null = null;
	private navEl: HTMLElement;
	private contentWrapEl: HTMLElement;

	constructor(app: App) {
		super(app);
		this.modalEl.addClass('mod-settings', 'mod-sidebar-layout');
		this.titleEl.parentElement!.detach();
		const container = this.contentEl.createDiv('vertical-tabs-container');
		this.navEl = container.createDiv('vertical-tab-header');
		this.contentWrapEl = container.createDiv('vertical-tab-content-container');
		this.settingTabs = [new EditorTab(app), new FilesTab(app), new AppearanceTab(app), new HotkeysTab(app), new CorePluginsTab(app), new CommunityPluginsTab(app), new NetworkTab(app), new AboutTab(app)];
	}

	addSettingTab(tab: SettingTab): void {
		this.pluginTabs.push(tab);
		if (this.containerEl.isConnected) this.renderNav();
	}

	removeSettingTab(tab: SettingTab): void {
		const i = this.pluginTabs.indexOf(tab);
		if (i >= 0) this.pluginTabs.splice(i, 1);
		if (this.activeTab === tab) this.openTab(this.settingTabs[0]);
		if (this.containerEl.isConnected) this.renderNav();
	}

	onOpen(): void {
		this.renderNav();
		this.openTab(this.activeTab ?? this.settingTabs[0]);
	}

	onClose(): void {
		this.activeTab?.hide();
	}

	openTabById(id: string): void {
		const tab = [...this.settingTabs, ...this.pluginTabs].find((t) => t.id === id);
		if (tab) this.openTab(tab);
	}

	openTab(tab: SettingTab): void {
		this.activeTab?.hide();
		this.activeTab = tab;
		this.contentWrapEl.replaceChildren(tab.containerEl);
		tab.display();
		for (const el of this.navEl.querySelectorAll('.vertical-tab-nav-item')) el.toggleClass('is-active', el.getAttr('data-id') === tab.id);
	}

	private renderNav(): void {
		this.navEl.empty();
		const group = (title: string, tabs: SettingTab[]) => {
			if (!tabs.length) return;
			const g = this.navEl.createDiv('vertical-tab-header-group');
			g.createDiv({ cls: 'vertical-tab-header-group-title', text: title });
			const items = g.createDiv('vertical-tab-header-group-items');
			for (const t of tabs) {
				const el = items.createDiv({ cls: 'vertical-tab-nav-item', text: t.name, attr: { 'data-id': t.id } });
				el.toggleClass('is-active', t === this.activeTab);
				el.addEventListener('click', () => this.openTab(t));
			}
		};
		group('Options', this.settingTabs);
		group('Core plugins', this.pluginTabs.filter((t) => t.core));
		group('Community plugins', this.pluginTabs.filter((t) => !t.core));
	}
}

/** Toggle/dropdown/text bound to a vault config key. */
function configToggle(app: App, el: HTMLElement, key: string, name: string, desc = '') {
	new Setting(el).setName(name).setDesc(desc).addToggle((t) => t.setValue(!!app.vault.getConfig(key)).onChange((v) => app.vault.setConfig(key, v)));
}
function configDropdown(app: App, el: HTMLElement, key: string, name: string, options: Record<string, string>, desc = '') {
	new Setting(el).setName(name).setDesc(desc).addDropdown((d) => d.addOptions(options).setValue(String(app.vault.getConfig(key))).onChange((v) => app.vault.setConfig(key, v)));
}
function configText(app: App, el: HTMLElement, key: string, name: string, desc = '', placeholder = '') {
	new Setting(el).setName(name).setDesc(desc).addText((t) => t.setPlaceholder(placeholder).setValue(String(app.vault.getConfig(key) ?? '')).onChange((v) => app.vault.setConfig(key, v)));
}

class EditorTab extends SettingTab {
	id = 'editor';
	name = 'Editor';
	display(): void {
		const el = this.containerEl;
		el.empty();
		configDropdown(this.app, el, 'defaultViewMode', 'Default view for new tabs', { source: 'Editing view', preview: 'Reading view' });
		configToggle(this.app, el, 'livePreview', 'Live Preview', 'Hide Markdown syntax away from the cursor. Off = source mode.');
		configDropdown(this.app, el, 'propertiesInDocument', 'Properties in document', { visible: 'Visible', hidden: 'Hidden', source: 'Source' });
		configToggle(this.app, el, 'readableLineLength', 'Readable line length', 'Limit maximum line length.');
		configToggle(this.app, el, 'strictLineBreaks', 'Strict line breaks', 'Single line breaks are ignored in reading view, as in standard Markdown.');
		configToggle(this.app, el, 'spellcheck', 'Spellcheck', "Uses the browser's built-in spellchecker.");
		configToggle(this.app, el, 'showLineNumber', 'Show line numbers');
		configToggle(this.app, el, 'foldHeading', 'Fold headings');
		configToggle(this.app, el, 'foldIndent', 'Fold indent');
	}
}

class FilesTab extends SettingTab {
	id = 'file';
	name = 'Files and links';
	display(): void {
		const el = this.containerEl;
		el.empty();
		configToggle(this.app, el, 'promptDelete', 'Confirm file deletion');
		configDropdown(this.app, el, 'trashOption', 'Deleted files', { local: "Move to vault's .trash folder", none: 'Permanently delete' },
			'The web has no system trash, so "system trash" behaves like the .trash folder.');
		configToggle(this.app, el, 'alwaysUpdateLinks', 'Automatically update internal links', 'Rewrite links when a file is renamed or moved.');
		configDropdown(this.app, el, 'newFileLocation', 'Default location for new notes', { root: 'Vault folder', current: 'Same folder as current file', folder: 'In the folder specified below' });
		configText(this.app, el, 'newFileFolderPath', 'Folder to create new notes in', '', 'Example: folder 1/subfolder 2');
		configDropdown(this.app, el, 'newLinkFormat', 'New link format', { shortest: 'Shortest path when possible', relative: 'Relative path to file', absolute: 'Absolute path in vault' });
		new Setting(el).setName('Use [[Wikilinks]]').setDesc('Off: generate Markdown links instead.')
			.addToggle((t) => t.setValue(!this.app.vault.getConfig('useMarkdownLinks')).onChange((v) => this.app.vault.setConfig('useMarkdownLinks', !v)));
		configText(this.app, el, 'attachmentFolderPath', 'Default location for new attachments', '"/" = vault folder, "./" = same folder as the note, "./name" = subfolder under it.', '/');
	}
}

class AppearanceTab extends SettingTab {
	id = 'appearance';
	name = 'Appearance';
	display(): void {
		const el = this.containerEl;
		el.empty();
		configDropdown(this.app, el, 'theme', 'Base color scheme', { system: 'Adapt to system', moonstone: 'Light', obsidian: 'Dark' });
		new Setting(el).setName('Accent color').setDesc('Leave unset to use the theme default.')
			.addColorPicker((c) => c.setValue(String(this.app.vault.getConfig('accentColor') || '#3b82f6')).onChange((v) => this.app.vault.setConfig('accentColor', v)))
			.addExtraButton((b) => b.setIcon('rotate-ccw').setTooltip('Restore default').onClick(() => {
				this.app.vault.setConfig('accentColor', '');
				this.display();
			}));
		new Setting(el).setName('Font size').setDesc('Font size in pixels for editing and reading views.')
			.addSlider((s) => s.setLimits(10, 30, 1).setValue(Number(this.app.vault.getConfig('baseFontSize'))).setDynamicTooltip().onChange((v) => this.app.vault.setConfig('baseFontSize', v)));
		configText(this.app, el, 'interfaceFontFamily', 'Interface font', 'CSS font-family list.', 'e.g. Inter, sans-serif');
		configText(this.app, el, 'textFontFamily', 'Text font', 'Used in editing and reading views.');
		configText(this.app, el, 'monospaceFontFamily', 'Monospace font', 'Used for code.');
		renderThemeSettings(this.app, el, () => this.display());
	}
}

class HotkeysTab extends SettingTab {
	id = 'hotkeys';
	name = 'Hotkeys';
	private filter = '';

	display(): void {
		const el = this.containerEl;
		el.empty();
		const search = el.createEl('input', { type: 'text', placeholder: 'Filter…', value: this.filter, cls: 'setting-search' });
		const list = el.createDiv();
		const render = () => {
			list.empty();
			const match = prepareFuzzySearch(this.filter);
			const cmds = this.app.commands.listCommands().filter((c) => match(c.name)).sort((a, b) => a.name.localeCompare(b.name));
			for (const cmd of cmds) this.renderCommand(list, cmd, render);
		};
		search.addEventListener('input', () => {
			this.filter = search.value;
			render();
		});
		render();
		el.createDiv({ cls: 'setting-item-description', text: 'Browsers reserve some shortcuts (e.g. Ctrl/⌘+W, T, N) in a normal tab; Alt-based defaults are provided for those.' });
	}

	private renderCommand(list: HTMLElement, cmd: Command, rerender: () => void): void {
		const { commands } = this.app;
		const s = new Setting(list).setName(cmd.name);
		const keys = commands.getHotkeys(cmd.id);
		for (const hk of keys) {
			const kbd = s.controlEl.createEl('kbd', { cls: 'setting-hotkey', text: hotkeyLabel(hk) });
			const x = kbd.createSpan({ cls: 'setting-hotkey-icon setting-delete-hotkey', attr: { 'aria-label': 'Delete hotkey' } });
			setIcon(x, 'x');
			x.addEventListener('click', () => this.save(cmd.id, keys.filter((k) => k !== hk), rerender));
		}
		if (commands.customKeys[cmd.id]) {
			s.addExtraButton((b) => b.setIcon('rotate-ccw').setTooltip('Restore default').onClick(() => this.save(cmd.id, undefined, rerender)));
		}
		s.addExtraButton((b) => b.setIcon('plus-circle').setTooltip('Customize this command').onClick(() => {
			const rec = s.controlEl.createEl('kbd', { cls: 'setting-hotkey mod-active', text: 'Press hotkey…' });
			const onKey = (e: KeyboardEvent) => {
				if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
				e.preventDefault();
				e.stopPropagation();
				window.removeEventListener('keydown', onKey, true);
				rec.detach();
				if (e.key === 'Escape') return;
				const mods: Modifier[] = [];
				if (isMac ? e.metaKey : e.ctrlKey) mods.push('Mod');
				if (isMac && e.ctrlKey) mods.push('Ctrl');
				if (e.altKey) mods.push('Alt');
				if (e.shiftKey) mods.push('Shift');
				this.save(cmd.id, [...keys, { modifiers: mods, key: eventKey(e) }], rerender);
			};
			window.addEventListener('keydown', onKey, true);
		}));
	}

	private save(id: string, keys: Hotkey[] | undefined, rerender: () => void): void {
		const { commands, vault } = this.app;
		if (keys === undefined) delete commands.customKeys[id];
		else commands.customKeys[id] = keys;
		void vault.writeConfigJson('hotkeys', commands.customKeys);
		rerender();
	}
}

class CorePluginsTab extends SettingTab {
	id = 'plugins';
	name = 'Core plugins';
	display(): void {
		const el = this.containerEl;
		el.empty();
		for (const { instance, enabled } of Object.values(this.app.internalPlugins.plugins)) {
			new Setting(el).setName(instance.name).setDesc(instance.description)
				.addToggle((t) => t.setValue(enabled).onChange((v) => this.app.internalPlugins.setEnabled(instance.id, v)));
		}
	}
}

/** Read plugin files picked by the user: a release .zip, or the loose manifest.json + main.js (+ styles.css). */
export async function readPluginFiles(files: File[]): Promise<{ manifest: string; main: string; styles?: string }> {
	const byName = new Map<string, string>();
	for (const f of files) {
		if (f.name.endsWith('.zip')) {
			const { unzipSync } = await import('fflate');
			const entries = unzipSync(new Uint8Array(await f.arrayBuffer()));
			for (const [path, bytes] of Object.entries(entries)) byName.set(path.split('/').pop()!, new TextDecoder().decode(bytes));
		} else {
			byName.set(f.name, await f.text());
		}
	}
	const manifest = byName.get('manifest.json');
	const main = byName.get('main.js');
	if (!manifest || !main) throw new Error('Need manifest.json and main.js (or a .zip containing them).');
	return { manifest, main, styles: byName.get('styles.css') };
}

class CommunityPluginsTab extends SettingTab {
	id = 'community-plugins';
	name = 'Community plugins';

	display(): void {
		const el = this.containerEl;
		el.empty();
		const pm = this.app.plugins;
		if (!pm.isEnabled()) {
			new Setting(el).setName('Restricted mode is on').setDesc('Community plugins can run any code with full access to this vault and to anything this page can reach. Only turn them on if you trust the plugins you install.')
				.addButton((b) => b.setButtonText('Turn on community plugins').setWarning().onClick(async () => {
					pm.setCommunityPluginsEnabled(true);
					await pm.initialize();
					this.display();
				}));
		} else {
			new Setting(el).setName('Restricted mode').setDesc('Off on this device. Turning it on unloads all community plugins.')
				.addButton((b) => b.setButtonText('Turn on restricted mode').onClick(async () => {
					for (const id of Object.keys(pm.plugins)) if (!pm.manifests[id]?.bundled) await pm.unloadPlugin(id);
					pm.setCommunityPluginsEnabled(false);
					this.display();
				}));
		}
		new Setting(el).setName('Community plugins').setDesc('Browse plugins from the Obsidian community directory.')
			.addButton((b) => b.setButtonText('Browse').setCta().onClick(() => new PluginBrowser(this.app).setCloseCallback(() => this.display()).open()));
		new Setting(el).setName('Install plugin from files').setDesc('A release .zip, or manifest.json + main.js (+ styles.css) downloaded from the plugin’s GitHub releases.')
			.addButton((b) => b.setButtonText('Choose files…').onClick(() => {
				const input = createEl('input', { type: 'file', attr: { multiple: '', accept: '.zip,.json,.js,.css' } });
				input.addEventListener('change', async () => {
					try {
						const m = await pm.installPlugin(await readPluginFiles([...(input.files ?? [])]));
						if (pm.isEnabled()) await pm.enablePluginAndSave(m.id);
					} catch (e) {
						new Notice(`Install failed: ${(e as Error).message}`);
					}
					this.display();
				});
				input.click();
			}))
			.addExtraButton((b) => b.setIcon('refresh-cw').setTooltip('Reload plugin list').onClick(async () => {
				await pm.loadManifests();
				this.display();
			}));

		new Setting(el).setName('Installed plugins').setHeading();
		const manifests = Object.values(pm.manifests).sort((a, b) => a.name.localeCompare(b.name));
		if (!manifests.length) el.createDiv({ cls: 'setting-item-description', text: 'No community plugins installed.' });
		for (const m of manifests) {
			const loaded = !!pm.plugins[m.id];
			const s = new Setting(el).setName(`${m.name} ${m.version}${m.bundled ? ' (built in)' : ''}`).setDesc(`By ${m.author}. ${m.description}`);
			const err = pm.errors[m.id] ?? (m.isDesktopOnly ? 'Desktop-only: needs Node.js/Electron.' : '');
			if (err) s.descEl.createDiv({ cls: 'mod-warning setting-plugin-error', text: err });
			if (loaded && this.app.setting.pluginTabs.some((t) => t.id === m.id)) {
				s.addExtraButton((b) => b.setIcon('settings').setTooltip('Options').onClick(() => this.app.setting.openTabById(m.id)));
			}
			if (!m.bundled) s.addExtraButton((b) => b.setIcon('trash-2').setTooltip('Uninstall').onClick(async () => {
				await pm.uninstallPlugin(m.id);
				this.display();
			}));
			s.addToggle((t) => t.setValue(pm.enabledPlugins.has(m.id)).setDisabled((!pm.isEnabled() && !m.bundled) || !!m.isDesktopOnly).onChange(async (v) => {
				if (v) await pm.enablePluginAndSave(m.id);
				else await pm.disablePluginAndSave(m.id);
				this.app.setting.openTab(this);
			}));
		}
	}
}

class NetworkTab extends SettingTab {
	id = 'network';
	name = 'Network';
	display(): void {
		const el = this.containerEl;
		el.empty();
		el.createDiv({ cls: 'setting-item-description', text: 'Browsers block pages from reading most other websites (CORS). Plugins that call web APIs, plugin installs from GitHub releases, and reader mode need a bridge you install yourself. obsidian-online runs no server. Requests use the first bridge available below.' });
		new Setting(el).setName('Active bridge').setDesc(activeBridge());

		const hv = hoppscotchVersion();
		new Setting(el).setName('Hoppscotch browser extension')
			.setDesc(hv ? `Detected, version ${hv}${Number(hv.split('.')[1]) < 35 && hv.startsWith('0.') ? ': too old (CVE-2024-34714), update to 0.35 or newer.' : '.'}` : `Not detected. Install it from the Chrome or Firefox store, then add ${location.origin} to its allowed origins (extension popup).`);

		new Setting(el).setName('Userscript bridge').setDesc('For Violentmonkey or Tampermonkey. Your userscript manager asks before each new site the script contacts.')
			.addButton((b) => b.setButtonText('Download userscript').onClick(() => {
				const url = URL.createObjectURL(new Blob([bridgeUserscript()], { type: 'text/javascript' }));
				createEl('a', { href: url, attr: { download: 'obsidian-online-bridge.user.js' } }).click();
				setTimeout(() => URL.revokeObjectURL(url), 60_000);
			}));

		new Setting(el).setName('Your own CORS proxy').setDesc('Optional. "https://proxy.example/?url=" style (the target is appended URL-encoded), or a base ending in "/" (the target is appended as-is). Stored on this device only.')
			.addText((t) => t.setPlaceholder('https://…').setValue(getCorsProxy()).onChange((v) => setCorsProxy(v.trim())));

		const result = el.createDiv('setting-item-description');
		new Setting(el).setName('Test').setDesc('Fetches https://example.com, which doesn’t allow CORS.')
			.addButton((b) => b.setButtonText('Run test').onClick(async () => {
				result.setText('Testing…');
				try {
					const r = await requestUrl({ url: 'https://example.com/', throw: false });
					result.setText(`OK via ${activeBridge()}: HTTP ${r.status}, ${r.text.length} characters.`);
				} catch (e) {
					result.setText(`Failed: ${(e as Error).message}`);
				}
			}));
	}
}

class AboutTab extends SettingTab {
	id = 'about';
	name = 'About';
	display(): void {
		const el = this.containerEl;
		el.empty();
		new Setting(el).setName('obsidian-online').setDesc('A browser client for Markdown vaults. Not affiliated with Obsidian.').setHeading();
		new Setting(el).setName('Vault storage').setDesc(this.app.vault.adapter.constructor.name.replace('Adapter', '') + ` · ${this.app.vault.getName()}`);
		new Setting(el).setName('Backup').setDesc('Browser storage can be cleared by the browser. Export regularly.')
			.addButton((b) => b.setButtonText('Export .zip').setCta().onClick(() => this.app.commands.executeCommandById('app:export-vault-zip')))
			.addButton((b) => b.setButtonText('Import .zip').onClick(() => this.app.commands.executeCommandById('app:import-zip')));
		new Setting(el).setName('Capabilities').setHeading();
		for (const [k, v] of Object.entries(caps)) new Setting(el).setName(k).setDesc(v ? 'available' : 'unavailable — features fall back where possible');
	}
}
