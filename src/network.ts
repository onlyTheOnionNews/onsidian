// requestUrl / request (obsidian.d.ts) over user-installed network bridges (PLAN §6.3). We run no proxy.
// Order: Hoppscotch extension hook (>= 0.35) → userscript bridge → user's own CORS proxy → plain fetch.

export interface RequestUrlParam {
	url: string;
	method?: string;
	contentType?: string;
	body?: string | ArrayBuffer;
	headers?: Record<string, string>;
	throw?: boolean;
}

export interface RequestUrlResponse {
	status: number;
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
	json: any;
	text: string;
}

interface RawResponse {
	status: number;
	headers: Record<string, string>;
	body: ArrayBuffer;
}

type Bridge = { name: string; available(): boolean; send(p: RequestUrlParam): Promise<RawResponse> };

const PROXY_KEY = 'obsidian-online:cors-proxy';
const BRIDGE_MSG = 'obsidian-online-bridge';

export function getCorsProxy(): string {
	try { return localStorage.getItem(PROXY_KEY) ?? ''; } catch { return ''; }
}

export function setCorsProxy(url: string): void {
	try {
		if (url) localStorage.setItem(PROXY_KEY, url);
		else localStorage.removeItem(PROXY_KEY);
	} catch { /* storage blocked: setting just won't persist */ }
}

function headersOf(p: RequestUrlParam): Record<string, string> {
	const h = { ...p.headers };
	if (p.contentType && !Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['Content-Type'] = p.contentType;
	return h;
}

// ---- Hoppscotch extension (MIT): window.__POSTWOMAN_EXTENSION_HOOK__.sendRequest(axiosConfig) ----
const hoppscotch: Bridge = {
	name: 'Hoppscotch extension',
	available() {
		const hook = (window as any).__POSTWOMAN_EXTENSION_HOOK__;
		if (!hook?.sendRequest) return false;
		const v = hook.getVersion?.() ?? { major: 0, minor: 0 };
		// CVE-2024-34714: origin-check bypass in versions before 0.35.
		return v.major > 0 || v.minor >= 35;
	},
	async send(p) {
		const res = await (window as any).__POSTWOMAN_EXTENSION_HOOK__.sendRequest({
			url: p.url, method: p.method ?? 'GET', headers: headersOf(p), data: p.body, wantsBinary: true,
		});
		return { status: res.status, headers: lowerKeys(res.headers ?? {}), body: res.data as ArrayBuffer };
	},
};

// ---- Userscript bridge (public/bridge.user.js): postMessage ↔ GM_xmlhttpRequest ----
let userscriptReady = false;
window.addEventListener('message', (e) => {
	if (e.source === window && e.data?.type === `${BRIDGE_MSG}:ready`) userscriptReady = true;
});
let nextId = 0;
const userscript: Bridge = {
	name: 'Userscript bridge',
	available: () => userscriptReady,
	send(p) {
		const id = ++nextId;
		return new Promise((resolve, reject) => {
			const onMsg = (e: MessageEvent) => {
				if (e.source !== window || e.data?.type !== `${BRIDGE_MSG}:response` || e.data.id !== id) return;
				window.removeEventListener('message', onMsg);
				if (e.data.error) reject(new Error(e.data.error));
				else resolve({ status: e.data.status, headers: lowerKeys(e.data.headers ?? {}), body: e.data.body });
			};
			window.addEventListener('message', onMsg);
			// Same-window message, our origin only.
			window.postMessage({ type: `${BRIDGE_MSG}:request`, id, url: p.url, method: p.method ?? 'GET', headers: headersOf(p), body: p.body }, location.origin);
		});
	},
};

// ---- User's own CORS proxy: "<proxy>?url=<encoded target>" or "<proxy>/<target>" if the proxy URL ends with "/" ----
const proxy: Bridge = {
	name: 'CORS proxy',
	available: () => !!getCorsProxy(),
	async send(p) {
		const base = getCorsProxy();
		const url = base.endsWith('/') ? base + p.url : `${base}${base.includes('?') ? '&' : '?'}url=${encodeURIComponent(p.url)}`;
		return plainFetch({ ...p, url });
	},
};

async function plainFetch(p: RequestUrlParam): Promise<RawResponse> {
	const res = await fetch(p.url, { method: p.method ?? 'GET', headers: headersOf(p), body: p.body, redirect: 'follow' });
	const headers: Record<string, string> = {};
	res.headers.forEach((v, k) => (headers[k] = v));
	return { status: res.status, headers, body: await res.arrayBuffer() };
}

const direct: Bridge = { name: 'Direct (CORS only)', available: () => true, send: plainFetch };

const BRIDGES = [hoppscotch, userscript, proxy, direct];

export function activeBridge(): string {
	return BRIDGES.find((b) => b.available())!.name;
}

function lowerKeys(h: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}

export type RequestUrlResponsePromise = Promise<RequestUrlResponse> & { arrayBuffer: Promise<ArrayBuffer>; json: Promise<any>; text: Promise<string> };

/**
 * Sends through the first available bridge. A plain fetch that fails (TypeError = network/CORS) with no bridge
 * installed gets an actionable error. Like Obsidian, the promise also exposes `.json` / `.text` / `.arrayBuffer`.
 */
export function requestUrl(param: RequestUrlParam | string): RequestUrlResponsePromise {
	const p = send(param) as RequestUrlResponsePromise;
	Object.defineProperties(p, {
		arrayBuffer: { get: () => p.then((r) => r.arrayBuffer) },
		json: { get: () => p.then((r) => r.json) },
		text: { get: () => p.then((r) => r.text) },
	});
	return p;
}

async function send(param: RequestUrlParam | string): Promise<RequestUrlResponse> {
	const p = typeof param === 'string' ? { url: param } : param;
	const bridge = BRIDGES.find((b) => b.available())!;
	let raw: RawResponse;
	try {
		raw = await bridge.send(p);
	} catch (e) {
		if (bridge === direct && e instanceof TypeError) {
			throw new Error(`requestUrl: ${new URL(p.url, location.href).host} blocks browser requests (CORS) — install a network bridge (Settings → Network).`);
		}
		throw e;
	}
	const body = raw.body;
	let textCache: string | undefined;
	const res: RequestUrlResponse = {
		status: raw.status,
		headers: raw.headers,
		arrayBuffer: body,
		get text() { return (textCache ??= new TextDecoder().decode(body)); },
		get json() { return JSON.parse(this.text); },
	};
	if (p.throw !== false && raw.status >= 400) {
		const err: any = new Error(`Request failed, status ${raw.status}`);
		err.status = raw.status;
		err.headers = raw.headers;
		throw err;
	}
	return res;
}

/** Legacy API: resolves to the response text. */
export async function request(param: RequestUrlParam | string): Promise<string> {
	return (await requestUrl(param)).text;
}
