# task-07：调试体验与富文本能力增强

> **状态：已完成 ✅（2026-08）**
> 执行结果：`layout` 命令新增 `--out <file>`（CLI 直接写 UTF-8 文件，绕开 Windows 重定向/管道问题）
> 与 `--find <text>`（按文本定位节点 + 祖先链 rect）；富文本解析器升级为**栈式解析**（span 支持 lineHeight、
> 支持 1 层嵌套、≥2 层不崩溃降级）；Text 新增 `baselineAlign: "baseline"` 实现**跨 span 基线对齐**（SVG
> `dominant-baseline="alphabetic"` + PPTX run 天然基线）；新增 12 个单测 + 调试工作流文档；全量回归无新增失败。

## 一、任务目标需求

### 背景与问题

**问题 9（调试手段单一、输出不可靠）**：`layout --debug` 在 Windows 下重定向到文件曾静默失败、
管道输出被编码/缓冲问题吞掉，拿不到布局树只能盲改。

**问题 10（富文本能力偏弱）**：span 不支持 lineHeight、不支持嵌套、跨 span 基线对齐无可靠实现
（只能拆多 Text + `alignItems: baseline` 手工对齐，脆弱）。

### 目标

1. `layout --debug` 输出稳定可靠：Windows 重定向/管道均可正常获取，含节点层级树与 rect 明细；
2. 富文本能力增强：span 支持 lineHeight、支持 1 层嵌套、跨 span 基线对齐有可靠实现路径；
3. 为 Agent 提供"一键导出布局树 + 定位节点"的调试工作流。

---

## 二、设计和实现思路

### 2.1 调试输出可靠性（R7.1）

**根因排查**：实测发现 `@app.callback` 已全局调用 `_force_utf8_stdio()`（第一期 task-09 已修复），
layout 子命令实际已受 UTF-8 保护——重定向/管道均正常（验证通过）。本次将可靠性进一步加固：

1. **layout_cmd 开头显式 `_force_utf8_stdio()`**（防御 callback 覆盖场景）；
2. **新增 `--out <file>`**：CLI 直接写 UTF-8 文件（`Path.write_text(encoding="utf-8")`），
   不依赖 shell 重定向，彻底规避 cmd 管道问题；
3. **新增 `--find <text>`**：DFS 按 Text 全文 / 节点 label 子串匹配，输出该节点**整条祖先链 rect**
   （根 → 目标，目标标 `<<< 目标`），快速定位"某个元素实际渲染位置"；
4. **抽出 `_layout_tree_lines`**：print 与 `--out` 写文件复用同一格式化函数（缩进 + 类型 + label + rect + 溢出标记）。

### 2.2 富文本能力增强（R7.2）

#### span lineHeight + 1 层嵌套（统一解析器升级）

`text_measure.py` 升级（**测量与渲染共用的唯一解析器**）：

- `RichRun` 新增 `line_height: Optional[float]`（span 内行高倍数，None 继承）；
- `_parse_span_style` 支持 `lineHeight`（倍数 ≥1.0）；
- `parse_rich_text` 由正则非嵌套匹配升级为**栈式 token 扫描**（`_SPAN_TOKEN_RE` 交替匹配
  span-open / span-close / br）：
  - 样式栈继承 + 覆盖：内层 span 覆盖外层同名属性（fontSize/fontWeight/color/lineHeight），其余继承；
  - 1 层嵌套 `<span A><span B>text</span></span>` 正确解析；
  - ≥2 层嵌套**不崩溃**（最内层属性生效），但超出承诺边界——文档注明建议拆多 Text；
  - 多余闭合标签/未闭合标签**降级为纯文本**，不崩溃；
- `measure_rich_text` 行高：行高 = 行内最大 (run 字号 × run 生效行高倍数)，span 内 lineHeight 优先。

#### 跨 span 基线对齐（方案 A 落地 + 方案 B 已有）

| 路径 | 状态 | 说明 |
|---|---|---|
| **方案 A**：Text `baselineAlign: "baseline"` | ✅ 落地 | 同一 Text 内不同字号 span run 共享基线；SVG 输出 `dominant-baseline="alphabetic"`（y 指向基线 = 行顶 + 行高 − 最大字号 20% 下行距）；PPTX run 天然共享段落基线，无需改动 |
| **方案 B**：row 容器 `alignItems: baseline` | ✅ 已有（task-05） | 多 Text 子项首行基线重合，文档沉淀为两种路径之一 |

`styles.py` Text 白名单新增 `baselineAlign`（枚举 `top`/`baseline`，默认 `top` 行为不变）；
`engine.py` ResolvedStyle 新增 `baseline_align` 字段。

### 2.3 调试工作流文档（R7.3）

- `create-from-scratch.md` Step5 新增「调试排障工作流」：validate 定位错误 → `layout --debug --out tree.txt`
  导出布局树 → `--find` 定位节点 → 对照修法速查修改；附一次真实排障的完整命令序列；
