import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { scanSkillsDir, parseSkillMd } from './scanner.js';
import type { SkillMetadata, SkillContent } from './types.js';
import { config } from '../config.js';
import { loopAgentHome } from '../user-home.js';

/**
 * Skill 加载器：扫描、解析、渐进式加载
 *
 * 需求 20261112-008（D5）：skill 目录收敛为全局唯一一份 `~/.loop-agent/skills`。
 * - `getWorkspaceDir()` 已删除，`{ws}/.loop-agent/skills` 不再被扫描
 * - `SkillMetadata.scope` 字段保留（协议稳定）但恒为 `'global'`
 */
export class SkillLoader {
  private skills: Map<string, SkillMetadata> = new Map();

  /** 全局 Skill 目录（唯一目录） */
  get globalDir(): string {
    return join(loopAgentHome(), 'skills');
  }

  /** 扫描并加载所有 Skill 元信息（只扫全局目录） */
  scan(): SkillMetadata[] {
    const skills = scanSkillsDir(this.globalDir, 'global');

    this.skills.clear();
    for (const s of skills) this.skills.set(s.name, s);

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

  /** 获取所有 Skill 元信息（按名称排序） */
  list(): SkillMetadata[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 按名称查找 */
  get(name: string): SkillMetadata | undefined {
    return this.skills.get(name);
  }

  /** 重新扫描（全局目录） */
  reload(): SkillMetadata[] {
    return this.scan();
  }

  /** 当前是否启用 Skill */
  isEnabled(): boolean {
    return config.skill.enabled;
  }
}

/** 全局单例 */
export const skillLoader = new SkillLoader();
