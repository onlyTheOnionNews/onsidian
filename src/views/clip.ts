// Clip payloads and the bookmarklet (the clipper's trust boundary), kept free of DOM/app imports so they test in Node.

export interface Clip {
	title: string;
	url: string;
	/** Whole page HTML (bookmarklet) — Readability picks the article. */
	html?: string;
	/** Selected or shared plain text. */
	text?: string;
}

// Keeps the earlier name: bookmarklets people already saved send this id.
export const MSG = 'obsidian-online-clip';
const MAX = 20 * 1024 * 1024;
const str = (v: unknown, max = MAX) => (typeof v === 'string' && v.length <= max ? v : '');

/** Validate an untrusted clip payload; null if it isn't one. */
export function parseClip(data: unknown): Clip | null {
	const d = data as Record<string, unknown> | null;
	if (!d || d.type !== MSG) return null;
	const url = str(d.url, 8192);
	if (url && !/^https?:\/\//i.test(url)) return null;
	const clip = { title: str(d.title, 1000).trim(), url, html: str(d.html), text: str(d.text) };
	return clip.html || clip.text || clip.url ? clip : null;
}

/** The bookmarklet: opens this app, waits for it to say ready, then sends the page only to this app's origin. */
export function bookmarklet(appUrl: string): string {
	const origin = new URL(appUrl).origin;
	const target = `${appUrl.split(/[?#]/)[0]}?clip=1`;
	const code = `(()=>{const w=open(${JSON.stringify(target)});if(!w)return alert('Allow pop-ups to clip.');const s=String(getSelection()),d={type:${JSON.stringify(MSG)},title:document.title,url:location.href,text:s,html:s?'':document.documentElement.outerHTML};const h=e=>{if(e.source===w&&e.origin===${JSON.stringify(origin)}&&e.data===${JSON.stringify(`${MSG}-ready`)}){w.postMessage(d,${JSON.stringify(origin)});removeEventListener('message',h)}};addEventListener('message',h)})()`;
	return `javascript:${encodeURIComponent(code)}`;
}
