# 任务文档：MD 渲染图表增强（KaTeX 公式 + ECharts 图表）

> 对应需求编号：20261023-001 ｜ 状态：**已实施（P0/P1/P2 完成，全量回归与人工验证进行中）** ｜ 创建：2026-10-23 ｜ 修订：2026-10-23 实施落盘

## 一、任务目标需求

### 1.1 背景

WebUI 的 Markdown 渲染管线（对话消息 ChatView + 文件查看 FilesView 共用）已支持代码高亮与 Mermaid 图表，但存在三类图表缺口：数学公式（`$..$` / `$$..$$`）原样显示为文本；```echarts 等数据图表代码块按普通代码块高亮；mermaid v12 内置的图内公式因缺 KaTeX 样式未启用。Agent 回复中常含公式与数据图表诉求（推理、统计场景），渲染缺口影响可读性。

### 1.2 现状梳理

| 所需能力 | 框架现状 | 结论 |
| --- | --- | --- |
| md 统一渲染 | `webui/src/markdown.ts`：marked v15 + DOMPurify 消毒 + hljs 高亮，`highlightIn` 已跳过 language-mermaid | 扩展点现成：marked.use 注册公式扩展；跳过列表加 echarts |
| 图表后处理 | `webui/src/mermaid.ts`：```mermaid → SVG + 工具栏/缩放/平移/全屏容器，失败标红降级，串行队列 | 模式成熟，echarts 复用同款容器交互 |
| 容器样式 | `webui/src/mermaid.css`（.mermaid-block 等专用类，两视图共用） | 抽共享或按类名复用 |
| 视图接线 | ChatView.vue:193-194 与 FilesView.vue:521-522 已按「高亮→mermaid」顺序后处理 | 各加一行 echarts 后处理调用 |
| 数学公式 | 无 katex 依赖，`$` 原样输出 | 需新增 katex + marked-katex-extension |
| ECharts | 无 echarts 依赖 | 需新增 echarts（动态 import，不进首包） |
| mermaid 图内公式 | mermaid v12 内置 KaTeX（MathML 输出），样式需宿主提供 | 引入 katex 后 import 其 css 即可启用 |
| 测试 | 主工程 vitest；`tests/webui-chat-stream-abort.test.ts` 已有测 webui 代码先例 | 纯逻辑函数进主工程 tests/ |

### 1.3 任务目标

1. 对话流与文件预览两处支持内联公式 `$..$` 与块级公式 `$$..$$`（KaTeX 排版，失败回退原文）。
2. 支持 ```echarts 代码块（纯 JSON option）渲染为交互图表（缩放/平移/全屏），解析失败标红保留源码。
3. 启用 mermaid 图内 `$$..$$` 公式（KaTeX 字体本地打包）。
4. 明暗主题适配；全部动态加载不影响首包。

### 1.4 设计约束

- 零风险优先：不改 marked+DOMPurify 的安全基线（消毒仍在最后统一执行）。
- 动态 import：katex / echarts 均按需加载（mermaid 同款模式）。
- 离线可用：KaTeX 字体经 vite 打包本地托管，不用 CDN。
- 与现有失败降级风格一致（保留代码块 + 标红类）。

## 二、方案设计

### 2.1 总体思路

```
md 文本（对话段 / md、doc 文件内容）
   │
   ▼
┌─ markdown.ts（编译期）────────────────────────────────┐
│ marked.parse                                          │
│  ├─ marked-katex-extension【D1/D2】$..$ / $$..$$       │
│  │    → KaTeX HTML+MathML 片段                        │
│  └─ ```mermaid / ```echarts 代码块原样输出             │
│ DOMPurify.sanitize【D2】（HTML+SVG+MathML，最后统一消毒）│
└───────────────┬───────────────────────────────────────┘
                ▼ v-html 挂载 → nextTick
