# 🔧 Built-in Tools

> [⬅ Back to README](../../../README.md)

| Tool | Name | Description | Parameters |
|---|---|---|---|
| 🖥️ **Command Execution** | `commandRun` | Execute a shell command locally, returning stdout + stderr | `command` (required), `cwd` (optional), `timeout` (optional, defaults to 30000ms) |
| 📄 **File Read** | `fileRead` | Read file content; supports reading a line range; each line is prefixed with `line: ` by default. Default caps: full reads return at most 2000 lines / 256KB, lines longer than 8192 chars are clipped, and a truncation note is appended; full reads above 16MB are rejected (use a range instead); binary files (NUL in the first 8000 bytes) are rejected | `path` (required), `startLine` (optional), `endLine` (optional), `offset` (optional, 1-based start line, alias of `startLine`), `limit` (optional, number of lines), `maxBytes` (optional, output byte cap), `encoding` (optional), `lineNumbers` (optional, defaults to `true`) |
| ✏️ **File Write** | `fileWrite` | **Whole-file write**: `overwrite` fully replaces the entire file with `content` (**the original content is permanently lost; partial/regional overwrite is NOT supported — use `editFile` for partial edits**); `append` appends to the end; parent directories are created automatically | `path` (required), `content` (required; the complete file content when overwriting), `mode` (optional, `overwrite` / `append`) |
| 🔁 **File Edit** | `editFile` | Three modes: ① literal replacement (must appear exactly once; multiple matches error out to avoid accidental edits); ② `regex=true` regex replacement (supports `$1`/`$&` capture references); ③ whole-line-range replacement when `startLine`/`endLine` are given | `path` (required), `newText` (required), `oldText` (required unless a line range is given), `startLine` (optional), `endLine` (optional), `replaceAll` (optional, defaults to `false`), `regex` (optional, defaults to `false`), `flags` (optional, e.g. `i`/`m`/`s`) |
| 🔍 **Content Search** | `grep` | Search content in a file or directory; supports regex, case-insensitivity and recursive search | `pattern` (required), `path` (required), `ignoreCase` (optional), `recursive` (optional), `maxResults` (optional, defaults to 50) |
| 🎯 **Skill Activation** | `activate_skill` | Activate a Skill, returning the full SKILL.md instructions **plus the skill's directory (skill dir / absolute SKILL.md path)**, making it easy to locate bundled scripts, reference docs, etc. | `name` (required) |
| 👁️ **Image Description** | `describe_image` | Produce an overall description of an image (subject, scene, visible text, colors, counts, etc.); use it first to get global context when unsure what to ask | `image` (required, local path or http(s) URL) |
| ❓ **Image Q&A** | `ask_image` | Answer a specific question about an image (UI text, error codes, button states, colors, counts, etc.); more precise and shorter output than `describe_image` | `image` (required), `question` (required) |
| 🧾 **Structured Extraction** | `extract_json` | Extract structured data from an image by a list of fields and return JSON (forms / tables / config screens, etc.); falls back to the raw text automatically when parsing fails | `image` (required), `fields` (required, array of field names) |
| 📝 **Text Recognition** | `ocr_image` | Recognize all text in an image (OCR), preserving the original reading order and line breaks | `image` (required) |

> **Path base**: when `commandRun` omits `cwd`, and for relative paths of the file tools (`fileRead` / `fileWrite` / `editFile` / `grep`), the base is the **root of the session's owning workspace** (`ToolContext.workspaceRoot`; out-of-bounds paths are rejected). An MCP server's working directory is fixed to the process launch directory (or an explicit value in config) and never follows workspace switches.

### Tool Usage Examples

```bash
# Command execution
commandRun({ "command": "dir", "cwd": "." })

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

# Skill activation (progressive loading; returns the full SKILL.md content + skill dir / absolute SKILL.md path)
activate_skill({ "name": "example-skill" })

# Image description (local paths are auto-converted to base64 data URLs; requires vision.enabled = true)
describe_image({ "image": "screenshots/login.png" })

# Image Q&A (accepts a local path or an http(s) URL)
ask_image({ "image": "https://example.com/chart.png", "question": "Which month does the tallest bar in this chart correspond to?" })

# Structured extraction (returns a JSON string; falls back to the raw text when parsing fails)
extract_json({ "image": "invoice.png", "fields": ["title", "amount", "date"] })

# Text recognition (OCR; preserves the original reading order and line breaks)
ocr_image({ "image": "receipt.jpg" })
```
