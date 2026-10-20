// Indexer contract: what MetadataCache stores for a note. Any future (wasm) indexer must pass this too.
import { expect, test } from 'vitest';
import { getAllTags, parseLinktext, parseMetadata } from '../src/parse';

const NOTE = [
	'---',                                  // 0
	'tags: [project, web]',                 // 1
	'related: "[[Other note|other]]"',      // 2
	'date: 2026-10-19',                     // 3
	'---',                                  // 4
	'# Title #inline',                      // 5
	'',                                     // 6
	'See [[Target#Heading|alias]] and ![[image.png]].', // 7
	'A [md link](Some%20Note.md) and [ext](https://x.y). ^para1', // 8
	'',                                     // 9
	'- item one #todo',                     // 10
	'  - [ ] child task',                   // 11
	'- [x] done ^done1',                    // 12
	'',                                     // 13
	'```js',                                // 14
	'[[not a link]] #nottag',               // 15
	'```',                                  // 16
	'`[[code]]` #123 %%[[hidden]]%%',       // 17
	'## Second',                            // 18
	'> [!note] Callout [[InCallout]]',      // 19
	'',                                     // 20
	'| a | b |',                            // 21
	'|---|---|',                            // 22
	'| 1 | 2 |',                            // 23
	'',                                     // 24
	'^table1',                              // 25
].join('\r\n');

test('parseMetadata matches the CachedMetadata contract', () => {
	const c = parseMetadata(NOTE);

	// Frontmatter: core schema keeps dates as strings, like Obsidian's properties.
	expect(c.frontmatter).toEqual({ tags: ['project', 'web'], related: '[[Other note|other]]', date: '2026-10-19' });
	expect(c.frontmatterPosition?.start.line).toBe(0);
	expect(c.frontmatterPosition?.end.line).toBe(4);
	expect(c.frontmatterLinks).toEqual([{ key: 'related', link: 'Other note', original: '[[Other note|other]]', displayText: 'other' }]);

	expect(c.headings?.map((h) => [h.heading, h.level, h.position.start.line])).toEqual([
		['Title #inline', 1, 5],
		['Second', 2, 18],
	]);

	// Links: wikilink with subpath+alias, decoded markdown link; external URL, code, %% comments excluded.
	expect(c.links?.map((l) => [l.link, l.displayText, l.position.start.line])).toEqual([
		['Target#Heading', 'alias', 7],
		['Some Note.md', 'md link', 8],
		['InCallout', 'InCallout', 19],
	]);
	expect(c.embeds?.map((e) => e.link)).toEqual(['image.png']);

	// Offsets account for CRLF line endings.
	const first = c.links![0];
	expect(NOTE.slice(first.position.start.offset, first.position.end.offset)).toBe('[[Target#Heading|alias]]');

	expect(c.tags?.map((t) => t.tag)).toEqual(['#inline', '#todo']);
	expect(getAllTags(c)).toEqual(['#project', '#web', '#inline', '#todo']);

	// List items: parent = parent's line, or -(first line of list) for roots.
	expect(c.listItems?.map((li) => [li.position.start.line, li.parent, li.task, li.id])).toEqual([
		[10, -10, undefined, undefined],
		[11, 10, ' ', undefined],
		[12, -10, 'x', 'done1'],
	]);

	expect(c.sections?.map((s) => s.type)).toEqual([
		'yaml', 'heading', 'paragraph', 'list', 'code', 'paragraph', 'heading', 'callout', 'table',
	]);
	expect(Object.keys(c.blocks ?? {})).toEqual(['para1', 'done1', 'table1']);
	expect(c.blocks!.table1.position.start.line).toBe(21); // standalone ^id names the preceding table
});

test('empty note has no cache keys; invalid YAML yields no frontmatter', () => {
	expect(parseMetadata('')).toEqual({});
	const c = parseMetadata('---\nkey: [unclosed\n---\ntext');
	expect(c.frontmatter).toBeUndefined();
	expect(c.frontmatterPosition?.end.line).toBe(2);
});

test('headings and quotes interrupt a list (no lazy continuation)', () => {
	const c = parseMetadata('- item\n## Heading\n- other\n> quote');
	expect(c.headings?.map((h) => h.heading)).toEqual(['Heading']);
	expect(c.sections?.map((s) => s.type)).toEqual(['list', 'heading', 'list', 'blockquote']);
});

test('parseLinktext', () => {
	expect(parseLinktext('foo#bar')).toEqual({ path: 'foo', subpath: '#bar' });
	expect(parseLinktext('foo')).toEqual({ path: 'foo', subpath: '' });
});
