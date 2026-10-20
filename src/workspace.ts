// Workspace layout tree (obsidian.d.ts): splits → tabs → leaves → views, plus left/right sidedocks and ribbon.
// DOM structure and class names mirror Obsidian so community themes and plugins find what they expect.
// ponytail: phase-1 scope — no root-split resizing, no stacked tabs, no pop-outs, no layout persistence,
// no back/forward history. Each is listed in PLAN §5.4 / §10 phase 2.
import type { App } from './app';
import { Component, Events, debounce } from './events';
import { setIcon } from './icons';
import type { TFile } from './vault';

export type ViewCreator = (leaf: WorkspaceLeaf) => View;
export type SplitDirection = 'vertical' | 'horizontal';
export type PaneType = 'tab' | 'split' | 'window';

export interface ViewState {
	type: string;
	state?: Record<string, unknown>;
	active?: boolean;
	pinned?: boolean;
}

/** View types and file-extension → view-type mapping (`app.viewRegistry`, used by Plugin.registerView/registerExtensions). */
export class ViewRegistry extends Events {
	viewByType: Record<string, ViewCreator> = {};
	typeByExtension: Record<string, string> = {};

	registerView(type: string, creator: ViewCreator): void {
		if (this.viewByType[type]) throw new Error(`View type "${type}" is already registered`);
		this.viewByType[type] = creator;
		this.trigger('view-registered', type);
	}

	unregisterView(type: string): void {
		delete this.viewByType[type];
		this.trigger('view-unregistered', type);
	}

	registerExtensions(exts: string[], type: string): void {
		for (const e of exts) this.typeByExtension[e] = type;
		this.trigger('extensions-updated');
	}

	getTypeByExtension(ext: string): string | undefined {
		return this.typeByExtension[ext];
	}
}

// ---------------- Views ----------------

export abstract class View extends Component {
	app: App;
	icon = 'file';
	navigation = false;
	containerEl: HTMLElement;

	constructor(public leaf: WorkspaceLeaf) {
		super();
		this.app = leaf.app;
		this.containerEl = createDiv('workspace-leaf-content');
	}

	protected async onOpen(): Promise<void> {}
	protected async onClose(): Promise<void> {}
	/** @internal open/close are protected in the API but the leaf drives them. */
	async _open(): Promise<void> { await this.onOpen(); }
	async _close(): Promise<void> { await this.onClose(); }

	abstract getViewType(): string;
	abstract getDisplayText(): string;

	getState(): Record<string, unknown> { return {}; }
	async setState(_state: unknown, _result: { history: boolean }): Promise<void> {}
	getEphemeralState(): Record<string, unknown> { return {}; }
	setEphemeralState(_state: unknown): void {}
	getIcon(): string { return this.icon; }
	onResize(): void {}
}

export abstract class ItemView extends View {
	headerEl: HTMLElement;
	titleEl: HTMLElement;
	actionsEl: HTMLElement;
	contentEl: HTMLElement;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.headerEl = this.containerEl.createDiv('view-header');
		const nav = this.headerEl.createDiv('view-header-left').createDiv('view-header-nav-buttons');
		for (const [icon, label, dir] of [['arrow-left', 'Navigate back', 'back'], ['arrow-right', 'Navigate forward', 'forward']] as const) {
			const b = nav.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': label, 'data-dir': dir } });
			setIcon(b, icon);
			b.addEventListener('click', () => void (dir === 'back' ? this.leaf.history.back() : this.leaf.history.forward()));
		}
		this.titleEl = this.headerEl.createDiv('view-header-title-container').createDiv('view-header-title');
		this.actionsEl = this.headerEl.createDiv('view-actions');
		this.contentEl = this.containerEl.createDiv('view-content');
	}

	addAction(icon: string, title: string, callback: (evt: MouseEvent) => any): HTMLElement {
		const el = this.actionsEl.createEl('a', { cls: 'clickable-icon view-action', attr: { 'aria-label': title } });
		setIcon(el, icon);
		el.addEventListener('click', callback);
		return el;
	}

	/** @internal refresh header title after state changes. */
	updateHeader(): void {
		this.titleEl.setText(this.getDisplayText());
		this.leaf.updateHeader();
	}
}

export abstract class FileView extends ItemView {
	allowNoFile = false;
	file: TFile | null = null;
	navigation = true;

	getDisplayText(): string {
		return this.file?.basename ?? 'No file';
	}

	getState(): Record<string, unknown> {
		return { file: this.file?.path ?? null };
	}

