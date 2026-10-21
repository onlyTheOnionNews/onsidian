// setIcon/getIcon/addIcon/getIconIds (obsidian.d.ts). Obsidian's icon ids are Lucide names ("file-plus" or "lucide-file-plus").
// Plugins may ask for any Lucide id, so the full set (~900 KB) is needed, but it loads in parallel with startup instead
// of sitting in the main bundle. Icons asked for before it arrives get their <svg> at once and are filled in on load.
type IconNode = [string, Record<string, string>][];

let lucide: Record<string, IconNode> | null = null;
const waiting: [SVGSVGElement, IconNode | string][] = [];
const custom = new Map<string, string>();
const svgNS = 'http://www.w3.org/2000/svg';

export const iconsReady: Promise<void> = import('lucide').then((m) => {
	lucide = m.icons as unknown as Record<string, IconNode>;
	for (const [svg, id] of waiting.splice(0)) {
		const node = lucide[toPascal(id as string)];
		if (node) draw(svg, node);
	}
});

const toPascal = (id: string) => id.replace(/^lucide-/, '').replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());

function draw(svg: SVGSVGElement, node: IconNode): void {
	for (const [k, v] of Object.entries({ fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) {
		svg.setAttribute(k, v);
	}
	for (const [tag, attrs] of node) {
		const el = document.createElementNS(svgNS, tag);
		for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
		svg.appendChild(el);
	}
}

export function getIcon(id: string): SVGSVGElement | null {
	const svg = document.createElementNS(svgNS, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('class', `svg-icon ${id.startsWith('lucide-') ? id : 'lucide-' + id}`);
	const c = custom.get(id);
	if (c !== undefined) {
		svg.setAttribute('viewBox', '0 0 100 100');
		svg.innerHTML = c;
		return svg;
	}
	if (!lucide) {
		waiting.push([svg, id]);
		return svg;
	}
	const node = lucide[toPascal(id)];
	if (!node) return null;
	draw(svg, node);
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

/** Every icon id (Lucide ids once the set has loaded, plus addIcon ones). */
export function getIconIds(): string[] {
	const ids = Object.keys(lucide ?? {}).map((n) => 'lucide-' + n.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase());
	return [...ids, ...custom.keys()];
}
