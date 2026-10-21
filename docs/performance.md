# Performance (phase 6)

Measured 2026-10-20 with the benchmark page in the Claude desktop app's built-in browser (Chromium 152, Windows,
16 cores), storage in OPFS. Synthetic vaults: ~2.5 KB notes with frontmatter, headings, ~13 wikilinks, tags, tasks and a
callout each, in folders of 100. They are denser in links than most real vaults, which is the harder case for links
and the graph.

## How to reproduce

```bash
npm run dev    # then open http://localhost:5173/bench.html?n=10000   (n = 1000, 10000, 50000, …)
```

The first visit generates the vault into OPFS (`bench/<n>/`), which takes minutes at 50k; later visits reuse it. The
first run after generating or after a parser change is **cold** (every note read and parsed). Runs after that are
**warm** (the persisted index is reused). Results show on the page and in `window.__bench`.

## Targets (PLAN §10, 10k notes)

| Target | Before phase 6 | After | |
|---|---|---|---|
| Cold start to fully indexed, 10k notes, < 5 s | 21.1 s | 7.8 s cold / **3.6 s warm** | warm: met. cold: read-bound (below) |
| Search keystroke < 50 ms | 2.6–3.2 s per query | **12–96 ms** for one word, path, tag, property; 100–420 ms for multi-word queries with thousands of hits; ~380 ms `line:` | met for common queries |
| Graph 60 fps at 5k nodes | 155 ms per frame at 10k (layout + draw on the main thread) | draw **1–11 ms** at 10k; layout off the main thread | met for drawing and input; layout settles slowly (below) |

## What changed

| Area | Change | Effect (10k) |
|---|---|---|
| Vault scan | Stats come from each directory listing's handles, folders scanned in parallel (was one root-walking stat per file) | 12.1 s → 1.6 s |
| File reads | OPFS file handles from the scan are reused | reads ~40% faster |
| Indexing | 4 parser workers instead of 1 | parse 2.5 s → ~0.7 s |
| Persisted index | Metadata per note in IndexedDB (JSON strings), valid while mtime and size match; `PARSER_VERSION` invalidates it, and a test forces a bump when `parse.ts` changes | warm start skips reading and parsing |
| Link resolution | Link path normalized once per link; create/rename/delete re-resolve only notes linking to that name (reverse index) | resolve all 1.3 s → 0.7 s; create note 350 ms → 4 ms |
| Search | Regex compiled once per query; yield on a 12 ms time budget (was every 50 files, ~4 ms timer clamp each); parallel batched reads; `line:`/`block:`/`section:`/`task:` reject on the whole note first | 3 s → 12–96 ms; `line:` 1.4 s → 0.38 s |
| Note text | Read into memory in the background after a warm start; concurrent reads of the same note are shared; a read never caches text older than a write that landed during it | first search no longer reads all notes on demand |
| Reading view | Long notes (> 64 KB) render in heading-delimited chunks, first chunk at once; re-render on `resolved` only when this note's links changed | 500 KB note: first paint ~0.6 s, complete ~1.5 s |
| Graph | d3-force layout in a worker; draw batched into one path per style; off-screen culling; cached font | draw 155 ms → 1–11 ms |
| Bundle | Lucide icons, zip (fflate) and Readability load on demand | main chunk 1,373 KB → 897 KB (423 → 312 KB gzipped) |

## 50k notes (no target in the plan; measured for the record)

| | Cold | Warm |
|---|---|---|
| Vault scan | 8.2 s | 8.8 s |
| Startup to fully indexed | 47 s | 25 s |
| Search (after warm-up) | 150–760 ms; `line:` 1.8 s | — |
| Create note | 4 ms | 4 ms |
| Heap after indexing | ~860 MB | ~860 MB |

## Known limits and upgrade paths

- **Cold start is read-bound.** Reading 10k OPFS files costs ~3 s in this browser, even with cached handles. Upgrade
  path: read through `createSyncAccessHandle` in the indexer workers (OPFS vaults only).
- **Vault scan grows linearly** (getFile() per note for size and mtime): 1.6 s at 10k, 8.8 s at 50k. Upgrade path:
  for OPFS/IndexedDB vaults, where this app is the only writer, persist the file list and revalidate in the background.
- **Graph layout settles slowly on big graphs.** d3-force's many-body step takes ~64 ms at 5k nodes and ~430 ms at
  10k in this browser. The view stays at frame rate because the layout runs in a worker, but a 10k graph takes ~45 s
  to settle. Upgrade path: a typed-array Barnes–Hut, or wasm (PLAN §9). This is the one measured case for wasm.
- **Memory.** All note text stays in memory after the warm-up (~2× file size), and the metadata objects that the
  Obsidian API returns are large (61 MB as JSON for 10k notes). ~860 MB heap at 50k. Upgrade path: an LRU text cache.
- **First search right after opening** waits for the background warm-up reads (~3 s at 10k).
- **Multi-word searches with thousands of hits** take 100–400 ms: every match position is collected for highlighting.
  Upgrade path: collect positions only for the results that are rendered.
- **Long notes in reading view** still build their whole DOM, just without blocking first paint. Upgrade path: section
  virtualization like Obsidian's.