	async setState(state: any, result: { history: boolean }): Promise<void> {
		const file = state?.file ? this.app.vault.getFileByPath(state.file) : null;
		if (file && file !== this.file) {
			if (this.file) await this.onUnloadFile(this.file);
			this.file = file;
			await this.onLoadFile(file);
			this.updateHeader();
		}
		await super.setState(state, result);
	}

	async onLoadFile(_file: TFile): Promise<void> {}
	async onUnloadFile(_file: TFile): Promise<void> {}
	canAcceptExtension(_ext: string): boolean { return false; }

	async _close(): Promise<void> {
		if (this.file) await this.onUnloadFile(this.file);
		this.file = null;
		await super._close();
	}
}

/** File view over text data with autosave (obsidian.d.ts TextFileView). Relay patches requestSave/save/setViewData here. */
export abstract class TextFileView extends FileView {
	data = '';
	// Returns the save promise, so requestSave.run() tells callers a save was pending (unsaved-changes guard).
	requestSave = debounce(() => this.save(), 2000, true);

	abstract getViewData(): string;
	abstract setViewData(data: string, clear: boolean): void;
	abstract clear(): void;

	async onLoadFile(file: TFile): Promise<void> {
		this.data = await this.app.vault.read(file);
		this.setViewData(this.data, true);
	}

	async onUnloadFile(_file: TFile): Promise<void> {
		await this.save();
	}

	async save(clear?: boolean): Promise<void> {
		this.requestSave.cancel();
		const file = this.file;
		if (!file) return;
		const data = this.getViewData();
		if (data !== (await this.app.vault.cachedRead(file))) await this.app.vault.modify(file, data);
		this.data = data;
		if (clear) this.clear();
	}
}

class EmptyView extends ItemView {
	getViewType() { return 'empty'; }
	getDisplayText() { return 'New tab'; }
	async onOpen() {
		const el = this.contentEl.createDiv('empty-state');
		el.createDiv({ cls: 'empty-state-title', text: 'No file is open' });
		const actions = el.createDiv('empty-state-container');
		const btn = actions.createEl('button', { cls: 'empty-state-action', text: 'Create new note' });
		btn.addEventListener('click', () => void this.app.newNote(this.leaf));
	}
}

// ---------------- Layout tree ----------------

/** 16 hex chars, like Obsidian's layout ids. */
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

export abstract class WorkspaceItem extends Events {
	id = newId();
	parent: WorkspaceParent | null = null;
	containerEl!: HTMLElement;
	constructor(public workspace: Workspace) { super(); }
	getRoot(): WorkspaceItem {
		return this.parent ? this.parent.getRoot() : this;
	}
}

export abstract class WorkspaceParent extends WorkspaceItem {
	children: WorkspaceItem[] = [];

	insertChild(index: number, child: WorkspaceItem): void {
		child.parent = this;
		this.children.splice(index, 0, child);
		this.renderChildren();
	}

	removeChild(child: WorkspaceItem): void {
		const i = this.children.indexOf(child);
		if (i < 0) return;
		this.children.splice(i, 1);
		child.containerEl.detach();
		child.parent = null;
		this.renderChildren();
		if (!this.children.length) this.onEmpty();
	}

	replaceChild(old: WorkspaceItem, child: WorkspaceItem): void {
		const i = this.children.indexOf(old);
		old.containerEl.detach();
		old.parent = null;
		child.parent = this;
		this.children[i] = child;
		this.renderChildren();
	}

	protected abstract renderChildren(): void;
	protected onEmpty(): void {
		this.parent?.removeChild(this);
	}
}

export class WorkspaceSplit extends WorkspaceParent {
	constructor(workspace: Workspace, public direction: SplitDirection) {
		super(workspace);
		this.containerEl = createDiv(`workspace-split mod-${direction}`);
	}

	protected renderChildren(): void {
		this.containerEl.replaceChildren(...this.children.map((c) => c.containerEl));
	}
}

export class WorkspaceRoot extends WorkspaceSplit {
	constructor(workspace: Workspace) {
		super(workspace, 'vertical');
		this.containerEl.addClass('mod-root');
	}

	// The root always keeps one tab group with one leaf, as in Obsidian.
	protected onEmpty(): void {
		this.ensureLeaf();
	}

	ensureLeaf(): void {
		if (this.children.length) return;
		const tabs = new WorkspaceTabs(this.workspace);
		this.insertChild(0, tabs);
		const leaf = new WorkspaceLeaf(this.workspace);
		tabs.insertChild(0, leaf);
		void leaf.setViewState({ type: 'empty' });
		this.workspace.setActiveLeaf(leaf);
	}
}