- `component-text.md` 富文本能力边界更新：语法表（lineHeight + 1 层嵌套 + 边界）、内联样式说明、
  测量一致性、样式表（baselineAlign）、基线对齐两种路径。

---

## 三、涉及文件

| 文件 | 改动 |
|---|---|
| `scripts/slidep/cli/main.py` | layout 命令：`--out` 写文件、`--find` 定位、显式 UTF-8；`_layout_tree_lines`/`_find_layout_nodes`/`_ancestor_chain_lines` |
| `scripts/slidep/layout/text_measure.py` | RichRun.line_height；_parse_span_style lineHeight；parse_rich_text 栈式解析（1 层嵌套）；measure_rich_text 行高 |
| `scripts/slidep/preview/svg_renderer.py` | 行高 run 级 lineHeight；baselineAlign → dominant-baseline="alphabetic" |
| `scripts/slidep/dsl/styles.py` | Text 白名单 + baselineAlign 枚举 |
| `scripts/slidep/layout/engine.py` | ResolvedStyle.baseline_align 字段与解析 |
| `references/create-from-scratch.md` | 调试排障工作流（4 步 + 真实命令序列） |
| `references/component-text.md` | 富文本能力边界更新（lineHeight/嵌套/baseline） |
| `tests/test_cli.py` | 3 用例：--out 写文件 / --find 祖先链 / 管道 UTF-8 |
| `tests/test_layout.py` | 5 用例：lineHeight 测量 / 继承回退 / 嵌套解析 / 深嵌套不崩溃 / 坏标签降级 |
| `tests/test_preview.py` | 4 用例：lineHeight SVG 行高 / 未设回退 / baselineAlign alphabetic / 默认 top |

## 四、验收测试清单（执行结果）

| # | 验收项 | 操作 | 结果 |
|---|---|---|---|
| 1 | layout --debug 重定向可靠 | `layout <project> --debug --out tree.txt` | ✅ 文件生成，UTF-8 中文正常，含节点树 + rect（96 行） |
| 2 | --find 定位 | `layout <project> --find "标题2"` | ✅ 输出祖先链 rect（Slide→Box→...→目标 <<<） |
| 3 | 管道输出可用 | `layout <project> --debug 2>&1 \| findstr` | ✅ 输出不丢失、exit=0 |
| 4 | span lineHeight | `<span style={{lineHeight:1.8}}>` | ✅ 测量与 SVG 渲染行高均按 1.8（32pt→76.8px 验证） |
| 5 | span 1 层嵌套 | `<span A><span B>text</span></span>` | ✅ 内层覆盖外层，其余继承 |
| 6 | 嵌套 2 层以上 | 3 层嵌套构造 | ✅ 不崩溃（最内层生效）；文档注明边界 |
| 7 | baseline 对齐 | `baselineAlign:"baseline"` 大小字号跨 span | ✅ SVG dominant-baseline="alphabetic" + 82.7px/26.7px 双字号共享基线 |
| 8 | 调试文档落地 | create-from-scratch.md | ✅ 4 步工作流 + 真实命令序列 |
| 9 | 单测覆盖 | 3 个测试文件 | ✅ 新增 12 用例全过 |
| 10 | 全量回归 | `pytest tests/` | ✅ 683 passed，2 既有失败（与基线一致） |
| 11 | 真实项目 | ai-office 调试全流程 | ✅ 布局树导出 390 行 + --find "80%" 双命中；富文本 toc 页 SVG 正常；validate 0 错误 |

## 五、遗留说明

- **PPTX 层 span lineHeight 为段落级**：PPTX 的 line_spacing 是段落属性，无法按单个 run 设置。
  span 内 lineHeight 在**测量与 SVG 预览**按 run 精确生效；PPTX 渲染段落取顶层 `style.lineHeight`
  近似（单个 span 行高差异在 PPTX 中不可表达）。文档注明此边界；
- **baselineAlign 在 PPTX 的保证**：PPTX 文本框内不同字号 run 天然共享段落基线（HTML 文本行为），
  与 SVG 的 alphabetic 语义一致，两处视觉对齐；未对 PPTX 做额外属性写入（无需）；
- **span 嵌套仅承诺 1 层**：≥2 层虽可解析（最内层生效）但超出承诺边界，文档建议拆多 Text
  或用布局组合；解析器对坏标签（多余闭合/未闭合）降级为纯文本不崩溃；
- **--find 匹配范围**：Text 按全文子串匹配（含富文本标签内文本），其他节点按 label 匹配；
  命中多节点时全部输出祖先链；无命中输出提示；
- 全量回归剩 **2 个既有失败**（`test_baseline_fallback_column`、`test_row_text_children`），
  与 task-01~06 基线一致，属第一次任务期遗留，建议后续任务一并评估。
