# Task-15：每轮迭代 Token / 缓存 / 上下文统计输出

> 目标：每次 LLM 迭代完成后打印当前上下文占用、本轮模型缓存命中率、输入/输出 token 数；会话结束后打印累积汇总。数据全部来自现有 `LLMResponse.usage` 与 `WorkingMemory` 估算，零新依赖。

---

## 一、需求目标

### 1.1 解决的核心痛点

| 痛点 | 现状 | 目标 |
|------|------|------|
| **上下文占用不可见** | 不知道当前上下文离压缩阈值（默认 6400/8000）还有多远 | 每轮打印上下文 token 与占比 |
| **Token 成本不可见** | 输入/输出 token 仅在 debug 日志（默认关闭）可见 | 每轮打印输入/输出 token 数 |
| **缓存命中率不可见** | DeepSeek V4 等模型支持前缀缓存（成本与命中率强相关），但仅 debug 汇总 | 每轮打印缓存命中率 |
| **调优无依据** | 无法判断 `maxTokens`/`compactionThreshold` 是否合理 | 会话结束打印累积汇总（总 token、平均缓存率、上下文峰值） |

### 1.2 设计约束

- **不影响主流程**：`usage` 缺失或统计出错时静默降级（显示 `N/A` 或 fallback 估算），绝不抛错
- **单行紧凑**：每轮一行，不打断 Thought 流式输出
- **独立开关**：新增 `agent.showTokenStats`（默认 `true`），与 `agent.verbose` 解耦——`verbose=false` 静默模式仍可保留 token 统计
- **零新依赖**：数据全部来自现有 `LLMResponse.usage` + `WorkingMemory.estimateTokens()`
- **复用现有机制**：事件走 `AgentEvents` 扩展（参考 langchain callbacks 设计），渲染由 `ConsoleLogger` 完成

---

## 二、数据来源与定义

| 字段 | 来源 | 说明 |
|------|------|------|
| 输入 token | `usage.prompt_tokens` | 本轮实际发给模型的输入 token 数（含缓存命中部分） |
| 缓存命中 token | `usage.prompt_cache_hit_tokens` | 命中前缀缓存的 token 数（部分模型不返回 → 显示 N/A） |
| 缓存未命中 token | `usage.prompt_cache_miss_tokens` | 需重新计算的 token 数 |
| 输出 token | `usage.completion_tokens` | 本轮模型输出 token 数 |
| 总 token | `usage.total_tokens` | 本轮总 token 数 |
| **上下文占用** | 优先 `usage.prompt_tokens`（模型实际输入，最准确）；缺失时 fallback `WorkingMemory.estimateTokens(messages)` | 当前上下文体积 |
| 上下文上限 | `cfg.memory.working.maxTokens`（默认 8000） | L1 压缩上限 |
| 压缩阈值 | `maxTokens * compactionThreshold`（默认 6400） | 超过后触发 pre-compaction flush |

**缓存命中率** = `prompt_cache_hit_tokens / prompt_tokens`（`prompt_tokens` 为 0 或缓存字段缺失时显示 `N/A`）。

---

## 三、输出格式设计（单行紧凑，已确认）

### 3.1 每轮统计（LLM 调用完成后立即打印）

```
[迭代 2/5] 上下文 3214/8000 (40%) | 输入 2588 | 输出 412 | 缓存 72.3% | 1.2s
```

- 上下文百分比 = `contextTokens / maxTokens`
- 缓存百分比 = `cacheHit / prompt`；无缓存字段显示 `缓存 N/A`
- 上下文接近（≥80% 阈值）或超过压缩阈值时，`上下文` 段以警告色 + `⚠` 提示
- 末尾耗时：本轮 LLM 调用耗时（秒，1 位小数）

### 3.2 会话结束汇总（onEnd 前打印一次）

```
[统计汇总] 3 轮 | 总输入 7842 | 总输出 1230 | 总 token 9072 | 平均缓存命中 68.5% | 上下文峰值 4500/8000 (56%)
```

- 平均缓存命中 = 累计 `hit / prompt`
- 上下文峰值 = 各轮上下文 token 最大值

