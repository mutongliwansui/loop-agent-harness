# 🔍 Troubleshooting

> [⬅ Back to README](../../../README.md)

### Invalid or Expired API Key

```
Error: Invalid or expired API Key. Please check OPENAI_API_KEY in .env
```

**Fix**: Check whether `OPENAI_API_KEY` in `.env` is correct and matches the provider for `OPENAI_BASE_URL`. You can also change it at runtime via `/config set model.apiKey <key>`.

### Model Does Not Exist (404)

```
Error: Model does not exist (404). Please check MODEL_NAME in .env (current: xxx)
```

**Fix**: Confirm that `MODEL_NAME` is available on the target provider. Change it at runtime via `/config set model.name <new-model-name>`.

### Too Many Requests (429)

```
Error: Too many requests (429). Please retry later or reduce the call frequency
```

**Fix**: Reduce the call frequency. Integration tests run serially by default (`fileParallelism: false`) to avoid concurrent rate limiting.

### Tool Execution Timeout

```
Error: Tool execution timed out (30000ms)
```

**Fix**: The `commandRun` tool has a default 30s timeout, adjustable via the `timeout` parameter. For complex commands, split them into multiple steps.

### Windows Terminal Garbled Chinese

**Fix**: The CLI already runs `chcp 65001` on startup to switch to UTF-8. If garbling persists, manually run `chcp 65001` before starting.

### Reaching Max Iterations

```
Error: Reached max iterations 10; the agent could not produce a final answer
```

**Fix**: Increase `MAX_ITERATIONS` in `.env`, or change it at runtime via `/config set model.maxIterations 20`. You can also simplify the question so the agent finishes in fewer steps.

### Tool Not Registered

```
Error: Tool xxx is not registered
```

**Fix**: Call `registerBuiltinTools()` to register the built-in tools, or register a custom tool via `registry.register(tool)`. You can also reload via `/tools reload`.

### MCP Connection Failure

```
Error: MCP server xxx failed to connect
```

**Fix**: Check whether the MCP config is correct; run `/mcp test <name>` to test the connection. Remove with `/mcp remove <name>` and re-add with `/mcp add <name>`.

### Skill Not Found

```
Error: Skill "xxx" not found. Available Skills: ...
```

**Fix**: Confirm the Skill is placed in `~/.loop-agent/skills/` (global) or `<cwd>/.loop-agent/skills/` (workspace), and that `SKILL.md` contains a valid `name` and `description` frontmatter. View scan results via `/skill list`, and rescan via `/skill reload`.

### Memory System Not Enabled

```
⚠ Memory system not enabled. Please set memory.enabled=true in the config
```

**Fix**: Enable via `/config set memory.enabled true`, or edit `.loop-agent/.agent-config.json` directly. `/memory status` shows the current enabled state and per-tier stats.

### Session Cannot Be Loaded / Decryption Failure

```
Error: Key file is corrupted; verification failed
Error: Key not loaded; cannot read session
```

**Fix**:
- Check that `~/.loop-agent/.keyfile` exists and is not corrupted
- If accidentally deleted/corrupted, restore it by calling `keychain.importKey()` with the base64 exported earlier via `exportKey()`
- If it cannot be recovered, delete the corrupted session file (`/session delete <id>`) and start over

### Debug Logs Not Generated

**Fix**: Confirm debug mode is enabled via the `DEBUG=true` environment variable or `/config set agent.debug true`; logs output to `~/.loop-agent/logs/debug-YYYY-MM-DD.log`. Once enabled, the CLI startup banner shows the debug log directory hint.

### Config Source Tracing

When config doesn't take effect as expected, use `/config list` to see each field's actual source (cli / workspace / global / env / default) and quickly identify which layer overrode it.
