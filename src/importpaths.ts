// Path rules for importing files, folders and zips (backup.ts). Pure, so they're unit-tested.

/** A relative path from a picker, drop or zip, made safe: "/" separators, no empty or "." segments. null when it
 *  contains ".." (zip-slip) or nothing is left. */
export function cleanRelPath(p: string): string | null {
	const parts = p.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
	if (!parts.length || parts.includes('..')) return null;
	return parts.join('/');
}

/** `path`, or the first free "name 1.ext", "name 2.ext", …; folders get no extension split. Never overwrites. */
export function freePath(path: string, taken: (p: string) => boolean, isFolder = false): string {
	if (!taken(path)) return path;
	const slash = path.lastIndexOf('/');
	const dir = path.slice(0, slash + 1);
	const name = path.slice(slash + 1);
	const dot = isFolder ? -1 : name.lastIndexOf('.');
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : '';
	for (let n = 1; ; n++) {
		const candidate = `${dir}${stem} ${n}${ext}`;
		if (!taken(candidate)) return candidate;
	}
}

/** Zip contents to import: folders and macOS metadata dropped, and a single top-level folder unwrapped (its name is
 *  returned so the import can be named after it). Entries with unsafe paths are dropped. */
export function zipLayout(paths: string[]): { root: string | null; files: [entry: string, rel: string][] } {
	const files = paths
		.filter((p) => !p.endsWith('/') && !p.startsWith('__MACOSX/') && !/(^|\/)\.DS_Store$/.test(p))
		.map((p) => [p, cleanRelPath(p)] as const)
		.filter((x): x is readonly [string, string] => x[1] !== null);
	const tops = new Set(files.map(([, rel]) => rel.split('/')[0]));
	const root = tops.size === 1 && files.every(([, rel]) => rel.includes('/')) ? [...tops][0] : null;
	return { root, files: files.map(([entry, rel]) => [entry, root ? rel.slice(root.length + 1) : rel]) };
}
