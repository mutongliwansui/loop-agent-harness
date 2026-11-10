// grep 工具输出治理单测：超长行（minified 单行）围绕匹配位置截取窗口
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grep } from '../src/tools/grep.js';

let WS = '';

beforeAll(async () => {
  WS = await mkdtemp(join(tmpdir(), 'loop-agent-grep-'));
});

afterAll(async () => {
  await rm(WS, { recursive: true, force: true });
});

describe('grep 超长行窗口截取', () => {
  it('短行原样返回，不受影响', async () => {
    await writeFile(join(WS, 'short.txt'), 'hello world\nfoo bar\n', 'utf-8');
    const out = await grep.execute(
      { pattern: 'foo', path: 'short.txt' },
      { workspaceRoot: WS },
    );
    expect(out).toContain('short.txt:2: foo bar');
    expect(out).not.toContain('省略');
  });

  it('单行超长：围绕匹配点截取，输出受限且包含省略标注', async () => {
    // 5000 字符单行，目标串位于 2500 附近
    const line = 'a'.repeat(2400) + 'TARGET' + 'b'.repeat(2594);
    await writeFile(join(WS, 'bundle.js'), line, 'utf-8');
    const out = await grep.execute(
      { pattern: 'TARGET', path: 'bundle.js' },
      { workspaceRoot: WS },
    );
    // 命中点保留
    expect(out).toContain('TARGET');
    // 两端省略标注
    expect(out).toContain('省略前');
    expect(out).toContain('省略后');
    expect(out).toContain('该行共 5000 字符');
    // 输出总行数远小于原始行（窗口 ~1000 字符 + 标注）
    const resultLine = out.split('\n').find((l) => l.includes('TARGET'))!;
    expect(resultLine.length).toBeLessThan(1300);
    // 不会包含完整的 2400 个 'a' 前缀
    expect(out).not.toContain('a'.repeat(2400));
  });

  it('匹配点在行首：无前省略，仅标注后省略', async () => {
    const line = 'TARGET' + 'x'.repeat(4994);
    await writeFile(join(WS, 'head.js'), line, 'utf-8');
    const out = await grep.execute(
      { pattern: 'TARGET', path: 'head.js' },
      { workspaceRoot: WS },
    );
    expect(out).toContain('TARGET');
    expect(out).not.toContain('省略前');
    expect(out).toContain('省略后');
    expect(out).toContain('该行共 5000 字符');
  });

  it('匹配点在行尾：无后省略，仅标注前省略与总长度', async () => {
    const line = 'y'.repeat(4994) + 'TARGET';
    await writeFile(join(WS, 'tail.js'), line, 'utf-8');
    const out = await grep.execute(
      { pattern: 'TARGET', path: 'tail.js' },
      { workspaceRoot: WS },
    );
    expect(out).toContain('TARGET');
    expect(out).toContain('省略前');
    expect(out).not.toContain('省略后');
    expect(out).toContain('该行共 5000 字符');
  });

  it('超长行 + 超限条数：先逐行截取，再走既有的 maxResults 落盘兜底', async () => {
    // 3 条超长行匹配，maxResults=2 触发既有超限路径
    const line = 'z'.repeat(2400) + 'HIT' + 'z'.repeat(2597);
    await writeFile(join(WS, 'many.js'), [line, line, line].join('\n'), 'utf-8');
    const out = await grep.execute(
      { pattern: 'HIT', path: 'many.js', maxResults: 2 },
      { workspaceRoot: WS },
    );
    expect(out).toContain('已达上限 2');
    // 每条仍是被截取后的窗口
    expect(out).toContain('省略前');
    expect(out).not.toContain('z'.repeat(2400));
  });

  it('流式扫描：CRLF 文件行尾 \\r 被剥离，行号正确', async () => {
    await writeFile(join(WS, 'crlf.txt'), 'alpha\r\nbeta needle\r\ngamma\r\n', 'utf-8');
    const out = await grep.execute(
      { pattern: 'needle', path: 'crlf.txt' },
      { workspaceRoot: WS },
    );
    expect(out).toContain('crlf.txt:2: beta needle');
    expect(out).not.toContain('\r');
  });

  it('流式扫描：多行大文件逐行命中且行号连续正确', async () => {
    // 1 万行，命中分散在头/中/尾三处，验证流式路径行号累计不错位
    const total = 10000;
    const lines = Array.from({ length: total }, (_, i) =>
      [0, 4999, 9999].includes(i) ? `line${i + 1} needle` : `line${i + 1}`,
    );
    await writeFile(join(WS, 'big.log'), lines.join('\n'), 'utf-8');
    const out = await grep.execute(
      { pattern: 'needle', path: 'big.log' },
      { workspaceRoot: WS },
    );
    expect(out).toContain('big.log:1: line1 needle');
    expect(out).toContain('big.log:5000: line5000 needle');
    expect(out).toContain('big.log:10000: line10000 needle');
    expect(out).toContain('找到 3 处匹配');
  });
});

describe('grep 扫描防护（二进制嗅探 + 匹配硬上限）', () => {
  it('二进制嗅探：前 8000 字节含 NUL 的文件直接跳过', async () => {
    const buf = Buffer.concat([Buffer.from('prefix needle ', 'utf-8'), Buffer.alloc(64)]);
    await writeFile(join(WS, 'bin.dat'), buf);
    const out = await grep.execute(
      { pattern: 'needle', path: 'bin.dat' },
      { workspaceRoot: WS },
    );
    expect(out).toContain('未在');
  });

  it('匹配风暴：达硬上限 2000 提前停止，如实声明结果非完整', async () => {
    // 2500 行全部命中，默认 maxResults=50 → 硬上限 2000 触发提前停止
    const lines = Array.from({ length: 2500 }, (_, i) => `row${i} storm`);
    await writeFile(join(WS, 'storm.log'), lines.join('\n'), 'utf-8');
    const out = await grep.execute(
      { pattern: 'storm', path: 'storm.log' },
      { workspaceRoot: WS },
    );
    expect(out).toContain('找到 2000 处匹配（已达上限 50）');
    expect(out).toContain('提前停止');
    expect(out).toContain('不完整');
    // 头部只展示前 50 条
    expect(out).toContain('storm.log:50:');
    expect(out).not.toContain('storm.log:51:');
  });

  it('maxResults 大于硬上限时上限跟随：2100 条全部返回不提前停止', async () => {
    const lines = Array.from({ length: 2100 }, (_, i) => `row${i} storm`);
    await writeFile(join(WS, 'storm2.log'), lines.join('\n'), 'utf-8');
    const out = await grep.execute(
      { pattern: 'storm', path: 'storm2.log', maxResults: 3000 },
      { workspaceRoot: WS },
    );
    expect(out).toContain('找到 2100 处匹配');
    expect(out).not.toContain('已达上限');
    expect(out).not.toContain('提前停止');
  });
});
