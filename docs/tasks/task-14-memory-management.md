# Task-14：OpenClaw 风格三层记忆管理

> 基于 OpenClaw 的 Tier Model 设计，核心思想：**文件是真相源，索引只做加速；写读路径分离；晋升有闸门。**

---

## 一、需求目标

### 1.1 解决的核心痛点

| 痛点 | 现状 | 目标 |
|------|------|------|
| **上下文膨胀** | 长对话中 messages 无限增长，导致 Premature close、token 超限 | Token 超阈值时自动 Pre-compaction flush → 压缩 |
| **历史丢失** | Session 仅能恢复最近会话，无跨会话知识积累 | 按天持久化 Episodic Memory，支持历史检索 |
| **知识空白** | Agent 无法记住用户偏好、项目事实等长期信息 | L3 Curated Memory 常驻注入 system prompt |
| **记忆污染** | 工具结果、临时闲聊混在上下文里 | Promotion Gate 过滤，仅晋升高价值信息 |

### 1.2 设计约束

- **与现有架构兼容**：不破坏 Task-11 会话持久化（加密存储用于会话恢复），新记忆系统是对它的补充
- **零外部依赖**：不引入向量数据库，使用 SQLite FTS5（Node 内置 `node:sqlite` 或 `better-sqlite3`），Phase 1 可用纯文件检索
- **渐进式实现**：Phase 1 最小闭环 → Phase 2 智能压缩 → Phase 3 晋升流水线 → Phase 4 向量检索
- **失败降级**：记忆子系统挂了不影响主回复路径

### 1.3 与 Task-11 会话持久化的关系（改造后）

```
Task-11 SessionStore（加密存储，改造）      Task-14 记忆管理（新增）
─────────────────────────────────────      ──────────────────────────
用途：会话恢复（分层加载）                  用途：跨会话知识积累
存储：~/.loop-agent/sessions/{wid}/         存储：{cwd}/memory/ + {cwd}/*.md
格式：AES-256-GCM 加密 JSON（分层）         格式：Markdown 明文 + SQLite 索引
生命周期：会话级别                          生命周期：永久

Session 文件结构（改造后）:
{
  "id": "session_abc",
  "title": "会话标题",
  "lastSummary": "上次会话摘要（L1 压缩产物）",  // 新增
  "recentMessages": [                          // 新增：只保留最近 N 轮
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "..."}
  ],
  "archivedCount": 45,                         // 新增：归档消息数
  "updatedAt": "2026-08-10T10:00:00Z"
}

恢复策略：
  1. 只加载 recentMessages 到 _chatHistory
  2. lastSummary 注入到 L3 或系统提示词
  3. archivedCount 仅用于显示，不加载到上下文
```

### 1.4 Session 与 Memory 的交互设计（新增）

#### 问题分析

| 问题 | 现状 | 风险 |
|------|------|------|
| Session 恢复全量历史 | `loadSession()` 加载所有消息到 `_chatHistory` | 超大 Session 恢复后首轮就触发 L1 压缩，浪费 token |
| L2 无 Session 隔离 | 所有 Session 共享 `YYYY-MM-DD.md` 文件 | A 会话的工具结果会污染 B 会话的检索结果 |

#### 解决方案

**方案 1：Session 分层存储**

```
改造前:
  Session 文件.messages = [全量消息 1...N]

改造后:
  Session 文件 = {
    lastSummary: "会话摘要",           // L1 压缩产物，注入系统提示词
    recentMessages: [最近 3 轮对话],  // L1 工作集，加载到 _chatHistory
    archivedMessages: [...],          // 归档（可选存储，不参与上下文）
  }
```

**方案 2：L2 增加 Session 标签与过滤**

```typescript
// L2 存储结构（改造后）
interface EpisodicEntry {
  sessionId: string;                    // 来源 Session ID
  scope: 'session' | 'global';          // 作用域隔离
  content: string;
  timestamp: string;
}

// 写入时打标签
await episodicMemory.appendToday(content, {
  sessionId: 'abc123',
  scope: 'session',  // 默认会话隔离
});

// 检索时过滤
const results = await episodicMemory.search(query, {
  sessionId: 'abc123',  // 只检索当前会话的记忆
  includeGlobal: true,  // 可选：包含全局记忆
});
```

**隔离策略**：
- `scope: 'session'` - 会话私有记忆（工具结果、临时信息），默认隔离
- `scope: 'global'` - 全局知识（项目背景、配置信息），跨会话共享
- 检索时默认只返回当前 Session 的 `session` 级记忆 + 所有 `global` 级记忆

#### 交互流程图

```
新的架构:

Session 恢复:
  ├── recentMessages → 加载到 _chatHistory (L1)
  ├── lastSummary → 注入到 L3 MEMORY.md 或系统提示词
  └── archivedMessages → 不参与上下文

L2 检索:
  ├── scope: 'session' + sessionId → 只检索当前会话相关
  └── scope: 'global' → 跨会话通用知识

Context 组装:
  system_prompt = 
    L3 常驻内容 +
    lastSummary +
    L2(当前会话) + 
    L2(全局知识) +
    recentMessages(L1)
```

---

## 二、架构设计

### 2.1 三层架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                    L1 Working Memory                        │
│          (ReActAgent._chatHistory 数组)                      │
│          TTL: 单次会话运行期                                  │
│          超阈值 → pre-compaction flush → L2                  │
└──────────────────────┬──────────────────────────────────────┘
                       │ flush (确定性触发)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                  L2 Episodic Memory                         │
│          (memory/YYYY-MM-DD.md 按天分文件)                   │
│          TTL: 长期留存，不自动注入 context                    │
│          访问方式: memorySearch() 按需召回                    │
│          晋升条件: Dreaming 巡检 + Promotion Gate             │
└──────────────────────┬──────────────────────────────────────┘
                       │ promote (后台异步)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              L3 Curated Core Memory                         │
│     (SOUL.md / USER.md / MEMORY.md 精炼常驻文件)             │
│     TTL: 永久，会话启动常驻注入 system prompt                │
│     内容: 用户偏好、关键事实、Agent 人格/行为准则             │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 职责对照表

| 层级 | 存储形态 | 生命周期 | 自动进 context | 写入触发者 |
|------|----------|----------|----------------|------------|
| L1 Working | RAM 中 `_chatHistory` 数组 | 单次会话 | ✅ 始终在 | ReAct 循环自身 |
| L2 Episodic | `{cwd}/memory/YYYY-MM-DD.md` | 永久存档 | ❌ 按需检索 | Pre-compaction flush / 工具回调 |
| L3 Curated | `{cwd}/SOUL.md` / `USER.md` / `MEMORY.md` | 永久常驻 | ✅ 启动注入 | Dreaming 晋升流水线 |

### 2.3 数据流全景

```
用户输入
  │
  ▼
┌─────────────────────────────────────────┐
│  buildContext() 组装完整 context         │
│  1. L3 Curated → 注入 system prompt      │
│  2. L2.search() → 按需检索相关历史       │
│  3. L1 messages → 当前对话               │
└─────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────┐
│  ReAct 循环                              │
│  检查 L1 token 是否超阈值                 │
│  ├─ 未超 → 正常推理                       │
│  └─ 超阈 → pre-compaction flush → L2     │
└─────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────┐
│  工具执行                                │
│  工具结果 → ToolMemoryCallback → L2      │
└─────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────┐
│  会话结束 / 空闲时                        │
│  DreamingPipeline.run()                  │
│  巡检 L2 → 提候选事实 → Promotion Gate   │
│  → 写入 L3                              │
└─────────────────────────────────────────┘
```

### 2.4 目录结构

