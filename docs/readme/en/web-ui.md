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

Eight items in the left navigation (Chinese UI, light/dark follows the system, navigation collapses into an icon bar on narrow screens):

| View | Capabilities | Endpoints |
|---|---|---|
| 💬 Chat | Multi-session (create/switch/delete, 409 notice when deleting in-flight), SSE streaming render (thought / tool-call cards / final answer), stop generation, in-chat upload. Tool calls render as cohesive cards: 16×16 line icon + display name + monospace argument summary, with only a status pill (done/failed/running/aborted) / elapsed / caret on the right; failures get a 3px red bar on the left edge and the reason written straight into the subtitle (readable without expanding); runs of ≥3 consecutive same-tool calls merge into `读取文件 ×4` with expandable per-call rows (a failure inside the run disables merging); raw JSON is tucked into a `{ }` popover in the header so it takes no vertical space; the result block scrolls at 190px with an "expand all N lines" entry past 12 lines; MCP/unknown tools fall back to the raw English name plus a gear icon | `/sessions`, `/sessions/:id/messages`, `/uploads/raw`, `/uploads` |
| ⚙️ Config | Browse masked config tree, single-key read (with source layer), write/delete (workspace/global layering), restart notice for `api.*` changes | `/config`, `/config/path`, `/config/:key` |
| 🤖 Models | Registry management (add/delete), one-click active switch, connectivity test (latency), current effective snapshot | `/models`, `/model`, `/models/:alias/test` |
| 🔧 Tools | Enable/disable built-in tools (effective immediately), view parameter schema, hot reload | `/tools`, `/tools/:name`, `/tools/reload` |
| 🔌 MCP | Register servers (stdio/SSE/HTTP), connection test, bulk reconnect, delete, tool details; failed registration shows the "config persisted" half-state notice | `/mcp/servers`, `/mcp/reload` |
| 🧩 Skills | Install from a local directory (optional overwrite), uninstall (auto scope), view SKILL.md body, hot reload | `/skills`, `/skills/reload` |
| 🧠 Memory | Three-tier memory status, episodic browsing by day, curated entries, semantic search, Promotion Gate decisions, Dreaming (accepted async), initialization | `/memory/*` |
| 🩺 Doctor | One-click check as a card flow (✅ pass / ⚠ missing / ⛔ blocker) with an overall health badge | `/doctor` |

<!-- Screenshot placeholder: to be added -->

### Workspace File Panel (right side of chat)

A persistent "workspace files" panel sits on the right of the chat view and **lazy-loads** per active-session workspace (children are fetched only when a directory is expanded), so it never competes with the conversation:

- **Single-row header (≤64px)**: search box (`Ctrl K` to focus, `Esc` to clear) plus three 26px icon buttons — new folder / upload (opens a sub-menu: upload file or upload folder) / refresh. Below 246px of panel width a container query kicks in: the magnifier hides, buttons shrink to 24px, and the placeholder shortens to "搜索文件…" so nothing is clipped.
- **Tree rows**: inline SVG icons (brand green for directories, muted grey for files, both following `currentColor`), a chevron that rotates 90° when expanded, 14px indentation per level with guide lines, and a 26px row height. The selected row gets a 3px brand bar on the left plus a bold, brand-coloured name — legible even four levels deep.
- **Inline actions**: directories expose `＋` (new subfolder) / `↑` (upload here) / `⋯`; files expose `⤓` (download) / `✎` (rename) / `⋯`. The `⋯` menu shares one implementation with the context menu and carries a path header, separators and "copy relative path".
- **Search**: results are grouped per file with a "N hits · M files" summary and a one-click clear; each group header shows the file icon, dimmed directory, file name and a hit-count badge, while hit rows right-align the line number and highlight the keyword with `<mark>` (case-insensitive, regex metacharacters safe).
- **All four states**: first-paint skeleton, empty-state card (clear search), error card (retry), and a drag-and-drop overlay that names the destination directory.
- **30px status bar**: item count on the left (switches to `上传 x/y` while uploading, with a 3px progress line under the header), the "hidden items" switch in the middle, and an auto-refresh pulse on the right — the indicator is still clickable to pause polling temporarily, and the choice persists in `localStorage`.
- **Sizing and a11y**: default 264px, minimum 204px, maximum `min(420, total width − 320)`, double-click to reset; the tree uses `role="tree"` / `role="treeitem"` / `aria-expanded` / `tabindex` so rows can be focused one by one.

Endpoints are unchanged: `/fs/tree`, `/fs/search`, `/fs/fingerprint`, `/fs/file`, `/fs/raw`, `/fs/upload`, etc. — this rework touches only the front-end visuals and interactions.

### In-chat Upload

The 📎 button in the composer opens the upload panel: file picker (multi-select) → each file is uploaded as raw bytes via `POST /uploads/raw` (browsers cannot obtain full local paths, hence this new endpoint; the CLI's `/upload` path mode is unaffected) → on success a context chip (file name + size) appears above the composer and is injected into the Agent context with the next message. The chip ✕ only removes it on the client (no longer injected); the management list can inspect/clear uploaded files (verb-as-confirmation).

### Multi-tab sync and background-completion alerts

When multiple tabs of the same browser are open, run state syncs automatically (Task-20261021-002-07): a run started/finished in tab A shows a running dot / unread dot in tab B within ~1s and refreshes the sidebar; deleting a session in A removes it in B; marking a session read in A clears the unread dot in B as well. The channel is `BroadcastChannel('loop-agent')` with automatic localStorage fallback in older browsers; only derived state is broadcast (run started/finished/read/deleted) — message content always comes from the server.

Background-completion alerts are configured in the 🔔 panel above the composer, with two independent persisted toggles: **system notification** (fires only when the window is hidden or unfocused; same-session notifications replace each other to avoid spam; clicking one focuses the window and jumps to the session; permission is requested only when you tick the switch — if the browser denied it, re-enable from browser settings) and **chime** (a WebAudio synthesized two-tone sound, no permission needed). Foreground completion keeps the in-page toast. When accessed via LAN IP + http the browser provides no Notification API; the 🔔 panel shows a degradation notice, while the chime and in-page alerts keep working.

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

Native mobile apps, multi-user accounts, SEO/public site scenarios, i18n bilingual UI (Chinese-only for now), drag-and-drop / paste upload (future evolution).
