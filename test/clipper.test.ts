import { expect, test } from 'vitest';
import { bookmarklet, parseClip } from '../src/views/clip';

test('untrusted clip payloads are validated', () => {
	expect(parseClip(null)).toBeNull();
	expect(parseClip({ type: 'other', text: 'x' })).toBeNull();
	expect(parseClip({ type: 'obsidian-online-clip', url: 'javascript:alert(1)', text: 'x' })).toBeNull();
	expect(parseClip({ type: 'obsidian-online-clip', title: 5, url: 'https://a.example/', text: {} })).toEqual({ title: '', url: 'https://a.example/', html: '', text: '' });
});

test('bookmarklet is valid JavaScript targeting the app origin', () => {
	const href = bookmarklet('https://notes.example/app/?vault=1#x');
	expect(href.startsWith('javascript:')).toBe(true);
	const code = decodeURIComponent(href.slice('javascript:'.length));
	expect(() => new Function(code)).not.toThrow();
	expect(code).toContain('"https://notes.example/app/?clip=1"');
	expect(code).toContain('w.postMessage(d,"https://notes.example")');
});
