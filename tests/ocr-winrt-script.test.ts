/**
 * WinRT OCR 内嵌脚本的静态约束单测
 *
 * 真机行为（能不能识别出字）由 ocrImage 真机验证覆盖；这里只守「已经踩过的坑」，
 * 防止后续改动把脚本改回不可用状态——这些坑都不会在单测里自然暴露，只有真机才炸：
 *
 *   1. 不能用 [Windows.Storage.StorageFile]::FromPathAsync 读图。
 *      Win11 26100 的 WinRT 投影里 StorageFile 只有 GetFileFromPathAsync，
 *      调用 FromPathAsync 会抛「不包含名为 FromPathAsync 的方法」，
 *      而该异常被统一映射成 decode_failed → 用户只看到「图片无法被解码」，排查成本极高。
 *   2. 脚本必须保持纯 ASCII。脚本按 UTF-8 落盘，但 Windows PowerShell 5.1 按
 *      控制台/系统 ANSI 代码页（内网机 GBK）读取 .ps1，中文注释会变乱码甚至解析失败。
 *   3. 不能用 PowerShell 7 专有语法，内网目标机是 Windows 10 + PowerShell 5.1。
 */
import { describe, it, expect } from 'vitest';
import { WINRT_SCRIPT } from '../src/ocr/engine-winrt.js';

describe('WinRT 脚本：图片解码路径', () => {
  it('不再调用 StorageFile.FromPathAsync（Win11 26100 投影里不存在）', () => {
    // 只看调用形态，注释里允许出现 "no FromPathAsync" 这类说明文字
    expect(WINRT_SCRIPT).not.toContain('FromPathAsync(');
    expect(WINRT_SCRIPT).not.toContain('Windows.Storage.StorageFile]::');
    expect(WINRT_SCRIPT).not.toContain('Windows.Storage.Streams.IRandomAccessStream');
  });

  it('改为 字节 → MemoryStream → AsRandomAccessStream 的内存解码路径', () => {
    expect(WINRT_SCRIPT).toContain('[System.IO.File]::ReadAllBytes($ImagePath)');
    expect(WINRT_SCRIPT).toContain('[System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream');
    expect(WINRT_SCRIPT).toContain(
      '[Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)',
    );
  });

  it('解码失败仍归到 decode_failed，并带上原始异常信息（便于定位）', () => {
    expect(WINRT_SCRIPT).toContain("Fail 'decode_failed'");
    expect(WINRT_SCRIPT).toContain("'Cannot decode image: ' + $_.Exception.Message");
  });

  it('不再要求预加载 StorageFile 类型（类型探测列表与实现保持一致）', () => {
    const declared = WINRT_SCRIPT.split('\n')
      .filter((l) => l.includes('ContentType=WindowsRuntime'))
      .join('\n');
    expect(declared).toContain('Windows.Graphics.Imaging.BitmapDecoder');
    expect(declared).toContain('Windows.Media.Ocr.OcrEngine');
    expect(declared).not.toContain('Windows.Storage');
  });
});

describe('WinRT 脚本：兼容性硬约束', () => {
  it('脚本是纯 ASCII（PS 5.1 按 ANSI 代码页读取，非 ASCII 会乱码）', () => {
    const bad: string[] = [];
    for (let i = 0; i < WINRT_SCRIPT.length; i++) {
      const c = WINRT_SCRIPT.charCodeAt(i);
      if (c > 0x7f) bad.push(`offset ${i}: U+${c.toString(16).toUpperCase()}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('不含 PowerShell 7 专有语法（?? / ?. / $PSStyle）', () => {
    expect(WINRT_SCRIPT.includes('??')).toBe(false);
    expect(/\?\.[A-Za-z]/.test(WINRT_SCRIPT)).toBe(false);
    expect(WINRT_SCRIPT).not.toContain('$PSStyle');
  });

  it('probe 模式不碰图片（无图也要能探测出语言包与最大边长）', () => {
    const probeIdx = WINRT_SCRIPT.indexOf("if ($Mode -eq 'probe')");
    const imageIdx = WINRT_SCRIPT.indexOf("Fail 'image_missing'");
    expect(probeIdx).toBeGreaterThan(-1);
    expect(imageIdx).toBeGreaterThan(-1);
    expect(probeIdx).toBeLessThan(imageIdx);
  });
});
