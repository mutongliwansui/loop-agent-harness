// upload/manager 单测（Task-20261012-001）
// 覆盖：跨平台参数归一（D5）、批量复制校验（D1/D3/D4）、列表/清理、文件选择框平台探测链（D9）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, exec: execMock };
});

import {
  parseUploadArgs,
  pickFilesViaDialog,
  copyToUploads,
  listUploads,
  cleanUploads,
  cleanAllUploads,
  buildContextNote,
  formatBytes,
  defaultUploadsRoot,
  MAX_UPLOAD_BYTES,
} from '../src/upload/manager.js';

/** 临时重定义 process.platform（测试结束恢复） */
function mockPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}
const REAL_PLATFORM = process.platform;

/** execMock 快捷构造：按命令内容路由返回值 */
function execResponds(handler: (cmd: string) => { stdout?: string; code?: number } | undefined): void {
  execMock.mockImplementation((cmd: string, _opts: unknown, cb: (e: unknown, r?: { stdout: string; stderr: string }) => void) => {
    const r = handler(cmd);
    if (!r || r.code !== undefined) {
      const err = Object.assign(new Error(`exit ${r?.code ?? 1}`), { code: r?.code ?? 1, stdout: r?.stdout ?? '' });
      cb(err, { stdout: r?.stdout ?? '', stderr: '' });
      return;
    }
    cb(null, { stdout: r.stdout ?? '', stderr: '' });
  });
}

beforeEach(() => {
  execMock.mockReset();
});
afterEach(() => {
  mockPlatform(REAL_PLATFORM);
});

describe('parseUploadArgs（D5 跨平台归一）', () => {
  it('Windows 双引号段：含空格与中文、多段拆分', () => {
    expect(parseUploadArgs('"D:\\docs\\a b.png" "D:\\图片\\c.pdf"')).toEqual([
      'D:\\docs\\a b.png',
      'D:\\图片\\c.pdf',
    ]);
  });

  it('Konsole 单引号段与转义空格', () => {
    expect(parseUploadArgs("'/tmp/a b.png'")).toEqual(['/tmp/a b.png']);
    expect(parseUploadArgs('/tmp/a\\ b.png')).toEqual(['/tmp/a b.png']);
  });

  it('file:// URI 归一（含 %20 编码，POSIX 与 Windows 盘符形态）', () => {
    const r = parseUploadArgs('file:///home/u/a%20b.png');
    expect(r).toEqual(['/home/u/a b.png']);
    expect(parseUploadArgs('file:///D:/x/a%20b.png')).toEqual(['D:/x/a b.png']);
  });

  it('无引号路径反斜杠保留（Windows 分隔符不误吞）', () => {
    expect(parseUploadArgs('D:\\plain\\path.png')).toEqual(['D:\\plain\\path.png']);
  });

  it('混合格式一次解析', () => {
    const r = parseUploadArgs('"x y.png" file:///a%20b.png');
    expect(r).toHaveLength(2);
    expect(r[0]).toBe('x y.png');
  });

  it('空输入返回空数组', () => {
    expect(parseUploadArgs('')).toEqual([]);
    expect(parseUploadArgs('   ')).toEqual([]);
  });
});

