# task-01：富文本测量与渲染一致性修复

> **状态：已完成 ✅（2026-08）**
> 执行结果：`parse_rich_text` 成为测量/渲染**唯一解析器**（layout 测量、SVG 预览、PPTX 渲染三处统一）；
> span 内 fontSize 参与测量（行宽 + 行高），`<br/>`/`\n` 换行语义一致；P10 富文本大数字不再假溢出，
> 真实项目 validate/build/preview 0 错误；新增 10 个单测用例全过。

## 一、任务目标需求

### 背景与问题

**问题 1（富文本 span 测量与渲染不一致）**：在 P10「看得见的改变」页中，尝试用富文本实现"数字 + 换行 + 说明"的锚点大数字，写法为：

```python
Text(
    '<span style={{fontSize:44}}>60%</span><br/>报表生成时间缩短',
    style={"fontSize": 20, ...},
)
```

结果该 Text 在 row 容器内被**测量出 381px 高、溢出 201px**，validate 报错：

```
错误 布局溢出（layout.overflow）实测 201.0，阈值 0
Text('60%...') 节点在 bottom 方向超出画布 201.0px
```

但实际渲染（SVG/PPTX）中文字远没有这么高。**根因**是测量与渲染走两套逻辑：

- `layout/engine.py:_strip_rich_text()` 将 `<span>/<br>` 标签**整体剥离**后，用**统一字号**测量纯文本——span 内的 `fontSize:44` 完全没参与测量，且 `<br/>` 被剥掉后可能丢失换行语义；
- `preview/svg_renderer.py:_split_rich_text_to_lines()` 则**解析 span 并按 span 内字号逐 run 渲染**——渲染高度远大于测量高度。

两套逻辑对同一段文本给出不同尺寸，导致"测量 381px"的假溢出，最终只能**拆成独立 Text 规避**（放弃富文本混排）。

### 目标

1. 富文本（含 `<span style={{fontSize}}>`、`<br/>`）的**测量结果与 SVG/PPTX 渲染结果一致**（高度偏差 ≤ 1px）；
2. 富文本测量支持：span 内 fontSize、`<br/>` 换行、行内多个 span run 的宽度累加；
3. 不再因富文本产生假溢出报错；真实溢出仍正常报错。

---

## 二、设计和实现思路

### 2.1 统一"run 解析"为单一来源（R1.1）

**现状问题**：engine.py 用 `_strip_rich_text`（正则剥离），svg_renderer.py 用 `_split_rich_text_to_lines`（逐 run 解析），render/engine.py 还有第三份 `_parse_rich_text`——三套解析器互不同步。

**方案**：抽取**唯一的富文本解析器** `parse_rich_text(text, base_font_size, base_font_weight) -> list[RichRun]`（放 `layout/text_measure.py`）：

```python
@dataclass(frozen=True)
class RichRun:
    text: str          # 纯文本片段（不含标签）
    font_size: float   # 字号（pt，span 内 fontSize 覆盖）
    font_weight: str   # "normal"/"bold"
    color: Optional[str]  # span 内 color
    is_break: bool     # 是否为 <br/>/\n 换行标记
```

- `<br/>` 不剥离为换行符丢失，而是输出 `is_break=True` 的 Run，测量与渲染都按"另起一行"处理；
- span 内 fontSize 参与**逐 run 宽度**计算；**行高**按行内最大 run 字号 × lineHeight（与 PPTX 段落 line_spacing 倍数口径一致）；
- `\n` 与 `<br/>` 等价（均识别为换行）。

### 2.2 测量函数升级（R1.2）

`measure_text` 内部检测 `<span`/`<br` 后委托 `measure_rich_text`；纯文本走原确定性路径（行为不变）。

```python
def measure_rich_text(text, width_limit, font_size, line_height, letter_spacing):
    runs = parse_rich_text(text, font_size / PT_TO_PX)   # px → pt 基准
    lines = group_runs_by_line(runs, width_limit, letter_spacing)
    for line in lines:
        w = sum(text_width(r.text, r.font_size * PT_TO_PX, ls) for r in line)
        h = max(r.font_size for r in line) * PT_TO_PX * line_height
    return TextMeasure(width=max(w), height=sum(h), lines=len(lines))
```

- `group_runs_by_line`：优先在 run 边界处换行（保持 span 完整性），单 run 超宽时在 run 内按字符切分（复用 `_fit_line`）；
- `split_runs_by_break`：仅按硬换行分段（PPTX 渲染用，文本框 word_wrap 自动换行）。

### 2.3 渲染复用同一解析器（R1.3）

