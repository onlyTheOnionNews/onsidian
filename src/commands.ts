// Core commands, with Obsidian's command ids so hotkeys.json files carry over between desktop and web.
// Browser-reserved shortcuts (Mod+N/T/W) also get Alt-based defaults (PLAN §3).
import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { App } from './app';
import { exportVaultZip, importZip } from './backup';
import { CommandPalette, QuickSwitcher } from './modals';
import { promptText } from './ui';
import type { MarkdownView } from './views/markdown';
import { type WorkspaceTabs } from './workspace';

/** Toggle `marker` around each selection (or insert an empty pair at the cursor). */
function toggleWrap(cm: EditorView, marker: string, end = marker): void {
	const { state } = cm;
	cm.dispatch(state.changeByRange((r) => {
		const text = state.sliceDoc(r.from, r.to);
		// Markers inside the selection: "**x**" selected.
		if (text.length >= marker.length + end.length && text.startsWith(marker) && text.endsWith(end)) {
			const inner = text.slice(marker.length, text.length - end.length);
			return { changes: { from: r.from, to: r.to, insert: inner }, range: EditorSelection.range(r.from, r.from + inner.length) };
		}
		// Markers just outside the selection: "x" selected inside "**x**".
		if (state.sliceDoc(r.from - marker.length, r.from) === marker && state.sliceDoc(r.to, r.to + end.length) === end) {
			return {
				changes: [{ from: r.from - marker.length, to: r.from }, { from: r.to, to: r.to + end.length }],
				range: EditorSelection.range(r.from - marker.length, r.to - marker.length),
			};
		}
		return {
			changes: [{ from: r.from, insert: marker }, { from: r.to, insert: end }],
			range: EditorSelection.range(r.from + marker.length, r.to + marker.length),
		};
	}));
}

/** Apply `fn` to every line touched by the selections. */
function mapLines(cm: EditorView, fn: (text: string) => string): void {
	const { state } = cm;
	const changes: { from: number; to: number; insert: string }[] = [];
	const seen = new Set<number>();
	for (const r of state.selection.ranges) {
		for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) {
			if (seen.has(n)) continue;
			seen.add(n);
			const line = state.doc.line(n);
			const out = fn(line.text);
			if (out !== line.text) changes.push({ from: line.from, to: line.to, insert: out });
		}
	}
	if (changes.length) cm.dispatch({ changes });
}

const LIST = /^(\s*)([-*+]|\d+[.)])\s+/;
const TASK = /^(\s*)([-*+]|\d+[.)])\s+\[(.)\]\s/;

export function toggleChecklist(text: string): string {
	const t = TASK.exec(text);
	if (t) return text.replace(/\[(.)\]/, t[3] === ' ' ? '[x]' : '[ ]');
	const l = LIST.exec(text);
	if (l) return text.slice(0, l[0].length) + '[ ] ' + text.slice(l[0].length);
	const indent = /^\s*/.exec(text)![0];
	return `${indent}- [ ] ${text.slice(indent.length)}`;
}

