// Canvas core plugin (PLAN §5.5): JSON Canvas 1.0 files (reference/jsoncanvas/spec/1.0.md).
// DOM nodes + SVG edges on a transformed plane. `view.canvas` exposes the internal names plugins patch
// (nodes, edges, getData, setData, requestSave, markViewportChanged, zoomToFit).
// ponytail: text cards edit in a plain <textarea> (Obsidian embeds a full editor); swap in a CM6 editor if needed.
import type { App } from '../app';
import { CorePlugin } from '../coreplugins';
import { Component } from '../events';
import { setIcon } from '../icons';
import { Keymap } from '../keymap';
import { MarkdownRenderer } from '../render';
import { FuzzySuggestModal, Menu, promptText } from '../ui';
import { TFile, type TAbstractFile } from '../vault';
import { Notice, TextFileView, type WorkspaceLeaf } from '../workspace';

type Side = 'top' | 'right' | 'bottom' | 'left';

export interface CanvasNodeData {
	id: string;
	type: 'text' | 'file' | 'link' | 'group';
	x: number; y: number; width: number; height: number;
	color?: string;
	text?: string;
	file?: string;
	subpath?: string;
	url?: string;
	label?: string;
	background?: string;
	backgroundStyle?: 'cover' | 'ratio' | 'repeat';
}

export interface CanvasEdgeData {
	id: string;
	fromNode: string; fromSide?: Side; fromEnd?: 'none' | 'arrow';
	toNode: string; toSide?: Side; toEnd?: 'none' | 'arrow';
	color?: string;
	label?: string;
}

export interface CanvasData { nodes: CanvasNodeData[]; edges: CanvasEdgeData[]; }

const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
const IMAGE = /^(png|jpe?g|gif|bmp|svg|webp|avif)$/i;
const VIDEO = /^(mp4|webm|ogv|mov|mkv)$/i;
const AUDIO = /^(mp3|wav|m4a|ogg|3gp|flac)$/i;

/** Preset colors "1"–"6" map to --canvas-color-N (an RGB triplet); other values are CSS colors. */
function colorVar(c?: string): string | null {
	if (!c) return null;
	return /^[1-6]$/.test(c) ? `rgb(var(--canvas-color-${c}))` : c;
}

function anchor(n: CanvasNodeData, side: Side): { x: number; y: number } {
	switch (side) {
		case 'top': return { x: n.x + n.width / 2, y: n.y };
		case 'bottom': return { x: n.x + n.width / 2, y: n.y + n.height };
		case 'left': return { x: n.x, y: n.y + n.height / 2 };
		case 'right': return { x: n.x + n.width, y: n.y + n.height / 2 };
	}
}

/** Sides facing each other when an edge doesn't specify them. */
function autoSides(a: CanvasNodeData, b: CanvasNodeData): [Side, Side] {
	const dx = b.x + b.width / 2 - (a.x + a.width / 2);
	const dy = b.y + b.height / 2 - (a.y + a.height / 2);
	if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? ['right', 'left'] : ['left', 'right'];
	return dy > 0 ? ['bottom', 'top'] : ['top', 'bottom'];
}

const DIR: Record<Side, [number, number]> = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };

function edgePath(from: CanvasNodeData, to: CanvasNodeData, e: CanvasEdgeData): { d: string; mid: { x: number; y: number } } {
	const [fs, ts] = autoSides(from, to);
	const fSide = e.fromSide ?? fs;
	const tSide = e.toSide ?? ts;
	const p1 = anchor(from, fSide);
	const p2 = anchor(to, tSide);
	const k = Math.max(40, Math.hypot(p2.x - p1.x, p2.y - p1.y) * 0.4);
	const c1 = { x: p1.x + DIR[fSide][0] * k, y: p1.y + DIR[fSide][1] * k };
	const c2 = { x: p2.x + DIR[tSide][0] * k, y: p2.y + DIR[tSide][1] * k };
	const mid = { x: (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8, y: (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8 };
	return { d: `M${p1.x},${p1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`, mid };
}

// ---------------- Rendering (shared by the editor and read-only embeds) ----------------

function renderNodeContent(app: App, n: CanvasNodeData, el: HTMLElement, sourcePath: string, component: Component): void {
	el.empty();
	if (n.type === 'text') {
		const md = el.createDiv('markdown-rendered markdown-preview-view');
		void MarkdownRenderer.render(app, n.text ?? '', md, sourcePath, component);
	} else if (n.type === 'file') {
		const file = app.vault.getFileByPath(n.file ?? '');
		if (!file) {
			el.createDiv({ cls: 'canvas-node-placeholder', text: `"${n.file}" not found.` });
			return;
		}
		if (IMAGE.test(file.extension)) {
			const img = el.createEl('img', { cls: 'canvas-node-image' });
			void app.vault.getResourceUrl(file).then((u) => (img.src = u));
		} else if (VIDEO.test(file.extension) || AUDIO.test(file.extension)) {
			const media = el.createEl(VIDEO.test(file.extension) ? 'video' : 'audio', { attr: { controls: '' } });
			void app.vault.getResourceUrl(file).then((u) => (media.src = u));
		} else if (file.extension === 'md') {
			const md = el.createDiv('markdown-rendered markdown-preview-view');
			void MarkdownRenderer.render(app, `![[${file.path}${n.subpath ?? ''}]]`, md, sourcePath, component);
		} else {
			el.createDiv({ cls: 'canvas-node-placeholder', text: file.name });
		}
	} else if (n.type === 'link') {
		const card = el.createDiv('canvas-link-card');
		let host = n.url ?? '';
		try { host = new URL(n.url ?? '').host; } catch { /* keep raw */ }
		card.createDiv({ cls: 'canvas-link-host', text: host });
		card.createEl('a', { cls: 'external-link', text: n.url ?? '', href: n.url ?? '#', attr: { target: '_blank', rel: 'noopener nofollow' } });
	}
}

/** Read-only render of a whole canvas, scaled to fit `el` (used for ![[file.canvas]] embeds). */
export function renderCanvasStatic(app: App, data: CanvasData, el: HTMLElement, sourcePath: string, component: Component): void {
	el.addClass('canvas-embed');
	if (!data.nodes.length) {
		el.createDiv({ cls: 'canvas-node-placeholder', text: 'Empty canvas' });
		return;
	}
	const minX = Math.min(...data.nodes.map((n) => n.x));
	const minY = Math.min(...data.nodes.map((n) => n.y));
	const maxX = Math.max(...data.nodes.map((n) => n.x + n.width));
	const maxY = Math.max(...data.nodes.map((n) => n.y + n.height));
	const w = maxX - minX + 80;
	const h = maxY - minY + 80;
	const scale = Math.min(1, 640 / w);
	const viewport = el.createDiv('canvas-embed-viewport');
	viewport.style.height = `${h * scale}px`;
	const plane = viewport.createDiv('canvas');
	plane.style.transform = `scale(${scale}) translate(${-minX + 40}px, ${-minY + 40}px)`;
	drawEdges(plane, data);
	for (const n of data.nodes) {
		const nodeEl = plane.createDiv({ cls: `canvas-node canvas-node-${n.type}` });
		placeNode(nodeEl, n);
		if (n.type === 'group') nodeEl.createDiv({ cls: 'canvas-group-label', text: n.label ?? '' });
		else renderNodeContent(app, n, nodeEl.createDiv('canvas-node-container').createDiv('canvas-node-content'), sourcePath, component);
	}
}

function placeNode(el: HTMLElement, n: CanvasNodeData): void {
	el.style.transform = `translate(${n.x}px, ${n.y}px)`;
	el.style.width = `${n.width}px`;
	el.style.height = `${n.height}px`;
	const c = colorVar(n.color);
	el.toggleClass('is-themed', !!c);
	if (c) el.style.setProperty('--canvas-color', c);
	else el.style.removeProperty('--canvas-color');
}

function drawEdges(plane: HTMLElement, data: CanvasData, selected?: Set<string>): SVGSVGElement {
	const ns = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(ns, 'svg');
	svg.setAttribute('class', 'canvas-edges');
	const byId = new Map(data.nodes.map((n) => [n.id, n]));
	for (const e of data.edges) {
		const from = byId.get(e.fromNode);
		const to = byId.get(e.toNode);
		if (!from || !to) continue;
		const { d, mid } = edgePath(from, to, e);
		const g = document.createElementNS(ns, 'g');
		g.setAttribute('class', `canvas-edge${selected?.has(e.id) ? ' is-focused' : ''}`);
		g.dataset.id = e.id;
		const c = colorVar(e.color);
		if (c) g.style.setProperty('--canvas-color', c);
		const hit = document.createElementNS(ns, 'path');
		hit.setAttribute('class', 'canvas-interaction-path');
		hit.setAttribute('d', d);
		const path = document.createElementNS(ns, 'path');
		path.setAttribute('class', 'canvas-display-path');
		path.setAttribute('d', d);
		if ((e.toEnd ?? 'arrow') === 'arrow') path.setAttribute('marker-end', 'url(#canvas-arrow)');
		if (e.fromEnd === 'arrow') path.setAttribute('marker-start', 'url(#canvas-arrow-start)');
		g.append(hit, path);
		if (e.label) {
			const t = document.createElementNS(ns, 'text');
			t.setAttribute('class', 'canvas-edge-label');
			t.setAttribute('x', String(mid.x));
			t.setAttribute('y', String(mid.y));
			t.textContent = e.label;
			g.append(t);
		}
		svg.append(g);
	}
	svg.insertAdjacentHTML('afterbegin', '<defs><marker id="canvas-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="canvas-arrow-head"/></marker><marker id="canvas-arrow-start" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="canvas-arrow-head"/></marker></defs>');
	plane.prepend(svg);
	return svg;
}

// ---------------- Editor view ----------------

export class CanvasView extends TextFileView {
	icon = 'layout-dashboard';
	/** Internal controller (plugins reach view.canvas). */
	canvas: CanvasController;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.contentEl.addClass('canvas-wrapper');
		this.canvas = new CanvasController(this);
	}

	getViewType(): string { return 'canvas'; }

	getViewData(): string {
		return JSON.stringify(this.canvas.getData(), null, '\t');
	}

	/** Set when the file isn't valid JSON: we show it empty and never write it back (that would destroy it). */
	private unreadable = false;

	setViewData(data: string, clear: boolean): void {
		let parsed: CanvasData = { nodes: [], edges: [] };
		this.unreadable = false;
		try {
			const j = data.trim() ? JSON.parse(data) : {};
			parsed = { nodes: Array.isArray(j.nodes) ? j.nodes : [], edges: Array.isArray(j.edges) ? j.edges : [] };
		} catch {
			this.unreadable = true;
			new Notice('This canvas file is not valid JSON, so it is shown empty and changes here will not be saved. Fix the file in a text editor first.', 10000);
		}
		this.canvas.setData(parsed, clear);
	}

	async save(clear?: boolean): Promise<void> {
		if (this.unreadable) {
			this.requestSave.cancel();
			return;
		}
		await super.save(clear);
	}

	clear(): void {
		this.canvas.setData({ nodes: [], edges: [] }, true);
	}

	onunload(): void {
		this.canvas.renderer.unload();
	}
}

class CanvasController {
	nodes = new Map<string, CanvasNodeData & { nodeEl?: HTMLElement }>();
	edges = new Map<string, CanvasEdgeData>();
	selection = new Set<string>();
	/** pan (x, y) and zoom of the viewport */
	tx = 0;
	ty = 0;
	zoom = 1;
	renderer = new Component();
	wrapperEl: HTMLElement;
	canvasEl: HTMLElement;
	private edgesEl: SVGSVGElement | null = null;
	private undoStack: string[] = [];
	private redoStack: string[] = [];
	private fittedOnce = false;

	constructor(private view: CanvasView) {
		this.renderer.load();
		this.wrapperEl = view.contentEl;
		this.canvasEl = this.wrapperEl.createDiv('canvas');
		this.buildControls();
		this.bindEvents();
		// Fit once the view has a size (new tabs are 0×0 when the data arrives).
		const ro = new ResizeObserver(() => {
			if (!this.fittedOnce && this.wrapperEl.clientWidth) this.zoomToFit();
		});
		ro.observe(this.wrapperEl);
		view.register(() => ro.disconnect());
	}

	private get app(): App { return this.view.app; }
	private get path(): string { return this.view.file?.path ?? ''; }

	getData(): CanvasData {
		const nodes = [...this.nodes.values()].map(({ nodeEl: _el, ...n }) => n);
		return { nodes, edges: [...this.edges.values()] };
	}

	setData(data: CanvasData, resetView = false): void {
		this.nodes = new Map(data.nodes.map((n) => [n.id, { ...n }]));
		this.edges = new Map(data.edges.map((e) => [e.id, { ...e }]));
		this.selection.clear();
		if (resetView) {
			this.undoStack = [];
			this.redoStack = [];
			this.fittedOnce = false;
		}
		this.render();
		if (!this.fittedOnce && this.wrapperEl.clientWidth) this.zoomToFit();
	}

	requestSave(): void {
		this.view.requestSave();
	}

	markViewportChanged(): void {
		this.canvasEl.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.zoom})`;
		this.wrapperEl.style.setProperty('--canvas-zoom', String(this.zoom));
		this.wrapperEl.style.backgroundPosition = `${this.tx}px ${this.ty}px`;
		this.wrapperEl.style.backgroundSize = `${20 * this.zoom}px ${20 * this.zoom}px`;
	}

	zoomToFit(): void {
		const r = this.wrapperEl.getBoundingClientRect();
		if (!r.width) return;
		this.fittedOnce = true;
		const list = [...this.nodes.values()];
		if (!list.length) {
			this.tx = r.width / 2;
			this.ty = r.height / 2;
			this.zoom = 1;
			return this.markViewportChanged();
		}
		const minX = Math.min(...list.map((n) => n.x));
		const minY = Math.min(...list.map((n) => n.y));
		const maxX = Math.max(...list.map((n) => n.x + n.width));
		const maxY = Math.max(...list.map((n) => n.y + n.height));
		this.zoom = Math.max(0.1, Math.min(1, Math.min((r.width - 80) / (maxX - minX), (r.height - 80) / (maxY - minY))));
		this.tx = r.width / 2 - ((minX + maxX) / 2) * this.zoom;
		this.ty = r.height / 2 - ((minY + maxY) / 2) * this.zoom;
		this.markViewportChanged();
	}

	// ----- mutations (each one is undoable) -----

	private checkpoint(): void {
		this.undoStack.push(JSON.stringify(this.getData()));
		if (this.undoStack.length > 100) this.undoStack.shift();
		this.redoStack = [];
	}

	private changed(): void {
		this.render();
		this.requestSave();
	}

	undo(): void {
		const prev = this.undoStack.pop();
		if (!prev) return;
		this.redoStack.push(JSON.stringify(this.getData()));
		this.setData(JSON.parse(prev));
		this.requestSave();
	}

	redo(): void {
		const next = this.redoStack.pop();
		if (!next) return;
		this.undoStack.push(JSON.stringify(this.getData()));
		this.setData(JSON.parse(next));
		this.requestSave();
	}

	addNode(partial: Omit<CanvasNodeData, 'id'>): CanvasNodeData {
		this.checkpoint();
		const n = { id: newId(), ...partial };
		// Groups go to the bottom of the z-order so cards inside stay visible.
		if (n.type === 'group') this.nodes = new Map([[n.id, n], ...this.nodes]);
		else this.nodes.set(n.id, n);
		this.selection = new Set([n.id]);
		this.changed();
		return n;
	}

	deleteSelection(): void {
		if (!this.selection.size) return;
		this.checkpoint();
		for (const id of this.selection) {
			this.nodes.delete(id);
			this.edges.delete(id);
		}
		for (const [id, e] of this.edges) if (!this.nodes.has(e.fromNode) || !this.nodes.has(e.toNode)) this.edges.delete(id);
		this.selection.clear();
		this.changed();
	}

	setColor(color: string | undefined): void {
		this.checkpoint();
		for (const id of this.selection) {
			const item = this.nodes.get(id) ?? this.edges.get(id);
			if (item) item.color = color;
		}
		this.changed();
	}

	// ----- rendering -----

	render(): void {
		this.renderer.unload();
		this.renderer = new Component();
		this.renderer.load();
		this.canvasEl.empty();
		this.edgesEl = drawEdges(this.canvasEl, this.getData(), this.selection);
		for (const n of this.nodes.values()) this.renderNode(n);
		this.markViewportChanged();
	}

	private renderNode(n: CanvasNodeData & { nodeEl?: HTMLElement }): void {
		const el = this.canvasEl.createDiv({ cls: `canvas-node canvas-node-${n.type}`, attr: { 'data-id': n.id } });
		n.nodeEl = el;
		el.toggleClass('is-focused', this.selection.has(n.id));
		placeNode(el, n);
		if (n.type === 'group') {
			el.createDiv({ cls: 'canvas-group-label', text: n.label ?? '' });
		} else {
			const content = el.createDiv('canvas-node-container').createDiv('canvas-node-content');
			if (n.type === 'file') el.createDiv({ cls: 'canvas-node-label', text: n.file ?? '' });
			renderNodeContent(this.app, n, content, this.path, this.renderer);
		}
		for (const side of ['top', 'right', 'bottom', 'left'] as Side[]) el.createDiv({ cls: `canvas-node-connection-point mod-${side}`, attr: { 'data-side': side } });
		el.createDiv('canvas-node-resizer');
	}

	/** Replace a text card's content with an editor until it loses focus. */
	private editText(n: CanvasNodeData & { nodeEl?: HTMLElement }): void {
		const content = n.nodeEl?.querySelector<HTMLElement>('.canvas-node-content');
		if (!content || n.type !== 'text') return;
		const before = n.text ?? '';
		content.empty();
		const ta = content.createEl('textarea', { cls: 'canvas-node-textarea' });
		ta.value = before;
		ta.focus();
		ta.addEventListener('keydown', (e) => {
			e.stopPropagation();
			if (e.key === 'Escape') ta.blur();
		});
		ta.addEventListener('pointerdown', (e) => e.stopPropagation());
		ta.addEventListener('blur', () => {
			if (ta.value !== before) {
				this.checkpoint();
				n.text = ta.value;
				this.changed();
			} else this.render();
		});
	}

	// ----- coordinates & events -----

	private toWorld(e: { clientX: number; clientY: number }): { x: number; y: number } {
		const r = this.wrapperEl.getBoundingClientRect();
		return { x: (e.clientX - r.left - this.tx) / this.zoom, y: (e.clientY - r.top - this.ty) / this.zoom };
	}

	private nodeFromEvent(e: Event): (CanvasNodeData & { nodeEl?: HTMLElement }) | null {
		const el = (e.target as HTMLElement).closest('.canvas-node') as HTMLElement | null;
		return el ? this.nodes.get(el.dataset.id!) ?? null : null;
	}

	private bindEvents(): void {
		const w = this.wrapperEl;
		w.tabIndex = 0;

		w.addEventListener('wheel', (e) => {
			e.preventDefault();
			if (e.ctrlKey || e.metaKey) {
				const p = this.toWorld(e);
				const z = Math.max(0.1, Math.min(4, this.zoom * Math.exp(-e.deltaY * 0.01)));
				const r = w.getBoundingClientRect();
				this.tx = e.clientX - r.left - p.x * z;
				this.ty = e.clientY - r.top - p.y * z;
				this.zoom = z;
			} else {
				this.tx -= e.deltaX;
				this.ty -= e.deltaY;
			}
			this.markViewportChanged();
		}, { passive: false });

		w.addEventListener('pointerdown', (e) => {
			if ((e.target as HTMLElement).closest('.canvas-controls, textarea, a, video, audio')) return;
			w.focus();
			const start = this.toWorld(e);
			const target = e.target as HTMLElement;
			const node = this.nodeFromEvent(e);
			const edgeEl = target.closest('.canvas-edge') as SVGGElement | null;

			// Connect: drag from a connection point onto another node.
			if (node && target.hasClass('canvas-node-connection-point')) return this.dragConnect(e, node, target.dataset.side as Side);
			// Resize: bottom-right handle.
			if (node && target.hasClass('canvas-node-resizer')) return this.dragResize(e, node);

			if (edgeEl) {
				this.selection = new Set([edgeEl.dataset.id!]);
				return this.render();
			}
			if (node) {
				if (!e.shiftKey && !this.selection.has(node.id)) this.selection = new Set([node.id]);
				else if (e.shiftKey && this.selection.has(node.id)) this.selection.delete(node.id);
				else if (e.shiftKey) this.selection.add(node.id);
				for (const el of this.canvasEl.querySelectorAll('.canvas-node')) el.toggleClass('is-focused', this.selection.has((el as HTMLElement).dataset.id!));
				return this.dragMove(e, start);
			}
			// Empty space: pan.
			this.selection.clear();
			for (const el of this.canvasEl.querySelectorAll('.is-focused')) el.removeClass('is-focused');
			const tx = this.tx;
			const ty = this.ty;
			this.drag(e, (ev) => {
				this.tx = tx + ev.clientX - e.clientX;
				this.ty = ty + ev.clientY - e.clientY;
				this.markViewportChanged();
			});
		});

		w.addEventListener('dblclick', (e) => {
			const node = this.nodeFromEvent(e);
			if (node?.type === 'text') return this.editText(node);
			if (node?.type === 'file') {
				const f = this.app.vault.getFileByPath(node.file ?? '');
				if (f) void this.app.workspace.getLeaf(Keymap.isModEvent(e) || 'tab').openFile(f, { eState: node.subpath ? { subpath: node.subpath } : undefined });
				return;
			}
			if (node?.type === 'group') return void this.renameGroup(node);
			if ((e.target as HTMLElement).closest('.canvas-edge')) return void this.labelEdge();
			if (!node) {
				const p = this.toWorld(e);
				const n = this.addNode({ type: 'text', text: '', x: Math.round(p.x - 125), y: Math.round(p.y - 30), width: 250, height: 60 });
				this.editText(this.nodes.get(n.id)!);
			}
		});

		w.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			const node = this.nodeFromEvent(e);
			const edgeEl = (e.target as HTMLElement).closest('.canvas-edge') as SVGGElement | null;
			if (node && !this.selection.has(node.id)) this.selection = new Set([node.id]);
			if (edgeEl) this.selection = new Set([edgeEl.dataset.id!]);
			const menu = new Menu();
			if (this.selection.size) {
				for (const [c, name] of [['1', 'Red'], ['2', 'Orange'], ['3', 'Yellow'], ['4', 'Green'], ['5', 'Cyan'], ['6', 'Purple']]) {
					menu.addItem((i) => i.setTitle(name).setIcon('palette').setSection('color').onClick(() => this.setColor(c)));
				}
				menu.addItem((i) => i.setTitle('No color').setSection('color').onClick(() => this.setColor(undefined)));
				if (edgeEl) menu.addItem((i) => i.setTitle('Edit label…').setIcon('pencil').setSection('edit').onClick(() => void this.labelEdge()));
				menu.addItem((i) => i.setTitle('Remove').setIcon('trash-2').setWarning(true).setSection('danger').onClick(() => this.deleteSelection()));
			} else {
				const p = this.toWorld(e);
				menu.addItem((i) => i.setTitle('Add card').setIcon('sticky-note').onClick(() => this.addNode({ type: 'text', text: '', x: p.x, y: p.y, width: 250, height: 60 })));
				menu.addItem((i) => i.setTitle('Add note from vault').setIcon('file-text').onClick(() => this.addFileAt(p)));
				menu.addItem((i) => i.setTitle('Add web link').setIcon('globe').onClick(() => void this.addLinkAt(p)));
				menu.addItem((i) => i.setTitle('Create group').setIcon('box-select').onClick(() => this.addNode({ type: 'group', label: 'Group', x: p.x, y: p.y, width: 400, height: 300 })));
			}
			menu.showAtMouseEvent(e);
		});

		w.addEventListener('keydown', (e) => {
			if ((e.target as HTMLElement).tagName === 'TEXTAREA') return;
			const mod = Keymap.isModifier(e, 'Mod');
			if (e.key === 'Delete' || e.key === 'Backspace') this.deleteSelection();
			else if (mod && e.key.toLowerCase() === 'z' && e.shiftKey) this.redo();
			else if (mod && e.key.toLowerCase() === 'z') this.undo();
			else if (mod && e.key.toLowerCase() === 'y') this.redo();
			else if (mod && e.key.toLowerCase() === 'a') {
				this.selection = new Set(this.nodes.keys());
				this.render();
			} else return;
			e.preventDefault();
			e.stopPropagation();
		});

		// Drop files from the explorer or the OS (vault files only for OS drops: we don't import here).
		w.addEventListener('dragover', (e) => e.preventDefault());
		w.addEventListener('drop', (e) => {
			e.preventDefault();
			const path = e.dataTransfer?.getData('text/plain');
			const file = path ? this.app.vault.getFileByPath(path) : null;
			if (file) this.addFile(file, this.toWorld(e));
		});
	}

	private drag(e: PointerEvent, move: (ev: PointerEvent) => void, done?: (ev: PointerEvent) => void): void {
		const el = this.wrapperEl;
		el.setPointerCapture(e.pointerId);
		const onMove = (ev: PointerEvent) => move(ev);
		const onUp = (ev: PointerEvent) => {
			el.removeEventListener('pointermove', onMove);
			el.removeEventListener('pointerup', onUp);
			done?.(ev);
		};
		el.addEventListener('pointermove', onMove);
		el.addEventListener('pointerup', onUp);
	}

	/** Move selected nodes; dragging a group also moves the nodes inside it. */
	private dragMove(e: PointerEvent, start: { x: number; y: number }): void {
		const moving = new Set(this.selection);
		for (const id of this.selection) {
			const g = this.nodes.get(id);
			if (g?.type !== 'group') continue;
			for (const n of this.nodes.values()) if (n.x >= g.x && n.y >= g.y && n.x + n.width <= g.x + g.width && n.y + n.height <= g.y + g.height) moving.add(n.id);
		}
		const origin = new Map([...moving].map((id) => [id, { x: this.nodes.get(id)!.x, y: this.nodes.get(id)!.y }]));
		let moved = false;
		this.drag(e, (ev) => {
			const p = this.toWorld(ev);
			const dx = Math.round(p.x - start.x);
			const dy = Math.round(p.y - start.y);
			if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
			if (!moved) this.checkpoint();
			moved = true;
			for (const [id, o] of origin) {
				const n = this.nodes.get(id)!;
				n.x = o.x + dx;
				n.y = o.y + dy;
				if (n.nodeEl) placeNode(n.nodeEl, n);
			}
			this.redrawEdges();
		}, () => moved && this.requestSave());
	}

	private dragResize(e: PointerEvent, n: CanvasNodeData & { nodeEl?: HTMLElement }): void {
		this.checkpoint();
		const start = this.toWorld(e);
		const w0 = n.width;
		const h0 = n.height;
		this.drag(e, (ev) => {
			const p = this.toWorld(ev);
			n.width = Math.max(60, Math.round(w0 + p.x - start.x));
			n.height = Math.max(40, Math.round(h0 + p.y - start.y));
			if (n.nodeEl) placeNode(n.nodeEl, n);
			this.redrawEdges();
		}, () => this.requestSave());
	}

	private dragConnect(e: PointerEvent, from: CanvasNodeData, fromSide: Side): void {
		const ns = 'http://www.w3.org/2000/svg';
		const line = document.createElementNS(ns, 'path');
		line.setAttribute('class', 'canvas-display-path canvas-edge-preview');
		this.edgesEl?.append(line);
		const a = anchor(from, fromSide);
		this.drag(e, (ev) => {
			const p = this.toWorld(ev);
			line.setAttribute('d', `M${a.x},${a.y} L${p.x},${p.y}`);
		}, (ev) => {
			line.remove();
			const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.canvas-node') as HTMLElement | null;
			const to = el ? this.nodes.get(el.dataset.id!) : null;
			if (!to || to.id === from.id) return;
			const side = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.dataset.side as Side | undefined;
			this.checkpoint();
			const edge: CanvasEdgeData = { id: newId(), fromNode: from.id, fromSide, toNode: to.id, toSide: side ?? autoSides(from, to)[1] };
			this.edges.set(edge.id, edge);
			this.changed();
		});
	}

	private redrawEdges(): void {
		this.edgesEl?.remove();
		this.edgesEl = drawEdges(this.canvasEl, this.getData(), this.selection);
	}

	private async renameGroup(n: CanvasNodeData): Promise<void> {
		const label = await promptText(this.app, 'Group label', n.label ?? '');
		if (label === null) return;
		this.checkpoint();
		n.label = label;
		this.changed();
	}

	private async labelEdge(): Promise<void> {
		const id = [...this.selection].find((x) => this.edges.has(x));
		const edge = id ? this.edges.get(id) : undefined;
		if (!edge) return;
		const label = await promptText(this.app, 'Edge label', edge.label ?? '');
		if (label === null) return;
		this.checkpoint();
		edge.label = label || undefined;
		this.changed();
	}

	private addFile(file: TFile, at: { x: number; y: number }): void {
		const media = IMAGE.test(file.extension) || VIDEO.test(file.extension);
		this.addNode({ type: 'file', file: file.path, x: Math.round(at.x), y: Math.round(at.y), width: 400, height: media ? 300 : 400 });
	}

	private addFileAt(at: { x: number; y: number }): void {
		const files = this.app.vault.getFiles().filter((f) => f.path !== this.path);
		new VaultFilePicker(this.app, files, (f) => this.addFile(f, at)).open();
	}

	private async addLinkAt(at: { x: number; y: number }): Promise<void> {
		const url = await promptText(this.app, 'Web link', 'https://', 'Add');
		if (!url || !/^https?:\/\//.test(url)) return;
		this.addNode({ type: 'link', url, x: Math.round(at.x), y: Math.round(at.y), width: 400, height: 120 });
	}

	private buildControls(): void {
		const bar = this.wrapperEl.createDiv('canvas-controls');
		const btn = (icon: string, label: string, cb: () => void) => {
			const b = bar.createDiv({ cls: 'canvas-control-item clickable-icon', attr: { 'aria-label': label } });
			setIcon(b, icon);
			b.addEventListener('click', cb);
		};
		const center = () => {
			const r = this.wrapperEl.getBoundingClientRect();
			return this.toWorld({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
		};
		btn('sticky-note', 'Add card', () => {
			const p = center();
			const n = this.addNode({ type: 'text', text: '', x: Math.round(p.x - 125), y: Math.round(p.y - 30), width: 250, height: 60 });
			this.editText(this.nodes.get(n.id)!);
		});
		btn('file-text', 'Add note from vault', () => this.addFileAt(center()));
		btn('globe', 'Add web link', () => void this.addLinkAt(center()));
		btn('box-select', 'Create group', () => {
			const p = center();
			this.addNode({ type: 'group', label: 'Group', x: Math.round(p.x - 200), y: Math.round(p.y - 150), width: 400, height: 300 });
		});
		btn('maximize', 'Zoom to fit', () => this.zoomToFit());
		btn('undo-2', 'Undo', () => this.undo());
		btn('redo-2', 'Redo', () => this.redo());
	}
}

class VaultFilePicker extends FuzzySuggestModal<TFile> {
	constructor(app: App, private files: TFile[], private onPick: (f: TFile) => void) {
		super(app);
		this.setPlaceholder('Choose a file to add…');
	}
	getItems(): TFile[] { return this.files; }
	getItemText(f: TFile): string { return f.path; }
	onChooseItem(f: TFile): void { this.onPick(f); }
}

// ---------------- Plugin ----------------

export class CanvasPlugin extends CorePlugin {
	id = 'canvas';
	name = 'Canvas';
	description = 'Arrange notes, media and links on an infinite canvas (JSON Canvas).';

	onload(): void {
		this.registerView('canvas', (leaf) => new CanvasView(leaf));
		this.app.viewRegistry.registerExtensions(['canvas'], 'canvas');
		this.register(() => delete this.app.viewRegistry.typeByExtension.canvas);
		this.addRibbonIcon('layout-dashboard', 'Create new canvas', () => void this.createCanvas());
		this.addCommand({ id: 'canvas:new-file', name: 'Canvas: Create new canvas', icon: 'layout-dashboard', callback: () => void this.createCanvas() });
		this.registerEvent(this.app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => {
			if ('children' in file) menu.addItem((i) => i.setTitle('New canvas').setIcon('layout-dashboard').setSection('new').onClick(() => void this.createCanvas(file.path)));
		}));
		// ![[file.canvas]] embeds render a read-only, scaled-down canvas.
		const creator = (ctx: { app: App; containerEl: HTMLElement; sourcePath: string }, file: TFile) => {
			const child = new Component() as Component & { loadFile(): Promise<void> };
			child.loadFile = async () => {
				let data: CanvasData = { nodes: [], edges: [] };
				try { data = { nodes: [], edges: [], ...JSON.parse(await ctx.app.vault.cachedRead(file)) }; } catch { /* empty */ }
				renderCanvasStatic(ctx.app, data, ctx.containerEl, file.path, child);
			};
			return child;
		};
		this.app.embedRegistry.registerExtension('canvas', creator);
		this.register(() => this.app.embedRegistry.unregisterExtension('canvas'));
	}

	private async createCanvas(folder?: string): Promise<void> {
		const base = folder && folder !== '/' ? `${folder}/` : '';
		let path = `${base}Untitled.canvas`;
		for (let n = 1; this.app.vault.getAbstractFileByPath(path); n++) path = `${base}Untitled ${n}.canvas`;
		const file = await this.app.vault.create(path, JSON.stringify({ nodes: [], edges: [] }, null, '\t'));
		await this.app.workspace.getLeaf(false).openFile(file, { active: true });
	}
}