export class WorkspaceSidedock extends WorkspaceSplit {
	collapsed = false;
	width: number;

	constructor(workspace: Workspace, public side: 'left' | 'right') {
		super(workspace, 'horizontal');
		this.width = side === 'left' ? 280 : 300;
		this.containerEl.addClasses(['mod-sidedock', `mod-${side}-split`]);
		this.containerEl.style.width = `${this.width}px`;
		this.addResizeHandle();
	}

	protected renderChildren(): void {
		super.renderChildren();
		this.addResizeHandle();
	}

	private addResizeHandle(): void {
		const handle = this.containerEl.createDiv('workspace-leaf-resize-handle');
		handle.addEventListener('pointerdown', (e) => {
			handle.setPointerCapture(e.pointerId);
			const startX = e.clientX;
			const startW = this.width;
			const move = (ev: PointerEvent) => {
				const dx = ev.clientX - startX;
				this.width = Math.max(160, Math.min(800, startW + (this.side === 'left' ? dx : -dx)));
				this.containerEl.style.width = `${this.width}px`;
			};
			handle.addEventListener('pointermove', move);
			handle.addEventListener('pointerup', () => {
				handle.removeEventListener('pointermove', move);
				this.workspace.requestSaveLayout();
			}, { once: true });
		});
	}

	setWidth(px: number): void {
		this.width = px;
		this.containerEl.style.width = `${px}px`;
	}

	toggle(): void { this.collapsed ? this.expand() : this.collapse(); }
	collapse(): void { this.setCollapsed(true); }
	expand(): void { this.setCollapsed(false); }

	private setCollapsed(c: boolean): void {
		this.collapsed = c;
		this.containerEl.toggleClass('is-sidedock-collapsed', c);
		this.workspace.trigger('resize');
		this.workspace.requestSaveLayout();
	}

	// Sidedocks stay even when empty.
	protected onEmpty(): void {}
}

export class WorkspaceTabs extends WorkspaceParent {
	currentTab = 0;
	tabHeaderContainerEl: HTMLElement;
	tabsInnerEl: HTMLElement;
	tabsContainerEl: HTMLElement;

	constructor(workspace: Workspace, private iconOnly = false) {
		super(workspace);
		this.containerEl = createDiv('workspace-tabs mod-top');
		this.tabHeaderContainerEl = this.containerEl.createDiv('workspace-tab-header-container');
		this.tabsInnerEl = this.tabHeaderContainerEl.createDiv('workspace-tab-header-container-inner');
		if (!iconOnly) {
			const newTab = this.tabHeaderContainerEl.createDiv({ cls: 'workspace-tab-header-new-tab' }).createEl('span', { cls: 'clickable-icon', attr: { 'aria-label': 'New tab' } });
			setIcon(newTab, 'plus');
			newTab.addEventListener('click', () => {
				const leaf = this.workspace.createLeafInTabs(this);
				void leaf.setViewState({ type: 'empty', active: true });
			});
		}
		this.tabsContainerEl = this.containerEl.createDiv('workspace-tab-container');
	}

	protected renderChildren(): void {
		this.tabsInnerEl.replaceChildren(...this.children.map((c) => (c as WorkspaceLeaf).tabHeaderEl));
		this.tabsContainerEl.replaceChildren(...this.children.map((c) => c.containerEl));
		this.selectTabIndex(Math.min(this.currentTab, this.children.length - 1));
		this.tabsInnerEl.toggleClass('mod-icon-only', this.iconOnly);
	}

	selectTab(leaf: WorkspaceLeaf): void {
		this.selectTabIndex(this.children.indexOf(leaf));
	}

	selectTabIndex(i: number): void {
		if (i < 0) return;
		this.currentTab = i;
		this.children.forEach((c, n) => {
			const leaf = c as WorkspaceLeaf;
			leaf.tabHeaderEl.toggleClass('is-active', n === i);
			leaf.containerEl.toggle(n === i);
		});
	}
}

interface HistoryEntry {
	state: ViewState;
	eState: unknown;
}

/** Per-leaf back/forward navigation (leaf.history in Obsidian). */
export class LeafHistory {
	backHistory: HistoryEntry[] = [];
	forwardHistory: HistoryEntry[] = [];
	constructor(private leaf: WorkspaceLeaf) {}

	/** @internal record the current state before navigating away. */
	push(): void {
		const v = this.leaf.view as FileView;
		if (!v?.navigation || !v.file) return;
		this.backHistory.push({ state: this.leaf.getViewState(), eState: v.getEphemeralState() });
		if (this.backHistory.length > 50) this.backHistory.shift();
		this.forwardHistory = [];
	}