```
loop-agent-command/
├── src/
│   ├── memory/                           # 新增：记忆管理模块
│   │   ├── types.ts                      # 记忆相关类型定义
│   │   ├── working.ts                    # L1 WorkingMemory
│   │   ├── episodic.ts                   # L2 EpisodicMemory + SQLite 索引
│   │   ├── curated.ts                    # L3 Curated Core 读写
│   │   ├── gate.ts                       # PromotionGate 晋升闸门
│   │   ├── dreaming.ts                   # DreamingPipeline 后台巡检
│   │   ├── callback.ts                   # ToolMemoryCallback 工具记忆回调
│   │   ├── context.ts                    # buildContext 上下文组装
│   │   └── index.ts                      # 模块聚合入口
│   ├── agent/
│   │   ├── react-agent.ts               # 改造：集成记忆管理
│   │   └── prompt.ts                     # 改造：L3 注入 system prompt
│   └── ...
├── {cwd}/                                # 运行时数据（可 .gitignore）
│   ├── SOUL.md                           # L3：Agent 人格
│   ├── USER.md                           # L3：用户画像
│   ├── MEMORY.md                         # L3：精炼事实
│   └── memory/                           # L2：情景记忆
│       ├── 2026-08-08.md
│       ├── 2026-08-07.md
│       └── index.sqlite                  # BM25 索引（非真相源）
└── docs/
    └── tasks/
        └── task-14-memory-management.md  # 本文档
```

---

## 三、L1 工作记忆（Working Memory）

### 3.1 职责

- 持有当前 ReAct 循环的完整 `Thought → Action → Observation` 轨迹
- 管理 token 预算，超阈值时**先 flush 到 L2 再压缩**
- 不直接持久化，但为 L2 提供原材料

### 3.2 类型定义

```typescript
// src/memory/types.ts

export interface WorkingMemoryConfig {
  /** 最大 token 数（估算值） */
  maxTokens: number;
  /** 压缩阈值（0.8 = 80% 时触发） */
  compactionThreshold: number;
  /** 压缩后保留最近 N 轮对话（每轮 = user + assistant） */
  keepRecentTurns: number;
}

export const DEFAULT_WORKING_CONFIG: WorkingMemoryConfig = {
  maxTokens: 8000,
  compactionThreshold: 0.8,
  keepRecentTurns: 3,
};
```

### 3.3 WorkingMemory 类

```typescript
// src/memory/working.ts

export class WorkingMemory {
  private config: WorkingMemoryConfig;

  constructor(config: WorkingMemoryConfig = DEFAULT_WORKING_CONFIG) {
    this.config = config;
  }

  /** 估算当前 token 用量（简化版：字符数 / 4） */
  estimateTokens(messages: ChatMessage[]): number {
    return messages.reduce((acc, m) => {
      const content = m.content ?? '';
      return acc + Math.ceil(content.length / 4);
    }, 0);
  }

  /** 是否需要压缩 */
  needsCompaction(messages: ChatMessage[]): boolean {
    return this.estimateTokens(messages) >= this.config.maxTokens * this.config.compactionThreshold;
  }

  /**
   * Pre-compaction Flush：关键机制
   * 不是简单截断旧消息，而是先让 LLM 把重要信息"存档"再丢
   */
  async preCompactionFlush(
    messages: ChatMessage[],
    llm: LLMClient,
  ): Promise<string> {
    const flushPrompt = `你正在压缩对话历史。请将以下对话中的关键信息提取为结构化笔记，保留：
- 用户表达的稳定偏好和约束
- 已确认的事实和决策
- 未完成的任务和目标
- 工具调用的关键结果

忽略：闲聊、重复确认、临时中间结果。
输出格式：纯文本，每条一行，以 "- " 开头。`;

    const extractMessages: ChatMessage[] = [
      { role: 'system', content: flushPrompt },
      ...messages,
    ];

    const response = await llm.chat(extractMessages);
    return response.content ?? '';
  }

  /**
   * 压缩：保留 system + 最近 N 轮
   */
  compact(messages: ChatMessage[]): ChatMessage[] {
    const systemMsg = messages.find((m) => m.role === 'system');
    const nonSystem = messages.filter((m) => m.role !== 'system');

    // 保留最近 N 轮（每轮包含 user + assistant + tool）
    const turns: ChatMessage[][] = [];
    let currentTurn: ChatMessage[] = [];
    for (let i = nonSystem.length - 1; i >= 0; i--) {
      currentTurn.unshift(nonSystem[i]);
      if (nonSystem[i].role === 'user' && currentTurn.length > 1) {
        turns.unshift(currentTurn);
        currentTurn = [];
        if (turns.length >= this.config.keepRecentTurns) break;
      }
    }
    if (currentTurn.length > 0) turns.unshift(currentTurn);

    const result: ChatMessage[] = [];
    if (systemMsg) result.push(systemMsg);
    result.push(...turns.flat());
    return result;
  }
}
```

### 3.4 与 ReAct 循环集成

在 `ReActAgent.run()` 的迭代循环中，每次 LLM 调用前检查：

```typescript
// react-agent.ts 改造（伪代码）
if (workingMemory.needsCompaction(messages)) {
  debug.log('L1 超阈值，触发 pre-compaction flush');
  const extracted = await workingMemory.preCompactionFlush(messages, llm);
  await episodicMemory.appendToday(extracted);
  messages = workingMemory.compact(messages);
  debug.log(`压缩完成，保留 ${messages.length} 条消息`);
}
```

---

## 四、L2 情景记忆（Episodic Memory）

### 4.1 设计原则

- **按天分文件**：`{cwd}/memory/YYYY-MM-DD.md`，天然时间索引
- **Session 隔离**：条目带 `sessionId` 和 `scope` 标签，检索时过滤
- **不自动注入 context**：避免历史噪声污染
- **按需检索**：通过 `memorySearch()` 召回相关片段
- **追加写 only**：不修改历史文件，保证不可变性
- **文件是真相源，SQLite 只是索引**

### 4.2 Session 隔离机制

#### 隔离标签

```typescript
// src/memory/types.ts 新增
export type MemoryScope = 'session' | 'global';

export interface EpisodicEntry {
  sessionId: string;          // 来源 Session ID
  scope: MemoryScope;         // 作用域
  content: string;
  timestamp: string;
}

export interface AppendOptions {
  sessionId?: string;
  scope?: MemoryScope;        // 默认 'session'
}

export interface SearchOptions {
  sessionId?: string;         // 过滤当前会话
  includeGlobal?: boolean;    // 是否包含全局记忆（默认 true）
  topK?: number;
}
```

#### 隔离策略

| scope | 说明 | 检索行为 |
|-------|------|----------|
| `session` | 会话私有记忆（工具结果、临时信息） | 只在当前 Session 可见 |
| `global` | 全局知识（项目背景、配置信息） | 所有 Session 可见 |

**默认行为**：
- 工具调用结果 → `scope: 'session'`（避免跨会话污染）
- 用户明确追加的项目知识 → `scope: 'global'`
- 检索时返回：当前 Session 的 `session` 级 + 所有 `global` 级

### 4.3 文件结构

```
{cwd}/memory/
├── 2026-08-06.md          # 历史日记
├── 2026-08-07.md
├── 2026-08-08.md          # 今天，正在写入
└── index.sqlite           # BM25 索引（可重建，非真相源）
```

Daily Note 文件格式（带 Session 标签，已实现）：

```markdown
## 2026-08-08T09:43:26.314Z [sessionId: abc123] [scope: session] [tag: tool]
- [tool:commandRun] input={...} → 华锐报价 ¥12.5/股

## 2026-08-08T09:45:00.000Z [sessionId: abc123] [scope: session] [tag: final_answer]
用户: 帮我查一下华锐的报价
结果: 华锐报价 ¥12.5/股

## 2026-08-08T10:00:00.000Z [sessionId: xyz789] [scope: global] [tag: compaction]
- 项目知识：本项目使用 TypeScript + Node.js 技术栈
```

