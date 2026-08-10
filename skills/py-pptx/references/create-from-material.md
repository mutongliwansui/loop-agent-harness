# 基于素材构建 PPT 的教程（Create from Material）

> 用户上传 docx/pdf/pptx 参考素材时，先用解析管线提取素材的「内容 + 风格特征」，再参照素材风格生成新 PPT。
>
> 本文件是 `SKILL.md` 的子文档，是「基于素材创建」路径的入口；素材解析完成后，页面生成等后续步骤遵循 [create-from-scratch.md](create-from-scratch.md) 的标准流程。

---

## 快速命令（核心操作）

| 任务类型 | 操作 |
| :--- | :--- |
| 解析素材（内容 + 风格 + 图片，一次完成） | `doc, profile = extract_material("素材.docx", output_dir="resources/extracted/")` |
| 查看素材风格预览 | 读取 `resources/extracted/preview_grid.png`（9 宫格，仅 pptx 源生成） |
| 生成参照风格包 | `pack = generate_from_profile(profile)` |

解析以编程方式调用（`from slidep.extract import extract_material`）；引擎 CLI 不提供解析命令。提取产物统一落在 `resources/extracted/`：

| 产物 | 说明 |
| :--- | :--- |
| `content.json` | 结构化内容：标题层级 + 段落 + 图片引用（`ExtractedDocument`） |
| `style_profile.json` | 风格特征：主色 / 面积占比 / 字号直方图 / 字体 / 预览图路径（`StyleProfile`） |
| `preview_grid.png` | 素材页面 9 宫格预览（**仅 pptx 源**生成） |
| `images/` | 从素材中提取的原始图片 |

---

## 严格遵循约束

1. **素材只解析一次**，解析结果以 `content.json` / `style_profile.json` / `images/` 为准，禁止反复读取或重新解析素材文件；
2. **学习素材版式**：pptx 素材读取 `preview_grid.png` 9 宫格了解其页面结构；docx/pdf 素材通过 `content.json` 的层级结构推断内容组织方式；
3. **必须审核素材图片质量**：`images/` 中图片清晰、完整且满足要求 → 直接在 PPT 中引用素材原图（更符合用户需求），禁止滥用生图工具；若图片模糊、不完整或不适用，则考虑其他方式（重新截图或生图）；
4. **高置信度场景**（财务数据分析、学术科研汇报、法律政策解读等）：不仅 PPT 的**文本内容**要严格来源于素材原文，更要**优先提取并直接使用素材中原有的图片、图表和数据**，保持信息绝对准确一致，**严禁用 AI 生图替代素材中的真实配图**；
5. 素材中没有的图片不要编造路径；图片缺失或路径非法是错误，不是警告。

---

## 创建流程

### 制定任务计划

> **任务命名约束（强约束）**：本表仅为内部执行参考。在创建 TODO / 任务或向用户汇报进度时，**必须使用面向用户的术语**（如「读取素材 / 内容大纲 / 风格设计 / 创建演示文稿 / 逐页制作 / 检查页面 / 交付」），**禁止暴露任何内部实现字眼**（如 `DSL`、`*.py`、`slidep`、`OOXML`、`success=true`、源码、组件文件名等）。

| Step | 职责（内部） | 产物（内部） |
| ---- | ---------------------------------------------------------------- | ------------------------------------------------ |
| 1    | 素材解析：素材放入 `resources/`，执行解析管线 | `resources/extracted/`（content.json / style_profile.json / preview_grid.png / images/） |
| 2    | 需求澄清 + 依据素材与主题构建 PPT 的叙述逻辑 | `STORY.md` |
| 3    | 参照风格生成（基于风格特征）+ 内容规划（基于素材内容） | `DESIGN.md`（参照风格包） |
| 4    | 逐页生成 PPT（在 `pages/` 下按大纲顺序写完全部页面源文件） | 全部页面源文件 |
| 5    | 校验页面（`slidep validate`，设计规范门禁） | 全部页面校验通过 |
| 6    | 编译产出 `.pptx`（`slidep build`） | `dist/*.pptx` |
| 7    | 启动预览（`slidep serve`，可选） | 预览画廊已打开，用户可实时观察 |
| 8    | 交付 | 目标 `.pptx` 已交付给用户 |

### Step1：素材解析

1. 将用户上传的素材文件放入项目 `resources/` 目录；
2. 执行素材解析（支持 docx / pdf / pptx）：

```python
from slidep.extract import extract_material

doc, profile = extract_material("resources/参考材料.pptx", output_dir="resources/extracted/")
```

3. 读取 `content.json` 了解素材内容结构（标题层级、段落、图片引用）；
4. 读取 `style_profile.json` 了解素材风格特征（色板、字号直方图、字体家族、预览图路径）；
5. 若为 pptx 素材，查看 `preview_grid.png` 9 宫格了解页面版式。

