# Task-12：Skill 能力集成

## 需求目标

实现 Agent Skill 技能包能力，支持从全局 `~/.loop-agent/skills/` 和工作空间 `<cwd>/.loop-agent/skills/` 两个目录自动扫描 Skill，将 Skill 元信息注入系统提示词，并支持按需渐进式加载 Skill 详细内容。

### 目标清单
1. 实现 Skill 扫描器，自动发现全局和工作空间的 Skill
2. 解析 `SKILL.md` 的 YAML frontmatter（name + description）
3. 将 Skill 元信息注入 System Prompt，供 LLM 发现和选择
4. 实现渐进式加载：LLM 选定 Skill 后再加载完整内容
5. 支持 Skill 的优先级：工作空间 Skill > 全局 Skill
6. CLI 命令支持 Skill 管理（`/skill` 系列命令）
7. Skill 目录示例和文档完善

## 实现方案

### 1. Skill 目录结构

```
~/.loop-agent/                    # 用户目录
├── skills/                       # 全局 Skill（所有项目可用）
│   ├── pdf-processing/
│   │   └── SKILL.md
│   └── web-research/
│       └── SKILL.md
│
<current-workspace>/              # 当前项目
├── .loop-agent/skills/           # 工作空间 Skill（仅当前项目可用，优先）
│   └── custom-deploy/
│       ├── SKILL.md
│       ├── scripts/              # 可选：执行脚本
│       ├── references/          # 可选：参考文档
│       └── assets/               # 可选：模板/资源
```

### 2. SKILL.md 格式规范

```markdown
---
name: pdf-processing
description: Extract text and tables from PDF files, fill forms, merge documents.
---

# PDF Processing

## When to use this skill
Use this skill when the user needs to work with PDF files...

## How to extract text
1. Use pdfplumber for text extraction...

## How to fill forms
...
```

**YAML Frontmatter 字段**：
| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | Skill 唯一标识，用于 LLM 匹配和调用 |
| `description` | ✅ | 简短描述，LLM 据此判断何时使用该 Skill |

### 3. 核心类型定义

```typescript
// src/skill/types.ts

export interface SkillMetadata {
  name: string;           // 从 YAML frontmatter 提取
  description: string;    // 从 YAML frontmatter 提取
  path: string;           // SKILL.md 绝对路径
  dir: string;            // Skill 文件夹路径
  scope: 'global' | 'workspace';
}

export interface SkillContent {
  metadata: SkillMetadata;
  fullContent: string;    // SKILL.md 完整正文
  body: string;           // frontmatter 之后的正文部分
}

export interface SkillLoader {
  /** 扫描所有 Skill（全局 + 工作空间），返回元信息列表 */
  scan(): Promise<SkillMetadata[]>;

  /** 按名称加载 Skill 完整内容（渐进式加载） */
  load(name: string): Promise<SkillContent | null>;

  /** 获取所有 Skill 的元信息用于提示词注入 */
  list(): SkillMetadata[];
}
```

### 4. Skill 加载流程

```
启动时：
  1. 扫描 ~/.loop-agent/skills/  → 全局 Skill 元信息
  2. 扫描 <cwd>/.loop-agent/skills/   → 工作空间 Skill 元信息
  3. 合并去重（工作空间优先）
  4. 将所有 SkillMetadata 注入 System Prompt

运行时：
  1. LLM 根据用户意图选择 Skill
  2. Agent 检测到意图 → 调用 skillLoader.load(name)
  3. 读取 SKILL.md 完整正文
  4. 追加到上下文 messages 中
  5. LLM 基于 Skill 详细说明继续推理
```

### 5. 新增文件

```
src/skill/
├── types.ts          # SkillMetadata / SkillContent 类型定义
├── loader.ts         # SkillLoader：扫描、解析、加载
├── scanner.ts        # 文件系统扫描 + YAML frontmatter 解析
└── index.ts          # 模块聚合入口
```

### 6. 关键模块实现

#### scanner.ts — SKILL.md 解析

