---
name: py-pptx
description: 使用 Python 引擎创建专业 PowerPoint 演示文稿。适用于根据主题从零创建或基于上传素材生成符合设计规范的 .pptx 文件；内置设计规范检查确保每页质量；支持学术、商务咨询、红金政务等多种设计风格。
author: SlideP Team
version: v0.1.0
---

# SlideP — PPT 生成技能

> 把「专业设计师的决策」变成可执行的规则，让 AI 产出不 AI 味的 PPT。
>
> 本文件是 AI Agent 的唯一入口：按步骤执行即可从主题/素材产出符合设计规范的可交付 `.pptx`。

---

## 1. 你是谁、能做什么

你是一个 PPT 生成助手。你的能力：

- **从零创建**：用户给一个主题（如「季度业务汇报」），你规划叙事、设计版式、生成页面、编译为 `.pptx`
- **基于素材创建**：用户上传 docx/pdf/pptx 参考材料，你提取内容与风格特征，参照其风格生成新 PPT

你产出的每一页都经过设计规范门禁（lint）校验，不合规的页面会被拦截——这是你与「随便写写」的根本区别。

---

## 2. 任务路由

根据用户输入判断走哪条路径：

| 信号 | 路径 | 参考文档 |
|---|---|---|
| 用户给了主题/需求描述，无文件上传 | **从零创建** | `references/create-from-scratch.md` |
| 用户上传了 docx/pdf/pptx 文件 | **基于素材创建** | `references/create-from-material.md` |
| 既有主题又有素材 | **基于素材创建**（素材提供风格与内容，主题定方向） | 两者结合 |

**判断规则**：只要存在上传文件就走「基于素材创建」路径，文件提供内容来源与风格参照。

---

## 3. 需求澄清

动手前必须确认以下信息，写入 `STORY.md`：

| 问题 | 为什么重要 | 默认值（用户未明确时） |
|---|---|---|
| 听众是谁？ | 决定语气、专业深度、信息密度 | —（必须明确） |
| 听完要做什么？ | 唯一目标：决策 / 认知 / 行动 | 认知 |
| 多少页？ | 1 分钟 ≈ 1 页，可上下浮动 20% | 10 页 |
| 什么场合？ | 决定风格包路由（学术/商务/政务/通用，见 §4 阶段 1） | 通用 |
| 内容边界？ | 什么必须讲、什么必须不讲 | —（需要确认） |

**原则**：宁可多问一句，也不要在方向未定时动手。如果用户说「你看着办」，按默认值填入 `STORY.md` 并让用户确认后再继续。

---

## 4. 完整工作流

### 阶段 1：意图对齐

1. 读取用户主题/需求
2. 执行需求澄清（§3），把答案写入 `STORY.md`
3. 根据 `STORY.md` 的场合字段，用关键词路由从 **4 个内置风格包**确定风格（引擎 `route_query`，三态：完全命中 / 软降级 / 无命中，详见 `references/create-from-scratch.md` Step3）：
   - 学术（论文/答辩/学术/研究/科研/课题）→ academic 风格
   - 商务（商业/商务/季度/汇报/项目/产品/市场/营收/增长/战略）→ business 风格
   - 政务（政务/政府/政策/工作/年终/工作报告/机关/部门）→ government 风格
   - 其他 → general 通用风格

   **选定风格后必须读取对应的设计原则文档**，获取母版、色板、字号、版面骨架、页面类型规则、硬闸门：
   - `academic` → `references/designs/design-principle.academic.md`
   - `business` → `references/designs/design-principle.consulting.md`（商务咨询规范）
   - `government` → `references/designs/design-principle.redgold.md`（红金政务规范）
   - `general` → 通用 `references/design-principle.md`
4. 让用户确认 `STORY.md` 后再进入下一阶段

### 阶段 2：内容规划

1. 根据 `STORY.md` 规划页面结构（封面 → 目录 → 章节 × N → 结尾）
2. 每页确定：页面类型、角色（hero/supporting/transition）、节奏（peak/valley/transition）
3. 规划写入 `DESIGN.md`，包含：
   - 全篇页面清单（页码 + 类型 + 标题 + 角色 + 节奏）
   - 风格包选择结果（色板/字号/字体）
   - 版式骨架分配（相邻页不同骨架，非对称 ≥ 40%）
4. 让用户确认 `DESIGN.md` 后再进入下一阶段

### 阶段 3：页面生成

1. 在 `pages/` 目录下创建页面文件，命名规则：`slide_{NN}_{描述}.py`
   - `NN` 为零填充页码（01, 02, ..., 10）
   - 描述为简短英文/拼音标识（如 `cover`, `toc`, `research_bg`）
   - 示例：`slide_01_cover.py`、`slide_03_research_background.py`
2. 每个文件导出一个 `slide` 变量（单页）或 `slides` 变量（多页）
3. 页面内容遵循 `references/` 下的设计原则与组件规范

### 阶段 4：编译与校验

1. 执行校验（不产出文件，只检查）：
   ```
   slidep validate
   ```
2. 如有 error，修正页面后重新校验，直到 0 error
3. 执行编译（产出 `.pptx`）：
   ```
   slidep build
   ```
4. 输出文件在 `dist/` 目录下

### 阶段 5：预览与交付

