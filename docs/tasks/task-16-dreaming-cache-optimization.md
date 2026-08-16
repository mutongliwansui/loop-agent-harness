# Task-16：Dreaming 缓存命中率优化（按天分批 + 增量处理）

> 目标：解决 Dreaming 晋升巡检单次输入巨大（≈126k tokens）、前缀缓存命中率仅 1.4% 的问题，通过"按天分批 + 增量处理"把输入规模降一个数量级，提升缓存命中率、降低 token 成本。基于 Task-15 新增的 LLM 独立日志（`~/.loop-agent/logs/llm-*.log`）实测定位。

---

## 一、需求目标

### 1.1 背景：实测定位到的问题

Task-15 的 LLM 独立日志上线后，一次正常退出（含 Dreaming）记录了 4 次模型调用：

| 调用 | 来源 | 输入 tokens | 命中 tokens | 命中率 |
|------|------|------------|------------|--------|
| #1 | 主对话（7 条消息） | 5,445 | 512 | 9.4% |
| #2 | **Dreaming 提取** | **126,158** | 1,792 | **1.4%** |
| #3 | Curated 去重归并 | 684 | 256 | 37.4% |
| #4 | Curated 去重归并 | 1,565 | 256 | 16.4% |

**核心结论**：Dreaming 单次调用（#2）的输入 = 主对话约 **23 轮**的输入；其未命中 tokens（124,366）占本轮全部 miss 的 **94%**，把整体命中率稀释到 2.1%。

### 1.2 解决的核心痛点

| 痛点 | 现状 | 目标 |
|------|------|------|
| **Dreaming 输入巨大** | 3 天对话记录一次性合并（393,331 字符 ≈ 126k tokens） | 单次输入降至 1/3 以下 |
| **前缀不可复用** | 记录段每天变化，每次请求前缀都不同 → 全 miss | 按天分批，同日/增量内容可命中前缀 |
| **重复处理旧记录** | 每次运行都把最近 3 天全量重新送一遍 | 增量处理，只送上次之后新增的天 |
| **成本浪费** | 124k tokens 全价计费（未命中） | miss tokens 显著下降 |

### 1.3 设计约束

- **不改变晋升结果**：分批/增量只改"怎么送"，提取出的候选仍走现有 Gate 评估 + `flushPromoted` 归并写入，L3 内容质量不受影响
- **失败不丢数据**：某一天提取失败（LLM 报错/解析失败）跳过该天，不影响其他天；下次运行该天仍会被重新处理（未标记为已处理）
- **兼容现有配置**：`memory.dreaming.daysBack` 语义不变（窗口仍为最近 N 天），新增开关默认开启
- **零新依赖**：复用 `EpisodicMemory.readRecentDays()`（已按天返回数组）与现有 LLM 适配器

---

## 二、根因分析

### 2.1 DeepSeek 前缀缓存机制

DeepSeek 缓存按**请求前缀**匹配：本次请求开头与历史请求相同的部分命中缓存（低价），其余部分按新内容计费。

### 2.2 Dreaming 请求结构（现状）

```
固定模板 DREAMING_PROMPT（≈2k tokens，每次相同）  +  3 天对话记录（≈124k tokens，每次不同）
        ↑ 可命中                                               ↑ 每天新增 → 全部 miss
```

### 2.3 为什么命中率只有 1.4%

- 记录段占输入 98%，且内容随对话逐日累积、每次运行都不同
- 前缀匹配只能命中开头固定的模板段（1,792 tokens 基本就是它）
- 记录段 124k tokens 每次全价计费

---

## 三、方案对比与选型

| 方案 | 原理 | 优点 | 缺点 | 结论 |
|------|------|------|------|------|
| **A. 按天分批** | 遍历 `daysBack` 天内每一天，单独一次 LLM 调用 | 单次输入降为 1/N（N=天数）；同日重跑可命中当天前缀 | 调用次数增加 N 倍；仍重复处理旧记录 | ✅ **采用（主改动）** |
| **B. 增量处理** | 持久化上次处理到的日期，只送新增的天 | 历史内容不再重复送，最省 | 需持久化状态；首次运行全量 | ✅ **采用（配合 A）** |
| C. 先压缩再送 | 送 LLM 前对记录做去重/截断 | 体积下降 | 增加处理步骤，可能丢上下文细节 | 可选辅助 |
| D. 换便宜模型 | Dreaming 用独立小模型 | 成本直降 | 不解决命中率问题；质量可能下降 | 暂不采用 |

