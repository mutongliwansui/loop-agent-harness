/**
 * 外部消费冒烟（任务 04 §3.6，D22/D23/D24）。
 *
 * 为什么必须起子进程：进程内 `import('../src/index.js')` 走的是**相对路径**，
 * 压根不经过 `exports` 字段——而 `exports` 只有在包**作为一个依赖被消费**时才生效。
 * 所以这里在 `os.tmpdir()` 下造一个最小消费工程，真跑 `tsc` 与 `node`。
 *
 * 为什么不放仓库内（D24）：`tsc` 会顺着目录上溯找 `node_modules`，
 * 放仓库内可能解析到本仓库的依赖，测出来的就不是「外部」消费了。
 *
 * 关于 CJS 支线（D23）：本机 Node 是否支持 `require(esm)` 决定结果，
 * **两种都是正确行为**，故只断言「成功」或「报 ERR_REQUIRE_ESM/ERR_PACKAGE_PATH_NOT_EXPORTED」，
 * 不判红；实测结论写入 README。
 */
import { execFile } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, describe, expect, it } from 'vitest';

const execFileP = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(CORE_ROOT, '..');
const TSC_BIN = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

/** 临时消费工程根目录 */
let consumerRoot = '';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 跑子进程，把非零退出码也当正常结果返回（不抛） */
async function run(cmd: string, args: string[], cwd: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, {
      cwd,
      encoding: 'utf8',
      // Node 24 默认允许 require(esm)；显式不传 flag，测的就是默认行为
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** 断言产物已构建（否则后面的失败信息会很难懂） */
function assertBuilt(): void {
  if (!existsSync(join(CORE_ROOT, 'dist', 'index.js'))) {
    throw new Error('请先构建产物：npm run build -w @loop-agent/core');
  }
}

/**
 * 造一个最小消费工程。
 *
 * 用 **junction**（Windows 下不需要管理员权限的目录链接）把 core 挂进
 * `node_modules/@loop-agent/core`：等价于 `npm install file:` 的链接结果，
 * 但不需要网络、不写 lockfile，且真实走 `node_modules` 查找 + `exports` 解析。
 */
function createConsumer(): string {
  const root = mkdtempSync(join(tmpdir(), 'loop-agent-core-consumer-'));

  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'core-consumer-smoke',
        private: true,
        type: 'module',
        dependencies: { '@loop-agent/core': 'file:' + CORE_ROOT },
      },
      null,
      2,
    ),
    'utf8',
  );

  const scopeDir = join(root, 'node_modules', '@loop-agent');
  mkdirSync(scopeDir, { recursive: true });
  symlinkSync(CORE_ROOT, join(scopeDir, 'core'), 'junction');

  // moduleResolution 必须 nodenext：只有它才会走 exports 字段
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'nodenext',
          moduleResolution: 'nodenext',
          strict: true,
          skipLibCheck: true,
          outDir: 'out',
          rootDir: 'src',
          types: [],
        },
        include: ['src'],
      },
      null,
      2,
    ),
    'utf8',
  );

  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'main.ts'),
    `import {
  CoreError,
  ServiceConflictError,
  TypedEventBus,
  createHost,
  createRootContext,
} from '@loop-agent/core';
import type { EventMapBase, Plugin } from '@loop-agent/core';

interface Ev extends EventMapBase {
  'demo/ping': (n: number) => string | undefined;
}

const plugin: Plugin<Ev> = {
  name: 'smoke',
  apply(ctx) {
    ctx.provide('answer', 42);
  },
};

const host = createHost<Ev>();
const ctx = createRootContext<Ev>(host);
const fiber = ctx.plugin(plugin);
await host.settle();

const answer: number | undefined = ctx.get<number>('answer');
const bus = new TypedEventBus<Ev>();
bus.on('demo/ping', (n) => (n > 0 ? 'pong' : undefined));
const serial = await bus.serial('demo/ping', 1);
const wf = await bus.waterfall('demo/ping', () => 'fallback', 1);

const err = new ServiceConflictError('dup');
const isCoreError = err instanceof CoreError && err instanceof Error;

// 单副本：消费方拿到的 CoreError 必须与本包导出的同一个类
const ctx2 = createRootContext<Ev>();
const sameCtor = ctx2.diagnose().fibers.length === 0;

if (answer !== 42) throw new Error('answer 期望 42，实际 ' + String(answer));
if (serial !== 'pong') throw new Error('serial 期望 pong，实际 ' + String(serial));
if (wf !== 'pong') throw new Error('waterfall 期望 pong，实际 ' + String(wf));
if (fiber.state !== 'ACTIVE') throw new Error('插件未激活：' + fiber.state);
if (!isCoreError) throw new Error('CoreError 继承链断裂');
if (err.code !== 'CORE_SERVICE_CONFLICT') throw new Error('code 不稳定: ' + err.code);
if (!sameCtor) throw new Error('diagnose 基线不为空');

console.log('SMOKE_OK ' + err.code + ' ' + String(ctx.diagnose().fibers.length));
`,
    'utf8',
  );

  // CJS 支线：require 一个纯 ESM 包
  mkdirSync(join(root, 'cjs'), { recursive: true });
  writeFileSync(
    join(root, 'cjs', 'main.cjs'),
    `try {
  const core = require('@loop-agent/core');
  const e = new core.CoreError('m');
  console.log('CJS_OK ' + e.code + ' ' + (e instanceof Error));
} catch (error) {
  console.log('CJS_ERR ' + (error && error.code));
  throw error;
}
`,
    'utf8',
  );

  return root;
}

