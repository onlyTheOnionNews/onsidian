// Bases formula/filter language (reference/obsidian-help/en/Bases/Functions.md). Tokenizer → Pratt parser → evaluator.
// Never uses eval/Function (PLAN §5.5: safety + CSP). DOM-free so it's unit-testable.
import moment from 'moment';

// ---------------- Values ----------------

export class Duration {
	constructor(readonly d: moment.Duration) {}
}
export class LinkVal {
	constructor(readonly path: string, readonly display?: string) {}
	toString(): string { return this.display ?? this.path; }
}
export class HtmlVal { constructor(readonly html: string) {} }
export class ImageVal { constructor(readonly src: string) {} }
export class IconVal { constructor(readonly name: string) {} }

/** What a Bases expression sees as a file (file.* fields and methods). */
export interface FileLike {
	name: string;
	basename: string;
	path: string;
	folder: string;
	ext: string;
	size: number;
	ctime: number;
	mtime: number;
	properties: Record<string, unknown>;
	tags: string[];
	links: string[];
	embeds: string[];
	backlinks: () => FileLike[];
	/** Resolve a link/path to a file (link targets, file() function). */
	resolve: (path: string) => FileLike | null;
}

export type Val = null | number | string | boolean | moment.Moment | Duration | Val[] | { [k: string]: Val } | LinkVal | FileLike | RegExp | HtmlVal | ImageVal | IconVal;

export const isDate = (v: unknown): v is moment.Moment => moment.isMoment(v);
export const isFile = (v: unknown): v is FileLike => !!v && typeof v === 'object' && 'basename' in v && 'resolve' in v;

export function truthy(v: Val): boolean {
	if (v === null || v === false || v === 0 || v === '' || (typeof v === 'number' && Number.isNaN(v))) return false;
	if (Array.isArray(v)) return v.length > 0;
	return true;
}

export function typeName(v: Val): string {
	if (v === null) return 'null';
	if (Array.isArray(v)) return 'list';
	if (isDate(v)) return 'date';
	if (v instanceof Duration) return 'duration';
	if (v instanceof LinkVal) return 'link';
	if (v instanceof RegExp) return 'regexp';
	if (isFile(v)) return 'file';
	if (v instanceof HtmlVal) return 'html';
	if (v instanceof ImageVal) return 'image';
	if (v instanceof IconVal) return 'icon';
	if (typeof v === 'object') return 'object';
	return typeof v;
}

export function toText(v: Val): string {
	if (v === null) return '';
	if (Array.isArray(v)) return v.map(toText).join(', ');
	if (isDate(v)) return v.hours() || v.minutes() || v.seconds() ? v.format('YYYY-MM-DD HH:mm') : v.format('YYYY-MM-DD');
	if (v instanceof Duration) return v.d.humanize();
	if (isFile(v)) return v.basename;
	if (v instanceof LinkVal) return v.toString();
	if (v instanceof HtmlVal) return v.html;
	if (v instanceof ImageVal) return v.src;
	if (v instanceof IconVal) return v.name;
	if (v instanceof RegExp) return v.toString();
	if (typeof v === 'object') return JSON.stringify(v);
	// Hide binary floating-point noise (0.1 + 0.2 → "0.3", not "0.30000000000000004").
	if (typeof v === 'number' && !Number.isInteger(v)) return String(Number(v.toPrecision(12)));
	return String(v);
}

function equals(a: Val, b: Val): boolean {
	if (isDate(a) && isDate(b)) return a.valueOf() === b.valueOf();
	if (isFile(a) || isFile(b) || a instanceof LinkVal || b instanceof LinkVal) return pathOf(a) !== null && pathOf(a) === pathOf(b);
	if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equals(x, b[i]));
	return a === b;
}

