// Vault + adapters + MetadataCache together, on both key-value backends (memory and IndexedDB).
import 'fake-indexeddb/auto';
import { expect, test } from 'vitest';
import { IdbBackend, KvAdapter, MemBackend } from '../src/adapters';
import { MetadataCache } from '../src/metadata';
import { TFile, TFolder, Vault } from '../src/vault';

for (const [name, backend] of [['memory', () => new MemBackend()], ['indexeddb', () => new IdbBackend('test-vault')]] as const) {
	test(`vault + metadata on ${name}`, async () => {
		const adapter = new KvAdapter(backend(), 'Test');
		await adapter.write('notes/a.md', 'Links to [[b]] and [[missing]]');
		await adapter.write('.obsidian/app.json', '{}');

		const vault = new Vault(adapter);
		await vault.load();
		expect(vault.getFiles().map((f) => f.path)).toEqual(['notes/a.md']); // .obsidian is hidden
		const meta = new MetadataCache(vault, false);
		await meta.initialize();
		expect(meta.unresolvedLinks['notes/a.md']).toEqual({ b: 1, missing: 1 });

		const events: string[] = [];
		for (const e of ['create', 'modify', 'delete', 'rename']) vault.on(e, (f: any, old?: string) => events.push(`${e}:${f.path}${old ? '<' + old : ''}`));
		const changed = new Promise((r) => meta.on('changed', r));

		// Creating b.md in a new folder resolves a's link by name and creates the parent folder implicitly.
		const b = await vault.create('other/b.md', '# B\n#tag');
		await changed;
		expect(vault.getFolderByPath('other')).toBeInstanceOf(TFolder);
		expect(meta.resolvedLinks['notes/a.md']).toEqual({ 'other/b.md': 1 });
		expect(meta.getFileCache(b)?.tags?.[0].tag).toBe('#tag');
		expect(meta.fileToLinktext(b, 'notes/a.md')).toBe('b');

		await expect(vault.create('other/b.md', '')).rejects.toThrow('File already exists.');

		// Folder rename re-keys children and fires rename for each.
		await vault.rename(vault.getFolderByPath('other')!, 'moved');
		expect(vault.getFileByPath('moved/b.md')).toBe(b);
		expect(await vault.read(b)).toBe('# B\n#tag');
		expect(meta.resolvedLinks['notes/a.md']).toEqual({ 'moved/b.md': 1 });

		await vault.trash(b, true); // no OS trash on the web → .trash/
		expect(vault.getFileByPath('moved/b.md')).toBeNull();
		expect(await adapter.exists('.trash/b.md')).toBe(true);
		expect(meta.unresolvedLinks['notes/a.md']).toEqual({ b: 1, missing: 1 });

		expect(events).toEqual([
			'create:other', 'create:other/b.md',
			'rename:moved<other', 'rename:moved/b.md<other/b.md',
			'delete:moved/b.md',
		]);

		// rescan() picks up writes made behind the vault's back (e.g. desktop Obsidian on the same folder).
		await adapter.write('notes/new.md', 'x');
		await adapter.remove('notes/a.md');
		await vault.rescan();
		expect(vault.getFiles().map((f) => f.path).sort()).toEqual(['notes/new.md']);
		expect(vault.getFileByPath('notes/new.md')).toBeInstanceOf(TFile);
	});
}

test('a read that finishes after a write never caches the older text', async () => {
	const backend = new MemBackend();
	const adapter = new KvAdapter(backend, 'Test');
	await adapter.write('n.md', 'old');
	const vault = new Vault(adapter);
	await vault.load();
	const f = vault.getFileByPath('n.md')!;
	const get = backend.get.bind(backend);
	backend.get = async (k) => {
		const r = await get(k); // snapshot now, deliver late
		await new Promise((res) => setTimeout(res, 20));
		return r;
	};
	const slow = vault.cachedRead(f);
	await vault.modify(f, 'new');
	expect(await slow).toBe('old'); // that read's own result
	expect(await vault.cachedRead(f)).toBe('new');
});

test('persisted index: reused on reopen, re-parsed when a note changed while closed', async () => {
	const adapter = new KvAdapter(new MemBackend(), 'Test');
	await adapter.write('a.md', '#one [[b]]');
	await adapter.write('c.md', '#keep');
	const open = async () => {
		const vault = new Vault(adapter);
		await vault.load();
		const meta = new MetadataCache(vault, false, 'persist-test');
		await meta.initialize();
		await new Promise((r) => setTimeout(r, 50)); // the index write is fire-and-forget
		return { vault, meta };
	};
	const first = await open();
	expect(first.meta.getCache('a.md')?.tags?.[0].tag).toBe('#one');

	await new Promise((r) => setTimeout(r, 5)); // a later mtime
	await adapter.write('a.md', '#two [[b]] [[c]]');
	const second = await open();
	expect(second.meta.getCache('a.md')?.tags?.[0].tag).toBe('#two');
	expect(second.meta.resolvedLinks['a.md']).toEqual({ 'c.md': 1 });
	expect(second.meta.getCache('c.md')?.tags?.[0].tag).toBe('#keep');
});
