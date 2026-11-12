# 🧩 架构图集（Mermaid）

> 本文用 Mermaid 绘制本项目的**结构类图**——分层架构、ReAct 循环、三层记忆、配置合并、工具装配、核心类关系。
>
> 一次 `run()` 的内部控制流见 [图 3](#3️⃣-react-循环控制流)；这边画的是**系统长什么样**。
> 所有图均以 `src/` 实际代码为准（标注了对应文件），可直接当阅读源码的地图用。
>
> 相关文档：[架构设计](readme/zh/architecture.md) · [记忆管理](readme/zh/memory-management.md) · [工具扩展](readme/zh/tool-extension.md) · [配置管理](readme/zh/configuration.md)

---

## 图索引

| # | 图 | 类型 | 回答什么问题 |
|---|---|---|---|
| 1 | [系统全景](#1️⃣-系统全景四种接入形态) | flowchart | 一个仓库怎么跑出四种形态？谁复用谁？ |
| 2 | [分层架构](#2️⃣-分层架构) | flowchart | 代码分成哪几层，依赖方向如何？ |
| 3 | [ReAct 循环](#3️⃣-react-循环控制流) | flowchart | 一轮对话内部到底怎么转？ |
| 4 | [三层记忆](#4️⃣-三层记忆数据流) | flowchart | L1/L2/L3 各自存什么、落到哪个文件？ |
| 5 | [配置分层合并](#5️⃣-配置分层合并) | flowchart | 同一个配置项，谁压过谁？ |
| 6 | [工具装配](#6️⃣-工具装配与调用链) | flowchart | 10 个内置工具 + MCP 工具怎么进 `tools` 参数？ |
| 7 | [核心类关系](#7️⃣-核心类关系) | classDiagram | 核心类之间谁持有谁？ |

---

## 1️⃣ 系统全景：四种接入形态

同一个 `ReActAgent`，被四个入口以不同方式复用；`src/api` 是解耦点——CLI 走进程内直连，Web/第三方走 HTTP。

```mermaid
flowchart TB
    subgraph Entry["🖥️ 接入层"]
        direction LR
        CLI["CLI REPL<br/>src/cli/start.ts"]
        LIB["编程调用<br/>agent.run()"]
        HTTP["HTTP API<br/>src/api/server.ts"]
        WEB["Web UI · Vue3<br/>webui/dist"]
    end

    subgraph Api["🔌 API 层（仅 HTTP 形态）"]
        direction LR
        AUTH["鉴权 Bearer + 回环限制<br/>api/http-utils.ts"]
        ROUTER["声明式路由表<br/>api/router.ts"]
        H["13 组 handler<br/>api/handlers/*"]
        LOCATE["locateSession 定位归属空间<br/>api/session-locator.ts"]
        SSE["SSE 事件透传<br/>api/sse.ts"]
        STATIC["WebUI 静态资源<br/>api/static.ts"]
    end

    subgraph WSR["🗂 工作空间运行时（serve 多空间并行）"]
        direction LR
        REG["WorkspaceRegistry 懒建 + LRU(4)<br/>api/workspace-runtime.ts"]
        RT["WorkspaceRuntime 每空间六件套<br/>store · configLoader/Writer<br/>skillLoader · sessions · pool · memoryKit"]
        SEM["全局并发信号量(8)<br/>api/semaphore.ts"]
        ALSW["AsyncLocalStorage 兜底<br/>runtime/workspace-context.ts"]
    end

    subgraph Core["🧠 核心"]
        AGENT["ReActAgent<br/>agent/react-agent.ts"]
    end

    subgraph Cap["⚙️ 能力"]
        direction LR
        LLM["LLM Client<br/>llm/client.ts"]
        TOOLS["Tool Registry + Runner"]
        MCPC["MCP Client<br/>stdio / SSE / HTTP"]
        SKILL["SkillLoader"]
        MEM["三层记忆"]
        SESS["SessionStore"]
        CFG["ConfigLoader / Writer"]
    end

    subgraph Out["🌐 外部"]
        direction LR
        LLMAPI["OpenAI 协议模型<br/>OpenAI / DeepSeek / Moonshot / vLLM"]
        MCPAPI["MCP Server"]
        DISK["本地磁盘<br/>~/.loop-agent + 工作区"]
    end

    CLI --> AGENT
    LIB --> AGENT
    HTTP --> AUTH --> ROUTER --> H --> LOCATE --> RT
    REG -->|"按 canonical root 懒建"| RT
    RT -->|"pool.acquire(sessionId)"| AGENT
    SEM -->|"跨空间 run 总数上限，FIFO 排队"| RT
    H --> SSE
    H --> STATIC --> WEB
    WEB -->|"fetch / EventSource"| HTTP

    AGENT --> LLM
    AGENT -->|"runner 注入 ctx.workspaceRoot"| TOOLS
    ALSW -.->|"显式根缺失时兜底"| TOOLS
    AGENT --> SKILL
    AGENT --> MEM
    AGENT --> SESS
    AGENT --> CFG
    TOOLS --> MCPC
    LLM --> LLMAPI
    MCPC --> MCPAPI
    MEM --> DISK
    SESS --> DISK
    CFG --> DISK

    classDef entry fill:#e3f2fd,stroke:#1565c0,color:#0d47a1
    classDef api fill:#fff3e0,stroke:#ef6c00,color:#e65100
    classDef core fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20
    classDef cap fill:#f3e5f5,stroke:#6a1b9a,color:#4a148c
    classDef out fill:#eceff1,stroke:#455a64,color:#263238
    classDef ws fill:#e0f7fa,stroke:#00838f,color:#006064
    class CLI,LIB,HTTP,WEB entry
    class AUTH,ROUTER,H,LOCATE,SSE,STATIC api
    class AGENT core
    class LLM,TOOLS,MCPC,SKILL,MEM,SESS,CFG cap
    class LLMAPI,MCPAPI,DISK out
    class REG,RT,SEM,ALSW ws
```

**读图要点**

- `--serve` 时 **WebUI 与 API 同端口**：`api/static.ts` 对未注册的 `GET` 先做静态回落，命中 `webui/dist` 就返回页面，否则再进路由（见 `server.ts` 请求流注释）。
- 请求处理链：**HTTP → 鉴权 → 路由 → handler → `locateSession`（按 sessionId 定位归属空间）→ WorkspaceRuntime → pool.acquire → agent → tool(ctx.workspaceRoot)**。每个空间由 `WorkspaceRegistry` 懒建独立 runtime（会话存储、配置、技能、记忆、Agent 池六件套，LRU 上限 4），互斥只约束**同空间同会话**，跨空间 run 并行互不影响；进程级 `Semaphore(8)` 限制全局并发 run 总数（FIFO 排队不拒绝）。
- 工具路径基准：`runner.run` 显式注入 `ctx.workspaceRoot`（会话所属空间根，优先）；漏改的深层代码由 `AsyncLocalStorage`（`runtime/workspace-context.ts`）兜底——进程级 `process.chdir` 已全量移除。
- CLI 与 API 仍共享进程级 `MCPManager` 单例（MCP server 的 cwd 固定为启动目录或配置显式值，不随空间切换）；`ConfigLoader/Writer` 与 `SkillLoader` 在 serve 侧按空间各持实例，CLI 单空间模式行为不变。

---

## 2️⃣ 分层架构

依赖方向**自上而下单向**：上层知道下层，下层不知道上层（`agent/` 不 import `api/`，`memory/` 不 import `agent/`）。

```mermaid
flowchart TD
    subgraph L1["1️⃣ 表现层"]
        direction LR
        A1["src/index.ts 分发入口<br/>共享前置 src/runtime/init.ts"]
        A2["src/commands/*<br/>13 个斜杠命令"]
        A3["src/ui/*<br/>renderer · spinner · colors"]
        A4["src/api/*<br/>server · router · handlers"]
        A5["webui/src/*<br/>8 个视图"]
    end

    subgraph L2["2️⃣ 编排层"]
        B1["agent/react-agent.ts<br/>run() · initMemory() · restoreSession()"]
        B2["agent/prompt.ts<br/>System Prompt 装配"]
        B3["agent/logger.ts<br/>16 个事件钩子 → 控制台"]
        B4["agent/stats.ts<br/>token 统计汇总"]
        B5["agent/stream-forward.ts<br/>流式片段转发"]
    end

    subgraph L3["3️⃣ 能力层"]
        direction LR
        C1["llm/client.ts<br/>chat · chatStream · 重试"]
        C2["tools/*<br/>registry · runner · 内置工具"]
        C3["tools/vision · tools/ocrImage.ts · ocr/*<br/>视觉理解 + 本地 OCR"]
        C3b["documents/*<br/>文档解析 + 文档内图片 OCR"]
        C4["tools/mcp/*<br/>client · adapter"]
        C5["skill/*<br/>scanner · loader · installer"]
        C6["upload/manager.ts<br/>会话隔离上传目录"]
    end

    subgraph L4["4️⃣ 记忆层"]
        direction LR
        D1["working.ts<br/>L1 压缩"]
        D2["episodic.ts<br/>L2 日记 + FTS"]
        D3["vector.ts / embedding.ts<br/>向量检索"]
        D4["curated.ts<br/>L3 精炼"]
        D5["gate.ts<br/>晋升闸门"]
        D6["dreaming.ts<br/>后台流水线"]
        D7["context.ts<br/>上下文组装"]
    end

    subgraph L5["5️⃣ 支撑层"]
        direction LR
        E1["config/*<br/>loader · writer · merge · schema"]
        E2["session/*<br/>store · crypto · keychain"]
        E3["bootstrap/*<br/>wizard · doctor · scaffold"]
        E4["debug.ts / llm-logger.ts<br/>结构化日志"]
    end

    L1 --> L2 --> L3
    L2 --> L4
    L2 --> L5
    L3 --> L5
    L4 --> L5

    classDef l1 fill:#e3f2fd,stroke:#1565c0
    classDef l2 fill:#e8f5e9,stroke:#2e7d32
    classDef l3 fill:#fff8e1,stroke:#f9a825
    classDef l4 fill:#fce4ec,stroke:#ad1457
    classDef l5 fill:#eceff1,stroke:#455a64
    class A1,A2,A3,A4,A5 l1
    class B1,B2,B3,B4,B5 l2
    class C1,C2,C3,C4,C5,C6 l3
    class D1,D2,D3,D4,D5,D6,D7 l4
    class E1,E2,E3,E4 l5
```

**两条不变量**（改代码时值得守住的边界）

1. `api/handlers/*` 只依赖 `HandlerContext` 里的接口，不 import 具体单例 → 单测可注入 `fake runAgent` 与临时目录。
2. `memory/*` 通过 `ILLMClient` 接口拿 LLM，不直接 import `llm/client.ts` → 记忆模块可以脱离真实网络单测。

---

## 3️⃣ ReAct 循环控制流

`agent/react-agent.ts` 的 `run()` 主循环（L420 起），对应 [architecture.md](readme/zh/architecture.md) 里那张 ASCII 流程图：

```mermaid
flowchart TD
    START(["run(userInput, options)"]) --> CFG["ConfigLoader.load(cliOverride)<br/>分层合并 + CLI 临时覆盖"]
    CFG --> SK["skillLoader.scan(cwd)<br/>扫描技能包"]
    SK --> SP["buildSystemPrompt(skills, cwd, vision)<br/>可被 cfg.agent.systemPrompt 覆盖"]
    SP --> MSG["构造 messages<br/>resetHistory → options.messages<br/>→ _chatHistory → 新建"]
    MSG --> EV0["events.onStart(userInput)"]
    EV0 --> LOOP{{"i &lt; maxIterations ?"}}

    LOOP -->|"否"| ERR(["抛错：达到最大迭代次数"])
    LOOP -->|"是"| IT["events.onIterationStart(i, maxIterations)"]
    IT --> CHK{{"L1 上下文超阈值？<br/>优先用上轮真实 prompt_tokens"}}

    CHK -->|"是"| FLUSH["preCompactionFlush(messages, llm)<br/>让 LLM 先抽取关键信息"]
    FLUSH --> OK{{"抽取成功？"}}
    OK -->|"是"| W2["写入 L2 · scope=global · tag=compaction"]
    OK -->|"否"| FB["flushFailure 为 archive 时<br/>原始对话降级写入 L2"]
    W2 --> CMP["compact：保留 system + 最近 N 轮"]
    FB --> CMP
    CMP --> EV1["events.onCompaction(...)"] --> CALL
    CHK -->|"否"| CALL["llm.chatStream(messages, tools)"]

    CALL --> STREAM["流式回调<br/>onLLMStream / onToolCallDelta"]
    STREAM --> RESP["拿到完整 LLMResponse + usage"]
    RESP --> STATS["events.onLLMEnd / onLLMStats"]
    STATS --> HAS{{"存在 tool_calls ？"}}

    HAS -->|"否：最终答案"| FINAL["events.onFinal(content)"]
    FINAL --> L2W["EpisodicMemory.appendToday<br/>scope=session"]
    L2W --> BRK(["break → onEnd → AgentResult"])

    HAS -->|"是"| PUSH["push assistant 消息，携带 tool_calls"]
    PUSH --> TS["对每个 tool_call 触发 onToolStart"]
    TS --> PAR["runner.run 并发执行<br/>Promise.all + 单工具超时<br/>注入 ctx.workspaceRoot（会话所属空间根）"]
    PAR --> ISO["失败隔离：单个工具抛错<br/>转成错误 Observation 不中断"]
    ISO --> TE["onToolProgress / onToolEnd"]
    TE --> TMSG["push role=tool 的 Observation 消息"]
    TMSG --> NEXT["i++ → 回到循环判断"]
    NEXT --> LOOP

    classDef s fill:#e8f5e9,stroke:#2e7d32
    classDef d fill:#fff9c4,stroke:#f9a825
    classDef mem fill:#fce4ec,stroke:#ad1457
    classDef err fill:#ffebee,stroke:#c62828
    class START,FINAL,BRK s
    class LOOP,CHK,OK,HAS,IT,CALL,PAR d
    class FLUSH,W2,FB,CMP,L2W,MSG,SP mem
    class ERR err
```

**三个容易踩的细节**（都写在这段代码里）

| 细节 | 说明 | 源码 |
|---|---|---|
| 阈值判定优先用**真实 token** | `_lastContextTokens`（上轮 `prompt_tokens`，含 system/工具/L2/L3 注入）优先；缺失才回退「字符数/4」估算——中文会被低估导致压缩不触发 | `react-agent.ts` L431 |
| 压缩不是截断 | 先 `preCompactionFlush` 让 LLM 产出结构化笔记写进 L2，**再** `compact` 丢消息；抽取失败时按 `flushFailure` 策略降级存档 | `memory/working.ts` |
| 工具并发但事件串行 | 先统一 `onToolStart`，再 `Promise.all` 执行，最后统一 `onToolProgress`/`onToolEnd` | `react-agent.ts` L596 |

---

## 4️⃣ 三层记忆数据流

```mermaid
flowchart TB
    subgraph L1["🥅 L1 Working Memory · 进程内"]
        W1["messages 数组<br/>当前会话上下文窗口"]
        W2["estimateTokens / needsCompaction"]
        W3["preCompactionFlush → compact<br/>保留 system + keepRecentTurns 次调用"]
    end

    subgraph L2["📔 L2 Episodic Memory · 按天追加"]
        E1["Daily Notes<br/>~/.loop-agent/memory/&lt;workspaceId&gt;/"]
        E2["FTS 全文索引<br/>fts.ts · tokenizeForFts"]
        E3["向量索引（可选）<br/>vector.ts + embedding.ts"]
        E4["混合检索 RRF<br/>hybrid.ts"]
    end

    subgraph L3["🧠 L3 Curated Memory · 人可读 Markdown"]
        C1["SOUL.md · USER.md<br/>~/.loop-agent/curated/（全局）"]
        C2["MEMORY.md<br/>&lt;工作区&gt;/（项目级）"]
        C3["超行数触发 LLM 精简<br/>curated-dedupe.ts"]
    end

    subgraph PIPE["🌙 晋升流水线"]
        G["PromotionGate<br/>按来源分档阈值<br/>owner_direct=1 … agent_inferred=5<br/>system=-1 永不晋升"]
        D["DreamingPipeline<br/>巡检最近 N 天 L2 → LLM 提取候选<br/>→ 逐条过 Gate → 写 L3"]
    end

    W1 -->|"超阈值先存档"| W3
    W3 -->|"flush 内容 scope=global"| E1
    W1 -->|"最终答案时追加摘要"| E1
    E1 --> E2
    E1 --> E3
    E2 --> E4
    E3 --> E4
    E1 -->|"Dreaming 巡检"| D
    D --> G
    G -->|"确认次数达标"| C1
    G -->|"确认次数达标"| C2
    C1 --> C3
    C2 --> C3

    C1 -->|"L3 常驻注入 System Prompt"| CTX
    E4 -->|"L2 检索命中才注入"| CTX["ContextAssembler<br/>memory/context.ts"]
    W1 -->|"L1 当前对话"| CTX
    CTX -->|"repairMessageSequence 校验<br/>清理孤立 tool 消息"| OUT(["发给 LLM 的 messages"])

    classDef l1 fill:#e3f2fd,stroke:#1565c0
    classDef l2 fill:#e8f5e9,stroke:#2e7d32
    classDef l3 fill:#fce4ec,stroke:#ad1457
    classDef pipe fill:#fff9c4,stroke:#f9a825
    class W1,W2,W3 l1
    class E1,E2,E3,E4 l2
    class C1,C2,C3 l3
    class G,D pipe
```

**注入策略是「按价值付费」**

| 层 | 何时进上下文 | 代价 |
|---|---|---|
| L3 | **每轮常驻**（System Prompt 的 memory section） | 固定占用，所以必须短、必须是人可读的结论 |
| L2 | **只在查询命中时**注入（内置停用词过滤「继续」「好的」这类空话，避免无谓检索） | 变动成本，命中才付费 |
| L1 | 当前对话本身 | 超阈值即压缩 |

> 「常驻的必须精炼，海量的必须按需」——这是三层设计的根因，也是 `gate.ts` 里 `system: -1`（脚手架永不晋升）存在的理由。

---

## 5️⃣ 配置分层合并

```mermaid
flowchart TD
    CLI["⌨️ CLI 参数 / AgentOptions<br/>--model · maxIterations · temperature · verbose"]
    WS["📁 工作空间配置<br/>&lt;workspace&gt;/.loop-agent/.agent-config.json"]
    GL["🌍 全局配置<br/>~/.loop-agent/config.json"]
    ENV["🔑 环境变量<br/>.env + process.env<br/>OPENAI_API_KEY 等"]
    DEF["📦 默认值<br/>DEFAULT_CONFIG · config/schema.ts"]

    CLI -->|"最高"| MERGE
    WS --> MERGE
    GL --> MERGE
    ENV --> MERGE
    DEF -->|"最低"| MERGE

    MERGE["deepMerge 逐层覆盖<br/>config/merge.ts"]
    MERGE --> RES["ResolvedConfig<br/>值 + ConfigSource 来源标注"]
    RES --> USE["被 agent / commands / api 消费"]

    W["ConfigWriter<br/>/config set · PUT /config/:key"] -->|"写回指定层"| WS
    W --> GL

    classDef hi fill:#ffebee,stroke:#c62828
    classDef mid fill:#fff8e1,stroke:#f9a825
    classDef lo fill:#eceff1,stroke:#455a64
    classDef core fill:#e8f5e9,stroke:#2e7d32
    class CLI hi
    class WS,GL,ENV mid
    class DEF lo
    class MERGE,RES,USE,W core
```

**两个行为细节**

- `.env` 加载是**幂等且不覆盖**已存在的 `process.env`：命令行/系统环境变量优先级天然高于 `.env` 文件（`loader.ts` L33）。
- `load(cliOverride)` 在**每次 `run()` 都重新执行**，所以 `/model use` 切模型、`/config set` 改配置都能在下一轮立即生效，不需重启进程。

---

## 6️⃣ 工具装配与调用链

```mermaid
flowchart LR
    subgraph SRC["工具来源"]
        B["10 个常驻内置工具<br/>commandRun · commandStatus · commandLogs<br/>commandStop · fileRead · fileWrite<br/>editFile · grep · activateSkill · delegate"]
        V["条件注册：视觉与 OCR<br/>analyzeImage（vision.enabled）<br/>ocrImage（ocr.enabled + 引擎探测）"]
        M["MCP 远端工具<br/>adaptMCPTool + buildToolName"]
    end

    subgraph REG["ToolRegistry · tools/registry.ts"]
        R1["Map&lt;name, Tool&gt;<br/>重名注册直接抛错"]
        R2["toOpenAITools()<br/>canonicalize 递归排序 key"]
    end

    subgraph RUN["ToolRunner · tools/runner.ts"]
        N1["名称查找 → 未注册则返回错误 Observation"]
        N2["超时控制 + 异常捕获<br/>失败不中断其它工具"]
    end

    subgraph CFG2["注册期过滤"]
        F1["tools.enabled 非空 → 白名单"]
        F2["tools.disabled → 排除"]
        F3["vision.enabled=false<br/>→ 不注册视觉工具<br/>（保持 tools 列表稳定，护前缀缓存）"]
    end

    CFG2 --> REG
    B --> CFG2
    V --> CFG2
    M --> REG
    REG -->|"每轮 run() 取一次"| LLMREQ["请求体 tools 参数"]
    LLMREQ --> MODEL["LLM 返回 tool_calls"]
    MODEL --> RUN
    RUN --> OBS["Observation → role=tool 消息"]

    classDef src fill:#fff8e1,stroke:#f9a825
    classDef reg fill:#e3f2fd,stroke:#1565c0
    classDef run fill:#e8f5e9,stroke:#2e7d32
    classDef cfg fill:#f3e5f5,stroke:#6a1b9a
    class B,V,M src
    class R1,R2,LLMREQ reg
    class N1,N2,OBS,MODEL run
    class F1,F2,F3 cfg
```

**为什么 `canonicalize` 要排 key？** DeepSeek 等模型的**前缀缓存**要求请求体字节级一致；`JSON.stringify` 的对象 key 顺序不稳定会让 `tools` 段每次都 miss 缓存。同样的考虑也解释了「视觉未启用时不注册视觉工具」——避免 `tools` 数组长度抖动。

---

## 7️⃣ 核心类关系

```mermaid
classDiagram
    direction LR

    class ReActAgent {
        -ChatMessage[] _chatHistory
        -SessionStore _sessionStore
        -WorkingMemory _workingMemory
        -EpisodicMemory _episodicMemory
        -CuratedMemory _curatedMemory
        -ContextAssembler _contextAssembler
        -PromotionGate _promotionGate
        -DreamingPipeline _dreamingPipeline
        +run(userInput, options) AgentResult
        +initMemory(cwd)
        +restoreSession(data, systemPrompt)
        +appendContextNote(note)
        +resetSession()
    }

    class ToolRegistry {
        -Map tools
        -Map mcpClients
        +register(tool)
        +get(name) Tool
        +toOpenAITools()
    }

    class ToolRunner {
        +run(tool, args) ToolResult
    }

    class ConfigLoader {
        -string workspacePath
        -string globalDir
        +load(cliOverrides) ResolvedConfig
        +setWorkspacePath(path)
    }

    class SessionStore {
        +save(data)
        +load(id) SessionData
        +list(workspace)
    }

    class WorkingMemory {
        +needsCompaction(messages) bool
        +preCompactionFlush(messages, llm) string
        +compact(messages) ChatMessage[]
    }

    class EpisodicMemory {
        +init()
        +appendToday(content, meta)
        +search(query) MemorySearchResult[]
        +closeIndex()
    }

    class CuratedMemory {
        +init()
        +read(key) string
        +write(key, content)
    }

    class ContextAssembler {
        +assemble() ChatMessage[]
    }

    class PromotionGate {
        +check(fact, provenance) bool
        +loadState(dir)
    }

    class DreamingPipeline {
        +run(options) DreamingResult
    }

    class SkillLoader {
        +scan(cwd) SkillMetadata[]
        +load(name) Skill
    }

    class MCPClient {
        +connect()
        +listTools()
        +callTool(name, args)
    }

    class ApiServer {
        +start() port
        +close()
    }

    class WorkspaceRegistry {
        +get(input) WorkspaceRuntime
        +getCanonical(root) WorkspaceRuntime
        +evictIdle()
    }

    class WorkspaceRuntime {
        +string root
        +SessionStore store
        +ConfigLoader configLoader
        +ConfigWriter configWriter
        +SkillLoader skillLoader
        +SessionManager sessions
        +AgentPool pool
        +MemoryKit memoryKit
    }

    class WorkspaceContext {
        +AsyncLocalStorage als
        +currentWorkspaceRoot() string
    }

    class Semaphore {
        +acquire()
        +release()
    }

    ReActAgent --> ConfigLoader : 每次 run 重载
    ReActAgent --> ToolRegistry : 取 OpenAI tools
    ReActAgent --> SkillLoader : 扫描技能包
    ReActAgent --> SessionStore : autoSave 持久化
    ReActAgent *-- WorkingMemory : L1
    ReActAgent *-- EpisodicMemory : L2
    ReActAgent *-- CuratedMemory : L3
    ReActAgent *-- ContextAssembler : 组装上下文
    ReActAgent *-- PromotionGate : 晋升闸门
    ReActAgent *-- DreamingPipeline : 后台流水线

    DreamingPipeline --> EpisodicMemory : 读 Daily Notes
    DreamingPipeline --> PromotionGate : 逐条校验
    DreamingPipeline --> CuratedMemory : 达标写入
    ContextAssembler --> CuratedMemory : L3 常驻
    ContextAssembler --> EpisodicMemory : L2 检索

    ToolRegistry --> MCPClient : 持有多个
    ToolRunner ..> ToolRegistry : 按名查找

    ApiServer --> ReActAgent : 注入 runAgent
    ApiServer --> WorkspaceRegistry : locateSession 定位归属空间
    WorkspaceRegistry --> WorkspaceRuntime : 懒建 + LRU(4)
    WorkspaceRuntime *-- SessionStore : 每空间一例
    WorkspaceRuntime *-- ConfigLoader : 构造期定根
    WorkspaceRuntime *-- SkillLoader : 实例级隔离
    WorkspaceRuntime --> Semaphore : 全局并发上限(8)
    WorkspaceRuntime --> ReActAgent : pool.acquire(sessionId)
    ToolRunner ..> WorkspaceContext : workspaceRoot 兜底（ALS）
    ApiServer --> SessionStore : 经 runtime 取用
    ApiServer --> ConfigLoader : 经 runtime 取用
```

**图例**：`-->` 关联 · `*--` 组合（记忆组件生命周期跟随 agent）· `..>` 依赖（不持有）。

`ApiServer` 对 `ReActAgent` 只依赖 **`runAgent` 函数签名**而非类本身——这正是 `server.ts` 里 `ApiServerDeps.runAgent` 那层依赖注入 seam，让 API 单测能塞一个假的 `runAgent` 跑真实 HTTP server（`port: 0`）。

---

## 📁 附：落盘位置速查

```text
~/.loop-agent/                     ← 全局层（跨项目共享）
├── config.json                    ← 全局配置
├── .env / 密钥
├── curated/                       ← L3：SOUL.md · USER.md
├── memory/<workspaceId>/          ← L2：按天 Daily Notes + FTS/向量索引
├── uploads/<sessionKey>/          ← /upload 会话隔离上传目录
├── sessions/                      ← 会话（AES-256-GCM 加密）
└── logs/                          ← DEBUG=true 时的结构化日志

<workspace>/.loop-agent/           ← 工作区层（仅本项目）
├── .agent-config.json             ← 工作区配置（优先级高于全局）
├── skills/                        ← 技能包目录
└── MEMORY.md                      ← L3：项目级精炼记忆
```

对应源码：`react-agent.ts` `initMemory()`（L197/L223/L225）、`upload/manager.ts` `defaultUploadsRoot()`。

---

## 🔧 维护约定

1. **图必须跟着代码走**：改动 `run()` 的控制流、记忆层落盘路径、或 API 路由时，顺手更新对应图——本文件所有节点都标了源码文件名，方便核对。
2. **不在图里放会漂移的数字**（迭代上限、阈值、文件数），只写机制；确需数字时用配置项名代替（如 `maxIterations`）。
3. 渲染方式：GitHub/GitLab 自动渲染 Mermaid；VS Code 装 *Markdown Preview Mermaid Support*；本地 `webui` 已依赖 `mermaid@12`。