function pathOf(v: Val): string | null {
	if (isFile(v)) return v.path.replace(/\.md$/, '').toLowerCase();
	if (v instanceof LinkVal) return v.path.replace(/\.md$/, '').toLowerCase();
	if (typeof v === 'string') return v.replace(/^\[\[|\]\]$/g, '').split('|')[0].replace(/\.md$/, '').toLowerCase();
	return null;
}

const UNITS: Record<string, moment.unitOfTime.DurationConstructor> = {
	y: 'years', year: 'years', years: 'years', M: 'months', month: 'months', months: 'months', w: 'weeks', week: 'weeks', weeks: 'weeks',
	d: 'days', day: 'days', days: 'days', h: 'hours', hour: 'hours', hours: 'hours', m: 'minutes', minute: 'minutes', minutes: 'minutes',
	s: 'seconds', second: 'seconds', seconds: 'seconds',
};

export function parseDuration(s: string): Duration | null {
	const d = moment.duration(0);
	let any = false;
	for (const m of s.matchAll(/(-?\d+(?:\.\d+)?)\s*([A-Za-z]+)/g)) {
		const unit = UNITS[m[2]] ?? UNITS[m[2].toLowerCase()];
		if (!unit) return null;
		d.add(Number(m[1]), unit);
		any = true;
	}
	return any ? new Duration(d) : null;
}

export function parseDate(s: string): moment.Moment | null {
	const m = moment(s, [moment.ISO_8601, 'YYYY-MM-DD HH:mm:ss', 'YYYY-MM-DD HH:mm', 'YYYY-MM-DD'], true);
	return m.isValid() ? m : null;
}

// ---------------- Parser ----------------

type Node =
	| { k: 'lit'; v: Val }
	| { k: 'id'; name: string }
	| { k: 'list'; items: Node[] }
	| { k: 'obj'; entries: [string, Node][] }
	| { k: 'un'; op: string; a: Node }
	| { k: 'bin'; op: string; a: Node; b: Node }
	| { k: 'get'; obj: Node; name: string }
	| { k: 'idx'; obj: Node; index: Node }
	| { k: 'call'; fn: Node; args: Node[] };

type Tok = { t: 'num' | 'str' | 'id' | 'op' | 'regex' | 'eof'; v: string; flags?: string };

function tokenize(src: string): Tok[] {
	const out: Tok[] = [];
	let i = 0;
	const prevIsValue = () => {
		const p = out[out.length - 1];
		return p && (p.t === 'num' || p.t === 'str' || p.t === 'id' || p.t === 'regex' || (p.t === 'op' && (p.v === ')' || p.v === ']')));
	};
	while (i < src.length) {
		const c = src[i];
		if (/\s/.test(c)) { i++; continue; }
		if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
			const m = /^\d*\.?\d+(?:[eE][-+]?\d+)?/.exec(src.slice(i))!;
			out.push({ t: 'num', v: m[0] });
			i += m[0].length;
			continue;
		}
		if (c === '"' || c === "'") {
			let j = i + 1;
			let s = '';
			while (j < src.length && src[j] !== c) {
				if (src[j] === '\\' && j + 1 < src.length) { s += { n: '\n', t: '\t' }[src[j + 1]] ?? src[j + 1]; j += 2; }
				else s += src[j++];
			}
			if (j >= src.length) throw new SyntaxError(`Unterminated string starting at ${i}`);
			out.push({ t: 'str', v: s });
			i = j + 1;
			continue;
		}
		if (c === '/' && !prevIsValue()) {
			const m = /^\/((?:\\.|[^/\\\n])+)\/([gimsuy]*)/.exec(src.slice(i));
			if (m) {
				out.push({ t: 'regex', v: m[1], flags: m[2] });
				i += m[0].length;
				continue;
			}
		}
		const id = /^[A-Za-z_À-￿][\wÀ-￿]*/.exec(src.slice(i));
		if (id) {
			out.push({ t: 'id', v: id[0] });
			i += id[0].length;
			continue;
		}
		const op = /^(==|!=|>=|<=|&&|\|\||[-+*/%<>!().,[\]{}:])/.exec(src.slice(i));
		if (!op) throw new SyntaxError(`Unexpected "${c}" at ${i}`);
		out.push({ t: 'op', v: op[0] });
		i += op[0].length;
	}
	out.push({ t: 'eof', v: '' });
	return out;
}

