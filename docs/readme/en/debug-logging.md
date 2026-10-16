# 📝 Debug Logging

> [⬅ Back to README](../../../README.md)

The agent has a built-in file-based debug logging system (`src/debug.ts`) that records LLM requests/responses, tool calls and agent iterations to local files for troubleshooting.

### Enabling

```bash
# Option 1: environment variable
DEBUG=true npm start

# Option 2: runtime config
/config set agent.debug true
```

Once enabled, the CLI prints on startup:

```
⚠ Debug mode enabled, logs output to: C:\Users\xxx\.loop-agent\logs
```

### Log Location and Rotation

- **Location**: `~/.loop-agent/logs/debug-YYYY-MM-DD.log` (split by date)
- **Rotation**: max **10MB** per file; auto-rotates when exceeded, keeping up to **5** historical files
- **Redaction**: API keys in logs are automatically redacted (only the first and last 4 characters are shown)

### Log Content

| Type | Trigger | Recorded Content |
|---|---|---|
| `llmRequest` | Every LLM request | Model, message count, tool count, redacted parameters |
| `llmResponse` | LLM response returned | Content (truncated to 300 chars), tool calls, duration |
| `llmError` | LLM call error | Error message, duration |
| `toolCall` | Every tool call | Tool name, parameters, result (all truncated), duration |
| `iteration` | Every agent iteration | Thought / Action / Observation |
| `session` | Every `run()` start | Message count, tool count, session ID |

### Programmatic Read

```typescript
import { debug } from './src/debug.js';

// Current log file path
const logPath = debug.getLogPath();

// Read recent log content (defaults to at most 10000 chars)
const content = debug.readLog(10000);
```
