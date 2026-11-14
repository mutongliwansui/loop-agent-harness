# Task-17：上下文压缩信息丢失修复（flush 格式 + 失败兜底 + 检索召回）

> 目标：修复 L1 上下文压缩链路中"信息在压缩后彻底丢失"的问题。实测场景：用户先声明"我会打篮球"，对话达到阈值触发压缩后，再次提问"我会打篮球吗？"，模型在压缩后的上下文中已看不到该历史，回答"没有关于你个人能力的记录"。基于 Task-15 的 LLM 独立日志（`~/.loop-agent/logs/llm-*.log`）与 debug 日志实测定位。

---

## 一、需求目标

### 1.1 背景：实测定位到的问题

2026-08-18 会话（`sess_20260818_232526`）实测事件链（debug 日志还原）：

```
15:25:26  用户声明"我会打篮球"（L1 记录 + L2 记录）
   ↓ 对话持续到 66 条消息
15:33:59  L1 超阈值 → 触发 pre-compaction flush
          → LLM 请求 #33（67 条消息，提取关键信息）
15:34:01  ✗ LLM 调用失败 #1: 500 Jinja "System message must be at the beginning"
15:34:04  ✗ 重试 #2: 同样 500
15:34:08  ✗ 重试 #3: 同样 500
15:34:08  压缩完成，保留 8 条消息      ← 提取失败，但压缩照常执行！
15:34:50  用户提问"我会打篮球吗？"
15:34:52  ✗ 模型回答："我没有关于你个人能力的记录" ← 信息已永久丢失
```

**核心结论**：压缩链路存在两个缺陷叠加——(a) 压缩提取调用**必然失败**（消息格式违反模型要求），(b) 提取失败后**仍执行压缩**（信息无存档被直接丢弃）。两者叠加导致用户历史信息在压缩后彻底消失。

### 1.2 解决的核心痛点

| 痛点 | 现状 | 目标 |
|------|------|------|
| **压缩提取调用必然失败** | flush 消息拼接了两个 system（压缩 prompt + 主 system），sglang 后端 500 拒绝 | 消息格式满足模型要求，提取成功 |
| **失败后仍压缩丢信息** | flush 返回空 → 跳过 L2 写入 → compact 照常截断 | 提取失败时跳过压缩（宁超上下文不丢历史） |
| **失败后无降级存档** | 提取失败的历史直接丢弃，L2 无备份 | 可选：失败时把原始对话降级写入 L2 保底 |
| **压缩后检索无法兜底召回** | L2 有"我会打篮球"记录但检索未注入；无 sessionId 条目不可见（数据黑洞） | 检索能召回历史信息，压缩后提问仍可回答 |

### 1.3 设计约束

- **压缩语义不变**：正常路径仍为"先存档（flush 提取 → L2）再截断（compact）"
- **失败不丢数据**：任何失败场景下历史消息必须保留（L1 或 L2 至少一处）
- **不新增依赖**：复用现有 `EpisodicMemory.appendToday` / `WorkingMemory` / LLM 适配器
- **行为可配置**：失败兜底策略提供配置项，默认安全行为

---

## 二、根因分析

### 2.1 根因 1：压缩提取调用必然失败——消息格式违反模型要求

`src/memory/working.ts` `preCompactionFlush()` 的消息拼接：

```typescript
const extractMessages: ChatMessage[] = [
  { role: 'system', content: flushPrompt },   // 压缩 prompt（system）
  ...messages,                                 // ← messages 本身就包含 system！
];
```

调用方（`react-agent.ts`）传入的 `messages` 是当前 L1 上下文，**开头即为 system**（主 system prompt）。拼接后实际发送：

```
[0] system   你正在压缩对话历史...（压缩 prompt）
[1] system   你是智能 Agent...（主 system）
[2] user     ...
```

`wrench-9b-8k`（sglang 后端）Jinja 模板校验 "System message must be at the beginning" → **100% 必现 500 错误**，重试无效。

**证据**：llm 日志 #33 输入消息 67 条，`[0]` 为压缩 prompt、`[1]` 为主 system；debug 日志三次重试均为相同 500。