const BINARY: Record<string, number> = { '||': 1, or: 1, '&&': 2, and: 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };

export function parseExpr(src: string): Node {
	const toks = tokenize(src);
	let p = 0;
	const peek = () => toks[p];
	const next = () => toks[p++];
	const expect = (v: string) => {
		const t = next();
		if (t.v !== v || t.t === 'str') throw new SyntaxError(`Expected "${v}" but found "${t.v || 'end'}"`);
	};
	const atOp = (v: string) => peek().t === 'op' && peek().v === v;
	/** Comma-separated items up to (and consuming) `end`. */
	const commaList = <T>(end: string, item: () => T): T[] => {
		const items: T[] = [];
		if (!atOp(end)) {
			items.push(item());
			while (atOp(',')) {
				next();
				items.push(item());
			}
		}
		expect(end);
		return items;
	};

	function expr(minPrec = 0): Node {
		let left = unary();
		for (;;) {
			const t = peek();
			const op = t.t === 'op' || (t.t === 'id' && (t.v === 'and' || t.v === 'or')) ? t.v : '';
			const prec = BINARY[op];
			if (!prec || prec <= minPrec) return left;
			next();
			const norm = op === 'and' ? '&&' : op === 'or' ? '||' : op;
			left = { k: 'bin', op: norm, a: left, b: expr(prec) };
		}
	}

	function unary(): Node {
		const t = peek();
		if (t.t === 'op' && (t.v === '!' || t.v === '-')) {
			next();
			return { k: 'un', op: t.v, a: unary() };
		}
		if (t.t === 'id' && t.v === 'not') {
			next();
			return { k: 'un', op: '!', a: unary() };
		}
		return postfix(primary());
	}

	function postfix(n: Node): Node {
		for (;;) {
			const t = peek();
			if (t.t === 'op' && t.v === '.') {
				next();
				const name = next();
				if (name.t !== 'id') throw new SyntaxError(`Expected a name after "."`);
				n = { k: 'get', obj: n, name: name.v };
			} else if (t.t === 'op' && t.v === '(') {
				next();
				n = { k: 'call', fn: n, args: commaList(')', () => expr()) };
			} else if (t.t === 'op' && t.v === '[') {
				next();
				const index = expr();
				expect(']');
				n = { k: 'idx', obj: n, index };
			} else return n;
		}
	}

	function primary(): Node {
		const t = next();
		switch (t.t) {
			case 'num': return { k: 'lit', v: Number(t.v) };
			case 'str': return { k: 'lit', v: t.v };
			case 'regex': return { k: 'lit', v: new RegExp(t.v, t.flags) };
			case 'id':
				if (t.v === 'true' || t.v === 'false') return { k: 'lit', v: t.v === 'true' };
				if (t.v === 'null') return { k: 'lit', v: null };
				return { k: 'id', name: t.v };
			case 'op':
				if (t.v === '(') {
					const e = expr();
					expect(')');
					return e;
				}
				if (t.v === '[') return { k: 'list', items: commaList(']', () => expr()) };
				if (t.v === '{') {
					const entries = commaList('}', (): [string, Node] => {
						const key = next();
						if (key.t !== 'id' && key.t !== 'str') throw new SyntaxError('Expected an object key');
						expect(':');
						return [key.v, expr()];
					});
					return { k: 'obj', entries };
				}
		}
		throw new SyntaxError(`Unexpected "${t.v || 'end of expression'}"`);
	}

	const n = expr();
	if (peek().t !== 'eof') throw new SyntaxError(`Unexpected "${peek().v}"`);
	return n;
}

// ---------------- Evaluator ----------------

