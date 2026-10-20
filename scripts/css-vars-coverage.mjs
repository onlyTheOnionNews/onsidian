// Reports which CSS variables documented in obsidian-developer-docs are defined by the CSS files in src/ (PLAN §4).
// Usage: npm run css-coverage [-- path/to/obsidian-developer-docs]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const docs = process.argv[2] ?? '../reference/obsidian-developer-docs/en/Reference/CSS variables';
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));

const byFile = new Map();
// Publish variables are skipped: Publish is out of scope (PLAN §7.2).
for (const f of walk(docs).filter((f) => f.endsWith('.md') && !f.replaceAll('\\', '/').includes('/Publish/'))) {
	const vars = [...readFileSync(f, 'utf8').matchAll(/`(--[a-z0-9-]+)`/g)].map((m) => m[1]);
	if (vars.length) byFile.set(f.slice(docs.length + 1).replaceAll('\\', '/'), [...new Set(vars)]);
}
const css = walk('src').filter((f) => f.endsWith('.css')).map((f) => readFileSync(f, 'utf8')).join('\n');
const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

let total = 0, have = 0;
for (const [file, vars] of [...byFile].sort()) {
	const missing = vars.filter((v) => !defined.has(v));
	total += vars.length;
	have += vars.length - missing.length;
	if (missing.length) console.log(`${file}: ${vars.length - missing.length}/${vars.length}  missing ${missing.join(' ')}`);
}
console.log(`\nDefined ${have}/${total} documented variables (${Math.round((have / total) * 100)}%).`);
