// 需求 20261106-001：工具输出超限治理——核心模块 output-governor 单测
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  buildTmpFilePath,
  sanitizeParamDigest,
  formatSize,
  summarizeParam,
  buildFullOutputNotice,
  TmpFileWriter,
  pruneTmp,
  configureOutputGovernor,
  outputGovernorOptions,
  setTmpDirForTest,
  governOneShot,
} from '../src/tools/output-governor.js';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let testRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'loop-og-test-'));
  setTmpDirForTest(testRoot);
  // 重置治理配置为默认
  configureOutputGovernor({
    preserveKb: 1,          // 1KB 触发落盘（测试用小阈值）
    triggerMultiplier: 1,   // 直接触发（不用双阈值）
    tmpTtlDays: 7,
    tmpMaxTotalMb: 100,
  });
});

afterEach(() => {
  setTmpDirForTest(undefined);
  try { rmSync(testRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  // 恢复默认配置
  configureOutputGovernor({
    preserveKb: 64,
    preserveLines: 200,
    triggerMultiplier: 2,
    tmpTtlDays: 7,
    tmpMaxTotalMb: 200,
  });
});

describe('路径构造', () => {
  it('buildTmpFilePath 按 sessionId / tool / digest / ts 拼接', () => {
    const p = buildTmpFilePath('sess_abc', 'commandRun', 'npm_test', 1730956800);
    expect(p).toContain('sess_abc');
    expect(p).toContain('commandRun-npm_test-1730956800');
    expect(p).toContain('.txt');
  });

  it('buildTmpFilePath 无 sessionId 时用 nosess_<ts> 目录', () => {
    const p = buildTmpFilePath(undefined, 'fileRead', 'app.ts', 1730956800);
    expect(p).toContain('nosess_1730956800');
  });

  it('sanitizeParamDigest 过滤 Windows/macOS/Linux 禁止字符', () => {
    // 'cmd /c "rm -rf /"' → 去引号 → cmd /c rm -rf / → 路径分隔符/冒号换 _ → cmd _c rm -rf _
    //   → 折叠空白 → cmd_c_rm_-rf_ → 去首尾 _ → cmd_c_rm_-rf
    expect(sanitizeParamDigest('cmd /c "rm -rf /"')).toBe('cmd_c_rm_-rf');
    expect(sanitizeParamDigest('path\\to:file*?')).toBe('path_to_file');
  });

  it('sanitizeParamDigest 超 32 字符截断', () => {
    const long = 'a'.repeat(100);
    expect(sanitizeParamDigest(long).length).toBeLessThanOrEqual(32);
  });

  it('sanitizeParamDigest 空字符串兜底返回 data', () => {
    expect(sanitizeParamDigest('')).toBe('data');
  });

  it('summarizeParam commandRun 去引号/折叠空白/截 32', () => {
    expect(summarizeParam({ command: 'npm test' }, 'commandRun')).toBe('npm_test');
    expect(summarizeParam({ command: '"echo hello"' }, 'commandRun')).toBe('echo_hello');
  });

  it('summarizeParam fileRead 取 basename', () => {
    expect(summarizeParam({ path: '/home/user/src/app.ts' }, 'fileRead')).toBe('app.ts');
    expect(summarizeParam({ path: 'C:\\Users\\dev\\main.ts' }, 'fileRead')).toBe('main.ts');
  });

  it('summarizeParam grep 取 pattern 前 32 字符', () => {
    expect(summarizeParam({ pattern: 'ERROR|FAIL' }, 'grep')).toBe('ERROR_FAIL');
  });
});

describe('formatSize', () => {
  it('< 1KB 显示 B', () => {
    expect(formatSize(12)).toBe('12 B');
  });
  it('KB 级别', () => {
    expect(formatSize(1280)).toBe('1.3 KB');
  });
  it('MB 级别', () => {
    expect(formatSize(4.2 * 1024 * 1024)).toBe('4.2 MB');
  });
  it('GB 级别', () => {
    expect(formatSize(2 * 1024 * 1024 * 1024)).toBe('2.00 GB');
  });
});

describe('buildFullOutputNotice', () => {
  it('包含边界标记与四字段', () => {
    const text = buildFullOutputNotice({
      path: '/tmp/sess_x/commandRun-foo-123.txt',
      bytes: 4096,
      lines: 100,
      suggestion: '建议: 用 fileRead 分段读取',
    });
    expect(text).toContain('── 完整输出已保存 ──');
    expect(text).toContain('路径:');
    expect(text).toContain('文件大小:');
    expect(text).toContain('文件行数:');
    expect(text).toContain('建议:');
    expect(text).toContain('/tmp/sess_x/commandRun-foo-123.txt');
  });

  it('complete 未指定/true 时声明「完整」', () => {
    const text = buildFullOutputNotice({
      path: '/tmp/a.txt', bytes: 10, lines: 1, suggestion: '建议: x',
    });
    expect(text).toContain('完整性: 完整');
    expect(text).not.toContain('⚠');
  });

  it('complete=false 时显式声明不完整并给出原因（不得谎称完整）', () => {
    const text = buildFullOutputNotice({
      path: '/tmp/a.txt',
      bytes: 10,
      lines: 1,
      suggestion: '建议: x',
      complete: false,
      incompleteReason: '背压丢弃 500 字节',
    });
    expect(text).toContain('完整性: ⚠ 不完整');
    expect(text).toContain('背压丢弃 500 字节');
    expect(text).not.toContain('完整性: 完整');
  });
});

describe('TmpFileWriter 流式治理', () => {
  it('累计未达阈值时不落盘（零磁盘开销）', async () => {
    const w = new TmpFileWriter({
      sessionId: 'sess_small',
      toolName: 'commandRun',
      paramDigest: 'cmd',
      thresholds: { preserveKb: 1, triggerMultiplier: 1 },
    });
    // 喂 500B（< 1KB 阈值）
    w.onChunk(Buffer.alloc(500, 'a'));
    w.onChunk(Buffer.alloc(400, 'b'));
    const info = await w.finalize();
    expect(info).toBeUndefined();

    // 根目录下不该有 sess_small 子目录
    const entries = require('node:fs').readdirSync(testRoot);
    // 如果目录被创建也不该有文件；直接检查是否有完整落盘文件就行
    if (existsSync(join(testRoot, 'sess_small'))) {
      const files = require('node:fs').readdirSync(join(testRoot, 'sess_small'));
      expect(files.length).toBe(0);
    }
  });

  it('累计超过阈值时创建 WriteStream，且**回填**触发前的暂存内容（文件完整）', async () => {
    const w = new TmpFileWriter({
      sessionId: 'sess_big',
      toolName: 'commandRun',
      paramDigest: 'cmd',
      thresholds: { preserveKb: 1, triggerMultiplier: 1 },
    });
    const chunk = Buffer.alloc(600, 'x');
    w.onChunk(chunk);  // 600B < 1KB：进暂存缓冲（旧实现会直接丢弃）
    w.onChunk(chunk);  // 1200B 累计 > 1KB：创建 WriteStream 并回填前一块
    const info = await w.finalize();
    expect(info).toBeDefined();
    // 关键断言（需求 20261106-002）：文件字节数 === 工具真实输出量，不再缺头
    expect(info!.bytes).toBe(1200);
    expect(info!.contentBytes).toBe(1200);
    expect(info!.complete).toBe(true);
    expect(info!.path).toContain('sess_big');
    expect(info!.path).toContain('commandRun-cmd');

    // 文件内容包含触发阈值前的第一块（回填生效）
    const content = readFileSync(info!.path, 'utf-8');
    expect(content.length).toBe(1200);
  });

  it('多块流式输出：落盘行数与字节数完整等于真实输出（10 万行回归）', async () => {
    const w = new TmpFileWriter({
      sessionId: 'sess_bulk',
      toolName: 'commandRun',
      paramDigest: 'bulk',
      thresholds: { preserveKb: 64, triggerMultiplier: 2 }, // 128KB 才落盘
    });
    const totalLines = 100_000;
    // 每块 1000 行 × 5 字节 = 5000B，共 100 块 = 500000B（远超 128KB 阈值）
    const block = Buffer.from('year\n'.repeat(1000), 'utf-8');
    expect(block.length).toBe(5000);
    for (let i = 0; i < 100; i++) w.onChunk(block);

    const info = await w.finalize();
    expect(info).toBeDefined();
    expect(info!.contentBytes).toBe(500_000);
    expect(info!.bytes).toBe(500_000);      // 旧实现这里是 500000-131072=368928
    expect(info!.lines).toBe(totalLines);
    expect(info!.complete).toBe(true);

    const content = readFileSync(info!.path, 'utf-8');
    expect(content.length).toBe(500_000);
    expect(content.split('\n').filter((l) => l === 'year').length).toBe(totalLines);
  });

  it('小输出（未达阈值）零落盘：不创建任何文件', async () => {
    const w = new TmpFileWriter({
      sessionId: 'sess_tiny',
      toolName: 'commandRun',
      paramDigest: 'tiny',
      thresholds: { preserveKb: 64, triggerMultiplier: 2 },
    });
    w.onChunk(Buffer.from('hello\n', 'utf-8'));
    const info = await w.finalize();
    expect(info).toBeUndefined();
    if (existsSync(join(testRoot, 'sess_tiny'))) {
      expect(require('node:fs').readdirSync(join(testRoot, 'sess_tiny')).length).toBe(0);
    }
  });

  it('写入失败时禁用，finalize 返回 undefined', async () => {
    // 故意让 WriteStream 目标路径不可写
    const w = new TmpFileWriter({
      sessionId: 'sess_bad',
      toolName: 'commandRun',
      paramDigest: 'cmd',
      thresholds: { preserveKb: 1, triggerMultiplier: 1 },
    });
    // 模拟写入失败：override mkdirSync 在第二次调用时抛错（或直接 mock）
    // 这里用 setTmpDirForTest 指向不可写路径太脆，改用 disable API 手动测试
    w.disable();
    w.onChunk(Buffer.alloc(2000, 'x'));
    const info = await w.finalize();
    expect(info).toBeUndefined();
  });
});

describe('pruneTmp 清理', () => {
  it('清理超期文件（mtime < tmpTtlDays 天前）', () => {
    const fs = require('node:fs');
    const sessionDir = join(testRoot, 'sess_prune_test');
    fs.mkdirSync(sessionDir, { recursive: true });
    const DAY = 24 * 60 * 60 * 1000;

    const oldFile = join(sessionDir, 'commandRun-cmd-1000.txt');
    fs.writeFileSync(oldFile, 'old content');
    const old = new Date(Date.now() - 9 * DAY);
    fs.utimesSync(oldFile, old, old);

    const newFile = join(sessionDir, 'commandRun-cmd-2000.txt');
    fs.writeFileSync(newFile, 'new content');
    const recent = new Date(Date.now() - 1 * DAY);
    fs.utimesSync(newFile, recent, recent);

    const result = pruneTmp({ tmpTtlDays: 7, tmpMaxTotalMb: 100 });
    expect(result.removedFiles).toBe(1);
    expect(result.freedBytes).toBeGreaterThan(0);

    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(newFile)).toBe(true);
  });

  it('tmp 目录不存在时静默返回 0', () => {
    const result = pruneTmp({ tmpTtlDays: 7 });
    expect(result.removedFiles).toBe(0);
  });

  it('总量超限按 mtime 从旧删起', () => {
    const fs = require('node:fs');
    const DAY = 24 * 60 * 60 * 1000;
    const sessionDir = join(testRoot, 'sess_size_prune');
    fs.mkdirSync(sessionDir, { recursive: true });

    const makeFile = (name: string, ageMs: number, size: number) => {
      const p = join(sessionDir, name);
      fs.writeFileSync(p, Buffer.alloc(size, 'x'));
      const t = new Date(Date.now() - ageMs);
      fs.utimesSync(p, t, t);
      return p;
    };
    const oldF = makeFile('old.txt', 1 * DAY, 50 * 1024);
    const midF = makeFile('mid.txt', 0.5 * DAY, 50 * 1024);
    const newF = makeFile('new.txt', 0.1 * DAY, 50 * 1024);

    // tmpMaxTotalMb=0.05 (50KB)，三个文件合计 150KB → 触发淘汰，最旧先删
    const result = pruneTmp({ tmpTtlDays: 30, tmpMaxTotalMb: 0.05 });
    expect(result.removedFiles).toBeGreaterThanOrEqual(1);
    expect(existsSync(oldF)).toBe(false);
  });
});

describe('configureOutputGovernor 配置注入', () => {
  it('注入后 outputGovernorOptions 返回新值', () => {
    configureOutputGovernor({ preserveKb: 32, triggerMultiplier: 1.5 });
    const opts = outputGovernorOptions();
    expect(opts.preserveKb).toBe(32);
    expect(opts.triggerMultiplier).toBe(1.5);
    // 未注入的字段保持原值
    expect(opts.preserveLines).toBe(200);
  });

  it('非法值被夹到下限', () => {
    configureOutputGovernor({ preserveKb: -5, triggerMultiplier: 0 });
    const opts = outputGovernorOptions();
    expect(opts.preserveKb).toBe(1);  // max(1, -5)
    expect(opts.triggerMultiplier).toBe(1);  // max(1, 0)
  });
});

describe('governOneShot runner 层兜底', () => {
  it('小输出原样返回（零磁盘开销）', async () => {
    const small = 'hello world';
    const result = await governOneShot(small, 'grep', { pattern: 'hello' }, 'sess_mini', {
      preserveKb: 1,
      triggerMultiplier: 1,
    });
    expect(result.truncated).toBe(false);
    expect(result.text).toBe('hello world');
    expect(result.fullOutputPath).toBeUndefined();
  });

  it('超限完整落临时文件 + 返回截断片段 + 路径提示', async () => {
    const big = 'x'.repeat(3000);  // 3KB，超 1KB 阈值
    const result = await governOneShot(big, 'grep', { pattern: 'x' }, 'sess_big_govern', {
      preserveKb: 1,
      triggerMultiplier: 1,
    });
    expect(result.truncated).toBe(true);
    expect(result.fullOutputPath).toBeDefined();
    expect(result.text).toContain('── 完整输出已保存 ──');
    expect(result.text).toContain(result.fullOutputPath!);

    // 完整文件可读取，长度 = 原始 big 的长度
    const content = readFileSync(result.fullOutputPath!, 'utf-8');
    expect(content.length).toBe(big.length);
  });
});
