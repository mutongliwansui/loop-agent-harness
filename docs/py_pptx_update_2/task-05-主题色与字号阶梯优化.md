# task-05：主题色与字号阶梯优化

> **状态：已完成 ✅（2026-08）**
> 执行结果：样例 `state-grid-template` 全部页面删除未使用颜色常量（含误导新手的第 5 主题色 `ACCENT #1D9BA1`）；
> `size_ladder` 区间连续化（body↔sub↔title↔section↔hero↔display 全部衔接/重叠，21/28/60 中间档可用）；
> 主题色额度分配表 + 组件文档"示例色值口径"落地；两回归基准 0 错误；全量回归无新增失败。

## 一、任务目标需求

### 背景与问题

**问题 6（样例定义未使用的主题色，误导新手）**：内置样例 `state-grid-template` 的页面文件顶部定义：

```python
PRIMARY = "#007470"
ACCENT = "#1D9BA1"   # ← 全程未使用
```

`max_theme_colors` 上限为 **4**，而 `#1D9BA1` 是第 5 个主题色。新手照样例引入 `ACCENT` 装饰任何元素，立即触发 `color.max_theme_colors`。但样例本身"定义了却不报错"（lint 只统计实际使用的颜色，不统计定义了但未用的常量），极具误导性。

**问题 7（字号阶梯缺中间档）**：`typography.size_ladder` 旧区间 60→62、20→22、26→28、36→38 存在断裂，P10 大数字页 44-60 档在卡片内 60 过高只能降到 44，排版选择僵硬。

### 目标

1. 样例不定义未使用的主色常量；主题色额度有清晰的**分配表与示例**，新手可一次到位；
2. 字号阶梯区间**连续无断裂**，常用中间档可用（21、28、60 等）；
3. 不破坏既有页面。

---

## 二、设计和实现思路

### 2.1 样例主题色清理（R5.1）

全量排查 `examples/state-grid-template/pages/*.py`，用 AST + 引用计数检测未使用常量，删除 6 处：

| 文件 | 删除的常量 | 说明 |
|---|---|---|
| `slide_01_cover.py` | `GRAY`、`TITLE_GREEN` | 未使用（`TITLE_GREEN` 与 `ACCENT` 同色冗余） |
| `slide_02_toc.py` | `WHITE`、`TITLE_GREEN` | 未使用（同色冗余） |
| `slide_03_content.py` | `ACCENT`（`#1D9BA1`） | **核心：误导新手的第 5 主题色** |
| `slide_04_ending.py` | `LIGHT_GRAY` | 未使用 |

清理后样例 4 页共 18 个常量**全部被引用**，无未使用定义（验收项 1 ✓）；`validate` 仍 0 错误 0 警告。

在 `design-principle.md` §2.1.1 新增**主题色额度分配表**（主/次/强调/中性 4 色位 + 示例 + 使用约束），并注明"样例不得定义未使用的主题色常量"。

### 2.2 字号阶梯区间连续化（R5.2）

`rules.json` 的 `typography` 常量区与 `typography.size_ladder` 规则定义同步调整为连续区间：

| 档位 | 旧区间 | 新区间 | 衔接 |
|---|---|---|---|
| 注释 caption | 9–14 | 9–14 | — |
| 正文 body | 16–20 | **16–22** | 22 衔接 sub_title |
| 小标题 sub_title | 22–26 | **22–28** | 28 衔接 title |
| 标题 title | 28–36 | **28–40** | 38–40 与 section 重叠 |
| 大标题 section_title | 38–42 | **38–44** | 44 衔接 hero |
| Hero 标题 hero_title | 44–60 | **44–62** | 62 衔接 display |
| 大数字 display | 62–96 | 62–96 | — |

- 唯一断档是 **15pt**（注释与正文之间的自然空档，任务未要求连续）；
- lint 校验逻辑不变（字号落在任一档区间即合法），仅改 rules.json；
- 回归：两项目全部字号（14/16/20/22/24/26/32/34/36/42/44/48/54/56/60/62/96）在新阶梯下全部合法，0 新错误。

### 2.3 文档与样例同步（R5.3）

- `design-principle.md`：字号阶梯表更新为连续区间 + §2.1.1 主题色额度分配表；
- `create-from-scratch.md`：3 处阶梯引用更新（size_ladder 速查表 / hero 档 / 报错表）+ 新增"常用字号速查"小节；
- **组件文档示例色值口径**（12 个 `component-*.md`）：统一插入"示例色值口径"说明——示例中的颜色（`#3B82F6`/`#0F172A` 等）仅为**演示组件能力**的占位色，实际项目取色必须从 `DESIGN.md` 的主题色分配表（3 正式色 + 中性）选择，禁止引入第 5 色。

