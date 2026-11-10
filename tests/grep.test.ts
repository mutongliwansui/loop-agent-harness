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
});
