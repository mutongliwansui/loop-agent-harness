# task-06：中性色豁免主题色统计

> **状态：已完成 ✅（2026-08）**
> 执行结果：中性色（白/黑/纯灰）豁免参数化（容差可配置、可一键关闭），面积统计口径明确为"中性色不进入排序候选、分母仍为 B 区总面积"；样例与《算力资源运营中心汇报》12 页均 **0 错误 0 警告**。

## 一、任务目标需求

### 背景与问题

`validate_color_palette()` 通过 `_extract_colors()` 提取页面全部 hex 颜色计入 `color.max_theme_colors`（≤4 色）。该统计**不豁免中性色**，而白底页面 + 白字/白卡/白留白是常态，导致：

- 样例 `state-grid-template` 实测 **9 色超限**，其中 `#FFFFFF`（白）、灰阶等中性色占了大半；
- 设计上"4 主题色"约束的是**品牌色数量**，白/黑/灰是排版中性色，不应挤占品牌色额度；
- 主题色统计虚高 → 新用户被迫为中性色合并/妥协，误伤正常设计。

### 目标

1. 白 `#FFFFFF`、黑 `#000000`、灰阶（R=G=B 的纯灰）作为**中性色豁免**，不纳入 `max_theme_colors` 计数；
2. 颜色**面积占比**统计中性色不参与排序候选，分母保持 B 区总面积；
3. 样例与真实项目主题色统计回落至真实品牌色数量。

---

## 二、实现方案

### 2.1 中性色判定（R6.1/R6.2）

`_is_neutral_color(hex6, tolerance=0)`：

```python
def _is_neutral_color(hex6: str, tolerance: int = 0) -> bool:
    r = int(hex6[1:3], 16); g = int(hex6[3:5], 16); b = int(hex6[5:7], 16)
    return max(r, g, b) - min(r, g, b) <= tolerance
```

- `tolerance=0`（默认）：严格纯灰（R==G==B），含 `#FFFFFF` 白、`#000000` 黑；
- `tolerance>0`：R/G/B 最大差值 ≤ tolerance 的近灰（如 `#F5F0F0` 差值 5 ≤ 8）一并豁免；
- `tolerance<0`：关闭豁免（配合 `neutral_exempt: false` 恢复旧行为）。

> 注：任务文档举例 `#FAFAFA`/`#F5F5F5` 实际是**纯灰**（R=G=B=250），默认 tolerance=0 即豁免；容差参数针对的是**非等值近灰**（如 `#F5F0F0`）。

### 2.2 面积统计口径（R6.3，方案 A）

`_color_area_map(slide, layout, tolerance)` 在收集面积时**直接过滤中性色**：

- **中性色不计入排序候选**——白底/白卡是"无色"，不应占据 rank 0 被算作主色（此前白底会挤掉品牌色成为"主色"，导致主色统计完全错乱）；
- **分母仍是 `_B_AREA`（B 区总面积）**——`ratio = area / _B_AREA` 不变，白底天然稀释品牌色占比，与"主色占版面的视觉权重"语义一致（若剔除分母，白底占 70% 时品牌色 30% 会被放大到 100%，虚高）；
- 渐变起止色分别判定，一端为白时只统计另一端品牌色。

### 2.3 参数化（R6.2，单一数据源）

rules.json 常量区 `color` 段新增（保持 params 纯数值约束）：

```json
"color": {
  "max_theme_colors": 4,
  "neutral_exempt": true,
  "neutral_tolerance": 0
}
```

lint 读取：`validate_color_palette` / `validate_color_ratio` 均从 `rules["color"]` 读取 `neutral_exempt`/`neutral_tolerance`；`neutral_exempt: false` 时 tolerance 传 -1，恢复旧行为（全部颜色计数）。

## 三、涉及文件

| 文件 | 改动 |
|---|---|
| `scripts/slidep/validate/lint.py` | `_is_neutral_color` 加容差参数；`_extract_colors` 加 tolerance 参数（<0 关闭豁免）；`_color_area_map` 过滤中性色；`validate_color_palette`/`validate_color_ratio` 读取 rules 豁免参数 |
| `scripts/slidep/validate/rules.json` | 常量区 `color.neutral_exempt` / `color.neutral_tolerance`；规则描述/hint 同步 |
| `references/component-slide.md` / `component-text.md` | `color.max_theme_colors` 表述注明中性色豁免 |
| `tests/test_lint.py` | 新增 TestNeutralColorExempt×7 |

## 四、验收测试清单（执行结果）

| # | 验收项 | 操作 | 结果 |
|---|---|---|---|
| 1 | 白色豁免 | 页面含 `#FFFFFF` 背景/文字 | ✅ `_extract_colors` 不含白色 |
| 2 | 黑色豁免 | 页面含 `#000000` | ✅ 不含黑色 |
| 3 | 纯灰豁免 | 页面含 `#808080`、`#CCCCCC` | ✅ 不含纯灰 |
| 4 | 品牌色仍计 | 深绿/浅绿/强调色各 1 + 白/灰 | ✅ 计数 = 3（≤4 不触发） |
| 5 | 面积占比不受影响 | 白底页面，品牌色占比 | ✅ 中性色不进入候选，主色=品牌色；分母仍 B 区总面积 |
| 6 | 容差参数 | `neutral_tolerance: 8` + 近灰 `#F5F0F0` | ✅ 豁免；tolerance=0 计入 |
| 7 | 可关闭 | `neutral_exempt: false` | ✅ 恢复旧行为（白+黑+灰+3 品牌色=5 >4 触发） |
| 8 | 样例回归 | `validate examples/state-grid-template` | ✅ **0 错误 0 警告** |
| 9 | 单测覆盖 | `pytest tests/test_lint.py` | ✅ 64 用例全过（新增 7 个） |
| — | 真实项目回归 | `validate model-compute-monitor` | ✅ **0 错误 0 警告** |
| — | 全量回归 | `pytest tests/` | ✅ 与 task-04 基线一致（8 个既有失败，无新增） |
| — | build 回归 | 样例 + 真实项目 build | ✅ 均一次通过 |

## 五、遗留说明

- 全量回归剩 **8 个既有失败**（`test_layout.py`×6 字体测量 + `test_render.py`×2），与 task-01/04 基线一致，非本次引入；
- 面积口径"中性色不参与候选、分母保留"已在实现注释与文档写明，与设计文档（`design-principle.stategrid.md`）的联动表述留待 **task-08 文档一致性收口** 统一；
- 半透明白/透明度色未特殊处理（DSL 目前 `Color.a` 独立于 hex，中性判定基于 RGB 等值语义），如后续支持 rgba 主题色可扩展。