export interface EvalContext {
	file: FileLike | null;
	/** Frontmatter of the row's note. */
	note: Record<string, unknown>;
	/** Evaluate formula `name` for this row (with cycle detection in the caller). */
	formula: (name: string) => Val;
	/** `this`: the base file, the embedding note, or the active note. */
	self: FileLike | null;
	/** Property types (types.json) to read note values as dates etc. */
	propType?: (name: string) => string | undefined;
	locals?: Record<string, Val>;
}

const cache = new Map<string, Node>();
export function compile(src: string): Node {
	let n = cache.get(src);
	if (!n) {
		n = parseExpr(src);
		if (cache.size > 2000) cache.clear();
		cache.set(src, n);
	}
	return n;
}

export function evaluate(src: string | Node, ctx: EvalContext): Val {
	return ev(typeof src === 'string' ? compile(src) : src, ctx);
}

/** Frontmatter value → expression value: dates (by type or ISO shape), links, nested lists/objects. */
export function fromProperty(v: unknown, type?: string): Val {
	if (v === undefined || v === null) return null;
	if (Array.isArray(v)) return v.map((x) => fromProperty(x));
	if (typeof v === 'string') {
		const link = /^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$/.exec(v.trim());
		if (link) return new LinkVal(link[1], link[2]);
		if (type === 'date' || type === 'datetime' || /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/.test(v)) return parseDate(v) ?? v;
		return v;
	}
	if (typeof v === 'number' || typeof v === 'boolean') return v;
	if (typeof v === 'object') return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, fromProperty(x)]));
	return String(v);
}

function noteProp(ctx: EvalContext, name: string): Val {
	if (name in ctx.note) return fromProperty(ctx.note[name], ctx.propType?.(name));
	const key = Object.keys(ctx.note).find((k) => k.toLowerCase() === name.toLowerCase());
	return key === undefined ? null : fromProperty(ctx.note[key], ctx.propType?.(key));
}

function ev(n: Node, ctx: EvalContext): Val {
	switch (n.k) {
		case 'lit': return n.v;
		case 'list': return n.items.map((x) => ev(x, ctx));
		case 'obj': return Object.fromEntries(n.entries.map(([k, x]) => [k, ev(x, ctx)]));
		case 'id': return resolveId(n.name, ctx);
		case 'un': {
			const a = ev(n.a, ctx);
			if (n.op === '!') return !truthy(a);
			if (a instanceof Duration) return new Duration(moment.duration(-a.d.asMilliseconds()));
			return -(num(a));
		}
		case 'bin': return binary(n.op, n.a, n.b, ctx);
		case 'get': return getField(n.obj, n.name, ctx);
		case 'idx': {
			const o = ev(n.obj, ctx);
			const k = ev(n.index, ctx);
			if (n.obj.k === 'id' && n.obj.name === 'note' && typeof k === 'string') return noteProp(ctx, k);
			if (n.obj.k === 'id' && n.obj.name === 'formula' && typeof k === 'string') return ctx.formula(k);
			if (Array.isArray(o) && typeof k === 'number') return o[k < 0 ? o.length + k : k] ?? null;
			if (typeof o === 'string' && typeof k === 'number') return o[k] ?? null;
			if (o && typeof o === 'object' && !Array.isArray(o) && typeof k === 'string') return ((o as Record<string, Val>)[k] ?? null);
			return null;
		}
		case 'call': return call(n, ctx);
	}
}

function resolveId(name: string, ctx: EvalContext): Val {
	if (ctx.locals && name in ctx.locals) return ctx.locals[name];
	if (name === 'file') return ctx.file;
	// `this` is a note context like a row: this.file.<field> and this.<property> (docs: Bases syntax › this).
	if (name === 'this') return ctx.self ? ({ ...(fromProperty(ctx.self.properties) as Record<string, Val>), file: ctx.self } as Val) : null;
	if (name === 'note') return ctx.note as Val;
	return noteProp(ctx, name);
}

