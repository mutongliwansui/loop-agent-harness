# 📁 Project Structure

> [⬅ Back to README](../../../README.md)

```
loop-agent-command/
├── src/
│   ├── index.ts                      # 🚪 CLI entry (interactive REPL + multi-command support)
│   ├── config.ts                     # ⚙️ Env-var config (deprecated; kept for legacy code — use config/index.ts)
│   ├── debug.ts                      # 📝 Debug logging (file output: LLM/tool/iteration logs)
│   ├── types.ts                      # 📐 Core type definitions (Tool, ChatMessage, AgentEvents, etc.)
│   ├── agent/
│   │   ├── react-agent.ts            # 🔄 ReAct main loop (streaming version + session auto-save)
│   │   ├── prompt.ts                 # 📝 System Prompt builder (incl. Skill metadata injection)
│   │   ├── logger.ts                 # 🎨 ConsoleLogger (colored log output, implements AgentEvents)
│   │   └── stats.ts                  # 📊 LLM stats aggregation (buildLLMStatsSummary)
│   ├── llm/
│   │   └── client.ts                 # 🤖 LLM client (chat + chatStream + auto-retry)
│   ├── api/                          # 🌐 HTTP API service layer (shared backend for --serve and the WebUI)
│   │   ├── router.ts                 # Route registration (createRoutes, reflection source for the developer center)
│   │   ├── server.ts                 # HTTP server (token auth / static hosting / SSE)
│   │   ├── handlers/                 # Resource handlers (sessions/messages/tools/models/mcp/memory/…)
│   │   ├── subagent-notice.ts        # Background sub-agent completion notice builder (full persistence of oversized results)
│   │   └── run-journal.ts            # Run lifecycle journal (running/done/failed/aborted)
│   ├── config/                       # ⚙️ Layered configuration system
│   │   ├── index.ts                  # Unified exports
│   │   ├── schema.ts                 # Config type definitions + defaults (incl. skill / memory sections)
│   │   ├── loader.ts                 # Config loader (layered merge)
│   │   ├── writer.ts                 # Config writer (persistence)
│   │   ├── merge.ts                  # Deep merge utility
│   │   └── mcp-manager.ts            # MCP lifecycle manager
│   ├── skill/                        # 🎯 Skills
│   │   ├── index.ts                  # Unified exports
│   │   ├── types.ts                  # Skill type definitions (SkillMetadata / SkillContent)
│   │   ├── scanner.ts                # Directory scanning + SKILL.md YAML frontmatter parsing
│   │   └── loader.ts                 # SkillLoader (scan / progressive loading)
│   ├── memory/                       # 🧠 Three-tier memory management (Phases 1-5)
│   │   ├── index.ts                  # Unified exports
│   │   ├── types.ts                  # Memory type definitions + default config
│   │   ├── working.ts                # L1 WorkingMemory (token estimation + compaction)
│   │   ├── episodic.ts               # L2 EpisodicMemory (daily Markdown journal + retrieval)
│   │   ├── curated.ts                # L3 CuratedMemory (SOUL/USER/MEMORY read-write)
│   │   ├── context.ts                # ContextAssembler (L3 injection + L2 retrieval assembly)
│   │   ├── callback.ts               # ToolMemoryCallback (auto-write tool results to L2)
│   │   ├── gate.ts                   # PromotionGate (promotion gate: confirmation counts/thresholds)
│   │   ├── dreaming.ts               # DreamingPipeline (background L2 → L3 promotion)
│   │   ├── fts.ts                    # MemoryIndex (BM25 full-text search + tokenization)
│   │   ├── embedding.ts              # EmbeddingClient (vector embedding client)
│   │   ├── vector.ts                 # VectorMemory (vector store + cosine similarity)
│   │   └── hybrid.ts                 # Hybrid retrieval (FTS + vector RRF fusion)
│   ├── session/                      # 💾 Session persistence (encrypted storage)
│   │   ├── index.ts                  # Unified exports
│   │   ├── store.ts                  # SessionStore (session read/write/index/workspace isolation)
│   │   ├── keychain.ts               # Keychain (master key auto-generation/loading/backup)
│   │   ├── crypto.ts                 # Crypto primitives (PBKDF2 + AES-256-GCM)
│   │   └── types.ts                  # Session type definitions + default config
│   ├── documents/                    # 📄 Document parsing (reused by fileRead)
│   │   ├── detect.ts                 # Type detection (extension + magic bytes)
│   │   ├── extract.ts                # Extraction dispatcher (incl. in-document image OCR assembly)
│   │   ├── word.ts / pptx.ts / xlsx.ts / odt.ts / rtf.ts / pdf.ts   # Per-format body text extraction
│   │   ├── images.ts                 # Embedded image extraction + OCR results assembled into [Image N] blocks
│   │   ├── pdf-raster.ts             # Page-by-page rasterisation of scanned PDFs (pdftoppm / mutool / gs)
│   │   ├── external.ts               # External converter invocation (docx/pdf fallback)
│   │   ├── text.ts                   # Plain-text reading (line range / truncation / encoding)
│   │   └── zip-text.ts               # Zip text flattening (avoids binary noise)
│   ├── ocr/                          # 🔍 Local OCR engines (zero dependency)
│   │   ├── index.ts                  # Engine factory + availability probing
│   │   ├── engine-winrt.ts           # Windows.Media.Ocr (invoked via powershell.exe)
│   │   ├── engine-http.ts            # Optional HTTP OCR endpoint
│   │   ├── run-ocr.ts                # Single-image orchestration (timeout / cache / throttling / error mapping)
│   │   ├── postprocess.ts            # Line-break repair and post-processing
│   │   └── cache.ts                  # LRU result cache (file fingerprints in the key)
│   └── tools/
│       ├── index.ts                  # 🛠️ Tool system aggregate entry
│       ├── ocrImage.ts               # 🔤 Built-in tool: image text recognition (ocrImage)
│       ├── registry.ts               # 📋 Tool registry (register/query/convert to OpenAI format/MCP mgmt)
│       ├── runner.ts                 # ⚡ Tool runner (timeout control + exception capture)
│       ├── commandRun.ts             # 🖥️ Built-in tool: command execution
│       ├── fileRead.ts               # 📄 Built-in tool: file read
│       ├── fileWrite.ts              # ✏️ Built-in tool: file write
│       ├── editFile.ts               # 🔁 Built-in tool: text edit (literal/regex/line-range)
│       ├── grep.ts                   # 🔍 Built-in tool: content search
│       ├── activateSkill.ts          # 🎯 Built-in tool: Skill activation (progressive loading)
│       ├── vision/                   # 👁️ Vision tools (multimodal vision model integration)
│       │   ├── tools.ts              # Vision tool analyzeImage (description / targeted Q&A / structured extraction merged)
│       │   ├── image.ts              # Image resolution (local → base64 data URL / URL validation / size limits)
│       │   ├── cache.ts              # LRU result cache (local file fingerprints in the key; auto-invalidated on content change)
│       │   └── stats.ts              # Usage stats (success / failure / cache hits / elapsed / tokens)
│       └── mcp/                      # 🌐 MCP tool integration
│           ├── index.ts              # Entry
│           ├── client.ts             # MCP client (stdio / SSE transport)
│           └── adapter.ts            # MCP tool adapter (converts to the Tool interface)
├── examples/
│   └── run.ts                        # 📝 Programmatic usage example
├── tests/                            # 🧪 Tests (unit parallel / integration serial, layering in vitest.config.ts)
│   ├── integration/                  # Integration tests (8 test files / 17 cases, real LLM/PTY, serial)
│   │   ├── a-no-tool.test.ts         # Scenario requiring no tools
│   │   ├── b-single-tool.test.ts     # Single tool call
│   │   ├── c-multi-tool.test.ts      # Multiple tool calls
│   │   ├── d-tool-failure.test.ts    # Tool execution failure
│   │   ├── e-unknown-tool.test.ts    # Tool does not exist
│   │   ├── f-max-iterations.test.ts  # Reaching the max iterations
│   │   └── g-parallel-tools.test.ts  # Parallel tools in the same round
│   ├── memory-working.test.ts        # L1 working memory (token estimation + compaction)
│   ├── memory-callback.test.ts       # Tool callback auto-writes to L2
│   ├── memory-flush.test.ts          # L2 daily log flush
│   ├── memory-dreaming.test.ts       # Dreaming promotion pipeline
│   ├── memory-gate.test.ts           # Promotion Gate
│   ├── memory-phase4.test.ts         # Phase 4 hybrid retrieval
│   ├── memory-phase5.test.ts         # Phase 5 vector retrieval
│   ├── session-isolation.test.ts     # Session workspace isolation
│   ├── edit-file.test.ts             # editFile text-edit tool (literal/regex/line-range)
│   ├── file-read.test.ts             # fileRead line-number output
│   ├── activate-skill.test.ts        # activate_skill outputs the skill dir / SKILL.md path
│   ├── system-prompt.test.ts         # Skill block injection into the System Prompt
│   ├── llm-stats.test.ts             # LLM stats aggregation
│   ├── vision-cache.test.ts          # Vision result cache (LRU / TTL / file-fingerprint invalidation)
│   ├── vision-image.test.ts          # Image resolution (local → base64 / URL / size & format validation)
│   ├── vision-client.test.ts         # chatVision multimodal client (jsonMode / error-context rewrite / retry)
│   ├── vision-registry.test.ts       # Vision tool registration (vision.enabled gating / Tab-completion list)
│   ├── vision-tools.test.ts          # Vision tool pipeline (parsing / cache / fallback / truncation)
│   └── vision-command.test.ts        # /vision command (status / test)
├── docs/
│   ├── plan.md                       # 📋 Overall dev plan and milestones
│   ├── openclaw_memory_management.md # 🧠 Memory management design reference (OpenClaw style)
│   └── tasks/                        # 📂 Per-task docs (15 tasks, incl. memory Phases 1-5 and LLM stats)
├── .loop-agent/                      # 📋 Workspace config and Skills (.agent-config.json + skills/, all git-ignored)
│   ├── .agent-config.json            # ⚙️ Workspace config (optional, generated at runtime)
│   └── skills/                       # 🎯 Workspace Skills (example-skill, py-pptx, etc.)
├── memory/                           # 🧠 L2 episodic memory (generated at runtime, split by day)
├── SOUL.md                           # 🧠 L3: agent persona
├── USER.md                           # 🧠 L3: user profile
├── MEMORY.md                         # 🧠 L3: distilled facts
├── .env                              # 🔒 Environment variables (create by copying .env.example)
├── .env.example                      # 📄 Env-var template
├── .mcp.json                         # 🔌 MCP config (optional, copy from .mcp.json.example)
├── .mcp.json.example                 # 📄 MCP config template
├── package.json
├── tsconfig.json
├── vitest.config.ts                  # 🧪 Test config (unit parallel / integration serial layers)
└── README.md                         # 📖 Project documentation
```