**格式说明**：
- 使用 `[key: value]` 元数据格式（非 HTML 注释），便于正则解析
- 每个条目以 `##` 开头，后跟时间戳和元数据标签
- `scope: session` 的条目仅创建它的会话可见
- `scope: global` 的条目所有会话可见

### 4.4 EpisodicMemory 类（已实现）

```typescript
// src/memory/episodic.ts 实际实现

export type MemoryScope = 'session' | 'global';

export interface AppendOptions {
  sessionId?: string;
  scope?: MemoryScope;
  tag?: string;
}

export interface SearchOptions {
  sessionId?: string;
  scope?: MemoryScope;
}

export class EpisodicMemory {
  private memoryDir: string;

  constructor(memoryDir: string) {
    this.memoryDir = memoryDir;
  }

  /** 初始化 */
  async init(): Promise<void> {
    await mkdir(this.memoryDir, { recursive: true });
  }

  /** 追加写入（带 Session 标签） */
  async append(day: string, content: string, options: AppendOptions = {}): Promise<void> {
    const filepath = join(this.memoryDir, `${day}.md`);
    const timestamp = new Date().toISOString();
    
    // 构建元数据 header: ## {timestamp} [sessionId: xxx] [scope: session] [tag: tool]
    const metaParts = [timestamp];
    if (options.sessionId) metaParts.push(`sessionId: ${options.sessionId}`);
    if (options.scope) metaParts.push(`scope: ${options.scope}`);
    if (options.tag) metaParts.push(`tag: ${options.tag}`);
    
    const header = metaParts.map(p => `[${p}]`).join(' ');
    const entry = `\n## ${header}\n${content.trim()}\n`;
    await appendFile(filepath, entry, 'utf-8');
  }

  /** 快捷方法：写今天 */
  async appendToday(content: string, options?: AppendOptions): Promise<void> {
    const day = new Date().toISOString().split('T')[0];
    return this.append(day, content, options);
  }

  /**
   * 带 Session 过滤的检索
   * 检索规则：
   * - 指定 sessionId → 返回 scope=global + scope=session(当前会话)
   * - 指定 scope → 只返回该 scope 的条目
   */
  async search(query: string, topK = 5, options: SearchOptions = {}): Promise<MemorySearchResult[]> {
    const days = await this.listDays();
    const results: MemorySearchResult[] = [];
    const lowerQuery = query.toLowerCase();

    for (const day of days) {
      const content = await this.readDay(day);
      if (!content || !content.toLowerCase().includes(lowerQuery)) continue;

      // 按段落匹配 + Session 过滤
      const sections = content.split(/^## /m);
      for (const section of sections) {
        const lines = section.split('\n');
        const header = lines[0] ?? '';
        const body = lines.slice(1).join('\n').trim();

        if (!body.toLowerCase().includes(lowerQuery)) continue;
        if (!this.isSectionVisible(header, options)) continue;

        results.push({ day, content: `## ${header}${body}`, score: 1 });
      }
      if (results.length >= topK) break;
    }
    return results.slice(0, topK);
  }

  /** 判断条目是否对当前请求可见 */
  private isSectionVisible(header: string, options: SearchOptions): boolean {
    const scopeMatch = header.match(/\[scope:\s*(\w+)\]/);
    const sessionMatch = header.match(/\[sessionId:\s*([^\]]+)\]/);
    const entryScope = scopeMatch?.[1] as MemoryScope | undefined;
    const entrySessionId = sessionMatch?.[1];

    // 指定 scope 过滤
    if (options.scope) return entryScope === options.scope;

    // 指定 sessionId 的默认可见性规则
    if (options.sessionId) {
      if (entryScope === 'global') return true;
      if (entryScope === 'session') return entrySessionId === options.sessionId;
      if (!entryScope) return true;  // 向后兼容
    }
    return true;
  }

  /** 列出所有日期文件 */
  async listDays(): Promise<string[]> { /* ... */ }
  
  /** 获取 memory 目录路径 */
  getMemoryDir(): string { return this.memoryDir; }
}
```

### 4.4 SQLite 索引层

```typescript
// src/memory/episodic.ts (MemoryIndex 内部类)

class MemoryIndex {
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async init(): Promise<void> {
    // 使用 better-sqlite3（同步）或 node:sqlite
    // CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
    // USING fts5(day, content, tokenize='unicode61')
  }

  async add(day: string, content: string): Promise<void> {
    // INSERT INTO memory_fts (day, content) VALUES (?, ?)
  }

  async search(query: string, topK: number): Promise<MemorySearchResult[]> {
    // SELECT day, content, bm25(memory_fts) as score
    // FROM memory_fts WHERE memory_fts MATCH ?
    // ORDER BY score LIMIT ?
  }

  /** 从 Markdown 文件重建索引（索引损坏时使用） */
  async rebuildFromFiles(memoryDir: string): Promise<void> {
    // 扫描所有 .md 文件，逐条重新索引
  }
}
```

### 4.5 依赖说明

Phase 1 可使用 `node:sqlite`（Node.js 22.11+ 内置）或 `better-sqlite3`。如果不想引入新依赖，Phase 1 可先用简单的文件内容检索（遍历日期文件做关键词匹配），后续再升级到 SQLite FTS5。

---

## 五、L3 长期记忆（Curated Core）

### 5.1 文件分工

| 文件 | 内容 | 写入权限 |
|------|------|----------|
| `SOUL.md` | Agent 人格、核心价值观、行为准则 | 仅系统初始化 / 人工编辑 |
| `USER.md` | 用户画像、稳定偏好、沟通风格 | Promotion Gate 晋升 |
| `MEMORY.md` | 精炼事实、跨会话关键知识 | Promotion Gate 晋升 |

### 5.2 初始模板

**SOUL.md**（Agent 人格，系统自动生成一次）：

```markdown
# SOUL - Agent 人格

## 核心身份
你是一个基于 ReAct 框架的智能 Agent，擅长通过工具调用解决复杂问题。

## 行为准则
- 优先使用工具获取准确信息，不凭空臆造
- 在调用工具前，先用自然语言简要说明意图
- 得到足够信息后直接给出最终答案，不继续调用工具
- 面对失败时尝试换思路，不重复同样的失败调用

## 沟通风格
- 使用中文回答
- 回答简洁清晰，结构化表达
```

**USER.md**（空模板，由 Dreaming 逐步填充）：

```markdown
# USER - 用户画像

## 基本信息

## 偏好

## 约束
```

**MEMORY.md**（空模板，由 Dreaming 逐步填充）：

```markdown
# MEMORY - 精炼事实

## 项目知识

## 关键决策

## 已知问题
```

### 5.3 CuratedMemory 类

```typescript
// src/memory/curated.ts

export interface CuratedFiles {
  soul: string;
  user: string;
  memory: string;
}

export class CuratedMemory {
  private workspaceDir: string;
  private files: CuratedFiles = {
    soul: 'SOUL.md',
    user: 'USER.md',
    memory: 'MEMORY.md',
  };

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  /** 初始化：创建文件（如不存在） */
  async init(): Promise<void> {
    for (const [key, filename] of Object.entries(this.files)) {
      const filepath = join(this.workspaceDir, filename);
      if (!fileExists(filepath)) {
        await writeFile(filepath, this.getDefaultContent(key), 'utf-8');
      }
    }
  }

  /** 读取指定文件内容 */
  async read(key: keyof CuratedFiles): Promise<string> {
    const filepath = join(this.workspaceDir, this.files[key]);
    if (!fileExists(filepath)) return '';
    return readFile(filepath, 'utf-8');
  }

