// In-app guide for setting up the Hoppscotch extension as a network bridge (PLAN §6.3). The status banner polls, so it
// changes by itself as the user installs the extension and adds this site: the extension injects its hook without a reload.
// Images: public/guide/ (sources and how to redo them in scripts/guide/).
import type { App } from './app';
import { activeBridge, hoppscotchState, hoppscotchVersion, requestUrl, type HoppscotchState } from './network';
import { Modal } from './ui';
import { Notice } from './workspace';

const STORES: [string, string][] = [
	['Chrome, Brave, Opera', 'https://chromewebstore.google.com/detail/hoppscotch-browser-extens/amknoiejhlmhancpahfcfcfhllgkpbld'],
	['Edge', 'https://microsoftedge.microsoft.com/addons/detail/fiedjkdkhgihoalhlflpdmoheglbpchf'],
	['Firefox', 'https://addons.mozilla.org/en-US/firefox/addon/hoppscotch/'],
];

function statusText(s: HoppscotchState): string {
	switch (s) {
		case 'missing': return 'Not installed yet. Start with step 1.';
		case 'needs-origin': return `Installed, but this site isn't on its list yet. Do step 3 to add ${location.origin}.`;
		case 'too-old': return `Version ${hoppscotchVersion()} is too old and has a security problem (CVE-2024-34714). Update it to 0.35 or newer.`;
		case 'ready': return `Connected. Hoppscotch extension ${hoppscotchVersion()} is working for this site.`;
	}
}

export class HoppscotchGuide extends Modal {
	private timer = 0;

	constructor(app: App) {
		super(app);
	}

	onClose(): void {
		window.clearInterval(this.timer);
	}

	private step(n: number, title: string): HTMLElement {
		const el = this.contentEl.createDiv('bridge-guide-step');
		el.createEl('h3', { text: `${n}. ${title}` });
		return el;
	}

	private image(parent: HTMLElement, src: string, alt: string): void {
		parent.createEl('img', { cls: 'bridge-guide-img', attr: { src: `guide/${src}`, alt, loading: 'lazy' } });
	}

	onOpen(): void {
		this.setTitle('Set up the Hoppscotch extension');
		this.modalEl.addClass('bridge-guide');
		const el = this.contentEl;
		el.createEl('p', { text: 'Browsers stop web pages from reading most other websites. The free Hoppscotch browser extension lets onsidian make those requests, so you can install community plugins with one click, use plugins that call web services, and use reader mode in the web viewer.' });

		const status = el.createDiv('bridge-guide-status');
		const paint = () => {
			const s = hoppscotchState();
			status.setText(statusText(s));
			status.toggleClass('mod-ready', s === 'ready');
		};
		paint();
		this.timer = window.setInterval(paint, 1000);

		const install = this.step(1, 'Install the extension');
		install.createEl('p', { text: 'Open the store for your browser and choose Add. It takes a few seconds.' });
		const links = install.createDiv('bridge-guide-links');
		for (const [name, href] of STORES) links.createEl('a', { text: name, href, cls: 'external-link', attr: { target: '_blank', rel: 'noopener' } });
		install.createEl('p', { cls: 'bridge-guide-note', text: 'Your browser will warn that the extension can read and change data on all websites. It needs that access to reach any site a plugin asks for. It only accepts requests from sites on its own list, which you control in step 3, and you can remove it at any time.' });

		const open = this.step(2, 'Open the extension');
		open.createEl('p', { text: 'With onsidian as the active tab, select the puzzle piece icon in your browser’s toolbar, then Hoppscotch Browser Extension. The pin icon keeps it in the toolbar.' });
		this.image(open, 'toolbar.png', 'Browser toolbar with the puzzle piece icon open, listing Hoppscotch Browser Extension and its pin icon.');

		const add = this.step(3, 'Add this site');
		add.createEl('p', { text: 'Check that “Enter new origin” shows the address below, then select Add. If the box shows something else, replace it with this address.' });
		const row = add.createDiv('bridge-guide-origin');
		row.createEl('code', { text: location.origin });
		row.createEl('button', { text: 'Copy' }).addEventListener('click', async () => {
			try {
				await navigator.clipboard.writeText(location.origin);
				new Notice('Address copied.');
			} catch {
				new Notice('Couldn’t copy. Select the address and copy it by hand.');
			}
		});
		this.image(add, 'popup.png', 'Hoppscotch extension popup with the site address in the Enter new origin box, the green Add button, and the Active origins list.');
		add.createEl('p', { cls: 'bridge-guide-note', text: 'The picture shows an example address. The list should then include your address under Active origins, and the status at the top of this guide changes to Connected.' });

		const check = this.step(4, 'Test it');
		check.createEl('p', { text: 'This fetches example.com, a site onsidian couldn’t read on its own.' });
		const result = check.createDiv('bridge-guide-note');
		check.createEl('button', { cls: 'mod-cta', text: 'Run test' }).addEventListener('click', async () => {
			result.setText('Testing…');
			try {
				const r = await requestUrl({ url: 'https://example.com/', throw: false });
				result.setText(`It works: connected through ${activeBridge()} (HTTP ${r.status}).`);
			} catch (e) {
				result.setText(`That didn’t work: ${(e as Error).message}`);
			}
		});
		this.image(check, 'network.png', 'onsidian Settings, Network tab, showing Active bridge: Hoppscotch extension.');
		check.createEl('p', { cls: 'bridge-guide-note', text: 'You can see the same status any time in Settings → Network.' });

		const help = this.step(5, 'If it isn’t working');
		const list = help.createEl('ul');
		for (const tip of [
			'Status still says not installed: reload this page once. The extension can’t reach tabs that were open before it was installed.',
			'Firefox: open about:addons, select Hoppscotch, then Permissions, and allow access to all websites.',
			'Check the extension’s site access: in your browser’s extension details, set it to run on all sites.',
			'Private windows: extensions are off there unless you allow them in the extension’s details.',
			'Added the wrong address: the address must match exactly, including http or https and any port. Delete the entry and add it again.',
			'Safari and most mobile browsers can’t use this extension. Install plugins from files instead, or try the userscript bridge in Settings → Network.',
		]) list.createEl('li', { text: tip });

		const buttons = this.modalEl.createDiv('modal-button-container');
		buttons.createEl('button', { text: 'Done' }).addEventListener('click', () => this.close());
	}
}
