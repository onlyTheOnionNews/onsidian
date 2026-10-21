<p align="center">
  <img src="public/logo.svg" alt="onsidian logo: a crystal lowercase o inside a capital O" width="160">
</p>

<h1 align="center">onsidian</h1>

<p align="center">
  A browser client for Markdown vaults that works like Obsidian, runs community plugins, and needs no server.
</p>

> **Not affiliated with Obsidian or Dynalist Inc.** onsidian is an independent, clean-room implementation of the
> public plugin API (`obsidian.d.ts`). It reads and writes ordinary Obsidian vaults, so the same folder works in both.

---

## Contents

- [What it is](#what-it-is)
- [Features](#features)
- [Where your notes live](#where-your-notes-live)
- [Community plugins](#community-plugins)
- [Network access and CORS](#network-access-and-cors)
- [Collaboration with Relay](#collaboration-with-relay)
- [Offline use, installing, and the web clipper](#offline-use-installing-and-the-web-clipper)
- [Browser support](#browser-support)
- [Performance](#performance)
- [Getting started (development)](#getting-started-development)
- [Project layout](#project-layout)
- [Testing](#testing)
- [Hosting it yourself](#hosting-it-yourself)
- [Known limitations](#known-limitations)
- [Status and roadmap](#status-and-roadmap)
- [License and credits](#license-and-credits)

## What it is

onsidian is a static web app: HTML, JavaScript and CSS that any static host can serve. All work happens in your
browser. There is no account, no backend and no sync server run by this project. The architecture and every design
decision are written up in [PLAN.md](PLAN.md).

It reproduces Obsidian's documented behavior and its DOM and CSS-variable conventions. That lets most themes, CSS
snippets and community plugins work unchanged. When a browser lacks something (File System Access, Web Workers,
WebAssembly, Service Workers, a permission), only that feature degrades, with a fallback or an explanation. The
rest of the app keeps working.

## Features

**Editing**
- CodeMirror 6 editor with **Live Preview** and plain source mode, plus a **reading view**.
- Wikilinks and Markdown links, embeds (`![[note]]`, `![[note#heading]]`, `![[note#^block]]`, images, PDFs, audio, video).
- Callouts, task lists, footnotes, highlights, math (MathJax, loaded on demand), Mermaid diagrams, syntax highlighting.
- Frontmatter **properties** editor, tags, aliases.
- Unsaved edits merge with changes made elsewhere: a 3-way merge, with a "conflicted copy" note when both sides changed the same lines.

**Navigation and workspace**
- File explorer, tabs, splits, sidebars, pinned tabs, history (back/forward), layout saved per vault.
- Quick switcher, command palette, customizable hotkeys.
- Search with Obsidian's operators: `file:`, `path:`, `content:`, `tag:`, `line:`, `block:`, `section:`, `task:`, `[property:value]`, `/regex/`, `OR`, `-`, quotes, and match case.
- Backlinks, outgoing links, outline, tags view, bookmarks, page preview on hover.

**Core plugins** (switch each on or off under *Settings → Core plugins*)

| | | |
|---|---|---|
| Backlinks | Bases (table, cards, list, kanban; formulas; plugins can add views such as Maps) | Bookmarks |
| Canvas (JSON Canvas 1.0) | Daily notes | File recovery (snapshots) |
| Graph view (global and local) | Importer (Markdown, HTML, CSV, Evernote .enex, Notion export, Google Keep Takeout) | Note composer |
| Outgoing links | Outline | PDF viewer (pdf.js) |
| Page preview | Random note | Search |
| Slides | Static site export (zip of HTML pages) | Tags view |
| Templates | Unique note creator | Web clipper |
| Web viewer (with reader mode) | Word count | |

**Appearance**
- Light and dark themes, accent color, fonts, CSS snippets, and community themes from `.obsidian/themes/`.

## Where your notes live

You choose where each vault is stored. The vault picker lists every vault you have opened.

| Storage | Browsers | Notes |
|---|---|---|
| **A folder on your disk** (File System Access) | Chrome, Edge, Opera, other Chromium | Same folder desktop Obsidian uses. Changes made outside the app are picked up. The browser asks again for permission after a restart. |
| **Browser storage: OPFS** | All modern browsers | Private to this site in this browser. Fast. |
| **Browser storage: IndexedDB** | Fallback when OPFS is unavailable | Same, slower. |
| **Memory** | Last resort (for example, some private windows) | Lost when the tab closes. |

Things to know about browser storage:
- **Browsers can clear it** when the device runs low on space or when site data is cleared. onsidian requests
  persistent storage, and warns you if a vault that used to have notes opens empty. **Keep a backup:**
  the command palette's *Export vault as .zip*, and *Import .zip into vault* to restore.
- **One tab per vault.** A second tab offers to take the vault over, and the first tab saves and hands it off.

The vault format is plain Obsidian: Markdown files plus a `.obsidian/` folder. The window layout is kept in
`.obsidian/workspace-web.json`, so it never overwrites desktop Obsidian's `workspace.json`.

## Community plugins

- Browse the community directory, or install from files: a release `.zip`, or `manifest.json` + `main.js` (+ `styles.css`).
- Plugins installed by desktop Obsidian in the vault's `.obsidian/plugins/` folder are picked up.
- **Restricted mode is on by default**, per device and per vault. A plugin runs with full access to the vault and to
  anything the page can reach, so turn plugins on only if you trust them.
- **Compatibility:** in a load-time test of the 50 most-downloaded mobile-compatible plugins, 35 load cleanly and the
  rest hit missing internals or desktop-only APIs. See [docs/plugin-compat.md](docs/plugin-compat.md) for the
  per-plugin table. Plugins marked desktop-only need Node.js or Electron and can't run in a browser.

## Network access and CORS

Browsers block a page from reading most other websites (CORS). onsidian runs no server and no proxy, so requests
from plugins (`requestUrl`), one-click plugin installs from GitHub, and the web viewer's reader mode use the first
**network bridge** available:

1. The **Hoppscotch browser extension** (v0.35 or later).
2. The **userscript bridge** (Tampermonkey or Violentmonkey). Install it from *Settings → Network*. Your userscript
   manager asks before each new site.
3. **Your own CORS proxy**, entered in *Settings → Network*.
4. A plain request, which works only for sites that allow cross-origin requests.

Without a bridge, plugins that call web APIs fail, and you install plugins from files instead.

## Collaboration with Relay

[Relay](https://github.com/No-Instructions/Relay) by System 3 (MIT) adds real-time collaboration: live cursors,
shared folders and access management. onsidian ships it **built in**:
- A pinned release (currently 0.8.12) is downloaded at build time and checked against SHA-256 hashes in
  [relay.lock.json](relay.lock.json). A mismatch fails the build.
- It is **on by default**, works in Restricted mode, and can be turned off (but not uninstalled) under
  *Settings → Community plugins*.
- Its settings live in the vault's `.obsidian/plugins/system3-relay/`, shared with desktop Relay. If the vault contains
  its own Relay install, that copy is used instead.
- Relay stays inactive until you sign in. **Signing in connects to System 3's servers** under their terms.

To change the Relay version, review the release, then run `node scripts/vendor-relay.mjs --update <version>`.

## Offline use, installing, and the web clipper

- **Offline:** a production build installs a Service Worker that caches the whole app, including parts loaded on
  demand such as pdf.js, MathJax, Mermaid and Relay. After one visit, the app opens without a network connection.
- **Install:** use your browser's *Install* menu item to get onsidian as an app with its own window.
- **Share to onsidian:** once installed, onsidian appears in your device's share sheet. Shared links and text become a note.
- **Bookmarklet:** drag the link from *Settings → Web clipper* to your bookmarks bar. On any page, click it to save the
  article, or your selection, as a note. The page goes only to onsidian's own origin. The HTML is sanitized, and you
  confirm each clip before it's saved.

## Browser support

| Browser | Status |
|---|---|
| Chrome, Edge, Opera, Brave (desktop) | Full support, including vaults in folders on disk |
| Firefox, Safari (desktop) | Full support with vaults in browser storage; no folder vaults |
| Mobile browsers | Works; the UI isn't tuned for small screens yet |

The app needs a secure context (`https://` or `localhost`) for OPFS, Service Workers and the Web Crypto API. Every
feature checks the capabilities it needs, so blocked features (WebAssembly disabled, workers blocked by policy,
private windows) degrade one at a time.

## Performance

Measured on a 10,000-note vault ([docs/performance.md](docs/performance.md) has all numbers and how to reproduce them):

| | Result |
|---|---|
| Reopen a vault until fully indexed | 3.6 s (the first open takes 7.8 s) |
| Search, common queries | 12–96 ms |
| Graph view frame | 1–11 ms; the layout runs in a worker |
| Create a note | 4 ms |

The metadata index is saved in IndexedDB, so reopening a vault re-parses only notes that changed. No WebAssembly is
needed. Larger vaults work: 50k notes reopen in about 25 s and use about 860 MB of memory.

## Getting started (development)

Requirements: Node.js 20 or later and npm.

```bash
git clone https://github.com/onlyTheOnionNews/onsidian.git
cd onsidian
npm install
npm run dev        # http://localhost:5173
```

The first `npm run dev` or `npm run build` downloads the pinned Relay release (network needed once).

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server with hot reload (no Service Worker) |
| `npm run build` | Type-check, then production build into `dist/` |
| `npx vite preview` | Serve `dist/` to try the production build: offline, install, share target |
| `npm test` | Unit tests (Vitest) |
| `npm run icons` | Regenerate the logo and every favicon/app icon from `scripts/build-icons.mjs` |
| `npm run vendor:relay` | Download and verify the pinned Relay release |
| `npm run compat:fetch` | Download the top community plugins for the compatibility page |
| `npm run api-coverage` | Report how much of the `obsidian` API surface is implemented |
| `npm run css-coverage` | Report coverage of Obsidian's CSS variables |

Development-only pages, served by `npm run dev`:
- `/compat.html`: loads each downloaded community plugin and records errors (`?only=<plugin-id>` for one).
- `/bench.html?n=10000`: generates a synthetic vault of *n* notes and times startup, search, graph and reading view.

Diagnostics: set `window.__obsidianOnlineDiagnose = true` before plugins load to log every `app.*` / `obsidian.*`
member a plugin reads that isn't implemented. The results are in `window.__obsidianOnlineMissing`.

## Project layout

```
src/
  main.ts            boot, vault picker, opening vaults, tab takeover
  caps.ts            capability probe
  app.ts             App: vault, workspace, metadata cache, plugins
  adapters.ts        storage backends (folder / OPFS / IndexedDB / memory)
  vault.ts           Vault, TFile/TFolder, config files
  parse.ts           Markdown → CachedMetadata (runs in workers)
  metadata.ts        MetadataCache, link resolution, worker pool
  indexstore.ts      persisted metadata index
  search.ts          search query language
  workspace.ts       splits, tabs, leaves, layout
  editor.ts, livepreview.ts   CodeMirror 6 editor and Live Preview
  render.ts          Markdown rendering for reading view and embeds
  plugins.ts         community plugin host, Restricted mode, bundled plugins
  api.ts             the `obsidian` module exposed to plugins
  network.ts         requestUrl and the network bridges
  merge.ts           3-way merge
  bases/             Bases: formula language, values, views
  views/             explorer, editor view, graph, canvas, PDF, search, panels, importer, export, clipper, …
public/              Service Worker, web app manifest, icons, bundled plugins (generated)
scripts/             Relay vendoring, icon generation, coverage and compatibility tools
test/                unit tests and fixtures
docs/                plugin compatibility and performance reports
branding/            full-resolution logo (PNG 4096×4096, SVG)
```

## Testing

```bash
npm test
```

The unit tests cover the Markdown parser, vault and metadata cache (memory and IndexedDB), the persisted index, the
search language, the Bases formula language, the 3-way merge, the clipper's input validation and the reading view's
note splitter. One test fails on purpose when `src/parse.ts` changes without a `PARSER_VERSION` bump, so stale saved
indexes are never used.

Feature behavior is checked in a browser: `/compat.html` for plugins and `/bench.html` for performance.

## Hosting it yourself

`npm run build` writes a static site to `dist/`. Copy it to any static host: GitHub Pages, Cloudflare Pages, Netlify,
S3, or nginx. Requirements:
- **HTTPS** (or `localhost`).
- Serve `.webmanifest` as `application/manifest+json` (most hosts already do).
- The app expects to be served from the site root. A sub-path needs Vite's `base` option set in `vite.config.ts`.

No server-side code, database or environment variables are involved.

## Known limitations

- Desktop-only plugins (those needing Node.js or Electron) can't run. Some plugins that reach into undocumented
  Obsidian internals fail; see [docs/plugin-compat.md](docs/plugin-compat.md).
- Folder vaults on disk need a Chromium browser.
- Browser-storage vaults can be cleared by the browser; keep zip backups.
- No Vim mode yet.
- No pop-out windows, stacked tabs, or drag-and-drop in the file explorer; side panels can't be resized yet.
- The importer has no OneNote (it needs a Microsoft app registration for the hosting domain) or Apple Notes support.
- Search scans note text directly (no inverted index). It's fast to about 10k notes and slower beyond that.
- The Relay signed-in collaboration flow hasn't been tested end to end yet.

More detail, with each simplification and its upgrade path: [PLAN.md](PLAN.md) (status section) and
[docs/performance.md](docs/performance.md).

## Status and roadmap

All six phases in [PLAN.md](PLAN.md) are done: foundation, editor, plugin and theme host, visual features, Relay and
offline, and the performance pass. Open questions that need an owner decision (hosting domain, System 3's terms for
Relay, plugin trust defaults, licensing) are listed at the end of PLAN.md.

## License and credits

**No license has been chosen yet** (PLAN.md, open question 5). Until one is added, all rights are reserved.

Built on: [CodeMirror 6](https://codemirror.net/), [markdown-it](https://github.com/markdown-it/markdown-it),
[DOMPurify](https://github.com/cure53/DOMPurify), [MathJax](https://www.mathjax.org/), [Mermaid](https://mermaid.js.org/),
[pdf.js](https://mozilla.github.io/pdf.js/), [Prism](https://prismjs.com/), [d3-force](https://d3js.org/d3-force),
[Lucide](https://lucide.dev/) icons, [Moment.js](https://momentjs.com/), [js-yaml](https://github.com/nodeca/js-yaml),
[fflate](https://github.com/101arrowz/fflate), [Readability](https://github.com/mozilla/readability),
[node-diff3](https://github.com/bhousel/node-diff3), and [Relay](https://github.com/No-Instructions/Relay) by System 3 (MIT).

"Obsidian" is a trademark of Dynalist Inc. This project isn't endorsed by or affiliated with it.
