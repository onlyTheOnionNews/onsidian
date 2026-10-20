// Three-way merge of note text (PLAN §2 / phase 5): used when a note changes elsewhere (another device, desktop
// Obsidian on the same folder, Relay, a plugin) while this editor has unsaved edits. Line-based diff3.
import { diff3Merge } from 'node-diff3';

export interface MergeResult {
	text: string;
	/** Hunks both sides changed differently. Resolved with the local side; the caller keeps the remote copy. */
	conflicts: number;
}

export function merge3(base: string, local: string, remote: string): MergeResult {
	if (local === remote) return { text: local, conflicts: 0 };
	if (base === local) return { text: remote, conflicts: 0 };
	if (base === remote) return { text: local, conflicts: 0 };
	const regions = diff3Merge(local.split('\n'), base.split('\n'), remote.split('\n'), { excludeFalseConflicts: true });
	const out: string[] = [];
	let conflicts = 0;
	for (const r of regions) {
		if (r.ok) out.push(...r.ok);
		else if (r.conflict) {
			conflicts++;
			out.push(...r.conflict.a);
		}
	}
	return { text: out.join('\n'), conflicts };
}
