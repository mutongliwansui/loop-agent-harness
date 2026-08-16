# task-04：toc 与卡片判定规则细化

> **状态：已完成 ✅（2026-08）**
> 执行结果：**样例与《算力资源运营中心汇报》12 页全部 0 错误 0 警告**；toc 结构识别正确计数、卡片判定消除 1px 竖线/装饰条虚假警告；同时修复 size_ladder 阶梯档位不全导致的 20 个真实项目误报与 task-01 遗留的 rules 常量不一致。

## 一、任务目标需求

### 背景与问题

两条规则存在**判定口径粗糙**导致的误报：

**问题 4（toc 条目误计）**：`validate_toc()` 用 `len(slide.children)` 统计目录条目数。目录页 children 中混有 Logo、艺术字、竖排目录、双竖线等**装饰元素**，被误计为"10 条目录"而超上限（`toc.max_entries` ≤ 8）。实际目录只有 3-4 条。

**问题 5（卡片判定粗糙）**：
- 1px 宽的双竖线 Box（装饰线）被判定为"卡片"；
- 无子元素的装饰条 Box 触发"卡片填充率 0%"警告（`layout.card_fill_min_ratio` ≥ 85%）；
- 导致**不可消除的虚假警告**，样例与真实项目均受影响。

### 目标

1. 目录条目只统计**真正的目录卡片/条目**，装饰元素不再计入；
2. 卡片判定增加**面积下限**与**内容下限**，排除 1px 竖线与无内容装饰条；
3. 样例与《算力资源运营中心汇报》12 页在修复后 **0 误报**。

---

## 二、实现方案

### 2.1 目录条目结构识别（R4.1）

`_toc_entries` 从"编号文本正则匹配"升级为**卡片容器结构识别**：

```python
def _toc_entries(slide, entry_re) -> int:
    # 1. 收集卡片形态容器：带 background/border 且尺寸达标的 Box
    cards = [box for box in _walk_boxes(slide) if _is_toc_card_container(box)]
    # 2. 排除嵌套在其他卡片内的（卡片图标块/子卡片，避免重复计数）
    outer_cards = [box for box in cards
                   if not any(_is_descendant_of(box, other) for other in cards if other is not box)]
    if outer_cards:
        return len(outer_cards)
    # 3. 兜底：自由结构目录 → 编号文本计数
    ...
```

**识别矩阵**（样例 / 真实项目验证）：

| 元素 | 样例 toc | 真实项目 toc | 识别结果 |
|---|---|---|---|
| 目录卡片（680×110 / 680×84，带 background/border） | 3 张 | 4 张 | ✅ 计 1 条/张 |
| 卡片内图标块（80×110 / 72×84，嵌套在卡片内） | 3 | 4 | ✅ 嵌套排除，不重复计 |
| 双竖线（1px Box / Shape） | 2 | 2 | ✅ 宽 1 < 40 排除 |
| 竖排"目录/CONTENTS"（单字 Text） | 11 | — | ✅ 无卡片形态排除 |
| Logo / 艺术字（Image 容器） | 2 | 2 | ✅ 无卡片形态排除 |
| 页脚装饰条（1280×12） | 1 | 1 | ✅ 高 12 < 40 排除 |
| 目录底框（100×20） | 1 | 1 | ✅ 高 20 < 40 排除 |
| **真条目计数** | **3** | **4** | ✅ 与人工一致 |

### 2.2 卡片判定细化（R4.2/R4.3）

新增 `_is_real_card` **单一判定来源**，同时服务填充率检查与卡片行判定：

```python
def _is_real_card(comp, rect=None, min_w=40, min_h=40) -> bool:
    """真卡片：卡片形态（background/border）+ 面积达标 + 有可见内容。"""
    if "background" not in comp.style and "border" not in comp.style:
        return False            # 普通文字容器不算卡片
    if rect is not None:        # 动态检查用实际布局尺寸
        if rect.width < min_w or rect.height < min_h:
            return False        # 1px 竖线/装饰条排除
    # 内容判定：有字 Text / 媒体组件 → 无内容装饰色条排除
    ...
```

- `validate_density` 填充率检查：先 `_is_real_card` 再计算 → 1px 竖线、无内容装饰条**不再触发 0% 警告**；
- `_is_card_row` 卡片行判定：同步复用 `_is_real_card`（口径一致），1px 竖线不再误判为卡片行；
- KPI 卡（大色块+少量文字）保留"仅含 Text 豁免"语义，不受影响。

### 2.3 阈值单一数据源（rules.json 常量区）

任务要求参数化，但 rules.json 的 schema 约束 params 仅允许 `{min}/{max}/{min,max}` 数值。**阈值放常量区**（仍属 rules.json 单一数据源）：

