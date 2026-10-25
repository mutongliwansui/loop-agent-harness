/**
 * SEA 内嵌原生模块（PTY）释放逻辑单测（Task-20261027-002）
 *
 * 这层代码的价值全在「异常路径」上——正常路径在真机上已经跑通了，容易出问题的是：
 * 临时目录被清理工具删掉一半（僵尸目录）、多实例同时首次启动（rename 竞争）、
 * 升级 exe 后新旧目录并存、非 SEA 环境被误触发。故用例重点压这些分支。
 *
 * 做法：mock `node:os` 的 tmpdir 到测试沙箱（避免污染真实 %TEMP%），
 * mock `../src/sea-assets.js` 控制「内嵌了什么」。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 测试沙箱：作为释放根目录，避免动真实 %TEMP% */
const sandbox = vi.hoisted(() => ({ dir: '', realTmp: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  // 记下真实 tmpdir：beforeEach 要用它建沙箱，而对外暴露的 tmpdir 已被改指向沙箱
  sandbox.realTmp = actual.tmpdir();
  return { ...actual, tmpdir: () => sandbox.dir };
});

/** 内嵌资源状态：各用例自行填充 */
const seaState = vi.hoisted(() => ({
  isSea: true,
  assets: new Map<string, Buffer>(),
  /** readSeaAsset 调用计数（用于验证「幂等不重复解包」） */
  reads: 0,
}));

vi.mock('../src/sea-assets.js', () => ({
  isSeaRuntime: () => seaState.isSea,
  readSeaAsset: (key: string) => {
    seaState.reads += 1;
    return seaState.assets.get(key) ?? null;
  },
  readSeaAssetText: (key: string) => {
    const buf = seaState.assets.get(key);
    return buf ? buf.toString('utf8') : null;
  },
}));

/**
 * 模拟 Windows 真实的文件占用：活进程映射了目录里的 `.node` 时，
 * 删除该目录 / rename 到该目录都会 EPERM，而写**其他**文件并不受影响。
 * 这样可精确压「目录删不掉时能否自愈」这条分支，而不必真的去锁文件。
 */
const fsFault = vi.hoisted(() => ({ lockedDirs: new Set<string>(), failingWrites: new Set<string>() }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const eperm = (op: string, p: string) => {
    const e = new Error(`EPERM: operation not permitted, ${op} '${p}'`) as Error & { code: string };
    e.code = 'EPERM';
    return e;
  };
  return {
    ...actual,
    rmSync: (p: Parameters<typeof actual.rmSync>[0], o?: Parameters<typeof actual.rmSync>[1]) => {
      if (fsFault.lockedDirs.has(String(p))) throw eperm('rm', String(p));
      return actual.rmSync(p, o);
    },
    writeFileSync: (
      p: Parameters<typeof actual.writeFileSync>[0],
      d: Parameters<typeof actual.writeFileSync>[1],
      o?: Parameters<typeof actual.writeFileSync>[2],
    ) => {
      if (fsFault.failingWrites.has(String(p))) throw eperm('open', String(p));
      return actual.writeFileSync(p, d, o as never);
    },
  };
});

import {
  ensureEmbeddedPty,
  resetEmbeddedPtyCache,
  hasEmbeddedPty,
  readPtyManifest,
  isExtractedUsable,
  embeddedPtyRoot,
  embeddedPtyRoots,
  lastEmbeddedPtyError,
  PTY_MANIFEST_KEY,
} from '../src/terminal/pty-embed.js';

/** 构造一套最小的合法内嵌内容（结构照抄真实平台包的关键文件） */
function seedAssets(id = 'abcdef123456') {
  const files = [
    'node_modules/@lydell/node-pty/package.json',
    'node_modules/@lydell/node-pty/lib/index.js',
    'node_modules/@lydell/node-pty-win32-x64/package.json',
    'node_modules/@lydell/node-pty-win32-x64/lib/utils.js',
    'node_modules/@lydell/node-pty-win32-x64/prebuilds/win32-x64/conpty.node',
  ];
  const content = (f: string) => Buffer.from(`content-of-${f}`);
  seaState.assets.set(
    PTY_MANIFEST_KEY,
    Buffer.from(
      JSON.stringify({ id, files, sizes: files.map((f) => content(f).length) }),
    ),
  );
  for (const f of files) {
    seaState.assets.set(f, content(f));
  }
  return { id, files };
}


beforeEach(() => {
  sandbox.dir = mkdtempSync(join(sandbox.realTmp, 'pty-embed-test-'));
  fsFault.lockedDirs.clear();
  fsFault.failingWrites.clear();
  seaState.isSea = true;
  seaState.assets = new Map();
  seaState.reads = 0;
  resetEmbeddedPtyCache();
});

afterEach(() => {
  fsFault.lockedDirs.clear();
  fsFault.failingWrites.clear();
  rmSync(sandbox.dir, { recursive: true, force: true });
  resetEmbeddedPtyCache();
});

describe('readPtyManifest：清单解析与校验', () => {
  it('没有内嵌清单时返回 null（构建时未装原生包的场景）', () => {
    expect(readPtyManifest()).toBeNull();
    expect(hasEmbeddedPty()).toBe(false);
  });

  it('合法清单可解析出 id 与文件列表', () => {
    const { id, files } = seedAssets();
    const m = readPtyManifest();
    expect(m?.id).toBe(id);
    expect(m?.files).toEqual(files);
  });

  it('id 不合规（非 hex / 过短）视为无效，避免被拼成可疑目录名', () => {
    seaState.assets.set(
      PTY_MANIFEST_KEY,
      Buffer.from(JSON.stringify({ id: '../../evil', files: ['a.node'] })),
    );
    expect(readPtyManifest()).toBeNull();
  });

  it('files 为空视为无效（否则会建出空目录并误判可用）', () => {
    seaState.assets.set(PTY_MANIFEST_KEY, Buffer.from(JSON.stringify({ id: 'abcdef123456', files: [] })));
    expect(readPtyManifest()).toBeNull();
  });

  it('清单不是合法 JSON 时返回 null 而不抛', () => {
    seaState.assets.set(PTY_MANIFEST_KEY, Buffer.from('{not json'));
    expect(() => readPtyManifest()).not.toThrow();
    expect(readPtyManifest()).toBeNull();
  });
});

describe('embeddedPtyRoot：指纹目录（D3）', () => {
  it('目录名带内容指纹，不同指纹互不干扰（多版本并存）', () => {
    const a = embeddedPtyRoot('aaaaaaaaaaaa');
    const b = embeddedPtyRoot('bbbbbbbbbbbb');
    expect(a).not.toBe(b);
    expect(a).toContain('aaaaaaaaaaaa');
    expect(a.startsWith(sandbox.dir)).toBe(true);
  });
});

describe('isExtractedUsable：损坏判据（D5）', () => {
  it('缺 .ready 视为不可用', () => {
    const { id, files } = seedAssets();
    const root = embeddedPtyRoot(id);
    const m = readPtyManifest()!;
    // 文件都写出来但故意不写 .ready
    for (const f of files) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), 'x');
    }
    expect(isExtractedUsable(root, m)).toBe(false);
  });

  it('目录在、.ready 在，但原生 .node 被清理工具删掉 → 判为损坏（这是最危险的僵尸态）', () => {
    seedAssets();
    const root = embeddedPtyRoot('abcdef123456');
    mkdirSync(join(root, 'node_modules/@lydell/node-pty-win32-x64/prebuilds/win32-x64'), { recursive: true });
    writeFileSync(join(root, '.ready'), 'abcdef123456');
    const m = readPtyManifest()!;
    expect(isExtractedUsable(root, m)).toBe(false);
  });

  it('清单里没有 .node 时退化为只看 .ready，避免异常清单导致永久不可用', () => {
    seaState.assets.set(
      PTY_MANIFEST_KEY,
      Buffer.from(JSON.stringify({ id: 'abcdef123456', files: ['a.js'] })),
    );
    const root = embeddedPtyRoot('abcdef123456');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '.ready'), 'abcdef123456');
    expect(isExtractedUsable(root, readPtyManifest()!)).toBe(true);
  });
});