describe('copyToUploads（D1/D3/D4）', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'loop-uploads-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('复制成功：时间戳前缀 + 源文件未动 + 元数据正确', async () => {
    const srcDir = join(root, 'src');
    await mkdir(srcDir);
    const src = join(srcDir, 'a.txt');
    await writeFile(src, 'hello');
    const now = new Date(2026, 9, 12, 15, 30, 1);
    const r = await copyToUploads([src], { sessionKey: 's1', uploadsRoot: root, now });
    expect(r.failed).toHaveLength(0);
    expect(r.succeeded).toHaveLength(1);
    const e = r.succeeded[0];
    expect(e.fileName).toMatch(/^20261012-153001-a\.txt$/);
    expect(e.bytes).toBe(5);
    // 目标存在且内容一致，源文件未动
    const target = await stat(e.targetPath);
    expect(target.isFile()).toBe(true);
    expect((await stat(src)).isFile()).toBe(true);
  });

  it('目录路径报「仅支持文件」，不存在报「文件不存在」，其余继续', async () => {
    const f = join(root, 'ok.txt');
    await writeFile(f, 'x');
    const r = await copyToUploads([root, join(root, 'nope.txt'), f], { sessionKey: 's1', uploadsRoot: root });
    expect(r.succeeded.map((e) => e.fileName)).toContainEqual(expect.stringMatching(/ok\.txt$/));
    expect(r.failed).toEqual([
      { path: root, reason: '仅支持文件（目录请压缩后上传）' },
      { path: join(root, 'nope.txt'), reason: '文件不存在' },
    ]);
  });

  it('超过上限报错（maxBytes 注入便于测试）', async () => {
    const f = join(root, 'big.bin');
    await writeFile(f, 'x'.repeat(10));
    const r = await copyToUploads([f], { sessionKey: 's1', uploadsRoot: root, maxBytes: 5 });
    expect(r.failed[0].reason).toContain('超过单文件上限');
    expect(r.succeeded).toHaveLength(0);
  });

  it('MAX_UPLOAD_BYTES 为 100MB', () => {
    expect(MAX_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
  });

  it('sessionKey 为空整体拒绝（无 default 回退）', async () => {
    const r = await copyToUploads(['a.txt', 'b.txt'], { sessionKey: '', uploadsRoot: root });
    expect(r.succeeded).toHaveLength(0);
    expect(r.failed).toHaveLength(2);
    expect(r.failed.every((f) => f.reason === '当前无活动会话')).toBe(true);
  });

  it('同秒同名不覆盖：第二个追加毫秒段', async () => {
    const a = join(root, 'same.txt');
    const b = join(root, 'sub', 'same.txt');
    await mkdir(join(root, 'sub'));
    await writeFile(a, 'A');
    await writeFile(b, 'B');
    const now = new Date(2026, 9, 12, 15, 30, 1);
    now.getMilliseconds = () => 250; // 固定毫秒，断言稳定
    const r = await copyToUploads([a, b], { sessionKey: 's1', uploadsRoot: root, now });
    expect(r.succeeded).toHaveLength(2);
    expect(r.succeeded[0].fileName).toMatch(/^20261012-153001-same\.txt$/);
    expect(r.succeeded[1].fileName).toMatch(/^20261012-153001-250-same\.txt$/);
    expect(r.succeeded[0].targetPath).not.toBe(r.succeeded[1].targetPath);
  });
});

describe('listUploads / cleanUploads / cleanAllUploads', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'loop-uploads-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('listUploads：目录不存在返回 []', async () => {
    expect(await listUploads(root, 'none')).toEqual([]);
  });

  it('listUploads：条目含大小与时间，子目录跳过', async () => {
    const dir = join(root, 's1');
    await mkdir(dir);
    await writeFile(join(dir, '20261012-100000-a.txt'), '12345');
    await mkdir(join(dir, 'subdir'));
    const entries = await listUploads(root, 's1');
    expect(entries).toHaveLength(1);
    expect(entries[0].fileName).toBe('20261012-100000-a.txt');
    expect(entries[0].bytes).toBe(5);
    expect(entries[0].targetPath).toContain('s1');
  });

  it('cleanUploads：有内容删除返回 true，空/不存在返回 false', async () => {
    const dir = join(root, 's1');
    await mkdir(dir);
    await writeFile(join(dir, 'a.txt'), 'x');
    expect(await cleanUploads(root, 's1')).toBe(true);
    await expect(stat(dir)).rejects.toThrow();
    expect(await cleanUploads(root, 's1')).toBe(false);
  });

  it('cleanAllUploads：根目录清空重建', async () => {
    const dir = join(root, 's1');
    await mkdir(dir);
    await writeFile(join(dir, 'a.txt'), 'x');
    await cleanAllUploads(root);
    const entries = await listUploads(root, 's1');
    expect(entries).toEqual([]);
  });
});

