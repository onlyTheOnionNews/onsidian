// Search query language (PLAN §5.4): terms, "phrases", /regex/, OR, -negation, (groups), operators
// file: path: content: tag: line: block: section: task: task-todo: task-done: match-case: ignore-case:, [prop], [prop:value].
// ponytail: linear scan over cached note text on the main thread (with yields). Fine to a few thousand notes; move to the
// worker with an inverted index (PLAN §5.4) when large vaults need it.
import type { CachedMetadata } from 'obsidian';
import type { App } from './app';
import { getAllTags } from './parse';
import type { TFile } from './vault';

type Node =
	| { t: 'and' | 'or'; items: Node[] }
	| { t: 'not'; item: Node }
	| { t: 'term'; text: string; regex?: RegExp; caseSensitive?: boolean }
	| { t: 'op'; op: string; item: Node }
	| { t: 'prop'; name: string; value: Node | null };

const OPS = new Set(['file', 'path', 'content', 'tag', 'line', 'block', 'section', 'task', 'task-todo', 'task-done', 'match-case', 'ignore-case']);

export function parseQuery(query: string): Node | null {
	let i = 0;
	const src = query;
	const ws = () => { while (/\s/.test(src[i] ?? '')) i++; };

	function parseOr(): Node | null {
		const items: Node[] = [];
		for (let n = parseAnd(); n; n = parseAnd()) {
			items.push(n);
			ws();
			if (src.startsWith('OR ', i) || src.startsWith('OR\t', i)) i += 3;
			else break;
		}
		return items.length === 0 ? null : items.length === 1 ? items[0] : { t: 'or', items };
	}

	function parseAnd(): Node | null {
		const items: Node[] = [];
		for (;;) {
			ws();
			if (i >= src.length || src[i] === ')' || src.startsWith('OR ', i)) break;
			const n = parseUnary();
			if (!n) break;
			items.push(n);
		}
		return items.length === 0 ? null : items.length === 1 ? items[0] : { t: 'and', items };
	}

	function parseUnary(): Node | null {
		ws();
		if (src[i] === '-') {
			i++;
			const item = parseUnary();
			return item ? { t: 'not', item } : null;
		}
		return parseAtom();
	}

	function parseAtom(): Node | null {
		ws();
		if (src[i] === '(') {
			i++;
			const n = parseOr();
			ws();
			if (src[i] === ')') i++;
			return n;
		}
		if (src[i] === '[') {
			const end = src.indexOf(']', i);
			const inner = src.slice(i + 1, end < 0 ? src.length : end);
			i = end < 0 ? src.length : end + 1;
			const colon = inner.indexOf(':');
			if (colon < 0) return { t: 'prop', name: inner.trim(), value: null };
			const sub = parseQuery(inner.slice(colon + 1));
			return { t: 'prop', name: inner.slice(0, colon).trim(), value: sub };
		}
		const op = /^([a-z-]+):/.exec(src.slice(i));
		if (op && OPS.has(op[1])) {
			i += op[0].length;
			const item = parseAtom() ?? { t: 'term', text: '' };
			return { t: 'op', op: op[1], item };
		}
		if (src[i] === '"') {
			const end = src.indexOf('"', i + 1);
			const text = src.slice(i + 1, end < 0 ? src.length : end);
			i = end < 0 ? src.length : end + 1;
			return { t: 'term', text };
		}
		if (src[i] === '/') {
			const m = /^\/((?:\\.|[^/\\])+)\/([a-z]*)/.exec(src.slice(i));
			if (m) {
				i += m[0].length;
				try {
					return { t: 'term', text: m[1], regex: new RegExp(m[1], m[2].includes('i') ? 'gi' : 'g') };
				} catch {
					return { t: 'term', text: m[0] };
				}
			}
		}
		const m = /^[^\s()"]+/.exec(src.slice(i));
		if (!m) return null;
		i += m[0].length;
		return { t: 'term', text: m[0] };
	}

	return parseOr();
}

export interface SearchMatch {
	/** Character range in the note's text. */
	from: number;
	to: number;
}

export interface FileResult {
	file: TFile;
	matches: SearchMatch[];
}

interface Ctx {
	file: TFile;
	text: string;
	cache: CachedMetadata | null;
	caseSensitive: boolean;
	matches: SearchMatch[];
}

/** A slice of the note the current sub-expression must match within. */
interface Scope { from: number; to: number; }

const regexCache = new WeakMap<object, RegExp[]>();

/** Compiled once per query node and case mode (search runs it against every file). */
function termRegex(n: Extract<Node, { t: 'term' }>, caseSensitive: boolean): RegExp {
	const cached = regexCache.get(n) ?? [];
	regexCache.set(n, cached);
	const k = caseSensitive ? 1 : 0;
	if (cached[k]) return cached[k];
	// /regex/ follows the match-case setting too, unless it carries its own "i" flag.
	if (n.regex) return (cached[k] = new RegExp(n.regex.source, caseSensitive && !n.regex.flags.includes('i') ? 'g' : 'gi'));
	const esc = n.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return (cached[k] = new RegExp(esc, caseSensitive ? 'g' : 'gi'));
}

/** Matches of `n` inside `scope` of the note text. Returns false when the expression doesn't hold there. */
function evalIn(n: Node, ctx: Ctx, scope: Scope, field: 'any' | 'content' | 'file' | 'path'): boolean {
	switch (n.t) {
		case 'and': return n.items.every((x) => evalIn(x, ctx, scope, field));
		case 'or': {
			let any = false;
			for (const x of n.items) if (evalIn(x, ctx, scope, field)) any = true; // keep collecting highlights
			return any;
		}
		case 'not': {
			const saved = ctx.matches.length;
			const r = evalIn(n.item, ctx, scope, field);
			ctx.matches.length = saved; // negated terms don't highlight
			return !r;
		}
		case 'term': {
			if (!n.text) return true;
			const re = termRegex(n, n.caseSensitive ?? ctx.caseSensitive);
			let hit = false;
			if (field === 'file' || field === 'any') {
				re.lastIndex = 0;
				if (re.test(ctx.file.basename)) hit = true;
				if (field === 'file') return hit;
			}
			if (field === 'path') {
				re.lastIndex = 0;
				return re.test(ctx.file.path);
			}
			re.lastIndex = 0;
			const slice = scope.from === 0 && scope.to === ctx.text.length ? ctx.text : ctx.text.slice(scope.from, scope.to);
			for (let m = re.exec(slice); m; m = re.exec(slice)) {
				if (!m[0]) { re.lastIndex++; continue; }
				ctx.matches.push({ from: scope.from + m.index, to: scope.from + m.index + m[0].length });
				hit = true;
			}
			return hit;
		}
		case 'op': return evalOp(n.op, n.item, ctx, scope);
		case 'prop': {
			const fm = ctx.cache?.frontmatter;
			if (!fm) return false;
			const key = Object.keys(fm).find((k) => k.toLowerCase() === n.name.toLowerCase());
			if (key === undefined) return false;
			if (!n.value) return true;
			const values = Array.isArray(fm[key]) ? fm[key] : [fm[key]];
			return values.some((v: unknown) => {
				const sub: Ctx = { ...ctx, text: String(v ?? ''), matches: [] };
				return evalIn(n.value!, sub, { from: 0, to: sub.text.length }, 'content');
			});
		}
	}
}

function evalOp(op: string, item: Node, ctx: Ctx, scope: Scope): boolean {
	switch (op) {
		case 'file': return evalIn(item, ctx, scope, 'file');
		case 'path': return evalIn(item, ctx, scope, 'path');
		case 'content': return evalIn(item, ctx, scope, 'content');
		case 'match-case':
		case 'ignore-case': return evalIn(item, { ...ctx, caseSensitive: op === 'match-case', matches: ctx.matches }, scope, 'content');
		case 'tag': {
			const want = (item.t === 'term' ? item.text : '').replace(/^#/, '').toLowerCase();
			const tags = ctx.cache ? getAllTags(ctx.cache) ?? [] : [];
			const hit = tags.some((t) => {
				const tag = t.replace(/^#/, '').toLowerCase();
				return tag === want || tag.startsWith(want + '/');
			});
			if (hit) for (const t of ctx.cache?.tags ?? []) if (t.tag.slice(1).toLowerCase().startsWith(want)) ctx.matches.push({ from: t.position.start.offset, to: t.position.end.offset });
			return hit;
		}
		case 'line': return someScope(() => lineScopes(ctx.text, scope), item, ctx, scope);
		case 'block': return someScope(() => (ctx.cache?.sections ?? []).map((s) => ({ from: s.position.start.offset, to: s.position.end.offset })), item, ctx, scope);
		case 'section': return someScope(() => headingSections(ctx), item, ctx, scope);
		case 'task':
		case 'task-todo':
		case 'task-done': {
			const tasks = (ctx.cache?.listItems ?? []).filter((li) => li.task !== undefined && (op === 'task' || (op === 'task-todo') === (li.task === ' ')));
			return someScope(() => tasks.map((li) => ({ from: li.position.start.offset, to: li.position.end.offset })), item, ctx, scope);
		}
	}
	return false;
}

const hasNot = (n: Node): boolean => n.t === 'not' || ((n as any).items ?? []).some(hasNot) || (!!(n as any).item && hasNot((n as any).item));

/** `item` must match within one of the scopes (lines, blocks, sections, tasks) inside `outer`. */
function someScope(scopes: () => Scope[], item: Node, ctx: Ctx, outer: Scope): boolean {
	// Without negation, a match inside a part implies a match in the whole: reject on the whole first (cheap).
	if (!hasNot(item)) {
		const saved = ctx.matches.length;
		const ok = evalIn(item, ctx, outer, 'content');
		ctx.matches.length = saved;
		if (!ok) return false;
	}
	let any = false;
	for (const s of scopes()) {
		const saved = ctx.matches.length;
		if (evalIn(item, ctx, s, 'content')) any = true;
		else ctx.matches.length = saved;
	}
	return any;
}

function lineScopes(text: string, scope: Scope): Scope[] {
	const out: Scope[] = [];
	for (let start = scope.from; start <= scope.to; ) {
		const nl = text.indexOf('\n', start);
		const end = nl < 0 || nl > scope.to ? scope.to : nl;
		out.push({ from: start, to: end });
		start = end + 1;
	}
	return out;
}

function headingSections(ctx: Ctx): Scope[] {
	const hs = ctx.cache?.headings ?? [];
	if (!hs.length) return [{ from: 0, to: ctx.text.length }];
	const out: Scope[] = [{ from: 0, to: hs[0].position.start.offset }];
	hs.forEach((h, i) => out.push({ from: h.position.start.offset, to: hs[i + 1]?.position.start.offset ?? ctx.text.length }));
	return out;
}

/** Run a query over the vault's Markdown files (and other files by name). */
export async function searchVault(app: App, query: string, opts: { caseSensitive?: boolean; signal?: { cancelled: boolean } } = {}): Promise<FileResult[]> {
	const ast = parseQuery(query);
	if (!ast) return [];
	const out: FileResult[] = [];
	const files = app.vault.getFiles();
	let slice = performance.now();
	for (let i = 0; i < files.length; i++) {
		if (opts.signal?.cancelled) return out;
		// Yield to the UI about every 12 ms of work (a fixed every-N-files yield costs ~4 ms each in timer clamping).
		if (performance.now() - slice > 12) {
			await new Promise((r) => setTimeout(r));
			slice = performance.now();
		}
		// Notes not read yet (persisted index, fresh vault): read the next batch in parallel, not one at a time.
		if (i % 256 === 0) await Promise.all(files.slice(i, i + 256).filter((f) => f.extension === 'md').map((f) => app.vault.cachedRead(f)));
		const file = files[i];
		const isMd = file.extension === 'md';
		const ctx: Ctx = {
			file,
			text: isMd ? await app.vault.cachedRead(file) : '',
			cache: isMd ? app.metadataCache.getFileCache(file) : null,
			caseSensitive: !!opts.caseSensitive,
			matches: [],
		};
		if (evalIn(ast, ctx, { from: 0, to: ctx.text.length }, 'any')) {
			ctx.matches.sort((a, b) => a.from - b.from);
			out.push({ file, matches: ctx.matches });
		}
	}
	return out;
}