  /** 读取全部 Curated 文件，返回 system prompt 片段 */
  async buildSystemPrompt(): Promise<string> {
    const sections: string[] = [];
    for (const [key, filename] of Object.entries(this.files)) {
      const content = await this.read(key as keyof CuratedFiles);
      if (content && content.trim()) {
        const title = filename.replace('.md', '');
        sections.push(`# ${title}\n${content.trim()}`);
      }
    }
    return sections.join('\n\n');
  }

  /** 向指定文件追加一条事实 */
  async append(key: keyof CuratedFiles, fact: string): Promise<void> {
    const filepath = join(this.workspaceDir, this.files[key]);
    const current = await this.read(key);
    const newLine = `- ${fact}\n`;
    if (current.includes(newLine.trim())) return; // 去重
    await writeFile(filepath, current + newLine, 'utf-8');
  }

  private getDefaultContent(key: string): string {
    // 返回各文件的初始模板内容
  }
}
```

### 5.4 常驻注入策略

在 `buildSystemPrompt()` 中，L3 Curated 内容作为 system prompt 的一部分注入：

```typescript
// src/agent/prompt.ts 改造

export async function buildFullSystemPrompt(
  skills: SkillMetadata[] = [],
  curatedContent?: string,  // L3 Curated 注入
): Promise<string> {
  const basePrompt = buildSystemPrompt(skills);
  const curatedSection = curatedContent
    ? `\n\n## 你的长期记忆（Curated Memory）\n以下是关于你服务的用户和积累的知识，请在回答时参考：\n${curatedContent}`
    : '';
  return basePrompt + curatedSection;
}
```

---

## 六、Promotion Gate（晋升闸门）

### 6.1 设计理念

**不是什么信息都配进 L3**。不同来源的信息可信度不同，晋升需要不同的确认门槛。

### 6.2 类型定义

```typescript
// src/memory/gate.ts

export type Provenance =
  | 'owner_direct'      // 用户明确说出（最高可信度）
  | 'owner_derived'     // 从用户行为推导
  | 'tool_output'       // 工具返回（需验证）
  | 'web_search'        // 网页搜索（低可信度）
  | 'agent_inferred'    // Agent 自己推断（最低）
  | 'system';           // 系统脚手架（不可晋升）

export interface PendingFact {
  fact: string;
  count: number;
  provenance: Provenance;
  firstSeen: string;    // ISO timestamp
  category: 'preference' | 'fact' | 'rule' | 'skill';
  targetFile: 'USER.md' | 'MEMORY.md';
}

export class PromotionGate {
  /** 不同来源的最小确认次数 */
  private static readonly REQUIRED_CONFIRMATIONS: Record<Provenance, number> = {
    owner_direct: 1,     // 用户说的，一次就够
    owner_derived: 2,    // 推导的，需要两次交叉验证
    tool_output: 3,      // 工具结果，需要多次一致
    web_search: 4,       // 网页信息，要求更高
    agent_inferred: 5,   // 自己猜的，最难晋升
    system: -1,          // 永不可晋升
  };

  private pending: Map<string, PendingFact> = new Map();

  /** 评估一条事实是否够格晋升 */
  evaluate(fact: string, provenance: Provenance): boolean {
    if (provenance === 'system') return false;

    const threshold = PromotionGate.REQUIRED_CONFIRMATIONS[provenance];
    const key = this.normalize(fact);

    if (!this.pending.has(key)) {
      this.pending.set(key, {
        fact,
        count: 1,
        provenance,
        firstSeen: new Date().toISOString(),
        category: 'fact',
        targetFile: 'MEMORY.md',
      });
      return false;
    }

    const entry = this.pending.get(key)!;
    entry.count += 1;
    return entry.count >= threshold;
  }

  /** 标记事实的类别和目标文件 */
  categorize(fact: string, category: PendingFact['category'], targetFile: PendingFact['targetFile']): void {
    const key = this.normalize(fact);
    const entry = this.pending.get(key);
    if (entry) {
      entry.category = category;
      entry.targetFile = targetFile;
    }
  }

  /** 获取已确认的事实并清除（晋升后调用） */
  consumeApproved(): PendingFact[] {
    const approved: PendingFact[] = [];
    for (const [key, entry] of this.pending) {
      const threshold = PromotionGate.REQUIRED_CONFIRMATIONS[entry.provenance];
      if (entry.count >= threshold) {
        approved.push(entry);
        this.pending.delete(key);
      }
    }
    return approved;
  }

  /** 归一化事实文本，避免同义重复 */
  private normalize(fact: string): string {
    return fact.toLowerCase().trim().replace(/[。.!！?？]+$/, '');
  }

  /** 序列化/反序列化（用于持久化 pending 状态） */
  serialize(): string {
    return JSON.stringify(Array.from(this.pending.entries()));
  }

  deserialize(json: string): void {
    const entries = JSON.parse(json) as [string, PendingFact][];
    this.pending = new Map(entries);
  }
}
```

### 6.3 Gate 状态持久化

`PromotionGate` 的 `pending` Map 需要持久化，避免重启后丢失计数。存储位置：`{cwd}/.memory-gate.json`。

```typescript
// src/memory/gate.ts

async saveState(workspaceDir: string): Promise<void> {
  const path = join(workspaceDir, '.memory-gate.json');
  await writeFile(path, this.serialize(), 'utf-8');
}

async loadState(workspaceDir: string): Promise<void> {
  const path = join(workspaceDir, '.memory-gate.json');
  if (fileExists(path)) {
    const data = await readFile(path, 'utf-8');
    this.deserialize(data);
  }
}
```

---

## 七、Dreaming 晋升流水线

### 7.1 设计原则

- **后台异步运行**：不阻塞主回复路径
- **巡检最近 N 天的 Daily Notes**：提取候选事实
- **逐条过 Promotion Gate**：确保只有高价值信息进入 L3
- **可用更强模型**：Dreaming 可以用比主对话更贵的模型

### 7.2 DreamingPipeline 类

```typescript
// src/memory/dreaming.ts

const DREAMING_PROMPT = `你是记忆管理员。下面是一段近期对话记录，请提取其中值得长期记住的事实。

筛选标准：
1. 用户明确表达的偏好或约束（高优先级）
2. 被多次验证的事实（高优先级）
3. 对未来决策有指导意义的信息（中优先级）
4. 一次性临时信息（丢弃）

对每条候选事实，输出 JSON：
[{"fact": "事实陈述（一句话）", "confidence": 1-10, "category": "preference|fact|rule|skill", "targetFile": "USER.md|MEMORY.md"}]`;

export class DreamingPipeline {
  private episodic: EpisodicMemory;
  private gate: PromotionGate;
  private curated: CuratedMemory;
  private llm: LLMClient;

  constructor(
    episodic: EpisodicMemory,
    gate: PromotionGate,
    curated: CuratedMemory,
    llm: LLMClient,
  ) {
    this.episodic = episodic;
    this.gate = gate;
    this.curated = curated;
    this.llm = llm;
  }

  /** 巡检最近 N 天的 daily notes */
  async run(daysBack = 3): Promise<DreamingResult> {
    const result: DreamingResult = { promoted: [], skipped: [], errors: [] };

    try {
      const days = await this.episodic.readRecentDays(daysBack);
      if (days.length === 0) return result;

      // 合并多天内容
      const combinedContent = days.map((d) => `## ${d.day}\n${d.content}`).join('\n\n');

      // 让 LLM 提取候选事实
      const prompt = `${DREAMING_PROMPT}\n\n---对话记录---\n${combinedContent}`;
      const response = await this.llm.chat([
        { role: 'user', content: prompt },
      ]);

      // 解析 JSON 数组
      const candidates = this.parseCandidates(response.content ?? '[]');

      // 逐条过 Gate
      for (const cand of candidates) {
        const provenance = this.inferProvenance(cand);
        this.gate.categorize(cand.fact, cand.category, cand.targetFile);
        
        if (this.gate.evaluate(cand.fact, provenance)) {
          await this.curated.append(cand.targetFile, cand.fact);
          result.promoted.push({ ...cand, provenance });
        } else {
          result.skipped.push({ ...cand, provenance });
        }
      }

      // 保存 Gate 状态
      await this.gate.saveState(this.curated.workspaceDir);

    } catch (e) {
      result.errors.push(e instanceof Error ? e.message : String(e));
    }

    return result;
  }

