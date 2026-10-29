# 🧠 记忆管理

> [⬅ 返回 README](../../../README.md)

基于 OpenClaw 风格的三层记忆架构（Tier Model），核心思想：**文件是真相源，索引只做加速；写读路径分离；晋升有闸门。** 记忆系统与会话持久化（Task-11）互补：会话持久化解决"恢复上次对话"，记忆管理解决"跨会话知识积累"。

### 三层架构

| 层级 | 存储形态 | 生命周期 | 自动进 context | 说明 |
|---|---|---|---|---|
| **L1 Working** | 内存 `_chatHistory` | 单次会话 | ✅ 始终在 | 超阈值自动压缩（默认 8000 token / 80% 阈值，保留最近 3 轮）：先让 LLM 提取关键笔记写 L2，再以 `[历史摘要]` 临时占位（`is_show=false` 标记，LLM 可见、写盘过滤）注入上下文；磁盘全量历史为唯一真源，内存压缩与磁盘恢复共用同一 `buildCompactedView` 生成器 |
| **L2 Episodic** | `{工作空间根}/memory/YYYY-MM-DD.md` | 永久存档 | ❌ 按需检索 | 按天分文件，工具调用结果自动记录，支持 `/memory search` 召回 |
| **L3 Curated** | `{工作空间根}/SOUL.md` / `USER.md` / `MEMORY.md` | 永久常驻 | ✅ 启动注入 | Agent 人格 / 用户画像 / 精炼事实，常驻 System Prompt |

> **多工作空间（serve 模式）**：记忆 kit 由每个空间的 WorkspaceRuntime 持有（按 workspaceId 隔离），随运行时 LRU 淘汰释放句柄；CLI 单空间模式即启动目录，行为不变。

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
- **落盘顺序即轨迹顺序**：L1 压缩只用 `is_compact` 标记区分「折叠进摘要」与「保留」，但**磁盘数组顺序始终等于本轮原始轨迹顺序**。单轮长任务按 token 预算截尾时，被「任务锚点 pin」保留下来的当前轮 user 消息仍排在其引发的那些消息之前，因此会话重载后不会出现「用户消息跑到自己那一整轮回答之后」。存量历史若已错乱无法无损还原（原始轨迹不落盘），可用 `node scripts/session-order-check.mjs` 做只读诊断

### 自动晋升（`--serve` / WebUI）

CLI 在退出时会跑一次 Dreaming；但 `--serve` 是常驻进程，「退出时晋升」对它不成立，因此服务侧补齐三条触发路径：

| 触发 | 时机 | 说明 |
| --- | --- | --- |
| **定时（主力）** | 按 `schedule.cron`（crontab 5 字段表达式，默认 `0 3 * * *` 即每天 03:00，**服务器本地时区**）触发 | 只处理「今天之前」的天；当天内容留到次日。**没有新增内容时不调用 LLM**（增量判定直接 return） |
| **关停兜底** | 收到 `Ctrl+C`（`SIGINT`）/`SIGTERM`/`SIGBREAK` | 遍历全部已装载工作空间串行晋升，受 `shutdownBudgetMs`（默认 30s）约束；**再按一次 Ctrl+C 立即退出** |
| **手动** | `POST /memory/dream` 或 WebUI「✦ 立即梳理」 | 与自动触发共用同一把进程内锁 |

#### cron 表达式

- **5 字段**：`分 时 日 月 周`（0-59 / 0-23 / 1-31 / 1-12 / 0-7，周中 0 与 7 都表示周日），**不支持 6 字段秒级**。
- **支持的语法**：`*`、列表 `,`、区间 `-`、步长 `/`；宏 `@yearly` `@monthly` `@weekly` `@daily` `@hourly`。
- **不支持的语法**：`L` / `W` / `#` / `?`（Quartz 扩展，标准 cron 语义下无意义）。
- **「日」与「周」同时受限时取并集**（vixie cron 语义）：`0 3 1 * 1` 表示「每月 1 号 **或** 每周一 03:00」。
- **热生效**：写 `cron` 后立即重排，**无需重启**；非法表达式直接拒绝（400），**不落盘、不打断现有排期**。
- **兼容**：`cron` 为空串时回落到旧固定间隔语义（`startupDelayMin` + `intervalHours`，两者已 deprecated）。

#### 规则与限制

