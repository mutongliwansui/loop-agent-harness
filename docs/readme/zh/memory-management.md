# 🧠 记忆管理

> [⬅ 返回 README](../../../README.md)

基于 OpenClaw 风格的三层记忆架构（Tier Model），核心思想：**文件是真相源，索引只做加速；写读路径分离；晋升有闸门。** 记忆系统与会话持久化（Task-11）互补：会话持久化解决"恢复上次对话"，记忆管理解决"跨会话知识积累"。

### 三层架构

| 层级 | 存储形态 | 生命周期 | 自动进 context | 说明 |
|---|---|---|---|---|
| **L1 Working** | 内存 `_chatHistory` | 单次会话 | ✅ 始终在 | 超阈值自动压缩（默认 8000 token / 80% 阈值，保留最近 3 轮） |
| **L2 Episodic** | `{cwd}/memory/YYYY-MM-DD.md` | 永久存档 | ❌ 按需检索 | 按天分文件，工具调用结果自动记录，支持 `/memory search` 召回 |
| **L3 Curated** | `{cwd}/SOUL.md` / `USER.md` / `MEMORY.md` | 永久常驻 | ✅ 启动注入 | Agent 人格 / 用户画像 / 精炼事实，常驻 System Prompt |

### 目录结构

```
<workspace>/
├── SOUL.md                     # L3：Agent 人格与行为准则（系统生成，人工编辑）
├── USER.md                     # L3：用户画像（稳定偏好、沟通风格、约束）
├── MEMORY.md                   # L3：精炼事实（项目知识、关键决策、已知问题）
└── memory/                     # L2：情景记忆（按天分文件）
    ├── 2026-08-08.md
    ├── 2026-08-09.md
    └── ...
```

### L3 文件模板

```markdown
# SOUL - Agent 人格
## 核心身份 / 行为准则 / 沟通风格

# USER - 用户画像
## 基本信息 / 偏好 / 约束

# MEMORY - 精炼事实
## 项目知识 / 关键决策 / 已知问题
```

首次启动或执行 `/memory curated list` 时自动创建；L3 内容会在每次 LLM 调用时注入 System Prompt，作为"长期记忆"常驻参考。

### CLI 示例

```
/memory status                          # 查看记忆系统状态（各层统计）
/memory curated list                    # 列出 L3 核心记忆文件（行数/字符数）
/memory curated read user               # 读取 USER.md
/memory curated append memory "决策：默认使用 DeepSeek 模型"  # 追加核心记忆
/memory episodic list                   # 列出 L2 情景记忆日志
/memory episodic read 2026-08-09        # 读取指定日期日志
/memory search 华锐                      # 搜索历史记忆
/memory dream 3                         # 手动触发 Dreaming 巡检（最近 3 天）
/memory gate                            # 查看 Promotion Gate 待确认/待晋升事实
```

### 编程式使用

```typescript
import {
  EpisodicMemory, CuratedMemory, WorkingMemory,
  PromotionGate, DreamingPipeline, MemoryIndex, VectorMemory, rrfMerge,
} from './src/memory/index.js';

// L2 情景记忆：按天写入/读取
const episodic = new EpisodicMemory(process.cwd());
await episodic.init();
await episodic.appendToday('- 用户询问了华锐的报价');

// L3 核心记忆：读写 SOUL / USER / MEMORY
const curated = new CuratedMemory(process.cwd());
await curated.init();
await curated.append('user', '用户偏好邮件沟通');

// L1 工作记忆：token 估算与压缩
const working = new WorkingMemory();
const needs = working.needsCompaction(messages);

// Promotion Gate + Dreaming：L2 → L3 晋升（不同来源需不同确认次数）
const gate = new PromotionGate(process.cwd());
await gate.init();
await gate.record('用户偏好邮件沟通', 'owner_direct');

const dream = new DreamingPipeline({ gate, episodic, curated, llm });
const result = await dream.run(3);   // 巡检最近 3 天，达标事实晋升 L3

// 混合检索：BM25 全文 + 向量（可选）通过 RRF 融合排序
const index = new MemoryIndex();
index.add(day, content);
const vector = new VectorMemory();
const merged = rrfMerge(ftsHits, vectorHits);
```

### 设计原则（Phase 1-5 已落地）

- **文件即真相源**：Markdown 明文可读、可 diff、可版本管理（SQLite 索引在后续阶段引入）
- **写读分离**：回复路径只做检索，不抽取记忆；抽取走 Dreaming 流水线（`/memory dream` 或退出时自动触发）
- **晋升有闸门**：不同来源（用户直述 / 工具输出 / 网页搜索）需不同确认次数才能晋升 L3（Promotion Gate 已实现，`/memory gate` 可查看）
- **混合检索**：BM25 全文检索 + 向量检索（可选）通过 RRF 融合排序，配置 `episodic.vectorSearch` 后自动启用，embedding 失败自动降级
- **失败降级**：记忆子系统异常不影响主回复路径
