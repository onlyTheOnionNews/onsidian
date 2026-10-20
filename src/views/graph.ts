// Graph view core plugin (PLAN §5.3): global graph + local graph, filters, color groups, display and force settings.
// Settings use Obsidian's .obsidian/graph.json keys; colors come from the documented --graph-* CSS variables.
// ponytail: Canvas 2D renderer + d3-force on the main thread — smooth to a few thousand nodes. For very large vaults,
// move the simulation into a worker and/or render with WebGL (PLAN §5.3 lists both).
import { forceCenter, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import type { App } from '../app';
import { CorePlugin } from '../coreplugins';
import { debounce } from '../events';
import { setIcon } from '../icons';
import { Keymap } from '../keymap';
import { getAllTags, parseLinktext } from '../parse';
import { searchVault } from '../search';
import { Setting } from '../ui';
import { TFile } from '../vault';
import { ItemView, type WorkspaceLeaf } from '../workspace';

interface GraphOptions {
	search: string;
	showTags: boolean;
	showAttachments: boolean;
	hideUnresolved: boolean;
	showOrphans: boolean;
	colorGroups: { query: string; color: { a: number; rgb: number } }[];
	showArrow: boolean;
	textFadeMultiplier: number;
	nodeSizeMultiplier: number;
	lineSizeMultiplier: number;
	centerStrength: number;
	repelStrength: number;
	linkStrength: number;
	linkDistance: number;
	localJumps: number;
}

const DEFAULTS: GraphOptions = {
	search: '', showTags: false, showAttachments: false, hideUnresolved: false, showOrphans: true, colorGroups: [],
	showArrow: false, textFadeMultiplier: 0, nodeSizeMultiplier: 1, lineSizeMultiplier: 1,
	centerStrength: 0.52, repelStrength: 10, linkStrength: 1, linkDistance: 250, localJumps: 1,
};

type Kind = 'file' | 'unresolved' | 'tag' | 'attachment';

interface Node extends SimulationNodeDatum {
	id: string;
	label: string;
	kind: Kind;
	degree: number;
	color?: string;
}

type Link = SimulationLinkDatum<Node> & { source: Node | string; target: Node | string };

export class GraphView extends ItemView {
	icon = 'git-fork';
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private sim: Simulation<Node, Link> | null = null;
	private nodes: Node[] = [];
	private links: Link[] = [];
	private neighbors = new Map<string, Set<string>>();
	private view = { x: 0, y: 0, k: 1 };
	private hover: Node | null = null;
	private drag: { node: Node | null; startX: number; startY: number; moved: boolean; vx: number; vy: number } | null = null;
	private frame = 0;
	private opts: GraphOptions = { ...DEFAULTS };
	private controlsEl: HTMLElement;
	private colors: Record<string, string> = {};
	private resizeObs: ResizeObserver;

	constructor(leaf: WorkspaceLeaf, public local = false) {
		super(leaf);
		this.contentEl.addClass('graph-view-container');
		this.canvas = this.contentEl.createEl('canvas', { cls: 'graph-canvas' });
		this.ctx = this.canvas.getContext('2d')!;
		this.controlsEl = this.contentEl.createDiv('graph-controls is-close');
		this.resizeObs = new ResizeObserver(() => this.resize());
		this.resizeObs.observe(this.contentEl);
		this.bindPointer();
	}

	getViewType(): string { return this.local ? 'localgraph' : 'graph'; }
	getDisplayText(): string {
		if (!this.local) return 'Graph view';
		return `Graph of ${this.app.workspace.getActiveFile()?.basename ?? 'note'}`;
	}

	async onOpen(): Promise<void> {
		this.opts = { ...DEFAULTS, ...((await this.app.vault.readConfigJson('graph')) ?? {}), ...(this.local ? { localJumps: 1 } : {}) };
		this.renderControls();
		this.readColors();
		await this.rebuild();
	}

	onload(): void {
		const r = debounce(() => void this.rebuild(), 500, true);
		this.registerEvent(this.app.metadataCache.on('resolved', r));
		this.registerEvent(this.app.vault.on('rename', r));
		this.registerEvent(this.app.vault.on('delete', r));
		this.registerEvent(this.app.workspace.on('css-change', () => { this.readColors(); this.draw(); }));
		if (this.local) this.registerEvent(this.app.workspace.on('file-open', () => { this.updateHeader(); void this.rebuild(); }));
		this.register(() => {
			this.sim?.stop();
			this.resizeObs.disconnect();
			cancelAnimationFrame(this.frame);
		});
	}

	private saveOpts = debounce(() => {
		if (this.local) return; // local graph settings are per view, as in Obsidian
		void this.app.vault.writeConfigJson('graph', this.opts);
	}, 500);

	/** Theme colors from CSS variables (themes restyle the graph through these). */
	private readColors(): void {
		const cs = getComputedStyle(this.contentEl);
		const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
		this.colors = {
			node: v('--graph-node', '#999'), unresolved: v('--graph-node-unresolved', '#666'), focused: v('--graph-node-focused', '#5b8def'),
			tag: v('--graph-node-tag', '#3c9'), attachment: v('--graph-node-attachment', '#ca3'), line: v('--graph-line', '#555'),
			text: v('--graph-text', '#ccc'), bg: v('--background-primary', '#111'),
		};
	}

	// ---------------- Data ----------------

	private async rebuild(): Promise<void> {
		const { vault, metadataCache, workspace } = this.app;
		const o = this.opts;
		const old = new Map(this.nodes.map((n) => [n.id, n]));
		const nodes = new Map<string, Node>();
		const links: Link[] = [];
		const add = (id: string, label: string, kind: Kind) => {
			if (!nodes.has(id)) {
				const prev = old.get(id);
				nodes.set(id, { id, label, kind, degree: 0, x: prev?.x, y: prev?.y, vx: prev?.vx, vy: prev?.vy });
			}
			return nodes.get(id)!;
		};

		// Search filter limits which files appear.
		let allowed: Set<string> | null = null;
		if (o.search.trim()) allowed = new Set((await searchVault(this.app, o.search)).map((r) => r.file.path));

		for (const f of vault.getFiles()) {
			if (allowed && !allowed.has(f.path)) continue;
			if (f.extension === 'md') add(f.path, f.basename, 'file');
			else if (o.showAttachments) add(f.path, f.name, 'attachment');
		}
		for (const [src, targets] of Object.entries(metadataCache.resolvedLinks)) {
			if (!nodes.has(src)) continue;
			for (const t of Object.keys(targets)) if (t !== src && nodes.has(t)) links.push({ source: src, target: t });
		}
		if (!o.hideUnresolved) {
			for (const [src, targets] of Object.entries(metadataCache.unresolvedLinks)) {
				if (!nodes.has(src)) continue;
				for (const t of Object.keys(targets)) {
					add(`unresolved:${t}`, t, 'unresolved');
					links.push({ source: src, target: `unresolved:${t}` });
				}
			}
		}
		if (o.showTags) {
			for (const f of vault.getMarkdownFiles()) {
				if (!nodes.has(f.path)) continue;
				const cache = metadataCache.getFileCache(f);
				for (const t of new Set(cache ? getAllTags(cache) ?? [] : [])) {
					add(`tag:${t}`, t, 'tag');
					links.push({ source: f.path, target: `tag:${t}` });
				}
			}
		}

		// Local graph: BFS from the active note, both directions, up to N jumps.
		if (this.local) {
			const center = workspace.getActiveFile()?.path;
			const keep = new Set<string>();
			if (center && nodes.has(center)) {
				const adj = new Map<string, Set<string>>();
				for (const l of links) {
					const a = l.source as string;
					const b = l.target as string;
					addTo(adj, a, b);
					addTo(adj, b, a);
				}
				let frontier = [center];
				keep.add(center);
				for (let d = 0; d < o.localJumps; d++) {
					const next: string[] = [];
					for (const id of frontier) for (const n of adj.get(id) ?? []) if (!keep.has(n)) { keep.add(n); next.push(n); }
					frontier = next;
				}
			}
			for (const id of [...nodes.keys()]) if (!keep.has(id)) nodes.delete(id);
		}

		const finalLinks = links.filter((l) => nodes.has(l.source as string) && nodes.has(l.target as string));
		this.neighbors = new Map();
		for (const l of finalLinks) {
			const a = l.source as string;
			const b = l.target as string;
			nodes.get(a)!.degree++;
			nodes.get(b)!.degree++;
			addTo(this.neighbors, a, b);
			addTo(this.neighbors, b, a);
		}
		if (!o.showOrphans) for (const [id, n] of nodes) if (!n.degree && !(this.local && id === workspace.getActiveFile()?.path)) nodes.delete(id);

		// Color groups: first matching group wins.
		for (const g of o.colorGroups) {
			if (!g.query.trim()) continue;
			const hits = new Set((await searchVault(this.app, g.query)).map((r) => r.file.path));
			const color = `#${g.color.rgb.toString(16).padStart(6, '0')}`;
			for (const n of nodes.values()) if (!n.color && hits.has(n.id)) n.color = color;
		}

		this.nodes = [...nodes.values()];
		this.links = finalLinks.filter((l) => nodes.has(l.source as string) && nodes.has(l.target as string));
		this.restartSimulation();
	}

	private restartSimulation(): void {
		const o = this.opts;
		this.sim?.stop();
		this.sim = forceSimulation<Node, Link>(this.nodes)
			.force('link', forceLink<Node, Link>(this.links).id((n) => n.id).distance(o.linkDistance * 0.4).strength(o.linkStrength * 0.5))
			.force('charge', forceManyBody<Node>().strength(-o.repelStrength * 12).distanceMax(600))
			.force('center', forceCenter(0, 0))
			.force('x', forceX<Node>(0).strength(o.centerStrength * 0.05))
			.force('y', forceY<Node>(0).strength(o.centerStrength * 0.05))
			.alphaDecay(0.03)
			.on('tick', () => this.requestDraw());
	}

	// ---------------- Rendering ----------------

	private fitted = false;

	private resize(): void {
		const r = this.contentEl.getBoundingClientRect();
		// Center once the view actually has a size (a new tab is 0×0 when the graph is built).
		if (!this.fitted && r.width > 0 && r.height > 0) {
			this.fitted = true;
			this.fit();
		}
		const dpr = window.devicePixelRatio || 1;
		this.canvas.width = Math.max(1, Math.round(r.width * dpr));
		this.canvas.height = Math.max(1, Math.round(r.height * dpr));
		this.canvas.style.width = `${r.width}px`;
		this.canvas.style.height = `${r.height}px`;
		this.draw();
	}

	private fit(): void {
		const r = this.contentEl.getBoundingClientRect();
		this.view = { x: r.width / 2, y: r.height / 2, k: this.local ? 1.2 : Math.max(0.2, Math.min(1, 600 / Math.max(300, Math.sqrt(this.nodes.length) * 120))) };
	}

	private radius(n: Node): number {
		return (3 + Math.sqrt(n.degree) * 1.6) * this.opts.nodeSizeMultiplier;
	}

	private requestDraw(): void {
		cancelAnimationFrame(this.frame);
		this.frame = requestAnimationFrame(() => this.draw());
	}

	private draw(): void {
		const { ctx, canvas, view, colors, opts } = this;
		const dpr = window.devicePixelRatio || 1;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.x, dpr * view.y);
		const focus = this.hover;
		const near = focus ? this.neighbors.get(focus.id) ?? new Set<string>() : null;
		const active = this.app.workspace.getActiveFile()?.path;

		ctx.lineWidth = (1 / view.k) * opts.lineSizeMultiplier;
		for (const l of this.links) {
			const s = l.source as Node;
			const t = l.target as Node;
			if (s.x === undefined || t.x === undefined) continue;
			const lit = focus && (s === focus || t === focus);
			ctx.globalAlpha = focus ? (lit ? 0.9 : 0.12) : 0.5;
			ctx.strokeStyle = lit ? colors.focused : colors.line;
			ctx.beginPath();
			ctx.moveTo(s.x, s.y!);
			ctx.lineTo(t.x, t.y!);
			ctx.stroke();
			if (opts.showArrow) this.arrow(s, t);
		}

		for (const n of this.nodes) {
			if (n.x === undefined) continue;
			const dim = focus && n !== focus && !near!.has(n.id);
			ctx.globalAlpha = dim ? 0.2 : 1;
			ctx.fillStyle = n === focus || n.id === active ? colors.focused : n.color ?? (n.kind === 'file' ? colors.node : colors[n.kind]);
			ctx.beginPath();
			ctx.arc(n.x, n.y!, this.radius(n), 0, Math.PI * 2);
			ctx.fill();
		}

		// Labels fade in with zoom (textFadeMultiplier shifts the threshold); hovered node + neighbors always show.
		const threshold = 0.7 - opts.textFadeMultiplier * 0.15;
		const zoomAlpha = Math.max(0, Math.min(1, (view.k - threshold) * 3));
		ctx.font = `${12 / view.k}px ${getComputedStyle(document.body).getPropertyValue('--font-interface') || 'sans-serif'}`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'top';
		for (const n of this.nodes) {
			if (n.x === undefined) continue;
			const isFocus = n === focus || !!near?.has(n.id);
			const alpha = isFocus ? 1 : focus ? 0.2 * zoomAlpha : zoomAlpha;
			if (alpha <= 0) continue;
			ctx.globalAlpha = alpha;
			ctx.fillStyle = colors.text;
			ctx.fillText(n.label, n.x, n.y! + this.radius(n) + 3 / view.k);
		}
		ctx.globalAlpha = 1;
	}

	private arrow(s: Node, t: Node): void {
		const { ctx } = this;
		const ang = Math.atan2(t.y! - s.y!, t.x! - s.x!);
		const r = this.radius(t);
		const tipX = t.x! - Math.cos(ang) * r;
		const tipY = t.y! - Math.sin(ang) * r;
		const size = 6 / this.view.k;
		ctx.beginPath();
		ctx.moveTo(tipX, tipY);
		ctx.lineTo(tipX - size * Math.cos(ang - 0.4), tipY - size * Math.sin(ang - 0.4));
		ctx.lineTo(tipX - size * Math.cos(ang + 0.4), tipY - size * Math.sin(ang + 0.4));
		ctx.closePath();
		ctx.fillStyle = ctx.strokeStyle;
		ctx.fill();
	}

	// ---------------- Interaction ----------------

	private toGraph(e: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } {
		const r = this.canvas.getBoundingClientRect();
		return { x: (e.clientX - r.left - this.view.x) / this.view.k, y: (e.clientY - r.top - this.view.y) / this.view.k };
	}

	private nodeAt(p: { x: number; y: number }): Node | null {
		let best: Node | null = null;
		let bestD = Infinity;
		for (const n of this.nodes) {
			if (n.x === undefined) continue;
			const d = Math.hypot(n.x - p.x, n.y! - p.y);
			if (d < Math.max(this.radius(n), 6 / this.view.k) && d < bestD) { best = n; bestD = d; }
		}
		return best;
	}

	private bindPointer(): void {
		const c = this.canvas;
		c.addEventListener('pointerdown', (e) => {
			c.setPointerCapture(e.pointerId);
			const node = this.nodeAt(this.toGraph(e));
			this.drag = { node, startX: e.clientX, startY: e.clientY, moved: false, vx: this.view.x, vy: this.view.y };
			if (node) {
				node.fx = node.x;
				node.fy = node.y;
				this.sim?.alphaTarget(0.3).restart();
			}
		});
		c.addEventListener('pointermove', (e) => {
			const p = this.toGraph(e);
			if (!this.drag) {
				const h = this.nodeAt(p);
				if (h !== this.hover) {
					this.hover = h;
					c.style.cursor = h ? 'pointer' : 'default';
					this.draw();
				}
				return;
			}
			if (Math.hypot(e.clientX - this.drag.startX, e.clientY - this.drag.startY) > 3) this.drag.moved = true;
			if (this.drag.node) {
				this.drag.node.fx = p.x;
				this.drag.node.fy = p.y;
			} else {
				this.view.x = this.drag.vx + e.clientX - this.drag.startX;
				this.view.y = this.drag.vy + e.clientY - this.drag.startY;
				this.draw();
			}
		});
		c.addEventListener('pointerup', (e) => {
			const d = this.drag;
			this.drag = null;
			if (d?.node) {
				d.node.fx = null;
				d.node.fy = null;
				this.sim?.alphaTarget(0);
				if (!d.moved) this.open(d.node, e);
			}
		});
		c.addEventListener('wheel', (e) => {
			e.preventDefault();
			const p = this.toGraph(e);
			const k = Math.max(0.05, Math.min(8, this.view.k * Math.exp(-e.deltaY * 0.0015)));
			const r = c.getBoundingClientRect();
			this.view = { k, x: e.clientX - r.left - p.x * k, y: e.clientY - r.top - p.y * k };
			this.draw();
		}, { passive: false });
	}

	private open(n: Node, e: MouseEvent): void {
		const { workspace, vault } = this.app;
		if (n.kind === 'tag') {
			void (this.app.internalPlugins.getEnabledPluginById('global-search') as any)?.openGlobalSearch(`tag:${n.label}`);
			return;
		}
		const file = vault.getFileByPath(n.id);
		const mod = Keymap.isModEvent(e);
		if (file instanceof TFile) void workspace.getLeaf(mod).openFile(file);
		else if (n.kind === 'unresolved') void workspace.openLinkText(parseLinktext(n.label).path, '', mod);
	}

	// ---------------- Controls ----------------

	private renderControls(): void {
		const el = this.controlsEl;
		el.empty();
		const toggle = el.createDiv({ cls: 'clickable-icon graph-controls-button', attr: { 'aria-label': 'Open graph settings' } });
		setIcon(toggle, 'settings');
		toggle.addEventListener('click', () => el.toggleClass('is-close', !el.hasClass('is-close')));
		const body = el.createDiv('graph-controls-body');
		const o = this.opts;
		const changed = (rebuild: boolean) => {
			this.saveOpts();
			if (rebuild) void this.rebuild();
			else this.restartSimulation();
		};
		const section = (title: string) => body.createDiv({ cls: 'graph-control-section-header', text: title });

		section('Filters');
		new Setting(body).setName('Search').addText((t) => t.setPlaceholder('Search files…').setValue(o.search).onChange(debounce((v: string) => { o.search = v; changed(true); }, 400, true)));
		if (this.local) {
			new Setting(body).setName('Depth').addSlider((s) => s.setLimits(1, 5, 1).setValue(o.localJumps).setDynamicTooltip().onChange((v) => { o.localJumps = v; changed(true); }));
		}
		const tog = (name: string, key: 'showTags' | 'showAttachments' | 'hideUnresolved' | 'showOrphans' | 'showArrow', rebuild = true) =>
			new Setting(body).setName(name).addToggle((t) => t.setValue(o[key]).onChange((v) => { o[key] = v; rebuild ? changed(true) : this.draw(); this.saveOpts(); }));
		tog('Tags', 'showTags');
		tog('Attachments', 'showAttachments');
		tog('Existing files only', 'hideUnresolved');
		tog('Orphans', 'showOrphans');

		section('Groups');
		const groupsEl = body.createDiv();
		const renderGroups = () => {
			groupsEl.empty();
			o.colorGroups.forEach((g, i) => {
				new Setting(groupsEl)
					.addText((t) => t.setPlaceholder('Search query, e.g. tag:#idea').setValue(g.query).onChange(debounce((v: string) => { g.query = v; changed(true); }, 400, true)))
					.addColorPicker((c) => c.setValue(`#${g.color.rgb.toString(16).padStart(6, '0')}`).onChange((v) => { g.color.rgb = parseInt(v.slice(1), 16); changed(true); }))
					.addExtraButton((b) => b.setIcon('x').setTooltip('Remove group').onClick(() => { o.colorGroups.splice(i, 1); renderGroups(); changed(true); }));
			});
			new Setting(groupsEl).addButton((b) => b.setButtonText('New group').onClick(() => {
				o.colorGroups.push({ query: '', color: { a: 1, rgb: Math.floor(Math.random() * 0xffffff) } });
				renderGroups();
			}));
		};
		renderGroups();

		section('Display');
		tog('Arrows', 'showArrow', false);
		const slider = (name: string, key: keyof GraphOptions, min: number, max: number, step: number, rebuild = false) =>
			new Setting(body).setName(name).addSlider((s) => s.setLimits(min, max, step).setValue(o[key] as number).setDynamicTooltip().onChange((v) => {
				(o as any)[key] = v;
				if (rebuild) changed(false);
				else { this.saveOpts(); this.draw(); }
			}));
		slider('Text fade threshold', 'textFadeMultiplier', -3, 3, 0.1);
		slider('Node size', 'nodeSizeMultiplier', 0.1, 5, 0.1);
		slider('Link thickness', 'lineSizeMultiplier', 0.1, 5, 0.1);

		section('Forces');
		slider('Center force', 'centerStrength', 0, 1, 0.01, true);
		slider('Repel force', 'repelStrength', 0, 20, 0.5, true);
		slider('Link force', 'linkStrength', 0, 1, 0.01, true);
		slider('Link distance', 'linkDistance', 30, 500, 10, true);
	}
}

export class GraphPlugin extends CorePlugin {
	id = 'graph';
	name = 'Graph view';
	description = 'Show notes and links as an interactive graph.';
	onload(): void {
		this.registerView('graph', (leaf) => new GraphView(leaf, false));
		this.registerView('localgraph', (leaf) => new GraphView(leaf, true));
		this.addRibbonIcon('git-fork', 'Open graph view', () => void openGraph(this.app));
		this.addCommand({ id: 'graph:open', name: 'Graph view: Open graph view', icon: 'git-fork', hotkeys: [{ modifiers: ['Mod'], key: 'G' }], callback: () => void openGraph(this.app) });
		this.addCommand({ id: 'graph:open-local', name: 'Graph view: Open local graph', icon: 'git-fork', callback: () => void this.app.workspace.ensureSideLeaf('localgraph', 'right', { reveal: true }) });
	}
}

async function openGraph(app: App): Promise<void> {
	const existing = app.workspace.getLeavesOfType('graph')[0];
	if (existing) return app.workspace.setActiveLeaf(existing, { focus: true });
	await app.workspace.getLeaf('tab').setViewState({ type: 'graph', active: true });
}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
	const set = map.get(key) ?? new Set<string>();
	set.add(value);
	map.set(key, set);
}