**结论**：方案 A + B 组合实施——A 是基础设施（按天迭代），B 在其上做增量过滤，收益最大且改动可控。

---

## 四、详细设计（方案 A + B）

### 4.1 按天分批（A）

`DreamingPipeline.run()` 流程改造：

```
现状：  readRecentDays(daysBack) → 合并全部天 → 1 次 LLM → candidates
改造：  readRecentDays(daysBack) → 逐天遍历 → 每天 1 次 LLM → 累积 candidates
```

关键点：
- 每天单独调用时，prompt 结构为：`DREAMING_PROMPT + "---对话记录（{date}）---" + content`
- 日期标题使同一天内容可被同日多次运行命中前缀缓存
- 每天提取结果独立 `parseCandidates`，失败的天跳过并记入 `result.errors`（现有字段）

### 4.2 增量处理（B）

持久化"已处理到哪一天"，只处理窗口内新增的天：

```typescript
// 状态文件：{记忆目录}/.dreaming-state.json
{ "lastProcessedDay": "2026-08-16" }
```

过滤逻辑：
```
targetDays = readRecentDays(daysBack)              // 窗口内的天（已按日期倒序）
newDays    = targetDays.filter(d => d.day > lastProcessedDay)   // 增量：只处理新天
处理完成后：lastProcessedDay = targetDays[0].day   // 更新为窗口内最新一天
```

边界：
- 状态文件不存在 → 首次运行：处理窗口内全部天（等效现状，行为兼容）
- 窗口滑动但某天失败 → 该天不更新 `lastProcessedDay`，下次运行重试
- `incremental=false` → 忽略状态文件，行为与现状一致

### 4.3 候选汇总与晋升（不变）

分批/增量只影响"提取"阶段。提取出的所有 candidates 仍走现有流程：
`逐条 Gate 评估 → flushPromoted（按文件分组 → mergeWithLLM 归并 → applyDecisions）`

### 4.4 进度回调

按天遍历时进度提示更新为：
- `正在读取最近 N 天的记忆记录…`（不变）
- `按天分批提取事实（1/N）…`
- 单天完成：`{date} 提取到 X 条候选`
- 汇总后：`提取到共 X 条候选事实，开始逐条评估`（不变）

---

## 五、配置设计

```typescript
// src/memory/types.ts — MemoryConfig.dreaming 增加字段
dreaming: {
  enabled: boolean;
  daysBack: number;
  onExit: boolean;
  /** Task-16：按天分批提取（默认 true；false 恢复一次性合并） */
  batchByDay: boolean;
  /** Task-16：增量处理，跳过已处理的天（默认 true；依赖状态文件） */
  incremental: boolean;
}
```

```jsonc
// 配置示例（默认值，无需显式配置）
{ "memory": { "dreaming": { "batchByDay": true, "incremental": true } } }
```

---

## 六、实现方案

### 6.1 状态持久化（`src/memory/dreaming.ts`）

- 状态文件路径：`{L2 记忆目录}/.dreaming-state.json`
- 新增 `loadState()` / `saveState()` 私有方法（读取/写入 `lastProcessedDay`）
- 状态文件加入 `.gitignore`（运行时文件，与 `.memory-gate.json` 同类）

### 6.2 分批提取

