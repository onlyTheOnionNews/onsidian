// Downloads the most-downloaded community plugins' release files into compat-plugins/ (gitignored) for the
// compatibility run (compat.html). Node has no CORS limits, so this works without a network bridge.
// The files are third-party code: they're only served to the browser test page, never executed by Node.
// Usage: npm run compat:fetch [-- <count>]
import { mkdir, writeFile } from 'node:fs/promises';

const count = Number(process.argv[2] ?? 50);
const R = 'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD';
const [list, stats] = await Promise.all([
	fetch(`${R}/community-plugins.json`).then((r) => r.json()),
	fetch(`${R}/community-plugin-stats.json`).then((r) => r.json()),
]);
list.sort((a, b) => (stats[b.id]?.downloads ?? 0) - (stats[a.id]?.downloads ?? 0));

const index = [];
for (const p of list) {
	if (index.length >= count) break;
	try {
		const manifest = await fetch(`https://raw.githubusercontent.com/${p.repo}/HEAD/manifest.json`).then((r) => r.json());
		if (manifest.isDesktopOnly) {
			console.log(`skip ${p.id} (desktop-only)`);
			continue;
		}
		const get = async (file) => {
			const r = await fetch(`https://github.com/${p.repo}/releases/download/${manifest.version}/${file}`);
			return r.ok ? r.text() : null;
		};
		const [main, releaseManifest, styles] = await Promise.all([get('main.js'), get('manifest.json'), get('styles.css')]);
		if (!main) {
			console.log(`skip ${p.id} (no main.js in release ${manifest.version})`);
			continue;
		}
		const dir = `compat-plugins/${p.id}`;
		await mkdir(dir, { recursive: true });
		// .txt so the Vite dev server serves it verbatim (it transforms .js requests).
		await writeFile(`${dir}/main.js.txt`, main);
		await writeFile(`${dir}/manifest.json`, releaseManifest ?? JSON.stringify(manifest));
		if (styles) await writeFile(`${dir}/styles.css`, styles);
		index.push({ id: p.id, name: p.name, version: manifest.version, downloads: stats[p.id]?.downloads ?? 0, styles: !!styles });
		console.log(`ok   ${p.id} ${manifest.version}`);
	} catch (e) {
		console.log(`fail ${p.id}: ${e.message}`);
	}
}
await mkdir('compat-plugins', { recursive: true });
await writeFile('compat-plugins/index.json', JSON.stringify(index, null, 2));
console.log(`\n${index.length} plugins in compat-plugins/. Run the dev server and open /compat.html.`);