  /** 推断候选事实的来源可信度 */
  private inferProvenance(cand: { fact: string; confidence: number }): Provenance {
    // 简单规则：confidence >= 8 → owner_direct, 6-7 → owner_derived, ...
    if (cand.confidence >= 8) return 'owner_direct';
    if (cand.confidence >= 6) return 'owner_derived';
    if (cand.confidence >= 4) return 'tool_output';
    return 'agent_inferred';
  }

  /** 解析 LLM 返回的 JSON */
  private parseCandidates(content: string): Array<{
    fact: string; confidence: number;
    category: 'preference' | 'fact' | 'rule' | 'skill';
    targetFile: 'USER.md' | 'MEMORY.md';
  }> {
    try {
      // 尝试直接解析
      return JSON.parse(content);
    } catch {
      // 尝试提取 JSON 块
      const match = content.match(/\[[\s\S]*\]/);
      if (match) {
        try { return JSON.parse(match[0]); } catch {}
      }
      return [];
    }
  }
}

export interface DreamingResult {
  promoted: Array<{ fact: string; confidence: number; category: string; targetFile: string; provenance: string }>;
  skipped: Array<{ fact: string; confidence: number; category: string; targetFile: string; provenance: string }>;
  errors: string[];
}
```

### 7.3 触发时机

Dreaming 不在主对话循环中触发，而是在以下时机：

1. **会话结束时**：用户输入 `exit/quit/退出` 后、程序关闭前
2. **CLI 命令 `/memory dream`**：用户手动触发
3. **定时触发（可选）**：长时间空闲时后台触发

```typescript
// index.ts 改造（伪代码）
rl.on('close', async () => {
  // 会话结束后执行 Dreaming
  try {
    const result = await dreaming.run(3);
    if (result.promoted.length > 0) {
      console.log(`[Dreaming] 晋升 ${result.promoted.length} 条事实到 L3`);
    }
  } catch {}
  process.exit(0);
});
```

---

## 八、ToolMemoryCallback（工具记忆回调）

### 8.1 设计目标

工具产生的结果是重要记忆来源，但**不能直接晋升到 L3**——需要标记来源、等待验证。

### 8.2 实现（已完成）

```typescript
// src/memory/callback.ts 实际实现

export class ToolMemoryCallback {
  private episodic: EpisodicMemory;
  private _sessionId: string | null = null;

  constructor(episodic: EpisodicMemory) {
    this.episodic = episodic;
  }

  /** 设置当前会话 ID（由 ReActAgent 在运行时调用） */
  setSessionId(sessionId: string | null): void {
    this._sessionId = sessionId;
  }

  /** 工具调用结果自动写入 L2（带 sessionId 和 scope=session） */
  async log(toolName: string, input: Record<string, unknown>, output: string): Promise<void> {
    const truncated = this.truncate(output, 200);
    const entry = `- [tool:${toolName}] input=${JSON.stringify(input)} → ${truncated}`;
    try {
      const options: AppendOptions = { tag: 'tool' };
      if (this._sessionId) {
        options.sessionId = this._sessionId;
        options.scope = 'session';  // 工具结果默认会话隔离
      }
      await this.episodic.appendToday(entry, options);
    } catch { /* 静默丢弃 */ }
  }

  /** 工具错误也记录 */
  async logError(toolName: string, error: string): Promise<void> { /* ... */ }

  /** 记录全局级别的记忆（跨会话可见） */
  async logGlobal(content: string, tag?: string): Promise<void> {
    try {
      await this.episodic.appendToday(content, {
        scope: 'global',
        tag,
        sessionId: this._sessionId ?? undefined,
      });
    } catch { /* 静默丢弃 */ }
  }

  private truncate(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, max) + '...';
  }
}
```

### 8.3 集成点

在 `ReActAgent.run()` 的工具执行后：

```typescript
// react-agent.ts 改造（伪代码）
// 执行工具后
for (let i = 0; i < callItems.length; i++) {
  const { toolName, args } = callItems[i];
  const observation = observations[i];
  // 记录到 L2
  void this._memoryCallback.log(toolName, args ?? {}, observation);
}
```

---

## 九、Context Assembly（上下文组装）

### 9.1 组装流程

```typescript
// src/memory/context.ts

export class ContextAssembler {
  private curated: CuratedMemory;
  private episodic: EpisodicMemory;

  constructor(curated: CuratedMemory, episodic: EpisodicMemory) {
    this.curated = curated;
    this.episodic = episodic;
  }

  /**
   * 组装完整 context：L3 常驻 + L2 检索 + L1 当前
   * 每次 LLM 调用前执行
   */
  async assemble(
    userMessage: string,
    currentMessages: ChatMessage[],
    skills: SkillMetadata[] = [],
    maxRetrievedTokens = 1000,
  ): Promise<ChatMessage[]> {
    // 1. L3 常驻：system prompt（含 SOUL/USER/MEMORY）
    const curatedContent = await this.curated.buildSystemPrompt();
    const systemPrompt = buildSystemPrompt(skills) + '\n' + curatedContent;

    // 2. L2 检索：召回相关历史片段
    let memoryBlock = '';
    try {
      const retrieved = await this.safeSearch(userMessage, 3);
      if (retrieved.length > 0) {
        memoryBlock = retrieved.map((r) => r.content).join('\n');
      }
    } catch {
      // 检索失败不影响主流程
    }

    const finalSystemPrompt = memoryBlock
      ? `${systemPrompt}\n\n## 相关历史记忆\n以下是你在之前会话中积累的相关信息，请参考：\n${memoryBlock}`
      : systemPrompt;

    // 3. 组装完整 messages
    const messages: ChatMessage[] = [
      { role: 'system', content: finalSystemPrompt },
      ...currentMessages.filter((m) => m.role !== 'system'),
    ];

    return messages;
  }

  /** 带超时的安全检索 */
  private async safeSearch(query: string, topK: number, timeoutMs = 500): Promise<MemorySearchResult[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.episodic.search(query, topK);
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }
}
```

---

## 十、核心配置扩展

### 10.1 配置 Schema

```typescript
// src/config/schema.ts 扩展

export interface MemoryConfig {
  enabled: boolean;
  /** L1 配置 */
  working: WorkingMemoryConfig;
  /** L2 配置 */
  episodic: {
    dir: string;            // memory 目录
    searchTopK: number;     // 检索返回条数
    searchTimeoutMs: number; // 检索超时
  };
  /** L3 配置 */
  curated: {
    files: string[];        // 需要加载的 Curated 文件列表
  };
  /** Dreaming 配置 */
  dreaming: {
    enabled: boolean;
    daysBack: number;       // 巡检最近几天
    onExit: boolean;        // 退出时自动执行
  };
}

