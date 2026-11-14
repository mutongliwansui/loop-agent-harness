/**
 * PersistentPluginRegistry 组合层回归（任务 04 / 需求 20261114-004 P2）。
 *
 * 文件层能力（读写/坏档/原子写）在 store.test.ts 覆盖，这里只测「注册中心把
 * 清单 + Fiber + 加载器串起来」的行为。
 *
 * 关键口径：
 * - 一律用 `loadPlugin` 注入内存插件，不写真实 ESM 文件（D20）：
 *   真实 import() 慢且易被 Windows 文件锁卡住，与「注册中心逻辑」无关。
 * - 落盘断言用文件内容比对，不用 mtime（D21）。
 * - 每个用例注入 mkdtemp 临时目录，绝不碰真实 ~/.loop-agent。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHost, createRootContext, type EventMapBase, type Plugin } from '@loop-agent/core';
import { afterEach, describe, expect, it } from 'vitest';

import { PersistentPluginRegistry } from '../src/registry.js';
import { createPluginStore } from '../src/store.js';
import { MANIFEST_SCHEMA_VERSION, type PluginManifest } from '../src/types.js';

/** 本组用例的临时目录，统一在 afterEach 清理 */
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'loop-main-reg-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

/** 内存插件：不落文件，直接由 loadPlugin 注入（D20） */
function memoryPlugin(name: string, services: Record<string, unknown> = {}): Plugin {
  return {
    name,
    apply(ctx) {
      for (const [key, value] of Object.entries(services)) ctx.provide(key, value);
    },
  };
}

interface Harness {
  dir: string;
  file: string;
  registry: PersistentPluginRegistry;
  /** 卸载顺序记录（逆序断言用） */
  disposeOrder: string[];
  /** specifier → 内存插件 */
  plugins: Map<string, Plugin>;
  /** 让某个 specifier 在加载时抛错 */
  failOn: Set<string>;
}

function makeHarness(initial?: PluginManifest): Harness {
  const dir = makeTempDir();
  const file = join(dir, 'plugins', 'registry.json');
  const plugins = new Map<string, Plugin>();
  const failOn = new Set<string>();
  const disposeOrder: string[] = [];

  const store = createPluginStore({ file });
  if (initial) store.write(initial);

  const host = createHost();
  const context = createRootContext(host);

  const registry = new PersistentPluginRegistry({
    context,
    host,
    store,
    async loadPlugin(specifier) {
      if (failOn.has(specifier)) throw new Error(`加载失败：${specifier}`);
      const plugin = plugins.get(specifier);
      if (!plugin) throw new Error(`未注册的插件：${specifier}`);
      // 包一层以便记录卸载时序
      return {
        name: plugin.name ?? specifier,
        ...(plugin.inject ? { inject: plugin.inject } : {}),
        apply(ctx) {
          ctx.effect(() => () => {
            disposeOrder.push(specifier);
          });
          return plugin.apply(ctx);
        },
      } satisfies Plugin;
    },
  });

  return { dir, file, registry, disposeOrder, plugins, failOn };
}

function readManifest(file: string): PluginManifest {
  return JSON.parse(readFileSync(file, 'utf8')) as PluginManifest;
}

function manifest(
  entries: Array<{ id: string; specifier: string; enabled?: boolean }>,
): PluginManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    entries: entries.map((e) => ({
      id: e.id,
      specifier: e.specifier,
      enabled: e.enabled !== false,
    })),
    updatedAt: new Date().toISOString(),
  };
}

describe('PersistentPluginRegistry：增删', () => {
  it('mount 后条目在、Fiber ACTIVE、文件已落盘', async () => {
    const h = makeHarness();
    h.plugins.set('./a.mjs', memoryPlugin('a'));

    const fiber = await h.registry.mount({ id: 'a', specifier: './a.mjs', enabled: true });

    expect(fiber.state).toBe('ACTIVE');
    expect(h.registry.entries()).toEqual([{ id: 'a', specifier: './a.mjs', enabled: true }]);
    expect(readManifest(h.file).entries).toEqual([
      { id: 'a', specifier: './a.mjs', enabled: true },
    ]);
  });

  it('unmount 卸载 Fiber、删条目、落盘', async () => {
    const h = makeHarness(manifest([{ id: 'a', specifier: './a.mjs' }]));
    h.plugins.set('./a.mjs', memoryPlugin('a'));
    await h.registry.restore();

    await h.registry.unmount('a');

    expect(h.registry.entries()).toEqual([]);
    expect(h.registry.fiberOf('a')).toBeUndefined();
    expect(readManifest(h.file).entries).toEqual([]);
    expect(h.disposeOrder).toContain('./a.mjs');
  });
});

