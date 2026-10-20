// Obsidian Flavored Markdown → DOM (PLAN §5.2). One pipeline for reading view, embeds, Live Preview widgets and plugins:
//   markdown-it (+ wikilinks, tags, math, highlights, footnotes, tasks) → DOMPurify → DOM passes (callouts, block ids,
//   embeds, math, code blocks) → registered post-processors.
// ponytail: re-renders the whole note on every change. Obsidian renders per section; do that if long notes get slow.
import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
import markdownItFootnote from 'markdown-it-footnote';
import markdownItMark from 'markdown-it-mark';
import type { App } from './app';
import { Component } from './events';
import { setIcon } from './icons';
import { parseLinktext } from './parse';
import { TFile } from './vault';

// ---------------- Post-processor registry (MarkdownPreviewRenderer statics in the API) ----------------

export interface MarkdownPostProcessorContext {
	docId: string;
	sourcePath: string;
	frontmatter: any;
	addChild(child: MarkdownRenderChild): void;
	getSectionInfo(el: HTMLElement): { text: string; lineStart: number; lineEnd: number } | null;
}
export type MarkdownPostProcessor = ((el: HTMLElement, ctx: MarkdownPostProcessorContext) => Promise<any> | void) & { sortOrder?: number };
export type CodeBlockProcessor = (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => Promise<any> | void;

const postProcessors: MarkdownPostProcessor[] = [];
const codeBlockProcessors = new Map<string, CodeBlockProcessor>();

export const MarkdownPreviewRenderer = {
	registerPostProcessor(fn: MarkdownPostProcessor, sortOrder?: number): void {
		if (sortOrder !== undefined) fn.sortOrder = sortOrder;
		postProcessors.push(fn);
		postProcessors.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
	},
	unregisterPostProcessor(fn: MarkdownPostProcessor): void {
		const i = postProcessors.indexOf(fn);
		if (i >= 0) postProcessors.splice(i, 1);
	},
	registerCodeBlockPostProcessor(language: string, fn: CodeBlockProcessor): void {
		codeBlockProcessors.set(language, fn);
	},
	unregisterCodeBlockPostProcessor(language: string): void {
		codeBlockProcessors.delete(language);
	},
};

export class MarkdownRenderChild extends Component {
	constructor(public containerEl: HTMLElement) {
		super();
	}
}

// ---------------- markdown-it with Obsidian syntax ----------------

interface Env {
	resolve?: (link: string) => boolean;
	/** Added to source line numbers (task checkboxes) when rendering a slice of a file. */
	lineOffset?: number;
}

const md = new MarkdownIt({ html: true, linkify: true, breaks: true });
md.use(markdownItMark).use(markdownItFootnote);

const esc = md.utils.escapeHtml;
const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;

// [[link]], [[link|alias]], ![[embed]]
md.inline.ruler.before('link', 'wikilink', (state, silent) => {
	const src = state.src;
	const embed = src.startsWith('![[', state.pos);
	if (!embed && !src.startsWith('[[', state.pos)) return false;
	const start = state.pos + (embed ? 3 : 2);
	const end = src.indexOf(']]', start);
	if (end < 0 || src.slice(start, end).includes('\n')) return false;
	if (!silent) {
		const inner = src.slice(start, end);
		const bar = inner.indexOf('|');
		const link = (bar < 0 ? inner : inner.slice(0, bar)).trim();
		state.push('wikilink', '', 0).meta = { link, display: bar < 0 ? link : inner.slice(bar + 1), alias: bar >= 0, embed };
	}
	state.pos = end + 2;
	return true;
});
md.renderer.rules.wikilink = (tokens, i, _o, envAny) => {
	const env = envAny as Env | undefined;
	const { link, display, embed, alias } = tokens[i].meta as { link: string; display: string; embed: boolean; alias: boolean };
	if (embed) return `<span class="internal-embed" src="${esc(link)}" alt="${alias ? esc(display) : ''}"></span>`;
	const unresolved = env?.resolve && !env.resolve(link) ? ' is-unresolved' : '';
	return `<a data-href="${esc(link)}" href="${esc(link)}" class="internal-link${unresolved}" target="_blank" rel="noopener nofollow">${esc(display)}</a>`;
};

// #tag (same character rules as the indexer)
md.inline.ruler.after('wikilink', 'tag', (state, silent) => {
	if (state.src[state.pos] !== '#' || (state.pos > 0 && !/\s/.test(state.src[state.pos - 1]))) return false;
	const m = /^#([\p{L}\p{N}\p{M}_\/-]+)/u.exec(state.src.slice(state.pos));
	if (!m || /^\d+$/.test(m[1])) return false;
	if (!silent) state.push('tag', '', 0).content = m[0];
	state.pos += m[0].length;
	return true;
});
md.renderer.rules.tag = (tokens, i) => {
	const tag = esc(tokens[i].content);
	return `<a href="${tag}" class="tag" target="_blank" rel="noopener nofollow">${tag}</a>`;
};

// $inline$ and $$display$$ math (pandoc rules: no space inside the delimiters, closing $ not followed by a digit)
md.inline.ruler.after('escape', 'math_inline', (state, silent) => {
	const src = state.src;
	if (src[state.pos] !== '$') return false;
	const display = src[state.pos + 1] === '$';
	const open = state.pos + (display ? 2 : 1);
	if (!display && /\s/.test(src[open] ?? ' ')) return false;
	let close = open;
	for (;;) {
		close = src.indexOf(display ? '$$' : '$', close);
		if (close < 0) return false;
		if (src[close - 1] !== '\\') break;
		close++;
	}
	if (close === open || (!display && (/\s/.test(src[close - 1]) || /\d/.test(src[close + 1] ?? '')))) return false;
	if (!silent) {
		const t = state.push('math', '', 0);
		t.content = src.slice(open, close);
		t.meta = { display };
	}
	state.pos = close + (display ? 2 : 1);
	return true;
});
md.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
	const lineText = (n: number) => state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n]);
	const first = lineText(startLine);
	if (!first.startsWith('$$')) return false;
	let content: string;
	let last = startLine;
	const rest = first.slice(2);
	if (rest.trimEnd().endsWith('$$') && rest.trim().length > 2) {
		content = rest.trimEnd().slice(0, -2);
	} else {
		const lines = [rest];
		for (last = startLine + 1; last < endLine; last++) {
			const t = lineText(last);
			if (t.trimEnd().endsWith('$$')) {
				lines.push(t.trimEnd().slice(0, -2));
				break;
			}
			lines.push(t);
		}
		if (last >= endLine) return false; // unclosed: plain text, as in Obsidian
		content = lines.join('\n');
	}
	if (silent) return true;
	const t = state.push('math', '', 0);
	t.content = content;
	t.meta = { display: true };
	t.block = true;
	t.map = [startLine, last + 1];
	state.line = last + 1;
	return true;
}, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
md.renderer.rules.math = (tokens, i) => {
	const { content } = tokens[i];
	return (tokens[i].meta as { display: boolean }).display
		? `<div class="math math-block">${esc(content)}</div>`
		: `<span class="math math-inline">${esc(content)}</span>`;
};

