// Vendors the Relay plugin (MIT, github.com/No-Instructions/Relay) into public/bundled/system3-relay/ so it ships with
// the app as the built-in collaboration feature (PLAN §7.1). The release files are pinned by version and SHA-256 in
// relay.lock.json: a download that doesn't match fails the build.
// Usage: node scripts/vendor-relay.mjs                    download if missing, verify
//        node scripts/vendor-relay.mjs --update <version>  re-pin to another release (review its changes first)
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const REPO = 'No-Instructions/Relay';
const FILES = ['main.js', 'manifest.json', 'styles.css'];
const OUT = 'public/bundled/system3-relay';
const LOCK = 'relay.lock.json';
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const update = process.argv.indexOf('--update');
const lock = update > 0 ? { version: process.argv[update + 1], files: {} } : JSON.parse(await readFile(LOCK, 'utf8'));
if (!lock.version) throw new Error('usage: --update <version>');

await mkdir(OUT, { recursive: true });
for (const name of FILES) {
	const path = `${OUT}/${name}`;
	let data = await readFile(path).catch(() => null);
	if (!data || sha256(data) !== lock.files[name]) {
		const r = await fetch(`https://github.com/${REPO}/releases/download/${lock.version}/${name}`);
		if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
		data = Buffer.from(await r.arrayBuffer());
	}
	const hash = sha256(data);
	if (update > 0) lock.files[name] = hash;
	else if (hash !== lock.files[name]) throw new Error(`${name}: SHA-256 ${hash} does not match ${LOCK}`);
	await writeFile(path, data);
}
const manifest = JSON.parse(await readFile(`${OUT}/manifest.json`, 'utf8'));
if (manifest.id !== 'system3-relay' || manifest.version !== lock.version) throw new Error(`unexpected manifest ${manifest.id} ${manifest.version}`);
if (update > 0) await writeFile(LOCK, `${JSON.stringify(lock, null, '\t')}\n`);
console.log(`Relay ${lock.version} vendored and verified.`);