┌─ 后处理（ChatView 对话流 / FilesView 预览，顺序接线）───┐
│ highlightIn：跳过 language-mermaid / language-echarts   │
│ renderMermaidIn：mermaid → SVG 容器（现有，共用容器【D3】）│
│ renderEChartsIn【D4】：JSON option → echarts SVG 图表容器 │
└────────────────────────────────────────────────────────┘
```

### 2.2 关键设计决策

- **D1 公式方案选 marked-katex-extension**：marked 官方生态推荐扩展、零依赖（仅 peer katex）、维持 marked 管线；否决 MathJax（体积大、同步渲染慢）与 KaTeX auto-render 后处理（需二次 DOM 扫描、时序复杂、与 v-html 重渲冲突）。选项 `throwOnError: false`（解析失败回退原文）、`nonStandard` 关闭（要求 `$` 定界规范，避免「$5 与 $10」类价格文本误判为公式）。
- **D2 DOMPurify 放行公式输出**：KaTeX 输出为 HTML span + MathML（`<math>`）；DOMPurify 默认 profile 含 HTML+SVG+MathML，理论直接兼容，P0 需实测验证（用典型公式用例核对 `class`、`aria` 属性与 MathML 节点存活）；若被裁剪则按需 `ADD_TAGS/ADD_ATTR` 白名单补充，不关消毒。
- **D3 图表容器抽共享模块 `chart-box.ts`**：把 mermaid.ts 的 buildMermaidBox（工具栏 + 滚轮缩放 + 拖拽平移 + 全屏）抽为共享构建器，caption 参数化（mermaid / echarts），mermaid.ts 改为调用方；否决复制精简版（双份维护、样式漂移）。mermaid 现有交互行为保持不变（回归点）。
- **D4 echarts 仅 JSON 声明式 + SVG 渲染器**：```echarts 代码块内容必须为合法 JSON option（JSON.parse，strict 无执行面，与 mermaid strict 同级安全）；否决 JS 脚本块（VitePress 亦默认禁用，需沙箱超范围）；渲染器选 `svg`（5x 缩放下线条清晰、可被 DOMPurify 生态导出），否决 canvas（缩放模糊）；解析/初始化失败降级为标红代码块（`.echarts-err`，同 mermaid-err 模式）。
- **D5 新增三个 webui 依赖**：`katex`、`marked-katex-extension`、`echarts`；echarts 约 1MB 由动态 import 按需加载，katex 字体随 css 打包本地托管；全部进 webui/package.json，主工程零改动。
- **D6 顺带启用 mermaid 图内公式**：mermaid v12 内置 KaTeX（MathML），引入 katex 依赖后在应用入口 import `katex/dist/katex.min.css` 一次即可覆盖「独立公式 + mermaid 图内公式」两处，无额外接线。
- **D7 主题适配**：KaTeX 为纯 CSS 排版天然随主题；echarts 渲染时读取当前主题（`data-theme`，逻辑同 mermaid.ts）选明暗配色并设背景透明；主题切换的已渲染图表通过 MutationObserver 监听 `html[data-theme]` 触发重渲（对话流与文件预览共用监听），否决「重开文件才生效」（体验断裂）。
- **D8 单测策略**：纯逻辑（echarts option JSON 提取校验、语言块判定、主题读取）抽为可导出函数，放主工程 `tests/`（webui-chat-stream-abort.test.ts 先例）；DOM 集成（公式排版、图表容器交互）列入「人工验证」清单，不为 WebUI 引入 jsdom 环境。

## 三、任务详细设计

### 3.1 markdown.ts（公式编译期接入）

```ts
import markedKatex from 'marked-katex-extension';
marked.use(markedKatex({ throwOnError: false })); // 模块级注册一次
// highlightIn 跳过列表：language-mermaid + language-echarts
```

### 3.2 echarts.ts（新建，图表后处理）

```ts
export function renderEChartsIn(root: HTMLElement): Promise<void>;
// 复用 mermaid.ts 的串行队列模式：扫 pre>code.language-echarts
// → extractEChartsOption(text)（导出纯函数，供单测）
// → 动态 import('echarts') → init(el, themeName, { renderer:'svg' }) → setOption
// → 挂入 chart-box 容器；失败：清理占位 + pre 加 .echarts-err 标红
```

### 3.3 chart-box.ts（新建，自 mermaid.ts 抽取）

