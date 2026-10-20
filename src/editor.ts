// `Editor` (obsidian.d.ts) over a CodeMirror 6 EditorView. Positions are 0-based {line, ch}; CM6 lines are 1-based.
import { redo, undo, selectAll, indentMore, indentLess, cursorDocStart, cursorDocEnd } from '@codemirror/commands';
import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

export interface EditorPosition { line: number; ch: number; }
export interface EditorRange { from: EditorPosition; to: EditorPosition; }
export interface EditorSelectionPos { anchor: EditorPosition; head: EditorPosition; }
export interface EditorRangeOrCaret { from: EditorPosition; to?: EditorPosition; }
export interface EditorChange extends EditorRangeOrCaret { text: string; }
export interface EditorTransaction {
	replaceSelection?: string;
	changes?: EditorChange[];
	selections?: EditorRangeOrCaret[];
	selection?: EditorRangeOrCaret;
}

export class Editor {
	constructor(public cm: EditorView) {}

	getDoc(): this { return this; }
	refresh(): void { this.cm.requestMeasure(); }

	getValue(): string { return this.cm.state.doc.toString(); }
	setValue(content: string): void {
		this.cm.dispatch({ changes: { from: 0, to: this.cm.state.doc.length, insert: content } });
	}

	getLine(line: number): string { return this.cm.state.doc.line(line + 1).text; }
	setLine(n: number, text: string): void {
		const l = this.cm.state.doc.line(n + 1);
		this.cm.dispatch({ changes: { from: l.from, to: l.to, insert: text } });
	}
	lineCount(): number { return this.cm.state.doc.lines; }
	lastLine(): number { return this.cm.state.doc.lines - 1; }

	getSelection(): string {
		const { from, to } = this.cm.state.selection.main;
		return this.cm.state.sliceDoc(from, to);
	}
	somethingSelected(): boolean { return !this.cm.state.selection.main.empty; }
	getRange(from: EditorPosition, to: EditorPosition): string {
		return this.cm.state.sliceDoc(this.posToOffset(from), this.posToOffset(to));
	}

	replaceSelection(replacement: string, _origin?: string): void {
		this.cm.dispatch(this.cm.state.replaceSelection(replacement));
	}
	replaceRange(replacement: string, from: EditorPosition, to?: EditorPosition, _origin?: string): void {
		const a = this.posToOffset(from);
		this.cm.dispatch({ changes: { from: a, to: to ? this.posToOffset(to) : a, insert: replacement } });
	}

	getCursor(side: 'from' | 'to' | 'head' | 'anchor' = 'head'): EditorPosition {
		const r = this.cm.state.selection.main;
		return this.offsetToPos(side === 'from' ? r.from : side === 'to' ? r.to : side === 'anchor' ? r.anchor : r.head);
	}
	listSelections(): EditorSelectionPos[] {
		return this.cm.state.selection.ranges.map((r) => ({ anchor: this.offsetToPos(r.anchor), head: this.offsetToPos(r.head) }));
	}
	setCursor(pos: EditorPosition | number, ch?: number): void {
		const p = typeof pos === 'number' ? { line: pos, ch: ch ?? 0 } : pos;
		this.setSelection(p);
	}
	setSelection(anchor: EditorPosition, head?: EditorPosition): void {
		this.cm.dispatch({ selection: EditorSelection.single(this.posToOffset(anchor), this.posToOffset(head ?? anchor)), scrollIntoView: true });
	}
	setSelections(ranges: EditorRangeOrCaret[], main?: number): void {
		this.cm.dispatch({ selection: EditorSelection.create(ranges.map((r) => this.toRange(r)), main) });
	}

	focus(): void { this.cm.focus(); }
	blur(): void { this.cm.contentDOM.blur(); }
	hasFocus(): boolean { return this.cm.hasFocus; }

	getScrollInfo(): { top: number; left: number } {
		return { top: this.cm.scrollDOM.scrollTop, left: this.cm.scrollDOM.scrollLeft };
	}
	scrollTo(x?: number | null, y?: number | null): void {
		if (x != null) this.cm.scrollDOM.scrollLeft = x;
		if (y != null) this.cm.scrollDOM.scrollTop = y;
	}
	scrollIntoView(range: EditorRange, center?: boolean): void {
		this.cm.dispatch({ effects: (this.cm.constructor as typeof EditorView).scrollIntoView(this.posToOffset(range.from), { y: center ? 'center' : 'nearest' }) });
	}

	undo(): void { undo(this.cm); }
	redo(): void { redo(this.cm); }

	/** Subset of Obsidian's EditorCommandName that maps onto CM6 commands. */
	exec(command: string): void {
		const map: Record<string, (v: EditorView) => boolean> = {
			undo, redo, selectAll, indentMore, indentLess, goStart: cursorDocStart, goEnd: cursorDocEnd,
		};
		map[command]?.(this.cm);
	}

	transaction(tx: EditorTransaction, _origin?: string): void {
		const changes = (tx.changes ?? []).map((c) => ({ from: this.posToOffset(c.from), to: c.to ? this.posToOffset(c.to) : undefined, insert: c.text }));
		if (tx.replaceSelection !== undefined) {
			const { from, to } = this.cm.state.selection.main;
			changes.push({ from, to, insert: tx.replaceSelection });
		}
		const sel = tx.selections ?? (tx.selection ? [tx.selection] : undefined);
		this.cm.dispatch({ changes, selection: sel ? EditorSelection.create(sel.map((r) => this.toRange(r))) : undefined });
	}

	wordAt(pos: EditorPosition): EditorRange | null {
		const r = this.cm.state.wordAt(this.posToOffset(pos));
		return r ? { from: this.offsetToPos(r.from), to: this.offsetToPos(r.to) } : null;
	}

	posToOffset(pos: EditorPosition): number {
		const doc = this.cm.state.doc;
		const line = doc.line(Math.max(1, Math.min(doc.lines, pos.line + 1)));
		return line.from + Math.max(0, Math.min(line.length, pos.ch));
	}
	offsetToPos(offset: number): EditorPosition {
		const line = this.cm.state.doc.lineAt(Math.max(0, Math.min(this.cm.state.doc.length, offset)));
		return { line: line.number - 1, ch: offset - line.from };
	}

	processLines<T>(read: (line: number, text: string) => T | null, write: (line: number, text: string, value: T | null) => EditorChange | void, ignoreEmpty = true): void {
		const sels = this.cm.state.selection.ranges;
		const changes: EditorChange[] = [];
		const seen = new Set<number>();
		for (const r of sels) {
			const a = this.offsetToPos(r.from).line;
			const b = this.offsetToPos(r.to).line;
			for (let l = a; l <= b; l++) {
				if (seen.has(l)) continue;
				seen.add(l);
				const text = this.getLine(l);
				if (ignoreEmpty && !text.trim() && a !== b) continue;
				const c = write(l, text, read(l, text));
				if (c) changes.push(c);
			}
		}
		if (changes.length) this.transaction({ changes });
	}

	private toRange(r: EditorRangeOrCaret) {
		return EditorSelection.range(this.posToOffset(r.from), this.posToOffset(r.to ?? r.from));
	}
}
