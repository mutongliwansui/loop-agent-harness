// 工作空间配置一次性迁移（需求 20261112-008 / D6）
//
// 背景：配置作用域收敛为全局后，{ws}/.loop-agent/.agent-config.json 不再参与合并。
// 存量内容（本机实测为 tools.enabled / tools.disabled / memory.working /
// agent.debug / agent.maxIterations / webui.terminal / vision.enabled 共 541B）
// 若不迁移，升级后行为会突变（例如工具白名单静默失效 -> 工具全开或全关）。
//
// 取值方向（D6）：**workspace 值胜出**。改造前 workspace 覆盖 global，它才是当前
// 生效值，因此合并方向为 deepMerge(global, ws)。
//
// 幂等性：迁移后源文件改名为 .agent-config.json.bak-<ts>，再次扫描时该文件已不存在，
// 不会重复合并、不会重复备份。失败只告警，绝不阻断启动。
import { readdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { deepMerge } from './merge.js';
import { readJsonSafe, readJsonSafeSync } from './loader.js';
import type { AgentConfig, PartialAgentConfig } from './schema.js';
import type { ConfigWriter } from './writer.js';

/** 工作空间配置文件的相对路径（统一存放于 {workspace}/.loop-agent/） */
export const WORKSPACE_CONFIG_REL = join('.loop-agent', '.agent-config.json');

export interface MigrateResult {
  /** 扫描到的候选工作空间根数 */
  scanned: number;
  /** 实际发生迁移的空间 */
  migrated: Array<{ root: string; keys: string[]; backupPath: string }>;
  /** 跳过（无文件 / 空对象 / 出错） */
  skipped: Array<{ root: string; reason: string }>;
}

/** 收集已登记的工作空间根（来自 sessions/<id>/meta.json 的 workspacePath，明文可读） */
export async function collectWorkspaceRoots(sessionsDir: string): Promise<string[]> {
  const roots = new Set<string>();
  let entries: string[] = [];
  try {
    entries = (await readdir(sessionsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return []; // sessions 目录不存在：无历史空间
  }
  for (const name of entries) {
    const meta = readJsonSafeSync<{ workspacePath?: string }>(join(sessionsDir, name, 'meta.json'));
    const p = typeof meta?.workspacePath === 'string' ? meta.workspacePath.trim() : '';
    if (p) roots.add(p);
  }
  return [...roots];
}

/** 列出配置对象里的点路径叶子键（用于日志展示迁移了哪些键） */
function collectLeafKeys(cfg: PartialAgentConfig, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(cfg as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...collectLeafKeys(v as PartialAgentConfig, path));
    } else {
      out.push(path);
    }
  }
  return out;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把各工作空间的存量配置并入全局配置（workspace 值胜出），源文件备份为 .bak-<ts>。
 *
 * @param opts.globalDir    全局目录（~/.loop-agent）
 * @param opts.writer       写入器（默认单例即可；单测可注入）
 * @param opts.candidateRoots 额外候选根（如当前 cwd、serve 已知空间），与 sessions 收集结果合并
 * @param opts.sessionsDir  sessions 索引目录，用于收集历史空间根
 * @param opts.log          日志回调
 */
export async function migrateWorkspaceConfigToGlobal(opts: {
  globalDir: string;
  writer: ConfigWriter;
  candidateRoots?: string[];
  sessionsDir?: string;
  log?: (msg: string) => void;
}): Promise<MigrateResult> {
  const { globalDir, writer, log } = opts;
  const result: MigrateResult = { scanned: 0, migrated: [], skipped: [] };
  const ts = new Date().toISOString().replace(/[:.]/g, '-');

  const roots = new Set<string>();
  for (const r of opts.candidateRoots ?? []) {
    if (typeof r === 'string' && r.trim()) roots.add(r.trim());
  }
  if (opts.sessionsDir) {
    for (const r of await collectWorkspaceRoots(opts.sessionsDir)) roots.add(r);
  }

  for (const root of roots) {
    result.scanned++;
    const srcPath = join(root, WORKSPACE_CONFIG_REL);
    try {
      if (!(await exists(srcPath))) {
        result.skipped.push({ root, reason: '无工作空间配置文件' });
        continue;
      }
      const wsCfg = await readJsonSafe<PartialAgentConfig>(srcPath);
      if (!wsCfg || typeof wsCfg !== 'object' || Object.keys(wsCfg).length === 0) {
        // 空对象：只备份，不合并（避免把 {} 当配置处理）
        const bak = `${srcPath}.bak-${ts}`;
        await rename(srcPath, bak);
        result.skipped.push({ root, reason: '内容为空对象，已备份未合并' });
        log?.(`[config-migrate] ${srcPath} 为空配置，已备份为 ${bak}`);
        continue;
      }

      // D6：workspace 值胜出（改造前它覆盖 global）
      const globalCfg = await readJsonSafe<PartialAgentConfig>(join(globalDir, 'config.json'));
      const merged = deepMerge<AgentConfig>(
        {} as AgentConfig,
        (globalCfg ?? {}) as Partial<AgentConfig>,
        wsCfg as Partial<AgentConfig>,
      );
      await writer.writeGlobal(merged as PartialAgentConfig);

      const bak = `${srcPath}.bak-${ts}`;
      await rename(srcPath, bak);

      const keys = collectLeafKeys(wsCfg);
      result.migrated.push({ root, keys, backupPath: bak });
      log?.(
        `[config-migrate] 已迁移 ${root} 的 ${keys.length} 个配置键到全局（${keys.join(', ')}），源文件备份为 ${bak}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.skipped.push({ root, reason: `迁移失败：${msg}` });
      log?.(`[config-migrate] 迁移 ${root} 失败（已忽略，不阻断启动）：${msg}`);
    }
  }

  return result;
}
