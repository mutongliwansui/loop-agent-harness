# 🔧 Built-in Tools

> [⬅ Back to README](../../../README.md)

| Tool | Name | Description | Parameters |
|---|---|---|---|
| 🖥️ **Command Execution** | `commandRun` | Execute a shell command locally, returning stdout + stderr; long tasks can run with `background:true` (returns a `taskId` immediately, not subject to the 30s timeout); when a task finishes while the session is idle, the API service starts a wake-up run with a synthetic input to consume the completion notice (`tools.backgroundNotify.wakeIdle`, on by default). Foreground output keeps 128KB head + 128KB tail (total cap configurable) with the middle omitted and annotated, so it no longer fails on maxBuffer; terminal tags are `[exit=N]` / `[timeout=Nms]` / `[aborted]` / `[signal=…]` plus `[duration=…]` | `command` (required), `cwd` (optional), `timeout` (optional, defaults to `tools.commandRun.timeoutMs`, foreground only), `background` (optional, defaults to `false`) |
| ⏱️ **Background Status** | `commandStatus` | Query a background command task's status (running/exited/killed/orphaned-*), exit code, duration and log size; without `taskId`, returns the 5 most recent tasks | `taskId` (optional) |
| 📜 **Background Logs** | `commandLogs` | Read a background task's log incrementally: without `sinceOffset`, returns new bytes since the last read and advances the cursor; capped at 8KB per call; `tail:true` reads only the last 2KB | `taskId` (required), `sinceOffset` (optional, byte offset), `tail` (optional) |
| ⏹️ **Background Stop** | `commandStop` | Kill a background task's process tree (Windows `taskkill /T /F`; POSIX process group). Idempotent; stopping a session does NOT stop background tasks — call this explicitly | `taskId` (required) |
| 📄 **File Read** | `fileRead` | Read file content; supports reading a line range; each line is prefixed with `line: ` by default. Default caps: full reads return at most 2000 lines / 256KB, lines longer than 8192 chars are clipped, and a truncation note is appended; full reads above 16MB are rejected (use a range instead); binary files (NUL in the first 8000 bytes) are rejected | `path` (required), `startLine` (optional), `endLine` (optional), `offset` (optional, 1-based start line, alias of `startLine`), `limit` (optional, number of lines), `maxBytes` (optional, output byte cap), `encoding` (optional), `lineNumbers` (optional, defaults to `true`) |
| ✏️ **File Write** | `fileWrite` | **Whole-file write**: `overwrite` fully replaces the entire file with `content` (**the original content is permanently lost; partial/regional overwrite is NOT supported — use `editFile` for partial edits**); `append` appends to the end; parent directories are created automatically. For existing files, line endings are adapted to the file's dominant EOL (e.g. CRLF); new files keep LF; writes to the same file are automatically serialized | `path` (required), `content` (required; the complete file content when overwriting), `mode` (optional, `overwrite` / `append`) |
| 🔁 **File Edit** | `editFile` | Three modes: ① literal replacement (must appear exactly once; multiple matches error out to avoid accidental edits); ② `regex=true` regex replacement (supports `$1`/`$&` capture references); ③ whole-line-range replacement when `startLine`/`endLine` are given | `path` (required), `newText` (required), `oldText` (required unless a line range is given), `startLine` (optional), `endLine` (optional), `replaceAll` (optional, defaults to `false`), `regex` (optional, defaults to `false`), `flags` (optional, e.g. `i`/`m`/`s`) |
| 🔍 **Content Search** | `grep` | Search content in a file or directory (grep-like): supports regex, case-insensitivity and recursive search (skips `node_modules` / `.git` / `dist`, recursion depth capped at 5). **Streaming line scan**: uses `createReadStream` + `readline`, keeping only the current line in memory so GB-scale logs are never read whole; `crlfDelay: Infinity` also strips trailing `\r`, so end-of-line `$` anchors no longer mismatch on CRLF files. **Binary sniffing**: files whose first 8000 bytes contain NUL are skipped (same rule as `fileRead`). **Over-long line protection**: a line longer than 1200 chars (e.g. minified files) is clipped to 500 chars before and after the regex hit, with the elided char count and total line length annotated; short lines are returned untouched. **Hard match cap**: scanning stops early at 2000 matches (the cap grows with `maxResults`) to avoid blowing up the context, and a persisted result file honestly declares itself incomplete with a tighter-regex suggestion. When matches exceed `maxResults`, the full result is written to a temp file and its path plus a range-read hint are returned | `pattern` (required), `path` (required), `ignoreCase` (optional, defaults to `false`), `recursive` (optional, defaults to `true`), `maxResults` (optional, defaults to 50) |
| 🎯 **Skill Activation** | `activate_skill` | Activate a Skill, returning the full SKILL.md instructions **plus the skill's directory (skill dir / absolute SKILL.md path)**, making it easy to locate bundled scripts, reference docs, etc. | `name` (required) |
| 🧑‍🤝‍🧑 **Sub-agent Delegation** | `delegate` | Hand a self-contained sub-task to an independent sub-agent and return its final conclusion. The sub-agent has its own message history, shares L2/L3 memory, keeps an isolated L1 working memory, **excludes `delegate`** from its tool set (no infinite recursion), does not persist a separate session, and inherits the abort signal. The executor is injected by the parent agent at run time (`ToolContext.runSubAgent`); when absent the tool degrades with an error. Process visibility: WebUI shows a collapsible "sub-agent process" block inside the card (collapsed by default); CLI prints a one-line summary at the end and, with `verbose`, the expanded steps. `background:true` runs in parallel and returns a `sub_<id>` immediately; the result card is persisted on completion (concurrency capped by `agent.subAgent.maxConcurrent`, default 3). Completion notices reach the main agent through two channels (requirement 20261107-011): injected before the next LLM call while it is still running, or an automatic wake-up run when it has already finished. Results over 2000 chars are fully persisted to `~/.loop-agent/tmp/<sessionId>/subagent-*.txt` (reusing the 7-day TTL cleanup); the notice carries only a 400-char preview + path + a `fileRead` range-read hint, degrading to truncation if persisting fails (requirement 20261108-001) | `task` (required, self-contained description), `context` (optional background), `background` (optional, `true` = parallel background; default blocks) |
| 👁️ **Image Description** | `describe_image` | Produce an overall description of an image (subject, scene, visible text, colors, counts, etc.); use it first to get global context when unsure what to ask | `image` (required, local path or http(s) URL) |
| ❓ **Image Q&A** | `ask_image` | Answer a specific question about an image (UI text, error codes, button states, colors, counts, etc.); more precise and shorter output than `describe_image` | `image` (required), `question` (required) |
| 🧾 **Structured Extraction** | `extract_json` | Extract structured data from an image by a list of fields and return JSON (forms / tables / config screens, etc.); falls back to the raw text automatically when parsing fails | `image` (required), `fields` (required, array of field names) |
| 📝 **Text Recognition** | `ocr_image` | Recognize all text in an image (OCR), preserving the original reading order and line breaks | `image` (required) |

