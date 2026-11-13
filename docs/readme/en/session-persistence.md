# 💾 Session Persistence

> [⬅ Back to README](../../../README.md)

The agent has built-in file-system-based session persistence: the conversation history (messages + steps) is encrypted on the local disk, and after restarting the CLI you can restore context with `/session load <id>` and continue.

### Storage Structure

```
~/.loop-agent/
├── .keyfile                      # 🔑 Master key file (auto-generated on first use, mode 0600)
├── config.json                   # Global config (optional)
├── logs/
│   └── debug-YYYY-MM-DD.log      # 📝 Debug logs (see the next section)
└── sessions/
    └── {workspaceId}/            # Isolated by workspace (first 16 chars of the SHA-256 of the canonicalized path: case/separator/trailing-slash normalized)
        ├── meta.json             # Workspace metadata
        ├── sessions.json         # Session index (metadata only, no message content)
        └── sess_{wsId8}_YYYYMMDD_HHMMSS.enc   # Encrypted session data file (id carries a workspace segment; wsId8 = first 8 chars of workspaceId)
```

> **sessionId workspace namespace**: the new format is `sess_<wsId8>_<timestamp>` — the owning workspace is located from the id alone (HTTP endpoints no longer switch the "current workspace" because of this); legacy `sess_<timestamp>` ids (no workspace segment) remain readable forever, located via a full-scan fallback.

### Created On Demand (Nothing Is Written Up Front)

A workspace directory is **created only on the first real session write**: starting the server, deriving the default (recent) workspace on a cold start, and initializing memory never create `sessions/{workspaceId}/` or `memory/`. Therefore:

- After a fresh start, `~/.loop-agent/` contains only `.keyfile`, `config.json`, `skills/` and the like — **no** `sessions/` or `memory/`;
- `sessions/{workspaceId}/{meta.json,sessions.json,sess_*.enc}` appears only once the first session is created;
- The memory directory is likewise created on demand (the first time that workspace uses memory).

Whether a workspace directory "has real sessions" is decided by **content existing**, not by metadata existing: the directory contains `sess_*` session body files (`.json` / `.enc`), or `sessions.json` parses to a non-empty array. A directory holding only `meta.json` does not count.

### Legacy Ghost Workspaces (Warn Only)

Older versions provisioned a workspace at startup and wrote it to disk immediately, which may have left behind **residual directories containing only `meta.json` and no sessions** (called "ghost workspaces"). These directories now:

- are never chosen as the "recent" default workspace;
- do not appear in `GET /workspaces` or the WebUI sidebar (zero-session groups are filtered out).

On startup the server **scans read-only** for such residue and, if found, warns in the startup log and appends one JSON line to `~/.loop-agent/ghost-workspaces.log` (rewritten once it exceeds 256KB, so it never grows without bound):

```
  ├─ 1 legacy ghost workspace(s) (left over from startup provisioning; warn only, not cleaned; delete the sessions/ dir yourself if you are sure it is unused)
  │    · 776e97820388b15d  C:\Users\muton  (only meta.json, no session files)
  │    details: C:\Users\muton\.loop-agent\ghost-workspaces.log
```

> The lines above are paraphrased; the actual startup output is in Chinese, e.g. `存量幽灵空间 1 个（旧版启动预装残留，仅告警不清理…）`. The `ghost-workspaces.log` entries are JSON (`{ts, count, ghosts:[{wsId, workspacePath, reason}]}`) and independent of locale.

> **This project never cleans up automatically**: the program does not delete, rename or move any workspace directory, and there is no "one-click cleanup" endpoint. Once you have confirmed a directory is unused, delete `~/.loop-agent/sessions/{workspaceId}/` (and the possibly existing `~/.loop-agent/memory/{workspaceId}/`) yourself.
>
> The detection rule is deliberately conservative: if a directory contains anything other than `meta.json` / `sessions.json` (`sess_*` session bodies, a `runs/` subdirectory, any other stray file), it is treated as a real workspace and never reported — under-reporting is preferred over risking the deletion of a workspace in use.


### Encryption

- **Master key**: A 256-bit random key is auto-generated on first use and stored in `~/.loop-agent/.keyfile` (mode `0600`); no user password required
- **Data encryption**: Session messages are encrypted with **PBKDF2 (100,000 iterations) derivation** + **AES-256-GCM**, with an authentication tag ensuring integrity
- **Key verification**: The key file contains a verification token; the key's integrity is checked on read, and corruption raises an error
- **Plaintext index**: `sessions.json` stores only session metadata (ID, title, message count, time); all message content is encrypted

### Auto-save / Restore

- **Auto-save**: After `run()`, if `session.autoSave=true` and a SessionStore is set, a new session is created or the current one updated automatically
- **Auto-restore**: When `session.autoRestore=true`, the CLI loads the most recent session on startup, seamlessly continuing the last conversation
- **Manual control**: Use the `/session` subcommands at any time — list / load / save / new / delete

### Key Management (Keychain)

`src/session/keychain.ts` provides key lifecycle management:

| Method | Description |
|---|---|
| `keychain.ensureUnlocked()` | Ensure the key is loaded (auto-generates the key file on first use) |
| `keychain.exportKey()` | Export the master key (base64, for backup) |
| `keychain.importKey(base64)` | Import the master key from a backup (for migration/restore) |
| `keychain.reset()` | Delete the key file (⚠️ makes all encrypted sessions undecryptable) |

> ⚠️ **Important**: `.keyfile` is the sole credential for decrypting sessions. Losing this file makes all encrypted sessions unrecoverable. Back up regularly via `exportKey()`.
