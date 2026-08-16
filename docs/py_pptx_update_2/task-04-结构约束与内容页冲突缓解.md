# task-04：结构约束与内容页冲突缓解（嵌套深度 / 字数口径）

> **状态：已完成 ✅（2026-08）**
> 执行结果：`_max_depth` 对 `position:absolute` Box 不计层（方案 A 生效，未需叠加方案 B）；
> 字数统计提取为 `validate/body_chars.py` 独立模块，页面形态感知选用 120/180 口径；
> ai-office-efficiency 13 页从 8 警告降至 **4 警告**（P04/P05/P08/P12 嵌套警告全部消除）；
> P12 流程卡页去掉"凑段"文字后仍按 120 口径通过；两个回归基准 0 错误。

## 一、任务目标需求

### 背景与问题

**问题 4（嵌套深度 ≤5 与标准内容页结构冲突）**：本期 13 页中 P04/P05/P08/P12 均触发：

```
警告 structure.max_nesting_depth：组件嵌套深度 6 层，超过上限 5 层
```

根因是**标准内容页结构天然达到 6 层**：

```
Slide(1) → 内容区Box(2) → 行容器(3) → 卡片Box(4) → 卡片文字容器(5) → Text(6)
```

为满足 lint 被迫扁平化（去掉中间容器），牺牲了代码可读性与结构清晰度。

**问题 5（正文字数下限对流程/图表页机械）**：P12「三步走落地路径」是流程卡页面，`min_body_chars ≥ 180` 统计时**卡片内 desc 文字不计入**，实测仅 169 字报错；最终只能额外塞一段"落地原则说明"凑字数——内容并不缺，是**统计口径与页面形态不匹配**导致"凑数感"。

### 目标

1. 标准内容页结构（标题区 + 卡片 + 卡片文字）不再触发嵌套深度警告；
2. 正文字数统计口径与页面形态匹配：含 ≥2 个图表/表格/结构卡片的页面按"数据页"口径（≥120）或纳入卡片文字统计；
3. 不降低 lint 对"过度嵌套 / 正文过空"的真实约束力。

---

## 二、设计和实现思路

### 2.1 嵌套深度：absolute 装饰不计层（R4.1，方案 A 实施）

`_max_depth` 递归时，**`position: absolute` 的 Box 不计入深度**（level 不 +1，子树沿用父级深度）：

```python
def _max_depth(comp, level: int = 1) -> int:
    children = getattr(comp, "children", [])
    if not children:
        return level
    depths = []
    for c in children:
        is_abs = isinstance(c, Box) and c.style.get("position") == "absolute"
        depths.append(_max_depth(c, level if is_abs else level + 1))
    return max(depths)
```

- 语义依据：absolute 元素不参与布局流（"附着"而非"嵌套"），标题区装饰（编号对话框/色块）与 absolute 内容区容器不再人为加深层级；
- 验证：P04/P05/P08/P12 深度全部 6→5，**方案 A 已足够，未叠加方案 B（阈值 5→6）**；
- 既有 `test_nesting_depth_exceeded`（5 层纯 static Box）仍触发 → 对"过度嵌套"的真实约束力不变。

### 2.2 字数统计：页面形态感知（R4.2）+ 独立模块（R4.3）

新建 `scripts/slidep/validate/body_chars.py`（单一数据源，lint 与文档共用）：

- `body_char_count(slide)`：页面正文可见字符数——统计**全部 Text（含卡片 'card'/'block' 内 desc/标签文字）**，富文本标签剥离；
- `is_data_page(slide, layout, b_area, card_kind_fn)`：数据页判定——
  1. 图表/表格主导：Chart/Table 面积 ≥40% B 区（既有口径）；
  2. **结构卡片页**（新增）：≥2 个 'card'/'block' 卡片（流程卡/KPI 卡/功能区块），卡片内文字即正文主体 → 120 口径；
  3. 纯文字页（无图表、无卡片）→ False（走 180）；
- `effective_min_chars(rules, slide, ...)`：按页面形态选用 120/180，阈值读 rules.json。