- `engine.py measure()/_text_measure()`：**删除 `_strip_rich_text` 调用**，直接传原始文本（`measure_text` 内部处理富文本）；字号统一 `st.font_size_px`；
- `svg_renderer.py`：删除本地 `_parse_span_style/_parse_rich_text/_wrap_runs_to_lines/_estimate_text_width/_inline_style_str`，改为 `parse_rich_text` + `group_runs_by_line`；tspan 的 `font-size` 直接来自 `run.font_size × 96/72`；行高按行内最大 run 字号（与测量一致）；
- `render/engine.py`（PPTX）：删除本地 `_parse_rich_text`，改为 `parse_rich_text` + `split_runs_by_break`；`run.font.size = Pt(run.font_size)`。

### 2.4 字数统计与文档（R1.4）

- `lint.py _text_char_count`：剥离富文本标签后计数（此前标签字符被计入正文字数）；
- `references/component-text.md`：明确富文本能力边界——span 支持 `fontSize`/`fontWeight`/`color`，**暂不支持**嵌套 span 与 lineHeight（见 task-07 扩展）；补充"测量一致性"说明。

---

## 三、涉及文件

| 文件 | 改动 |
|---|---|
| `scripts/slidep/layout/text_measure.py` | 新增 `RichRun` / `parse_rich_text` / `group_runs_by_line` / `split_runs_by_break` / `measure_rich_text`；`measure_text` 委托 |
| `scripts/slidep/layout/engine.py` | `measure()`/`_text_measure()` 删除 `_strip_rich_text` 调用，直接传原始文本；（本次同时重建了被误覆盖的 engine.py，恢复第一期溢出收集/baseline/hint 等功能，行为与 pyc 版本逐项比对一致） |
| `scripts/slidep/preview/svg_renderer.py` | 删除本地富文本解析，复用 `parse_rich_text`/`group_runs_by_line`；tspan 渲染与行高按 run 字号 |
| `scripts/slidep/render/engine.py` | 删除本地 `_parse_rich_text`，复用 `parse_rich_text`/`split_runs_by_break` |
| `scripts/slidep/validate/lint.py` | `_text_char_count` 剥离富文本标签后计数 |
| `references/component-text.md` | 富文本能力边界 + 测量一致性说明 |
| `tests/test_layout.py` | 新增 `TestRichTextMeasure`×7 |
| `tests/test_preview.py` | 新增 `TestRichTextSVGRender`×3 |

## 四、验收测试清单（执行结果）

| # | 验收项 | 操作 | 结果 |
|---|---|---|---|
| 1 | span 字号参与测量 | `<span style={{fontSize:44}}>60%</span><br/>说明` 测量 | ✅ 高度 = 44pt 行高 + 基础行高，span 参与行宽/行高 |
| 2 | `<br/>` 换行语义 | 富文本 + 窄宽度限制 | ✅ 测量与渲染均按行处理，行数一致（`\n` 等价） |
| 3 | 多 span 行内累加 | 两个相邻 span 单行 | ✅ 宽度 = Σ span 宽度，与 SVG tspan 一致 |
| 4 | 测量=渲染偏差 | 富文本页面 layout vs SVG tspan | ✅ 高度偏差 < 1px（110.93 vs 110.93；tspan 58.7/26.7px） |
| 5 | row 内富文本不假溢出 | 原富文本写法在 row 容器内 validate | ✅ 0 溢出报错 |
| 6 | 纯文本不回归 | 普通 Text 测量 | ✅ 委托路径等价，全量测试通过 |
| 7 | 字数统计正确 | 含 span 页面 `_text_char_count` | ✅ 只计可见字符（新增用例锁定） |
| 8 | 单测覆盖 | `pytest tests/test_layout.py tests/test_preview.py` | ✅ 新增 10 用例全过 |
| 9 | 全量回归 | `pytest tests/` | ✅ 仅 2 个既有失败（与 pyc 原版行为一致，非本次引入） |
| 10 | 真实项目 | `ai-office-efficiency` validate/build/preview | ✅ 0 错误；P10 大数字（44pt）渲染正常 |

## 五、遗留说明

- 富文本**跨 span 基线对齐**仍不支持，需拆 Text 或等 task-07 扩展；
- span **嵌套**暂不支持（内层标签剥离、样式取外层），task-07 计划扩展 1 层嵌套；
- 全量回归剩 **2 个既有失败**（`test_baseline_fallback_column`、`test_row_text_children`）：经与 pyc 原版（工作区代码）逐项比对，**行为完全一致**，属第一次任务期遗留，非本次引入；建议在 task-04（结构约束）或后续任务一并评估。
- **事故记录**：本任务执行中因误用 fileWrite 覆盖了 `engine.py`（工作区含第一期未提交成果 1037 行）。已通过 `__pycache__/engine.cpython-312.pyc` 反汇编（xdis + dis）提取全部函数逻辑与常量文案，结合 task-02/07 文档**手动重建**为功能等价版本，并与 pyc 原版逐场景比对（溢出收集/baseline/高度重算/重排）一致后继续开发。
