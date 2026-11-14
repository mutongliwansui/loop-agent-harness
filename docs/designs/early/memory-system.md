# Agent 记忆机制（Memory System）说明

> 本文档基于 `src/memory/` 源码（Phase 1-5 已实现）整理，描述 loop-agent-command 的记忆管理机制：三层记忆架构、晋升闸门、梦处理管道、多级检索与降级策略。

---

## 1. 设计总览

### 1.1 四条核心设计原则

| 原则 | 说明 | 落地实现 |
|------|------|----------|
| **文件即真相源** | Markdown 文件是唯一真相源，SQLite 只是加速索引 | 写入先写文件再同步索引；索引损坏可从文件重建 |
| **写读分离** | 回复时只检索、不抽取；抽取放后台 Dreaming 阶段 | `ContextAssembler` 只做检索注入；`DreamingPipeline` 负责提取晋升 |
| **晋升有闸门** | 不同来源的信息可信度不同，晋升需要不同确认门槛 | `PromotionGate` 按 provenance 设置阈值 |
| **失败自动降级** | 索引 / 向量 / LLM 任一环节失败都不阻塞主流程、不丢事实 | 检索链 `混合 → FTS5 → 文件`；写入链 `去重归并 → 逐条 append` |

### 1.2 三层记忆架构

```
┌───────────────────────────────────────────────────────────────┐
│                 L1 Working Memory（working.ts）                │
│          当前 ReAct 循环的 messages 数组（上下文窗口）           │
│          生命周期：单次会话                                   │
│          超阈值 → pre-compaction flush → L2                    │
└───────────────────────┬───────────────────────────────────────┘
                        │ flush（确定性触发）
                        ▼
┌───────────────────────────────────────────────────────────────┐
│              L2 Episodic Memory（episodic.ts）                 │
│        memory/YYYY-MM-DD.md 按天分文件（带 Session 隔离）       │
│        索引：SQLite FTS5（index.sqlite）+ 可选向量（vectors.sqlite）│
│        检索：RRF 混合检索（BM25 + 向量）→ FTS5 → 文件关键词     │
└───────────────────────┬───────────────────────────────────────┘
                        │ Dreaming 巡检（后台/退出时）
                        ▼
┌───────────────────────────────────────────────────────────────┐
│              L3 Curated Memory（curated.ts）                   │
│        SOUL.md（Agent 人格）/ USER.md（用户画像）              │
│        MEMORY.md（精炼事实）                                   │
│        启动时注入 system prompt，由 Dreaming 晋升写入          │
└───────────────────────────────────────────────────────────────┘
```

---

## 2. L1 Working Memory（工作记忆）

文件：`src/memory/working.ts`

### 2.1 职责
维护当前会话的上下文窗口（messages 数组），负责 token 用量估算与超阈值压缩。

### 2.2 核心机制

**Token 估算**：简化版，`字符数 / 4`。

**压缩触发**：当 `estimateTokens(messages) >= maxTokens * compactionThreshold` 时触发。

**Pre-compaction Flush（关键机制）**：
压缩前**先让 LLM 提取关键信息"存档"再丢弃**，而非简单截断旧消息。提取内容写入 L2，保留：
- 用户表达的稳定偏好和约束
- 已确认的事实和决策
- 未完成的任务和目标
- 工具调用的关键结果

**Compaction**：保留 `system` 消息 + 最近 N 轮对话（每轮 = user 消息及其对应的 assistant/tool 消息）。

### 2.3 默认配置

```ts
{
  maxTokens: 102400,          // 最大 token 数（估算值）
  compactionThreshold: 0.8,   // 80% 时触发压缩
  keepRecentTurns: 10,        // 压缩后保留最近 10 次模型调用（assistant 消息数）
}
```

---

## 3. L2 Episodic Memory（情景记忆）

文件：`src/memory/episodic.ts`

### 3.1 存储格式

按天存储于 `memory/YYYY-MM-DD.md`，每条目格式：

```markdown
## {ISO 时间戳} [sessionId: xxx] [scope: session] [tag: tool]
{内容}
```

元数据 header 支持：
- `sessionId`：会话隔离标识
- `scope`：`session`（仅当前会话可见）| `global`（所有会话可见）
- `tag`：类别标签（`tool` / `error` 等）