// Task list items: "- [ ] x" → checkbox carrying its source line.
md.core.ruler.after('inline', 'tasks', (state) => {
	const toks = state.tokens;
	for (let i = 2; i < toks.length; i++) {
		const inline = toks[i];
		if (inline.type !== 'inline' || toks[i - 1].type !== 'paragraph_open' || toks[i - 2].type !== 'list_item_open') continue;
		const m = /^\[(.)\]\s/.exec(inline.content);
		if (!m) continue;
		const li = toks[i - 2];
		const line = (li.map?.[0] ?? 0) + ((state.env as Env).lineOffset ?? 0);
		li.attrJoin('class', 'task-list-item');
		if (m[1] !== ' ') li.attrJoin('class', 'is-checked');
		li.attrSet('data-task', m[1]);
		const first = inline.children?.[0];
		if (first?.type === 'text') first.content = first.content.slice(m[0].length);
		const box = new state.Token('html_inline', '', 0);
		box.content = `<input type="checkbox" class="task-list-item-checkbox" data-line="${line}"${m[1] !== ' ' ? ' checked' : ''}>`;
		inline.children?.unshift(box);
	}
});

// Markdown links: external → new tab; relative → internal link. Local markdown images → embeds.
md.renderer.rules.link_open = (tokens, i, opts, _env, self) => {
	const tok = tokens[i];
	const href = String(tok.attrGet('href') ?? '');
	if (EXTERNAL.test(href)) {
		tok.attrJoin('class', 'external-link');
		tok.attrSet('target', '_blank');
		tok.attrSet('rel', 'noopener nofollow');
	} else {
		let target = href;
		try { target = decodeURIComponent(href); } catch {}
		tok.attrJoin('class', 'internal-link');
		tok.attrSet('data-href', target);
	}
	return self.renderToken(tokens, i, opts);
};
const defaultImage = md.renderer.rules.image!;
md.renderer.rules.image = (tokens, i, opts, env, self) => {
	const src = String(tokens[i].attrGet('src') ?? '');
	if (EXTERNAL.test(src)) return defaultImage(tokens, i, opts, env, self);
	let path = src;
	try { path = decodeURIComponent(src); } catch {}
	return `<span class="internal-embed" src="${esc(path)}" alt="${esc(tokens[i].content)}"></span>`;
};

