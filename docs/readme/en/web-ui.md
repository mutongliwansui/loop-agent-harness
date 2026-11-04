# 🖥️ Web UI (Browser Interface)

> [⬅ Back to README](../../../README.en.md)

In `--serve` mode, the service hosts a browser interface on the same port as the REST API (built with Vue 3 + Vite; the build output goes to `webui/dist/` and is served directly by the `node:http` static layer): **open the URL and get chat plus a full ops console**. Everything reuses the existing REST endpoints with zero API behavior changes.

### Start

```bash
npm run build:webui   # Build after first clone or frontend changes (output: webui/dist/, not committed — build once after cloning)
npm run serve
# or
npx tsx src/index.ts --serve
```

Open `http://127.0.0.1:3000/` in your browser.

```
HTTP API 服务已启动
  地址:    http://127.0.0.1:3000
  鉴权:    仅本机（未配置 api.token）
  端点:    /health · /status · /sessions · /uploads · /config · /tools · /models · /mcp · /skills · /memory
  提示:    Ctrl+C 退出；配置变更需重启生效
```

> If `webui/dist` has not been built yet (the artifact is not committed, so it is absent after a fresh clone), the static layer is skipped and the pure API service is unaffected; run `npm run build:webui` to build it.

### Auth (token gate)

Exactly the same policy as the REST API: the static page itself requires no auth, while every API call made by the page carries a Bearer token.

- **No token configured (default)** → local access is frictionless, just open and use;
- **With a token set** (`/config set api.token xxx`, effective after restart) → the first visit shows a token input; once verified it is remembered in the browser's `localStorage`; on invalidation (401) it is cleared automatically and the prompt reappears;
- For remote (LAN) access the server needs `api.host` bound to `0.0.0.0` plus an `api.token`; enter the same token in the browser.

### Interface Overview

Nine views in total (chat plus 8 admin views, "Developer Center" being the one added by requirement 20261104-002; Chinese UI, and the navigation collapses into an icon bar on narrow screens). At the bottom sits a single-row **Settings & management** entry (redesigned in requirement 20261028-002):

- **One resident row, 45px**: the entry keeps a badge on the right showing the page you are on (配置 / 模型 / MCP…, or 「对话」 on chat), and opens a grouped panel **upwards** that overlays the session list without stealing its height (the old collapsible group occupied 337.3px, 37.5% of a 900px viewport, whenever expanded).
- **Three groups in a single column**: Run (config / models / tools), Extend (MCP server / skills / developer center), Data & diagnostics (memory / doctor). Each row is ~187px wide, so full labels fit (in the earlier two-column layout each cell was only 92px and "MCP server" had to be abbreviated). Below ~440px viewport height the panel caps its height and scrolls internally, so the first item is never pushed off-screen. Icons are hand-drawn 16×16 line SVGs (`stroke-width: 1.6`, `currentColor`, round caps) sharing the same icon language as tool cards and chart containers, replacing the nine multi-coloured platform emojis.
- **Three-state appearance**: a segmented control at the panel bottom (Follow / Light / Dark, current value in `aria-pressed`). An explicit choice is persisted to `localStorage`; picking *Follow* deletes `data-theme` and hands control back to `prefers-color-scheme`.
- **Keyboard and a11y**: the entry carries `aria-haspopup` / `aria-expanded` / `aria-controls`; the panel is `role="menu"` with `role="menuitem"` items carrying `aria-current="page"`. Opening focuses the current page item, `↑`/`↓` cycle, `Home`/`End` jump to the ends, `Esc` closes and returns focus to the entry, and a click outside closes it.
- **Narrow screens (≤900px)**: the entry shrinks to a 40px icon-only button and **stays reachable** (the old CSS set both `.grp-body` and `.grp.open .grp-body` to `display: none`, making the admin menu unreachable below 900px), while the panel pops out to the right.