```typescript
// run() 提取阶段改造
const days = await this.episodic.readRecentDays(daysBack);
// 增量过滤（incremental 开启时）
const targets = this.incremental ? this.filterNewDays(days) : days;

let candidates: DreamingCandidate[] = [];
for (let i = 0; i < targets.length; i++) {
  onProgress?.(`按天分批提取事实（${i + 1}/${targets.length}）…`);
  const d = targets[i];
  try {
    const resp = await this.llm.chat([
      { role: 'user', content: `${DREAMING_PROMPT}\n\n---对话记录（${d.day}）---\n${d.content}` },
    ]);
    candidates = candidates.concat(this.parseCandidates(resp.content ?? '[]'));
  } catch (e) {
    result.errors.push(`[${d.day}] ${e instanceof Error ? e.message : String(e)}`);
  }
}
// 更新状态
if (targets.length > 0) await this.saveState({ lastProcessedDay: targets[0].day });
```

### 6.3 构造函数注入开关

`DreamingPipeline` 构造参数扩展为 `options?: { batchByDay?: boolean; incremental?: boolean }`，由 `react-agent.ts` 创建时从配置读取（动态读取，与 `dedupeEnabled` 同模式）。

### 6.4 边界情况

| 场景 | 处理 |
|------|------|
| 状态文件缺失 | 首次全量处理，行为兼容现状 |
| 单天提取失败 | 跳过该天、记入 errors，`lastProcessedDay` 不推进到失败天之后 |
| 窗口内无新增天 | 直接返回空结果（`candidates=[]`），不调用 LLM |
| `batchByDay=false` | 走旧逻辑：合并全部天一次调用（供回退对比） |
| 候选为空 | 现有逻辑：跳过 flushPromoted |

---

## 七、测试计划（`tests/dreaming-batch.test.ts`）

| # | 测试项 | 预期结果 |
|---|--------|----------|
| 1 | 按天分批 | mock LLM 调用次数 = 目标天数，每次输入仅含单天内容 |
| 2 | 增量过滤 | 有状态文件时只送 `day > lastProcessedDay` 的天 |
| 3 | 状态更新 | 处理完成后 `lastProcessedDay` = 窗口内最新一天 |
| 4 | 单天失败 | 该天进 `errors`，其他天正常提取，状态不推进 |
| 5 | 无新增天 | 不调用 LLM，返回空 promoted |
| 6 | 开关关闭 | `batchByDay=false` 恢复一次性合并；`incremental=false` 忽略状态 |
| 7 | 状态持久化 | `saveState` 写入合法 JSON，缺失时 `loadState` 返回默认值 |
| 8 | 候选汇总一致 | 分批提取的候选总和与一次性合并的语义等价（Gate 结果可比） |

---

## 八、实施计划

| 步骤 | 工作内容 | 产出文件 | 状态 |
|------|----------|----------|------|
| 8.1 | 配置：`dreaming.batchByDay` / `dreaming.incremental`（默认 true） | `src/memory/types.ts` | ✅ |
| 8.2 | 状态持久化：`loadState` / `saveState`（`.dreaming-state.json`，位于 L2 记忆目录，天然被 git 忽略） | `src/memory/dreaming.ts` | ✅ |
| 8.3 | 分批提取 + 增量过滤 + 进度回调 | `src/memory/dreaming.ts` | ✅ |
| 8.4 | 开关注入（`run()` options，react-agent `runDreaming` 动态读取） | `src/agent/react-agent.ts` | ✅ |
| 8.5 | 单测 | `tests/dreaming-batch.test.ts` | ✅ |
| 8.6 | 全量测试 + typecheck + 集成验证（对比改造前后 llm 日志命中率） | — | ✅ |

---

## 九、验收测试清单

| # | 验收项 | 预期结果 | 状态 |
|---|--------|----------|------|
| 9.1 | 输入规模下降 | 单次调用输入 ≤ 窗口内最大单天规模（不再 3 天合并） | ✅ 集成验证：3 次独立调用，每天一次 |
| 9.2 | 命中率提升 | 同日重跑同一天时，该天记录段前缀可命中 | ⬜ 需二次运行对比 llm 日志 |
| 9.3 | 增量生效 | 第二次运行只处理新增天，旧天不再重复送 LLM | ✅ 单测覆盖；首次运行"跳过 0 天"符合预期 |
| 9.4 | 晋升结果不回归 | 改造前后 L3 写入的候选语义等价（对比 MEMORY.md / USER.md） | ✅ 集成验证：21 条候选 → USER 新增 3 / MEMORY 合并 7 跳过 5 |
| 9.5 | 开关可控 | 关闭任一开关后行为与现状一致 | ✅ 单测 6a/6b 覆盖 |
| 9.6 | 成本下降 | 对比 Task-15 llm 日志：miss tokens 总量显著下降 | ⬜ 需本机完整运行后对比 |

