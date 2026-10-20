// PDF core plugin (PLAN §5.6): pdf.js viewer with lazily rendered pages + selectable text layer, zoom, #page= links,
// and ![[file.pdf#page=N]] embeds. The browser's own find (Ctrl/⌘+F) searches the text layer.
// ponytail: no outline sidebar or annotation/highlight tools yet.
import type { App } from '../app';
import { CorePlugin } from '../coreplugins';
import { Component } from '../events';
import { setIcon } from '../icons';
import type { TFile } from '../vault';
import { FileView, type WorkspaceLeaf } from '../workspace';

type PdfJs = typeof import('pdfjs-dist');
let pdfjs: Promise<PdfJs> | null = null;

/** obsidian.d.ts loadPdfJs(): lazily loads pdf.js (its worker runs off the main thread when workers are available). */
export function loadPdfJs(): Promise<PdfJs> {
	return (pdfjs ??= (async () => {
		const lib = await import('pdfjs-dist');
		const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
		lib.GlobalWorkerOptions.workerSrc = worker.default;
		return lib;
	})());
}

type PdfDoc = Awaited<ReturnType<PdfJs['getDocument']>['promise']>;

/** Open a PDF; `close()` frees pdf.js resources (the loading task owns them). */
async function openPdf(app: App, file: TFile): Promise<{ doc: PdfDoc; close: () => Promise<void> }> {
	const lib = await loadPdfJs();
	const data = new Uint8Array(await app.vault.readBinary(file));
	const task = lib.getDocument({ data });
	return { doc: await task.promise, close: () => task.destroy() };
}

