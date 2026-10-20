// Runtime exports of obsidian.d.ts (classes, functions, consts) vs the keys of `obsidianModule` in src/api.ts (PLAN §6.2).
// Interfaces and types are compile-time only and not counted.
import { readFileSync } from 'node:fs';

const dts = readFileSync('node_modules/obsidian/obsidian.d.ts', 'utf8');
const runtime = new Set([...dts.matchAll(/^export (?:declare )?(?:abstract )?(?:class|function|const|let|var|enum) (\w+)/gm)].map((m) => m[1]));

const api = readFileSync('src/api.ts', 'utf8');
const block = api.slice(api.indexOf('export const obsidianModule = {'), api.indexOf('\n};', api.indexOf('export const obsidianModule = {')));
const ours = new Set();
for (const line of block.split('\n').slice(1)) {
	const code = line.replace(/\/\/.*$/, '');
	for (const m of code.matchAll(/(\w+)\s*(?::|,|$)/g)) ours.add(m[1]);
}

const missing = [...runtime].filter((n) => !ours.has(n)).sort();
const have = runtime.size - missing.length;
console.log(`Missing (${missing.length}):\n  ${missing.join('\n  ')}`);
console.log(`\nobsidian.d.ts runtime exports provided: ${have}/${runtime.size} (${Math.round((have / runtime.size) * 100)}%)`);
