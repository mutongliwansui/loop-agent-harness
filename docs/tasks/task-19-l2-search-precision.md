# Task 19：L2 检索精度优化

> **状态**：待实施
> **创建时间**：2026-08-16
> **关联任务**：Task-14（memory-management）、Task-16（dreaming-cache-optimization）

## 一、背景

用户让 Agent 执行任务 1，完成后说"继续"，Agent 把另一个完全不相干的历史对话检索出来——只因历史对话中也包含"继续"二字。不相关历史注入上下文后干扰了 Agent 判断，导致跑偏。

## 二、根因分析

检索链路：

```
用户输入 "继续"
  → context.ts safeSearch("继续", topK=3, sessionId)
    → episodic.search("继续", 3, {sessionId})
      → sectionMatches("继续", 条目正文)
        → bigram("继续") = {"继续"}
        → 正文含"继续"二字 → 命中（实际不相关）
      → 所有命中统一 score: 1 → 无法区分强弱
    → 3 条不相关历史注入 user 消息前缀 → 干扰 Agent
```

5 个根因：

| # | 根因 | 代码位置 |
|---|---|---|
| 1 | **查询词过短**——只用当前消息搜索，"继续"的 bigram 过于宽泛 | `context.ts:132` `safeSearch(userMessage, ...)` |
| 2 | **无相关性评分**——所有命中统一 `score: 1` | `episodic.ts:332-336` `results.push({ ..., score: 1 })` |
| 3 | **无最低阈值**——只要命中就注入 | `context.ts:133` `if (retrieved.length > 0)` |
| 4 | **无时间衰减**——3 个月前的命中和今天的等价 | 全程 `score: 1` |
| 5 | **bigram 对短查询过于宽泛**——2 字查询只产生 1 个 bigram | `episodic.ts:46-49` |

## 三、方案设计

### 方案 1：查询增强——用对话上下文替代单条消息

**目标**：不用 `"继续"` 搜索，而是用最近 N 轮对话拼接后搜索。

**改动位置**：`src/memory/context.ts` `assemble()`

**逻辑**：

```typescript
// 改前：只用当前 user 消息搜索
const retrieved = await this.safeSearch(userMessage, searchTopK, ...);

// 改后：拼接最近 3 轮对话作为查询
const recentContext = currentMessages
  .filter(m => m.role === 'user' || m.role === 'assistant')
  .slice(-6)  // 最近 3 轮（6 条消息）
  .map(m => typeof m.content === 'string' ? m.content : '')
  .join(' ');
const retrieved = await this.safeSearch(recentContext, searchTopK, ...);
```

**效果**：查询从 `"继续"` 变为 `"优化缓存命中率 context.ts assemble 继续"`——匹配到的将是关于缓存优化的历史，而非任何含"继续"的不相关对话。

**注意事项**：
- 查询变长可能增加匹配数量，需配合方案 2 的评分机制过滤
- 如果当前是第一轮对话（无历史），`recentContext` 退化为 `userMessage` 本身

### 方案 2：真实评分 + 最低阈值

**目标**：用真实 BM25 分数替代统一 `score: 1`，设最低阈值过滤弱匹配。

**改动位置**：
- `src/memory/episodic.ts`：`filterEntries()`、`searchViaFiles()`
- `src/memory/context.ts`：`assemble()` 中过滤

**逻辑**：

1. **FTS5 路径**（已有 BM25 分数，当前被丢弃）：

```typescript
// filterEntries 中，改前：
results.push({ day, content, score: 1 });
// 改后：
results.push({ day, content, score: entry.score }); // 保留 BM25 真实分数
```

2. **文件检索路径**（无 FTS5 时）：

```typescript
// searchViaFiles 中，用匹配 bigram 比例作为分数
const queryBigrams = extractChineseBigrams(query);
const matched = [...queryBigrams].filter(bg => sectionBody.toLowerCase().includes(bg));
const score = matched.length / Math.max(queryBigrams.size, 1); // 0~1
```

3. **阈值过滤**（context.ts）：

```typescript
// assemble 中，改前：
if (retrieved.length > 0) { memoryBlock = ... }

// 改后：
const MIN_SCORE = 2.0; // BM25 经验阈值，需调参
const filtered = retrieved.filter(r => r.score >= MIN_SCORE);
if (filtered.length > 0) { memoryBlock = filtered.map(r => r.content).join('\n'); }
// 全部低于阈值 → 不注入 → 不干扰
```

**效果**：短查询"继续"只产生 1 个 bigram，BM25 分数极低；长查询匹配多个 term，分数高。低于阈值的历史不注入。

**注意事项**：
- BM25 阈值需实测调参（建议初始 2.0，根据命中率调整）
- 文件检索路径的评分逻辑和 FTS5 路径的评分量纲不同，需统一（或分别设阈值）

### 方案 3：时间衰减加权

**目标**：越新的记忆分数越高，旧的自动降权。

**改动位置**：`src/memory/episodic.ts` `filterEntries()`、`searchViaFiles()`

**逻辑**：

```typescript
const daysSince = (Date.now() - new Date(entry.day + 'T00:00:00').getTime()) / 86400000;
const recencyFactor = Math.exp(-daysSince / 7); // 半衰期 7 天
const finalScore = baseScore * recencyFactor;
// 今天: ×1.0, 7天前: ×0.37, 30天前: ×0.014
```

**效果**：今天的"继续优化缓存"得分远高于 3 个月前的"继续讨论部署"。

**注意事项**：
- 半衰期 7 天需可配置（建议加入 `memory.episodic.recencyHalfLifeDays`）
- 跨年日期解析需稳健处理（`entry.day` 格式为 `YYYY-MM-DD`）