// Obsidian drops "%%comments%%" from reading view and keeps line numbers stable (task checkboxes need them).
function stripComments(src: string): string {
	return src.split(/(^ {0,3}(?:```|~~~)[^\n]*\n[\s\S]*?^ {0,3}(?:```|~~~)[ \t]*$)/m)
		.map((part, i) => (i % 2 ? part : part.replace(/%%[\s\S]*?%%/g, (m) => m.replace(/[^\n]/g, ''))))
		.join('');
}

// ---------------- Lazy libraries (loadMathJax / loadMermaid / loadPrism in the API) ----------------

let mathJax: Promise<any> | null = null;
export function loadMathJax(): Promise<any> {
	return (mathJax ??= (async () => {
		(window as any).MathJax = { startup: { typeset: false }, svg: { fontCache: 'global' }, options: { enableMenu: false } };
		await import('mathjax/es5/tex-svg-full.js');
		await (window as any).MathJax.startup.promise;
		return (window as any).MathJax;
	})());
}

export function renderMath(source: string, display: boolean): HTMLElement {
	return (window as any).MathJax.tex2svg(source, { display });
}

export function finishRenderMath(): Promise<void> {
	return Promise.resolve();
}

let mermaid: Promise<any> | null = null;
export function loadMermaid(): Promise<any> {
	return (mermaid ??= import('mermaid').then((m) => m.default));
}

let prism: Promise<any> | null = null;
export function loadPrism(): Promise<any> {
	return (prism ??= import('./prism').then((m) => m.default));
}

let mermaidId = 0;
codeBlockProcessors.set('mermaid', async (source, el) => {
	const m = await loadMermaid();
	m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: document.body.hasClass('theme-dark') ? 'dark' : 'default' });
	try {
		const { svg } = await m.render(`mermaid-${++mermaidId}`, source);
		el.addClass('mermaid');
		el.innerHTML = svg; // mermaid sanitizes at securityLevel 'strict'
	} catch (e) {
		el.createEl('pre', { cls: 'mermaid-error', text: String((e as Error).message ?? e) });
	}
});

// ---------------- Rendering ----------------

const CALLOUT_ICONS: Record<string, string> = {
	note: 'pencil', abstract: 'clipboard-list', summary: 'clipboard-list', tldr: 'clipboard-list', info: 'info',
	todo: 'circle-check', tip: 'flame', hint: 'flame', important: 'flame', success: 'check', check: 'check', done: 'check',
	question: 'circle-help', help: 'circle-help', faq: 'circle-help', warning: 'triangle-alert', caution: 'triangle-alert',
	attention: 'triangle-alert', failure: 'x', fail: 'x', missing: 'x', danger: 'zap', error: 'zap', bug: 'bug',
	example: 'list', quote: 'quote', cite: 'quote',
};
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'avif']);
const AUDIO = new Set(['mp3', 'wav', 'm4a', 'ogg', '3gp', 'flac']);
const VIDEO = new Set(['mp4', 'webm', 'ogv', 'mov', 'mkv']);

interface RenderOpts {
	/** Paths currently being embedded (cycle guard). */
	chain?: string[];
	lineOffset?: number;
}