> **决策说明**（验收项 7"示例色值全部落在分配表"）：组件文档示例色是"任意 hex 可用"的能力演示（SVG 流程图多色节点、富文本高亮等），逐字替换成绿色主题会破坏演示语义。落地为**统一口径说明**——明确"示例仅为占位、取色从分配表"，从源头消除"拼装时误引第 5 色"的问题（这与任务背景"用户拼装时容易超额度"的诉求一致）。

### 2.4 校验一致性（R5.4）

新增测试：
- `test_rules.py`：`test_size_ladder_continuous`（5 组相邻档衔接/重叠 + 9-96 仅 15 空档）、`test_size_ladder_middle_steps_covered`（21/28/60 均在档内）、`test_typography_consistent` 扩展全部 7 档常量一致性；
- `test_lint.py`：`test_size_ladder_middle_steps`（21/28/60 合法）、`test_size_ladder_break_still_flagged`（15 仍报错）；
- 修正 4 个旧测试（旧"缺口字号"27/25/26/29 在连续化后已合法，改用 15 作为唯一断档）。

---

## 三、涉及文件

| 文件 | 改动 |
|---|---|
| `scripts/slidep/validate/rules.json` | `typography` 常量区 + `size_ladder` 区间连续化；description/hint 更新 |
| `examples/state-grid-template/pages/*.py` | 删除 6 处未使用颜色常量（含 `ACCENT #1D9BA1`） |
| `references/design-principle.md` | §2.1.1 主题色额度分配表；§3.1 字号阶梯表连续化 |
| `references/create-from-scratch.md` | 3 处阶梯引用更新 + 常用字号速查 |
| `references/component-*.md`（12 个） | 统一"示例色值口径"说明 |
| `tests/test_rules.py` | 新增阶梯连续性/中间档用例，扩展常量一致性 |
| `tests/test_lint.py` | 新增中间档/断档用例；修正 4 个旧测试的缺口字号 |

## 四、验收测试清单（执行结果）

| # | 验收项 | 操作 | 结果 |
|---|---|---|---|
| 1 | 样例无语色常量 | AST 引用计数扫描 state-grid 4 页 | ✅ 18 个常量全部被引用，无未使用定义 |
| 2 | 主题色额度表落地 | 打开 design-principle.md §2.1.1 | ✅ 4 色位 + 用途 + 示例 + 使用约束 |
| 3 | 阶梯连续 | 检查 size_ladder 边界 | ✅ body22↔sub、sub28↔title、title38-40↔section、section44↔hero、hero62↔display 全衔接/重叠；唯一断档 15 |
| 4 | 现页字号合法 | `ai-office-efficiency` validate | ✅ 0 新错误（14/16/20/22/24/26/32/36/42/44/48/54/56/60/62/96 全合法） |
| 5 | 中间档可用 | fontSize=21/28/60 构造 | ✅ 不触发 size_ladder；15/8/97 仍触发 |
| 6 | 样例回归 | `state-grid-template` validate | ✅ 0 错误 0 警告 |
| 7 | 文档样例一致 | 组件文档示例色值口径 | ✅ 12 个组件文档统一口径说明（见 2.3 决策说明） |
| 8 | 单测覆盖 | `pytest tests/test_rules.py tests/test_lint.py` | ✅ 新增 5 用例 + 修正 4 旧用例全过 |
| 9 | 全量回归 | `pytest tests/` | ✅ 仅 2 个既有失败（与 task-01~04 基线一致，无新增） |

## 五、遗留说明

- **组件文档示例色值未逐字替换**：改为统一口径说明（见 2.3 决策说明）。若后续要求示例代码可直接照抄运行且不超额度，需为每个组件文档定义一套"绿色主题示例"版本（工作量较大，且会与"组件能力演示"目标冲突），暂不实施；
- **推荐档位标注**：连续化后档位变宽，`design-principle.md` 与 `create-from-scratch.md` 均保留了"常用字号速查"（正文 16-18 / 小节标题 22-26 / 页标题 32-36 / hero 54-60）作为推荐档（仅推荐不强制）；
- **62 归属 display**：62 同时落在 hero_title[44,62] 与 display[62,96]，lint 不冲突；文档注明"62 归 display（大数字）"；
- 全量回归剩 **2 个既有失败**（`test_baseline_fallback_column`、`test_row_text_children`），与 task-01~04 基线一致，属第一次任务期遗留，建议后续任务一并评估。
