// Markdown → CachedMetadata (the MetadataCache contract in obsidian.d.ts). Pure: runs in the indexer worker or in-process.
// Correctness is pinned by test/parse.test.ts; any future wasm indexer must pass the same fixtures (PLAN §5.3).
// ponytail: line-based scanner, not a full CommonMark parser. Known gaps: setext headings, multi-line %% comments,
// html blocks, footnotes/referenceLinks. Add when a fixture shows a real vault needs them.
import { load as loadYaml, CORE_SCHEMA } from 'js-yaml';
import type {
	BlockCache, CachedMetadata, EmbedCache, FrontmatterLinkCache, HeadingCache, LinkCache,
	ListItemCache, Loc, Pos, SectionCache, TagCache,
} from 'obsidian';

/** Bump whenever parsing output changes: persisted indexes (indexstore.ts) from other versions are discarded. */
export const PARSER_VERSION = 1;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+|$)(?:\[(.)\](?:[ \t]|$))?/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BLOCK_ID = /(?:^|\s)\^([A-Za-z0-9-]+)[ \t]*$/;
const WIKILINK = /(!?)\[\[([^\[\]\n]+?)\]\]/g;
const MDLINK = /(!?)\[([^\[\]\n]*)\]\(([^()\s]+|<[^<>\n]+>)\)/g;
const TAG = /(?<=^|\s)#([\p{L}\p{N}\p{M}_\/-]+)/gu;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

interface Line {
	text: string;
	offset: number;
}

export function parseMetadata(src: string): CachedMetadata {
	const lines: Line[] = [];
	let off = 0;
	for (const raw of src.split('\n')) {
		lines.push({ text: raw.endsWith('\r') ? raw.slice(0, -1) : raw, offset: off });
		off += raw.length + 1;
	}
	const loc = (line: number, col: number): Loc => ({ line, col, offset: lines[line].offset + col });
	const span = (a: number, b: number): Pos => ({ start: loc(a, 0), end: loc(b, lines[b].text.length) });

	const cache: CachedMetadata = {};
	const sections: SectionCache[] = [];
	const headings: HeadingCache[] = [];
	const links: LinkCache[] = [];
	const embeds: EmbedCache[] = [];
	const tags: TagCache[] = [];
	const listItems: ListItemCache[] = [];
	const blocks: Record<string, BlockCache> = {};

	let i = 0;

	// --- Frontmatter ---
	if (lines[0]?.text === '---') {
		let end = 1;
		while (end < lines.length && lines[end].text !== '---' && lines[end].text !== '...') end++;
		if (end < lines.length) {
			const yaml = lines.slice(1, end).map((l) => l.text).join('\n');
			try {
				const fm = loadYaml(yaml, { schema: CORE_SCHEMA });
				if (fm && typeof fm === 'object' && !Array.isArray(fm)) {
					cache.frontmatter = fm as Record<string, any>;
					const fmLinks = frontmatterLinks(fm as Record<string, any>);
					if (fmLinks.length) cache.frontmatterLinks = fmLinks;
				}
			} catch {
				// Invalid YAML: Obsidian shows it as-is and caches no frontmatter.
			}
			cache.frontmatterPosition = span(0, end);
			sections.push({ type: 'yaml', position: span(0, end) });
			i = end + 1;
		}
	}

	// --- Inline scan (links, embeds, tags) for one line, code spans and %%comments%% masked out ---
	const scanInline = (n: number) => {
		const text = lines[n].text
			.replace(/(`+)[^`]*?\1/g, (m) => ' '.repeat(m.length))
			.replace(/%%.*?%%/g, (m) => ' '.repeat(m.length));
		for (const m of text.matchAll(WIKILINK)) {
			const [full, bang, inner] = m;
			const bar = inner.indexOf('|');
			const link = (bar < 0 ? inner : inner.slice(0, bar)).trim();
			const ref: LinkCache = {
				link,
				original: full,
				displayText: bar < 0 ? link : inner.slice(bar + 1),
				position: { start: loc(n, m.index!), end: loc(n, m.index! + full.length) },
			};
			(bang ? embeds : links).push(ref);
		}
		for (const m of text.matchAll(MDLINK)) {
			const [full, bang, label, rawUrl] = m;
			const url = rawUrl.startsWith('<') ? rawUrl.slice(1, -1) : rawUrl;
			if (URL_SCHEME.test(url)) continue; // external links are not vault links
			let link = url;
			try { link = decodeURIComponent(url); } catch {}
			(bang ? embeds : links).push({
				link,
				original: full,
				displayText: label,
				position: { start: loc(n, m.index!), end: loc(n, m.index! + full.length) },
			});
		}
		for (const m of text.matchAll(TAG)) {
			if (/^\d+$/.test(m[1])) continue; // "#123" is not a tag
			tags.push({ tag: '#' + m[1], position: { start: loc(n, m.index!), end: loc(n, m.index! + m[0].length) } });
		}
	};

	const isBlank = (n: number) => n >= lines.length || !lines[n].text.trim();
	// Block starts that end a paragraph or list item instead of continuing it lazily (CommonMark).
	const interrupts = (text: string) => HEADING.test(text) || FENCE.test(text) || HR.test(text) || /^ {0,3}>/.test(text);

	// --- Block scan ---
	while (i < lines.length) {
		const text = lines[i].text;
		if (!text.trim()) { i++; continue; }

		const start = i;
		const fence = text.match(FENCE);
		if (fence) {
			const close = new RegExp(`^ {0,3}\\${fence[1][0]}{${fence[1].length},}\\s*$`);
			i++;
			while (i < lines.length && !close.test(lines[i].text)) i++;
			const end = Math.min(i, lines.length - 1);
			sections.push({ type: 'code', position: span(start, end) });
			i = end + 1;
			continue;
		}

		if (text.trim() === '$$') {
			i++;
			while (i < lines.length && lines[i].text.trim() !== '$$') i++;
			const end = Math.min(i, lines.length - 1);
			sections.push({ type: 'math', position: span(start, end) });
			i = end + 1;
			continue;
		}

		const h = text.match(HEADING);
		if (h) {
			headings.push({ heading: (h[2] ?? '').trim(), level: h[1].length, position: { start: loc(i, 0), end: loc(i, text.length) } });
			sections.push({ type: 'heading', position: span(i, i) });
			scanInline(i);
			i++;
			continue;
		}

		if (HR.test(text)) {
			sections.push({ type: 'thematicBreak', position: span(i, i) });
			i++;
			continue;
		}

		let type: string;
		if (text.trimStart().startsWith('>')) {
			type = /^\s*>\s*\[!/.test(text) ? 'callout' : 'blockquote';
			while (i < lines.length && lines[i].text.trimStart().startsWith('>')) scanInline(i++);
		} else if (LIST_ITEM.test(text)) {
			type = 'list';
			i = scanList(i);
		} else if (text.trimStart().startsWith('|') && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1].text)) {
			type = 'table';
			while (!isBlank(i)) scanInline(i++);
		} else {
			type = 'paragraph';
			while (!isBlank(i) && (i === start || (!interrupts(lines[i].text) && !LIST_ITEM.test(lines[i].text)))) scanInline(i++);
		}
		const section: SectionCache = { type, position: span(start, i - 1) };

		const id = lines[i - 1].text.match(BLOCK_ID)?.[1];
		if (id && type !== 'list') {
			// A paragraph that is only "^id" names the block before it (tables, quotes, code).
			const target = type === 'paragraph' && start === i - 1 && lines[start].text.trim() === `^${id}` && sections.length
				? sections[sections.length - 1]
				: section;
			target.id = id;
			blocks[id] = { id, position: target.position };
			if (target !== section) continue;
		}
		sections.push(section);
	}

	// List: consecutive items + continuation lines; blank lines allowed when the list continues after them.
	function scanList(from: number): number {
		const stack: { indent: number; line: number }[] = [];
		const listStart = from;
		let n = from;
		let current: ListItemCache | null = null;
		while (n < lines.length) {
			const text = lines[n].text;
			if (!text.trim()) {
				let next = n + 1;
				while (isBlank(next) && next < lines.length) next++;
				if (next >= lines.length || !(LIST_ITEM.test(lines[next].text) || /^\s/.test(lines[next].text))) break;
				n++;
				continue;
			}
			const m = text.match(LIST_ITEM);
			if (m) {
				const indent = m[1].replace(/\t/g, '    ').length;
				while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
				current = {
					parent: stack.length ? stack[stack.length - 1].line : -listStart,
					task: m[3],
					position: { start: loc(n, m[1].length), end: loc(n, text.length) },
				};
				listItems.push(current);
				stack.push({ indent, line: n });
			} else if (current && (/^\s/.test(text) || (!isBlank(n - 1) && !interrupts(text)))) {
				current.position.end = loc(n, text.length); // continuation / lazy line
			} else {
				break;
			}
			const id = text.match(BLOCK_ID)?.[1];
			if (id && current) {
				current.id = id;
				blocks[id] = { id, position: current.position };
			}
			scanInline(n);
			n++;
		}
		return n;
	}

	if (sections.length) cache.sections = sections;
	if (headings.length) cache.headings = headings;
	if (links.length) cache.links = links;
	if (embeds.length) cache.embeds = embeds;
	if (tags.length) cache.tags = tags;
	if (listItems.length) cache.listItems = listItems;
	if (Object.keys(blocks).length) cache.blocks = blocks;
	return cache;
}

