// setIcon/getIcon/addIcon (obsidian.d.ts). Obsidian's icon ids are Lucide names ("file-plus" or "lucide-file-plus").
// The full Lucide set is bundled because plugins may ask for any id.
import { icons } from 'lucide';

const custom = new Map<string, string>();

const toPascal = (id: string) => id.replace(/^lucide-/, '').replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());

export function getIcon(id: string): SVGSVGElement | null {
	const svgNS = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(svgNS, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('class', `svg-icon ${id.startsWith('lucide-') ? id : 'lucide-' + id}`);
	const c = custom.get(id);
	if (c !== undefined) {
		svg.setAttribute('viewBox', '0 0 100 100');
		svg.innerHTML = c;
		return svg;
	}
	const node = (icons as Record<string, [string, Record<string, string>][]>)[toPascal(id)];
	if (!node) return null;
	for (const [k, v] of Object.entries({ fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) {
		svg.setAttribute(k, v);
	}
	for (const [tag, attrs] of node) {
		const el = document.createElementNS(svgNS, tag);
		for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
		svg.appendChild(el);
	}
	return svg;
}

export function setIcon(parent: HTMLElement, id: string): void {
	parent.empty();
	const svg = getIcon(id);
	if (svg) parent.appendChild(svg);
}

/** `svgContent` is inner SVG markup for a 0 0 100 100 viewBox, as in Obsidian. Plugin-supplied, trusted like plugin code. */
export function addIcon(id: string, svgContent: string): void {
	custom.set(id, svgContent);
}

export function removeIcon(id: string): void {
	custom.delete(id);
}
