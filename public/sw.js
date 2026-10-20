// Offline app shell (PLAN §5.11). Install precaches every build file listed in asset-manifest.json, including the
// lazily loaded parts (pdf.js, MathJax, Mermaid), so the whole app works offline. Vault data never passes through here.
// ponytail: no skipWaiting: a new version takes over once every tab of the old one is closed, so a running tab never
// loses the lazy chunks it was built with. Add an "update available, reload" prompt if updates feel slow.
const scope = self.registration.scope;
let current = '';

self.addEventListener('install', (e) => e.waitUntil((async () => {
	const text = await (await fetch('asset-manifest.json', { cache: 'no-cache' })).text();
	const urls = new Set(['./', 'manifest.webmanifest', 'icon.svg']);
	for (const c of Object.values(JSON.parse(text))) for (const f of [c.file, ...(c.css ?? []), ...(c.assets ?? [])]) urls.add(f);
	const cache = await caches.open(await cacheName(text));
	await cache.addAll([...urls]);
})()));

self.addEventListener('activate', (e) => e.waitUntil((async () => {
	const keep = await cacheName(await (await fetch('asset-manifest.json', { cache: 'no-cache' })).text()).catch(() => null);
	if (keep) for (const k of await caches.keys()) if (k.startsWith('app-') && k !== keep) await caches.delete(k);
	await self.clients.claim();
})()));

async function cacheName(manifestText) {
	if (current) return current;
	const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(manifestText)));
	return (current = `app-${[...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')}`);
}

self.addEventListener('fetch', (e) => {
	const req = e.request;
	const url = new URL(req.url);
	if (req.method === 'POST' && url.href === new URL('share', scope).href) return e.respondWith(share(req));
	if (req.method !== 'GET' || url.origin !== location.origin) return;
	// Pages: network first (fresh deploys), cached shell offline. Build files are content-hashed: cache first.
	if (req.mode === 'navigate') e.respondWith(fetch(req).catch(() => caches.match(new URL('./', scope).href, { ignoreVary: true })));
	// ignoreVary: module scripts are requested with an Origin header the precache request lacked (servers send Vary: Origin).
	else e.respondWith(caches.match(req, { ignoreVary: true }).then((r) => r ?? fetch(req)));
});

// PWA share target: stash the shared title/text/url for the app to pick up, then open it. Nothing goes in the URL.
async function share(req) {
	const f = await req.formData();
	const d = { title: String(f.get('title') ?? ''), text: String(f.get('text') ?? ''), url: String(f.get('url') ?? '') };
	await (await caches.open('share-target')).put('shared', new Response(JSON.stringify(d), { headers: { 'content-type': 'application/json' } }));
	return Response.redirect(new URL('./?share=1', scope).href, 303);
}