| View | Capabilities | Endpoints |
|---|---|---|
| 💬 Chat | Multi-session (create/switch/delete, 409 notice when deleting in-flight), SSE streaming render (thought / tool-call cards / final answer), stop generation, in-chat upload. Tool calls render as cohesive cards: 16×16 line icon + display name + monospace argument summary, with only a status pill (done/failed/running/aborted) / elapsed / caret on the right; failures get a 3px red bar on the left edge and the reason written straight into the subtitle (readable without expanding); runs of ≥3 consecutive same-tool calls merge into `读取文件 ×4` with expandable per-call rows (a failure inside the run disables merging); raw JSON is tucked into a `{ }` popover in the header so it takes no vertical space; the result block scrolls at 190px with an "expand all N lines" entry past 12 lines; MCP/unknown tools fall back to the raw English name plus a gear icon | `/sessions`, `/sessions/:id/messages`, `/uploads/raw`, `/uploads` |
| ⚙️ Config | Browse masked config tree, single-key read (with source layer), write/delete (workspace/global layering), restart notice for `api.*` changes | `/config`, `/config/path`, `/config/:key` |
| 🤖 Models | The registry is rendered as **row cards** (one per model: icon + alias, then a secondary line with model name / host / masked key, a status-pill group and an icon action group); the **active model is pinned on top and highlighted** (3px brand bar on the left + an "Active" pill), replacing the duplicated "current effective" card; status pills use three tiers — neutral grey for untested / un-benchmarked, green for connectivity success and good TTFT, red for connectivity failure / all-rounds-failed (slow TTFT uses amber); actions collapse into icon buttons (connectivity test / bench) plus a "Set active" pill shown only on inactive rows and a two-step confirmed delete (disabled with an explanation on the active row); keyword filter (alias / model / host) with an "N models · M active" counter; registration moved into a **420px right-side drawer** (explicit labels, required markers, inline validation for the Base URL protocol and temperature 0–2, show/hide API key, write-scope switchable in place); skeleton / empty-state guidance and a ≤720px wrap layout were added. The **Bench** drawer is unchanged — a fixed-tier real streaming run with live readouts that can be aborted, then metric cards / cross-model bar comparison / per-round details / history sparkline; token counts marked "estimated" when `usage` is missing, and gateway-buffered responses flagged separately | `/models`, `/model`, `/models/:alias/test`, `/models/bench/*` |
| 🔧 Tools | Enable/disable built-in tools (effective immediately), view parameter schema, hot reload | `/tools`, `/tools/:name`, `/tools/reload` |
| 🔌 MCP | Register servers (stdio/SSE/HTTP), connection test, bulk reconnect, delete, tool details; failed registration shows the "config persisted" half-state notice | `/mcp/servers`, `/mcp/reload` |
| 🧩 Skills | Install from a local directory (optional overwrite), uninstall (auto scope), view SKILL.md body, hot reload | `/skills`, `/skills/reload` |
| `</>` Developer Center | **Multi-module tabs, the first module being the API reference**: 79 endpoints listed in 9 groups (five-colour method badges + monospace paths with `:param` segments highlighted), a search box matching method/path/description plus a method dropdown, expandable rows showing the parameter table / request body / response / curl example (one-click copy, base URL taken from the page's `location.origin`), and a stats bar (N endpoints · M documented · service address · version). The other two modules are **Auth & conventions** (token three-state, 9 error codes, semantic conventions, current auth status — never the token itself) and **SSE events** (frame format, 19-event table marking Agent passthrough vs API-synthesized, and a `fetch` streaming snippet). Module state lives in `?tab=`, so deep links restore it. Data comes from `GET /dev/api-docs` | `/dev/api-docs` |
| 🧠 Memory | **① Auto-promotion card**: `daily HH:mm` / `weekly X HH:mm` segmented presets plus a `custom cron` input that previews the next 3 trigger instants as you type (300 ms debounce, parsed server-side as the single source of truth); an invalid expression shows a red outline + inline Chinese error + disabled save while **the schedule on the right stays unchanged**; saving is hot (via `PUT /memory/dream/schedule`, no restart). Advanced options (shutdown fallback / read window / misfire catch-up) are collapsed by default with the open state kept in `localStorage`. **② Recent runs**: time / source / result / window / promoted·skipped·errors / duration, with badges derived as `ok` → success, `!ok && promoted>0` → partial failure, `!ok && promoted===0` → failure, `skippedBecause` → skipped/missed, plus an empty state and a clear button. **③ Layered status** and **④ Curated / Episodic / Gate / Search**. Also covers manual Dreaming dispatch and initialization | `/memory/*`, `/memory/dream/schedule`, `/memory/dream/preview`, `/memory/dream/history` |
| 🩺 Doctor | One-click check as a card flow (✅ pass / ⚠ missing / ⛔ blocker) with an overall health badge | `/doctor` |

<!-- Screenshot placeholder: to be added -->

### Developer Center (API reference)

`#/dev` is the entry point for second-party developers (requirement 20261104-002). It organizes developer modules as tabs, with the **API reference as the first module**, leaving obvious slots for later developer-facing modules (webhooks, SDK snippets, …).

- **The endpoint set comes from runtime reflection, never a hand-written list**: `GET /dev/api-docs` walks `createRoutes()` in `src/api/router.ts`, so a newly added route shows up on the page automatically — it cannot be missed. Chinese descriptions, parameters and examples come from the in-code metadata `src/api/api-docs.ts`, keyed by `METHOD /path`.
- **Drift is observable, never silent**: endpoints lacking metadata are returned with `documented: false`, rendered as "description pending" and counted in `stats.undocumented`. Unit tests assert bidirectional agreement between the route table and the metadata keys (a missing entry fails, and so does a stale ghost key), so forgetting to document a new route breaks CI.
- **Three modules**: ① API reference (grouped list + search + method filter + expandable parameter table / body / response / curl); ② Auth & conventions (token three-state and startup checks, the uniform error body, semantic conventions, current auth status — **shows the mode only, never the token**); ③ SSE events (frame format, 19-event table split into "agent passthrough" and "API synthesized", plus a `fetch` streaming snippet).
- **Deep-linkable**: the active module lives in the hash query (`#/dev?tab=sse`), so refreshes and shared links restore it; an invalid value falls back to the first module.
- **Zero new dependencies**: no swagger-ui / OpenAPI runtime is pulled in — the frontend adds one pure-function module (`webui/src/api-docs-ui.ts`, directly testable under Node) and one view file.

### Workspace File Panel (right side of chat)

A persistent "workspace files" panel sits on the right of the chat view and **lazy-loads** per active-session workspace (children are fetched only when a directory is expanded), so it never competes with the conversation:

- **Single-row header (≤64px)**: search box (`Ctrl K` to focus, `Esc` to clear) plus three 26px icon buttons — new folder / upload (opens a sub-menu: upload file or upload folder) / refresh. Below 246px of panel width a container query kicks in: the magnifier hides, buttons shrink to 24px, and the placeholder shortens to "搜索文件…" so nothing is clipped.
- **Tree rows**: inline SVG icons (brand green for directories, muted grey for files, both following `currentColor`), a chevron that rotates 90° when expanded, 14px indentation per level with guide lines, and a 26px row height. The selected row gets a 3px brand bar on the left plus a bold, brand-coloured name — legible even four levels deep.
- **Inline actions**: directories expose `＋` (new subfolder) / `↑` (upload here) / `⋯`; files expose `⤓` (download) / `✎` (rename) / `⋯`. The `⋯` menu shares one implementation with the context menu and carries a path header, separators and "copy relative path".
- **Search**: **file names, directory names and contents are all matched** (case-insensitive, regex metacharacters safe), with name hits ranked ahead of content hits so they can never be crowded out by the 200-result cap. Directory hits come first (clicking one expands the tree and scrolls to that directory), then per-file groups — each group header shows the file icon, dimmed directory, file name and a hit-count badge; a name hit highlights the keyword in the header, and a file with no content lines shows a "文件名" badge instead. Hit rows right-align the line number and highlight the keyword with `<mark>`. The summary reads "N hits · M files · K dirs" (the last part is omitted when there are no directory hits) with a one-click clear, and an overflow notice reads "结果过多，仅显示前 200 条".
- **All four states**: first-paint skeleton, empty-state card (clear search), error card (retry), and a drag-and-drop overlay that names the destination directory.
- **30px status bar**: item count on the left (switches to `上传 x/y` while uploading, with a 3px progress line under the header), the "hidden items" switch in the middle, and an auto-refresh pulse on the right — the indicator is still clickable to pause polling temporarily, and the choice persists in `localStorage`.
- **Sizing and a11y**: default 264px, minimum 204px, maximum `min(420, total width − 320)`, double-click to reset; the tree uses `role="tree"` / `role="treeitem"` / `aria-expanded` / `tabindex` so rows can be focused one by one.

Endpoints are unchanged: `/fs/tree`, `/fs/search`, `/fs/fingerprint`, `/fs/file`, `/fs/raw`, `/fs/upload`, etc. — this rework touches only the front-end visuals and interactions.

### Terminal in the File Preview Area

The top of the file preview area is a tab strip: `📄 filename` sits side by side with terminal tabs (`● PowerShell`, `● Command Prompt`), and `＋` on the right opens a new terminal — the terminal is a **first-class citizen** of the preview area, not an overlay, and needs no split pane. The dot to the left of a terminal tab is the session state: green running, grey exited, red failure, replaced by a spinner while a command runs.

- **Shells come from runtime detection**: on start it probes `pwsh.exe` (PowerShell 7) → `powershell.exe` (Windows PowerShell 5.1) → `cmd.exe` (`$SHELL` / `bash` / `zsh` on POSIX) and lists only what actually exists; when `pwsh.exe` is not installed it never appears in the dropdown (no fake option that errors on click). The working directory is always the current session's workspace, and the path in the toolbar is click-to-copy.
- **Channel**: `browser (xterm.js) ⇄ WebSocket ⇄ server ⇄ pseudo-terminal PTY (ConPTY)`, so scrollback, cursor, `Ctrl+C`, `↑` history and full-screen TUI programs (e.g. the `npm run build` progress bar) behave like a real terminal; resizing the window or dragging the splitter recomputes columns/rows (the `resize` message is debounced 120ms).
- **All six states covered**: not started (centered CTA + shell cards) / running (bottom status bar: `● connected · 96×27 · UTF-8 · PID · cwd`) / busy (tab spinner + bottom-right strip "running xx · Ctrl+C") / exited (overlay with exit code and uptime, **output preserved and scrollable**, one-click restart) / disconnected (yellow top banner "reconnecting… (2/5)", exponential backoff 1s→2s→4s→8s) / PTY missing (shows the searched paths and the right remedy per deployment form: `npm i` for a dev checkout, `node_modules/@lydell` beside the exe for SEA). In non-live states the status bar never falsely claims "connected", and clear/copy are greyed out as appropriate.
- **No garbled CJK**: it does not inject `chcp 65001` — ConPTY works in UTF-16 internally and the server already receives UTF-8, so `echo 中文测试✓` echoes correctly; injecting it would pollute existing output and break tools that rely on the OEM code page. The font stack includes a CJK fallback (`Microsoft YaHei UI`).
- **Reconnect without losing the screen**: each session keeps a 256KB ring buffer of recent output and replays it before resuming the stream; after a WS disconnect the PTY is kept for a 60s grace period for reconnection, then reclaimed (Windows uses `taskkill /T /F /PID` to clear the process tree including `conhost.exe`).
- **Closing a tab frees the slot**: clicking the tab `✕` immediately tells the server to kill the PTY and release the concurrency slot — this is distinct from "keep 60s for reconnect after a network blip". Page reload/close also releases via `pagehide`, with a 60s reclaim as backstop. Repeatedly opening and closing terminals therefore never produces "no terminal on screen yet the limit is reported".

**Off by default, must be enabled explicitly**: a terminal means arbitrary command execution with the current user's privileges, so `webui.terminal` defaults to `false`; while disabled the WS handshake returns 403 (the front end shows a configuration hint instead of failing silently).

```bash
# Enable the terminal (takes effect after restart)
npm run cli -- /config set webui.terminal true

# Optional: deny list (enforced server-side, denied and audited), concurrency cap, idle reclaim
npm run cli -- /config set webui.terminalDeny '["shutdown","format"]'
npm run cli -- /config set webui.terminalMax 4
npm run cli -- /config set webui.terminalIdleMs 1800000
```

Security constraints: (1) off by default; (2) without `api.token` only loopback works — non-loopback binding without a token is always rejected; (3) the WS handshake carries the token in `Sec-WebSocket-Protocol` (browsers cannot set custom headers on WebSocket, and a token in the query string would land in access logs); (4) `Origin` allow-list check to prevent CSRF-style cross-site connections; (5) every submitted command is written to the session log for auditing; (6) the front-end confirmation for dangerous commands (`del /s`, `rmdir /s`, `format`, `shutdown`) only guards against slips — **the real boundary is the server-side deny list plus auth**.

Dependencies: `@xterm/xterm` + `@xterm/addon-fit` on the front end; `ws` + `@lydell/node-pty` on the server (a **prebuilt, no-compile** package that avoids node-gyp / Python / VS Build Tools unlike the official node-pty). Without `@lydell/node-pty` the service still starts normally and the terminal degrades to "interactive terminal unavailable"; the message comes from `ptyHint` on `GET /terminal/info` and includes the **directories actually searched** plus the two distinct remedies — `npm i` for a dev checkout vs. shipping `node_modules/@lydell` beside the exe for SEA single-file deployments (`npm run build:sea` copies it automatically).

### In-chat Upload

The 📎 button in the composer opens the upload panel: file picker (multi-select) → each file is uploaded as raw bytes via `POST /uploads/raw` (browsers cannot obtain full local paths, hence this new endpoint; the CLI's `/upload` path mode is unaffected) → on success a context chip (file name + size) appears above the composer and is injected into the Agent context with the next message. The chip ✕ only removes it on the client (no longer injected); the management list can inspect/clear uploaded files (verb-as-confirmation).

**Paste with `Ctrl+V`**: press `Ctrl+V` right in the composer to drop in a screenshot (Win+Shift+S / QQ / WeChat capture) or files copied with `Ctrl+C` in File Explorer — the browser exposes both through `paste.clipboardData.files`, so they share one upload path and you no longer need to save to disk before reaching for 📎. Chrome's default screenshot name `image.png` is renamed to `paste.png` / `paste-2.png` (the server prefixes the on-disk name with `YYYYMMDD-HHmmss-`; the client adds no timestamp of its own — otherwise several screenshots pasted within the same second would share a prefix and become indistinguishable once the chip ellipsises them), while ordinary files always keep their original name. Image chips show a 24×24 local thumbnail; the blob URL is released on delete / successful send / clear-all / unmount, and a failed send restores the chips untouched (no early release, so thumbnails never break). At most 6 files per paste, uploaded sequentially in paste order, and blocked while a reply is being generated. When an image exceeds `vision.maxImageBytes` or the vision pipeline is disabled, the chip shows a ⚠ badge (hover for the exact reason) instead of silently pretending it is readable. Plain-text pasting keeps the browser default behaviour — never intercepted, never toasted.

### Clickable paths in tool cards

Path arguments in tool cards render as clickable chips (20261028-006, following optimization suggestion 20261028-003): `path` of `fileRead` / `fileWrite` / `editFile`, `path` of `grep` (directory), `cwd` of `commandRun` (directory), and `image` of the four vision tools (`describe_image` / `ask_image` / `ocr_image` / `extract_json`). Clicking a file chip expands the file panel and opens the preview (reusing the existing `FilesView.openFile` pipeline: md/html/svg/csv/xlsx/docx/pdf/images/pptx/text); clicking a directory chip locates that directory in the panel; paths in expanded group-card rows are clickable too. http(s) links, `data:` URIs, missing arguments, and absolute paths outside the workspace do not render as links (the hover title explains why), avoiding clicks that are guaranteed to fail.

Uploaded images (the vision tools' landing spot `~/.loop-agent/uploads/{sessionId}/`, outside the workspace and unreachable via `/fs/*`) are previewed through a new controlled read-only endpoint `GET /uploads/view?path=&disp=file|raw`: read-only, double-checked with lexical traversal protection (`resolveInWs`) plus symlink escape protection (realpath); out-of-bounds always yields 403. `disp=file` returns a response isomorphic to `/fs/file` (512KB truncation, binary rejection); `disp=raw` streams raw bytes (Content-Type by extension, 100MB cap). Session replay works identically (paths come from persisted args); missing files show the preview error state plus a toast without blocking the UI.

### Multi-tab sync and background-completion alerts

When multiple tabs of the same browser are open, run state syncs automatically (Task-20261021-002-07): a run started/finished in tab A shows a running dot / unread dot in tab B within ~1s and refreshes the sidebar; deleting a session in A removes it in B; marking a session read in A clears the unread dot in B as well. The channel is `BroadcastChannel('loop-agent')` with automatic localStorage fallback in older browsers; only derived state is broadcast (run started/finished/read/deleted) — message content always comes from the server.

Background-completion alerts are configured in the 🔔 panel above the composer, with two independent persisted toggles: **system notification** (fires only when the window is hidden or unfocused; same-session notifications replace each other to avoid spam; clicking one focuses the window and jumps to the session; permission is requested only when you tick the switch — if the browser denied it, re-enable from browser settings) and **chime** (a WebAudio synthesized two-tone sound, no permission needed). Foreground completion keeps the in-page toast. When accessed via LAN IP + http the browser provides no Notification API; the 🔔 panel shows a degradation notice, while the chime and in-page alerts keep working.

### Background Task Card (requirement 20261104-005)

When `commandRun` is called with `background:true`, the tool card's result area switches to a background task card: the header shows the full command plus a stop button (with confirmation), and the summary row shows a status pill, elapsed time, exit code and log size. The log is collapsed by default; expanding it fetches the last 20 lines / 2KB. Running tasks poll every 2s (15s while the page is hidden), and polling stops on a terminal status. After a server restart or when logs are removed by retention policy, the card degrades to a dim "record cleaned" state instead of erroring. Data comes from `GET /background/:id`, `GET /background/:id/logs?tail=1` and `POST /background/:id/stop`.

### Cross-Workspace Sessions

The sidebar groups sessions by workspace (`GET /workspaces`): sessions from other workspaces have **exactly the same rights** as the current one — you can open them and keep chatting directly, run them in parallel with runs in the current workspace, and delete them normally. A workspace's "current" marker only means most-recently-used and imposes no sending restriction. Cross-workspace runs never interfere with each other; a 409 busy only occurs when you send concurrent messages to the **same session**.

### Rich Content Rendering (Math & Charts)

Markdown bodies (the chat answers and md/doc file previews share one pipeline, `marked` + `DOMPurify` sanitization) support:

- **Math**: `$E=mc^2$` inline and `$$..$$` block via KaTeX (in-diagram `$$..$$` math is built into mermaid v12, flowchart/sequence only); syntax errors render as an inline red fragment without blocking the rest.
- **Mermaid charts**: mermaid code blocks render as SVG; the container toolbar offers zoom in/out, fit, fullscreen plus wheel zoom and drag panning, and labels the diagram type from the first source keyword (flowchart / sequence / class …); parse failures keep the source block outlined in red.
- **ECharts charts**: echarts code blocks (pure JSON options, declarative — no script execution surface) render as interactive SVG charts with the same container controls as Mermaid, and label the series forms from `series[].type` (bar / line / pie …); invalid JSON keeps the source block outlined in red.
- **Container chrome**: a uniform card with a soft border and a title bar of *icon + kind (chart / diagram) + subtitle*; icon-only tool buttons (names on hover), a click-to-reset zoom readout, and a pan hint in the bottom-right corner when panning is possible.
- **Incremental streaming render**: message bodies are split into *stable blocks + a mutable tail*, so a chart renders **as soon as its code fence closes** — no need to wait for the whole answer. Charts already on screen survive subsequent output (zoom/fullscreen state preserved). While a fence is open, a "generating chart…" placeholder (with character count) replaces the raw code stream; on stop/failure it falls back to a copyable code block.
- **Preview ⇄ source**: the `</>` button at the right of the chart toolbar switches to the source view (monospace, copyable); switching back does not rebuild the chart instance, and zoom/fullscreen buttons are disabled in source mode.
- Both load on demand and adapt to light/dark themes (already-rendered charts re-render on theme switch); KaTeX fonts are bundled locally for offline use.

### Scroll Following and "Back to Latest"

While output streams in, the viewport sticks to the tail by default so the newest content stays visible. That follow is releasable, so you can read back mid-stream:

- **Scrolling up releases it**: the mouse wheel, touch scrolling, dragging the scrollbar, or `PageUp/PageDown/Home/End/ArrowUp/ArrowDown` while the message area is focused all release the follow. The viewport stays where it is and later deltas no longer yank it back to the bottom — you can re-read the tool arguments and reasoning of long, multi-tool answers at any point.
- **Returning to the bottom re-engages it**: scrolling back within 24px of the bottom re-pins the viewport to the tail.
- **Back-to-latest button**: while released, a floating down-arrow button appears in the bottom-right of the message area; clicking it smoothly returns to the bottom and resumes following. If new content arrives while released, the button shows a brand-colored dot (no counter — a streaming reply is a single message growing, so a count would be meaningless).
- **Forced back to bottom**: sending a message, switching sessions, and creating a session always return to the latest regardless of the released state; a run finishing while released does not steal the viewport back — it only lights the dot.
- **Stable reading position**: highlighting and chart rendering during a released state (which change block heights) are corrected by the browser's scroll anchoring, so what you already read does not drift.

### Security Details

- The static layer prevents path traversal (`..%2f` etc. → 403); `/assets/*` is cached immutable for one year while `index.html` is not cached (upgrades take effect immediately).
- Markdown is rendered via `marked` + `DOMPurify` sanitization to prevent script injection from model output.
- API errors are shown as toasts with the backend `error.message`; 409 busy, 413 over-limit (100MB per file) etc. all have dedicated messages.

### Frontend Development

```bash
cd webui
npm install
npm run dev        # Vite dev server on :5173, proxying endpoint prefixes (/sessions, /config, …) to a local --serve on :3000
npm run build      # Output to dist/ (equivalent to npm run build:webui at the repo root)
```

Tech stack: Vue 3 `<script setup>` + TypeScript + Vite; hash routing (`#/chat` etc., zero router dependency); SSE parsed manually with `fetch` + `ReadableStream` (`EventSource` cannot carry Bearer headers).

### Non-goals

Native mobile apps, multi-user accounts, SEO/public site scenarios, i18n bilingual UI (Chinese-only for now), drag-and-drop upload (future evolution).
