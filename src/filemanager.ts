// FileManager (obsidian.d.ts): rename with link updates, frontmatter editing, trash per settings, new-file locations.
import { dump as dumpYaml, load as loadYaml, CORE_SCHEMA } from 'js-yaml';
import type { App } from './app';
import { dirname, join } from './adapters';
import { parseLinktext } from './parse';
import { confirmAction } from './ui';
import { TAbstractFile, TFile, TFolder, Vault, normalizePath } from './vault';

interface Ref {
	ref: { link: string; original: string; displayText?: string; position?: { start: { offset: number }; end: { offset: number } } };
	target: TFile;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?\r?\n)?---(\r?\n|$)/;

export class FileManager {
	constructor(private app: App) {}

	getNewFileParent(sourcePath: string, _newFilePath?: string): TFolder {
		const { vault } = this.app;
		const loc = vault.getConfig('newFileLocation');
		if (loc === 'current') return vault.getAbstractFileByPath(sourcePath)?.parent ?? vault.getRoot();
		if (loc === 'folder') return vault.getFolderByPath(vault.getConfig('newFileFolderPath')) ?? vault.getRoot();
		return vault.getRoot();
	}

	/** "Untitled.md", "Untitled 1.md", … in `folder`. */
	async createNewMarkdownFile(folder: TFolder, name = 'Untitled', data = ''): Promise<TFile> {
		const base = folder.isRoot() ? '' : folder.path;
		let path = join(base, `${name}.md`);
		for (let n = 1; this.app.vault.getAbstractFileByPath(path); n++) path = join(base, `${name} ${n}.md`);
		return this.app.vault.create(path, data);
	}

	/**
	 * Rename/move and, when "alwaysUpdateLinks" is on, rewrite every link that pointed at the file (or into the folder).
	 * ponytail: relative markdown links *inside* moved notes are not rewritten. Add when someone moves notes that use them.
	 */
	async renameFile(file: TAbstractFile, newPath: string): Promise<void> {
		const { vault, metadataCache } = this.app;
		newPath = normalizePath(newPath);
		if (!vault.getConfig('alwaysUpdateLinks')) return vault.rename(file, newPath);

		// Which notes link to which moved files, captured before the paths change.
		const moved: TFile[] = [];
		if (file instanceof TFile) moved.push(file);
		else if (file instanceof TFolder) Vault.recurseChildren(file, (f) => f instanceof TFile && moved.push(f));
		const movedPaths = new Set(moved.map((f) => f.path));
		const sources = Object.entries(metadataCache.resolvedLinks)
			.filter(([, targets]) => Object.keys(targets).some((t) => movedPaths.has(t)))
			.map(([src]) => src);
		// Keyed by TFile: the same objects are re-keyed by vault.rename, so this survives sources moving too.
		const refs = new Map<TFile, Ref[]>();
		for (const src of sources) {
			const srcFile = vault.getFileByPath(src);
			const cache = metadataCache.getCache(src);
			if (!srcFile || !cache) continue;
			const list: Ref[] = [];
			for (const ref of [...(cache.links ?? []), ...(cache.embeds ?? []), ...(cache.frontmatterLinks ?? [])]) {
				const target = metadataCache.getFirstLinkpathDest(parseLinktext(ref.link).path, src);
				if (target && movedPaths.has(target.path)) list.push({ ref, target });
			}
			if (list.length) refs.set(srcFile, list);
		}

		await vault.rename(file, newPath);

		for (const [srcFile, list] of refs) {
			await vault.process(srcFile, (text) => {
				// Body links by offset, last first; frontmatter links by string replacement inside the YAML block.
				const body = list.filter((r) => r.ref.position).sort((a, b) => b.ref.position!.start.offset - a.ref.position!.start.offset);
				for (const { ref, target } of body) {
					const s = ref.position!.start.offset;
					const e = ref.position!.end.offset;
					if (text.slice(s, e) !== ref.original) continue; // file changed since indexing; skip rather than corrupt
					text = text.slice(0, s) + this.relink(ref, target, srcFile.path) + text.slice(e);
				}
				const fm = list.filter((r) => !r.ref.position);
				if (fm.length) {
					text = text.replace(FRONTMATTER, (block) => {
						for (const { ref, target } of fm) block = block.split(ref.original).join(this.relink(ref, target, srcFile.path));
						return block;
					});
				}
				return text;
			});
		}
	}

