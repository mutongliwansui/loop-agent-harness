// 启动体检：基于合并后生效值检测必备目录与配置是否齐备
// 纯函数设计：文件存在性通过注入的 exists 探针完成，便于单测
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig } from '../config/schema.js';

export type BootstrapIssueId =
  | 'model-apiKey'
  | 'model-name'
  | 'global-config'
  | 'workspace-config'
  | 'skills-global'
  | 'skills-workspace';

export interface BootstrapIssue {
  id: BootstrapIssueId;
  /** blocker：主模型三元组缺失，进向导；missing：目录/文件缺失，静默补建 */
  level: 'blocker' | 'missing';
  /** 面向用户的中文描述 */
  message: string;
  /** 相关文件/目录绝对路径（blocker 无固定路径，缺省） */
  path?: string;
}

export interface BootstrapReport {
  /** 无 blocker 即 true（missing 项可静默补建，不阻断使用） */
  ok: boolean;
  issues: BootstrapIssue[];
}

/** 引导检测所需的路径集合 */
export interface BootstrapPaths {
  globalConfigPath: string;
  workspaceConfigPath: string;
  skillsGlobalDir: string;
  skillsWorkspaceDir: string;
}

export type ExistsProbe = (path: string) => boolean;

export const defaultExistsProbe: ExistsProbe = (path) => existsSync(path);

/**
 * 按项目路径约定构造检测路径集合
 * 与 configWriter / skillLoader 的默认路径保持一致
 */
export function defaultBootstrapPaths(): BootstrapPaths {
  const globalDir = join(homedir(), '.loop-agent');
  const workspaceDir = join(process.cwd(), '.loop-agent');
  return {
    globalConfigPath: join(globalDir, 'config.json'),
    workspaceConfigPath: join(workspaceDir, '.agent-config.json'),
    skillsGlobalDir: join(globalDir, 'skills'),
    skillsWorkspaceDir: join(workspaceDir, 'skills'),
  };
}

/**
 * 检测必备配置与目录（Task-20261011-001）
 *
 * 判定规则（D1：看合并后生效值，不看文件）：
 * - cfg.model.apiKey / name 为空 → blocker（进向导）
 * - 全局/工作空间配置文件、两级 skills 目录不存在 → missing（静默补建）
 * - 不含 logs/、memory、.keyfile（各模块按需自建）
 */
export function checkBootstrap(
  cfg: AgentConfig,
  paths: BootstrapPaths,
  exists: ExistsProbe = defaultExistsProbe,
): BootstrapReport {
  const issues: BootstrapIssue[] = [];

  if (!cfg.model.apiKey || cfg.model.apiKey.trim() === '') {
    issues.push({
      id: 'model-apiKey',
      level: 'blocker',
      message: '主模型 apiKey 未配置',
    });
  }
  if (!cfg.model.name || cfg.model.name.trim() === '') {
    issues.push({
      id: 'model-name',
      level: 'blocker',
      message: '主模型名称未配置',
    });
  }
  if (!exists(paths.globalConfigPath)) {
    issues.push({
      id: 'global-config',
      level: 'missing',
      message: '全局配置文件不存在（留待首次写入时创建）',
      path: paths.globalConfigPath,
    });
  }
  if (!exists(paths.workspaceConfigPath)) {
    issues.push({
      id: 'workspace-config',
      level: 'missing',
      message: '工作空间配置文件不存在',
      path: paths.workspaceConfigPath,
    });
  }
  if (!exists(paths.skillsGlobalDir)) {
    issues.push({
      id: 'skills-global',
      level: 'missing',
      message: '全局 skills 目录不存在',
      path: paths.skillsGlobalDir,
    });
  }
  if (!exists(paths.skillsWorkspaceDir)) {
    issues.push({
      id: 'skills-workspace',
      level: 'missing',
      message: '工作空间 skills 目录不存在',
      path: paths.skillsWorkspaceDir,
    });
  }

  return {
    ok: !issues.some((i) => i.level === 'blocker'),
    issues,
  };
}
