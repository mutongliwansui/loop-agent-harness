# 🏗️ Architecture

> [⬅ Back to README](../../../README.md)
>
> 📊 A **structured Mermaid version** of the ASCII diagrams on this page (layered architecture, ReAct control flow, three-tier memory, config merging, tool wiring, core class relations) is available in [Architecture Diagrams (Mermaid)](../../mermaid-architecture.md).


```
┌──────────────────────────────────────────────────────────────┐
│                         CLI / API                            │
│        (src/cli/ · src/api/ · src/runtime/ · src/index.ts)   │
├──────────────────────────────────────────────────────────────┤
│                      ReAct Agent                             │
│                    (react-agent.ts)                          │
│   ┌──────────────┐  ┌───────────────┐  ┌────────────────┐  │
│   │ System Prompt │  │  Event System │  │  ChatHistory   │  │
│   │  (prompt.ts)  │  │  (logger.ts)  │  │ (multi-turn)   │  │
│   └──────────────┘  └───────────────┘  └────────────────┘  │
├──────────────────────────────────────────────────────────────┤
│                     LLM Client                               │
│                   (llm/client.ts)                            │
│          chat() / chatStream() + auto-retry (backoff)       │
├──────────────────────────────────────────────────────────────┤
│                     Tool System                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Registry    │  │   Runner     │  │  MCP Adapter     │  │
│  │ (register/   │  │ (execute/    │  │ (external tool   │  │
│  │  query)      │  │  timeout)    │  │  adaptation)     │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
├──────────────────────────────────────────────────────────────┤
│                  Configuration System                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  ConfigLoader│  │  ConfigWriter│  │  MCPManager      │  │
│  │ (layered     │  │ (persistence)│  │ (lifecycle mgmt) │  │
│  │  loading)    │  │              │  │                  │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
├──────────────────────────────────────────────────────────────┤
│                     Skill System                            │
│    scanner (scan) │ loader (load) │ activate_skill tool     │
├──────────────────────────────────────────────────────────────┤
│                     Memory System                           │
│    Working(L1) │ Episodic(L2) │ Curated(L3) │ Callback     │
├──────────────────────────────────────────────────────────────┤
│                   Session System                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ SessionStore │  │   Keychain   │  │  Crypto (AES-GCM)│  │
│  │ (read/write) │  │ (key mgmt)   │  │  (encrypt/decrypt)│ │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
├──────────────────────────────────────────────────────────────┤
│                   Built-in Tools                             │
│ commandRun │ fileRead │ fileWrite │ grep │ activate_skill   │
└──────────────────────────────────────────────────────────────┘
```

### ReAct Loop Flow

```
  ┌─────────────────────────────────────────────────────┐
  │  1. Build messages (system + user, or reuse history) │
  └────────────────────┬────────────────────────────────┘
                       │
                       ▼
  ┌─────────────────────────────────────────────────────┐
  │  2. Stream-call the LLM (chatStream)                 │
  │     Real-time Thought via events.onLLMStream         │
  └────────────────────┬────────────────────────────────┘
                       │
                       ▼
  ┌─────────────────────────────────────────────────────┐
  │  3. Get the full LLMResponse after the stream ends   │
  └────────────────────┬────────────────────────────────┘
                       │
                       ▼
          ┌────────────────────────────┐
          │  4. Check tool_calls       │
          │                            │
          │   ┌─── no tool_calls ──┐   │
          │   │ Return content as  │   │
          │   │   Final Answer     │   │
          │   └────────────────────┘   │
          │                            │
          │   ┌─── has tool_calls ─┐   │
          │   │ Run all tools      │   │
          │   │ concurrently;      │   │
          │   │ concatenate        │   │
          │   │ Observations back  │   │
          │   │ into messages      │   │
          │   └────────┬───────────┘   │
          └────────────┼───────────────┘
                       │
                       ▼
          ┌────────────────────────────┐
          │  5. Back to step 2, keep    │
          │     iterating               │
          └────────────────────────────┘
                       │
          ┌────────────┴────────────┐
          │  6. Max iterations       │
          │  reached → throw error,  │
          │  exit gracefully         │
          └─────────────────────────┘
```

> After `run()` completes, if a session store is configured (`session.autoSave=true`), the current messages and steps are automatically encrypted and saved to disk.

### Layered Config Loading

```
Load priority (high → low):
  CLI args > global config (~/.loop-agent/config.json)
           > environment variables (.env)
           > defaults (DEFAULT_CONFIG)
  (the workspace layer .loop-agent/.agent-config.json was removed in req 20261112-008)
```

### Workspace Runtime

In HTTP serve mode (`--serve`), the process no longer has a single "current workspace". A `WorkspaceRegistry` lazily creates one immutable `WorkspaceRuntime` per workspace and caches them with an LRU (up to 4 entries):

```
WorkspaceRegistry (lazy creation + LRU, up to 4)
  key   = canonicalWorkspacePath(root) → workspaceId
  value = WorkspaceRuntime (immutable)
            ├─ SessionStore         session storage (one per workspace)
            ├─ sessions             session scheduling (busy only applies to the same workspace + session)
            ├─ AgentPool            agent pool (leased by sessionId)
            └─ memoryKit            three-tier memory (handles released on LRU eviction)

Process-level singletons (shared across workspaces, never evicted by the LRU):
  ConfigLoader / ConfigWriter / SkillLoader / McpManager / McpMonitor

Fallback and throttling:
  ├─ AsyncLocalStorage<{root,id}>: deep code paths that missed the refactor can still read the current workspace
  └─ Global concurrency semaphore (8): caps the total number of runs in the process
```

Key points:

- `sessionId` carries a workspace segment (`sess_<wsId8>_<ts>`), so the owning runtime is located by id alone; endpoints such as `GET /sessions/:id` and `POST /sessions {workspacePath}` no longer "switch workspace", and `switched` is always `false`;
- Tool relative paths resolve against `ToolContext.workspaceRoot` (the default cwd of `commandRun` is the owning workspace root); the process-level `process.chdir` has been removed;
- Runs in different workspaces never block each other: while a run is active in workspace A, you can create sessions and start new runs in workspace B;
- The CLI single-space mode bypasses the Registry: the launch directory is the only workspace, exactly as before.
