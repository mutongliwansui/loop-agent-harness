# DESIGN.md — AI 赋能高效工作

## 风格路由判断

- 主题：「AI 如何协助工作、提升效率」
- 关键词命中："工作" 命中 government 包硬关键词（matched），但该场景为**技术分享/内部培训**，属「大量常见场景走通用设计原则」的情形（预设风格不应泛化到垂直领域之外）。按 `create-from-scratch.md` Step3 判断原则，**选择 general 通用风格**（深色科技调性），不采用红金政务规范。分支常量值层不适用，色板由本项目原创。

## 设计令牌（DESIGN TOKENS）

全篇组件内颜色严格 ≤ 4 hex（lint：`color.max_theme_colors`）：

| 角色 | Hex | 用途 |
|---|---|---|
| 背景色 | `#0F172A` | Slide 背景、深色卡片底、SVG 节点底 |
| 文字色 | `#FFFFFF` | 主标题、正文、次级文字（靠字号/字重区分层级） |
| 主色 | `#3B82F6` | 图标（FAIcon/Math）、边框、SVG 主色、强调词、数据条 |
| 强调色 | `#F59E0B` | 巨型数字锚点、CTA、关键数据高亮 |

- 字号阶梯（lint 强制）：hero 56–72 / 标题 32–40 / 正文 18–24 / 辅助 12–16
- 字体：`Microsoft YaHei` + `Arial`（正文/标题）
- 锚点策略：每个 content 页至少 1 个 56–64px 巨型数字或 ≥40% 面积图表
- 图表内置色板、表格引擎样式、SVG 内部 fill、QRCode/CodeBlock 位图均不参与主题色统计

## 页面清单（页面映射表）

| # | 文件 | 类型 | 角色 | 节奏 | 骨架 | L1/L2 图 | 字数 | 留白 | 色彩分配 | 关键约束 |
|---|---|---|---|---|---|---|---|---|---|---|
| 01 | slide_01_cover.py | cover | hero | peak | 全屏视觉+骑线文字 | ai_network.png(背景) | 30 | 35% | 主60%辅30% | 渐变背景+FAIcon 装饰 |
| 02 | slide_02_toc.py | toc | transition | transition | 左标题+右条目 | — | 120 | 25% | 主40%辅25% | 4 条目录，每条 ≥ 20 字 |
| 03 | slide_03_time_usage.py | content | supporting | valley | chart-led（左图右字） | barChart | 220 | 28% | 主45%辅20% | 正文 ≥ 180 字；图表占 B 区 ≥ 40% 作锚点 |
| 04 | slide_04_ai_workflow.py | content | supporting | valley | 上流程下说明（SVG） | SVG 流程 | 220 | 26% | 主45%辅25% | 正文 ≥ 180 字；SVG 节点 ≥ 44px 文字锚点 |
| 05 | slide_05_productivity.py | content | hero | peak | hero-split（大字+双图） | lineChart + scatterChart | 200 | 32% | 强调20%爆发 | 巨型数字 64px 锚点；双图并排 |
| 06 | slide_06_scenarios.py | content | supporting | valley | card-row（6 卡） | image.ai_workspace.png | 240 | 24% | 主50%辅20% | card-row ≤ 2 页；图片 ≥ 280×180 |
| 07 | slide_07_tool_matrix.py | content | supporting | valley | 左表右说明（two-column） | Table | 260 | 24% | 主45%辅25% | 表格 4 列 6 行；正文 ≥ 180 字 |
| 08 | slide_08_roi.py | content | supporting | valley | 左公式右饼图（two-column） | Math + pieChart | 220 | 26% | 主45%辅25% | 公式 ≥ 44px 锚点；饼图 ≥ 40% B 区 |
| 09 | slide_09_automation.py | content | supporting | valley | 左代码右说明 | CodeBlock | 200 | 26% | 主45%辅25% | 代码 ≥ 40% B 区锚点；正文 ≥ 180 字 |
| 10 | slide_10_ending.py | ending | hero | peak | 居中号召+扫码 | QRCode | 60 | 35% | 主40%辅20% | 二维码真实链接；CTA 56px |

## 骨架与节奏检查

- 相邻页骨架不同 ✓（cover→bullet-flow→chart-led→流程→hero-split→card-row→two-column→two-column→代码→居中）
- 对称骨架：P1 / P2 / P6 / P10 = 4 页 ≤ 60% ✓（非对称 60% ≥ 40%）
- card-row：仅 P6 = 1 页 ≤ 2 ✓
- hero 页：P1 / P5 / P10 = 30%（20%–30%）✓

## 内容与组件覆盖核对

Slide / Box / Text / Chart（bar+line+scatter+pie）/ Image / Table / FAIcon / SVG / QRCode / CodeBlock / Math —— 全部 11 组件覆盖。
