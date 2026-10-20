// Live Preview (PLAN §5.2): CM6 decorations that hide Markdown syntax away from the cursor and render rich blocks.
//   blockField   (StateField): frontmatter → properties, callouts, tables, $$math$$, ```mermaid → rendered widgets.
//   inlinePlugin (ViewPlugin): hide marks (#, **, ~~, `, [](), [[ ]], ==, >), checkboxes, bullets, inline math,
//                              embeds, link/tag/highlight/comment styling. Markup is revealed where the selection is.
// ponytail: blocks are found by a line scan on every doc change (O(lines)); incremental if very long notes lag.
import { syntaxTree } from '@codemirror/language';
import { EditorState, StateField, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { App } from './app';
import type { Component } from './events';
import { parseFrontmatterYaml, renderProperties, stringifyFrontmatter } from './properties';
import { MarkdownRenderer, loadMathJax, renderMath } from './render';

export interface LivePreviewHost {
	app: App;
	component: Component;
	sourcePath(): string;
}

// ---------------- Widgets ----------------

/** Renders a slice of Markdown with the shared renderer; clicking it (outside links/inputs) moves the cursor into it. */
class MarkdownWidget extends WidgetType {
	constructor(readonly host: LivePreviewHost, readonly source: string, readonly cls: string, readonly from: number, readonly block: boolean) {
		super();
	}
	eq(o: MarkdownWidget): boolean {
		return o.source === this.source && o.cls === this.cls && o.block === this.block;
	}
	toDOM(view: EditorView): HTMLElement {
		const el = createEl(this.block ? 'div' : 'span', { cls: `cm-embed-block ${this.cls}` });
		void MarkdownRenderer.render(this.host.app, this.source, el, this.host.sourcePath(), this.host.component)
			.then(() => view.requestMeasure());
		if (this.block) {
			el.addEventListener('mousedown', (e) => {
				if ((e.target as HTMLElement).closest('a, input, button, .callout-fold, .markdown-embed-link')) return;
				e.preventDefault();
				view.dispatch({ selection: { anchor: this.from } });
				view.focus();
			});
		}
		return el;
	}
	get estimatedHeight(): number {
		return this.block ? 40 : -1;
	}
	ignoreEvent(e: Event): boolean {
		return e.type !== 'mousedown';
	}
}

class PropertiesWidget extends WidgetType {
	constructor(readonly yaml: string, readonly from: number, readonly to: number) {
		super();
	}
	eq(o: PropertiesWidget): boolean {
		return o.yaml === this.yaml;
	}
	toDOM(view: EditorView): HTMLElement {
		const el = createDiv('cm-embed-block cm-preview-code-block');
		renderProperties(el.createDiv(), parseFrontmatterYaml(this.yaml), (fm) => {
			// Positions may have shifted since render; find the frontmatter again in the current doc.
			const range = findFrontmatter(view.state);
			const text = stringifyFrontmatter(fm);
			if (range) view.dispatch({ changes: { from: range.from, to: range.to + (text ? 0 : 1), insert: text } });
			else if (text) view.dispatch({ changes: { from: 0, insert: text + '\n' } });
		});
		return el;
	}
	ignoreEvent(): boolean {
		return true;
	}
}

class CheckboxWidget extends WidgetType {
	constructor(readonly checked: boolean, readonly pos: number) {
		super();
	}
	eq(o: CheckboxWidget): boolean {
		return o.checked === this.checked && o.pos === this.pos;
	}
	toDOM(view: EditorView): HTMLElement {
		const cb = createEl('input', { type: 'checkbox', cls: 'task-list-item-checkbox' });
		cb.checked = this.checked;
		cb.addEventListener('mousedown', (e) => e.preventDefault());
		cb.addEventListener('click', () => view.dispatch({ changes: { from: this.pos, to: this.pos + 1, insert: this.checked ? ' ' : 'x' } }));
		return cb;
	}
	ignoreEvent(): boolean {
		return true;
	}
}

class BulletWidget extends WidgetType {
	eq(): boolean {
		return true;
	}
	toDOM(): HTMLElement {
		return createSpan({ cls: 'list-bullet', text: '•' });
	}
}

class MathWidget extends WidgetType {
	constructor(readonly tex: string) {
		super();
	}
	eq(o: MathWidget): boolean {
		return o.tex === this.tex;
	}
	toDOM(view: EditorView): HTMLElement {
		const el = createSpan({ cls: 'math math-inline cm-math', text: this.tex });
		void loadMathJax().then(() => {
			el.replaceChildren(renderMath(this.tex, false));
			view.requestMeasure();
		}).catch(() => {});
		return el;
	}
}

class HrWidget extends WidgetType {
	eq(): boolean {
		return true;
	}
	toDOM(): HTMLElement {
		return createEl('hr');
	}
}

// ---------------- Block scan ----------------

interface Block {
	from: number;
	to: number;
	kind: 'properties' | 'callout' | 'table' | 'math' | 'code';
	source: string;
}

function findFrontmatter(state: EditorState): { from: number; to: number; yaml: string } | null {
	const doc = state.doc;
	if (doc.lines < 2 || doc.line(1).text !== '---') return null;
	for (let n = 2; n <= doc.lines; n++) {
		const t = doc.line(n).text;
		if (t === '---' || t === '...') {
			return { from: 0, to: doc.line(n).to, yaml: state.sliceDoc(doc.line(2).from, doc.line(n).from) };
		}
	}
	return null;
}

function scanBlocks(state: EditorState, renderedLangs: (lang: string) => boolean): Block[] {
	const doc = state.doc;
	const blocks: Block[] = [];
	const fm = findFrontmatter(state);
	let n = 1;
	if (fm) {
		blocks.push({ from: fm.from, to: fm.to, kind: 'properties', source: fm.yaml });
		n = doc.lineAt(fm.to).number + 1;
	}
	const text = (k: number) => doc.line(k).text;
	for (; n <= doc.lines; n++) {
		const line = text(n);
		const fence = /^ {0,3}(`{3,}|~{3,})\s*([\w-]*)/.exec(line);
		if (fence) {
			const close = new RegExp(`^ {0,3}\\${fence[1][0]}{${fence[1].length},}\\s*$`);
			let end = n + 1;
			while (end <= doc.lines && !close.test(text(end))) end++;
			end = Math.min(end, doc.lines);
			if (renderedLangs(fence[2].toLowerCase())) {
				blocks.push({ from: doc.line(n).from, to: doc.line(end).to, kind: 'code', source: state.sliceDoc(doc.line(n).from, doc.line(end).to) });
			}
			n = end;
			continue;
		}
		if (line.trim() === '$$' || (line.startsWith('$$') && !line.trimEnd().endsWith('$$'))) {
			let end = n + 1;
			while (end <= doc.lines && !text(end).trimEnd().endsWith('$$')) end++;
			if (end > doc.lines) continue; // unclosed
			blocks.push({ from: doc.line(n).from, to: doc.line(end).to, kind: 'math', source: state.sliceDoc(doc.line(n).from, doc.line(end).to) });
			n = end;
			continue;
		}
		if (/^\s*>\s*\[!/.test(line)) {
			let end = n;
			while (end + 1 <= doc.lines && /^\s*>/.test(text(end + 1))) end++;
			blocks.push({ from: doc.line(n).from, to: doc.line(end).to, kind: 'callout', source: state.sliceDoc(doc.line(n).from, doc.line(end).to) });
			n = end;
			continue;
		}
		if (/^\s*\|/.test(line) && n + 1 <= doc.lines && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(text(n + 1))) {
			let end = n + 1;
			while (end + 1 <= doc.lines && /^\s*\|/.test(text(end + 1))) end++;
			blocks.push({ from: doc.line(n).from, to: doc.line(end).to, kind: 'table', source: state.sliceDoc(doc.line(n).from, doc.line(end).to) });
			n = end;
		}
	}
	return blocks;
}

/** Mark decorations may not be empty in CM6 (e.g. "[[]]"), so skip zero-length ones. */
function pushMark(deco: Range<Decoration>[], spec: Parameters<typeof Decoration.mark>[0], from: number, to: number): void {
	if (from < to) deco.push(Decoration.mark(spec).range(from, to));
}

function touches(state: EditorState, from: number, to: number): boolean {
	return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

// ---------------- Extension ----------------

export function livePreview(host: LivePreviewHost, renderedLangs: (lang: string) => boolean): Extension {
	const propsMode = () => host.app.vault.getConfig('propertiesInDocument');

	const blockField = StateField.define<{ blocks: Block[]; decos: DecorationSet }>({
		create(state) {
			const blocks = scanBlocks(state, renderedLangs);
			return { blocks, decos: blockDecos(state, blocks) };
		},
		update(value, tr) {
			if (!tr.docChanged && !tr.selection) return value;
			const blocks = tr.docChanged ? scanBlocks(tr.state, renderedLangs) : value.blocks;
			return { blocks, decos: blockDecos(tr.state, blocks) };
		},
		provide: (f) => [
			EditorView.decorations.from(f, (v) => v.decos),
			// The cursor skips over the properties block instead of landing inside hidden YAML.
			EditorView.atomicRanges.of((view) => {
				const b = view.state.field(f).blocks.find((x) => x.kind === 'properties');
				return b && propsMode() !== 'source' ? Decoration.set(Decoration.replace({}).range(b.from, b.to)) : Decoration.none;
			}),
		],
	});

	function blockDecos(state: EditorState, blocks: Block[]): DecorationSet {
		const out: Range<Decoration>[] = [];
		for (const b of blocks) {
			if (b.kind === 'properties') {
				const mode = propsMode();
				if (mode === 'source') continue;
				out.push(Decoration.replace({ block: true, widget: mode === 'hidden' ? undefined : new PropertiesWidget(b.source, b.from, b.to) }).range(b.from, b.to));
				continue;
			}
			if (touches(state, b.from, b.to)) continue; // editing: show the source
			out.push(Decoration.replace({ block: true, widget: new MarkdownWidget(host, b.source, `cm-${b.kind}-widget`, b.from, true) }).range(b.from, b.to));
		}
		return Decoration.set(out, true);
	}

	const inlinePlugin = ViewPlugin.fromClass(class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = this.build(view);
		}
		update(u: ViewUpdate) {
			if (u.docChanged || u.selectionSet || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = this.build(u.view);
		}
		build(view: EditorView): DecorationSet {
			const { state } = view;
			const deco: Range<Decoration>[] = [];
			const hidden = Decoration.replace({});
			const blocks = state.field(blockField).blocks;
			const inBlock = (pos: number) => blocks.some((b) => pos >= b.from && pos <= b.to);
			const activeLine = (pos: number) => {
				const line = state.doc.lineAt(pos);
				return touches(state, line.from, line.to);
			};
			const codeRanges: [number, number][] = [];

			for (const { from, to } of view.visibleRanges) {
				syntaxTree(state).iterate({
					from, to,
					enter: (node) => {
						const name = node.name;
						// Skip nodes rendered by a block widget (but not ancestors like Document that merely start inside one).
						if (blocks.some((b) => node.from >= b.from && node.to <= b.to)) return false;
						if (name === 'FencedCode' || name === 'CodeBlock') {
							codeRanges.push([node.from, node.to]);
							for (let l = state.doc.lineAt(node.from).number; l <= state.doc.lineAt(node.to).number; l++) {
								const line = state.doc.line(l);
								const edge = line.from === state.doc.lineAt(node.from).from ? ' HyperMD-codeblock-begin' : line.to === state.doc.lineAt(node.to).to ? ' HyperMD-codeblock-end' : '';
								deco.push(Decoration.line({ class: `HyperMD-codeblock HyperMD-codeblock-bg${edge}` }).range(line.from));
							}
							return false;
						}
						if (name === 'InlineCode') {
							codeRanges.push([node.from, node.to]);
							if (!touches(state, node.from, node.to)) {
								for (let c = node.node.firstChild; c; c = c.nextSibling) if (c.name === 'CodeMark') deco.push(hidden.range(c.from, c.to));
							}
							return false;
						}
						if (/^ATXHeading\d$/.test(name)) {
							const level = name.slice(-1);
							deco.push(Decoration.line({ class: `HyperMD-header HyperMD-header-${level}` }).range(state.doc.lineAt(node.from).from));
							const mark = node.node.firstChild;
							if (mark?.name === 'HeaderMark' && !activeLine(node.from)) deco.push(hidden.range(mark.from, Math.min(mark.to + 1, node.to)));
							return;
						}
						if (name === 'EmphasisMark' || name === 'StrikethroughMark') {
							const parent = node.node.parent!;
							if (!touches(state, parent.from, parent.to)) deco.push(hidden.range(node.from, node.to));
							return;
						}
						if (name === 'Link' || name === 'Image') {
							// Only inline [text](url) links: the grammar also reads [^1] and the brackets of [[wikilinks]] as reference links.
							const url = node.node.getChild('URL');
							if (!url) return;
							if (touches(state, node.from, node.to)) return false;
							const href = state.sliceDoc(url.from, url.to);
							if (name === 'Image') {
								deco.push(Decoration.replace({ widget: new MarkdownWidget(host, state.sliceDoc(node.from, node.to), 'image-embed', node.from, false) }).range(node.from, node.to));
								return false;
							}
							const marks = node.node.getChildren('LinkMark');
							if (marks.length < 2) return false;
							const textFrom = marks[0].to;
							const textTo = marks[1].from;
							deco.push(hidden.range(node.from, textFrom));
							const external = /^[a-z][a-z0-9+.-]*:/i.test(href);
							pushMark(deco, { class: external ? 'cm-link cm-underline external-link' : 'cm-hmd-internal-link cm-underline', attributes: { 'data-href': href, 'data-external': String(external) } }, textFrom, textTo);
							deco.push(hidden.range(textTo, node.to));
							return false;
						}
						if (name === 'QuoteMark') {
							deco.push(Decoration.line({ class: 'HyperMD-quote' }).range(state.doc.lineAt(node.from).from));
							if (!activeLine(node.from)) deco.push(hidden.range(node.from, Math.min(node.to + 1, state.doc.lineAt(node.from).to)));
							return;
						}
						if (name === 'ListMark') {
							const item = node.node.parent!;
							const task = item.getChild('Task')?.getChild('TaskMarker');
							const lineFrom = state.doc.lineAt(node.from).from;
							deco.push(Decoration.line({ class: 'HyperMD-list-line' + (task ? ' HyperMD-task-line' : '') }).range(lineFrom));
							if (task) {
								const ch = state.sliceDoc(task.from + 1, task.from + 2);
								if (ch !== ' ') deco.push(Decoration.line({ attributes: { 'data-task': ch } }).range(lineFrom));
								if (!touches(state, node.from, task.to)) {
									deco.push(Decoration.replace({ widget: new CheckboxWidget(ch !== ' ', task.from + 1) }).range(node.from, Math.min(task.to + 1, state.doc.lineAt(node.from).to)));
								}
							} else if (/^[-*+]$/.test(state.sliceDoc(node.from, node.to)) && !touches(state, node.from, node.to + 1)) {
								deco.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to));
							}
							return;
						}
						if (name === 'HorizontalRule' && !activeLine(node.from)) {
							deco.push(Decoration.replace({ widget: new HrWidget() }).range(node.from, node.to));
							return false;
						}
					},
				});

				// Obsidian syntax the Markdown grammar doesn't know: [[links]], ![[embeds]], #tags, ==highlights==, %%comments%%, $math$.
				const inCode = (a: number, b: number) => codeRanges.some(([s, e]) => a < e && b > s) || inBlock(a);
				for (let pos = from; pos <= to;) {
					const line = state.doc.lineAt(pos);
					scanLine(line.text, line.from, inCode, deco, state, host);
					pos = line.to + 1;
				}
			}
			return Decoration.set(deco, true);
		}
	}, { decorations: (v) => v.decorations });

	const clickLinks = EditorView.domEventHandlers({
		mousedown(e, view) {
			const a = (e.target as HTMLElement).closest('[data-href]') as HTMLElement | null;
			if (!a || !view.contentDOM.contains(a)) return false;
			e.preventDefault();
			const href = a.dataset.href!;
			if (a.dataset.external === 'true') window.open(href, '_blank', 'noopener');
			else void host.app.workspace.openLinkText(href, host.sourcePath(), e.ctrlKey || e.metaKey ? 'tab' : false);
			return true;
		},
	});

	return [blockField, inlinePlugin, clickLinks, EditorView.editorAttributes.of({ class: 'is-live-preview' })];
}

const WIKI = /(!?)\[\[([^\[\]\n]+?)\]\]/g;
const TAG = /(^|\s)(#[\p{L}\p{N}\p{M}_\/-]*[\p{L}\p{M}_\/-][\p{L}\p{N}\p{M}_\/-]*)/gu;
const HIGHLIGHT = /==(?=\S)([^=\n]+?)==/g;
const COMMENT = /%%.*?%%/g;
const MATH = /(?<![\\$])\$(?=\S)([^$\n]+?)(?<=\S)\$(?!\d)/g;

function scanLine(text: string, base: number, inCode: (a: number, b: number) => boolean, deco: Range<Decoration>[], state: EditorState, host: LivePreviewHost): void {
	const hidden = Decoration.replace({});
	const each = (re: RegExp, fn: (m: RegExpExecArray, from: number, to: number) => void) => {
		re.lastIndex = 0;
		for (let m = re.exec(text); m; m = re.exec(text)) {
			const from = base + m.index;
			const to = from + m[0].length;
			if (!inCode(from, to)) fn(m, from, to);
		}
	};
	each(COMMENT, (_m, from, to) => pushMark(deco, { class: 'cm-comment' }, from, to));
	each(WIKI, (m, from, to) => {
		const [, bang, inner] = m;
		const bar = inner.indexOf('|');
		const target = (bar < 0 ? inner : inner.slice(0, bar)).trim();
		if (touches(state, from, to)) {
			pushMark(deco, { class: 'cm-hmd-internal-link', attributes: { 'data-href': target } }, from + bang.length + 2, to - 2);
			return;
		}
		if (bang) {
			deco.push(Decoration.replace({ widget: new MarkdownWidget(host, m[0], 'internal-embed-widget', from, false) }).range(from, to));
			return;
		}
		const textFrom = bar < 0 ? from + 2 : from + 2 + bar + 1;
		deco.push(hidden.range(from, textFrom));
		pushMark(deco, { class: 'cm-hmd-internal-link cm-underline', attributes: { 'data-href': target } }, textFrom, to - 2);
		deco.push(hidden.range(to - 2, to));
	});
	each(TAG, (m, from, to) => pushMark(deco, { class: 'cm-hashtag cm-hashtag-begin cm-hashtag-end' }, from + m[1].length, to));
	each(HIGHLIGHT, (_m, from, to) => {
		const active = touches(state, from, to);
		if (!active) deco.push(hidden.range(from, from + 2));
		pushMark(deco, { class: 'cm-highlight' }, from + (active ? 0 : 2), to - (active ? 0 : 2));
		if (!active) deco.push(hidden.range(to - 2, to));
	});
	each(MATH, (m, from, to) => {
		if (touches(state, from, to)) pushMark(deco, { class: 'cm-math' }, from, to);
		else deco.push(Decoration.replace({ widget: new MathWidget(m[1]) }).range(from, to));
	});
}