	private relink(ref: { link: string; original: string; displayText?: string }, target: TFile, sourcePath: string): string {
		const { subpath } = parseLinktext(ref.link);
		const embed = ref.original.startsWith('!') ? '!' : '';
		if (ref.original.startsWith('[[', embed.length)) {
			const alias = ref.original.includes('|') ? `|${ref.displayText}` : '';
			return `${embed}[[${this.app.metadataCache.fileToLinktext(target, sourcePath) + subpath}${alias}]]`;
		}
		return `${embed}[${ref.displayText ?? ''}](${encodeURI(target.path) + subpath})`;
	}

	generateMarkdownLink(file: TFile, sourcePath: string, subpath = '', alias = ''): string {
		const { vault, metadataCache } = this.app;
		if (vault.getConfig('useMarkdownLinks')) {
			return `[${alias || file.basename}](${encodeURI(metadataCache.fileToLinktext(file, sourcePath, false)) + subpath})`;
		}
		const text = metadataCache.fileToLinktext(file, sourcePath) + subpath;
		return `[[${text}${alias ? `|${alias}` : ''}]]`;
	}

	/** Parse frontmatter, let `fn` mutate it, write it back (inserting a block if the note had none). */
	async processFrontMatter(file: TFile, fn: (frontmatter: any) => void): Promise<void> {
		await this.app.vault.process(file, (text) => {
			const m = FRONTMATTER.exec(text);
			const fm = (m?.[1] ? loadYaml(m[1], { schema: CORE_SCHEMA }) : {}) ?? {};
			if (typeof fm !== 'object' || Array.isArray(fm)) throw new Error('Frontmatter is not a YAML mapping.');
			fn(fm);
			const yaml = Object.keys(fm).length ? dumpYaml(fm, { schema: CORE_SCHEMA, lineWidth: -1 }) : '';
			const block = yaml ? `---\n${yaml}---\n` : '';
			return m ? block + text.slice(m[0].length) : block + text;
		});
	}

	async trashFile(file: TAbstractFile): Promise<void> {
		const { vault } = this.app;
		const opt = vault.getConfig('trashOption');
		if (opt === 'none') await vault.delete(file, true);
		else await vault.trash(file, opt === 'system');
	}

	async promptForDeletion(file: TAbstractFile): Promise<boolean> {
		if (this.app.vault.getConfig('promptDelete')) {
			const where = this.app.vault.getConfig('trashOption') === 'none' ? 'permanently deleted' : "moved to the vault's .trash folder";
			if (!(await confirmAction(this.app, 'Delete file', `"${file.name}" will be ${where}.`))) return false;
		}
		await this.trashFile(file);
		return true;
	}

	/** Attachment location per "attachmentFolderPath": "/" root, "./" next to the note, "./sub" under it, else a folder. */
	async getAvailablePathForAttachment(filename: string, sourcePath = ''): Promise<string> {
		const setting = String(this.app.vault.getConfig('attachmentFolderPath') ?? '/');
		const noteDir = dirname(sourcePath);
		const dir = setting === '/' ? '' : setting.startsWith('./') ? join(noteDir, setting.slice(2)) : setting === '.' ? noteDir : setting;
		const dot = filename.lastIndexOf('.');
		const stem = dot > 0 ? filename.slice(0, dot) : filename;
		const ext = dot > 0 ? filename.slice(dot) : '';
		let path = normalizePath(join(dir, filename));
		for (let n = 1; this.app.vault.getAbstractFileByPath(path); n++) path = normalizePath(join(dir, `${stem} ${n}${ext}`));
		if (dir && !this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
		return path;
	}
}