> **Path base**: when `commandRun` omits `cwd`, and for relative paths of the file tools (`fileRead` / `fileWrite` / `editFile` / `grep`), the base is the **root of the session's owning workspace** (`ToolContext.workspaceRoot`; out-of-bounds paths are rejected). An MCP server's working directory is fixed to the process launch directory (or an explicit value in config) and never follows workspace switches.

### Tool Usage Examples

```bash
# Command execution
commandRun({ "command": "dir", "cwd": "." })

# Run a long task in the background (dev server / watch / long tests); returns a taskId immediately
commandRun({ "command": "npm run dev", "background": true })

# Query background task status (without taskId: the 5 most recent tasks)
commandStatus({ "taskId": "bg_a1b2c3d4_1737500000" })

# Read log incrementally (no args: continue from last read; tail:true: latest 2KB only)
commandLogs({ "taskId": "bg_a1b2c3d4_1737500000", "tail": true })

# Stop a background task (kills the whole process tree)
commandStop({ "taskId": "bg_a1b2c3d4_1737500000" })

# File read (full file, numbered by default)
fileRead({ "path": "package.json" })

# File read (a line range; line numbers are the real file line numbers)
fileRead({ "path": "src/agent/react-agent.ts", "startLine": 1, "endLine": 20 })

# File read (no line numbers; returns raw content, suitable for read-modify-write)
fileRead({ "path": "src/agent/react-agent.ts", "lineNumbers": false })

# File write (overwrite = whole-file replacement: content IS the complete file; original content is lost)
fileWrite({ "path": "output.txt", "content": "Hello World", "mode": "overwrite" })

# File write (append to the end, preserving existing content)
fileWrite({ "path": "output.txt", "content": "\nMore text", "mode": "append" })

# Partial edit of an existing file (do NOT use fileWrite overwrite — it loses content) → use editFile
editFile({ "path": "output.txt", "oldText": "Hello World", "newText": "Hello TRAE" })

# Text replacement (literal match; add replaceAll explicitly when there are multiple matches)
editFile({ "path": "src/config/schema.ts", "oldText": "gpt-4o-mini", "newText": "deepseek-chat" })

# Regex replacement (regex=true, supports flags and $1 capture references)
editFile({ "path": "src/version.ts", "oldText": "v\\d+\\.\\d+\\.\\d+", "newText": "v2.0.0", "regex": true })

# Whole-line-range replacement (replace lines 10-12 with newText; an empty newText deletes those lines)
editFile({ "path": "src/a.ts", "startLine": 10, "endLine": 12, "newText": "// TODO" })

# Line-range replacement + oldText check (optional; guards against line-number drift)
editFile({ "path": "src/a.ts", "startLine": 10, "endLine": 12, "oldText": "function legacy() {", "newText": "function modern() {" })

# Content search
grep({ "pattern": "config", "path": "src", "ignoreCase": true, "maxResults": 20 })

# Big-file / log search (streaming scan without reading whole file; binary skipped; over-long minified lines auto-clipped)
grep({ "pattern": "ERROR|FATAL", "path": "logs/app.log" })

# Skill activation (progressive loading; returns the full SKILL.md content + skill dir / absolute SKILL.md path)
activate_skill({ "name": "example-skill" })

# Sub-agent delegation (runs in an isolated sub-agent; the result comes back as an observation)
delegate({ "task": "Research this project's three-tier memory implementation and summarize the key points", "context": "The project root is the current workspace" })

# Two unrelated tasks in parallel background mode: returns taskIds immediately, the main agent keeps reasoning
delegate({ "task": "Count lines of code per directory under src/", "background": true })
delegate({ "task": "List outdated design docs under docs/", "background": true })

# Image description (local paths are auto-converted to base64 data URLs; requires vision.enabled = true)
describe_image({ "image": "screenshots/login.png" })

# Image Q&A (accepts a local path or an http(s) URL)
ask_image({ "image": "https://example.com/chart.png", "question": "Which month does the tallest bar in this chart correspond to?" })

# Structured extraction (returns a JSON string; falls back to the raw text when parsing fails)
extract_json({ "image": "invoice.png", "fields": ["title", "amount", "date"] })

# Text recognition (OCR; preserves the original reading order and line breaks)
ocr_image({ "image": "receipt.jpg" })
```