export function registerCoreCommands(app: App): void {
	const c = app.commands;
	const md = () => app.workspace.activeEditor as MarkdownView | null;
	const editorCmd = (id: string, name: string, run: (cm: EditorView) => void, hotkeys?: { modifiers: any[]; key: string }[]) =>
		c.addCommand({ id, name, hotkeys, editorCallback: (_e, view: MarkdownView) => run(view.cm) });

	c.addCommand({ id: 'command-palette:open', name: 'Command palette: Open command palette', icon: 'terminal', hotkeys: [{ modifiers: ['Mod'], key: 'P' }], callback: () => new CommandPalette(app).open() });
	c.addCommand({ id: 'switcher:open', name: 'Quick switcher: Open quick switcher', icon: 'search', hotkeys: [{ modifiers: ['Mod'], key: 'O' }], callback: () => new QuickSwitcher(app).open() });
	c.addCommand({ id: 'app:open-settings', name: 'Open settings', icon: 'settings', hotkeys: [{ modifiers: ['Mod'], key: ',' }], callback: () => app.setting.open() });
	for (const [id, name, key, dir] of [['app:go-back', 'Navigate back', 'ArrowLeft', 'back'], ['app:go-forward', 'Navigate forward', 'ArrowRight', 'forward']] as const) {
		c.addCommand({ id, name, hotkeys: [{ modifiers: ['Mod', 'Alt'], key }], checkCallback: (checking) => {
			const leaf = app.workspace.getMostRecentLeaf();
			const h = leaf?.history;
			if (!h || !(dir === 'back' ? h.backHistory : h.forwardHistory).length) return false;
			if (!checking) void (dir === 'back' ? h.back() : h.forward());
			return true;
		} });
	}
	// Mouse back/forward buttons navigate tabs instead of leaving the app.
	window.addEventListener('mouseup', (e) => {
		if (e.button !== 3 && e.button !== 4) return;
		e.preventDefault();
		c.executeCommandById(e.button === 3 ? 'app:go-back' : 'app:go-forward');
	});
	c.addCommand({ id: 'app:export-vault-zip', name: 'Export vault as .zip', icon: 'download', callback: () => void exportVaultZip(app) });
	c.addCommand({ id: 'app:import-zip', name: 'Import .zip into vault', icon: 'upload', callback: () => void importZip(app) });
	c.addCommand({ id: 'app:toggle-left-sidebar', name: 'Toggle left sidebar', callback: () => app.workspace.leftSplit.toggle() });
	c.addCommand({ id: 'app:toggle-right-sidebar', name: 'Toggle right sidebar', callback: () => app.workspace.rightSplit.toggle() });

	c.addCommand({ id: 'file-explorer:new-file', name: 'Create new note', icon: 'square-pen', hotkeys: [{ modifiers: ['Mod'], key: 'N' }, { modifiers: ['Alt'], key: 'N' }], callback: () => void app.newNote() });
	c.addCommand({ id: 'workspace:new-tab', name: 'New tab', hotkeys: [{ modifiers: ['Mod'], key: 'T' }, { modifiers: ['Alt'], key: 'T' }],
		callback: () => void app.workspace.getLeaf('tab').setViewState({ type: 'empty', active: true }) });
	c.addCommand({ id: 'workspace:close', name: 'Close current tab', hotkeys: [{ modifiers: ['Mod'], key: 'W' }, { modifiers: ['Alt'], key: 'W' }],
		checkCallback: (checking) => {
			const leaf = app.workspace.getMostRecentLeaf();
			if (!leaf) return false;
			if (!checking) leaf.detach();
			return true;
		} });
	for (const [id, name, delta] of [['workspace:next-tab', 'Go to next tab', 1], ['workspace:previous-tab', 'Go to previous tab', -1]] as const) {
		c.addCommand({ id, name, hotkeys: [{ modifiers: ['Ctrl'], key: delta > 0 ? 'PageDown' : 'PageUp' }], checkCallback: (checking) => {
			const leaf = app.workspace.getMostRecentLeaf();
			const tabs = leaf?.parent as WorkspaceTabs | null;
			if (!leaf || !tabs || tabs.children.length < 2) return false;
			if (!checking) {
				const next = tabs.children[(tabs.children.indexOf(leaf) + delta + tabs.children.length) % tabs.children.length];
				app.workspace.setActiveLeaf(next as any, { focus: true });
			}
			return true;
		} });
	}
	c.addCommand({ id: 'workspace:split-vertical', name: 'Split right', icon: 'separator-vertical', callback: () => void splitAndOpen('vertical') });
	c.addCommand({ id: 'workspace:split-horizontal', name: 'Split down', icon: 'separator-horizontal', callback: () => void splitAndOpen('horizontal') });
	async function splitAndOpen(dir: 'vertical' | 'horizontal') {
		const file = app.workspace.getActiveFile();
		const leaf = app.workspace.splitActiveLeaf(dir);
		if (file) await leaf.openFile(file, { active: true });
		else await leaf.setViewState({ type: 'empty', active: true });
	}

	const activeFileCmd = (id: string, name: string, run: (file: NonNullable<ReturnType<typeof app.workspace.getActiveFile>>) => any, hotkeys?: any[]) =>
		c.addCommand({ id, name, hotkeys, checkCallback: (checking) => {
			const file = app.workspace.getActiveFile();
			if (!file) return false;
			if (!checking) void run(file);
			return true;
		} });
	activeFileCmd('app:delete-file', 'Delete current file', (f) => app.fileManager.promptForDeletion(f));
	activeFileCmd('workspace:edit-file-title', 'Rename file', async (f) => {
		const name = await promptText(app, 'Rename file', f.extension === 'md' ? f.basename : f.name);
		if (!name?.trim()) return;
		const finalName = f.extension === 'md' && !name.endsWith('.md') ? `${name.trim()}.md` : name.trim();
		await app.fileManager.renameFile(f, f.parent && !f.parent.isRoot() ? `${f.parent.path}/${finalName}` : finalName);
	}, [{ modifiers: [], key: 'F2' }]);
	activeFileCmd('file-explorer:reveal-active-file', 'Reveal current file in navigation', async (f) => {
		const leaf = await app.workspace.ensureSideLeaf('file-explorer', 'left', { reveal: true });
		(leaf.view as any).revealFile?.(f);
	});

	c.addCommand({ id: 'markdown:toggle-preview', name: 'Toggle reading view', icon: 'book-open', hotkeys: [{ modifiers: ['Mod'], key: 'E' }],
		checkCallback: (checking) => {
			const view = app.workspace.activeLeaf?.view as MarkdownView | undefined;
			if (view?.getViewType() !== 'markdown') return false;
			if (!checking) view.setMode(view.mode === 'source' ? 'preview' : 'source');
			return true;
		} });
	c.addCommand({ id: 'editor:save-file', name: 'Save current file', hotkeys: [{ modifiers: ['Mod'], key: 'S' }],
		checkCallback: (checking) => {
			const view = md();
			if (!view) return false;
			if (!checking) void view.save();
			return true;
		} });

	editorCmd('editor:toggle-bold', 'Toggle bold', (cm) => toggleWrap(cm, '**'), [{ modifiers: ['Mod'], key: 'B' }]);
	editorCmd('editor:toggle-italics', 'Toggle italics', (cm) => toggleWrap(cm, '*'), [{ modifiers: ['Mod'], key: 'I' }]);
	editorCmd('editor:toggle-strikethrough', 'Toggle strikethrough', (cm) => toggleWrap(cm, '~~'));
	editorCmd('editor:toggle-highlight', 'Toggle highlight', (cm) => toggleWrap(cm, '=='));
	editorCmd('editor:toggle-code', 'Toggle code', (cm) => toggleWrap(cm, '`'));
	editorCmd('editor:toggle-comments', 'Toggle comment', (cm) => toggleWrap(cm, '%%'), [{ modifiers: ['Mod'], key: '/' }]);
	editorCmd('editor:insert-wikilink', 'Add internal link', (cm) => toggleWrap(cm, '[[', ']]'));
	editorCmd('editor:insert-link', 'Insert Markdown link', (cm) => toggleWrap(cm, '[', ']()'), [{ modifiers: ['Mod'], key: 'K' }]);
	editorCmd('editor:toggle-checklist-status', 'Toggle checkbox status', (cm) => mapLines(cm, toggleChecklist), [{ modifiers: ['Mod'], key: 'L' }]);
	editorCmd('editor:toggle-bullet-list', 'Toggle bullet list', (cm) => mapLines(cm, (t) => (LIST.test(t) ? t.replace(LIST, '$1') : t.replace(/^(\s*)/, '$1- '))));
	editorCmd('editor:toggle-numbered-list', 'Toggle numbered list', (cm) => mapLines(cm, (t) => (LIST.test(t) ? t.replace(LIST, '$1') : t.replace(/^(\s*)/, '$11. '))));
	editorCmd('editor:toggle-blockquote', 'Toggle blockquote', (cm) => mapLines(cm, (t) => (/^\s*>\s?/.test(t) ? t.replace(/^(\s*)>\s?/, '$1') : `> ${t}`)));
	for (let level = 1; level <= 6; level++) {
		editorCmd(`editor:set-heading-${level}`, `Set as heading ${level}`, (cm) =>
			mapLines(cm, (t) => {
				const stripped = t.replace(/^#{1,6}\s+/, '');
				return t.startsWith('#'.repeat(level) + ' ') ? stripped : `${'#'.repeat(level)} ${stripped}`;
			}));
	}
}
