// Bases expression language, checked against the examples in reference/obsidian-help/en/Bases/Functions.md.
import moment from 'moment';
import { expect, test } from 'vitest';
import { evalFilter, evaluate, isDate, summarize, toText, type EvalContext, type FileLike } from '../src/bases/expr';

function file(path: string, extra: Partial<FileLike> = {}): FileLike {
	const name = path.slice(path.lastIndexOf('/') + 1);
	const f: FileLike = {
		name, basename: name.replace(/\.[^.]+$/, ''), path, folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
		ext: name.slice(name.lastIndexOf('.') + 1), size: 100, ctime: Date.parse('2026-01-01T00:00:00Z'), mtime: Date.parse('2026-10-01T00:00:00Z'),
		properties: {}, tags: [], links: [], embeds: [], backlinks: () => [], resolve: (p) => (p.replace(/\.md$/, '') === 'Other' ? other : null),
		...extra,
	};
	return f;
}
const other = file('Other.md');
// As in the app, file.properties is the note's frontmatter.
const ctx = (note: Record<string, unknown> = {}, f = file('Notes/Book.md', { tags: ['#book/fiction', '#to-read'], links: ['Other'], properties: note })): EvalContext => ({
	file: f, note, self: f, formula: (n) => (n === 'double' ? (evaluate('price * 2', ctx(note, f)) as number) : null),
});
const e = (src: string, note?: Record<string, unknown>) => evaluate(src, ctx(note));

test('documented function examples', () => {
	expect(e('if(1 > 0, "yes", "no")')).toBe('yes');
	expect(e('if(false, "x")')).toBe(null);
	expect(e('"hello".contains("ell")')).toBe(true);
	expect(e('"hello".containsAll("h", "e")')).toBe(true);
	expect(e('"hello".containsAny("x", "y", "e")')).toBe(true);
	expect(e('"a:b:c:d".replace(/:/, "-")')).toBe('a-b:c:d');
	expect(e('"a:b:c:d".replace(/:/g, "-")')).toBe('a-b-c-d');
	expect(e('"John Smith".replace(/(\\w+) (\\w+)/, "$2, $1")')).toBe('Smith, John');
	expect(e('"123".repeat(2)')).toBe('123123');
	expect(e('"hello".slice(1, 4)')).toBe('ell');
	expect(e('"a,b,c,d".split(",", 3)')).toEqual(['a', 'b', 'c']);
	expect(e('"hello world".title()')).toBe('Hello World');
	expect(e('(-5).abs()')).toBe(5);
	expect(e('(2.5).round()')).toBe(3);
	expect(e('(2.3333).round(2)')).toBe(2.33);
	expect(e('(3.14159).toFixed(2)')).toBe('3.14');
	expect(e('[1,2,3,4].filter(value > 2)')).toEqual([3, 4]);
	expect(e('[1,2,3,4].map(value + 1)')).toEqual([2, 3, 4, 5]);
	expect(e('[1,2,3].reduce(acc + value, 0)')).toBe(6);
	expect(e('[3, 9, "x", 4].filter(value.isType("number")).reduce(if(acc == null || value > acc, value, acc), null)')).toBe(9);
	expect(e('[1,[2,3]].flat()')).toEqual([1, 2, 3]);
	expect(e('[1,2,3].join(",")')).toBe('1,2,3');
	expect(e('[3, 1, 2].sort()')).toEqual([1, 2, 3]);
	expect(e('["c", "a", "b"].sort()')).toEqual(['a', 'b', 'c']);
	expect(e('[1,2,2,3].unique()')).toEqual([1, 2, 3]);
	expect(e('[1,2,3,4].slice(1,3)')).toEqual([2, 3]);
	expect(e('/abc/.matches("abcde")')).toBe(true);
	expect(e('"example".isType("string") && true.isType("boolean")')).toBe(true);
	expect(e('123.toString()')).toBe('123');
	expect(e('number("3.4")')).toBe(3.4);
	expect(e('list("value")')).toEqual(['value']);
	expect(e('max(1, 7, 3) + min(4, 2)')).toBe(9);
	expect(e('{}.isEmpty() && "".isEmpty() && !"x".isEmpty()')).toBe(true);
});