```typescript
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import type { SkillMetadata } from './types.js';

/** 解析 SKILL.md 的 YAML frontmatter */
export function parseSkillMd(filePath: string): { name: string; description: string; body: string } | null {
  const content = readFileSync(filePath, 'utf-8');
  // 匹配 --- ... --- 之间的 YAML
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return null;

  const yaml = match[1];
  const nameMatch = yaml.match(/^name:\s*(.+)$/m);
  const descMatch = yaml.match(/^description:\s*(.+)$/m);
  if (!nameMatch || !descMatch) return null;

  return {
    name: nameMatch[1].trim().replace(/['"]/g, ''),
    description: descMatch[1].trim().replace(/['"]/g, ''),
    body: content.slice(match[0].length),
  };
}

/** 扫描指定目录下的所有 Skill */
export function scanSkillsDir(dir: string, scope: 'global' | 'workspace'): SkillMetadata[] {
  if (!existsSync(dir)) return [];
  const skills: SkillMetadata[] = [];
  const entries = readdirSync(dir);

  for (const entry of entries) {
    const skillDir = join(dir, entry);
    const stat = statSync(skillDir);
    if (!stat.isDirectory()) continue;

    const skillMdPath = join(skillDir, 'SKILL.md');
    if (!existsSync(skillMdPath)) continue;

    const parsed = parseSkillMd(skillMdPath);
    if (!parsed) continue;

    skills.push({
      name: parsed.name,
      description: parsed.description,
      path: skillMdPath,
      dir: skillDir,
      scope,
    });
  }
  return skills;
}
```

#### loader.ts — SkillLoader

```typescript
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { scanSkillsDir, parseSkillMd } from './scanner.js';
import type { SkillMetadata, SkillContent } from './types.js';

export class SkillLoader {
  private skills: Map<string, SkillMetadata> = new Map();

  /** 扫描并加载所有 Skill 元信息 */
  scan(cwd: string): SkillMetadata[] {
    const globalDir = join(homedir(), '.loop-agent', 'skills');
    const workspaceDir = join(cwd, '.loop-agent', 'skills');

    // 先加载全局，再加载工作空间（后者覆盖前者）
    const globalSkills = scanSkillsDir(globalDir, 'global');
    const workspaceSkills = scanSkillsDir(workspaceDir, 'workspace');

    this.skills.clear();
    for (const s of globalSkills) this.skills.set(s.name, s);
    for (const s of workspaceSkills) this.skills.set(s.name, s);

    return this.list();
  }

  /** 渐进式加载：按名称读取完整 SKILL.md */
  async load(name: string): Promise<SkillContent | null> {
    const meta = this.skills.get(name);
    if (!meta) return null;

    const raw = readFileSync(meta.path, 'utf-8');
    const parsed = parseSkillMd(meta.path);
    if (!parsed) return null;

    return {
      metadata: meta,
      fullContent: raw,
      body: parsed.body,
    };
  }

  /** 获取所有 Skill 元信息 */
  list(): SkillMetadata[] {
    return [...this.skills.values()];
  }

  /** 按名称查找 */
  get(name: string): SkillMetadata | undefined {
    return this.skills.get(name);
  }
}
```

### 7. System Prompt 注入

在 `src/agent/prompt.ts` 中修改 `buildSystemPrompt()`，在 prompt 末尾追加 Skill 信息段：

```typescript
// 伪代码：在 buildSystemPrompt 中追加
function buildSkillsPrompt(skills: SkillMetadata[]): string {
  if (skills.length === 0) return '';

  const skillList = skills
    .map((s) => `- **${s.name}** (${s.scope}): ${s.description}`)
    .join('\n');

  return `
## 可用 Skills（技能包）
你可以使用以下专业技能包来完成特定领域的任务：

${skillList}

### 使用规则
1. **渐进式加载**：当你判断用户意图匹配某个 Skill 时，请在回复中明确说明要使用该 Skill
2. **详细加载**：系统会自动加载 Skill 的完整说明（SKILL.md 正文）作为参考
3. **资源利用**：Skill 目录下可能包含 scripts/（可执行脚本）、references/（参考文档）、assets/（模板资源），加载后可通过 fileRead / commandRun 等工具访问
4. **命名冲突**：工作空间 Skill 优先级高于全局 Skill