### 方案 4：当前会话优先检索

**目标**：分两轮搜索——先搜当前会话的 L2 条目，有结果就不搜全局。

**改动位置**：`src/memory/episodic.ts` `search()` 或 `src/memory/context.ts` `safeSearch()`

**逻辑**：

```typescript
// 第一轮：只搜当前 session 的条目
const sessionResults = await this.episodic.search(query, topK, {
  sessionId,
  scope: 'session',
});
if (sessionResults.length > 0) return sessionResults;

// 第二轮：兜底搜全局
return this.episodic.search(query, topK, { sessionId });
```

**效果**：当前任务的 L2 条目（同 sessionId）优先返回，不相关会话的条目仅在当前会话无结果时才兜底。

**注意事项**：
- 需确认 `scope: 'session'` 条目写入量是否足够（取决于 ToolMemoryCallback 的写入频率）
- 如果 session 级条目稀疏，此方案效果有限，方案 1+2+3 已足够

### 方案 5：短查询保护——直接跳过 L2 检索

**目标**：对过短或过于通用的查询，直接不触发 L2 检索。

**改动位置**：`src/memory/context.ts` `safeSearch()` 或 `assemble()`

**逻辑**：

```typescript
const STOPWORDS = new Set([
  '继续', '好的', '是的', '可以', 'ok', '嗯', '对', '行', '不是',
  '继续。', '好的。', '是的。',
]);

const trimmed = userMessage.trim().toLowerCase();
if (trimmed.length < 4 || STOPWORDS.has(trimmed)) {
  return []; // 不检索，不注入
}
```

**效果**：最简单的第一道防线——"继续"这类消息完全不触发 L2 检索。

**注意事项**：
- 停用词列表需要持续维护
- 长度阈值 4 字符是中文经验值（中文 4 字 ≈ 英文 1 单词）
- 如果方案 1 查询增强已实施，此方案作为前置过滤仍然有价值（短消息不触发增强搜索，节省一次检索 I/O）

## 四、实施计划

### 阶段一：三层核心防线（方案 5 + 1 + 2）

| 步骤 | 内容 | 文件 |
|---|---|---|
| 6.1 | 方案 5：短查询保护——在 `context.ts` `safeSearch` 前加停用词 + 长度检查 | `context.ts` |
| 6.2 | 方案 1：查询增强——`assemble` 中用最近 6 条对话拼接替代单条 `userMessage` | `context.ts` |
| 6.3 | 方案 2a：FTS5 路径保留 BM25 真实分数（`filterEntries` 中 `score: entry.score`） | `episodic.ts` |
| 6.4 | 方案 2b：文件检索路径用匹配比例评分 | `episodic.ts` |
| 6.5 | 方案 2c：`context.ts` `assemble` 中加 `MIN_SCORE` 阈值过滤 | `context.ts` |
| 6.6 | 新增配置项 `memory.episodic.searchMinScore`、`memory.episodic.queryEnhanceRounds` | `config/schema.ts` + `config.ts` |
| 6.7 | 验证：TSC + vitest + 手动测试短查询场景 | — |

### 阶段二：精度提升（方案 3 + 4）

| 步骤 | 内容 | 文件 |
|---|---|---|
| 6.8 | 方案 3：`filterEntries` 和 `searchViaFiles` 中加时间衰减因子 | `episodic.ts` |
| 6.9 | 方案 3：新增配置 `memory.episodic.recencyHalfLifeDays`（默认 7） | `config/schema.ts` + `config.ts` |
| 6.10 | 方案 4：`safeSearch` 中分两轮搜索（session 优先） | `context.ts` 或 `episodic.ts` |
| 6.11 | 验证：TSC + vitest | — |

## 五、配置项设计

```jsonc
{
  "memory": {
    "episodic": {
      "searchMinScore": 2.0,        // 方案 2：BM25 最低阈值
      "queryEnhanceRounds": 3,      // 方案 1：查询增强轮数（0=禁用）
      "recencyHalfLifeDays": 7,     // 方案 3：时间衰减半衰期（0=禁用）
      "shortQueryMinLength": 4,     // 方案 5：短查询最小长度
      "stopwords": []               // 方案 5：自定义停用词（追加到内置列表）
    }
  }
}
```

## 六、验收清单

| # | 验收项 | 验证方式 |
|---|---|---|
| 7.1 | `npx tsc --noEmit` 编译零错误 | TSC |
| 7.2 | `npx vitest run` 全量测试通过 | vitest |
| 7.3 | 输入"继续"不再检索到不相关历史 | 手动测试 |
| 7.4 | 输入"继续"后注入的历史与当前任务相关（或无注入） | 手动测试 |
| 7.5 | BM25 分数被保留（非统一 1） | 检查日志 |
| 7.6 | 低于 `searchMinScore` 的结果不注入 | 检查日志 |
| 7.7 | 停用词列表可配置 | `/config get memory.episodic.stopwords` |
| 7.8 | 时间衰减因子生效（旧记忆分数更低） | 单元测试 |
| 7.9 | 会话优先检索生效（session 级结果优先） | 单元测试 |

## 七、预期收益

| 指标 | 改前 | 改后预期 |
|---|---|---|
| 短查询（≤3字）误检索率 | ~100% | 0%（直接跳过） |
| 不相关历史注入率 | 高 | <10%（阈值过滤） |
| 当前会话记忆命中率 | 随机 | 优先命中 |
| 旧记忆干扰 | 无差别 | 7 天后衰减至 37% |
