// 配置写入器：统一写全局（~/.loop-agent/config.json）
//
// 需求 20261112-008：配置作用域收敛为全局，写侧不再有工作空间分支。
// 原来的 updateScope(scope, partial) / deleteScopeKey(scope, key) 收敛为
// update(partial) / deleteKey(key)，writeWorkspace 与 workspaceConfigPath 删除。
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';import type { PartialAgentConfig, AgentConfig } from './schema.js';
import { deepMerge } from './merge.js';
import { configLoader } from './loader.js';
import { loopAgentHome } from '../user-home.js';

export class ConfigWriter {
  private globalDir: string;

  // 需求 20261112-008（D2）：只接全局目录，不再持有工作空间路径。
  constructor(
    globalDir = loopAgentHome(),
    private loader = configLoader,
  ) {
    this.globalDir = globalDir;
  }

  get globalConfigPath(): string {
    return join(this.globalDir, 'config.json');
  }

  /** 写入全局配置（完整覆盖） */
  async writeGlobal(config: PartialAgentConfig): Promise<void> {
    await mkdir(this.globalDir, { recursive: true });
    await writeJson(this.globalConfigPath, config);
  }

  /** 读取现有全局配置后合并再写回（部分更新） */
  async update(partial: PartialAgentConfig): Promise<void> {
    const current = await this.loader.loadGlobal();
    const merged = deepMerge<AgentConfig>(
      {} as AgentConfig,
      current as Partial<AgentConfig>,
      partial as Partial<AgentConfig>,
    );
    await this.writeGlobal(merged as PartialAgentConfig);
  }

  /** 删除全局配置中的指定字段（用 undefined 覆盖后再去掉 undefined） */
  async deleteKey(keyPath: string[]): Promise<void> {
    const current = await this.loader.loadGlobal();
    deleteByPath(current, keyPath);
    await this.writeGlobal(current);
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