	async back(): Promise<void> {
		await this.go(this.backHistory, this.forwardHistory);
	}

	async forward(): Promise<void> {
		await this.go(this.forwardHistory, this.backHistory);
	}

	private async go(from: HistoryEntry[], to: HistoryEntry[]): Promise<void> {
		const entry = from.pop();
		if (!entry) return;
		to.push({ state: this.leaf.getViewState(), eState: this.leaf.view.getEphemeralState() });
		await this.leaf.setViewState(entry.state, entry.eState, { history: true });
	}
}

export class WorkspaceLeaf extends WorkspaceItem {
	app: App;
	history = new LeafHistory(this);
	/** State for a view type that isn't registered yet (e.g. a plugin still loading); applied when it registers. */
	pendingState: ViewState | null = null;
	view!: View;
	pinned = false;
	tabHeaderEl: HTMLElement;
	private tabIconEl: HTMLElement;
	private tabTitleEl: HTMLElement;

	constructor(workspace: Workspace) {
		super(workspace);
		this.app = workspace.app;
		this.containerEl = createDiv('workspace-leaf');
		this.tabHeaderEl = createDiv({ cls: 'workspace-tab-header tappable', attr: { draggable: 'true' } });
		const inner = this.tabHeaderEl.createDiv('workspace-tab-header-inner');
		this.tabIconEl = inner.createDiv('workspace-tab-header-inner-icon');
		this.tabTitleEl = inner.createDiv('workspace-tab-header-inner-title');
		const close = inner.createDiv({ cls: 'workspace-tab-header-inner-close-button', attr: { 'aria-label': 'Close' } });
		setIcon(close, 'x');
		close.addEventListener('click', (e) => {
			e.stopPropagation();
			this.detach();
		});
		this.tabHeaderEl.addEventListener('click', () => this.workspace.setActiveLeaf(this, { focus: true }));
		this.tabHeaderEl.addEventListener('auxclick', (e) => e.button === 1 && this.detach());
		this.containerEl.addEventListener('focusin', () => this.workspace.setActiveLeaf(this));
		this.containerEl.addEventListener('mousedown', () => this.workspace.setActiveLeaf(this));

		// Every leaf starts with the empty view (synchronously), so callers can rely on `leaf.view`.
		const empty = new EmptyView(this);
		this.view = empty;
		empty.containerEl.dataset.type = 'empty';
		this.containerEl.appendChild(empty.containerEl);
		empty.load();
		void empty._open();
		this.updateHeader();
	}

	async open(view: View): Promise<View> {
		if (this.view) {
			await this.view._close();
			this.view.unload();
			this.view.containerEl.detach();
		}
		this.view = view;
		view.containerEl.dataset.type = view.getViewType();
		this.containerEl.appendChild(view.containerEl);
		view.load();
		await view._open();
		this.updateHeader();
		return view;
	}

	async setViewState(vs: ViewState, eState?: any, opts: { history?: boolean } = {}): Promise<void> {
		const registered = !!this.app.viewRegistry.viewByType[vs.type];
		this.pendingState = registered ? null : vs;
		// Navigating to another file/view records history (unless we're replaying history).
		const cur = this.getViewState();
		if (!opts.history && (cur.type !== vs.type || (vs.state as any)?.file !== (cur.state as any)?.file)) this.history.push();
		if (!this.view || this.view.getViewType() !== (registered ? vs.type : 'empty')) {
			const create = this.app.viewRegistry.viewByType[registered ? vs.type : 'empty'];
			await this.open(create(this));
		}
		if (!registered) {
			this.updateHeader();
			return;
		}
		await this.view.setState(vs.state ?? {}, { history: false });
		if (eState) this.view.setEphemeralState(eState);
		if (vs.pinned !== undefined) this.setPinned(vs.pinned);
		this.updateHeader();
		if (vs.active) this.workspace.setActiveLeaf(this, { focus: true });
		this.workspace.onLeafStateChanged(this);
	}

	getViewState(): ViewState {
		if (this.pendingState) return this.pendingState;
		return { type: this.view?.getViewType() ?? 'empty', state: this.view?.getState() ?? {}, pinned: this.pinned };
	}

	async openFile(file: TFile, openState?: { active?: boolean; state?: any; eState?: any }): Promise<void> {
		const type = this.app.viewRegistry.getTypeByExtension(file.extension);
		if (!type) {
			new Notice(`No view can open ".${file.extension}" files yet.`);
			return;
		}
		await this.setViewState({ type, state: { ...openState?.state, file: file.path }, active: openState?.active ?? true }, openState?.eState);
	}