test('dates and durations', () => {
	const d = e('date("2024-12-01") + "1M" + "4h" + "3m"');
	expect(isDate(d) && d.format('YYYY-MM-DD HH:mm:ss')).toBe('2025-01-01 04:03:00');
	expect(e('date("2025-05-27").format("YYYY-MM-DD")')).toBe('2025-05-27');
	expect(e('date("2025-05-27 13:45:10").time()')).toBe('13:45:10');
	expect(e('date("2025-05-27").year * 100 + date("2025-05-27").month')).toBe(202505);
	expect(isDate(e('now() + (duration("1d") * 2)'))).toBe(true);
	expect(e('date("2026-01-02") - date("2026-01-01")')).toBe(864e5);
	expect(e('file.mtime > date("2026-09-01")')).toBe(true);
	// ISO-shaped frontmatter strings compare as dates.
	expect(e('due < date("2026-12-01")', { due: '2026-11-30' })).toBe(true);
	expect(e('today() > now() - "2 days"')).toBe(true);
});

test('file, note, formula, this', () => {
	expect(e('file.name')).toBe('Book.md');
	expect(e('file.basename + "|" + file.folder + "|" + file.ext')).toBe('Book|Notes|md');
	expect(e('file.hasTag("book")')).toBe(true); // nested #book/fiction counts
	expect(e('file.hasTag("tag1", "to-read")')).toBe(true);
	expect(e('file.inFolder("Notes")')).toBe(true);
	expect(e('file.hasLink("Other")')).toBe(true);
	expect(e('file.hasLink(file("Other"))')).toBe(true);
	expect(e('file.hasProperty("PRICE")', { price: 3 })).toBe(true);
	expect(e('price * 2', { price: 3 })).toBe(6);
	expect(e('note.price + note["price"]', { price: 3 })).toBe(6);
	expect(e('formula.double', { price: 4 })).toBe(8);
	// `this` is a note context: this.file.* and this.<property>
	expect(e('this.file.name == file.name')).toBe(true);
	expect(e('this.file.folder')).toBe('Notes');
	expect(e('this.price', { price: 5 })).toBe(5);
	expect(e('if(price, price.toFixed(2) + " dollars")', { price: 2 })).toBe('2.00 dollars');
	expect(e('if(price, price.toFixed(2) + " dollars")', {})).toBe(null);
	expect(toText(e('author', { author: '[[Jane Doe]]' }))).toBe('Jane Doe');
	expect(e('missing == null')).toBe(true);
	expect(e('status != "done"', { status: 'open' })).toBe(true);
});

test('filters and summaries', () => {
	const c = ctx({ status: 'open', price: 3 });
	expect(evalFilter({ and: ['status != "done"', { or: ['price > 5', 'price > 2.1'] }] }, c)).toBe(true);
	expect(evalFilter({ not: ['file.hasTag("book")', 'file.inFolder("Required Reading")'] }, c)).toBe(false);
	expect(evalFilter('file.ext == "md"', c)).toBe(true);
	expect(summarize('Average', [1, 2, 3, null])).toBe(2);
	expect(summarize('Median', [5, 1, 3, 2])).toBe(2.5);
	expect(summarize('Sum', [1, '2', 3])).toBe(6);
	expect(summarize('Filled', [1, null, '', [], 'x'])).toBe(2);
	expect(summarize('Unique', ['a', 'b', 'a'])).toBe(2);
	expect(summarize('Checked', [true, false, true])).toBe(2);
	const latest = summarize('Latest', [moment('2026-01-01'), moment('2026-03-01')]);
	expect(isDate(latest) && latest.format('MM')).toBe('03');
	expect(summarize('custom', [1, 2, 3, 4], 'values.mean().round(3)')).toBe(2.5);
});

test('syntax errors are reported, not thrown as something else', () => {
	expect(() => e('price >')).toThrow(SyntaxError);
	expect(() => e('"unterminated')).toThrow(SyntaxError);
	expect(() => e('nope()')).toThrow(/Unknown function/);
});