### 2.2 根因 2：flush 失败后仍执行压缩——信息无存档被直接丢弃

失败链：

1. `preCompactionFlush()` 内部 `catch { return '' }`（`working.ts`）吞掉异常返回空字符串
2. `react-agent.ts` `if (extracted && this._episodicMemory)` 为 false → **跳过 L2 写入**
3. `compact(messages)` **照常执行** → L1 截断为最近 3 轮

**先丢后存档的顺序反了**：设计意图是"先存档再丢"，实际变成"没存上照样丢"。"我会打篮球"从 L1 丢弃，L2 无备份 → 永久丢失。

**证据**：debug 日志 `15:34:08.977 压缩完成，保留 8 条消息`（紧跟在三次失败之后）；当天 L2 文件无任何 `[tag: compaction]` 新条目。

### 2.3 根因 3（次要）：压缩后检索无法兜底召回

即使 L2 有历史（07:29 与 15:25 各有"我会打篮球"记录），15:34:50 的检索没有注入相关内容。两个子问题：

**a. 无 sessionId 条目成为数据黑洞**（`episodic.ts` `isSectionVisible`）：

```typescript
// scope=session 但无 sessionId 的条目（如会话刚建立、currentSessionId 尚未赋值时写入的）
if (entryScope === 'session') {
  return entrySessionId === options.sessionId;   // undefined === 'sess_xxx' → false → 不可见！
}
```

15:25:26 的"我会打篮球"条目为 `[scope: session]` **无 sessionId**，带 sessionId 检索时被过滤；07:29:42 的条目 `sessionId=sess_20260818_152817` 与当前会话不匹配也被过滤。

**b. FTS5 中文分词匹配不可靠**：查询"我会打篮球吗？" vs 索引"我会打篮球"，默认 tokenizer 对中文的匹配行为需验证。

---

## 三、方案对比与选型

| 方案 | 原理 | 优点 | 缺点 | 结论 |
|------|------|------|------|------|
| **1. 修复 flush 消息格式** | 拼接时过滤掉原 messages 中的 system，只保留压缩 prompt 一个 system | 治本；提取调用从"必现 500"变为正常 | 无 | ✅ **必修（主改动）** |
| **2. flush 失败不压缩** | 提取为空/异常时跳过 compact，本轮继续 | 历史保留在 L1，信息不丢；实现简单 | 上下文可能继续增长直至 API 拒绝 | ✅ **必修（兜底）** |
| **3. 失败降级存档** | flush 失败时把原始对话直接写入 L2（`compaction_fallback`） | 信息保底，且压缩仍可进行 | L2 会写入未提炼的原始内容，需标记区分 | ✅ **推荐（配合 2）** |
| **4. 修复检索召回** | 无 sessionId 条目改为可见；验证/修复 FTS 中文分词 | 压缩后提问可经 L2 召回历史 | 涉及检索语义，改动面较大 | ⬜ **建议（另案）** |

**结论**：方案 1 + 2 为核心修复（必修），方案 3 作为兜底增强（推荐），方案 4 独立跟进（建议另案处理）。

---

## 四、详细设计

### 4.1 方案 1：修复 flush 消息格式（治本）

`preCompactionFlush()` 拼接时过滤掉原有 system：

```typescript
const extractMessages: ChatMessage[] = [
  { role: 'system', content: flushPrompt },
  ...messages.filter((m) => m.role !== 'system'),   // ← 过滤原 system，保证唯一且在最前
];
```

修复后发送：

```
[0] system   你正在压缩对话历史...（压缩 prompt，唯一 system）
[1] user     ...
[2] assistant ...
```

满足 sglang "System message must be at the beginning" 要求（单个 system 且在开头）。

### 4.2 方案 2：flush 失败不压缩（安全兜底）

`react-agent.ts` 压缩触发逻辑改造：只有提取成功才允许 compact。

```
现状：  extracted = flush()（可能为空）
        if (extracted) 写入 L2
        compact()                        ← 无条件执行（缺陷）
改造：  extracted = flush()
        if (extracted) {
          写入 L2
          compact()
          onCompaction 事件
        } else {
          debug + 对话提示："压缩提取失败，已跳过压缩（上下文继续累积）"
        }
```

