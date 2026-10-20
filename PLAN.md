# obsidian-online — Architecture & Feature Plan

A browser client for Obsidian vaults that aims for full feature parity with the
desktop/mobile apps, and that can run community plugins and themes.

> **Hard constraint: no server hosting.** obsidian-online is a **static, client-only app**: HTML/JS/CSS/wasm
> served from any static host (GitHub Pages, Cloudflare Pages, Netlify, a USB stick served by `npx serve`).
> We operate no backend, proxy, database, or account system. Anything online goes **browser → third-party
> service directly**, and only to services that allow cross-origin (CORS) requests. Real-time collaboration
> is provided by **Relay** (System 3), integrated as a default feature (§7.1).
> *Assumption:* static file hosting is allowed. A secure context is required for OPFS, Service Workers and
> WebCrypto, so `file://` is not a supported way to run the app.

## 0. Ground truth & reference material

**The Obsidian app is closed source.** No official repo contains its implementation.
The parts `obsidianmd` publishes openly are cloned into `../reference/` and act as our spec:

| Repo | What it gives us |
|---|---|
| `obsidian-api` | `obsidian.d.ts` (~11.5k lines), the **complete public plugin API contract**. It is our compatibility target. |
| `obsidian-help` | User docs for every core feature, core plugin, Bases, Sync, Publish. This is our **functional spec**. |
| `obsidian-developer-docs` | CSS variable reference, plugin/theme guidelines, manifest format. This is our **theming contract**. |
| `obsidian-sample-plugin` / `-sample-theme` | Smoke tests for plugin and theme loading. |
| `jsoncanvas` | Open spec for `.canvas` files. |
| `relay` (`No-Instructions/Relay`, MIT) | The Relay collaboration plugin we bundle. It also serves as our hardest plugin-compat test (§7.1). |

Two facts from the reference material drive the design:

1. `obsidian-api` declares a `CapacitorAdapter`. The **mobile app is already a web-tech
   app** (Capacitor WebView). Plugins without `isDesktopOnly` already run without Node or
   Electron, so "mobile-compatible" is effectively "web-compatible". That set is our target.
2. The API adds globals and prototype methods (`createEl`, `createDiv`, `HTMLElement.empty/setText/toggleClass`,
   `Array.prototype.first/last/contains/remove`, `fish`, `sleep`, `activeWindow`…), and
   plugins manipulate the DOM directly. Themes target Obsidian's DOM class names
   (`.workspace-leaf`, `.nav-file-title`, `.markdown-preview-view`, `.cm-s-obsidian`…)
   and its CSS variables.

### Architectural decision: "clean-room re-implementation of the public contract"
- Implement `obsidian.d.ts` faithfully: same class names, same method semantics, same events.
- Reproduce Obsidian's **DOM structure and class names** (from the help docs, the CSS variable docs, and the
  selectors community themes use), not its code.
- **No virtual-DOM UI framework for the workspace.** React/Vue/Svelte would fight plugins that mutate
  the DOM directly. Use vanilla TypeScript and the same `Component`/`View` lifecycle the API defines.
  A framework may be used *inside* our own settings screens only if that proves worth it.
- Do not reuse Obsidian's name, logo or branding in the shipped product (trademark). The vault format is
  open (Markdown + `.obsidian/` JSON) and fine to interoperate with.

---

## 1. Capability tiers (the backbone of all fallbacks)

Every feature is written against a capability probe that runs once at boot, not against
specific browsers. The client degrades **per capability**, not per browser.

```ts
// sketch: boot/capabilities.ts
caps = {
  wasm:        typeof WebAssembly === 'object' && WebAssembly.validate(MIN_MODULE), // false under Safari Lockdown, Edge Enhanced Security (strict), CSP w/o 'wasm-unsafe-eval'
  workers:     typeof Worker === 'function',
  fsAccess:    'showDirectoryPicker' in window,          // Chromium only
  opfs:        !!navigator.storage?.getDirectory,
  idb:         !!indexedDB (probe open; fails in some private modes),
  persist:     await navigator.storage?.persisted?.(),
  webgl:       !!canvas.getContext('webgl2') || !!canvas.getContext('webgl'),
  serviceWorker: 'serviceWorker' in navigator && isSecureContext,
  crypto:      !!crypto?.subtle && isSecureContext,
  clipboard:   permission query 'clipboard-read' / 'clipboard-write',
  mic:         permission query 'microphone',
  notifications, broadcastChannel, sharedArrayBuffer (crossOriginIsolated), localFonts, …
}
```

Rules:
- **WASM is always an accelerator, never the only path.** The exceptions listed in §9 have
  a JS fallback that is slower, or the feature is clearly marked unavailable with a reason.
- **Permissions are requested lazily** at first use, never at boot. A denied permission hides or
  disables only that sub-feature and shows a one-line explanation in the UI and in *Settings → About → Capabilities*.
- *Settings → About → Capabilities* lists every probe result, so support issues can be diagnosed.

---

