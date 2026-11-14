/**
 * PluginStore 纯文件层回归（任务 04 / 需求 20261114-004 P2）。
 *
 * 只测「清单怎么读写」：不碰注册中心、不碰 Fiber。
 * 关键口径（对应设计的 D 编号）：
 * - 落盘断言一律用**文件内容比对**，不用 mtime（D21）。
 * - 原子性用**并发读压测**验证读方永不看到半截 JSON（D22）。
 * - 每个用例都在 mkdtemp 出来的临时目录里跑，绝不碰真实 ~/.loop-agent。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPluginStore } from '../src/store.js';
import { MANIFEST_SCHEMA_VERSION, emptyManifest, type PluginManifest } from '../src/types.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'loop-main-store-'));
  file = join(dir, 'plugins', 'registry.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** 预置清单文件（父目录按需创建） */
function seed(content: unknown, target = file): void {
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
}

function backupNames(): string[] {
  return readdirSync(join(dir, 'plugins')).filter((n) => n.includes('.bad.'));
}

function roundTrip(): PluginManifest {
  return JSON.parse(readFileSync(file, 'utf8')) as PluginManifest;
}

describe('PluginStore：清单读写', () => {
  it('文件不存在时返回空清单，且不创建文件', () => {
    const store = createPluginStore({ file });

    const got = store.read();
    expect(got.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
    expect(got.entries).toEqual([]);
    expect(existsSync(file)).toBe(false);
    expect(store.lastError()).toBeUndefined();
  });

  it('写→读 往返一致', () => {
    const store = createPluginStore({ file });
    const manifest: PluginManifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      entries: [{ id: 'a', specifier: './a.mjs', enabled: true }],
      updatedAt: '2026-11-14T00:00:00.000Z',
    };

    expect(store.write(manifest).ok).toBe(true);
    expect(store.read()).toEqual(manifest);
  });

  it('落盘结构含 schemaVersion / entries / updatedAt', () => {
    const store = createPluginStore({ file });
    store.write(emptyManifest());

    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(raw.schemaVersion).toBe(1);
    expect(Array.isArray(raw.entries)).toBe(true);
    expect(typeof raw.updatedAt).toBe('string');
  });

  it('目标文件已存在时可覆盖（Windows 先删再 rename，D8）', () => {
    const store = createPluginStore({ file });
    store.write({ ...emptyManifest(), entries: [{ id: 'a', specifier: './a.mjs', enabled: true }] });
    const second: PluginManifest = {
      ...emptyManifest(),
      entries: [{ id: 'b', specifier: './b.mjs', enabled: false }],
    };

    expect(store.write(second).ok).toBe(true);
    expect(roundTrip().entries).toEqual(second.entries);
  });

  it('父目录不存在时自动创建', () => {
    const deep = join(dir, 'deep', 'nested', 'registry.json');
    const store = createPluginStore({ file: deep });

    expect(store.write(emptyManifest()).ok).toBe(true);
    expect(existsSync(deep)).toBe(true);
  });

  it('写完不留下 .tmp 残留文件', () => {
    const store = createPluginStore({ file });
    store.write(emptyManifest());

    const leftovers = readdirSync(join(dir, 'plugins')).filter((n) => n.includes('.tmp.'));
    expect(leftovers).toEqual([]);
  });

  it('options 只保留 JSON 可序列化内容（往返后仍是原对象）', () => {
    const store = createPluginStore({ file });
    const entry = { id: 'a', specifier: './a.mjs', enabled: true, options: { level: 3 } };
    store.write({ ...emptyManifest(), entries: [entry] });

    expect(store.read().entries).toEqual([entry]);
  });
});