export const MarkdownRenderer = {
	/** Legacy (deprecated) form without `app`; uses the global app. */
	renderMarkdown(markdown: string, el: HTMLElement, sourcePath: string, component: Component): Promise<void> {
		return MarkdownRenderer.render((window as any).app, markdown, el, sourcePath, component);
	},

	/** obsidian.d.ts MarkdownRenderer.render */
	async render(app: App, markdown: string, el: HTMLElement, sourcePath: string, component: Component, opts: RenderOpts = {}): Promise<void> {
		const env: Env = {
			resolve: (link) => !parseLinktext(link).path || !!app.metadataCache.getFirstLinkpathDest(parseLinktext(link).path, sourcePath),
			lineOffset: opts.lineOffset,
		};
		md.set({ breaks: !app.vault.getConfig('strictLineBreaks') });
		const html = md.render(stripComments(markdown), env as Record<string, unknown>);
		el.appendChild(DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true, ADD_ATTR: ['target'] }));

		const ctx: MarkdownPostProcessorContext = {
			docId: Math.random().toString(36).slice(2),
			sourcePath,
			frontmatter: app.metadataCache.getCache(sourcePath)?.frontmatter,
			addChild: (child) => component.addChild(child),
			getSectionInfo: () => null,
		};
		for (const h of el.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')) h.dataset.heading = h.textContent ?? '';
		markBlockIds(el);
		buildCallouts(el);
		await Promise.all([
			renderEmbeds(app, el, sourcePath, component, opts.chain ?? [sourcePath]),
			renderMathIn(el),
			renderCodeBlocks(el, ctx),
		]);
		for (const pp of postProcessors) {
			try {
				await pp(el, ctx);
			} catch (e) {
				console.error('Markdown post processor failed', e);
			}
		}
	},
};

/** Hide trailing "^block-id" markers and tag the block so links to it can scroll there. */
function markBlockIds(root: HTMLElement): void {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const hits: Text[] = [];
	for (let n = walker.nextNode(); n; n = walker.nextNode()) if (/(?:^|\s)\^[A-Za-z0-9-]+\s*$/.test(n.textContent ?? '')) hits.push(n as Text);
	for (const t of hits) {
		const block = t.parentElement?.closest('p, li, blockquote, td, th');
		if (!block || t !== lastTextNode(block)) continue;
		const m = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/.exec(t.textContent!)!;
		t.textContent = t.textContent!.slice(0, m.index);
		(block as HTMLElement).dataset.blockId = m[1];
	}
}

function lastTextNode(el: Element): Text | null {
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	let last: Text | null = null;
	for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.trim()) last = n as Text;
	return last;
}

/** `> [!type]± Title` blockquotes → Obsidian's callout DOM. Innermost first so nested callouts work. */
function buildCallouts(root: HTMLElement): void {
	for (const bq of [...root.querySelectorAll('blockquote')].reverse()) {
		const p = bq.firstElementChild;
		if (p?.tagName !== 'P') continue;
		const first = p.firstChild;
		const m = first?.nodeType === Node.TEXT_NODE ? /^\[!([^\]\s]+)\]([+-]?)[ \t]*/.exec(first.textContent ?? '') : null;
		if (!m) continue;
		const type = m[1].toLowerCase();
		const fold = m[2];
		first!.textContent = first!.textContent!.slice(m[0].length);

		// Title = nodes up to the first line break; the rest of the paragraph is content.
		const titleNodes: Node[] = [];
		for (let n = p.firstChild; n; n = p.firstChild) {
			if (n.nodeName === 'BR') { n.remove(); break; }
			if (n.nodeType === Node.TEXT_NODE && n.textContent!.includes('\n')) {
				const i = n.textContent!.indexOf('\n');
				titleNodes.push(document.createTextNode(n.textContent!.slice(0, i)));
				n.textContent = n.textContent!.slice(i + 1);
				break;
			}
			titleNodes.push(n);
			n.remove();
		}

		const callout = createDiv({ cls: ['callout', fold ? 'is-collapsible' : '', fold === '-' ? 'is-collapsed' : ''].filter(Boolean), attr: { 'data-callout': type, 'data-callout-fold': fold } });
		const title = callout.createDiv('callout-title');
		setIcon(title.createDiv('callout-icon'), CALLOUT_ICONS[type] ?? 'pencil');
		const inner = title.createDiv('callout-title-inner');
		inner.append(...titleNodes);
		if (!inner.textContent?.trim()) inner.setText(type.charAt(0).toUpperCase() + type.slice(1));
		const content = createDiv('callout-content');
		if (p.textContent?.trim() || p.childElementCount) content.appendChild(p);
		else p.remove();
		while (bq.firstChild) content.appendChild(bq.firstChild);
		if (content.childNodes.length) callout.appendChild(content);
		if (fold) {
			setIcon(title.createDiv('callout-fold'), 'chevron-down');
			title.addEventListener('click', () => callout.toggleClass('is-collapsed', !callout.hasClass('is-collapsed')));
		}
		bq.replaceWith(callout);
	}
}