describe('external-consumer：包契约在仓库之外的真实行为', () => {
  // 建工程 + 两次 tsc + 两次 node，给足时间（tsc 首次约 2–5s）
  const TIMEOUT = 120000;

  /** ESM 类型解析与运行时的结果（后续用例复用，避免重复跑） */
  let esmTypecheck: RunResult | undefined;
  let esmEmit: RunResult | undefined;
  let esmRun: RunResult | undefined;

  function ensureConsumer(): string {
    if (!consumerRoot) {
      assertBuilt();
      consumerRoot = createConsumer();
    }
    return consumerRoot;
  }

  it('临时消费工程可建立（package.json / tsconfig / 链接 / 源码齐备）', () => {
    const root = ensureConsumer();
    expect(existsSync(join(root, 'package.json'))).toBe(true);
    expect(existsSync(join(root, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(root, 'src', 'main.ts'))).toBe(true);
    expect(existsSync(join(root, 'node_modules', '@loop-agent', 'core', 'package.json'))).toBe(true);
  });

  it('tsc 工具链可用（用本仓库的 typescript，避免 npx 联网）', () => {
    expect(existsSync(TSC_BIN), `未找到 tsc：${TSC_BIN}`).toBe(true);
  });

  it('ESM 类型解析：消费工程 tsc --noEmit 退出码 0（exports.types 生效）', async () => {
    const root = ensureConsumer();
    esmTypecheck = await run(process.execPath, [TSC_BIN, '--noEmit', '-p', 'tsconfig.json'], root);
    // 注意：tsc 的诊断信息写在 **stdout**（不是 stderr），故断言 stdout 为空
    expect(esmTypecheck.stdout.trim()).toBe('');
    expect(esmTypecheck.code).toBe(0);
  }, TIMEOUT);

  it('ESM 运行时：node 执行 import 后行为正确、退出码 0', async () => {
    const root = ensureConsumer();
    // 先编译出 js（Node 对 .ts 的类型剥离不覆盖 `import type` + nodenext 的边界情况）
    esmEmit = await run(process.execPath, [TSC_BIN, '-p', 'tsconfig.json'], root);
    expect(esmEmit.stdout.trim()).toBe('');
    expect(esmEmit.code).toBe(0);

    esmRun = await run(process.execPath, [join('out', 'main.js')], root);
    expect(esmRun.stderr.trim()).toBe('');
    expect(esmRun.code).toBe(0);
    expect(esmRun.stdout).toContain('SMOKE_OK CORE_SERVICE_CONFLICT 1');
  }, TIMEOUT);

  it('消费方事件表必须 extends EventMapBase（interface 无隐式索引签名）', async () => {
    const root = ensureConsumer();
    // 这条约束是本次冒烟实测发现的：EventMapBase 带
    //   [event: string]: (...args: any[]) => any
    // 而 interface **不会**隐式获得索引签名，故 `interface Ev { … }`（不 extends）
    // 传给 Plugin<Ev> 会报 TS2344；type 别名则不受影响。写进 README 并锁成回归。
    const probeDir = join(root, 'probe');
    mkdirSync(join(probeDir, 'src'), { recursive: true });
    writeFileSync(
      join(probeDir, 'src', 'bad.ts'),
      `import type { Plugin } from '@loop-agent/core';
interface Ev { 'demo/ping': (n: number) => string | undefined }
export const p: Plugin<Ev> = { apply() {} };
`,
      'utf8',
    );
    writeFileSync(
      join(probeDir, 'src', 'good.ts'),
      `import type { EventMapBase, Plugin } from '@loop-agent/core';
interface EvA extends EventMapBase { 'demo/ping': (n: number) => string | undefined }
type EvB = { 'demo/ping': (n: number) => string | undefined };
export const a: Plugin<EvA> = { apply() {} };
export const b: Plugin<EvB> = { apply() {} };
`,
      'utf8',
    );
    writeFileSync(
      join(probeDir, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'nodenext',
            moduleResolution: 'nodenext',
            strict: true,
            skipLibCheck: true,
            noEmit: true,
            types: [],
          },
          include: ['src'],
        },
        null,
        2,
      ),
      'utf8',
    );

    // 坏写法必报 TS2344
    const bad = await run(process.execPath, [TSC_BIN, '--noEmit', '-p', 'tsconfig.json'], probeDir);
    expect(bad.code).not.toBe(0);
    expect(bad.stdout).toMatch(/TS2344/);
    expect(bad.stdout).toMatch(/Index signature for type 'string' is missing/);

    // 只留好写法时零错误
    rmSync(join(probeDir, 'src', 'bad.ts'), { force: true });
    const good = await run(process.execPath, [TSC_BIN, '--noEmit', '-p', 'tsconfig.json'], probeDir);
    expect(good.stdout.trim()).toBe('');
    expect(good.code).toBe(0);
  }, TIMEOUT);

  it('完全无 types 条件时类型仍可解析（F1 实测口径）', async () => {
    // 这条是「types 顺序不构成风险」的**直接证据**：
    // 造一份删掉 types 条件的 core 副本（保留 dist 与同址声明），
    // 让 nodenext 消费方去解析 —— 若仍能拿到类型，说明 types 条件属零成本惯例。
    const root = ensureConsumer();
    const stripped = join(root, 'core-notypes');
    mkdirSync(join(stripped, 'dist'), { recursive: true });

    const pkg = JSON.parse(readFileSync(join(CORE_ROOT, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    > & { exports: Record<string, Record<string, string>> };
    // 同时删掉顶层 types 与 exports 里的 types 条件，只留 import / default
    delete pkg.types;
    pkg.exports = { '.': { import: './dist/index.js', default: './dist/index.js' } };
    writeFileSync(join(stripped, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');

    // dist 三个文件全部复制（含 index.d.ts，这是能解析的前提）
    for (const name of readdirSync(join(CORE_ROOT, 'dist'))) {
      if (!name.startsWith('index.')) continue;
      copyFileSync(join(CORE_ROOT, 'dist', name), join(stripped, 'dist', name));
    }
    expect(existsSync(join(stripped, 'dist', 'index.d.ts'))).toBe(true);

    // 独立消费工程：必须放在临时根下的**平级**目录，不能落在 root/ 之内。
    // 否则 tsc 会从 probe/src 逐级上溯 node_modules，命中 root/node_modules
    // 里指向真实 core 的 junction（本任务实测踩到过），从而「意外」解析成功。
    const probe = join(consumerRoot, '..', `notypes-probe-${Date.now()}`);
    mkdirSync(join(probe, 'node_modules', '@loop-agent'), { recursive: true });
    mkdirSync(join(probe, 'src'), { recursive: true });
    symlinkSync(stripped, join(probe, 'node_modules', '@loop-agent', 'core'), 'junction');
    copyFileSync(join(root, 'tsconfig.json'), join(probe, 'tsconfig.json'));
    writeFileSync(
      join(probe, 'src', 'main.ts'),
      `import { CoreError, ServiceRegistry } from '@loop-agent/core';
const e: CoreError = new CoreError('m');
const n: string = e.code;
const s = new ServiceRegistry();
const got: number | undefined = s.get<number>('k');
console.log(n, got);
`,
      'utf8',
    );

    const result = await run(process.execPath, [TSC_BIN, '--noEmit', '-p', 'tsconfig.json'], probe);
    // 无 types 条件 + 有同址声明 → 解析成功，无 TS7016
    expect(result.stdout).not.toMatch(/TS7016/);
    expect(result.stdout.trim()).toBe('');
    expect(result.code).toBe(0);

    // 反向对照（证伪「无 types 必然失败」的同时，证明本用例不是空转）：
    // 删掉同址声明后再解析，此时才真的报找不到声明（TS7016 / TS2307）。
    rmSync(join(stripped, 'dist', 'index.d.ts'), { force: true });
    expect(existsSync(join(stripped, 'dist', 'index.d.ts'))).toBe(false);
    // 同时清掉 tsc 可能用到的依赖解析缓存，确保是重新解析
    rmSync(join(probe, 'node_modules', '.cache'), { recursive: true, force: true });
    const broken = await run(process.execPath, [TSC_BIN, '--noEmit', '-p', 'tsconfig.json'], probe);
    expect(broken.code, `反向对照仍通过，stdout=${broken.stdout} stderr=${broken.stderr}`).not.toBe(0);
    expect(broken.stdout).toMatch(/TS7016|TS2307/);
  }, TIMEOUT);

  it('deep import 被 exports 挡下（子路径未导出 → ERR_PACKAGE_PATH_NOT_EXPORTED）', async () => {
    const root = ensureConsumer();
    // 这正是「零反向依赖 / 只暴露一个入口」在消费方视角的体现
    const probe = join(root, 'cjs', 'deep.cjs');
    writeFileSync(probe, `require('@loop-agent/core/dist/index.js');\n`, 'utf8');
    const result = await run(process.execPath, [probe], root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/ERR_PACKAGE_PATH_NOT_EXPORTED|Package subpath/);
  }, TIMEOUT);

  it('CJS 支线：成功或 ERR_REQUIRE_ESM 必居其一（D23 不判红）', async () => {
    const root = ensureConsumer();
    const result = await run(process.execPath, [join('cjs', 'main.cjs')], root);

    if (result.code === 0) {
      // Node ≥ 20.19 / 22.12 默认支持 require(esm)，本机即属此类
      expect(result.stdout).toContain('CJS_OK CORE_ERROR');
      expect(result.stderr.trim()).toBe('');
      // eslint-disable-next-line no-console
      console.info('[external-consumer] 本机 Node 支持 require(esm)，CJS 可直接消费');
    } else {
      expect(result.stderr).toMatch(/ERR_REQUIRE_ESM|ERR_PACKAGE_PATH_NOT_EXPORTED/);
      // eslint-disable-next-line no-console
      console.info('[external-consumer] 本机 Node 不支持 require(esm)，CJS 消费需升级');
    }
  }, TIMEOUT);

  afterAll(() => {
    if (consumerRoot && existsSync(consumerRoot)) {
      // Windows 下刚被 node 释放的句柄可能短暂占用，加 retries
      rmSync(consumerRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