function getField(objNode: Node, name: string, ctx: EvalContext): Val {
	if (objNode.k === 'id' && !(ctx.locals && objNode.name in ctx.locals)) {
		if (objNode.name === 'note') return noteProp(ctx, name);
		if (objNode.name === 'formula') return ctx.formula(name);
	}
	const o = ev(objNode, ctx);
	if (o === null) return null;
	if (isFile(o)) {
		switch (name) {
			case 'name': return o.name;
			case 'basename': return o.basename;
			case 'path': return o.path;
			case 'folder': return o.folder;
			case 'ext': return o.ext;
			case 'size': return o.size;
			case 'ctime': return moment(o.ctime);
			case 'mtime': return moment(o.mtime);
			case 'properties': return fromProperty(o.properties);
			case 'tags': return o.tags;
			case 'links': return o.links.map((l) => new LinkVal(l));
			case 'embeds': return o.embeds.map((l) => new LinkVal(l));
			case 'backlinks': return o.backlinks();
			case 'file': return o;
		}
	}
	if (isDate(o)) {
		const f: Record<string, () => number> = { year: () => o.year(), month: () => o.month() + 1, day: () => o.date(), hour: () => o.hour(), minute: () => o.minute(), second: () => o.second(), millisecond: () => o.millisecond() };
		if (f[name]) return f[name]();
	}
	if (name === 'length' && (typeof o === 'string' || Array.isArray(o))) return o.length;
	if (o && typeof o === 'object' && !Array.isArray(o) && !(o instanceof RegExp)) return ((o as Record<string, Val>)[name] ?? null);
	return null;
}

function num(v: Val): number {
	if (typeof v === 'number') return v;
	if (typeof v === 'boolean') return v ? 1 : 0;
	if (isDate(v)) return v.valueOf();
	if (v instanceof Duration) return v.d.asMilliseconds();
	if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
	return NaN;
}

function asDuration(v: Val): Duration | null {
	if (v instanceof Duration) return v;
	if (typeof v === 'string') return parseDuration(v);
	return null;
}

function binary(op: string, an: Node, bn: Node, ctx: EvalContext): Val {
	if (op === '&&') {
		const a = ev(an, ctx);
		return truthy(a) ? truthy(ev(bn, ctx)) : false;
	}
	if (op === '||') {
		const a = ev(an, ctx);
		return truthy(a) ? true : truthy(ev(bn, ctx));
	}
	const a = ev(an, ctx);
	const b = ev(bn, ctx);
	switch (op) {
		case '==': return equals(a, b);
		case '!=': return !equals(a, b);
		case '+': {
			if (isDate(a)) {
				const d = asDuration(b);
				if (d) return a.clone().add(d.d);
			}
			if (a instanceof Duration && b instanceof Duration) return new Duration(a.d.clone().add(b.d));
			if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
			if (typeof a === 'string' || typeof b === 'string') return toText(a) + toText(b);
			return num(a) + num(b);
		}
		case '-': {
			if (isDate(a) && isDate(b)) return a.valueOf() - b.valueOf();
			if (isDate(a)) {
				const d = asDuration(b);
				if (d) return a.clone().subtract(d.d);
			}
			if (a instanceof Duration && b instanceof Duration) return new Duration(a.d.clone().subtract(b.d));
			return num(a) - num(b);
		}
		case '*':
			if (a instanceof Duration) return new Duration(moment.duration(a.d.asMilliseconds() * num(b)));
			return num(a) * num(b);
		case '/':
			if (a instanceof Duration) return new Duration(moment.duration(a.d.asMilliseconds() / num(b)));
			return num(a) / num(b);
		case '%': return num(a) % num(b);
		case '<': case '>': case '<=': case '>=': {
			if (a === null || b === null) return false;
			const [x, y] = isDate(a) || isDate(b)
				? [num(isDate(a) ? a : (parseDate(String(a)) as Val)), num(isDate(b) ? b : (parseDate(String(b)) as Val))]
				: typeof a === 'string' && typeof b === 'string' ? [a, b] : [num(a), num(b)];
			if (typeof x === 'number' && typeof y === 'number' && (Number.isNaN(x) || Number.isNaN(y))) return false;
			return op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y;
		}
	}
	throw new Error(`Unknown operator ${op}`);
}