export interface AgentConfig {
  // ... 原有字段
  memory: MemoryConfig;     // 新增
}
```

### 10.2 默认配置

```typescript
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  working: {
    maxTokens: 8000,
    compactionThreshold: 0.8,
    keepRecentTurns: 3,
  },
  episodic: {
    dir: 'memory',
    searchTopK: 3,
    searchTimeoutMs: 500,
  },
  curated: {
    files: ['SOUL.md', 'USER.md', 'MEMORY.md'],
  },
  dreaming: {
    enabled: true,
    daysBack: 3,
    onExit: true,
  },
};
```

---

## 十一、CLI 命令扩展

### 11.1 新增命令

| 命令 | 说明 |
|------|------|
| `/memory list` | 列出 L2 情景记忆的日期文件 |
| `/memory read <date>` | 读取指定日期的记忆（如 2026-08-08） |
| `/memory search <query>` | 搜索 L2 记忆 |
| `/memory dream` | 手动触发 Dreaming 晋升 |
| `/memory status` | 查看记忆系统状态（各层统计） |
| `/memory init` | 初始化 L3 Curated 文件 |
| `/memory gate` | 查看 Promotion Gate 待处理事实 |

### 11.2 `/memory` 命令处理器框架

```typescript
// index.ts 中新增

async function handleMemory(input: string): Promise<void> {
  const parts = input.split(/\s+/);
  const sub = parts[1] ?? 'list';
  const args = parts.slice(2);

  switch (sub) {
    case 'list':
      // 列出 memory/ 目录下所有日期文件
      break;
    case 'read':
      // 读取指定日期的记忆
      break;
    case 'search':
      // 搜索 L2 记忆
      break;
    case 'dream':
      // 手动触发 Dreaming
      break;
    case 'status':
      // 查看记忆系统状态
      break;
    case 'init':
      // 初始化 L3 Curated 文件
      break;
    case 'gate':
      // 查看 Gate 待处理事实
      break;
    default:
      console.log('支持: list / read / search / dream / status / init / gate');
  }
}
```

---

## 十二、安全与降级

### 12.1 降级策略

| 组件 | 失败行为 | 恢复方式 |
|------|----------|----------|
| L2 Episodic 写入 | 静默丢弃，不阻塞主流程 | 日志告警，不影响对话 |
| L2 Episodic 检索 | 返回空结果 | 跳过历史记忆，用 L1 + L3 对话 |
| L2 SQLite 索引损坏 | rebuildFromFiles() 重建 | 启动时自动检测并重建 |
| L3 Curated 读取 | 返回空内容 | 仅用 L1 对话 |
| Dreaming 失败 | 跳过本次巡检 | 下次触发时重试 |
| Promotion Gate 状态丢失 | 重新开始计数 | 对已晋升事实无影响 |

### 12.2 关键原则

**记忆子系统挂了不能拖垮主回复。** 所有 memory 操作必须有 timeout/fallback。

```typescript
// 安全包装模式
async function safeMemoryOp<T>(
  op: () => Promise<T>,
  fallback: T,
  timeoutMs = 500,
): Promise<T> {
  try {
    const result = await Promise.race([
      op(),
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    return result;
  } catch {
    return fallback;
  }
}
```

---

## 十三、实施计划

### Phase 1：最小闭环 + Session 分层改造（预计 8h）

| 步骤 | 工作内容 | 产出文件 | 状态 |
|------|----------|----------|------|
| **1.1** | 创建 `src/memory/types.ts`，定义所有记忆相关类型（含 `MemoryScope`、`AppendOptions`、`SearchOptions`） | `src/memory/types.ts` | ✅ |
| **1.2** | 实现 `WorkingMemory`（L1）：token 估算 + 压缩逻辑 | `src/memory/working.ts` | ✅ |
| **1.3** | 实现 `EpisodicMemory`（L2）：带 Session 标签的 Markdown 文件读写 | `src/memory/episodic.ts` | ✅ |
| **1.4** | 实现带 Session 过滤的检索（Phase 1 用简单关键词匹配 + Session 标签解析） | `src/memory/episodic.ts` | ✅ |
| **1.5** | 实现 `CuratedMemory`（L3）：SOUL/USER/MEMORY 文件读写 | `src/memory/curated.ts` | ✅ |
| **1.6** | 实现 `ContextAssembler` 上下文组装（含 Session 隔离的 L2 检索） | `src/memory/context.ts` | ✅ |
| **1.7** | 配置扩展：`MemoryConfig` 加入 `AgentConfig` | `src/config/schema.ts` | ✅ |
| **1.8** | **改造 Session 存储**：`src/session/store.ts` 增加分层存储（`lastSummary`、`recentMessages`、`archivedMessages`） | `src/session/store.ts` | ✅ |
| **1.9** | **改造 Session 恢复**：只加载 `recentMessages` 到 `_chatHistory`，`lastSummary` 注入系统提示词 | `src/session/store.ts` + `src/index.ts` | ✅ |
| **1.10** | 改造 `ReActAgent`：集成 L1 压缩 + L2 flush（带 sessionId）+ L3 注入 + Session 分层保存 | `src/agent/react-agent.ts` | ✅ |
| **1.11** | 改造 `buildSystemPrompt()`：支持注入 `lastSummary` | `src/agent/prompt.ts` | ✅ |
| **1.12** | CLI 命令：`/memory status` / `/memory curated` / `/memory episodic` / `/memory search` | `src/index.ts` | ✅ |
| **1.13** | 集成测试：验证 Session 分层恢复 + L2 隔离检索 | `tests/` | ⬜ |

#### 1.8-1.9 Session 分层改造详情（已实现）

**Session 存储格式**：

```typescript
// src/session/types.ts 已实现
export interface SessionData {
  id: string;
  createdAt: string;
  updatedAt: string;
  
  // 原有字段（兼容旧格式）
  messages?: ChatMessage[];
  steps?: AgentStep[];
  
  // 分层存储字段（新格式）
  lastSummary?: string;           // L1 压缩产物，注入系统提示词
  recentMessages?: ChatMessage[];  // 最近 N 轮对话（L1 工作集）
  archivedMessages?: ChatMessage[]; // 归档消息（可选，不参与上下文）
  archivedCount?: number;          // 归档消息数（用于显示）
  recentTurns?: number;            // 保存时的最近轮数配置
}
```

**Session 保存逻辑**（`store.ts` 已实现）：

```typescript
// SessionStore.updateSession() 实际实现
async updateSession(id: string, messages: ChatMessage[], steps: AgentStep[]): Promise<void> {
  const data = await this.readSession(id);
  data.messages = messages;  // 兼容旧格式
  data.updatedAt = new Date().toISOString();

  // === 分层存储逻辑 ===
  const recentTurns = data.recentTurns ?? this.recentTurns;
  const turnSize = 4;  // 每轮约 4 条：system + user + assistant + tool
  const maxRecentMessages = recentTurns * turnSize;

  // 合并当前 recent + 新消息（去重）
  let mergedRecent = [...(data.recentMessages ?? [])];
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');
  for (const msg of nonSystemMessages) {
    const exists = mergedRecent.some(m => m.role === msg.role && m.content === msg.content);
    if (!exists) mergedRecent.push(msg);
  }

  // 超出阈值的迁移到 archived
  let archived = [...(data.archivedMessages ?? [])];
  if (mergedRecent.length > maxRecentMessages) {
    const overflow = mergedRecent.slice(0, mergedRecent.length - maxRecentMessages);
    mergedRecent = mergedRecent.slice(-maxRecentMessages);
    archived = [...archived, ...overflow];
  }

  // archived 超 30 条时生成摘要
  if (archived.length > 30) {
    // 生成摘要，保留最近 10 条
    data.lastSummary = `[历史摘要] ...`;
    archived = archived.slice(-10);
  }

  data.recentMessages = mergedRecent;
  data.archivedMessages = archived;
  data.archivedCount = archived.length;
  data.recentTurns = recentTurns;

  await this.writeSession(data);
}
```

**Session 恢复逻辑**（`react-agent.ts` + `index.ts` 已实现）：

```typescript
// ReActAgent.restoreSession() 实际实现
restoreSession(data: SessionData, systemPrompt: string): void {
  this._currentSessionId = data.id;
  if (this._memoryCallback) this._memoryCallback.setSessionId(data.id);

  const restored: ChatMessage[] = [];

  // 1. 构建增强的 system prompt（注入 lastSummary）
  let enhancedSystem = systemPrompt;
  if (data.lastSummary) {
    enhancedSystem += `\n\n## 会话历史摘要\n${data.lastSummary}`;
  }
  restored.push({ role: 'system', content: enhancedSystem });

  // 2. 添加 recentMessages（恢复最近对话）
  if (data.recentMessages?.length) {
    restored.push(...data.recentMessages);
  } else if (data.messages) {
    restored.push(...data.messages.filter(m => m.role !== 'system'));
  }

  this._chatHistory = restored;
}

// CLI 调用方式（index.ts）
agent.restoreSession(data, systemPrompt);
const restoreMessages = SessionStore.getRestoreMessages(data);  // 仅用于显示
renderMessages(restoreMessages);
```

### Phase 2：智能压缩（预计 4h）

| 步骤 | 工作内容 | 产出文件 |
|------|----------|----------|
| 2.1 | 实现 `preCompactionFlush()`：LLM 提取关键信息再压缩 | `src/memory/working.ts` |
| 2.2 | 工具结果自动写入 L2（`ToolMemoryCallback`） | `src/memory/callback.ts` |
| 2.3 | CLI 命令：`/memory search` | `src/index.ts` |
| 2.4 | 压缩质量验证：测试压缩前后关键信息保留率 | `tests/` |

### Phase 3：晋升流水线（预计 6h）

| 步骤 | 工作内容 | 产出文件 |
|------|----------|----------|
| 3.1 | 实现 `PromotionGate`：来源可信度评分 + 状态持久化 | `src/memory/gate.ts` |
| 3.2 | 实现 `DreamingPipeline`：后台巡检 + LLM 提取 + Gate 评估 | `src/memory/dreaming.ts` |
| 3.3 | 会话结束自动触发 Dreaming | `src/index.ts` |
| 3.4 | CLI 命令：`/memory dream` / `/memory gate` / `/memory init` | `src/index.ts` |
| 3.5 | 集成测试：验证完整晋升链路 | `tests/` |

### Phase 4：SQLite 索引 + 安全降级（预计 4h）

| 步骤 | 工作内容 | 产出文件 |
|------|----------|----------|
| 4.1 | 引入 `better-sqlite3`（或使用 `node:sqlite`） | `package.json` |
| 4.2 | 实现 `MemoryIndex`：FTS5 全文搜索 | `src/memory/episodic.ts` |
| 4.3 | 索引重建工具：`rebuildFromFiles()` | `src/memory/episodic.ts` |
| 4.4 | 实现所有 memory 操作的 timeout/fallback 包装 | `src/memory/context.ts` |
| 4.5 | 降级策略测试 | `tests/` |

### Phase 5：向量检索（可选，预计 6h）

| 步骤 | 工作内容 | 产出文件 |
|------|----------|----------|
| 5.1 | 接入 embedding 模型（可配置） | `src/memory/embedding.ts` |
| 5.2 | 实现混合检索：BM25 + 向量 RRF 融合 | `src/memory/episodic.ts` |
| 5.3 | 语义相似度排序 | `src/memory/episodic.ts` |

---

## 十四、验收测试清单

### Phase 1 验收

| # | 测试项 | 预期结果 | 状态 |
|---|--------|----------|------|
| 1.1 | L1 token 估算 | 长对话正确估算 token 数 | ✅ |
| 1.2 | L1 压缩触发 | 达到 80% 阈值时触发压缩 | ✅ |
| 1.3 | L1 压缩保留 | 压缩后保留最近 3 轮对话 | ✅ |
| 1.4 | L2 追加写入（带 Session 标签） | 写入 `memory/YYYY-MM-DD.md`，含 `[sessionId:xxx] [scope:session]` 标签 | ✅ |
| 1.5 | L2 按日读取 | 能正确读取指定日期的日记 | ✅ |
| 1.6 | L2 Session 过滤检索 | 检索时只返回当前 Session 的 `session` 级 + 所有 `global` 级 | ✅ |
| 1.7 | L2 跨会话隔离 | Session A 的工具结果不会出现在 Session B 的检索结果中 | ✅ |
| 1.8 | L2 global 级共享 | `scope: global` 的记忆可跨会话检索到 | ✅ |
| 1.9 | L3 文件初始化 | 首次运行自动创建 SOUL.md / USER.md / MEMORY.md | ✅ |
| 1.10 | L3 注入 system prompt | 启动时 Curated 内容正确注入 | ✅ |
| 1.11 | Session 分层存储 | Session 保存时分离 `recentMessages`、`lastSummary`、`archivedMessages` | ✅ |
| 1.12 | Session 分层恢复 | 恢复 Session 时只加载 `recentMessages` 到 `_chatHistory` | ✅ |
| 1.13 | Session summary 注入 | `lastSummary` 在恢复后注入系统提示词 | ✅ |
| 1.14 | Session 超大恢复 | 恢复包含 500 条消息的 Session，首轮不触发 L1 压缩 | ⬜ |
| 1.15 | `/memory status` | 显示记忆系统各层统计（含 Session 数） | ✅ |
| 1.16 | `/memory curated list/read/append` | L3 Curated 文件管理命令正常 | ✅ |
| 1.17 | `/memory episodic list/read` | L2 情景记忆查看命令正常 | ✅ |
| 1.18 | `/memory search <q>` | 带 Session 过滤的关键词检索正常 | ✅ |
| 1.19 | 跨会话 L3 保留 | 重启后 L3 Curated 内容仍在 | ✅ |

### Phase 2 验收

| # | 测试项 | 预期结果 | 状态 |
|---|--------|----------|------|
| 2.1 | Pre-compaction flush | 压缩前 LLM 提取关键信息写入 L2 | ✅ |
| 2.2 | 压缩信息保留 | 压缩后关键信息在 L2 中可检索 | ✅ |
| 2.3 | 工具结果自动记录（带 sessionId） | 工具调用结果写入 L2 当日日记，带当前 sessionId | ✅ |
| 2.4 | `/memory search <q>` | 关键词检索返回当前会话相关日记片段 | ✅ |
| 2.5 | 压缩后对话延续 | 压缩后 Agent 能正常继续对话 | ✅ |

### Phase 3 验收

| # | 测试项 | 预期结果 | 状态 |
|---|--------|----------|------|
| 3.1 | Gate 状态持久化 | 重启后 pending 计数不丢失 | ⬜ |
| 3.2 | 低可信度不晋升 | owner_derived 需 2 次确认才晋升 | ⬜ |
| 3.3 | 高可信度快速晋升 | owner_direct 1 次即晋升 | ⬜ |
| 3.4 | Dreaming 巡检 | 能从 L2 提取候选事实 | ⬜ |
| 3.5 | 晋升写入 L3 | 确认事实写入 USER.md / MEMORY.md | ⬜ |
| 3.6 | 退出自动 Dreaming | 会话退出时自动执行巡检 | ⬜ |
| 3.7 | `/memory dream` | 手动触发 Dreaming | ⬜ |
| 3.8 | `/memory gate` | 查看待处理事实列表 | ⬜ |

### Phase 4 验收

| # | 测试项 | 预期结果 | 状态 |
|---|--------|----------|------|
| 4.1 | SQLite FTS5 索引 | 全文搜索返回准确结果 | ⬜ |
| 4.2 | Session 过滤 + SQLite | FTS5 检索支持 Session 过滤 | ⬜ |
| 4.3 | 索引重建 | 索引损坏后可从 Markdown 重建 | ⬜ |
| 4.4 | 检索超时降级 | 检索超时时返回空，不阻塞对话 | ⬜ |
| 4.5 | 写入失败降级 | L2 写入失败时静默丢弃 | ⬜ |
| 4.6 | L2 读取失败降级 | L2 读取失败时返回空内容 | ⬜ |

---

## 十五、与现有代码的改造点汇总

### 15.1 新增文件

| 文件 | 说明 |
|------|------|
| `src/memory/types.ts` | 记忆相关类型定义（含 `MemoryScope`、`AppendOptions`、`SearchOptions`） |
| `src/memory/working.ts` | L1 WorkingMemory |
| `src/memory/episodic.ts` | L2 EpisodicMemory（带 Session 隔离） |
| `src/memory/curated.ts` | L3 CuratedMemory |
| `src/memory/gate.ts` | PromotionGate（Phase 3） |
| `src/memory/dreaming.ts` | DreamingPipeline（Phase 3） |
| `src/memory/callback.ts` | ToolMemoryCallback（带 sessionId） |
| `src/memory/context.ts` | ContextAssembler（含 Session 隔离检索） |
| `src/memory/index.ts` | 模块聚合入口 |

### 15.2 改造文件

| 文件 | 改造内容 |
|------|----------|
| `src/config/schema.ts` | 新增 `MemoryConfig`，加入 `AgentConfig` |
| `src/config/index.ts` | `ConfigLoader` 支持 memory 配置加载 |
| **`src/session/types.ts`** | **SessionData 增加 `lastSummary`、`recentMessages`、`archivedMessages`、`archivedCount` 字段** |
| **`src/session/store.ts`** | **Session 保存/加载逻辑改造：分层存储 + 分层恢复** |
| **`src/session/store.ts`** | **增加 `extractRecentTurns()` 和 `generateSummary()` 方法** |
| `src/agent/react-agent.ts` | 集成记忆管理：L1 压缩、L2 flush（带 sessionId）、工具回调、Context 组装 + Session 分层保存 |
| `src/agent/prompt.ts` | `buildSystemPrompt()` 支持 L3 Curated 注入 + `lastSummary` 注入 |
| `src/index.ts` | 新增 `/memory` 命令、Session 分层恢复逻辑、会话退出触发 Dreaming |
| `package.json` | Phase 4 新增 `better-sqlite3` 依赖 |

### 15.3 不需要改动

- `src/llm/client.ts` — LLM 客户端不变
- `src/tools/` — 工具系统不变
- `src/skill/` — Skill 系统不变
- `src/config/loader.ts` — 配置加载逻辑不变

### 15.4 数据迁移（Session 格式变更）

由于 SessionData 格式变更，需要处理旧数据兼容：

```typescript
// src/session/store.ts 迁移逻辑
function migrateSessionData(oldData: unknown): SessionData {
  // 旧格式：{ messages: ChatMessage[], ... }
  if ('messages' in (oldData as Record<string, unknown>)) {
    const old = oldData as { messages: ChatMessage[] };
    // 迁移：将全量 messages 转换为新格式
    const recentMessages = extractRecentTurns(old.messages, 3);
    return {
      ...old,
      recentMessages,
      lastSummary: undefined,
      archivedMessages: old.messages.slice(0, -recentMessages.length),
      archivedCount: old.messages.length - recentMessages.length,
    };
  }
  
  // 新格式：直接返回
  return oldData as SessionData;
}
```

---

## 十六、演进路线图

```
Phase 1: 最小闭环（纯文件检索）
  ├── L1 WorkingMemory + token 压缩
  ├── L2 EpisodicMemory（按天 Markdown + 简单关键词匹配）
  ├── L3 CuratedMemory（SOUL/USER/MEMORY 文件）
  └── ContextAssembler 集成

Phase 2: 智能压缩
  ├── Pre-compaction flush（LLM 提取关键信息）
  ├── ToolMemoryCallback（工具结果自动记录）
  └── 压缩质量验证

Phase 3: 晋升流水线
  ├── PromotionGate（来源可信度评分）
  ├── DreamingPipeline（后台巡检）
  └── 自动写入 USER.md / MEMORY.md

Phase 4: 索引与降级
  ├── SQLite FTS5 全文搜索
  ├── 索引重建工具
  └── 所有 memory 操作 timeout/fallback

Phase 5: 向量检索（可选）
  ├── 接入 embedding 模型
  ├── BM25 + 向量 RRF 融合
  └── 语义相似度排序
```

---

## 附录 A：关键设计决策（ADR）

### ADR-1：文件即真相源

**决策**：所有记忆的真相源是 Markdown 文件，SQLite 只是加速索引。

**理由**：
- 文件可读、可 diff、可 git 版本管理
- 索引挂了/迁移了，记忆不丢
- 人工可以直接编辑修正

### ADR-2：写路径和读路径分离

**决策**：回复时只做检索（read path），不抽取新记忆；抽取放到后台 Dreaming（write path）。

**理由**：
- 回复路径要求低延迟，不能每次都让 LLM 判断是否值得记住
- 后台巡检可以用更强模型、更充分思考
- 避免"边聊边记"导致 context 污染

### ADR-3：Promotion Gate 必须有来源标记

**决策**：每条候选记忆必须携带 `Provenance` 枚举，不同来源有不同晋升门槛。

**理由**：
- 防止工具错误输出污染长期记忆
- 防止网页搜索的不可靠信息直接晋升
- 用户明确说出的话优先级最高

### ADR-4：L2 不自动注入 Context

**决策**：Daily Notes 永远不会被自动拼进 system prompt，只能通过 `memory_search()` 按需召回。

**理由**：
- 历史记录量大，全量注入会爆 token
- 按需检索保证召回的相关性和新鲜度
- 避免"昨天聊过的废话"污染今天的推理

### ADR-5：L3 Curated 启动注入而非动态注入

**决策**：L3 在每次 LLM 调用时都注入 system prompt（作为 context 的一部分）。

**理由**：
- 用户画像和 Agent 人格是稳定的，需要始终参考
- 动态注入（按需检索）会增加复杂度
- token 开销可控（Curated 文件通常 < 1000 token）

### ADR-6：不替代 SessionStore

**决策**：Task-11 的 SessionStore（加密会话持久化）和 Task-14 的记忆管理是互补关系。

**理由**：
- SessionStore 解决的是"会话恢复"（加载上次未完成的对话）
- 记忆管理解决的是"跨会话知识积累"（不同会话间共享知识）
- 两者存储格式、生命周期、用途都不同

---

## 附录 B：快速体验流程

```
# 1. 初始化 L3
/memory init
→ 自动创建 SOUL.md / USER.md / MEMORY.md

# 2. 正常对话（L1 + L2 自动工作）
Agent> 你好，我叫张三，是采购负责人
Agent> 帮我查一下华锐的报价

# 3. 查看 L2 记录
/memory list
→ 列出 memory/ 下的日期文件
/memory read 2026-08-08
→ 查看今日对话的结构化笔记

# 4. 手动触发 Dreaming（或退出时自动触发）
/memory dream
→ 巡检最近 3 天的日记
→ 提取候选事实 → 过 Gate → 写入 USER.md

# 5. 下次对话（L3 自动注入）
Agent> 你好
→ Agent 已经知道你是张三，采购负责人

# 6. 搜索历史记忆
/memory search 华锐
→ 返回之前关于华锐报价的记录
```

---

## 附录 C：配置示例

```jsonc
// {cwd}/.agent-config.json
{
  "memory": {
    "enabled": true,
    "working": {
      "maxTokens": 8000,
      "compactionThreshold": 0.8,
      "keepRecentTurns": 3
    },
    "episodic": {
      "dir": "memory",
      "searchTopK": 3,
      "searchTimeoutMs": 500
    },
    "curated": {
      "files": ["SOUL.md", "USER.md", "MEMORY.md"]
    },
    "dreaming": {
      "enabled": true,
      "daysBack": 3,
      "onExit": true
    }
  }
}
```