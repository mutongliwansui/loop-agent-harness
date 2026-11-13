# 🚀 SEA Single-file Deployment

> [⬅ Back to README](../../../README.md)

Package the agent into a **single executable** (Node SEA, Single Executable Applications). On-site deployment **requires no Node.js and no dependencies** — just run it directly.

### Build

```bash
# Build machine requires Node.js >= 20.10
npm run build:sea
```

The artifacts are output to `dist-sea/`:

| Platform | Artifact | Description |
|---|---|---|
| Windows | `dist-sea/loop-agent.exe` | Verified in practice (Node v24) |
| Linux | `dist-sea/loop-agent` | Must be built on Linux |
| macOS | `dist-sea/loop-agent` | Must be built on macOS |
| All | `dist-sea/node_modules/@lydell/` | **Optional**: legacy distribution shape. Not required — the exe already embeds the native module (see below) |

> **No cross-compilation**: Node SEA requires building **on the target OS** (a Windows artifact only runs on Windows). Whichever OS the site uses, run `npm run build:sea` once on that OS.

> **Shipping the exe alone is enough**: the build script embeds the whole `@lydell/node-pty`
> native tree into the exe. On first terminal use it extracts itself to
> `%TEMP%/loop-agent-pty-<hash>/` (about 1.59 MB / 24 files on Windows), then reuses that directory
> by content hash — upgrading the exe creates a fresh directory and never disturbs a running old instance.
>
> Resolution order is **disk first, embedded as fallback**:
> 1. `node_modules/` beside the exe (upward lookup, legacy shape → on hit nothing is extracted, zero cost)
> 2. The embedded extraction directory (single-file deployment → extracted once, then reused)
>
> So the old "exe + sibling `node_modules/`" layout **still works**, while shipping only the exe now
> keeps the terminal fully functional instead of degrading to "interactive terminal unavailable".

### Run

```bash
# Windows
.\dist-sea\loop-agent.exe

# Linux / macOS (chmod +x first)
./dist-sea/loop-agent
```

The runtime experience is identical to `npm start`: enters the interactive REPL, with `/status`, `/config`, `/memory`, `/session` and other commands all available, and the memory system (L1/L2/L3) enabled.

### Build Principles

1. **Bundle**: `tsup` compiles TypeScript into a single CJS file, with all third-party dependencies inlined (`noExternal`)
2. **Generate blob**: `node --experimental-sea-config` generates a preparation blob from `sea-config.json`
3. **Inject**: copy the Node runtime as the artifact skeleton, and inject `NODE_SEA_BLOB` with `postject`
4. **Embed native deps**: embed the whole `node_modules/@lydell/node-pty` (JS wrapper) plus its
   platform sub-package `@lydell/node-pty-<platform>-<arch>` (the actual `.node`, `conpty.dll`,
   `OpenConsole.exe`) as SEA assets, while also copying a copy to `node_modules/` beside the artifact
   for the legacy layout

Why step 4 must embed the **whole tree**, not just the `.node`: `lib/*.js` requires
`prebuilds/<platform-arch>/conpty.node` via a relative path, `windowsPtyAgent.js` forks a child process
via `__dirname`, and `conpty.dll` / `OpenConsole.exe` live in a subdirectory — embedding a single
`.node` always breaks.

A `.node` cannot be dlopen'ed straight from memory (`process.dlopen()` needs a real filesystem path),
so at runtime we do "embedded asset → write temp file → load it" (see `src/terminal/pty-embed.ts`).
The extraction directory is named by content hash and guarded by a `.ready` marker plus a
**per-file size check**, giving idempotent reuse and self-healing after partial deletion;
concurrent first launches write to `.tmp-<pid>-<rand>` and then atomically rename, so no reader can ever
observe a half-written file.

There is a Windows-specific trap worth knowing: if another instance is running and has already mapped
`conpty.node` into its address space, the whole extraction directory can neither be removed
(`rmSync` → `EPERM`) nor can that file be overwritten. Instead of giving up, we **repair in place** —
writing only the missing or truncated files, and adding `.ready` last. Only when that is impossible
(the missing file is exactly the locked one) do we fall back to an alternate directory
`loop-agent-pty-<hash>-b1`. So "another instance is open" never leaves a new instance without a terminal.

Corresponding orchestration script: [scripts/build-sea.mjs](../../../scripts/build-sea.mjs) (`build:sea` in `package.json`).

### On-site Notes

| Item | Description |
|---|---|
| **MCP dependencies** | When using a stdio-type MCP server (e.g. `npx -y @modelcontextprotocol/...`), the target machine still needs Node/npx installed to spawn the subprocess; SSE type has no such requirement |
| **Global config and key migration** | On first run, `~/.loop-agent/` gets global config, `.keyfile` (session encryption master key), etc. When migrating machines, migrate these too, otherwise historical encrypted sessions can't be decrypted (back up with `keychain.exportKey()`) |
| **Working directory semantics** | The program treats the **current working directory** as the workspace root: L2 memory is written to `<cwd>/memory/`. Config and Skills are now global (`~/.loop-agent/`, see req 20261112-008) and no longer vary by directory; memory is still per-directory, so starting elsewhere yields a different "project memory context" |
| **No Node runtime needed** | The single-file artifact bundles the Node runtime; the target machine only needs the OS itself |
| **Native module is embedded** | The whole `@lydell/node-pty` tree is embedded in the exe and extracted on first terminal use to `%TEMP%/loop-agent-pty-<hash>/`. **Ship the exe only**; the legacy "exe + sibling `node_modules/`" layout still works (disk first, nothing extracted on a hit). If `%TEMP%` is unwritable or out of space, the terminal degrades and reports the paths it searched plus the failure reason. A directory locked by another instance is repaired in place; on the rare remaining failure, delete the matching `%TEMP%/loop-agent-pty-*` directory and restart |