function frontmatterLinks(fm: Record<string, any>): FrontmatterLinkCache[] {
	const out: FrontmatterLinkCache[] = [];
	const visit = (key: string, v: unknown) => {
		if (typeof v === 'string') {
			for (const m of v.matchAll(WIKILINK)) {
				if (m[1]) continue;
				const bar = m[2].indexOf('|');
				const link = (bar < 0 ? m[2] : m[2].slice(0, bar)).trim();
				out.push({ key, link, original: m[0], displayText: bar < 0 ? link : m[2].slice(bar + 1) });
			}
		} else if (Array.isArray(v)) {
			v.forEach((x, i) => visit(`${key}.${i}`, x));
		}
	};
	for (const [k, v] of Object.entries(fm)) visit(k, v);
	return out;
}

// ---- Public link helpers (obsidian.d.ts functions) ----

export function parseLinktext(linktext: string): { path: string; subpath: string } {
	const i = linktext.indexOf('#');
	return i < 0 ? { path: linktext, subpath: '' } : { path: linktext.slice(0, i), subpath: linktext.slice(i) };
}

export function getLinkpath(linktext: string): string {
	return parseLinktext(linktext).path;
}

export function getAllTags(cache: CachedMetadata): string[] | null {
	const out: string[] = [];
	const fmTags = cache.frontmatter?.tags ?? cache.frontmatter?.tag;
	const list = Array.isArray(fmTags) ? fmTags : typeof fmTags === 'string' ? fmTags.split(/[,\s]+/) : [];
	for (const t of list) if (t) out.push(String(t).startsWith('#') ? String(t) : '#' + t);
	for (const t of cache.tags ?? []) out.push(t.tag);
	return out.length ? out : null;
}