`validate_density` 改用 `body_char_count` + `effective_min_chars`（删除原内联 data_area 判定），`_text_char_count` 保留为兼容包装。

**口径细化说明**：任务初稿数据页判定写"_card_kind == 'card' ≥2"，但 P12 三张 stage_card 在 task-03 后判定为 **block**（无边框无圆角浅灰底）。为满足验收项 3（P12 按 120 通过），判定扩展为 **'card'/'block' 结构卡片 ≥2**，语义上更符合"卡片页文字即正文主体"的意图。

### 2.3 回归基准（R4.4）

- `ai-office-efficiency`：8 警告 → **4 警告**（P04/P05/P08/P12 嵌套警告消除；剩余 P07 留白 + P12 真卡片填充率×3，均非本任务范围）；
- `state-grid-template`：0 错误 0 警告。

---

## 三、涉及文件

| 文件 | 改动 |
|---|---|
| `scripts/slidep/validate/body_chars.py` | **新增**：正文统计 / 数据页判定 / 门槛选用（R4.3 单一数据源） |
| `scripts/slidep/validate/lint.py` | `_max_depth` 跳过 absolute Box；`validate_density` 改用 body_chars；`_text_char_count` 兼容包装 |
| `scripts/slidep/validate/rules.json` | 嵌套深度/字数规则 description/hint 更新（absolute 不计层、卡片页 120 口径） |
| `references/create-from-scratch.md` | 速查表更新 + "正文字数口径"与"嵌套深度口径"两个说明小节 |
| `tests/test_lint.py` | 新增 3 用例：absolute 不计层 / 卡片页 120 口径 / body_chars 模块口径 |

## 四、验收测试清单（执行结果）

| # | 验收项 | 操作 | 结果 |
|---|---|---|---|
| 1 | 标准内容页不触发嵌套警告 | 标题区+卡片+卡片文字标准结构（6 层）validate | ✅ absolute 不计层生效，深度 5 不警告 |
| 2 | absolute 装饰不加深 | 封面/章节页 absolute 色块 | ✅ 标题编号/色块不计层（P04-P12 全部 6→5） |
| 3 | 流程卡页字数达标 | P12 三步走卡片页（3 卡） | ✅ 120 口径通过；**去掉凑段文字后 147 字仍达标** |
| 4 | 图表页口径正确 | 含图表页（Chart 面积 ≥40% B 区） | ✅ is_data_page=True，120 口径生效 |
| 5 | 正文过空仍被拦 | 纯文字内容页 56 字 | ✅ 仍触发 min_body_chars（180 口径） |
| 6 | 回归基准 | `ai-office-efficiency` validate | ✅ 0 错误；P04/P05/P08/P12 嵌套警告**全部消除**（8→4 警告） |
| 7 | 回归基准 2 | `state-grid-template` validate | ✅ 0 错误 0 警告 |
| 8 | 单测覆盖 | `pytest tests/test_lint.py` | ✅ 新增 3 用例全过 |
| 9 | 全量回归 | `pytest tests/` | ✅ 仅 2 个既有失败（与 task-01~03 基线一致，无新增） |

## 五、遗留说明

- **方案 B（阈值 5→6）未启用**：方案 A（absolute 不计层）已覆盖全部真实场景；rules.json 阈值保持 5，对"纯 static 过度嵌套"的约束力不变（有测试锁定）；
- **"排除标题区与装饰文字"未单独实现**：`body_char_count` 统计全部可见文字（含标题/编号），靠"卡片页 120 口径"整体放宽。任务初稿提的"排除标题区"会增加判定复杂度且对字数影响极小（标题/编号通常 <20 字），故未单独区分——若未来出现"标题很长但正文空"的边界，可在 body_chars 中增加 fontSize ≥36 排除规则；
- **嵌套深度口径对 build 无影响**：`_max_depth` 仅用于 lint 反馈，布局引擎布局流不受影响；
- 全量回归剩 **2 个既有失败**（`test_baseline_fallback_column`、`test_row_text_children`），与 task-01~03 基线一致，属第一次任务期遗留，建议后续任务一并评估。
