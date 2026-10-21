// Generates the logo — a lowercase "o" inside a capital "O", both cut from faceted purple crystal — as SVG, renders the
// full-resolution PNG and every favicon / app icon size from it.
// Usage: npm run icons   (writes branding/ and public/; commit the output, the build doesn't run this)
// The facets are deterministic (seeded), so re-running gives identical files.
import { Resvg } from '@resvg/resvg-js';
import { mkdir, rm, writeFile } from 'node:fs/promises';

function rng(seed) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const PALETTE = [
	[0.0, [22, 5, 48]],
	[0.3, [61, 18, 134]],
	[0.55, [109, 51, 214]],
	[0.8, [166, 117, 255]],
	[1.0, [220, 198, 255]],
	[1.25, [255, 255, 255]],
];

function color(i) {
	i = Math.max(0, Math.min(1.25, i));
	for (let k = 1; k < PALETTE.length; k++) {
		const [p1, c1] = PALETTE[k];
		const [p0, c0] = PALETTE[k - 1];
		if (i <= p1) {
			const f = (i - p0) / (p1 - p0);
			const c = c0.map((v, j) => Math.round(v + (c1[j] - v) * f));
			return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
		}
	}
	return '#ffffff';
}

const norm = (v) => {
	const l = Math.hypot(...v);
	return v.map((x) => x / l);
};
const LIGHT = norm([-0.45, -0.65, 0.62]); // upper left (SVG y points down)
const HALF = norm([LIGHT[0], LIGHT[1], LIGHT[2] + 1]);

/** One letter ring as crystal facets: each segment rises from both edges to a jittered ridge. */
function ring({ cx, cy, rx, ry, tMin, tMax, segs, seed, detail, minLight = 0 }) {
	const r = rng(seed);
	const pts = [];
	for (let i = 0; i < segs; i++) {
		const th = ((i + (r() - 0.5) * 0.45) / segs) * Math.PI * 2;
		const t = tMin + (tMax - tMin) * Math.abs(Math.cos(th)) ** 1.6; // thick sides, thin top/bottom, like a typeface's stress
		const at = (d, a = th) => [cx + (rx - d) * Math.cos(a), cy + (ry - d) * Math.sin(a)];
		const f = 0.5 + (r() - 0.5) * 0.3;
		const ridgeA = th + ((r() - 0.5) * 0.5 * Math.PI * 2) / segs;
		pts.push({ o: [...at(0), 0], i: [...at(t), 0], m: [...at(t * f, ridgeA), t * (0.35 + 0.3 * r())] });
	}
	const facets = [];
	for (let k = 0; k < segs; k++) {
		const a = pts[k];
		const b = pts[(k + 1) % segs];
		for (const [e0, e1] of [[a.o, b.o], [a.i, b.i]]) {
			const tris = r() < 0.5 ? [[e0, e1, b.m], [e0, b.m, a.m]] : [[e0, e1, a.m], [e1, b.m, a.m]];
			facets.push(...tris);
		}
	}
	const shapes = [];
	for (const tri of facets) {
		const [p, q, s] = tri;
		let n = norm([
			(q[1] - p[1]) * (s[2] - p[2]) - (q[2] - p[2]) * (s[1] - p[1]),
			(q[2] - p[2]) * (s[0] - p[0]) - (q[0] - p[0]) * (s[2] - p[2]),
			(q[0] - p[0]) * (s[1] - p[1]) - (q[1] - p[1]) * (s[0] - p[0]),
		]);
		if (n[2] < 0) n = n.map((x) => -x);
		const diffuse = Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
		const spec = Math.max(0, n[0] * HALF[0] + n[1] * HALF[1] + n[2] * HALF[2]) ** 24;
		const light = Math.max(minLight, 0.12 + 0.72 * diffuse + 0.55 * spec + (r() - 0.5) * 0.12);
		const d = tri.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
		shapes.push(`<polygon points="${d}" fill="${color(light)}"/>`);
		if (detail && r() < 0.4) {
			// Cleavage striations: a few lines parallel to the facet's first edge, stepping toward the opposite corner.
			const lines = 2 + Math.floor(r() * 3);
			for (let j = 1; j <= lines; j++) {
				const f = (j / (lines + 1)) * (0.6 + 0.3 * r());
				const u = [p[0] + (s[0] - p[0]) * f, p[1] + (s[1] - p[1]) * f];
				const v = [q[0] + (s[0] - q[0]) * f, q[1] + (s[1] - q[1]) * f];
				shapes.push(`<line x1="${u[0].toFixed(1)}" y1="${u[1].toFixed(1)}" x2="${v[0].toFixed(1)}" y2="${v[1].toFixed(1)}" class="cleave"/>`);
			}
		}
		shapes.push(`<polygon points="${d}" class="edge"/>`);
	}
	// Ridges catch the light: brighter lines along them.
	const ridge = pts.map((p) => `${p.m[0].toFixed(1)},${p.m[1].toFixed(1)}`).join(' ');
	shapes.push(`<polygon points="${ridge}" class="ridge"/>`);
	const outline = (k) => pts.map((p) => `${p[k][0].toFixed(1)},${p[k][1].toFixed(1)}`).join(' ');
	return { shapes, outer: outline('o'), inner: outline('i'), glints: pts.filter(() => r() < 0.12).map((p) => p.m) };
}

