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
    └── {workspaceId}/            # Isolated by workspace path (first 16 chars of the path's SHA-256)
        ├── meta.json             # Workspace metadata
        ├── sessions.json         # Session index (metadata only, no message content)
        └── sess_YYYYMMDD_HHMMSS.enc   # Encrypted session data file
```

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
