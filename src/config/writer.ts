// 配置写入器：工作空间/全局写入，支持部分更新
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PartialAgentConfig, AgentConfig } from './schema.js';
import { deepMerge } from './merge.js';
import { configLoader } from './loader.js';

export type ConfigScope = 'workspace' | 'global';

export class ConfigWriter {
  private workspacePath: string;
  private globalDir: string;

  constructor(
    workspacePath = process.cwd(),
    globalDir = join(homedir(), '.loop-agent'),
    private loader = configLoader,
  ) {
    this.workspacePath = workspacePath;
    this.globalDir = globalDir;
  }

  get workspaceConfigPath(): string {
    return join(this.workspacePath, '.agent-config.json');
  }

  get globalConfigPath(): string {
    return join(this.globalDir, 'config.json');
  }

  /** 写入工作空间配置（完整覆盖） */
  async writeWorkspace(config: PartialAgentConfig): Promise<void> {
    await writeJson(this.workspaceConfigPath, config);
  }

  /** 写入全局配置（完整覆盖） */
  async writeGlobal(config: PartialAgentConfig): Promise<void> {
    await mkdir(this.globalDir, { recursive: true });
    await writeJson(this.globalConfigPath, config);
  }

  /** 读取现有配置后合并再写回（部分更新） */
  async updateScope(scope: ConfigScope, partial: PartialAgentConfig): Promise<void> {
    if (scope === 'workspace') {
      const current = await this.loader.loadWorkspace();
      const merged = deepMerge<AgentConfig>(
        {} as AgentConfig,
        current as Partial<AgentConfig>,
        partial as Partial<AgentConfig>,
      );
      await this.writeWorkspace(merged as PartialAgentConfig);
    } else {
      const current = await this.loader.loadGlobal();
      const merged = deepMerge<AgentConfig>(
        {} as AgentConfig,
        current as Partial<AgentConfig>,
        partial as Partial<AgentConfig>,
      );
      await this.writeGlobal(merged as PartialAgentConfig);
    }
  }

  /** 删除某个 scope 中的指定字段（用 undefined 覆盖后再去掉 undefined） */
  async deleteScopeKey(scope: ConfigScope, keyPath: string[]): Promise<void> {
    const current =
      scope === 'workspace'
        ? await this.loader.loadWorkspace()
        : await this.loader.loadGlobal();

    deleteByPath(current, keyPath);
    if (scope === 'workspace') {
      await this.writeWorkspace(current);
    } else {
      await this.writeGlobal(current);
    }
  }

  /**
   * 按点路径读取 / 写入配置值。
   * 如 "model.name" → ["model", "name"]
   */
  static parseKey(key: string): string[] {
    return key.split('.').filter(Boolean);
  }

  /** 按点路径从配置对象中获取值 */
  static getByKey(cfg: object, key: string): unknown {
    const path = ConfigWriter.parseKey(key);
    let cur: unknown = cfg;
    for (const k of path) {
      if (typeof cur !== 'object' || cur === null) return undefined;
      cur = (cur as Record<string, unknown>)[k];
    }
    return cur;
  }

  /** 按点路径写入值到配置对象 */
  static setByKey(cfg: Record<string, unknown>, key: string, value: unknown): void {
    const path = ConfigWriter.parseKey(key);
    if (path.length === 0) return;
    let cur: Record<string, unknown> = cfg;
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i];
      if (!(k in cur) || typeof cur[k] !== 'object' || cur[k] === null || Array.isArray(cur[k])) {
        cur[k] = {};
      }
      cur = cur[k] as Record<string, unknown>;
    }
    cur[path[path.length - 1]] = value;
  }
}

function deleteByPath(cfg: object, path: string[]): void {
  if (path.length === 0) return;
  let cur: unknown = cfg;
  const stack: Array<Record<string, unknown>> = [];
  for (let i = 0; i < path.length - 1; i++) {
    if (typeof cur !== 'object' || cur === null) return;
    stack.push(cur as Record<string, unknown>);
    cur = (cur as Record<string, unknown>)[path[i]];
  }
  if (typeof cur !== 'object' || cur === null) return;
  delete (cur as Record<string, unknown>)[path[path.length - 1]];
  // 顺带清理空对象（可选，不清理也不影响功能）
  // 这里不自动清理，避免误删用户其他字段
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

// 兼容：保留 readJson 作为 readFile + parse
export async function readJson<T>(path: string): Promise<T> {
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content) as T;
}

/** 全局单例 */
export const configWriter = new ConfigWriter();
