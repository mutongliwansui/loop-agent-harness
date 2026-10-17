# 🖥️ Web UI (Browser Interface)

> [⬅ Back to README](../../../README.en.md)

In `--serve` mode, the service hosts a browser interface on the same port as the REST API (built with Vue 3 + Vite; the build output is committed at `webui/dist/` and served directly by the `node:http` static layer): **open the URL and get chat plus a full ops console**. Everything reuses the existing REST endpoints with zero API behavior changes.

### Start

```bash
npm run build:webui   # Build after first clone or frontend changes (output: webui/dist/, committed to the repo — usable right after cloning)
npm run serve
# or
npx tsx src/index.ts --serve
```

Open `http://127.0.0.1:3000/` in your browser.

```
HTTP API service started
  Address:   http://127.0.0.1:3000
  Auth:      local-only (no api.token configured)
  Endpoints: 47 (sessions 5 + health 1 + command resources 40 + raw upload 1)
  Static:    webui/dist hosted (chat + admin console)
  Note:      Ctrl+C to exit; config changes require a restart
```

> If `webui/dist` is missing (e.g. cleaned manually), the static layer is skipped and the pure API service is unaffected; run `npm run build:webui` again to restore it.

### Auth (token gate)

Exactly the same policy as the REST API: the static page itself requires no auth, while every API call made by the page carries a Bearer token.

- **No token configured (default)** → local access is frictionless, just open and use;
- **With a token set** (`/config set api.token xxx`, effective after restart) → the first visit shows a token input; once verified it is remembered in the browser's `localStorage`; on invalidation (401) it is cleared automatically and the prompt reappears;
- For remote (LAN) access the server needs `api.host` bound to `0.0.0.0` plus an `api.token`; enter the same token in the browser.

### Interface Overview

Eight items in the left navigation (Chinese UI, light/dark follows the system, navigation collapses into an icon bar on narrow screens):

| View | Capabilities | Endpoints |
|---|---|---|
| 💬 Chat | Multi-session (create/switch/delete, 409 notice when deleting in-flight), SSE streaming render (thought / collapsible tool-call blocks / final answer), stop generation, in-chat upload | `/sessions`, `/sessions/:id/messages`, `/uploads/raw`, `/uploads` |
| ⚙️ Config | Browse masked config tree, single-key read (with source layer), write/delete (workspace/global layering), restart notice for `api.*` changes | `/config`, `/config/path`, `/config/:key` |
| 🤖 Models | Registry management (add/delete), one-click active switch, connectivity test (latency), current effective snapshot | `/models`, `/model`, `/models/:alias/test` |
| 🔧 Tools | Enable/disable built-in tools (effective immediately), view parameter schema, hot reload | `/tools`, `/tools/:name`, `/tools/reload` |
| 🔌 MCP | Register servers (stdio/SSE/HTTP), connection test, bulk reconnect, delete, tool details; failed registration shows the "config persisted" half-state notice | `/mcp/servers`, `/mcp/reload` |
| 🧩 Skills | Install from a local directory (optional overwrite), uninstall (auto scope), view SKILL.md body, hot reload | `/skills`, `/skills/reload` |
| 🧠 Memory | Three-tier memory status, episodic browsing by day, curated entries, semantic search, Promotion Gate decisions, Dreaming (accepted async), initialization | `/memory/*` |
| 🩺 Doctor | One-click check as a card flow (✅ pass / ⚠ missing / ⛔ blocker) with an overall health badge | `/doctor` |

<!-- Screenshot placeholder: to be added -->

### In-chat Upload

The 📎 button in the composer opens the upload panel: file picker (multi-select) → each file is uploaded as raw bytes via `POST /uploads/raw` (browsers cannot obtain full local paths, hence this new endpoint; the CLI's `/upload` path mode is unaffected) → on success a context chip (file name + size) appears above the composer and is injected into the Agent context with the next message. The chip ✕ only removes it on the client (no longer injected); the management list can inspect/clear uploaded files (verb-as-confirmation).

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