describe('ensureEmbeddedPty：释放主链路', () => {
  it('非 SEA 运行时直接返回 null 且零副作用（开发环境不该碰临时目录）', () => {
    seaState.isSea = false;
    seedAssets();
    expect(ensureEmbeddedPty()).toBeNull();
    expect(seaState.reads).toBe(0); // 连清单都没读
    expect(existsSync(join(sandbox.dir, 'loop-agent-pty-abcdef123456'))).toBe(false);
  });

  it('正常释放：整树落盘、写 .ready、返回可加载锚点', () => {
    const { id, files } = seedAssets();
    const info = ensureEmbeddedPty();
    expect(info).not.toBeNull();
    expect(info!.root).toBe(embeddedPtyRoot(id));
    // 整树结构必须保留（lib 用相对 require，dll/exe 在子目录）
    for (const f of files) {
      expect(existsSync(join(info!.root, f))).toBe(true);
    }
    expect(existsSync(join(info!.root, '.ready'))).toBe(true);
    // 内容无损
    expect(readFileSync(join(info!.root, files[0]), 'utf8')).toBe(`content-of-${files[0]}`);
    // anchor 只用于 createRequire 基准，不必真实存在
    expect(info!.anchor.startsWith(info!.root)).toBe(true);
  });

  it('幂等：第二次调用复用同一目录，不重复解包（D3）', () => {
    seedAssets();
    const first = ensureEmbeddedPty();
    expect(first).not.toBeNull();
    // 埋一个哨兵文件：若发生重建（rmSync 整目录）它就会消失
    const sentinel = join(first!.root, 'sentinel.txt');
    writeFileSync(sentinel, 'keep-me');
    resetEmbeddedPtyCache(); // 清进程内缓存，强制走真实判定
    const second = ensureEmbeddedPty();
    expect(second!.root).toBe(first!.root);
    expect(existsSync(sentinel)).toBe(true);
  });

  it('损坏自愈：.node 被删后再次启动能重建（D5）', () => {
    const { files } = seedAssets();
    const first = ensureEmbeddedPty()!;
    const nativeRel = files.find((f) => f.endsWith('.node'))!;
    rmSync(join(first.root, nativeRel)); // 模拟 %TEMP% 被清理工具删了一半
    resetEmbeddedPtyCache();
    const second = ensureEmbeddedPty();
    expect(second).not.toBeNull();
    expect(existsSync(join(second!.root, nativeRel))).toBe(true);
  });

  it('未内嵌清单时返回 null 并记录原因（供提示文案使用，D8）', () => {
    expect(ensureEmbeddedPty()).toBeNull();
    expect(lastEmbeddedPtyError()).toContain(PTY_MANIFEST_KEY);
  });

  it('清单声明了文件但资源缺失 → 降级为 null 而非抛异常（服务必须能启动）', () => {
    seaState.assets.set(
      PTY_MANIFEST_KEY,
      Buffer.from(
        JSON.stringify({
          id: 'abcdef123456',
          files: ['node_modules/@lydell/node-pty/lib/index.js'],
        }),
      ),
    );
    // 故意不放对应 asset
    expect(() => ensureEmbeddedPty()).not.toThrow();
    expect(ensureEmbeddedPty()).toBeNull();
    expect(lastEmbeddedPtyError()).toBeTruthy();
  });

  it('目标目录被抢占但内容已可用时复用，不因 rename 失败而报错（D4 并发路径）', () => {
    const { id, files } = seedAssets();
    // 预先造出一个「另一实例已发布完成」的目录
    const root = embeddedPtyRoot(id);
    for (const f of files) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), `content-of-${f}`);
    }
    writeFileSync(join(root, '.ready'), id);
    const info = ensureEmbeddedPty();
    expect(info).not.toBeNull();
    expect(info!.root).toBe(root);
  });
});