```ts
export interface ChartBox { el: HTMLDivElement; fit(): void; onResize(cb: () => void): void }
export function buildChartBox(content: HTMLElement | string, caption: string): ChartBox;
// content 为 svg 标记字符串（mermaid）或待挂载 div（echarts）
// onResize：全屏切换/fit 后回调，echarts 用它调 chart.resize()
```

### 3.4 视图接线与入口样式

- ChatView.vue：mermaid 后处理后追加 `void renderEChartsIn(msgsEl.value)`。
- FilesView.vue：md 预览分支与「切回预览」分支同上加一行。
- 应用入口 import `katex/dist/katex.min.css`【D6】。
- mermaid.css 中容器类迁移/别名为 chart-box 通用类，`.mermaid-err` / `.echarts-err` 标红规则并列。

### 3.5 边界与错误处理

| 场景 | 行为 |
| --- | --- |
| 公式语法错误 | throwOnError:false → KaTeX 输出红色错误片段，不阻断整段渲染 |
| `$` 价格类文本 | 标准 nonStandard=false 定界规则，绝大多数不误判；误判成本可接受 |
| echarts JSON 非法 | 标红保留源码（.echarts-err），控制台警告原因 |
| echarts 动态加载失败 | 静默保留代码块（同 mermaid 加载失败路径） |
| DOMPurify 裁剪公式节点 | P0 实测，按需 ADD_TAGS/ADD_ATTR，不关消毒【D2】 |
| 消息流式重渲/v-html 更新 | 后处理幂等（已渲染块被替换后重扫，同 mermaid 现行为） |

### 3.6 演进项（本任务不做）

MathJax、JS 脚本式图表块、```chartjs/```plantuml 等更多语言块、公式号/引用、图表导出 PNG。

## 四、实施计划

| 阶段 | 内容 | 交付物 |
| --- | --- | --- |
| P0 核心链路 | katex+扩展接入并通过 DOMPurify 实测【D2】；echarts.ts 基础渲染（JSON→图）；两视图接线 | 公式与图表在两处可渲染 |
| P1 完整体验 | chart-box.ts 抽取与 mermaid.ts 改造【D3】；缩放/平移/全屏/resize；明暗主题+切换重渲【D7】；mermaid 图内公式启用【D6】；失败降级完善 | 交互与主题达到 mermaid 同级体验 |
| P2 收口 | 纯逻辑单测进 tests/；README 中英 web-ui.md 渲染能力章节同步；台账回填 | 文档与测试齐全，全量回归绿 |

## 五、文件清单

| 文件 | 改动 | 阶段 |
| --- | --- | --- |
| webui/package.json | +katex、marked-katex-extension、echarts | P0 |
| webui/src/markdown.ts | marked.use 公式扩展；hljs 跳过 echarts 块 | P0 |
| webui/src/echarts.ts | 新建：renderEChartsIn + extractEChartsOption 纯函数 | P0 |
| webui/src/views/ChatView.vue | 追加 renderEChartsIn 接线 | P0 |
| webui/src/views/FilesView.vue | md 预览与切回预览两分支追加接线 | P0 |
| webui/src/chart-box.ts | 新建：自 mermaid.ts 抽共享容器 | P1 |
| webui/src/mermaid.ts | 改用 chart-box；无行为变化回归 | P1 |
| webui/src/mermaid.css | 容器类通用化 + echarts-err 样式 | P1 |
| webui/src/main.ts | import katex.min.css | P1 |
| tests/webui-md-chart.test.ts | 新建：纯逻辑单测 | P2 |
| docs/readme/zh/web-ui.md、en/web-ui.md | 渲染能力文档同步 | P2 |
| docs/requirements/需求.md | 完成后回填状态 | P2 |

## 六、任务验收清单