## 2. UI architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ Shell (boot, capability probe, vault picker, auth, PWA/SW)         │
├────────────────────────────────────────────────────────────────────┤
│ App  (the `app` object plugins receive)                            │
│  ├─ Workspace   split/tabs/leaf tree, sidedocks, ribbon, layout    │
│  ├─ Vault       TAbstractFile tree, events, adapter ↓              │
│  ├─ MetadataCache  links, tags, headings, blocks, frontmatter      │
│  ├─ FileManager    rename + link update, frontmatter processing    │
│  ├─ Keymap/Scope   hotkeys, commands                               │
│  ├─ Plugins (core + community), Themes, CSS snippets               │
│  └─ SecretStorage, Settings (SettingTab / declarative SettingPage) │
├────────────────────────────────────────────────────────────────────┤
│ Views: MarkdownView (CM6 source/live-preview + reading), Canvas,   │
│  Graph, Bases, PDF, Image/Audio/Video, FileExplorer, Search, …     │
├────────────────────────────────────────────────────────────────────┤
│ DataAdapter implementations (pick at runtime, §5.1)                │
│  FsAccessAdapter │ OpfsAdapter │ IdbAdapter │ MemAdapter            │
├────────────────────────────────────────────────────────────────────┤
│ Workers: indexer, search, graph-layout, crypto, sync  (each with   │
│  a main-thread fallback runner behind the same message interface)  │
└────────────────────────────────────────────────────────────────────┘
```

Key points:
- **Single `App` instance per vault, per tab.** Multiple browser tabs on one vault coordinate through
  `BroadcastChannel` and Web Locks: one tab is the *writer leader*, the others forward writes.
  Fallback without BroadcastChannel: a `storage` event on localStorage. If neither exists, show
  "vault open in another tab" and go read-only.
- **Worker boundary:** parsing, indexing, search, graph layout and crypto run off the main thread.
  Each worker module exports a plain async API. A tiny RPC wrapper runs it in a Worker when
  `caps.workers` is true and otherwise in-process, with chunked `requestIdleCallback` / `scheduler.yield()`.
- **Editor:** CodeMirror 6, pinned to the versions `obsidian-api` declares as peer deps
  (`@codemirror/state` 6.7.x, `@codemirror/view` 6.43.x). Plugins register CM6 extensions directly,
  so version drift would break them.
- **Module exposure for plugins:** a `require()` shim maps `obsidian`, `@codemirror/*`,
  `@lezer/*` and `moment` to our singletons (see §6).

## 3. UI design

Reproduce the Obsidian layout so that users, themes and plugins all find what they expect:

- **Ribbon** (left vertical icon strip), **left sidedock** (file explorer, search, bookmarks, tags),
  **root split** (tab groups, arbitrarily nested horizontal/vertical splits, stacked tabs, pinned and linked tabs),
  **right sidedock** (backlinks, outgoing links, outline, properties, tags), **status bar**.
- **Modals:** command palette, quick switcher, settings (two-pane), file/folder suggesters, confirm dialogs.
- **Hover popovers** (page preview), context menus (`Menu` API), `Notice` toasts, tooltips.
- **Responsive / mobile layout:** below ~768px, switch to the mobile workspace model (`WorkspaceMobileDrawer`,
  bottom toolbar, swipe drawers). Add `is-mobile` / `is-phone` / `is-tablet` body classes, since themes and plugins check them.
- **Pop-out windows:** `window.open` sharing the same `App` through `BroadcastChannel` + `activeWindow/activeDocument`.
  Document Picture-in-Picture is used where available. *Fallback:* popup blocked → open as a tab in the main window.
- **Browser-reserved shortcuts** (Ctrl/Cmd+W, N, T, Tab) cannot be captured in a normal tab.
  Handling: (a) when installed as a PWA, more keys are capturable; (b) in fullscreen, use the Keyboard Lock API (Chromium);
  (c) otherwise, use default alternatives (e.g. Alt+W) and show the conflict in the Hotkeys settings.
- **Accessibility:** ARIA roles on the tree, tabs, menus and modals; full keyboard navigation; prefers-reduced-motion.
- **i18n:** load Obsidian-style locale strings; `getLanguage()` API.

## 4. Themes

- **Contract:** the CSS variable set documented in `obsidian-developer-docs/en/Reference/CSS variables`
  (foundations, components, editor, plugins, window) plus Obsidian's DOM classes.
  `theme-light` / `theme-dark` body classes, `--accent-h/s/l`, font variables, `--file-line-width`, etc.
- **Base theme:** we write our own default theme that implements the variable set. Do not copy app.css.
- **Community themes:** fetch `community-css-themes.json` and `theme.css`/`manifest.json` from the theme's repo.
  Install into `.obsidian/themes/<name>/`, same as desktop, so vault folders stay interchangeable.
- **CSS snippets:** `.obsidian/snippets/*.css`, toggled per snippet. Loaded as `<style>` elements, live-reloaded on change.
- **Appearance settings:** base color scheme (light/dark/system via `prefers-color-scheme`), accent color, font
  families (interface/text/monospace), font size, zoom, translucent-window is N/A on web (hidden),
  native vs custom frame is N/A.
  *Local Font Access API* lists installed fonts. *Fallback:* free-text font family input plus a curated web-safe list.
- No WASM needed. Pure CSS.

---

## 5. Core default features

Legend for the **WASM** column: **No** = pure JS/CSS, wasm adds nothing.
**Opt** = optional accelerator, JS path is the default and fully functional.
**Yes\*** = wasm is the practical route, so a fallback is defined.

### 5.1 Vault & files

| Feature | Sub-features | WASM | Implementation / fallback |
|---|---|---|---|
| Vault storage | open local folder, create vault, multiple vaults, vault switcher | No | Adapter chain (below). |
| └ **FsAccessAdapter** | real on-disk folder, edits visible to desktop Obsidian | No | Chromium `showDirectoryPicker`, handle persisted in IDB, re-permission prompt per session. *Not available on Firefox/Safari* → next tier. |
| └ **OpfsAdapter** | fast private browser storage | No | OPFS (all modern browsers). Sync-access handles used inside a worker when available. |
| └ **IdbAdapter** | fallback when OPFS is missing/broken (older Safari, some private modes) | No | IndexedDB blob-per-file. |
| └ **MemAdapter** | last resort: storage fully blocked | No | In-memory, with a loud "nothing will be saved" banner, plus zip import/export. |
| File watching | detect external changes | No | FsAccess: `FileSystemObserver` where available, else poll mtimes on focus/interval. OPFS/IDB: we are the only writer. |
| File operations | create/rename/move/delete/duplicate, drag-drop, multi-select | No | Rename uses `FileManager.renameFile` with link updating. Delete goes to `.trash/` or the system trash; on web, `.trash/` is the only option. |
| Accepted formats | md, canvas, base, images, audio, video, pdf | Opt | Native `<img>/<audio>/<video>`. **HEIC/TIFF**: decode with libheif/utif-wasm. *Fallback:* the file is shown with a "download / preview unavailable" card. |
| Attachments | default location rules, paste/drop images, attachment folder | No | Clipboard and drag-drop `File` objects. |
| Zip import/export | move vaults in/out of the browser | No | `fflate` (JS) in a worker. |
| Symlinks | — | N/A | Not representable in browser storage. Documented as unsupported. |

### 5.2 Editing & formatting

| Feature | Sub-features | WASM | Implementation / fallback |
|---|---|---|---|
| Editor | source mode, **Live Preview**, reading view, toggle per pane | No | CM6 + Lezer markdown with Obsidian extensions (wikilinks, embeds, highlights `==`, comments `%%`, tags, callouts, block ids `^id`, math, footnotes). |
| Obsidian Flavored Markdown | CommonMark, GFM tables/tasks/strikethrough, callouts (foldable, nested), footnotes, math (`$`/`$$`), Mermaid, HTML subset, comments | No | Reading view rendered with a markdown-it/micromark pipeline + `MarkdownPostProcessor` hooks. HTML is sanitized (`sanitizeHTMLToDom` → DOMPurify). |
| Math | inline/block LaTeX | No | MathJax 3 (as Obsidian, `loadMathJax`/`renderMath` API). |
| Diagrams | Mermaid | No | Mermaid lazy-loaded (`loadMermaid`). |
| Code highlighting | reading + editor | No | Prism (`loadPrism`) in reading view; CM6 language packs in the editor. |
| Properties | typed frontmatter UI (text, list, number, checkbox, date, datetime, tags, aliases), property types registry, source/visual toggle | No | YAML via `js-yaml`-compatible `parseYaml/stringifyYaml`. |
| Editing aids | multiple cursors, find/replace (regex), folding (headings/lists/indents), auto-pair, smart lists, drag lines, tab indent, slash commands, editor suggest (`[[`, `#`, `:`) | No | CM6 core. |
| Spellcheck | squiggles, suggestions, language selection | No/Opt | Native browser spellcheck (`spellcheck` attr). Custom dictionaries need an in-app checker: `nspell` (JS) or hunspell-wasm (Opt). *Fallback:* native only, with no custom words. |
| Clipboard | copy/paste rich → markdown, paste images | No | Async Clipboard API (rich paste via `paste` events needs no permission). `htmlToMarkdown` (Turndown-like). *Fallback (permission denied):* keyboard paste events only; "Paste as plain text" via the native shortcut. |
| Word/char count | status bar, selection count, CJK aware | No | `Intl.Segmenter`, with a regex fallback on old Safari. |

### 5.3 Linking & knowledge graph

| Feature | Sub-features | WASM | Implementation / fallback |
|---|---|---|---|
| Internal links | `[[wikilinks]]`, markdown links, heading `#` and block `^` links, aliases, display text, shortest/relative/absolute path formats | No | `MetadataCache` resolution, identical to the API (`getFirstLinkpathDest`, `resolvedLinks`, `unresolvedLinks`). |
| Embeds | note/heading/block transclusion, images with size `|300`, PDFs `#page=`, audio/video, canvas, bases, web embeds | No | Reading + live preview widgets. |
| Metadata indexing | headings, links, embeds, tags, blocks, sections, list items/tasks, footnotes, frontmatter | **Opt** | JS parser in an *indexer worker*, results cached in IDB keyed by mtime+size. **Opt:** a Rust parser (pulldown-cmark/comrak based) compiled to wasm for initial indexing of very large vaults (≫10k notes). *Fallback:* JS worker; if no workers, main thread with idle-time chunking and a progress bar. Correctness is defined by the JS implementation; wasm must pass the same fixture suite. |
| Backlinks / Outgoing links | linked + unlinked mentions, link-to-this, context | No | Derived from the cache. Unlinked mentions use the search worker. |
| **Graph view** | global + local graph, filters, groups/colors, forces, depth, animate timelapse, tags/attachments/orphans toggles | **Opt** | Render with WebGL (PixiJS, as Obsidian does). Physics: `d3-force` in a worker. **Opt:** wasm force simulation (Barnes-Hut) for >20k nodes. *Fallbacks:* no WebGL → Canvas2D renderer (fine to ~3k nodes, auto-reduces labels); no workers → main-thread sim with a lower tick budget; extreme → show a "graph too large" notice with filters. |
| Tags | nested tags, tag pane, rename | No | Cache. |
| Aliases | frontmatter `aliases`, quick switcher matching | No | |

### 5.4 Navigation & search

| Feature | Sub-features | WASM | Implementation / fallback |
|---|---|---|---|
| Quick switcher | fuzzy files + aliases + headings/blocks, create on miss | No | `prepareFuzzySearch` (we implement it, as it is an API function). |
| Command palette | all commands, pinned, recent | No | |
| **Search** | operators `file: path: content: tag: line: block: section: task: task-todo: task-done: match-case: ignore-case:`, `[property:value]`, regex, boolean/grouping, results with context, embedded query blocks, sort | **Opt** | JS: an inverted index (MiniSearch-style) in the search worker, persisted to IDB, with regex/line ops done by scanning candidate files. JS handles ~50k notes. **Opt:** a wasm index (tantivy-like) only if benchmarks demand it. *Fallback:* no worker → main-thread incremental scan. |
| Bookmarks | files, folders, headings, blocks, searches, graphs, URLs, groups | No | `.obsidian/bookmarks.json`. |
| Outline | heading tree, drag to reorder sections | No | |
| Tabs/workspace | tab groups, stacked tabs, pin, link panes, history back/forward, split, workspace layouts saved/restored (`workspace.json`), Workspaces core plugin | No | Browser history API integration (back/forward buttons map to leaf history). |
| Random note, Note composer (merge/extract), Unique note creator, Format converter | | No | |

### 5.5 Structured content

| Feature | Sub-features | WASM | Implementation / fallback |
|---|---|---|---|
| **Canvas** | cards (text/file/link/group), edges with labels/colors, arrange, zoom/pan, embed notes/media/web, JSON Canvas I/O | No | DOM + SVG edges (DOM keeps text editable via embedded CM6). Spec: `reference/jsoncanvas`. Link cards use iframes. *Fallback:* site forbids framing (X-Frame-Options/CSP) → show a plain link card (URL + favicon via `<img>`; no title unfurl, since that would need a proxy). |
| **Bases** | `.base` files and code blocks; filters; formulas; functions; views: **Table, Cards, List, Kanban, Map**; sort/group/summaries; property editing in place | No | Query engine over `MetadataCache` in JS. **Formulas are parsed by our own expression parser. Never `eval`/`Function`** (security + CSP). Table uses a virtualized grid. Map view: Leaflet (Canvas/DOM) by default, MapLibre (WebGL) optional. *Fallback:* no WebGL → Leaflet raster tiles. Tiles need network; offline → "map unavailable offline" placeholder. `BasesView` API exposed for plugin views. |
| Daily notes, Templates, Slides | date formats (moment), template variables `{{date}}` `{{time}}` `{{title}}`, Slides from `---` separators | No | moment.js (API exposes it). |
| Footnotes view, Properties view, Tags view | | No | |

### 5.6 Media & other core plugins

| Feature | Sub-features | WASM | Implementation / fallback |
|---|---|---|---|
| PDF viewer | render, text select, search, outline, `#page=` links, highlight→link | Opt (internal) | pdf.js (`loadPdfJs` API). pdf.js ships optional wasm decoders (JPX/JBIG2) with built-in JS fallbacks. |
| **Audio recorder** | record into vault, playback | **Yes\*** for some formats | `MediaRecorder` gives native `webm/opus` (Chromium/Firefox) or `mp4/aac` (Safari). That is the default, no wasm. Transcoding to mp3/m4a for portability uses ffmpeg/lame-wasm (Opt). *Fallback:* keep the native container. Mic permission denied/absent → command and ribbon hidden, with a notice explaining why. |
| Web viewer | open URLs in a pane, reader mode, save to vault | No | `<iframe sandbox>`. Most major sites refuse framing. *Fallbacks:* (1) reader mode via direct `fetch` + Readability, only for CORS-enabled sites or through a network bridge (§6.3); (2) open in a new browser tab. "Save to vault" works only via (1). |
| File recovery | periodic snapshots, restore, diff | No | Snapshots in IDB (separate from the vault adapter), configurable interval/retention. Diff via `diff-match-patch`. |
| Importer | Markdown, HTML, CSV, Textbundle, Evernote ENEX, Notion zip, Bear, Roam/Logseq JSON, Google Keep (Takeout), Craft, Tomboy, Airtable, OneNote, Apple Notes/Journal | **Yes\*** for SQLite-based sources | JS for XML/zip/JSON/CSV sources. **Apple Notes** reads `NoteStore.sqlite`, which needs **sql.js (wasm)**; *fallback:* "requires WebAssembly", and point the user to the export-to-HTML route. API-based sources must be CORS-enabled and support browser OAuth (PKCE, no client secret). **OneNote** (Microsoft Graph supports SPA PKCE + CORS) is kept, with an app registration that uses our static origin as the redirect URI. **Notion API / Airtable API** are dropped (no browser CORS / secret required) → use their file exports instead (Notion zip, Airtable CSV). |
| Sync, collaboration | see §7 | | |
| Publish | **Removed** (needs hosting). Replaced by "Export vault/folder as static HTML site" (zip) that the user hosts anywhere. | No | Same reading-view renderer, run over a folder and written into a zip with `fflate`. |

### 5.7 App-level

| Feature | Sub-features | WASM | Implementation / fallback |
|---|---|---|---|
| Settings | Editor, Files & links, Appearance, Hotkeys, Core plugins, Community plugins, per-vault `.obsidian/*.json` | No | Read/write the same JSON files as desktop, so a vault opened by both stays consistent. |
| Hotkeys | rebind, conflicts, Mod key mapping | No | See §3 for browser-reserved keys. |
| Obsidian URI | `open`, `new`, `search`, `daily`, `unique`, `choose-vault`, `hook-get-address` | No | Path routes `/v/<vault>/open?file=…`, plus `navigator.registerProtocolHandler('web+obsidian', …)`. Real `obsidian://` cannot be claimed by a website. |
| Offline / install | PWA, works offline | No | Service Worker app-shell cache. *Fallback:* SW disabled (Firefox private, enterprise policy) → app needs network to load, but local vault editing still works once loaded. |
| Storage durability | avoid browser eviction | No | `navigator.storage.persist()` request, plus a warning banner and backup-export nudge if it is denied. |
| Notifications | sync/conflict alerts | No | Notification permission is optional; in-app `Notice` always works. |

---

## 6. Plugin extensibility

**Target:** run unmodified community plugins whose `manifest.json` lacks `isDesktopOnly: true`.

1. **Loader.** Read `.obsidian/plugins/<id>/{manifest.json,main.js,styles.css,data.json}`.
   Evaluate `main.js` as CommonJS: `new Function('require','module','exports', code)` executed via a blob
   `<script>` (so CSP can allow `blob:`, not `unsafe-eval`). Provide a `require()` shim mapping
   `obsidian`, `@codemirror/*`, `@lezer/*` and `moment` to our instances. Node/Electron built-ins
   (`fs`, `path`, `electron`, `child_process`, `crypto`) resolve to **stubs that throw a clear
   "not available on web" error**. `path` gets a real browser polyfill because many mobile-OK plugins import it.
   `Platform.isDesktopApp=false`, `isMobile` per layout, plus a new `Platform.isWeb=true` hint.
2. **API surface.** Implement all of `obsidian.d.ts`. Track coverage with a generated checklist (parse the
   `.d.ts` → list of members → mark implemented), and keep a compatibility dashboard by running the top 100
   community plugins headlessly (Playwright) and recording load errors.
3. **`requestUrl`.** On desktop/mobile, plugins use it to bypass CORS. Page JavaScript and wasm cannot bypass CORS
   or forge `Origin` (forbidden headers, browser-enforced), and we run no proxy. `requestUrl` therefore goes through
   a chain of **user-installed network bridges**, picking the first one available:
   1. **Hoppscotch extension** (MIT, Chrome + Firefox, `reference/hoppscotch-extension`). When the user adds our origin
      to its allowed-origins list, it injects `window.__POSTWOMAN_EXTENSION_HOOK__`, and its background worker
      runs `sendRequest(axiosConfig)` free of CORS. We require **v0.35 or later** via `getVersion()`
      (CVE-2024-34714: an origin-check bypass in older versions). Caveats: the hook is Hoppscotch's internal API, not a
      public contract, so it is wrapped in a small adapter with contract tests and can be dropped if it breaks.
      Binary bodies travel as base64 (slow for large files). The extension requests `<all_urls>` + `cookies`.
   2. **Userscript bridge.** We publish a ~30-line userscript for Violentmonkey (MIT) / Tampermonkey that relays
      `postMessage` ↔ `GM_xmlhttpRequest`. Every target host must be declared with `@connect`, and the manager asks
      the user before contacting a new host, which gives per-domain consent. The bridge checks `event.origin`/`event.source`
      and accepts only our message types.
   3. **Settings → Network → "CORS proxy URL"** (empty by default). It is a bring-your-own setting for users who run
      their own proxy (e.g. a Cloudflare Worker template we document). We never host one.
   4. **Plain `fetch`.** It works for CORS-enabled hosts. Any other host fails with a clear
      `requestUrl: <host> blocks browser requests (CORS) — install a network bridge` error, shown in the plugin list.
   *Settings → Network* shows which bridge is active. Bridges are never installed or enabled by us, and
   "Allow CORS"-style header-rewriting extensions are explicitly **not** supported or recommended, because they
   disable CORS for every site the user visits.
   *Later option:* our own narrow extension (MV3, `externally_connectable` locked to our origin, optional host
   permissions granted per domain). Build it only if the Hoppscotch hook breaks or a narrower permission set
   becomes a requirement. Store costs: Chrome $5 one-time, Firefox and Edge free, Safari $99/yr + Xcode/macOS.
4. **Distribution.** Browsing works without a server: `community-plugins.json` / `community-css-themes.json`
   come from `raw.githubusercontent.com`, and release metadata from `api.github.com` (both send
   `Access-Control-Allow-Origin: *`, verified 2026-10-19). **Downloading release assets does not:**
   `github.com/.../releases/download/...` redirects without CORS headers, and the final
   `release-assets.githubusercontent.com` URL has none either (verified 2026-10-19). Install order:
   1. jsDelivr `cdn.jsdelivr.net/gh/<repo>@<tag>/<file>` (CORS-enabled), which works only when the plugin commits
      `main.js`/`styles.css`/`manifest.json` to its repo at that tag. Many do not.
   2. Through any active network bridge (item 3). This fetches the real GitHub release assets, the same as desktop.
   3. **Manual install:** drop the plugin's zip/folder (downloaded from GitHub by the user) onto the plugin settings page.
   Themes are usually plain repo files (`theme.css`, `manifest.json`), so the jsDelivr route nearly always works for them.
5. **Security model.** As on desktop, **community plugins are fully trusted code**. Keep **Restricted mode on by default**,
   with an explicit opt-in and per-plugin warnings. Bundled plugins (Relay, §7.1) are exempt: they are pinned by version
   and SHA-256 at build time. Web-specific notes:
   - We hold no secrets of our own (no accounts, no sessions). Plugin secrets (e.g. Relay tokens, `SecretStorage`)
     live in browser storage on this origin and are readable by other plugins, which is the same trust model as desktop.
   - Strict CSP for scripts (`script-src 'self' blob:`; `wasm-unsafe-eval` only when wasm is on). `connect-src` must
     stay open (`https: wss:`), because plugins and Relay (including user self-hosted relay servers) reach arbitrary hosts.
   - **Later option:** a "sandboxed plugin" mode running plugins in a cross-origin iframe/worker with an RPC bridge.
     It is safer but breaks DOM-mutating plugins, so it is opt-in per plugin. YAGNI until the compat mode works.
6. **Plugin DX.** The official `obsidian-sample-plugin` must load and pass; add a dev mode that hot-reloads a plugin
   from a local folder (FsAccess) or a `localhost` URL.
7. **Themes & snippets** follow the same install path (§4).

WASM: none required for the plugin host. Plugins that ship their own wasm (e.g. some PDF/OCR/diagram plugins)
work only when `caps.wasm`. Their failure is caught and the plugin is marked "needs WebAssembly" in the plugin list.

---

## 7. Online functionality (client-only)

With no server of ours, "online" means: **Relay for collaboration and shared-folder sync**, plus direct
browser connections to services the user already has. Everything else works offline.

### 7.1 Relay: real-time collaboration (default feature)

[Relay](https://github.com/No-Instructions/Relay) by System 3 (MIT, `id: system3-relay`, v0.8.12, `isDesktopOnly: false`)
adds live multiplayer editing, cursors/presence, shared folders with access management, and background sync of shared
folders, including attachments and canvas. It runs on Yjs and is pure JS, so **no wasm** is needed. System 3 runs the relay
servers (free + paid tiers), and users can also point Relay at a **self-hosted relay server**. Both are outside our hosting.

**Integration approach: bundle the unmodified upstream plugin; do not re-implement it.**
- The build step downloads a **pinned** Relay release from GitHub (at build time, so CORS does not apply), verifies its
  SHA-256 and ships it inside the static app as a *bundled plugin*. Upgrades are a deliberate version bump + compat test run.
- It is **enabled by default** and listed under Core plugins as "Relay (collaboration)", where it can be switched off.
  It stays dormant (no shared folders) until the user signs in to Relay. Onboarding states that enabling it contacts
  System 3's servers.
- **Vault interop:** if a vault already contains `.obsidian/plugins/system3-relay/` (installed by desktop Obsidian), we load
  our bundled code but **reuse that folder's `data.json`**, so settings and shared-folder bindings stay the same on both.
  We never load two copies. If the vault's copy is newer than ours, show a notice instead of silently downgrading behavior.
- **Multiple tabs:** only the writer-leader tab (§2) runs Relay's connections; other tabs get updates through the vault events.

**What Relay needs from our host** (found by reading its source in `../reference/relay/src`):
- Public API: `requestUrl`, `Platform`, `apiVersion`, `MarkdownView`, `TextFileView`, `MetadataCache`, `Vault`, CM6
  extensions (pinned `@codemirror/state`/`view` versions must stay compatible with what Relay was built against).
- **Private internals it monkey-patches** (via `monkey-around`): `MarkdownView.prototype`, `TextFileView` methods
  (`requestSave`, `save`, `setViewData`, `onUnloadFile`, `setState`), `MetadataCache.prototype`, `app.vault` methods
  (`modify`, `process`, `getConfig`), `previewMode.render`, `app.plugins.plugins`, and the **Canvas view internals**
  (canvas object, nodes, embed views, `requestSave`, `markViewportChanged`). These names and call orders must match
  Obsidian's real behavior, so **Relay is our reference test for internal-API fidelity**. A Playwright suite
  (two browser contexts editing one shared folder) gates every release.
- `Platform.isDesktopApp` must be `false`, so that Relay uses `requestUrl` and not its Node HTTP path (`NodeHttp.ts`).
- Svelte UI with a Trusted Types policy, which is fine under our CSP.

**Browser network check (verified 2026-10-19, from a foreign origin):**
| Endpoint | Result |
|---|---|
| `auth.system3.md` (PocketBase auth) | `Access-Control-Allow-Origin: *`, preflight OK. |
| `api.system3.md` API routes (`/token`, `/file-token`, `/flags`, `/relay/...`) | Origin reflected, `authorization, content-type, relay-version` headers allowed. |
| `api.system3.md/health` | **No CORS headers.** Relay's health ping fails in-browser. It must be harmless (to verify in phase 5); if it is not, add a small shim in `requestUrl` that answers health checks as "unknown". |
| Relay WebSocket servers | Not CORS-bound. Need to verify they do not reject our `Origin`. |
| Attachment/blob storage URLs (CAS / background sync) | **To verify:** signed storage URLs must allow CORS. |
| OAuth login | `window.open` popup from a click, plus PocketBase realtime (SSE), which work in browsers. *Fallback:* popup blocked → show a link the user clicks. |

**Before shipping:** confirm with System 3 that a non-Obsidian web client using their service is acceptable under their
terms, and report our client honestly in request headers (`apiVersion` = the API version we actually implement).

**Fallbacks:** offline or Relay unreachable → local editing continues and Yjs merges on reconnect; Relay disabled or
blocked → the app is a fully local editor; wasm and permissions are irrelevant (Relay uses neither).

### 7.2 Other online facets

| Facet | Status | Implementation / fallback |
|---|---|---|
| Accounts | **Removed.** | No accounts of our own. Relay has its own login. |
| Our sync service / remote vaults / E2E sync | **Removed.** | Cross-device sync comes from: (a) **Relay shared folders**; (b) **same folder as desktop** via FsAccess (Chromium), letting the user's existing sync (Obsidian Sync on desktop, Dropbox/OneDrive/iCloud clients) do the work; (c) community sync plugins that use CORS-enabled APIs (e.g. Remotely Save with Dropbox/OneDrive) when they run in our plugin host. |
| Git sync | **Removed.** | GitHub's git HTTP endpoint lacks CORS. It is possible only with a user-supplied CORS proxy, via the generic plugin path. |
| Official Obsidian Sync / Publish | **Not possible.** | Private APIs. We do not reverse-engineer them. |
| Publish | **Replaced.** | "Export as static site" zip (§5.6) for the user to host anywhere. |
| Link unfurl, web-viewer reader proxy | **Removed / degraded.** | See §5.5 and §5.6 fallbacks. |
| Version history | Kept, local. | File recovery snapshots (§5.6) plus Relay's own history for shared folders. |
| Web clipper | Kept. | PWA `share_target` (installed PWA) and a bookmarklet that opens the app and hands content over via `postMessage`. Content is never put in the URL. |
| Offline / install | Kept. | Service Worker app shell, PWA manifest. |
| Settings across devices | Manual. | Export/import `.obsidian` settings as a zip. |

---

## 8. Tech stack (proposed)

- **Client:** TypeScript, Vite, vanilla DOM (+ our `createEl` helpers), CodeMirror 6, Lezer, markdown-it (or micromark),
  MathJax 3, Mermaid, Prism, pdf.js, PixiJS + d3-force, Leaflet, DOMPurify, fflate, diff-match-patch, moment, Readability.
- **Bundled plugin:** Relay (pinned release + SHA-256, vendored at build time).
- **WASM modules (all lazy-loaded, all optional):** sql.js (Apple Notes import), libheif/utif (HEIC/TIFF preview),
  lame/ffmpeg (audio transcode), later: Rust md indexer and force-sim **only if benchmarks show a need**.
- **Hosting:** static files only (GitHub Pages / Cloudflare Pages / any static host). **No server.**
- **Tests:** Vitest for units, a fixture vault with expected `CachedMetadata` JSON (the indexer contract), Playwright for UI + plugin compat runs
  across Chromium/Firefox/WebKit, plus runs with **wasm disabled** (`--js-flags=--noexpose_wasm`) and **workers disabled** to keep fallbacks honest,
  and a two-context Relay collaboration suite.

## 9. WASM decision summary

| Facet | Needs wasm? | Why / fallback |
|---|---|---|
| UI, workspace, themes, settings | No | DOM/CSS work. |
| Editor (CM6), rendering, math, mermaid | No | Mature JS libraries; the API mandates them. |
| Metadata indexing | Optional | JS worker is adequate; wasm only for huge-vault cold start. |
| Search | Optional | JS inverted index; wasm only if benchmarks fail. |
| Graph view | Optional | Rendering bottleneck is GPU (WebGL), not JS. wasm physics for >20k nodes; Canvas2D fallback for no WebGL. |
| Canvas, Bases, Daily notes, Templates | No | |
| PDF | Internal | pdf.js has wasm decoders with its own JS fallback. |
| Relay collaboration | No | Yjs is pure JS. |
| Apple Notes import | **Yes** | SQLite reader; fallback: export-to-HTML guidance. |
| HEIC/TIFF previews | **Yes** | No native decoder outside Safari; fallback: download card. |
| Audio transcode | Optional | Native MediaRecorder container is the default. |
| Plugin host | No | Plugins with their own wasm are flagged when wasm is off. |

(The sync-encryption KDF row was dropped along with our own sync service.)

## 10. Phased roadmap

**Status (2026-10-20):** phases 1–4 are done. Phase 4: note core plugins, file recovery, graph view, Canvas, Bases (4 core layouts; Map comes from the official Maps plugin through `registerBasesView`), pdf.js viewer, web viewer, importer, static-site export.
- **Plugins:** 36 of the top 50 mobile-compatible plugins load cleanly (`docs/plugin-compat.md`). API coverage is 128/159 runtime exports (`npm run api-coverage`).
- **Installs:** only 1 of the top 40 plugins is installable via jsDelivr, so one-click installs need a network bridge (§6.3) or manual install. See open question 6.

Known gaps carried forward, each marked `ponytail:` in code:
- Search is a main-thread linear scan; the metadata index isn't persisted between sessions.
- `.obsidian/types.json` (explicit property types) isn't read or written.
- Root splits can't be resized; there are no stacked tabs, pop-out windows, or drag-and-drop in the explorer.
- PDFs use the browser's built-in viewer (pdf.js in phase 4).
- Reading view re-renders the whole note on each change.
- Conflicting external edits: unsaved local edits win (merging comes in phase 5).
- Graph view is Canvas 2D with physics on the main thread (worker/WebGL for very large vaults).
- Canvas text cards edit in a plain textarea, not a full editor.
- PDF view has no outline sidebar or annotation tools.
- Importer has no OneNote (needs a Microsoft app registration for the hosted origin) or Apple Notes (needs SQLite via wasm).
- Bases filter editing is in the YAML source; the toolbar covers views, layout, sort, properties, grouping and view settings.
- Main bundle is 1.36 MB (423 KB gzipped); lazy-loading core plugins is a phase 6 task.

1. **Foundation:** capability probe, adapters (FsAccess/OPFS/IDB/Mem), Vault + events, MetadataCache (JS worker + fixtures),
   workspace (splits/tabs/sidedocks), file explorer, CM6 source + reading view, default theme with full CSS variable set.
2. **Editor parity:** Live Preview, properties UI, embeds, callouts, math/mermaid, quick switcher, command palette, hotkeys,
   search (all operators), backlinks/outgoing/outline/tags/bookmarks, settings persisted to `.obsidian/`.
3. **Plugin & theme host:** `require` shim, API coverage tracker, community browser (raw/jsDelivr/manual install), Restricted mode,
   sample-plugin + top-50 plugin compat CI.
4. **Visual features:** graph view, canvas, Bases (all 5 layouts), PDF, media, file recovery, templates/daily notes/slides,
   web viewer, importer (JS formats + OneNote PKCE), static-site export.
5. **Relay + offline:** private-internal fidelity work (MarkdownView/TextFileView/MetadataCache/Canvas), vendored Relay
   build step, two-context collab test suite, the remaining CORS checks from §7.1, PWA/offline, web clipper.
   Canvas internals arrive in phase 4, so Relay comes after it.
6. **Perf pass:** benchmark 1k/10k/50k-note vaults; add the optional wasm accelerators only where JS misses targets
   (e.g. cold index of 10k notes < 5s, search keystroke < 50ms, graph 60fps at 5k nodes).

## 11. Open questions (need owner decisions)

1. **Static host:** GitHub Pages, Cloudflare Pages, or other, and the domain? (Relay's API reflects any origin, so this does not block Relay.)
2. **System 3 terms:** who contacts System 3 to confirm a web client may use Relay's hosted service?
3. **Network bridges:** OK to depend on the Hoppscotch extension's internal hook (§6.3), or build our own extension from the start?
4. **Plugin trust default:** ship with community plugins available (Restricted mode opt-out) or curated allow-list only?
5. **Licensing/name:** the product name must avoid implying it is an official Obsidian product.
6. **Plugin installs without a bridge:** only 1 of the top 40 plugins publishes `main.js` where jsDelivr can serve it. Option: a scheduled GitHub Actions job that mirrors release files of an allow-listed set of plugins into the static site (static hosting, no server), so installs work with no bridge. This also makes the app a redistributor of those plugins, so check their licenses first.
