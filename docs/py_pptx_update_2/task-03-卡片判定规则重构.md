# task-03：卡片判定规则重构

> **状态：已完成 ✅（2026-08）**
> 执行结果：`_is_real_card` → `_card_kind` 三层判定（'card'/'block'/'decor'/None）；
> 功能区块（block）不再触发卡片行上限；装饰竖条（decor）不计卡片、不拉低填充率；
> `card_row_max_pages` 上限 2→3；真实项目 ai-office-efficiency 从 13 警告降至 8 警告，
> **P08 卡片填充率 54% 警告消除**；两个回归基准 0 错误。

## 一、任务目标需求

### 背景与问题

**问题 3（卡片判定不可预期）**：制作 P08「智能会议助手」时，最初采用 **2×2 功能卡片**布局（4 个带浅灰背景的 Box），validate 报：

```
错误 layout.card_row_max_pages：N 卡片横排版式 3 页，超过上限 2 页
```

被迫把 2×2 卡片改回**无背景的行式列表**，视觉层次变弱。问题出在两处：

1. **`card_row_max_pages ≤ 2` 过严**：真实汇报中"3 个 KPI 横排 + 2 个功能卡横排"是常见表达，13 页 deck 出现 3 页卡片横排很自然，却被硬性拦截；
2. **卡片判定只看形态不看意图**：`_is_real_card` 将"**任何带 background/border 的 Box**（且 ≥40px 且有内容）"判为卡片。于是：
   - 纯色**装饰竖条**（P10 的 8px 主色竖条）若恰有内容会被计入卡片，导致 `card_fill_min_ratio` 填充率**虚低**（P08 曾报 54%）；
   - 浅灰**功能区块**（非视觉上"一张卡片"）也被判为卡片行，触发横排页上限。

### 目标

1. 卡片判定**更贴近视觉语义**：区分"卡片"（独立视觉块，含内容与留白）与"功能区块/装饰元素"；
2. `card_row_max_pages` 上限**放宽或按页面类型豁免**，使 2×2 功能卡、3 KPI 横排等常见版式不再被误拦；
3. 纯色装饰元素不再计入卡片，卡片填充率统计**不失真**。

---

## 二、设计和实现思路

### 2.1 卡片判定分层模型（R3.1）

`_is_real_card` 重构为 `_card_kind(comp, rect, min_w, min_h) -> Optional[str]` 三层判定：

```python
def _card_kind(comp, rect=None, min_w=40, min_h=40):
    """返回卡片类别：'card' | 'block' | 'decor' | None"""
    # 第1层 形态：background/border 且尺寸达标（≥40px），否则 None
    # 第2层 装饰排除：宽高比极悬殊（>12）且无内边距 → 'decor'（竖条/色带）；
    #               纯色无边框/圆角/padding 且子项均 absolute → 'decor'（装饰容器）
    # 第3层 语义：有 border/borderRadius（视觉独立卡片框）→ 'card'；
    #            无边框/圆角仅纯背景（可有 padding）→ 'block'；无内容 → None
```

**关键决策**（相对任务初稿调整）：
- **'card' = 带边框或圆角**的视觉独立卡片（任务初稿把 padding 也算 card，但 P08 底部信息条带 padding 16 会被误判 → 调整为 card 依赖 border/borderRadius）；
- **'block' = 仅背景色（可有 padding）**的功能区块（信息条/图表容器/KPI 色块）；
- **填充率检查只对 'card' 执行**：block 功能区块不做 card_fill_min_ratio 检查（避免 P08 信息条等浅灰分区误报 54%），这与任务初稿"block 计入填充率"有出入——以验收项 6（P08 不报 54%）为硬指标，block 的实际语义为"计入页面内容覆盖，但不做单卡片填充率检查"。

### 2.2 `card_row_max_pages` 口径调整（R3.2）

- `_is_card_row` 只统计 **'card' 类别** ≥2 的 row 容器（'block'/'decor' 不计）；
- `rules.json` 上限 **2 → 3**，hint 补充"连续 >3 页建议换版式"；
- 相邻页豁免（章节页后不计数）评估后**未实施**——放宽到 3 + block 不计行已满足验收项 1/4，豁免复杂度高且收益有限（记入遗留）。