function call(n: Extract<Node, { k: 'call' }>, ctx: EvalContext): Val {
	// Method call: receiver.method(args)
	if (n.fn.k === 'get') return method(n.fn.obj, n.fn.name, n.args, ctx);
	if (n.fn.k !== 'id') throw new Error('Not a function');
	const args = () => n.args.map((a) => ev(a, ctx));
	switch (n.fn.name) {
		case 'if': {
			const c = ev(n.args[0], ctx);
			return truthy(c) ? (n.args[1] ? ev(n.args[1], ctx) : null) : n.args[2] ? ev(n.args[2], ctx) : null;
		}
		case 'now': return moment();
		case 'today': return moment().startOf('day');
		case 'date': {
			const [v] = args();
			return isDate(v) ? v.clone() : parseDate(toText(v));
		}
		case 'duration': return parseDuration(toText(args()[0]));
		case 'number': {
			const v = num(args()[0]);
			if (Number.isNaN(v)) throw new Error(`Can't convert to a number`);
			return v;
		}
		case 'list': {
			const [v] = args();
			return Array.isArray(v) ? v : v === null ? [] : [v];
		}
		case 'max': return Math.max(...args().map(num));
		case 'min': return Math.min(...args().map(num));
		case 'random': return Math.random();
		case 'link': {
			const [p, display] = args();
			return new LinkVal(isFile(p) ? p.path : toText(p).replace(/^\[\[|\]\]$/g, ''), display === undefined || display === null ? undefined : toText(display));
		}
		case 'file': {
			const [p] = args();
			if (isFile(p)) return p;
			return ctx.file?.resolve(p instanceof LinkVal ? p.path : toText(p)) ?? ctx.self?.resolve(toText(p)) ?? null;
		}
		case 'escapeHTML': return toText(args()[0]).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
		case 'html': return new HtmlVal(toText(args()[0]));
		case 'image': {
			const [p] = args();
			return new ImageVal(isFile(p) ? p.path : p instanceof LinkVal ? p.path : toText(p));
		}
		case 'icon': return new IconVal(toText(args()[0]));
	}
	throw new Error(`Unknown function ${n.fn.name}()`);
}