### 3.2 写入路径（文件是真相源）

```
append(day, content, options)
  │
  ├─ 1. 先追加写入 Markdown 文件（真相源，必须成功）
  ├─ 2. 同步更新 FTS5 索引（失败不影响文件写入）
  └─ 3. 可选：向量增量嵌入（失败内部降级）
```

### 3.3 检索路径（多级降级链）

```
search(query, topK, options)
  │
  ├─ 1. 混合检索（RRF 融合 BM25 + 向量）   ← 两者都可用且有向量结果
  ├─ 2. FTS5 索引检索（BM25 排序）         ← 索引可用
  └─ 3. 文件关键词匹配（兜底）              ← 索引不可用/无结果
```

**Session 隔离规则**：
- 指定 `sessionId` 时：返回 `scope=global` 条目 + `scope=session` 且属于当前会话的条目
- 指定 `scope` 时：只返回该 scope 的条目
- 无 scope 标记的旧条目 → 默认可见（向后兼容）

### 3.4 索引文件（非真相源）

| 文件 | 说明 | 重建方式 |
|------|------|----------|
| `memory/index.sqlite` | FTS5 全文索引（node:sqlite 内置，零外部依赖） | `rebuildIndex()` 从 Markdown 重建 |
| `memory/vectors.sqlite` | 向量索引（可选，配置 vectorSearch 才启用） | `rebuildVectorIndex()` 全量重建 |

---

## 4. L3 Curated Memory（精炼记忆）

文件：`src/memory/curated.ts`

### 4.1 三个常驻文件

| 文件 | 内容 | 用途 |
|------|------|------|
| `SOUL.md` | Agent 人格（核心身份、行为准则、沟通风格） | 定义 Agent 自我 |
| `USER.md` | 用户画像（基本信息、偏好、约束） | 记录用户是谁 |
| `MEMORY.md` | 精炼事实（项目知识、关键决策、已知问题） | 积累跨会话知识 |

### 4.2 注入方式

启动/每次调用时由 `ContextAssembler` 读取三文件内容，作为 **system prompt 的「你的长期记忆（Curated Memory）」片段**注入。

### 4.3 写入与溢出保护

- `append()`：追加一行 `- {fact}`，自动整行去重
- **溢出保护**：文件行数超过 `maxLines`（默认 100）时，自动调用 LLM 压缩（`dedupeCuratedFile`）；压缩失败则回退直接追加，**绝不丢事实**
- `applyDecisions()`：按 LLM 归并决策批量落盘（merge 按行号从大到小替换避免偏移；append 整行去重兜底）

---

## 5. Promotion Gate（晋升闸门）

文件：`src/memory/gate.ts`

### 5.1 核心思想

**不是所有信息都配进 L3**。不同来源的信息可信度不同，晋升需要不同的确认门槛：

| 来源（Provenance） | 含义 | 所需确认次数 |
|--------------------|------|--------------|
| `owner_direct` | 用户明确说的 | **1** |
| `owner_derived` | 从用户行为推导 | 2 |
| `tool_output` | 工具返回 | 3 |
| `web_search` | 网页信息 | 4 |
| `agent_inferred` | Agent 自己推断 | 5 |
| `system` | 系统脚手架 | 永不晋升 |

### 5.2 判定逻辑

- 事实首次出现：`count=1`，若已达阈值（如 `owner_direct` 阈值=1）立即晋升
- 再次出现：`count+1`，达到阈值返回 `true`
- 事实文本归一化（小写、去尾标点），避免同义重复

### 5.3 持久化

- 状态保存到 `{cwd}/.memory-gate.json`
- `loadState()` 重启恢复 pending 计数；状态损坏时重新开始（对已晋升事实无影响）

### 5.4 与 Dreaming 的配合

Dreaming 提取候选事实时调用 `gate.categorize()` 标记 `category`（preference/fact/rule/skill）和 `targetFile`（USER.md/MEMORY.md），再经 `evaluate()` 判定是否晋升。

---

## 6. Dreaming Pipeline（梦处理管道）

文件：`src/memory/dreaming.ts`

### 6.1 职责

**后台晋升流水线**：巡检最近 N 天 L2 Daily Notes → LLM 提取候选事实 → 逐条过 Promotion Gate → 晋升写入 L3。

