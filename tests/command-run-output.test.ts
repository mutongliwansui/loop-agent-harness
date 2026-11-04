// 需求 20261104-006：前台 commandRun 收敛（头尾累积器 + spawn 标签 + 超时/取消）
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  OutputAccumulator,
  configureCommandRunOutput,
  commandRunOutputOptions,
} from '../src/tools/command-run-output.js';
import { commandRun } from '../src/tools/commandRun.js';

afterEach(() => {
  configureCommandRunOutput({ outputLimitKb: 256, timeoutMs: 30000 });
});

describe('OutputAccumulator 头尾截断', () => {
  it('输出小于配额时完整保留，无省略标记', () => {
    const acc = new OutputAccumulator(16, 16);
    acc.push(Buffer.from('hello world'));
    const r = acc.render();
    expect(r.text).toBe('hello world');
    expect(r.omittedBytes).toBe(0);
    expect(r.totalBytes).toBe(11);
  });

  it('超过配额时保留头尾，输出省略字节标记', () => {
    const acc = new OutputAccumulator(5, 5);
    const body = 'HEAD' + 'x'.repeat(90) + 'TAIL';
    acc.push(Buffer.from(body));
    const r = acc.render();
    expect(r.text.startsWith('HEAD')).toBe(true);
    expect(r.text.endsWith('TAIL')).toBe(true);
    expect(r.text).toContain('省略 88 字节');
    expect(r.totalBytes).toBe(98);
  });

  it('分批写入也能跨块累积头尾', () => {
    const acc = new OutputAccumulator(4, 4);
    acc.push(Buffer.from('ab'));
    acc.push(Buffer.from('cdefghij'));
    acc.push(Buffer.from('klmn'));
    const r = acc.render();
    expect(r.text.startsWith('abcd')).toBe(true);
    expect(r.text.endsWith('klmn')).toBe(true);
    expect(r.omittedBytes).toBe(6);
  });

  it('UTF-8 多字节字符在截断点不出现替换符', () => {
    const acc = new OutputAccumulator(2, 2); // 2 字节恰好切在一个汉字中间
    acc.push(Buffer.from('中文测试尾部内容'));
    const r = acc.render();
    expect(r.text).not.toContain('\uFFFD');
  });
});

describe('commandRun 前台行为', () => {
  it('成功输出保持旧观感：不加 [exit=0]，stderr 只出现一次标签', async () => {
    const out = await commandRun.execute(
      { command: 'node -e "console.log(\'hi\'); console.error(\'err\')"' },
      { workspaceRoot: process.cwd() },
    ) as string;
    expect(out).toContain('[stdout]');
    expect(out).toContain('hi');
    expect(out).toContain('[stderr]');
    expect(out).toContain('err');
    expect(out).not.toContain('[stderr]\n[stderr]');
    expect(out).not.toContain('[exit=0]');
  });

  it('非零退出附 [exit=N] 与耗时', async () => {
    const out = await commandRun.execute(
      { command: 'node -e "process.exit(3)"' },
      { workspaceRoot: process.cwd() },
    ) as string;
    expect(out).toContain('[exit=3]');
    expect(out).toMatch(/\[duration=\d+ms\]/);
  });

  it('超时被杀并附 [timeout=Nms]', async () => {
    const out = await commandRun.execute(
      { command: 'node -e "setTimeout(()=>{}, 5000)"', timeout: 200 },
      { workspaceRoot: process.cwd() },
    ) as string;
    expect(out).toContain('[timeout=200ms]');
    expect(out).toMatch(/\[duration=\d+ms\]/);
  }, 10000);

  it('已取消的 signal 不启动进程，立即返回 [aborted]', async () => {
    const ac = new AbortController();
    ac.abort();
    const out = await commandRun.execute(
      { command: 'node -e "console.log(1)"' },
      { workspaceRoot: process.cwd(), signal: ac.signal },
    ) as string;
    expect(out).toBe('[aborted]');
  });

  it('10MB 输出不失败：头尾保留并标注省略', async () => {
    configureCommandRunOutput({ outputLimitKb: 1, timeoutMs: 30000 });
    const out = await commandRun.execute(
      {
        command: 'node -e "const s=\'y\'.repeat(10000000); console.log(s)"',
      },
      { workspaceRoot: process.cwd() },
    ) as string;
    expect(out).not.toContain('maxBuffer');
    expect(out).toContain('省略');
    expect(out && out.indexOf('yyyy')).toBeGreaterThan(-1);
  }, 20000);

  it('配置注入只影响默认超时与输出配额', () => {
    configureCommandRunOutput({ outputLimitKb: 512, timeoutMs: 5000 });
    expect(commandRunOutputOptions()).toEqual({ outputLimitKb: 512, timeoutMs: 5000 });
  });
});

describe('配置边界', () => {
  it('非法值被夹到下限', () => {
    configureCommandRunOutput({ outputLimitKb: 0, timeoutMs: 0 });
    const opts = commandRunOutputOptions();
    expect(opts.outputLimitKb).toBeGreaterThanOrEqual(1);
    expect(opts.timeoutMs).toBeGreaterThanOrEqual(1);
  });
});

// vi 仅为保持与仓库测试风格一致（外部进程真实执行，不做 mock）
void vi;
