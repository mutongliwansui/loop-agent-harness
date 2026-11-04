// MCP 展示名翻译缓存（需求 20261104-001，D7）
// ------------------------------------------------------------------
// 落盘位置：~/.loop-agent/mcp-meta.json
// 键为内容指纹（metaFingerprint）：server 改描述/title 即自动失配 → 重译。
// 全程容错：文件缺失/损坏/字段非法一律当空表，绝不抛错影响 MCP 连接与对话。
import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** 缓存条目：一次翻译的产物 */
export interface MetaCacheEntry {
  server: string;
  tool: string;
  zhName: string;
  zhParams: Record<string, string>;
  /** 产出该条目的模型名（便于排查「换了模型想重译」） */
  model: string;
  /** ISO 时间戳（LRU 裁剪用） */
  at: string;
}

export interface MetaCacheFile {
  version: 1;
  translations: Record<string, MetaCacheEntry>;
}

/** 缓存条目上限（按 at LRU，防无界增长） */
export const META_CACHE_KEEP = 500;

const CACHE_VERSION = 1;

/** 默认缓存文件路径（可用参数注入，便于单测） */
export function defaultMetaCachePath(): string {
  return join(homedir(), '.loop-agent', 'mcp-meta.json');
}

function isEntry(v: unknown): v is MetaCacheEntry {
  const e = v as MetaCacheEntry | null;
  return (
    !!e &&
    typeof e === 'object' &&
    typeof e.server === 'string' &&
    typeof e.tool === 'string' &&
    typeof e.zhName === 'string' &&
    typeof e.at === 'string' &&
    !!e.zhParams &&
    typeof e.zhParams === 'object' &&
    !Array.isArray(e.zhParams)
  );
}

/** 空表 */
export function emptyMetaCache(): MetaCacheFile {
  return { version: CACHE_VERSION, translations: {} };
}

/** 读取缓存；文件缺失/损坏/字段不合法一律返回空表，不抛错 */
export async function loadMetaCache(file?: string): Promise<MetaCacheFile> {
  const path = file ?? defaultMetaCachePath();
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch {
    return emptyMetaCache();
  }
  try {
    const raw = JSON.parse(text.replace(/^\uFEFF/, '')) as {
      translations?: unknown;
    };
    const src = raw?.translations;
    if (!src || typeof src !== 'object' || Array.isArray(src)) return emptyMetaCache();
    const translations: Record<string, MetaCacheEntry> = {};
    for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
      if (!isEntry(v)) continue;
      const params: Record<string, string> = {};
      for (const [pk, pv] of Object.entries(v.zhParams)) {
        if (typeof pv === 'string') params[pk] = pv;
      }
      translations[k] = {
        server: v.server,
        tool: v.tool,
        zhName: v.zhName,
        zhParams: params,
        model: typeof v.model === 'string' ? v.model : '',
        at: v.at,
      };
    }
    return { version: CACHE_VERSION, translations };
  } catch {
    return emptyMetaCache();
  }
}

/** 按 at 裁剪到最近 keep 条（保留最新） */
export function pruneMetaCache(cache: MetaCacheFile, keep = META_CACHE_KEEP): MetaCacheFile {
  const entries = Object.entries(cache.translations);
  if (entries.length <= keep) return cache;
  entries.sort((a, b) => (a[1].at < b[1].at ? 1 : a[1].at > b[1].at ? -1 : 0));
  const translations: Record<string, MetaCacheEntry> = {};
  for (const [k, v] of entries.slice(0, keep)) translations[k] = v;
  return { version: CACHE_VERSION, translations };
}

/** 进程内写盘串行队列（避免同进程并发写互相覆盖；不做跨进程锁） */
let writeChain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = writeChain.then(task, task);
  // 吞掉队列中的异常，避免一次失败阻断后续写入
  writeChain = next.catch(() => undefined);
  return next;
}

/**
 * 写入单条并落盘（tmp + rename 原子替换；LRU 保留最近 META_CACHE_KEEP 条）。
 * 失败静默（缓存非关键路径），返回写入后的完整缓存对象。
 */
export async function saveMetaEntry(
  fingerprint: string,
  entry: MetaCacheEntry,
  file?: string,
): Promise<MetaCacheFile> {
  const path = file ?? defaultMetaCachePath();
  return enqueue(async () => {
    const current = await loadMetaCache(path);
    current.translations[fingerprint] = entry;
    const pruned = pruneMetaCache(current);
    try {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
      try {
        await writeFile(tmp, JSON.stringify(pruned, null, 2), 'utf-8');
        await rename(tmp, path);
      } catch (e) {
        await unlink(tmp).catch(() => {});
        throw e;
      }
    } catch {
      // 写盘失败不影响内存中的翻译结果（调用方仍会用本次结果更新侧表）
    }
    return pruned;
  });
}
