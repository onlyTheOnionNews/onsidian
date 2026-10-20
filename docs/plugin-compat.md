# Community plugin compatibility

Run on 2026-10-20 against the 50 most-downloaded **mobile-compatible** community plugins (desktop-only plugins
excluded: Zotero, Pandoc, Advanced Slides, Local REST API…).

## What "ok" means

Each plugin is installed into one `App` on an in-memory vault (a few seeded notes), enabled, given 1.2 s for async
startup, then disabled. **ok** means: it loaded, registered its commands and views, threw no errors during startup,
and unloaded without leaving commands or views behind. It does **not** mean every feature was exercised. The run
is a load-time smoke test; feature testing per plugin is separate work.

| Status | Count |
|---|---|
| ok | 36 |
| runtime errors during startup | 8 |
| failed to load | 6 |

Progress while building phase 3: 14 → 24 → 31 → 36 ok, by implementing the internals the failures pointed at.

## How to reproduce

```bash
npm run compat:fetch -- 50   # downloads release files into compat-plugins/ (gitignored)
npm run dev                  # then open http://localhost:5173/compat.html  (or ?only=<plugin-id>)
```

The page records each plugin's load error, runtime errors (attributed by `plugin:<id>/` stack frames), registered
commands and views, and leftovers after unload. It also runs in diagnose mode: reads of `obsidian.*` / `app.*`
members we don't implement are collected in `window.__obsidianOnlineMissing`.

## Results

| Plugin | Version | Status | Commands | Views | First error |
|---|---|---|---|---|---|
| Excalidraw | 2.29.0 | runtime-errors | 0 | excalidraw, excalidraw-sidepanel | failed to unload: reading 'destroy' (startup didn't finish) |
| Templater | 2.26.0 | ok | 4 |  |  |
| Dataview | 0.5.68 | ok | 3 |  |  |
| Tasks | 8.6.0 | ok | 8 |  |  |
| Git | 2.42.0 | ok | 42 | git-view, git-history-view, git-read-only-file-view, diff-view, split-diff-view |  |
| Advanced Tables | 0.23.2 | ok | 22 | advanced-tables-toolbar |  |
| Calendar | 1.5.10 | ok | 3 | calendar |  |
| Style Settings | 1.0.9 | ok | 1 | style-settings |  |
| Kanban | 2.0.51 | load-failed | 0 |  | Cannot convert undefined or null to object |
| Copilot | 4.0.15 | ok | 18 | copilot-chat-view, obsidian-copilot-apply-view, copilot-relevant-notes-view |  |
| Remotely Save | 0.5.25 | ok | 6 |  |  |
| Iconize | 2.14.7 | runtime-errors | 1 |  | CodeMirror plugin crashed: NodeType.prop reading 'id' |
| QuickAdd | 2.32.1 | ok | 7 |  |  |
| TaskNotes | 4.13.10 | ok | 39 | tasknotes-pomodoro-view, tasknotes-pomodoro-stats-view, tasknotes-stats-view, tasknotes-release-notes |  |
| Editing Toolbar | 4.1.10 | ok | 100 |  |  |
| Omnisearch | 1.31.0 | runtime-errors | 2 |  | optional local HTTP server needs Node `http` (search itself unaffected) |
| Minimal Theme Settings | 9.0.0 | ok | 51 |  |  |
| Importer | 3.1.15 | ok | 1 |  |  |
| Outliner | 4.10.2 | runtime-errors | 7 |  | logs "Vim adapter not found" (no Vim mode yet) |
| Homepage | 4.5.0 | ok | 3 |  |  |
| Smart Connections | 4.7.2 | runtime-errors | 8 | smart-env-status-view, smart-connections-view, smart-release-notes-view | Ribbon actions require converged env.config.actions |
| Linter | 1.34.2 | load-failed | 0 |  | reading 'commands' of undefined |
| Recent Files | 1.7.10 | ok | 1 | recent-files |  |
| Tag Wrangler | 0.6.5 | load-failed | 0 |  | s.on is not a function |
| BRAT | 2.2.0 | ok | 17 |  |  |
| Notebook Navigator | 3.4.3 | runtime-errors | 0 |  | downloads language data from github.com: needs a network bridge |
| Self-hosted LiveSync | 1.0.38 | ok | 39 | p2p-replicator, p2p-server-status, log-log, global-history |  |
| Admonition | 12.0.11 | ok | 4 |  |  |
| Advanced Canvas | 7.1.0 | ok | 39 | canvas | (canvas core view arrives in phase 4) |
| Day Planner | 0.35.1 | ok | 14 | planner-timeline, planner-weekly, planner-release-notes, planner-time-tracker |  |
| Mind Map | 1.1.0 | ok | 1 | mindmap |  |
| make.md | 1.3.5 | runtime-errors | 22 | mk-ever-view, mk-path-view, mk-space, … | constructView: reading 'render' of null |
| PDF++ | 0.40.31 | load-failed | 0 |  | needs pdf.js (phase 4) |
| Commander | 0.7.0 | ok | 1 |  |  |
| Periodic Notes | 0.0.17 | ok | 0 |  |  |
| Highlightr | 1.2.2 | runtime-errors | 11 |  | Uncaught Error: FS error |
| Advanced URI | 2.2.1 | ok | 12 |  |  |
| Latex Suite | 1.14.0 | load-failed | 0 |  | reading 'createInstance' of undefined |
| Various Complements | 11.4.2 | ok | 10 |  |  |
| Better Word Count | 0.10.1 | ok | 0 |  |  |
| Hover Editor | 0.11.31 | load-failed | 0 |  | reading 'views' of undefined (pop-out/hover internals) |
| Spaced Repetition | 1.15.4 | ok | 9 | spaced-repetition-tab-view, review-queue-list-view |  |
| Markmind | 3.7.4 | ok | 56 | mindmapview |  |
| Annotator | 0.2.11 | ok | 1 | pdf-annotator |  |
| Text Generator | 0.8.7 | ok | 17 | playground-view, tool-view |  |
| Meta Bind | 1.5.1 | ok | 5 | mb-playground-view-type |  |
| Image Converter | 1.4.6 | ok | 4 |  |  |
| Natural Language Dates | 0.6.4 | ok | 8 |  |  |
| Quick Switcher++ | 6.2.0 | ok | 11 |  |  |
| Paste URL into selection | 1.11.4 | ok | 1 |  |  |

## Known gaps behind the remaining failures

- **pdf.js** (PDF++, PDF Annotator features): phase 4.
- **Canvas core view** (Advanced Canvas loads but has nothing to extend): phase 4.
- **Undocumented internals** reached by Kanban, Linter, Tag Wrangler, Latex Suite, Hover Editor, make.md: each needs
  investigation in its bundle; the diagnose mode didn't catch them because they read deeper objects
  (e.g. internal plugin instances, view internals).
- **Vim mode** (Outliner warning): CM6 Vim isn't wired in.

## Installing these plugins

Only 1 of the top 40 plugins (make.md) commits its built `main.js` to the repo at the release tag, so the
jsDelivr route almost never works. One-click installs from the plugin browser need a network bridge
(Settings → Network); otherwise download the release files and use "Install plugin from files".