describe('pickFilesViaDialog（D9 平台探测链）', () => {
  it('win32：PowerShell WinForms，逐行输出', async () => {
    mockPlatform('win32');
    execResponds((cmd) => (cmd.includes('command -v') ? undefined
      : cmd.includes('powershell') ? { stdout: 'D:\\a.png\r\nD:\\b.png' } : undefined));
    const r = await pickFilesViaDialog();
    expect(r.paths).toEqual(['D:\\a.png', 'D:\\b.png']);
    expect(execMock.mock.calls.some(([c]) => String(c).includes('powershell'))).toBe(true);
  });

  it('darwin：osascript 多选', async () => {
    mockPlatform('darwin');
    execResponds((cmd) => (cmd.includes('osascript') ? { stdout: '/tmp/a.png\n/tmp/b.png' } : undefined));
    const r = await pickFilesViaDialog();
    expect(r.paths).toEqual(['/tmp/a.png', '/tmp/b.png']);
  });

  it('linux：zenity 命中，| 分隔', async () => {
    mockPlatform('linux');
    execResponds((cmd) => {
      if (cmd.includes('command -v')) return { stdout: '/usr/bin/zenity' };
      return cmd.includes('zenity --file-selection') ? { stdout: '/tmp/a.png|/tmp/b.png' } : undefined;
    });
    const r = await pickFilesViaDialog();
    expect(r.paths).toEqual(['/tmp/a.png', '/tmp/b.png']);
    expect(execMock.mock.calls.some(([c]) => String(c).includes('kdialog'))).toBe(false);
  });

  it('linux：全部工具缺失 → unavailable', async () => {
    mockPlatform('linux');
    execResponds(() => ({ code: 1 }));
    const r = await pickFilesViaDialog();
    expect(r.paths).toEqual([]);
    expect(r.reason).toBe('unavailable');
  });

  it('linux：zenity 取消（exit 1 无输出）→ cancelled', async () => {
    mockPlatform('linux');
    execResponds((cmd) => {
      if (cmd.includes('command -v')) return { stdout: '/usr/bin/zenity' };
      return cmd.includes('zenity --file-selection') ? { code: 1 } : undefined;
    });
    const r = await pickFilesViaDialog();
    expect(r.paths).toEqual([]);
    expect(r.reason).toBe('cancelled');
  });

  it('linux：zenity 异常退出（exit 127）→ unavailable', async () => {
    mockPlatform('linux');
    execResponds((cmd) => {
      if (cmd.includes('command -v')) return { stdout: '/usr/bin/zenity' };
      return cmd.includes('zenity --file-selection') ? { code: 127 } : undefined;
    });
    const r = await pickFilesViaDialog();
    expect(r.reason).toBe('unavailable');
  });

  it('linux：kdialog 回退（zenity 缺失），输出按 shell 风格解析', async () => {
    mockPlatform('linux');
    execResponds((cmd) => {
      if (cmd.includes('command -v zenity')) return { code: 1 };
      if (cmd.includes('command -v')) return { stdout: '/usr/bin/kdialog' };
      return cmd.includes('kdialog') ? { stdout: '/tmp/a.png /tmp/b.png' } : undefined;
    });
    const r = await pickFilesViaDialog();
    expect(r.paths).toEqual(['/tmp/a.png', '/tmp/b.png']);
  });
});

describe('辅助', () => {
  it('formatBytes 人性化', () => {
    expect(formatBytes(512)).toBe('512B');
    expect(formatBytes(2048)).toBe('2.0KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0MB');
  });

  it('buildContextNote 含标记/路径/大小', () => {
    const note = buildContextNote({
      originalPath: 'D:\\a.txt',
      targetPath: 'C:\\u\\.loop-agent\\uploads\\s1\\20261012-a.txt',
      fileName: '20261012-a.txt',
      bytes: 2048,
      uploadedAt: '2026-10-12T00:00:00.000Z',
    });
    expect(note).toContain('[文件上传] 20261012-a.txt');
    expect(note).toContain('C:\\u\\.loop-agent\\uploads\\s1\\20261012-a.txt');
    expect(note).toContain('2.0KB');
  });

  it('defaultUploadsRoot 指向 ~/.loop-agent/uploads', () => {
    expect(defaultUploadsRoot()).toContain(join('.loop-agent', 'uploads'));
  });
});
