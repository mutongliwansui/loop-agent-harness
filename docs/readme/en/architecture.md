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
│ commandRun │ fileRead │ fileWrite │ grep │ activateSkill    │
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
  CLI args > workspace config (.loop-agent/.agent-config.json)
           > global config (~/.loop-agent/config.json)
           > environment variables (.env)
           > defaults (DEFAULT_CONFIG)
```
