/**
 * 插件清单的读写（落盘层）。
 *
 * 三条硬约束，都是为了「启动不能被一个坏档或一次写失败锁死」：
 * 1. **原子写**（D8）：先写同目录 tmp，再 rename 覆盖。读方要么看到旧文件、
 *    要么看到新文件，永不会读到半截 JSON。
 * 2. **坏档降级**（D9）：结构不识别时备份为 `.bad.<ts>` 并返回空清单，
 *    绝不抛错——否则一个手抖改坏的 registry.json 就能让整个进程起不来。
 * 3. **写失败只记录**（D4）：返回 `{ok:false}` 并记 `lastError`，由上层决定
 *    是否中止；内存态照常推进，用户的操作不会因为磁盘问题而「看起来失败」。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { pluginsDir } from './home.js';
import {
  MANIFEST_SCHEMA_VERSION,
  emptyManifest,
  type PluginManifest,
  type PluginManifestEntry,
} from './types.js';

export interface PluginStoreOptions {
  /** 清单文件绝对路径；缺省 `~/.loop-agent/plugins/registry.json`（D3） */
  file?: string;
}

export interface PluginStore {
  readonly file: string;
  read(): PluginManifest;
  write(manifest: PluginManifest): { ok: true } | { ok: false; error: Error };
  lastError(): Error | undefined;
}

export function createPluginStore(options: PluginStoreOptions = {}): PluginStore {
  const file = options.file ?? join(pluginsDir(), 'registry.json');
  let lastError: Error | undefined;
  // tmp 文件名序号：同进程连续写不重名（并发由 registry 的写队列串行化，D18）
  let seq = 0;

  /** 坏档处理：备份为 .bad.<ts> 后返回空清单，不抛错（D9） */
  function degrade(target: string, error: Error): PluginManifest {
    lastError = error;
    try {
      if (existsSync(target)) {
        renameSync(target, `${target}.bad.${Date.now()}`);
      }
    } catch {
      // 备份失败不阻断：原文件仍在原地，下次启动会再试一遍
    }
    return emptyManifest();
  }

  return {
    file,

    read() {
      if (!existsSync(file)) return emptyManifest();
      let raw: string;
      try {
        raw = readFileSync(file, 'utf8');
      } catch (error) {
        return degrade(file, toError(error));
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        return degrade(file, toError(error));
      }
      const normalized = normalizeManifest(parsed);
      if (!normalized) return degrade(file, new Error('清单结构不识别'));
      return normalized;
    },

    write(manifest) {
      // D8：写 tmp → 删目标 → rename。
      // Windows 上 rename 到已存在的文件会 EPERM，故必须先删。这留下一个
      // 极短窗口「目标已删、新文件未就位」，但读方在那个窗口只会读到
      // ENOENT 并降级为空清单（不崩），比读到半截 JSON 好得多。
      const tmp = `${file}.tmp.${process.pid}.${++seq}`;
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        if (existsSync(file)) rmSync(file, { force: true });
        renameSync(tmp, file);
        lastError = undefined;
        return { ok: true };
      } catch (error) {
        const err = toError(error);
        lastError = err;
        // 清理残留 tmp，避免同目录越积越多
        try {
          if (existsSync(tmp)) rmSync(tmp, { force: true });
        } catch {
          // 清理失败不影响主流程
        }
        return { ok: false, error: err };
      }
    },

    lastError() {
      return lastError;
    },
  };
}

/**
 * 结构校验：容忍字段缺失与脏条目，只在「整体结构不可用」时返回 undefined。
 *
 * 取舍刻意偏宽松：单条坏数据只丢那一条，不牵连整份清单——用户装了 10 个
 * 插件，不该因为第 3 条写错一个字段就全部失效。
 */
function normalizeManifest(value: unknown): PluginManifest | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  if (obj.schemaVersion !== MANIFEST_SCHEMA_VERSION) return undefined;
  if (!Array.isArray(obj.entries)) return undefined;

  const seen = new Set<string>();
  const entries: PluginManifestEntry[] = [];
  for (const item of obj.entries) {
    if (typeof item !== 'object' || item === null) continue;
    const e = item as Record<string, unknown>;
    if (typeof e.id !== 'string' || e.id === '') continue;
    if (typeof e.specifier !== 'string' || e.specifier === '') continue;
    if (seen.has(e.id)) continue; // 重复 id 保留首个
    seen.add(e.id);
    entries.push({
      id: e.id,
      specifier: e.specifier,
      enabled: e.enabled !== false, // 缺省视为启用（宽松向后兼容）
      ...(isPlainObject(e.options) ? { options: e.options } : {}),
    });
  }
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    entries,
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString(),
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