	togglePinned(): void { this.setPinned(!this.pinned); }

	setPinned(pinned: boolean): void {
		this.pinned = pinned;
		this.tabHeaderEl.toggleClass('is-pinned', pinned);
		this.trigger('pinned-change', pinned);
	}

	getIcon(): string { return this.view?.getIcon() ?? 'file'; }
	getDisplayText(): string { return this.view?.getDisplayText() ?? ''; }
	onResize(): void { this.view?.onResize(); }

	/** @internal */
	updateHeader(): void {
		for (const b of this.view?.containerEl.querySelectorAll<HTMLButtonElement>('.view-header-nav-buttons button') ?? []) {
			b.disabled = !(b.dataset.dir === 'back' ? this.history.backHistory : this.history.forwardHistory).length;
		}
		setIcon(this.tabIconEl, this.getIcon());
		this.tabTitleEl.setText(this.getDisplayText());
		this.tabHeaderEl.setAttr('aria-label', this.getDisplayText());
	}

	detach(): void {
		void (async () => {
			if (this.view) {
				await this.view._close();
				this.view.unload();
			}
			const parent = this.parent;
			parent?.removeChild(this);
			this.workspace.onLeafDetached(this);
		})();
	}
}

// ---------------- Ribbon ----------------

export class WorkspaceRibbon {
	containerEl = createDiv('workspace-ribbon side-dock-ribbon mod-left');
	private actionsEl = this.containerEl.createDiv('side-dock-actions');

	addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => any): HTMLElement {
		const el = this.actionsEl.createDiv({ cls: 'clickable-icon side-dock-ribbon-action', attr: { 'aria-label': title } });
		setIcon(el, icon);
		el.addEventListener('click', callback);
		return el;
	}
}

// ---------------- Workspace ----------------

export class Workspace extends Events {
	containerEl = createDiv('workspace');
	leftRibbon = new WorkspaceRibbon();
	leftSplit: WorkspaceSidedock;
	rightSplit: WorkspaceSidedock;
	rootSplit: WorkspaceRoot;
	activeLeaf: WorkspaceLeaf | null = null;
	layoutReady = false;
	private lastActiveFile: TFile | null = null;
	private layoutReadyCbs: (() => any)[] = [];
	/** Root leaves in most-recently-active order. */
	private recentRootLeaves: WorkspaceLeaf[] = [];
	/** Recently opened file paths, newest first (persisted in workspace.json as "lastOpenFiles"). */
	lastOpenFiles: string[] = [];

	constructor(public app: App) {
		super();
		this.leftSplit = new WorkspaceSidedock(this, 'left');
		this.rightSplit = new WorkspaceSidedock(this, 'right');
		this.rootSplit = new WorkspaceRoot(this);
		this.containerEl.append(this.leftRibbon.containerEl, this.leftSplit.containerEl, this.rootSplit.containerEl, this.rightSplit.containerEl);
		app.viewRegistry.registerView('empty', (leaf) => new EmptyView(leaf));
		app.viewRegistry.on('view-registered', (type: string) => {
			this.iterateAllLeaves((leaf) => {
				if (leaf.pendingState?.type === type) void leaf.setViewState(leaf.pendingState, undefined, { history: true });
			});
		});
		window.addEventListener('resize', () => this.trigger('resize'));
	}

	/** Build the default layout. Called once views are registered. */
	/**
	 * Restore the saved layout (or build the default) and fire onLayoutReady callbacks. The layout lives in
	 * .obsidian/workspace-web.json so it doesn't fight desktop Obsidian over workspace.json on a shared folder;
	 * the first run imports the desktop layout if there is one.
	 */
	async initLayout(): Promise<void> {
		const { vault } = this.app;
		const layout = (await vault.readConfigJson('workspace-web')) ?? (await vault.readConfigJson('workspace'));
		try {
			if (layout) await this.loadLayout(layout);
		} catch (e) {
			console.warn('Ignoring unreadable workspace layout', e);
		}
		this.rootSplit.ensureLeaf();
		for (const side of [this.leftSplit, this.rightSplit]) if (!side.children.length) side.insertChild(0, new WorkspaceTabs(this, true));
		this.layoutReady = true;
		for (const cb of this.layoutReadyCbs.splice(0)) cb();
		this.on('layout-change', () => this.requestSaveLayout());
		this.on('active-leaf-change', () => this.requestSaveLayout());
		this.trigger('layout-change');
	}

