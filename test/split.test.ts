import { expect, test, vi } from 'vitest';

// render.ts pulls in DOM-only modules at import time; only the pure splitter is under test.
vi.mock('../src/dom', () => ({}));

test('long notes split at headings outside code fences, keeping line offsets', async () => {
	const { splitAtHeadings } = await import('../src/render');
	const body = 'x'.repeat(20);
	const text = `# A\n${body}\n\`\`\`\n# not a heading\n\`\`\`\n${body}\n## B\n${body}\n# C\n${body}\n`;
	const chunks = splitAtHeadings(text, 20);
	expect(chunks.map((c) => c.text.split('\n')[0])).toEqual(['# A', '## B', '# C']);
	expect(chunks.map((c) => c.lineOffset)).toEqual([0, 6, 8]);
	expect(chunks.map((c) => c.text).join('')).toBe(text);
	// Footnotes / reference links: never split.
	expect(splitAtHeadings(`${text}[^1]: note\n`, 30)).toHaveLength(1);
	expect(splitAtHeadings('short', 30)).toHaveLength(1);
});
