'use strict';
// Shaped like esbuild's CommonJS output for obsidianmd/obsidian-sample-plugin (externals: obsidian, @codemirror/*).
var obsidian = require('obsidian');
var view = require('@codemirror/view');

const DEFAULT_SETTINGS = { mySetting: 'default' };

class SampleModal extends obsidian.Modal {
	onOpen() { this.contentEl.setText('Woah!'); }
	onClose() { this.contentEl.empty(); }
}

class SampleSettingTab extends obsidian.PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	display() {
		const { containerEl } = this;
		containerEl.empty();
		new obsidian.Setting(containerEl)
			.setName('Setting #1')
			.setDesc("It's a secret")
			.addText((text) => text
				.setPlaceholder('Enter your secret')
				.setValue(this.plugin.settings.mySetting)
				.onChange(async (value) => {
					this.plugin.settings.mySetting = value;
					await this.plugin.saveSettings();
				}));
	}
}

class SampleView extends obsidian.ItemView {
	getViewType() { return 'sample-view'; }
	getDisplayText() { return 'Sample view'; }
	async onOpen() { this.contentEl.createEl('h4', { text: 'Sample view' }); }
}

class MyPlugin extends obsidian.Plugin {
	async onload() {
		await this.loadSettings();
		const ribbonIconEl = this.addRibbonIcon('dice', 'Sample Plugin', () => new obsidian.Notice('This is a notice!'));
		ribbonIconEl.addClass('my-plugin-ribbon-class');
		this.addStatusBarItem().setText('Status Bar Text');
		this.addCommand({ id: 'open-sample-modal-simple', name: 'Open sample modal (simple)', callback: () => new SampleModal(this.app).open() });
		this.addCommand({
			id: 'sample-editor-command',
			name: 'Sample editor command',
			editorCallback: (editor) => editor.replaceSelection('Sample Editor Command'),
		});
		this.addCommand({
			id: 'open-sample-modal-complex',
			name: 'Open sample modal (complex)',
			checkCallback: (checking) => {
				const markdownView = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
				if (markdownView) {
					if (!checking) new SampleModal(this.app).open();
					return true;
				}
			},
		});
		this.addSettingTab(new SampleSettingTab(this.app, this));
		this.clicks = 0;
		this.registerDomEvent(document, 'click', () => { this.clicks++; });
		this.registerInterval(window.setInterval(() => {}, 5 * 60 * 1000));

		// Beyond the sample: more API surface.
		this.registerMarkdownCodeBlockProcessor('sample', (source, el) => { el.createEl('b', { cls: 'sample-block', text: source.trim().toUpperCase() }); });
		this.registerEditorExtension(view.ViewPlugin.define(() => ({})));
		this.registerView('sample-view', (leaf) => new SampleView(leaf));
		this.registerEvent(this.app.vault.on('create', () => {}));
		this.platformIsWeb = obsidian.Platform.isWeb === true && !obsidian.Platform.isDesktopApp;
		this.yamlRoundTrip = obsidian.stringifyYaml(obsidian.parseYaml('a: 1\nb: [x, y]\n'));
		this.momentWorks = typeof obsidian.moment().format('YYYY') === 'string' && window.moment === obsidian.moment;
		this.fsStub = (() => { try { require('fs').readFileSync('x'); return 'no throw'; } catch (e) { return String(e.message); } })();
	}

	onunload() {}

	async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
	async saveSettings() { await this.saveData(this.settings); }
}

module.exports = MyPlugin;