	getLayout(): Record<string, unknown> {
		const ser = (item: WorkspaceItem): any => {
			if (item instanceof WorkspaceLeaf) return { id: item.id, type: 'leaf', state: item.getViewState() };
			if (item instanceof WorkspaceTabs) return { id: item.id, type: 'tabs', children: item.children.map(ser), currentTab: item.currentTab };
			const split = item as WorkspaceSplit;
			const out: any = { id: split.id, type: 'split', children: split.children.map(ser), direction: split.direction };
			if (split instanceof WorkspaceSidedock) Object.assign(out, { width: split.width, collapsed: split.collapsed });
			return out;
		};
		return {
			main: ser(this.rootSplit),
			left: ser(this.leftSplit),
			right: ser(this.rightSplit),
			active: this.activeLeaf?.id,
			lastOpenFiles: this.lastOpenFiles,
		};
	}

	/** Debounced write of the current layout. */
	requestSaveLayout = debounce(() => {
		if (this.layoutReady) void this.app.vault.writeConfigJson('workspace-web', this.getLayout());
	}, 1000);

	private async loadLayout(layout: any): Promise<void> {
		const jobs: Promise<void>[] = [];
		let active: WorkspaceLeaf | null = null;
		const build = (parent: WorkspaceParent, data: any, iconOnly: boolean): void => {
			if (data?.type === 'tabs') {
				const tabs = new WorkspaceTabs(this, iconOnly);
				parent.insertChild(parent.children.length, tabs);
				for (const child of data.children ?? []) build(tabs, child, iconOnly);
				tabs.selectTabIndex(Math.min(data.currentTab ?? 0, tabs.children.length - 1));
				if (!tabs.children.length) parent.removeChild(tabs);
			} else if (data?.type === 'leaf') {
				const leaf = new WorkspaceLeaf(this);
				if (typeof data.id === 'string') leaf.id = data.id;
				parent.insertChild(parent.children.length, leaf);
				if (data.id === layout.active) active = leaf;
				jobs.push(leaf.setViewState(data.state ?? { type: 'empty' }, undefined, { history: true }));
			} else if (data?.type === 'split') {
				const split = new WorkspaceSplit(this, data.direction === 'horizontal' ? 'horizontal' : 'vertical');
				parent.insertChild(parent.children.length, split);
				for (const child of data.children ?? []) build(split, child, iconOnly);
			}
		};
		for (const child of layout.main?.children ?? []) build(this.rootSplit, child, false);
		for (const [side, data] of [[this.leftSplit, layout.left], [this.rightSplit, layout.right]] as const) {
			for (const child of data?.children ?? []) build(side, child, true);
			if (typeof data?.width === 'number') side.setWidth(data.width);
			if (data?.collapsed) side.collapse();
		}
		if (Array.isArray(layout.lastOpenFiles)) this.lastOpenFiles = layout.lastOpenFiles.filter((p: unknown) => typeof p === 'string');
		await Promise.all(jobs);
		const restored = active as WorkspaceLeaf | null;
		if (restored) this.setActiveLeaf(restored);
		else {
			const first = firstLeaf(this.rootSplit);
			if (first) this.setActiveLeaf(first);
		}
	}

	onLayoutReady(cb: () => any): void {
		this.layoutReady ? cb() : this.layoutReadyCbs.push(cb);
	}

	// ----- leaves -----

	iterateAllLeaves(cb: (leaf: WorkspaceLeaf) => any): void {
		for (const root of [this.leftSplit, this.rootSplit, this.rightSplit]) iterateLeaves(root, cb);
	}

	iterateRootLeaves(cb: (leaf: WorkspaceLeaf) => any): void {
		iterateLeaves(this.rootSplit, cb);
	}

	getLeavesOfType(type: string): WorkspaceLeaf[] {
		const out: WorkspaceLeaf[] = [];
		this.iterateAllLeaves((l) => l.view?.getViewType() === type && out.push(l));
		return out;
	}

	detachLeavesOfType(type: string): void {
		for (const l of this.getLeavesOfType(type)) l.detach();
	}

	getLeafById(id: string): WorkspaceLeaf | null {
		let found: WorkspaceLeaf | null = null;
		this.iterateAllLeaves((l) => { if (l.id === id) found = l; });
		return found;
	}

	getMostRecentLeaf(): WorkspaceLeaf | null {
		return this.recentRootLeaves[0] ?? null;
	}

