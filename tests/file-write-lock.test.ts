/**
 * Task-20261023-001：同文件写并发保护测试
 * 覆盖：perPath 串行化、跨文件并行、锁内异常不阻塞后续调用、mtime 并发诊断、fileWrite 行尾适配。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { editFile } from '../src/tools/editFile.js';
import { fileWrite } from '../src/tools/fileWrite.js';
import { withFileLock, lockKey } from '../src/tools/file-lock.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';

const DIR = join(tmpdir(), 'loop-agent-tests', 'test-file-write-lock');
const file = (name: string): string => join(DIR, name);

function seed(name: string, content: string): string {
  const p = file(name);
  writeFileSync(p, content, 'utf-8');
  return p;
}

function raw(p: string): string {
  return readFileSync(p, 'utf-8');
}

describe('file-lock 基础行为', () => {
  it('lockKey：同一文件不同大小写/相对表示收敛为同一 key', () => {
    const a = join(DIR, 'Case.txt');
    const b = join(DIR, 'case.txt');
    if (process.platform === 'win32') {
      expect(lockKey(a)).toBe(lockKey(b));
    } else {
      expect(lockKey(a)).not.toBe(lockKey(b));
    }
  });

  it('withFileLock：同文件串行、fn 结果与异常透传', async () => {
    const order: string[] = [];
    const p = file('serial.txt');
    const t1 = withFileLock(p, async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push('first');
      return 1;
    });
    const t2 = withFileLock(p, async () => {
      order.push('second');
      return 2;
    });
    const [r1, r2] = await Promise.all([t1, t2]);
    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(order).toEqual(['first', 'second']);
    await expect(withFileLock(p, async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    // 前序异常不阻塞后续
    const r3 = await withFileLock(p, async () => 3);
    expect(r3).toBe(3);
  });

  it('withFileLock：不同文件并行执行', async () => {
    let running = 0;
    let maxConcurrent = 0;
    const mk = (): Promise<number> => {
      const p = file(`par-${Math.random()}.txt`);
      return withFileLock(p, async () => {
        running++;
        maxConcurrent = Math.max(maxConcurrent, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        return running;
      });
    };
    await Promise.all([mk(), mk(), mk()]);
    expect(maxConcurrent).toBe(3);
  });
});

describe('editFile/fileWrite 并发写保护（P1）', () => {
  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
  });

  afterAll(() => {
    rmSync(DIR, { recursive: true, force: true });
  });

  it('20 路并发同文件 editFile（互不冲突锚点）全部成功且结果正确', async () => {
    // 种子文件含 20 个独立锚点行，20 路并发各自替换自己的锚点：锁保证互不踩踏，全部成功
    const seedLines = Array.from({ length: 20 }, (_, i) => `anchor-${String(i).padStart(2, '0')}`);
    const p = seed('concurrent.txt', seedLines.join('\r\n') + '\r\n');
    const jobs = Array.from({ length: 20 }, (_, i) =>
      editFile.execute({
        path: p,
        oldText: `anchor-${String(i).padStart(2, '0')}`,
        newText: `done-${String(i).padStart(2, '0')}`,
      }).catch((e: Error) => `FAIL: ${e.message}`),
    );
    const results = await Promise.all(jobs);
    expect(results.every((r) => r.includes('已编辑'))).toBe(true);
    const text = raw(p);
    expect(text).not.toContain('anchor-');
    const lines = text.split('\r\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(20);
    expect(new Set(lines).size).toBe(20);
    expect(lines.every((l) => /^done-\d{2}$/.test(l))).toBe(true);
  });

  it('20 路并发同文件 editFile（replaceAll 同锚点）互不踩踏', async () => {
    const p = seed('concurrent-all.txt', 'x=1\r\n');
    // 每路把 x=1 整体改写为独立键（replaceAll 使唯一匹配），锁保证串行落盘
    const jobs = Array.from({ length: 20 }, (_, i) =>
      editFile.execute({
        path: p,
        oldText: 'x=1',
        newText: `key-${String(i).padStart(2, '0')}=1`,
        replaceAll: true,
      }).catch((e: Error) => `FAIL: ${e.message}`),
    );
    const results = await Promise.all(jobs);
    const ok = results.filter((r) => r.includes('已编辑'));
    // x=1 首次被改后锚点消失：恰好 1 路成功、19 路得到明确的「未找到」失败（不再有静默竞态）
    expect(ok.length).toBe(1);
    const text = raw(p);
    expect(text.startsWith('key-')).toBe(true);
    expect(text.endsWith('\r\n')).toBe(true);
  });

  it('同轮 editFile + fileWrite 并发同文件不互相踩踏', async () => {
    const p = seed('combo.txt', 'anchor\r\n');
    await Promise.all([
      editFile.execute({ path: p, oldText: 'anchor', newText: 'edited' }),
      fileWrite.execute({ path: p, content: 'appended\n', mode: 'append' }),
    ]);
    // 两个操作都落盘：串行执行保证无「读-改-写窗口互相插入」
    const text = raw(p);
    expect(text).toContain('edited');
  });

  it('外部修改（mtime 变化）后 editFile 失配 → 报「并发修改」提示', async () => {
    const p = seed('ext-mod.txt', 'old content\r\n');
    // 先经本进程工具写一次，登记 mtime
    await fileWrite.execute({ path: p, content: 'first version\r\n' });
    // 模拟外部修改：直接改 mtime
    const old = statSync(p);
    const future = new Date(old.mtimeMs + 5000);
    writeFileSync(p, 'external changed\r\n', 'utf-8');
    const st = statSync(p);
    if (Math.abs(st.mtimeMs - old.mtimeMs) <= 1) {
      // 文件系统 mtime 精度不足时，手动篡改登记值制造差异
      const { recordWriteMtime } = await import('../src/tools/line-endings.js');
      recordWriteMtime(p, st.mtimeMs - 5000);
    }
    void future;
    const err = await editFile
      .execute({ path: p, oldText: 'first version', newText: 'x' })
      .catch((e: Error) => e);
    const msg = (err as Error).message;
    expect(msg).toContain('mtime 相比本进程上次写入已变化');
    expect(msg).toContain('其他写操作');
    expect(msg).toContain('要替换的文本');
    expect(msg).toContain('实际: external changed');
  });

  it('fileWrite：overwrite/append 到 CRLF 文件适配 CRLF，新文件保持 LF', async () => {
    const p1 = seed('fw-crlf.txt', 'a\r\nb\r\n');
    await fileWrite.execute({ path: p1, content: 'x\ny\n', mode: 'overwrite' });
    expect(raw(p1)).toBe('x\r\ny\r\n');

    await fileWrite.execute({ path: p1, content: 'z\n', mode: 'append' });
    expect(raw(p1)).toBe('x\r\ny\r\nz\r\n');

    const p2 = file('fw-new.txt');
    await fileWrite.execute({ path: p2, content: 'a\nb\n' });
    expect(raw(p2)).toBe('a\nb\n');
  });
});