---

## 四、配置设计

```typescript
// src/config/schema.ts — AgentBehaviorConfig 增加字段
export interface AgentBehaviorConfig {
  verbose: boolean;
  debug: boolean;
  systemPrompt: string | null;
  /** Task-15：是否打印每轮 token/缓存/上下文统计（默认 true，独立于 verbose） */
  showTokenStats: boolean;
}
```

```jsonc
// .loop-agent/.agent-config.json 配置示例
{ "agent": { "showTokenStats": false } }   // 关闭统计输出
```

---

## 五、实现方案

### 5.1 类型定义（`src/types.ts`）

```typescript
/** 单轮 LLM 调用统计（Task-15） */
export interface LLMStats {
  iteration: number;            // 0-based 轮次
  contextTokens: number;        // 本轮上下文（优先 usage.prompt_tokens，fallback 估算）
  contextMaxTokens: number;     // L1 压缩上限（maxTokens）
  contextThreshold: number;     // 压缩阈值（maxTokens * compactionThreshold）
  promptTokens: number;         // 输入 token（缺失为 0）
  completionTokens: number;     // 输出 token（缺失为 0）
  totalTokens: number;          // 本轮总 token
  cacheHitTokens?: number;      // 缓存命中 token（可选）
  cacheHitRate?: number;        // 缓存命中率 0-1（无法计算时为 undefined）
  elapsedMs: number;            // 本轮 LLM 调用耗时（毫秒）
}

/** 会话累积汇总（Task-15） */
export interface LLMStatsSummary {
  iterations: number;
  totalPrompt: number;
  totalCompletion: number;
  totalTokens: number;
  totalCacheHit: number;
  avgCacheHitRate?: number;     // 0-1，全部命中时
  peakContextTokens: number;
  peakContextMaxTokens: number;
}

// AgentEvents 新增两个可选事件（所有钩子保持可选，未实现时跳过）
onLLMStats?(stats: LLMStats): void | Promise<void>;
onLLMStatsSummary?(summary: LLMStatsSummary): void | Promise<void>;
```

### 5.2 ConsoleLogger 渲染（`src/agent/logger.ts`）

- 构造函数改为 `new ConsoleLogger(verbose, showTokenStats)`
- 实现 `onLLMStats`：按 §3.1 格式打印单行（受 `showTokenStats` 控制，与 `verbose` 无关）
- 实现 `onLLMStatsSummary`：按 §3.2 格式打印汇总（仅当 `iterations > 0`）
- 缓存命中率 = `hit / prompt`，无缓存字段打印 `缓存 N/A`

### 5.3 迭代循环集成（`src/agent/react-agent.ts`）

在 `run()` 的迭代循环内，LLM 调用前后：

```typescript
// 1. streamLLM 前记录计时（startTs）
// 2. LLM 返回后（onLLMEnd 之后）计算统计：
const stats: LLMStats = {
  iteration: i,
  contextTokens: resp.usage?.prompt_tokens ?? this._workingMemory?.estimateTokens(messages) ?? 0,
  contextMaxTokens: this._workingMemory?.getConfig().maxTokens ?? 0,
  contextThreshold: (this._workingMemory?.getConfig().maxTokens ?? 0)
    * (this._workingMemory?.getConfig().compactionThreshold ?? 0),
  promptTokens: resp.usage?.prompt_tokens ?? 0,
  completionTokens: resp.usage?.completion_tokens ?? 0,
  totalTokens: resp.usage?.total_tokens ?? 0,
  cacheHitTokens: resp.usage?.prompt_cache_hit_tokens,
  cacheHitRate: resp.usage?.prompt_tokens
    ? (resp.usage.prompt_cache_hit_tokens ?? 0) / resp.usage.prompt_tokens
    : undefined,
  elapsedMs: Date.now() - startTs,
};
await safeEvents.onLLMStats(stats);
```

循环结束后、`onEnd` 之前，从 `usageHistory` 聚合汇总并触发 `onLLMStatsSummary`。

### 5.4 事件接线

`run()` 中 `composeEvents([new ConsoleLogger(verbose, cfg.agent.showTokenStats), ...])`。