**错误处理**（解析失败抛 `SlidepUserError`，按错误码处理）：

| 错误码 | 含义 | 处理 |
| :--- | :--- | :--- |
| `IO_FILE_NOT_FOUND` | 素材文件不存在 | 检查路径后重新解析 |
| `IO_FORMAT_UNSUPPORTED` | 格式不支持（仅支持 docx/pdf/pptx） | 提示用户转换格式 |
| `IO_EXTRACTION_FAILED` | 提取失败 | 报告失败原因，必要时换格式 |

### Step2：需求澄清 + 构建叙事逻辑（STORY.md）

遵循 [create-from-scratch.md](create-from-scratch.md) 的 Step2。额外确认：

- 素材与新 PPT 的关系：内容复用 / 仅风格参照 / 两者都要；
- 哪些素材内容**必须**出现在新 PPT 中，哪些**不需要**。

将确认结果与叙事规划写入 `STORY.md`，并向用户确认后进入下一步。

### Step3：参照风格生成 + 内容规划（DESIGN.md）

#### 参照风格生成

**不走内置风格路由**（4 个内置风格包适用于从零创建），素材路径基于 `style_profile.json` 生成一次性参照风格包：

```python
from slidep.designs import generate_from_profile
from slidep.extract import StyleProfile
import json

with open("resources/extracted/style_profile.json", encoding="utf-8") as f:
    profile = StyleProfile(**json.load(f))

pack = generate_from_profile(profile)
# pack.tokens.palette / font_size_ladder / font_families / lint_overrides
```

生成规则（引擎实证）：

| 特征 | 规则 | 不足时的兜底 |
| :--- | :--- | :--- |
| 主色 `palette.primary` | 主色列表第 1 色（按面积降序） | 默认 `#1E293B` |
| 辅色 `palette.secondary` | 第 2 色 | 默认 `#3B82F6` |
| 强调色 `palette.accent` | 第 3 色 | 默认 `#F59E0B` |
| 字号阶梯 `font_size_ladder` | 按字号直方图推断：最大→hero、次大→title、中位→body、最小→caption | 默认阶梯 |
| 字体 `font_families` | 取前 2 个字体家族 | 默认 `Microsoft YaHei` |
| lint 豁免 `lint_overrides` | 自动加入 `typography.size_ladder`，使推断字号通过 lint | — |

风格包 `id="referenced"`、名称为「参照风格」。**约束**：参照色板超出主题色 ≤ 4 个的 lint 限制时，取前 3 色 + 中性色；参照风格不豁免其他 lint 规则。

#### 内容规划

1. 从 `content.json` 中筛选需要复用的内容（标题、段落、图片），结合 `STORY.md` 的页数预算组织到页面；
2. 每页标注内容来源：素材复用（注明素材位置）/ 素材复用 + AI 扩展 / AI 创作；
3. 将参照风格包信息（色板 / 字号 / 字体）、页面清单、内容来源标注写入 `DESIGN.md`，并向用户确认后进入下一步。

### Step4：逐页生成 PPT（按大纲顺序）

遵循 [create-from-scratch.md](create-from-scratch.md) 的 Step4（含动笔前必读、10 条硬约束自检），素材路径下的差异：

- 图片路径指向 `resources/extracted/images/` 下的**素材原图**（经质量审核通过后引用），不重新生图；
- 色板 / 字号 / 字体使用参照风格包的值（`pack.tokens`）；
- 内容文本优先来自 `content.json`，高置信度场景必须使用素材原文。

### Step5：校验页面

遵循 [create-from-scratch.md](create-from-scratch.md) 的 Step5：全量执行 `slidep validate`，修复至 0 error。

### Step6：编译产出 `.pptx`

遵循 [create-from-scratch.md](create-from-scratch.md) 的 Step6：执行 `slidep build`，产出 `dist/*.pptx`。

### Step7：启动预览（可选）

遵循 [create-from-scratch.md](create-from-scratch.md) 的 Step7：执行 `slidep serve`，浏览器查看页面画廊。

### Step8：交付

遵循 [create-from-scratch.md](create-from-scratch.md) 的 Step8：使用面向用户的语言（禁用 `slidep` / `OOXML` / `DSL` 等内部字眼）交付 `dist/` 下的 `.pptx`。

---

## 生成后的编辑（后续行为指导）

**PPTX 交付后，用户提出修改需求时，回到本项目 `pages/` 下对应的页面源文件进行修改，修改后重新执行 `slidep validate`（可选）与 `slidep build` 重新编译；若预览服务运行中，改动会自动反映到预览画廊。**