async function renderMathIn(root: HTMLElement): Promise<void> {
	const els = root.querySelectorAll<HTMLElement>('.math');
	if (!els.length) return;
	try {
		await loadMathJax();
	} catch (e) {
		console.warn('MathJax failed to load; showing TeX source.', e);
		return;
	}
	for (const el of els) {
		const display = el.hasClass('math-block');
		const tex = el.textContent ?? '';
		el.replaceChildren(renderMath(tex, display));
		el.dataset.tex = tex;
		el.addClass('is-loaded');
	}
}

async function renderCodeBlocks(root: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
	const jobs: Promise<unknown>[] = [];
	for (const code of root.querySelectorAll<HTMLElement>('pre > code')) {
		const lang = /language-(\S+)/.exec(code.className)?.[1]?.toLowerCase();
		if (!lang) continue;
		const processor = codeBlockProcessors.get(lang);
		const pre = code.parentElement!;
		if (processor) {
			const div = createDiv(`block-language-${lang}`);
			const source = code.textContent?.replace(/\n$/, '') ?? '';
			pre.replaceWith(div);
			jobs.push(Promise.resolve(processor(source, div, ctx)).catch((e) => div.setText(String(e?.message ?? e))));
		} else {
			pre.addClass(`language-${lang}`);
			jobs.push(loadPrism().then((Prism) => Prism.languages[lang] && Prism.highlightElement(code)).catch(() => {}));
		}
	}
	await Promise.all(jobs);
}

/** Expand `span.internal-embed` placeholders: images/media/PDF, notes (whole, #heading, #^block), other files. */
async function renderEmbeds(app: App, root: HTMLElement, sourcePath: string, component: Component, chain: string[]): Promise<void> {
	await Promise.all([...root.querySelectorAll<HTMLElement>('span.internal-embed')].map(async (el) => {
		const src = el.getAttr('src') ?? '';
		const alt = el.getAttr('alt') ?? '';
		const { path, subpath } = parseLinktext(src);
		const file = path ? app.metadataCache.getFirstLinkpathDest(path, sourcePath) : app.vault.getFileByPath(sourcePath);
		if (!file) {
			el.addClass('is-unresolved');
			el.setText(`"${path}" could not be found.`);
			return;
		}
		const ext = file.extension.toLowerCase();
		el.addClass('is-loaded');
		// Plugins render their own file types (and may wrap the Markdown creator, as Kanban does).
		const creator = app.embedRegistry.embedByExtension[ext];
		if (creator && (ext === 'md' || !(creator as any).builtin)) {
			const child = creator({ app, containerEl: el, sourcePath, linktext: src, depth: chain.length, chain } as any, file, subpath) as any;
			if (child) {
				component.addChild(child);
				// Note embeds are awaited (fast; heading scroll needs them). Other types (PDF pages, canvases, bases, plugin
				// embeds) fill in when ready, so one slow embed doesn't hold back the whole note.
				const loading = child.loadFile?.();
				if (ext === 'md') await loading;
				else void Promise.resolve(loading).catch((e: Error) => el.setText(`Couldn't load ${file.name}: ${e?.message ?? e}`));
			}
			return;
		}
		if (IMAGE.has(ext) || AUDIO.has(ext) || VIDEO.has(ext) || ext === 'pdf') {
			el.addClass('media-embed');
			const url = await app.vault.getResourceUrl(file);
			if (IMAGE.has(ext)) {
				el.addClass('image-embed');
				const img = el.createEl('img', { attr: { src: url, alt: /^\d+(x\d+)?$/.test(alt) ? file.basename : alt || file.basename } });
				const size = /^(\d+)(?:x(\d+))?$/.exec(alt);
				if (size) {
					img.width = Number(size[1]);
					if (size[2]) img.height = Number(size[2]);
				}
			} else if (AUDIO.has(ext)) {
				el.addClass('audio-embed');
				el.createEl('audio', { attr: { controls: '', src: url } });
			} else if (VIDEO.has(ext)) {
				el.addClass('video-embed');
				el.createEl('video', { attr: { controls: '', src: url } });
			} else {
				// ponytail: the browser's built-in PDF viewer until pdf.js lands (phase 4). `#page=N` works in both.
				el.addClass('pdf-embed');
				el.createEl('iframe', { attr: { src: url + (subpath.startsWith('#page=') ? subpath : ''), title: file.name } });
			}
			return;
		}
		el.addClass('file-embed');
		const link = el.createEl('a', { cls: 'internal-link', text: file.name, attr: { 'data-href': file.path, href: file.path } });
		setIcon(link.createSpan({ cls: 'file-embed-icon', prepend: true }), 'file');
	}));
}