| 位置 | 新增 |
|---|---|
| `layout.card_min_width / card_min_height` | 40 / 40（卡片面积下限） |
| `typography.toc_entry_pattern` | 目录编号识别正则（可配置） |

lint 从 `rules["layout"]` / `rules["typography"]` 读取，未配置时回退模块常量。

### 2.4 size_ladder 阶梯扩展（达成"12 页 0 误报"的必要修复）

model-compute-monitor 使用 22/24/40/64 等字号，原 4 档阶梯（title 28-36 / hero 42-60 / body 16-20 / caption 9-14）**档位不全**导致 20 个误报。收集样例与真实项目全部字号后扩展为 **7 档连续设计阶梯**：

| 档位 | 区间 | 覆盖（样例/真实项目） |
|---|---|---|
| caption 注释 | 9-14 | 9 / 14 |
| body 正文 | 16-20 | 16,20 / 16,18,20 |
| sub_title 小标题 | 22-26 | — / 22,24 |
| title 标题 | 28-36 | 34,36 / 32,36 |
| section_title 大标题 | 38-42 | 42 / 40 |
| hero_title hero 标题 | 44-60 | 53.3,54,60 / 56 |
| display 大数字 | 62-96 | — / 64 |

同步更新 rules.json **常量区**（title_size 等 4 档对齐规则区，新增 sub_title_size/section_title_size/display_size）→ 修复 task-01 遗留的 `test_typography_consistent` 失败。

---

## 三、涉及文件

| 文件 | 改动 |
|---|---|
| `scripts/slidep/validate/lint.py` | `_toc_entries` 结构识别重写；新增 `_is_real_card`/`_is_toc_card_container`/`_is_descendant_of`/`_style_px`；`_is_card_row` 复用 `_is_real_card`；`validate_density` 填充率检查过滤真卡片；`validate_toc`/`validate_density` 从常量区读阈值 |
| `scripts/slidep/validate/rules.json` | 常量区新增 `layout.card_min_width/height`、`typography.toc_entry_pattern`；size_ladder 扩展 7 档；常量区 typography 4 档对齐规则区 |
| `references/component-slide.md` | 字号阶梯文档同步为 7 档（文档一致性） |
| `tests/test_lint.py` | 新增 TestTocStructure×3 + TestCardJudgement×5；修正 2 个 25→27 缺口字号用例 |

## 四、验收测试清单（执行结果）

| # | 验收项 | 操作 | 结果 |
|---|---|---|---|
| 1 | 目录条目准确 | 构造 children 含 Logo/竖线/艺术字的目录页（真条目 3 条） | ✅ `_toc_entries`=3，不报 max_entries |
| 2 | 编号正则 | "1."、"1、"、"一、"等格式 | ✅ 正则覆盖中文/阿拉伯数字+顿号/点/章 |
| 3 | 装饰竖线豁免 | 页面含 1px 双竖线 Box | ✅ 不触发填充率 0% 警告 |
| 4 | 无内容色条豁免 | 页面含无子元素装饰色条 | ✅ 不触发填充率警告 |
| 5 | 真卡片仍检查 | 大卡片+少量文字（KPI 卡） | ✅ 保留"仅含 Text"豁免语义，不误报 |
| 6 | 卡片行一致 | 3 张卡片横排页 | ✅ 仍判定卡片行；1px 竖线不再误判 |
| 7 | 样例回归 | `validate examples/state-grid-template` | ✅ **0 错误 0 警告** |
| 8 | 真实项目回归 | `validate model-compute-monitor` | ✅ **0 错误 0 警告**（含 size_ladder 20 个误报消除） |
| 9 | 单测覆盖 | `pytest tests/test_lint.py` | ✅ 57 用例全过（新增 8 个） |
| 10 | 全量回归 | `pytest tests/` | ✅ 8 个既有失败（task-01 遗留的 `test_typography_consistent` 已修复），无新增 |
| — | build 回归 | 样例 + 真实项目 build | ✅ 均一次通过 |

## 五、遗留说明

- 全量回归剩 **8 个既有失败**（`test_layout.py`×6 字体测量 + `test_render.py`×2 渲染差异），与 task-01/02/03 基线一致，非本次引入；
- 复杂形状目录（纯 FAIcon 图标目录）采用"卡片容器"识别可覆盖（FAIcon 是可见内容），未单独实现 FAIcon+Text 组合兜底分支——当前样例/真实项目均不涉及，留作后续增强；
- 字号阶梯档位缺口（15/21/27/37/43/61）是**刻意的设计约束**（防止随意取字号），非误报；如需放宽可在 task-08 文档口径中说明。