describe('截断文件判定（尺寸校验）', () => {
  it('文件在但字节数不符（写一半崩了）→ 判为损坏', () => {
    const { id, files } = seedAssets();
    const root = embeddedPtyRoot(id);
    for (const f of files) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), `content-of-${f}`);
    }
    writeFileSync(join(root, '.ready'), id);
    const m = readPtyManifest()!;
    expect(isExtractedUsable(root, m)).toBe(true);

    const nativeRel = files.find((f) => f.endsWith('.node'))!;
    writeFileSync(join(root, nativeRel), 'content-of-node_mod'); // 截断
    expect(isExtractedUsable(root, m)).toBe(false);
  });

  it('旧产物无 sizes 字段时退化为仅校验存在性（向后兼容）', () => {
    const { id, files } = seedAssets();
    const root = embeddedPtyRoot(id);
    for (const f of files) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), 'x'); // 尺寸完全不符
    }
    writeFileSync(join(root, '.ready'), id);
    seaState.assets.set(PTY_MANIFEST_KEY, Buffer.from(JSON.stringify({ id, files })));
    expect(isExtractedUsable(root, readPtyManifest()!)).toBe(true);
  });

  it('sizes 与 files 不等长 → 整份清单作废（不按错误判据复用目录）', () => {
    const { id, files } = seedAssets();
    seaState.assets.set(
      PTY_MANIFEST_KEY,
      Buffer.from(JSON.stringify({ id, files, sizes: [1, 2] })),
    );
    expect(readPtyManifest()).toBeNull();
  });
});