	/**
	 * false/undefined: reuse the most recent unpinned root leaf; 'tab'/true: new tab next to it; 'split': split it.
	 * ('window' falls back to a tab: pop-outs are phase 2.)
	 */
	getLeaf(newLeaf?: PaneType | boolean, direction: SplitDirection = 'vertical'): WorkspaceLeaf {
		const recent = this.getMostRecentLeaf();
		if (newLeaf === 'split' && recent) return this.createLeafBySplit(recent, direction);
		if (!newLeaf && recent && !recent.pinned) return recent;
		const tabs = (recent?.parent as WorkspaceTabs | null) ?? this.firstRootTabs();
		return this.createLeafInTabs(tabs);
	}

	getUnpinnedLeaf(): WorkspaceLeaf {
		return this.getLeaf(false);
	}

	createLeafInTabs(tabs: WorkspaceTabs): WorkspaceLeaf {
		const leaf = new WorkspaceLeaf(this);
		const after = this.activeLeaf?.parent === tabs ? tabs.children.indexOf(this.activeLeaf) + 1 : tabs.children.length;
		tabs.insertChild(after, leaf);
		return leaf;
	}

	createLeafBySplit(leaf: WorkspaceLeaf, direction: SplitDirection = 'vertical', before = false): WorkspaceLeaf {
		const tabs = leaf.parent as WorkspaceTabs;
		const split = tabs.parent as WorkspaceSplit;
		const newTabs = new WorkspaceTabs(this);
		const newLeaf = new WorkspaceLeaf(this);
		newTabs.insertChild(0, newLeaf);
		const i = split.children.indexOf(tabs);
		if (split.direction === direction) {
			split.insertChild(before ? i : i + 1, newTabs);
		} else {
			const sub = new WorkspaceSplit(this, direction);
			split.replaceChild(tabs, sub);
			sub.insertChild(0, tabs);
			sub.insertChild(before ? 0 : 1, newTabs);
		}
		this.trigger('layout-change');
		return newLeaf;
	}

	splitActiveLeaf(direction: SplitDirection = 'vertical'): WorkspaceLeaf {
		return this.createLeafBySplit(this.getMostRecentLeaf() ?? this.getLeaf(), direction);
	}

	getLeftLeaf(split: boolean): WorkspaceLeaf {
		return this.getSideLeaf(this.leftSplit, split);
	}

	getRightLeaf(split: boolean): WorkspaceLeaf {
		return this.getSideLeaf(this.rightSplit, split);
	}

	private getSideLeaf(side: WorkspaceSidedock, split: boolean): WorkspaceLeaf {
		let tabs = side.children[0] as WorkspaceTabs | undefined;
		if (!tabs || split) {
			tabs = new WorkspaceTabs(this, true);
			side.insertChild(side.children.length, tabs);
		}
		return this.createLeafInTabs(tabs);
	}

	async ensureSideLeaf(type: string, side: 'left' | 'right', options: { active?: boolean; split?: boolean; reveal?: boolean; state?: any } = {}): Promise<WorkspaceLeaf> {
		const existing = this.getLeavesOfType(type)[0];
		if (existing) {
			if (options.reveal) await this.revealLeaf(existing);
			return existing;
		}
		const leaf = side === 'left' ? this.getLeftLeaf(!!options.split) : this.getRightLeaf(!!options.split);
		await leaf.setViewState({ type, state: options.state, active: options.active });
		if (options.reveal) await this.revealLeaf(leaf);
		return leaf;
	}

	async revealLeaf(leaf: WorkspaceLeaf): Promise<void> {
		const root = leaf.getRoot();
		if (root instanceof WorkspaceSidedock) root.expand();
		(leaf.parent as WorkspaceTabs | null)?.selectTab(leaf);
	}

	setActiveLeaf(leaf: WorkspaceLeaf, params?: { focus?: boolean }): void {
		(leaf.parent as WorkspaceTabs | null)?.selectTab(leaf);
		if (leaf.getRoot() === this.rootSplit) {
			const i = this.recentRootLeaves.indexOf(leaf);
			if (i >= 0) this.recentRootLeaves.splice(i, 1);
			this.recentRootLeaves.unshift(leaf);
		}
		if (this.activeLeaf !== leaf) {
			this.activeLeaf?.containerEl.removeClass('mod-active');
			this.activeLeaf = leaf;
			leaf.containerEl.addClass('mod-active');
			this.trigger('active-leaf-change', leaf);
		}
		if (params?.focus) (leaf.view?.containerEl.querySelector('.cm-content, .view-content') as HTMLElement | null)?.focus();
		this.checkFileOpen();
	}