### 2.3 填充率统计排除装饰（R3.3）

- `card_fill_min_ratio` 遍历节点时，`_card_kind != 'card'` 跳过（block/decor/None 均不检查）；
- P08 底部信息条（浅灰 #F7F7F7 + padding 16，无边框）→ block → 不再报 54%；
- P12 的 3 条填充率警告来自**带边框真卡片**（内容真实不足）→ 保留（真卡片仍被统计）。

### 2.4 回归基准与文档（R3.4）

- `state-grid-template`：0 错误 0 警告（回归基准 1）；
- `ai-office-efficiency`：0 错误，13 警告 → **8 警告**（P04/P08/P10 填充率警告消除，剩余为嵌套深度/留白/真卡片填充率）；
- `design-principle.md` §4.1.1 新增"卡片 vs 功能区块 vs 装饰"判定速查表。

---

## 三、涉及文件

| 文件 | 改动 |
|---|---|
| `scripts/slidep/validate/lint.py` | `_is_real_card` → `_card_kind`（三层模型）；`_is_real_card` 保留为兼容包装；`_is_card_row` 只统计 'card'；`validate_density` 填充率只检查 'card' |
| `scripts/slidep/validate/rules.json` | `layout.card_row_max_pages.max: 2 → 3`；description/hint 更新 |
| `references/design-principle.md` | §4.1.1 卡片三类判定速查 |
| `tests/test_lint.py` | 更新 3 个口径调整测试（真卡片=带边框）+ 新增 4 用例（block 不计行/三层判定/decor 不参与填充率） |

## 四、验收测试清单（执行结果）

| # | 验收项 | 操作 | 结果 |
|---|---|---|---|
| 1 | 2×2 功能卡不误触上限 | 4 个浅灰功能区块（'block'）页 × 3 页 validate | ✅ 0 错误，不触发 card_row_max_pages |
| 2 | 真卡片仍被统计 | 带边框+padding+文字的卡片 4 页横排 | ✅ 触发上限（actual=4, limit=3） |
| 3 | 装饰竖条不拉低填充率 | 8px 竖条/装饰容器（'decor'） | ✅ card_fill_min_ratio 统计排除，不误报 |
| 4 | 3 KPI 横排通过 | 3 个数字指标横排页 | ✅ 0 错误（3 ≤ 3） |
| 5 | 回归基准 1 | `state-grid-template` validate | ✅ 0 错误 0 警告 |
| 6 | 回归基准 2 | `ai-office-efficiency` validate | ✅ 0 错误；**P08 54% 消除**（13→8 警告） |
| 7 | 单测覆盖 | `pytest tests/test_lint.py` | ✅ 新增 4 用例 + 更新 3 用例全过 |
| 8 | 全量回归 | `pytest tests/` | ✅ 仅 2 个既有失败（与 task-01/02 基线一致，非本次引入） |
| 9 | 文档落地 | design-principle.md §4.1.1 | ✅ 三类判定速查完整可读 |

## 五、遗留说明

- **"相邻页豁免"未实施**：任务初稿的可选项（章节页后卡片页不计数）——放宽到 3 + block 不计行已满足验收项，且避免引入"相邻页"边界的复杂度；如后续出现"连续 3 页真卡片"的节奏问题再评估；
- **block 不做填充率检查**：与任务初稿"block 计入填充率"表述有出入（见 2.1 关键决策），以验收项 6 为准——功能区块（浅灰信息条/图表容器/KPI 色块）不触发 card_fill_min_ratio；真卡片（带边框/圆角）内容不足仍报（P12 保留 3 条合理警告）；
- **KPI 卡（无边框大色块）现判为 block**：不计卡片行、不查填充率——2 个 KPI 横排将不再触发卡片行上限，如产品需要 KPI 卡计入卡片行，可后续为 KPI 卡加圆角（borderRadius）即自动归入 'card'；
- 全量回归剩 **2 个既有失败**（`test_baseline_fallback_column`、`test_row_text_children`），与 task-01/02 基线一致，属第一次任务期遗留，建议后续任务一并评估。