describe('目录删不掉时的自愈（Windows 文件占用）', () => {
  /**
   * 真实场景：另一个实例正跑着并把 conpty.node 映射进地址空间，
   * 于是 `rmSync` 整目录必然 EPERM。旧实现到这里就永久放弃（重启也修不好）。
   */
  it('目录被占用删不掉，但只缺部分文件 → 原地补缺成功，不必新建目录', () => {
    const { id, files } = seedAssets();
    const root = embeddedPtyRoot(id);
    const nativeRel = files.find((f) => f.endsWith('.node'))!;

    // 造出「被清理工具删了一半」的目录：只留一部分文件，且没有 .ready
    for (const f of files) {
      if (f === nativeRel) continue;
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), `content-of-${f}`);
    }
    // 整目录删除会失败（模拟被占用）
    fsFault.lockedDirs.add(root);

    const info = ensureEmbeddedPty();
    expect(info).not.toBeNull();
    expect(info!.root).toBe(root); // 仍用规范目录，没有退到备用目录
    expect(readFileSync(join(root, nativeRel), 'utf8')).toBe(`content-of-${nativeRel}`);
    expect(existsSync(join(root, '.ready'))).toBe(true);
  });

  it('规范目录既删不掉又补不齐（缺的正好是被锁的文件）→ 退到备用目录仍可用', () => {
    const { id, files } = seedAssets();
    const root = embeddedPtyRoot(id);
    const nativeRel = files.find((f) => f.endsWith('.node'))!;

    mkdirSync(root, { recursive: true });
    // 规范目录整体不可删；且那个 .node 也写不进去（被映射，无法覆盖）
    fsFault.lockedDirs.add(root);
    fsFault.failingWrites.add(join(root, nativeRel));

    const info = ensureEmbeddedPty();
    expect(info).not.toBeNull();
    expect(info!.root).toBe(`${root}-b1`);
    expect(existsSync(join(info!.root, nativeRel))).toBe(true);
    expect(lastEmbeddedPtyError()).toBeNull();
  });

  it('所有候选目录都失败 → 返回 null 且原因里带上每个候选路径（便于用户清理）', () => {
    const { id, files } = seedAssets();
    const nativeRel = files.find((f) => f.endsWith('.node'))!;
    for (const root of embeddedPtyRoots(id)) {
      mkdirSync(root, { recursive: true });
      fsFault.lockedDirs.add(root);
      fsFault.failingWrites.add(join(root, nativeRel));
    }
    expect(ensureEmbeddedPty()).toBeNull();
    const err = lastEmbeddedPtyError()!;
    for (const root of embeddedPtyRoots(id)) expect(err).toContain(root);
  });
});