	getActiveFile(): TFile | null {
		const v = this.getMostRecentLeaf()?.view as FileView | undefined;
		return v?.file ?? null;
	}

	getActiveViewOfType<T extends View>(type: abstract new (...args: any[]) => T): T | null {
		const v = this.activeLeaf?.view;
		return v instanceof type ? v : null;
	}

	async openLinkText(linktext: string, sourcePath: string, newLeaf?: PaneType | boolean, openViewState?: { active?: boolean; state?: any; eState?: any }): Promise<void> {
		const { vault, metadataCache } = this.app;
		const hash = linktext.indexOf('#');
		const path = hash < 0 ? linktext : linktext.slice(0, hash);
		const subpath = hash < 0 ? '' : linktext.slice(hash);
		let file = path ? metadataCache.getFirstLinkpathDest(path, sourcePath) : vault.getFileByPath(sourcePath);
		// Clicking an unresolved link creates the note, as in Obsidian.
		if (!file && path) file = await vault.create(path.endsWith('.md') ? path : `${path}.md`, '');
		if (!file) return;
		const eState = subpath ? { ...openViewState?.eState, subpath } : openViewState?.eState;
		// Same-file heading link in the current view: just scroll.
		const current = this.getMostRecentLeaf();
		if (!path && !newLeaf && current && (current.view as FileView)?.file === file) {
			current.view.setEphemeralState(eState);
			return;
		}
		await this.getLeaf(newLeaf).openFile(file, { ...openViewState, eState });
	}

	// ----- internal notifications from leaves -----

	/** @internal */
	onLeafStateChanged(leaf: WorkspaceLeaf): void {
		if (leaf === this.activeLeaf) this.checkFileOpen();
		this.requestLayoutChange();
	}

	/** @internal */
	onLeafDetached(leaf: WorkspaceLeaf): void {
		const i = this.recentRootLeaves.indexOf(leaf);
		if (i >= 0) this.recentRootLeaves.splice(i, 1);
		if (this.activeLeaf === leaf) {
			this.activeLeaf = null;
			const next = this.getMostRecentLeaf() ?? firstLeaf(this.rootSplit);
			if (next) this.setActiveLeaf(next);
		}
		this.requestLayoutChange();
	}

	private requestLayoutChange = debounce(() => this.trigger('layout-change'), 50);

	/** The focused Markdown editor (MarkdownView), if any. */
	get activeEditor(): (View & { editor: any; file: TFile | null }) | null {
		const v = this.activeLeaf?.view as any;
		return v?.editor ? v : null;
	}

	getLastOpenFiles(): string[] {
		return this.lastOpenFiles.filter((p) => this.app.vault.getAbstractFileByPath(p));
	}

	private checkFileOpen(): void {
		const file = this.getActiveFile();
		if (file !== this.lastActiveFile) {
			this.lastActiveFile = file;
			if (file) this.lastOpenFiles = [file.path, ...this.lastOpenFiles.filter((p) => p !== file.path)].slice(0, 50);
			this.trigger('file-open', file);
		}
	}

	private firstRootTabs(): WorkspaceTabs {
		let tabs: WorkspaceTabs | null = null;
		const find = (p: WorkspaceItem) => {
			if (tabs) return;
			if (p instanceof WorkspaceTabs) tabs = p;
			else if (p instanceof WorkspaceParent) p.children.forEach(find);
		};
		find(this.rootSplit);
		return tabs!;
	}
}

function iterateLeaves(item: WorkspaceItem, cb: (leaf: WorkspaceLeaf) => any): void {
	if (item instanceof WorkspaceLeaf) cb(item);
	else if (item instanceof WorkspaceParent) for (const c of item.children) iterateLeaves(c, cb);
}

function firstLeaf(item: WorkspaceItem): WorkspaceLeaf | null {
	let found: WorkspaceLeaf | null = null;
	iterateLeaves(item, (l) => { found ??= l; });
	return found;
}

// ---------------- Notice ----------------

export class Notice {
	noticeEl: HTMLElement;

	constructor(message: string | DocumentFragment, duration = 4000) {
		let container = document.body.querySelector<HTMLElement>('.notice-container');
		if (!container) container = document.body.createDiv('notice-container');
		this.noticeEl = container.createDiv('notice');
		this.noticeEl.setText(message);
		this.noticeEl.addEventListener('click', () => this.hide());
		if (duration) setTimeout(() => this.hide(), duration);
	}

	setMessage(message: string | DocumentFragment): this {
		this.noticeEl.setText(message);
		return this;
	}

	hide(): void {
		this.noticeEl.detach();
	}
}
