// L3 Curated Core Memory：精炼常驻文件
// SOUL.md (Agent 人格) / USER.md (用户画像) / MEMORY.md (精炼事实)
// 启动时注入 system prompt，由 Dreaming 晋升写入
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { CuratedFileKey, CuratedFiles } from './types.js';

function fileExists(path: string): boolean {
  return existsSync(path);
}

const FILE_MAP: Record<CuratedFileKey, string> = {
  soul: 'SOUL.md',
  user: 'USER.md',
  memory: 'MEMORY.md',
};

const DEFAULT_CONTENT: Record<CuratedFileKey, string> = {
  soul: `# SOUL - Agent 人格

## 核心身份
你是一个基于 ReAct 框架的智能 Agent，擅长通过工具调用解决复杂问题。

## 行为准则
- 优先使用工具获取准确信息，不凭空臆造
- 在调用工具前，先用自然语言简要说明意图
- 得到足够信息后直接给出最终答案，不继续调用工具
- 面对失败时尝试换思路，不重复同样的失败调用

## 沟通风格
- 使用中文回答
- 回答简洁清晰，结构化表达
`,
  user: `# USER - 用户画像

## 基本信息

## 偏好

## 约束
`,
  memory: `# MEMORY - 精炼事实

## 项目知识

## 关键决策

## 已知问题
`,
};

export class CuratedMemory {
  private workspaceDir: string;
  private files: CuratedFiles = { ...FILE_MAP };

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  /** 初始化：创建文件（如不存在） */
  async init(): Promise<void> {
    await mkdir(this.workspaceDir, { recursive: true });
    for (const key of Object.keys(FILE_MAP) as CuratedFileKey[]) {
      const filepath = join(this.workspaceDir, FILE_MAP[key]);
      if (!fileExists(filepath)) {
        await writeFile(filepath, DEFAULT_CONTENT[key], 'utf-8');
      }
    }
  }

  /** 读取指定文件内容 */
  async read(key: CuratedFileKey): Promise<string> {
    const filepath = join(this.workspaceDir, this.files[key]);
    if (!fileExists(filepath)) return '';
    return readFile(filepath, 'utf-8');
  }

  /** 按文件名读取（用于 /memory read 命令） */
  async readByFilename(filename: string): Promise<string> {
    const key = (Object.keys(FILE_MAP) as CuratedFileKey[]).find(
      (k) => FILE_MAP[k] === filename,
    );
    if (!key) return '';
    return this.read(key);
  }

  /** 读取全部 Curated 文件，返回 system prompt 片段 */
  async buildSystemPrompt(): Promise<string> {
    const sections: string[] = [];
    for (const key of Object.keys(FILE_MAP) as CuratedFileKey[]) {
      const content = await this.read(key);
      if (content && content.trim()) {
        const title = FILE_MAP[key].replace('.md', '');
        sections.push(`# ${title}\n${content.trim()}`);
      }
    }
    return sections.join('\n\n');
  }

  /** 向指定文件追加一条事实 */
  async append(key: CuratedFileKey, fact: string): Promise<void> {
    const filepath = join(this.workspaceDir, this.files[key]);
    const current = fileExists(filepath)
      ? await readFile(filepath, 'utf-8')
      : DEFAULT_CONTENT[key];
    const newLine = `- ${fact}\n`;
    if (current.includes(newLine.trim())) return;
    await writeFile(filepath, current + newLine, 'utf-8');
  }

  /** 根据文件名追加事实（供 Dreaming 调用） */
  async appendByFilename(filename: string, fact: string): Promise<void> {
    const key = (Object.keys(FILE_MAP) as CuratedFileKey[]).find(
      (k) => FILE_MAP[k] === filename,
    );
    if (!key) return;
    await this.append(key, fact);
  }

  /** 获取工作空间目录 */
  getWorkspaceDir(): string {
    return this.workspaceDir;
  }

  /** 获取所有 Curated 文件的完整路径列表 */
  getFilePaths(): Record<CuratedFileKey, string> {
    const result = {} as Record<CuratedFileKey, string>;
    for (const key of Object.keys(FILE_MAP) as CuratedFileKey[]) {
      result[key] = join(this.workspaceDir, FILE_MAP[key]);
    }
    return result;
  }
}