/** Methods; filter/map/reduce evaluate their argument per element with `value`, `index`, `acc` bound. */
function method(objNode: Node, name: string, argNodes: Node[], ctx: EvalContext): Val {
	const o = ev(objNode, ctx);
	const args = () => argNodes.map((a) => ev(a, ctx));
	const withLocals = (locals: Record<string, Val>): EvalContext => ({ ...ctx, locals: { ...ctx.locals, ...locals } });

	// Any type
	switch (name) {
		case 'isTruthy': return truthy(o);
		case 'isType': return typeName(o) === toText(args()[0]).toLowerCase();
		case 'toString': return toText(o);
		case 'isEmpty':
			if (o === null) return true;
			if (typeof o === 'string' || Array.isArray(o)) return o.length === 0;
			if (typeof o === 'object' && !isDate(o) && !isFile(o) && !(o instanceof LinkVal) && !(o instanceof RegExp)) return Object.keys(o).length === 0;
			return false;
	}
	if (o === null) return null;

	if (Array.isArray(o)) {
		switch (name) {
			case 'contains': { const [v] = args(); return o.some((x) => equals(x, v)); }
			case 'containsAll': { const vs = args(); return vs.every((v) => o.some((x) => equals(x, v))); }
			case 'containsAny': { const vs = args(); return vs.some((v) => o.some((x) => equals(x, v))); }
			case 'filter': return o.filter((value, index) => truthy(ev(argNodes[0], withLocals({ value, index }))));
			case 'map': return o.map((value, index) => ev(argNodes[0], withLocals({ value, index })));
			case 'reduce': {
				let acc: Val = argNodes[1] ? ev(argNodes[1], ctx) : null;
				o.forEach((value, index) => { acc = ev(argNodes[0], withLocals({ value, index, acc })); });
				return acc;
			}
			case 'flat': return (o as unknown[]).flat(Infinity) as Val[];
			case 'join': return o.map(toText).join(argNodes.length ? toText(args()[0]) : ', ');
			case 'reverse': return [...o].reverse();
			case 'slice': { const [s, e] = args(); return o.slice(num(s), e === undefined || e === null ? undefined : num(e)); }
			case 'sort': return [...o].sort(compareVals);
			case 'unique': return o.filter((x, i) => o.findIndex((y) => equals(x, y)) === i);
			// summary helpers (values.mean() etc.)
			case 'mean': { const ns = o.map(num).filter((x) => !Number.isNaN(x)); return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null; }
			case 'sum': return o.map(num).filter((x) => !Number.isNaN(x)).reduce((a, b) => a + b, 0);
		}
	}
	if (typeof o === 'string') {
		const s = o;
		switch (name) {
			case 'contains': return s.includes(toText(args()[0]));
			case 'containsAll': return args().every((v) => s.includes(toText(v)));
			case 'containsAny': return args().some((v) => s.includes(toText(v)));
			case 'startsWith': return s.startsWith(toText(args()[0]));
			case 'endsWith': return s.endsWith(toText(args()[0]));
			case 'lower': return s.toLowerCase();
			case 'upper': return s.toUpperCase();
			case 'title': return s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
			case 'trim': return s.trim();
			case 'reverse': return [...s].reverse().join('');
			case 'repeat': return s.repeat(Math.max(0, num(args()[0])));
			case 'slice': { const [a, b] = args(); return s.slice(num(a), b === undefined || b === null ? undefined : num(b)); }
			case 'split': {
				const [sep, n] = args();
				const parts = s.split(sep instanceof RegExp ? sep : toText(sep));
				return n === undefined || n === null ? parts : parts.slice(0, num(n));
			}
			case 'replace': {
				const [pat, rep] = args();
				return pat instanceof RegExp ? s.replace(pat, toText(rep)) : s.split(toText(pat)).join(toText(rep));
			}
		}
	}
	if (typeof o === 'number') {
		switch (name) {
			case 'abs': return Math.abs(o);
			case 'ceil': return Math.ceil(o);
			case 'floor': return Math.floor(o);
			case 'round': { const [d] = args(); const f = 10 ** (d === undefined || d === null ? 0 : num(d)); return Math.round(o * f) / f; }
			case 'toFixed': return o.toFixed(num(args()[0]));
		}
	}
	if (isDate(o)) {
		switch (name) {
			case 'date': return o.clone().startOf('day');
			case 'format': return o.format(toText(args()[0]));
			case 'time': return o.format('HH:mm:ss');
			case 'relative': return o.fromNow();
		}
	}
	if (o instanceof RegExp && name === 'matches') {
		o.lastIndex = 0;
		return o.test(toText(args()[0]));
	}
	if (o instanceof LinkVal) {
		switch (name) {
			case 'asFile': return ctx.file?.resolve(o.path) ?? ctx.self?.resolve(o.path) ?? null;
			case 'linksTo': {
				const target = ctx.file?.resolve(o.path);
				const [other] = args();
				return !!target && target.links.some((l) => pathOf(l) === pathOf(other));
			}
		}
	}
	if (isFile(o)) {
		switch (name) {
			case 'asLink': { const [d] = args(); return new LinkVal(o.path, d === undefined || d === null ? undefined : toText(d)); }
			case 'hasLink': {
				const [other] = args();
				const want = pathOf(other);
				return [...o.links, ...o.embeds].some((l) => {
					const target = o.resolve(l);
					return (target ? pathOf(target) : pathOf(l)) === want || pathOf(l) === want;
				});
			}
			case 'hasProperty': { const [p] = args(); return Object.keys(o.properties).some((k) => k.toLowerCase() === toText(p).toLowerCase()); }
			case 'hasTag': {
				const want = args().map((t) => toText(t).replace(/^#/, '').toLowerCase());
				return o.tags.some((t) => {
					const tag = t.replace(/^#/, '').toLowerCase();
					return want.some((w) => tag === w || tag.startsWith(w + '/'));
				});
			}
			case 'inFolder': {
				const f = toText(args()[0]).replace(/^\/|\/$/g, '');
				return o.folder === f || o.folder.startsWith(f + '/');
			}
		}
	}
	if (o && typeof o === 'object' && !isDate(o)) {
		switch (name) {
			case 'keys': return Object.keys(o);
			case 'values': return Object.values(o) as Val[];
		}
	}
	throw new Error(`${typeName(o)} has no method ${name}()`);
}

export function compareVals(a: Val, b: Val): number {
	if (a === null && b === null) return 0;
	if (a === null) return 1;
	if (b === null) return -1;
	if (typeof a === 'number' && typeof b === 'number') return a - b;
	if (isDate(a) && isDate(b)) return a.valueOf() - b.valueOf();
	if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
	return toText(a).localeCompare(toText(b), undefined, { numeric: true, sensitivity: 'base' });
}

// ---------------- Filters & summaries ----------------

/** A filter is a statement string or { and | or | not: Filter[] } (not = none of them). */
export type Filter = string | { and?: Filter[]; or?: Filter[]; not?: Filter[] };

export function evalFilter(f: Filter | undefined | null, ctx: EvalContext): boolean {
	if (f === undefined || f === null) return true;
	if (typeof f === 'string') return truthy(evaluate(f, ctx));
	if (f.and) return f.and.every((x) => evalFilter(x, ctx));
	if (f.or) return f.or.some((x) => evalFilter(x, ctx));
	if (f.not) return !f.not.some((x) => evalFilter(x, ctx));
	return true;
}

/** Default summaries from the docs; custom ones are formulas over `values`. */
export function summarize(name: string, values: Val[], custom?: string): Val {
	const dates = values.filter(isDate);
	const nums = values.filter((v) => !isDate(v) && v !== null).map(num).filter((x) => !Number.isNaN(x));
	const empty = (v: Val) => v === null || v === '' || (Array.isArray(v) && !v.length);
	switch (name) {
		case 'Average': return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
		case 'Min': return nums.length ? Math.min(...nums) : dates.length ? moment.min(dates) : null;
		case 'Max': return nums.length ? Math.max(...nums) : dates.length ? moment.max(dates) : null;
		case 'Sum': return nums.reduce((a, b) => a + b, 0);
		case 'Range':
			if (dates.length) return new Duration(moment.duration(moment.max(dates).diff(moment.min(dates))));
			return nums.length ? Math.max(...nums) - Math.min(...nums) : null;
		case 'Median': {
			if (!nums.length) return null;
			const s = [...nums].sort((a, b) => a - b);
			const m = Math.floor(s.length / 2);
			return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
		}
		case 'Stddev': {
			if (!nums.length) return null;
			const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
			return Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length);
		}
		case 'Earliest': return dates.length ? moment.min(dates) : null;
		case 'Latest': return dates.length ? moment.max(dates) : null;
		case 'Checked': return values.filter((v) => v === true).length;
		case 'Unchecked': return values.filter((v) => v === false).length;
		case 'Empty': return values.filter(empty).length;
		case 'Filled': return values.filter((v) => !empty(v)).length;
		case 'Unique': return values.filter((x, i) => values.findIndex((y) => equals(x, y)) === i).length;
	}
	if (custom) return evaluate(custom, { file: null, note: {}, formula: () => null, self: null, locals: { values } });
	return null;
}