/** Render one page (canvas + text layer) into `el` at `scale`. */
async function renderPage(doc: PdfDoc, n: number, el: HTMLElement, scale: number): Promise<void> {
	const lib = await loadPdfJs();
	const page = await doc.getPage(n);
	const viewport = page.getViewport({ scale });
	const dpr = window.devicePixelRatio || 1;
	el.empty();
	el.style.width = `${viewport.width}px`;
	el.style.height = `${viewport.height}px`;
	el.style.setProperty('--total-scale-factor', String(scale));
	const canvas = el.createEl('canvas');
	canvas.width = Math.floor(viewport.width * dpr);
	canvas.height = Math.floor(viewport.height * dpr);
	canvas.style.width = `${viewport.width}px`;
	canvas.style.height = `${viewport.height}px`;
	await page.render({ canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
	const textEl = el.createDiv('textLayer');
	await new lib.TextLayer({ textContentSource: page.streamTextContent(), container: textEl, viewport }).render();
}

export class PdfView extends FileView {
	icon = 'file-text';
	private doc: PdfDoc | null = null;
	private closeDoc: (() => Promise<void>) | null = null;
	private scale = 1.2;
	private pagesEl: HTMLElement;
	private pageInput: HTMLInputElement;
	private countEl: HTMLElement;
	private observer: IntersectionObserver | null = null;
	private pendingPage: number | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.contentEl.addClass('pdf-view');
		const bar = this.contentEl.createDiv('pdf-toolbar');
		this.pageInput = bar.createEl('input', { type: 'number', cls: 'pdf-page-input', attr: { min: '1' } });
		this.countEl = bar.createSpan({ cls: 'pdf-page-count' });
		this.pageInput.addEventListener('change', () => this.goToPage(Number(this.pageInput.value)));
		const btn = (icon: string, label: string, fn: () => void) => {
			const b = bar.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': label } });
			setIcon(b, icon);
			b.addEventListener('click', fn);
		};
		btn('zoom-out', 'Zoom out', () => this.setScale(this.scale / 1.2));
		btn('zoom-in', 'Zoom in', () => this.setScale(this.scale * 1.2));
		btn('move-horizontal', 'Fit width', () => void this.fitWidth());
		this.pagesEl = this.contentEl.createDiv('pdf-pages');
		this.pagesEl.addEventListener('scroll', () => this.updatePageNumber());
	}

	getViewType(): string { return 'pdf'; }
	canAcceptExtension(ext: string): boolean { return ext === 'pdf'; }

	async onLoadFile(file: TFile): Promise<void> {
		try {
			const opened = await openPdf(this.app, file);
			this.doc = opened.doc;
			this.closeDoc = opened.close;
		} catch (e) {
			this.pagesEl.empty();
			this.pagesEl.createDiv({ cls: 'pane-empty', text: `Couldn't open this PDF: ${(e as Error).message}` });
			return;
		}
		this.countEl.setText(`of ${this.doc.numPages}`);
		await this.fitWidth();
		if (this.pendingPage) this.goToPage(this.pendingPage);
	}

	async onUnloadFile(): Promise<void> {
		this.observer?.disconnect();
		await this.closeDoc?.();
		this.doc = null;
		this.closeDoc = null;
	}

	/** {subpath: '#page=N'} from links / embeds. */
	setEphemeralState(state: any): void {
		const n = Number(/#?page=(\d+)/.exec(String(state?.subpath ?? ''))?.[1] ?? state?.page);
		if (!n) return;
		if (this.doc) this.goToPage(n);
		else this.pendingPage = n;
	}

	private async fitWidth(): Promise<void> {
		if (!this.doc) return;
		const page = await this.doc.getPage(1);
		const w = this.pagesEl.clientWidth || 800;
		this.setScale(Math.max(0.3, Math.min(4, (w - 48) / page.getViewport({ scale: 1 }).width)));
	}

	private setScale(scale: number): void {
		this.scale = Math.max(0.25, Math.min(5, scale));
		void this.layout();
	}

	/** Size every page placeholder, render on demand as pages scroll into view. */
	private async layout(): Promise<void> {
		const doc = this.doc;
		if (!doc) return;
		const current = Number(this.pageInput.value) || 1;
		this.observer?.disconnect();
		this.pagesEl.empty();
		const first = (await doc.getPage(1)).getViewport({ scale: this.scale });
		this.observer = new IntersectionObserver((entries) => {
			for (const e of entries) {
				const el = e.target as HTMLElement;
				if (!e.isIntersecting || el.dataset.rendered) continue;
				el.dataset.rendered = '1';
				void renderPage(doc, Number(el.dataset.page), el, this.scale).catch((err) => el.setText(String(err?.message ?? err)));
			}
		}, { root: this.pagesEl, rootMargin: '600px 0px' });
		for (let n = 1; n <= doc.numPages; n++) {
			const el = this.pagesEl.createDiv({ cls: 'pdf-page', attr: { 'data-page': String(n) } });
			el.style.width = `${first.width}px`;
			el.style.height = `${first.height}px`;
			this.observer.observe(el);
		}
		this.goToPage(current);
	}

	private goToPage(n: number): void {
		const el = this.pagesEl.querySelector<HTMLElement>(`[data-page="${n}"]`);
		if (!el) return;
		this.pendingPage = null;
		this.pagesEl.scrollTop = el.offsetTop - this.pagesEl.offsetTop - 8;
		this.pageInput.value = String(n);
	}

	private updatePageNumber(): void {
		const top = this.pagesEl.scrollTop + this.pagesEl.clientHeight / 3;
		for (const el of this.pagesEl.querySelectorAll<HTMLElement>('.pdf-page')) {
			if (el.offsetTop - this.pagesEl.offsetTop + el.offsetHeight > top) {
				this.pageInput.value = el.dataset.page!;
				return;
			}
		}
	}
}

export class PdfPlugin extends CorePlugin {
	id = 'pdf';
	name = 'PDF viewer';
	description = 'View PDFs with pdf.js; embeds show a page.';

	onload(): void {
		this.registerView('pdf', (leaf) => new PdfView(leaf));
		this.app.viewRegistry.registerExtensions(['pdf'], 'pdf');
		this.register(() => delete this.app.viewRegistry.typeByExtension.pdf);
		// ![[file.pdf#page=N]] renders that page (first page by default).
		this.app.embedRegistry.registerExtension('pdf', (ctx: { app: App; containerEl: HTMLElement }, file: TFile, subpath: string) => {
			const child = new Component() as Component & { loadFile(): Promise<void> };
			child.loadFile = async () => {
				ctx.containerEl.addClass('pdf-embed');
				const pageEl = ctx.containerEl.createDiv('pdf-page');
				try {
					const { doc, close } = await openPdf(ctx.app, file);
					child.register(() => void close());
					const n = Math.min(doc.numPages, Number(/page=(\d+)/.exec(subpath)?.[1] ?? 1));
					const width = ctx.containerEl.clientWidth || 600;
					const scale = width / (await doc.getPage(n)).getViewport({ scale: 1 }).width;
					await renderPage(doc, n, pageEl, Math.min(2, scale));
				} catch (e) {
					pageEl.setText(`Couldn't render ${file.name}: ${(e as Error).message}`);
				}
			};
			return child;
		});
		this.register(() => this.app.embedRegistry.unregisterExtension('pdf'));
	}
}
