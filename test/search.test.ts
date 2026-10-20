// Search query language against a small in-memory vault.
import { expect, test } from 'vitest';
import { KvAdapter, MemBackend } from '../src/adapters';
import { MetadataCache } from '../src/metadata';
import { searchVault } from '../src/search';
import { Vault } from '../src/vault';

test('search operators', async () => {
	const adapter = new KvAdapter(new MemBackend(), 'S');
	await adapter.write('Alpha.md', '---\nstatus: draft\ntags: [proj/web]\n---\n# Intro\nThe quick brown fox.\n- [ ] buy milk\n- [x] ship it\n## Later\nlazy dog here');
	await adapter.write('notes/Beta.md', 'Fox and dog on one line.\n#idea\nQuick thoughts');
	await adapter.write('Gamma.md', 'nothing relevant');
	const vault = new Vault(adapter);
	await vault.load();
	const metadataCache = new MetadataCache(vault, false);
	await metadataCache.initialize();
	const app = { vault, metadataCache } as any;
	const files = async (q: string, caseSensitive = false) => (await searchVault(app, q, { caseSensitive })).map((r) => r.file.basename).sort();

	expect(await files('fox')).toEqual(['Alpha', 'Beta']);
	expect(await files('fox dog')).toEqual(['Alpha', 'Beta']); // AND across the note
	expect(await files('line:(fox dog)')).toEqual(['Beta']); // same line only
	expect(await files('fox -dog')).toEqual([]);
	expect(await files('fox OR nothing')).toEqual(['Alpha', 'Beta', 'Gamma']);
	expect(await files('"brown fox"')).toEqual(['Alpha']);
	expect(await files('/qu.ck/')).toEqual(['Alpha', 'Beta']);
	expect(await files('Quick', true)).toEqual(['Beta']);
	expect(await files('match-case:Quick')).toEqual(['Beta']);
	expect(await files('file:alp')).toEqual(['Alpha']);
	expect(await files('path:notes/')).toEqual(['Beta']);
	expect(await files('tag:#proj')).toEqual(['Alpha']); // nested tag prefix
	expect(await files('tag:idea')).toEqual(['Beta']);
	expect(await files('task-todo:milk')).toEqual(['Alpha']);
	expect(await files('task-done:milk')).toEqual([]);
	expect(await files('task:ship')).toEqual(['Alpha']);
	expect(await files('section:(intro fox)')).toEqual(['Alpha']);
	expect(await files('section:(fox lazy)')).toEqual([]); // different heading sections
	expect(await files('[status:draft]')).toEqual(['Alpha']);
	expect(await files('[status]')).toEqual(['Alpha']);

	// Match ranges point into the note text, for highlighting.
	const [beta] = await searchVault(app, 'path:notes dog');
	const text = await vault.cachedRead(beta.file);
	expect(beta.matches.map((m) => text.slice(m.from, m.to))).toEqual(['dog']);
});