/**
 * Built-in creator for `embedRegistry.embedByExtension.md`: a component whose loadFile() renders the note (or a
 * #heading / #^block slice) into ctx.containerEl. Plugins can wrap it.
 */
export function markdownEmbedCreator(ctx: { app: App; containerEl: HTMLElement; sourcePath: string; linktext?: string; chain?: string[] }, file: TFile, subpath: string): Component {
	const child = new MarkdownRenderChild(ctx.containerEl) as MarkdownRenderChild & { loadFile(): Promise<void>; showEditor(): void; showPreview(): void };
	// Obsidian's embed exposes these; embeds here are read-only renders.
	child.showEditor = () => {};
	child.showPreview = () => {};
	child.loadFile = async () => {
		const { app, containerEl: el, sourcePath } = ctx;
		const chain = ctx.chain ?? [sourcePath];
		el.addClass('markdown-embed');
		if (chain.includes(file.path) || chain.length > 5) {
			el.createDiv({ cls: 'markdown-embed-content', text: 'Embed loop or nesting limit reached.' });
			return;
		}
		el.createDiv({ cls: 'markdown-embed-title', text: subpath ? `${file.basename}${subpath.replace(/^#\^?/, ' › ')}` : file.basename });
		const link = el.createDiv({ cls: 'markdown-embed-link', attr: { 'aria-label': 'Open link' } });
		setIcon(link, 'link');
		link.addEventListener('click', () => void app.workspace.openLinkText(ctx.linktext ?? file.path, sourcePath));
		const content = el.createDiv('markdown-embed-content');
		const { text, lineOffset } = await sliceForSubpath(app, file, subpath);
		await MarkdownRenderer.render(app, text, content, file.path, child, { chain: [...chain, file.path], lineOffset });
	};
	return child;
}

/** The text an embed shows: whole note (minus frontmatter), a heading's section, or a block. */
async function sliceForSubpath(app: App, file: TFile, subpath: string): Promise<{ text: string; lineOffset: number }> {
	const text = await app.vault.cachedRead(file);
	const cache = app.metadataCache.getFileCache(file);
	if (subpath.startsWith('#^')) {
		const block = cache?.blocks?.[subpath.slice(2)];
		if (block) return { text: text.slice(block.position.start.offset, block.position.end.offset), lineOffset: block.position.start.line };
	} else if (subpath.startsWith('#') && cache?.headings) {
		const want = subpath.slice(1).split('#').pop()!.trim().toLowerCase();
		const i = cache.headings.findIndex((h) => h.heading.trim().toLowerCase() === want);
		if (i >= 0) {
			const h = cache.headings[i];
			const next = cache.headings.slice(i + 1).find((x) => x.level <= h.level);
			return { text: text.slice(h.position.start.offset, next?.position.start.offset ?? text.length), lineOffset: h.position.start.line };
		}
	}
	const fm = cache?.frontmatterPosition;
	return fm ? { text: text.slice(fm.end.offset), lineOffset: fm.end.line } : { text, lineOffset: 0 };
}