/** The mark on a 1024 canvas. `small`: fewer, larger facets for 16–48 px. `background`: app-icon tile. */
function logo({ small = false, background = null, scale = 1 } = {}) {
	const s = small ? 1.6 : 1;
	const O = ring({ cx: 512, cy: 512, rx: 440, ry: 468, tMin: small ? 120 : 84, tMax: small ? 190 : 156, segs: small ? 14 : 44, seed: 7, detail: !small, minLight: small ? 0.4 : 0 });
	const o = ring({ cx: 512, cy: 520, rx: small ? 210 : 196, ry: small ? 214 : 204, tMin: small ? 70 : 44, tMax: small ? 110 : 80, segs: small ? 10 : 30, seed: 11, detail: !small, minLight: small ? 0.4 : 0 });
	const holes = (r) => `M${r.outer.replaceAll(' ', ' L')} Z M${r.inner.replaceAll(' ', ' L')} Z`;
	const glint = ([x, y]) => `<path d="M${x},${y - 26}Q${x},${y} ${x + 26},${y}Q${x},${y} ${x},${y + 26}Q${x},${y} ${x - 26},${y}Q${x},${y} ${x},${y - 26}Z" fill="#fff" opacity="0.9"/>`;
	const bg = background === 'tile'
		? `<rect width="1024" height="1024" rx="228" fill="url(#bg)"/>`
		: background === 'full' ? `<rect width="1024" height="1024" fill="url(#bg)"/>` : '';
	const k = scale;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
<defs>
<radialGradient id="bg" cx="0.5" cy="0.42" r="0.75"><stop offset="0" stop-color="#2a1748"/><stop offset="1" stop-color="#0e0918"/></radialGradient>
<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="18"/></filter>
<style>
.edge{fill:none;stroke:#efe2ff;stroke-opacity:${small ? 0.15 : 0.42};stroke-width:${(small ? 4 : 1.6) * s};stroke-linejoin:round}
.ridge{fill:none;stroke:#fbf6ff;stroke-opacity:${small ? 0.5 : 0.75};stroke-width:${small ? 6 : 2.4};stroke-linejoin:round}
.cleave{stroke:#ffffff;stroke-opacity:0.2;stroke-width:1.1}
.rim{fill:none;stroke:${small ? '#3a1585' : '#13042b'};stroke-width:${small ? 14 : 4};stroke-linejoin:round}
</style>
</defs>
${bg}
<g transform="translate(${512 - 512 * k} ${512 - 512 * k}) scale(${k})">
${small ? '' : `<path d="${holes(O)} ${holes(o)}" fill="#05010d" fill-rule="evenodd" opacity="0.45" transform="translate(0 22)" filter="url(#shadow)"/>`}
${O.shapes.join('\n')}
${o.shapes.join('\n')}
<path d="${holes(O)} ${holes(o)}" class="rim" fill-rule="evenodd"/>
${small ? '' : [...O.glints.slice(0, 3), ...o.glints.slice(0, 1)].map(glint).join('\n')}
</g>
</svg>
`;
}

const png = (svg, size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();

/** ICO container holding PNG images (supported by every current browser and Windows). */
function ico(images) {
	const header = Buffer.alloc(6 + 16 * images.length);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(images.length, 4);
	let offset = header.length;
	images.forEach(([size, data], n) => {
		const e = 6 + 16 * n;
		header[e] = size >= 256 ? 0 : size;
		header[e + 1] = size >= 256 ? 0 : size;
		header.writeUInt16LE(1, e + 4);
		header.writeUInt16LE(32, e + 6);
		header.writeUInt32LE(data.length, e + 8);
		header.writeUInt32LE(offset, e + 12);
		offset += data.length;
	});
	return Buffer.concat([header, ...images.map(([, d]) => d)]);
}

const full = logo();
const small = logo({ small: true });
const tile = logo({ background: 'tile', scale: 0.78 });
const maskable = logo({ background: 'full', scale: 0.62 }); // artwork inside the 80% safe circle

await mkdir('branding', { recursive: true });
await writeFile('branding/logo.svg', full);
await writeFile('branding/logo-4096.png', png(full, 4096));

await writeFile('public/logo.svg', full);
await writeFile('public/favicon.svg', small);
await writeFile('public/favicon.ico', ico([16, 32, 48].map((n) => [n, png(small, n)])));
await writeFile('public/favicon-16.png', png(small, 16));
await writeFile('public/favicon-32.png', png(small, 32));
await writeFile('public/apple-touch-icon.png', png(logo({ background: 'full', scale: 0.78 }), 180)); // iOS rounds the corners itself
await writeFile('public/icon-192.png', png(tile, 192));
await writeFile('public/icon-512.png', png(tile, 512));
await writeFile('public/icon-maskable-512.png', png(maskable, 512));
await rm('public/icon.svg', { force: true });
console.log('Icons written to branding/ and public/.');