### 5.5 边界情况

- `usage` 完全缺失（部分流式代理）→ `promptTokens=0`、上下文走估算、缓存 `N/A`、`elapsedMs` 仍有效
- 单轮会话（iterations=1）→ 汇总仍打印
- `showTokenStats=false` → 完全不输出，行为与现状一致
- 多监听器：统计事件对用户自定义 events 同样可达（`composeEvents` 已支持）

---

## 六、测试计划（`tests/llm-stats.test.ts`）

| # | 测试项 | 预期结果 |
|---|--------|----------|
| 1 | 统计计算（纯函数） | 缓存命中率、上下文 fallback 估算、summary 聚合正确 |
| 2 | `onLLMStats` 事件触发 | mock AgentEvents 捕获，字段与 `resp.usage`/`estimateTokens` 一致 |
| 3 | usage 缺失降级 | 上下文走估算、缓存 N/A、不抛错 |
| 4 | 缓存命中率边界 | prompt=0 或缓存字段缺失 → rate 为 undefined |
| 5 | ConsoleLogger 渲染 | 单行格式符合 §3.1；`showTokenStats=false` 不输出 |
| 6 | verbose 解耦 | `verbose=false` + `showTokenStats=true` 仍输出统计 |
| 7 | 累积汇总 | 多轮后 `onLLMStatsSummary` 字段正确（总 token/平均缓存/峰值） |

---

## 七、实施计划

| 步骤 | 工作内容 | 产出文件 | 状态 |
|------|----------|----------|------|
| 7.1 | 类型：`LLMStats` / `LLMStatsSummary` + `AgentEvents` 新事件 | `src/types.ts` | ✅ |
| 7.2 | 配置：`AgentBehaviorConfig.showTokenStats`（默认 true） | `src/config/schema.ts` | ✅ |
| 7.3 | ConsoleLogger：构造参数 + `onLLMStats` / `onLLMStatsSummary` 渲染 | `src/agent/logger.ts` | ✅ |
| 7.4 | 迭代循环：统计计算 + 事件触发 + 汇总聚合（`buildLLMStatsSummary` 纯函数） | `src/agent/react-agent.ts` / `src/agent/stats.ts` | ✅ |
| 7.5 | 测试：单测 + 渲染 + 开关 | `tests/llm-stats.test.ts` | ✅ |
| 7.6 | 全量测试 + typecheck + 文档状态更新 | — | ✅ |

## 八、验收测试清单

| # | 验收项 | 预期结果 | 状态 |
|---|--------|----------|------|
| 8.1 | 每轮上下文占用 | 每轮打印 `上下文 X/8000 (Y%)` | ✅ |
| 8.2 | 每轮缓存命中率 | 打印 `缓存 Z%`（无缓存字段显示 N/A） | ✅ |
| 8.3 | 每轮输入/输出 token | 打印 `输入 A | 输出 B` | ✅ |
| 8.4 | 会话累积汇总 | 结束后打印总 token/平均缓存率/上下文峰值 | ✅ |
| 8.5 | 开关独立 | `showTokenStats=false` 关闭；`verbose=false` 不影响统计 | ✅ |
| 8.6 | 静默降级 | usage 缺失不抛错、显示 N/A/估算 | ✅ |

## 九、实际运行效果（真实 LLM 集成测试输出）

```
[迭代 1/200] 上下文 1407 | 输入 1407 | 输出 153 | 缓存 91.0% | 1.2s
[迭代 2/200] 上下文 1824 | 输入 1824 | 输出 109 | 缓存 84.2% | 1.1s
[迭代 3/200] 上下文 2475 | 输入 2475 | 输出 563 | 缓存 77.6% | 4.6s
[统计汇总] 3 轮 | 总输入 5706 | 总输出 825 | 总 token 6531 | 平均缓存命中 83.0% | 上下文峰值 2475
```

> 注：集成测试未初始化记忆系统（`maxTokens=0`），故上下文只显示绝对值；启用记忆后显示 `X/8000 (Y%)` 比例，达到压缩阈值（6400）时黄色 ⚠ 警示。
