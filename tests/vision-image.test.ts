/**
 * 视觉图片解析单测（Task-20261010-001）
 * 覆盖：三来源解析（http URL / data URI / 本地文件）、大小限制、格式校验、分类错误、文件指纹
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveImage, isHttpUrl, isDataUri, SUPPORTED_IMAGE_EXTS } from '../src/tools/vision/image.js';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let tmpDir: string;
async function tmpFile(name: string, data: Buffer): Promise<string> {
  if (!tmpDir) tmpDir = await mkdtemp(join(tmpdir(), 'vision-image-test-'));
  const p = join(tmpDir, name);
  await writeFile(p, data);
  return p;
}

afterAll(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe('来源识别辅助函数', () => {
  it('isHttpUrl 识别 http/https 且大小写不敏感', () => {
    expect(isHttpUrl('https://example.com/a.png')).toBe(true);
    expect(isHttpUrl('HTTP://example.com/a.png')).toBe(true);
    expect(isHttpUrl('/local/a.png')).toBe(false);
    expect(isHttpUrl('ftp://example.com/a.png')).toBe(false);
  });

  it('isDataUri 仅识别 data:image/ 前缀', () => {
    expect(isDataUri('data:image/png;base64,AA')).toBe(true);
    expect(isDataUri('DATA:image/jpeg;base64,AA')).toBe(true);
    expect(isDataUri('data:text/plain;base64,AA')).toBe(false);
    expect(isDataUri('/local/a.png')).toBe(false);
  });

  it('SUPPORTED_IMAGE_EXTS 覆盖六种格式', () => {
    expect(SUPPORTED_IMAGE_EXTS).toBe('png/jpg/jpeg/webp/gif/bmp');
  });
});

describe('resolveImage - URL 来源', () => {
  it('http(s) URL 原样透传，不校验大小、无指纹', async () => {
    const r = await resolveImage('https://example.com/a.PNG', 100);
    expect(r.uri).toBe('https://example.com/a.PNG');
    expect(r.source).toBe('url');
    expect(r.bytes).toBe(0);
    expect(r.fileFingerprint).toBeUndefined();
  });
});

describe('resolveImage - data URI 来源', () => {
  it('data URI 透传并按 base64 估算解码后大小', async () => {
    const r = await resolveImage('data:image/png;base64,AAAA', 100);
    expect(r.uri).toBe('data:image/png;base64,AAAA');
    expect(r.source).toBe('data');
    expect(r.bytes).toBe(3);
    expect(r.fileFingerprint).toBeUndefined();
  });

  it('data URI 超过大小上限时报分类错误', async () => {
    await expect(resolveImage('data:image/png;base64,AAAA', 2)).rejects.toThrow('图片超过大小限制');
  });
});

describe('resolveImage - 本地文件来源', () => {
  it('本地文件转为 data URI 并携带 size-mtime 指纹', async () => {
    const p = await tmpFile('a.png', PNG_BYTES);
    const r = await resolveImage(p, 1024 * 1024);
    expect(r.source).toBe('file');
    expect(r.uri).toMatch(/^data:image\/png;base64,/);
    expect(r.bytes).toBe(PNG_BYTES.length);
    const st = await stat(p);
    expect(r.fileFingerprint).toBe(`${st.size}-${st.mtimeMs}`);
  });

  it('扩展名大小写不敏感（.PNG → image/png）', async () => {
    const p = await tmpFile('b.PNG', PNG_BYTES);
    const r = await resolveImage(p, 1024 * 1024);
    expect(r.uri).toMatch(/^data:image\/png;/);
  });

  it('文件超过大小上限时报分类错误', async () => {
    const p = await tmpFile('d.png', PNG_BYTES);
    await expect(resolveImage(p, 4)).rejects.toThrow('图片超过大小限制');
  });

  it('不支持的扩展名报错并列出支持格式', async () => {
    const p = await tmpFile('c.txt', PNG_BYTES);
    await expect(resolveImage(p, 1024 * 1024)).rejects.toThrow(
      `不支持的图片格式: .txt（支持 ${SUPPORTED_IMAGE_EXTS}）`,
    );
  });

  it('文件不存在报错并包含输入路径', async () => {
    const p = join(tmpdir(), 'vision-no-such-file-<test>.png');
    await expect(resolveImage(p, 1024 * 1024)).rejects.toThrow(`图片文件不存在: ${p}`);
  });

  it('路径是目录时报"不是文件"错误', async () => {
    if (!tmpDir) tmpDir = await mkdtemp(join(tmpdir(), 'vision-image-test-'));
    await expect(resolveImage(tmpDir, 1024 * 1024)).rejects.toThrow('图片路径不是文件');
  });

  it('空输入报参数错误', async () => {
    await expect(resolveImage('   ', 1024 * 1024)).rejects.toThrow('图片参数 image 不能为空');
  });
});