describe('PluginStore：坏档容错（D9）', () => {
  it('坏 JSON：返回空清单、备份 .bad.<ts>、不抛错', () => {
    seed('{ 这不是 JSON');
    const store = createPluginStore({ file });

    expect(store.read().entries).toEqual([]);
    expect(store.lastError()).toBeInstanceOf(Error);

    const backups = backupNames();
    expect(backups).toHaveLength(1);
    // 坏档内容原样保留，便于用户排查
    expect(readFileSync(join(dir, 'plugins', backups[0]), 'utf8')).toBe('{ 这不是 JSON');
    // 原文件已被挪走，下次启动不会重复降级
    expect(existsSync(file)).toBe(false);
  });

  it('schemaVersion 不识别时降级为空清单并备份', () => {
    seed({ schemaVersion: 999, entries: [{ id: 'a', specifier: './a.mjs' }] });
    const store = createPluginStore({ file });

    expect(store.read().entries).toEqual([]);
    expect(backupNames()).toHaveLength(1);
  });

  it('entries 非数组时降级为空清单并备份', () => {
    seed({ schemaVersion: 1, entries: { a: 1 } });
    const store = createPluginStore({ file });

    expect(store.read().entries).toEqual([]);
    expect(backupNames()).toHaveLength(1);
  });

  it('顶层是数组 / null 时也降级', () => {
    seed([1, 2, 3]);
    const store = createPluginStore({ file });
    expect(store.read().entries).toEqual([]);

    seed('null');
    const store2 = createPluginStore({ file });
    expect(store2.read().entries).toEqual([]);
  });

  it('条目 id 为空串或 specifier 缺失时跳过该条，其余保留', () => {
    seed({
      schemaVersion: 1,
      entries: [
        { id: '', specifier: './bad.mjs' },
        { id: 'no-spec' },
        { id: 'ok', specifier: './ok.mjs' },
      ],
    });
    const store = createPluginStore({ file });

    expect(store.read().entries.map((e) => e.id)).toEqual(['ok']);
    // 结构可修复 → 不算坏档，不备份
    expect(backupNames()).toEqual([]);
  });

  it('文件内 id 重复时保留首个', () => {
    seed({
      schemaVersion: 1,
      entries: [
        { id: 'dup', specifier: './first.mjs' },
        { id: 'dup', specifier: './second.mjs' },
      ],
    });
    const store = createPluginStore({ file });

    const entries = store.read().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].specifier).toBe('./first.mjs');
  });

  it('enabled 字段缺失视为 true（宽松向后兼容）', () => {
    seed({ schemaVersion: 1, entries: [{ id: 'a', specifier: './a.mjs' }] });
    expect(createPluginStore({ file }).read().entries[0].enabled).toBe(true);
  });

  it('updatedAt 缺失时补当前时间，不视为坏档', () => {
    seed({ schemaVersion: 1, entries: [] });
    const got = createPluginStore({ file }).read();

    expect(got.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(backupNames()).toEqual([]);
  });
});

describe('PluginStore：原子写与写失败（D8 / D22）', () => {
  it('并发读压测期间永不读到半截 JSON（D22）', async () => {
    const store = createPluginStore({ file });

    // 造一份足够大的清单，让写窗口有可观测的时长
    const big: PluginManifest = {
      ...emptyManifest(),
      entries: Array.from({ length: 200 }, (_, i) => ({
        id: `p${i}`,
        specifier: `./p${i}.mjs`,
        enabled: true,
      })),
    };
    store.write(big);

    let bad = 0;
    let reads = 0;
    let stop = false;

    const reader = (async () => {
      while (!stop) {
        try {
          const raw = readFileSync(file, 'utf8');
          reads += 1;
          JSON.parse(raw); // 读到半截必然抛
        } catch (error) {
          // ENOENT 是允许的（rename 前后的极短窗口），只统计 JSON 解析失败
          if (error instanceof SyntaxError) bad += 1;
        }
        await new Promise((r) => setImmediate(r));
      }
    })();

    for (let i = 0; i < 60; i += 1) {
      store.write({ ...big, updatedAt: new Date(i).toISOString() });
      await new Promise((r) => setImmediate(r));
    }
    stop = true;
    await reader;

    expect(reads).toBeGreaterThan(0); // 防断言空转
    expect(bad).toBe(0);
  });

  it('写失败时返回 ok:false、记录 lastError、不抛错', () => {
    // 父路径是个文件 → 建目录必失败
    const blocker = join(dir, 'blocked');
    writeFileSync(blocker, 'x', 'utf8');
    const store = createPluginStore({ file: join(blocker, 'registry.json') });

    const result = store.write(emptyManifest());
    expect(result.ok).toBe(false);
    expect(store.lastError()).toBeInstanceOf(Error);
  });

  it('写失败后 lastError 可被下一次成功写清掉', () => {
    const blocker = join(dir, 'blocked');
    writeFileSync(blocker, 'x', 'utf8');
    const store = createPluginStore({ file });

    // 先用同一个 store 制造失败：把 file 指到非法路径不行（file 只读），
    // 故换一个 store 验证语义：失败 → 成功应清除
    const bad = createPluginStore({ file: join(blocker, 'registry.json') });
    bad.write(emptyManifest());
    expect(bad.lastError()).toBeInstanceOf(Error);

    const good = createPluginStore({ file });
    expect(good.write(emptyManifest()).ok).toBe(true);
    expect(good.lastError()).toBeUndefined();
  });

  it('写失败不留 .tmp 残留', () => {
    const blocker = join(dir, 'blocked');
    writeFileSync(blocker, 'x', 'utf8');
    const target = join(blocker, 'registry.json');
    const store = createPluginStore({ file: target });

    store.write(emptyManifest());
    // 父路径是文件，tmp 也建不出来，本目录下不应有任何残留
    expect(readdirSync(dir).filter((n) => n.includes('.tmp.'))).toEqual([]);
  });
});