describe('PersistentPluginRegistry：五个写操作均落盘（D4）', () => {
  it('mount / enable / disable / unmount / reorder 各写一次，内容与内存一致', async () => {
    const h = makeHarness();
    for (const s of ['./a.mjs', './b.mjs']) h.plugins.set(s, memoryPlugin(s));

    // 1) mount
    await h.registry.mount({ id: 'a', specifier: './a.mjs', enabled: true });
    expect(readManifest(h.file).entries.map((e) => e.id)).toEqual(['a']);

    await h.registry.mount({ id: 'b', specifier: './b.mjs', enabled: true });
    expect(readManifest(h.file).entries.map((e) => e.id)).toEqual(['a', 'b']);

    // 2) disable
    await h.registry.disable('a');
    expect(readManifest(h.file).entries[0].enabled).toBe(false);

    // 3) enable
    await h.registry.enable('a');
    expect(readManifest(h.file).entries[0].enabled).toBe(true);

    // 4) reorder
    await h.registry.reorder(['b', 'a']);
    expect(readManifest(h.file).entries.map((e) => e.id)).toEqual(['b', 'a']);

    // 5) unmount
    await h.registry.unmount('b');
    expect(readManifest(h.file).entries.map((e) => e.id)).toEqual(['a']);

    // 全程磁盘与内存保持一致
    expect(readManifest(h.file).entries).toEqual(h.registry.entries());
  });

  it('清单顺序即数组下标，不写冗余 order 字段（D17）', async () => {
    const h = makeHarness();
    h.plugins.set('./p1.mjs', memoryPlugin('p1'));
    await h.registry.mount({ id: 'p1', specifier: './p1.mjs', enabled: true });

    expect(Object.keys(readManifest(h.file).entries[0]).sort()).toEqual([
      'enabled',
      'id',
      'specifier',
    ]);
  });
});

