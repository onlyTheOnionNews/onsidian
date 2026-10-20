// Applies appearance.json settings to <body>: color scheme classes, accent color, font size, font overrides (PLAN §4).
import type { Vault } from './vault';

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
let current: Vault | null = null;

/** Obsidian's values: "obsidian" = dark, "moonstone" = light, "system" = follow the OS. */
function isDark(theme: string): boolean {
	return theme === 'obsidian' || (theme !== 'moonstone' && darkQuery.matches);
}

function hexToHsl(hex: string): [number, number, number] | null {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex);
	if (!m) return null;
	const n = parseInt(m[1], 16);
	const [r, g, b] = [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	if (max === min) return [0, 0, Math.round(l * 100)];
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return [Math.round(h * 60), Math.round(s * 100), Math.round(l * 100)];
}

export function applyAppearance(vault: Vault | null): void {
	current = vault;
	const get = (k: string) => vault?.getConfig(k);
	const body = document.body;
	const dark = isDark(String(get('theme') ?? 'system'));
	body.toggleClass('theme-dark', dark);
	body.toggleClass('theme-light', !dark);

	const hsl = hexToHsl(String(get('accentColor') ?? ''));
	for (const [i, name] of ['--accent-h', '--accent-s', '--accent-l'].entries()) {
		if (hsl) body.style.setProperty(name, i ? `${hsl[i]}%` : String(hsl[i]));
		else body.style.removeProperty(name);
	}

	const size = Number(get('baseFontSize'));
	if (size && size !== 16) body.style.setProperty('--font-text-size', `${size}px`);
	else body.style.removeProperty('--font-text-size');

	// User font choices win over the theme's, which win over the defaults.
	for (const [key, v, fallback] of [
		['interfaceFontFamily', '--font-interface', 'var(--font-interface-theme), var(--font-default)'],
		['textFontFamily', '--font-text', 'var(--font-text-theme), var(--font-default)'],
		['monospaceFontFamily', '--font-monospace', 'var(--font-monospace-theme), var(--font-monospace-default)'],
	] as const) {
		const font = String(get(key) ?? '').trim();
		if (font) body.style.setProperty(v, `${font}, ${fallback}`);
		else body.style.removeProperty(v);
	}
}

darkQuery.addEventListener('change', () => applyAppearance(current));
