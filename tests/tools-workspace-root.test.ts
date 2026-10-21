// 工具层消费 workspaceRoot 单测（Task-20261021-010-02 §6.2）
//
// 核心断言：**不做 chdir** 的前提下，两个临时目录 A/B 的相对路径读写各自落点正确、互不串。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileWrite } from '../src/tools/fileWrite.js';
import { fileRead } from '../src/tools/fileRead.js';
import { editFile } from '../src/tools/editFile.js';
import { grep } from '../src/tools/grep.js';
import { commandRun } from '../src/tools/commandRun.js';
import { runner } from '../src/tools/runner.js';
import { runWithWorkspace } from '../src/runtime/workspace-context.js';
import type { Tool } from '../src/types.js';

let A = '';
let B = '';

/** 探测工具：回显 runner 注入的 workspaceRoot */
const probe: Tool = {
  name: 'probe',
  description: 'probe',
  parameters: { type: 'object', properties: {} },
  async execute(_args, ctx) {
    return ctx?.workspaceRoot ?? '(none)';
  },
};

/** 路径比较用归一（win32 反斜杠与大小写） */
function norm(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

describe('工具层 workspaceRoot', () => {
  beforeAll(async () => {
    A = await mkdtemp(join(tmpdir(), 'loop-agent-ws-a-'));
    B = await mkdtemp(join(tmpdir(), 'loop-agent-ws-b-'));
  });

  afterAll(async () => {
    await rm(A, { recursive: true, force: true });
    await rm(B, { recursive: true, force: true });
  });

  it('fileWrite 相对路径分别落在各自空间（互不串）', async () => {
    await fileWrite.execute({ path: 'out.txt', content: 'from-A' }, { workspaceRoot: A });
    await fileWrite.execute({ path: 'out.txt', content: 'from-B' }, { workspaceRoot: B });

    expect(await readFile(join(A, 'out.txt'), 'utf-8')).toBe('from-A');
    expect(await readFile(join(B, 'out.txt'), 'utf-8')).toBe('from-B');
  });

  it('fileWrite 自动创建空间内父目录', async () => {
    await fileWrite.execute({ path: 'nested/deep/x.txt', content: 'x' }, { workspaceRoot: A });
    expect(await readFile(join(A, 'nested', 'deep', 'x.txt'), 'utf-8')).toBe('x');
  });

  it('fileRead 相对路径只在各自空间读取', async () => {
    const ra = await fileRead.execute({ path: 'out.txt' }, { workspaceRoot: A });
    const rb = await fileRead.execute({ path: 'out.txt' }, { workspaceRoot: B });
    expect(ra).toContain('from-A');
    expect(rb).toContain('from-B');
  });

  it('editFile 相对路径只改各自空间', async () => {
    await writeFile(join(A, 'target.txt'), 'hello A', 'utf-8');
    await writeFile(join(B, 'target.txt'), 'hello B', 'utf-8');
    await editFile.execute(
      { path: 'target.txt', oldText: 'hello', newText: 'bye' },
      { workspaceRoot: A },
    );
    expect(await readFile(join(A, 'target.txt'), 'utf-8')).toBe('bye A');
    expect(await readFile(join(B, 'target.txt'), 'utf-8')).toBe('hello B');
  });

  it('grep 相对起点跟随空间根', async () => {
    await writeFile(join(A, 'note.txt'), 'needle-a', 'utf-8');
    await writeFile(join(B, 'note.txt'), 'needle-b', 'utf-8');
    const ra = await grep.execute({ pattern: 'needle', path: '.' }, { workspaceRoot: A });
    expect(ra).toContain('needle-a');
    expect(ra).not.toContain('needle-b');
  });

  it('绝对路径原样放行（D20：不新增越界拒绝）', async () => {
    const outside = join(tmpdir(), `loop-agent-outsider-${Date.now()}.txt`);
    await writeFile(outside, 'outside', 'utf-8');
    try {
      const r = await fileRead.execute({ path: outside }, { workspaceRoot: A });
      expect(r).toContain('outside');
    } finally {
      await rm(outside, { force: true });
    }
  });

  it('runner：显式 workspaceRoot 优先于 ALS', async () => {
    const got = await runWithWorkspace(
      { root: A, id: 'id-a' },
      () => runner.run(probe, {}, { workspaceRoot: B }),
    );
    expect(got).toBe(B);
  });

  it('runner：无显式根时回落 ALS', async () => {
    const got = await runWithWorkspace({ root: A, id: 'id-a' }, () => runner.run(probe, {}));
    expect(got).toBe(A);
  });

  it('runner：无显式根且无 ALS 时回落 process.cwd()（CLI 语义不变）', async () => {
    const got = await runner.run(probe, {});
    expect(norm(got)).toBe(norm(process.cwd()));
  });

  it('commandRun：无 args.cwd 时在注入根执行且不改变进程 cwd', async () => {
    const before = process.cwd();
    const cmd = process.platform === 'win32' ? 'cd' : 'pwd';
    const out = await commandRun.execute({ command: cmd }, { workspaceRoot: A });
    expect(norm(out)).toContain(norm(A));
    expect(process.cwd()).toBe(before);
  });

  it('commandRun：相对 args.cwd 按空间根展开', async () => {
    await mkdir(join(A, 'sub'), { recursive: true });
    const cmd = process.platform === 'win32' ? 'cd' : 'pwd';
    const out = await commandRun.execute({ command: cmd, cwd: 'sub' }, { workspaceRoot: A });
    expect(norm(out)).toContain(norm(join(A, 'sub')));
  });
});
