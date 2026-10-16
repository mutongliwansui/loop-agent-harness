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

> **No cross-compilation**: Node SEA requires building **on the target OS** (a Windows artifact only runs on Windows). Whichever OS the site uses, run `npm run build:sea` once on that OS.

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

Corresponding orchestration script: [scripts/build-sea.mjs](../../../scripts/build-sea.mjs) (`build:sea` in `package.json`).

### On-site Notes

| Item | Description |
|---|---|
| **MCP dependencies** | When using a stdio-type MCP server (e.g. `npx -y @modelcontextprotocol/...`), the target machine still needs Node/npx installed to spawn the subprocess; SSE type has no such requirement |
| **Global config and key migration** | On first run, `~/.loop-agent/` gets global config, `.keyfile` (session encryption master key), etc. When migrating machines, migrate these too, otherwise historical encrypted sessions can't be decrypted (back up with `keychain.exportKey()`) |
| **Working directory semantics** | The program treats the **current working directory** as the workspace root: L2 memory is written to `<cwd>/memory/`, and workspace config is read from `<cwd>/.loop-agent/`. Starting in a different directory yields a different "project context" |
| **No Node runtime needed** | The single-file artifact bundles the Node runtime; the target machine only needs the OS itself |