describe('PersistentPluginRegistry：启停是一等状态（D7）', () => {
  it('disable 后条目数不变、enabled=false、Fiber 已卸载', async () => {
    const h = makeHarness(manifest([{ id: 'p1', specifier: './p1.mjs' }]));
    h.plugins.set('./p1.mjs', memoryPlugin('p1'));
    await h.registry.restore();
    expect(h.registry.fiberOf('p1')?.state).toBe('ACTIVE');

    await h.registry.disable('p1');

    expect(h.registry.entries()).toHaveLength(1);
    expect(h.registry.entries()[0].enabled).toBe(false);
    expect(h.registry.fiberOf('p1')).toBeUndefined();
    expect(h.disposeOrder).toContain('./p1.mjs');
  });

  it('enable 后 enabled=true、Fiber 重新 ACTIVE、条目位置不变', async () => {
    const h = makeHarness(
      manifest([
        { id: 'a', specifier: './a.mjs' },
        { id: 'b', specifier: './b.mjs', enabled: false },
        { id: 'c', specifier: './c.mjs' },
      ]),
    );
    for (const s of ['./a.mjs', './b.mjs', './c.mjs']) h.plugins.set(s, memoryPlugin(s));
    await h.registry.restore();

    const fiber = await h.registry.enable('b');

    expect(fiber.state).toBe('ACTIVE');
    expect(h.registry.entries().map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(h.registry.entries()[1].enabled).toBe(true);
  });

  it('disable 未知 id 与重复 disable 都是幂等空操作且不写盘', async () => {
    const h = makeHarness(manifest([{ id: 'p1', specifier: './p1.mjs' }]));
    h.plugins.set('./p1.mjs', memoryPlugin('p1'));
    await h.registry.restore();

    await h.registry.disable('nope'); // 未知 id
    await h.registry.disable('p1');
    const snapshot = readFileSync(h.file, 'utf8');

    await h.registry.disable('nope'); // 未知 id
    await h.registry.disable('p1'); // 已停用
    expect(readFileSync(h.file, 'utf8')).toBe(snapshot);
  });

  it('unmount 未知 id 是幂等空操作且不写盘', async () => {
    const h = makeHarness(manifest([{ id: 'p1', specifier: './p1.mjs' }]));
    h.plugins.set('./p1.mjs', memoryPlugin('p1'));
    await h.registry.restore();
    const before = readFileSync(h.file, 'utf8');

    await h.registry.unmount('nope');
    expect(readFileSync(h.file, 'utf8')).toBe(before);
  });
});

describe('PersistentPluginRegistry：排序（D17）', () => {
  it('reorder 按入参顺序重排并落盘', async () => {
    const h = makeHarness(
      manifest([
        { id: 'a', specifier: './a.mjs' },
        { id: 'b', specifier: './b.mjs' },
        { id: 'c', specifier: './c.mjs' },
      ]),
    );
    for (const s of ['./a.mjs', './b.mjs', './c.mjs']) h.plugins.set(s, memoryPlugin(s));
    await h.registry.restore();

    await h.registry.reorder(['c', 'a', 'b']);

    expect(h.registry.entries().map((e) => e.id)).toEqual(['c', 'a', 'b']);
    expect(readManifest(h.file).entries.map((e) => e.id)).toEqual(['c', 'a', 'b']);
  });

  it('reorder 未列出的 id 按原相对序留在尾部', async () => {
    const h = makeHarness(
      manifest([
        { id: 'a', specifier: './a.mjs' },
        { id: 'b', specifier: './b.mjs' },
        { id: 'c', specifier: './c.mjs' },
        { id: 'd', specifier: './d.mjs' },
      ]),
    );
    for (const s of ['./a.mjs', './b.mjs', './c.mjs', './d.mjs']) {
      h.plugins.set(s, memoryPlugin(s));
    }
    await h.registry.restore();

    await h.registry.reorder(['d', 'b']);
    expect(h.registry.entries().map((e) => e.id)).toEqual(['d', 'b', 'a', 'c']);
  });
});

describe('PersistentPluginRegistry：错误与冲突（D10）', () => {
  it('mount 重复 id 抛 PLUGIN_ID_CONFLICT', async () => {
    const h = makeHarness(manifest([{ id: 'p1', specifier: './p1.mjs' }]));
    h.plugins.set('./p1.mjs', memoryPlugin('p1'));
    await h.registry.restore();

    await expect(
      h.registry.mount({ id: 'p1', specifier: './other.mjs', enabled: true }),
    ).rejects.toMatchObject({ code: 'PLUGIN_ID_CONFLICT' });
  });

  it('enable 未知 id 抛 PLUGIN_NOT_FOUND', async () => {
    const h = makeHarness();
    await expect(h.registry.enable('nope')).rejects.toMatchObject({ code: 'PLUGIN_NOT_FOUND' });
  });

  it('reorder 未知 id 抛 PLUGIN_NOT_FOUND', async () => {
    const h = makeHarness(manifest([{ id: 'a', specifier: './a.mjs' }]));
    await expect(h.registry.reorder(['nope'])).rejects.toMatchObject({
      code: 'PLUGIN_NOT_FOUND',
    });
  });

  it('restore 时单条加载失败：记 loadError，其余仍 ACTIVE（不锁死启动）', async () => {
    const h = makeHarness(
      manifest([
        { id: 'good1', specifier: './good1.mjs' },
        { id: 'bad', specifier: './bad.mjs' },
        { id: 'good2', specifier: './good2.mjs' },
      ]),
    );
    h.plugins.set('./good1.mjs', memoryPlugin('good1'));
    h.plugins.set('./good2.mjs', memoryPlugin('good2'));
    h.failOn.add('./bad.mjs');

    await expect(h.registry.restore()).resolves.toBeUndefined();

    const diag = h.registry.diagnose();
    const bad = diag.entries.find((e) => e.id === 'bad');
    expect(bad?.loadError?.message).toContain('加载失败');
    expect(bad?.state).toBeUndefined();
    expect(diag.entries.find((e) => e.id === 'good1')?.state).toBe('ACTIVE');
    expect(diag.entries.find((e) => e.id === 'good2')?.state).toBe('ACTIVE');
  });

  it('mount 加载失败：抛给调用方，但条目保留且 loadError 可见', async () => {
    const h = makeHarness();
    h.failOn.add('./broken.mjs');

    await expect(
      h.registry.mount({ id: 'broken', specifier: './broken.mjs', enabled: true }),
    ).rejects.toThrow('加载失败');

    // 条目保留（用户能看到「我装过它」），并已落盘
    expect(h.registry.entries().map((e) => e.id)).toEqual(['broken']);
    expect(readManifest(h.file).entries.map((e) => e.id)).toEqual(['broken']);
    expect(h.registry.diagnose().entries[0].loadError?.message).toContain('加载失败');
  });

  it('插件 apply 抛错时该条 FAILED，不中断其余', async () => {
    const h = makeHarness(
      manifest([
        { id: 'boom', specifier: './boom.mjs' },
        { id: 'ok', specifier: './ok.mjs' },
      ]),
    );
    h.plugins.set('./ok.mjs', memoryPlugin('ok'));
    h.plugins.set('./boom.mjs', {
      name: 'boom',
      apply() {
        throw new Error('apply 失败');
      },
    });

    await h.registry.restore();

    const diag = h.registry.diagnose();
    expect(diag.entries.find((e) => e.id === 'boom')?.state).toBe('FAILED');
    expect(diag.entries.find((e) => e.id === 'ok')?.state).toBe('ACTIVE');
  });
});

describe('PersistentPluginRegistry：落盘失败与并发（D4/D18）', () => {
  it('落盘失败时内存清单仍更新、persistError 有值、操作不抛', async () => {
    const dir = makeTempDir();
    // 把清单路径指到一个「已被文件占位」的目录下，使 mkdir/rename 必失败
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x', 'utf8');
    const registry = new PersistentPluginRegistry({
      context: createRootContext(createHost()),
      store: createPluginStore({ file: join(blocker, 'registry.json') }),
      loadPlugin: async () => memoryPlugin('p1'),
    });

    await expect(
      registry.mount({ id: 'p1', specifier: './p1.mjs', enabled: true }),
    ).resolves.toBeDefined();

    expect(registry.entries().map((e) => e.id)).toEqual(['p1']);
    expect(registry.diagnose().persistError?.message).toBeTruthy();
  });

  it('落盘目标是个目录时也不抛，仅记录 persistError', async () => {
    const dir = makeTempDir();
    const target = join(dir, 'as-dir');
    mkdirSync(target, { recursive: true });
    const registry = new PersistentPluginRegistry({
      context: createRootContext(createHost()),
      store: createPluginStore({ file: target }),
      loadPlugin: async () => memoryPlugin('p1'),
    });

    await expect(
      registry.mount({ id: 'p1', specifier: './p1.mjs', enabled: true }),
    ).resolves.toBeDefined();
    expect(registry.diagnose().persistError?.message).toBeTruthy();
  });

  it('同进程并发 mount 后，文件内容与内存一致（D18 串行写）', async () => {
    const h = makeHarness();
    const specs = ['./a.mjs', './b.mjs', './c.mjs', './d.mjs', './e.mjs'];
    for (const s of specs) h.plugins.set(s, memoryPlugin(s));

    await Promise.all(
      specs.map((s, i) => h.registry.mount({ id: `p${i}`, specifier: s, enabled: true })),
    );

    expect(h.registry.entries()).toHaveLength(specs.length);
    expect(readManifest(h.file).entries).toEqual(h.registry.entries());
  });

  it('残留 tmp 文件不影响下次读（read 只看 registry.json）', async () => {
    const h = makeHarness();
    h.plugins.set('./p1.mjs', memoryPlugin('p1'));
    await h.registry.mount({ id: 'p1', specifier: './p1.mjs', enabled: true });

    writeFileSync(`${h.file}.tmp.dead`, '{ 半截', 'utf8');
    expect(readManifest(h.file).entries.map((e) => e.id)).toEqual(['p1']);
  });
});

describe('PersistentPluginRegistry：还原与关停（跨实例）', () => {
  it('新实例 restore() 能还原清单并挂回 enabled 插件', async () => {
    const first = makeHarness();
    first.plugins.set('./a.mjs', memoryPlugin('a'));
    first.plugins.set('./b.mjs', memoryPlugin('b'));
    await first.registry.mount({ id: 'a', specifier: './a.mjs', enabled: true });
    await first.registry.mount({ id: 'b', specifier: './b.mjs', enabled: true });
    await first.registry.disable('b');

    // 换一套全新 host + registry，读同一个清单文件（模拟进程重启）
    const host2 = createHost();
    const registry2 = new PersistentPluginRegistry({
      context: createRootContext(host2),
      host: host2,
      store: createPluginStore({ file: first.file }),
      loadPlugin: async (s) => first.plugins.get(s)!,
    });
    await registry2.restore();

    expect(registry2.entries().map((e) => e.id)).toEqual(['a', 'b']);
    expect(registry2.fiberOf('a')?.state).toBe('ACTIVE');
    expect(registry2.fiberOf('b')).toBeUndefined(); // b 已停用，不挂载
  });

  it('restore 幂等：重复调用不重复挂载', async () => {
    const h = makeHarness(manifest([{ id: 'a', specifier: './a.mjs' }]));
    h.plugins.set('./a.mjs', memoryPlugin('a'));

    await h.registry.restore();
    await h.registry.restore();

    expect(h.registry.fiberOf('a')).toBeDefined();
    // 不应出现「同一插件两个 ACTIVE Fiber」的泄漏
    expect(
      h.registry.diagnose().core.fibers.filter((f) => f.name === 'a' && f.state === 'ACTIVE'),
    ).toHaveLength(1);
  });

  it('dispose() 逆序卸载且幂等（返回同一 Promise）', async () => {
    const h = makeHarness(
      manifest([
        { id: 'a', specifier: './a.mjs' },
        { id: 'b', specifier: './b.mjs' },
        { id: 'c', specifier: './c.mjs' },
      ]),
    );
    for (const s of ['./a.mjs', './b.mjs', './c.mjs']) h.plugins.set(s, memoryPlugin(s));
    await h.registry.restore();

    const p1 = h.registry.dispose();
    const p2 = h.registry.dispose();
    expect(p1).toBe(p2);
    await p1;

    // 逆序：后挂载的先卸载
    expect(h.disposeOrder).toEqual(['./c.mjs', './b.mjs', './a.mjs']);
    expect(h.registry.fiberOf('a')).toBeUndefined();
  });

  it('restore 末尾等链式依赖收敛（host.settle 生效）', async () => {
    const dir = makeTempDir();
    const store = createPluginStore({ file: join(dir, 'registry.json') });
    // C 依赖 B 的服务、B 依赖 A 的服务；清单顺序故意倒着写
    store.write(
      manifest([
        { id: 'C', specifier: 'C' },
        { id: 'B', specifier: 'B' },
        { id: 'A', specifier: 'A' },
      ]),
    );

    const host = createHost();
    const registry = new PersistentPluginRegistry<EventMapBase>({
      context: createRootContext(host),
      host,
      store,
      loadPlugin: async (s) => {
        if (s === 'A') return { name: 'A', apply: (c) => void c.provide('a-svc', 'a') };
        if (s === 'B') {
          return { name: 'B', inject: ['a-svc'], apply: (c) => void c.provide('b-svc', 'b') };
        }
        return { name: 'C', inject: ['b-svc'], apply: () => {} };
      },
    });

    await registry.restore();

    // restore() 返回时链式依赖必须已全部 ACTIVE
    expect(registry.diagnose().entries.map((e) => e.state)).toEqual([
      'ACTIVE',
      'ACTIVE',
      'ACTIVE',
    ]);
  });
});
