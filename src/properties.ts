// Properties (frontmatter) editor shown at the top of notes in Live Preview and reading view (PLAN §5.2).
// Types are inferred from values. ponytail: .obsidian/types.json (explicit property types) isn't read or written yet.
import { dump as dumpYaml, load as loadYaml, CORE_SCHEMA } from 'js-yaml';
import { setIcon } from './icons';

type PropType = 'list' | 'checkbox' | 'number' | 'date' | 'datetime' | 'text';

const LIST_KEYS = new Set(['tags', 'aliases', 'cssclasses']);
const ICONS: Record<PropType, string> = { list: 'list', checkbox: 'square-check', number: 'binary', date: 'calendar', datetime: 'clock', text: 'text' };

function typeOf(key: string, v: unknown): PropType {
	if (LIST_KEYS.has(key) || Array.isArray(v)) return 'list';
	if (typeof v === 'boolean') return 'checkbox';
	if (typeof v === 'number') return 'number';
	if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return 'date';
	if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return 'datetime';
	return 'text';
}

export function parseFrontmatterYaml(yaml: string): Record<string, unknown> | null {
	try {
		const fm = loadYaml(yaml, { schema: CORE_SCHEMA });
		return fm && typeof fm === 'object' && !Array.isArray(fm) ? (fm as Record<string, unknown>) : fm == null ? {} : null;
	} catch {
		return null;
	}
}

export function stringifyFrontmatter(fm: Record<string, unknown>): string {
	return Object.keys(fm).length ? `---\n${dumpYaml(fm, { schema: CORE_SCHEMA, lineWidth: -1 })}---` : '';
}

/**
 * Renders an editable property list. `onChange` receives the new object (committed on blur/Enter, not per keystroke,
 * so re-rendering the host doesn't steal focus mid-typing).
 */
export function renderProperties(el: HTMLElement, fm: Record<string, unknown> | null, onChange: (fm: Record<string, unknown>) => void): void {
	el.addClass('metadata-container');
	el.empty();
	const heading = el.createDiv('metadata-properties-heading');
	heading.createDiv({ cls: 'metadata-properties-title', text: 'Properties' });
	if (!fm) {
		el.createDiv({ cls: 'metadata-error', text: 'Invalid YAML: edit the frontmatter in source mode.' });
		return;
	}
	const props = el.createDiv('metadata-properties');
	const data = { ...fm };
	const commit = () => onChange({ ...data });

	for (const [key, value] of Object.entries(fm)) {
		const type = typeOf(key, value);
		const row = props.createDiv({ cls: 'metadata-property', attr: { 'data-property-key': key, 'data-property-type': type } });
		const keyEl = row.createDiv('metadata-property-key');
		setIcon(keyEl.createSpan('metadata-property-icon'), ICONS[type]);
		const keyInput = keyEl.createEl('input', { cls: 'metadata-property-key-input', type: 'text', value: key });
		keyInput.addEventListener('change', () => {
			const k = keyInput.value.trim();
			if (!k || k === key || k in data) {
				keyInput.value = key;
				return;
			}
			// Rename while keeping order.
			const entries = Object.entries(data).map(([kk, vv]) => [kk === key ? k : kk, vv] as const);
			for (const kk of Object.keys(data)) delete data[kk];
			for (const [kk, vv] of entries) data[kk] = vv;
			commit();
		});
		const valueEl = row.createDiv('metadata-property-value');
		renderValue(valueEl, type, value, (v) => {
			data[key] = v;
			commit();
		});
		const remove = row.createDiv({ cls: 'clickable-icon metadata-property-remove', attr: { 'aria-label': 'Remove property' } });
		setIcon(remove, 'x');
		remove.addEventListener('click', () => {
			delete data[key];
			commit();
		});
	}

	const add = el.createDiv({ cls: 'metadata-add-button' });
	setIcon(add.createSpan(), 'plus');
	add.createSpan({ text: 'Add property' });
	add.addEventListener('click', () => {
		add.hide();
		const input = el.createEl('input', { cls: 'metadata-new-key', type: 'text', placeholder: 'Property name' });
		input.focus();
		const done = () => {
			const k = input.value.trim();
			if (k && !(k in data)) {
				data[k] = LIST_KEYS.has(k) ? [] : '';
				commit();
			} else {
				input.remove();
				add.show();
			}
		};
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') done();
			if (e.key === 'Escape') { input.remove(); add.show(); }
		});
		input.addEventListener('blur', done);
	});
}

function renderValue(el: HTMLElement, type: PropType, value: unknown, set: (v: unknown) => void): void {
	const commitOn = (input: HTMLInputElement, parse: () => unknown) => {
		input.addEventListener('change', () => set(parse()));
		input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
	};
	switch (type) {
		case 'checkbox': {
			const cb = el.createEl('input', { type: 'checkbox', cls: 'metadata-input-checkbox' });
			cb.checked = value === true;
			cb.addEventListener('change', () => set(cb.checked));
			return;
		}
		case 'number': {
			const i = el.createEl('input', { type: 'number', cls: 'metadata-input metadata-input-number', value: String(value ?? '') });
			commitOn(i, () => (i.value === '' ? null : Number(i.value)));
			return;
		}
		case 'date':
		case 'datetime': {
			const i = el.createEl('input', { type: type === 'date' ? 'date' : 'datetime-local', cls: 'metadata-input', value: String(value ?? '') });
			commitOn(i, () => i.value);
			return;
		}
		case 'list': {
			const items = (Array.isArray(value) ? value : value == null || value === '' ? [] : [value]).map(String);
			const box = el.createDiv('multi-select-container');
			for (const [n, item] of items.entries()) {
				const pill = box.createDiv('multi-select-pill');
				pill.createDiv({ cls: 'multi-select-pill-content', text: item });
				const x = pill.createDiv('multi-select-pill-remove-button');
				setIcon(x, 'x');
				x.addEventListener('click', () => set(items.filter((_, i) => i !== n)));
			}
			const input = box.createEl('input', { cls: 'multi-select-input', type: 'text' });
			input.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' && input.value.trim()) set([...items, input.value.trim()]);
				else if (e.key === 'Backspace' && !input.value && items.length) set(items.slice(0, -1));
			});
			input.addEventListener('blur', () => input.value.trim() && set([...items, input.value.trim()]));
			return;
		}
		default: {
			const i = el.createEl('input', { type: 'text', cls: 'metadata-input metadata-input-text', value: value == null ? '' : String(value) });
			commitOn(i, () => i.value);
		}
	}
}