- **互斥**：同一工作空间同一时刻只跑一次晋升；撞车时后来者直接跳过（手动端点回 `accepted:false`），不排队、不重复晋升。
- **不与对话抢资源**：定时轮遇到该空间有对话正在跑（in-flight）时本轮让位；关停兜底不受此限（此时已无新对话）。
- **补漏**：读取窗口按「距上次处理的天数 + 1」放大（上限 `maxDaysBack`，默认 30），避免停机多日后中间的天永久晋升不到。
- **错过补跑**：睡眠 / 系统时间回拨导致迟于触发点但在 `misfireGraceMin`（默认 60 分钟）宽限内 → 补跑一次并标 `catchup`；超出宽限 → 记一条「错过」记录但**不补跑**（避免开机就狂跑一轮）。
- **跨天与夏令时**：调度器按「本地墙钟分钟键」去重，且单次等待分片不超过 6 小时（规避 `setTimeout` 24.8 天上限）；因此 DST 回拨不重复触发、前拨不长时间漏触发。
- **可观测**：`GET /memory/status` 的 `dreaming` 字段（见 [HTTP API](./http-api.md)）给出 `cron` / `describe` / `nextRunAt` / `nextRunTimes` / `running` 等；WebUI 记忆页「自动晋升」卡片可直接编辑并即时预览未来触发时刻。
- **运行历史**：`{L2 目录}/.dreaming-runs.json` 环形保留最近 `historyLimit`（默认 20，`0` = 不留历史）条，记录时间 / 来源（定时·手动·关停）/ 结果 / 读取窗口 / 晋升·跳过·错误计数 / 耗时；与增量状态文件分离。
- **增量状态**：`{L2 目录}/.dreaming-state.json` 保存 `lastProcessedDay`（已整理到哪一天）与 `lastRunAt` / `lastSummary`（上次执行记录）。
- **关闭方式**：`memory.dreaming.schedule.enabled=false` 只停定时轮（关停兜底仍生效）；`memory.dreaming.onExit=false` 只停关停兜底；`memory.dreaming.enabled=false` 全停。
- **已知边界**：CLI 与 `--serve` 同时跑同一工作空间时无跨进程文件锁，靠 `lastProcessedDay` 幂等 + 去重归并兜底；Windows 下关闭控制台窗口可能拿不到清理时机（无优雅关停信号）。

### WebUI 记忆页（四标签页）

WebUI「记忆」页按数据维度重组为四个标签页（`#/memory?tab=<key>`，状态写入 hash，刷新/分享可还原）：

| 标签页 | 内容 | 数据源 |
| --- | --- | --- |
| **定时任务** | 自动晋升 cron 配置 + 触发记录（支持「全部空间 / 当前空间」范围切换）+ 分层状态概要 + Gate 晋升决策 | `GET /memory/status`、`GET /memory/dream/preview`、`GET /memory/dream/history?scope=all\|ws`、`DELETE /memory/dream/history` |
| **L2 情景** | 空间 → 会话 → 范围/标签三级筛选 + 天数窗口，按天分组折叠展示；条目头（会话 id / scope / tag）由前端解析 | `GET /memory/episodic?limit=<1-90>[&ws=<id>]` + `GET /memory/workspaces` |
| **L3 长期** | 全局共享（SOUL/USER，不随空间切换）与工作空间级（MEMORY）两栏；右上角可切换空间直读 | `GET /memory/curated[?ws=<id>]` |
| **检索** | L2 语义检索（当前空间） | `GET /memory/search?q=` |

配套端点：

- **`GET /memory/workspaces`**：聚合「有会话 ∪ 有记忆」的空间清单，返回 `{id, name, path, hasMemory, hasSession}[]`——会话侧来自 sessions 索引扫描，记忆侧来自 `{memoryDir}/*/` 目录扫描，仅有记忆的「孤儿空间」也会列出（供 L2/L3 空间下拉使用）。
- **`GET /memory/episodic` / `GET /memory/curated` 支持 `?ws=<id 或绝对路径>`**：按空间直读记忆（走 WorkspaceRuntime 路由，canonical 校验，未知空间 404）；缺省回落**缺省空间（最近使用）**——需求 20261027-004 起不再绑定启动目录。
- **`GET /memory/dream/history?scope=all|ws`**：`all` 时文件扫描聚合全部空间的 `.dreaming-runs.json`（不要求空间已装载），每条附 `workspaceId/workspaceName/workspacePath`；`ws`（缺省）= 缺省空间（最近使用）单文件读取。
- **`DELETE /memory/dream/history?scope=all|ws[&ws=<id>]`**：清空跟随筛选范围；`all` 时遍历清空各空间记录（文件保留、内容清空，保持幂等）。