import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { scanSkillsDir, parseSkillMd } from './scanner.js';
import type { SkillMetadata, SkillContent } from './types.js';
import { config } from '../config.js';

/** Skill 加载器：扫描、解析、渐进式加载 */
export class SkillLoader {
  private skills: Map<string, SkillMetadata> = new Map();

  /** 全局 Skill 目录 */
  get globalDir(): string {
    return join(homedir(), '.loop-agent', 'skills');
  }

  /** 扫描并加载所有 Skill 元信息 */
  scan(cwd: string): SkillMetadata[] {
    const workspaceDir = join(cwd, 'skills');

    const globalSkills = scanSkillsDir(this.globalDir, 'global');
    const workspaceSkills = scanSkillsDir(workspaceDir, 'workspace');

    // 先加载全局，再加载工作空间（后者覆盖前者）
    this.skills.clear();
    for (const s of globalSkills) this.skills.set(s.name, s);
    for (const s of workspaceSkills) this.skills.set(s.name, s);

    return this.list();
  }

  /** 渐进式加载：按名称读取完整 SKILL.md */
  load(name: string): SkillContent | null {
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

  /** 获取工作空间 Skill 目录 */
  getWorkspaceDir(cwd: string): string {
    return join(cwd, 'skills');
  }

  /** 重新扫描 */
  reload(cwd: string): SkillMetadata[] {
    return this.scan(cwd);
  }

  /** 当前是否启用 Skill */
  isEnabled(): boolean {
    return config.skill.enabled;
  }
}

/** 全局单例 */
export const skillLoader = new SkillLoader();