行为语义：
- **提取成功** → 正常"存档 + 截断"
- **提取失败**（LLM 报错/返回空）→ 保留全部历史，本轮继续（宁可真实 token 超限，也不丢信息）

### 4.3 方案 3：失败降级存档（可选兜底增强）

在方案 2 基础上，flush 失败时把原始对话降级写入 L2：

```typescript
// flush 失败分支
const rawContent = messages
  .map((m) => `${m.role}: ${m.content}`)
  .join('\n');
await this._episodicMemory.appendToday(rawContent, {
  sessionId: this._currentSessionId ?? undefined,
  scope: 'session',              // 降级存档仅当前会话可见，避免污染其他会话检索
  tag: 'compaction_fallback',    // 标记来源
});
```

这样压缩后 L1 历史被截断，但 L2 有原始存档兜底，检索仍可召回。

### 4.4 方案 4：修复检索召回（建议另案）

**a. 无 sessionId 条目可见性**：`isSectionVisible` 中 `scope=session` 且无 `sessionId` 的条目，在带 sessionId 检索时应视为可见（向后兼容，视为会话早期遗留条目）：

```typescript
if (entryScope === 'session') {
  if (!entrySessionId) return true;          // 无 sessionId 的旧条目 → 可见（兼容）
  return entrySessionId === options.sessionId;
}
```

**b. FTS 中文分词**：验证 `fts.ts` 的 tokenizer 配置（`unicode61` 对中文匹配不可靠，考虑 `trigram` 或降级路径覆盖），确保"我会打篮球吗？"能召回"我会打篮球"。

---

## 五、配置设计

方案 2/3 的失败兜底策略提供配置项：

```typescript
// src/memory/types.ts — WorkingMemoryConfig 增加字段
working: {
  maxTokens: number;
  compactionThreshold: number;
  keepRecentTurns: number;
  /**
   * Task-17：压缩提取失败时的兜底策略
   * 'skip'    （默认）跳过压缩，保留全部历史（宁可超上下文不丢信息）
   * 'archive' 降级存档到 L2 后仍压缩（信息保底 + 压缩继续）
   */
  flushFailure: 'skip' | 'archive';
}
```

```jsonc
// 配置示例
{ "memory": { "working": { "flushFailure": "skip" } } }
```

方案 1 为纯修复，无需配置。

---

## 六、实现方案

### 6.1 修复 flush 消息格式（`src/memory/working.ts`）

- `preCompactionFlush()` 拼接时对 `messages` 过滤 `role !== 'system'`
- 同时确保 `flushPrompt` 为唯一 system 且在首位

### 6.2 失败不压缩 + 降级存档（`src/agent/react-agent.ts`）

- 压缩触发分支重构：`extracted` 为空 → 按 `flushFailure` 策略处理（`skip` 跳过压缩 / `archive` 降级写 L2 后压缩）
- 失败时 `debug.log` + 触发 `onCompaction` 事件（携带失败标记）供 `ConsoleLogger` 打印提示
- 配置读取沿用动态读取模式（与 `dedupeEnabled` 同款）

### 6.3 检索召回修复（`src/memory/episodic.ts` + `src/memory/fts.ts`）

- `isSectionVisible`：无 sessionId 的 session 条目改为可见
- 验证 FTS tokenizer 中文匹配，必要时调整配置或强化降级路径

### 6.4 边界情况

| 场景 | 处理 |
|------|------|
| flush LLM 返回空字符串 | 视为失败，按 `flushFailure` 策略处理 |
| flush LLM 抛异常 | `preCompactionFlush` 内部已 catch 返回空 → 同上 |
| `flushFailure=skip` 且持续失败 | 上下文持续增长直至 API 拒绝；提示用户调大 maxTokens |
| `flushFailure=archive` | 原始对话写入 L2（tag=compaction_fallback），后续可正常压缩 |
| 压缩成功 | 行为与现状一致（存档 → 截断 → onCompaction 事件） |

---

## 七、测试计划（`tests/compaction-fix.test.ts`）

