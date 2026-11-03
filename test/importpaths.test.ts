import { expect, test } from 'vitest';
import { cleanRelPath, freePath, zipLayout } from '../src/importpaths';

test('relative paths are normalized and zip-slip is refused', () => {
	expect(cleanRelPath('a\\b/./c.canvas')).toBe('a/b/c.canvas');
	expect(cleanRelPath('/lead//x.md')).toBe('lead/x.md');
	expect(cleanRelPath('../etc/x')).toBeNull();
	expect(cleanRelPath('a/../../x')).toBeNull();
	expect(cleanRelPath('./')).toBeNull();
});

test('name clashes get a number, never overwrite', () => {
	const taken = new Set(['Board.canvas', 'Board 1.canvas', 'Notes', 'dir/x.md']);
	const has = (p: string) => taken.has(p);
	expect(freePath('Board.canvas', has)).toBe('Board 2.canvas');
	expect(freePath('Fresh.md', has)).toBe('Fresh.md');
	expect(freePath('Notes', has, true)).toBe('Notes 1');
	expect(freePath('dir/x.md', has)).toBe('dir/x 1.md');
	expect(freePath('.hidden', (p) => p === '.hidden')).toBe('.hidden 1'); // dotfile: no extension split
});

test('zip layout unwraps a single top folder and drops junk', () => {
	expect(zipLayout(['Vault/', 'Vault/a.md', 'Vault/b/c.canvas', '__MACOSX/Vault/._a.md', 'Vault/.DS_Store'])).toEqual({
		root: 'Vault',
		files: [['Vault/a.md', 'a.md'], ['Vault/b/c.canvas', 'b/c.canvas']],
	});
	expect(zipLayout(['a.md', 'b/c.md', '../evil.md'])).toEqual({ root: null, files: [['a.md', 'a.md'], ['b/c.md', 'b/c.md']] });
});