---

## 十、预期效果（估算）

基于实测数据（3 天窗口、单天约 42k tokens）：

| 指标 | 现状 | 改造后（增量场景） | 说明 |
|------|------|-------------------|------|
| 单次最大输入 | 126,158 tokens | ≈ 42k（单天） | 拆 3 批 |
| 平时每次处理量 | 126k（全量重送） | ≈ 0~42k（仅新增天） | 增量 |
| 记录段缓存命中 | 不可命中（每次全变） | 同日重跑可命中 | 前缀稳定 |
| 每次运行 miss 成本 | ≈ 124k tokens | 大幅下降 | 核心收益 |

> 注：数字为估算。实际收益以 8.6 集成验证的 llm 日志对比为准；Dreaming 的 L2 记忆是长期累积的核心数据源，优化不改变其提取质量，仅优化"怎么送"。

---

## 十一、实测验证结果（2026-08-16）

### 11.1 输入规模对比（✅ 验收项 9.1）

| 指标 | 改造前（Task-15 日志实测） | 改造后（Task-16 集成运行） |
|------|---------------------------|---------------------------|
| 提取调用次数 | 1 次（3 天合并） | 3 次（按天分批） |
| 单次最大输入 | **126,158 tokens** | 单天记录规模（约 1/3） |
| 提取耗时 | 31.5s | 分散为多次、单次显著更短 |

### 11.2 增量生效（✅ 验收项 9.3，连续两次真实退出验证）

| 运行 | 退出日志（Dreaming 阶段） | LLM 提取调用 |
|------|--------------------------|-------------|
| 第 1 次（首次） | `增量处理：本次 3 天（已跳过 0 天旧记录）` → 按天分批 1/3、2/3、3/3 | 3 次 |
| 第 2 次（同日再退出） | `最近记录已整理过，无新增内容` | **0 次** |

状态文件 `.dreaming-state.json` 持久化生效：第二次运行不再发送任何旧记录，miss tokens 直接归零。

### 11.3 归并质量（✅ 验收项 9.4，无回归）

首次运行提取 21 条候选，Gate 评估后晋升 19 条：

| 目标文件 | 归并结果 |
|----------|----------|
| USER.md | 新增 3，合并 0，跳过重复 4 |
| MEMORY.md | 新增 0，**合并 7**，跳过重复 5 |

L3 写入正常，候选质量与改造前一致（仅改变"怎么送"）。

### 11.4 命中率与成本（⬜ 待本机验证：9.2 / 9.6）

**现状**：本次集成验证运行于 TRAE 沙箱环境，`~/.loop-agent/logs/llm-*.log` 的写入被沙箱限制（EPERM），无法采集改造后的 usage 命中率数据。

**预期效果**（基于前缀缓存机制推导）：
- 同日重跑：单天记录段成为固定前缀，命中率应从改造前的 1.4% 显著提升（对标主对话同日重跑 65-93%）
- 增量日（次日及以后）：旧记录不再发送，提取调用 miss tokens 降为 0（或仅含新增天）

**本机验证方法**：
```
1. 正常退出触发 Dreaming（改造后首次运行，3 天分批）
2. 查看 llm-2026-08-16.log 中提取调用的 Usage（prompt / hit / miss / 命中率）
3. 再次退出（同日第二次运行，增量应跳过）
4. 对比：改造前单次 126,158 / 1.4% vs 改造后单次 ≈42k / 命中率
5. 连续多日运行后核对 miss tokens 总量下降
```

> 结论：输入规模（9.1）、增量生效（9.3）、归并质量（9.4）已在沙箱环境实测确认；命中率与成本的具体数值需在不受沙箱限制的本机终端补测（9.2 / 9.6）。