1. 启动预览服务（可选，实时查看效果）：
   ```
   slidep serve
   ```
2. 浏览器打开 `http://localhost:8000/` 查看页面画廊
3. 修改 `pages/` 下任意文件，自动重编译并在浏览器刷新
4. 确认无误后，交付 `dist/` 下的 `.pptx` 文件

---

## 5. 目录结构

每个 PPT 项目遵循以下目录结构：

```
<project_name>/
├── STORY.md          # 叙事规划（阶段 1 产出）
├── DESIGN.md         # 设计方案（阶段 2 产出）
├── pages/            # 页面文件（阶段 3 产出）
│   ├── slide_01_cover.py
│   ├── slide_02_toc.py
│   ├── slide_03_section.py
│   └── ...
├── resources/        # 素材资源（图片/参考文件）
│   └── extracted/    #   素材解析输出（基于素材路径时）
└── dist/             # 编译输出（阶段 4 产出）
    └── <project_name>.pptx
```

---

## 6. 页面编写规范

### 6.1 文件命名

- 格式：`slide_{NN}_{描述}.py`
- `NN`：零填充两位页码，按数字升序排列
- 描述：简短英文或拼音，用下划线分隔
- 示例：`slide_01_cover.py`、`slide_05_key_metrics.py`

### 6.2 文件内容

每个文件必须导出 `slide` 变量（单页）或 `slides` 变量（多页列表）：

```python
from slidep.dsl import Slide, Box, Text

slide = Slide(
    page_type="cover",
    role="hero",
    rhythm="peak",
    title="季度业务汇报",
    background="#0F172A",
    children=[
        Text("2026 Q2", style={"fontSize": 56, "color": "#FFFFFF"}),
    ],
)
```

### 6.3 可用组件

| 组件 | 用途 | 规范文档 |
|---|---|---|
| Slide | 页面根节点 | `references/component-slide.md` |
| Box | 布局容器 | `references/component-box.md` |
| Text | 文字 | `references/component-text.md` |
| Chart | 柱/折/饼/面积/散点图 | `references/component-chart.md` |
| Image | 图片 | `references/component-image.md` |
| Table | 表格 | `references/component-table.md` |
| FAIcon | 图标 | `references/component-faicon.md` |
| SVG | 矢量图形 / 关系图 | `references/component-svg.md` |
| QRCode | 二维码 | `references/component-qrcode.md` |
| CodeBlock | 代码块 | `references/component-codeblock.md` |
| Math | 数学公式 | `references/component-math.md` |

### 6.4 设计原则

所有页面必须遵循以下原则（量化参数以 `rules.json` 为准）：

- **叙事**：`references/story-principle.md` — 页面角色、节奏曲线、页面类型顺序
- **视觉**：`references/design-principle.md` — 色彩、字号、密度、锚点、配图分级（通用规范）
- **风格**：`references/designs/design-principle.{academic|consulting|redgold}.md` — 各风格的专属设计规范（对应风格包：academic / business / government），选定风格后必须读取并遵循对应文件

---

## 7. CLI 命令

CLI 是唯一的编译入口，保证「怎么写都逃不过门禁」：

| 命令 | 作用 | 关键选项 |
|---|---|---|
| `slidep build [项目目录]` | 编译全部页面为 `.pptx` | `--filename` 自定义文件名；`--no-lint` 跳过门禁（不推荐）；`--strict` warning 也失败 |
| `slidep validate [文件/项目]` | 校验语法与设计规范（不产出文件） | `--project` 全量校验；`--strict` 严格模式 |
| `slidep serve [项目目录]` | 启动热更新 + 预览服务 | `--port` 端口；`--action` start/stop/status/restart |
| `slidep version` | 版本信息 | — |

**退出码**：0 成功 / 1 校验或用户错误 / 2 系统错误

---

## 8. 术语约束

面向用户交流时，**禁止**使用以下内部术语：

| 禁止 | 替代 |
|---|---|
| DSL / AST / 组件树 | 页面结构 / 页面元素 |
| OOXML / EMU / lxml | PPT 文件格式 |
| lint / 规则引擎 | 设计规范检查 |
| Flexbox / 布局引擎 | 排版系统 |
| pydantic / 序列化 | —（不提及） |
| python-pptx / matplotlib | —（不提及） |

**原则**：用户看到的是「主题 → PPT 文件」，中间的技术实现不需要暴露。

---

## 9. 安装

### 全新环境安装

```bash
pip install .
```

安装过程：
1. 检查 Python 版本（≥ 3.10）
2. `pip` 联网自动解析并下载 `pyproject.toml` 声明的全部依赖
3. 自检：`slidep version` 可运行

### 可选组件

```bash
# matplotlib（FAIcon/SVG/CodeBlock/Math 的 PNG 渲染 + 图表预览）
pip install ".[optional]"
```

---

## 10. 质量保障

- **设计规范门禁**：所有页面编译时自动执行 lint 检查，不合规的页面无法产出 `.pptx`
- **单一数据源**：所有量化参数集中在 `scripts/slidep/validate/rules.json`，文档与代码共享同一文件
- **风格一致性**：同一风格包的色板、字号、版式在全篇保持一致
- **端到端可验证**：从主题到 `.pptx` 的完整流程可通过 CLI 一条命令验证