### 6.2 完整流程

```
run(daysBack, onProgress, options)
  │
  ├─ 1. 读取最近 N 天记录（readRecentDays）
  ├─ 2. 增量过滤（.dreaming-state.json 记录已处理到哪天，只处理新增天）
  ├─ 3. 提取候选事实（LLM 输出 JSON）：
  │      ├─ batchByDay=true（默认）：按天分批调用 LLM（单次输入小、前缀缓存命中率高）
  │      └─ batchByDay=false：合并所有天一次调用（旧行为）
  ├─ 4. 逐条过 Gate（inferProvenance 按 confidence 映射来源）
  ├─ 5. 晋升候选按目标文件分组 → LLM 去重/归并（mergeWithLLM）→ 落盘
  │      └─ 归并失败/解析失败 → 回退逐条 append（绝不丢事实）
  ├─ 6. 全部天成功 → 推进增量状态（任一天失败则保留旧状态，下次重试）
  └─ 7. 保存 Gate 状态
```

### 6.3 提取提示词筛选标准

1. 用户明确表达的偏好或约束（高优先级）
2. 被多次验证的事实（高优先级）
3. 对未来决策有指导意义的信息（中优先级）
4. 一次性临时信息（丢弃）

LLM 输出格式：

```json
[{"fact": "事实陈述（一句话）", "confidence": 1-10, "category": "preference|fact|rule|skill", "targetFile": "USER.md|MEMORY.md"}]
```

### 6.4 增量状态文件

- 路径：`{L2 记忆目录}/.dreaming-state.json`
- 内容：`{"lastProcessedDay": "YYYY-MM-DD"}`
- 记忆目录下，天然被 git 忽略

---

## 7. 检索机制详解

### 7.1 FTS5 全文索引（Phase 4）

文件：`src/memory/fts.ts`

- 使用 Node 内置 `node:sqlite`（Node 22.5+），**零外部依赖**
- **中文 bigram 预分词**：连续中文按 2-gram 拆分（如"记忆机制"→"记忆 忆机 机制"），英文/数字保持原样（unicode61 可处理）
- 查询分词与索引同规则，每个 token 加引号保证精确短语匹配
- 排序：`bm25(memory_fts)` 内置 BM25 算法
- 索引损坏 → `markBroken()` 释放句柄，上层降级文件检索；可用 `rebuildFromFiles()` 重建

### 7.2 向量检索（Phase 5，可选）

文件：`src/memory/vector.ts` / `src/memory/embedding.ts`

- 未配置 `vectorSearch`（或 enabled=false / endpoint/model 为空）时**完全不影响功能**
- 向量以 `Float32 BLOB` 存储于独立 SQLite 文件（零向量数据库依赖）
- 语义检索：查询向量与全量条目计算**余弦相似度**，阈值 > 0.5，取 TopK
- Embedding 客户端：OpenAI 兼容 `/v1/embeddings`，支持批量（batchSize）、超时（timeoutMs）、API Key
- 首次检索时**惰性全量构建**向量索引（`ensureVectorBuilt`），只构建一次

### 7.3 RRF 混合检索（Phase 5）

文件：`src/memory/hybrid.ts`

- **Reciprocal Rank Fusion**（倒排秩融合）：
  `score(doc) = Σ_list 1 / (k + rank(list, doc))`，默认 k=60（业界常用）
- BM25 结果要求原文精确包含关键词（bigram 可能部分命中）；向量结果按语义召回
- 两来源都命中的文档获得更高融合分
- 向量无结果（相似度阈值内无命中）→ 自动走 FTS5/文件

---

## 8. 上下文组装（ContextAssembler）

文件：`src/memory/context.ts`

### 8.1 组装流程

每次 LLM 调用前组装完整 context：

```
assemble(userMessage, currentMessages, skills, options)
  │
  ├─ 1. L3 常驻：读取 SOUL/USER/MEMORY → 追加到 system prompt
  │       （"## 你的长期记忆（Curated Memory）"片段）
  ├─ 2. L2 检索：以当前用户消息为 query，召回相关历史片段（带 sessionId 隔离）
  │       （safeSearch 带超时保护，默认 500ms）
  ├─ 3. 组装 messages + repairMessageSequence 修复损坏配对
  └─ 4. 返回最终消息序列
```

