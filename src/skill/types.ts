/** Skill 相关类型定义 */

/** Skill 作用域（需求 20261112-008：只剩全局一份，类型保留单值以稳定协议） */
export type SkillScope = 'global';

/** Skill 配置项 */
export interface SkillConfig {
  /** 是否启用 Skill 功能 */
  enabled: boolean;
  /** 全局 Skill 目录（默认 ~/.loop-agent/skills；唯一目录） */
  globalDir: string;
  /** 启动时是否自动扫描 */
  autoLoad: boolean;
}

/** Skill 元数据（用于 System Prompt 注入） */
export interface SkillMetadata {
  /** Skill 唯一标识 */
  name: string;
  /** 简短描述，LLM 据此判断何时使用 */
  description: string;
  /** SKILL.md 绝对路径 */
  path: string;
  /** Skill 文件夹路径 */
  dir: string;
  /** 作用域 */
  scope: SkillScope;
}

/** Skill 完整内容（渐进式加载后使用） */
export interface SkillContent {
  /** 元数据 */
  metadata: SkillMetadata;
  /** SKILL.md 完整内容（含 frontmatter） */
  fullContent: string;
  /** frontmatter 之后的正文部分 */
  body: string;
}

/** YAML frontmatter 解析结果 */
export interface ParsedSkillMd {
  name: string;
  description: string;
  body: string;
}