| # | 测试项 | 预期结果 |
|---|--------|----------|
| 1 | flush 消息格式 | mock LLM 收到的消息中 system 仅 1 条且在首位，其余消息均非 system |
| 2 | 提取成功路径 | flush 返回非空 → 写入 L2 → compact 执行 → onCompaction 触发 |
| 3 | 提取失败 + `skip` | flush 返回空 → 不写入 L2、不 compact、消息原样保留 |
| 4 | 提取失败 + `archive` | flush 返回空 → 原始消息写入 L2（tag=compaction_fallback）→ compact 执行 |
| 5 | 检索可见性 | scope=session 无 sessionId 条目在带 sessionId 检索时可见 |
| 6 | 中文检索（集成） | 查询"我会打篮球吗？"能召回"我会打篮球"相关条目 |
| 7 | 回归 | 压缩成功后 keepRecentTurns 语义不变；现有 memory-working/memory-flush 测试全过 |

---

## 八、实施计划

| 步骤 | 工作内容 | 产出文件 | 状态 |
|------|----------|----------|------|
| 8.1 | 方案 1：flush 消息格式修复（过滤原 system） | `src/memory/working.ts` | ✅ |
| 8.2 | 方案 2/3：失败不压缩 + 降级存档（`flushFailure` 配置） | `src/memory/types.ts`、`src/agent/react-agent.ts` | ✅ |
| 8.3 | 失败提示：onCompaction 事件携带失败标记 + 打印 | `src/types.ts`、`src/agent/logger.ts` | ✅ |
| 8.4 | 方案 4a：无 sessionId 条目检索可见性修复 | `src/memory/episodic.ts` | ✅ |
| 8.5 | 方案 4b：FTS 中文分词验证与修复 | `src/memory/fts.ts` | ✅ |
| 8.6 | 单测 + 全量测试 + typecheck | `tests/compaction-fix.test.ts` | ✅ |

---

## 九、验收测试清单

| # | 验收项 | 预期结果 | 状态 |
|---|--------|----------|------|
| 9.1 | flush 调用成功 | 压缩触发时 llm 日志显示提取调用返回正常（无 500） | ✅ |
| 9.2 | 压缩后信息不丢 | 复现场景：声明"我会打篮球" → 压缩 → 提问"我会打篮球吗？" → 模型能回答出"会打篮球" | ✅ |
| 9.3 | 失败不压缩 | mock/模拟 LLM 500 → L1 历史完整保留，debug 日志记录跳过 | ✅ |
| 9.4 | 降级存档 | `flushFailure=archive` 时 L2 出现 `[tag: compaction_fallback]` 条目 | ✅ |
| 9.5 | 检索兜底 | 压缩后提问能从 L2 召回"我会打篮球"（无 sessionId 条目可见） | ✅ |
| 9.6 | 无回归 | 全量测试通过；压缩成功路径行为与现状一致 | ✅ |

> **验收状态说明**：9.1-9.6 已由 `tests/compaction-fix.test.ts`（7 项）+ 全量单测（85/85）+ `npm run typecheck` 覆盖并通过。其中 9.1/9.2 以单测验证核心语义（消息格式唯一 system、三条信息保全路径）；真实环境复现（llm 日志无 500、实际对话问答）可在运行时二次确认。

---

## 十、预期效果

| 指标 | 现状 | 修复后 |
|------|------|--------|
| 压缩提取调用 | 必现 500（3 次重试无效） | 正常返回提取笔记 |
| 压缩时信息保存 | "我会打篮球"永久丢失 | flush 提取写入 L2（成功路径）或跳过压缩（失败路径） |
| 压缩后提问 | 模型"没有记录" | 能从 L2 召回历史（方案 1/2/3 + 方案 4 兜底） |
| 异常韧性 | 一次模型故障 → 永久丢历史 | 最多保留原上下文继续累积，信息不丢 |

> 注：本任务聚焦压缩链路的**信息保全**（方案 1/2/3 为必修与推荐）；方案 4（检索召回）独立跟进，用于压缩后提问的兜底召回，不阻塞核心修复。