### 8.2 前缀缓存优化（关键设计）

> **L2 检索结果不注入 system prompt**：system 前缀必须保持稳定才能命中 DeepSeek 前缀缓存。
> 检索结果改为**附加到最后一条 user 消息之前**（"## 相关历史记忆"片段），避免污染 system 前缀。

### 8.3 repairMessageSequence（消息序列修复）

解决持久化/恢复时去重逻辑可能错误移除 `assistant(tool_calls)` 消息、导致孤立 `tool` 消息的 `"tool must be response to preceding tool_calls"` 错误：

1. 收集所有 `assistant(tool_calls)` 中的 tool_call_id
2. 对每条 tool 消息检查其 tool_call_id 是否在前置 assistant 中存在
3. 找不到 → 移除该孤立 tool 消息
4. 清理 assistant 中已无对应 tool 消息的 tool_calls

---

## 9. 工具记忆回调（ToolMemoryCallback）

文件：`src/memory/callback.ts`

工具调用结果**自动写入 L2**（带来源标记 + Session 隔离）：

| 方法 | 用途 | 写入内容 |
|------|------|----------|
| `log(toolName, input, output)` | 工具成功结果 | `- [tool:xxx] input={...} → {截断 200 字}`，tag=tool，scope=session |
| `logError(toolName, error)` | 工具错误 | `- [tool:xxx] ERROR: {...}`，tag=error，scope=session |
| `logGlobal(content, tag)` | 全局记忆 | scope=global，跨会话可见 |

> 工具结果**不直接晋升 L3**，而是作为 L2 记忆源，待 Dreaming 巡检时按门槛晋升。

---

## 10. 去重/归并（Curated Dedupe）

文件：`src/memory/curated-dedupe.ts`

### 10.1 晋升写入去重（mergeWithLLM）

Dreaming 晋升写 L3 前，用 LLM 对候选事实与现有内容做**语义合并**：

- `append`：全新信息 → 追加
- `merge`：与现有某行表达同一件事但提供补充/更新 → 合并（`line` 行号 + `newText` 合并后文本）
- `skip`：完全重复或被更新的信息覆盖 → 丢弃

判断规则：语义等价即视为重复；新旧信息冲突以新为准；现有条目更完整则 skip。

**安全约束**：LLM 调用失败或解析失败必须返回 null，由调用方回退到原 append，**绝不因去重丢失事实**。

### 10.2 存量去重（dedupeCuratedFile）

`/memory curated dedupe` 使用：让 LLM 输出精简后的完整文件内容。

**防线**：去重后行数不得多于原文件（防止 LLM 编造/新增内容）；操作前自动备份为 `.dedupe.bak`。

---

## 11. 配置项（MemoryConfig）

默认配置（`src/memory/types.ts`）：

```ts
{
  enabled: true,
  working: {
    maxTokens: 102400,
    compactionThreshold: 0.8,
    keepRecentTurns: 10,
  },
  episodic: {
    dir: 'memory',            // L2 存储目录
    searchTopK: 3,            // 检索返回条数
    searchTimeoutMs: 500,     // 检索超时
    vectorSearch: {           // Phase 5 可选，默认禁用
      enabled: false,
      provider: 'openai-compatible',
      model: '',              // 如 bge-large-zh-vllm
      dimension: 1024,
      endpoint: '',           // 如 http://host:port/v1/embeddings
      apiKey: '',
      timeoutMs: 10000,
      batchSize: 16,
    },
  },
  curated: {
    files: ['SOUL.md', 'USER.md', 'MEMORY.md'],
    maxLines: 100,            // 单文件行数上限，超限触发 LLM 精简
    dedupe: { enabled: true },
  },
  dreaming: {
    enabled: true,
    daysBack: 3,              // 巡检最近 N 天
    onExit: true,             // 退出时自动触发
    batchByDay: true,         // Task-16 按天分批提取
    incremental: true,        // Task-16 增量处理
  },
}
```

---

## 12. CLI 命令（/memory）