### 6.1 P0
- [x] `$E=mc^2$` 行内公式与 `$$..$$` 块级公式在对话流渲染为 KaTeX 排版（代码接入完成，真机确认见 6.4）
- [x] 同公式在 FilesView md 预览（预览模式）渲染正确（同上，接入点 FilesView 两分支）
- [x] DOMPurify 消毒后 KaTeX MathML/样式节点存活（实测记录）【D2】→ node 端摸底：KaTeX 输出为 `span.katex > span.katex-mathml > math[xmlns]` 结构，DOMPurify 默认 profile 含 MathML；node 无 DOM 无法完整验证，浏览器端确认列入 6.4
- [x] ```echarts JSON 代码块渲染为 SVG 图表（对话流 + 文件预览）（echarts.ts + 两视图接线完成）
- [x] 非法 JSON 标红保留源码；hljs 不再给 echarts 块上高亮（.echarts-err + highlightIn 跳过）
- 完成记录：katex/marked-katex-extension/echarts 已装入 webui；markdown.ts 注册公式扩展（throwOnError:false、nonStandard 关闭）；echarts.ts 串行队列 + extractEChartsOption 纯函数；ChatView/FilesView 接线完成。

### 6.2 P1
- [x] mermaid 图表交互行为与改造前一致（缩放/平移/全屏回归）（交互代码原样抽取至 chart-box.ts，mermaid.ts 改为调用方）
- [x] echarts 图表具备同款工具栏：放大/缩小/适应宽度/全屏/滚轮缩放/拖拽平移（共用 chart-box）
- [x] 暗色/亮色主题下公式与图表配色正确；切换主题已渲染图表自动重渲（MutationObserver + matchMedia 双监听，主题 init 固化故 dispose 重建；真机确认见 6.4）
- [x] mermaid 图内 `$$..$$` 公式渲染（KaTeX 字体本地加载，断网可用）（main.ts import katex.min.css，构建产物含全量 KaTeX 字体文件）
- [x] 动态 import 验证：首包产物不含 echarts/katex 主体 → **偏差记录**：echarts/mermaid 确认为独立异步分包（约 1.1MB / 654KB）；katex 主体（约 311KB）随入口打包——marked-katex-extension 为编译期同步渲染，异步化收益低且增复杂度，字体文件仍由浏览器按需拉取
- 完成记录：chart-box.ts 抽取完成（新增 onResize/remeasure 接口支撑 echarts 动态尺寸）；mermaid.css 补 .echarts-host/.echarts-err；webui `npx tsc --noEmit` 本任务文件零错误（另有 chat-stream.ts 两处存量类型错误，属 20261022-001 遗留、本任务未触碰）；webui `npm run build` 成功。

### 6.3 P2
- [x] tests/webui-md-chart.test.ts 覆盖 extractEChartsOption 等纯函数（含非法输入）（5 用例全绿）
- [x] npx tsc --noEmit 通过；npx vitest run 全量回归绿（主工程 tsc exit 0；vitest run 94 文件 / 979 用例全绿，156.9s）
- [x] README 中英 web-ui.md 渲染能力说明同步（新增「富内容渲染（公式与图表）」/「Rich Content Rendering (Math & Charts)」小节）
- [x] 需求台账回填「是 + 完成时间」（2026-10-23）
- 完成记录：D2 浏览器端实测补齐——headless Edge 验证 DOMPurify 消毒：默认 profile 保留视觉层与 aria 属性但裁剪 MathML 语义层 semantics/annotation → markdown.ts 按 ADD_TAGS/ADD_ATTR 白名单补齐（semantics/annotation/encoding），复测 katex/math/semantics/html 层全部存活，消毒基线未动。

### 6.4 人工验证（真实环境）
- [ ] `npm run dev`（webui）真机走查：含公式+mermaid+echarts 混排的对话与 md 文件
- [ ] 全屏下图表缩放与拖拽手感；移动端触摸滚动不受劫持影响
- [ ] 长对话多次重渲（切会话来回）无重复渲染/内存泄漏迹象

## 修订历史

- 2026-10-23 实施：①D2 实测结论——DOMPurify 默认 profile 裁剪 KaTeX MathML 语义层，已按白名单 ADD_TAGS=['semantics','annotation']、ADD_ATTR=['encoding'] 补齐（不关消毒）；②D5 偏差——katex 主体随入口打包（编译期同步渲染，异步化收益低），echarts/mermaid 保持独立异步分包，字体按需拉取；③D3 落地补充——chart-box 增加 onResize/remeasure 接口支撑 echarts 动态尺寸与缩放重绘。
