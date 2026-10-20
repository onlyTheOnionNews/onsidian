import { expect, test } from 'vitest';
import { merge3 } from '../src/merge';

const base = 'title\n\nline one\nline two\nline three\n';

test('non-overlapping edits from both sides merge', () => {
	const local = 'title\n\nline one EDITED HERE\nline two\nline three\n';
	const remote = 'title\n\nline one\nline two\nline three\nadded remotely\n';
	expect(merge3(base, local, remote)).toEqual({ text: 'title\n\nline one EDITED HERE\nline two\nline three\nadded remotely\n', conflicts: 0 });
});

test('trivial cases', () => {
	expect(merge3(base, base, 'x')).toEqual({ text: 'x', conflicts: 0 });
	expect(merge3(base, 'y', base)).toEqual({ text: 'y', conflicts: 0 });
	expect(merge3(base, 'same', 'same')).toEqual({ text: 'same', conflicts: 0 });
});

test('conflicting edits keep the local side and report the conflict', () => {
	const local = 'title\n\nline one LOCAL\nline two\nline three\n';
	const remote = 'title\n\nline one REMOTE\nline two\nline three\n';
	const r = merge3(base, local, remote);
	expect(r.conflicts).toBe(1);
	expect(r.text).toBe(local);
});