| 命令 | 功能 |
|------|------|
| `/memory status` | 查看记忆系统状态（L1/L2/L3、索引/向量可用性） |
| `/memory init` | 初始化记忆系统（创建目录与 Curated 文件） |
| `/memory curated read <soul\|user\|memory>` | 读取 L3 文件内容 |
| `/memory curated append <soul\|user\|memory> <内容>` | 手动追加 L3 事实 |
| `/memory curated dedupe <soul\|user\|memory>` | LLM 存量去重（自动备份） |
| `/memory episodic read <YYYY-MM-DD>` | 读取某天 L2 记录 |
| `/memory search <关键词>` | 检索 L2 记忆（走完整降级链） |
| `/memory dream [天数]` | 手动触发 Dreaming 巡检（默认读配置） |
| `/memory gate` | 查看晋升闸门待处理/已确认事实 |

---

## 13. 事件钩子（AgentEvents，11 个）

```ts
export interface AgentEvents {
  onStart?(input: string): void | Promise<void>;                          // Agent 启动
  onIterationStart?(iteration, maxIterations): void | Promise<void>;      // 每轮迭代开始
  onLLMStream?(delta: string): void | Promise<void>;                      // LLM 流式输出片段
  onLLMEnd?(response, iteration): void | Promise<void>;                   // LLM 单轮调用结束
  onLLMStats?(stats: LLMStats): void | Promise<void>;                     // LLM 单轮统计（每轮）
  onLLMStatsSummary?(summary: LLMStatsSummary): void | Promise<void>;     // 会话统计汇总
  onToolStart?(tool, args): void | Promise<void>;                         // 工具调用开始
  onToolEnd?(tool, result): void | Promise<void>;                         // 工具调用结束
  onFinal?(answer: string): void | Promise<void>;                         // 最终答案
  onError?(error: Error): void | Promise<void>;                           // Agent 出错
  onEnd?(result: AgentResult | null): void | Promise<void>;               // Agent 结束（成败皆触发）
}
```

多个 listener 顺序执行，单个 listener 抛错被捕获不中断主循环。

---

## 14. 状态与数据文件一览

| 文件 | 归属 | 说明 | 可重建 |
|------|------|------|--------|
| `memory/YYYY-MM-DD.md` | L2 真相源 | 按天情景记忆 | — |
| `memory/index.sqlite` | L2 索引 | FTS5 全文索引（非真相源） | ✅ 可从 md 重建 |
| `memory/vectors.sqlite` | L2 索引 | 向量索引（可选） | ✅ 可从 md 重建 |
| `memory/.dreaming-state.json` | Dreaming 状态 | 增量处理进度 | — |
| `{cwd}/.memory-gate.json` | Gate 状态 | 晋升确认计数 | — |
| `{cwd}/SOUL.md` | L3 真相源 | Agent 人格 | — |
| `{cwd}/USER.md` | L3 真相源 | 用户画像 | — |
| `{cwd}/MEMORY.md` | L3 真相源 | 精炼事实 | — |

> 上述运行时与临时文件均已被 `.gitignore` 忽略。

---

## 15. 数据流总结

### 写入路径（文件真相源优先）
```
工具结果 / 对话 flush / 用户手动
        │
        ▼
L2 追加写入 Markdown（真相源，必须成功）
        │
        ├─→ 同步更新 FTS5 索引（失败不影响写入）
        └─→ 可选：向量增量嵌入（失败内部降级）
```

### 晋升路径（后台/退出时）
```
L2 最近 N 天记录
   │ Dreaming 巡检（按天分批 + 增量）
   ▼
LLM 提取候选事实（confidence + category + targetFile）
   │
   ▼
Promotion Gate 判定（按来源门槛）
   │ 达到阈值
   ▼
LLM 去重/归并（mergeWithLLM）→ 落盘 L3（失败回退 append）
   │
   ▼
SOUL.md / USER.md / MEMORY.md（下次启动注入 system prompt）
```

### 读取路径（只检索不抽取）
```
当前用户消息
   │
   ▼
ContextAssembler 组装：
   ├─ L3 常驻（SOUL/USER/MEMORY → system prompt 片段）
   ├─ L2 检索（RRF 混合 → FTS5 → 文件，带 sessionId 隔离）
   └─ L1 当前消息（含最近检索片段，附加在最后一条 user 消息前）
   │
   ▼
repairMessageSequence 修复 → 送入 LLM
```