### 示例
- 用户："帮我提取 PDF 表格数据" → 使用 pdf-processing Skill
- 用户："研究一下量子计算最新进展" → 使用 web-research Skill
`.trim();
}
```

### 8. Skill 渐进式加载触发机制

在 ReActAgent 中增加 Skill 加载逻辑：

```typescript
// react-agent.ts 中，在 LLM 回复后检测是否需要加载 Skill
private async handleSkillActivation(resp: LLMResponse): Promise<void> {
  // 检查 LLM 是否在回复中提到了某个 Skill
  // 方式1：通过 tool_call（新增 activate_skill 工具）
  // 方式2：通过自然语言检测 "使用 xxx skill" / "using xxx" 等关键词

  // 推荐方案：新增一个内置工具 activate_skill
  // 参数: { name: string }
  // 执行: 加载 SKILL.md 完整内容 → 追加到 messages → 返回加载成功
}
```

### 9. CLI 命令支持

```
/skill list                → 列出所有可用 Skill（全局 + 工作空间）
/skill info <name>         → 查看 Skill 详细信息（元数据）
/skill show <name>         → 显示 SKILL.md 完整内容
/skill dir                 → 显示 Skill 扫描目录
```

### 10. 配置扩展

```typescript
// schema.ts 中新增
export interface SkillConfig {
  enabled: boolean;
  globalDir: string;      // 默认 ~/.loop-agent/skills
  workspaceDir: string;   // 默认 <cwd>/.loop-agent/skills
  autoLoad: boolean;      // 启动时是否自动扫描
}

export interface AgentConfig {
  // ... 现有配置
  skill: SkillConfig;
}
```

## 验收测试清单

| # | 测试项 | 验收标准 | 状态 |
|---|---|---|---|
| 1 | Skill 目录扫描 | 全局/工作空间的 SKILL.md 能被正确发现和解析 | 未开始 |
| 2 | YAML Frontmatter 解析 | name + description 正确提取，格式错误时返回 null | 未开始 |
| 3 | 工作空间优先级 | 同名 Skill 同时存在时，工作空间版本优先 | 未开始 |
| 4 | System Prompt 注入 | 启动后 Skill 元信息正确写入系统提示词 | 未开始 |
| 5 | 渐进式加载 | LLM 选定 Skill 后，SKILL.md 完整内容被追加到上下文 | 未开始 |
| 6 | /skill 命令 | list/info/show/dir 子命令正常工作 | 未开始 |
| 7 | 空目录容错 | skills 目录不存在时不报错，正常启动 | 未开始 |
| 8 | 动态刷新 | /skill reload 可重新扫描 Skill 目录 | 未开始 |
| 9 | 示例 Skill | 提供 pdf-processing / web-research 示例 Skill | 未开始 |
| 10 | 类型检查 | `npm run typecheck` 无错误 | 未开始 |

## 参考实现

- [Claude Code Skills 规范](https://docs.claude.ai/claude-code/skills)
- [DeepAgents Skills 实现](https://juejin.cn/post/7631477294100021282)
- SKILL.md 标准格式：YAML frontmatter（name + description）+ Markdown 正文

## 开发步骤建议

1. **Step 1**：创建 `src/skill/types.ts` + `src/skill/scanner.ts`，实现 Skill 扫描和解析
2. **Step 2**：创建 `src/skill/loader.ts`，实现 SkillLoader 类
3. **Step 3**：在 `src/config/schema.ts` 中新增 `skill` 配置项
4. **Step 4**：修改 `src/agent/prompt.ts`，注入 Skill 元信息到 System Prompt
5. **Step 5**：在 `src/agent/react-agent.ts` 中集成 Skill 渐进式加载
6. **Step 6**：在 `src/tools/` 中新增 `activate_skill` 内置工具
7. **Step 7**：在 `src/index.ts` 中新增 `/skill` CLI 命令
8. **Step 8**：提供示例 Skill 目录结构
9. **Step 9**：更新文档和验收测试
